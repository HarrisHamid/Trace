# Trace — Idea Overview (start here)

> Entry point for any agent or collaborator working on Trace. Read this file first, then the three linked docs.
> Anything marked **(unverified)** has not been confirmed from an official source. Do not treat it as fact.

## One-liner

Trace is a web app that visualizes a Python codebase as a constellation-style map and lets you ask questions
about it. An AI agent answers by **walking the real call graph node by node**, and every claim it makes is
**checked by plain code against that graph and the actual source**. Claims that fail the check are flagged
"unverified" instead of being presented as fact. An optional **learning mode** (fog of war) turns the same
map into a way to build understanding of an unfamiliar codebase.

## The problem

- Understanding an unfamiliar backend codebase is slow. Questions like "what happens when a user logs in?"
  or "where does this request end up?" require reading many files and following calls by hand.
- AI answers about code are fluent but often unverifiable. People cannot tell which parts are grounded in the
  code and which are guesses.
- Trace's angle: the structure (the call graph) is built **without AI** by static analysis. The AI is only
  allowed to navigate that structure, and its output is validated against it.

## Who it is for

Engineers onboarding to a backend codebase, reviewers, and students reading real-world FastAPI projects.
Hackathon problem statement: **Build for Your World** ("solve a problem you know firsthand, free up time and
mental space, make something possible that wasn't before").

## What Trace is NOT (important for positioning)

- Not a generic "chat with your codebase" / basic RAG app. The hackathon explicitly lists "Basic RAG
  Applications" as a sample anti-project. Always lead with: graph-walking, per-claim verification, flagged
  unverified claims. Never pitch it as a chatbot.
- Not a multi-language tool, not a PR-review tool, not a security scanner (all cut).
- Only the Q&A loop is truly agentic. Do not oversell the rest as "AI".

## Hackathon context that constrains every decision

Event: **Meta Global AI Developer Hackathon** (Meta + Cerebral Valley). Solo entry. Building period
Oct 27 – Nov 4, 2026. Prize tracks are Indie Developer and Startups; Trace is presumably Indie **(confirm on
the submission page)**.

Official rules (from the participant guide):
- **Repository must be public.**
- **New work only.** What is presented must have been built during the event. The demo must show only features,
  code and functionality built during the hackathon. Failing to make original contributions clearly
  identifiable can mean disqualification at the judges' sole discretion. Third-party code or data used must be
  something we have rights to.
- **Submission:** via the Cerebral Valley platform by **Wed Nov 4, 9:00 PM ET**. Late submissions are not
  considered. A **3-minute demo video** is required and is a primary judging artifact.
- **Must use Meta models** (Muse Spark series, Muse Wonder, Muse Image, Muse Voice Transcribe, SAM 3.1 via
  Meta Model API, or open-weight Muse Glimmer / Muse Spark Open). Stage 1 is pass/fail on this.
- Solo participation is allowed. $150 Meta API credits are claimable by Nov 4 9 PM ET (card required).
- Not stated in the guide: any ban on third-party AI coding agents. Not confirmed in writing by organizers
  **(unverified; ask in Discord #questions)**. The repo keeps a NOTES.md log of AI-written code regardless.

Judging: Stage 1 pass/fail; Stage 2 rubric 0–10: **Impact 30%, Use of Meta AI tooling 25%, Technical Depth &
Execution 20%, Demo 25%**; Stage 3: top 5 per track are judged again live on demo videos.

## Document index

| File | Contents |
|---|---|
| `idea.md` | This overview, rules, working agreements |
| `idea-product.md` | Features, views, learning mode, UX priorities, explicit cuts |
| `idea-architecture.md` | Pipeline, graph schema, agent loop, validator, Meta API facts, tech stack, contracts |
| `idea-demo-eval.md` | Demo repo choice, eval plan, 3-min video outline, prizes, schedule, risks, open questions |

## Working agreements for agents (follow these)

1. **Be a strict reviewer, not a yes-man.** Check work against the judging rubric. Flag risks and propose cuts.
   Concise, bullet-heavy answers. Flag anything unverified instead of guessing.
2. **Never silently drop unresolved calls** in the parser. Mark them `uncertain` and report them.
3. **Never present a model claim as verified** unless the validator confirmed it in plain code.
4. **Every model call in the product must go to Meta models.** Base URL and model ID live in config/env.
5. **Public repo hygiene:** no secrets, no `.env`, no API keys in history, never commit cloned third-party
   code (commit only the pinned commit SHA, derived `graph.json`, and an attribution note). Do not squash
   history; real commit timestamps are evidence for the "built during the event" rule.
6. **Log AI-written code** in NOTES.md.
7. **Do not build cut features** (see `idea-product.md`). Never cut the agent loop or the grounding validator.
8. **Report real results.** Run tests and builds and report actual output. State what could not be verified.

## Current status snapshot (as of Fri Oct 30 evening)

- Parser v1 built on the pinned demo repo; 11 tests pass; report in `out/report.md`. Known gaps and the v2
  work list are in `idea-architecture.md`.
- Meta API "Gate 1" passed: a multi-step tool-calling loop (4 calls, correct answer) and 10/10 valid
  structured outputs, but on a **tiny fake graph** and with tools and JSON tested **separately**. Tools plus
  structured output on the real graph is **not yet tested**.
- Repo skeleton, the three data contracts, mock fixtures, FastAPI skeleton and web scaffold: in progress.
- Official deadline: Wed Nov 4, 9:00 PM ET. Plan: feature freeze Mon Nov 2, record and submit Tue Nov 3,
  Nov 4 is buffer only.
