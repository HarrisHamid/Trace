"""FastAPI app. /api/ask replays a recorded run when there is one, and otherwise runs the agent."""

import asyncio
import re
from collections.abc import AsyncIterator, Callable
from functools import cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from backend.trace.agent import run_agent
from backend.trace.schemas import ChecksFile, Event, Graph, event_adapter
from backend.trace.schemas.events import Done, ErrorEvent
from backend.trace.tools import GraphIndex

from .settings import Settings

MODEL_RETRIES = 4
MODEL_TIMEOUT_SECONDS = 90


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)


def sse(event: Event) -> dict[str, str]:
    return {"event": event.type, "data": event.model_dump_json(exclude_none=True)}


async def replay_events(path: Path, delay: float) -> AsyncIterator[dict[str, str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    events = [event_adapter.validate_json(line) for line in lines if line.strip()]
    for index, event in enumerate(events):
        if index:
            await asyncio.sleep(delay)
        yield sse(event)


def answer_path(data_dir: Path, question: str) -> Path:
    slug = re.sub(r"[^a-z0-9]+", "-", question.lower()).strip("-")
    return data_dir / "answers" / f"{slug}.jsonl"


def model_client(settings: Settings) -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=settings.meta_api_key.get_secret_value(),
        base_url=settings.meta_base_url,
        max_retries=MODEL_RETRIES,
        timeout=MODEL_TIMEOUT_SECONDS,
    )


async def live_events(question: str, settings: Settings, index: GraphIndex) -> AsyncIterator[dict[str, str]]:
    if not settings.meta_api_key.get_secret_value():
        yield sse(ErrorEvent(type="error", message="META_API_KEY is not set, so the agent cannot run."))
        yield sse(Done(type="done"))
        return
    client = model_client(settings)
    async for event in run_agent(question, client=client, model=settings.meta_model, index=index):
        yield sse(event)


def event_stream(
    question: str, settings: Settings, load_index: Callable[[], GraphIndex]
) -> AsyncIterator[dict[str, str]]:
    delay = settings.trace_replay_delay_seconds
    mock_run = settings.trace_data_dir / "events.jsonl"
    if mock_run.is_file():
        return replay_events(mock_run, delay)
    cached = answer_path(settings.trace_data_dir, question)
    if cached.is_file():
        return replay_events(cached, delay)
    return live_events(question, settings, load_index())


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="Trace")

    @cache
    def load_index() -> GraphIndex:
        return GraphIndex.load(settings.trace_data_dir / "graph.json", settings.trace_source_dir)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/graph")
    def graph() -> Graph:
        return Graph.model_validate_json((settings.trace_data_dir / "graph.json").read_text(encoding="utf-8"))

    @app.get("/api/checks")
    def checks() -> ChecksFile:
        return ChecksFile.model_validate_json((settings.trace_data_dir / "checks.json").read_text(encoding="utf-8"))

    @app.get("/api/source", response_class=PlainTextResponse)
    def source(file: str) -> str:
        root = settings.trace_source_dir.resolve()
        path = (root / file).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(status_code=404, detail=f"No source for {file}")
        return path.read_text(encoding="utf-8")

    @app.post("/api/ask")
    async def ask(request: AskRequest) -> EventSourceResponse:
        return EventSourceResponse(event_stream(request.question, settings, load_index))

    if settings.trace_web_dist.is_dir():
        app.mount("/", StaticFiles(directory=settings.trace_web_dist, html=True), name="web")

    return app
