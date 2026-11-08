# Brief 06: minor follow-ups before merge

The re-check (`docs/briefs/05-recheck-report.md`) says MERGE with minor follow-ups. Do them on `feat/mod` in `/home/ayagmar/.cache/embers/worker`, one commit each, Conventional Commits, no attribution trailers.

1. R1: `/embers off` must survive a `/clear`. Mirror `isOff` as the report describes, or any cleaner way that keeps one source of truth.
2. R2: replace the `isInteractive` module variable with a read of `$.session.surfaces()` where it is needed.
3. R3: in the newest-per-branch retention rule, drop a superseded record only when it is older than 2 × TTL and the root holds more than 10 records.
4. Add `cache_creation_input_tokens` to the fork figures shown in toasts and `/embers` output.
5. Clamp `fixed` to at most `tokens` in the cold path so the ask never says Fresh costs more than sending.
6. Update DESIGN.md "Rules that keep it cheap": the fork's uncached tail is the last turn, not a few hundred tokens; say so.
7. First commit `docs/briefs/05-recheck.md`, `05-recheck-report.md` and this brief as `docs: re-check round briefs and report`.

Add a regression test only for R1 (off survives /clear). Run `claude plugin validate embers`, `tsc -p embers`, `claude plugin test embers`. No live run. Push and reply with the head commit hash only.
