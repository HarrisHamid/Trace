"""Scoring for eval/run_eval.py. Nothing here calls the model."""

from types import SimpleNamespace

import pytest

from backend.trace.schemas import Claim, PathStep
from backend.trace.schemas.events import Done, ErrorEvent, FinalPath, RunStarted, ToolCall
from eval.run_eval import check_labels, report, score_run


def question(must, should=(), checked=True):
    return {"id": "q", "must_reach": list(must), "should_reach": list(should), "human_checked": checked}


def step(node_id, *statuses):
    claims = [Claim(text="where", status="verified"), *(Claim(text="c", status=s) for s in statuses)]
    return PathStep(node_id=node_id, explanation="why", claims=claims)


def run(*steps):
    call = ToolCall(type="tool_call", name="find_node", args={}, call_index=0)
    return [RunStarted(type="run_started"), call, FinalPath(type="final_path", steps=list(steps)), Done(type="done")]


def test_recall_counts_only_nodes_in_the_final_path():
    score = score_run(question(["a", "b"], ["c"]), run(step("a"), step("c")), 1.0)
    assert (score.must_hit, score.must_total, score.should_hit, score.should_total) == (1, 2, 1, 1)
    assert score.missed == ["b"]


def test_a_validator_written_claim_does_not_count_as_the_models():
    score = score_run(question(["a"]), run(step("a", "verified", "unverified")), 1.0)
    assert (score.claims_verified, score.claims_total) == (1, 2)


def test_a_gap_is_counted_wherever_it_sits():
    gap_step = PathStep(node_id="a", explanation="why", claims=[Claim(text="no edge", status="gap")])
    assert score_run(question(["a"]), run(gap_step), 1.0).gaps == 1


def test_a_failed_run_scores_nothing_and_says_why():
    events = [RunStarted(type="run_started"), ErrorEvent(type="error", message="boom"), Done(type="done")]
    score = score_run(question(["a"]), events, 1.0)
    assert (score.must_hit, score.error) == (0, "boom")
    assert "boom" in report([score])


def test_unchecked_questions_stay_out_of_the_checked_line():
    checked = score_run(question(["a"]), run(step("a")), 1.0)
    unchecked = score_run(question(["a"], checked=False), run(step("b")), 1.0)
    text = report([checked, unchecked])
    assert "1 of 2 questions" in text
    assert "| Checked by hand | 1 | 100% |" in text
    assert "| All, including unchecked | 2 | 50% |" in text


def test_a_label_naming_no_node_stops_the_eval():
    with pytest.raises(SystemExit, match="not in the graph"):
        check_labels([question(["made:up"])], SimpleNamespace(nodes=[]))
