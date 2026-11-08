import type { EngineInterface } from 'claude-code'

import type { HandoffRecord, TtlRecord } from '../types'

const RETAIN_MS = 14 * 86_400_000

export const handoffKey = (root: string, sessionId: string): string =>
  `handoff:${root}:${sessionId}`
export const ttlKey = (model: string): string => `ttl:${model}`

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
  const { observedMinutes, observedAt } = value
  if (typeof observedMinutes !== 'number' || typeof observedAt !== 'number') return undefined
  return { v: 1, observedMinutes, observedAt }
}

/**
 * The one reader of `$.store`: a record whose key kind, `v` or shape does not
 * check out reads as absent and is deleted.
 */
async function readRecord(
  $: EngineInterface,
  key: string,
): Promise<HandoffRecord | TtlRecord | undefined> {
  const value = await $.store.get(key)
  if (value === undefined) return undefined
  const record = key.startsWith('handoff:')
    ? parseHandoff(key, value)
    : key.startsWith('ttl:')
      ? parseTtl(value)
      : undefined
  if (record === undefined) await $.store.delete(key)
  return record
}

export async function readHandoff(
  $: EngineInterface,
  key: string,
): Promise<HandoffRecord | undefined> {
  const record = await readRecord($, key)
  return record !== undefined && 'root' in record ? record : undefined
}

export async function readTtl($: EngineInterface, key: string): Promise<TtlRecord | undefined> {
  const record = await readRecord($, key)
  return record !== undefined && 'observedMinutes' in record ? record : undefined
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

/**
 * Drops invalid records, handoffs older than 14 days, and every handoff but
 * the newest per root and branch.
 */
export async function sweep($: EngineInterface, now: number): Promise<void> {
  const newest = new Map<string, HandoffRecord>()
  for (const key of await $.store.keys()) {
    const record = await readRecord($, key)
    if (record === undefined || !('root' in record)) continue
    if (now - record.writtenAt > RETAIN_MS) {
      await $.store.delete(key)
      continue
    }
    const group = `${record.root}\n${record.branch}`
    const kept = newest.get(group)
    if (kept === undefined) {
      newest.set(group, record)
    } else if (record.writtenAt > kept.writtenAt) {
      await $.store.delete(handoffKey(kept.root, kept.sessionId))
      newest.set(group, record)
    } else {
      await $.store.delete(key)
    }
  }
}

/** The TTL in force for the session's model: an observed or engine-reported one, else the configured one. */
export async function ttlMinutes($: EngineInterface, configured: number): Promise<number> {
  const record = await readTtl($, ttlKey(await $.session.model()))
  return record?.observedMinutes ?? configured
}

/** The margin before the TTL: the configured one, cut to a fifth of a short TTL (but not under a minute). */
export const marginFor = (ttl: number, margin: number): number =>
  Math.min(margin, Math.max(1, ttl / 5))

/** The checked-out branch, or '' outside git. */
export async function currentBranch($: EngineInterface): Promise<string> {
  const run = await $.process.run(['git', 'branch', '--show-current']).catch(() => undefined)
  return run?.exitCode === 0 ? run.stdout.trim() : ''
}
