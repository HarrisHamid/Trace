import filecmp
import os
import subprocess
import sys

TRACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(TRACE, "tests", "fixtures")
TARGET = os.path.join(TRACE, "repos", "fastapi-template")


def _build(repo, root, out):
    subprocess.run(
        [sys.executable, "-m", "trace_parser", "build", "--repo", repo, "--root", root, "--out", str(out)],
        cwd=TRACE, check=True, capture_output=True,
    )


def test_fixture_build_is_deterministic(tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    _build(FIXTURES, ".", a)
    _build(FIXTURES, ".", b)
    assert filecmp.cmp(a, b, shallow=False)


def test_target_build_is_deterministic(tmp_path):
    if not os.path.isdir(TARGET):
        import pytest
        pytest.skip("target repo not cloned")
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    _build(TARGET, "backend", a)
    _build(TARGET, "backend", b)
    assert filecmp.cmp(a, b, shallow=False)
