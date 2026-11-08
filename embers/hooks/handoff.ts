import type { EngineInterface, ModelUsage, PromptSubmitResult } from 'claude-code'

import type { HandoffRecord } from '../types'
import { disarm, inProcess } from './process'
import {
  currentBranch,
  handoffKey,
  listHandoffs,
  marginFor,
  readHandoff,
  readTtl,
  sweep,
  ttlKey,
  ttlMinutes,
} from './records'
import type { Config } from './shared'
import {
  clockTime,
  compose,
  dateTime,
  FRESH,
  fixedTokens,
  forkFigures,
  HANDOFF_PROMPT,
  handoffTokens,
  isWarmRead,
  KNOWN_TTLS,
  k,
  LOAD,
  lastAssistantText,
  MINUTE,
  minutesOf,
  SEND,
  SKIP,
  SLACK_MS,
  SWAP,
} from './shared'
import {
  apply,
  cacheTouched,
  cleared,
  forkFailed,
  forkSkipped,
  forkStarted,
  forkWritten,
  lapseObserved,
  offerMade,
  prefixReplaced,
  readRun,
} from './state'

type Written = { record: HandoffRecord; usage: ModelUsage } | { reason: string; usage?: ModelUsage }

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
    return { reason: 'no context size yet' }
  }
  const lastAssistant = lastAssistantText(await $.session.messages())
  const branch = await currentBranch($)
  await apply($, forkStarted)

  const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
  const now = await $.clock.now()
  if (!reply.isAnswered) {
    await apply($, forkFailed)
    return reply.reason === 'nothing-to-fork' ? { reason: reply.reason } : { reason: reply.reason, usage: reply.usage }
  }
  const [sessionAfter, turnsAfter, s] = await Promise.all([$.session.id(), $.session.turns(), readRun($)])
  if (sessionAfter !== sessionId || turnsAfter !== turns || s.phase.kind !== 'writing') {
    // A turn or a /clear that moved on set its own phase; only a stale `writing` is ours.
    await apply($, forkFailed)
    return { reason: 'the conversation moved on while it was written', usage: reply.usage }
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
  await apply($, forkWritten, { now, ttl, isWarm: isWarmRead(reply.usage), contextTokens })
  return { record, usage: reply.usage }
}

async function fire($: EngineInterface, config: Config): Promise<void> {
  const [s, now, ttl, model] = await Promise.all([readRun($), $.clock.now(), ttlMs($, config), $.session.model()])
  if (s.phase.kind !== 'armed') return
  const { cache } = s.phase
  if (cache.model !== model) {
    // The prefix is billed afresh after `/model`: a fork now pays for all of it.
    await apply($, forkSkipped)
    $.ui.toast('embers: handoff skipped, the model changed since the last turn')
    return
  }
  if (now - cache.touchedAt >= ttl - SLACK_MS) {
    await apply($, forkSkipped)
    $.ui.toast(`embers: handoff skipped, the cache had already lapsed after ${minutesOf(now - cache.touchedAt)}m idle`)
    return
  }
  const written = await writeHandoff($, config)
  $.ui.toast(
    'record' in written
      ? `embers: handoff written; ${forkFigures(written.usage)}`
      : `embers: no handoff (${written.reason})${written.usage ? `; ${forkFigures(written.usage)}` : ''}`,
  )
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
async function swap($: EngineInterface, record: HandoffRecord, tokens: number, fixed: number): Promise<void> {
  const oldId = await $.session.id()
  await $.command.run({ command: 'clear' })
  await afterClear($)
  const appended = await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: compose(record) }] },
  })
  if (appended.deny !== undefined) {
    $.ui.toast(`embers: the session was cleared but the handoff was refused (${appended.deny})`)
    return
  }
  await $.store.delete(handoffKey(record.root, record.sessionId))
  // What the model now holds, for the person to read; the model never reads a log line.
  $.ui.log(compose(record))
  $.ui.toast(
    `embers: swapped ${k(tokens)} → ~${k(fixed + handoffTokens(record))} tokens (handoff ${k(handoffTokens(record))}); send your prompt from the box. Old conversation: claude --resume ${oldId}`,
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
  let choice: string
  if (config.coldMode === 'swap' && matching !== undefined) {
    choice = SWAP
  } else {
    const swapCost =
      matching === undefined
        ? ''
        : `; swapping to the ${clockTime(matching.writtenAt)} handoff writes ~${k(fixed + handoffTokens(matching))}`
    const question = `The prompt cache is cold (${minutesOf(idleMs)}m idle). Sending rewrites ${k(tokens)} tokens${swapCost}; a fresh session writes ~${k(fixed)} (paste attachments again). What now?`
    const labels = matching === undefined ? [SEND, FRESH] : [SWAP, SEND, FRESH]
    choice = await $.ui.ask(question, { header: 'embers', options: labels }).catch(() => SEND)
  }

  if (choice !== FRESH && choice !== SWAP) return undefined
  // The host refuses a compaction or a command under the turn a prompt.submit
  // hook holds, so the prompt is dropped (the engine puts it back in the box)
  // and the session is reshaped from a timer for the person to send it again.
  const plan = { swapTo: choice === SWAP ? matching : undefined, tokens, fixed }
  inProcess.isReshaping = true
  $.clock.after(0, () => {
    void reshape($, plan).catch(error => $.ui.log(`embers: ${choice} failed: ${String(error)}`, { to: 'debug' }))
  })
  const what = choice === FRESH ? 'starting fresh' : 'swapping to the handoff'
  return { drop: `embers: ${what}; your prompt stays in the box (paste attachments again)` }
}

