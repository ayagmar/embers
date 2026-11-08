import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PromptSubmitResult, Timer } from 'claude-code'

import type { EmbersRun, HandoffRecord } from '../types'
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
import {
  FRESH,
  HANDOFF_PROMPT,
  KNOWN_TTLS,
  LOAD,
  MINUTE,
  SEND,
  SKIP,
  SLACK_MS,
  SWAP,
  clockTime,
  compose,
  dateTime,
  fixedTokens,
  forkFigures,
  handoffTokens,
  isWarmRead,
  k,
  lastAssistantText,
  minutesOf,
} from './shared'
import type { Config } from './shared'

export const INITIAL: EmbersRun = {
  phase: 'idle',
  isInteractive: false,
  isOff: false,
  startOffered: false,
}
const run = atom({ plugin: 'embers', key: 'run' } as const, INITIAL, { shape: 'run-1' })
/** The session's state; a read while drawing subscribes the drawing. */
export function readRun($: EngineInterface): Promise<EmbersRun> {
  return read($, run)
}
/** `update` with one signature, so the change's literals keep their types. */
export function change($: EngineInterface, fn: (r: EmbersRun) => EmbersRun): Promise<EmbersRun> {
  return update($, run, fn)
}

type Written = { record: HandoffRecord; usage: ModelUsage } | { reason: string; usage?: ModelUsage }

// The one value a reload loses; `session.start` re-arms it from `$.state`.
let timer: Timer | undefined

export function disarm(): void {
  timer?.cancel()
  timer = undefined
}

export async function ttlMs($: EngineInterface, config: Config): Promise<number> {
  return (await ttlMinutes($, config.ttlMinutes)) * MINUTE
}

