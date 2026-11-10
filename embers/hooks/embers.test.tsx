import type { ModelUsage, On, SessionCompactInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { HandoffRecord } from '../types'

const ROOT = '/work/repo'
const SESSION = 'session-1'
const MINUTE = 60_000
const T0 = Date.UTC(2026, 10, 8, 12, 0)
const KEY = `handoff:${ROOT}:${SESSION}`
/** A fork's reply as the model writes one: headed sections, lists, past a log line's 2000 characters. */
const FORK_TEXT = `## Goal\n\nHANDOFF: release v2 is next\n\n## State\n\n${'- a step done, with its path and figures\n'.repeat(60)}`

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
  /** What `$.session.surfaces()` answers; empty under -p. */
  surfaces: readonly ('terminal' | 'desktop')[]
  /** What the main loop's next request reads from the cache. */
  stepUsage: ModelUsage
  turns: number
  /** `context.tokens`; absent before a resumed process's first response. */
  contextTokens: number | undefined
  answer: string
  forks: number
  /** While set, a fork in flight waits for it. */
  forkGate: Promise<void> | undefined
  asks: { question: string; labels: string[] }[]
  compactions: SessionCompactInput[]
  /** Lines `$.ui.log` put in the transcript. */
  logged: string[]
  /** Ids of the rows `$.ui.place` put in the transcript. */
  placed: string[]
  filled: string[]
  commands: string[]
  /** The `/clear` rejects, to fail a swap before it starts. */
  failing: 'clear' | undefined
}

/** Stands for the engine: every `$` call embers makes is answered here. */
function engine(on: On, overrides: Partial<World> = {}): World {
  const world: World = {
    model: 'claude-test',
    surfaces: ['terminal'],
    stepUsage: WARM,
    turns: 3,
    contextTokens: 100_000,
    answer: 'Send as is',
    forks: 0,
    forkGate: undefined,
    asks: [],
    compactions: [],
    logged: [],
    placed: [],
    filled: [],
    commands: [],
    failing: undefined,
    ...overrides,
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: ROOT }))
  on('session.model', () => ({ value: world.model }))
  on('session.surfaces', () => ({ value: world.surfaces }))
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
            {
              name: 'Messages',
              tokens: (world.contextTokens ?? 20_000) - 20_000,
              color: 'x',
              isDeferred: false,
              kind: 'used',
            },
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
  on('model.fork', async () => {
    world.forks += 1
    await world.forkGate
    return { value: { isAnswered: true, text: FORK_TEXT, usage: WARM } }
  })
  on('ui.log', (_, e) => {
    if (e.to !== 'transcript') return { value: undefined }
    // The terminal draws one line of 2000 characters: anything longer is mangled.
    if (e.text.includes('\n') || e.text.length > 2000) throw new Error(`a log line the terminal mangles: ${e.text}`)
    world.logged.push(e.text)
    return { value: undefined }
  })
  on('ui.place', (_, e) => {
    world.placed.push(e.id)
    return { value: { isPlaced: true, requestId: e.id } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const asked = e.questions[0]
    if (asked === undefined) throw new Error('no question')
    const labels = asked.options.map(option => option.label)
    world.asks.push({ question: asked.question, labels })
    // `answer` names an option by the start of its label, which may carry a size; else it is typed under "Other".
    const answer = labels.find(label => label.startsWith(world.answer)) ?? world.answer
    return { result: { questions: e.questions, answers: { [asked.question]: answer } } }
  })
  on('session.compact', (_, e) => {
    world.compactions.push(e)
    return { messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.run', (_, e) => {
    if (world.failing === 'clear' && e.command === 'clear') throw new Error('clear failed')
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
  // biome-ignore lint/correctness/useYield: a stream that answers with no parts
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

/**
 * A clock the test moves by hand; each timer is held until the test fires it.
 * `isLive` is false once the plugin cancelled it or a reload lost it.
 */
type Wait = { due: number; isLive: () => boolean; lose: () => void; fire: () => void }
function manualClock(on: On, start: number): { now: number; waits: Wait[] } {
  const clock = { now: start, waits: [] as Wait[] }
  on('clock.now', () => ({ value: clock.now }))
  on(
    'clock.after',
    (_, e, next) =>
      new Promise(resolve => {
        let isLost = false
        const isLive = (): boolean => !isLost && !next.signal.aborted
        clock.waits.push({
          due: clock.now + e.ms,
          isLive,
          lose: () => {
            isLost = true
          },
          fire: () => {
            if (isLive()) resolve({ value: undefined })
          },
        })
      }),
  )
  return clock
}

/**
 * Lets the test start `$.state` over, as the host does under a new session id
 * after a `/clear` (no `session.start` follows) or in a later process. The
 * next read finds nothing; the next write stands.
 */
function stateStartsOver(on: On): () => void {
  let isOver = false
  on('state.get', async (_, e, next) => {
    const read = await next(e)
    return isOver && 'value' in read && read.value !== undefined ? { value: { ...read.value, value: undefined } } : read
  })
  on('state.set', (_, e, next) => {
    isOver = false
    return next(e)
  })
  return () => {
    isOver = true
  }
}

/** `HH:MM` in local time, as the band writes it. */
const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5)

const start = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const turnEnd = {
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer',
  usage: { ...WARM, model: 'claude-test' },
} as const
const typed = { wait: false, origin: { kind: 'composer' } } as const
const MODEL_SWITCH = {
  from_model: 'claude-test',
  to_model: 'claude-test',
  requested_model: null,
  source: 'command',
  context_tokens: 100_000,
  prompt_cache_warm: true,
  cache_ttl: '1h',
  estimated_cache_write_usd: 0,
  pricing: 'default',
} as const
const slash = (command: string, args = '') =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

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

/** The text of the band above the prompt, '' when embers draws none. */
async function band($: Engine): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'embers',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })
  const text = (await ui.find({ type: 'Text', text: /embers/ }))?.text ?? ''
  await ui.unmount()
  return text
}

