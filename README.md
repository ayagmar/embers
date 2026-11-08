# embers

A Claude Code mod that keeps your context warm.

Claude's prompt cache lapses after a quiet hour (five minutes under some plans). Come back to a long session after that and your next message pays to rebuild the whole prefix. embers writes a handoff shortly before the cache lapses, while reading the prefix is still cheap, and when you return cold it swaps the conversation to that handoff instead of reloading everything.

Status: first implementation on `feat/mod`, not released. `docs/DESIGN.md` is the design; `docs/briefs/02-status.md` lists where the code departs from it and what is not yet verified.

## Layout

- `embers/`: the mod (manifest, hooks module, state contract).
- `docs/DESIGN.md`: what the mod does and why, the source of truth.
- `docs/briefs/`: worker and reviewer briefs.
- `docs/reference/`: the Claude Code plugin API types and reference, copied from the build this was designed against.

## Running it

```
claude --plugin-dir ./embers
```

## License

MIT.
