import type { Timer } from 'claude-code'

import type { HandoffRecord } from '../types'

/**
 * What lives as long as this module: it outlives a `/clear`, which starts
 * `$.state` over, and a reload starts it over.
 */
export const inProcess: {
  /** The handoff timer; `session.start` re-arms it from `$.state` after a reload. */
  timer: Timer | undefined
  /** A swap or fresh start chosen at a cold prompt is running; a reload ends it. */
  isReshaping: boolean
  /** `/embers off`, which holds for the process. */
  isOff: boolean
  /** What each placed handoff row draws, by its id; a reload empties it and the rows draw nothing. */
  placed: Map<string, string>
  /** The handoff this process last swapped or loaded in, for `/embers show` once its record is gone. */
  lastShown: HandoffRecord | undefined
} = { timer: undefined, isReshaping: false, isOff: false, placed: new Map(), lastShown: undefined }

export function disarm(): void {
  inProcess.timer?.cancel()
  inProcess.timer = undefined
}
