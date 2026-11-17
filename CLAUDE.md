# Trace

Trace turns a Python repo into an interactive graph.
You ask a question, an LLM agent answers by walking that graph, and plain code checks every claim against the graph and the source before the UI shows it.
Claims that fail are flagged, then sent back to the model once to fix.
It was built for the Meta AI Global Hackathon, so every product model call goes to Meta's API (Muse Spark) through the OpenAI SDK.

## Layout

```
backend/trace/
  parser/       ast + jedi -> Graph (no AI). builder.py is most of it, layout.py bakes x/y
  schemas/      pydantic contracts: Graph, Event (union on `type`), ChecksFile. Single source of truth
  tools/        GraphIndex (graph + source files) and the six read-only agent tools
  agent/        loop.py: investigate, answer, validate, repair
  validator/    grounding.py (claim status), repair.py (bounded fix round)
  api/          app.py (routes, SSE), repos.py (GitHub ingest), settings.py
web/src/        React 19 + Vite + Tailwind 4 + Zustand. Cytoscape for the map, DOM/SVG for a file's page
data/mock/      invented "taskboard" app: graph, events.jsonl, checks, line-aligned source
data/fastapi-template/   graph + recorded answers for the demo repo
data/repos/     repos added from the browser (gitignored)
docs/contracts/ generated JSON Schemas (committed)
eval/           questions, saved runs, run_eval.py scorer
scripts/        export_schemas, cache_answer, repair_recording, verify (parser reviewer)
third_party/    gitignored pinned clone of the demo repo (see README Attribution)
```

`.claude/Project_Context/` and `.claude/idea*.md` are snapshots from 2026-10-31 and the original pitch.
They are stale in places (they say the agent is not built).
Trust the code, `README.md` and `NOTES.md` (decision log) over them.

## Terminology