/** The Markdown the last placed row draws, '' when embers draws none. */
async function placedText($: Engine, world: World): Promise<string> {
  const id = world.placed.at(-1)
  if (id === undefined) return ''
  const ui = await $.ui.mount({
    plugin: 'embers',
    surface: 'terminal',
    component: 'Placed',
    props: { id, plugin: 'embers' },
  })
  const text = (await ui.find({ type: 'Markdown' }))?.props.text
  await ui.unmount()
  return typeof text === 'string' ? text : ''
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
  // Sending rewrites 100k; Fresh writes the 20k of system and tools; the swap adds the handoff.
  const [swapLabel, ...rest] = world.asks[0]?.labels ?? []
  expect(swapLabel).toMatch(/^Swap to handoff \(~2\dk\)$/)
  expect(rest).toEqual(['Send as is (100k)', 'Fresh session (~20k)', 'Read it first'])
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
  // The old conversation stays reachable, and the person can read what the model now holds.
  expect(world.logged.at(-1)).toContain(`claude --resume ${SESSION}`)
  expect(await placedText($, world)).toContain('HANDOFF: release v2 is next')
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

test('a /clear typed by the person drops the old band and timer, and the next turn arms again', async ($, on) => {
  const world = engine(on)
  const clock = manualClock(on, T0)
  memoryStore(on)
  const startOver = stateStartsOver(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  expect(await band($)).toContain('embers  warm  handoff at')
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  expect(clock.waits.filter(wait => wait.isLive())).toEqual([])
  startOver()

  expect(await band($)).toBe('')
  clock.now = T0 + 55 * MINUTE
  expect(world.forks).toBe(0)
  expect(world.logged).toEqual([])

  await $.turn.complete(turnEnd)
  expect(await band($)).toBe(`embers  warm  handoff at ${hhmm(T0 + 110 * MINUTE)}`)
})

test('/embers off holds after a /clear, which starts the state over', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)
  const startOver = stateStartsOver(on)
  const off = {
    command: 'embers',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const

  await $.session.start(start)
  await $.command.run(off)
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  startOver()
  await $.turn.complete(turnEnd)

  expect(await band($)).toBe('')
  await clock.advance(55 * MINUTE)
  expect(world.forks).toBe(0)
})

test('/embers on undoes /embers off, even after a /clear started the state over', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)
  const startOver = stateStartsOver(on)
  const embers = (args: 'on' | 'off') =>
    ({
      command: 'embers',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    }) as const

  await $.session.start(start)
  await $.command.run(embers('off'))
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  startOver()
  await $.command.run(embers('on'))
  await $.turn.complete(turnEnd)

  expect(await band($)).toBe(`embers  warm  handoff at ${hhmm(T0 + 55 * MINUTE)}`)
  await clock.advance(55 * MINUTE)
  expect(world.forks).toBe(1)
})

