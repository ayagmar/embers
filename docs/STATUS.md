# Status

Updated 2026-11-08.

## State

embers 0.1.0 is on `main`, tagged `embers--v0.1.0`, and listed in the `ayagmar/claude-mods` marketplace. 24 tests; `npm run check` clean. Not yet run for long with default settings.

## Next

1. Run it with default settings for a few days and watch the fork toasts.
2. Add `author` and an icon to the manifest before any wider publishing.

## Decisions

- The swap is `/clear` plus an appended handoff. The host refuses compaction inside the submit hook, and a compaction from a timer skips the plugin's own hook; `docs/probes/` shows both.
- No "write handoff then swap" choice on a cold prompt: re-warming the full prefix and then discarding it costs more than sending.
- The start offer runs from `session.start`; classic hooks are bypassed by the org security plugin on this machine.
- Dev tooling lives in `package.json` with a lockfile. The mod has no dependencies.

## Open

- Fork cache writes: about 7.6k after a conversation's first turn, 0 to 3 after later turns. The first-turn write is unexplained.
- `/embers off` comes back on after a `/clear` followed by a reload before any state write. The test kit cannot start a module over, so there is no test.
