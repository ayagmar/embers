import type { HandoffRecord } from '../types'
import type { Engine } from 'claude-code/testing'
import type { ModelUsage, On, SessionCompactInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/work/repo'
const SESSION = 'session-1'
const MINUTE = 60_000
const T0 = Date.UTC(2026, 10, 8, 12, 0)
const KEY = `handoff:${ROOT}:${SESSION}`

const WARM: ModelUsage = {
  input_tokens: 300,
  output_tokens: 1200,
  cache_read_input_tokens: 99_000,
  cache_creation_input_tokens: 0,
}
const COLD: ModelUsage = {
  input_tokens: 300,
  output_tokens: 1200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 99_000,
}

/** What the engine beneath the plugin holds, and what reached it. */
type World = {
  model: string
  /** What the main loop's next request reads from the cache. */
  stepUsage: ModelUsage
  turns: number
  /** `context.tokens`; absent before a resumed process's first response. */
  contextTokens: number | undefined
  answer: string
  forks: number
  asks: { question: string; labels: string[] }[]
  compactions: SessionCompactInput[]
  toasts: string[]
  filled: string[]
  commands: string[]
}

/** Stands for the engine: every `$` call embers makes is answered here. */
function engine(on: On, overrides: Partial<World> = {}): World {
  const world: World = {
    model: 'claude-test',
    stepUsage: WARM,
    turns: 3,
    contextTokens: 100_000,
    answer: 'Send as is',
    forks: 0,
    asks: [],
    compactions: [],
    toasts: [],
    filled: [],
    commands: [],
    ...overrides,
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: ROOT }))
  on('session.model', () => ({ value: world.model }))
  on('session.turns', () => ({ value: world.turns }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'ship it?', toolUses: [] },
      { role: 'assistant', text: 'LAST REPLY: shipped v2', toolUses: [] },
    ],
  }))
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: {
        tokens: world.contextTokens,
        window: 200_000,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 8000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'System tools', tokens: 12_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: (world.contextTokens ?? 20_000) - 20_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 80_000, color: 'x', isDeferred: false, kind: 'free' },
          ],
          totalTokens: world.contextTokens ?? 20_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          autocompactSource: 'model-default',
          percentage: 50,
          gridRows: [],
          model: 'claude-test',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
      rateLimits: [],
    },
  }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.fork', () => {
    world.forks += 1
    return { value: { isAnswered: true, text: 'HANDOFF: release v2 is next', usage: WARM } }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const asked = e.questions[0]
    if (asked === undefined) throw new Error('no question')
    world.asks.push({ question: asked.question, labels: asked.options.map(option => option.label) })
    return { result: { questions: e.questions, answers: { [asked.question]: world.answer } } }
  })
  on('session.compact', (_, e) => {
    world.compactions.push(e)
    return { messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.run', (_, e) => {
    world.commands.push(e.command)
    return { text: '' }
  })
  on('prompt.fill', (_, e) => {
    world.filled.push(e.text)
    return { isFilled: true }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  // The engine's own band, drawn when embers passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  // eslint-disable-next-line require-yield
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { ...world.stepUsage, model: world.model },
    } as const
  })
  return world
}


/** `$.store` beneath the plugin, held in a Map the test reads. */
function memoryStore(on: On, entries: Record<string, unknown> = {}): Map<string, unknown> {
  const store = new Map(Object.entries(entries))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

/** The last `run` value embers wrote to `$.state`. */
function stateLog(on: On): { last: () => unknown } {
  let last: unknown
  on('state.set', (_, e, next) => {
    last = e.value
    return next(e)
  })
  return { last: () => last }
}

/** A clock the test moves by hand; each timer is held until the test fires it. */
type Wait = { due: number; signal: AbortSignal; fire: () => void }
function manualClock(on: On, start: number): { now: number; waits: Wait[] } {
  const clock = { now: start, waits: [] as Wait[] }
  on('clock.now', () => ({ value: clock.now }))
  on(
    'clock.after',
    (_, e, next) =>
      new Promise(resolve => {
        clock.waits.push({ due: clock.now + e.ms, signal: next.signal, fire: () => resolve({ value: undefined }) })
      }),
  )
  return clock
}

const start = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
const typed = { wait: false, origin: { kind: 'composer' } } as const

function handoff(fields: Partial<HandoffRecord>): HandoffRecord {
  return {
    v: 1,
    root: ROOT,
    branch: 'main',
    sessionId: SESSION,
    turns: 3,
    writtenAt: T0,
    contextTokens: 100_000,
    text: 'HANDOFF',
    lastAssistant: 'LAST REPLY',
    ...fields,
  }
}

type Run = { phase?: string; lastCacheTouch?: number; deadline?: number }
/** A `state.set` of a shaped value carries `{ shape, value }`. */
const asRun = (written: unknown): Run =>
  typeof written === 'object' && written !== null && 'value' in written && typeof written.value === 'object' && written.value !== null
    ? written.value
    : {}
/** The text of the band above the prompt, '' when embers draws none. */
async function band($: Engine): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'embers',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  const text = (await ui.find({ type: 'Text', text: /embers/ }))?.text ?? ''
  await ui.unmount()
  return text
}

