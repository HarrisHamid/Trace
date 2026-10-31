from collections import Counter
from pathlib import Path

import pytest

from backend.trace.schemas import ChecksFile, Graph, event_adapter

MOCK = Path(__file__).resolve().parents[1] / "data" / "mock"


@pytest.fixture(scope="module")
def graph():
    return Graph.model_validate_json((MOCK / "graph.json").read_text())


@pytest.fixture(scope="module")
def events():
    return [event_adapter.validate_json(line) for line in (MOCK / "events.jsonl").read_text().splitlines()]


@pytest.fixture(scope="module")
def checks():
    return ChecksFile.model_validate_json((MOCK / "checks.json").read_text())


def test_graph_covers_the_required_shapes(graph):
    node_types = Counter(n.type for n in graph.nodes)
    assert node_types["route"] >= 1 and node_types["dependency"] >= 1 and node_types["external"] >= 1
    edge_types = Counter(e.type for e in graph.edges)
    assert edge_types["implements"] >= 1 and edge_types["uncertain"] >= 1
    assert len({n.module for n in graph.nodes if n.type != "external"}) == 4
    assert 20 <= len(graph.nodes) <= 30


def test_graph_nodes_have_baked_positions(graph):
    assert all(n.x is not None and n.y is not None for n in graph.nodes)
    assert len({(n.x, n.y) for n in graph.nodes}) == len(graph.nodes)


def test_graph_edges_point_at_real_nodes(graph):
    ids = {n.id for n in graph.nodes}
    assert all(e.source in ids and e.target in ids for e in graph.edges)


def test_graph_uncertain_edges_are_the_unresolved_ones(graph):
    assert [e for e in graph.edges if e.type == "uncertain"] == [e for e in graph.edges if not e.resolved]


def test_graph_stats_match_the_graph(graph):
    types = {n.id: n.type for n in graph.nodes}
    calls = [e for e in graph.edges if e.type == "calls"]
    assert graph.stats.nodes_by_type == Counter(n.type for n in graph.nodes)
    assert graph.stats.edges_by_type == Counter(e.type for e in graph.edges)
    assert graph.stats.calls_external == sum(types[e.target] == "external" for e in calls)
    assert graph.stats.calls_resolved == sum(types[e.target] != "external" for e in calls)
    assert graph.stats.calls_uncertain == sum(e.type == "uncertain" for e in graph.edges)


def test_events_form_a_complete_run(events, graph):
    assert events[0].type == "run_started" and events[-1].type == "done"
    calls = [e for e in events if e.type == "tool_call"]
    results = [e for e in events if e.type == "tool_result"]
    assert [e.call_index for e in calls] == list(range(len(calls))) == [e.call_index for e in results]
    ids = {n.id for n in graph.nodes}
    assert all(e.node_id in ids for e in events if e.type == "node_visited")


def test_final_path_has_an_unverified_claim_and_a_gap(events, graph):
    final = next(e for e in events if e.type == "final_path")
    statuses = Counter(c.status for step in final.steps for c in step.claims)
    assert statuses["unverified"] == 1 and statuses["gap"] == 1
    gap_steps = [s for s in final.steps if any(c.status == "gap" for c in s.claims)]
    assert len(gap_steps) == 1
    assert {s.node_id for s in final.steps} <= {n.id for n in graph.nodes}


def test_checks_decoys_come_from_sibling_functions(checks, graph):
    assert len(checks.checks) == 5
    nodes = {n.id: n for n in graph.nodes}
    for check in checks.checks:
        target = nodes[check.node_id]
        correct = next(o for o in check.options if o.id == check.correct_option_id)
        assert correct.text == target.docstring
        siblings = {
            n.docstring for n in graph.nodes if n.module == target.module and n.type == "function" and n.id != target.id
        }
        decoys = {o.text for o in check.options if o.id != check.correct_option_id}
        assert decoys and decoys <= siblings
