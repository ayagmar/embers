# Status

Updated 2026-11-12.

## State

embers 0.2.1 is on `main`, tagged `embers--v0.2.1`, and listed in the `ayagmar/claude-mods` marketplace. 0.2.1 fixes, over 0.2.0: a resumed session with no handoff on file sent its first prompt cold without asking; it now keeps a `touch:<session>` record of its last cache read and sizes a resumed conversation from the local breakdown. Every unasked cold send logs its reason to the debug log, log lines lose the doubled `embers:` prefix, and a fork that failed before billing is no longer tallied. A running 0.2.0 process deletes `touch:` records, so restart open sessions after updating. 43 tests; `npm run check` clean.

## In flight

Nothing.

## Next

1. Run it with default settings for a few days and watch the fork lines and the monthly tally.
2. Add `author` and an icon to the manifest before any wider publishing.
3. From the audit, not yet done: git HEAD in the handoff and a staleness note on load; handoff history with `/embers show <n>`; a cold band once the cache lapses; an opt-out of automatic forks for worker sessions.

## Decisions

- The swap is `/clear` plus an appended handoff. The host refuses compaction inside the submit hook, and a compaction from a timer skips the plugin's own hook; `docs/probes/` shows both.
- No "write handoff then swap" choice on a cold prompt: re-warming the full prefix and then discarding it costs more than sending.
- The start offer runs from `session.start`; classic hooks are bypassed by the org security plugin on this machine.
- Dev tooling lives in `package.json` with a lockfile. The mod has no dependencies.

## Open

- Fork cache writes: about 7.6k after a conversation's first turn, 0 to 3 after later turns. The first-turn write is unexplained.
- `/embers off` comes back on after a `/clear` followed by a reload before any state write. The test kit cannot start a module over, so there is no test.
