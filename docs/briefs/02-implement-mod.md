# Brief 02: implement the embers mod

You are the worker. You implement the mod described in `docs/DESIGN.md` revision 2.

## Where

Worktree `/home/ayagmar/.cache/embers/worker`, branch `feat/mod`, of the repository `/home/ayagmar/projects/embers`. Work only in that worktree. Commit as you go with Conventional Commit messages, one logical change per commit, no attribution trailers. Push the branch when done and reply with the branch name and the path of a short status note at `docs/briefs/02-status.md` (done, not done, what you could not verify).

## Read first

1. `docs/DESIGN.md`: the design, including the scope filters, state model and config table. It is the contract. If you find a better way than the design states, take it and say why in the status note and the commit message.
2. `docs/briefs/01-challenge-report.md`: why the design is shaped as it is. Every finding there is a bug you must not reintroduce.
3. Load the `plugin-authoring` skill (`/plugin-authoring`). It names where this build's types are written and how `claude plugin validate`, `tsc -p` and `claude plugin test` work. `docs/reference/` holds a copy of the same material for grep.
4. `docs/reference/examples/band.tsx`, `pane.tsx`, `tool-call.ts` and `pane.test.tsx`: complete working mods and one test.

## Files

- `embers/.claude-plugin/plugin.json`: exists; add `userConfig` for the seven options with their defaults and one-line descriptions.
- `embers/hooks/hooks.json`: exists.
- `embers/hooks/register.tsx`: the module. Split into more modules under `embers/hooks/` if it passes about 400 lines; `hooks.json` lists them.
- `embers/types/index.d.ts`: the `PluginState` contract for every `$.state` value, and the stored record types, each with a `v` field.
- `embers/hooks/*.test.ts`: tests, see below.

## Standards

- Strict TypeScript, no `any`, no non-null assertions, no casts to silence the compiler. Narrow on the event's fields.
- No implicit state: nothing a reload would lose except the timer handle, which `session.start` re-arms from `$.state`. No module variable holds anything the design puts in `$.state` or `$.store`.
- Every `$.store` read validates the record's `v` and shape through one function; failure means absent and delete.
- Capture session id, root and turns before every `await` that a `/clear` could interleave with, and bind the result to the captured values.
- Every hook that can throw is given `.catch` so a failure lets the prompt or the compaction through untouched, never blocks it.
- Cost visibility: every fork and swap toasts the token figures named in the design.
- No fallbacks, compatibility layers, or helpers beyond what the design needs.

## Tests

Fewer, stronger tests, each named for the bug it catches. Write these, in `claude plugin test` form, and no others unless a bug you fixed needs a regression test:

1. A cold prompt with a matching handoff: the compaction gets the marker, the hook answers with the handoff plus last assistant text, no model call, the prompt enters.
2. A cold prompt with a handoff whose turn count no longer matches: no swap; the ask offers handoff-and-swap, send and fresh.
3. A prompt within the TTL of a warm fork (fork at 55m, prompt at 70m): passes through, no ask.
4. A subagent's `turn.complete` and a `/loop` or task-notification prompt: ignored, timer and `lastCacheTouch` unchanged.
5. The timer firing after the wall clock passed the TTL (slept laptop): no fork, nothing stored, toast says skipped.
6. A `userConfig` reload while armed: the deadline survives and the timer re-arms once.
7. `/compact` typed by the person: the mod's compact hook calls `next(e)`.
8. Store retention: a record with the wrong `v` is treated as absent and deleted; the newest per root and branch survives.

## Verify before you stop

- `claude plugin validate embers`
- `tsc -p embers` with the types the engine laid, or the tsconfig the skill describes if they are not there yet
- `claude plugin test embers`
- A live run: `claude --plugin-dir ./embers` from the worktree, in a scratch session, with `ttlMinutes` set to 2 and `marginMinutes` to 1, context threshold 0: send two prompts, wait for the fork, read the toast's `cache_read_input_tokens`, wait past the TTL, send a prompt, take swap. Record every figure in the status note. If the fork's cache read is near zero, stop and write that in the status note; the design's premise is then wrong for this model and the owner must decide.

Do not publish, do not merge, do not touch `main`.
