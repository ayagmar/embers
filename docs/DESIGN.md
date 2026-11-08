# embers: design

Revision 2, after the challenge in `briefs/01-challenge-report.md`. Line references `d.ts:<n>` point into `reference/claude-code.d.ts`.

## Problem

Claude Code sends the whole conversation on every request. The API serves the unchanged prefix from a prompt cache at a tenth of the input price, but the entry lapses after an idle period (the TTL: one hour on this account, five minutes under overage or on other plans). The first request after a lapse writes the whole prefix again at 1.25 times the input price. On a 100k-token session that is the most expensive request of the day, and it buys nothing: the next request is warm again.

Two things make it worse:

- You cannot tell at send time that the cache is cold, and once it is cold, every way of shrinking the context (a summary, a handoff, compaction) also reads the cold prefix.
- Writing a handoff for every idle session is a waste when you never come back to it.

## What embers does

1. **Warm handoff.** When a main-loop turn ends on a session whose context is above a size threshold, embers arms one timer for TTL minus a margin. If the session is still idle when it fires, embers asks the model for a handoff with `$.model.fork`. A fork rides the main thread's cached prefix, so it costs the handoff's output tokens plus a few hundred input tokens. A cache read also renews the entry, so the fork keeps the prefix warm for one more TTL. The handoff is stored in `$.store`, bound to the session id and turn count it was written from.

2. **Cold prompt.** On a person's `prompt.submit` on the main loop, embers compares the time since the last cache touch (the last main-loop turn end, or a later fork that read the cache) with the TTL.
   - Under the TTL: the prompt passes through. Nothing drawn, nothing logged.
   - Over the TTL: embers asks, inside the hook with `$.ui.ask`. The choices:
     - **swap** (first, offered only when a handoff is on file and matches the session id and turn count): the hook drops the prompt; from `$.clock.after(0, …)` embers runs `/clear`, appends the handoff and the last reply as the new conversation's first row with `$.session.append`, and deletes the handoff. The person sends the prompt again from the box, and it enters on the short prefix. No model call.
     - **send**: `next(e)` with the prompt intact; it enters cold and the cache rewarms on that request.
     - **fresh**: the hook drops the prompt and runs `/clear` from `$.clock.after(0, …)`; the person sends it again.
   - Swap and fresh drop the prompt because the host refuses both a compaction and a command under the turn a `prompt.submit` hook holds (`d.ts:3236`). A compaction from the timer instead runs past the calling plugin's own `session.compact` hook, so core would summarize the cold prefix with a model call. `docs/probes/compact-in-prompt-submit` is a kit test that shows both. The engine puts a dropped prompt back in the box by itself; attachments must be pasted again, and the drop reason says so. Until the swap or fresh start ends, a prompt sent again is dropped with `embers: still swapping; send again when it says done`.
   - The swap's `/clear` gives a new session id. Its toast names `claude --resume <old id>`, which returns to the old conversation, and the handoff text is logged to the transcript, where the person can read it and the model does not.
   - Without a matching handoff the ask offers only send and fresh. Writing a handoff at that point would itself reread the whole cold prefix P at the cache-write price, the same 1.25 × P that sending pays, and the swap would then write the short prefix S at 1.25 × S on top. Sending leaves P warm, read at 0.1 × P per later request. For P = 100k and S = 25k the swap adds about 31k token-equivalents now to save 7.5k per later request: it pays back only after four or more.
   - The question states each choice's size: `The prompt cache is cold (65m idle). Sending rewrites 100k tokens; swapping to the 12:55 handoff writes ~25k; a fresh session writes ~20k (paste attachments again). What now?` Without a handoff the swap clause is left out.
   - `coldMode` `swap` skips the ask when a matching handoff is on file. `send` and `off` never ask. If the ask rejects (dismissed, non-interactive), the prompt is sent.
   - The swap is skipped, and the prompt sent, when the saving is small: context tokens minus (system and tools tokens plus handoff tokens) below `minSavingTokens`. The system and tools figure comes from `$.session.usage({ breakdown: "summary" })`.

3. **Handoff on start.** When an interactive session starts with no turns yet (not under `-p`, not a resumed conversation) in a project where a previous session left a handoff older than the TTL on the same branch, embers offers it once per session (`startOffered`, which survives a reload). The check runs in `session.start`; the classic `SessionStart` hook is not used, since an organization plugin can bypass it. Loading appends it as a user message with `$.session.append` and deletes it. Skip records `offeredAt` on the handoff, so it is not offered again. The offer shows the handoff's time and branch.

4. **TTL observation.** embers reads the TTL from the engine where it says it (`cache_ttl` on the classic model-switch hooks, `d.ts:8239`) and otherwise observes it from the main loop's first response after an idle: a near-zero `cache_read_input_tokens` after an idle shorter than the configured TTL, on the same model, means the real TTL is shorter. A reload, an MCP reconnect or a changed system prompt also makes one read cold, so the first observation is only held in `$.state.lapse`; a second on the same model, in a later idle period, stores the TTL per model, where it overrides the configured one. A warm read after an idle longer than a held or stored TTL clears it. Reads are skipped when the model changed since the last cache touch, or after `/effort`. Fork results are not used for this: a cold fork can also follow `/model` or a late timer.

## Rules that keep it cheap

