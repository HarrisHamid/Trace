# Trace — Project Context (start here)

> The repo **as it actually is** on 2026-10-31, on branch `feat/parser-v2`. The `.claude/idea*.md` files
> describe what Trace is meant to become. If they disagree about the current state, this folder wins. If they
> disagree about the goal, the idea docs win. Paths are relative to the repo root.

## What Trace is

A web app that turns a Python codebase into a map of modules (plates) and the calls between them (belts). You ask a question, an AI agent answers by
walking the real call graph node by node, and plain code checks every claim against the graph and the source.
Claims that fail are flagged instead of shown as fact. Graphify takes one file apart into blocks of its real code, with
arrows from each calling line.

It is a solo entry in the Meta Global AI Developer Hackathon. Submission closes **Wed Nov 4, 9:00 PM ET**, and every
product model call must go to Meta models. Rules, judging and positioning are in `.claude/idea.md`.

## Where it stands

**The core product and Graphify work end to end on the real graph. The eval is not finished, and learning mode is deferred.**

- **Works on real data:** the parser, the graph API and the map. Parser v2 emits the `Graph` contract with a baked layout,
  and the UI renders the demo repo from it, with real source in the code panel.
- **Works on the real graph:** answers, with `make dev-api-real`. `POST /api/ask` runs the agent and validator live, or replays a cached answer. Mock mode still replays `data/mock/events.jsonl`.
- **UI built on mocks:** factory-style map (plates, label cards, belts), path animation with a parcel, file view, command
  palette, observation log and code panel. Spec in `docs/prds/03-ui.md`; the redesign is logged in `NOTES.md`.
- **Works on the real graph:** Graphify, on branch `feat/graphify`. Spec and results are in `docs/prds/06-graphify.md`.
- **Deferred:** learning mode and the tap-check generator. Notes are kept in `docs/prds/04-learning-mode.md`.
- **Not finished:** eval. The questions are drafted and there is no scoring script.
- **Biggest risk now:** time. Feature freeze is Mon Nov 2, and the eval questions still need a human.
- **Demo repo decided:** `fastapi/full-stack-fastapi-template`, after a trial of three larger repos.

Check details, the gap table and open design questions are in `status.md`.

## Document map

| File | Use it for |
|---|---|
| `.claude/Project_Context/README.md` | This overview |
| `.claude/Project_Context/architecture.md` | How the code is built today: components, data flow, contracts, API, repo map |
| `.claude/Project_Context/status.md` | Built vs mock vs missing, check results, demo-repo trial, open questions, stale docs |
| `.claude/Project_Context/next-steps.md` | The ordered plan to submission, with who does each step |
| `.claude/idea.md` | Pitch, hackathon rules, working agreements |
| `.claude/idea-product.md` | Target features, UX priorities, explicit cuts |
| `.claude/idea-architecture.md` | Target design: agent loop, validator, Meta API facts, tech stack decisions |
| `.claude/idea-demo-eval.md` | Demo repo, eval plan, video outline, prizes, schedule, risks |
| `NOTES.md` | Disclosure of AI-written code and the decision log |
| `README.md` | Public-facing README. Its feature list describes the target product, not the current build |

`docs/prds/03-ui.md` is the UI spec and `02-agent-validator.md` the agent spec. `04` and `05` are still `TODO` stubs.

## Run it

Needs `uv`, Node 24 and `make`. Python 3.14 is fetched by `uv`.

```sh
make setup       # uv sync, npm install
make dev-api     # FastAPI on :8000, serves data/mock/
make dev-web     # Vite on :5173, proxies /api to :8000
make test        # pytest
make lint        # ruff, oxlint
make build-web   # builds web/dist, which the API serves at /
make schemas     # re-export docs/contracts after changing a contract
```

The parser has no `make` target. To run it on the demo repo (clone steps are in the root `README.md`):

```sh
uv run python -m backend.trace.parser build \
  --repo third_party/fastapi-template --root backend --out out/graph.json
uv run python scripts/verify.py flow --graph out/graph.json \
  --repo third_party/fastapi-template --route "POST /api/v1/login/access-token"
```

To see the real graph on the map, serve it instead of the mocks. `graph.json` is the only file the map needs, but the
API's other routes read `checks.json` and `events.jsonl` from the same folder, and those are still mock-only:

```sh
TRACE_DATA_DIR=out TRACE_SOURCE_DIR=third_party/fastapi-template \
  uv run uvicorn backend.trace.api:create_app --factory --port 8000
```

## Things that will trip you up

- **Import path:** use `backend.trace`, never a top-level `trace`, which collides with the stdlib module.
- **`layout.py` mirrors the plate padding in `web/src/lib/scene.ts`.** Change them together, or plates will overlap
  without any test noticing on the UI side.
- **Don't treat an `external` edge as a proven library fact.** Its `note` gives the evidence. `name_not_defined_in_repo`
  stubs sit under `<unknown>` because nothing says which library they belong to.
- **Cytoscape forces `position: relative` on its container.** Put it inside an absolutely positioned wrapper, or the
  container collapses to zero height and nothing draws.
- **Mock source must match `graph.json` line numbers.** `tests/test_mock_fixtures.py` checks it. If you edit
  `data/mock/source/`, check the line ranges and the quotes in `events.jsonl` still match.
- **Contracts reject unknown fields** (`extra="forbid"`), so a stray key fails validation rather than being dropped.
- **Contract changes have a fixed order:** edit `backend/trace/schemas/`, run `make schemas`, update `data/mock/`, and
  let `npm run gen:types` regenerate web types (it runs on `npm run dev` and `npm run build`). Commit the generated
  files too. A test fails if `docs/contracts/` drifts from the models.
- **`out/` and `third_party/` are gitignored and must stay out of git.** This repo is public, and graphs derived from
  the unlicensed `fastapi-realworld-backend` must never be committed.
- **Quote the resolution rate carefully.** Say "59/59 internal calls resolved, externals classified by rule", never a
  bare "100%".
- **Log AI-written work in `NOTES.md`,** and do not squash history. Commit timestamps are evidence for the
  built-during-the-event rule.

The full working agreements are in `.claude/idea.md`.
