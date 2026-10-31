import json
import shutil
from pathlib import Path

import httpx
import pytest

from backend.trace.api import create_app
from backend.trace.api.settings import Settings
from backend.trace.schemas import event_adapter

MOCK = Path(__file__).resolve().parents[1] / "data" / "mock"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def client_for(**settings):
    defaults = {"trace_replay_delay_seconds": 0, "trace_web_dist": Path("/nonexistent")}
    app = create_app(Settings(**(defaults | settings)))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def read_events(response):
    event = {}
    async for raw in response.aiter_lines():
        line = raw.rstrip("\r")
        if line.startswith("event: "):
            event["event"] = line.removeprefix("event: ")
        elif line.startswith("data: "):
            event["data"] = json.loads(line.removeprefix("data: "))
        elif not line and event:
            yield event
            event = {}


@pytest.mark.anyio
async def test_health():
    async with client_for() as client:
        response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_graph_serves_the_mock():
    async with client_for() as client:
        response = await client.get("/api/graph")
    assert response.status_code == 200
    body = response.json()
    assert body["repo"] == "demo/taskboard"
    assert len(body["nodes"]) == 26


@pytest.mark.anyio
async def test_checks_serves_the_mock():
    async with client_for() as client:
        response = await client.get("/api/checks")
    assert response.status_code == 200
    assert len(response.json()["checks"]) == 5


@pytest.mark.anyio
async def test_source_serves_a_file():
    async with client_for() as client:
        response = await client.get("/api/source", params={"file": "taskboard/api/auth.py"})
    assert response.status_code == 200
    assert response.text.startswith('"""Login and session routes."""')


@pytest.mark.anyio
@pytest.mark.parametrize("file", ["taskboard/missing.py", "../graph.json", "/etc/hosts", "<external>"])
async def test_source_rejects_anything_outside_the_source_dir(file):
    async with client_for() as client:
        response = await client.get("/api/source", params={"file": file})
    assert response.status_code == 404


@pytest.mark.anyio
async def test_ask_streams_events_in_order():
    question = {"question": "how does login work?"}
    events = []
    async with client_for() as client, client.stream("POST", "/api/ask", json=question) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        async for event in read_events(response):
            events.append(event)
            if len(events) == 4:
                break
    assert [e["event"] for e in events] == ["run_started", "tool_call", "tool_result", "node_visited"]
    for event in events:
        assert event_adapter.validate_python(event["data"]).type == event["event"]


@pytest.mark.anyio
async def test_ask_requires_a_question():
    async with client_for() as client:
        response = await client.post("/api/ask", json={})
    assert response.status_code == 422


@pytest.mark.anyio
async def test_data_dir_is_configurable(tmp_path):
    shutil.copy(MOCK / "graph.json", tmp_path)
    graph = json.loads((tmp_path / "graph.json").read_text())
    graph["repo"] = "other/repo"
    (tmp_path / "graph.json").write_text(json.dumps(graph))
    async with client_for(trace_data_dir=tmp_path) as client:
        response = await client.get("/api/graph")
    assert response.json()["repo"] == "other/repo"


def test_data_dir_reads_the_env(monkeypatch, tmp_path):
    monkeypatch.setenv("TRACE_DATA_DIR", str(tmp_path))
    assert Settings().trace_data_dir == tmp_path


@pytest.mark.anyio
async def test_serves_web_dist_when_present(tmp_path):
    (tmp_path / "index.html").write_text("<title>hello</title>")
    async with client_for(trace_web_dist=tmp_path) as client:
        index = await client.get("/")
        health = await client.get("/api/health")
    assert "hello" in index.text
    assert health.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_no_web_dist_means_no_root_route():
    async with client_for() as client:
        response = await client.get("/")
    assert response.status_code == 404
