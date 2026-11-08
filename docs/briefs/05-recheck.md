# Brief 05: re-check of the embers fix round

You reviewed branch `feat/mod` in brief 03. The fix round is done; re-check the new head. Read-only: write only the report named below.

## Where

`/home/ayagmar/.cache/embers/worker`, branch `feat/mod`, head `eb0eb35`. Do not touch `/home/ayagmar/projects/embers`.

## Read

1. `docs/briefs/04-status.md`: what was fixed, commit by commit, the live-run figures, the bug found live (`/clear` starts `$.state` over) and the four open points.
2. `git log --oneline 1e04083..eb0eb35` and the diff of each fix commit against your findings.
3. `docs/probes/compact-in-prompt-submit/`: the evidence for finding 8.

## What to do

1. For each of your findings 1 to 12 and the test findings: fixed, or not, with the line. Report only the ones not fixed or fixed wrongly.
2. Regressions and blockers introduced by the fix round only. In particular: `isInteractive` and the swap flag moved to module variables (commit `13eea56`); the `session.start` seeding from the session's own handoff; the `lapse` two-observation rule; `session.end` resetting on `clear`, including the swap's own `/clear`.
3. The four open points in the status note. For point 1, the fork's 7.6k `cache_creation_input_tokens` on the first fork of a conversation: explain it from the types or the debug logs named in the note, and say whether it changes the cost case.

## Output

Write `/home/ayagmar/.cache/embers/worker/docs/briefs/05-recheck-report.md`: regressions and blockers first with `file:line`, failure scenario and smallest fix; then unfixed earlier findings; then the open points; then one verdict line: `MERGE` or `MERGE AFTER FIXES` (list) or `DO NOT MERGE`. No nits. Reply in the chat with the report path only.