- **Node types:** module, class, function, route, dependency, external, unresolved. **Edge types:** calls, imports, inherits, routes_to, injects, implements, uncertain.
- **Node id:** `module.path:qualname`, or just `module.path` for a module. `external` and `unresolved` nodes have no source in the repo.
- **Call buckets:** every call site is resolved (jedi found one repo node), uncertain (ambiguous, reason in `note`), or external (proven by jedi or classified by rule). Quote the rate as "59/59 internal calls resolved, externals by rule", never a bare 100%.
- **Claim status:** `verified` (edge exists, or the quote is in the node's own lines), `unverified`, or `gap` (no firm edge between two steps). Verified means the evidence exists, not that the model's sentence is right.
- **Path / step:** the agent's answer, an ordered list of `PathStep` (node id, explanation, claims).
- **Repair:** one extra model call that returns a patch (a quote for a flagged claim, a bridge node for a gap). It cannot delete or reword anything.
- **Recorded answer:** a saved run in `data/<repo>/answers/<question-slug>.jsonl` that `/api/ask` replays instead of calling the model.
- **Plates and belts:** the map draws each module as a plate and each call as a belt (`scene.ts`, `belt.ts`, `sky.ts`).
- **Graphify / dive:** a file's page (`#/app/file/<path>`). The file is cut into blocks of real code with arrows from each calling line. No model is involved. `fileblocks.ts` does the layout and `useDive.ts` the map-to-file transition.
- **Import root:** the folder imports start from. Detected for added repos by `detect_root`, never a package or a tests/docs folder.
- **Builtin repo:** the one the server starts with (`TRACE_DATA_DIR`). It cannot be deleted from the UI.

## How the key parts work

**Agent (`agent/loop.py`).**
`_investigate` runs a tool-calling loop capped at `MAX_TOOL_CALLS = 8`.
`_answer` makes one structured-output call whose schema (`DraftPath`) has no status field, so the model cannot mark its own claims.
The validator then builds the `PathStep`s.
The first claim of each step is written by code from the graph, and model claims are checked by quote.
`final_path` is emitted before repair runs, so a repair failure never loses the first answer.
A question asked on a file's page passes `file` and `node`, and `scoped_question` tells the agent to start there.

**Validator (`validator/grounding.py`).**
Never cut it or let anything but this module set a status.
A quote must be at least 12 chars and appear, whitespace-flattened, in the node's own lines.
A claim on an external step stays `unverified`.
Repair quotes may be up to 200 chars and may point at the previous step's source.

**`/api/ask` dispatch (`api/app.py::event_stream`).**
Mock `events.jsonl` replays for any question.
Otherwise a recorded answer replays, but only for whole-repo questions with no `file` or `node`.
Otherwise it runs live, or emits an `error` event if `META_API_KEY` is empty.
Every endpoint takes an optional `repo` id.

**Adding a repo (`api/repos.py`).**
`POST /api/repos` starts a background job: shallow clone, `detect_root`, parse, written to `data/repos/<id>/{graph,report,meta}.json` plus `source/`.
Public GitHub URLs only, max 1,500 Python files, one job at a time.
The folder is built under `.<id>.partial` and renamed into place.

**Frontend.**
Hash routes (`#/`, `#/repos`, `#/app`, `#/app/file/...`) because FastAPI's static mount has no SPA fallback.
`lib/run.ts` and `lib/trace.ts` derive everything shown from the event list plus a playback cursor, and playback deliberately lags the stream (auto or manual step-through).
Types in `web/src/types/contracts/` are generated from the schemas.
`index.css` tokens are the only source of colour (`css.ts` reads them for canvas code).

## Run it

Needs `uv`, Node 24, `make`, and `git` for adding repos. Python 3.14 is fetched by uv.

```sh
make setup            # uv sync, npm install
cp .env.example .env  # META_API_KEY, META_BASE_URL, META_MODEL (only live questions need them)
make dev-api          # :8000 on data/mock
make dev-api-real     # :8000 on the demo repo; needs third_party/fastapi-template (README Attribution)
make dev-web          # :5173, proxies /api to :8000
make build-web        # web/dist, which the API then serves at /
```

Repos added from the Repositories page work with either API target.

## Test it

- `make test` (pytest), `make test-web` (node --test on `web/scripts/*.check.ts`), `make lint` (ruff, oxlint), `cd web && npm run build` (tsc + vite).
  oxlint has one known warning in `components/ui/button.tsx` (shadcn output).
- `test_target_graph.py` and `test_determinism.py` use the `third_party` clone and skip without it.
- `tests/fixtures/fixpkg` is the parser's exact-output fixture. `test_mock_fixtures.py` pins `data/mock` line numbers and quotes to its source.
- **End to end:** `make build-web && make dev-api-real`, open http://localhost:8000 in a browser.
  Recorded questions ("How does a user log in?") replay with no key.
  Click a node, open its code, use the dive into a file, and ask a question from a file's page.
  A live question needs a real `META_API_KEY` and takes 20 to 60 seconds.
  Adding a repo needs network and takes seconds to a minute.
- `make eval` only re-scores saved runs and calls no model.
  `python -m eval.run_eval --round N` makes live calls and costs money, so ask first (limits are in `run_eval.py`).
- To record a demo answer use `scripts/cache_answer.py "question"`.
  It refuses to overwrite, because answers vary run to run and the demo depends on the saved one.

## Conventions

- Import as `backend.trace...`. A top-level `trace` package would collide with the stdlib.
- Changing a contract: edit `backend/trace/schemas/`, run `make schemas`, update `data/mock/`, then `npm run gen:types` (runs on dev and build).
  Commit the generated files. A test fails if `docs/contracts/` drifts. Contracts use `extra="forbid"`.
- Do not hand-edit `docs/contracts/`, `web/src/types/contracts/`, or `web/src/components/ui/` (shadcn output).
- `layout.py` mirrors the plate padding in `web/src/lib/scene.ts`. Change both together.
- Web lib files that `make test-web` imports directly under node (`filegraph`, `fileblocks`, `route`, `run`, `trace`, `examples`, `belt`) may only use `import type` from `@/`. Use relative paths for value imports.
- Cytoscape forces `position: relative` on its container, so keep it inside an absolutely positioned wrapper.
- `localStorage` access is always wrapped in try/catch with a default (see `store.ts`).
- Ruff line length is 120. Comments explain why, not what.
- `third_party/`, `out/`, `data/repos/` and `.env` stay out of git.
  Never commit a graph derived from a repo without a licence.
- Commit messages are short imperative sentences. Do not squash history, because timestamps are evidence for the hackathon's new-work rule.
- Record notable decisions in `NOTES.md`.
- The current UI direction is a neutral dark developer tool (IBM Plex Sans, JetBrains Mono, serif only on the landing wordmark), on branch `ui-redesign`.
