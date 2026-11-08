import type { Register } from 'claude-code'

import {
  arm,
  change,
  cleared,
  coldPrompt,
  disarm,
  observeTtl,
  offerHandoff,
  readRun,
  status,
  ttlMs,
  writeHandoff,
} from './handoff'
import { handoffKey, marginFor, sweep, ttlKey } from './records'
import { MINUTE, WRITE, CANCEL, bandLine, forkFigures, isPersonPrompt, k, readConfig } from './shared'

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'embers',
      description: 'Write a handoff now; `status` lists handoffs and the TTL; `off` disables embers for this session',
      argumentHint: '[status|off]',
    })
    const now = await $.clock.now()
    // Fires on reload too: the state survived, the timer did not.
    const s = await change($, r => ({
      ...r,
      isInteractive: e.isInteractive,
      phase: r.phase === 'writing' ? 'idle' : r.phase,
    }))
    if (s.phase === 'armed' && s.deadline !== undefined) arm($, config, now, s.deadline)
    await sweep($, now)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (!isPersonPrompt(e)) return next(e)
    disarm()
    const s = await change($, r => ({ ...r, phase: 'idle', deadline: undefined }))
    if (s.isOff || config.coldMode === 'off' || config.coldMode === 'send' || s.lastCacheTouch === undefined) {
      return next(e)
    }
    const [now, ttl] = await Promise.all([$.clock.now(), ttlMs($, config)])
    const idle = now - s.lastCacheTouch
    if (idle < ttl) return next(e)
    return (await coldPrompt($, config, e, idle)) ?? next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    disarm()
    await change($, r => ({ ...r, phase: 'idle', deadline: undefined }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || e.index !== 0) return yield* next(e)
    const touch = (await readRun($)).lastCacheTouch
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (touch !== undefined && result.usage !== null) await observeTtl($, config, sentAt - touch, result.usage)
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    disarm()
    const [now, sessionId, root, usage, ttl] = await Promise.all([
      $.clock.now(),
      $.session.id(),
      $.session.root(),
      $.session.usage(),
      ttlMs($, config),
    ])
    // A handoff of this session is overtaken by the turn that just ended.
    await $.store.delete(handoffKey(root, sessionId))
    const tokens = usage.context.tokens
    const margin = marginFor(ttl / MINUTE, config.marginMinutes) * MINUTE
    const s = await change($, r => {
      const isArmed =
        !r.isOff && r.isInteractive && tokens !== undefined && tokens >= config.minContextTokens
      return {
        ...r,
        phase: isArmed ? 'armed' : 'idle',
        lastCacheTouch: now,
        contextTokens: tokens,
        deadline: isArmed ? now + ttl - margin : undefined,
        warmUntil: now + ttl,
        handoffAt: undefined,
      }
    })
    if (s.phase === 'armed' && s.deadline !== undefined) arm($, config, now, s.deadline)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      // A new prefix: the next request writes the cache whatever the clock says.
      disarm()
      await change($, r => ({
        ...r,
        phase: 'idle',
        deadline: undefined,
        lastCacheTouch: undefined,
        contextTokens: undefined,
        handoffAt: undefined,
      }))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'embers' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'status') return { text: await status($, config) }
    if (arg === 'off') {
      disarm()
      await change($, r => ({ ...r, isOff: true, phase: 'idle', deadline: undefined }))
      return { text: 'embers is off for this session.' }
    }
    if (arg !== '') return { text: 'Usage: /embers [status|off]' }
    const [s, now, ttl, usage] = await Promise.all([readRun($), $.clock.now(), ttlMs($, config), $.session.usage()])
    if (s.lastCacheTouch === undefined || now - s.lastCacheTouch >= ttl) {
      const tokens = usage.context.tokens
      const size = tokens === undefined ? 'the whole conversation' : `${k(tokens)} tokens`
      const answer = await $.ui
        .ask(`The prompt cache is cold, so a handoff now rereads ${size} at the cache-write price. Write it anyway?`, [WRITE, CANCEL])
        .catch(() => CANCEL)
      if (answer !== WRITE) return { text: 'No handoff written.' }
    }
    disarm()
    const written = await writeHandoff($, config)
    return {
      text:
        'record' in written
          ? `Handoff written; ${forkFigures(written.usage)}.`
          : `No handoff (${written.reason})${written.usage ? `; ${forkFigures(written.usage)}` : ''}.`,
    }
  }).catch(() => ({ text: 'embers: the command failed; the debug log has why.' }))

  // A changed effort level makes the next fork rewrite the cache on models
  // without per-message effort: no fork this idle period.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    disarm()
    await change($, r => (r.phase === 'armed' ? { ...r, phase: 'idle', deadline: undefined } : r))
    return result
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    if (e.source === 'clear') {
      await cleared($)
    } else if (e.source === 'resume' && e.seconds_since_last_response !== undefined) {
      const now = await $.clock.now()
      const touch = now - e.seconds_since_last_response * 1000
      await change($, r => ({ ...r, phase: 'idle', lastCacheTouch: touch, contextTokens: e.context_tokens }))
    } else if (e.source === 'startup' && config.offerOnStart) {
      $.clock.after(0, () => {
        void offerHandoff($, config).catch(error => $.ui.log(`embers: start offer failed: ${String(error)}`, { to: 'debug' }))
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    disarm()
    const [model, now] = await Promise.all([$.session.model(), $.clock.now()])
    await $.store.set(ttlKey(model), { v: 1, observedMinutes: e.cache_ttl === '5m' ? 5 : 60, observedAt: now })
    // The new model has no cache entry: nothing to judge or keep warm.
    await change($, r => ({ ...r, phase: 'idle', deadline: undefined, lastCacheTouch: undefined, handoffAt: undefined, lapse: undefined }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.showBand || e.props.hasSurvey) return next(e)
    const line = bandLine(await readRun($), config)
    if (line === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{line}</Text>
      </Box>
    )
  })
}
