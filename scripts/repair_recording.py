"""Run one real repair on a recording's first draft, and save the two together as a new cached answer.

    repair_recording.py SOURCE_SLUG "new question"

The result is stitched: the walk and first draft come from the recording, and the repair was made later. The model sees the
draft and the sources the repair brief attaches, but not the recording's tool results, which were never saved. Anything
built this way must be disclosed as stitched. A whole run from `cache_answer.py` is the better recording when it shows a gap.

Saves nothing to the cached answers unless the repair is accepted. The source recording is only read.
"""

import asyncio
import json
import sys
import time

from backend.trace.agent.loop import ANSWER_PROMPT, INVESTIGATE_PROMPT, _repair
from backend.trace.api.app import answer_path, model_client
from backend.trace.api.settings import REPO_ROOT, Settings
from backend.trace.schemas import event_adapter
from backend.trace.schemas.events import Done
from backend.trace.tools import GraphIndex
from backend.trace.validator import DraftClaim, DraftPath, DraftStep, validate_path
from eval.run_eval import REPAIR_DIR, CountingClient, check_budget

DATA_DIR = REPO_ROOT / "data" / "fastapi-template"
SOURCE_DIR = REPO_ROOT / "third_party" / "fastapi-template"


def draft_from(steps: list) -> DraftPath:
    """A recording keeps the quotes that passed and drops the rest, so a failed claim comes back with no quote."""
    rebuilt = [
        DraftStep(
            node_id=step.node_id,
            explanation=step.explanation,
            claims=[DraftClaim(text=claim.text, quote=claim.quote or "") for claim in step.claims[1:]],
        )
        for step in steps
    ]
    return DraftPath(steps=rebuilt)


async def main(source_slug: str, question: str) -> int:
    settings = Settings(trace_data_dir=DATA_DIR, trace_source_dir=SOURCE_DIR)
    source = DATA_DIR / "answers" / f"{source_slug}.jsonl"
    target = answer_path(DATA_DIR, question)
    record = REPAIR_DIR / "demo" / f"stitched-{target.stem}.json"
    if target.exists() or record.exists():
        print(f"not repaired: {target.name} or its record already exists", file=sys.stderr)
        return 1
    check_budget()

    lines = source.read_text(encoding="utf-8").splitlines()
    events = [event_adapter.validate_json(line) for line in lines if line.strip()]
    final_at = next(number for number, event in enumerate(events) if event.type == "final_path")
    first = events[final_at].steps
    draft = draft_from(first)
    index = GraphIndex.load(DATA_DIR / "graph.json", SOURCE_DIR)
    if validate_path(draft, index) != first:
        print("not repaired: the recording no longer validates to the same answer", file=sys.stderr)
        return 1

    messages = [
        {"role": "system", "content": INVESTIGATE_PROMPT},
        {"role": "user", "content": source_slug.replace("-", " ")},
        {"role": "user", "content": ANSWER_PROMPT},
        {"role": "assistant", "content": draft.model_dump_json()},
    ]
    calls: list[dict] = []
    client = CountingClient(model_client(settings), calls)
    started = time.monotonic()
    repair = [e async for e in _repair(messages, draft, first, client, settings.meta_model, index)]
    seconds = round(time.monotonic() - started, 1)

    stitched = [*events[: final_at + 1], *repair, Done(type="done")]
    saved = {
        "question": question,
        "stitched_from": source.name,
        "model": settings.meta_model,
        "seconds": seconds,
        "calls": calls,
        "events": [event.model_dump(mode="json", exclude_none=True) for event in stitched],
    }
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps(saved, indent=1) + "\n", encoding="utf-8")

    outcome = next((event.outcome for event in repair if event.type == "repair_finished"), "nothing to repair")
    print(f"{outcome} in {seconds}s. Record saved to {record}")
    if outcome != "accepted":
        print("not cached: the repair was not accepted", file=sys.stderr)
        return 1
    target.write_text("".join(event.model_dump_json(exclude_none=True) + "\n" for event in stitched), encoding="utf-8")
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(asyncio.run(main(sys.argv[1], sys.argv[2])))
