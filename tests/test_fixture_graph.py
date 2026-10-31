import ast
import os

import pytest

from backend.trace.parser import GraphBuilder
from backend.trace.parser.builder import callee_shape
from backend.trace.schemas import Graph

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
A = "fixpkg.api"
S = "fixpkg.stores"
I = "fixpkg.injected"


@pytest.fixture(scope="module")
def built():
    return GraphBuilder(FIXTURES, ".").build()


@pytest.fixture(scope="module")
def graph(built):
    return built[0]


@pytest.fixture(scope="module")
def report(built):
    return built[1]


@pytest.fixture(scope="module")
def nodes(graph):
    return {n["id"]: n for n in graph["nodes"]}


def edges(graph, etype):
    return {(e["source"], e["target"], e["line"]) for e in graph["edges"] if e["type"] == etype}


def internal_calls(graph, nodes):
    return {t for t in edges(graph, "calls") if nodes[t[1]]["type"] != "external"}


def test_output_is_the_graph_contract(graph):
    Graph.model_validate(graph)


def test_every_edge_end_is_a_node(graph, nodes, report):
    assert all(e["source"] in nodes and e["target"] in nodes for e in graph["edges"])
    assert report["dangling_edges"] == 0


def test_no_parse_failures(report):
    assert report["files"]["parse_failures"] == []
    assert report["files"]["included"] == [
        "fixpkg/__init__.py", "fixpkg/api.py", "fixpkg/deps.py", "fixpkg/helpers.py", "fixpkg/injected.py",
        "fixpkg/main.py", "fixpkg/stores.py",
    ]


def test_node_shape(nodes):
    n = {k: v for k, v in nodes["fixpkg.helpers:helper"].items() if k not in ("x", "y")}
    assert n == {
        "id": "fixpkg.helpers:helper", "type": "function", "name": "helper",
        "file": "fixpkg/helpers.py", "line_start": 4, "line_end": 6, "module": "fixpkg.helpers",
        "signature": "def helper(x)", "docstring": "Return x doubled.",
    }
    assert nodes["fixpkg.helpers:Repo.save"]["type"] == "function"
    assert nodes["fixpkg.helpers:Repo"]["type"] == "class"
    assert nodes["fixpkg.helpers"]["type"] == "module"
    assert nodes["fixpkg.helpers"]["module"] == "fixpkg.helpers"
    # nested defs are not nodes
    assert f"{A}:nested_and_lambda.inner" not in nodes and f"{A}:inner" not in nodes


def test_exact_call_edges(graph, nodes):
    assert internal_calls(graph, nodes) == {
        (f"{A}:plain_caller", f"{A}:local_fn", 19),                 # plain call
        (f"{A}:uses_import", "fixpkg.helpers:helper", 23),           # imported function
        (f"{A}:uses_alias", "fixpkg.helpers:compute", 27),           # aliased import
        (f"{A}:uses_module_attr", "fixpkg.helpers:compute", 31),     # module.attr call
        (f"{A}:Service.run", f"{A}:Service.step", 36),               # self method
        (f"{A}:Service.step", "fixpkg.helpers:Repo", 39),            # class instantiation
        (f"{A}:uses_callback", f"{A}:apply", 51),                    # passing a callback
        (f"{A}:nested_and_lambda", "fixpkg.helpers:helper", 56),     # inside nested def
        (f"{A}:nested_and_lambda", f"{A}:local_fn", 58),             # inside lambda
        (f"{A}:read_thing", "fixpkg.helpers:Repo.save", 64),         # method on Annotated alias param
        (A, f"{A}:local_fn", 72),                                    # module-level call
        ("fixpkg.deps:get_repo", "fixpkg.helpers:Repo", 9),
        (I, f"{I}:Bearer", 14),
    }


def test_uncertain_edges_end_at_unresolved_nodes(graph, nodes):
    uncertain = [e for e in graph["edges"] if e["type"] == "uncertain"]
    assert {(e["source"], e["line"], e["note"].partition(":")[0]) for e in uncertain} == {
        (f"{A}:dynamic", 43, "dynamic_attribute"),
        (f"{A}:apply", 47, "callable_parameter"),
        ("fixpkg.main:Worker.go", 20, "callable_attribute"),
        (f"{I}:by_lambda", 25, "no_dependency_expr"),
    }
    for e in uncertain:
        target, source = nodes[e["target"]], nodes[e["source"]]
        assert e["resolved"] is False
        assert target["type"] == "unresolved"
        assert target["module"] == source["module"] and target["file"] == source["file"]
        assert target["line_start"] == target["line_end"] == e["line"]
    assert nodes[f"{A}:?callback"]["name"] == "callback"


def test_each_call_site_classified_once(graph, report):
    calls, stats = report["calls"], graph["stats"]
    assert calls["total"] == calls["resolved"] + calls["uncertain"] + calls["external"]
    # getattr(obj, "save")() is two call sites starting at the same column, so key on callee too
    sites = [(c["source"], c["line"], c["col"], c["callee"]) for c in report["call_sites"]]
    assert len(sites) == len(set(sites)) == calls["total"]
    assert calls["internal"] == calls["resolved"] + calls["uncertain"]
    assert (stats["calls_resolved"], stats["calls_uncertain"], stats["calls_external"]) == (
        calls["resolved"], calls["uncertain"], calls["external"],
    )


