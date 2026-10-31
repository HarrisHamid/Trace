# Trace — Next Steps

> Written Sat Oct 31, 2026, after parser v2 (PR #3). Work top to bottom. **Who** says who has to do it. Feature freeze is
> Mon Nov 2, the plan is to submit Tue Nov 3, and the hard deadline is **Wed Nov 4, 9:00 PM ET**.

The agent and validator were due today and have not been started, so steps 1 to 4 come before anything else.

## Tonight (Sat Oct 31)

| # | Step | Who |
|---|---|---|
| 1 | **Merge PR #3 with a merge commit, not a squash.** Commit timestamps are evidence for the new-work rule | You |
| 2 | **Get Meta API access working.** Claim the $150 credits (card required) and set a spend alert. Put the key in `.env`, using `.env.example`. This checkout has no `.env`, and nothing can call the model without it | You |
| 3 | **Write `docs/prds/02-agent-validator.md`.** One page: tool list, the 8-call cap, the two-step model flow and the validator rules. Claude drafts it; you approve the answers to open questions 1, 4 and 7 in `status.md`. Replace the `01-parser-graph.md` stub with a pointer to `architecture.md` at the same time | Claude, you approve |
| 4 | **Build a thin agent end to end on the real graph.** Put the graph in `data/<repo>/`, then run tools and one structured-output call against `muse-spark-1.3`. Tools and structured output have never run together on real data, so if this combination fails, find out tonight | Claude |

## Sunday (Nov 1)

| # | Step | Who |
|---|---|---|
| 5 | **Finish the validator and wire `/api/ask` to the real loop,** with cached demo answers. Never cut either one | Claude |
| 6 | **Rewrite the helix animation from scratch.** Using code you have no rights to is a disqualifying rule, and its source and licence are still unknown. Skip this only if you can find a licence that clearly allows it | Claude |
| 7 | **Hand-label about 10 eval questions** with the correct node IDs. These must come from you, not from the AI that built the parser | You |
| 8 | **Pick the demo question and plan the flagged moment.** The template has no uncertain edges, so a gap only appears if the model claims a link that doesn't exist. Find a question that reliably produces an `unverified` claim or a gap, then cache it | You and Claude |
| 9 | **Build learning mode, only if step 5 works.** Write `docs/prds/04-learning-mode.md` first, briefly | Claude |

## Monday (Nov 2)

| # | Step | Who |
|---|---|---|
| 10 | **Write `docs/prds/05-eval-demo.md` and run the eval.** Report failures honestly | You and Claude |
| 11 | **Freeze features.** Check the UI at 1280px, plus hover cards and file view on the real graph | Claude |
| 12 | **Prepare your answer to "why an agent if it fits in context?"** The template is small, so expect the question. A draft is in `.claude/idea-architecture.md` | You |

## Tuesday (Nov 3)

| # | Step | Who |
|---|---|---|
| 13 | **Run the submission check** (list below) and bring `README.md` up to date. It still describes unbuilt features in the present tense | You and Claude |
| 14 | **Record the 3-minute video** from cached answers. Label the demo repo as third-party input | You |
| 15 | **Submit** at <https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit> | You |

## Wednesday (Nov 4)

| # | Step | Who |
|---|---|---|
| 16 | **Keep it as buffer only.** After submitting, post the demo on X for the Most Viral prize; engagement counts until Nov 8 | You |

## If you fall behind

Cut in this order: open-weight path, eval size, file-view detail, learning mode, then UI polish. Never cut the agent loop or
the grounding validator.

## Submission check

- [ ] Repo is public, with no secrets or `.env` in its history
- [ ] Muse models power the app itself, including the agent and its tool calling, and every product model call goes to Meta
- [ ] Nothing in the repo or video uses code, data or assets without the rights to it (helix rewritten, demo repo credited as MIT)
- [ ] Judges can tell what is new: `README.md` "Built during the hackathon" section, `NOTES.md`, and only event-built work in the video
- [ ] AI coding help disclosed in `NOTES.md`
- [ ] Project is entered in one track only: Indie Developer
- [ ] Problem statement chosen: Build for Your World (Push the Frontier also fits, but pick one)
- [ ] Video is 3 minutes and its link works
- [ ] No `TODO` stubs left in `docs/prds/`
- [ ] Trace is pitched as graph-walking with verified claims, never as chat with your code or basic RAG. Pitch learning mode as
      onboarding to a codebase, because "AI for education" chatbots are on the avoid list
