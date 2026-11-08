# Brief 03 report: adversarial review of the embers mod

Branch `feat/mod` at `1e04083`. I read the code against `docs/reference/claude-code.d.ts` (cited `d.ts:<n>`; the engine-laid copy matches it line for line up to the tools block) and the three debug logs the status note names. I ran `claude plugin test embers` once: 8 pass, 0 fail. Nothing in the repository was changed.

Paths are relative to `embers/`.

## Findings

### Major

**1. With a 5-minute TTL, the handoff fork runs one minute after every turn.**
- Where: `hooks/records.ts:117-118`. `marginFor(5, 5)` is `min(5, max(4, 2.5)) = 4`, so `turn.complete` (`hooks/register.tsx:84,93`) arms the timer for `now + 5m − 4m`.
- Failure: once a 5m TTL is observed or reported by the engine, any pause longer than a minute after an answer costs a handoff fork: 0.1 × the context plus about 500 to 2,000 output tokens at the output price. On a 100k context, that adds roughly 12k to 20k input-equivalents to almost every turn. The band says "margin now 4m", which reads as the reverse of what happens. The live run used TTL 2 and margin 1, where the formula gives 1, so it never showed up.
- Fix: `Math.min(margin, Math.max(1, ttl / 5))`. That fires at 4m for a 5m TTL and at 55m for 60m. Add a test that asserts the fork time for a 5m override.

**2. `/model` while armed still forks on a cold prefix on this machine, and it can also store a false 5m TTL.**
- Where: the only model-change guard is `classic.PostModelSwitch` (`hooks/register.tsx:172-179`). The debug logs show `cc-plugin-sec-default` hooks `classic.*` and passes over embers' `classic.SessionStart` (logs at 03:30:16, 03:41:10 and 03:44:57). The same bypass will very likely apply to `classic.PostModelSwitch`, though it was never exercised.
- Failure: the person switches model while idle. The timer fires and `fire()` passes its clock check (`hooks/handoff.ts:143`). The fork is billed for the whole prefix, because the prefix is "billed afresh … after `/model`" (`d.ts:2739`).
- Second failure: if the person sends before the timer instead, the first `turn.step` reads cold with an idle shorter than the TTL. `observeTtl` (`hooks/handoff.ts:286-289`) then stores a persistent `ttl:<new model>` of 5m. Combined with finding 1, that means a fork after every turn, in every later session on that model.
- The same false observation follows a `/effort` change on a model without per-message effort. The `/effort` hook (`hooks/register.tsx:149-154`) disarms the timer but leaves `lastCacheTouch` in place.
- Fix:
  - Keep `modelAtTouch` in `EmbersRun`, read with `$.session.model()` at `turn.complete`.
  - In `fire()` and `observeTtl`, do nothing when the current model differs.
  - Clear `lastCacheTouch` in the `/effort` hook.
  - Keep the classic hook as a bonus, not the guard.

**3. A prompt sent again while the swap is still running can start a second cold fork.**
- Where: `coldPrompt` drops the prompt and schedules `reshape` (`hooks/handoff.ts:237-243`). `lastCacheTouch` is cleared only in `reshape`'s `finally` (`hooks/handoff.ts:272-275`). On "Write handoff, swap", the cold fork takes 10 to 60 seconds, and the dropped prompt is already back in the box.
- Failure: the person presses Enter during the fork. `prompt.submit` sets the phase to `idle` (`hooks/register.tsx:43`), sees the old touch, and asks again.
  - If they pick "Write handoff, swap" again, a second cold fork runs. That is two full prefix writes in one idle period.
  - If they pick "Send", the prompt goes in cold and the first fork's result is thrown away (`hooks/handoff.ts:108`). That is a cold fork plus a cold send.

  The same window exists, shorter, between the drop and the queued `/clear` on Swap and Fresh.
- Fix: add `reshaping: boolean` to `EmbersRun`. While it is set, `prompt.submit` answers `{ drop: 'embers: still swapping; send again when it says done' }`. Clear it in `reshape`'s `finally`.

**4. "Write handoff, swap" re-warms the full prefix and then throws it away; the ask presents it as a saving.**
- Where: `hooks/handoff.ts:222-227` (the question) and `hooks/handoff.ts:257-271`.
- Failure: the cold fork writes the whole prefix P into the cache. At that moment, sending would read it at 0.1 × P. The swap instead writes S = system + tools + handoff at 1.25 × S.
  - For P = 100k and S = 25k, that is about 31k token-equivalents for the swap against 10k for sending, plus the fork's output.
  - It pays back only after roughly 4 or more later requests on the shorter prefix.

  The saving check at `hooks/handoff.ts:264` compares token counts, not prices, so it never catches this. The question says "a handoff first rereads 100k cold, then the swap writes ~20k", which reads as cheaper than "Sending rewrites 100k". It is not.
