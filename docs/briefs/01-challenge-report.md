# Brief 01 report: challenge of the embers design

Reviewed `docs/DESIGN.md` against `docs/reference/claude-code.d.ts` (cited as `d.ts:<line>`), `docs/reference/plugin-authoring-reference.md` (cited as `ref:<line>`) and the two example mods. Nothing was run; every claim below is from the types or the reference text, except where marked as API behaviour or "verify on first run".

## Findings

### Blocker

**B1. The swap uses a handoff without checking that it still describes the conversation.**
- Gap: DESIGN.md:18 swaps whenever a handoff is "on file" for this session. Nothing ties the handoff to the transcript state it was written from.
- Evidence: the timer is lost on every hot reload and config change (`d.ts:3592`, `ref:73-74`). `/embers` writes a handoff on demand (DESIGN.md:54). Store keys are root plus session id only (DESIGN.md:14).
- Failure: the person runs `/embers` at 11:00, works three more turns, saves the mod (reload drops the timer), and goes to lunch. At 13:00 the cold prompt finds the 11:00 handoff and compacts to it. The three turns disappear from the model's context without a word.
- Fix: capture `$.session.id()` and `$.session.turns()` (`d.ts:2916`) before the fork starts, and store them with the handoff. At submit time, swap only if both still match. Delete the session's handoff at the next main-loop `turn.complete`.

**B2. The fork refreshes the cache, but the cold check still measures from the last turn.**
- Gap: DESIGN.md:16 compares the time since the last turn with the TTL. The fork at TTL minus margin reads the main thread's cached prefix (`d.ts:2737-2739`, `d.ts:6688-6690`). In API behaviour, a cache hit renews the entry's lifetime, so the prefix stays warm until fork time plus TTL.
- Failure: with a 1h TTL, the person leaves at 12:00. The fork runs at 12:55 and keeps the prefix warm until 13:55. The person comes back at 13:10. embers sees an idle of more than 60 minutes and swaps (automatic, because a handoff is on file). The swap throws away a warm 118k prefix that would have cost 0.1 × 118k ≈ 12k token-equivalents to read. In its place it writes a new prefix (system, tools, handoff) at 1.25×, which costs more, and the conversation loses detail. This hits the main case the mod exists for, and it makes things worse.
- Fix: keep `lastCacheTouch` in `$.state` as the later of the last main-loop turn end and the end of any fork whose `usage.cache_read_input_tokens` was high. Compare the TTL against that. Say in the design that the warm handoff also keeps the cache alive for one more TTL.

### Major

**M1. The `session.compact` hook has no guard and would answer every compaction.**
- Evidence: the event fires for `/compact`, auto-compaction, `precompute`, any plugin's `$.session.compact` (all of which share `trigger: 'plugin'`), and the compactions of subagents and forks (`d.ts:4603-4610`, `d.ts:11707-11716`, `d.ts:11760`, `d.ts:199`).
- Failure: the person types `/compact keep the API notes`, or the engine auto-compacts in a subagent. embers answers with the stored handoff, which may be stale or belong to the main loop, and core's summary never runs.
- Fix: answer only when `trigger === 'plugin'`, `agentId === undefined` and `instructions` equals a marker embers passes, such as `embers:<handoffId>`. In every other case return `next(e)`. The marker is stateless, so it survives a reload.

**M2. The hooks fire for loops and origins the design does not exclude.**
- Evidence:
  - `turn.complete` fires for every agent's end, including the engine's own forks (`d.ts:4695-4696`, `d.ts:199`, `d.ts:14660-14670`).
  - `prompt.submit` fires for slash commands (`e.command`, `d.ts:9770-9779`), for prompts typed during a turn (`turnId`, `d.ts:9809-9813`), and for non-person origins: `sdk`, `task-notification`, scheduled tasks and `/loop`, peers, plugins (`d.ts:9499-9530`).
- Failure:
  - A background subagent finishing at minute 50 resets "last turn end" and re-arms the timer, so the main thread's real idle is misjudged.
  - After an hour away, typing `/embers status`, `/model` or `/exit` gets held behind a three-button band.
  - An hourly `/loop` or a task notification hits the `ask` path with nobody there to answer, and the session stalls.
