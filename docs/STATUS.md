# Status

Updated 2026-11-08.

## Done

- Design revision 2 after an adversarial challenge (`briefs/01-challenge-report.md`, verdict MODIFY, all findings folded in).
- Implementation on branch `feat/mod` (`briefs/02-status.md`): validate, type-check and 8 tests pass. Live run on Fable 5.1 confirmed the premise: every handoff fork read the whole prefix from cache with about 130 uncached input tokens.
- Review round 1 (`briefs/03-review-report.md`): MERGE AFTER FIXES, findings 1 to 7.

- Fix round on `feat/mod` (`briefs/04-status.md`, head `eb0eb35`): all 12 review findings fixed one commit each, 17 tests, live run clean; one more bug found live and fixed (`/clear` starts `$.state` over). Compaction inside the submit hook proven refused by a probe plugin under `docs/probes/`.

- Re-check (`briefs/05-recheck-report.md`): MERGE; the three minor regressions and two follow-ups fixed (18 tests). PR #1 merged to `main` with a merge commit on 2026-11-08. Worktree and panes closed.

- Sweep on `refactor/sweep` (`briefs/07-status.md`): explicit state machine, one off switch and `/embers on`, Biome and `npm run check`, figures in words, fuller `/embers status`, `handoffInstructions`, README rewrite. 19 tests, live run clean.

## In flight

- `refactor/sweep` is pushed and not merged. It needs review and a merge.

## Next

1. Run the mod in a real session with default settings for a few days: `claude --plugin-dir ~/projects/embers/embers`. Watch the `wrote` figure in the fork toasts after a long agentic turn.
2. Add an icon if the mod is ever published.

## Decisions taken

- Swap is `/clear` plus an appended handoff, unless the fix round proves compaction works inside the submit hook, in which case compaction returns.
- The "write handoff then swap" cold option is removed: re-warming the full prefix and then discarding it costs more than sending.
- Start offer lives on `session.start`, since the org security plugin bypasses classic hooks on this machine. It also appears on `--resume`.

## Open

- The fork's uncached tail is the last turn (explained in `briefs/05-recheck-report.md`); one fork after a multi-step turn is still unmeasured. Manifest `author` and icon are publishing metadata, left for the owner.
- Whether the org plugin bypass of `classic.*` hooks also applies to `classic.PostModelSwitch` (assumed yes; the mod no longer depends on it).
- Publishing: not planned until the mod has run for a few days with default settings.
