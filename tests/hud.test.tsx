import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 20 }

const BAND = {
  plugin: 'jarvis-hud',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: SCROLL, view: {} },
} as const

const PANE = {
  plugin: 'jarvis-hud',
  component: 'Pane',
  requestId: 'jarvis',
  props: { title: 'J.A.R.V.I.S.', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
} as const

const MEASURE = {
  context: { tokens: 152_000, window: 200_000, percent: 76 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2099-01-01T00:00:00Z' }],
  cost: { usd: 3.5 },
  changed: ['context', 'rateLimits', 'cost'],
} as const

test('a reading lights the band, the pane and the briefing on every surface', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-27T10:00:00Z') })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'jarvis' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // before any reply the band still says it is there
  const early = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await early.find({ type: 'Text', text: /JARVIS online/ })).toBeDefined()
  await early.unmount()

  await $.session.measure(MEASURE)

  const text = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await text.find({ type: 'Text', text: /^ 48K$/ }))?.text).toContain('48K')
  expect(await text.find({ key: 'hud' })).toBeDefined()
  // cost is reported by Claude Code but never shown
  expect(await text.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  await text.unmount()

  // the desktop draws the reactor strip instead of the text row
  const strip = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = String((await strip.find({ type: 'Svg' }))?.props.source)
  expect(svg).toContain('48K left')
  expect(svg).toContain('76% used')
  expect(svg).toContain('58%')
  expect(svg).toContain('5-hour quota: 42% used')
  expect(svg).not.toContain('$')
  expect(await strip.find({ type: 'Text', text: /48K/ })).toBeUndefined()
  expect(await strip.find({ key: 'hud' })).toBeDefined()
  await strip.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /152K \/ 200K · 76%/ })).toBeDefined()
    // crossing 70% left a line in the log
    expect(await pane.find({ type: 'Text', text: /Context at 76%/ })).toBeDefined()
    expect(await pane.find({ key: 'compact' })).toBeDefined()
    await pane.unmount()
  }

  const status = await $.command.run({ command: 'jarvis', args: 'status' })
  expect(status.text).toContain('48K of 200K')
  expect(status.text).toContain('5-hour quota: 42% used')
  expect(status.text).not.toContain('cost')

  const off = await $.command.run({ command: 'jarvis', args: 'auto off' })
  expect(off.text).toBe('Auto-compact disarmed.')
})

test('past the threshold, a finished turn triggers a compaction', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-27T10:00:00Z') })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'jarvis' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  let compactions = 0
  on('session.compact', () => {
    compactions += 1
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 180_000, tokensAfter: 30_000 }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ ...MEASURE, context: { tokens: 180_000, window: 200_000, percent: 90 } })
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)
  await clock.settle()

  expect(compactions).toBe(1)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /Compaction complete\. 180K → 30K/ })).toBeDefined()
  await pane.unmount()
})

test('a narrow band sheds detail, and the breakdown names the biggest consumer', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-27T10:00:00Z') })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'jarvis' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 100_000,
        window: 200_000,
        percent: 50,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 3_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'MCP tools', tokens: 20_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: 77_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 100_000, color: 'x', isDeferred: false, kind: 'free' },
          ],
          totalTokens: 100_000, maxTokens: 200_000, rawMaxTokens: 200_000, autocompactSource: 'model-default',
          percentage: 50, gridRows: [], model: 'm', memoryFiles: [], mcpTools: [], agents: [],
          autoCompactThreshold: 180_000, isAutoCompactEnabled: true, apiUsage: null,
        },
      },
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  await clock.settle()
  await $.session.measure({ ...MEASURE, context: { tokens: 100_000, window: 200_000, percent: 50 }, cost: { usd: 2 } })
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /↻/ })).toBeDefined()
  await band.unmount()

  // a narrow band sheds detail instead of wrapping: reset timers go first
  const thin = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 30 } })
  expect(await thin.find({ type: 'Text', text: /↻/ })).toBeUndefined()
  expect(await thin.find({ key: 'hud' })).toBeDefined()
  await thin.unmount()

  // the strip scales instead: the same drawing at any width
  const strip = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 30 } })
  expect(String((await strip.find({ type: 'Svg' }))?.props.source)).toContain('↻')
  await strip.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /WHERE IT WENT/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /is 77% of what's in use/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Compacting shrinks this/ })).toBeDefined()
    await pane.unmount()
  }

  const status = await $.command.run({ command: 'jarvis', args: 'status' })
  expect(status.text).not.toContain('cost')
})
