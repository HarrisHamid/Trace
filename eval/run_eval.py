"""Run eval/questions.json through the live agent and score each answer's path. No model decides a score.

    run_eval.py --round N        run every question once into eval/runs-repair/round-N/, write eval/results-repair.md
    run_eval.py --smoke ID       run one question into eval/runs-repair/smoke/, which is not scored
    run_eval.py --demo Q --attempt N    run question Q into eval/runs-repair/demo/, which is not scored
    run_eval.py --score-repair   score the saved repair rounds again
    run_eval.py --score          score the baseline in eval/runs/ again, for when the labels change

Every question runs live, never from the demo's cached answers, and every run counts: a bad one is not retried.
eval/runs/ is the baseline from before repair existed. Nothing here writes to it, and no run overwrites another.
"""

import argparse
import asyncio
import json
import re
import statistics
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from backend.trace.agent import run_agent
from backend.trace.api.app import model_client
from backend.trace.api.settings import REPO_ROOT, Settings
from backend.trace.schemas import Graph, PathStep, event_adapter
from backend.trace.schemas.events import Event
from backend.trace.tools import GraphIndex

EVAL_DIR = REPO_ROOT / "eval"
DATA_DIR = REPO_ROOT / "data" / "fastapi-template"
SOURCE_DIR = REPO_ROOT / "third_party" / "fastapi-template"
REPAIR_DIR = EVAL_DIR / "runs-repair"
REPAIR_RESULTS = EVAL_DIR / "results-repair.md"
AUDIT_PATH = EVAL_DIR / "repair-audit.md"

INPUT_DOLLARS_PER_TOKEN = 1.25 / 1_000_000
OUTPUT_DOLLARS_PER_TOKEN = 4.25 / 1_000_000
NO_ANSWER = "no answer, run failed"
# The owner's limits for the repair work. Past either one, stop and ask.
MAX_LIVE_RUNS = 26
MAX_DOLLARS = 5.0


@dataclass(frozen=True)
class Score:
    id: str
    checked: bool
    must_hit: int
    must_total: int
    should_hit: int
    should_total: int
    missed: list[str]
    claims_verified: int
    claims_total: int
    gaps: int
    tool_calls: int
    seconds: float
    error: str | None


def first_steps(events: list[Event]) -> list[PathStep]:
    return next((event.steps for event in events if event.type == "final_path"), [])


def final_steps(events: list[Event]) -> list[PathStep]:
    """The answer the user ends up with: the repaired path if it was accepted, or else the first one."""
    finished = next((e for e in events if e.type == "repair_finished" and e.outcome == "accepted"), None)
    return finished.steps if finished else first_steps(events)


def score_run(question: dict, events: list[Event], seconds: float) -> Score:
    return score_steps(question, final_steps(events), events, seconds)


def score_steps(question: dict, steps: list[PathStep], events: list[Event], seconds: float) -> Score:
    """Recall is over the final path only. A node the agent read but left out of its answer does not count."""
    reached = {step.node_id for step in steps}
    must, should = question["must_reach"], question["should_reach"]
    # The first claim of each step is written by the validator from the graph. The rest are the model's.
    model_claims = [claim for step in steps for claim in step.claims[1:]]
    return Score(
        id=question["id"],
        checked=question["human_checked"],
        must_hit=sum(node in reached for node in must),
        must_total=len(must),
        should_hit=sum(node in reached for node in should),
        should_total=len(should),
        missed=[node for node in must if node not in reached],
        claims_verified=sum(claim.status == "verified" for claim in model_claims),
        claims_total=len(model_claims),
        gaps=sum(claim.status == "gap" for step in steps for claim in step.claims),
        tool_calls=sum(event.type == "tool_call" for event in events),
        seconds=seconds,
        error=next((event.message for event in events if event.type == "error"), None),
    )


def check_labels(questions: list[dict], graph: Graph) -> None:
    """A label naming no node could never be reached, and would read as an agent failure."""
    ids = {node.id for node in graph.nodes}
    unknown = [node for q in questions for node in q["must_reach"] + q["should_reach"] if node not in ids]
    if unknown:
        raise SystemExit(f"Labels name nodes that are not in the graph: {unknown}")


