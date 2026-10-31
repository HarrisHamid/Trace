# Trace — Demo Repo, Eval, Demo Video, Schedule, Risks

> Part of the Trace idea set. See `idea.md` first. **(unverified)** = not confirmed from an official source.

## Demo repo

**Primary: `fastapi/full-stack-fastapi-template`** — MIT, ~46k stars, pinned to commit
`f4bcfaba7c85be3c6332cc74a20819f586dcdbc6`. Parse only the Python backend (`backend/app`, 19 files; Alembic
migrations and tests excluded). It already satisfies "full-stack FastAPI". Weakness: small (51 functions, 59
call edges), so the constellation can look sparse and the "why an agent if it fits in context" question is
harder.

**Being scouted as larger swap-ins** (pick by function count ~300–1,500, route count, resolution rate, flow
depth; verify each LICENSE file yourself):
- `polarsource/polar`: Apache-2.0 (confirmed on repo page), ~10k stars, very large; FastAPI `server/` plus
  Next.js `clients/`. Would need to be scoped to a few server modules.
- `Netflix/dispatch`: Apache 2.0 (confirmed from its LICENSE file); archived Sep 2025 (stable pin); Python plus Vue.
- `mizhexiaoxiao/vue-fastapi-admin`: MIT (confirmed from its LICENSE file); FastAPI + Vue3, Tortoise ORM; small.

**Trial result (2026-10-31): none beats the template, so the template ships.** Numbers are in
`.claude/Project_Context/status.md`.

**Excluded:** `evroon/bracket` (AGPL-3.0), cookiecutter generators (templated files may not parse), the
unlicensed `fastapi-realworld-backend` (local robustness testing only).

Decision rule: run the parser on candidates, rank by the criteria above. If none beats the template, ship the
template and prepare the context-window answer carefully.

## Eval plan

- 1–2 repos, about 10 questions each, with **hand-labeled ground-truth nodes** (labeled by the human, not the
  agent that built the parser).
- Report: path recall, grounding pass rate, call-resolution rate (with the corrected phrasing), tool calls,
  latency, and **failure cases honestly**.
- `eval/run_eval.py` reads questions with ground-truth node IDs from JSON, runs the agent, prints a markdown
  table.
- Optional 3–5 person learning-mode test: label it **anecdotal**.
- If possible, run the eval on both Muse Spark and Muse Spark Open (served by a partner) by changing config.

## 3-minute demo video (required; Demo is 25% of the score)

Must show only what was built during the hackathon. Clearly label the demo codebase as third-party input
data, not our work.

| Time | Content |
|---|---|
| 0:00–0:20 | The problem and the grounded-agent framing (not "chat with your codebase") |
| 0:20–1:50 | Ask a question; animated path; an unverified claim being flagged; click a node to the exact line |
| 1:50–2:30 | Learning mode: fog of war, tap-check, progress bar |
| 2:30–3:00 | Eval numbers and what was built |

Record with macOS screen recording or OBS; edit in DaVinci Resolve or CapCut. Use cached answers so the
recording does not depend on live latency.

## Prizes and what to target

Rubric: Impact 30%, Use of Meta AI tooling 25%, Technical Depth & Execution 20%, Demo 25%.

| Prize | Value | Fit |
|---|---|---|
| Best Agentic Use-Case | $5K | Strong fit (autonomy, effectiveness, practical usefulness) |
| Best Build on Meta Open Weight Models | $10K | Only if an open-weight model (Muse Glimmer / Muse Spark Open) actually runs the product, on own hardware or partner inference; partner verifies |
| Most Viral Project | $20K | Post a demo on X and submit the link; engagement counts until Nov 8 EOD |
| Community Vote | $10K | Public gallery votes; winner announced Nov 16 |
| Best Creative Build | $5K | Requires Muse Image or Muse Wonder; not targeted |

## Schedule

All times ET. Today is Fri Oct 30 (evening). Time is not the constraint (full weekend available); depth and
scope discipline are.

- **Fri night:** repo scaffold, three contracts, mock fixtures; parser v2 prompt.
- **Sat:** parser v2; agent loop plus validator on the real graph (first test of tools + structured output
  together); UI scaffold against mocks in parallel.
- **Sun:** UI priorities 1–3, learning mode, pre-generated checks.
- **Mon Nov 2:** eval on ~10 hand-labeled questions, then **feature freeze**.
- **Tue Nov 3:** record and **submit** (last full day for submission questions and troubleshooting).
- **Wed Nov 4:** buffer only. Hard deadline 9:00 PM ET; plan to be done long before.
- Nov 5–8 judging; Nov 9 closing ceremony and final-round live judging; Nov 16 community vote winner.

Also do now: claim the $150 Meta credits (form, card required, spend-limit alert on Billing); optionally apply
for the Baseten credits; read the Discord #questions answer on AI coding tools.

## Honest scorecard and risks

Estimated about **6.7/10** weighted if the core ships. Biggest risks:
- Parser quality ceiling (resolution quality, abstract-interface dead ends).
- Agent reliability, especially tools + structured output on the real graph (untested).
- **Clone perception:** a polished graph-based PR-review product already exists.
- UI time sink.
- Thin "Meta tooling" score if the model only summarizes.
- "Basic RAG" anti-project perception.
- New-work-only rule: keep history clean, label third-party code, README "built during the hackathon" section.

**Cut order if behind:** open-weight path, then eval size, then file-view detail, then UI polish.
**Never cut:** the agent loop or the grounding validator.

## Open questions

- Hours available per day this weekend.
- Written confirmation that third-party AI coding agents are allowed.
- Confirm entry track (Indie Developer) on the submission page.
- Skip behavior in fog of war; code in side panel only; node granularity; keep the name Trace.
- Whether to attempt Muse Glimmer locally (probably ~4-bit only on 24GB; unverified).
- Whether using Meta's Muse Code coding agent earns any extra tooling credit (unknown; rubric text says
  "creative use of Meta's AI tooling").
