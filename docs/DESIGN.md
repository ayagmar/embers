# embers: design

## Problem

Claude Code sends the whole conversation on every request. The API serves the unchanged prefix from a prompt cache at a tenth of the input price, but the cache entry lapses after an idle period (the TTL: one hour on this account, five minutes under overage or on other plans). The first request after a lapse writes the whole prefix again at 1.25 times the input price. On a 100k-token session that is the single most expensive request of the day, and it buys nothing: the next request is warm again.

Two things make it worse:

- You cannot tell at send time that the cache is cold, and once it is cold, every way of shrinking the context (a summary, a handoff, compaction) also reads the cold prefix.
- Writing a handoff for every idle session is a waste when you never come back to it.

## What embers does

1. **Warm handoff.** When a turn ends on a session whose context is above a size threshold, embers arms one timer for TTL minus a margin. If the session is still idle when it fires, embers asks the model for a handoff with `$.model.fork`. A fork rides the main thread's cached prefix, so it costs the handoff's output tokens plus a few hundred input tokens. The handoff is stored in `$.store` under project root and session id, with the time and the context size. The timer does not re-arm until the next turn ends.

2. **Cold swap.** On `prompt.submit`, embers compares the time since the last turn with the TTL.
   - Under the TTL: the prompt passes through, nothing drawn, nothing logged.
   - Over the TTL with a handoff on file: embers compacts the conversation to the handoff (its own `session.compact` hook answers with the stored messages, so no model call) and lets the prompt enter on the short prefix.
   - Over the TTL without a handoff: embers holds the prompt and offers three choices in the band: send anyway (cold reload once), handoff then swap (one cold fork, then compact), or fresh (`/clear`, then the prompt enters first). The typed text is never lost.

3. **Handoff on start.** When a session starts in a project where a previous session left a handoff, embers offers to load it. This turns the handoff written for a session you abandoned into the project's status note.

4. **Self-correction.** Every fork result carries `usage.cache_read_input_tokens`. Near zero after an idle shorter than the configured TTL means the real TTL is shorter. embers records the observed TTL per model in `$.store`, shortens its margin to fit, and shows the observation in the band.

## Rules that keep it cheap

- One fork per idle period, never more. An abandoned session costs one handoff.
- Nothing happens below the context threshold. A cold reload of a small context is cheaper than any of this.
- The fork names no `effort`. On a model without per-message effort, a named effort rewrites the whole conversation into a new cache entry. The handoff prompt asks for haste in words instead.
- The fork's prompt is short and fixed, so the uncached tail is a few hundred tokens.
- No timer is armed in a `-p` run, under an SDK host, or when the band cannot be drawn and mode is `ask`.

## Configuration (`userConfig`)

| key | type | default | meaning |
|---|---|---|---|
| `ttlMinutes` | number | 60 | assumed cache lifetime |
| `marginMinutes` | number | 5 | how long before the TTL the handoff is written |
| `minContextTokens` | number | 40000 | below this, embers does nothing |
| `coldMode` | `ask` / `swap` / `send` / `off` | `ask` | what to do on a cold prompt with no handoff on file; with a handoff on file, `ask` and `swap` both swap |
| `offerOnStart` | boolean | true | offer the last handoff of this project on session start |
| `showBand` | boolean | true | draw the band above the prompt |

An observed TTL shorter than `ttlMinutes` overrides it for that model until a warm fork is observed again.

## UI

- **Band** above the prompt, drawn only when the context is above threshold:
  - warm: `embers  warm  handoff in 48m`
  - written: `embers  handoff ready  written 12:04, 118k tokens`
  - cold with a choice: `embers  cold  [send anyway] [handoff and swap] [fresh]`
  - observed TTL: `embers  cache lapsed after 5m, margin now 4m`
- **Toast** once per handoff or swap, with tokens read from cache and tokens written.
- **Commands**: `/embers` writes a handoff now; `/embers status` shows the store for this project; `/embers off` disables for this session.
- **Status line**: nothing. The band is enough.

## State

- `$.state` (session): phase (`idle`, `armed`, `writing`, `ready`, `cold-asking`), the armed timer's cancel, the last turn's end time and context size, the held prompt during `ask`.
- `$.store` (across sessions): handoffs by project root and session id; observed TTL by model.
- Every value is declared in `types/index.d.ts`; a missing or old-shaped stored value is treated as absent, never patched in place.

## Open questions for the challenger

1. Can `$.session.compact` be called from inside a `prompt.submit` hook, or must the hook drop the prompt, compact, then `$.prompt.submit` the held text?
2. Is a fork at the timer served from cache on Fable when effort rides the message? What do the fork's usage numbers show on the first real run?
3. How does the mod know the context size at `turn.complete`? `e.usage` gives the last request's input plus cache reads; is that the right figure, or should it read `$.session.measure`?
4. What happens to an armed timer across a hot reload of the mod? Module variables reset, `$.state` stays; the timer's cancel handle is not serializable.
5. After a swap, the first request writes a new short prefix. Is there any case where the swap costs more than sending cold? (A session you were about to end anyway.)
6. Should `offerOnStart` key on project root alone, or on root plus branch?
