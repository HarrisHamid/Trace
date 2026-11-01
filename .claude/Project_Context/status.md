# Trace — Status, Gaps and Next Work

> Snapshot from 2026-10-31, updated 2026-11-01 for the agent work on branch `feat/agent-validator`.
> Results below are from commands run that day, unless the row says otherwise. Paths are relative to the repo root.

## Component status

| Component | State | Notes |
|---|---|---|
| Parser v2 | **Working** | Contract format, baked layout, `implements`, dependency, external and unresolved nodes, plus `report.json`. Functions passed as values are still not edges |
| Contracts | **Working** | Models, exported schemas and generated TS types are in sync |
| Mock fixtures | **Working** | 26 nodes, 26 edges, 12 events, 5 checks; invented app |
| FastAPI app | **Working** | Serves a real graph and real source through `TRACE_DATA_DIR` and `TRACE_SOURCE_DIR`. `/api/ask` replays `events.jsonl` in mock mode, then a cached answer, and otherwise runs the agent |
| Web app | **Working** | Map, code panel, a live run and a path that revisits a node checked on the real graph at 1456px. The cached gap also displays correctly. 1280px and hover cards are not checked |
| Graph tools | **Working** | Six tools in `backend/trace/tools/graph_tools.py` |
| Agent loop | **Working** | `backend/trace/agent/loop.py`: `muse-spark-1.3`, Chat Completions, cap of 8 enforced. Live runs take about 20 to 25 seconds |
| Grounding validator | **Working** | `backend/trace/validator/grounding.py`. Rules are in `docs/prds/02-agent-validator.md`. Must never be cut |
| Code panel | **Working** | Reads `GET /api/source`. Shows the pinned clone when `TRACE_SOURCE_DIR` points at it |
| Graphify | **Working** | On branch `feat/graphify`. Results of the merge gate are in `docs/prds/06-graphify.md` |
| Learning mode | Deferred | Replaced by Graphify on 2026-11-01. Store fields only; `/api/checks` is unused. Notes are in `docs/prds/04-learning-mode.md` |
| Tap-check generator | Deferred | `checks.json` is hand-written mock data |
| Eval | **Started** | `eval/questions.json` holds 10 draft questions that a human must check. There is no scoring script yet |
| Cached demo answers | **Working** | Two in `data/fastapi-template/answers/`, written by `scripts/cache_answer.py`. The demo question is "How does login work?" |
| Demo-repo choice | **Decided: template** | Trial results below |

The shadcn `dialog`, `popover` and `switch` components are generated but unused.

## Check results (2026-10-31)

| Check | Result |
|---|---|
| `uv run pytest` | 84 passed, up from 58. Two of the new test files run on the pinned clone and skip without it |
| `uv run ruff check .` | Clean |
| `scripts/export_schemas.py --check` | No drift |
| `npm run lint` | 1 warning: `web/src/components/ui/button.tsx:66` (`only-export-components`, shadcn output) |
| `npm run build` | Passes. Warns about the main JS chunk size |
| UI on the real graph | **Checked in Chrome at 1456x829:** map fits the frame, plate names readable, "Show all connections", code panel shows real source with correct line range, no console errors. **Not checked:** 1280px width, hover cards, file view on real data |
| UI on the mock | **Checked in Chrome:** dashed stub, full path animation, gap line, claim tally, no console errors |
| Meta API | **Not checked.** Gate 1 is recorded in `.claude/idea.md`, but no agent code is in this repo |

**Parser on `fastapi/full-stack-fastapi-template` @ `f4bcfaba7c85be3c6332cc74a20819f586dcdbc6`** (root `backend`):

- Validates against the `Graph` contract. v1 failed it with 1,233 errors.
- 19 files, 0 parse failures. Excluded: `backend/app/alembic` (6 files), `backend/tests` (15 files). `verify.py files` accounts for all 40.
- Nodes: 19 modules, 22 classes, 48 functions, 4 dependencies, 23 routes, 82 external, 0 unresolved (198 total).
- Edges: 313 calls (59 internal, 254 external), 41 imports, 6 inherits, 41 injects, 23 routes_to, 0 implements, 0 uncertain.
- Call sites unchanged from v1: 59 resolved, 0 uncertain, 254 external.
- External evidence unchanged: 107 proven by jedi, 74 by non-repo import, 73 by name not defined in the repo.
- Rates: 59/59 internal calls resolved; 28.6% strict rate (jedi-only externals).
- All 41 injections land: 40 on repo nodes, 1 on an external node. 0 dangling edges.
- `reusable_oauth2` is a dependency node, so the current-user chain no longer breaks at `TokenDep`.
- The login flow traces from the route through `crud.authenticate` and `verify_password` to `session.exec` and `jwt.encode`.
- **No uncertain edges at all on this repo,** so on the template a gap can only come from the model claiming a link that
  isn't there. The demo's "flagged gap" has to be planned with that in mind.
- `sqlmodel`, `pyjwt` and `pwdlib` are not installed in Trace's venv, so jedi can't see them. That is why the strict rate is
  low and `session.exec` sits under `<unknown>`. Installing the target's libraries into a separate environment and passing it
  to `jedi.Project` should raise both. Not tried.

The precision samples in earlier reports were self-judged by the AI that wrote the parser, and no human has checked
them. Eval ground truth must be hand-labelled separately.

