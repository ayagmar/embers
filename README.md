# embers

A Claude Code plugin that makes coming back to a long conversation cheaper.

Claude keeps your conversation in a cache for about an hour after your last message (five minutes on some plans). Step away longer and the next message pays to load the whole conversation again, which on a long session is the most expensive message of the day. embers notices when you've gone quiet, writes a short summary of where you were just before the cache expires, and when you come back offers to continue from that summary instead. embers calls the summary a handoff.

## What it saves

Coming back to a 100k-token conversation after the cache has expired, counted in input tokens:

| When you come back you... | Costs now | Each later message reads |
|---|---|---|
| send as usual, without embers | ~125k | 100k |
| switch to the embers summary | ~46k (15k for the summary, written while you were away, plus 31k to start fresh from it) | 25k |
| never come back | ~15k for the summary | |

embers writes at most one summary per break, and none for short conversations.

## Install

From the marketplace:

```
/plugin marketplace add ayagmar/claude-mods
/plugin install embers@ayagmar
```

Or from a clone, for one session:

```
git clone https://github.com/ayagmar/embers ~/projects/embers
claude --plugin-dir ~/projects/embers/embers
```

To load the clone in every session, set `CLAUDE_CODE_PLUGIN_DIRS` to `~/projects/embers/embers` in your shell or in the `env` block of `~/.claude/settings.json`.

## Using it

There is nothing to do while you work. Once a conversation is long enough, a line above the prompt shows what embers is doing:

```
embers  warm  handoff at 12:55
embers  writing handoff…
embers  handoff ready  12:55, 118k tokens, warm until 13:55
```

### Coming back after a break

If you send a message after the cache has expired, embers holds it and asks what to do. Each choice shows how many tokens it will cost:

- **Swap to handoff**: start a clean conversation from the summary. Your message stays in the box; send it again.
- **Send as is**: send the message and pay to reload the full conversation.
- **Fresh session**: start a clean conversation with no summary. Send your message again.
- **Read it first**: show the summary without changing anything.

Press Esc to cancel; nothing is sent and your message stays in the box. Attachments need to be pasted again after a swap or fresh start.

After a swap, the summary appears in the transcript so you can see what the model was given, along with a `claude --resume <id>` command that takes you back to the full old conversation.

### Starting a new session

If you open a new session in a folder where an earlier session left a summary on the same git branch, embers offers to load it. Choose **Load it** or **Skip**. The model is told the summary is from an earlier session and that files may have changed since.

### What it costs

Each summary prints one line with its cost, such as `embers: Handoff written; read 26k from cache, wrote 7.6k, 937 out`. `/embers status` shows this month's total: what summaries cost and what swaps saved.

## Commands

| Command | What it does |
|---|---|
| `/embers` | Write a summary now. Asks first if the cache has already expired, since that costs more. |
| `/embers show` | Show this session's summary. The model doesn't see it. |
| `/embers status` | Show whether embers is on, the cache state, saved summaries for this folder, and this month's costs and savings. |
| `/embers off` | Turn embers off until `/embers on` or you quit. |
| `/embers on` | Turn it back on. |

## Settings

Change these in the plugin's config menu.

| Setting | Default | What it does |
|---|---|---|
| `ttlMinutes` | 60 | How long the cache is assumed to last. embers adjusts this if it sees the cache expiring sooner. |
| `marginMinutes` | 5 | How many minutes before expiry to write the summary. |
| `minContextTokens` | 40000 | Conversations smaller than this are left alone. |
| `minSavingTokens` | 20000 | Don't offer a swap unless it saves at least this many tokens. |
| `coldMode` | `ask` | What to do when you come back: `ask`, `swap` automatically when a summary exists, or `send` without asking. |
| `offerOnStart` | true | Offer an earlier session's summary when a new session starts. |
| `showBand` | true | Show the status line above the prompt. |
| `handoffInstructions` | empty | Extra instructions added to the end of the summary prompt. |

Summaries older than 14 days are deleted.

## How it works

See [docs/DESIGN.md](docs/DESIGN.md) for the design, diagrams and stored data.

## Developing

```
npm ci && npm run check
```

That runs Biome, `tsc`, the plugin tests and `claude plugin validate`. The type-check needs the plugin API types, which Claude Code writes under `embers/.claude-plugin/types/` the first time the mod loads with the `plugin-authoring` skill active; they are gitignored. `docs/probes/` holds a small plugin whose test shows why the swap clears the session instead of compacting it.
