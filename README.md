# embers

Claude's prompt cache lapses after a quiet hour (five minutes on some plans), and the next message after that pays to write your whole conversation to the cache again. embers writes a short handoff just before the cache lapses, while reading the conversation is still cheap. When you come back cold, you can continue from the handoff instead of rewriting everything.

## Install

```
git clone https://github.com/ayagmar/embers ~/projects/embers
claude --plugin-dir ~/projects/embers/embers
```

`--plugin-dir` loads it for that one session. To load it in every session, set `CLAUDE_CODE_PLUGIN_DIRS` to `~/projects/embers/embers` in your shell or in the `env` block of `~/.claude/settings.json`.

## What you see

A line above the prompt, once the context is big enough:

```
embers  warm  handoff at 12:55
embers  writing handoff…
embers  handoff ready  12:55, 118k tokens, warm until 13:55
```

If you send a prompt after the cache has gone cold, embers asks what to do and shows what each choice costs:

- **Swap to handoff**: clear the session and continue from the handoff. Offered only when a handoff matches this conversation. Send your prompt again from the box.
- **Send as is**: send the prompt and rewrite the cache.
- **Fresh session**: clear the session with no handoff. Send your prompt again from the box.

When a new session starts in a folder where an earlier one left a handoff on the same branch, embers offers to load it. Choose **Load it** or **Skip**.

Each handoff shows a toast with its cost, such as `read 26k from cache, wrote 7.6k, 937 out`.

## Commands

| Command | What it does |
|---|---|
| `/embers` | Writes a handoff now, and asks first if the cache is cold. |
| `/embers status` | Shows on or off, the cache, the phase, the last fork, the TTL and this folder's handoffs. |
| `/embers off` | Turns embers off until you run `/embers on` or quit. |
| `/embers on` | Turns it back on; the next turn to end arms it. |

## Options

Set these in the plugin's config menu.

| Option | Default | Meaning |
|---|---|---|
| `ttlMinutes` | 60 | How long the cache is assumed to last. A TTL reported by Claude Code or observed by embers overrides it. |
| `marginMinutes` | 5 | How long before the TTL the handoff is written. Cut for short TTLs. |
| `minContextTokens` | 40000 | Below this context size, embers does nothing. |
| `minSavingTokens` | 20000 | A swap must shrink the context by at least this much. |
| `coldMode` | `ask` | On a cold prompt: `ask`, `swap` without asking when a handoff matches, or `send` without asking. |
| `offerOnStart` | true | Offer an earlier handoff when a session starts. |
| `showBand` | true | Draw the line above the prompt. |
| `handoffInstructions` | empty | Added to the handoff prompt as its last sentence. |

## Cost

A handoff reads the cached conversation and, in the runs measured, writes little to the cache: 7.6k tokens after a conversation's first turn, and none after a turn of eight file reads that added 46k tokens. A session you abandon costs one handoff.

The design is in `docs/DESIGN.md`.
