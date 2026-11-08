# Brief 08 report: adversarial review of the sweep

Branch `refactor/sweep` at `e702d7c` against `main`. Paths are relative to the repository root; `d.ts` is `docs/reference/claude-code.d.ts`.

Everything that ran, ran in a scratch copy. Biome is clean, `tsc` is clean, and `claude plugin test` gives 19 pass, 0 fail. I also applied 25 one-line mutations to the copy, reran the tests after each, and ran one probe test. Not run: `claude plugin validate` and a live session. The worktree is unchanged apart from this report.

## Findings

### Blocker

None. The refactor broke none of the invariants from brief 03 or 05 as those reports stated them. Finding 3 is a regression in a case they did not cover.

### Major

**1. `/embers` after a model change forks the whole prefix without asking.**
- Where: `embers/hooks/register.tsx:149-152`. The cold check looks only at the clock. `fire` (`embers/hooks/handoff.ts:142`) and `turn.step` (`embers/hooks/register.tsx:85`) both compare the model; this path does not.
- Failure: a turn ends, the person runs `/model`, and 10 minutes later runs `/embers`. The fork is billed for the whole prefix (`d.ts:2739`), and the cold ask never appears. In the probe, with no `classic.PostModelSwitch` raised, the result was 1 fork and 0 asks, and the band then read `handoff ready  12:10, 100k tokens, warm until 13:10`. The only protection is that classic hook, which brief 03 finding 2 expected to be bypassed on this machine.
- Origin: the same code is on `main`, so the refactor did not cause it. It is still the listed invariant, and brief 03 rated the same bug on the timer path major.
- Smallest fix: add `$.session.model()` to the `Promise.all` at line 149, and treat the cache as cold when `cache.model !== undefined && cache.model !== model`. A seeded touch has no model and must not trigger the ask.

**2. The behaviours the refactor rewrote mostly have no test that would catch their bug.**

Each of these mutations left all 19 tests passing:

| Removed | Where | Bug that would ship |
|---|---|---|
| Session, turn and phase re-check after the fork | `embers/hooks/handoff.ts:115` | A handoff of a conversation that moved on is stored, and a later swap loads it |
| Refusal of `/embers` while writing | `embers/hooks/register.tsx:150` | Two forks at once |
| The `armed` guard in `fire` | `embers/hooks/handoff.ts:140` | A timer that fires after a prompt or a `/embers off` still forks |
| `writing` ended on reload | `embers/hooks/register.tsx:41` | The band says `writing handoff…` until the next prompt and `/embers` refuses to run |
| Each of the three `minContextTokens` gates | `embers/hooks/register.tsx:112`, `embers/hooks/shared.ts:144`, `embers/hooks/handoff.ts:219` | Paid forks and asks on small sessions |
| Reset on `/effort`, compaction, model switch | `embers/hooks/register.tsx:129,173,189` | The band promises a warm cache, or a fork runs on a rewritten prefix |
| The `session.end` reset | `embers/hooks/register.tsx:180` | A stale timer outlives a `/clear`. The test at `embers/hooks/embers.test.tsx:361` passes without the hook because `stateStartsOver` does all the work |
| Retention's 2 × TTL filter, and the delete loop itself | `embers/hooks/records.ts:104,109` | Retention deletes a live handoff, or never deletes anything. The test at `embers/hooks/embers.test.tsx:681` holds 5 records, so the over-cap branch never runs, despite its comment about two terminals |

Smallest fix, four tests:
- A fork the test holds open and releases. With a turn, then with `/effort`, then with `session.start` raised while it runs, assert no record is stored, the band, and the forks count. A second `/embers` while it is held is refused.
- A 30k context: no band, no fork at the deadline, no ask when cold.
- `/effort` and a compaction while armed: band empty, no fork at the deadline.
- Retention with more than 10 records in a root: a superseded record younger than 2 × TTL stays, an older one goes.

For the `session.end` row, switch the test at line 361 to `manualClock` and assert no live wait remains after `session.end`.

No test mirrors the implementation.

### Minor

**3. `/embers off`, then `/clear`, then a reload turns embers back on.**
- Where: `embers/hooks/state.ts:21`, `embers/hooks/register.tsx:42`.
- Failure: after the `/clear`, the new state has `isOff: false` and only the module variable says off. A reload (a config change, a saved file) resets the variable, `session.start` finds the state on, and embers arms and forks again without saying so. On `main`, `withOff` copied the variable into the state on the next write, so this case held. `README.md:37` says off lasts until `/embers on` or quit.
- Origin: brief 07 section 2 ordered this sync, so this is the owner's call. The mutation that removes the copy at `embers/hooks/register.tsx:42` also survives, because the kit cannot start a module over.
- Smallest fix, in `apply`, the one writer: `r => { const next = transition(r, ...input); return inProcess.isOff && !next.isOff ? { ...next, isOff: true } : next }`. `/embers on` clears the variable first, so it still works.

