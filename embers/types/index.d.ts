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

/** A fork that reached the API. `usage` is the engine's `ModelUsage`, spelled out: a contract cannot import. */
export type LastFork = {
  at: number
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
}

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
  /** When the last fork ended and what it cost. */
  lastFork?: LastFork
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
  /** Written by embers 0.1.0 when its start offer showed the handoff; read, never written. */
  offeredAt?: number
}

/**
 * `$.store` key `offered:<sessionId>:<writtenAt>`: the start offer showed that
 * handoff, skipped or loaded, so it is not offered again. A key of its own, so
 * the mark never rewrites the handoff its own session may still replace.
 */
export type OfferedRecord = {
  v: 1
  sessionId: string
  writtenAt: number
}

/**
 * `$.store` key `touch:<sessionId>`: when the session last read the cache, so
 * a resumed process can judge its first prompt without a handoff on file.
 * Written at each interactive turn end over `minContextTokens` and after a
 * warm fork. A `/clear` gives a new session id, so it never speaks for the new conversation.
 */
export type TouchRecord = {
  v: 1
  sessionId: string
  touchedAt: number
  contextTokens: number
}

/** `$.store` key `ttl:<model>`. */
export type TtlRecord = {
  v: 1
  observedMinutes: number
  observedAt: number
  /** `reported` came from Claude Code at a model switch and does not expire; an observed one (or one with no source) holds for a day. */
  source?: 'reported'
}

/** `$.store` key `stats:<yyyy-mm>`, local time: what embers cost and saved that month, in input-token equivalents. */
export type StatsRecord = {
  v: 1
  forks: number
  /** Every fork that reached the API, priced by `forkCost`. */
  forkCost: number
  swaps: number
  /** Cache writes the swaps avoided, priced by `swapSaving`. */
  swapSaved: number
  loads: number
}

declare module 'claude-code' {
  interface PluginState {
    embers: { run: Shaped<EmbersRun> }
  }
}
