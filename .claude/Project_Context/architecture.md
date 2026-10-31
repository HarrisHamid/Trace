# Trace — Architecture As Built

> How the code works on 2026-10-30, at commit `4a0f1ae`. For the target design see `.claude/idea-architecture.md`.
> Paths are relative to the repo root.

## System today

There are two separate halves. The parser runs on real code, and the API and UI run on mock data. Nothing connects
them yet.

```
REAL DATA                                     MOCK DATA
third_party/fastapi-template (pinned)         data/mock/ (invented "taskboard" app)
  |                                             graph.json  events.jsonl  checks.json
  v                                             |
backend/trace/parser  [built, no AI]            v
  ast + jedi + networkx                       backend/trace/api  [built]
  |                                             GET  /api/graph   validated Graph
  v                                             GET  /api/checks  validated ChecksFile
out/graph.json (gitignored)                     POST /api/ask     replays events over SSE
  parser format, NOT the Graph contract         |
  |                                             v
  X---- parser v2 not built ---->             web/ (React, Cytoscape.js, Zustand)  [skeleton]

NOT BUILT: backend/trace/tools -> backend/trace/agent -> backend/trace/validator
           These replace the replay behind POST /api/ask.
```

## Parser: `backend/trace/parser/`

Deterministic and AI-free. `GraphBuilder(repo, root).build()` returns a plain dict.

| File | Role |
|---|---|
| `builder.py` (840 lines) | All graph logic |
| `discover.py` | Chooses files. Excludes tests, migrations, virtualenvs, build output and tool caches, and records each exclusion |
| `cli.py`, `__main__.py` | `python -m backend.trace.parser build --repo <path> --root <subfolder> --out <file>` |

Passes run in this order: load, nodes, calls, routes, injects, imports and inherits, then `to_json`.

**Call classification.** Every call site lands in exactly one bucket:

| Result | How it is decided | Stored as |
|---|---|---|
| resolved | jedi finds exactly one definition that is a repo node | `calls` edge |
| uncertain | Ambiguous or dynamic, with a recorded `reason` | `uncertain` edge with `target: null` |
| external | jedi proves it, or a rule does (below) | `external_calls` list with `evidence` |

When jedi finds nothing, the rules are applied in order. If the callee or the root of its attribute chain comes from a
non-repo import, it is external (`unresolved_external_import`). If it is an attribute call whose name is defined or
assigned nowhere in the repo, it is external (`name_not_defined_in_repo`). Anything else is uncertain.

**Attribution.** Nested functions, lambdas and local classes are not nodes, so their calls belong to the enclosing
node. Decorators, defaults and annotations run at definition time, so they belong to the outer scope.

**Routes.** The parser reads FastAPI and Flask decorators on routers, apps and blueprints. Prefixes come from literals
or the default of a repo-defined setting. Routes mounted inside an `if` get `conditional_mount: true`.

**Injection.** The parser finds `Depends` and `Security` in parameter defaults, `Annotated[...]`, type aliases such as
`SessionDep`, and route `dependencies=[...]`. Anything it cannot turn into an edge goes in `unresolved_injections`.

**Node and edge types emitted today:** module, class, function, route; calls, imports, inherits, routes_to, injects,
uncertain. The `dependency` and `external` node types and `implements` edges exist only in the contract and mock data.

**Reviewer tool:** `scripts/verify.py` (`sample`, `flow`, `files`) reads the parser format, not the contract format.

## Contracts: `backend/trace/schemas/`

This is the single source of truth between parser, agent, API and UI. `Contract` in `base.py` sets `extra="forbid"`.

```
pydantic models (backend/trace/schemas/*.py)
  -> make schemas         -> docs/contracts/*.schema.json   (committed)
  -> npm run gen:types    -> web/src/types/contracts/*.d.ts (committed, runs on dev and build)
```

| Contract | File | Key shape | Enforced by validators |
|---|---|---|---|
| `Graph` | `graph.py` | `repo`, `commit_sha`, `nodes`, `edges`, `stats` | Unique node ids; `call_resolution_rate` must equal resolved / (resolved + uncertain) |
| `Event` | `events.py` | Union discriminated on `type` | Closed claim status: `verified`, `unverified`, `gap` |
| `ChecksFile` | `checks.py` | `repo`, `checks` (one per node) | Unique option ids; correct option must exist |

