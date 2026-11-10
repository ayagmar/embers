import type { EngineInterface, ModelForkResult, ModelUsage, PromptSubmitResult } from 'claude-code'

import type { HandoffRecord } from '../types'
import { disarm, inProcess } from './process'
import {
  addStats,
  currentBranch,
  handoffKey,
  listHandoffs,
  marginFor,
  markOffered,
  readHandoff,
  readStats,
  readTtl,
  sweep,
  ttlKey,
  ttlMinutes,
  wasOffered,
} from './records'
import type { ColdChoice, Config } from './shared'
import {
  cacheWords,
  clockTime,
  coldChoiceOf,
  coldOptions,
  compose,
  dateTime,
  fixedTokens,
  forkCost,
  forkFigures,
  handoffPrompt,
  handoffTokens,
  handoffView,
  isWarmRead,
  KNOWN_TTLS,
  k,
  LOAD,
  lastAssistantText,
  MINUTE,
  minutesOf,
  phaseWords,
  SKIP,
  SLACK_MS,
  statsWords,
  swapSaving,
} from './shared'
import {
  apply,
  cacheTouched,
  cleared,
  forkFailed,
  forkSkipped,
  forkStarted,
  forkWritten,
  isOff,
  lapseObserved,
  offerMade,
  prefixReplaced,
  readCurrent,
  readRun,
} from './state'

type NoHandoff =
  | 'no context size yet'
  | 'the conversation moved on while it was written'
  | Extract<ModelForkResult, { isAnswered: false }>['reason']

type Written =
  | { kind: 'written'; record: HandoffRecord; usage: ModelUsage }
  | { kind: 'none'; reason: NoHandoff; usage?: ModelUsage }

/** What a fork came to, for a log line or a command's reply. */
export function outcome(written: Written): string {
  switch (written.kind) {
    case 'written':
      return `Handoff written; ${forkFigures(written.usage)}`
    case 'none':
      return `No handoff (${written.reason})${written.usage ? `; ${forkFigures(written.usage)}` : ''}`
  }
}

export async function ttlMs($: EngineInterface, config: Config): Promise<number> {
  return (await ttlMinutes($, config.ttlMinutes)) * MINUTE
}

export function arm($: EngineInterface, config: Config, now: number, deadline: number): void {
  disarm()
  inProcess.timer = $.clock.after(Math.max(0, deadline - now), () => {
    inProcess.timer = undefined
    void fire($, config).catch(error => $.ui.log(`embers: handoff timer failed: ${String(error)}`, { to: 'debug' }))
  })
}

/**
 * Forks a handoff over the cached prefix and stores it, bound to the session
 * id, root and turn count captured before the fork.
 */
export async function writeHandoff($: EngineInterface, config: Config): Promise<Written> {
  const [sessionId, root, turns, usage] = await Promise.all([
    $.session.id(),
    $.session.root(),
    $.session.turns(),
    $.session.usage(),
  ])
  const contextTokens = usage.context.tokens
  if (contextTokens === undefined) {
    // No timer runs now: an `armed` phase would promise a handoff that never comes.
    await apply($, forkSkipped)
    return { kind: 'none', reason: 'no context size yet' }
  }
  const lastAssistant = lastAssistantText(await $.session.messages())
  const branch = await currentBranch($)
  await apply($, forkStarted)

  const reply = await $.model.fork({ prompt: handoffPrompt(config.handoffInstructions) })
  const now = await $.clock.now()
  // Every fork that reached the API is paid for, answered or not.
  if (reply.isAnswered || reply.reason !== 'nothing-to-fork') {
    await addStats($, now, { forks: 1, forkCost: forkCost(reply.usage) })
  }
  if (!reply.isAnswered) {
    await apply($, forkFailed, reply.reason === 'nothing-to-fork' ? undefined : { at: now, usage: reply.usage })
    return reply.reason === 'nothing-to-fork'
      ? { kind: 'none', reason: reply.reason }
      : { kind: 'none', reason: reply.reason, usage: reply.usage }
  }
  const [sessionAfter, turnsAfter, s] = await Promise.all([$.session.id(), $.session.turns(), readCurrent($)])
  if (sessionAfter !== sessionId || turnsAfter !== turns || s.phase.kind !== 'writing') {
    // A turn or a /clear that moved on set its own phase; only a stale `writing` is ours.
    await apply($, forkFailed, { at: now, usage: reply.usage })
    return { kind: 'none', reason: 'the conversation moved on while it was written', usage: reply.usage }
  }
  const record: HandoffRecord = {
    v: 1,
    root,
    branch,
    sessionId,
    turns,
    writtenAt: now,
    contextTokens,
    text: reply.text,
    lastAssistant,
  }
  const ttl = await ttlMs($, config)
  await $.store.set(handoffKey(root, sessionId), record)
  await sweep($, now, ttl)
  await apply($, forkWritten, { now, ttl, isWarm: isWarmRead(reply.usage), contextTokens, usage: reply.usage })
  return { kind: 'written', record, usage: reply.usage }
}