test('the start offer shows only at a fresh interactive start, and not again after Skip', async ($, on) => {
  const world = engine(on, { answer: 'Skip', turns: 0 })
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on, { [`handoff:${ROOT}:old`]: handoff({ sessionId: 'old', writtenAt: T0 - 120 * MINUTE }) })
  // A later process starts with no `$.state` of its own.
  const startOver = stateStartsOver(on)

  await $.session.start({ ...start, isInteractive: false })
  await clock.settle()
  world.turns = 2
  await $.session.start(start)
  await clock.settle()
  expect(world.asks).toEqual([])

  world.turns = 0
  await $.session.start(start)
  await clock.settle()
  expect(world.asks.map(ask => ask.labels)).toEqual([['Load it', 'Skip']])

  startOver()
  await $.session.start(start)
  await clock.settle()
  expect(world.asks).toHaveLength(1)
})

test('Fresh at a cold prompt clears the session with no fork and no handoff row', async ($, on) => {
  const world = engine(on, { answer: 'Fresh session', surfaces: [] })
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)
  const session = mock.session(on)

  await $.session.start({ ...start, isInteractive: false })
  await $.turn.complete(turnEnd)
  await clock.set(T0 + 70 * MINUTE)
  const dropped = await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()

  expect(dropped.drop).toContain('starting fresh')
  expect(world.commands).toEqual(['clear'])
  expect(world.forks).toBe(0)
  expect(session.appended()).toEqual([])
  expect(world.logged).toEqual([
    `embers: started a fresh session; send your prompt from the box. Old conversation: claude --resume ${SESSION}`,
  ])
  expect(await $.prompt.submit({ text: 'go on', ...typed })).toEqual({ text: 'go on' })
  expect(world.asks).toHaveLength(1)
})

test('a handoff whose turn count no longer matches is not swapped to', async ($, on) => {
  const world = engine(on, { turns: 5, surfaces: [] })
  const clock = mock.clock(on, { now: T0 })
  const store = memoryStore(on)

  await $.session.start({ ...start, isInteractive: false })
  await $.turn.complete(turnEnd)
  store.set(KEY, handoff({ turns: 3 }))
  await clock.set(T0 + 70 * MINUTE)
  const entered = await $.prompt.submit({ text: 'go on', ...typed })

  expect(entered).toEqual({ text: 'go on' })
  expect(world.asks.map(ask => ask.labels)).toEqual([['Send as is (100k)', 'Fresh session (~20k)']])
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
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.set(T0 + 10 * MINUTE)
  await $.turn.complete({ ...turnEnd, agentId: 'agent-1' })
  await $.prompt.submit({ text: 'tick', wait: false, origin: { kind: 'scheduled-trigger' } })
  await $.prompt.submit({ text: 'done', wait: false, isMeta: true, origin: { kind: 'task-notification' } })

  expect(await band($)).toBe(`embers  warm  handoff at ${hhmm(T0 + 55 * MINUTE)}`)
  expect(world.asks).toEqual([])
  await clock.set(T0 + 55 * MINUTE)
  expect(world.forks).toBe(1)
})

test('a timer that fires after the cache lapsed (slept laptop) forks nothing', async ($, on) => {
  const world = engine(on)
  const clock = manualClock(on, T0)
  const store = memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  clock.now = T0 + 9 * 60 * MINUTE
  for (const wait of clock.waits) wait.fire()
  await drain()

  expect(world.forks).toBe(0)
  expect([...store.keys()]).toEqual([])
  expect(world.logged.some(text => text.includes('handoff skipped'))).toBe(true)
  expect(await band($)).toBe('')
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
  expect(world.logged).toEqual(['embers: handoff skipped, the model changed since the last turn'])

  // Sent before any timer: the first request on the new model reads cold
  // after 10m, well inside the TTL. Taken for a lapse, it would make one
  // more cold read enough to store a 5m TTL and fork 4m after every turn.
  world.stepUsage = COLD
  await $.turn.complete(turnEnd)
  world.model = 'claude-test'
  await clock.advance(10 * MINUTE)
  await step($)
  await $.turn.complete(turnEnd)
  await clock.advance(10 * MINUTE)
  await step($)
  await $.turn.complete(turnEnd)
  await clock.advance(5 * MINUTE)
  expect(world.forks).toBe(0)
  await clock.advance(50 * MINUTE)
  expect(world.forks).toBe(1)
})

