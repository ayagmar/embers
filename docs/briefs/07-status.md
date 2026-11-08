# Brief 07 status: architecture sweep

Branch `refactor/sweep`, pushed, not merged. Every section of the brief is done. `npm run check` is clean: Biome, `tsc`, 19 tests, and `claude plugin validate` (passes with its two existing warnings, no `author` and no icon).

## Where it differs from the brief, or adds to it

- `writing` has an optional `cache`, and `Cache.model` can be undefined. A manual `/embers` can start with no cache touch known, and a touch seeded from a handoff has no model. Leaving the model out keeps the rule that no TTL observation follows a resume.
- Transitions beyond the brief's list: `forkSkipped` (the timer decided against forking), `offerMade`, `lapseObserved`, `switchedOff`, `switchedOn`. `turn.start` reuses `promptStarted`. `prefixReplaced` also takes `cold-choice`, for a swap or fresh start whose `/clear` failed. `cacheTouched` is the resume seed.
- `isOff` stays out of `turnEnded`'s purity problem this way: the hook reads `isOff(run)` and passes a `deadline` or none, and `turnEnded` also refuses to arm when the state itself says off.
- The state contract spells out the four usage counts in `LastFork`. `claude plugin validate` rejects an `import` in a contract.
- TypeScript is not a dev dependency, so Biome stays the only one. The `typecheck` script runs `npx --yes -p typescript@7.0.2 tsc -p embers`.
- Biome's `useExhaustiveSwitchCases` is on but did not fire when I deleted a case: it cannot read a union declared in a `.d.ts`. `bandLine` ends in `phase satisfies never`, and `tsc` failed on the same deletion. The other switches return `string`, so `tsc` catches them without that line.
- `.gitignore` already had `node_modules/`, so it did not change.

## Behaviour changes

All three are rare, and each follows from `prefixReplaced` being one transition or from `ready` always having a cache.

- `/effort` during `ready` now goes to `idle`, so the band stops promising a warm cache the next request rewrites. The handoff stays on file.
- `/effort` during a running fork now ends it as "the conversation moved on", as a compaction or model switch already did. That fork's cost is spent and its handoff is not stored.
- A cold manual fork with no cache touch known ends `idle` instead of `ready`. The band showed nothing in either case, and the handoff is stored.

A value stored under the old state shape reads as the initial state, so a session that was off before this change is on again after it hot-reloads.

## Verified

- Each commit's tests passed as it was made, apart from one validate failure caught before any push and fixed in the commit that caused it.
- Removing `inProcess.isOff = false` from `/embers on` fails the new test.
- Live run: `claude --plugin-dir ./embers --debug --settings <scratch>`, Sonnet 5.5 at low effort, `ttlMinutes` 2, `marginMinutes` 1, `minContextTokens` 0, context about 33k.

| When | What | Result |
|---|---|---|
| 15:27 | first turn ends | band `embers  warm  handoff at 15:28` |
| 15:28:46 | fork | toast `embers: Handoff written; read 26k from cache, wrote 7.6k, 746 out`; band `embers  handoff ready  15:28, 33k tokens, warm until 15:30` |
| 15:29 | `/embers status` | `embers is on.` / `Cache: warm until 15:30.` / `Phase: handoff ready since 15:28.` / `Last fork: 15:28, read 26k from cache, wrote 7.6k, 746 out.` / `TTL: 2m for claude-sonnet-5-5 (configured).` / this root's handoff |
| 15:29 | `/embers off`, then status | `embers is off.`, `Phase: nothing scheduled.`, band gone |
| 15:29 | `/embers on`, then a second turn | band `embers  warm  handoff at 15:30` |
| 15:30:07 | fork after the second turn | toast `embers: Handoff written; read 34k from cache, wrote 0, 861 out` |

`handoffInstructions` was set to ask for a closing word. The stored handoff ended with that word, so the option reaches the prompt.

## Not verified

- The swap, the cold ask and the start offer were not run live this round; the brief's run does not cover them. The kit tests do, and they pass unchanged.
- A fork after a long multi-step turn is still unmeasured. The figures above follow short turns only.

The scratch session, pane, settings file, debug log and the run's store file are removed.
