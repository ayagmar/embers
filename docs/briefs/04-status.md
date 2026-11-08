# Brief 04 status: review round 1 fixes

Branch `feat/mod`. All seven major findings and the five minor ones are fixed, one commit each. The test changes the brief asked for are in. A live run found one more bug, now fixed: after any `/clear`, embers stopped arming. `claude plugin validate embers`, `tsc -p embers` and `claude plugin test embers` (17 tests) pass.

## Done

| Finding | Commit | What changed |
|---|---|---|
| 1 margin | `6d3589b` | `marginFor = min(margin, max(1, ttl/5))`: fork at 4m for a 5m TTL, 55m for 60m |
| 2 model change | `6bf6758` | `modelAtTouch` kept at `turn.complete`; the timer and `turn.step` act only on the same model; `/effort` also clears the cache touch. `classic.PostModelSwitch` stays as a bonus |
| 4 handoff-and-swap | `a872d2e` | Option removed. The cold ask is Swap (only with a matching handoff), Send, Fresh, and states each size. DESIGN "Cold prompt" updated with the cost reasoning |
| 3 second prompt | `b5a5f35` | A prompt sent while a swap or fresh start runs is dropped: `embers: still swapping; send again when it says done`. Fresh now toasts when done |
| 5 resume | `63d99bf` | `session.start` seeds the cache touch and context size from the session's own matching handoff; the cold path uses `context.tokens ?? contextTokens`. Classic resume branch removed |
| 6 `/clear` reset | `8812b56` | `session.end` with `reason: 'clear'` resets. The test file is now `.tsx` so tests can mount the band |
| 7 start offer | `9211ab2` | Offer runs from `session.start`, gated by `offerOnStart`, `e.isInteractive`, `turns() === 0` and `startOffered`; Skip records `offeredAt` on the handoff, which is then not offered again. `classic.SessionStart` hook removed |
| 8 compaction refusal | `5fea361` | Proven, see below. The `/clear` swap stays |
| 9 resume id, log | `a0e2aed` | Swap toast ends `Old conversation: claude --resume <old id>`; the handoff text is `$.ui.log`ged to the transcript |
| 10 retention | `22eb394` | A superseded handoff is dropped only once older than 2 × TTL |
| 11 one cold read | `fb98841` | First cold read is held in `$.state.lapse` (`isPending`, with its model and idle period); a second on the same model in a later idle period stores `ttl:<model>`. A warm read past it drops a held or stored TTL |
| 12 `/embers` while writing | `63c0bf3` | `/embers` refuses while `writing`; every early return of `writeHandoff` leaves the phase `idle` (a moved-on return only when the phase is still `writing`) |
| Tests | `e90bc51` | Reload test now loses the old timer and fails without the re-arm; raw `$.state` assertions replaced by band line and fork count; Fresh test |
| Found live | `13eea56` | `isInteractive` and the swap-in-flight flag moved to module variables (see below) |
| Docs | `eb11c6b` | DESIGN state list, margin row and band wording match the code |

Every new or changed test was checked by putting its bug back; each mutation failed the test it is named for. The brief's test list maps to: `a 5m TTL forks the handoff near its end…`, `a model change while idle forks nothing…`, `a prompt sent again while the swap runs…`, `a resumed session with its handoff on file…`, `a /clear typed by the person drops the old band and timer, and the next turn arms again`, `the start offer shows only at a fresh interactive start, and not again after Skip`, `a shorter TTL is stored after cold reads in two idle periods, and cleared by a warm read past it` (override clearing), `/embers on a cold cache asks…`, `Fresh at a cold prompt clears the session…`.

## Finding 8: compaction inside `prompt.submit`

A kit test inside embers cannot call `$.session.compact`: the host refuses calls the module's own source does not make (`$.session.compact refused: its hooks module does not call it`). The evidence is a small probe plugin kept at `docs/probes/compact-in-prompt-submit/` (`claude plugin test docs/probes/compact-in-prompt-submit` passes). It shows:

- From a `prompt.submit` hook the host rejects with: `HooksError: compact-probe: session.compact: called from a prompt.submit hook, it would compact under the turn this hook is holding; call it from a later event (turn.complete) (host check)`.
- From a timer the hook leaves, the compaction runs, but the calling plugin's own `session.compact` hook does not, so core would summarize the cold prefix with a model call.

So the `/clear` and append swap stays, with the prompt dropped and sent again.

## Found in the live run: `/clear` starts `$.state` over

After the first swap, the next turn left the phase `idle` and no band. `/embers` still forked, so `context.tokens` was present: `isInteractive` read false. `$.state` starts over under the new session id after a `/clear`, and no `session.start` follows to set it again. Before `13eea56`, embers stopped arming for the rest of the process after any `/clear`, whether the swap's or the person's. `isInteractive` and the swap flag are now module variables: a `/clear` leaves them alone, and a reload starts them over (when `session.start` sets `isInteractive` again). The `/clear` test now starts the state over as the host does.

Consequences that remain: `isOff` (`/embers off`) and `startOffered` live in `$.state`, so they also start over after a `/clear`. A `/clear` raises no `session.start`, so the offer is not shown again. `/embers off` has to be typed again after a `/clear`.

