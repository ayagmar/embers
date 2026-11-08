import { expect, mock, test } from 'claude-code/testing'

// Why embers swaps with /clear and an append instead of a compaction.
test('the host refuses a compaction inside prompt.submit, and one from a timer skips the caller', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const toasts: string[] = []
  const core: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.compact', (_, e) => {
    core.push(e.instructions ?? '')
    return { messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.prompt.submit({ text: 'in-hook', wait: false, origin: { kind: 'composer' } })
  expect(toasts).toEqual([
    'rejected HooksError: compact-probe: session.compact: called from a prompt.submit hook, it would compact under the turn this hook is holding; call it from a later event (turn.complete) (host check)',
  ])
  expect(core).toEqual([])

  // From a timer the compaction runs, but past the calling plugin's own
  // session.compact hook: core summarizes the cold prefix with a model call.
  toasts.length = 0
  await $.prompt.submit({ text: 'from-timer', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  expect(core).toEqual(['embers:test'])
  expect(toasts.filter(text => text.startsWith('own session.compact hook'))).toEqual([])
  expect(toasts[0]).toStartWith('resolved')
})
