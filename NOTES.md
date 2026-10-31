# NOTES: disclosure and decisions

## AI-generated code disclosure
All code in this folder was written by an AI assistant (Claude Opus 5.5, via Claude Code) in one session on 2026-10-29, working from the task brief. That covers:

- `trace_parser/` (`builder.py`, `discover.py`, `cli.py`, `__init__.py`, `__main__.py`)
- `tests/` (fixture package `tests/fixtures/fixpkg`, `test_fixture_graph.py`, `test_determinism.py`, `conftest.py`)
- `tools/verify.py`
- `out/report.md` and this file

No external code snippets were copied in. The only third-party libraries are jedi 0.20.1 (with its dependency parso 0.8.7), networkx 3.7 and pytest 9.2.0. All three are installed in `trace/.venv`.

The correct/incorrect judgements in the report's precision sections were made by the AI assistant. It read the source line printed for each sampled edge. No human checked them.

## External repos (read-only, not modified, not redistributed)
| repo | commit | license |
|---|---|---|
| fastapi/full-stack-fastapi-template | f4bcfaba7c85be3c6332cc74a20819f586dcdbc6 | MIT (LICENSE file + GitHub API) |
| borys25ol/fastapi-realworld-backend | 55111c6b335455734c139a2245d98be8288be528 (2026-01-27) | **none detected**: no LICENSE file, nothing in README/pyproject, and the GitHub API returns `license: null`. Under default copyright you may not redistribute it. It was only parsed locally; don't ship it or its graph in a public demo without the author's permission. |

## Decisions and assumptions
- **Python version mismatch.** The target requires Python >=3.14, but only 3.13.7 is available, and I did no global installs. `backend/app/api/deps.py` uses PEP 758 (`except A, B:`), which `ast` on 3.13 rejects. When `ast.parse` fails, the builder retries with an in-memory rewrite to `except(A, B):`. The rewrite keeps every token's column, so jedi positions still line up. jedi always gets the original source. Each use is recorded in `meta.parse_failures` with `recovered: true`. `--strict-parse` turns the shim off.
- **Third-party packages are not installed** (by rule). jedi therefore returns nothing for fastapi, sqlmodel, pydantic, etc. Calls where jedi finds nothing are classified in this order:
  1. The callee, or the root of its attribute chain, is bound by an import from a non-repo module → `external` (`unresolved_external_import`).
  2. An attribute call whose name is not defined anywhere in the repo, and is not assigned anywhere as an attribute or field → `external` (`name_not_defined_in_repo`). If the name is never defined in the repo, it can't be a call to a repo node.
  3. Otherwise → `uncertain`.

  The stats also report a strict rate that treats rules 1 and 2 as uncertain.
- Nested functions, lambdas and classes defined inside functions are not nodes. Their calls belong to the enclosing node, and calls to them resolve to that enclosing node.
- Decorator, default-value and annotation calls run at definition time, so they belong to the enclosing scope (module or class), not to the decorated function. Calls in a class body belong to the class node.
- Function/class `start_line` includes decorators. Duplicate qualnames (e.g. a property setter) get an `@<def line>` suffix.
- Route prefixes are resolved from literals, or from the default value of a repo-defined setting (e.g. `settings.API_V1_STR = "/api/v1"`). An environment variable could override that default at runtime. Routes from a router mounted inside an `if` get `conditional_mount: true`.
- Excluded dirs: `tests`, `test`, `alembic`, `migrations`, virtualenvs, build output, caches. Excluded files: `test_*.py`, `*_test.py`, `conftest.py`.