**4. The README's install step does not get a first-time user running.**
- Where: `README.md:8`.
- Failure: the path assumes a clone at `~/projects/embers`, and no clone step is given. `--plugin-dir` loads the plugin "for that session only" (`docs/reference/plugin-authoring-reference.md:72`), so the next plain `claude` has no embers and nothing says why.
- Smallest fix: add the clone command, and one sentence saying the flag is per session, with an alias or `CLAUDE_CODE_PLUGIN_DIRS` for every session.

**5. The README lists `send` and `off` as different `coldMode` values, and they behave the same.**
- Where: `README.md:50`, `embers/hooks/register.tsx:65`.
- Failure: a person picks `off` expecting something more than `send`. Both pass the prompt through without asking, and nothing else reads the value.
- Smallest fix: say so in the table (`send` or `off`, both send without asking), or drop one value.

**6. The README states the fork's cost as measured, and it is not.**
- Where: `README.md:57`.
- Failure: brief 05 asked for one measurement after a multi-step turn before stating the cost in the README, and `docs/briefs/07-status.md:45` says that is still unmeasured. On the recheck's reading of the logs, a last turn with 30k of tool output makes the fork write about 30k at 1.25 ×. A reader of "the last turn" pictures a few hundred tokens.
- Smallest fix: measure it, or add that the write grows with the last turn's tool output.

## 1. Invariants

| Invariant | State | Where |
|---|---|---|
| One fork per idle period | Holds | `embers/hooks/handoff.ts:140`, `embers/hooks/register.tsx:150`, single handle at `embers/hooks/process.ts:9` |
| Deadline in state, handle in `process.ts`, re-armed on reload | Holds | `embers/types/index.d.ts:19`, `embers/hooks/process.ts:9`, `embers/hooks/register.tsx:43` |
| Session id and turns captured before the fork, re-checked after | Holds | `embers/hooks/handoff.ts:90-95,114-115` |
| A prompt during a swap is refused | Holds | `embers/hooks/register.tsx:61`, `embers/hooks/handoff.ts:250,273` |
| `/clear` starts over, nothing arms from stale state | Holds | `embers/hooks/state.ts:113`, `embers/hooks/register.tsx:179-182`; `fire` re-reads the phase |
| No fork or TTL observation after a model change | Broken for manual `/embers` (finding 1); holds for the timer and `turn.step` | `embers/hooks/handoff.ts:142`, `embers/hooks/register.tsx:85` |
| Compaction hook answers only its own marker | Holds trivially: there is no marker left and it always passes through | `embers/hooks/register.tsx:124-132` |
| Retention never deletes a live session's handoff | Holds as brief 05 agreed. Past 10 records in a root, a superseded handoff older than 2 × TTL can go, even if its session is still open. Unchanged from `main` | `embers/hooks/records.ts:102-111` |
| Nothing below `minContextTokens` or under `-p` | Holds for everything automatic. `-p` prompts carry origin `sdk` (`d.ts:9520`), which `isPersonPrompt` rejects. An explicit `/embers` has no size gate, as on `main` | `embers/hooks/register.tsx:48,112`, `embers/hooks/shared.ts:139,144`, `embers/hooks/handoff.ts:219` |

## 2. The state machine

- Every transition in `embers/hooks/state.ts:30-121` handles every phase and reads only its inputs. `isOff` (line 25) reads the module variable, and it is not a transition.
- No contradictory payload is reachable. A cold fork with a known touch gives `ready` with `warmUntil` already past (line 79), so the band prints a past time. `main` does the same.
- No `$.state` spread exists outside `state.ts`.
- A `run-1` value reads as absent (`d.ts:720`), so it becomes `INITIAL`. A reload cancels the old timers (`d.ts:3592`).
- A reload mid-`writing` ends in `idle` with no timer (`embers/hooks/register.tsx:41`), so neither the band nor the timer lies.

## 3. The three behaviour changes

All three are acceptable.

- `/effort` during `ready`: an improvement. `main` kept promising a warm cache the next request rewrites.
- `/effort` during a fork: the paid fork is lost, but only inside a window of under a minute. The discarded handoff had little use, since the dropped cache means the next prompt is not asked about. `main` set a fresh touch here on a prefix that had just changed.
- Cold manual fork with no touch: the band is empty either way and the handoff is stored.

## 4. Types and lint

- No `string` remains where a union fits. The only production `as` is `as const` at `embers/hooks/state.ts:8`, which the API's own example uses (`d.ts:733`).
- All three switches are exhaustive under `tsc`. Deleting a case from each failed with an error.
- Biome enforces what the brief asked: `noExplicitAny`, `noNonNullAssertion` and `useExhaustiveSwitchCases` all fired on a deliberate sample.
- `docs/briefs/07-status.md:12` is wrong about why the rule stayed quiet. It fires on `phaseWords` and `outcome`, whose unions are declared in the same `.d.ts`. It stays quiet on `bandLine` because that switch has a `default`. The code is right as it stands, since `tsc` covers `bandLine`.

## 5. README

See findings 3 to 6. The band examples, the commands and every default match the code and `plugin.json`.

## 6. Tests

See finding 2.

## Verdict

MERGE AFTER FIXES: finding 1 and the tests in finding 2.
