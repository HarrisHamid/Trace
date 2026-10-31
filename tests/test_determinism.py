import filecmp
import os
import subprocess
import sys

TRACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(TRACE, "tests", "fixtures")
TARGET = os.path.join(TRACE, "third_party", "fastapi-template")


def _build(repo, root, out):
    subprocess.run(
        [sys.executable, "-m", "backend.trace.parser", "build", "--repo", repo, "--root", root, "--out", str(out)],
        cwd=TRACE, check=True, capture_output=True,
    )


def _assert_identical(a, b):
    assert filecmp.cmp(a / "graph.json", b / "graph.json", shallow=False)
    assert filecmp.cmp(a / "report.json", b / "report.json", shallow=False)


def test_fixture_build_is_deterministic(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    _build(FIXTURES, ".", a / "graph.json")
    _build(FIXTURES, ".", b / "graph.json")
    _assert_identical(a, b)


def test_target_build_is_deterministic(tmp_path):
    if not os.path.isdir(TARGET):
        import pytest
        pytest.skip("target repo not cloned")
    a, b = tmp_path / "a", tmp_path / "b"
    _build(TARGET, "backend", a / "graph.json")
    _build(TARGET, "backend", b / "graph.json")
    _assert_identical(a, b)
