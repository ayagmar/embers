# Brief 09: fix the sweep review findings

`docs/briefs/08-review-report.md` says MERGE AFTER FIXES. Do all six findings on `refactor/sweep` in `/home/ayagmar/.cache/embers/sweep`, one commit each, Conventional Commits, no attribution trailers. Decisions already taken:

1. Finding 1: `/embers` treats the cache as cold when `cache.model` is set and differs from the current model. A seeded touch (no model) must not trigger the ask.
2. Finding 2: the four tests as the report lists them, plus the `manualClock` change to the `/clear` test. Each named for the bug it catches; check each by putting its bug back.
3. Finding 3: enforce off in `apply`, as the report's snippet does. `/embers on` clears the variable first.
4. Finding 4: README install gets a clone command and one sentence that `--plugin-dir` is per session, with `CLAUDE_CODE_PLUGIN_DIRS` for every session (check the exact variable in `docs/reference/plugin-authoring-reference.md`).
5. Finding 5: drop `off` from `coldMode`; the values are `ask`, `swap`, `send`. Update `plugin.json`, `Config`, `DESIGN.md`, README.
6. Finding 6: measure one fork after a multi-step turn in a live run (a turn where the model runs five or more tool calls with sizeable output, such as reading several files), record the figures in the status note, and state in the README's Cost section that the write grows with the last turn's tool output, with the measured figure.

Commit `docs/briefs/08-review-sweep.md`, `08-review-report.md` and this brief first as `docs: sweep review briefs and report`. `npm run check` clean. Close the scratch session and remove scratch files. Push and write `docs/briefs/09-status.md`; reply with its path.
