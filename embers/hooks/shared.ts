import type { ModelUsage, PluginOptions, PromptSubmitInput, SessionContextBreakdown, SessionMessage } from 'claude-code'

import type { Cache, EmbersRun, HandoffRecord, Phase } from '../types'
import { isOff } from './state'

export const MINUTE = 60_000
/** A timer that fires this close to the TTL, or later, finds the cache lapsed. */
export const SLACK_MS = 30_000
/** The TTLs the API offers, in minutes. */
export const KNOWN_TTLS = [5, 60]

export const HANDOFF_PROMPT = [
  'You have no tools in this reply. Answer straight away, without deliberating.',
  'Write a handoff for this conversation so that it can continue from the handoff alone, without the transcript:',
  'the goal, the decisions made and why, the state of the work (files touched, what is done, what is not),',
  'open questions, and the exact next step. Be specific: names, paths, commands, figures.',
  'Plain text, no preamble.',
].join(' ')

export type ColdChoice = 'swap' | 'send' | 'fresh'
export const COLD_LABELS: Record<ColdChoice, string> = {
  swap: 'Swap to handoff',
  send: 'Send as is',
  fresh: 'Fresh session',
}
/** The choice behind an answer; free text typed under "Other" sends the prompt. */
export const coldChoiceOf = (label: string): ColdChoice =>
  label === COLD_LABELS.swap ? 'swap' : label === COLD_LABELS.fresh ? 'fresh' : 'send'

export const LOAD = 'Load it'
export const SKIP = 'Skip'
export const WRITE = 'Write it'
export const CANCEL = 'Cancel'

export type ColdMode = 'ask' | 'swap' | 'send' | 'off'
export type Config = {
  ttlMinutes: number
  marginMinutes: number
  minContextTokens: number
  minSavingTokens: number
  coldMode: ColdMode
  offerOnStart: boolean
  showBand: boolean
}

export function readConfig(options: PluginOptions): Config {
  const num = (key: string): number => {
    const value = options[key]
    if (typeof value !== 'number') throw new Error(`embers: ${key} is not a number`)
    return value
  }
  const bool = (key: string): boolean => {
    const value = options[key]
    if (typeof value !== 'boolean') throw new Error(`embers: ${key} is not a boolean`)
    return value
  }
  const mode = options.coldMode
  if (mode !== 'ask' && mode !== 'swap' && mode !== 'send' && mode !== 'off') {
    throw new Error('embers: coldMode is not ask, swap, send or off')
  }
  return {
    ttlMinutes: num('ttlMinutes'),
    marginMinutes: num('marginMinutes'),
    minContextTokens: num('minContextTokens'),
    minSavingTokens: num('minSavingTokens'),
    coldMode: mode,
    offerOnStart: bool('offerOnStart'),
    showBand: bool('showBand'),
  }
}

export const k = (tokens: number): string =>
  tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
const pad = (n: number): string => String(n).padStart(2, '0')
export const clockTime = (ms: number): string => {
  const at = new Date(ms)
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
export const dateTime = (ms: number): string => {
  const at = new Date(ms)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clockTime(ms)}`
}
export const minutesOf = (ms: number): number => Math.round(ms / MINUTE)
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)
export const handoffTokens = (record: HandoffRecord): number =>
  estimateTokens(record.text) + estimateTokens(record.lastAssistant)

/** A fork or request served mostly from the cache. */
export const isWarmRead = (usage: ModelUsage): boolean =>
  usage.cache_read_input_tokens >=
  0.5 * (usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens)

/** System prompt, tools and everything else that is not the conversation. */
export function fixedTokens(breakdown: SessionContextBreakdown | undefined): number | undefined {
  if (breakdown === undefined) return undefined
  return breakdown.categories
    .filter(row => row.kind === 'used' && row.name !== 'Messages')
    .reduce((sum, row) => sum + row.tokens, 0)
}

export function lastAssistantText(messages: readonly SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message !== undefined && message.role === 'assistant' && message.text !== '') {
      return message.text
    }
  }
  return ''
}

export function compose(record: HandoffRecord): string {
  const head = `[embers] This conversation was replaced by a handoff written at ${dateTime(record.writtenAt)}, before the prompt cache lapsed. Continue from it.`
  const tail =
    record.lastAssistant === ''
      ? ''
      : `\n\nThe last assistant reply before the handoff, verbatim:\n\n${record.lastAssistant}`
  return `${head}\n\n${record.text}${tail}`
}

/** A fork's cost in words: every toast and command shows it through here. */
export function forkFigures(usage: ModelUsage): string {
  const cold = isWarmRead(usage) ? '' : ' (cold)'
  return `read ${k(usage.cache_read_input_tokens)} from cache, wrote ${k(usage.cache_creation_input_tokens)}, ${k(usage.output_tokens)} out${cold}`
}

/** A prompt the person typed at an idle session; everything else passes untouched. */
export const isPersonPrompt = (e: PromptSubmitInput): boolean =>
  e.command === undefined &&
  e.turnId === undefined &&
  e.isMeta === undefined &&
  (e.origin.kind === 'composer' || e.origin.kind === 'bridge')

export function bandLine(s: EmbersRun, config: Config): string | undefined {
  const { phase } = s
  const tokens = phase.cache?.contextTokens
  if (isOff(s) || tokens === undefined || tokens < config.minContextTokens) return undefined
  switch (phase.kind) {
    case 'idle':
      return undefined
    case 'armed': {
      const lapse =
        s.lapse !== undefined && s.lapse.isPending !== true
          ? `  cache lapsed after ${s.lapse.afterMinutes}m  margin now ${s.lapse.marginMinutes}m`
          : ''
      return `embers  warm  handoff at ${clockTime(phase.deadline)}${lapse}`
    }
    case 'writing':
      return 'embers  writing handoff…'
    case 'ready':
      return `embers  handoff ready  ${clockTime(phase.handoffAt)}, ${k(tokens)} tokens, warm until ${clockTime(phase.cache.warmUntil)}`
    default:
      return phase satisfies never
  }
}

export function phaseWords(phase: Phase): string {
  switch (phase.kind) {
    case 'idle':
      return 'nothing scheduled'
    case 'armed':
      return `handoff scheduled for ${clockTime(phase.deadline)}`
    case 'writing':
      return 'writing a handoff'
    case 'ready':
      return `handoff ready since ${clockTime(phase.handoffAt)}`
  }
}

export function cacheWords(cache: Cache | undefined, now: number): string {
  if (cache === undefined) return 'unknown'
  return `${now < cache.warmUntil ? 'warm until' : 'cold since'} ${clockTime(cache.warmUntil)}`
}