- One fork per idle period. The timer does not re-arm until the next main-loop turn ends. An abandoned session costs one handoff.
- Nothing happens below `minContextTokens`. The size is `(await $.session.usage()).context.tokens` read in the main-loop `turn.complete`; absent (right after a compaction) counts as below threshold. `e.usage` on `turn.complete` sums every response of the turn and is the wrong figure.
- The fork names no `effort`. On a model without per-message effort, a named effort rewrites the whole conversation into a new cache entry. The handoff prompt says there are no tools and asks for a direct answer without deliberation, so the uncached tail is a few hundred tokens.
- The fork is skipped when the effort level changed while idle, when a turn is running, when the session is not interactive, and when the wall clock says the cache has already lapsed (a laptop that slept through the deadline). A skipped fork writes nothing.
- `/embers` on a cold cache says so and asks before forking.
- Every fork and swap toasts its `cache_read_input_tokens`, `output_tokens` and, for a swap, the tokens before and after, so the cost is visible.

## Scope filters

- Act on the main loop only: every hook returns `next(e)` first when `e.agentId !== undefined`.
- At `prompt.submit`, act only when `!e.command`, `!e.turnId`, `!e.isMeta`, and `e.origin` is absent or its kind is `composer` or `bridge`. Slash commands, queued prompts, task notifications, `/loop`, peers and plugins pass through untouched.
- The `session.compact` hook only watches: every compaction gets `next(e)`, and a main-loop one that stands resets the cache touch, since the next request writes a new prefix.

## State

`$.state` (session, JSON only, survives hot reload):

- `phase`: `idle` | `armed` | `writing` | `ready`
- `lastCacheTouch`: epoch ms of the last main-loop turn end or warm fork
- `contextTokens`: from the last main-loop `turn.complete`, or absent
- `deadline`: epoch ms the timer should fire, while `armed`
- `effortAtTouch`: the effort level at the last turn end
- `startOffered`: whether the start offer was shown this session

The timer handle lives in a module variable. `session.start` (which fires on reload too) re-arms from `deadline` when `phase` is `armed` and the deadline is still ahead. The timer is cancelled at main-loop `prompt.submit` and `turn.start`. When it fires, it re-reads `$.state` and the clock before forking.

`$.store` (across sessions), one key per record, no index:

- `handoff:<root>:<sessionId>`: `{ v: 1, root, branch, sessionId, turns, writtenAt, contextTokens, text, lastAssistant }`. `lastAssistant` is the last assistant message's text, taken from `$.session.messages()` before the fork, because the fork's view ends at the last request and never sees the final reply. The swap appends it after the handoff.
- `ttl:<model>`: `{ v: 1, observedMinutes, observedAt }`.

Retention: a handoff is deleted when swapped to, loaded, or overtaken by a later main-loop turn of its own session. Per root and branch, an older handoff than the newest is dropped once it is older than twice the TTL; a younger one may belong to another session still open in the same checkout. Records older than 14 days are dropped. Both run on session start and after each handoff is written. Every read validates `v` and shape; a record that fails is treated as absent and deleted.

Session id, root and turns are captured before every await and bound to the record; `/clear` mid-fork must not store the old conversation under the new id.

Resume: `session.start`, when `lastCacheTouch` is unset, reads the session's own handoff and, when its turn count still matches, seeds `lastCacheTouch` from `writtenAt` and `contextTokens` from the record. A matching handoff is the only case where a swap is possible. `context.tokens` is absent until the first response of a resumed process, so the cold path falls back to the seeded `contextTokens`. Classic hooks are not used for this: an organization plugin can bypass a mod's `classic.*` hooks.

## Configuration (`userConfig`)

| key | type | default | meaning |
|---|---|---|---|
| `ttlMinutes` | number | 60 | assumed cache lifetime; overridden by an engine-reported or observed TTL |
| `marginMinutes` | number | 5 | how long before the TTL the handoff is written |
| `minContextTokens` | number | 40000 | below this, embers does nothing |
| `minSavingTokens` | number | 20000 | a swap must shrink the prefix by at least this |
| `coldMode` | `ask` / `swap` / `send` / `off` | `ask` | see "Cold prompt" |
| `offerOnStart` | boolean | true | offer the last handoff of this root and branch on session start |
| `showBand` | boolean | true | draw the band above the prompt |

A `userConfig` change reloads the mod; the state above survives it.

## UI

- **Band** above the prompt, drawn only when the context is above threshold and `showBand` is on, redrawn on state changes only (absolute times, no countdown):
  - armed: `embers  warm  handoff at 12:55`
  - writing: `embers  writing handoff…`
  - ready: `embers  handoff ready  12:55, 118k tokens, warm until 13:55`
  - ttl observed: `embers  cache lapsed after 5m  margin now 4m`
- **Ask** (`$.ui.ask`) on a cold prompt, with the options above and one line of cost: the context size, what sending cold costs, what the swap costs.
- **Toast** once per handoff, swap or skipped fork, with the token figures.
- **Commands**: `/embers` writes a handoff now (asks first if the cache is cold); `/embers status` lists this root's handoffs and the observed TTL; `/embers off` disables for this session.
- **Status line**: nothing.

## Not in scope

Keeping the cache alive beyond the one touch the handoff fork makes. Subagent sessions. Non-interactive runs beyond doing nothing in them.