test('a shorter TTL is stored after cold reads in two idle periods, and cleared by a warm read past it', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)
  world.stepUsage = COLD

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.advance(10 * MINUTE)
  await step($)
  await $.turn.complete(turnEnd)
  // One cold read (a reload, an MCP reconnect) changes nothing yet.
  expect(await band($)).not.toContain('cache lapsed')
  await clock.advance(10 * MINUTE)
  expect(world.forks).toBe(0)
  await step($)
  await $.turn.complete(turnEnd)
  expect(await band($)).toContain('cache lapsed after 5m  margin now 1m')
  await clock.advance(4 * MINUTE)
  expect(world.forks).toBe(1)

  // Warm after 10m idle: the 5m TTL was wrong, the configured 60m is back.
  world.stepUsage = WARM
  await clock.advance(10 * MINUTE)
  await step($)
  await $.turn.complete(turnEnd)
  expect(await band($)).not.toContain('cache lapsed')
  await clock.advance(54 * MINUTE)
  expect(world.forks).toBe(1)
  await clock.advance(MINUTE)
  expect(world.forks).toBe(2)
})

test('/embers on a cold cache asks before a fork that rereads the whole context', async ($, on) => {
  const world = engine(on, { answer: 'Cancel', surfaces: [] })
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)
  const embers = {
    command: 'embers',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const

  await $.session.start({ ...start, isInteractive: false })
  await $.turn.complete(turnEnd)
  await clock.set(T0 + 70 * MINUTE)
  expect(await $.command.run(embers)).toEqual({ text: 'No handoff written.' })
  expect(world.asks[0]?.question).toContain('The prompt cache is cold, so a handoff now rereads 100k tokens')
  expect(world.forks).toBe(0)

  world.answer = 'Write it'
  const written = await $.command.run(embers)
  expect(world.forks).toBe(1)
  expect(written.text).toStartWith('Handoff written')
})

test('/embers after a model change asks before forking; a resumed touch that names no model does not', async ($, on) => {
  const world = engine(on, { answer: 'Cancel', surfaces: [] })
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on, { [KEY]: handoff({}) })
  const embers = {
    command: 'embers',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const

  await $.session.start({ ...start, isInteractive: false })
  await clock.set(T0 + 10 * MINUTE)
  expect((await $.command.run(embers)).text).toStartWith('Handoff written')
  expect(world.asks).toEqual([])

  await $.turn.complete(turnEnd)
  world.model = 'claude-other'
  await clock.set(T0 + 20 * MINUTE)
  expect(await $.command.run(embers)).toEqual({ text: 'No handoff written.' })
  expect(world.asks).toHaveLength(1)
  expect(world.forks).toBe(1)
})

test(
  'a userConfig reload while armed re-arms the timer the reload lost, once',
  { options: { marginMinutes: 10 } },
  async ($, on) => {
    const world = engine(on)
    const clock = manualClock(on, T0)
    memoryStore(on)

    await $.session.start(start)
    await $.turn.complete(turnEnd)
    clock.now = T0 + 20 * MINUTE
    // A reload starts the module over: its timer is gone, `$.state` survived.
    for (const wait of clock.waits) wait.lose()
    await $.session.start(start)

    expect(await band($)).toBe(`embers  warm  handoff at ${hhmm(T0 + 50 * MINUTE)}`)
    const live = clock.waits.filter(wait => wait.isLive())
    expect(live.map(wait => wait.due)).toEqual([T0 + 50 * MINUTE])
    clock.now = T0 + 50 * MINUTE
    for (const wait of live) wait.fire()
    await drain()
    expect(world.forks).toBe(1)
  },
)

test('/compact typed by the person reaches core, even with marker-like instructions', async ($, on) => {
  const world = engine(on)
  mock.clock(on, { now: T0 })
  memoryStore(on, { [KEY]: handoff({}) })

  await $.session.start(start)
  await $.session.compact({ trigger: 'manual', messages: [], instructions: `embers:${T0}` })

  expect(world.compactions.map(e => e.instructions)).toEqual([`embers:${T0}`])
})