/** The main loop's first request of a turn, read to its end. */
async function step($: Engine, model = 'claude-test'): Promise<void> {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 4 })
  for await (const _ of stream) void _
}

// The test environment has the web timers; the hooks typings leave them out.
declare function setTimeout(fn: () => void, ms: number): unknown

/** Lets work a fired timer started run to its end. */
const drain = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50))

test('a cold prompt with a matching handoff swaps to it without a model call', async ($, on) => {
  const world = engine(on, { answer: 'Swap to handoff' })
  const clock = mock.clock(on, { now: T0 })
  const store = memoryStore(on)
  const session = mock.session(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.advance(55 * MINUTE)
  expect(world.forks).toBe(1)
  expect(store.has(KEY)).toBe(true)

  // The fork at 55m kept the cache warm until 115m; 120m is cold.
  await clock.set(T0 + 120 * MINUTE)
  const dropped = await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()

  expect(dropped.drop).toContain('swapping to the handoff')
  expect(world.asks[0]?.labels).toEqual(['Swap to handoff', 'Send as is', 'Fresh session'])
  expect(world.commands).toEqual(['clear'])
  const rows = session.appended().map(row => JSON.stringify(row.message.content))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toContain('HANDOFF: release v2 is next')
  expect(rows[0]).toContain('LAST REPLY: shipped v2')
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual([])
  // The engine puts a dropped prompt back in the box; filling it too doubles it.
  expect(world.filled).toEqual([])
  expect(store.has(KEY)).toBe(false)
  // The prompt sent from the box enters on the short prefix, unasked.
  await $.prompt.submit({ text: 'go on', ...typed })
  expect(world.asks).toHaveLength(1)
})

test('a prompt sent again while the swap runs is refused, not asked about or sent cold', async ($, on) => {
  const world = engine(on, { answer: 'Swap to handoff' })
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.advance(55 * MINUTE)
  await clock.set(T0 + 120 * MINUTE)
  await $.prompt.submit({ text: 'go on', ...typed })
  // The swap is scheduled, not done: Enter again from the box.
  const again = await $.prompt.submit({ text: 'go on', ...typed })
  expect(again).toEqual({ drop: 'embers: still swapping; send again when it says done' })
  await clock.settle()

  expect(world.asks).toHaveLength(1)
  expect(world.commands).toEqual(['clear'])
  expect(world.forks).toBe(1)
  expect(await $.prompt.submit({ text: 'go on', ...typed })).toEqual({ text: 'go on' })
})

test('a resumed session with its handoff on file is offered the swap before any response', async ($, on) => {
  const world = engine(on, { answer: 'Swap to handoff', contextTokens: undefined })
  const clock = mock.clock(on, { now: T0 + 120 * MINUTE })
  memoryStore(on, { [KEY]: handoff({}) })
  const session = mock.session(on)

  await $.session.start(start)
  const dropped = await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()

  expect(dropped.drop).toContain('swapping to the handoff')
  expect(world.asks[0]?.question).toContain('Sending rewrites 100k tokens')
  expect(world.commands).toEqual(['clear'])
  expect(session.appended()).toHaveLength(1)
})

test('a /clear typed by the person drops the old band and timer', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  expect(await band($)).toContain('embers  warm  handoff at')
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })

  expect(await band($)).toBe('')
  await clock.advance(55 * MINUTE)
  expect(world.forks).toBe(0)
  expect(world.toasts).toEqual([])
})

test('a handoff whose turn count no longer matches is not swapped to', async ($, on) => {
  const world = engine(on, { turns: 5 })
  const clock = mock.clock(on, { now: T0 })
  const store = memoryStore(on)

  await $.session.start({ ...start, isInteractive: false })
  await $.turn.complete(turnEnd)
  store.set(KEY, handoff({ turns: 3 }))
  await clock.set(T0 + 70 * MINUTE)
  const entered = await $.prompt.submit({ text: 'go on', ...typed })

  expect(entered).toEqual({ text: 'go on' })
  expect(world.asks.map(ask => ask.labels)).toEqual([['Send as is', 'Fresh session']])
  expect(world.compactions).toEqual([])
  expect(world.forks).toBe(0)
})

test('a prompt inside the TTL of a warm fork passes through without asking', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.advance(55 * MINUTE)
  expect(world.forks).toBe(1)
  await clock.set(T0 + 70 * MINUTE)
  const entered = await $.prompt.submit({ text: 'go on', ...typed })

  expect(entered).toEqual({ text: 'go on' })
  expect(world.asks).toEqual([])
  expect(world.compactions).toEqual([])
})

