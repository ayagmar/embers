# Brief 01: challenge the embers design

You are the reviewer. This is a read-only task: make no edits, commits, or new files inside the repository except the one report named below.

## Repository

`/home/ayagmar/projects/embers`, branch `main`. Nothing is implemented yet.

## Read, in this order

1. `docs/DESIGN.md`: the design under review.
2. `docs/reference/plugin-authoring-reference.md`: how a Claude Code mod works.
3. `docs/reference/claude-code.d.ts`: the full plugin API for this build. Grep it for the names the design uses: `prompt.submit`, `session.compact`, `$.model.fork` (`ModelForkRequest`, `ModelForkResult`), `turn.complete` (`TurnUsage`), `$.clock`, `$.store`, `$.state`, `userConfig`, `ui.render` with `AbovePrompt`, `$.command.run`, `$.prompt.submit`, `session.start`, `session.end`, `session.measure`.
4. `docs/reference/examples/band.tsx` and `pane.tsx`: complete working mods.

You may also load the `plugin-authoring` skill for the same material.

## What to do

Try to break the design before anyone implements it. Verify every claim in `docs/DESIGN.md` against the API types verbatim. For each of the six open questions at the end of the design, answer with the type or doc line that decides it, quoted with its line number in `claude-code.d.ts`.

Then look for what the design misses. In particular:

- Any path where the mod costs more than doing nothing: a fork that rewrites the cache, a timer that fires more than once per idle period, a handoff written for a context that was already small, a swap that pays a long cold prefix anyway.
- Any implicit state: a value that lives in a module variable and would be lost on hot reload, a stored value read without checking its shape, a held prompt that can be dropped.
- Races: a prompt typed while the fork is in flight; the timer firing during a turn; `/clear` or exit while writing; two sessions on the same project writing the same store key.
- UX: anything the person would find surprising, noisy, or unclear in the band, the toast, the choices, or the commands.
- Cases the design should state and does not: subagents and forks of the session (the hooks fire for them too; the mod must act on the main loop only), `-p` runs, the TTL dropping to five minutes mid-session, the model changing with `/model`, a session resumed with `--resume` long after.

## Output

Write one report to `/home/ayagmar/projects/embers/docs/briefs/01-challenge-report.md` with:

1. Findings first, ordered by severity (blocker, major, minor). Each with: the claim or gap, the evidence (`claude-code.d.ts:<line>` or the design line), a concrete failure scenario, and the smallest change to the design that fixes it. No nits, no style remarks.
2. Answers to the six open questions, each with its evidence.
3. One verdict line: `ACCEPT`, `MODIFY` (with the list of changes the design needs), or `REJECT` (with why).

Reply in the chat with the report path only.
