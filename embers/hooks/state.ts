import type { EngineInterface, ModelUsage } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Cache, EmbersRun, Lapse, LastFork, Phase } from '../types'
import { inProcess } from './process'

export const INITIAL: EmbersRun = { phase: { kind: 'idle' }, isOff: false, startOffered: false }
const run = atom({ plugin: 'embers', key: 'run' } as const, INITIAL, { shape: 'run-2' })

/** The session's state; a read while drawing subscribes the drawing. */
export function readRun($: EngineInterface): Promise<EmbersRun> {
  return read($, run)
}

/**
 * The one writer of the state: runs a transition below over the current value.
 * Off in this process goes into every write, so it survives a reload that
 * follows a `/clear`; `/embers on` clears the variable first.
 */
export function apply<A extends unknown[]>(
  $: EngineInterface,
  transition: (r: EmbersRun, ...input: A) => EmbersRun,
  ...input: A
): Promise<EmbersRun> {
  return update($, run, r => {
    const next = transition(r, ...input)
    return inProcess.isOff && !next.isOff ? { ...next, isOff: true } : next
  })
}

/**
 * The state as it stands now. Every read of one dispatch holds one moment, so a
 * read after a wait can be stale; `update` alone goes past it, on a version miss.
 */
export function readCurrent($: EngineInterface): Promise<EmbersRun> {
  return apply($, r => r)
}

/** `/embers off` holds for the process: `$.state` survives a reload, the variable a `/clear`. */
export const isOff = (r: EmbersRun): boolean => r.isOff || inProcess.isOff

const idle = (cache: Cache | undefined): Phase => (cache === undefined ? { kind: 'idle' } : { kind: 'idle', cache })

/** A main-loop turn ended: the cache was just read. `deadline` arms the handoff timer. */
export function turnEnded(
  r: EmbersRun,
  input: { now: number; ttl: number; model: string; contextTokens: number | undefined; deadline: number | undefined },
): EmbersRun {
  const cache: Cache = {
    touchedAt: input.now,
    model: input.model,
    contextTokens: input.contextTokens,
    warmUntil: input.now + input.ttl,
  }
  return {
    ...r,
    phase: input.deadline === undefined || r.isOff ? idle(cache) : { kind: 'armed', cache, deadline: input.deadline },
  }
}

/** A person's prompt or a main-loop turn began: nothing is scheduled, and a fork still running has moved on. */
export const promptStarted = (r: EmbersRun): EmbersRun => ({ ...r, phase: idle(r.phase.cache) })

/** The timer decided against forking, or no fork could start. */
export const forkSkipped = (r: EmbersRun): EmbersRun =>
  r.phase.kind === 'armed' ? { ...r, phase: idle(r.phase.cache) } : r

export const forkStarted = (r: EmbersRun): EmbersRun => ({
  ...r,
  phase: r.phase.cache === undefined ? { kind: 'writing' } : { kind: 'writing', cache: r.phase.cache },
})

/** The fork ended with no handoff, or a reload lost it. Only a stale `writing` is ours to end. */
export function forkFailed(r: EmbersRun, lastFork?: LastFork): EmbersRun {
  const known = lastFork === undefined ? r : { ...r, lastFork }
  return known.phase.kind === 'writing' ? { ...known, phase: idle(known.phase.cache) } : known
}

/**
 * The handoff is on file. A warm fork renews the cache; a cold one leaves the
 * touch where it was, and with no touch known the band has nothing to promise.
 */
export function forkWritten(
  r: EmbersRun,
  input: { now: number; ttl: number; isWarm: boolean; contextTokens: number; usage: ModelUsage },
): EmbersRun {
  const { now, ttl } = input
  const known: EmbersRun = { ...r, lastFork: { at: now, usage: input.usage } }
  if (known.phase.kind !== 'writing') return known
  const { cache } = known.phase
  const renewed: Cache = cache
    ? { ...cache, touchedAt: now, warmUntil: now + ttl }
    : { touchedAt: now, model: undefined, contextTokens: input.contextTokens, warmUntil: now + ttl }
  const touched = input.isWarm ? renewed : cache && { ...cache, warmUntil: cache.touchedAt + ttl }
  return {
    ...known,
    phase: touched === undefined ? idle(undefined) : { kind: 'ready', cache: touched, handoffAt: now },
  }
}

/** A touch known from elsewhere than a turn end: a resumed session's own handoff. No later read is judged against it. */
export function cacheTouched(
  r: EmbersRun,
  input: { touchedAt: number; contextTokens: number; ttl: number },
): EmbersRun {
  if (r.phase.kind !== 'idle' || r.phase.cache !== undefined) return r
  const cache: Cache = {
    touchedAt: input.touchedAt,
    model: undefined,
    contextTokens: input.contextTokens,
    warmUntil: input.touchedAt + input.ttl,
  }
  return { ...r, phase: idle(cache) }
}

/**
 * The next request writes a new prefix whatever the clock says. A new model
 * also makes what was learned about the old one's TTL moot. `cold-choice` is
 * a swap or fresh start at a cold prompt, whose next prompt is not asked about.
 */
export const prefixReplaced = (r: EmbersRun, cause: 'compaction' | 'model' | 'effort' | 'cold-choice'): EmbersRun => ({
  ...r,
  phase: { kind: 'idle' },
  lapse: cause === 'model' ? undefined : r.lapse,
})

/** After a `/clear`: a new conversation with nothing cached and no timer. */
export const cleared = (r: EmbersRun): EmbersRun => ({ ...INITIAL, isOff: r.isOff, startOffered: r.startOffered })

export const offerMade = (r: EmbersRun): EmbersRun => ({ ...r, startOffered: true })

export const lapseObserved = (r: EmbersRun, lapse: Lapse | undefined): EmbersRun => ({ ...r, lapse })

export const switchedOff = (r: EmbersRun): EmbersRun => ({ ...r, isOff: true, phase: idle(r.phase.cache) })

export const switchedOn = (r: EmbersRun): EmbersRun => ({ ...r, isOff: false })