## Demo-repo trial

**Decision: keep `fastapi/full-stack-fastapi-template`.** The rule in `.claude/idea-demo-eval.md` is to rank candidates and
ship the template if none beats it, and none does. All numbers are from parser v2 runs on 2026-10-31.

| Repo @ commit | Licence | Functions | Routes | Internal calls resolved | Flow depth (median / max) | Whole-map fit zoom |
|---|---|---|---|---|---|---|
| `fastapi/full-stack-fastapi-template` @ `f4bcfab` | MIT | 48 (+4 deps) | 23 | 59/59 | 4 / 5 | 0.34 |
| `mizhexiaoxiao/vue-fastapi-admin` @ `79d1bbb` | MIT | 114 | 35 | 163/182 (89.6%) | 4 / 5 | 0.20 |
| `Netflix/dispatch` @ `dd2837e` | Apache-2.0 | 2,435 | 291 | 3,468/5,241 (66.2%) | 5 / 12 | 0.05 |
| `polarsource/polar` @ `9b67985` (`server/`) | Apache-2.0 | 7,113 | 626 | 15,885/21,678 (73.3%) | 8 / 21 | 0.02 |

- Fit zoom assumes 1456x829. The camera's minimum is 0.2 and plate names need about 0.3, so dispatch and polar can't be
  shown whole. Neither has a map a viewer could read without a way to scope the graph, and no scoping feature exists.
- vue-fastapi-admin is about twice the size, with the same flow depth and a worse resolution rate. Its one advantage is 19
  real uncertain edges, which the template lacks.
- No candidate lands in the 300 to 1,500 function range. Scoping polar to one area such as `polar.checkout` might, and
  depth 8 to 21 is what would answer "why an agent if it fits in context". That needs a scoping feature and a new layout
  check, and there is no time for it before the freeze.
- **The template's weakness stands:** prepare the context-window answer for judges, and plan the demo's gap moment knowing
  it has no uncertain edges.
- Robustness: 0 parse failures and 0 dangling edges on all four (1,216 files in polar, 2 minutes). jedi raised on 44 call
  sites in dispatch, which were recorded as uncertain.

## Design questions

Questions 2, 3, 5 and 6 were settled by parser v2 as recommended; `NOTES.md` has the detail. Questions 1, 4 and 7 were
settled on 2026-11-01 as recommended and are recorded in `docs/prds/02-agent-validator.md`.

1. **Where does source text come from at runtime?** Partly settled: `GET /api/source` and `TRACE_SOURCE_DIR` exist,
   and the code panel shows "Source unavailable" on a 404. For the real repo, point the setting at the pinned clone.
   The agent's read-source tool and the validator's quote check still need to use the same root.
2. **Settled: the target of an uncertain edge** is an `unresolved` node.
3. **Settled: unresolved injections** become `dependency` or `external` nodes, and anything else an `uncertain` edge.
4. **What does `gap` mean?** `Claim.status` says "the parser could not resolve this link", while
   `.claude/idea-architecture.md` says consecutive path nodes with no real edge. Recommendation: a gap is no edge
   between consecutive steps, or a connecting edge with `resolved: false` (this now also covers `implements` edges with
   several implementations). The validator can compute this. Update the description in `events.py`, then run `make schemas`.
5. **Settled: external stubs** are one node per distinct callee and one edge per call site.
6. **Settled: report data** lives in `report.json` next to `graph.json`.
7. **How much should the validator trust an edge to an external node?** The call site is real, but under `<unknown>` the
   stub's identity rests on a rule. Recommendation: a path may end at one, and the claim about what the library does stays
   `unverified` unless a quote backs it.

## Stale facts in older docs

| Where | Says | Actually |
|---|---|---|
| `.claude/idea.md:85` | 11 tests pass | 84 pass |
| `.claude/idea.md:85` | Report in `out/report.md` | The report is now `out/report.json`, written by the parser |
| `.claude/idea.md:90` | Skeleton, contracts and web scaffold in progress | Done and committed |
| `.claude/idea-architecture.md:40-42` | Jedi proved 24 externals, 20.4% strict, libraries not installed | 107 proven, 28.6% strict, only Trace's own dependencies installed |
| `.claude/idea-architecture.md:45-47` | One file parsed through an in-memory rewrite | Rewrite removed; runs natively on 3.14 |
| `.claude/idea-architecture.md:51-59` | Parser v2 work list | Items 1 to 4 are done (item 1 partly: see the note on installed libraries); item 5 is not |
| `.claude/idea-demo-eval.md` | Dispatch and vue-fastapi-admin licences unverified | Confirmed from their `LICENSE` files: Apache-2.0 and MIT |
| `README.md` (main features, how it works) | Describes all features in the present tense | True of the target product, not the current build |

## Next work

In schedule order from `.claude/idea-demo-eval.md`. Feature freeze is Mon Nov 2, and recording and submission are Tue
Nov 3.

1. **Eval:** a human checks the draft questions, then write the scoring script and run it.
2. **Freeze check:** the map's module focus and hover cards at 1280px. Graphify's own checks are done.

The full ordered plan, including what only a human can do, is in `next-steps.md`. Also outstanding: confirm the entry track.
`docs/prds/05-eval-demo.md` is still empty.
