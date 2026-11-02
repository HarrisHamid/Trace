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
uv run python -m eval.run_eval          # one live run per question, saved to eval/runs/, costs model credits
uv run python -m eval.run_eval --score  # score the saved runs again after labels change, with no model calls
```

Every question runs live and never from the cached demo answers. Every run counts: nothing is retried or picked. A label
that names no node stops the eval, because it would otherwise read as an agent failure.

## Results

The latest numbers are in `eval/results.md`, with the raw runs in `eval/runs/`. Quote only the "Checked by hand" row, and
give its size. The model varies between runs, so one run per question is a sample and not a fixed score.

## Cached answers

`data/fastapi-template/answers/` holds 10 answers. `/api/ask` replays one when the question matches, ignoring case and
punctuation.

- `how-does-login-work.jsonl` is the recording for the video. It shows 12 verified, 4 unverified and 1 gap.
- The delete answer predates the eval, so its wording differs from the eval's delete question.
- The other 8 are the eval's own runs, copied unchanged.

The login recording is not the eval's login run. The recording reaches all 4 required nodes, and the eval's fresh run
missed `verify_password`. The video must not present the recording as the eval result.

## Demo video

See `.claude/idea-demo-eval.md` for the 3-minute outline. Record from cached answers with `make dev-api-real`, and label
the demo repo as third-party input.