test('a subagent turn end and machine prompts leave the timer and the cache touch alone', async ($, on) => {
  const world = engine(on)
  const state = stateLog(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.set(T0 + 10 * MINUTE)
  await $.turn.complete({ ...turnEnd, agentId: 'agent-1' })
  await $.prompt.submit({ text: 'tick', wait: false, origin: { kind: 'scheduled-trigger' } })
  await $.prompt.submit({ text: 'done', wait: false, isMeta: true, origin: { kind: 'task-notification' } })

  expect(asRun(state.last())).toMatchObject({ phase: 'armed', lastCacheTouch: T0, deadline: T0 + 55 * MINUTE })
  expect(world.asks).toEqual([])
  await clock.set(T0 + 55 * MINUTE)
  expect(world.forks).toBe(1)
})

test('a timer that fires after the cache lapsed (slept laptop) forks nothing', async ($, on) => {
  const world = engine(on)
  const state = stateLog(on)
  const clock = manualClock(on, T0)
  const store = memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  clock.now = T0 + 9 * 60 * MINUTE
  for (const wait of clock.waits) wait.fire()
  await drain()

  expect(world.forks).toBe(0)
  expect([...store.keys()]).toEqual([])
  expect(world.toasts.some(text => text.includes('handoff skipped'))).toBe(true)
  expect(asRun(state.last()).phase).toBe('idle')
})

test('a 5m TTL forks the handoff near its end, not one minute after every turn', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on, { 'ttl:claude-test': { v: 1, observedMinutes: 5, observedAt: T0 - MINUTE } })

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.advance(3 * MINUTE + 59_000)
  expect(world.forks).toBe(0)
  await clock.advance(1000)
  expect(world.forks).toBe(1)
})

test('a model change while idle forks nothing and stores no TTL from the cold read that follows', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  world.model = 'claude-other'
  await clock.advance(55 * MINUTE)
  expect(world.forks).toBe(0)
  expect(world.toasts).toEqual(['embers: handoff skipped, the model changed since the last turn'])

  // Sent before any timer: the first request on the new model reads cold
  // after 10m, well inside the TTL. Taken for a lapse, it would store a 5m
  // TTL and fork 4m after the next turn.
  await $.turn.complete(turnEnd)
  world.model = 'claude-test'
  await clock.advance(10 * MINUTE)
  world.stepUsage = COLD
  await step($)
  await $.turn.complete(turnEnd)
  await clock.advance(5 * MINUTE)
  expect(world.forks).toBe(0)
  await clock.advance(50 * MINUTE)
  expect(world.forks).toBe(1)
})

test('a userConfig reload while armed keeps the deadline and arms one timer', { options: { marginMinutes: 10 } }, async ($, on) => {
  const world = engine(on)
  const state = stateLog(on)
  const clock = manualClock(on, T0)
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  clock.now = T0 + 20 * MINUTE
  // A reload runs `session.start` again; `$.state` survived it.
  await $.session.start(start)

  expect(asRun(state.last()).deadline).toBe(T0 + 50 * MINUTE)
  const live = clock.waits.filter(wait => !wait.signal.aborted)
  expect(live.map(wait => wait.due)).toEqual([T0 + 50 * MINUTE])
  clock.now = T0 + 50 * MINUTE
  for (const wait of live) wait.fire()
  await drain()
  expect(world.forks).toBe(1)
})

test('/compact typed by the person reaches core, even with marker-like instructions', async ($, on) => {
  const world = engine(on)
  mock.clock(on, { now: T0 })
  memoryStore(on, { [KEY]: handoff({}) })

  await $.session.start(start)
  await $.session.compact({ trigger: 'manual', messages: [], instructions: `embers:${T0}` })

  expect(world.compactions.map(e => e.instructions)).toEqual([`embers:${T0}`])
})

test('store retention drops bad and superseded records, keeping the newest per root and branch', async ($, on) => {
  engine(on)
  mock.clock(on, { now: T0 })
  const old = `handoff:${ROOT}:old`
  const newer = `handoff:${ROOT}:newer`
  const other = `handoff:${ROOT}:other`
  const stale = `handoff:${ROOT}:stale`
  const wrong = `handoff:${ROOT}:wrong`
  const store = memoryStore(on, {
    [old]: handoff({ sessionId: 'old', writtenAt: T0 - 120 * MINUTE }),
    [newer]: handoff({ sessionId: 'newer', writtenAt: T0 - 60 * MINUTE }),
    [other]: handoff({ sessionId: 'other', branch: 'feature', writtenAt: T0 - 180 * MINUTE }),
    [stale]: handoff({ sessionId: 'stale', branch: 'stale', writtenAt: T0 - 15 * 24 * 60 * MINUTE }),
    [wrong]: { ...handoff({ sessionId: 'wrong' }), v: 2 },
    'ttl:claude-test': { v: 1, observedMinutes: '5' },
  })

  await $.session.start({ ...start, isInteractive: false })

  expect([...store.keys()].sort()).toEqual([newer, other].sort())
})
