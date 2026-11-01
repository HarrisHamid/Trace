# Trace — Next Steps

> Written Sat Oct 31, 2026, after parser v2 (PR #3). Steps 1 to 6 and 8 were done by Nov 1. Work top to bottom. **Who** says who has to do it. Feature freeze is
> Mon Nov 2, the plan is to submit Tue Nov 3, and the hard deadline is **Wed Nov 4, 9:00 PM ET**.

## Tonight (Sat Oct 31)

| # | Step | Who |
|---|---|---|
| 1 | **Done.** **Merge PR #3 with a merge commit, not a squash.** Commit timestamps are evidence for the new-work rule | You |
| 2 | **Done 2026-11-01.** **Get Meta API access working.** Claim the $150 credits (card required) and set a spend alert. Put the key in `.env`, using `.env.example`. This checkout has no `.env`, and nothing can call the model without it | You |
| 3 | **Done 2026-11-01.** **Write `docs/prds/02-agent-validator.md`.** One page: tool list, the 8-call cap, the two-step model flow and the validator rules. Claude drafts it; you approve the answers to open questions 1, 4 and 7 in `status.md`. Replace the `01-parser-graph.md` stub with a pointer to `architecture.md` at the same time | Claude, you approve |
| 4 | **Done 2026-11-01.** **Build a thin agent end to end on the real graph.** Put the graph in `data/<repo>/`, then run tools and one structured-output call against `muse-spark-1.3`. Tools and structured output have never run together on real data, so if this combination fails, find out tonight | Claude |

## Sunday (Nov 1)

| # | Step | Who |
|---|---|---|
| 5 | **Done 2026-11-01.** **Finish the validator and wire `/api/ask` to the real loop,** with cached demo answers. Never cut either one | Claude |
| 6 | **Done 2026-10-31: helix rewritten from scratch** in `web/src/lib/helix.ts`, and the third-party component deleted. It remains in git history (`b11c3d0`); see `NOTES.md` | Claude |
| 7 | **Check the 10 draft eval questions in `eval/questions.json`.** Claude drafted them from the source, so they are not ground truth until you have read each row against the code and set `human_checked` to true | You |
| 8 | **Done 2026-11-01: the demo question is "How does login work?",** replayed from `data/fastapi-template/answers/how-does-login-work.jsonl`. It shows 12 verified, 4 unverified and 1 gap, where the model jumps from `verify_password` back to the handler and skips `authenticate`. Never regenerate this file by accident: answers vary between runs | You and Claude |
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
