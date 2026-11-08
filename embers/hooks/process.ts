import type { Timer } from 'claude-code'

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
} = { timer: undefined, isReshaping: false, isOff: false }

export function disarm(): void {
  inProcess.timer?.cancel()
  inProcess.timer = undefined
}
