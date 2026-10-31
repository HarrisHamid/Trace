import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.trace.schemas import Check, ChecksFile, Graph, GraphStats, event_adapter
from backend.trace.schemas.events import MAX_TOOL_CALLS

ROOT = Path(__file__).resolve().parents[1]


def node(nid="m:f"):
    return {"id": nid, "type": "function", "name": "f", "file": "m.py", "line_start": 1, "line_end": 2, "module": "m"}


def stats(resolved=1, uncertain=1, external=0, rate=0.5):
    return {
        "nodes_by_type": {"function": 1},
        "edges_by_type": {},
        "calls_resolved": resolved,
        "calls_uncertain": uncertain,
        "calls_external": external,
        "call_resolution_rate": rate,
    }


def graph(nodes):
    return {"repo": "r", "commit_sha": "abc", "nodes": nodes, "edges": [], "stats": stats()}


def check(option_ids=("a", "b"), correct="a"):
    return {
        "node_id": "m:f",
        "question": "q",
        "options": [{"id": oid, "text": oid} for oid in option_ids],
        "correct_option_id": correct,
        "explanation": "e",
    }


def test_graph_accepts_distinct_node_ids():
    assert len(Graph.model_validate(graph([node("m:f"), node("m:g")])).nodes) == 2


def test_graph_rejects_duplicate_node_ids():
    with pytest.raises(ValidationError, match=r"duplicate node ids: \['m:f'\]"):
        Graph.model_validate(graph([node("m:f"), node("m:f")]))


def test_rate_formula_is_resolved_over_resolved_plus_uncertain():
    assert GraphStats.model_validate(stats(resolved=3, uncertain=1, rate=0.75)).call_resolution_rate == 0.75
    with pytest.raises(ValidationError, match="call_resolution_rate must be 0.75"):
        GraphStats.model_validate(stats(resolved=3, uncertain=1, rate=0.5))


def test_rate_ignores_externals():
    parsed = GraphStats.model_validate(stats(resolved=1, uncertain=1, external=98, rate=0.5))
    assert parsed.calls_external == 98


def test_rate_is_null_without_internal_calls():
    assert GraphStats.model_validate(stats(resolved=0, uncertain=0, rate=None)).call_resolution_rate is None
    with pytest.raises(ValidationError):
        GraphStats.model_validate(stats(resolved=0, uncertain=0, rate=0.0))


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "run_started"},
        {"type": "tool_call", "name": "search", "args": {"q": "x"}, "call_index": 0},
        {"type": "tool_result", "call_index": 0, "summary": "s"},
        {"type": "node_visited", "node_id": "m:f", "reason": "r"},
        {"type": "final_path", "steps": [{"node_id": "m:f", "explanation": "e", "claims": []}]},
        {"type": "error", "message": "m"},
        {"type": "done"},
    ],
)
def test_event_union_parses_every_type(payload):
    assert event_adapter.validate_python(payload).type == payload["type"]


def test_event_union_rejects_unknown_type():
    with pytest.raises(ValidationError):
        event_adapter.validate_python({"type": "nope"})


def test_claim_status_is_closed():
    step = {"node_id": "m:f", "explanation": "e", "claims": [{"text": "t", "status": "maybe"}]}
    with pytest.raises(ValidationError):
        event_adapter.validate_python({"type": "final_path", "steps": [step]})


def test_tool_call_cap_is_documented_not_enforced():
    event_adapter.validate_python({"type": "tool_result", "call_index": MAX_TOOL_CALLS + 1, "summary": "s"})
    assert str(MAX_TOOL_CALLS) in (ROOT / "docs/contracts/events.schema.json").read_text()


def test_check_accepts_consistent_options():
    assert Check.model_validate(check()).correct_option_id == "a"


def test_check_rejects_duplicate_option_ids():
    with pytest.raises(ValidationError, match=r"duplicate option ids: \['a'\]"):
        Check.model_validate(check(option_ids=("a", "a", "b")))


def test_check_rejects_unknown_correct_option():
    with pytest.raises(ValidationError, match="is not an option"):
        Check.model_validate(check(correct="z"))


def test_checks_file_validates_its_checks():
    with pytest.raises(ValidationError):
        ChecksFile.model_validate({"repo": "r", "checks": [check(correct="z")]})


def test_contracts_are_rejected_on_unknown_fields():
    with pytest.raises(ValidationError):
        Check.model_validate({**check(), "extra": 1})


def test_exported_schemas_match_the_models():
    subprocess.run([sys.executable, "scripts/export_schemas.py", "--check"], cwd=ROOT, check=True)