## Live run

`claude --plugin-dir ./embers --debug --settings <scratch>` from the worktree, Sonnet 5.5 at high effort, `ttlMinutes` 2, `marginMinutes` 1, `minContextTokens` 0, `minSavingTokens` -100000. Context was about 33k to 35k tokens, almost all system prompt and tools. The `isInteractive` fix was hot-reloaded into the running process at 04:13:40, between the two cycles.

| When | What | Figures |
|---|---|---|
| 04:08:04.32 | turn 1 ends; band `embers  warm  handoff at 04:09` | |
| 04:09:04.34 | timer fires, 60.0 s after the turn (TTL 2 − margin 1) | fork read 25,874, input 127, cache write 7,596, output 937, 6.98 s; toast `handoff written; cache_read_input_tokens 26k, output_tokens 937`; band `handoff ready 04:09, 33k tokens, warm until 04:11` |
| 04:11:24 | cold prompt after 2m idle; ask: `The prompt cache is cold (2m idle). Sending rewrites 33k tokens; swapping to the 04:09 handoff writes ~34k; a fresh session writes ~34k (paste attachments again). What now?` with Swap to handoff / Send as is / Fresh session | |
| 04:11:30.618 | Swap: dropped; `/clear` queued .666; embers' own `session.end` ran .695; append .728; log .739; toast .744 (126 ms in all) | toast `swapped 33k → ~34k tokens (handoff 666); send your prompt from the box. Old conversation: claude --resume ce9b7251-…` |
| 04:11:56 | prompt sent from the box, unasked; the model answered `one` from the handoff | in 1,187, out 19 |
| 04:11:57 | **bug**: phase `idle`, no band after this turn (`/embers status`) | |
| 04:12:32 | `/embers`, cache judged cold, written | fork read 27,015, input 127, cache write 7,590, output 991 |
| 04:13:56.01 | after the fix reloaded: turn ends; band `warm  handoff at 04:14` | |
| 04:14:56.02 | timer fires, 60.0 s after the turn | fork read 34,811, input 127, cache write 3, output 1,166 |
| 04:17:15 | cold prompt; same three choices, `rewrites 35k … 04:15 handoff writes ~35k; a fresh session writes ~34k` | |
| 04:17:24.386 | Swap: dropped | |
| 04:17:24.422 | second Enter: dropped with `embers: still swapping; send again when it says done` (36 ms later, before the `/clear` at .427) | |
| 04:17:24.499 | swap toast, `swapped 35k → ~35k tokens (handoff 824) … claude --resume e55459fc-…` | |
| 04:17:24.542 | a later Enter sent the prompt unasked; answer `two` from the handoff; band re-armed `warm  handoff at 04:18` | in 1,181, out 20 |
| 04:17:32 | `/clear` typed by hand: band gone | |
| to 04:18:40 | no fork and no toast at the old 04:18:25 deadline | |

In the first cycle the second Enter (04:11:30.567) arrived before the drop and never reached `prompt.submit`; the second cycle hit the window with a burst of Enter presses.

Debug logs, left in place: `~/.claude/debug/ce9b7251-69b1-4297-ad0c-ee7cdef90f87.txt` (first conversation), `e55459fc-c364-4b2c-a480-084e27741623.txt` (after swap 1), `9bacf46a-ec66-4a79-a141-c279914a57f7.txt` (after swap 2), `4e683ea6-9dab-4601-8354-4f7ba7b0001e.txt` (after the hand `/clear`). The scratch session and its pane are closed. The scratch settings file is gone. So is the embers store file, `~/.claude/plugins/store/embers_inline-715873254c11.json`, which held `{}` at the end.

## Not verified

- Resume (`claude --resume` with a matching handoff on file) and the start offer were not run live; both are covered only by kit tests.
- A real 5-minute TTL, so TTL observation and override clearing were not seen live.
- `/model` and `/effort` while armed, Fresh, and `/embers` while a fork runs were not run live.
- Whether a swap in flight survives a hot reload: a reload now ends the refusal, on the assumption that the swap dies with the module.
- Surfaces other than the terminal, and `-p` runs.

## Open points for the owner

1. **Fork cache writes.** Forks 1 and 3 wrote about 7.6k tokens to the cache each; fork 2 wrote 3. The design assumes a few hundred uncached tokens; the brief 02 run saw 27 to 29. Not explained yet. The 7.6k forks were the first of a conversation.
2. **Handoff in the transcript.** The engine shows a `$.ui.log` line up to its first 2,000 characters on the terminal and adds a notice line when it cuts one. The live handoff was 2,852 characters, so the transcript showed it cut and the notice. Options: leave it, or log a shorter text.
3. **Size estimate.** The summary breakdown put the fixed part (~34k) above the live context (33k), so the ask said Fresh writes ~34k against 33k for sending. That is harmless at the default `minSavingTokens`, which skips the ask, but the figures can read oddly on small sessions.
4. Manifest warnings from `claude plugin validate`: no `author`, no icon. Left for the owner, since both are publishing metadata.
