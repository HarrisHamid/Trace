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

## Scaffold
Everything in this section was written by an AI assistant (Claude Opus 5.5, via Claude Code) on 2026-10-30, working from the scaffold brief. It extends the disclosure above. The packages listed above moved with the parser, so their old paths no longer apply.

### Created
- Project: `pyproject.toml`, `uv.lock`, `.python-version`, `.gitignore`, `.env.example`, `Makefile`
- Packages: `backend/__init__.py`, `backend/trace/__init__.py`, and placeholders `backend/trace/{tools,agent,validator}/__init__.py`
- Contracts: `backend/trace/schemas/{base,graph,events,checks}.py`, `scripts/export_schemas.py`, `docs/contracts/*.schema.json` (generated)
- Mock data: `data/mock/{graph.json,events.jsonl,checks.json}`, describing an invented `taskboard` app
- API: `backend/trace/api/{app,settings}.py`
- Tests: `tests/test_schemas.py`, `tests/test_mock_fixtures.py`, `tests/test_api.py`, `tests/test_pep758.py`
- Web: everything under `web/`. `web/src/components/ui/` and `web/src/lib/utils.ts` are shadcn CLI output, `web/src/types/contracts/` is generated from the JSON Schemas, and `App.tsx`, `api.ts`, `store.ts` and `components/GraphView.tsx` are AI-written
- Docs: `docs/prds/*.md` (stubs), README sections "Built during the hackathon", "Quickstart" and "Attribution"

### Moved
- `trace_parser/` to `backend/trace/parser/`, `tools/verify.py` to `scripts/verify.py`. Run the parser with `python -m backend.trace.parser build ...`.

### Decisions
- **Imported, then moved.** The parser lived in `~/Desktop/trace`, which was not a git repo. It was committed unchanged first, then moved with `git mv`, so the rename is in history. The original folder was left in place.
- **`out/` and `repos/` were not imported.** `out/` holds graphs derived from third-party repos, including the unlicensed one above, and this repo is public.
- **`backend.trace`, not `trace`.** An installed top-level `trace` loses to the stdlib module (`'trace' is not a package`), and forcing it first on the path would hide the stdlib module. The directories match the brief; only the import path includes `backend`.
- **PEP 758 shim removed.** This replaces the "Python version mismatch" decision above. Python 3.14 parses `except A, B:` itself. The 11 tests contain no such syntax, so the check that mattered was the target repo: the 3.14 graph is identical with and without the shim apart from the removed `meta.strict_parse` key, and `--strict-parse` is gone. `tests/test_pep758.py` covers the syntax directly.
- **Third-party packages are now installed.** This replaces the note above. jedi can see fastapi, pydantic and others in the venv, so on the target repo more externals are proven by jedi (`jedi_definition` 107, was 24) and the strict rate rises to 28.6% (was 20.4%). The set of external calls, the nodes, the edges and `call_resolution_rate` are unchanged.
- **Parser output does not match `schemas/graph.py` yet.** v1 emits `start_line`/`end_line`, ids like `route:GET /x`, and `target: null` on uncertain edges. The contract is the target for parser v2. `Edge.target` is required, so v2 needs a stub target for an uncertain call.
- **External stubs.** The contract requires `file` and lines on every node, so stubs use `file: "<external>"` and lines of 0.
- **Max 8 tool calls is documented, not validated.** `MAX_TOOL_CALLS` and the `call_index` description state it. The agent loop will enforce it.
- **Parser ruff findings are ignored by path.** The broad excepts are deliberate guards around jedi, and rewriting them could change behaviour. New code gets the full rule set.

## Project context
`.claude/Project_Context/` (`README.md`, `architecture.md`, `status.md`) was written by an AI assistant (Claude Opus 5.5, via Claude Code) on 2026-10-30. It describes the repo as built, and the results in `status.md` come from commands run that day.


