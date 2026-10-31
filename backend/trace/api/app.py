"""FastAPI app. /api/ask replays the mock run until the agent loop exists."""

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from backend.trace.schemas import ChecksFile, Graph, event_adapter

from .settings import Settings


class AskRequest(BaseModel):
    question: str


async def replay_events(path: Path, delay: float) -> AsyncIterator[dict[str, str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    events = [event_adapter.validate_json(line) for line in lines if line.strip()]
    for index, event in enumerate(events):
        if index:
            await asyncio.sleep(delay)
        yield {"event": event.type, "data": event.model_dump_json(exclude_none=True)}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="Trace")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/graph")
    def graph() -> Graph:
        return Graph.model_validate_json((settings.trace_data_dir / "graph.json").read_text(encoding="utf-8"))

    @app.get("/api/checks")
    def checks() -> ChecksFile:
        return ChecksFile.model_validate_json((settings.trace_data_dir / "checks.json").read_text(encoding="utf-8"))

    @app.post("/api/ask")
    async def ask(_: AskRequest) -> EventSourceResponse:
        path = settings.trace_data_dir / "events.jsonl"
        return EventSourceResponse(replay_events(path, settings.trace_replay_delay_seconds))

    if settings.trace_web_dist.is_dir():
        app.mount("/", StaticFiles(directory=settings.trace_web_dist, html=True), name="web")

    return app
