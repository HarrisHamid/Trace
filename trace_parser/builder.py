"""Deterministic graph builder: ast for structure, jedi for name resolution.

Passes (in order): nodes, calls, routes, depends (injects), imports, inherits.
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field

import jedi
import networkx as nx

from .discover import discover, module_name

HTTP_METHODS = {"get", "post", "put", "delete", "patch", "options", "head", "trace"}
ROUTER_FACTORIES = {"APIRouter": "router", "FastAPI": "app", "Flask": "app", "Blueprint": "router"}
ROUTER_NAME_HINTS = {"router", "app", "api", "api_router", "bp", "blueprint"}
DEPENDS_NAMES = {"Depends", "Security"}

# PEP 758 (Python 3.14): `except A, B:` without parentheses. Rewritten to
# `except(A, B):` -- same columns for every token before the colon.
PEP758_RE = re.compile(r"(?m)^([ \t]*)except (?![(*])([^:#()\n]+,[^:#\n]*?)[ \t]*:")


@dataclass
class FileInfo:
    rel: str  # root-relative
    repo_rel: str  # repo-relative (what goes into node.file)
    abspath: str
    module: str
    source: str
    line_bytes: list[bytes]
    tree: ast.Module | None = None
    imports: dict[str, str] = field(default_factory=dict)  # local name -> dotted target
    import_spans: list[tuple[int, int, ast.stmt]] = field(default_factory=list)
    _script: jedi.Script | None = None


@dataclass
class Classification:
    kind: str  # resolved | external | uncertain
    target: str | None = None
    reason: str | None = None  # uncertain reason, or external sub-kind


class GraphBuilder:
    def __init__(self, repo: str, root: str, strict_parse: bool = False):
        self.repo = os.path.realpath(repo)
        self.root_rel = root.strip("/") or "."
        self.root = os.path.realpath(os.path.join(self.repo, root))
        self.strict_parse = strict_parse
        self.project = jedi.Project(self.root)
        self.files: dict[str, FileInfo] = {}
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.external_calls: list[dict] = []
        self.unresolved_injections: list[dict] = []
        self.parse_failures: list[dict] = []
        self.def_index: dict[tuple[str, int], str] = {}  # (rel, def line) -> node id
        self.ranges: dict[str, list[tuple[int, int, str]]] = {}  # rel -> [(start, end, id)]
        self.repo_def_names: set[str] = set()
        self.repo_attr_names: set[str] = set()  # names assigned as attributes/variables
        self.top_packages: set[str] = set()
        self.module_nodes: set[str] = set()
        self.call_counts: Counter = Counter()
        self.external_kinds: Counter = Counter()
        self.uncertain_reasons: Counter = Counter()
        self.notes: list[str] = []

    # ------------------------------------------------------------------ utils
    def script(self, fi: FileInfo) -> jedi.Script:
        if fi._script is None:  # exactly one jedi.Script per file
            fi._script = jedi.Script(code=fi.source, path=fi.abspath, project=self.project)
        return fi._script

    @staticmethod
    def char_col(fi: FileInfo, line: int, byte_col: int) -> int:
        """ast offsets are UTF-8 bytes; jedi wants characters."""
        return len(fi.line_bytes[line - 1][:byte_col].decode("utf-8", errors="replace"))

    def name_pos(self, fi: FileInfo, expr: ast.expr) -> tuple[int, int] | None:
        if isinstance(expr, ast.Name):
            return expr.lineno, self.char_col(fi, expr.lineno, expr.col_offset)
        if isinstance(expr, ast.Attribute):
            line = expr.end_lineno
            return line, self.char_col(fi, line, expr.end_col_offset) - len(expr.attr)
        return None

    def rel_of(self, path) -> str | None:
        if path is None:
            return None
        p = os.path.realpath(str(path))
        if not p.startswith(self.root + os.sep):
            return None
        return os.path.relpath(p, self.root).replace(os.sep, "/")

    def is_internal_module(self, dotted: str) -> bool:
        return dotted.split(".")[0] in self.top_packages

    def innermost(self, rel: str, line: int) -> str | None:
        best = None
        for start, end, nid in self.ranges.get(rel, ()):
            if start <= line <= end and (best is None or start >= best[0]):
                best = (start, nid)
        return best[1] if best else None

    def add_edge(self, source, target, etype, line, **extra):
        e = {"source": source, "target": target, "type": etype, "line": line}
        e.update(extra)
        self.edges.append(e)

    # ------------------------------------------------------------ pass 0: parse
    def load(self) -> None:
        disc = discover(self.root)
        self.discovery = disc
        for rel in disc.included:
            abspath = os.path.join(self.root, rel)
            with open(abspath, "rb") as fh:
                raw = fh.read()
            source = raw.decode("utf-8")
            fi = FileInfo(
                rel=rel,
                repo_rel=os.path.normpath(os.path.join(self.root_rel, rel)).replace(os.sep, "/"),
                abspath=abspath,
                module=module_name(rel),
                source=source,
                line_bytes=raw.splitlines(),
            )
            self.files[rel] = fi
            self.top_packages.add(fi.module.split(".")[0])
            try:
                fi.tree = ast.parse(source, filename=rel)
            except SyntaxError as exc:
                failure = {
                    "file": fi.repo_rel,
                    "error": f"SyntaxError: {exc.msg}",
                    "line": exc.lineno,
                    "python": sys.version.split()[0],
                    "recovered": False,
                    "recovery": None,
                }
                if not self.strict_parse:
                    shimmed, n = PEP758_RE.subn(r"\1except(\2):", source)
                    if n:
                        try:
                            fi.tree = ast.parse(shimmed, filename=rel)
                            failure["recovered"] = True
                            failure["recovery"] = f"pep758_except_shim ({n} rewrite(s), columns preserved)"
                        except SyntaxError as exc2:
                            failure["error"] += f"; still failing after shim: {exc2.msg} line {exc2.lineno}"
                self.parse_failures.append(failure)
        # `--root` itself may not be a package; every top-level dir/module counts.

    # ------------------------------------------------------------ pass 1: nodes
    def build_nodes(self) -> None:
        for fi in self.files.values():
            if fi.tree is None:
                continue
            self._index_imports(fi)
            mod = fi.module
            self._add_node(
                fi, mod, "module", mod.split(".")[-1], 1, max(len(fi.line_bytes), 1),
                None, ast.get_docstring(fi.tree), [],
            )
            self.module_nodes.add(mod)
            self._walk_defs(fi, fi.tree.body, "")
            for node in ast.walk(fi.tree):
                targets = []
                if isinstance(node, ast.Assign):
                    targets = node.targets
                elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                    targets = [node.target]
                for t in targets:
                    for sub in ast.walk(t):
                        if isinstance(sub, ast.Attribute):
                            self.repo_attr_names.add(sub.attr)
                        elif isinstance(sub, ast.Name) and isinstance(node, ast.AnnAssign):
                            self.repo_attr_names.add(sub.id)  # class-level fields
        for rel in self.ranges:
            self.ranges[rel].sort()

    def _add_node(self, fi, nid, ntype, name, start, end, signature, doc, decorators, def_line=None):
        if nid in self.nodes:  # property setters, conditional defs
            nid = f"{nid}@{def_line or start}"
        first = None
        if doc:
            first = next((ln.strip() for ln in doc.splitlines() if ln.strip()), None)
        self.nodes[nid] = {
            "id": nid, "type": ntype, "name": name, "file": fi.repo_rel,
            "start_line": start, "end_line": end, "signature": signature,
            "docstring": first, "decorators": decorators,
        }
        if ntype != "module":
            self.def_index[(fi.rel, def_line)] = nid
            self.ranges.setdefault(fi.rel, []).append((start, end, nid))
            self.repo_def_names.add(name)
        return nid

    def _walk_defs(self, fi, body, prefix):
        for stmt in body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kw = "async def" if isinstance(stmt, ast.AsyncFunctionDef) else "def"
                sig = f"{kw} {stmt.name}({ast.unparse(stmt.args)})"
                if stmt.returns is not None:
                    sig += f" -> {ast.unparse(stmt.returns)}"
                start = min([d.lineno for d in stmt.decorator_list] + [stmt.lineno])
                self._add_node(
                    fi, f"{fi.module}:{prefix}{stmt.name}", "function", stmt.name, start,
                    stmt.end_lineno, sig, ast.get_docstring(stmt),
                    [ast.unparse(d) for d in stmt.decorator_list], def_line=stmt.lineno,
                )
                # nested defs inside functions are not nodes (attributed to the enclosing fn)
                for sub in ast.walk(stmt):
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and sub is not stmt:
                        self.repo_def_names.add(sub.name)
            elif isinstance(stmt, ast.ClassDef):
                bases = [ast.unparse(b) for b in stmt.bases] + [ast.unparse(k) for k in stmt.keywords]
                sig = f"class {stmt.name}" + (f"({', '.join(bases)})" if bases else "")
                start = min([d.lineno for d in stmt.decorator_list] + [stmt.lineno])
                self._add_node(
                    fi, f"{fi.module}:{prefix}{stmt.name}", "class", stmt.name, start,
                    stmt.end_lineno, sig, ast.get_docstring(stmt),
                    [ast.unparse(d) for d in stmt.decorator_list], def_line=stmt.lineno,
                )
                self._walk_defs(fi, stmt.body, f"{prefix}{stmt.name}.")
            elif isinstance(stmt, (ast.If, ast.Try, ast.With, ast.AsyncWith)) or (
                sys.version_info >= (3, 11) and isinstance(stmt, getattr(ast, "TryStar", ()))
            ):
                for attr in ("body", "orelse", "finalbody"):
                    self._walk_defs(fi, getattr(stmt, attr, []), prefix)
                for h in getattr(stmt, "handlers", []):
                    self._walk_defs(fi, h.body, prefix)

    def _index_imports(self, fi: FileInfo) -> None:
        pkg = fi.module if fi.rel.endswith("__init__.py") else fi.module.rpartition(".")[0]
        for node in ast.walk(fi.tree):
            if isinstance(node, ast.Import):
                fi.import_spans.append((node.lineno, node.end_lineno, node))
                for a in node.names:
                    if a.asname:
                        fi.imports[a.asname] = a.name
                    else:
                        top = a.name.split(".")[0]
                        fi.imports.setdefault(top, top)
            elif isinstance(node, ast.ImportFrom):
                fi.import_spans.append((node.lineno, node.end_lineno, node))
                base = self._from_module(pkg, node)
                for a in node.names:
                    fi.imports[a.asname or a.name] = f"{base}.{a.name}" if base else a.name

    @staticmethod
    def _from_module(pkg: str, node: ast.ImportFrom) -> str:
        if not node.level:
            return node.module or ""
        parts = pkg.split(".") if pkg else []
        if node.level > 1:
            parts = parts[: len(parts) - (node.level - 1)]
        if node.module:
            parts.append(node.module)
        return ".".join(parts)

    def import_stmt_at(self, fi: FileInfo, line: int):
        for s, e, node in fi.import_spans:
            if s <= line <= e:
                return node
        return None

    # ------------------------------------------------------------ resolution
    def node_for_jedi_name(self, n) -> str | None:
        rel = self.rel_of(n.module_path)
        if rel is None or n.type not in ("function", "class", "property"):
            return None
        nid = self.def_index.get((rel, n.line))
        if nid is None:  # nested def inside a function -> enclosing node
            nid = self.innermost(rel, n.line)
        return nid

    def classify_defs(self, defs) -> Classification:
        internal, external = [], []
        for n in defs:
            rel = None if n.in_builtin_module() else self.rel_of(n.module_path)
            (internal if rel is not None else external).append((n, rel))
        if internal and external:
            return Classification("uncertain", reason="multiple_definitions")
        if not internal:
            return Classification("external", reason="jedi_definition")
        targets, non_nodes = set(), []
        for n, rel in internal:
            if rel not in self.files:
                non_nodes.append(("target_in_excluded_file", n))
                continue
            nid = self.node_for_jedi_name(n)
            if nid:
                targets.add(nid)
            else:
                non_nodes.append((None, n))
        if len(targets) > 1 or (targets and non_nodes):
            return Classification("uncertain", reason="multiple_definitions")
        if targets:
            return Classification("resolved", target=next(iter(targets)))
        why, n = non_nodes[0]
        if why:
            return Classification("uncertain", reason=why)
        reason = {
            "param": "callable_parameter",
            "statement": "resolves_to_variable",
            "instance": "resolves_to_variable",
            "module": "calls_module",
        }.get(n.type, f"resolves_to_{n.type}")
        return Classification("uncertain", reason=reason)

    def goto(self, fi, pos, follow=True):
        return self.script(fi).goto(pos[0], pos[1], follow_imports=follow)

    def import_origin(self, fi: FileInfo, expr: ast.Name) -> str | None:
        """If `expr` is bound by an import statement in this file, return its module."""
        pos = self.name_pos(fi, expr)
        try:
            defs = self.goto(fi, pos, follow=False)
        except Exception:
            return None
        for n in defs:
            if self.rel_of(n.module_path) != fi.rel or n.line is None:
                continue
            stmt = self.import_stmt_at(fi, n.line)
            if isinstance(stmt, ast.ImportFrom):
                pkg = fi.module if fi.rel.endswith("__init__.py") else fi.module.rpartition(".")[0]
                return self._from_module(pkg, stmt) or "."
            if isinstance(stmt, ast.Import):
                for a in stmt.names:
                    if (a.asname or a.name.split(".")[0]) == expr.id:
                        return a.name
        return None

    def classify_call(self, fi: FileInfo, call: ast.Call) -> Classification:
        func = call.func
        if isinstance(func, ast.Call):
            if isinstance(func.func, ast.Name) and func.func.id == "getattr":
                return Classification("uncertain", reason="dynamic_attribute")
            return Classification("uncertain", reason="call_result_invoked")
        if isinstance(func, ast.Subscript):
            return Classification("uncertain", reason="subscript_callee")
        if isinstance(func, ast.Lambda):
            return Classification("uncertain", reason="immediately_invoked_lambda")
        pos = self.name_pos(fi, func)
        if pos is None:
            return Classification("uncertain", reason="complex_callee_expression")
        try:
            defs = self.goto(fi, pos)
        except Exception as exc:  # pragma: no cover - defensive
            return Classification("uncertain", reason=f"jedi_error:{type(exc).__name__}")
        if defs:
            c = self.classify_defs(defs)
            if c.reason == "resolves_to_variable" and isinstance(func, ast.Attribute):
                c.reason = "callable_attribute"
            return c
        # jedi found nothing: look for evidence the target is outside the repo.
        if isinstance(func, ast.Name):
            origin = self.import_origin(fi, func)
            if origin and not self.is_internal_module(origin):
                return Classification("external", reason="unresolved_external_import")
            if origin:
                return Classification("uncertain", reason="unresolved_internal_import")
            return Classification("uncertain", reason="no_definition")
        base = func.value
        while isinstance(base, (ast.Attribute, ast.Call, ast.Subscript)):
            base = base.func if isinstance(base, ast.Call) else base.value
        if isinstance(base, ast.Name):
            origin = self.import_origin(fi, base)
            if origin and not self.is_internal_module(origin):
                return Classification("external", reason="unresolved_external_import")
        if func.attr in self.repo_attr_names:
            return Classification("uncertain", reason="callable_attribute")
        if func.attr not in self.repo_def_names:
            return Classification("external", reason="name_not_defined_in_repo")
        return Classification("uncertain", reason="receiver_type_unknown")

    # ------------------------------------------------------------ pass 2: calls
    def call_sites(self, fi: FileInfo):
        sites: list[tuple[str, ast.Call]] = []

        def handle(n, owner, in_func):
            if not in_func and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                nid = self.def_index[(fi.rel, n.lineno)]
                for d in n.decorator_list:
                    handle(d, owner, False)
                handle(n.args, owner, False)  # defaults + annotations run in the outer scope
                if n.returns is not None:
                    handle(n.returns, owner, False)
                for s in n.body:
                    handle(s, nid, True)
                return
            if not in_func and isinstance(n, ast.ClassDef):
                nid = self.def_index[(fi.rel, n.lineno)]
                for d in n.decorator_list + n.bases + [k.value for k in n.keywords]:
                    handle(d, owner, False)
                for s in n.body:
                    handle(s, nid, False)
                return
            if isinstance(n, ast.Call):
                sites.append((owner, n))
            for c in ast.iter_child_nodes(n):
                handle(c, owner, in_func)

        for s in fi.tree.body:
            handle(s, fi.module, False)
        return sites

    def build_calls(self) -> None:
        for fi in self.files.values():
            if fi.tree is None:
                continue
            for owner, call in self.call_sites(fi):
                c = self.classify_call(fi, call)
                col = self.char_col(fi, call.lineno, call.col_offset)
                callee = ast.unparse(call.func)
                if len(callee) > 80:
                    callee = callee[:77] + "..."
                self.call_counts[c.kind] += 1
                if c.kind == "resolved":
                    self.add_edge(owner, c.target, "calls", call.lineno, col=col, callee=callee)
                elif c.kind == "uncertain":
                    self.uncertain_reasons[c.reason] += 1
                    self.add_edge(owner, None, "uncertain", call.lineno, col=col, callee=callee, reason=c.reason)
                else:
                    self.external_kinds[c.reason] += 1
                    self.external_calls.append(
                        {"source": owner, "line": call.lineno, "col": col, "callee": callee, "evidence": c.reason}
                    )

    # ------------------------------------------------------------ pass 3: routes
    def str_value(self, fi: FileInfo, expr) -> tuple[str, str]:
        """Return (value, how) for a path/prefix expression."""
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            return expr.value, "literal"
        pos = self.name_pos(fi, expr) if expr is not None else None
        if pos:
            try:
                defs = self.goto(fi, pos)
            except Exception:
                defs = []
            for n in defs:
                rel = self.rel_of(n.module_path)
                tf = self.files.get(rel) if rel else None
                if not tf or tf.tree is None:
                    continue
                for node in ast.walk(tf.tree):
                    if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.lineno == n.line:
                        v = node.value
                        if isinstance(v, ast.Constant) and isinstance(v.value, str):
                            return v.value, "default_value"
        return "{" + ast.unparse(expr) + "}", "unresolved"

    def _router_tables(self):
        routers: dict[tuple[str, str], dict] = {}
        for fi in self.files.values():
            if fi.tree is None:
                continue
            # module-level routers, plus app/router objects built inside factory functions
            for stmt in ast.walk(fi.tree):
                if not (isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call)):
                    continue
                f = stmt.value.func
                fname = f.id if isinstance(f, ast.Name) else getattr(f, "attr", None)
                if fname not in ROUTER_FACTORIES:
                    continue
                prefix_expr = next(
                    (k.value for k in stmt.value.keywords if k.arg in ("prefix", "url_prefix")), None
                )
                prefix = self.str_value(fi, prefix_expr) if prefix_expr is not None else ("", "literal")
                for t in stmt.targets:
                    if isinstance(t, ast.Name) and (fi.module, t.id) not in routers:
                        routers[(fi.module, t.id)] = {
                            "kind": ROUTER_FACTORIES[fname], "prefix": prefix, "line": stmt.lineno,
                        }
        return routers

    def resolve_router_ref(self, fi, expr, routers):
        if isinstance(expr, ast.Name):
            if (fi.module, expr.id) in routers:
                return (fi.module, expr.id)
            tgt = fi.imports.get(expr.id)
            if tgt:
                mod, _, var = tgt.rpartition(".")
                if (mod, var) in routers:
                    return (mod, var)
        if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
            mod = fi.imports.get(expr.value.id)
            if mod and (mod, expr.attr) in routers:
                return (mod, expr.attr)
        return None

    def build_routes(self) -> None:
        routers = self._router_tables()
        mounts: dict[tuple, list[dict]] = {}
        for fi in self.files.values():
            if fi.tree is None:
                continue
            conditional_lines = set()
            for node in ast.walk(fi.tree):
                if isinstance(node, (ast.If, ast.Try)):
                    for sub in ast.walk(node):
                        if isinstance(sub, ast.Call) and sub is not node:
                            conditional_lines.add((sub.lineno, sub.col_offset))
            for node in ast.walk(fi.tree):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                    continue
                if node.func.attr not in ("include_router", "register_blueprint"):
                    continue
                child_expr = node.args[0] if node.args else next(
                    (k.value for k in node.keywords if k.arg in ("router", "blueprint")), None
                )
                parent = self.resolve_router_ref(fi, node.func.value, routers)
                child = self.resolve_router_ref(fi, child_expr, routers) if child_expr is not None else None
                if not (parent and child):
                    self.notes.append(f"unresolved include_router at {fi.repo_rel}:{node.lineno}")
                    continue
                pexpr = next((k.value for k in node.keywords if k.arg in ("prefix", "url_prefix")), None)
                prefix = self.str_value(fi, pexpr) if pexpr is not None else ("", "literal")
                mounts.setdefault(child, []).append(
                    {
                        "parent": parent, "prefix": prefix, "file": fi.repo_rel, "line": node.lineno,
                        "conditional": (node.lineno, node.col_offset) in conditional_lines,
                    }
                )

        def full_prefix(key, depth=0):
            info = routers[key]
            own, how = info["prefix"]
            flags = {"how": {how}, "conditional": False, "mounted": info["kind"] == "app"}
            ms = sorted(mounts.get(key, []), key=lambda m: (m["file"], m["line"]))
            if ms and depth < 10:
                m = ms[0]
                ppath, pflags = full_prefix(m["parent"], depth + 1)
                flags["how"] |= pflags["how"] | {m["prefix"][1]}
                flags["conditional"] = pflags["conditional"] or m["conditional"]
                flags["mounted"] = pflags["mounted"]
                return ppath + m["prefix"][0] + own, flags
            return own, flags

        for fi in self.files.values():
            if fi.tree is None:
                continue
            for fn in ast.walk(fi.tree):
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                handler = self.def_index.get((fi.rel, fn.lineno))
                if handler is None:
                    continue
                for dec in fn.decorator_list:
                    if not (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)):
                        continue
                    attr, recv = dec.func.attr, dec.func.value
                    if attr not in HTTP_METHODS | {"route", "api_route", "websocket"}:
                        continue
                    key = self.resolve_router_ref(fi, recv, routers)
                    if key is None and not (isinstance(recv, ast.Name) and recv.id in ROUTER_NAME_HINTS):
                        continue
                    path_expr = dec.args[0] if dec.args else next(
                        (k.value for k in dec.keywords if k.arg in ("path", "rule")), None
                    )
                    path, path_how = self.str_value(fi, path_expr) if path_expr is not None else ("", "literal")
                    if attr in HTTP_METHODS:
                        methods = [attr.upper()]
                    elif attr == "websocket":
                        methods = ["WEBSOCKET"]
                    else:
                        mexpr = next((k.value for k in dec.keywords if k.arg == "methods"), None)
                        methods = (
                            [e.value.upper() for e in mexpr.elts if isinstance(e, ast.Constant)]
                            if isinstance(mexpr, (ast.List, ast.Tuple)) else ["GET"]
                        )
                    if key:
                        prefix, flags = full_prefix(key)
                    else:
                        prefix, flags = "", {"how": {"unknown_router"}, "conditional": False, "mounted": False}
                    for method in methods:
                        full = prefix + path
                        name = f"{method} {full}"
                        rid = f"route:{name}"
                        if rid in self.nodes:
                            rid = f"{rid}@{handler}"
                        self.nodes[rid] = {
                            "id": rid, "type": "route", "name": name, "file": fi.repo_rel,
                            "start_line": dec.lineno, "end_line": dec.end_lineno,
                            "signature": None, "docstring": self.nodes[handler]["docstring"],
                            "decorators": [ast.unparse(dec)], "method": method, "path": full,
                            "local_path": path,
                            "router": f"{key[0]}:{key[1]}" if key else None,
                            "prefix_resolution": sorted(flags["how"] | {path_how}),
                            "router_mounted": flags["mounted"],
                            "conditional_mount": flags["conditional"],
                        }
                        self.add_edge(rid, handler, "routes_to", dec.lineno)
                    for kw in dec.keywords:
                        if kw.arg == "dependencies" and isinstance(kw.value, (ast.List, ast.Tuple)):
                            for el in kw.value.elts:
                                if self._is_depends(el):
                                    self._inject(fi, handler, el, None, el.lineno, "route_dependencies")

    # ------------------------------------------------------------ pass 4: injects
    @staticmethod
    def _is_depends(expr) -> bool:
        if not isinstance(expr, ast.Call):
            return False
        f = expr.func
        return (isinstance(f, ast.Name) and f.id in DEPENDS_NAMES) or (
            isinstance(f, ast.Attribute) and f.attr in DEPENDS_NAMES
        )

    @staticmethod
    def _annotated_parts(expr):
        if isinstance(expr, ast.Subscript):
            v = expr.value
            if (isinstance(v, ast.Name) and v.id == "Annotated") or (
                isinstance(v, ast.Attribute) and v.attr == "Annotated"
            ):
                if isinstance(expr.slice, ast.Tuple) and expr.slice.elts:
                    return expr.slice.elts[0], expr.slice.elts[1:]
        return None

    def _alias_value(self, fi, expr):
        """Resolve a Name/Attribute annotation to (file, value expr) of its module-level alias."""
        pos = self.name_pos(fi, expr)
        if not pos:
            return None
        try:
            defs = self.goto(fi, pos)
        except Exception:
            return None
        for n in defs:
            rel = self.rel_of(n.module_path)
            tf = self.files.get(rel) if rel else None
            if not tf or tf.tree is None or n.type not in ("statement", "instance"):
                continue
            for stmt in tf.tree.body:
                if stmt.lineno != n.line:
                    continue
                if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.value is not None:
                    return tf, stmt.value
                if sys.version_info >= (3, 12) and isinstance(stmt, getattr(ast, "TypeAlias", ())):
                    return tf, stmt.value
        return None

    def _inject(self, fi, handler, dep_call, type_expr, line, via):
        target_expr = dep_call.args[0] if dep_call.args else next(
            (k.value for k in dep_call.keywords if k.arg == "dependency"), None
        )
        if target_expr is None:  # Depends() -> dependency is the annotated type
            target_expr = type_expr
        if target_expr is None or self.name_pos(fi, target_expr) is None:
            self.unresolved_injections.append(
                {"source": handler, "line": line, "via": via, "expr": ast.unparse(dep_call), "reason": "no_dependency_expr"}
            )
            return
        try:
            c = self.classify_defs(self.goto(fi, self.name_pos(fi, target_expr)))
        except Exception:
            c = Classification("uncertain", reason="jedi_error")
        expr_txt = ast.unparse(target_expr)
        if c.kind == "resolved":
            self.add_edge(handler, c.target, "injects", line, via=via, dependency=expr_txt)
        else:
            reason = c.reason if c.kind == "uncertain" else "external_dependency"
            self.unresolved_injections.append(
                {"source": handler, "line": line, "via": via, "expr": expr_txt,
                 "defined_in": fi.repo_rel, "reason": reason}
            )

    def _scan_annotation(self, fi, handler, ann, line, via, depth=0):
        if ann is None or depth > 3:
            return
        parts = self._annotated_parts(ann)
        if parts:
            typ, meta = parts
            for m in meta:
                if self._is_depends(m):
                    self._inject(fi, handler, m, typ, line, via)
            return
        if isinstance(ann, ast.BinOp):  # X | None
            self._scan_annotation(fi, handler, ann.left, line, via, depth)
            self._scan_annotation(fi, handler, ann.right, line, via, depth)
            return
        if isinstance(ann, (ast.Name, ast.Attribute)):
            alias = self._alias_value(fi, ann)
            if alias:
                tf, value = alias
                # resolve inside the alias's own file; edge line stays at the parameter
                self._scan_alias(tf, handler, value, line, f"alias:{ast.unparse(ann)}", depth + 1)

    def _scan_alias(self, tf, handler, value, line, via, depth):
        parts = self._annotated_parts(value)
        if parts:
            typ, meta = parts
            for m in meta:
                if self._is_depends(m):
                    self._inject(tf, handler, m, typ, line, via)
        elif isinstance(value, (ast.Name, ast.Attribute)):
            self._scan_annotation(tf, handler, value, line, via, depth)

    def build_injects(self) -> None:
        for fi in self.files.values():
            if fi.tree is None:
                continue
            for fn in ast.walk(fi.tree):
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                handler = self.def_index.get((fi.rel, fn.lineno))
                if handler is None:
                    continue
                a = fn.args
                positional = a.posonlyargs + a.args
                defaults = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
                pairs = list(zip(positional, defaults)) + list(zip(a.kwonlyargs, a.kw_defaults))
                for arg, default in pairs:
                    if default is not None and self._is_depends(default):
                        self._inject(fi, handler, default, arg.annotation, arg.lineno, "default")
                    else:
                        self._scan_annotation(fi, handler, arg.annotation, arg.lineno, "annotated")

    # ------------------------------------------------------ pass 5: imports/inherits
    def build_imports_inherits(self) -> None:
        for fi in self.files.values():
            if fi.tree is None:
                continue
            pkg = fi.module if fi.rel.endswith("__init__.py") else fi.module.rpartition(".")[0]
            for node in ast.walk(fi.tree):
                targets = []
                if isinstance(node, ast.Import):
                    targets = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    base = self._from_module(pkg, node)
                    for a in node.names:
                        sub = f"{base}.{a.name}"
                        targets.append(sub if sub in self.module_nodes else base)
                for t in dict.fromkeys(targets):
                    # walk up to the closest module we have a node for
                    while t and t not in self.module_nodes:
                        t = t.rpartition(".")[0]
                    if t and t != fi.module:
                        self.add_edge(fi.module, t, "imports", node.lineno)
            for cls in ast.walk(fi.tree):
                if not isinstance(cls, ast.ClassDef):
                    continue
                cid = self.def_index.get((fi.rel, cls.lineno))
                if cid is None:
                    continue
                for b in cls.bases:
                    pos = self.name_pos(fi, b)
                    if not pos:
                        continue
                    try:
                        c = self.classify_defs(self.goto(fi, pos))
                    except Exception:
                        continue
                    if c.kind == "resolved":
                        self.add_edge(cid, c.target, "inherits", b.lineno)

    # ------------------------------------------------------------ output
    def build(self) -> dict:
        self.load()
        self.build_nodes()
        self.build_calls()
        self.build_routes()
        self.build_injects()
        self.build_imports_inherits()
        return self.to_json()

    def git_commit(self) -> str | None:
        try:
            out = subprocess.run(
                ["git", "-C", self.repo, "rev-parse", "HEAD"], capture_output=True, text=True, check=True
            )
            return out.stdout.strip()
        except Exception:
            return None

    def to_networkx(self) -> nx.MultiDiGraph:
        g = nx.MultiDiGraph()
        for nid, n in self.nodes.items():
            g.add_node(nid, **n)
        for e in self.edges:
            if e["target"] is not None:
                g.add_edge(e["source"], e["target"], **e)
        return g

    def to_json(self) -> dict:
        edge_key = lambda e: (e["type"], e["source"], e["line"], e.get("col", -1), e["target"] or "", e.get("via", ""), e.get("dependency", ""))
        edges = sorted(self.edges, key=edge_key)
        dangling = [e for e in edges if e["source"] not in self.nodes or (e["target"] is not None and e["target"] not in self.nodes)]
        g = self.to_networkx()
        resolved = self.call_counts["resolved"]
        uncertain = self.call_counts["uncertain"]
        external = self.call_counts["external"]
        internal = resolved + uncertain
        fallback_ext = external - self.external_kinds["jedi_definition"]
        strict_internal = internal + fallback_ext
        stats = {
            "files_included": len(self.files),
            "files_parsed": sum(1 for f in self.files.values() if f.tree is not None),
            "parse_failures": len(self.parse_failures),
            "parse_failures_unrecovered": sum(1 for p in self.parse_failures if not p["recovered"]),
            "nodes_by_type": dict(sorted(Counter(n["type"] for n in self.nodes.values()).items())),
            "edges_by_type": dict(sorted(Counter(e["type"] for e in edges).items())),
            "call_sites_total": resolved + uncertain + external,
            "calls_resolved": resolved,
            "calls_uncertain": uncertain,
            "calls_external": external,
            "external_by_evidence": dict(sorted(self.external_kinds.items())),
            "uncertain_by_reason": dict(sorted(self.uncertain_reasons.items(), key=lambda kv: (-kv[1], kv[0]))),
            "internal_call_sites": internal,
            "call_resolution_rate": round(resolved / internal, 4) if internal else None,
            "strict_call_resolution_rate": round(resolved / strict_internal, 4) if strict_internal else None,
            "strict_note": "strict = externals proven only by jedi; fallback-classified externals counted as uncertain",
            "unresolved_injections": len(self.unresolved_injections),
            "dangling_edges": len(dangling),
            "weakly_connected_components": nx.number_weakly_connected_components(g) if len(g) else 0,
        }
        meta = {
            "tool": "trace_parser 0.1.0",
            "repo": os.path.basename(self.repo),
            "commit": self.git_commit(),
            "root": self.root_rel,
            "python": sys.version.split()[0],
            "jedi": jedi.__version__,
            "networkx": nx.__version__,
            "strict_parse": self.strict_parse,
            "included_files": [f.repo_rel for f in self.files.values()],
            "excluded_dirs": [
                {**d, "path": os.path.normpath(os.path.join(self.root_rel, d["path"])).replace(os.sep, "/")}
                for d in self.discovery.excluded_dirs
            ],
            "excluded_files": [
                {**d, "path": os.path.normpath(os.path.join(self.root_rel, d["path"])).replace(os.sep, "/")}
                for d in self.discovery.excluded_files
            ],
            "parse_failures": self.parse_failures,
            "notes": sorted(set(self.notes)),
        }
        return {
            "meta": meta,
            "stats": stats,
            "nodes": [self.nodes[k] for k in sorted(self.nodes)],
            "edges": edges,
            "external_calls": sorted(self.external_calls, key=lambda e: (e["source"], e["line"], e["col"])),
            "unresolved_injections": sorted(
                self.unresolved_injections, key=lambda e: (e["source"], e["line"], e["expr"], e["via"])
            ),
        }
