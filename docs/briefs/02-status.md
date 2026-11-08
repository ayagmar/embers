# Brief 02 status: the embers mod

Branch `feat/mod`. Static checks and the eight tests pass, and the core loop worked in a live session: warm fork, cold ask, swap. Four parts of the design could not work as written and were changed; the owner should confirm two of them (see "Decisions for the owner").

## Done

- `embers/.claude-plugin/plugin.json`: the seven `userConfig` options with their defaults.
- `embers/types/index.d.ts`: `PluginState` for `embers.run`, and the `HandoffRecord` and `TtlRecord` store records, each with `v: 1`.
- `embers/hooks/`: `register.tsx` (the hooks), `handoff.ts` (timer, fork, cold path, swap, TTL observation, start offer, status), `records.ts` (store keys, the one validating reader, retention, TTL lookup), `shared.ts` (config, wording, the band line).
- `embers/hooks/embers.test.ts`: the eight tests from the brief. Each was checked by putting its bug back: all ten mutations tried were caught.

## Where the code departs from DESIGN.md, and why

1. **The swap is `/clear` plus an append, not a compaction.** The host refuses `$.session.compact` inside a `prompt.submit` hook ("it would compact under the turn this hook is holding") and inside a `command.run` hook. A compaction asked for from a timer skips every hook of the calling plugin, so embers cannot answer it, and core would summarize the cold prefix with a model call. The swap now runs `/clear`, then `$.session.append` writes the handoff and the last reply as the new conversation's first row. Same short prefix, no model call. The `session.compact` hook only watches: any main-loop compaction resets the cache touch.
2. **Swap and fresh drop the prompt.** Both run from `$.clock.after(0, …)` after the hook returns `{ drop }`. The engine puts a dropped prompt back in the box by itself (seen live), so embers does not fill it; the person presses Enter again. Resubmitting it as the plugin would skip `@file` expansion and images.
3. **"Effort changed while idle" is `/effort` run while armed.** No API reads the current effort level, so `effortAtTouch` is not kept; `/effort` disarms the timer. A `/model` change disarms through `classic.PostModelSwitch` and clears the cache touch.
4. **The engine-reported TTL** (`cache_ttl` on `classic.PostModelSwitch`) is stored as the same `ttl:<model>` record an observed TTL uses.

Also: `hooks.json` takes one module, so the split is by imports, not by listing more modules. `claude plugin validate` requires every function that takes `$` to be declared at the top level of a file of the mod. `embers/tsconfig.json` (extends the engine-laid types) exists locally but `.gitignore` excludes it, so it is not committed.

## Live run

`claude --plugin-dir ./embers --debug`, Fable 5.1 at medium effort, `ttlMinutes` 2, `marginMinutes` 1, `minContextTokens` 0. Context was about 35k tokens, almost all system prompt and tools.

| When | What | Figures |
|---|---|---|
| 03:30 | two prompts; band `embers  warm  handoff at 03:31` | |
| 03:31:50 | fork 1, toast `handoff written; cache_read_input_tokens 35k, output_tokens 794` | read 35,187, input 127, cache write 27, output 794, 10.5 s |
| 03:34:11 | cold prompt, `minSavingTokens` 0: sent without asking | context 35,292 < fixed 35,743: a short session has no `Messages` row and nothing to save |
| 03:34:34 | hot reload while armed: band kept `handoff at 03:35` | |
| 03:35:19 | fork 2, from the timer re-armed after the reload | read 35,225, input 127, cache write 27, output 431 |
| 03:38:39 | fork 3 | read 35,265, input 127, cache write 29, output 596 |
| 03:42:31 | new session with `minSavingTokens` -100000 to force the swap; fork | read 35,185, input 127, cache write 27, output 508 |
| 03:44:49 | cold prompt, idle 2m18s: ask `The prompt cache is cold (2m idle). Sending rewrites 35k tokens; swapping to the 03:42 handoff writes ~36k. …` with Swap to handoff / Send as is / Fresh session | |
| 03:44:57 | Swap: prompt dropped, `/clear`, handoff appended, toast `swapped 35k → ~36k tokens (handoff 369)` | |
| 03:45:25 | asked which one-word replies it gave: `one, two`, read from the handoff; no ask | engine line: in 1,187, out 23 |

The design's premise holds on Fable 5.1: every fork read the whole prefix from cache, with about 130 uncached input tokens. The store was empty at the end: the swap deleted its handoff and retention dropped the older ones. The live run found the doubled prompt (item 2), fixed in `a7dbd8d`. Editing a `--settings` file does not reload options; a restart does.

Debug logs: `~/.claude/debug/0d949e27-….txt`, `6f0de69e-….txt`, `e60e1877-….txt`.

## Not verified

- On this machine the organization plugin `cc-plugin-sec-default` bypasses every mod's `classic.SessionStart` hook. The start offer, the resume seeding and the reset after a person's `/clear` therefore never ran live. They are untested in the kit too.
- TTL observation and override clearing need a real 5-minute TTL; not seen live.
- `/embers`, `/embers status`, `/embers off`, the fresh path, handoff-then-swap, the `/effort` disarm and the model-switch path were not run live; only the swap and the timer paths were.
- Surfaces other than the terminal, and `-p` runs.

## Decisions for the owner

1. **Swap by `/clear` instead of compaction** (forced; item 1). A `/clear` gives a new session id and drops session-scoped state such as todos. The old transcript stays resumable with `--resume`. Recommendation: accept it; nothing else satisfies "no model call".
2. **The start offer depends on `classic.SessionStart`, which the security plugin bypasses here.** Recommendation: move the offer to `session.start`, gated by `startOffered` in `$.state`. That covers startup and resume alike, since `session.start` cannot tell them apart. It costs one offer on `--resume` too.
3. The saving check reads the fixed part as every `used` breakdown row except the one named `Messages`. The types say to branch on `kind`, not `name`, but no `kind` separates conversation from system. If the row is renamed, the check sees no saving and always sends, which is the safe direction.
