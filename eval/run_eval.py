"""Run eval/questions.json through the live agent and score each answer's path. No model decides a score.

    run_eval.py            run every question once, save each run to eval/runs/, write eval/results.md
    run_eval.py --score    score the saved runs again, for when the labels change

Every question runs live, never from the demo's cached answers, and every run counts: a bad one is not retried.
"""

import asyncio
import json
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from backend.trace.agent import run_agent
from backend.trace.api.app import model_client
from backend.trace.api.settings import REPO_ROOT, Settings
from backend.trace.schemas import Graph, event_adapter
from backend.trace.schemas.events import Event
from backend.trace.tools import GraphIndex

EVAL_DIR = REPO_ROOT / "eval"
DATA_DIR = REPO_ROOT / "data" / "fastapi-template"
SOURCE_DIR = REPO_ROOT / "third_party" / "fastapi-template"


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


def score_run(question: dict, events: list[Event], seconds: float) -> Score:
    """Recall is over the final path only. A node the agent read but left out of its answer does not count."""
    steps = next((event.steps for event in events if event.type == "final_path"), [])
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


def run_path(question: dict) -> Path:
    return EVAL_DIR / "runs" / f"{question['id']}.json"


def load_run(question: dict) -> tuple[list[Event], float]:
    saved = json.loads(run_path(question).read_text(encoding="utf-8"))
    return [event_adapter.validate_python(event) for event in saved["events"]], saved["seconds"]


async def run_question(question: dict, settings: Settings, index: GraphIndex) -> None:
    client = model_client(settings)
    started = time.monotonic()
    events = [e async for e in run_agent(question["question"], client=client, model=settings.meta_model, index=index)]
    seconds = round(time.monotonic() - started, 1)
    saved = {
        "question": question["question"],
        "model": settings.meta_model,
        "seconds": seconds,
        "events": [event.model_dump(mode="json", exclude_none=True) for event in events],
    }
    path = run_path(question)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(saved, indent=1) + "\n", encoding="utf-8")
    print(f"{question['id']}: {seconds}s", flush=True)


async def main(score_only: bool) -> int:
    labels = json.loads((EVAL_DIR / "questions.json").read_text(encoding="utf-8"))
    questions = labels["questions"]
    settings = Settings(trace_data_dir=DATA_DIR, trace_source_dir=SOURCE_DIR)
    index = GraphIndex.load(DATA_DIR / "graph.json", SOURCE_DIR)
    check_labels(questions, index.graph)
    if not score_only:
        for question in questions:
            await run_question(question, settings, index)
    scores = [score_run(question, *load_run(question)) for question in questions]
    text = report(scores)
    (EVAL_DIR / "results.md").write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main("--score" in sys.argv[1:])))