- Fix: remove the option. A second-best fix is to state its real price in the question ("costs more now, saves ~X per later request") and compare `1.25·S` with `0.1·P` after the fork, sending when that is cheaper.

**5. The resume path either never runs on this machine or gives up at the first prompt.**
- Where: seeding happens only in `classic.SessionStart` (`hooks/register.tsx:160-163`), which is bypassed here (see finding 2). Even where it runs, `coldPrompt` reads `usage.context.tokens` (`hooks/handoff.ts:208-210`), which is "absent until the first response of the live window: a fresh session" (`d.ts:11853-11856`). A resumed process has made no request yet, so `coldPrompt` likely returns `undefined` and sends cold every time. The seeded `contextTokens` is never consulted. This is plausible but unverified on a real resume.
- Failure: `claude --resume` the next day, with a matching handoff of that session on file. The first prompt rewrites the whole prefix cold.
- Fix:
  - In `coldPrompt`, use `usage.context.tokens ?? s.contextTokens`.
  - In the function `session.start`, when `lastCacheTouch` is undefined, seed it and `contextTokens` from the session's own matching handoff record (`writtenAt`, `contextTokens`). A matching handoff is the only case where a swap is possible anyway.
  - Do not offer "Write handoff, swap" before the first turn of a resumed process, since the fork answers `nothing-to-fork` there (`d.ts:6714-6716`).

**6. After a person's `/clear`, the reset never runs here, so a stale timer and band carry into the new conversation.**
- Where: `cleared()` is reached only from `classic.SessionStart` with `source === 'clear'` (`hooks/register.tsx:158-159`), which is bypassed.
- Failure: the person types `/clear` while armed. The band keeps showing the old conversation's "warm handoff at 12:55, 118k tokens" (`bandLine` reads the old `contextTokens`). At the deadline, the timer fires and `writeHandoff` returns "no context size yet" before changing the phase (`hooks/handoff.ts:90`). The phase stays `armed` with a past deadline, and the person gets a meaningless toast.
- Fix: call `cleared()` from a function `session.end` hook when `e.reason === 'clear'`. That event is not a classic hook, and it reports a `/clear` (`d.ts:11960-11963`). The same hook then also covers the swap's own `/clear`.

**7. The start offer never runs here, and the move the status note proposes needs two gates.**
- Where: the offer is in `classic.SessionStart` with `source === 'startup'` (`hooks/register.tsx:164-167`), which is bypassed. Moving it to `session.start`, gated by `startOffered`, is right: that flag survives reloads. It also needs:
  - `e.isInteractive`, because the first `session.start` is awaited before the first prompt and the offer must not run under `-p`;
  - `$.session.turns() === 0`, so a resumed session, which already has its full context, is not offered another session's handoff.
- Separately, Skip neither deletes nor marks the handoff (`hooks/handoff.ts:319-320`). The same handoff is offered at every new session in that root and branch for 14 days.
- Fix: the two gates above, and record `offeredAt` on the record when the person skips, so it is offered once.

### Minor

**8. The reason given for departure 1 is not shown anywhere I could find.**
- The status note says the host refuses `$.session.compact` inside `prompt.submit`, quoting "it would compact under the turn this hook is holding". That line is in none of the three debug logs. The types say only that compaction "rejects while a turn runs" (`d.ts:2997`), and that `prompt.submit` fires "before the turn starts" (`d.ts:4305`).
- The `/clear` swap has a real cost compared with a compaction:
  - a new session id;
  - todos and the session's usage figures start over (`d.ts:12677`);
  - the prompt has to be sent again, and attachments pasted again;
  - the race in finding 3.
- Fix: attach the refusal line, or a kit test that shows it, before accepting decision 1. If compaction does work inside the hook, switch back: the prompt is then kept whole.

**9. The swap does not say how to get the old conversation back, or what the model now holds.**
- The old transcript stays resumable: `/clear` ends it with a `resume.id` (`d.ts:11960-11973`). But the toast at `hooks/handoff.ts:191-193` gives no id, and the appended handoff row is invisible to the person.
- Fix: put `claude --resume <old id>` in the toast, and `$.ui.log` the handoff text to the transcript. The model never reads a log line.

