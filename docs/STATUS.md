# Status

Updated 2026-11-08.

## Done

- Design revision 2 after an adversarial challenge (`briefs/01-challenge-report.md`, verdict MODIFY, all findings folded in).
- Implementation on branch `feat/mod` (`briefs/02-status.md`): validate, type-check and 8 tests pass. Live run on Fable 5.1 confirmed the premise: every handoff fork read the whole prefix from cache with about 130 uncached input tokens.
- Review round 1 (`briefs/03-review-report.md`): MERGE AFTER FIXES, findings 1 to 7.

- Fix round on `feat/mod` (`briefs/04-status.md`, head `eb0eb35`): all 12 review findings fixed one commit each, 17 tests, live run clean; one more bug found live and fixed (`/clear` starts `$.state` over). Compaction inside the submit hook proven refused by a probe plugin under `docs/probes/`.

## In flight

- Re-check round with the same reviewer (`briefs/05-recheck.md`), report to `briefs/05-recheck-report.md`.

## Next

1. Act on the re-check: fix blockers, then merge. Two re-check rounds at most.
2. Merge `feat/mod` into `main` (no squash), then try the mod in a real session with default settings.
3. README: usage, options table, what the band and the ask look like. Add an icon if the mod is ever published.

## Decisions taken

- Swap is `/clear` plus an appended handoff, unless the fix round proves compaction works inside the submit hook, in which case compaction returns.
- The "write handoff then swap" cold option is removed: re-warming the full prefix and then discarding it costs more than sending.
- Start offer lives on `session.start`, since the org security plugin bypasses classic hooks on this machine. It also appears on `--resume`.

## Open

- Open points from `briefs/04-status.md`: first-fork cache writes of ~7.6k tokens unexplained; handoff log line cut at 2,000 characters; size estimate reads oddly on small sessions; manifest `author` and icon.
- Whether the org plugin bypass of `classic.*` hooks also applies to `classic.PostModelSwitch` (assumed yes; the mod no longer depends on it).
- Publishing: not planned until the mod has run for a few days with default settings.
