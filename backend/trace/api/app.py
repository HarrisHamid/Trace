"""FastAPI app. /api/ask replays a recorded run when there is one, and otherwise runs the agent.

Every endpoint that reads a repo takes an optional repo id. Without one it uses the repo the server started with.
"""

import asyncio
import re
from collections.abc import AsyncIterator, Callable
from functools import cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from backend.trace.agent import run_agent
from backend.trace.schemas import ChecksFile, Event, Graph, event_adapter
from backend.trace.schemas.events import Done, ErrorEvent
from backend.trace.tools import GraphIndex

from .repos import IngestError, Repo, Repos, RepoSummary
from .settings import Settings

MODEL_RETRIES = 4
MODEL_TIMEOUT_SECONDS = 90


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    # The file the question was asked from, when it was asked on a file's page. The agent then starts from that file.
    file: str | None = Field(default=None, min_length=1, max_length=500)
    repo: str | None = Field(default=None, max_length=200)
    # The block selected on that file's page, by node id. The agent starts from it.
    node: str | None = Field(default=None, min_length=1, max_length=500)


class AddRepoRequest(BaseModel):
    url: str = Field(min_length=1, max_length=300)
    # The folder imports start from. Left out, it is worked out from the repo.
    root: str | None = Field(default=None, max_length=200)


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


async def live_events(
    question: str, file: str | None, node: str | None, settings: Settings, index: GraphIndex
) -> AsyncIterator[dict[str, str]]:
    if not settings.meta_api_key.get_secret_value():
        yield sse(ErrorEvent(type="error", message="META_API_KEY is not set, so the agent cannot run."))
        yield sse(Done(type="done"))
        return
    client = model_client(settings)
    async for event in run_agent(question, client=client, model=settings.meta_model, index=index, file=file, node=node):
        yield sse(event)


def event_stream(
    question: str,
    file: str | None,
    repo: Repo,
    settings: Settings,
    load_index: Callable[[], GraphIndex],
    node: str | None = None,
) -> AsyncIterator[dict[str, str]]:
    delay = settings.trace_replay_delay_seconds
    mock_run = repo.data_dir / "events.jsonl"
    if mock_run.is_file():
        return replay_events(mock_run, delay)
    # Recorded answers are about the whole repo, so a question asked about one file always runs live.
    cached = answer_path(repo.data_dir, question)
    if file is None and node is None and cached.is_file():
        return replay_events(cached, delay)
    return live_events(question, file, node, settings, load_index())


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="Trace")
    repos = Repos(settings.trace_data_dir, settings.trace_source_dir, settings.trace_repos_dir)

    def find(repo_id: str | None) -> Repo:
        try:
            return repos.get(repo_id)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"No repo called {repo_id}") from None

    # Keyed on the folder, so a repo added later gets its own index and the startup repo keeps its one.
    @cache
    def index_for(data_dir: Path, source_dir: Path) -> GraphIndex:
        return GraphIndex.load(data_dir / "graph.json", source_dir)

    # The status bar shows which model answers live questions. The key itself never leaves the server.
    @app.get("/api/health")
    def health() -> dict[str, str | bool]:
        return {"status": "ok", "model": settings.meta_model, "live": bool(settings.meta_api_key.get_secret_value())}

    @app.get("/api/repos")
    def list_repos() -> list[RepoSummary]:
        return repos.summaries()

    # Starts a shallow clone and a parse in the background. GET /api/repos shows how far it has got.
    @app.post("/api/repos", status_code=202)
    async def add_repo(request: AddRepoRequest) -> RepoSummary:
        try:
            return repos.start(request.url, request.root)
        except IngestError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

    @app.delete("/api/repos/{repo_id}", status_code=204)
    def remove_repo(repo_id: str) -> Response:
        try:
            repos.remove(repo_id)
        except IngestError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None
        except KeyError:
            raise HTTPException(status_code=404, detail="No such repo, or it is still being added") from None
        # A repo added again under the same id must not be answered from the deleted one's graph.
        index_for.cache_clear()
        return Response(status_code=204)

    @app.get("/api/graph")
    def graph(repo: str | None = None) -> Graph:
        data_dir = find(repo).data_dir
        return Graph.model_validate_json((data_dir / "graph.json").read_text(encoding="utf-8"))

    @app.get("/api/checks")
    def checks(repo: str | None = None) -> ChecksFile:
        data_dir = find(repo).data_dir
        return ChecksFile.model_validate_json((data_dir / "checks.json").read_text(encoding="utf-8"))

    @app.get("/api/source", response_class=PlainTextResponse)
    def source(file: str, repo: str | None = None) -> str:
        root = find(repo).source_dir.resolve()
        path = (root / file).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(status_code=404, detail=f"No source for {file}")
        return path.read_text(encoding="utf-8")

    @app.post("/api/ask")
    async def ask(request: AskRequest) -> EventSourceResponse:
        chosen = find(request.repo)
        load_index = lambda: index_for(chosen.data_dir, chosen.source_dir)
        stream = event_stream(request.question, request.file, chosen, settings, load_index, request.node)
        return EventSourceResponse(stream)

    if settings.trace_web_dist.is_dir():
        app.mount("/", StaticFiles(directory=settings.trace_web_dist, html=True), name="web")

    return app
