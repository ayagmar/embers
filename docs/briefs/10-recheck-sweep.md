# Brief 10: re-check of the sweep fixes

You reviewed `refactor/sweep` in brief 08. The fixes are in; re-check the new head. Read-only: write only the report named below.

## Where

`/home/ayagmar/.cache/embers/sweep`, branch `refactor/sweep`, head `20a8b3a`. Diff `e702d7c..20a8b3a`.

## Read

`docs/briefs/09-status.md` first: the six fixes, one extra bug found (`fix: read the state afresh after a fork`), the measurement for finding 6 that went the other way, and the TypeScript dev dependency.

## What to do

1. Each of your findings 1 to 6: fixed, or not, with the line. Report only what is not fixed or fixed wrongly.
2. Regressions and blockers introduced by the fix round only, in particular: `apply` copying the off variable into every write; the post-fork check through `update`; the `coldMode` change and how a stored `off` reads; the new tests (do they assert behaviour, and would they catch the bug they are named for).
3. The finding 6 measurement: the fork after an eight-read turn wrote 0 to the cache, against your reading that the write would be the whole last turn. Say which reading the evidence now supports and whether the README's Cost section is true as written.

## Output

Write `/home/ayagmar/.cache/embers/sweep/docs/briefs/10-recheck-report.md`: regressions and blockers first with `file:line`, scenario and smallest fix; unfixed findings; the cost question; one verdict line `MERGE`, `MERGE AFTER FIXES` (list) or `DO NOT MERGE`. No nits. Reply in the chat with the report path only.