## Landing page
- **Third-party component removed (2026-10-31).** From 2026-10-30 the landing page used `web/src/components/ui/helix-chrono-matrix.tsx`, adapted from a third-party React component, `HelixChronoMatrix`. Its source and licence were never confirmed, so it was deleted rather than kept. It is no longer in the working tree, but it is still in git history (`b11c3d0`), which was not rewritten because commit timestamps are evidence for the new-work rule.
- **Helix rewritten, AI-written (Claude Opus 5.5, via Claude Code):** `web/src/lib/helix.ts` and the rework of `web/src/components/Landing.tsx`. No code was carried over, and the shape is different: a true double helix along one tilted axis, where the old component was a stack of counter-rotating rings. The assistant had read the old file before writing this, so it is a rewrite, not a clean-room implementation.
- **The helix shows what Trace does.** One strand is the answer, the other the code, and each rung is a claim. The parcel rides the answer and settles rungs as verified, unverified or gap, drawn as they are elsewhere (solid, hollow, broken) so status is never colour alone. Rung statuses are a fixed pattern and illustrate the idea; they are not results from a run, which is why the page shows no counts.
- **Two canvases sandwich the wordmark,** the same idiom as `sky.ts`, so strands pass in front of and behind the letters. Strands in front get a dark edge, because they are the same colour as the letters and would otherwise vanish into them.
- **The pointer unwinds the helix.** The twist it removes is added back either side of it, so the rest of the helix doesn't move.
- **Perspective applies only across the axis.** Applied along it too, points far from the centre swing sideways and the strands fold into loops.
- **Reduced motion gets one static frame,** and the pointer does nothing.
- **AI-written on 2026-10-30:** `web/src/components/Landing.tsx`, the hash switch in `web/src/App.tsx`, and `web/src/components/Workspace.tsx`, which is the old `App` body moved unchanged.
- **Hash routes, not a router.** FastAPI's `StaticFiles` mount has no SPA fallback, so a path like `/app` would 404 on refresh. `#/app` needs no backend change and no new dependency.

## UI
- **AI-written on 2026-10-31 (Claude Opus 5.5, via Claude Code):** `docs/prds/03-ui.md`; `web/src/components/{AskBar,CodePanel,CommandPalette,Glyphs,MapChrome,ObservationLog}.tsx`; `web/src/lib/{highlight,run,sky}.ts`; `data/mock/source/`; `GET /api/source`; rewrites of `GraphView.tsx`, `Workspace.tsx`, `store.ts` and the tokens in `index.css`.
- **Instrument Serif replaces Inter.** Added `@fontsource/instrument-serif` (SIL OFL) and removed `@fontsource-variable/inter`. JetBrains Mono stays for code, labels and chrome.
- **A canvas behind Cytoscape, not Cytoscape effects.** Cytoscape has no soft glow and can't draw a stroke progressively, so `lib/sky.ts` draws the glows and the thread underneath the nodes. Stars are seeded so the map looks identical on every run.
- **Modules are plates, not compound nodes.** The architecture doc planned compound nodes. Plates are drawn from the baked layout instead, and `data/mock/graph.json` was re-baked so each module's members sit together. The real layout step (parser v2) has to cluster by module too, or the plates will overlap.
- **A `gap` claim opens at the previous step.** Its quote is the unresolved call site, which is in the caller, not the target. The real validator needs to keep this shape, or `ObservationLog.tsx` needs a new rule. If a quote isn't in the file, the panel says so.
- **Source stubs match the graph's line numbers,** so `deps.py` and others are oddly dense in places. Tests pin them to `graph.json` and to the quotes in `events.jsonl`. `data/mock/source/` is excluded from ruff.
- **Playback lags the stream on purpose.** The animation holds about 400ms per step and queues whatever arrives faster.

## Space factory map (2026-10-31)
- **Plates, labels and belts.** `web/src/lib/scene.ts` builds one plate per module and the belts from the graph. `web/src/lib/pills.ts` draws the label cards on a second canvas above Cytoscape. `web/src/lib/sky.ts` draws the background, plates and the answer. All of it is AI-written.
- **Colour means module.** Six `--module-*` tokens replace the per-type colours. Shape still carries the node type.
- **Wiring is hidden by default.** Imports, injects, inherits and implements are behind "Show all connections". The default map is who calls whom.
- **Idle motion is capped at about 30fps** and is off under `prefers-reduced-motion`.
- **Calls are glowing lines, and the conveyor is saved for the answer, AI-written (Claude Opus 5.5, via Claude Code).** `web/src/lib/belt.ts` draws both on the sky's back canvas. A conveyor on every call was tried first and was too cluttered, so at rest a call is a thin white line with a faint blue glow, and a run lays a conveyor over the routes it takes: rails, slats, underside and legs, in the same oblique view as the plates. Cytoscape's lines are hidden for these edges (`isBelt` in `scene.ts`), and wiring edges stay Cytoscape lines.
- **Direction without arrowheads.** At rest the packages show it. Under reduced motion there are no packages, so each line gets one small chevron at its midpoint. The conveyor's slats are chevrons, so it reads in a still frame too.
- **Lines are S-curves, not straight,** leaving and arriving along their longer axis. The conveyor, the agent's footsteps, the parcel and the packages all follow the same routes, so nothing leaves the track.
- **An uncertain edge is a dashed blue line with no packages,** and a broken blue conveyor in a run, so an unproven link never looks like working machinery.
- **One line per caller and callee pair.** Each call site is an edge, and repeats would stack. The real graph has 79 pairs from 82 edges.
- **Far out, the conveyor simplifies.** Below zoom 0.42 it loses the rail highlight and the legs, and it stops shrinking at about 6px wide.