- **Node types:** module, class, function, route, dependency, external.
- **Edge types:** calls, imports, inherits, routes_to, injects, implements, uncertain.
- **Node ids:** `module.path:qualname`; module nodes are just `module.path`.
- **External stubs:** `file: "<external>"`, lines 0.
- **Event order in the mock run:** `run_started`, then `tool_call`, `tool_result`, `node_visited` three times, then
  `final_path`, `done`. `error` also exists. Each event's SSE name is its `type`.
- **`final_path`:** a list of `PathStep` (`node_id`, `explanation`, `claims`). A `Claim` has `text`, optional `quote`
  and `status`.

## API: `backend/trace/api/`

`create_app(settings)` is the factory, and `Settings` reads the environment plus `.env`.

| Route | Behaviour today |
|---|---|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/graph` | Reads and validates `graph.json` on every request |
| `GET /api/checks` | Reads and validates `checks.json` on every request. Nothing in the frontend calls it yet |
| `POST /api/ask` | Requires `{"question": ...}` but ignores its value. Replays `events.jsonl` over SSE |
| `/` | Serves `web/dist` when the directory exists; otherwise there is no root route |

| Setting | Default | Notes |
|---|---|---|
| `TRACE_DATA_DIR` | `data/mock` | Must hold `graph.json`, `checks.json` and `events.jsonl` |
| `TRACE_WEB_DIST` | `web/dist` | |
| `TRACE_REPLAY_DELAY_SECONDS` | `0.3` | Gap between replayed events |
| `META_API_KEY`, `META_BASE_URL`, `META_MODEL` | empty | Set in `.env` (see `.env.example`). No code reads them yet |

**Where the agent plugs in:** `replay_events` in `app.py` is the seam. The real loop yields the same
`{"event": ..., "data": ...}` dicts, so the frontend needs no protocol change. The replay path can also serve cached
demo answers.

## Frontend: `web/`

React 19, TypeScript, Vite, Tailwind 4, shadcn/ui and Cytoscape.js. In development Vite proxies `/api` to `:8000`. In
production FastAPI serves `web/dist` from the same origin, so there is no CORS setup.

| File | Role today |
|---|---|
| `src/App.tsx` | Loads the graph; one button with the hardcoded question "How does login work?"; raw event log |
| `src/components/GraphView.tsx` | Cytoscape with `preset` layout from baked `x`/`y`. Colours by node type, dashes `uncertain` edges, sets `selectedNode` on tap |
| `src/api.ts` | `fetchGraph` and `streamAsk`. SSE is parsed by hand because `EventSource` only supports GET |
| `src/store.ts` | Zustand store for selection and the agent run. `learningMode` and `nodeStates` exist, but no component uses them |

Missing `x`/`y` fall back to `(0, 0)`, so a graph without baked positions renders as a stack at the origin.

## Tests: `tests/`

| File | Tests | Covers |
|---|---|---|
| `test_schemas.py` | 21 | Contract rules, and that exported schemas match the models |
| `test_fixture_graph.py` | 9 | Exact parser output on `tests/fixtures/fixpkg` |
| `test_api.py` | 9 | Endpoints, SSE order, settings, static serving |
| `test_mock_fixtures.py` | 8 | Mocks are complete and consistent with each other |
| `test_determinism.py` | 2 | Two builds are byte-identical. The target-repo test skips without the clone |
| `test_pep758.py` | 1 | Python 3.14 `except A, B:` parses natively |

There is no CI and no frontend test suite.

## Repo map

```
backend/trace/
  parser/      built: real graph from real code
  schemas/     built: the three contracts
  api/         built: FastAPI over mock data
  tools/       stub   agent/  stub   validator/  stub
data/mock/     hand-written contract fixtures
docs/contracts/  generated JSON Schemas
docs/prds/     TODO stubs
eval/          empty
scripts/       export_schemas.py, verify.py
tests/         pytest suite and fixpkg fixture
web/src/       React app; types/contracts/ is generated, components/ui/ is shadcn output
third_party/   gitignored pinned clones
out/           gitignored parser output (not present in a fresh checkout)
```

Planned but not created yet: `data/<repo>/` (real graph, checks, cached answers) and `eval/run_eval.py`.
