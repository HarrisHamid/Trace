"""Pins parser v2 to the pinned demo repo. Skipped when the clone is missing."""

import os

import pytest

from backend.trace.parser import GraphBuilder

TARGET = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "third_party", "fastapi-template")
LOGIN_ROUTE = "app.api.routes.login:POST /api/v1/login/access-token"

pytestmark = pytest.mark.skipif(not os.path.isdir(TARGET), reason="target repo not cloned")


@pytest.fixture(scope="module")
def built():
    return GraphBuilder(TARGET, "backend").build()


def reachable(graph, start, types=("calls", "routes_to", "injects")):
    out: dict[str, list[str]] = {}
    for e in graph["edges"]:
        if e["type"] in types:
            out.setdefault(e["source"], []).append(e["target"])
    seen, stack = set(), [start]
    while stack:
        current = stack.pop()
        if current not in seen:
            seen.add(current)
            stack.extend(out.get(current, []))
    return seen


def test_header(built):
    graph, _ = built
    assert graph["repo"] == "fastapi/full-stack-fastapi-template"
    assert graph["commit_sha"] == "f4bcfaba7c85be3c6332cc74a20819f586dcdbc6"


def test_call_counts_are_unchanged_from_v1(built):
    graph, report = built
    assert graph["stats"]["calls_resolved"] == 59
    assert graph["stats"]["calls_uncertain"] == 0
    assert graph["stats"]["calls_external"] == 254
    assert report["calls"]["external_by_evidence"] == {
        "jedi_definition": 107, "name_not_defined_in_repo": 73, "unresolved_external_import": 74,
    }
    assert report["calls"]["strict_resolution_rate"] == 0.2864
    assert graph["stats"]["edges_by_type"]["calls"] == 59 + 254


def test_no_injection_is_lost(built):
    graph, report = built
    assert report["injections"] == {"total": 41, "resolved": 40, "external": 1, "uncertain": 0}
    assert graph["stats"]["edges_by_type"]["injects"] == 41


def test_the_current_user_chain_reaches_the_token_scheme(built):
    graph, _ = built
    assert "app.api.deps:reusable_oauth2" in reachable(graph, "app.api.deps:get_current_user")


def test_login_flow_reaches_the_database_and_the_token(built):
    graph, _ = built
    reached = reachable(graph, LOGIN_ROUTE)
    assert {"app.crud:authenticate", "app.core.security:verify_password", "app.core.security:create_access_token"} <= reached
    assert {"<unknown>:session.exec", "jwt:encode"} <= reached


def test_every_plate_has_its_own_title(built):
    graph, _ = built
    names = {n["id"]: n["name"] for n in graph["nodes"] if n["type"] == "module"}
    assert names["app.utils"] == "app.utils" and names["app.api.routes.utils"] == "routes.utils"
    assert names["app.crud"] == "crud"
