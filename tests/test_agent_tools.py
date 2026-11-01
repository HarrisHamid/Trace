import json
from pathlib import Path

import pytest

from backend.trace.tools import GraphIndex, run_tool, tool_schemas

MOCK = Path(__file__).resolve().parents[1] / "data" / "mock"
LOGIN = "taskboard.api.auth:login"
AUTHENTICATE = "taskboard.services.users:UserService.authenticate"
EXTERNAL = "jwt:encode"


@pytest.fixture
def index():
    return GraphIndex.load(MOCK / "graph.json", MOCK / "source")


def call(index, name, **args):
    outcome = run_tool(index, name, json.dumps(args))
    return json.loads(outcome.content), outcome


def test_every_tool_has_a_closed_schema():
    schemas = tool_schemas()
    assert {s["function"]["name"] for s in schemas} == {
        "search_nodes",
        "find_routes",
        "get_node",
        "get_neighbors",
        "follow_injections",
        "read_source",
    }
    assert all(s["function"]["parameters"]["additionalProperties"] is False for s in schemas)


def test_search_ranks_an_exact_name_first_and_hides_stubs(index):
    data, outcome = call(index, "search_nodes", query="login")
    assert data["matches"][0]["node_id"] == LOGIN
    assert outcome.summary.startswith(f"{data['total']} match")


def test_search_falls_back_to_external_nodes(index):
    data, _ = call(index, "search_nodes", query="bcrypt.verify")
    assert data["matches"][0]["node_id"] == "passlib.hash:bcrypt.verify"


def test_search_with_no_match_says_so(index):
    data, outcome = call(index, "search_nodes", query="zzzz")
    assert data == {"matches": [], "total": 0}
    assert outcome.summary == "No matches."


def test_find_routes_names_the_handler(index):
    data, _ = call(index, "find_routes", query="login")
    assert data["routes"] == [{"node_id": "taskboard.api.auth:POST /api/login", "handler": LOGIN}]


def test_get_node_reports_where_it_is_and_marks_a_visit(index):
    data, outcome = call(index, "get_node", node_id=LOGIN)
    assert (data["file"], data["line_start"]) == ("taskboard/api/auth.py", 12)
    assert list(outcome.visited) == [LOGIN]


def test_neighbors_show_both_directions_with_repo_code_first(index):
    data, _ = call(index, "get_neighbors", node_id=LOGIN, direction="both")
    assert {row["direction"] for row in data["neighbors"]} == {"in", "out"}
    types = [row["type"] for row in data["neighbors"]]
    assert types == sorted(types, key=lambda kind: kind == "external")


def test_neighbors_show_the_uncertain_edge(index):
    data, _ = call(index, "get_neighbors", node_id=AUTHENTICATE)
    uncertain = [row for row in data["neighbors"] if not row["resolved"]]
    assert [row["node_id"] for row in uncertain] == ["taskboard.services.users:?self.rehash"]


def test_follow_injections_walks_the_chain_and_survives_a_cycle(index):
    data, _ = call(index, "follow_injections", node_id="taskboard.api.auth:read_me")
    reached = {link["to"] for link in data["chain"]}
    assert {"taskboard.api.deps:get_current_user", "taskboard.api.deps:get_session"} <= reached


def test_read_source_returns_the_original_text(index):
    data, outcome = call(index, "read_source", node_id=LOGIN)
    assert data["start_line"] == 12
    assert "users.authenticate(form.email, form.password)" in data["source"]
    assert list(outcome.visited) == [LOGIN]


def test_read_source_refuses_a_node_with_no_source(index):
    data, outcome = call(index, "read_source", node_id=EXTERNAL)
    assert "no source" in data["error"]
    assert outcome.visited == {}


@pytest.mark.parametrize("name", ["get_node", "get_neighbors", "follow_injections", "read_source"])
def test_an_unknown_node_is_an_error_for_the_model(index, name):
    data, outcome = call(index, name, node_id="nope")
    assert "search_nodes" in data["error"]
    assert outcome.visited == {}


@pytest.mark.parametrize(
    ("name", "raw"),
    [("get_node", "{}"), ("get_node", '{"node_id": 3}'), ("get_node", "not json"), ("get_node", '{"node_id": "a", "b": 1}')],
)
def test_bad_arguments_are_an_error_for_the_model(index, name, raw):
    assert "Bad arguments" in json.loads(run_tool(index, name, raw).content)["error"]


def test_an_unknown_tool_is_an_error_for_the_model(index):
    assert "No tool" in json.loads(run_tool(index, "delete_repo", "{}").content)["error"]
