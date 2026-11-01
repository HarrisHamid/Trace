# Agent and validator

> Status: approved design decisions 2026-11-01. Product background is in `.claude/idea-architecture.md`.

## Goal

Answer a question about the demo repo by walking the real graph with Meta's `muse-spark-1.3`, then check the answer in
plain code before the user sees it. The walk is the product. The validator is what makes it trustworthy.

**Never cut the loop or the validator.** No other model provider, no framework, no database, no RAG.

## Flow

```
question -> investigate (tools, at most 8 calls) -> one structured-output call -> validator -> final_path
```

Tools and structured output never share a request. A live test on 2026-11-01 confirmed that both work on Chat Completions
when run as two separate steps.

## Tools

All tools read one in-memory graph. Arguments are validated with pydantic. Bad arguments or an unknown node return an
error to the model and still count towards the cap.

| Tool | Purpose |
|---|---|
| `search_nodes` | Find nodes by name, id or docstring |
| `find_routes` | List HTTP routes and their handlers |
| `get_node` | Signature, docstring, file, lines and edge counts |
| `get_neighbors` | Callers, callees, or both, with edge type and line |
| `follow_injections` | Walk the `Depends(...)` chain from a node |
| `read_source` | The node's source from the original file, at most 120 lines |

## Loop

- The cap of 8 tool calls is enforced by our code, per call and not per model turn. Calls past the cap are answered "not
  run", because every tool call needs a reply before the next request.
- Each call streams `tool_call`, `tool_result` and, the first time a node is reached, `node_visited`.
- The model's output has no `status` field, so the model cannot mark its own claims. Only the validator sets status.
- The OpenAI SDK retries 429s and server errors with backoff, so `tenacity` is not needed.
- A failed run streams `error` then `done`. The page never shows a half-checked answer.

## Validator rules

The validator is a pure function of the model's draft, the graph and the source files.

| Check | Result |
|---|---|
| Step names a node that is not in the graph | Step dropped. The link is then checked between the steps either side |
| Same node twice in a row | Repeat dropped |
| A resolved edge joins this step and the previous one, in either direction | Verified link claim, written by the validator from the edge |
| An edge exists but `resolved` is false, or it is an `uncertain` edge | `gap` claim |
| No edge joins them | `gap` claim |
| First step | Verified claim stating where the node is defined, so no step has an empty claim list |
| Model claim whose quote appears in the node's own lines | `verified` |
| Model claim with no quote, a quote under 12 characters, or a quote not found | `unverified`, and a failed quote is removed so it is never displayed |

Whitespace is collapsed before quotes are compared. Quotes are checked against the original files.

**Source location.** The tools, the validator and the Code panel all read `TRACE_SOURCE_DIR`, so a quote that passes is
the same text the user can open.

**External and unresolved nodes.** A path may end at one, but neither has source in the repo. A quote on such a step is
checked against the previous step's source, which is the call site. With no such quote, the claim stays `unverified`.

## What "verified" means

Verified means the edge exists, or the quoted text exists in the cited node. It does not mean the sentence the model wrote
about that text is true, and the UI and the pitch must not imply otherwise. The hand-labelled eval in `05-eval-demo.md` is
what measures whether answers are correct.

## Serving

`POST /api/ask` picks the first of these that applies:

1. The data folder has `events.jsonl`: replay it. This keeps mock mode and its tests free of model calls.
2. `answers/<slug>.jsonl` exists for this question: replay it. This is how the demo avoids live latency.
3. Otherwise, run the real loop.

`scripts/cache_answer.py` runs the loop once and writes the cache file.

## Done when

- A question on the real graph streams real tool calls and a validated path into the unchanged UI.
- Every status on screen was set by the validator.
- Tests cover every row of the rules table without calling the model.
