# Trace — Status, Gaps and Next Work

> Snapshot from 2026-10-30 (Fri evening), at commit `4a0f1ae`. Results below come from commands run that day, not from
> older docs. Paths are relative to the repo root.

## Component status

| Component | State | Notes |
|---|---|---|
| Parser v1 | **Working** | Real graph of the demo repo; output is not in contract format |
| Contracts | **Working** | Models, exported schemas and generated TS types are in sync |
| Mock fixtures | **Working** | 25 nodes, 26 edges, 12 events, 5 checks; invented app |
| FastAPI app | **Working on mocks** | `/api/ask` ignores the question and replays a canned run |
| Web app | **Skeleton** | Graph, one fixed question and a raw event log; no animation, panels or styling work |
| Parser v2 | Not built | Contract format, layout, `implements`, dependency and external nodes |
| Graph tools | Not built | Stub package |
| Agent loop | Not built | Stub package; `openai` and `tenacity` are installed but not imported |
| Grounding validator | Not built | Stub package; must never be cut |
| Code panel | Not built | Also has no API route to get source from (see question 1) |
| Learning mode | Not built | Store fields only; `/api/checks` is unused; no `persist` middleware yet |
| Tap-check generator | Not built | `checks.json` is hand-written mock data |
| Eval | Not built | `eval/` holds only `.gitkeep` |
| Cached demo answers | Not built | Replay in `app.py` can serve them once they exist |
| Demo-repo choice | Open | Template is the default until the parser trial on larger repos |

Installed but not imported anywhere yet: `framer-motion`, `shiki`, `cmdk`, `fuse.js`. The shadcn `dialog`, `popover` and
`switch` components are also generated but unused.

## Check results (2026-10-30)

| Check | Result |
|---|---|
| `uv run pytest` | 50 passed, including the demo-repo determinism test |
| `uv run ruff check .` | Clean |
| `scripts/export_schemas.py --check` | No drift |
| `npm run lint` | 1 warning: `web/src/components/ui/button.tsx:66` (`only-export-components`, shadcn output) |
| `npm run build` | Passes. Warns that the main JS chunk is 696.51 kB (222.73 kB gzip) |
| Live API on built frontend | `/api/health`, `/api/graph`, `/api/checks` and `/` return 200; `/api/ask` streams 12 events |
| UI in a browser | **Not checked** in this pass |
| Meta API | **Not checked.** Gate 1 is recorded in `.claude/idea.md`, but no agent code is in this repo |

**Parser on `fastapi/full-stack-fastapi-template` @ `f4bcfaba7c85be3c6332cc74a20819f586dcdbc6`** (root `backend`):

- 19 files, 0 parse failures. Excluded: `backend/app/alembic` (6 files), `backend/tests` (15 files).
- Nodes: 19 modules, 22 classes, 51 functions, 23 routes (115 total).
- Edges: 59 calls, 41 imports, 6 inherits, 39 injects, 23 routes_to, 0 uncertain (168 total).
- 313 call sites: 59 resolved, 0 uncertain, 254 external.
- External evidence: 107 proven by jedi, 74 by non-repo import, 73 by name not defined in the repo.
- Rates: 59/59 internal calls resolved; 28.6% strict rate (jedi-proven externals only).
- 2 unresolved injections (`reusable_oauth2`, `OAuth2PasswordRequestForm`), 0 dangling edges.
- The login flow traces from the route through `crud.authenticate` and `verify_password` to token creation.

The precision samples in earlier reports were self-judged by the AI that wrote the parser, and no human has checked
them. Eval ground truth must be hand-labelled separately.

## Parser output vs the `Graph` contract

`Graph.model_validate` on the demo-repo output fails with **1,233 validation errors**. Parser v2 must close these:

| Parser v1 emits | Contract or mock expects |
|---|---|
| `meta.repo`, `meta.commit` | Top-level `repo`, `commit_sha` |
| `start_line`, `end_line` | `line_start`, `line_end` |
| No `module` on nodes | `module` required |
| No `resolved` on edges | `resolved` required |
| No `x`, `y` | Baked positions. Optional in the contract, but the UI depends on them. No layout step exists |
| Route ids such as `route:POST /x` | Mock uses `module.path:POST /x` |
| `target: null` on uncertain edges | `target` is a required string |
| Node extras: `decorators`, `method`, `path`, `local_path`, `router`, `prefix_resolution`, `router_mounted`, `conditional_mount` | Rejected by `extra="forbid"` |
| Edge extras: `callee`, `col`, `via`, `dependency`, `reason` | Rejected; only `note` is available |
| 13 extra stats fields | Rejected |
| Top-level `meta`, `external_calls`, `unresolved_injections` | Rejected |
| External calls kept in a separate list | Mock uses `external` nodes joined by `calls` edges, and counts those edges as `calls_external` |

