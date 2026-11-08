# Brief 03: adversarial review of the embers implementation

You are the reviewer who challenged the design in brief 01. This is a read-only task: make no edits, commits, or new files except the one report named below.

## Where

Branch `feat/mod`, checked out at `/home/ayagmar/.cache/embers/worker`. Read it there. Do not touch `/home/ayagmar/projects/embers`.

## Read

1. `docs/briefs/02-status.md`: what the worker did, where it departed from the design, and what it could not verify.
2. `docs/DESIGN.md` (revision 2) and your own `docs/briefs/01-challenge-report.md`.
3. The mod: `embers/.claude-plugin/plugin.json`, `embers/types/index.d.ts`, `embers/hooks/register.tsx`, `handoff.ts`, `records.ts`, `shared.ts`, `embers.test.ts`.
4. `docs/reference/claude-code.d.ts` for any API claim, and `/home/ayagmar/.cache/embers/worker/embers/.claude-plugin/types/claude-code/index.d.ts`, the engine-laid copy.

## What to do

Try to break the implementation. In order:

1. Each of your findings B1, B2, M1 to M9, m1 to m6: is it fixed in the code, with the line that fixes it? Report only the ones that are not, or are fixed wrongly.
2. The four departures from the design in the status note. For each: is the worker's reason true against the types, and is the chosen replacement correct and the cheapest? In particular the `/clear` plus `$.session.append` swap: what does the person lose, what happens to the dropped prompt, to attachments, to a prompt typed during the swap, and can the old transcript really be resumed?
3. The paths the worker could not run live: the start offer, resume seeding, the reset after a person's `/clear`, TTL observation and override clearing, `/embers` on a cold cache, handoff-then-swap, fresh, `/effort` and `/model` while armed. Read them for bugs as if you were the only test.
4. Cost: any remaining path that forks on a cold prefix, forks twice in one idle period, names an effort, or swaps when sending would be cheaper.
5. State: any value held in a module variable that a reload loses, any store write without the captured session id, any `$.state` value not declared in the contract.
6. Tests: name any test that mirrors the implementation instead of a behavior, and any behavior above with no test that would catch its bug.

## Output

Write one report to `/home/ayagmar/.cache/embers/worker/docs/briefs/03-review-report.md`: findings by severity (blocker, major, minor), each with `file:line`, a concrete failure scenario, and the smallest fix. No nits. Then one verdict line: `MERGE`, `MERGE AFTER FIXES` (list them), or `DO NOT MERGE`. Reply in the chat with the report path only.