/** A swap to `swapTo`, or a fresh session when it is absent. */
type Reshape = { swapTo: HandoffRecord | undefined; tokens: number; fixed: number }

/** Runs the choice made at a cold prompt; the engine has put the dropped prompt back in the box. */
async function reshape($: EngineInterface, plan: Reshape): Promise<void> {
  try {
    if (plan.swapTo === undefined) {
      await $.command.run({ command: 'clear' })
      await afterClear($)
      $.ui.toast('embers: started a fresh session; send your prompt from the box')
      return
    }
    await swap($, plan.swapTo, plan.tokens, plan.fixed)
  } finally {
    // The person has chosen: the prompt they send next is not asked about again.
    inProcess.isReshaping = false
    await apply($, prefixReplaced, 'cold-choice')
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
  const override = await readTtl($, key)
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
  const offer = (await listHandoffs($, root)).find(
    record =>
      record.branch === branch &&
      record.sessionId !== sessionId &&
      record.offeredAt === undefined &&
      now - record.writtenAt >= ttl,
  )
  if (offer === undefined) return
  const where = offer.branch === '' ? 'this folder' : `branch ${offer.branch}`
  const answer = await $.ui
    .ask(
      `embers has a handoff from ${dateTime(offer.writtenAt)} on ${where} (a ${k(offer.contextTokens)}-token session). Load it into this session?`,
      { header: 'embers', options: [LOAD, SKIP] },
    )
    .catch(() => SKIP)
  if (answer !== LOAD) {
    await $.store.set(handoffKey(offer.root, offer.sessionId), { ...offer, offeredAt: now })
    return
  }
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: compose(offer) }] } })
  await $.store.delete(handoffKey(offer.root, offer.sessionId))
  $.ui.toast(`embers: loaded the ${clockTime(offer.writtenAt)} handoff (~${k(handoffTokens(offer))} tokens)`)
}

export async function status($: EngineInterface, config: Config): Promise<string> {
  const [root, sessionId, model, s] = await Promise.all([
    $.session.root(),
    $.session.id(),
    $.session.model(),
    readRun($),
  ])
  const override = await readTtl($, ttlKey(model))
  const ttl = override
    ? `TTL ${override.observedMinutes}m for ${model}, observed ${dateTime(override.observedAt)}`
    : `TTL ${config.ttlMinutes}m for ${model} (configured)`
  const rows = (await listHandoffs($, root)).map(
    record =>
      `  ${dateTime(record.writtenAt)}  ${record.branch === '' ? '(no branch)' : record.branch}  ${record.turns} turns  ${k(record.contextTokens)} tokens  ${record.sessionId === sessionId ? 'this session' : record.sessionId.slice(0, 8)}`,
  )
  const handoffs = rows.length === 0 ? 'No handoffs for this root.' : `Handoffs for ${root}:\n${rows.join('\n')}`
  return `${ttl}. ${s.isOff ? 'Off for this session.' : `Phase: ${s.phase.kind}.`}\n${handoffs}`
}
