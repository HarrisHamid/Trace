# Eval results

3 of 10 questions have labels checked by a human. Only those count as results.

One live run per question, on the pinned demo repo. Nothing was retried or picked.

| Questions | Runs | Must reach | Should reach | Model claims verified | Gaps | Tool calls | Median time |
|---|---|---|---|---|---|---|---|
| Checked by hand | 3 | 89% | 50% | 78% | 3 | 7.3 | 63s |
| All, including unchecked | 10 | 89% | 55% | 80% | 4 | 7.6 | 52s |

| Question | Checked | Must reach | Should reach | Model claims verified | Gaps | Tool calls | Time | Missed |
|---|---|---|---|---|---|---|---|---|
| login | yes | 3/4 | 0/1 | 9/10 | 0 | 8 | 45s | `app.core.security:verify_password` |
| password-recovery-email | no | 4/4 | 2/2 | 7/10 | 1 | 8 | 49s | none |
| reset-password | yes | 3/3 | 1/2 | 17/19 | 0 | 7 | 63s | none |
| current-user | no | 1/1 | 1/2 | 6/9 | 0 | 8 | 54s | none |
| superuser-check | no | 2/2 | 0/0 | 7/7 | 0 | 8 | 43s | none |
| create-item | yes | 2/2 | 1/1 | 6/12 | 3 | 7 | 75s | none |
| delete-user | no | 1/2 | 0/0 | 4/7 | 0 | 7 | 58s | `app.api.deps:get_current_active_superuser` |
| signup | no | 3/3 | 1/1 | 11/12 | 0 | 7 | 57s | none |
| admin-create-user | no | 4/4 | 0/1 | 9/11 | 0 | 8 | 50s | none |
| first-superuser | no | 2/3 | 0/1 | 8/8 | 0 | 8 | 28s | `app.crud:create_user` |

Must reach and should reach count hand-labelled nodes in the final path. A verified claim means its quote exists in
that node's source, not that the sentence about it is true, so recall is the measure of whether an answer is right.
Time includes the model calls.
