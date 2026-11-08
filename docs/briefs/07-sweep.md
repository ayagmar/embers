# Brief 07: architecture sweep, tooling, features, README

You are the worker. The mod on `main` works and is reviewed; this pass makes it clean before the owner starts using it. Behavior stays as `docs/DESIGN.md` describes except where this brief says otherwise.

## Where

Worktree `/home/ayagmar/.cache/embers/sweep`, branch `refactor/sweep`, of `/home/ayagmar/projects/embers`. Work only there. Conventional Commits, one logical change each, no attribution trailers. Push when done and reply with the path of `docs/briefs/07-status.md`.

## Read first

`docs/DESIGN.md`, `docs/briefs/05-recheck-report.md`, then every file under `embers/`. Load the `plugin-authoring` skill for the build's types and commands. The engine-laid types are in `embers/.claude-plugin/types/` once the mod has loaded; `tsc -p embers` needs the local `embers/tsconfig.json` the skill describes (gitignored; recreate it if missing).

## 1. Make the state machine explicit

Today `EmbersRun.phase` is a string and `deadline`, `handoffAt`, `warmUntil`, `lastCacheTouch`, `modelAtTouch`, `contextTokens` are optionals whose validity depends on it; twelve call sites write `{ phase: 'idle', deadline: undefined }` by hand.

Replace with a discriminated union, roughly:

```ts
type Cache = { touchedAt: number; model: string; contextTokens: number | undefined; warmUntil: number }
type Phase =
  | { kind: 'idle'; cache?: Cache }
  | { kind: 'armed'; cache: Cache; deadline: number }
  | { kind: 'writing'; cache: Cache }
  | { kind: 'ready'; cache: Cache; handoffAt: number }
```

and one module, `state.ts`, that owns the atom and exports named transitions, each a pure function `(run, input) => run` applied through one `apply($, transition, input)`: `turnEnded`, `promptStarted`, `forkStarted`, `forkFailed`, `forkWritten`, `cacheTouched`, `prefixReplaced` (compaction, model switch, effort), `cleared`. Hooks call transitions only; no hook spreads `$.state` by hand. `bandLine` is an exhaustive `switch` on `phase.kind`. Keep `lapse`, `startOffered` as they are, outside `Phase`. Bump the atom `shape` and treat an old-shaped stored value as `INITIAL`.

Invariants to keep, from the review trail: one fork per idle period; the timer deadline in state and the handle in a module variable, re-armed in `session.start`; session id and turns captured before the fork and re-checked after; a prompt during a swap is refused; `/clear` starts `$.state` over and raises no `session.start`.

## 2. One explicit off switch

Remove `withOff`. `/embers off` holds for the process: keep `isOff` as a module variable and in `$.state`; the only sync is in `session.start` (state to variable, for a reload) and in the `off`/`on` commands (both). A single `isOff(run)` reads `run.isOff || offInProcess`. Add `/embers on`.

## 3. Module-lifetime values in one place

`timer`, `isReshaping`, `offInProcess`: one `process.ts` (or a section of `state.ts`) with the lifetime stated once: they outlive a `/clear`, a reload starts them over.

## 4. Types and tooling

- No `string` where a union fits: the cold choice is `'swap' | 'send' | 'fresh'` mapped to labels, `Written` has a `kind`.
- Add Biome as the one dev dependency: `package.json` with `biome.json` (recommended rules plus `noExplicitAny`, `noNonNullAssertion`, `useExhaustiveSwitchCases` or the nearest equivalents, formatter on), and scripts `format`, `lint`, `typecheck` (`tsc -p embers`), `test` (`claude plugin test embers`), `validate` (`claude plugin validate embers`), `check` running all. Check the latest stable Biome version before pinning and state it in the commit. Run the formatter over `embers/` once as its own commit.
- `.gitignore` adds `node_modules/`.

## 5. UX

- Toast and command figures in words: `read 26k from cache, wrote 7.6k, 937 out`, with `(cold)` when the read was cold. One function, used everywhere a figure is shown.
- `/embers status` always says: on or off; cache warm until HH:MM or cold since HH:MM or unknown; phase in words; the last fork's figures and time (keep them in state); handoffs for this root; the TTL in force.
- Band wording unchanged.

## 6. Feature: `handoffInstructions`

A `userConfig` string option, default empty, appended to the handoff prompt as its last sentence when set. Document it in `plugin.json`, `DESIGN.md` and the README.

## 7. README

Rewrite `README.md` short and plain, in this order: one paragraph on what it does and why; install (`claude --plugin-dir ~/projects/embers/embers`); what you see (the band line, the cold ask with its three choices, the start offer); the commands; the options table with defaults; cost in two sentences (the fork reads the cached prefix, its uncached tail is the last turn; an abandoned session costs one fork); a line pointing at `docs/DESIGN.md`. No status section, no development history. Under 80 lines.

## 8. Tests

Keep every existing test green; they assert behavior and must survive the refactor unchanged except for the state-shape seeding. Add one test only for `/embers on`. Delete any test that now asserts implementation detail.

## Verify before you stop

`npm run check` clean. Then one short live run (`claude --plugin-dir ./embers --settings <scratch>`, `ttlMinutes` 2, `marginMinutes` 1, `minContextTokens` 0): band, fork toast in the new wording, `/embers status`, `/embers off`, `/embers on`. Record the figures in the status note. Close the scratch session and remove scratch files.

Do not merge, do not publish, do not touch `main`.
