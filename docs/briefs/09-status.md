# Brief 09 status: sweep review fixes

Branch `refactor/sweep`, pushed, not merged. All six findings are addressed, one commit each. One further bug turned up and has its own commit. Finding 6's README text differs from the brief because the measurement contradicted it.

## Finding 6: the measurement went the other way

The brief asked the README to say the write grows with the last turn's tool output. It did not in this run, so the README states what was measured instead.

Live run on Sonnet 5.5 at low effort, `ttlMinutes` 2, `marginMinutes` 1, `minContextTokens` 0. One short turn, then a turn of eight sequential `Read` calls (9 requests).

| Figure | Tokens |
|---|---|
| Context when the eight-read turn began | 33,519 |
| Context at its last request | 79,075 |
| Fork: read from cache | 79,076 |
| Fork: written to cache | 0 |
| Fork: uncached input | 127 |
| Fork: output | 1,512 |

Toast: `embers: Handoff written; read 79k from cache, wrote 0, 1.5k out`. Band: `embers  handoff ready  15:52, 79k tokens, warm until 15:54`.

This is one run. Claude Code's own prompt-suggestion fork ran between the turn and the handoff and wrote 3 tokens, so it did not absorb a large write. Earlier runs wrote about 7.6k after a conversation's first turn. Why that first turn differs is not established. `DESIGN.md` and the README now give these figures and drop the claim that a fork rewrites the last turn's tool output.

## Findings

1. `/embers` now asks when `cache.model` is set and differs from the current model. A seeded touch does not ask. The new test fails with the check removed and with the seeded exception removed.
2. The four tests and the `manualClock` change to the `/clear` test are in. Putting each bug from the report's table back fails a test: the re-check after the fork, the refusal while writing, the `armed` guard, `writing` ended on reload, each of the three size gates, the resets on `/effort`, compaction and model switch, the `session.end` reset, the 2 × TTL filter and the delete loop.
3. `apply` copies an off variable into every write, and `/embers on` clears the variable first. A throwaway test showed the state holds `isOff: true` after the next write with the fix and `false` without it. It is not committed, because the kit cannot start a module over. A reload right after a `/clear`, before any state write, still turns embers back on.
4. The README has the clone command and says `--plugin-dir` is per session, with `CLAUDE_CODE_PLUGIN_DIRS` for every session.
5. `coldMode` is `ask`, `swap` or `send`. A stored `off` now counts as unset, which means the default, `ask` (`plugin-authoring-reference.md`, on `options`).
6. See above.

## Found while writing the tests

`fix: read the state afresh after a fork`. Every `$.state.get` of one dispatch reads one moment (`d.ts:3558`), so the phase check after the fork could read `writing` after a reload, `/effort` or prompt had moved on, and store that handoff. The session and turn checks caught only a finished turn or a `/clear`. The check now goes through `update`, which retries past a held read. Putting the plain read back fails the held-fork test. This was already on `main`.

The timer's own first read is fresh, since each timer callback is its own dispatch, so `fire` keeps its plain read.

## Correction to `07-status.md`

Its reason for Biome's exhaustive-switch rule staying quiet is wrong. The review found the rule does fire on unions from the `.d.ts`; it stayed quiet on `bandLine` because that switch has a `default`. `tsc` covers `bandLine`, so the code stands.

## Verified

`npm run check` is clean: Biome, `tsc`, 24 tests, and `claude plugin validate` (passes with its existing `author` and icon warnings).

The scratch session, pane, settings file, debug log and the run's store file are removed.
