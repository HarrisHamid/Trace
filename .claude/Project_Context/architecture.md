# Trace — Architecture As Built

> How the code works on 2026-10-31, on branch `feat/parser-v2`. For the target design see `.claude/idea-architecture.md`.
> Paths are relative to the repo root.

## System today

The parser now emits the same `Graph` contract the API and UI read, so a real graph can be served by pointing
`TRACE_DATA_DIR` at it. The agent half does not exist yet, so `POST /api/ask` still replays the mock run.

```
REAL DATA                                     MOCK DATA
third_party/fastapi-template (pinned)         data/mock/ (invented "taskboard" app)
  |                                             graph.json  events.jsonl  checks.json
  v                                             |
backend/trace/parser  [built, no AI]            |
  ast + jedi + networkx                         |
  |                                             |
  v                                             v
out/graph.json  (Graph contract)  ------>     backend/trace/api  [built]
out/report.json (parser report)                 GET  /api/graph   validated Graph
                                                GET  /api/checks  validated ChecksFile
                                                POST /api/ask     replays events over SSE
                                                |
                                                v
                                              web/ (React, Cytoscape.js, Zustand)

NOT BUILT: backend/trace/tools -> backend/trace/agent -> backend/trace/validator
           These replace the replay behind POST /api/ask.
```

## Parser: `backend/trace/parser/`

Deterministic and AI-free. `GraphBuilder(repo, root).build()` returns `(graph, report)`, both plain dicts. The graph is
checked with `Graph.model_validate` before it is returned. The CLI writes it to `--out` and writes `report.json` beside it.

| File | Role |
|---|---|
| `builder.py` | All graph logic |
| `layout.py` | Baked positions. Mirrors the plate padding in `web/src/lib/scene.ts`; change them together |
| `discover.py` | Chooses files. Excludes tests, migrations, virtualenvs, build output and tool caches, and records each exclusion |
| `cli.py`, `__main__.py` | `python -m backend.trace.parser build --repo <path> --root <subfolder> --out <file>` |

Passes run in this order: load, nodes, calls, routes, injects, imports and inherits, implements, then the contract
(which runs the layout) and the report.

**Call classification.** Every call site lands in exactly one bucket:

| Result | How it is decided | Stored as |
|---|---|---|
| resolved | jedi finds exactly one definition that is a repo node | `calls` edge |
| uncertain | Ambiguous or dynamic, with a recorded `reason` | `uncertain` edge to an `unresolved` node, `resolved: false`, reason in `note` |
| external | jedi proves it, or a rule does (below) | `calls` edge to an `external` node, `resolved: true`, evidence in `note` |

Every call site, whichever bucket it landed in, is also a row in the report's `call_sites`.

When jedi finds nothing, the rules are applied in order. If the callee or the root of its attribute chain comes from a
non-repo import, it is external (`unresolved_external_import`). If it is an attribute call whose name is defined or
assigned nowhere in the repo, it is external (`name_not_defined_in_repo`). Anything else is uncertain.

**Attribution.** Nested functions, lambdas and local classes are not nodes, so their calls belong to the enclosing
node. Decorators, defaults and annotations run at definition time, so they belong to the outer scope.

**Routes.** The parser reads FastAPI and Flask decorators on routers, apps and blueprints. Prefixes come from literals
or the default of a repo-defined setting. Routes mounted inside an `if` get `conditional_mount: true`.

**External identity.** One node per distinct callee, one edge per call site. jedi's name wins when it has one
(`fastapi.exceptions:HTTPException`), the import rule uses the import (`jwt:decode`), and the name rule has no library to
name, so it uses `<unknown>:session.exec`. `callee_shape` drops arguments and collapses long chains (`select()….limit`).

**Injection.** The parser finds `Depends` and `Security` in parameter defaults, `Annotated[...]`, type aliases such as
`SessionDep`, and route `dependencies=[...]`. A repo function or class gets an `injects` edge, and an injected function is
typed `dependency`. A module variable becomes a `dependency` node, a library class an `external` node, and anything else
an `uncertain` edge. Those uncertain edges are not call sites, so they stay out of `calls_uncertain`.

**Implements.** An edge from a method to the abstract method it fills in, through explicit inheritance only. A base method
is abstract if it has `@abstractmethod` or its body only declares. With several implementations the edges are
`resolved: false`.

**Layout.** One plate per module, plus one for all `external` nodes. Modules are ranked by call depth, plates flow down
columns in that order, and the column height is chosen to best fill a 2:1 frame. Inside a plate a route sits beside its
handler and a class above its methods. Modules with no members get no plate and sit in a strip below the map.

**Report (`report.json`).** File accounting, the evidence breakdown, strict rate, uncertain reasons, routes (method, path,
prefix resolution, `conditional_mount`), `call_sites` and `injection_sites`.

**Reviewer tool:** `scripts/verify.py` (`sample`, `flow`, `files`) reads `graph.json` and the `report.json` beside it.

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

- **Node types:** module, class, function, route, dependency, external, unresolved.
- **Edge types:** calls, imports, inherits, routes_to, injects, implements, uncertain.
- **Node ids:** `module.path:qualname`; module nodes are just `module.path`.
- **External stubs:** `file: "<external>"`, lines 0.
- **Unresolved nodes:** `module.path:?callee`, in the caller's module, pointing at their first site in that module.
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
| `GET /api/source?file=` | Plain text of a file under `TRACE_SOURCE_DIR`; 404 for anything missing or outside it |
| `POST /api/ask` | Requires `{"question": ...}` but ignores its value. Replays `events.jsonl` over SSE |
| `/` | Serves `web/dist` when the directory exists; otherwise there is no root route |