test('a fork overtaken by a turn, /effort or a reload stores nothing, and /embers is refused while one runs', async ($, on) => {
  const world = engine(on)
  mock.clock(on, { now: T0 })
  const store = memoryStore(on)

  async function overtaken(moveOn: () => Promise<void>): Promise<void> {
    let release = (): void => {}
    world.forkGate = new Promise<void>(resolve => {
      release = resolve
    })
    const running = $.command.run(slash('embers'))
    await drain()
    expect(await band($)).toBe('embers  writing handoff…')
    expect((await $.command.run(slash('embers'))).text).toContain('is being written')
    await moveOn()
    release()
    expect((await running).text).toContain('the conversation moved on')
    expect(store.has(KEY)).toBe(false)
  }

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await overtaken(async () => {
    world.turns = 4
    await $.turn.complete(turnEnd)
    expect(await band($)).toContain('embers  warm  handoff at')
  })
  await overtaken(async () => {
    await $.session.start(start)
    expect(await band($)).toBe('')
  })
  await overtaken(async () => {
    await $.command.run(slash('effort', 'low'))
    expect(await band($)).toBe('')
  })
  expect(world.forks).toBe(3)
})

test(
  'a session under minContextTokens gets no band, no fork at the deadline and no cold ask',
  { options: { minSavingTokens: 0 } },
  async ($, on) => {
    const world = engine(on, { contextTokens: 30_000 })
    const clock = mock.clock(on, { now: T0 })
    memoryStore(on)

    await $.session.start(start)
    await $.turn.complete(turnEnd)
    expect(await band($)).toBe('')
    await clock.advance(55 * MINUTE)
    expect(world.forks).toBe(0)

    // Asked for by hand, the fork runs; the band stays quiet about a small session.
    await $.command.run(slash('embers'))
    expect(world.forks).toBe(1)
    expect(await band($)).toBe('')

    await clock.set(T0 + 180 * MINUTE)
    expect(await $.prompt.submit({ text: 'go on', ...typed })).toEqual({ text: 'go on' })
    expect(world.asks).toEqual([])
  },
)

test('/effort, a compaction or a model switch disarms the handoff, and a timer already firing when /embers off lands forks nothing', async ($, on) => {
  const world = engine(on)
  const clock = manualClock(on, T0)
  memoryStore(on)
  let heldRead: Promise<void> | undefined
  on('state.get', async (_, e, next) => {
    const gate = heldRead
    heldRead = undefined
    await gate
    return next(e)
  })
  on('classic.PostModelSwitch', () => ({}))
  const resets: (() => Promise<unknown>)[] = [
    () => $.command.run(slash('effort', 'low')),
    () => $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'earlier', toolUses: [] }] }),
    () => $.classic.PostModelSwitch(MODEL_SWITCH),
  ]

  await $.session.start(start)
  for (const reset of resets) {
    await $.turn.complete(turnEnd)
    expect(await band($)).toContain('embers  warm  handoff at')
    await reset()
    expect(await band($)).toBe('')
    expect(clock.waits.filter(wait => wait.isLive())).toEqual([])
  }

  // The timer has fired and its read of the state waits behind the off.
  await $.turn.complete(turnEnd)
  const [armed] = clock.waits.filter(wait => wait.isLive())
  let release = (): void => {}
  heldRead = new Promise<void>(resolve => {
    release = resolve
  })
  clock.now = T0 + 55 * MINUTE
  armed?.fire()
  await drain()
  await $.command.run(slash('embers', 'off'))
  release()
  await drain()
  expect(world.forks).toBe(0)
})

test('past its cap a root drops only superseded handoffs older than twice the TTL', async ($, on) => {
  engine(on)
  mock.clock(on, { now: T0 })
  const key = (sessionId: string): string => `handoff:${ROOT}:${sessionId}`
  const crowded = { branch: 'crowded' }
  const heads = Array.from({ length: 9 }, (_, i) => `head-${i}`)
  const kept = [...heads, 'newest', 'young'].map(key)
  const store = memoryStore(on, {
    ...Object.fromEntries(
      heads.map(id => [key(id), handoff({ sessionId: id, branch: id, writtenAt: T0 - 500 * MINUTE })]),
    ),
    [key('newest')]: handoff({ ...crowded, sessionId: 'newest', writtenAt: T0 - MINUTE }),
    [key('young')]: handoff({ ...crowded, sessionId: 'young', writtenAt: T0 - 90 * MINUTE }),
    [key('old')]: handoff({ ...crowded, sessionId: 'old', writtenAt: T0 - 180 * MINUTE }),
  })

  await $.session.start({ ...start, isInteractive: false })

  expect([...store.keys()].sort()).toEqual(kept.sort())
})