## Parser v2 (2026-10-31)
- **AI-written (Claude Opus 5.5, via Claude Code):** `backend/trace/parser/layout.py`; the rework of `backend/trace/parser/builder.py`, `cli.py` and `scripts/verify.py`; `tests/test_layout.py`, `tests/test_target_graph.py`, the fixtures `tests/fixtures/fixpkg/{stores,injected}.py`, and the rewrite of `tests/test_fixture_graph.py`. Web changes are listed below.
- **`build()` now returns `(graph, report)`.** The graph is checked with `Graph.model_validate` before it is returned, so a contract break fails the build. `report.json` is written next to `graph.json` and holds what the contract has no slot for: file accounting, the evidence breakdown, the strict rate, every call site, every injection and route details. The honest "externals classified by rule" claim rests on that file.
- **New node type `unresolved`.** An uncertain edge needs a target, a best guess would present an inference as fact, and `external` would claim something unproven. The node sits in the caller's module and points at its first site in that module, so opening it shows the code that could not be resolved. Id: `module.path:?callee`.
- **External nodes: one per distinct callee, one edge per call site.** That keeps `calls_external` correct. jedi's name is used when it has one (`fastapi.exceptions:HTTPException`). The import rule uses the import (`jwt:decode`). The name rule has no library to name, so those sit under `<unknown>` (`<unknown>:session.exec`). Arguments are dropped and long chains collapse (`select()….limit`), or every query would be its own node. These edges are `calls` with `resolved: true` and the evidence in `note`: the call site is real, and only the identity of the stub rests on a rule. The validator must not treat them as proven library facts.
- **Injections.** A module variable such as `reusable_oauth2` becomes a `dependency` node. A library class such as `OAuth2PasswordRequestForm` becomes an `external` node. Anything else is an `uncertain` edge. These uncertain edges are not call sites, so they stay out of `calls_uncertain` and the resolution rate.
- **Any function reached by `injects` is typed `dependency`,** whoever else calls it. The mock is not consistent on this (`get_user_service` is injected but typed `function`), and it was left alone because the checks fixture depends on it.
- **`implements` points from the implementation to the abstract method,** matching the mock. A base method counts as abstract if it has `@abstractmethod`, or its body only declares (`...`, `pass`, a docstring, `raise NotImplementedError`). With several implementations each edge is `resolved: false`, because the link is true but which one runs is a runtime fact. Only explicit inheritance is detected, so structural `Protocol` matches are missed.
- **`inherits` now sees subscripted bases,** so `class Repo(Base[int])` links to `Base`.
- **Layout.** Plates flow down columns in call order, and the column height is chosen to best fill a 2:1 frame. The first version gave every call depth its own column, which came out about 8,000 units wide, past the camera's minimum zoom, and hid every plate name. `layout.py` mirrors the plate padding in `web/src/lib/scene.ts`; change them together. `tests/test_layout.py` rebuilds the UI's boxes and checks that plates don't overlap.
- **Duplicate module names are disambiguated,** because the name is the plate's title (`routes.utils` and `app.utils`, not two `utils`).
- **`repo` and `commit_sha` come from git,** and only when the folder is the root of its own checkout. The fixtures sit inside Trace, so they report `unknown` rather than Trace's commit.
- **Web changes for the above, AI-written:** external calls are hidden until "Show all connections" and carry no belts (`scene.ts`, `GraphView.tsx`), because 254 of them would swamp 59 repo calls; the answer's own belt still reaches them. The `unresolved` type gets a dashed ring and a legend entry (`Glyphs.tsx`, `GraphView.tsx`, `pills.ts`, `CommandPalette.tsx`, `MapChrome.tsx`). `run.ts` treats any `resolved: false` edge as broken, not just `uncertain` ones.
- **Target-repo libraries are only partly installed.** Trace's venv has fastapi and pydantic but not sqlmodel, pyjwt or pwdlib, so jedi cannot see `session.exec` and the name rule classifies it. The earlier note that third-party packages are installed holds only for Trace's own dependencies.

