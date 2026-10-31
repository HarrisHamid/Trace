import os

import pytest

from backend.trace.parser import GraphBuilder

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
A = "fixpkg.api"


@pytest.fixture(scope="module")
def graph():
    return GraphBuilder(FIXTURES, ".").build()


def edges(graph, etype):
    return {(e["source"], e["target"], e["line"]) for e in graph["edges"] if e["type"] == etype}


def uncertain(graph):
    return {(e["source"], e["line"], e["reason"]) for e in graph["edges"] if e["type"] == "uncertain"}


def test_no_parse_failures(graph):
    assert graph["meta"]["parse_failures"] == []
    assert graph["meta"]["included_files"] == [
        "fixpkg/__init__.py", "fixpkg/api.py", "fixpkg/deps.py", "fixpkg/helpers.py", "fixpkg/main.py",
    ]


def test_node_shape(graph):
    nodes = {n["id"]: n for n in graph["nodes"]}
    n = nodes["fixpkg.helpers:helper"]
    assert n == {
        "id": "fixpkg.helpers:helper", "type": "function", "name": "helper",
        "file": "fixpkg/helpers.py", "start_line": 4, "end_line": 6,
        "signature": "def helper(x)", "docstring": "Return x doubled.", "decorators": [],
    }
    assert nodes["fixpkg.helpers:Repo.save"]["type"] == "function"
    assert nodes["fixpkg.helpers:Repo"]["type"] == "class"
    assert nodes["fixpkg.helpers"]["type"] == "module"
    assert nodes[f"{A}:read_thing"]["decorators"] == ['router.get(\'/{thing_id}\')']
    # nested defs are not nodes
    assert f"{A}:nested_and_lambda.inner" not in nodes and f"{A}:inner" not in nodes


def test_exact_call_edges(graph):
    assert edges(graph, "calls") == {
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
    }


def test_exact_uncertain_edges(graph):
    assert uncertain(graph) == {
        (f"{A}:dynamic", 43, "dynamic_attribute"),
        (f"{A}:apply", 47, "callable_parameter"),
        ("fixpkg.main:Worker.go", 20, "callable_attribute"),
    }
    for e in graph["edges"]:
        if e["type"] == "uncertain":
            assert e["target"] is None and e["reason"]


def test_each_call_site_classified_once(graph):
    s = graph["stats"]
    assert s["call_sites_total"] == s["calls_resolved"] + s["calls_uncertain"] + s["calls_external"]
    # getattr(obj, "save")() is two call sites starting at the same column, so key on callee too
    key = lambda e: (e["source"], e["line"], e["col"], e["callee"])
    sites = [key(e) for e in graph["edges"] if e["type"] in ("calls", "uncertain")]
    sites += [key(e) for e in graph["external_calls"]]
    assert len(sites) == len(set(sites)) == s["call_sites_total"]
    # builtin len() is external: counted, but no edge
    assert any(e["callee"] == "len" and e["line"] == 69 for e in graph["external_calls"])
    assert s["internal_call_sites"] == s["calls_resolved"] + s["calls_uncertain"]


def test_routes(graph):
    routes = {n["name"]: n for n in graph["nodes"] if n["type"] == "route"}
    assert set(routes) == {"GET /api/v1/things/{thing_id}", "POST /api/v1/things/"}
    r = routes["GET /api/v1/things/{thing_id}"]
    assert r["router_mounted"] is True and r["local_path"] == "/{thing_id}"
    assert edges(graph, "routes_to") == {
        ("route:GET /api/v1/things/{thing_id}", f"{A}:read_thing", 62),
        ("route:POST /api/v1/things/", f"{A}:create_thing", 67),
    }


def test_injects(graph):
    assert edges(graph, "injects") == {
        (f"{A}:read_thing", "fixpkg.deps:get_repo", 63),     # alias RepoDep + default Depends(get_repo)
        (f"{A}:create_thing", "fixpkg.deps:get_repo", 67),   # route dependencies=[...]
        (f"{A}:create_thing", "fixpkg.deps:get_repo", 68),   # Annotated[..., Depends(get_repo)]
    }
    vias = sorted(e["via"] for e in graph["edges"] if e["type"] == "injects")
    assert vias == ["alias:RepoDep", "annotated", "default", "route_dependencies"]


def test_imports_and_inherits(graph):
    imp = {(s, t) for s, t, _ in edges(graph, "imports")}
    assert ("fixpkg.api", "fixpkg.helpers") in imp
    assert ("fixpkg.api", "fixpkg.deps") in imp
    assert ("fixpkg.main", "fixpkg.api") in imp
    assert edges(graph, "inherits") == {("fixpkg.main:Child", "fixpkg.main:Worker", 23)}


def test_no_dangling_edges(graph):
    assert graph["stats"]["dangling_edges"] == 0
