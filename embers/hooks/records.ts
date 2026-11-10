import type { EngineInterface } from 'claude-code'

import type { HandoffRecord, StatsRecord, TtlRecord } from '../types'

const DAY = 86_400_000
const RETAIN_MS = 14 * DAY
/** An observed TTL can come from cold reads that were not a lapse; it is learned again within a day if it was real. */
const OBSERVED_TTL_MS = DAY

export const handoffKey = (root: string, sessionId: string): string => `handoff:${root}:${sessionId}`
export const ttlKey = (model: string): string => `ttl:${model}`
const pad = (n: number): string => String(n).padStart(2, '0')
export const statsKey = (now: number): string => {
  const at = new Date(now)
  return `stats:${at.getFullYear()}-${pad(at.getMonth() + 1)}`
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseHandoff(key: string, value: unknown): HandoffRecord | undefined {
  if (!isObject(value) || value.v !== 1) return undefined
  const { root, branch, sessionId, turns, writtenAt, contextTokens, text, lastAssistant, offeredAt } = value
  if (
    typeof root !== 'string' ||
    typeof branch !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof turns !== 'number' ||
    typeof writtenAt !== 'number' ||
    typeof contextTokens !== 'number' ||
    typeof text !== 'string' ||
    typeof lastAssistant !== 'string' ||
    (offeredAt !== undefined && typeof offeredAt !== 'number') ||
    key !== handoffKey(root, sessionId)
  ) {
    return undefined
  }
  const record: HandoffRecord = { v: 1, root, branch, sessionId, turns, writtenAt, contextTokens, text, lastAssistant }
  return offeredAt === undefined ? record : { ...record, offeredAt }
}

function parseTtl(value: unknown): TtlRecord | undefined {
  if (!isObject(value) || value.v !== 1) return undefined
  const { observedMinutes, observedAt, source } = value
  if (typeof observedMinutes !== 'number' || typeof observedAt !== 'number') return undefined
  if (source !== undefined && source !== 'reported') return undefined
  return source === undefined ? { v: 1, observedMinutes, observedAt } : { v: 1, observedMinutes, observedAt, source }
}

const STATS_FIELDS = ['forks', 'forkCost', 'swaps', 'swapSaved', 'loads'] as const
export const NO_STATS: StatsRecord = { v: 1, forks: 0, forkCost: 0, swaps: 0, swapSaved: 0, loads: 0 }

function parseStats(value: unknown): StatsRecord | undefined {
  if (!isObject(value) || value.v !== 1) return undefined
  return STATS_FIELDS.every(field => typeof value[field] === 'number') ? (value as StatsRecord) : undefined
}

/**
 * The one reader of `$.store`: a record whose key kind, `v` or shape does not
 * check out reads as absent and is deleted.
 */
async function readRecord(
  $: EngineInterface,
  key: string,
): Promise<HandoffRecord | TtlRecord | StatsRecord | undefined> {
  const value = await $.store.get(key)
  if (value === undefined) return undefined
  const record = key.startsWith('handoff:')
    ? parseHandoff(key, value)
    : key.startsWith('ttl:')
      ? parseTtl(value)
      : key.startsWith('stats:')
        ? parseStats(value)
        : undefined
  if (record === undefined) await $.store.delete(key)
  return record
}

export async function readHandoff($: EngineInterface, key: string): Promise<HandoffRecord | undefined> {
  const record = await readRecord($, key)
  return record !== undefined && 'root' in record ? record : undefined
}

/** The TTL record in force at `now`: an observed one past a day reads as absent and is deleted. */
export async function readTtl($: EngineInterface, key: string, now: number): Promise<TtlRecord | undefined> {
  const record = await readRecord($, key)
  if (record === undefined || !('observedMinutes' in record)) return undefined
  if (record.source !== 'reported' && now - record.observedAt > OBSERVED_TTL_MS) {
    await $.store.delete(key)
    return undefined
  }
  return record
}

export async function readStats($: EngineInterface, now: number): Promise<StatsRecord> {
  const record = await readRecord($, statsKey(now))
  return record !== undefined && 'forkCost' in record ? record : NO_STATS
}

/**
 * Adds to this month's figures, best effort: a failed write must not cost a
 * handoff or a swap. Two sessions adding at once can lose one addition:
 * `$.store` has no update, and the tally is an estimate anyway.
 */
export async function addStats($: EngineInterface, now: number, add: Partial<Omit<StatsRecord, 'v'>>): Promise<void> {
  try {
    const stats = await readStats($, now)
    const next: StatsRecord = { ...stats }
    for (const field of STATS_FIELDS) next[field] = stats[field] + (add[field] ?? 0)
    await $.store.set(statsKey(now), next)
  } catch (error) {
    $.ui.log(`embers: the monthly tally was not updated: ${String(error)}`, { to: 'debug' })
  }
}

/** Every valid handoff written from `root`, newest first. */
export async function listHandoffs($: EngineInterface, root: string): Promise<HandoffRecord[]> {
  const prefix = handoffKey(root, '')
  const found: HandoffRecord[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue
    const record = await readHandoff($, key)
    if (record !== undefined && record.root === root) found.push(record)
  }
  return found.sort((a, b) => b.writtenAt - a.writtenAt)
}

/** Below this many handoffs in a root, a superseded one is worth keeping for its own session's resume. */
const ROOT_CAP = 10

/**
 * Drops invalid records, handoffs older than 14 days, and, while a root holds
 * more than `ROOT_CAP`, handoffs that are not the newest of their branch and
 * are older than twice the TTL. A younger one may belong to a session still
 * open in the same checkout, and an older one to a session resumed later.
 */
export async function sweep($: EngineInterface, now: number, ttlMs: number): Promise<void> {
  const groups = new Map<string, HandoffRecord[]>()
  const perRoot = new Map<string, number>()
  for (const key of await $.store.keys()) {
    const record = await readRecord($, key)
    if (record === undefined || !('root' in record)) continue
    if (now - record.writtenAt > RETAIN_MS) {
      await $.store.delete(key)
      continue
    }
    const group = `${record.root}\n${record.branch}`
    groups.set(group, [...(groups.get(group) ?? []), record])
    perRoot.set(record.root, (perRoot.get(record.root) ?? 0) + 1)
  }
  const superseded = [...groups.values()]
    .flatMap(records => records.sort((a, b) => b.writtenAt - a.writtenAt).slice(1))
    .filter(record => now - record.writtenAt > 2 * ttlMs)
    .sort((a, b) => a.writtenAt - b.writtenAt)
  for (const record of superseded) {
    const count = perRoot.get(record.root) ?? 0
    if (count <= ROOT_CAP) continue
    await $.store.delete(handoffKey(record.root, record.sessionId))
    perRoot.set(record.root, count - 1)
  }
}

/** The TTL in force for the session's model: an observed or engine-reported one, else the configured one. */
export async function ttlMinutes($: EngineInterface, configured: number): Promise<number> {
  const [model, now] = await Promise.all([$.session.model(), $.clock.now()])
  const record = await readTtl($, ttlKey(model), now)
  return record?.observedMinutes ?? configured
}

/** The margin before the TTL: the configured one, cut to a fifth of a short TTL (but not under a minute). */
export const marginFor = (ttl: number, margin: number): number => Math.min(margin, Math.max(1, ttl / 5))

/** The checked-out branch, or '' outside git. */
export async function currentBranch($: EngineInterface): Promise<string> {
  const run = await $.process.run(['git', 'branch', '--show-current']).catch(() => undefined)
  return run?.exitCode === 0 ? run.stdout.trim() : ''
}