| Setting | Default | Notes |
|---|---|---|
| `TRACE_DATA_DIR` | `data/mock` | Must hold `graph.json`, `checks.json` and `events.jsonl` |
| `TRACE_SOURCE_DIR` | `data/mock/source` | Root the graph's `file` paths resolve against. Point it at the pinned clone for a real repo |
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
| `src/App.tsx` | Hash switch: `#/app` shows `Workspace`, anything else shows `Landing`. Hash routes because `StaticFiles` has no SPA fallback |
| `src/components/Landing.tsx` | Entry screen: helix, wordmark, tagline, status legend, link to `#/app` |
| `src/components/Workspace.tsx` | Loads the graph, runs playback, handles Escape and palette picks, lays out the panels |
| `src/components/GraphView.tsx` | Cytoscape for camera and hit-testing, with `preset` layout. Plates and module tabs are placed from the scene; node states are classes; all camera moves; the caption beside the current node; the wiring toggle |
| `src/components/ObservationLog.tsx` | The run: question, tally, tool trace, one lettered entry per step with claim chips |
| `src/components/CodePanel.tsx` | Shiki-highlighted source with the node's lines and any quoted line marked; explicit unavailable state |
| `src/components/CommandPalette.tsx` | `/` or Cmd+K, cmdk with fuse.js search over the nodes |
| `src/components/AskBar.tsx`, `MapChrome.tsx`, `Glyphs.tsx` | Question input; title, breadcrumb, legend card and the "Show all connections" toggle; node and claim-status glyphs. Node glyphs take the module colour |
| `src/lib/sky.ts` | Two canvases around Cytoscape. Behind it: starfield, plates with depth and trim, class outlines, call lines, glows and the answer's conveyor. In front: drifting packages and the parcel. The idle loop runs at about 30fps |
| `src/lib/belt.ts` | Routes (even-spaced S-curves in model units) and how they are drawn: a thin glowing line at rest, and for the answer a conveyor with rails, chevron slats, underside and legs. Cytoscape's own lines are hidden for these edges |
| `src/lib/helix.ts` | The landing page's double helix. Two canvases around the wordmark, so it weaves through the letters. Static under `prefers-reduced-motion` |
| `src/lib/scene.ts` | Built once from the graph: a plate per module (box, tab, caption), a colour per module, belts and per-node call counts. Calls into `external` nodes get no belt |
| `src/lib/pills.ts` | `LabelPainter`: label cards for nodes, tabs and captions for plates. Drops lower-priority labels that would collide |
| `src/lib/css.ts` | `cssVar` reads a theme token. The tokens in `index.css` are the one source of colour |
| `src/lib/run.ts` | Pure derivation of what to show from the events and the playback position; playback timing |
| `src/lib/highlight.ts` | Shiki core with Python and the `observatory` theme, loaded on demand |
| `src/api.ts` | `fetchGraph`, `fetchSource` and `streamAsk`. SSE is parsed by hand because `EventSource` only supports GET |
| `src/store.ts` | Zustand store for selection, the run, playback, view level, palette, code panel and the wiring toggle. `learningMode` and `nodeStates` exist, but no component uses them |

Missing `x`/`y` fall back to `(0, 0)`, so a graph without baked positions renders as a stack at the origin.

## Tests: `tests/`

| File | Tests | Covers |
|---|---|---|
| `test_schemas.py` | 21 | Contract rules, and that exported schemas match the models |
| `test_fixture_graph.py` | 21 | Exact parser output on `tests/fixtures/fixpkg`, in contract format |
| `test_layout.py` | 8 | Unique positions, no overlapping plates, routes beside handlers, on the fixtures and the target repo |
| `test_target_graph.py` | 6 | Pins the demo repo's counts and flows. Skips without the clone |
| `test_api.py` | 14 | Endpoints, source path checks, SSE order, settings, static serving |
| `test_mock_fixtures.py` | 11 | Mocks are complete and consistent with each other and with the source stubs |
| `test_determinism.py` | 2 | Two builds are byte-identical. The target-repo test skips without the clone |
| `test_pep758.py` | 1 | Python 3.14 `except A, B:` parses natively |

There is no CI and no frontend test suite.

## Repo map

```
backend/trace/
  parser/      built: real graph from real code, in contract format
  schemas/     built: the three contracts
  api/         built: FastAPI over mock data
  tools/       stub   agent/  stub   validator/  stub
data/mock/     hand-written contract fixtures; source/ holds the invented taskboard app, line-aligned with graph.json
docs/contracts/  generated JSON Schemas
docs/prds/     03-ui.md is written; the others are TODO stubs
eval/          empty
scripts/       export_schemas.py, verify.py
tests/         pytest suite and fixpkg fixture
web/src/       React app; types/contracts/ is generated, components/ui/ is shadcn output
third_party/   gitignored pinned clones
out/           gitignored parser output: graph.json and report.json (not present in a fresh checkout)
```

Planned but not created yet: `data/<repo>/` (real graph, checks, cached answers) and `eval/run_eval.py`.