**10. Retention deletes the handoff of another live session on the same root and branch.**
- Where: `hooks/records.ts:88-108`.
- Failure: two terminals in one checkout. Session B's handoff makes `sweep` delete session A's. A then comes back cold with no swap available.
- Fix: in the newest-per-group rule, only drop records older than twice the TTL.

**11. An override written from one cold read persists across sessions.**
- Where: `hooks/handoff.ts:289` writes to `$.store` after a single cold read. A reload, an MCP reconnect or a system-prompt change during an idle also makes the first read cold.
- Fix: keep a single observation in `$.state.lapse`, and persist it only after a second observation in another idle period.

**12. `/embers` during a timer fork, or right after a failed write, leaves things inconsistent.**
- Where: `hooks/register.tsx:137-138` runs `writeHandoff` even while the phase is `writing`, which means two forks.
- After `disarm()`, a "no context size yet" return leaves the phase `armed` with no timer, so the band promises a handoff that never comes.
- Fix: refuse while `writing`, and set the phase to `idle` on every early return.

## The departures

1. **`/clear` plus append in place of compaction.** The reason is unverified (finding 8). The replacement works, as shown in the live run, and it makes no model call. Its costs are findings 3 and 9 and the loss of session-scoped state. What happens in detail:
   - The dropped prompt is put back in the box by the engine, as seen in the live run. Text survives; attachments do not, and the drop reason says so.
   - A prompt typed during the swap triggers finding 3.
   - The old transcript can be resumed by id.
2. **Drop and re-send for swap and fresh.** This is correct given departure 1. Not filling the box is right (commit `a7dbd8d`).
3. **Disarm on `/effort` instead of `effortAtTouch`.** The stated reason is partly false: `turn.step` carries each request's `model` and `effort` (`d.ts:14823-14832`), so the level at the last main-loop request can be read. What cannot be read is the session's current level while idle. Disarming on `/effort` is the cheapest guard. It also needs to clear `lastCacheTouch` (finding 2).
4. **The engine-reported TTL is stored as an override.** That is fine while the classic hook runs. It inherits the bypass in finding 2, and it inherits the persistence problem in finding 11.

## Earlier findings not fixed, or fixed wrongly

Everything else from the brief 01 report is fixed: B1 at `register.tsx:82` and `handoff.ts:213`; B2 at `handoff.ts:128`; M1 through the watch-only hook at `register.tsx:102-117`; M2 at `shared.ts:125` and the `agentId` checks; M3 at `handoff.ts:228`; M4 at `handoff.ts:59` and `register.tsx:35,42,55`; M6 at `register.tsx:83`; M8 at `handoff.ts:91` and `shared.ts:compose`; m2 through m6.

These are not fixed, or fixed wrongly:
- **M5** (TTL observation): `marginFor` is wrong (finding 1), and the model and effort confounders go unguarded on this machine (finding 2).
- **M7** (retention): it now removes live sessions' handoffs (finding 10).
- **M9** (resume and `/clear`): the resume and `/clear` halves depend on a bypassed hook (findings 5 and 6). The capture-before-await half is fixed (`handoff.ts:83-110`).
- **m1** (start offer): bypassed, and it re-offers after Skip (finding 7).

## Tests
- Line 300, "a userConfig reload while armed…", does not test a reload. The module variable `timer` survives in the kit, so the test still passes with the re-arm in `session.start` (`register.tsx:35`) deleted. To test the reload, abort the first wait's signal before the second `session.start`, or assert that the re-arm alone produces the live wait.
- Lines 276 and 297 assert raw `$.state` payloads (`phase`, `deadline`). A rename breaks them without any change in behaviour. Assert the fork count, the toast and the band line instead.
- These behaviours have no test that would catch their bug:
  - the fork time under a 5m override (finding 1);
  - a model change before the timer and before the first step (finding 2);
  - a second prompt during `reshape` (finding 3);
  - resume with `context.tokens` absent (finding 5);
  - `/clear` reset (finding 6);
  - the start offer's gates and Skip (finding 7);
  - override clearing;
  - `/embers` on a cold cache;
  - Fresh.

## Verdict

MERGE AFTER FIXES: findings 1, 2, 3, 4, 5, 6 and 7, plus the reload test. Before decision 1 is accepted, attach the evidence asked for in finding 8.
