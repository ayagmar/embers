# Brief 08: adversarial review of the sweep

Read-only: make no edits, commits or files except the report named below.

## Where

Branch `refactor/sweep`, checked out at `/home/ayagmar/.cache/embers/sweep`. Compare against `main` (`git diff main...HEAD`). Do not touch `/home/ayagmar/projects/embers`.

## Read

1. `docs/briefs/07-sweep.md` (the brief) and `docs/briefs/07-status.md` (what the worker did, where it departed, three behaviour changes).
2. `docs/briefs/03-review-report.md` and `05-recheck-report.md`: the invariants earlier reviews established. Any of them broken by the refactor is a blocker.
3. The mod under `embers/`: `types/index.d.ts`, `hooks/state.ts`, `process.ts`, `register.tsx`, `handoff.ts`, `records.ts`, `shared.ts`, `embers.test.tsx`. `docs/reference/claude-code.d.ts` for API claims.
4. `README.md`.

## What to do

1. **Invariants.** For each: still holds, with the line, or broken, with a failure scenario. One fork per idle period. Timer deadline in state, handle in `process.ts`, re-armed on reload. Session id and turns captured before the fork and re-checked after. A prompt during a swap is refused. `/clear` starts the state over and nothing arms from stale state. No fork or TTL observation after a model change. The compaction hook answers only its own marker and otherwise passes through. Retention never deletes a live session's handoff. Nothing happens below `minContextTokens` or under `-p`.
2. **The state machine.** Is every transition total and pure? Is any phase reachable with a contradictory payload? Is there any remaining hand-written `$.state` spread outside `state.ts`? Can an old `run-1` value, or a reload mid-`writing`, leave the band or the timer lying?
3. **The three behaviour changes** in the status note: acceptable, or a regression?
4. **Types and lint.** Any `string` where a union fits, any cast, any `as`, any non-exhaustive switch that `tsc` would not catch. Whether Biome's config actually enforces what the brief asked.
5. **README.** Anything untrue against the code, anything missing a first-time user needs, anything verbose. Nothing else.
6. **Tests.** Any test that now mirrors implementation; any behaviour above with no test that would catch its bug.

## Output

Write `/home/ayagmar/.cache/embers/sweep/docs/briefs/08-review-report.md`: findings by severity (blocker, major, minor) with `file:line`, failure scenario and smallest fix; no nits; one verdict line `MERGE`, `MERGE AFTER FIXES` (list) or `DO NOT MERGE`. Reply in the chat with the report path only.
