# Eval and demo

## What the eval measures

`eval/questions.json` holds 10 questions about the pinned demo repo, each with the nodes a right answer must reach and
the nodes it should reach. A label counts only once a human has read it against the code and set `human_checked` to true.
The agent's builder drafted them, so unchecked rows are not ground truth.

| Measure | Meaning |
|---|---|
| Must reach | Share of required nodes in the final path. This is the measure of whether an answer is right |
| Should reach | The same for nodes a fuller answer would include |
| Model claims verified | Share of the model's claims the validator passed. The validator's own link claims are left out |
| Gaps | Hops in the final path with no proven edge |
| Tool calls, time | Effort per run, out of a cap of 8 tool calls |

A verified claim means its quote exists in that node's source, not that the sentence about it is true. Nodes the agent read
but left out of its answer do not count towards recall.

## Running it

```sh
uv run python -m eval.run_eval --round 1      # one live run per question, into eval/runs-repair/round-1/, costs credits
uv run python -m eval.run_eval --score-repair # score the saved repair rounds again, with no model calls
uv run python -m eval.run_eval --score        # score the baseline in eval/runs/ again, with no model calls
```

`make eval` runs both scoring commands, so it never spends credits. Run it after changing labels.

Every question runs live and never from the cached demo answers. Every run counts: nothing is retried or picked. A label
that names no node stops the eval, because it would otherwise read as an agent failure. A saved run is never overwritten,
and a cut-off round picks up where it stopped. The runner stops at 26 live runs or $5, the owner's limits for this work.

## Results

The latest numbers are in `eval/results.md`, with the raw runs in `eval/runs/`. Quote only the "Checked by hand" row, and
give its size. The model varies between runs, so one run per question is a sample and not a fixed score.

## Measuring repair

`eval/runs/` and `eval/results.md` are the baseline from before repair existed, and nothing writes to them. The repair
numbers are in `eval/results-repair.md`, with the raw runs in `eval/runs-repair/`.

Each run is scored twice, before and after its repair, on the same first draft, so model variance between runs does not
affect the comparison. The first-draft prompts did not change, and a scripted run confirms that every first-draft request
is identical to the one sent before repair existed.

Results from 20 live runs, 2 rounds of 10 questions. Quote the "Checked by hand" row and give its size, 6 runs.

| | Runs | Must reach | Should reach | Model claims verified | Gaps |
|---|---|---|---|---|---|
| Checked by hand | 6 | 89% to 89% | 25% to 25% | 89% to 97% | 0 to 0 |
| All, including unchecked | 20 | 86% to 86% | 32% to 32% | 82% to 90% | 0 to 0 |

| Outcome | Runs |
|---|---|
| Nothing to repair | 8 |
| Accepted | 9 |
| Changed nothing | 2 |
| Repair failed | 0 |
| No answer: the first draft broke the schema, so repair never ran | 1 |

20 claims went back and 15 were fixed. 8 flagged items were left alone, because no fix is possible.

**Read these before quoting anything.**

- **Awaiting human check.** The owner has not yet read `eval/repair-audit.md`. Until then, the rise in verified means only
  that quotes exist, not that answers became more correct. A real quote can still fail to prove its sentence.
- **Repair did not change recall.** Must reach moved by zero nodes. Do not pitch this as a recall gain. Repair only sees
  what the validator flags, and a node left out of a clean path is not flagged.
- **The eval says nothing about gaps.** None of the 20 drafts had one, so no gap was sent back. The only live gap repair is
  the stitched demo take, one case. The demo must not imply that gaps are common or that repairing them is proven.
- **First drafts differ from the baseline, unexplained.** Should reach is 32% here against 55%, gaps 0 against 4, and mean
  path length 5.5 steps against 6.1. The requests are identical, so this is run-to-run variance or a change on the model's
  side. The baseline's own numbers are one run per question.
- **The verified rise has a ceiling.** Claims on external steps can never verify and are never sent back.
- **Time.** The repair call took a median of 8s and 21s at most in the eval. Outside it, two calls took 30.7s and 34.0s, so
  the limit of 45s is not far off. A repair that hits it counts as failed, and the first answer stands.

## Cached answers

`data/fastapi-template/answers/` holds 10 answers, the owner's limit. `/api/ask` replays one when the question matches, ignoring case and
punctuation.

- `how-does-login-work.jsonl` is the first-draft recording, the "before" shot. It shows 12 verified, 4 unverified and 1 gap.
- The delete answer predates the eval, so its wording differs from the eval's delete question.
- The other 7 are the eval's own runs, copied unchanged. `create-item` was removed to stay at 10, as the weakest answer.
- `how-does-a-user-log-in.jsonl` is the repair take, and it is **stitched**. See below.

The login recording is not the eval's login run. The recording reaches all 4 required nodes, and the eval's fresh run
missed `verify_password`. The video must not present the recording as the eval result.

### The repair take

The owner's plan was up to 4 whole runs of "How does a user log in?", picking one that showed a good repair, and otherwise
one real repair on the old recording. 3 whole runs were made, keeping one live run of the owner's limit of 26 for the
fallback. None had a gap, so none shows the path being fixed on the map. They are in `eval/runs-repair/demo/`:

| Attempt | Outcome | Result |
|---|---|---|
| 1 | Changed nothing | 13, 1, 0 verified, unverified, gap |
| 2 | Accepted, 1 of 3 fixed | 18, 3, 0 to 19, 2, 0. It rightly left 2 "source was not fetched" claims unverified |
| 3 | Accepted, 1 of 1 fixed | 12, 1, 0 to 13, 0, 0 |

So the fallback was used. `scripts/repair_recording.py` made one real repair call on the first draft of
`how-does-login-work.jsonl`, which is unchanged. It went from 12, 4, 1 to 18, 0, 0, with the 5 of 5 sent back fixed.

**What must be disclosed:** the take is selected and stitched. The walk and first draft are the old recording, which
answered "How does login work?". The repair was made later, on a rebuilt conversation that held the draft and the attached
sources but not the old tool results, because those were never saved. It is one case, not typical: a whole run of this
question has not shown this repair. Its record is `eval/runs-repair/demo/stitched-how-does-a-user-log-in.json`, and its
4 fixed claims are in the audit.

## Demo video

See `.claude/idea-demo-eval.md` for the 3-minute outline. Record from cached answers with `make dev-api-real`, and label
the demo repo as third-party input.
