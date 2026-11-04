"""The repos Trace can show: the one the server started with, and public GitHub repos added from the browser.

An added repo lives in its own folder under the repos dir: graph.json and report.json from the parser, meta.json with
where it came from, and source/ with the shallow clone the agent and the code panel read.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import cached_property
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from backend.trace.parser.builder import GraphBuilder
from backend.trace.parser.discover import discover

logger = logging.getLogger(__name__)

GITHUB_URL = re.compile(
    r"^https://github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$"
)
CLONE_TIMEOUT_SECONDS = 180
# Big enough for a real service, small enough that parsing stays well under a minute on a laptop.
MAX_PYTHON_FILES = 1500
# Folders that hold Python but are never the code a reader means.
NOT_A_ROOT = {"tests", "test", "docs", "doc", "examples", "scripts", "migrations", "alembic", "node_modules"}

Step = Literal["cloning", "parsing", "ready", "failed"]


class IngestError(Exception):
    """A failure worth showing the person who asked, in their words."""


class RepoSummary(BaseModel):
    id: str
    repo: str
    commit_sha: str | None = None
    url: str | None = None
    root: str | None = None
    nodes: int | None = None
    edges: int | None = None
    files: int | None = None
    calls_resolved: int | None = None
    calls_internal: int | None = None
    # Recorded answers that replay instead of running live.
    recorded: int = 0
    # Mock data replays one run for any question.
    replays_any: bool = False
    # True for the repo the server started with. It cannot be removed.
    builtin: bool = False
    step: Step = "ready"
    error: str | None = None
    added_at: str | None = None


@dataclass
class Repo:
    id: str
    data_dir: Path
    source_dir: Path
    builtin: bool = False
    meta: dict = field(default_factory=dict)


@dataclass
class Job:
    id: str
    name: str
    url: str
    root: str | None
    step: Step = "cloning"
    error: str | None = None


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "repo"


def parse_github_url(url: str) -> tuple[str, str]:
    """(owner, name) of a public GitHub repo URL, or IngestError."""
    found = GITHUB_URL.match(url.strip())
    if not found or found.group(2) in {".", ".."}:
        raise IngestError("Use a GitHub repo URL like https://github.com/owner/repo.")
    return found.group(1), found.group(2)


def detect_root(source: Path) -> str:
    """The folder imports start from: the repo itself, or the top-level folder holding the most Python packages."""

    def score(folder: Path) -> int:
        packages = sum(1 for item in folder.iterdir() if item.is_dir() and (item / "__init__.py").is_file())
        modules = sum(1 for item in folder.iterdir() if item.is_file() and item.suffix == ".py")
        return packages * 3 + modules

    best, best_score = ".", score(source)
    for folder in sorted(source.iterdir()):
        if not folder.is_dir() or folder.name.startswith(".") or folder.name.lower() in NOT_A_ROOT:
            continue
        if (folder_score := score(folder)) > best_score:
            best, best_score = folder.name, folder_score
    return best


def clone(url: str, into: Path) -> None:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", "--quiet", "--", url, str(into)],
            check=True,
            capture_output=True,
            timeout=CLONE_TIMEOUT_SECONDS,
            env=env,
        )
    except subprocess.TimeoutExpired as error:
        raise IngestError("Cloning took too long. Try a smaller repo.") from error
    except subprocess.CalledProcessError as error:
        raise IngestError("Could not clone it. Check the URL, and that the repo is public.") from error


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def summarize(repo: Repo) -> RepoSummary:
    graph = json.loads((repo.data_dir / "graph.json").read_text(encoding="utf-8"))
    stats = graph.get("stats", {})
    answers = repo.data_dir / "answers"
    return RepoSummary(
        id=repo.id,
        repo=graph["repo"],
        commit_sha=graph.get("commit_sha"),
        url=repo.meta.get("url") or (f"https://github.com/{graph['repo']}" if "/" in graph["repo"] else None),
        root=repo.meta.get("root") or graph.get("root"),
        nodes=len(graph["nodes"]),
        edges=len(graph["edges"]),
        files=len({node["file"] for node in graph["nodes"] if node["type"] == "module"}),
        calls_resolved=stats.get("calls_resolved"),
        calls_internal=stats.get("calls_resolved", 0) + stats.get("calls_uncertain", 0),
        recorded=len(list(answers.glob("*.jsonl"))) if answers.is_dir() else 0,
        replays_any=(repo.data_dir / "events.jsonl").is_file(),
        builtin=repo.builtin,
        added_at=repo.meta.get("added_at"),
    )


class Repos:
    def __init__(self, data_dir: Path, source_dir: Path, repos_dir: Path) -> None:
        self.data_dir = data_dir
        self.source_dir = source_dir
        self.repos_dir = repos_dir
        self.jobs: dict[str, Job] = {}
        self.tasks: set[asyncio.Task] = set()

    @cached_property
    def builtin(self) -> Repo:
        """The repo the server started with. Its id comes from its graph, read once, when first needed."""
        graph = self.data_dir / "graph.json"
        name = json.loads(graph.read_text(encoding="utf-8"))["repo"] if graph.is_file() else self.data_dir.name
        return Repo(id=slug(name), data_dir=self.data_dir, source_dir=self.source_dir, builtin=True)

    def added(self) -> list[Repo]:
        if not self.repos_dir.is_dir():
            return []
        found = []
        for folder in sorted(self.repos_dir.iterdir()):
            meta = folder / "meta.json"
            if folder.is_dir() and meta.is_file() and (folder / "graph.json").is_file():
                found.append(Repo(folder.name, folder, folder / "source", meta=json.loads(meta.read_text("utf-8"))))
        return found

    def all(self) -> list[Repo]:
        return [self.builtin, *(repo for repo in self.added() if repo.id != self.builtin.id)]

    def get(self, repo_id: str | None) -> Repo:
        if repo_id is None or repo_id == self.builtin.id:
            return self.builtin
        for repo in self.added():
            if repo.id == repo_id:
                return repo
        raise KeyError(repo_id)

    def summaries(self) -> list[RepoSummary]:
        ready = [summarize(repo) for repo in self.all()]
        known = {summary.id for summary in ready}
        pending = [
            RepoSummary(id=job.id, repo=job.name, url=job.url, root=job.root, step=job.step, error=job.error)
            for job in self.jobs.values()
            if job.id not in known
        ]
        return ready + pending

    def start(self, url: str, root: str | None) -> RepoSummary:
        owner, name = parse_github_url(url)
        repo_id = slug(f"{owner}/{name}")
        clean_url = f"https://github.com/{owner}/{name}.git"
        if root is not None:
            root = root.strip().strip("/") or None
            if root and (".." in Path(root).parts or Path(root).is_absolute()):
                raise IngestError("The import root must be a folder inside the repo.")
        if any(repo.id == repo_id for repo in self.all()):
            raise IngestError(f"{owner}/{name} is already added.")
        if any(job.step in ("cloning", "parsing") for job in self.jobs.values()):
            raise IngestError("Another repo is being added. Wait for it to finish.")
        job = Job(repo_id, f"{owner}/{name}", clean_url, root)
        self.jobs[repo_id] = job
        task = asyncio.create_task(asyncio.to_thread(self.ingest, job))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return RepoSummary(id=repo_id, repo=f"{owner}/{name}", url=clean_url, root=root, step=job.step)

    def dismiss(self, repo_id: str) -> None:
        """Drops a failed attempt. Ready repos are left alone: removing data is not something a click should do."""
        job = self.jobs.get(repo_id)
        if job is None or job.step != "failed":
            raise KeyError(repo_id)
        del self.jobs[repo_id]

    def ingest(self, job: Job) -> None:
        target = self.repos_dir / job.id
        partial = self.repos_dir / f".{job.id}.partial"
        shutil.rmtree(partial, ignore_errors=True)
        try:
            partial.mkdir(parents=True)
            source = partial / "source"
            clone(job.url, source)
            job.step = "parsing"
            root = job.root or detect_root(source)
            if not (source / root).is_dir():
                raise IngestError(f"There is no folder called {root} in the repo.")
            python_files = len(discover(str(source / root)).included)
            if python_files == 0:
                raise IngestError("No Python files found. Trace reads Python codebases.")
            if python_files > MAX_PYTHON_FILES:
                raise IngestError(f"{python_files} Python files is more than this demo parses ({MAX_PYTHON_FILES}).")
            graph, report = GraphBuilder(str(source), root).build()
            write_json(partial / "graph.json", graph)
            write_json(partial / "report.json", report)
            write_json(partial / "meta.json", {"url": job.url, "root": root, "added_at": datetime.now(UTC).isoformat()})
            os.replace(partial, target)
            job.step = "ready"
            del self.jobs[job.id]
        except IngestError as error:
            job.step, job.error = "failed", str(error)
        except Exception as error:
            logger.exception("Adding %s failed", job.url)
            job.step, job.error = "failed", f"The parser failed on this repo ({type(error).__name__})."
        finally:
            shutil.rmtree(partial, ignore_errors=True)
