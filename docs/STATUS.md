# Status

Updated 2026-11-08.

## Done

- Design revision 2 after an adversarial challenge (`briefs/01-challenge-report.md`, verdict MODIFY, all findings folded in).
- Implementation on branch `feat/mod` (`briefs/02-status.md`): validate, type-check and 8 tests pass. Live run on Fable 5.1 confirmed the premise: every handoff fork read the whole prefix from cache with about 130 uncached input tokens.
- Review round 1 (`briefs/03-review-report.md`): MERGE AFTER FIXES, findings 1 to 7.

## In flight

- Fix round on `feat/mod` from `briefs/04-fix-review.md`: margin formula under a 5m TTL, model and effort guards, a second prompt during a swap, resume seeding, `/clear` reset via `session.end`, start offer on `session.start`, removal of the "write handoff then swap" option, test fixes.

## Next

1. Verify the fix round (validate, tsc, tests, read the status note).
2. Re-check round with the same reviewer on the new head: earlier findings verified, regressions and blockers only. Two re-check rounds at most.
3. Merge `feat/mod` into `main` (no squash), then try the mod in a real session with default settings.
4. README: usage, options table, what the band and the ask look like. Add an icon if the mod is ever published.

## Decisions taken

- Swap is `/clear` plus an appended handoff, unless the fix round proves compaction works inside the submit hook, in which case compaction returns.
- The "write handoff then swap" cold option is removed: re-warming the full prefix and then discarding it costs more than sending.
- Start offer lives on `session.start`, since the org security plugin bypasses classic hooks on this machine. It also appears on `--resume`.

## Open

- Whether the org plugin bypass of `classic.*` hooks also applies to `classic.PostModelSwitch` (assumed yes; the mod no longer depends on it).
- Publishing: not planned until the mod has run for a few days with default settings.