test('store retention drops bad and expired records, and keeps superseded ones while the root is under its cap', async ($, on) => {
  engine(on)
  mock.clock(on, { now: T0 })
  const old = `handoff:${ROOT}:old`
  const newer = `handoff:${ROOT}:newer`
  // Two terminals in one checkout: A's handoff is younger than twice the TTL.
  const terminalA = `handoff:${ROOT}:terminal-a`
  const terminalB = `handoff:${ROOT}:terminal-b`
  const other = `handoff:${ROOT}:other`
  const stale = `handoff:${ROOT}:stale`
  const wrong = `handoff:${ROOT}:wrong`
  const store = memoryStore(on, {
    [old]: handoff({ sessionId: 'old', writtenAt: T0 - 180 * MINUTE }),
    [newer]: handoff({ sessionId: 'newer', writtenAt: T0 - 60 * MINUTE }),
    [terminalA]: handoff({ sessionId: 'terminal-a', branch: 'two', writtenAt: T0 - 90 * MINUTE }),
    [terminalB]: handoff({ sessionId: 'terminal-b', branch: 'two', writtenAt: T0 - 5 * MINUTE }),
    [other]: handoff({ sessionId: 'other', branch: 'feature', writtenAt: T0 - 180 * MINUTE }),
    [stale]: handoff({ sessionId: 'stale', branch: 'stale', writtenAt: T0 - 15 * 24 * 60 * MINUTE }),
    [wrong]: { ...handoff({ sessionId: 'wrong' }), v: 2 },
    'ttl:claude-test': { v: 1, observedMinutes: '5' },
  })

  await $.session.start({ ...start, isInteractive: false })

  expect([...store.keys()].sort()).toEqual([old, newer, other, terminalA, terminalB].sort())
})

test('a swap refused after the /clear says so and names the old session', async ($, on) => {
  const world = engine(on, { answer: 'Swap to handoff', contextTokens: undefined })
  const clock = mock.clock(on, { now: T0 + 120 * MINUTE })
  memoryStore(on, { [KEY]: handoff({}) })
  on('session.append', () => ({ deny: 'too large' }))

  await $.session.start(start)
  await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()

  expect(world.commands).toEqual(['clear'])
  expect(world.logged).toHaveLength(1)
  expect(world.logged[0]).toContain('the handoff was refused (too large)')
  expect(world.logged[0]).toContain(`claude --resume ${SESSION}`)
})

test('a /clear that fails changes nothing, and the next prompt is still asked about', async ($, on) => {
  const world = engine(on, { answer: 'Swap to handoff', contextTokens: undefined, failing: 'clear' })
  const clock = mock.clock(on, { now: T0 + 120 * MINUTE })
  memoryStore(on, { [KEY]: handoff({}) })

  await $.session.start(start)
  await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()
  expect(world.logged.at(-1)).toContain('could not be cleared')

  world.failing = undefined
  await $.prompt.submit({ text: 'go on', ...typed })
  expect(world.asks).toHaveLength(2)
})

test('a turn that ended on an API error does not count as a cache read', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.set(T0 + 30 * MINUTE)
  await $.prompt.submit({ text: 'go on', ...typed })
  const { usage: _, ...noUsage } = turnEnd
  await $.turn.complete({ ...noUsage, reason: 'error' })
  expect(await band($)).toBe('')

  // 65 minutes after the last read, 35 after the error: cold.
  await clock.set(T0 + 65 * MINUTE)
  await $.prompt.submit({ text: 'go on', ...typed })
  expect(world.asks).toHaveLength(1)
  expect(world.forks).toBe(0)
})

