# Brief 04: fix the review findings on the embers mod

You are the worker for the fix round. A previous worker implemented the mod on branch `feat/mod`; a reviewer found seven things to fix before merge.

## Where

Worktree `/home/ayagmar/.cache/embers/worker`, branch `feat/mod`, of the repository `/home/ayagmar/projects/embers`. Work only there. Commit with Conventional Commit messages, one logical fix per commit, no attribution trailers. First commit the untracked `docs/briefs/03-review-mod.md`, `03-review-report.md` and this brief as `docs: review round 1 briefs and report`. Push when done. Reply with the path of `docs/briefs/04-status.md` (done, not done, what you could not verify, with every figure from any live run).

## Read first

1. `docs/briefs/03-review-report.md`: the findings. Fix 1 to 7 and the test findings. Findings 8 to 12 are listed below with what to do.
2. `docs/briefs/02-status.md`: what the previous worker did and why it departed from the design.
3. `docs/DESIGN.md` and `docs/briefs/01-challenge-report.md` for the reasoning.
4. Load the `plugin-authoring` skill (`/plugin-authoring`) for the build's types and the validate, type-check and test commands. `embers/.claude-plugin/types/` holds the engine-laid types; `embers/tsconfig.json` exists locally and is gitignored.
5. The mod: `embers/hooks/register.tsx`, `handoff.ts`, `records.ts`, `shared.ts`, `embers.test.ts`, `embers/types/index.d.ts`.

## Decisions already taken by the owner's delegate

- **Finding 4: remove the "Write handoff, swap" option.** The cold ask offers Swap (only when a matching handoff is on file), Send, and Fresh. Without a matching handoff it offers Send and Fresh. Update the question's wording and the design's "Cold prompt" section in `docs/DESIGN.md` to match. The `/embers` command keeps its own cold-cache ask.
- **Finding 7: move the start offer to `session.start`**, gated by `startOffered`, `e.isInteractive`, and `$.session.turns() === 0`. Skip records `offeredAt` on the handoff so it is offered once. Keep nothing in `classic.SessionStart` that the mod depends on; it is bypassed on this machine. The classic `PostModelSwitch` hook may stay as a bonus but is not the guard (finding 2).
- **Finding 8: prove or disprove the compaction refusal.** Write a kit test that calls `$.session.compact({ instructions: 'embers:test' })` from inside a `prompt.submit` hook and records what the host answers. If it rejects, keep the `/clear` swap, quote the rejection text in the status note, and keep the test as documentation of why. If it works, switch the swap back to compaction with the mod's own `session.compact` hook answering with the handoff, as `docs/DESIGN.md` describes, and drop the drop-and-resend dance for Swap. Fresh keeps the drop.
- **Finding 9**: put the old session id in the swap toast as `claude --resume <id>` and `$.ui.log` the handoff text to the transcript.
- **Finding 10**: in the newest-per-group retention rule, drop only records older than twice the TTL.
- **Finding 11**: hold a TTL observation in `$.state.lapse` first; write the `ttl:<model>` store record only on a second cold observation in a later idle period.
- **Finding 12**: `/embers` refuses while the phase is `writing`; every early return of `writeHandoff` sets the phase to `idle`.

## Tests

Fix the reload test so it fails without the re-arm in `session.start` (abort the first wait's signal before the second `session.start`). Replace raw `$.state` assertions with behavior: fork count, toast text, band line. Add one test each for: the fork time under a 5m override; a model change before the timer and before the first step; a second prompt during a swap; resume with `context.tokens` absent and a matching handoff; `/clear` reset through `session.end`; the start offer's gates and Skip; override clearing; `/embers` on a cold cache; Fresh. Each test is named for the bug it catches. Nothing else.

## Verify before you stop

- `claude plugin validate embers`, `tsc -p embers`, `claude plugin test embers`, all clean.
- A live run as in brief 02 (`claude --plugin-dir ./embers --debug` from the worktree, `ttlMinutes` 2, `marginMinutes` 1, `minContextTokens` 0, `minSavingTokens` -100000): confirm the fork fires at the computed time, the cold ask shows Swap, Send and Fresh, Swap works, a second Enter during the swap is refused with the message, and `/clear` by hand resets the band. Record the figures. Close the scratch session and remove scratch files when done; leave `~/.claude/debug` logs in place and name them.

Do not publish, do not merge, do not touch `main`.
