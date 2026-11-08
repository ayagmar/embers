/** What is known about the main thread's prompt-cache entry. */
export type Cache = {
  /** Epoch ms of the last main-loop turn end, or of a later fork that read the cache. */
  touchedAt: number
  /** The model at `touchedAt`; another model has no entry to keep warm or to judge the TTL by. Absent when the touch came from a handoff. */
  model: string | undefined
  /** `context.tokens` read at the last main-loop turn end. */
  contextTokens: number | undefined
  /** `touchedAt` plus the TTL in force. */
  warmUntil: number
}

/**
 * Where the session stands between turns. A manual `/embers` can write with
 * no touch known, so `writing` alone of the busy phases may lack a `cache`.
 */
export type Phase =
  | { kind: 'idle'; cache?: Cache }
  | { kind: 'armed'; cache: Cache; deadline: number }
  | { kind: 'writing'; cache?: Cache }
  | { kind: 'ready'; cache: Cache; handoffAt: number }

/**
 * A cold read inside the TTL and the margin it would leave. The first is held
 * `isPending`, from the idle period that began at `touch` on `model`; a second
 * on that model, in a later idle period, stores the `ttl:<model>` override and
 * drops `isPending`. The band shows only a stored one.
 */
export type Lapse = { afterMinutes: number; marginMinutes: number; touch?: number; model?: string; isPending?: boolean }

/**
 * The session's embers state, held in `$.state`: it survives a hot reload and
 * starts over under the new session id after a `/clear`.
 */
export type EmbersRun = {
  phase: Phase
  /** `/embers off` for this session. */
  isOff: boolean
  /** Whether the start offer was shown this session. */
  startOffered: boolean
  lapse?: Lapse
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