## Open design questions from reading the code

Each one blocks or shapes work on the parser, agent or validator.

1. **Where does source text come from at runtime?** The code panel, the agent's read-source tool and the validator's
   quote check all need file contents, but `third_party/` is gitignored, the planned `data/<repo>/` holds no source,
   and no API route serves it. Recommendation: add a repo-path setting pointing at the pinned clone, add
   `GET /api/source`, and fail loudly when the clone is missing.
2. **What is the target of an uncertain edge?** The contract requires one, the mock uses a best guess, and `NOTES.md`
   says a stub. Recommendation: a stub node. The UI needs both ends to draw a dashed edge, and a best guess presents an
   inference as graph fact. The mock would need updating.
3. **Where do unresolved injections go?** The contract has no slot. Dropping them would hide known breaks in a flow,
   which working agreement 2 forbids for unresolved calls. Recommendation: `reusable_oauth2` becomes a `dependency` node (parser v2 item 3),
   `OAuth2PasswordRequestForm` becomes an `external` node, and anything else becomes an `uncertain` edge.
4. **What does `gap` mean?** `Claim.status` says "the parser could not resolve this link", while
   `.claude/idea-architecture.md` says consecutive path nodes with no real edge. Recommendation: a gap is no edge
   between consecutive steps, or a connecting edge that is `uncertain`. The validator can compute this. Update the
   description in `events.py`, then run `make schemas`.
5. **How granular are external stubs?** The demo repo has 254 external call sites against 115 nodes, so one node per
   site would swamp the map. Recommendation: one node per distinct callee and one edge per call site, which keeps
   `calls_external` correct.
6. **Where does the parser's report data live?** The contract has no slot for the excluded files, parse failures,
   evidence breakdown or strict rate, and the honest "externals classified by rule" claim depends on them.
   Recommendation: write a separate report file next to `graph.json`.

## Stale facts in older docs

| Where | Says | Actually |
|---|---|---|
| `.claude/idea.md:85` | 11 tests pass | 50 pass |
| `.claude/idea.md:85` | Report in `out/report.md` | `out/` was not imported and is not in this checkout |
| `.claude/idea.md:90` | Skeleton, contracts and web scaffold in progress | Done and committed |
| `.claude/idea-architecture.md:40-42` | Jedi proved 24 externals, 20.4% strict, libraries not installed | 107 proven, 28.6% strict, libraries installed |
| `.claude/idea-architecture.md:45-47` | One file parsed through an in-memory rewrite | Rewrite removed; runs natively on 3.14 |
| `.claude/idea-architecture.md:53` | v2 item 1: re-run on 3.14 with libraries | Done |
| `README.md` (main features, how it works) | Describes all features in the present tense | True of the target product, not the current build |
| `scripts/verify.py:3-5` | `--repo repos/fastapi-template` | Clone lives at `third_party/fastapi-template` |
| `backend/trace/parser/cli.py`, `builder.py` | Tool named `trace_parser` | Cosmetic; the package moved to `backend.trace.parser` |

## Next work

In schedule order from `.claude/idea-demo-eval.md`. Feature freeze is Mon Nov 2, and recording and submission are Tue
Nov 3.

1. **Parser v2:** close the contract gap, settle questions 2, 3, 5 and 6, add the baked layout, `implements` edges,
   dependency and external nodes. Trial the larger candidate repos and pick the demo repo.
2. **Tools, agent loop and validator on the real graph:** settle questions 1 and 4. This is the first test of tools
   and structured output together, and it is the biggest technical risk.
3. **Wire `/api/ask` to the real loop,** with cached answers for the demo.
4. **UI priorities 1–3:** path animation, view transition, command palette, plus the code panel.
5. **Learning mode and tap-check generator.**
6. **Eval** on about 10 questions hand-labelled by a human.

Also outstanding, from `.claude/idea-demo-eval.md`: claim the Meta credits, get written confirmation on third-party AI
coding agents, and confirm the entry track. The `docs/prds/` stubs are still empty.