def test_external_calls_are_edges_to_one_node_per_callee(graph, nodes, report):
    edge_count = sum(1 for e in graph["edges"] if e["type"] == "calls" and nodes[e["target"]]["type"] == "external")
    assert edge_count == graph["stats"]["calls_external"]
    n = nodes["builtins:len"]
    assert (n["file"], n["line_start"], n["line_end"], n["module"]) == ("<external>", 0, 0, "builtins")
    assert any(e["target"] == "builtins:len" and e["line"] == 69 for e in graph["edges"])
    depends = [c for c in report["call_sites"] if c["target"] == "fastapi.param_functions:Depends"]
    assert len(depends) > 1  # many sites, one node
    assert sum(1 for n in nodes if n == "fastapi.param_functions:Depends") == 1


def test_external_edges_carry_their_evidence(graph, report):
    evidence = {c["reason"] for c in report["call_sites"] if c["kind"] == "external"}
    assert evidence <= {"jedi_definition", "unresolved_external_import", "name_not_defined_in_repo"}
    notes = [e["note"] for e in graph["edges"] if e["target"] == "builtins:len"]
    assert notes and all(note.startswith("jedi_definition: ") for note in notes)


@pytest.mark.parametrize(
    ("expr", "shape"),
    [
        ("session.exec", "session.exec"),
        ("session.exec(stmt).first", "session.exec().first"),
        ("select(User).where", "select().where"),
        ("select(User).where(a).order_by(b).limit", "select()….limit"),
        ("rows[0].save", "rows[].save"),
        ("(Path(f) / 'x').read_text", "(…).read_text"),
    ],
)
def test_callee_shape_drops_arguments(expr, shape):
    assert callee_shape(ast.parse(expr, mode="eval").body) == shape


def test_routes(graph, nodes, report):
    routes = {n["name"]: n for n in graph["nodes"] if n["type"] == "route"}
    assert set(routes) == {"GET /api/v1/things/{thing_id}", "POST /api/v1/things/"}
    assert routes["GET /api/v1/things/{thing_id}"]["id"] == f"{A}:GET /api/v1/things/{{thing_id}}"
    assert routes["GET /api/v1/things/{thing_id}"]["module"] == A
    info = {r["id"]: r for r in report["routes"]}[f"{A}:GET /api/v1/things/{{thing_id}}"]
    assert info["router_mounted"] is True and info["local_path"] == "/{thing_id}"
    assert edges(graph, "routes_to") == {
        (f"{A}:GET /api/v1/things/{{thing_id}}", f"{A}:read_thing", 62),
        (f"{A}:POST /api/v1/things/", f"{A}:create_thing", 67),
    }


def test_injects(graph, report):
    assert edges(graph, "injects") == {
        (f"{A}:read_thing", "fixpkg.deps:get_repo", 63),     # alias RepoDep + default Depends(get_repo)
        (f"{A}:create_thing", "fixpkg.deps:get_repo", 67),   # route dependencies=[...]
        (f"{A}:create_thing", "fixpkg.deps:get_repo", 68),   # Annotated[..., Depends(get_repo)]
        (f"{I}:by_variable", f"{I}:bearer", 17),             # module variable
        (f"{I}:by_library_class", "fastapi.security.oauth2:OAuth2PasswordRequestForm", 21),
    }
    vias = sorted(r["via"] for r in report["injection_sites"])
    assert vias == ["alias:RepoDep", "annotated", "annotated", "annotated", "default", "default", "route_dependencies"]
    assert report["injections"] == {"total": 7, "resolved": 5, "external": 1, "uncertain": 1}


def test_dependency_nodes(nodes):
    variable = nodes[f"{I}:bearer"]
    assert variable["type"] == "dependency"
    assert (variable["file"], variable["line_start"], variable["line_end"]) == ("fixpkg/injected.py", 14, 14)
    assert variable["signature"] == "bearer = Bearer()"
    assert nodes["fixpkg.deps:get_repo"]["type"] == "dependency"  # an injected function
    assert nodes["fastapi.security.oauth2:OAuth2PasswordRequestForm"]["type"] == "external"
    assert nodes["fixpkg.helpers:helper"]["type"] == "function"


def test_imports_and_inherits(graph):
    imp = {(s, t) for s, t, _ in edges(graph, "imports")}
    assert ("fixpkg.api", "fixpkg.helpers") in imp
    assert ("fixpkg.api", "fixpkg.deps") in imp
    assert ("fixpkg.main", "fixpkg.api") in imp
    assert edges(graph, "inherits") == {
        ("fixpkg.main:Child", "fixpkg.main:Worker", 23),
        (f"{S}:MemoryStore", f"{S}:Store", 21),
        (f"{S}:DiskStore", f"{S}:Store", 32),
        (f"{S}:IntBase", f"{S}:Base", 41),  # Base[int]
    }


def test_implements(graph):
    implements = {(e["source"], e["target"], e["line"]): e for e in graph["edges"] if e["type"] == "implements"}
    assert set(implements) == {
        (f"{S}:MemoryStore.load", f"{S}:Store.load", 22),
        (f"{S}:DiskStore.load", f"{S}:Store.load", 33),
        (f"{S}:MemoryStore.flush", f"{S}:Store.flush", 25),  # raises NotImplementedError
        (f"{S}:IntBase.get", f"{S}:Base.get", 42),           # `...` body
    }
    resolved = {source.rpartition(":")[2]: e["resolved"] for (source, _, _), e in implements.items()}
    assert resolved == {"MemoryStore.load": False, "DiskStore.load": False, "MemoryStore.flush": True, "IntBase.get": True}
    assert implements[(f"{S}:DiskStore.load", f"{S}:Store.load", 33)]["note"].startswith("one of 2 implementations")


def test_a_checkout_that_is_not_its_own_repo_has_no_commit(graph):
    # The fixtures live inside Trace's own git repo, and Trace's commit is not theirs.
    assert graph["repo"] == "fixtures" and graph["commit_sha"] == "unknown"