async function fire($: EngineInterface, config: Config): Promise<void> {
  const [s, now, ttl, model] = await Promise.all([readRun($), $.clock.now(), ttlMs($, config), $.session.model()])
  if (s.phase.kind !== 'armed') return
  const { cache } = s.phase
  if (cache.model !== model) {
    // The prefix is billed afresh after `/model`: a fork now pays for all of it.
    await apply($, forkSkipped)
    $.ui.log('embers: handoff skipped, the model changed since the last turn')
    return
  }
  if (now - cache.touchedAt >= ttl - SLACK_MS) {
    await apply($, forkSkipped)
    $.ui.log(`embers: handoff skipped, the cache had already lapsed after ${minutesOf(now - cache.touchedAt)}m idle`)
    return
  }
  // A log line, not a toast: the timer fires when nobody is looking.
  $.ui.log(`embers: ${outcome(await writeHandoff($, config))}`)
}

/**
 * Places the handoff in the transcript as a Markdown row for the person; the
 * model reads its own copy from the appended row. A log line is one line.
 */
export async function showHandoff($: EngineInterface, record: HandoffRecord): Promise<boolean> {
  const id = `handoff-${record.writtenAt}`
  inProcess.placed.set(id, handoffView(record))
  return (await $.ui.place({ id })).isPlaced
}

/** After a `/clear`: a new conversation with nothing cached and no timer. */
export async function afterClear($: EngineInterface): Promise<void> {
  disarm()
  await apply($, cleared)
}

/**
 * Swaps the conversation to the handoff: `/clear`, then the handoff as the
 * new conversation's first row. The host refuses `$.session.compact` inside
 * the hooks a cold prompt runs in, and a compaction from a timer skips this
 * plugin's own `session.compact` hook, so core would summarize the cold
 * prefix; a clear and an append make no model call.
 */
async function swap($: EngineInterface, record: HandoffRecord, plan: Reshape, resume: string): Promise<void> {
  const appended = await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: compose(record, 'swap') }] },
  })
  if (appended.deny !== undefined) {
    $.ui.log(`embers: the session was cleared but the handoff was refused (${appended.deny}). ${resume}`)
    return
  }
  // The handoff is in: what follows is feedback and bookkeeping, and its
  // failures must not read as a failed swap.
  const debug = (error: unknown): void => $.ui.log(`embers: after the swap: ${String(error)}`, { to: 'debug' })
  await $.store.delete(handoffKey(record.root, record.sessionId)).catch(debug)
  inProcess.lastShown = record
  await showHandoff($, record).catch(debug)
  const after = plan.fixed + handoffTokens(record)
  await $.clock
    .now()
    .then(now => addStats($, now, { swaps: 1, swapSaved: swapSaving(plan.tokens, after) }))
    .catch(debug)
  $.ui.log(
    `embers: swapped to the ${clockTime(record.writtenAt)} handoff, ${k(plan.tokens)} → ~${k(after)} tokens; send your prompt from the box. ${resume}`,
  )
}

/**
 * A resumed process: the session's own handoff, still matching its turn
 * count, says when the cache was last read and how large the context was,
 * so the first prompt is judged and a swap is offered.
 */
export async function seedFromHandoff($: EngineInterface, ttl: number): Promise<void> {
  const [sessionId, root, turns] = await Promise.all([$.session.id(), $.session.root(), $.session.turns()])
  const record = await readHandoff($, handoffKey(root, sessionId))
  if (record === undefined || record.turns !== turns) return
  await apply($, cacheTouched, { touchedAt: record.writtenAt, contextTokens: record.contextTokens, ttl })
}

/**
 * The cold-prompt path; undefined sends the prompt as it is. `knownTokens`
 * stands in for `context.tokens`, absent before a resumed process's first
 * response.
 */
