"""Scoring for eval/run_eval.py. Nothing here calls the model."""

from types import SimpleNamespace

import pytest

from backend.trace.schemas import Claim, PathStep
from backend.trace.schemas.events import Done, ErrorEvent, FinalPath, RepairFinished, RunStarted, ToolCall
from eval.run_eval import (
    NO_ANSWER,
    CountingClient,
    added_nodes,
    audit_cell,
    check_budget,
    check_labels,
    check_nothing_lost,
    dollars,
    final_steps,
    find_flips,
    first_steps,
    report,
    run_outcome,
    run_question,
    score_run,
)


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


def repaired_run(first, repaired, outcome="accepted"):
    events = run(*first)
    events.insert(3, RepairFinished(type="repair_finished", outcome=outcome, steps=repaired))
    return events


def test_the_final_answer_is_the_repair_only_when_it_was_accepted():
    first, fixed = [step("a", "unverified")], [step("a", "verified")]
    accepted = repaired_run(first, fixed)
    assert (first_steps(accepted), final_steps(accepted)) == (first, fixed)
    assert final_steps(repaired_run(first, [], "no_improvement")) == first
    assert final_steps(run(*first)) == first


def test_the_score_of_a_repaired_run_is_the_final_answer():
    score = score_run(question(["a"]), repaired_run([step("a", "unverified")], [step("a", "verified")]), 1.0)
    assert (score.claims_verified, score.claims_total) == (1, 1)


def test_a_run_that_failed_is_never_reported_as_having_nothing_to_repair():
    failed = [RunStarted(type="run_started"), ErrorEvent(type="error", message="boom"), Done(type="done")]
    assert run_outcome(failed) == NO_ANSWER
    assert run_outcome(run(step("a"))) == "nothing to repair"
    assert run_outcome(repaired_run([step("a", "unverified")], [], "failed")) == "failed"


def test_a_flip_is_found_wherever_the_claim_ended_up():
    moved_to = PathStep(node_id="b", explanation="why", claims=[Claim(text="where", status="verified")])
    moved_to.claims.append(Claim(text="c", quote="the quote", status="verified"))
    first = [step("a", "unverified"), step("b")]
    final = [step("a"), moved_to]
    flips = find_flips("q", "round-1", first, final)
    assert [(f.node, f.moved_from, f.quote) for f in flips] == [("b", "a", "the quote")]


def test_a_claim_that_stayed_unverified_is_not_a_flip():
    same = [step("a", "unverified")]
    assert find_flips("q", "round-1", same, same) == []


def test_added_nodes_are_the_inserted_steps():
    first = [step("a"), step("c")]
    assert added_nodes(first, [step("a"), step("b"), step("c")]) == ["b"]
    assert added_nodes(first, first) == []


@pytest.mark.parametrize(
    "final",
    [[step("a")], [step("a", "verified"), step("c")]],
    ids=["a node is gone", "a claim is gone"],
)
def test_a_repair_that_lost_anything_stops_the_eval(final):
    with pytest.raises(SystemExit, match="lost something"):
        check_nothing_lost("q", [step("a", "unverified", "verified"), step("b")], final)


def test_an_audit_row_stays_on_one_line():
    assert audit_cell("a  |\n  b") == "a \\| b"


def test_dollars_use_the_published_prices():
    assert dollars([{"input_tokens": 1_000_000, "output_tokens": 1_000_000}]) == pytest.approx(5.5)


class FakeModel:
    def __init__(self):
        self.options = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def with_options(self, **options):
        self.options.append(options)
        return self

    async def create(self, **request):
        return SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=2))


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_counting_survives_with_options_so_the_repair_call_is_counted():
    calls, model = [], FakeModel()
    await CountingClient(model, calls).create(messages=[])
    format_ = {"json_schema": {"name": "path_repair"}}
    await CountingClient(model, calls).with_options(timeout=1).create(messages=[], response_format=format_)
    assert [(c["kind"], c["input_tokens"], c["output_tokens"]) for c in calls] == [
        ("tools", 10, 2),
        ("path_repair", 10, 2),
    ]


@pytest.mark.anyio
async def test_a_saved_run_is_never_overwritten(tmp_path):
    (tmp_path / "q.json").write_text("{}")
    with pytest.raises(SystemExit, match="Refusing"):
        await run_question({"id": "q", "question": "?"}, None, None, tmp_path)


def test_every_limit_stops_a_run(tmp_path, monkeypatch):
    monkeypatch.setattr("eval.run_eval.REPAIR_DIR", tmp_path)
    (tmp_path / "a.json").write_text('{"calls": [{"input_tokens": 0, "output_tokens": 2000000}]}')
    monkeypatch.setattr("eval.run_eval.MAX_LIVE_RUNS", 5)
    with pytest.raises(SystemExit, match="Stopped"):
        check_budget()
    monkeypatch.setattr("eval.run_eval.MAX_DOLLARS", 100)
    monkeypatch.setattr("eval.run_eval.MAX_LIVE_RUNS", 1)
    with pytest.raises(SystemExit, match="Stopped"):
        check_budget()
