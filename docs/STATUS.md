# Status

Updated 2026-11-08.

## Done

- Design revision 2 after an adversarial challenge (`briefs/01-challenge-report.md`, MODIFY, all findings folded in).
- Implementation (`briefs/02-status.md`), review (`03-review-report.md`, MERGE AFTER FIXES), fix round (`04-status.md`), re-check (`05-recheck-report.md`, MERGE). PR #1 merged to `main` with a merge commit. Compaction inside the submit hook proven refused by the probe under `docs/probes/`.
- Sweep (`briefs/07-sweep.md`, `07-status.md`): explicit state machine in `hooks/state.ts`, process-lifetime values in `hooks/process.ts`, one off switch and `/embers on`, `coldMode` reduced to `ask`, `swap`, `send`, figures in words, fuller `/embers status`, `handoffInstructions` option, Biome 2.6.6 and TypeScript 7.0.2 pinned with a lockfile, `npm run check`, README rewritten. Review (`08-review-report.md`, MERGE AFTER FIXES), fixes (`09-status.md`), re-check (`10-recheck-report.md`, MERGE). PR #2 merged to `main` with a merge commit. 24 tests.

## In flight

- Nothing. All panes and worktrees are closed.

## Next

1. Run the mod with default settings for a few days: `claude --plugin-dir ~/projects/embers/embers`, or `CLAUDE_CODE_PLUGIN_DIRS` for every session (see README). Watch the fork toasts.
2. Add `author` and an icon if the mod is ever published.

## Decisions taken

- Swap is `/clear` plus an appended handoff: the host refuses compaction inside the submit hook, and a compaction from a timer skips the plugin's own hook.
- The "write handoff then swap" cold option is removed: re-warming the full prefix and then discarding it costs more than sending.
- Start offer lives on `session.start`, since the org security plugin bypasses classic hooks on this machine. It also appears on `--resume`.
- Dev tooling (Biome, TypeScript) is declared in `package.json` with a lockfile. The mod itself has no dependencies; the engine compiles the hooks module.

## Open

- Fork cache writes: about 7.6k after a conversation's first turn, 0 to 3 after later turns (one eight-read turn measured, `briefs/09-status.md`). The earlier theory that the fork rewrites the last turn did not hold. The first-turn write is unexplained.
- `/embers off` comes back on after a `/clear` followed by a reload before any state write. The kit cannot start a module over, so there is no test.
- Whether the org plugin bypass of `classic.*` hooks also applies to `classic.PostModelSwitch` (assumed yes; the mod no longer depends on it).
- Publishing: not planned until the mod has run for a few days with default settings.
