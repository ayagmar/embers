# Brief 10 report: re-check of the sweep fixes

Branch `refactor/sweep` at `20a8b3a`, diff `e702d7c..20a8b3a`, read against `docs/briefs/08-review-report.md` and `docs/briefs/09-status.md`.

In a scratch copy, Biome and `tsc` are clean, `claude plugin test` gives 24 pass, 0 fail, and `claude plugin validate` passes with warnings. I put back 20 of the bugs by mutation and ran one probe. No live session was run, and the debug logs behind the status note's figures are gone, so the cost section below rests on the table in `09-status.md`.

## Regressions and blockers

None.

What I checked in the four areas the brief names:

- **`apply` copying the off variable** (`embers/hooks/state.ts:27`). `/embers on` clears the variable before its write (`embers/hooks/register.tsx:144-145`), so the copy cannot undo it. A write racing `/embers on` retries through `update` and reads the variable again. The copy only ever adds off, and the variable already wins in `isOff`, so it changes no decision in the running process.
- **The post-fork check through `update`** (`embers/hooks/state.ts:35`, `embers/hooks/handoff.ts:115`). `update` writes with `ifVersion` and retries on a miss (`d.ts:16036-16048`), and `r => r` does write, so a stale pinned read misses and is retried. Putting the plain read back fails the held-fork test. The other plain reads after a wait do not need it: `observeTtl` reads only `lapse`, which nothing else writes during a step, and `fire`'s read being fresh is shown by every timer fork in the live runs, which would otherwise find the phase from before arming.
- **`coldMode`** (`embers/hooks/shared.ts:39,65`). A stored `off` is outside the field's `options`, so it counts as unset (`docs/reference/plugin-authoring-reference.md:74`). The probe with `coldMode: 'off'` loaded without the `readConfig` throw and asked at the cold prompt. So that person goes from no ask to `ask`, which is the stated behaviour and affects no released user.
- **The new tests.** They assert forks, stored records, the band, live timers, asks and replies. Removing each guard they are named for fails them: the model check and its seeded exception, the re-check after the fork, the refusal while writing, the `armed` guard, `writing` ended on reload, the three size gates, the three resets, the `session.end` reset, the 2 × TTL filter and the delete loop. None hung.

## Findings 1 to 6

All six are fixed: finding 1 at `embers/hooks/register.tsx:160-161`, finding 2 in `embers/hooks/embers.test.tsx`, finding 3 at `embers/hooks/state.ts:27`, finding 4 at `README.md:8,12`, finding 5 at `embers/hooks/shared.ts:39`, finding 6 at `README.md:60`.

Two limits that do not reopen them:

- Finding 3 has no committed test: removing the copy leaves all 24 passing, because the kit cannot start a module over. A reload after a `/clear` and before any state write still turns embers back on, as `09-status.md:28` says. `main` has the same window.
- Finding 4's clone command fails for anyone else while `ayagmar/embers` is private. It works for the owner, and making the repository public is the owner's decision.

## The cost question

The evidence now supports the status note, against my finding 6.

The eight-read turn took the context from 33,519 to 79,075 tokens. The fork then read 79,076 from cache, wrote 0, and sent 127 uncached, which is about the size of the handoff prompt. So the fork was served from the cache entry the main thread's last request had written, through to the end of that turn, and paid only for its own prompt. That is what `d.ts:2736-2738` describes: the main thread's last request again, with the prompt after it.

My finding 6 said a last turn with 30k of tool output would make the fork write about 30k. I took that from the brief 05 reading, and it did not hold in the one run that tested it. The finding's request for a measurement stood; its predicted result was wrong.

Every fork after a later turn wrote 0 to 3 tokens, and every fork after a first turn wrote about 7.6k. That first-turn write is still unexplained. The later-turn result is one eight-read run on one model at low effort.

The README's Cost section is true as written. The 7.6k, the 0 and the 46k (45,556) match the figures, and "in the runs measured" limits the claim to what was run.

## Verdict

MERGE
