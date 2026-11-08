import type { EngineInterface, Register } from 'claude-code'

// Asks for the compaction embers' swap would need, from the two places embers
// could ask: inside the cold prompt's prompt.submit hook, and from a timer
// that hook leaves behind. Each answer is toasted for the test to read.
export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.text === 'in-hook') {
      $.ui.toast(await compact($))
    } else if (e.text === 'from-timer') {
      $.clock.after(0, () => {
        void compact($).then(answer => $.ui.toast(answer))
      })
    }
    return next(e)
  })

  // The hook that would answer with the handoff instead of core's summary.
  on('session.compact', async ($, e, next) => {
    $.ui.toast(`own session.compact hook ran (${e.trigger})`)
    return next(e)
  })
}

async function compact($: EngineInterface): Promise<string> {
  return $.session.compact({ instructions: 'embers:test' }).then(
    result => `resolved ${JSON.stringify(result)}`,
    (error: unknown) => `rejected ${String(error)}`,
  )
}
