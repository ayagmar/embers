# Brief 05 report: re-check of the fix round

Branch `feat/mod` at `eb0eb35`. I read every fix commit in `1e04083..eb0eb35` against the brief 03 findings, the probe, `docs/briefs/04-status.md` and the four debug logs it names. I ran `claude plugin test embers` once: 17 pass, 0 fail. Nothing in the repository was changed. Paths are relative to `embers/`.

## Regressions and blockers from the fix round

There are no blockers and no majors. Three minor regressions:

**R1. `/embers off` comes undone after any `/clear`.**
- Where: `isOff` lives in `$.state` (`types/index.d.ts`, `hooks/handoff.ts:39-43`). A `/clear` starts `$.state` over, as the live run showed and `04-status.md:40` says. `cleared()` (`hooks/handoff.ts:173-180`) tries to carry `isOff` across, but it runs in `session.end`, before the new state exists, so it carries nothing. The swap's own `/clear` cannot hit this, because a session that is off never asks.
- Failure: the person runs `/embers off`, then `/clear`, and embers arms and forks again without telling them.
- Fix: mirror `isOff` in a module variable, the way `isInteractive` is mirrored. Treat embers as off when either the variable or `$.state` says so, and let `session.start` copy the state value into the variable after a reload.

**R2. `isInteractive` now depends on `session.start` running after every reload.**
- Where: `hooks/register.tsx:25,34,102`. A reload resets the variable to `false`. The live run showed `session.start` firing after a code reload. A `userConfig` change also reloads the module, and the types only say `session.start` runs again on "a reload (changed modules only…)" (`d.ts:4553-4556`). If an options-only reload does not count as a changed module, embers stops arming for the rest of the process, which is the bug class found live.
- Fix: read interactivity when it is needed: `(await $.session.surfaces()).length > 0` (`d.ts:2928-2938`; "Empty in a plain -p run"). That survives both `/clear` and reloads, and the variable can go.

**R3. The retention fix and the resume fix conflict.**
- Where: `sweep` (`hooks/records.ts:91-109`) deletes a superseded handoff once it is older than 2 × TTL. Any session's `session.start` or handoff write runs it.
- Failure: session A exits with a handoff. Session B on the same branch writes a newer one. A day later, `claude --resume A` finds no handoff of its own, so `seedFromHandoff` (`hooks/handoff.ts:218-227`) seeds nothing and the first prompt is sent cold. That is the same result as before the fix, so nothing gets more expensive. It does mean the resume fix rarely applies in a checkout used by more than one session.
- Fix: in the newest-per-branch rule, drop only records that are older than 2 × TTL and also past a count cap per root (say 10). The 14-day expiry stays.

What was checked and holds:
- The `session.end` reset handles the swap's own `/clear`: the live run shows `session.end` at .695, before the append. `swap()` runs `cleared()` again afterwards and `reshape`'s `finally` writes the new state.
- The two-observation `lapse` rule (`hooks/handoff.ts:326-343`): same-period reads stay pending, the model is checked, and a warm read clears both a held and a stored TTL. A `/clear` drops a pending observation, which is acceptable.
- `seedFromHandoff` leaves `modelAtTouch` unset, so no TTL observation follows a resume. That is safe.

## Earlier findings not fixed, or fixed wrongly

None. Each one is fixed:
- 1: `records.ts:117-118`
- 2: `register.tsx:77,107,174`; `handoff.ts:152-157`
- 3: `register.tsx:53`; `handoff.ts:61,276,301`
- 4: `handoff.ts:256-268`
- 5: `register.tsx:38,62`; `handoff.ts:218-227,246`
- 6: `register.tsx:181-184`
- 7: `register.tsx:42`; `handoff.ts:362,373-375`
- 8: the probe
- 9: `handoff.ts:207-210`
- 10: `records.ts:104-108`
- 11: `handoff.ts:326-336`
- 12: `register.tsx:145`; `handoff.ts:93-96,117`

The test findings are fixed too. The brief 03 list maps to the tests at `hooks/embers.test.tsx:288-606`, and the reload test at `:574` now loses its timer.

Finding 8 is proven. The probe's kit test shows the host refusing `$.session.compact` inside `prompt.submit` ("it would compact under the turn this hook is holding … (host check)"). It also shows that a compaction from a timer passes over the caller's own `session.compact` hook. The `/clear` swap stays.

## Open points

1. **The 7.6k `cache_creation_input_tokens`.** The logs fit one pattern, though I cannot prove it:
   - Fork 1 (`ce9b7251…txt` 04:09:11) and fork 2 (`e55459fc…txt` 04:12:39) each followed the first turn of a conversation. Each read about 26–27k, roughly the fixed part (system and tools), and wrote about 7.6k, roughly the whole conversation after it.
   - Fork 3 (04:15:03) followed the second turn of the same conversation. It read 34.8k and wrote 3.

   That fits a fork whose replay of "the main thread's last request" (`d.ts:2737-2738`) differs from the original request only in the last user message. Per-request content such as attachments and reminders is rendered at send time and never stored as a row (`ref:173,177`). The fork then reads up to the previous cache breakpoint and writes everything from the last user message on.
   - On a first turn, that is the whole conversation.
   - Later, it is the last turn: the prompt, plus every tool result and step of that turn.

   It does change the cost case for agentic work. A final turn with 30k of tool output makes the handoff fork write about 30k at 1.25×, and that entry is the fork's own, which the main thread never reuses. The fork is still far cheaper than a cold rewrite of the whole prefix, so the premise holds. But "a few hundred uncached tokens" (DESIGN "Rules") is true only when the last turn was short.
   - Follow-up: add `cache_creation_input_tokens` to `forkFigures` (`hooks/shared.ts`), so every toast shows the write. Measure one fork after a multi-step turn before stating the cost in the README.
2. **Handoff cut at 2,000 characters in the transcript.** Leave it. The model holds the full text in the appended row, and the log line is for orientation. Optionally end the log with "full handoff held by the model".
3. **Fixed part estimated above the live context.** The summary breakdown is a local estimate, while `context.tokens` comes from the API (`d.ts:11870-11875`). Clamp `fixed` to at most `tokens` in `coldPrompt` (`hooks/handoff.ts:247`), so the ask never claims Fresh costs more than sending. It is harmless at the default `minSavingTokens`.
4. **`author` and icon.** This is publishing metadata and the owner's call. It does not block the merge.

## Verdict

MERGE. Only minor findings remain. Follow-ups: R1, R2 and R3, the `cache_creation_input_tokens` figure in the fork toast with one measurement after a multi-step turn, and the `fixed` clamp.