test("/embers show draws this session's handoff for the person and sends the model nothing", async ($, on) => {
  const world = engine(on)
  mock.clock(on, { now: T0 })
  memoryStore(on, { [KEY]: handoff({ text: '## Goal\n\nship v2' }) })

  await $.session.start(start)
  const shown = await $.command.run(slash('embers', 'show'))

  expect(shown.text).toBeUndefined()
  expect(await placedText($, world)).toContain('## Goal\n\nship v2')
})

test('a cold ask answered with free text or dismissed sends nothing and changes nothing', async ($, on) => {
  const world = engine(on, { answer: 'hmm, wait', contextTokens: undefined })
  const clock = mock.clock(on, { now: T0 + 120 * MINUTE })
  memoryStore(on, { [KEY]: handoff({}) })

  await $.session.start(start)
  const dropped = await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()

  expect(dropped).toEqual({ drop: 'embers: nothing sent; your prompt is back in the box' })
  expect(world.commands).toEqual([])
  // Still cold: the prompt sent again is asked about again.
  await $.prompt.submit({ text: 'go on', ...typed })
  expect(world.asks).toHaveLength(2)
})

test('Read it first shows the handoff, keeps the session, and asks again on the next prompt', async ($, on) => {
  const world = engine(on, { answer: 'Read it first', contextTokens: undefined })
  const clock = mock.clock(on, { now: T0 + 120 * MINUTE })
  const store = memoryStore(on, { [KEY]: handoff({ text: '## Goal\n\nship v2' }) })

  await $.session.start(start)
  const dropped = await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()

  expect(dropped.drop).toContain('the handoff is above')
  expect(await placedText($, world)).toContain('## Goal\n\nship v2')
  expect(world.commands).toEqual([])
  expect(store.has(KEY)).toBe(true)
  world.answer = 'Swap to handoff'
  await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()
  expect(world.commands).toEqual(['clear'])
})

test('an observed TTL expires after a day; one Claude Code reported does not', async ($, on) => {
  engine(on)
  mock.clock(on, { now: T0 })
  const store = memoryStore(on, {
    'ttl:claude-test': { v: 1, observedMinutes: 5, observedAt: T0 - 2 * 24 * 60 * MINUTE },
  })

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  expect(await band($)).toBe(`embers  warm  handoff at ${hhmm(T0 + 55 * MINUTE)}`)
  expect(store.has('ttl:claude-test')).toBe(false)

  store.set('ttl:claude-test', { v: 1, observedMinutes: 5, observedAt: T0 - 2 * 24 * 60 * MINUTE, source: 'reported' })
  await $.turn.complete(turnEnd)
  expect(await band($)).toBe(`embers  warm  handoff at ${hhmm(T0 + 4 * MINUTE)}`)
})

test("Load it brings in an earlier session's handoff as such, and leaves it for that session", async ($, on) => {
  const world = engine(on, { answer: 'Load it', turns: 0 })
  const clock = mock.clock(on, { now: T0 })
  const oldKey = `handoff:${ROOT}:old`
  const store = memoryStore(on, {
    [oldKey]: handoff({ sessionId: 'old', writtenAt: T0 - 120 * MINUTE, text: 'ship v2' }),
  })
  const session = mock.session(on)

  await $.session.start(start)
  await clock.settle()

  const row = JSON.stringify(session.appended()[0]?.message.content)
  expect(row).toContain('A handoff from an earlier session')
  expect(row).not.toContain('This conversation was replaced')
  expect(await placedText($, world)).toContain('ship v2')
  // Session "old" may still be open: its handoff stays, marked so it is not offered again.
  expect(store.get(oldKey)).toMatchObject({ sessionId: 'old', offeredAt: T0 })
})

test('/embers status tallies what handoffs cost and what swaps saved this month', async ($, on) => {
  engine(on, { answer: 'Swap to handoff' })
  const clock = mock.clock(on, { now: T0 })
  memoryStore(on)

  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.advance(55 * MINUTE)
  await clock.set(T0 + 120 * MINUTE)
  await $.prompt.submit({ text: 'go on', ...typed })
  await clock.settle()

  const status = await $.command.run(slash('embers', 'status'))
  // The fork read 99k from cache, 300 uncached, 1.2k out: 9.9k + 300 + 6k = 16.2k.
  expect(status.text).toContain('This month: 1 handoff cost ~16k; 1 swap saved ~')
  expect(status.text).toMatch(/Net saved ~\d+k/)
})
