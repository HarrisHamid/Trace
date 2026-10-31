# Trace — Architecture and Stack

> Part of the Trace idea set. See `idea.md` first. **(unverified)** = not confirmed from an official source.

## Pipeline

```
Repo (pinned commit)
  -> parser (ast + jedi, NO AI)
  -> graph (networkx -> graph.json with baked node positions)
  -> graph tools (functions the agent can call)
  -> agent (Meta Muse Spark, own loop)
  -> grounding validator (plain code)
  -> FastAPI streaming (SSE)
  -> React UI
```

Tap-check questions are generated offline by the model, with decoys chosen from the graph, and validated
in code.

## 1. Parser and graph

- Python standard `ast` for structure, `jedi` for name resolution, `networkx` to build the graph, `pydantic`
  models as the shared schema definition (backend, tests, and generated frontend types all use it).
- **Node id format:** `module.path:qualname`.
- **Node types:** module, class, function, route, dependency, external, unresolved (the far end of an uncertain edge).
- **Edge types:** calls, imports, inherits, routes_to, injects, implements, uncertain.
- **Never silently drop unresolved calls.** Mark them `uncertain`.
- **Call-resolution rate** = resolved / (resolved + uncertain). External calls are reported separately and
  are not counted in that rate.
- Highest-value technical-depth item: capturing FastAPI `@router` route edges and `Depends(...)` injection
  edges.
- Layout is run once in dev; each node's x/y is saved into graph.json; runtime uses the fixed positions.

### Parser v1 results (pinned demo repo, `fastapi/full-stack-fastapi-template`)

- 19 modules, 22 classes, 51 functions, 23 routes. Edges: 59 calls, 41 imports, 6 inherits, 39 injects,
  23 routes_to, 0 uncertain.
- 59 of 59 internal call sites resolve (rate 100%). **Do not quote "100%" bare.** Say "59/59 internal calls
  resolved, externals classified by rule". Of 254 external calls, jedi itself proved only 24; 230 were
  labelled external by rules (non-repo import, or attribute defined nowhere in the repo). Jedi-proven-only
  rate: 20.4%. (Third-party libraries were not installed during that run.)
- Precision samples (20 each) were **self-judged by the agent that wrote the parser**, not by an independent
  human. Label them that way. Hand-label the eval ground truth separately.
- Template requires Python >= 3.14; one file used 3.14-only syntax and was parsed via an in-memory rewrite
  (cloned repo untouched). **The validator must check quoted code against the ORIGINAL file, not the
  rewritten text.** Preferred fix: run on Python 3.14 via uv and drop the hack.
- A second repo (`fastapi-realworld-backend`) has **no license**: parse locally only, never in the public
  repo, demo, or video.

### Known gaps and parser v2 work list (in priority order)

1. Re-run on Python 3.14 with the target repo's libraries installed; re-report the jedi-proven external rate.
2. **`implements` edges** from interface/abstract methods to implementations (18.7% of resolved calls in the
   second repo dead-ended at abstract methods). Mark `uncertain` when multiple implementations exist.
3. **Dependency nodes**: injected dependencies such as `reusable_oauth2` are module variables, so the
   current-user chain currently breaks at TokenDep.
4. **External stub nodes** (e.g. `session.exec`) as terminal nodes so flows visibly reach the DB step.
5. Functions passed as values (`default_factory=`, callbacks). Lower priority.

## 2. Agent loop

- **FastAPI + `AsyncOpenAI`** pointed at Meta (OpenAI-SDK compatible). Responses API recommended.
- **Own loop, hard cap of 8 tool calls, enforced in our code** (Meta's `max_tool_calls` limits built-in tools
  only).
- **Two model steps, not one:** (a) investigate with graph tools; (b) ONE final structured-output call to
  produce the JSON path. Tools and structured output are not combined in one request.
- Validate tool arguments with pydantic myself; `tool_choice` supports only `"auto"`.
- Stream each step to the browser over SSE (`sse-starlette`). Retry 429s with `tenacity`. Cache demo answers
  as JSON files so the live demo does not depend on latency.
- Base URL and model ID are config (see Meta facts), so swapping models is a one-line change.

### Graph tools the agent can call (design target)