export async function coldPrompt(
  $: EngineInterface,
  config: Config,
  idleMs: number,
  knownTokens: number | undefined,
): Promise<PromptSubmitResult | undefined> {
  const [sessionId, root, turns, usage] = await Promise.all([
    $.session.id(),
    $.session.root(),
    $.session.turns(),
    $.session.usage({ breakdown: 'summary' }),
  ])
  const tokens = usage.context.tokens ?? knownTokens
  const estimated = fixedTokens(usage.context.breakdown)
  if (tokens === undefined || tokens < config.minContextTokens || estimated === undefined) return undefined
  // A local estimate that can exceed the API's figure: Fresh never costs more than sending.
  const fixed = Math.min(estimated, tokens)
  if (tokens - fixed < config.minSavingTokens) return undefined
  const onFile = await readHandoff($, handoffKey(root, sessionId))
  const matching = onFile !== undefined && onFile.turns === turns ? onFile : undefined
  if (matching !== undefined && tokens - (fixed + handoffTokens(matching)) < config.minSavingTokens) {
    return undefined
  }

  // Writing a handoff now would reread the cold prefix and then throw that
  // write away: with no handoff on file, the choice is to send or start fresh.
  let choice: ColdChoice | undefined
  if (config.coldMode === 'swap' && matching !== undefined) {
    choice = 'swap'
  } else {
    const options = coldOptions({
      send: tokens,
      fresh: fixed,
      swap: matching === undefined ? undefined : fixed + handoffTokens(matching),
    })
    const clears =
      matching === undefined
        ? 'a fresh session clears it'
        : `swapping to the ${clockTime(matching.writtenAt)} handoff or a fresh session clears it`
    const question = `The prompt cache is cold (${minutesOf(idleMs)}m idle). Sending rewrites ${k(tokens)} tokens; ${clears} (paste attachments again). What now?`
    const answer = await $.ui
      .ask(question, { header: 'embers', options: options.map(([, label]) => label) })
      .catch(() => undefined)
    // No one to ask (-p): send, as the prompt would have gone without embers.
    if (answer === undefined && (await $.session.surfaces()).length === 0) return undefined
    choice = answer === undefined ? undefined : coldChoiceOf(answer, options)
  }

  // Dismissed, or free text under "Other": nothing is decided, so nothing is spent.
  if (choice === undefined) return { drop: 'embers: nothing sent; your prompt is back in the box' }
  if (choice === 'send') return undefined
  if (choice === 'read' && matching !== undefined) {
    // The person chose to spend nothing: a display failure must not send the prompt.
    const isShown = await showHandoff($, matching).catch(() => false)
    return {
      drop: isShown
        ? 'embers: the handoff is above; your prompt is back in the box, send it to choose'
        : 'embers: the handoff could not be shown; nothing sent, your prompt is back in the box',
    }
  }
  // The host refuses a compaction or a command under the turn a prompt.submit
  // hook holds, so the prompt is dropped (the engine puts it back in the box)
  // and the session is reshaped from a timer for the person to send it again.
  const plan = { swapTo: choice === 'swap' ? matching : undefined, tokens, fixed }
  inProcess.isReshaping = true
  $.clock.after(0, () => {
    void reshape($, plan).catch(error => $.ui.log(`embers: ${choice} failed: ${String(error)}`, { to: 'debug' }))
  })
  const what = choice === 'fresh' ? 'starting fresh' : 'swapping to the handoff'
  return { drop: `embers: ${what}; your prompt stays in the box (paste attachments again)` }
}

/** A swap to `swapTo`, or a fresh session when it is absent. */
type Reshape = { swapTo: HandoffRecord | undefined; tokens: number; fixed: number }

/**
 * Runs the choice made at a cold prompt; the engine has put the dropped prompt
 * back in the box. Every outcome is a log line, the old session's id in each
 * one past the `/clear`.
 */
async function reshape($: EngineInterface, plan: Reshape): Promise<void> {
  let resume = ''
  let isCleared = false
  try {
    const oldId = await $.session.id()
    resume = `Old conversation: claude --resume ${oldId}`
    await $.command.run({ command: 'clear' })
    // A hook can answer `/clear` without running it: only a new session id proves the clear.
    const newId = await $.session.id().catch(() => undefined)
    if (newId === undefined) {
      $.ui.log(`embers: /clear ran but its result could not be checked; the handoff was not added. ${resume}`)
      return
    }
    if (newId === oldId) throw new Error('/clear left the conversation in place')
    isCleared = true
    await afterClear($)
    if (plan.swapTo === undefined) {
      $.ui.log(`embers: started a fresh session; send your prompt from the box. ${resume}`)
      return
    }
    await swap($, plan.swapTo, plan, resume)
  } catch (error) {
    $.ui.log(
      isCleared
        ? `embers: the session was cleared but the handoff was not added (${String(error)}). ${resume}`
        : `embers: the session could not be cleared (${String(error)}); nothing changed`,
    )
  } finally {
    inProcess.isReshaping = false
    // The person has chosen: the prompt they send next is not asked about again,
    // unless nothing changed and the cache is as cold as it was.
    if (isCleared) await apply($, prefixReplaced, 'cold-choice')
  }
}

/**
 * Reads the main loop's first response after an idle. A cold read inside the
 * TTL can also follow a reload, an MCP reconnect or a changed system prompt,
 * so the first is only held; a second in a later idle period stores the
 * shorter TTL. A warm read past a TTL clears it.
 */
