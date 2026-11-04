import asyncio
import shutil
from pathlib import Path

import httpx
import pytest

from backend.trace.api import create_app
from backend.trace.api import repos as repos_module
from backend.trace.api.repos import IngestError, detect_root, parse_github_url
from backend.trace.api.settings import Settings

MOCK = Path(__file__).resolve().parents[1] / "data" / "mock"
URL = "https://github.com/octo/taskboard"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def client_for(tmp_path, **settings):
    defaults = {
        "trace_replay_delay_seconds": 0,
        "trace_web_dist": Path("/nonexistent"),
        "trace_data_dir": MOCK,
        "trace_source_dir": MOCK / "source",
        "trace_repos_dir": tmp_path / "repos",
    }
    app = create_app(Settings(**(defaults | settings)))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def no_network(monkeypatch):
    """Stands a copy of the mock repo's source in for a clone from GitHub."""
    cloned = []

    def fake_clone(url, into):
        cloned.append(url)
        shutil.copytree(MOCK / "source", into)

    monkeypatch.setattr(repos_module, "clone", fake_clone)
    return cloned


async def wait_until_settled(client, repo_id):
    for _ in range(200):
        listed = {repo["id"]: repo for repo in (await client.get("/api/repos")).json()}
        if listed[repo_id]["step"] in ("ready", "failed"):
            return listed[repo_id]
        await asyncio.sleep(0.05)
    raise AssertionError("ingest never finished")


@pytest.mark.anyio
async def test_the_startup_repo_is_always_listed_first(tmp_path):
    async with client_for(tmp_path) as client:
        listed = (await client.get("/api/repos")).json()
    assert len(listed) == 1
    assert listed[0]["builtin"] is True
    assert listed[0]["nodes"] == 26
    assert listed[0]["replays_any"] is True


@pytest.mark.anyio
async def test_a_repo_added_from_github_is_cloned_parsed_and_served(tmp_path, no_network):
    async with client_for(tmp_path) as client:
        started = await client.post("/api/repos", json={"url": URL + ".git"})
        assert started.status_code == 202
        repo_id = started.json()["id"]
        assert started.json()["step"] == "cloning"
        settled = await wait_until_settled(client, repo_id)
        assert settled["step"] == "ready", settled["error"]
        assert settled["url"] == "https://github.com/octo/taskboard.git"
        assert settled["nodes"] > 0 and settled["builtin"] is False

        graph = (await client.get("/api/graph", params={"repo": repo_id})).json()
        assert graph["nodes"]
        some_file = next(node["file"] for node in graph["nodes"] if node["type"] == "module")
        source = await client.get("/api/source", params={"repo": repo_id, "file": some_file})
        assert source.status_code == 200 and source.text

    assert no_network == ["https://github.com/octo/taskboard.git"]
    assert not any(path.name.endswith(".partial") for path in (tmp_path / "repos").iterdir())


@pytest.mark.anyio
async def test_an_added_repo_survives_a_restart(tmp_path, no_network):
    async with client_for(tmp_path) as client:
        repo_id = (await client.post("/api/repos", json={"url": URL})).json()["id"]
        await wait_until_settled(client, repo_id)
    async with client_for(tmp_path) as client:
        assert repo_id in [repo["id"] for repo in (await client.get("/api/repos")).json()]


@pytest.mark.anyio
async def test_a_repo_cannot_be_added_twice(tmp_path, no_network):
    async with client_for(tmp_path) as client:
        repo_id = (await client.post("/api/repos", json={"url": URL})).json()["id"]
        await wait_until_settled(client, repo_id)
        again = await client.post("/api/repos", json={"url": URL})
    assert again.status_code == 400
    assert "already added" in again.json()["detail"]


@pytest.mark.anyio
async def test_a_failed_clone_is_shown_and_can_be_dismissed(tmp_path, monkeypatch):
    def failing_clone(url, into):
        raise IngestError("Could not clone it. Check the URL, and that the repo is public.")

    monkeypatch.setattr(repos_module, "clone", failing_clone)
    async with client_for(tmp_path) as client:
        repo_id = (await client.post("/api/repos", json={"url": URL})).json()["id"]
        settled = await wait_until_settled(client, repo_id)
        assert settled["step"] == "failed"
        assert "public" in settled["error"]
        assert settled["repo"] == "octo/taskboard"
        assert (await client.delete(f"/api/repos/{repo_id}")).status_code == 204
        assert [repo["id"] for repo in (await client.get("/api/repos")).json()] != [repo_id]
        assert len((await client.get("/api/repos")).json()) == 1


@pytest.mark.anyio
async def test_a_root_with_no_such_folder_fails_with_a_reason(tmp_path, no_network):
    async with client_for(tmp_path) as client:
        repo_id = (await client.post("/api/repos", json={"url": URL, "root": "nowhere"})).json()["id"]
        settled = await wait_until_settled(client, repo_id)
    assert settled["step"] == "failed"
    assert "nowhere" in settled["error"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "url",
    [
        "https://gitlab.com/octo/taskboard",
        "git@github.com:octo/taskboard.git",
        "https://github.com/octo",
        "https://github.com/octo/taskboard/tree/main",
        "--upload-pack=evil",
        "https://github.com/../..",
    ],
)
async def test_only_a_github_repo_url_is_accepted(tmp_path, url):
    async with client_for(tmp_path) as client:
        response = await client.post("/api/repos", json={"url": url})
    assert response.status_code == 400


@pytest.mark.anyio
async def test_an_import_root_outside_the_repo_is_refused(tmp_path):
    async with client_for(tmp_path) as client:
        response = await client.post("/api/repos", json={"url": URL, "root": "../etc"})
    assert response.status_code == 400


@pytest.mark.anyio
async def test_an_unknown_repo_is_a_404(tmp_path):
    async with client_for(tmp_path) as client:
        assert (await client.get("/api/graph", params={"repo": "nope"})).status_code == 404
        assert (await client.get("/api/source", params={"repo": "nope", "file": "x.py"})).status_code == 404
        response = await client.post("/api/ask", json={"question": "q", "repo": "nope"})
        assert response.status_code == 404


def test_a_github_url_gives_the_owner_and_name():
    assert parse_github_url("https://github.com/fastapi/full-stack-fastapi-template") == (
        "fastapi",
        "full-stack-fastapi-template",
    )
    assert parse_github_url("https://github.com/psf/requests.git/") == ("psf", "requests")


def test_the_import_root_is_the_folder_with_the_most_packages(tmp_path):
    (tmp_path / "frontend").mkdir()
    (tmp_path / "backend" / "app").mkdir(parents=True)
    (tmp_path / "backend" / "app" / "__init__.py").write_text("")
    (tmp_path / "tests" / "unit").mkdir(parents=True)
    (tmp_path / "tests" / "unit" / "__init__.py").write_text("")
    (tmp_path / "setup.py").write_text("")
    assert detect_root(tmp_path) == "backend"


def test_a_flat_repo_is_its_own_import_root(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "__init__.py").write_text("")
    (tmp_path / "manage.py").write_text("")
    assert detect_root(tmp_path) == "."