Search/lookup a node by name, get a node's details and source location, get callers/callees/neighbors, find
routes, follow an injection chain, read a source snippet. Keep the tool set small; every tool is validated.

## 3. Grounding validator (plain code, no AI)

Checks on the agent's final path:
- Every cited node exists in the graph.
- Consecutive path nodes are joined by a real edge, or the step is explicitly marked as a **gap**.
- Quoted code actually appears in the cited source (against the original file).
- Failures are dropped or flagged `unverified`.

**Never cut the agent loop or the grounding validator.**

## 4. Meta API facts (verified from Meta docs earlier)

- Base URL `https://api.meta.ai/v1`. Models: `muse-spark-1.3` (use this), `muse-wonder-1.0` (preview, pricier,
  optional). Chat Completions and Anthropic-style Messages are also supported.
- Structured output: schema-constrained decoding (`response_format` in Chat Completions, `text.format` in
  Responses). No recursive schemas; nesting depth limit 10.
- Pricing for `muse-spark-1.3`: $1.25 per 1M input tokens, $4.25 per 1M output tokens; 3,000 requests/min.
- **Contributor mode** is cheaper but lets Meta train on prompts and code. Use only on public repos, never
  private or employer code.
- Context window is 1M tokens. Judges may ask "why an agent if a small repo fits in one prompt?" Answer: real
  repos exceed it; the validator makes output trustworthy; the step-by-step path is the product; cost and
  latency stay low.
- **Open weights:** Muse Spark Open is an 816B MoE (will not run on a 24GB M4 Pro; hosted inference only).
  Muse Glimmer is 30B dense, Apache 2.0, runnable via llama.cpp/Ollama/LM Studio, probably only ~4-bit on
  24GB (estimate, **unverified**). The Open Weight prize allows partner-provided inference (Baseten, Modal,
  Fireworks credits are offered by the organizers). For the hackathon use the Baseten model ID
  `meta-models/muse-spark-open-1026`, not the one in their docs.

## 5. Tech stack (decided)

| Part | Stack |
|---|---|
| Parser and graph | Python 3.14, ast, jedi, networkx, pydantic, pytest |
| Backend | FastAPI, AsyncOpenAI (Meta), pydantic, sse-starlette, tenacity; FastAPI also serves the built frontend (one command to run, no CORS) |
| UI | React + Vite + TypeScript (plain SPA), Tailwind, shadcn/ui, Cytoscape.js (for camera and hit-testing; plates, labels and belts are drawn on two canvases around it), Framer Motion, Zustand (persist), Shiki, cmdk, fuse.js, lucide-react, Instrument Serif + JetBrains Mono |
| Learning mode | Same frontend + an offline Python script that pre-generates `checks.json` |
| Eval | Python eval script, JSON ground truth |

React was chosen deliberately (reversing an earlier plain-JS call) because the UI has panels, animation,
shared state, and a toggle. Cytoscape specifics: modules are plates drawn on a canvas, not compound nodes, because their members are
scattered in the layout and compound boxes overlapped. Node labels are cards drawn on a canvas, not Cytoscape labels.
fog/seen/understood are node classes with style transitions; uncertain edges are dashed. The first constellation
version used compound nodes and glow effects; see `NOTES.md`.

## 6. The three contracts (lock first; UI and backend build in parallel against mocks)

Defined as pydantic models in `backend/trace/schemas/`; JSON Schemas exported to `docs/contracts/`; frontend
types are generated from them.

1. **graph.json**: nodes, edges, baked positions, stats.
2. **SSE event types**: run_started, tool_call, tool_result, node_visited, final_path (steps with claims
   marked verified / unverified / gap), error, done.
3. **checks.json**: tap-check questions, options, correct option id, one-line explanation.

Mock fixtures live in `data/mock/` so the UI can be built before the real parser and agent are finished.

## Repo layout

```
backend/trace/{schemas,parser,tools,agent,validator,api}/
scripts/   eval/   data/<repo>/ (graph.json, checks.json, cached answers)   data/mock/
third_party/ (gitignored pinned clones)   web/   docs/prds/   docs/contracts/   tests/
```

Never commit `.env`, secrets, or cloned third-party code.