def percent(part: int, whole: int) -> str:
    return f"{part / whole:.0%}" if whole else "n/a"


def totals(label: str, scores: list[Score]) -> str:
    if not scores:
        return f"| {label} | 0 | n/a | n/a | n/a | 0 | n/a | n/a |"
    must = percent(sum(s.must_hit for s in scores), sum(s.must_total for s in scores))
    should = percent(sum(s.should_hit for s in scores), sum(s.should_total for s in scores))
    claims = percent(sum(s.claims_verified for s in scores), sum(s.claims_total for s in scores))
    calls = statistics.mean(s.tool_calls for s in scores)
    seconds = statistics.median(s.seconds for s in scores)
    gaps = sum(s.gaps for s in scores)
    return f"| {label} | {len(scores)} | {must} | {should} | {claims} | {gaps} | {calls:.1f} | {seconds:.0f}s |"


def report(scores: list[Score]) -> str:
    checked = [score for score in scores if score.checked]
    lines = [
        "# Eval results",
        "",
        f"{len(checked)} of {len(scores)} questions have labels checked by a human. Only those count as results.",
        "",
        "One live run per question, on the pinned demo repo. Nothing was retried or picked.",
        "",
        "| Questions | Runs | Must reach | Should reach | Model claims verified | Gaps | Tool calls | Median time |",
        "|---|---|---|---|---|---|---|---|",
        totals("Checked by hand", checked),
        totals("All, including unchecked", scores),
        "",
        "| Question | Checked | Must reach | Should reach | Model claims verified | Gaps | Tool calls | Time | Missed |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for s in scores:
        missed = s.error or ", ".join(f"`{node}`" for node in s.missed) or "none"
        lines.append(
            f"| {s.id} | {'yes' if s.checked else 'no'} | {s.must_hit}/{s.must_total} | {s.should_hit}/{s.should_total} "
            f"| {s.claims_verified}/{s.claims_total} | {s.gaps} | {s.tool_calls} | {s.seconds:.0f}s | {missed} |"
        )
    lines += [
        "",
        "Must reach and should reach count hand-labelled nodes in the final path. A verified claim means its quote exists in",
        "that node's source, not that the sentence about it is true, so recall is the measure of whether an answer is right.",
        "Time includes the model calls.",
        "",
    ]
    return "\n".join(lines)


def run_path(question: dict, folder: Path = EVAL_DIR / "runs") -> Path:
    return folder / f"{question['id']}.json"


def load_run(question: dict, folder: Path = EVAL_DIR / "runs") -> tuple[list[Event], float]:
    saved = json.loads(run_path(question, folder).read_text(encoding="utf-8"))
    return [event_adapter.validate_python(event) for event in saved["events"]], saved["seconds"]


class CountingClient:
    """Records tokens and time for each model call. with_options keeps the wrapper, so the repair call is counted."""

    def __init__(self, client: Any, calls: list[dict]) -> None:
        self.client = client
        self.calls = calls
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def with_options(self, **options: Any) -> CountingClient:
        return CountingClient(self.client.with_options(**options), self.calls)

    async def create(self, **request: Any) -> Any:
        kind = request["response_format"]["json_schema"]["name"] if "response_format" in request else "tools"
        call = {"kind": kind, "seconds": 0.0, "input_tokens": 0, "output_tokens": 0}
        self.calls.append(call)
        started = time.monotonic()
        try:
            response = await self.client.chat.completions.create(**request)
        finally:
            call["seconds"] = round(time.monotonic() - started, 1)
        if response.usage:
            call["input_tokens"] = response.usage.prompt_tokens
            call["output_tokens"] = response.usage.completion_tokens
        # The raw patch is the only way to tell a model that declined from a fix that failed its check.
        if kind == "path_repair":
            call["reply"] = response.choices[0].message.content
        return response


def dollars(calls: list[dict]) -> float:
    return sum(
        call["input_tokens"] * INPUT_DOLLARS_PER_TOKEN + call["output_tokens"] * OUTPUT_DOLLARS_PER_TOKEN for call in calls
    )


def spent() -> tuple[int, float]:
    """Live runs and dollars so far, from every saved repair run, including smoke runs and demo attempts."""
    saved = [json.loads(path.read_text(encoding="utf-8")) for path in REPAIR_DIR.rglob("*.json")]
    return len(saved), sum(dollars(run.get("calls", [])) for run in saved)


def check_budget() -> None:
    runs, cost = spent()
    if runs >= MAX_LIVE_RUNS or cost >= MAX_DOLLARS:
        raise SystemExit(f"Stopped at the limit: {runs} live runs, ${cost:.2f}.")


async def run_question(question: dict, settings: Settings, index: GraphIndex, folder: Path) -> None:
    path = run_path(question, folder)
    if path.exists():
        raise SystemExit(f"Refusing to overwrite {path}.")
    check_budget()
    calls: list[dict] = []
    client = CountingClient(model_client(settings), calls)
    started = time.monotonic()
    events = [e async for e in run_agent(question["question"], client=client, model=settings.meta_model, index=index)]
    seconds = round(time.monotonic() - started, 1)
    saved = {
        "question": question["question"],
        "model": settings.meta_model,
        "seconds": seconds,
        "calls": calls,
        "events": [event.model_dump(mode="json", exclude_none=True) for event in events],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(saved, indent=1) + "\n", encoding="utf-8")
    runs, cost = spent()
    outcome = next((e.outcome for e in events if e.type == "repair_finished"), "nothing to repair")
    print(f"{question['id']}: {seconds}s, ${dollars(calls):.3f}, {outcome}. Total {runs} runs, ${cost:.2f}", flush=True)


@dataclass(frozen=True)
class Flip:
    question: str
    round: str
    node: str
    sentence: str
    quote: str
    moved_from: str | None


@dataclass(frozen=True)
class Paired:
    round: str
    first: Score
    final: Score
    outcome: str
    claims_sent: int
    gaps_sent: int
    left_alone: int
    steps_first: int
    steps_final: int
    added: list[str]
    flips: list[Flip]
    repair_seconds: float | None
    input_tokens: int
    output_tokens: int
    cost: float


def model_sentences(steps: list[PathStep]) -> Counter[str]:
    return Counter(claim.text for step in steps for claim in step.claims[1:])


def check_nothing_lost(question_id: str, first: list[PathStep], final: list[PathStep]) -> None:
    """The patch design makes this impossible. The eval checks it anyway, because the numbers depend on it."""
    lost_nodes = {step.node_id for step in first} - {step.node_id for step in final}
    if lost_nodes or model_sentences(first) != model_sentences(final):
        raise SystemExit(f"{question_id}: the repaired answer lost something: {lost_nodes or 'a claim'}")


def find_flips(question_id: str, round_name: str, first: list[PathStep], final: list[PathStep]) -> list[Flip]:
    """Every model claim that went from unverified to verified. A person must read these."""
    flips = []
    for step in first:
        for claim in step.claims[1:]:
            if claim.status == "verified":
                continue
            mended = next(
                ((s.node_id, c) for s in final for c in s.claims[1:] if c.text == claim.text and c.status == "verified"),
                None,
            )
            if mended:
                node, fixed = mended
                moved_from = step.node_id if node != step.node_id else None
                flips.append(Flip(question_id, round_name, node, claim.text, fixed.quote or "", moved_from))
    return flips


def added_nodes(first: list[PathStep], final: list[PathStep]) -> list[str]:
    """A repair only inserts steps, so walking both paths together finds them."""
    added, position = [], 0
    for step in final:
        if position < len(first) and first[position].node_id == step.node_id:
            position += 1
        else:
            added.append(step.node_id)
    return added


def run_outcome(events: list[Event]) -> str:
    """A run that failed before it had an answer never reached repair, and must not read as having nothing to fix."""
    if any(event.type == "error" for event in events):
        return NO_ANSWER
    return next((event.outcome for event in events if event.type == "repair_finished"), "nothing to repair")


def pair_run(question: dict, round_name: str, folder: Path) -> Paired:
    events, seconds = load_run(question, folder)
    saved = json.loads(run_path(question, folder).read_text(encoding="utf-8"))
    first, final = first_steps(events), final_steps(events)
    check_nothing_lost(question["id"], first, final)
    started = next((e for e in events if e.type == "repair_started"), None)
    issues = started.issues if started else []
    repair_call = next((call for call in saved["calls"] if call["kind"] == "path_repair"), None)
    return Paired(
        round=round_name,
        first=score_steps(question, first, events, seconds),
        final=score_steps(question, final, events, seconds),
        outcome=run_outcome(events),
        claims_sent=sum(issue.kind == "claim" for issue in issues),
        gaps_sent=sum(issue.kind == "gap" for issue in issues),
        left_alone=started.left_alone if started else 0,
        steps_first=len(first),
        steps_final=len(final),
        added=added_nodes(first, final),
        flips=find_flips(question["id"], round_name, first, final),
        repair_seconds=repair_call["seconds"] if repair_call else None,
        input_tokens=sum(call["input_tokens"] for call in saved["calls"]),
        output_tokens=sum(call["output_tokens"] for call in saved["calls"]),
        cost=dollars(saved["calls"]),
    )


def round_folders() -> list[Path]:
    found = [path for path in REPAIR_DIR.glob("round-*") if path.is_dir()]
    return sorted(found, key=lambda path: int(path.name.removeprefix("round-")))


def load_pairs(questions: list[dict]) -> list[Paired]:
    return [
        pair_run(question, folder.name, folder)
        for folder in round_folders()
        for question in questions
        if run_path(question, folder).exists()
    ]


def before_after(label: str, pairs: list[Paired]) -> str:
    if not pairs:
        return f"| {label} | 0 | n/a | n/a | n/a | n/a | n/a |"

    def share(scores: list[Score]) -> tuple[str, str, str]:
        return (
            percent(sum(s.must_hit for s in scores), sum(s.must_total for s in scores)),
            percent(sum(s.should_hit for s in scores), sum(s.should_total for s in scores)),
            percent(sum(s.claims_verified for s in scores), sum(s.claims_total for s in scores)),
        )

    first, final = [p.first for p in pairs], [p.final for p in pairs]
    must, should, claims = zip(share(first), share(final), strict=True)
    gaps = f"{sum(s.gaps for s in first)} to {sum(s.gaps for s in final)}"
    path_steps = f"{statistics.mean(p.steps_first for p in pairs):.1f} to {statistics.mean(p.steps_final for p in pairs):.1f}"
    arrow = " to ".join
    return f"| {label} | {len(pairs)} | {arrow(must)} | {arrow(should)} | {arrow(claims)} | {gaps} | {path_steps} |"


def repair_report(pairs: list[Paired], baseline: list[Score]) -> str:
    checked = [pair for pair in pairs if pair.first.checked]
    outcomes = Counter(pair.outcome for pair in pairs)
    flips = [flip for pair in pairs for flip in pair.flips]
    repaired_runs = [pair for pair in pairs if pair.repair_seconds is not None]
    claims_sent = sum(pair.claims_sent for pair in pairs)
    gaps_sent = sum(pair.gaps_sent for pair in pairs)
    gaps_closed = sum(p.first.gaps - p.final.gaps for p in pairs)
    repair_times = [pair.repair_seconds for pair in pairs if pair.repair_seconds is not None]
    fresh = [pair.first for pair in pairs]
    must_change = sum(p.final.must_hit - p.first.must_hit for p in pairs)
    lines = [
        "# Repair results",
        "",
        f"**Awaiting human check.** The {len(flips)} claims that repair marked verified are listed in",
        "`eval/repair-audit.md`. Until a person has read them, the verified figures below mean only that a quote exists in",
        "the source, and must not be quoted as answers getting more correct.",
        "",
        f"{len(pairs)} live runs in {len(round_folders())} rounds. Each run is scored twice on the same first draft, before",
        "and after its repair, so model variance between runs does not affect the comparison. Nothing was retried or picked.",
        "",
        "## What repair did",
        "",
        "| Outcome | Runs |",
        "|---|---|",
        *(
            f"| {name} | {outcomes[name]} |"
            for name in ["nothing to repair", "accepted", "no_improvement", "failed", NO_ANSWER]
        ),
        "",
        "`failed` means the repair failed and the first answer stood. A run with no answer failed before repair could start.",
        "It counts as zero in the tables below, because every run counts.",
        "",
        f"Claims sent back: {claims_sent}. Fixed: {len(flips)}. Gaps sent back: {gaps_sent}. Closed: {gaps_closed}.",
        f"Left alone, because no fix is possible: {sum(pair.left_alone for pair in pairs)}.",
        "",
        "## Before and after, on the same drafts",
        "",
        "| Questions | Runs | Must reach | Should reach | Model claims verified | Gaps | Mean path steps |",
        "|---|---|---|---|---|---|---|",
        before_after("Checked by hand", checked),
        before_after("All, including unchecked", pairs),
        "",
        f"Must reach changed by {must_change:+d} nodes across all runs. "
        + (
            "**Repair did not change recall.**"
            if must_change == 0
            else "These nodes came from bridges inserted to close gaps, so this is not a general gain in recall."
        ),
        "A repair cannot remove a node, so must reach cannot fall. Closing a gap adds a step, so a lower gap count comes with",
        "a longer path, as the last column shows.",
        "",
        "## First drafts against the baseline",
        "",
        "The first-draft prompts did not change, so these should differ only by run-to-run variance.",
        "",
        "| Questions | Runs | Must reach | Should reach | Model claims verified | Gaps | Tool calls | Median time |",
        "|---|---|---|---|---|---|---|---|",
        totals("Baseline, eval/runs", baseline),
        totals("First drafts here", fresh),
        "",
        "## Cost and time",
        "",
    ]
    if repaired_runs and repair_times:
        lines += [
            f"The repair call took a median of {statistics.median(repair_times):.0f}s, and {max(repair_times):.0f}s at most,",
            f"on the {len(repaired_runs)} runs that made one. The other {len(pairs) - len(repaired_runs)} runs made no extra call.",
            "",
        ]
    lines += [
        f"These runs used {sum(p.input_tokens for p in pairs):,} input and {sum(p.output_tokens for p in pairs):,} output tokens,",
        f"which is ${sum(p.cost for p in pairs):.2f} at $1.25 and $4.25 per million.",
        "",
        "## Every run",
        "",
        "| Round | Question | Checked | Outcome | Must reach | Claims verified | Gaps | Steps | Added | Repair |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for p in pairs:
        must = f"{p.first.must_hit} to {p.final.must_hit} of {p.first.must_total}"
        claims = f"{p.first.claims_verified} to {p.final.claims_verified} of {p.first.claims_total}"
        added = ", ".join(f"`{node}`" for node in p.added) or "none"
        took = f"{p.repair_seconds:.0f}s" if p.repair_seconds is not None else "none"
        outcome = f"{p.outcome}: {p.first.error}" if p.first.error else p.outcome
        lines.append(
            f"| {p.round} | {p.first.id} | {'yes' if p.first.checked else 'no'} | {outcome} | {must} | {claims} "
            f"| {p.first.gaps} to {p.final.gaps} | {p.steps_first} to {p.steps_final} | {added} | {took} |"
        )
    lines.append("")
    return "\n".join(lines)


def audit_cell(text: str) -> str:
    return re.sub(r"\s+", " ", text).replace("|", "\\|")


def audit_rows(flips: list[Flip], start: int) -> list[str]:
    rows = []
    for number, flip in enumerate(flips, start=start):
        moved = f"`{flip.moved_from}`" if flip.moved_from else ""
        rows.append(
            f"| {number} | {flip.question} ({flip.round}) | `{flip.node}` | {audit_cell(flip.sentence)} "
            f"| `{audit_cell(flip.quote)}` | {moved} |  |"
        )
    return rows


def demo_flips() -> list[Flip]:
    """Claims the demo video shows. They are not eval results, but they say "fixed" on screen."""
    flips = []
    for path in sorted((REPAIR_DIR / "demo").glob("stitched-*.json")):
        saved = json.loads(path.read_text(encoding="utf-8"))
        events = [event_adapter.validate_python(event) for event in saved["events"]]
        flips += find_flips(saved["question"], "stitched demo take", first_steps(events), final_steps(events))
    return flips


def repair_audit(pairs: list[Paired]) -> str:
    flips = [flip for pair in pairs for flip in pair.flips]
    demo = demo_flips()
    header = ["| # | Question | Step | Sentence | Quote | Moved from | Proves it? |", "|---|---|---|---|---|---|---|"]
    lines = [
        "# Repair audit",
        "",
        "**Status: awaiting human check.**",
        "",
        "Each row is a claim that the validator marked unverified, and marked verified after repair. The validator only",
        "proves the quote exists in that node's source. Only a person can say whether the quote proves the sentence.",
        "",
        "For each row, read the sentence and the quote, then write yes or no in the last column:",
        "**does this quote prove this sentence?** A true sentence with a quote that does not prove it is a no. A sentence",
        "about what the agent did or did not read, such as \"source was not fetched\", is a no.",
        "",
        "When you are done, change the status line above and tell whoever owns the eval how many were yes.",
        "",
        "## The eval",
        "",
        *header,
        *audit_rows(flips, 1),
        "",
        "## The demo take",
        "",
        "These are not eval results, but the video shows them as fixed, so they need the same read.",
        "",
        *header,
        *audit_rows(demo, len(flips) + 1),
        "",
    ]
    return "\n".join(lines)


def write_repair_results(questions: list[dict]) -> None:
    pairs = load_pairs(questions)
    baseline = [score_run(question, *load_run(question)) for question in questions]
    text = repair_report(pairs, baseline)
    REPAIR_RESULTS.write_text(text, encoding="utf-8")
    # The audit holds a person's answers, so scoring again must not wipe them.
    if not AUDIT_PATH.exists():
        AUDIT_PATH.write_text(repair_audit(pairs), encoding="utf-8")
    print(text)


async def main(args: argparse.Namespace) -> int:
    labels = json.loads((EVAL_DIR / "questions.json").read_text(encoding="utf-8"))
    questions = labels["questions"]
    settings = Settings(trace_data_dir=DATA_DIR, trace_source_dir=SOURCE_DIR)
    index = GraphIndex.load(DATA_DIR / "graph.json", SOURCE_DIR)
    check_labels(questions, index.graph)
    if args.score:
        scores = [score_run(question, *load_run(question)) for question in questions]
        text = report(scores)
        (EVAL_DIR / "results.md").write_text(text, encoding="utf-8")
        print(text)
    elif args.round is not None:
        folder = REPAIR_DIR / f"round-{args.round}"
        # A round that was cut off picks up where it stopped. A saved run is never run again.
        for question in questions:
            if not run_path(question, folder).exists():
                await run_question(question, settings, index, folder)
        write_repair_results(questions)
    elif args.smoke:
        question = next(question for question in questions if question["id"] == args.smoke)
        count = len(list((REPAIR_DIR / "smoke").glob("*.json"))) if (REPAIR_DIR / "smoke").exists() else 0
        await run_question({**question, "id": f"{count + 1}-{args.smoke}"}, settings, index, REPAIR_DIR / "smoke")
    elif args.demo:
        await run_question({"id": f"attempt-{args.attempt}", "question": args.demo}, settings, index, REPAIR_DIR / "demo")
    elif args.score_repair:
        write_repair_results(questions)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--round", type=int)
    mode.add_argument("--smoke")
    mode.add_argument("--demo")
    mode.add_argument("--score", action="store_true")
    mode.add_argument("--score-repair", action="store_true")
    parser.add_argument("--attempt", type=int, default=1)
    raise SystemExit(asyncio.run(main(parser.parse_args())))
