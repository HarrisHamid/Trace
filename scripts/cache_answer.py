"""Run the agent once and save the run, so /api/ask can replay it. Usage: cache_answer.py "question"."""

import asyncio
import sys

from backend.trace.agent import run_agent
from backend.trace.api.app import answer_path, model_client
from backend.trace.api.settings import Settings
from backend.trace.tools import GraphIndex


async def main(question: str) -> int:
    settings = Settings()
    index = GraphIndex.load(settings.trace_data_dir / "graph.json", settings.trace_source_dir)
    client = model_client(settings)
    events = [event async for event in run_agent(question, client=client, model=settings.meta_model, index=index)]
    failure = next((event for event in events if event.type == "error"), None)
    if failure:
        print(f"not cached: {failure.message}", file=sys.stderr)
        return 1
    path = answer_path(settings.trace_data_dir, question)
    path.parent.mkdir(exist_ok=True)
    path.write_text("".join(event.model_dump_json(exclude_none=True) + "\n" for event in events), encoding="utf-8")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(asyncio.run(main(sys.argv[1])))
