/** Where the session stands between turns. */
export type Phase = 'idle' | 'armed' | 'writing' | 'ready'

/**
 * The session's embers state, held in `$.state`: it survives a hot reload and
 * starts over under the new session id after a `/clear`.
 */
export type EmbersRun = {
  phase: Phase
  /** Epoch ms of the last main-loop turn end, or of a later fork that read the cache. */
  lastCacheTouch?: number
  /** The model at `lastCacheTouch`; another model has no cache entry to keep warm or to judge the TTL by. */
  modelAtTouch?: string
  /** `context.tokens` read at the last main-loop turn end; absent after a compaction. */
  contextTokens?: number
  /** Epoch ms the handoff timer fires, while `armed`. */
  deadline?: number
  /** `lastCacheTouch` plus the TTL in force, for the band. */
  warmUntil?: number
  /** When the handoff on file was written, while `ready`. */
  handoffAt?: number
  /** `/embers off` for this session. */
  isOff: boolean
  /** Whether the start offer was shown this session. */
  startOffered: boolean
  /**
   * A cold read inside the TTL and the margin it would leave. The first is
   * held `isPending`, from the idle period that began at `touch` on `model`; a
   * second on that model, in a later idle period, stores the `ttl:<model>`
   * override and drops `isPending`. The band shows only a stored one.
   */
  lapse?: { afterMinutes: number; marginMinutes: number; touch?: number; model?: string; isPending?: boolean }
}

/** `$.store` key `handoff:<root>:<sessionId>`. */
export type HandoffRecord = {
  v: 1
  root: string
  branch: string
  sessionId: string
  turns: number
  writtenAt: number
  contextTokens: number
  text: string
  lastAssistant: string
  /** When the start offer showed it and the person skipped it; it is not offered again. */
  offeredAt?: number
}

/** `$.store` key `ttl:<model>`. */
export type TtlRecord = {
  v: 1
  observedMinutes: number
  observedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    embers: { run: Shaped<EmbersRun> }
  }
}