- Fix: state the rule. Act only on `agentId === undefined`. At `prompt.submit`, act only when `!e.command`, `!e.turnId`, `!e.isMeta` and `e.origin.kind` is `composer` or `bridge`. Every other submission passes through untouched.

**M3. Holding the prompt by dropping and resubmitting it loses content and depends on the band having focus.**
- Evidence:
  - `$.prompt.submit` frames the text as the plugin's unless `asUser: true` (`d.ts:9701-9711`).
  - Pasted images and `@file` mentions are not expanded for a plugin's prompt (`d.ts:9706`).
  - Attachment ids are valid only while the original `prompt.submit` is in flight (`d.ts:9732`).
  - Band buttons take keys only after a click or ctrl+x tab (`d.ts:11087`, `ref:169`).
  - The band exists only on terminal and desktop (`d.ts:11089`). DESIGN.md:31 gates the timer on the band but not the cold path.
- Failure:
  - A prompt with a pasted screenshot comes back without it.
  - In VS Code, `ask` drops the prompt and draws no choice at all.
  - A second prompt typed while the first is held overwrites it.
- Fix: never drop the prompt. Inside the `prompt.submit` hook, await `$.ui.ask(...)` (`d.ts:2464-2479`; a `$` call in flight does not count against the hook's budget, `ref:204`) and branch:
  - send: `next(e)`.
  - swap: `$.session.compact({ instructions: marker })`, then `next(e)`.
  - handoff then swap: fork, then compact, then `next(e)`.
  - fresh: `{ drop }`, `$.prompt.fill` with the text, then `/clear` from `$.clock.after(0, …)`, because `$.command.run` rejects inside a hook the turn waits on (`d.ts:3236`). Tell the person that attachments must be pasted again.

  If `$.ui.ask` rejects (dismissed, or a `-p` run, `d.ts:2470`), send. This removes the "held prompt" from `$.state` entirely.

**M4. The timer's lifecycle is unspecified, and its handle cannot live where the design puts it.**
- Evidence:
  - `$.state` takes JSON data only (`d.ts:3576`). DESIGN.md:59 stores "the armed timer's cancel" there.
  - A reload cancels pending waits (`d.ts:3592`). A `userConfig` change also reloads (`ref:74`).
  - Nothing cancels the timer when a new prompt starts.
- Failure:
  - A 40-minute agentic turn starts at minute 30. The timer fires at minute 55 during the turn and writes a handoff nobody needs.
  - After a night of laptop suspend, the timer fires late, possibly as the person sits down. The fork reads a cold prefix and pays 1.25 × the whole context for a handoff the person did not ask for. That is the "fork that rewrites the cache" case.
- Fix:
  - Keep the `Timer` in a module variable and the deadline (epoch ms) in `$.state`.
  - Cancel the timer at main-loop `prompt.submit` and `turn.start`.
  - Re-arm from the stored deadline in `session.start`, which fires again on reload (`d.ts:4552-4556`).
  - When the timer fires, fork only if `$.state` says idle and `$.clock.now() - lastCacheTouch` is still below the TTL minus a small slack. Otherwise skip, write nothing and record nothing.

**M5. Self-correction is confounded by other causes and oscillates.**
- Evidence:
  - A cold fork also follows `/model` (`d.ts:2739`, `d.ts:6533-6535`) and a late timer (M4). DESIGN.md:23 reads every near-zero read as a short TTL.
  - DESIGN.md:44 clears the override "until a warm fork is observed again". Once the margin is shortened, every fork lands inside the short TTL and is warm, so the override clears on the next idle.
- Failure: the TTL drops to 5 minutes under overage.
  1. Fork at 55m is cold. The design records 5m and sets the margin to 4m.
  2. Next idle, the fork at 4m is warm. The override clears and the margin goes back to 55m.
  3. Next idle, the fork at 55m is cold again.

  One full cold write lands every other idle period. If the session is abandoned, each of those costs more than doing nothing.
- Fix:
  - Observe the TTL from the main loop's first `turn.step` response after each idle (`TurnUsage` per response, `d.ts:15030-15043`). That costs no fork and gives a reading on every return.
  - Clear an override only on a warm read after an idle longer than the override.
  - Skip the reading when `TurnUsage.model` differs from the model now in use.
  - Where the engine says the TTL itself, take it: `classic.PreModelSwitch` and `classic.PostModelSwitch` carry `cache_ttl: '5m' | '1h'` and `prompt_cache_warm` (`d.ts:8235-8239`, `d.ts:8321-8325`).

**M6. The context-size figure the design names is wrong (open question 3).**
- Evidence: `turn.complete`'s `usage` sums all of the turn's responses (`d.ts:15037`, `d.ts:14670-14675`).
- Failure: a 12-step turn on a 30k context reports about 360k of input plus cache reads. The 40k threshold passes, so embers writes handoffs and swaps on contexts it is meant to leave alone.
- Fix: read `(await $.session.usage()).context.tokens` (`d.ts:11858-11862`) in the main-loop `turn.complete`, or take `e.context.tokens` from a `session.measure` hook (`d.ts:4632-4642`, `d.ts:12069-12075`). The value is absent right after a compaction until the next response (`d.ts:11853-11856`); treat absent as "below threshold".

**M7. The store fills up and then refuses every write.**
- Evidence: `$.store.set` rejects once the store passes 4 MiB of JSON in total (`d.ts:3533`). Handoffs are kept per project root and session id, with no removal (DESIGN.md:14, :60).
- Failure: after some weeks of handoffs at 10 to 20 KB each across projects, every `set` rejects, including the observed-TTL write. The mod silently stops writing handoffs.
- Fix:
  - Delete a handoff once it has been swapped to, loaded, or overtaken by a later turn (B1).
  - Keep at most the newest handoff per project key (Q6) and drop entries older than about 14 days.
  - Use one store key per record and list with `$.store.keys()`. Do not keep a read-modify-write index, which two processes would race on (the types do not say `$.store` is safe across processes).

**M8. The swap with a handoff on file happens without a word, and it loses information.**
- Evidence:
  - DESIGN.md:18 and :40: under `ask`, a handoff on file means the swap happens automatically.
  - The fork answers over "the main thread's last request again … with `prompt` after it" (`d.ts:2737-2738`). The last turn's final assistant reply was received after that request, so per the types the handoff never sees it. Verify on the first run.
- Failure: the person comes back, types "ok, ship it", and the model now has a summary written without the reply that said what "it" is.
- Fix:
  - Under `ask`, still ask, with swap as the first option. Only `swap` swaps without asking.
  - Store the last assistant message's text verbatim beside the handoff (`$.session.messages()`, `d.ts:2863-2893`). It costs nothing at fork time, and the compaction includes it.

**M9. Resume and `/clear` are not handled.**
- Evidence:
  - `$.state` is per session and empty in a new process (`d.ts:3546`).
  - A fork answers `nothing-to-fork` on a resume that starts afresh and after `/clear` (`d.ts:6714-6716`, `d.ts:2746`).
  - `/clear` changes the session id, and `session.start` does not fire for it (`d.ts:11960-11963`, `d.ts:4553`).
- Failure:
  - `claude --resume` the next day: there is no last-turn time, so the cold prompt passes untreated, and "handoff then swap" cannot run.
  - A `/clear` while a fork is in flight: if the result handler reads `$.session.id()` after the await, it stores the old conversation's handoff under the new session id. A later cold prompt in the new conversation then compacts to the wrong conversation.
- Fix:
  - Hook `classic.SessionStart` with `source: 'resume'` for `seconds_since_last_response`, `prompt_cache_likely_expired` and `context_tokens` (`d.ts:12610-12629`) to seed `lastCacheTouch` and the context size.
  - Offer the session's own stored handoff if it passes B1. Otherwise offer only send or fresh.
  - Capture id, root and turns before every await, and bind the result to them.

### Minor

**m1. The start offer fires again on reloads, and the design does not say what "load" does.**
- Evidence: `session.start` also fires on enable, worker respawn and reload (`d.ts:4553-4556`). DESIGN.md:21 does not say how a handoff is loaded.
- Failure: every save of the mod and every change in `/config` re-offers the handoff. The offer can also show a handoff from a session still running in another terminal.
- Fix:
  - Keep an `offered` flag in `$.state`.
  - Say that loading means `$.session.append({ message: { type: "user", … } })` (`ref:196`).
  - Show the handoff's time and branch, and skip handoffs younger than the TTL, since those sessions are likely still live.

**m2. The fork can cost far more than "the handoff's output tokens".**
- Evidence: a fork thinks at the session's effort (`d.ts:6654-6656`, `ref:213`: "at `max` can be a minute"). Its usage sums several completions when the model attempts a tool (`d.ts:6529`, `d.ts:6593-6596`).
- Fix: the fixed prompt says there are no tools and asks for an answer without deliberation, as the type itself recommends (`d.ts:6688-6690`). Toast the fork's `output_tokens` so the cost shows.

**m3. A swap can save less than the threshold suggests.**
- Evidence: the post-swap prefix is the system prompt, the tools and the handoff, all cold once more than one TTL has passed since the fork.
- Failure: with a 40k context and about 20k of system and tools, the swap saves about 1.25 × 17k, and fidelity drops.
- Fix: before swapping, check the saving, context tokens minus (system and tools tokens plus handoff tokens), against a floor. The breakdown (`d.ts:2955-2974`, `{ breakdown: "summary" }`) gives the system and tools figure locally.

**m4. Stored values have no shape tag.**
- Evidence: `$.store.get` returns `unknown` (`d.ts:3527`). `Shaped<T>` exists only for `$.state` atoms (`ref:154`).
- Fix: DESIGN.md:61's promise needs a `v` field on every stored record and a validator. Say so.

**m5. The band's countdown needs a repeating timer.**
- Evidence: "handoff in 48m" (DESIGN.md:49) has to redraw every minute.
- Fix: show an absolute time instead ("handoff at 12:55"). The band then redraws only on state changes.

**m6. `/embers` on a cold session is a cold fork.**
- Evidence: DESIGN.md:54. The prefix is billed afresh once the entry has lapsed (`d.ts:2739`).
- Fix: when the cache is cold, say so and ask before forking.

### Claims checked and found to hold
- A fork with no `effort` reads the cache on every model, and a named effort on a model without per-message effort rewrites the conversation: `d.ts:6668-6690`. DESIGN.md:29 is correct.
- A hook answering `session.compact` makes no model call: `usage` is "Absent when a hook answered in core's place" (`d.ts:11687`).
- `$.state` survives a hot reload (`d.ts:3546-3547`) and `$.store` spans sessions (`d.ts:3520-3544`).
- `-p` and SDK runs can be told apart with `SessionStartInput.isInteractive` (`d.ts:12649`).
- The 1h and 5m TTLs both exist: `cache_ttl: '5m' | '1h'` (`d.ts:8239`).
- The fork's usage has `cache_read_input_tokens` on every arm except `nothing-to-fork` (`d.ts:6708-6722`). "Every fork result" (DESIGN.md:23) needs that one exception.

## Answers to the open questions

1. **`$.session.compact` inside `prompt.submit`.** The types allow it for a prompt typed while idle. `$.session.compact` "rejects while a turn runs" (`d.ts:2997`), and `prompt.submit` "Fires when a prompt is submitted, before the turn starts" (`d.ts:4305`), with `turnId` "Absent for a prompt submitted while the session was idle" (`d.ts:9813`). So: compact, then `next(e)`, with no drop and no resubmit (M3). For a prompt typed during a turn, compact would reject, but that case is never cold. What the types forbid inside that hook is `$.command.run` (`d.ts:3236`), which rules out `/clear` there. Confirm with a `claude plugin test` before relying on it.

2. **Fork on Fable with effort riding the message.** It is served from cache whether or not the model takes per-message effort, as long as the fork names no effort. Naming none "moves nothing ahead of `prompt`, so the cache is read on every model" (`d.ts:6688-6690`), and the default level is "the level the session runs at, which is the main thread's" (`d.ts:6655-6656`). On the first run, expect:
   - `cache_read_input_tokens` close to the last turn's context;
   - `cache_creation_input_tokens` near 0, because the tail is never cached (`d.ts:2738`);
   - `input_tokens` of a few hundred;
   - `effort` equal to the session's level, or absent (`d.ts:6537-6549`).

   One caveat: if the person changes `/effort` while idle, the fork's default level no longer matches the last request's. On a model with whole-request effort, that fork rewrites the conversation (`d.ts:6670-6680`). Skip the fork if the level changed.

3. **Context size at `turn.complete`.** `e.usage` is the wrong figure: "A turn's counts are its responses' summed" (`d.ts:15037`). There is no `$.session.measure` call; `session.measure` is an event (`d.ts:4632-4642`), and the session noun lists no such method (`d.ts:2862-3070`). Use `$.session.usage().context.tokens`, "Input tokens the last response was answered over: uncached, cache-written and cache-read together" (`d.ts:11859-11860`), or the same field pushed to a `session.measure` hook "after each main-thread turn" (`d.ts:4632`). See M6.

4. **Armed timer across a hot reload.** It is dropped: "a hot reload of the plugin cancels its pending waits with the old environment" (`d.ts:3592-3593`; `ref:73` adds that a `userConfig` change reloads too). A fork in flight is aborted as well ("the plugin's environment unloaded", `d.ts:6613`). `$.state` cannot hold the handle because it takes JSON data only (`d.ts:3576`). Store the deadline and re-arm in `session.start`, which fires on reload (`d.ts:4553-4556`). See M4.

5. **Can a swap cost more than sending cold?** Not on the first request when the cache really is cold and the new prefix is smaller (1.25 × S < 1.25 × P), even in a session that was about to end. It costs more in four cases:
   - (a) The cache is actually warm, because the fork refreshed it (B2) or the configured TTL is shorter than the real one. Then the comparison is 1.25 × S against 0.1 × P, and the swap loses once S > 0.08 × P.
   - (b) The handoff is stale (B1). That costs work, not tokens.
   - (c) The handoff misses detail, so the model re-reads files to recover it (M8).
   - (d) The saving is small against the fixed prefix (m3).

   The fork itself (`output_tokens` plus 0.1 × P) is a cost spent beforehand, and in an abandoned session it is the whole cost.

6. **`offerOnStart` key.** Key on `$.session.root()` plus the current branch. `$.session.root()` already separates worktrees: it follows "a worktree move" (`d.ts:2904-2907`), whereas `SessionRepo.root` is the main working tree for every worktree (`d.ts:12432`) and is the wrong key. `SessionRepo` carries no branch (`d.ts:12430-12457`), so read it once at write time with `$.process.run(["git", "branch", "--show-current"])`, and fall back to root alone outside git. Root alone would offer one branch's handoff in a checkout switched to another branch.

## Verdict

MODIFY. The design needs these changes:
- **B1:** bind each handoff to session id and turn count, and swap only on a match.
- **B2:** measure coldness from the last cache touch, forks included.
- **M1:** guard the `session.compact` answer with trigger, agentId and a marker.
- **M2:** state the main-loop and origin filters.
- **M3:** replace the drop-and-resubmit hold with `$.ui.ask` inside `prompt.submit`.
- **M4:** keep the timer deadline in `$.state`, cancel on a new turn, re-arm on reload, and re-check the wall clock when the timer fires.
- **M5:** take TTL readings from the main loop's first request after idle, and fix the override clearing.
- **M6:** use `context.tokens` for the size.
- **M7:** add store retention.
- **M8:** ask before a swap under `ask`, and keep the final reply.
- **M9:** handle resume and `/clear`.
- **m1-m6** as listed.
