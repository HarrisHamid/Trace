"""File discovery: decide which .py files under the root are parsed."""

from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass, field

# Directory names that are never parsed, with the reason recorded in the graph.
EXCLUDED_DIRS = {
    "tests": "tests",
    "test": "tests",
    "alembic": "migrations",
    "migrations": "migrations",
    ".venv": "virtualenv",
    "venv": "virtualenv",
    "env": "virtualenv",
    "site-packages": "virtualenv",
    "build": "build output",
    "dist": "build output",
    "__pycache__": "build output",
    "node_modules": "build output",
    ".git": "vcs",
    ".mypy_cache": "tool cache",
    ".pytest_cache": "tool cache",
    ".ruff_cache": "tool cache",
}
EXCLUDED_DIR_GLOBS = {"*.egg-info": "build output"}
EXCLUDED_FILE_GLOBS = {
    "test_*.py": "tests",
    "*_test.py": "tests",
    "conftest.py": "tests",
}


@dataclass
class Discovery:
    included: list[str] = field(default_factory=list)  # root-relative posix paths
    excluded_dirs: list[dict] = field(default_factory=list)
    excluded_files: list[dict] = field(default_factory=list)


def _count_py(path: str) -> int:
    n = 0
    for _, _, files in os.walk(path):
        n += sum(1 for f in files if f.endswith(".py"))
    return n


def _dir_reason(name: str) -> str | None:
    if name in EXCLUDED_DIRS:
        return EXCLUDED_DIRS[name]
    for pat, reason in EXCLUDED_DIR_GLOBS.items():
        if fnmatch.fnmatch(name, pat):
            return reason
    return None


def discover(root: str) -> Discovery:
    d = Discovery()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        keep = []
        for name in dirnames:
            reason = _dir_reason(name)
            if reason:
                full = os.path.join(dirpath, name)
                d.excluded_dirs.append(
                    {
                        "path": os.path.normpath(os.path.join(rel_dir, name)).replace(os.sep, "/"),
                        "reason": reason,
                        "py_files": _count_py(full),
                    }
                )
            else:
                keep.append(name)
        dirnames[:] = keep
        for name in sorted(filenames):
            if not name.endswith(".py"):
                continue
            rel = os.path.normpath(os.path.join(rel_dir, name)).replace(os.sep, "/")
            reason = next(
                (r for pat, r in EXCLUDED_FILE_GLOBS.items() if fnmatch.fnmatch(name, pat)),
                None,
            )
            if reason:
                d.excluded_files.append({"path": rel, "reason": reason})
            else:
                d.included.append(rel)
    d.included.sort()
    d.excluded_dirs.sort(key=lambda x: x["path"])
    d.excluded_files.sort(key=lambda x: x["path"])
    return d


def module_name(rel_path: str) -> str:
    parts = rel_path[:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)
