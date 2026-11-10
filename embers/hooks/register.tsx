import type { Register } from 'claude-code'

import {
  afterClear,
  arm,
  coldPrompt,
  observeTtl,
  offerHandoff,
  outcome,
  seedFromHandoff,
  showHandoff,
  status,
  ttlMs,
  writeHandoff,
} from './handoff'
import { disarm, inProcess } from './process'
import { handoffKey, marginFor, readHandoff, sweep, ttlKey } from './records'
import { bandLine, CANCEL, isPersonPrompt, k, MINUTE, readConfig, WRITE } from './shared'
import {
  apply,
  forkFailed,
  isOff,
  prefixReplaced,
  promptStarted,
  readRun,
  switchedOff,
  switchedOn,
  ttlInForce,
  turnEnded,
} from './state'

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'embers',
      description:
        'Write a handoff now; `show` shows the handoff, `status` where embers stands; `off` and `on` switch it for this process',
      argumentHint: '[show|status|off|on]',
    })
    const [now, ttl] = await Promise.all([$.clock.now(), ttlMs($, config)])
    const margin = marginFor(ttl / MINUTE, config.marginMinutes) * MINUTE
    // Fires on reload too: the state survived, the timer and any swap in flight
    // did not, and the TTL it was armed on may have expired since.
    const s = await apply($, r => ttlInForce(forkFailed(r), { ttl, margin }))
    if (s.isOff) inProcess.isOff = true
    if (s.phase.kind === 'armed') arm($, config, now, s.phase.deadline)
    if (s.phase.cache === undefined) await seedFromHandoff($, ttl)
    await sweep($, now, ttl)
    // Once per session, never under -p, and not into a resumed conversation,
    // which already holds its own context.
    if (config.offerOnStart && e.isInteractive && !s.startOffered && (await $.session.turns()) === 0) {
      $.clock.after(0, () => {
        void offerHandoff($, config).catch(error =>
          $.ui.log(`embers: start offer failed: ${String(error)}`, { to: 'debug' }),
        )
      })
    }
    return next(e)
  }).catch((_, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (!isPersonPrompt(e)) return next(e)
    // Asked again, it would start a second cold fork or send cold under the swap.
    if (inProcess.isReshaping) return { drop: 'embers: still swapping; send again when it says done' }
    disarm()
    const s = await apply($, promptStarted)
    const { cache } = s.phase
    if (isOff(s) || config.coldMode === 'send' || cache === undefined) return next(e)
    const [now, ttl] = await Promise.all([$.clock.now(), ttlMs($, config)])
    const idle = now - cache.touchedAt
    if (idle < ttl) return next(e)
    return (await coldPrompt($, config, idle, cache.contextTokens)) ?? next(e)
  }).catch((_, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    disarm()
    await apply($, promptStarted)
    return next(e)
  }).catch((_, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || e.index !== 0) return yield* next(e)
    const [s, model, sentAt] = await Promise.all([readRun($), $.session.model(), $.clock.now()])
    const result = yield* next(e)
    // After `/model` the prefix is billed afresh: a cold read says nothing about the TTL.
    const { cache } = s.phase
    if (cache !== undefined && cache.model === model && result.usage !== null) {
      await observeTtl($, config, cache.touchedAt, sentAt - cache.touchedAt, result.usage)
    }
    return result
  }).catch(async function* (_, e, next) {
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    disarm()
    const [before, now, sessionId, root, usage, ttl, model, surfaces] = await Promise.all([
      readRun($),
      $.clock.now(),
      $.session.id(),
      $.session.root(),
      $.session.usage(),
      ttlMs($, config),
      $.session.model(),
      // Read each time: none under -p, and nothing for a /clear or a reload to lose.
      $.session.surfaces(),
    ])
    const isInteractive = surfaces.length > 0
    // A handoff of this session is overtaken by the turn that just ended.
    await $.store.delete(handoffKey(root, sessionId))
    // No usage: an API error or an interrupt before any request counted. The
    // cache was not read, so the last touch stands and nothing is armed.
    if (e.usage === undefined) return next(e)
    const margin = marginFor(ttl / MINUTE, config.marginMinutes) * MINUTE
    // A stored TTL that expired leaves its lapse in the state, and the band would still claim it.
    await apply($, ttlInForce, { ttl, margin })
    const tokens = usage.context.tokens
    const isArmed = !isOff(before) && isInteractive && tokens !== undefined && tokens >= config.minContextTokens
    const s = await apply($, turnEnded, {
      now,
      ttl,
      model,
      contextTokens: tokens,
      deadline: isArmed ? now + ttl - margin : undefined,
    })
    if (s.phase.kind === 'armed') arm($, config, now, s.phase.deadline)
    return next(e)
  }).catch((_, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      // A new prefix: the next request writes the cache whatever the clock says.
      disarm()
      await apply($, prefixReplaced, 'compaction')
    }
    return result
  }).catch((_, e, next) => next(e))

  on('command.run', { command: 'embers' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'status') return { text: await status($, config) }
    if (arg === 'show') {
      const [root, sessionId] = await Promise.all([$.session.root(), $.session.id()])
      const record = (await readHandoff($, handoffKey(root, sessionId))) ?? inProcess.lastShown
      if (record === undefined) return { text: 'No handoff for this session.' }
      // Placed, not returned: a plugin's command text goes in requests, and the model has its own copy.
      if (await showHandoff($, record)) return {}
      return { text: 'embers: no surface to draw the handoff on.' }
    }
    if (arg === 'off') {
      inProcess.isOff = true
      disarm()
      await apply($, switchedOff)
      return { text: 'embers is off; /embers on turns it back on.' }
    }
    if (arg === 'on') {
      inProcess.isOff = false
      await apply($, switchedOn)
      return { text: 'embers is on; the next turn to end arms it.' }
    }
    if (arg !== '') return { text: 'Usage: /embers [show|status|off|on]' }
    const [s, now, ttl, usage, model] = await Promise.all([
      readRun($),
      $.clock.now(),
      ttlMs($, config),
      $.session.usage(),
      $.session.model(),
    ])
    if (s.phase.kind === 'writing')
      return { text: 'embers: a handoff is being written; run /embers again when it is done.' }
    const { cache } = s.phase
    // After `/model` the prefix is billed afresh; a touch seeded from a handoff names no model.
    const isNewModel = cache?.model !== undefined && cache.model !== model
    if (cache === undefined || now - cache.touchedAt >= ttl || isNewModel) {
      const tokens = usage.context.tokens
      const size = tokens === undefined ? 'the whole conversation' : `${k(tokens)} tokens`
      const answer = await $.ui
        .ask(`The prompt cache is cold, so a handoff now rereads ${size} at the cache-write price. Write it anyway?`, [
          WRITE,
          CANCEL,
        ])
        .catch(() => CANCEL)
      if (answer !== WRITE) return { text: 'No handoff written.' }
    }
    disarm()
    return { text: `${outcome(await writeHandoff($, config))}.` }
  }).catch(() => ({ text: 'embers: the command failed; the debug log has why.' }))

  // A changed effort level makes the next request rewrite the cache on models
  // without per-message effort: no fork this idle period, and the next cold
  // read is not a TTL observation.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    disarm()
    await apply($, prefixReplaced, 'effort')
    return result
  }).catch((_, e, next) => next(e))

  // A `/clear`, the person's or the swap's: the new conversation has nothing
  // cached, no timer, and nothing for the band. No `session.start` follows it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await afterClear($)
    return next(e)
  }).catch((_, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    disarm()
    const [model, now] = await Promise.all([$.session.model(), $.clock.now()])
    await $.store.set(ttlKey(model), {
      v: 1,
      observedMinutes: e.cache_ttl === '5m' ? 5 : 60,
      observedAt: now,
      source: 'reported',
    })
    // The new model has no cache entry: nothing to judge or keep warm.
    await apply($, prefixReplaced, 'model')
    return next(e)
  }).catch((_, e, next) => next(e))

  on('ui.render', { component: 'Placed' }, ($, e, next) => {
    const text = e.props.plugin === 'embers' ? inProcess.placed.get(e.props.id) : undefined
    if (text === undefined) return next(e)
    const { Box, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Markdown text={text} />
      </Box>
    )
  })

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
