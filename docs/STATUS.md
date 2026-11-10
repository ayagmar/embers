# Status

Updated 2026-11-10.

## State

embers 0.1.0 is on `main`, tagged `embers--v0.1.0`, and listed in the `ayagmar/claude-mods` marketplace. 24 tests; `npm run check` clean. Not yet run for long with default settings.

## In flight

PR #3, `fix/swap-feedback`: the handoff is drawn as a placed Markdown row instead of a mangled log line, `/embers show`, swap failures reported, log lines instead of toasts, and errored turns no longer count as cache reads. The placed row has not been checked in a live terminal.

## Next

1. Check the placed row after a real swap, then merge PR #3.
2. Cold-ask Esc currently sends the prompt; drop it instead. Expire a stored `ttl:<model>` after 24 hours. Keep a loaded handoff's record (mark it used) so a second session's "Load it" does not take it from a live session. Give a loaded handoff its own header instead of "this conversation was replaced".
3. Handoff prompt asks for Markdown with fixed headings; a savings ledger in `/embers status`; a "Read it first" cold choice with sizes in the labels.
4. Run it with default settings for a few days and watch the fork lines.
5. Add `author` and an icon to the manifest before any wider publishing.

## Decisions

- The swap is `/clear` plus an appended handoff. The host refuses compaction inside the submit hook, and a compaction from a timer skips the plugin's own hook; `docs/probes/` shows both.
- No "write handoff then swap" choice on a cold prompt: re-warming the full prefix and then discarding it costs more than sending.
- The start offer runs from `session.start`; classic hooks are bypassed by the org security plugin on this machine.
- Dev tooling lives in `package.json` with a lockfile. The mod has no dependencies.

## Open

- Fork cache writes: about 7.6k after a conversation's first turn, 0 to 3 after later turns. The first-turn write is unexplained.
- `/embers off` comes back on after a `/clear` followed by a reload before any state write. The test kit cannot start a module over, so there is no test.