export function arm($: EngineInterface, config: Config, now: number, deadline: number): void {
  disarm()
  timer = $.clock.after(Math.max(0, deadline - now), () => {
    timer = undefined
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
  if (contextTokens === undefined) return { reason: 'no context size yet' }
  const lastAssistant = lastAssistantText(await $.session.messages())
  const branch = await currentBranch($)
  await change($, r => ({ ...r, phase: 'writing', deadline: undefined }))

  const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
  const now = await $.clock.now()
  if (!reply.isAnswered) {
    await change($, r => (r.phase === 'writing' ? { ...r, phase: 'idle' } : r))
    return reply.reason === 'nothing-to-fork'
      ? { reason: reply.reason }
      : { reason: reply.reason, usage: reply.usage }
  }
  const [sessionAfter, turnsAfter, s] = await Promise.all([
    $.session.id(),
    $.session.turns(),
    read($, run),
  ])
  if (sessionAfter !== sessionId || turnsAfter !== turns || s.phase !== 'writing') {
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
  await $.store.set(handoffKey(root, sessionId), record)
  await sweep($, now)
  const isWarm = isWarmRead(reply.usage)
  const ttl = await ttlMs($, config)
  await change($, r => {
    if (r.phase !== 'writing') return r
    const touch = isWarm ? now : r.lastCacheTouch
    return {
      ...r,
      phase: 'ready',
      handoffAt: now,
      lastCacheTouch: touch,
      warmUntil: touch === undefined ? undefined : touch + ttl,
    }
  })
  return { record, usage: reply.usage }
}

async function fire($: EngineInterface, config: Config): Promise<void> {
  const [s, now, ttl, model] = await Promise.all([read($, run), $.clock.now(), ttlMs($, config), $.session.model()])
  if (s.phase !== 'armed') return
  if (s.modelAtTouch !== model) {
    // The prefix is billed afresh after `/model`: a fork now pays for all of it.
    await change($, r => (r.phase === 'armed' ? { ...r, phase: 'idle', deadline: undefined } : r))
    $.ui.toast('embers: handoff skipped, the model changed since the last turn')
    return
  }
  if (s.lastCacheTouch === undefined || now - s.lastCacheTouch >= ttl - SLACK_MS) {
    await change($, r => (r.phase === 'armed' ? { ...r, phase: 'idle', deadline: undefined } : r))
    const idle = s.lastCacheTouch === undefined ? '' : ` after ${minutesOf(now - s.lastCacheTouch)}m idle`
    $.ui.toast(`embers: handoff skipped, the cache had already lapsed${idle}`)
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
export async function cleared($: EngineInterface): Promise<void> {
  disarm()
  await change($, r => ({
    ...INITIAL,
    isInteractive: r.isInteractive,
    isOff: r.isOff,
    startOffered: r.startOffered,
    reshaping: r.reshaping,
  }))
}

/**
 * Swaps the conversation to the handoff: `/clear`, then the handoff as the
 * new conversation's first row. The host refuses `$.session.compact` inside
 * the hooks a cold prompt runs in, and a compaction from a timer skips this
 * plugin's own `session.compact` hook, so core would summarize the cold
 * prefix; a clear and an append make no model call.
 */
async function swap(
  $: EngineInterface,
  record: HandoffRecord,
  tokens: number,
  fixed: number,
): Promise<void> {
  const oldId = await $.session.id()
  await $.command.run({ command: 'clear' })
  await cleared($)
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
export async function seedFromHandoff($: EngineInterface): Promise<void> {
  const [sessionId, root, turns] = await Promise.all([$.session.id(), $.session.root(), $.session.turns()])
  const record = await readHandoff($, handoffKey(root, sessionId))
  if (record === undefined || record.turns !== turns) return
  await change($, r =>
    r.lastCacheTouch !== undefined
      ? r
      : { ...r, lastCacheTouch: record.writtenAt, contextTokens: record.contextTokens },
  )
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
  const fixed = fixedTokens(usage.context.breakdown)
  if (tokens === undefined || tokens < config.minContextTokens || fixed === undefined) return undefined
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
  await change($, r => ({ ...r, reshaping: true }))
  $.clock.after(0, () => {
    void reshape($, plan).catch(error =>
      $.ui.log(`embers: ${choice} failed: ${String(error)}`, { to: 'debug' }),
    )
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
      await cleared($)
      $.ui.toast('embers: started a fresh session; send your prompt from the box')
      return
    }
    await swap($, plan.swapTo, plan.tokens, plan.fixed)
  } finally {
    // The person has chosen: the prompt they send next is not asked about again.
    await change($, r => ({ ...r, lastCacheTouch: undefined, reshaping: undefined }))
  }
}

export async function observeTtl($: EngineInterface, config: Config, idleMs: number, usage: ModelUsage): Promise<void> {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total === 0) return
  const [model, now] = await Promise.all([$.session.model(), $.clock.now()])
  const key = ttlKey(model)
  const override = await readTtl($, key)
  const ttl = override?.observedMinutes ?? config.ttlMinutes
  const idleMinutes = idleMs / MINUTE
  if (usage.cache_read_input_tokens < 0.1 * total && idleMinutes < ttl) {
    const observed = KNOWN_TTLS.filter(minutes => minutes <= idleMinutes).at(-1)
    if (observed === undefined || observed >= ttl) return
    await $.store.set(key, { v: 1, observedMinutes: observed, observedAt: now })
    const lapse = { afterMinutes: observed, marginMinutes: marginFor(observed, config.marginMinutes) }
    await change($, r => ({ ...r, lapse }))
  } else if (isWarmRead(usage) && override !== undefined && idleMinutes > override.observedMinutes) {
    await $.store.delete(key)
    await change($, r => ({ ...r, lapse: undefined }))
  }
}

export async function offerHandoff($: EngineInterface, config: Config): Promise<void> {
  const s = await read($, run)
  if (s.startOffered) return
  await change($, r => ({ ...r, startOffered: true }))
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
    read($, run),
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
  return `${ttl}. ${s.isOff ? 'Off for this session.' : `Phase: ${s.phase}.`}\n${handoffs}`
}
