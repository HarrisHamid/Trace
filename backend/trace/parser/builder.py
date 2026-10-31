"""Deterministic graph builder: ast for structure, jedi for name resolution.

Passes (in order): nodes, calls, routes, depends (injects), imports, inherits, implements, then layout.
`build()` returns the `Graph` contract plus a report holding what the contract has no slot for.
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import jedi
import networkx as nx

from ..schemas import Graph
from .discover import discover, module_name
from .layout import bake_layout

TOOL = "backend.trace.parser 0.2.0"
EXTERNAL_FILE = "<external>"
UNKNOWN_MODULE = "<unknown>"  # outside the repo, but nothing says which library

HTTP_METHODS = {"get", "post", "put", "delete", "patch", "options", "head", "trace"}
ROUTER_FACTORIES = {"APIRouter": "router", "FastAPI": "app", "Flask": "app", "Blueprint": "router"}
ROUTER_NAME_HINTS = {"router", "app", "api", "api_router", "bp", "blueprint"}
DEPENDS_NAMES = {"Depends", "Security"}
EDGE_FIELDS = ("source", "target", "type", "line", "resolved", "note")


def callee_shape(func: ast.expr) -> str:
    """The callee without its arguments: `session.exec(stmt).first` becomes `session.exec().first`.

    Query builders chain freely, so a longer chain keeps its start and its last attribute: `select()….limit`.
    Without this every query in a repo would be its own external node.
    """
    parts: list[str] = []
    node = func
    while True:
        if isinstance(node, ast.Attribute):
            parts.append("." + node.attr)
            node = node.value
        elif isinstance(node, ast.Call):
            parts.append("()")
            node = node.func
        elif isinstance(node, ast.Subscript):
            parts.append("[]")
            node = node.value
        else:
            break
    parts.append(node.id if isinstance(node, ast.Name) else "(…)")
    parts.reverse()
    first = next((i for i, part in enumerate(parts) if part in ("()", "[]")), None)
    if first is None or first >= len(parts) - 2:
        return "".join(parts)
    return "".join(parts[: first + 1]) + "…" + parts[-1]


def root_name(expr: ast.expr) -> ast.Name | None:
    while isinstance(expr, (ast.Attribute, ast.Call, ast.Subscript)):
        expr = expr.func if isinstance(expr, ast.Call) else expr.value
    return expr if isinstance(expr, ast.Name) else None


def is_abstract(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """True for @abstractmethod, and for a body that only declares: `...`, `pass`, or raising NotImplementedError."""
    for dec in fn.decorator_list:
        name = dec.attr if isinstance(dec, ast.Attribute) else getattr(dec, "id", None)
        if name == "abstractmethod":
            return True
    body = fn.body[1:] if ast.get_docstring(fn) is not None else fn.body
    if not body:
        return True
    if len(body) > 1:
        return False
    stmt = body[0]
    if isinstance(stmt, ast.Pass):
        return True
    if isinstance(stmt, ast.Expr):
        return isinstance(stmt.value, ast.Constant) and stmt.value.value is Ellipsis
    if isinstance(stmt, ast.Raise) and stmt.exc is not None:
        exc = stmt.exc.func if isinstance(stmt.exc, ast.Call) else stmt.exc
        return isinstance(exc, ast.Name) and exc.id == "NotImplementedError"
    return False


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
    module: str | None = None  # external only: the library
    name: str | None = None  # external only: qualname inside that library


class GraphBuilder:
    def __init__(self, repo: str, root: str):
        self.repo = os.path.realpath(repo)
        self.root_rel = root.strip("/") or "."
        self.root = os.path.realpath(os.path.join(self.repo, root))
        self.project = jedi.Project(self.root)
        self.files: dict[str, FileInfo] = {}
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.call_log: list[dict] = []  # one row per call site, whatever it resolved to
        self.injection_log: list[dict] = []  # one row per injection
        self.routes: dict[str, dict] = {}  # route id -> what the contract has no slot for
        self.fn_defs: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
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

    def add_edge(self, source, target, etype, line, resolved=True, note=None, col=-1):
        self.edges.append(
            {"source": source, "target": target, "type": etype, "line": line, "resolved": resolved, "note": note, "col": col}
        )

    def external_node(self, module: str, name: str) -> str:
        """One node per distinct callee, however many call sites reach it."""
        nid = f"{module}:{name}"
        self.nodes.setdefault(
            nid,
            {
                "id": nid, "type": "external", "name": name, "file": EXTERNAL_FILE, "line_start": 0, "line_end": 0,
                "module": module, "signature": None, "docstring": None,
            },
        )
        return nid

    def unresolved_node(self, owner: str, name: str, line: int) -> str:
        """The far end of an uncertain edge. It sits in the caller's module and points at the first site in that module.

        A best guess would present an inference as graph fact, and the UI needs both ends to draw the dashed edge.
        """
        module, file = self.nodes[owner]["module"], self.nodes[owner]["file"]
        nid = f"{module}:?{name}"
        self.nodes.setdefault(
            nid,
            {
                "id": nid, "type": "unresolved", "name": name, "file": file, "line_start": line, "line_end": line,
                "module": module, "signature": None, "docstring": None,
            },
        )
        return nid

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
                self.parse_failures.append(
                    {
                        "file": fi.repo_rel,
                        "error": f"SyntaxError: {exc.msg}",
                        "line": exc.lineno,
                        "python": sys.version.split()[0],
                    }
                )
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
                None, ast.get_docstring(fi.tree),
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

    def _add_node(self, fi, nid, ntype, name, start, end, signature, doc, def_line=None):
        if nid in self.nodes:  # property setters, conditional defs
            nid = f"{nid}@{def_line or start}"
        first = None
        if doc:
            first = next((ln.strip() for ln in doc.splitlines() if ln.strip()), None)
        self.nodes[nid] = {
            "id": nid, "type": ntype, "name": name, "file": fi.repo_rel,
            "line_start": start, "line_end": end, "module": fi.module, "signature": signature,
            "docstring": first,
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
                nid = self._add_node(
                    fi, f"{fi.module}:{prefix}{stmt.name}", "function", stmt.name, start,
                    stmt.end_lineno, sig, ast.get_docstring(stmt), def_line=stmt.lineno,
                )
                self.fn_defs[nid] = stmt
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
                    stmt.end_lineno, sig, ast.get_docstring(stmt), def_line=stmt.lineno,
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
            module, name = self.external_identity(defs)
            return Classification("external", reason="jedi_definition", module=module, name=name)
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

    @staticmethod
    def external_identity(defs) -> tuple[str, str]:
        """(module, qualname) of what jedi found. Overloads share a full_name, so the choice is only for determinism."""
        n = min(defs, key=lambda d: (d.full_name or "", d.module_name or "", d.name or ""))
        module = n.module_name or UNKNOWN_MODULE
        full = n.full_name or n.name
        return module, full.removeprefix(f"{module}.")

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
        imported = self.external_by_import(fi, func)
        if imported:
            return imported
        if isinstance(func, ast.Name):
            if self.import_origin(fi, func):
                return Classification("uncertain", reason="unresolved_internal_import")
            return Classification("uncertain", reason="no_definition")
        if func.attr in self.repo_attr_names:
            return Classification("uncertain", reason="callable_attribute")
        if func.attr not in self.repo_def_names:
            return Classification(
                "external", reason="name_not_defined_in_repo", module=UNKNOWN_MODULE, name=callee_shape(func)
            )
        return Classification("uncertain", reason="receiver_type_unknown")

    def external_by_import(self, fi: FileInfo, expr: ast.expr) -> Classification | None:
        """External if the root of `expr` is bound by an import from outside the repo."""
        base = root_name(expr)
        origin = self.import_origin(fi, base) if base else None
        if not origin or self.is_internal_module(origin):
            return None
        shape = callee_shape(expr)
        bound_to_module = fi.imports.get(base.id) == origin or origin.split(".")[0] == base.id
        name = shape.removeprefix(f"{base.id}.") if bound_to_module else shape
        return Classification("external", reason="unresolved_external_import", module=origin, name=name)

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
                    target = c.target
                    self.add_edge(owner, target, "calls", call.lineno, note=callee, col=col)
                elif c.kind == "uncertain":
                    self.uncertain_reasons[c.reason] += 1
                    target = self.unresolved_node(owner, callee, call.lineno)
                    self.add_edge(
                        owner, target, "uncertain", call.lineno, resolved=False, note=f"{c.reason}: {callee}", col=col
                    )
                else:
                    self.external_kinds[c.reason] += 1
                    target = self.external_node(c.module, c.name)
                    self.add_edge(owner, target, "calls", call.lineno, note=f"{c.reason}: {callee}", col=col)
                self.call_log.append(
                    {
                        "source": owner, "line": call.lineno, "col": col, "callee": callee, "kind": c.kind,
                        "target": target, "reason": c.reason,
                    }
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
                        rid = f"{fi.module}:{name}"
                        if rid in self.nodes:
                            rid = f"{rid}@{handler}"
                        self.nodes[rid] = {
                            "id": rid, "type": "route", "name": name, "file": fi.repo_rel,
                            "line_start": dec.lineno, "line_end": dec.end_lineno, "module": fi.module,
                            "signature": None, "docstring": self.nodes[handler]["docstring"],
                        }
                        self.routes[rid] = {
                            "id": rid, "decorator": ast.unparse(dec), "method": method, "path": full,
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
        expr_txt = ast.unparse(target_expr if target_expr is not None else dep_call)
        target, reason = self._dependency_target(fi, target_expr)

        def log(outcome):
            self.injection_log.append(
                {"source": handler, "line": line, "via": via, "expr": expr_txt, "outcome": outcome, "target": target,
                 "reason": reason}
            )

        note = f"{via}: {expr_txt}"
        if target is not None:
            self.add_edge(handler, target, "injects", line, note=note)
            log("external" if self.nodes[target]["type"] == "external" else "resolved")
            return
        target = self.unresolved_node(handler, expr_txt, line)
        self.add_edge(handler, target, "uncertain", line, resolved=False, note=f"{reason}: {note}")
        log("uncertain")

    def _dependency_target(self, fi, expr) -> tuple[str | None, str | None]:
        """(node id, None) when the injected thing is a node, or (None, reason) when it can't be proven to be one."""
        pos = self.name_pos(fi, expr) if expr is not None else None
        if pos is None:
            return None, "no_dependency_expr"
        try:
            defs = self.goto(fi, pos)
        except Exception:
            return None, "jedi_error"
        if not defs:
            imported = self.external_by_import(fi, expr)
            if imported:
                return self.external_node(imported.module, imported.name), None
            return None, "no_definition"
        c = self.classify_defs(defs)
        if c.kind == "resolved":
            return c.target, None
        if c.kind == "external":
            return self.external_node(c.module, c.name), None
        variable = self._dependency_variable(defs)
        return variable, None if variable else c.reason

    def _dependency_variable(self, defs) -> str | None:
        """A module-level variable that is injected, such as `reusable_oauth2 = OAuth2PasswordBearer(...)`."""
        for n in defs:
            rel = self.rel_of(n.module_path)
            tf = self.files.get(rel) if rel else None
            if not tf or tf.tree is None or n.type not in ("statement", "instance"):
                continue
            for stmt in tf.tree.body:
                if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.lineno == n.line:
                    nid = f"{tf.module}:{n.name}"
                    text = ast.unparse(stmt)
                    self.nodes.setdefault(
                        nid,
                        {
                            "id": nid, "type": "dependency", "name": n.name, "file": tf.repo_rel,
                            "line_start": stmt.lineno, "line_end": stmt.end_lineno, "module": tf.module,
                            "signature": text if len(text) <= 120 else text[:117] + "...", "docstring": None,
                        },
                    )
                    return nid
        return None

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
        for e in self.edges:  # a function reached by injection is a dependency, whoever else calls it
            if e["type"] == "injects" and self.nodes[e["target"]]["type"] == "function":
                self.nodes[e["target"]]["type"] = "dependency"

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
                    pos = self.name_pos(fi, b.value if isinstance(b, ast.Subscript) else b)  # Base[T] -> Base
                    if not pos:
                        continue
                    try:
                        c = self.classify_defs(self.goto(fi, pos))
                    except Exception:
                        continue
                    if c.kind == "resolved":
                        self.add_edge(cid, c.target, "inherits", b.lineno)

    # ------------------------------------------------------------ pass 6: implements
    def build_implements(self) -> None:
        """Link methods to the abstract ones they fill in, so a call that lands on an interface can carry on.

        Only explicit inheritance counts; structural Protocol matches are not detected. With several implementations
        each link is true, but which one runs is a runtime fact, so those edges are `resolved: false`.
        """
        parents: dict[str, set[str]] = defaultdict(set)
        for e in self.edges:
            if e["type"] == "inherits":
                parents[e["source"]].add(e["target"])

        def ancestors(cid: str) -> set[str]:
            seen: set[str] = set()
            stack = list(parents[cid])
            while stack:
                current = stack.pop()
                if current not in seen:
                    seen.add(current)
                    stack.extend(parents[current])
            return seen

        impls: dict[str, list[tuple[str, int]]] = defaultdict(list)
        for nid, fn in sorted(self.fn_defs.items()):
            cid, _, method = nid.rpartition(".")
            if ":" not in cid or self.nodes.get(cid, {}).get("type") != "class":
                continue
            for base in sorted(ancestors(cid)):
                base_fn = self.fn_defs.get(f"{base}.{method}")
                if base_fn is not None and is_abstract(base_fn):
                    impls[f"{base}.{method}"].append((nid, fn.lineno))
        for target, found in impls.items():
            many = len(found) > 1
            note = f"one of {len(found)} implementations; which one runs is decided at runtime" if many else None
            for nid, line in found:
                self.add_edge(nid, target, "implements", line, resolved=not many, note=note)

    # ------------------------------------------------------------ output
    def build(self) -> tuple[dict, dict]:
        self.load()
        self.build_nodes()
        self.build_calls()
        self.build_routes()
        self.build_injects()
        self.build_imports_inherits()
        self.build_implements()
        return self.to_contract(), self.to_report()

    def git_info(self) -> tuple[str, str]:
        """(owner/name, commit) of the repo, or the folder name and "unknown" if it isn't its own git checkout."""
        fallback = os.path.basename(self.repo), "unknown"

        def git(*args):
            out = subprocess.run(["git", "-C", self.repo, *args], capture_output=True, text=True, check=True)
            return out.stdout.strip()

        try:
            if os.path.realpath(git("rev-parse", "--show-toplevel")) != self.repo:
                return fallback
            commit = git("rev-parse", "HEAD")
        except Exception:
            return fallback
        try:
            found = re.search(r"github\.com[:/](.+?)(?:\.git)?$", git("remote", "get-url", "origin"))
        except Exception:
            found = None
        return (found.group(1) if found else fallback[0]), commit

    def sorted_edges(self) -> list[dict]:
        return sorted(self.edges, key=lambda e: (e["type"], e["source"], e["line"] or 0, e["col"], e["target"], e["note"] or ""))

    def to_contract(self) -> dict:
        repo, commit = self.git_info()
        nodes = [self.nodes[k] for k in sorted(self.nodes)]
        edges = [{k: e[k] for k in EDGE_FIELDS} for e in self.sorted_edges()]
        modules = [n for n in nodes if n["type"] == "module"]
        counts = Counter(n["name"] for n in modules)
        for n in modules:  # the name is the plate's title, and two plates called `utils` read as one thing
            if counts[n["name"]] > 1:
                n["name"] = ".".join(n["id"].split(".")[-2:])
        bake_layout(nodes, edges)
        resolved, uncertain = self.call_counts["resolved"], self.call_counts["uncertain"]
        internal = resolved + uncertain
        graph = {
            "repo": repo,
            "commit_sha": commit,
            "nodes": nodes,
            "edges": edges,
            "stats": {
                "nodes_by_type": dict(sorted(Counter(n["type"] for n in nodes).items())),
                "edges_by_type": dict(sorted(Counter(e["type"] for e in edges).items())),
                "calls_resolved": resolved,
                "calls_uncertain": uncertain,
                "calls_external": self.call_counts["external"],
                "call_resolution_rate": round(resolved / internal, 4) if internal else None,
            },
        }
        Graph.model_validate(graph)
        return graph

    def to_networkx(self) -> nx.MultiDiGraph:
        g = nx.MultiDiGraph()
        for nid, n in self.nodes.items():
            g.add_node(nid, **n)
        for e in self.edges:
            g.add_edge(e["source"], e["target"], **e)
        return g

    def to_report(self) -> dict:
        """Everything the honest claims rest on that the Graph contract has no slot for. Written next to graph.json."""
        repo, commit = self.git_info()
        resolved, uncertain = self.call_counts["resolved"], self.call_counts["uncertain"]
        external = self.call_counts["external"]
        internal = resolved + uncertain
        strict_internal = internal + external - self.external_kinds["jedi_definition"]
        outcomes = Counter(row["outcome"] for row in self.injection_log)

        def repo_path(entry):
            return {**entry, "path": os.path.normpath(os.path.join(self.root_rel, entry["path"])).replace(os.sep, "/")}

        return {
            "tool": TOOL,
            "repo": repo,
            "commit_sha": commit,
            "root": self.root_rel,
            "python": sys.version.split()[0],
            "jedi": jedi.__version__,
            "networkx": nx.__version__,
            "files": {
                "included": [f.repo_rel for f in self.files.values()],
                "parsed": sum(1 for f in self.files.values() if f.tree is not None),
                "excluded_dirs": [repo_path(d) for d in self.discovery.excluded_dirs],
                "excluded_files": [repo_path(d) for d in self.discovery.excluded_files],
                "parse_failures": self.parse_failures,
            },
            "calls": {
                "total": resolved + uncertain + external,
                "resolved": resolved,
                "uncertain": uncertain,
                "external": external,
                "internal": internal,
                "resolution_rate": round(resolved / internal, 4) if internal else None,
                "strict_resolution_rate": round(resolved / strict_internal, 4) if strict_internal else None,
                "strict_note": "strict = externals proven only by jedi; externals classified by rule count as uncertain",
                "external_by_evidence": dict(sorted(self.external_kinds.items())),
                "uncertain_by_reason": dict(sorted(self.uncertain_reasons.items(), key=lambda kv: (-kv[1], kv[0]))),
            },
            "injections": {
                "total": len(self.injection_log),
                "resolved": outcomes["resolved"],
                "external": outcomes["external"],
                "uncertain": outcomes["uncertain"],
            },
            "dangling_edges": sum(1 for e in self.edges if e["source"] not in self.nodes or e["target"] not in self.nodes),
            "weakly_connected_components": nx.number_weakly_connected_components(self.to_networkx()),
            "notes": sorted(set(self.notes)),
            "routes": [self.routes[k] for k in sorted(self.routes)],
            "call_sites": sorted(self.call_log, key=lambda r: (r["source"], r["line"], r["col"], r["callee"])),
            "injection_sites": sorted(self.injection_log, key=lambda r: (r["source"], r["line"], r["expr"], r["via"])),
        }