export async function observeTtl(
  $: EngineInterface,
  config: Config,
  touch: number,
  idleMs: number,
  usage: ModelUsage,
): Promise<void> {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total === 0) return
  const [model, now, s] = await Promise.all([$.session.model(), $.clock.now(), readRun($)])
  const key = ttlKey(model)
  const override = await readTtl($, key, now)
  const ttl = override?.observedMinutes ?? config.ttlMinutes
  const idleMinutes = idleMs / MINUTE
  const held = s.lapse?.isPending === true && s.lapse.model === model ? s.lapse : undefined
  if (usage.cache_read_input_tokens < 0.1 * total && idleMinutes < ttl) {
    const observed = KNOWN_TTLS.filter(minutes => minutes <= idleMinutes).at(-1)
    if (observed === undefined || observed >= ttl) return
    const lapse = { afterMinutes: observed, marginMinutes: marginFor(observed, config.marginMinutes), touch, model }
    if (held === undefined || held.touch === touch) {
      await apply($, lapseObserved, { ...lapse, isPending: true })
      return
    }
    await $.store.set(key, { v: 1, observedMinutes: observed, observedAt: now })
    await apply($, lapseObserved, lapse)
  } else if (isWarmRead(usage)) {
    if (override !== undefined && idleMinutes > override.observedMinutes) {
      await $.store.delete(key)
      await apply($, lapseObserved, undefined)
    } else if (held !== undefined && idleMinutes > held.afterMinutes) {
      await apply($, lapseObserved, undefined)
    }
  }
}

export async function offerHandoff($: EngineInterface, config: Config): Promise<void> {
  const s = await readRun($)
  if (s.startOffered) return
  await apply($, offerMade)
  const [root, sessionId, branch, now, ttl] = await Promise.all([
    $.session.root(),
    $.session.id(),
    currentBranch($),
    $.clock.now(),
    ttlMs($, config),
  ])
  let offer: HandoffRecord | undefined
  for (const record of await listHandoffs($, root)) {
    if (record.branch !== branch || record.sessionId === sessionId || now - record.writtenAt < ttl) continue
    if (await wasOffered($, record)) continue
    offer = record
    break
  }
  if (offer === undefined) return
  const where = offer.branch === '' ? 'this folder' : `branch ${offer.branch}`
  const answer = await $.ui
    .ask(
      `embers has a handoff from ${dateTime(offer.writtenAt)} on ${where} (a ${k(offer.contextTokens)}-token session). Load it into this session?`,
      { header: 'embers', options: [LOAD, SKIP] },
    )
    .catch(() => SKIP)
  // Kept, and marked shown under a key of its own: its session may still be
  // open, and swap to it or write a newer one.
  await markOffered($, offer)
  if (answer !== LOAD) return
  const appended = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: compose(offer, 'load') }] } })
    .catch((error: unknown) => ({ deny: String(error) }))
  if (appended.deny !== undefined) {
    $.ui.log(`embers: the handoff was not loaded (${appended.deny})`)
    return
  }
  await addStats($, now, { loads: 1 })
  inProcess.lastShown = offer
  await showHandoff($, offer).catch(() => false)
  $.ui.log(`embers: loaded the ${clockTime(offer.writtenAt)} handoff (~${k(handoffTokens(offer))} tokens)`)
}

export async function status($: EngineInterface, config: Config): Promise<string> {
  const [root, sessionId, model, s, now] = await Promise.all([
    $.session.root(),
    $.session.id(),
    $.session.model(),
    readRun($),
    $.clock.now(),
  ])
  const override = await readTtl($, ttlKey(model), now)
  const ttl = override
    ? `${override.observedMinutes}m for ${model}, observed ${dateTime(override.observedAt)}`
    : `${config.ttlMinutes}m for ${model} (configured)`
  const fork = s.lastFork ? `${clockTime(s.lastFork.at)}, ${forkFigures(s.lastFork.usage)}` : 'none this session'
  const rows = (await listHandoffs($, root)).map(
    record =>
      `  ${dateTime(record.writtenAt)}  ${record.branch === '' ? '(no branch)' : record.branch}  ${record.turns} turns  ${k(record.contextTokens)} tokens  ${record.sessionId === sessionId ? 'this session' : record.sessionId.slice(0, 8)}`,
  )
  const handoffs = rows.length === 0 ? 'No handoffs for this root.' : `Handoffs for ${root}:\n${rows.join('\n')}`
  return [
    `embers is ${isOff(s) ? 'off' : 'on'}.`,
    `Cache: ${cacheWords(s.phase.cache, now)}.`,
    `Phase: ${phaseWords(s.phase)}.`,
    `Last fork: ${fork}.`,
    `TTL: ${ttl}.`,
    handoffs,
    statsWords(await readStats($, now)),
  ].join('\n')
}
