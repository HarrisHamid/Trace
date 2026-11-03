# Agent and validator

> Status: approved design decisions 2026-11-01. Product background is in `.claude/idea-architecture.md`.

## Goal

Answer a question about the demo repo by walking the real graph with Meta's `muse-spark-1.3`, then check the answer in
plain code before the user sees it. The walk is the product. The validator is what makes it trustworthy.

**Never cut the loop or the validator.** No other model provider, no framework, no database, no RAG.

## Flow

```
question -> investigate (tools, at most 8 calls) -> one structured-output call -> validator -> final_path
         -> if the model could fix something: one repair call -> validator -> gate -> repair_finished
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
| Model claim on an external or unresolved step | `unverified`, with its quote removed |

Whitespace is collapsed before quotes are compared. Quotes are checked against the original files.

**Source location.** The tools, the validator and the Code panel all read `TRACE_SOURCE_DIR`, so a quote that passes is
the same text the user can open.

**External and unresolved nodes.** A path may end at one, but neither has source in the repo. The link claim records the
call. A model claim on such a step stays `unverified` whatever it quotes, because the line that calls a library proves
the call and says nothing of what the library does.

## What "verified" means

Verified means the edge exists, or the quoted text exists in the cited node. It does not mean the sentence the model wrote
about that text is true, and the UI and the pitch must not imply otherwise. The hand-labelled eval in `05-eval-demo.md` is
what measures whether answers are correct.

## Repair

When the validator flags something the model could fix, the failures go back to the model for one round, and the same
validator checks the result. The model catches its mistake only because plain code showed it where.

```
final_path -> repair_started { issues, left_alone } -> repair_finished { outcome, steps } -> done
```

`final_path` is sent first and keeps its name, so a repair that fails can never lose the answer. With nothing to fix, the
stream is the same as it was before repair existed. Old cached answers hold none of these events and replay unchanged.

**What is sent back.** Only what could be fixed:

| Flagged | Sent back? |
|---|---|
| Unverified claim on a repo step | Yes, with why it failed, plus the source of its step and the step before |
| Gap with a bridge: a repo node with a firm edge to both ends, by call, route or injection | Yes, with the bridges to pick from. A node already on the path is offered alone |
| Claim on an external or unresolved step | No. It can never verify, so it counts as `left_alone` and the UI says so |
| Gap with no bridge | No, for the same reason |

**The call.** One extra structured-output call on the same conversation, with no tools, so `MAX_TOOL_CALLS` stays 8. It has
one try and a limit of 45 seconds. Nothing sent back gets a second round.

**The model returns a patch, not a new path.** This is what keeps the numbers honest. A patch can only:

- add a quote to a flagged claim, at its own step or the step before, where the call site usually is
- add one node from the offered bridges to a flagged gap, with an explanation and no claims

It cannot delete a step, delete a claim or change a sentence. A bridge carries no model claims, so the share of model
claims verified keeps the same denominator. A quote over 200 characters is ignored, because a pasted function would prove
nearly any sentence about it. A fix whose quote fails the check changes nothing, and that also stops a claim on an external
step being moved onto its caller to get around the rule above. Repair has no `status` field, and the patched draft goes
back through `validate_path`, so the validator is still the only thing that sets status.

**When a repair is accepted.** `is_better` in `backend/trace/validator/repair.py` is plain code. Every sentence and every
node must still be there, gaps must not rise, verified must not fall, and at least one of those must really improve.

| `outcome` | Meaning | `steps` |
|---|---|---|
| `accepted` | The repaired path replaces the first one | The repaired path |
| `no_improvement` | The model fixed nothing that passed, so the first answer stands | Empty |
| `failed` | The call failed, timed out or broke the schema, so the first answer stands. This is not an `error` | Empty |

**What repair cannot do.** It only sees what the validator flags. A node the model left out entirely, with a clean path
around it, is not flagged, so repair will not find it and recall should not be expected to rise. A real quote that does not
prove its sentence still passes, as it always has, so the eval lists every claim repair turned verified for a person to read.

**On screen.** The first path stays up with what was sent back listed in the log. An accepted repair redraws from the first
step it changed, new steps are marked as added and fixed claims as fixed, and the first draft's tally stays beside the
final one for good. `phase` stays `revealing` throughout.

## Serving

`POST /api/ask` picks the first of these that applies:

1. The data folder has `events.jsonl`: replay it. This keeps mock mode and its tests free of model calls.
2. `answers/<slug>.jsonl` exists for this question: replay it. This is how the demo avoids live latency.
3. Otherwise, run the real loop.

`scripts/cache_answer.py` runs the loop once and writes the cache file. It refuses to replace a file that exists, because
answers vary between runs and the demo depends on the saved one.

## Done when

- A question on the real graph streams real tool calls and a validated path into the unchanged UI.
- Every status on screen was set by the validator.
- Tests cover every row of the rules table without calling the model.
- A failed repair never loses the first answer, and tests cover each way a repair could raise a score without earning it.
