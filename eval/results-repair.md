# Repair results

**Awaiting human check.** The 15 claims that repair marked verified are listed in
`eval/repair-audit.md`. Until a person has read them, the verified figures below mean only that a quote exists in
the source, and must not be quoted as answers getting more correct.

20 live runs in 2 rounds. Each run is scored twice on the same first draft, before
and after its repair, so model variance between runs does not affect the comparison. Nothing was retried or picked.

## What repair did

| Outcome | Runs |
|---|---|
| nothing to repair | 8 |
| accepted | 9 |
| no_improvement | 2 |
| failed | 0 |
| no answer, run failed | 1 |

`failed` means the repair failed and the first answer stood. A run with no answer failed before repair could start.
It counts as zero in the tables below, because every run counts.

Claims sent back: 20. Fixed: 15. Gaps sent back: 0. Closed: 0.
Left alone, because no fix is possible: 8.

**No draft in these runs had a gap with a bridge, so this eval says nothing about repairing gaps.**

## Before and after, on the same drafts

| Questions | Runs | Must reach | Should reach | Model claims verified | Gaps | Mean path steps |
|---|---|---|---|---|---|---|
| Checked by hand | 6 | 89% to 89% | 25% to 25% | 89% to 97% | 0 to 0 | 4.8 to 4.8 |
| All, including unchecked | 20 | 86% to 86% | 32% to 32% | 82% to 90% | 0 to 0 | 5.2 to 5.2 |

Must reach changed by +0 nodes across all runs. **Repair did not change recall.**
A repair cannot remove a node, so must reach cannot fall. Closing a gap adds a step, so a lower gap count comes with
a longer path, as the last column shows.

## First drafts against the baseline

The first-draft prompts did not change, so these should differ only by run-to-run variance.

| Questions | Runs | Must reach | Should reach | Model claims verified | Gaps | Tool calls | Median time |
|---|---|---|---|---|---|---|---|
| Baseline, eval/runs | 10 | 89% | 55% | 80% | 4 | 7.6 | 52s |
| First drafts here | 20 | 86% | 32% | 82% | 0 | 7.7 | 45s |

## Cost and time

The repair call took a median of 8s, and 21s at most,
on the 11 runs that made one. The other 9 runs made no extra call.

These runs used 316,682 input and 108,638 output tokens,
which is $0.86 at $1.25 and $4.25 per million.

## Every run

| Round | Question | Checked | Outcome | Must reach | Claims verified | Gaps | Steps | Added | Repair |
|---|---|---|---|---|---|---|---|---|---|
| round-1 | login | yes | nothing to repair | 3 to 3 of 4 | 11 to 11 of 11 | 0 to 0 | 4 to 4 | none | none |
| round-1 | password-recovery-email | no | accepted | 4 to 4 of 4 | 6 to 8 of 8 | 0 to 0 | 8 to 8 | none | 16s |
| round-1 | reset-password | yes | accepted | 3 to 3 of 3 | 8 to 9 of 9 | 0 to 0 | 6 to 6 | none | 8s |
| round-1 | current-user | no | no_improvement | 1 to 1 of 1 | 11 to 11 of 14 | 0 to 0 | 9 to 9 | none | 7s |
| round-1 | superuser-check | no | nothing to repair | 2 to 2 of 2 | 6 to 6 of 6 | 0 to 0 | 3 to 3 | none | none |
| round-1 | create-item | yes | accepted | 2 to 2 of 2 | 8 to 9 of 10 | 0 to 0 | 4 to 4 | none | 6s |
| round-1 | delete-user | no | nothing to repair | 1 to 1 of 2 | 5 to 5 of 9 | 0 to 0 | 8 to 8 | none | none |
| round-1 | signup | no | nothing to repair | 3 to 3 of 3 | 11 to 11 of 11 | 0 to 0 | 4 to 4 | none | none |
| round-1 | admin-create-user | no | nothing to repair | 3 to 3 of 4 | 9 to 9 of 9 | 0 to 0 | 4 to 4 | none | none |
| round-1 | first-superuser | no | no answer, run failed: The model's answer did not fit the expected format. | 0 to 0 of 3 | 0 to 0 of 0 | 0 to 0 | 0 to 0 | none | none |
| round-2 | login | yes | accepted | 3 to 3 of 4 | 9 to 10 of 10 | 0 to 0 | 5 to 5 | none | 6s |
| round-2 | password-recovery-email | no | accepted | 4 to 4 of 4 | 6 to 9 of 9 | 0 to 0 | 8 to 8 | none | 21s |
| round-2 | reset-password | yes | accepted | 3 to 3 of 3 | 14 to 16 of 16 | 0 to 0 | 6 to 6 | none | 6s |
| round-2 | current-user | no | no_improvement | 1 to 1 of 1 | 11 to 11 of 14 | 0 to 0 | 9 to 9 | none | 9s |
| round-2 | superuser-check | no | nothing to repair | 2 to 2 of 2 | 5 to 5 of 5 | 0 to 0 | 3 to 3 | none | none |
| round-2 | create-item | yes | nothing to repair | 2 to 2 of 2 | 8 to 8 of 9 | 0 to 0 | 4 to 4 | none | none |
| round-2 | delete-user | no | accepted | 2 to 2 of 2 | 5 to 6 of 11 | 0 to 0 | 8 to 8 | none | 7s |
| round-2 | signup | no | nothing to repair | 3 to 3 of 3 | 9 to 9 of 9 | 0 to 0 | 4 to 4 | none | none |
| round-2 | admin-create-user | no | accepted | 3 to 3 of 4 | 5 to 7 of 8 | 0 to 0 | 4 to 4 | none | 15s |
| round-2 | first-superuser | no | accepted | 3 to 3 of 3 | 7 to 9 of 9 | 0 to 0 | 4 to 4 | none | 11s |
