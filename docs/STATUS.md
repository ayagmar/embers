# Status

Updated 2026-11-12.

## State

embers 0.2.0 is on `main`, tagged `embers--v0.2.0`, and listed in the `ayagmar/claude-mods` marketplace. 0.2.0 adds, over 0.1.0: the handoff drawn as a placed Markdown row, `/embers show`, swap failures reported with the resume command, log lines instead of toasts, errored turns not counted as cache reads, Esc on the cold ask sends nothing, "Read it first" and sizes in the ask labels, observed TTLs that expire after a day and are reconciled on reload, a loaded handoff under its own header and kept for its session with the offer marked under its own key, Markdown handoffs under fixed headings, and a monthly tally in `/embers status`. 40 tests; `npm run check` clean. Not yet run for long with default settings.

## In flight

Branch `fix/cold-pass-through`, PR open, not released. A resumed session whose handoff was never written (fork failed over a usage limit, or the process quit before the timer) sent its first prompt cold without asking: 328k tokens on a runnerd session on 2026-11-12. Fixes: a `touch:<session>` record per session seeds the cache on resume; every unasked cold send logs its reason to the debug log; log lines lose their doubled `embers:` prefix (the host adds one); a fork that failed before billing is no longer tallied. 41 tests; `npm run check` clean.

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
