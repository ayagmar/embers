/** Where the session stands between turns. */
export type Phase = 'idle' | 'armed' | 'writing' | 'ready'

/** The session's embers state, held in `$.state`; survives a hot reload. */
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
  /** Set by `session.start`: false under `-p` and the SDK. */
  isInteractive: boolean
  /** `/embers off` for this session. */
  isOff: boolean
  /** Whether the start offer was shown this session. */
  startOffered: boolean
  /** The observed TTL override and the margin it leaves, for the band. */
  lapse?: { afterMinutes: number; marginMinutes: number }
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
