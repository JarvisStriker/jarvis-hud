import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Breakdown, Compaction, FileStat, HudSettings, Limit, LogLine, Reading, Sample, ToolStat, TurnStat } from '../types'

// ── state ────────────────────────────────────────────────────────────────

const PANE = 'jarvis'
const TITLE = 'J.A.R.V.I.S.'

const DEFAULTS: HudSettings = { autoCompact: true, compactAt: 85, voice: false, readGuard: true }

const readingA = atom({ plugin: 'jarvis-hud', key: 'reading' } as const, null)
const samplesA = atom({ plugin: 'jarvis-hud', key: 'samples' } as const, [])
const breakdownA = atom({ plugin: 'jarvis-hud', key: 'breakdown' } as const, null)
const settingsA = atom({ plugin: 'jarvis-hud', key: 'settings' } as const, DEFAULTS)
const logA = atom({ plugin: 'jarvis-hud', key: 'log' } as const, [])
const alertedA = atom({ plugin: 'jarvis-hud', key: 'alerted' } as const, [])
const tickA = atom({ plugin: 'jarvis-hud', key: 'tick' } as const, 0)
const bandHiddenA = atom({ plugin: 'jarvis-hud', key: 'bandHidden' } as const, false)
const compactingA = atom({ plugin: 'jarvis-hud', key: 'compacting' } as const, false)
// Session stats: per-turn usage, what each tool and file put into the context,
// compactions, and when the session began.
const turnsA = atom({ plugin: 'jarvis-hud', key: 'turns' } as const, [])
const toolsA = atom({ plugin: 'jarvis-hud', key: 'tools' } as const, {})
const filesA = atom({ plugin: 'jarvis-hud', key: 'files' } as const, [])
const compactionsA = atom({ plugin: 'jarvis-hud', key: 'compactions' } as const, [])
const startedAtA = atom({ plugin: 'jarvis-hud', key: 'startedAt' } as const, null)
const subagentsA = atom({ plugin: 'jarvis-hud', key: 'subagents' } as const, 0)

// ── palette & formatting ─────────────────────────────────────────────────

const ORANGE = '#d97757' // Claude's own
const AMBER = '#f5c542'
const RED = '#ff3b4f'
const DIM = '#9a8478'
const SLICE_COLORS = ['#d97757', '#7c5cff', '#ff7ad9', '#f5c542', '#4ade80', '#38bdf8', '#94a3b8', '#a3e635']

const CTX_LEVELS = [70, 85, 95]
const LIMIT_LEVELS = [75, 90]

const COMPACT_INSTRUCTIONS =
  'Preserve the current goal, decisions made and why, file paths touched, open TODOs and unresolved errors. ' +
  'Drop verbose tool output, superseded attempts and anything already resolved.'

const heat = (usedPct: number) => (usedPct >= 85 ? RED : usedPct >= 70 ? AMBER : ORANGE)

const fmtK = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.max(0, Math.round(n)))

const bar = (fracLeft: number, cells: number) => {
  const lit = Math.max(0, Math.min(cells, Math.round(fracLeft * cells)))
  return '▰'.repeat(lit) + '▱'.repeat(cells - lit)
}

const span = (ms: number) => {
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

const clock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const limitName = (kind: string) =>
  kind === 'five_hour' ? '5H' : kind === 'seven_day' ? '7D' : kind === 'spend_limit' ? 'SPEND' : kind.toUpperCase()

const limitLong = (kind: string) =>
  kind === 'five_hour' ? '5-hour quota' : kind === 'seven_day' ? 'Weekly quota' : kind === 'spend_limit' ? 'Spend limit' : kind

const left = (r: Reading) => Math.max(0, r.window - (r.tokens ?? 0))
const usedPct = (r: Reading) => r.pct ?? Math.round(((r.tokens ?? 0) / r.window) * 100)

// ── projections ──────────────────────────────────────────────────────────

type Projection = { perTurn?: number; turnsLeft?: number; target: number; quotaEta?: number; quotaSafe?: boolean }

function project(r: Reading, samples: Sample[], s: HudSettings, b: Breakdown | null, now: number): Projection {
  const target = s.autoCompact ? (r.window * s.compactAt) / 100 : b?.compactAt ?? r.window
  const growth: number[] = []
  const recent = samples.filter(x => x.tokens !== undefined).slice(-7)
  for (let i = 1; i < recent.length; i++) {
    const d = (recent[i]!.tokens ?? 0) - (recent[i - 1]!.tokens ?? 0)
    if (d > 0) growth.push(d) // a drop is a compaction, not a turn's cost
  }
  const out: Projection = { target }
  if (growth.length >= 2) {
    out.perTurn = growth.reduce((a, n) => a + n, 0) / growth.length
    out.turnsLeft = Math.max(0, Math.floor((target - (r.tokens ?? 0)) / out.perTurn))
  }

  const fiveHour = r.limits.find(l => l.kind === 'five_hour')
  const window = samples.filter(x => x.fiveHour !== undefined && now - x.at < 60 * 60_000)
  if (fiveHour && window.length >= 2) {
    const first = window[0]!
    const last = window[window.length - 1]!
    const rate = ((last.fiveHour ?? 0) - (first.fiveHour ?? 0)) / Math.max(1, last.at - first.at)
    if (rate > 0) {
      out.quotaEta = now + (100 - fiveHour.pct) / rate
      const reset = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : NaN
      out.quotaSafe = Number.isFinite(reset) && reset < out.quotaEta
    }
  }
  return out
}

// ── the voice of the system ──────────────────────────────────────────────

async function say($: EngineInterface, text: string, level: LogLine['level'], opts: { toast?: boolean; notify?: boolean } = {}) {
  const at = await $.clock.now()
  await update($, logA, list => [...list, { at, text, level }].slice(-40))
  if (opts.toast !== false) $.ui.toast(`◢ ${text}`, { timeoutMs: level === 'crit' ? 9000 : 5000 })
  if (opts.notify) void $.ui.notify(text, { title: TITLE }).catch(() => undefined)
  const s = await read($, settingsA)
  if (s.voice && level !== 'info') void $.audio.speak(text).catch(() => undefined)
}

async function checkAlerts($: EngineInterface, r: Reading) {
  const s = await read($, settingsA)
  const done = new Set(await read($, alertedA))
  const before = [...done].sort().join('|')
  const pct = usedPct(r)

  for (const level of CTX_LEVELS) {
    const key = `ctx:${level}`
    if (pct < level - 10) done.delete(key) // re-arm after a compaction
    if (pct < level || done.has(key)) continue
    done.add(key)
    if (level === 70) await say($, `Context at ${pct}%. ${fmtK(left(r))} tokens in reserve. Monitoring.`, 'info')
    else if (level === 85)
      await say(
        $,
        s.autoCompact
          ? `Context at ${pct}%. I'll compact once this turn completes.`
          : `Context at ${pct}%. Recommend /jarvis compact.`,
        'warn',
      )
    else await say($, `Context critical: ${pct}%. ${fmtK(left(r))} tokens remain.`, 'crit', { notify: true })
  }

  for (const l of r.limits) {
    for (const level of LIMIT_LEVELS) {
      const key = `${l.kind}:${level}:${l.resetsAt ?? ''}`
      if (l.pct < level || done.has(key)) continue
      done.add(key)
      const reset = l.resetsAt ? ` Resets in ${span(Date.parse(l.resetsAt) - r.at)}.` : ''
      await say($, `${limitLong(l.kind)} at ${Math.round(l.pct)}%.${reset}`, level >= 90 ? 'crit' : 'warn', {
        notify: level >= 90,
      })
    }
  }

  if ([...done].sort().join('|') !== before) await update($, alertedA, () => [...done])
}

async function refreshBreakdown($: EngineInterface) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    if (!b) return
    await update($, breakdownA, () => ({
      max: b.rawMaxTokens,
      compactAt: b.autoCompactThreshold,
      slices: b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    }))
  } catch {
    // no session bound yet; the next turn tries again
  }
}

async function compactNow($: EngineInterface, why: 'auto' | 'manual') {
  if (await read($, compactingA)) return 'Compaction already in progress.'
  await update($, compactingA, () => true)
  await say($, why === 'auto' ? 'Threshold reached. Initiating compaction.' : 'Initiating compaction.', 'act')
  try {
    const r = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    if (r.skip !== undefined) {
      await say($, `Compaction declined: ${r.skip}`, 'warn')
      return `Compaction declined: ${r.skip}`
    }
    const freed =
      r.tokensBefore !== undefined && r.tokensAfter !== undefined
        ? ` ${fmtK(r.tokensBefore)} → ${fmtK(r.tokensAfter)}.`
        : ''
    await say($, `Compaction complete.${freed} Reserves restored.`, 'act')
    await update($, alertedA, list => list.filter(k => !k.startsWith('ctx:')))
    return `Compaction complete.${freed}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await say($, `Compaction failed: ${msg}`, 'warn')
    return `Compaction failed: ${msg}`
  } finally {
    await update($, compactingA, () => false)
    await refreshBreakdown($)
  }
}

async function briefing($: EngineInterface) {
  const r = await read($, readingA)
  if (!r || r.tokens === undefined) return 'Telemetry offline: no response measured yet. Send a prompt and I will report.'
  const s = await read($, settingsA)
  const p = project(r, await read($, samplesA), s, await read($, breakdownA), await $.clock.now())
  const lines = [
    `Context: ${usedPct(r)}% used, ${fmtK(left(r))} of ${fmtK(r.window)} tokens in reserve.`,
    p.turnsLeft !== undefined
      ? `Burn rate ~${fmtK(p.perTurn ?? 0)}/turn: about ${p.turnsLeft} turns until ${s.autoCompact ? 'I compact' : 'auto-compact'}.`
      : 'Burn rate: gathering data.',
    ...r.limits.map(
      l =>
        `${limitLong(l.kind)}: ${Math.round(l.pct)}% used${l.resetsAt ? `, resets in ${span(Date.parse(l.resetsAt) - r.at)}` : ''}.`,
    ),
    p.quotaEta !== undefined
      ? p.quotaSafe
        ? '5-hour quota will reset before you hit it at this pace.'
        : `At this pace the 5-hour quota runs out around ${clock(p.quotaEta)}.`
      : '',
    `Auto-compact ${s.autoCompact ? `armed at ${s.compactAt}%` : 'off'} · voice ${s.voice ? 'on' : 'off'} · read guard ${s.readGuard ? 'on' : 'off'}.`,
  ]
  return lines.filter(Boolean).join('\n')
}

async function setSetting($: EngineInterface, patch: Partial<HudSettings>) {
  await update($, settingsA, s => ({ ...s, ...patch }))
  await $.store.set('settings', await read($, settingsA))
}

// ── SVG: drawn pane sections ─────────────────────────────────────────────

// What each /context row is, in plain words, and what to do when it grows.
const SLICE_HINTS: [RegExp, string, string][] = [
  [/message|conversation/i, 'Your chat and tool output', 'Compacting shrinks this.'],
  [/mcp/i, "Connected servers' tool definitions", 'Disconnect servers you are not using (/mcp).'],
  [/memory/i, 'CLAUDE.md and memory files', 'Trim long memory files.'],
  [/skill/i, 'Skill listings', 'Disable skills you never use.'],
  [/agent/i, 'Custom agent descriptions', 'Remove unused agents.'],
  [/system tool/i, "Claude Code's built-in tools", 'Fixed cost, nothing to do.'],
  [/system prompt/i, 'Base instructions', 'Fixed cost, nothing to do.'],
]

const hintFor = (name: string) => SLICE_HINTS.find(([re]) => re.test(name)) ?? [/./, name, '']

const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const STRIP_H = 64

// The desktop band: a mini reactor for context with its forecast, then a gauge per
// quota stretched to fill the band. Drawn at `width` CSS pixels, one unit a pixel,
// so text stays crisp. Hover any part for exact numbers; it pulses past 85% and
// spins fast while compacting, like the pane's reactor.
function stripSvg(r: Reading, p: Projection, s: HudSettings, compacting: boolean, now: number, width: number) {
  const W = Math.round(width)
  const pct = usedPct(r)
  const c = heat(pct)
  const mono = 'font-family="Consolas, Menlo, monospace"'
  const sans = 'font-family="Segoe UI, system-ui, -apple-system, sans-serif"'
  const ring = 2 * Math.PI * 21
  const spin = compacting ? 4 : 30
  const pulse =
    pct >= 85 || compacting
      ? `<animate attributeName="opacity" values="0.35;1;0.35" dur="${compacting ? 0.8 : 1.4}s" repeatCount="indefinite"/>`
      : ''
  const forecast =
    p.turnsLeft !== undefined ? `~${p.turnsLeft} turns to ${s.autoCompact ? 'compact' : 'auto-compact'}` : 'calibrating burn rate'
  const tip = `${fmtK(r.tokens ?? 0)} of ${fmtK(r.window)} used · auto-compact at ${fmtK(p.target)}${
    p.perTurn !== undefined ? ` · ~${fmtK(p.perTurn)}/turn` : ''
  }`

  const reactor =
    `<g><title>${xml(tip)}</title>` +
    `<circle cx="38" cy="32" r="27" fill="none" stroke="${ORANGE}" stroke-opacity="0.4" stroke-width="1" stroke-dasharray="2 5">` +
    `<animateTransform attributeName="transform" type="rotate" from="0 38 32" to="360 38 32" dur="${spin}s" repeatCount="indefinite"/></circle>` +
    `<circle cx="38" cy="32" r="21" fill="none" stroke="${c}" stroke-opacity="0.16" stroke-width="6"/>` +
    `<circle cx="38" cy="32" r="21" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round" ` +
    `stroke-dasharray="${((ring * (100 - pct)) / 100).toFixed(1)} ${ring.toFixed(1)}" transform="rotate(-90 38 32)"/>` +
    `<circle cx="38" cy="32" r="12" fill="#2e1810" stroke="${c}" stroke-opacity="0.6"/>` +
    `<circle cx="38" cy="32" r="4.5" fill="${c}">${pulse}</circle>` +
    `<text x="78" y="30" ${sans} font-size="19" font-weight="600" fill="#fff3ec">${compacting ? 'Compacting…' : `${fmtK(left(r))} left`}` +
    `<tspan ${sans} font-size="12" font-weight="400" fill="${DIM}"> of ${fmtK(r.window)}</tspan></text>` +
    `<text x="78" y="49" ${mono} font-size="11.5" fill="${DIM}">${pct}% used · ${forecast}</text></g>`

  // Quotas fill whatever the band has left beside the reactor block.
  const limits = r.limits.slice(0, 2)
  const x0 = 340
  const right = W - 18
  const roomy = right - x0 > 300
  const valueW = roomy ? 132 : 48
  const barX = x0 + 34
  const barW = Math.max(40, right - valueW - 12 - barX)
  const rows = limits.map((l, i) => {
    const cy = limits.length === 1 ? 32 : 22 + i * 21
    const leftPct = Math.max(0, Math.min(100, 100 - l.pct))
    const reset = l.resetsAt ? span(Date.parse(l.resetsAt) - now) : undefined
    const lc = heat(l.pct)
    return (
      `<g><title>${xml(`${limitLong(l.kind)}: ${Math.round(l.pct)}% used${reset ? `, resets in ${reset}` : ''}`)}</title>` +
      `<text x="${x0}" y="${cy + 4}" ${mono} font-size="11.5" fill="${DIM}">${xml(limitName(l.kind))}</text>` +
      `<rect x="${barX}" y="${cy - 4}" width="${barW.toFixed(1)}" height="8" rx="4" fill="${lc}" fill-opacity="0.16"/>` +
      `<rect x="${barX}" y="${cy - 4}" width="${((barW * leftPct) / 100).toFixed(1)}" height="8" rx="4" fill="${lc}"/>` +
      `<text x="${right}" y="${cy + 4.5}" text-anchor="end" ${sans} font-size="12.5" fill="#fff3ec">${Math.round(leftPct)}%` +
      `${roomy ? `<tspan fill="${DIM}"> left${reset ? ` · ↻ ${reset}` : ''}</tspan>` : ''}</text></g>`
    )
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${STRIP_H}" width="${W}" height="${STRIP_H}">
<rect x="0.5" y="0.5" width="${W - 1}" height="${STRIP_H - 1}" rx="12" fill="#1a100c" stroke="${ORANGE}" stroke-opacity="0.22"/>
${reactor}
${limits.length ? `<line x1="${x0 - 18}" y1="14" x2="${x0 - 18}" y2="50" stroke="${DIM}" stroke-opacity="0.25"/>` : ''}
${rows.join('\n')}
</svg>`
}

// The pane's readout under the reactor: a card each for context and the quotas,
// then a forecast row. Drawn at `width` CSS pixels, one unit a pixel.
function statsSvg(r: Reading, p: Projection, s: HudSettings, compacting: boolean, now: number, width: number) {
  const W = Math.round(width)
  const mono = 'font-family="Consolas, Menlo, monospace"'
  const sans = 'font-family="Segoe UI, system-ui, -apple-system, sans-serif"'
  const pct = usedPct(r)
  type Card = { label: string; value: string; caption: string; leftPct: number; color: string; tip: string }
  const cards: Card[] = [
    {
      label: 'CONTEXT',
      value: compacting ? 'Compacting…' : `${fmtK(left(r))} left`,
      caption: `${fmtK(r.tokens ?? 0)} of ${fmtK(r.window)} used`,
      leftPct: 100 - pct,
      color: heat(pct),
      tip: `Auto-compact at ${fmtK(p.target)}`,
    },
    ...r.limits.slice(0, 2).map(l => {
      const reset = l.resetsAt ? span(Date.parse(l.resetsAt) - now) : undefined
      return {
        label: limitName(l.kind) === '5H' ? '5-HOUR' : limitName(l.kind) === '7D' ? 'WEEKLY' : limitName(l.kind),
        value: `${Math.round(100 - l.pct)}% left`,
        caption: reset ? `resets in ${reset}` : `${Math.round(l.pct)}% used`,
        leftPct: 100 - l.pct,
        color: heat(l.pct),
        tip: `${limitLong(l.kind)}: ${Math.round(l.pct)}% used`,
      }
    }),
  ]

  const gap = 10
  const cols = W >= 390 ? cards.length : 1
  const cardW = (W - gap * (cols - 1)) / cols
  const cardH = 84
  const card = (c: Card, i: number) => {
    const x = (i % cols) * (cardW + gap)
    const y = Math.floor(i / cols) * (cardH + gap)
    const barW = cardW - 28
    return (
      `<g><title>${xml(c.tip)}</title>` +
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${(cardW - 1).toFixed(1)}" height="${cardH - 1}" rx="10" fill="#1a100c" stroke="${ORANGE}" stroke-opacity="0.18"/>` +
      `<text x="${x + 14}" y="${y + 22}" ${mono} font-size="10.5" letter-spacing="1.5" fill="${DIM}">${xml(c.label)}</text>` +
      `<text x="${x + 14}" y="${y + 47}" ${sans} font-size="21" font-weight="600" fill="${c.color}">${xml(c.value)}</text>` +
      `<text x="${x + 14}" y="${y + 63}" ${sans} font-size="11.5" fill="${DIM}">${xml(c.caption)}</text>` +
      `<rect x="${x + 14}" y="${y + 70}" width="${barW.toFixed(1)}" height="5" rx="2.5" fill="${c.color}" fill-opacity="0.16"/>` +
      `<rect x="${x + 14}" y="${y + 70}" width="${((barW * Math.max(0, Math.min(100, c.leftPct))) / 100).toFixed(1)}" height="5" rx="2.5" fill="${c.color}"/></g>`
    )
  }
  const cardsH = Math.ceil(cards.length / cols) * (cardH + gap) - gap

  // Forecast: burn rate, turns to compaction, and whether the 5-hour quota holds.
  const fy = cardsH + gap
  const fh = 58
  const cells: [string, string, string][] = [
    ['BURN RATE', p.perTurn !== undefined ? `~${fmtK(p.perTurn)} / turn` : 'calibrating', DIM],
    [
      s.autoCompact ? `TO COMPACT (${s.compactAt}%)` : 'TO AUTO-COMPACT',
      p.turnsLeft !== undefined ? `${p.turnsLeft} turns` : '—',
      p.turnsLeft !== undefined && p.turnsLeft < 4 ? AMBER : '#fff3ec',
    ],
    [
      '5-HOUR QUOTA',
      p.quotaEta === undefined ? 'calibrating' : p.quotaSafe ? 'lasts to reset' : `out ≈ ${clock(p.quotaEta)}`,
      p.quotaEta !== undefined && !p.quotaSafe ? RED : '#fff3ec',
    ],
  ]
  const cw = W / cells.length
  const forecast =
    `<rect x="0.5" y="${fy + 0.5}" width="${W - 1}" height="${fh - 1}" rx="10" fill="#1a100c" stroke="${ORANGE}" stroke-opacity="0.18"/>` +
    cells
      .map(
        ([label, value, color], i) =>
          `<text x="${i * cw + 14}" y="${fy + 22}" ${mono} font-size="10" letter-spacing="1.2" fill="${DIM}">${xml(label)}</text>` +
          `<text x="${i * cw + 14}" y="${fy + 44}" ${sans} font-size="15" font-weight="600" fill="${color === DIM ? '#fff3ec' : color}">${xml(value)}</text>` +
          (i > 0 ? `<line x1="${i * cw}" y1="${fy + 12}" x2="${i * cw}" y2="${fy + fh - 12}" stroke="${DIM}" stroke-opacity="0.25"/>` : ''),
      )
      .join('')

  const H = fy + fh
  return {
    height: H,
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${cards.map(card).join('')}${forecast}</svg>`,
  }
}

const MONO = 'font-family="Consolas, Menlo, monospace"'
const SANS = 'font-family="Segoe UI, system-ui, -apple-system, sans-serif"'
const PANEL = '#1a100c'
const INK = '#fff3ec'

const secs = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : span(ms))

const panel = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x + 0.5}" y="${y + 0.5}" width="${(w - 1).toFixed(1)}" height="${h - 1}" rx="10" fill="${PANEL}" stroke="${ORANGE}" stroke-opacity="0.18"/>`

const heading = (x: number, y: number, label: string, right: string, rightX: number) =>
  `<text x="${x}" y="${y}" ${MONO} font-size="10.5" letter-spacing="1.5" fill="${DIM}">${xml(label)}</text>` +
  (right ? `<text x="${rightX}" y="${y}" text-anchor="end" ${SANS} font-size="11.5" fill="${DIM}">${xml(right)}</text>` : '')

const svgDoc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`

// Context used after each turn, the auto-compact line across it, and a marker
// wherever a compaction freed space.
function timelineSvg(samples: Sample[], compactions: Compaction[], r: Reading, p: Projection, width: number) {
  const W = Math.round(width)
  const H = 172
  const pts = samples.filter(x => x.tokens !== undefined)
  const freed = compactions.reduce((a, c) => a + Math.max(0, (c.before ?? 0) - (c.after ?? 0)), 0)
  const right = compactions.length
    ? `${compactions.length} compaction${compactions.length === 1 ? '' : 's'}${freed ? ` · ${fmtK(freed)} freed` : ''}`
    : `${pts.length} turn${pts.length === 1 ? '' : 's'}`
  let body = panel(0, 0, W, H) + heading(14, 22, 'CONTEXT OVER TIME', right, W - 14)
  if (pts.length < 2) {
    body += `<text x="${W / 2}" y="${H / 2 + 8}" text-anchor="middle" ${SANS} font-size="12.5" fill="${DIM}">Draws after two replies</text>`
    return { height: H, source: svgDoc(W, H, body) }
  }

  const x0 = 46
  const x1 = W - 16
  const y0 = 40
  const y1 = H - 24
  const top = Math.max(p.target, ...pts.map(x => x.tokens ?? 0)) * 1.08
  const X = (i: number) => x0 + (i / (pts.length - 1)) * (x1 - x0)
  const Y = (t: number) => y1 - (t / top) * (y1 - y0)
  const line = pts.map((x, i) => `${X(i).toFixed(1)},${Y(x.tokens ?? 0).toFixed(1)}`).join(' ')
  const c = heat(usedPct(r))

  body +=
    `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${DIM}" stroke-opacity="0.3"/>` +
    `<text x="${x0 - 8}" y="${y1 + 4}" text-anchor="end" ${MONO} font-size="10" fill="${DIM}">0</text>` +
    `<g><title>Auto-compact at ${fmtK(p.target)}</title>` +
    `<line x1="${x0}" y1="${Y(p.target).toFixed(1)}" x2="${x1}" y2="${Y(p.target).toFixed(1)}" stroke="${RED}" stroke-opacity="0.7" stroke-dasharray="4 4"/>` +
    `<text x="${x0 - 8}" y="${(Y(p.target) + 4).toFixed(1)}" text-anchor="end" ${MONO} font-size="10" fill="${RED}">${fmtK(p.target)}</text></g>` +
    `<polygon points="${X(0).toFixed(1)},${y1} ${line} ${X(pts.length - 1).toFixed(1)},${y1}" fill="${c}" fill-opacity="0.12"/>` +
    `<polyline points="${line}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>` +
    `<circle cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(pts.at(-1)!.tokens ?? 0).toFixed(1)}" r="3.5" fill="${c}"/>` +
    `<text x="${x0}" y="${H - 8}" ${MONO} font-size="10" fill="${DIM}">turn 1</text>` +
    `<text x="${x1}" y="${H - 8}" text-anchor="end" ${MONO} font-size="10" fill="${DIM}">now</text>`

  // A compaction sits between the last sample before it and the first after it.
  for (const k of compactions) {
    const i = pts.findIndex(x => x.at >= k.at)
    if (i <= 0) continue
    const x = (X(i - 1) + X(i)) / 2
    const label = k.before !== undefined && k.after !== undefined ? `−${fmtK(k.before - k.after)}` : 'compacted'
    body +=
      `<g><title>${xml(`Compacted (${k.trigger})${k.before !== undefined && k.after !== undefined ? `: ${fmtK(k.before)} → ${fmtK(k.after)}` : ''}`)}</title>` +
      `<line x1="${x.toFixed(1)}" y1="${y0 - 4}" x2="${x.toFixed(1)}" y2="${y1}" stroke="${AMBER}" stroke-opacity="0.8" stroke-dasharray="2 3"/>` +
      `<text x="${(x + 4).toFixed(1)}" y="${y0 + 6}" ${SANS} font-size="10.5" fill="${AMBER}">${label}</text></g>`
  }
  return { height: H, source: svgDoc(W, H, body) }
}

// The 5-hour quota used across its window against an even pace to the reset,
// with where the current rate leads. Undefined when there is no 5-hour quota.
function paceSvg(samples: Sample[], r: Reading, p: Projection, now: number, width: number) {
  const five = r.limits.find(l => l.kind === 'five_hour')
  const reset = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
  if (!five || !Number.isFinite(reset)) return undefined
  const W = Math.round(width)
  const H = 160
  const start = reset - 5 * 60 * 60_000
  const x0 = 46
  const x1 = W - 16
  const y0 = 40
  const y1 = H - 24
  const X = (t: number) => x0 + ((Math.max(start, Math.min(reset, t)) - start) / (reset - start)) * (x1 - x0)
  const Y = (pct: number) => y1 - (Math.max(0, Math.min(100, pct)) / 100) * (y1 - y0)
  const c = heat(five.pct)
  const pts = [
    ...samples.filter(x => x.fiveHour !== undefined && x.at >= start).map(x => ({ at: x.at, pct: x.fiveHour! })),
    { at: now, pct: five.pct },
  ]
  const line = pts.map(x => `${X(x.at).toFixed(1)},${Y(x.pct).toFixed(1)}`).join(' ')
  const evenNow = ((now - start) / (reset - start)) * 100
  const status =
    p.quotaEta !== undefined && !p.quotaSafe
      ? `runs out ≈ ${clock(p.quotaEta)}`
      : five.pct > evenNow + 5
        ? 'ahead of an even pace'
        : 'within an even pace'

  let body =
    panel(0, 0, W, H) +
    heading(14, 22, '5-HOUR QUOTA PACE', `${Math.round(100 - five.pct)}% left · ${status}`, W - 14) +
    `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${DIM}" stroke-opacity="0.3"/>` +
    `<text x="${x0 - 8}" y="${y1 + 4}" text-anchor="end" ${MONO} font-size="10" fill="${DIM}">0%</text>` +
    `<text x="${x0 - 8}" y="${y0 + 4}" text-anchor="end" ${MONO} font-size="10" fill="${DIM}">100%</text>` +
    `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${DIM}" stroke-opacity="0.15"/>` +
    `<g><title>An even pace uses the quota up exactly at the reset</title>` +
    `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y0}" stroke="${DIM}" stroke-opacity="0.6" stroke-dasharray="4 4"/></g>` +
    `<polyline points="${line}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>` +
    `<g><title>${xml(`${Math.round(five.pct)}% used now`)}</title><circle cx="${X(now).toFixed(1)}" cy="${Y(five.pct).toFixed(1)}" r="3.5" fill="${c}"/></g>` +
    `<text x="${x0}" y="${H - 8}" ${MONO} font-size="10" fill="${DIM}">${clock(start)}</text>` +
    `<text x="${x1}" y="${H - 8}" text-anchor="end" ${MONO} font-size="10" fill="${DIM}">resets ${clock(reset)}</text>`
  if (p.quotaEta !== undefined && !p.quotaSafe) {
    body +=
      `<g><title>${xml(`At this pace the quota runs out around ${clock(p.quotaEta)}`)}</title>` +
      `<line x1="${X(now).toFixed(1)}" y1="${Y(five.pct).toFixed(1)}" x2="${X(p.quotaEta).toFixed(1)}" y2="${y0}" stroke="${RED}" stroke-width="1.5" stroke-dasharray="2 3"/>` +
      `<circle cx="${X(p.quotaEta).toFixed(1)}" cy="${y0}" r="3" fill="${RED}"/></g>`
  }
  return { height: H, source: svgDoc(W, H, body) }
}

// Three cards: prompt-cache hit rate with a per-turn sparkline, turn speed, and
// the session at a glance.
function effSvg(turns: TurnStat[], startedAt: number | null, subagents: number, p: Projection, now: number, width: number) {
  const W = Math.round(width)
  const gap = 10
  const cols = W >= 390 ? 3 : 1
  const cardW = (W - gap * (cols - 1)) / cols
  const cardH = 104
  const hit = (t: TurnStat) => {
    const all = t.input + t.cacheRead + t.cacheWrite
    return all > 0 ? t.cacheRead / all : 0
  }
  const totalIn = turns.reduce((a, t) => a + t.input + t.cacheRead + t.cacheWrite, 0)
  const rate = totalIn > 0 ? turns.reduce((a, t) => a + t.cacheRead, 0) / totalIn : undefined
  const timed = turns.filter(t => t.ms > 0)
  const avgMs = timed.length ? timed.reduce((a, t) => a + t.ms, 0) / timed.length : undefined
  const slowest = timed.reduce((a, t) => Math.max(a, t.ms), 0)
  const tps = timed.length ? timed.reduce((a, t) => a + t.output, 0) / (timed.reduce((a, t) => a + t.ms, 0) / 1000) : undefined

  const card = (i: number, label: string, value: string, lines: string[], extra = '', tip = '') => {
    const x = Math.round((i % cols) * (cardW + gap))
    const y = Math.floor(i / cols) * (cardH + gap)
    return (
      `<g>${tip ? `<title>${xml(tip)}</title>` : ''}${panel(x, y, cardW, cardH)}` +
      `<text x="${x + 14}" y="${y + 22}" ${MONO} font-size="10.5" letter-spacing="1.5" fill="${DIM}">${xml(label)}</text>` +
      `<text x="${x + 14}" y="${y + 48}" ${SANS} font-size="21" font-weight="600" fill="${INK}">${xml(value)}</text>` +
      lines.map((l, k) => `<text x="${x + 14}" y="${y + 66 + k * 15}" ${SANS} font-size="11.5" fill="${DIM}">${xml(l)}</text>`).join('') +
      extra.replace(/\{x\}/g, String(x)).replace(/\{y\}/g, String(y)) +
      `</g>`
    )
  }

  // The sparkline sits along the cache card's foot, one bar per recent turn.
  const recent = turns.slice(-30)
  const sw = cardW - 28
  const bw = recent.length ? sw / recent.length : 0
  const spark = recent
    .map((t, k) => {
      const h = Math.max(1.5, hit(t) * 22)
      return `<rect x="${(14 + k * bw).toFixed(1)}" y="${(96 - h).toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${hit(t) < 0.5 ? AMBER : ORANGE}" fill-opacity="0.85"/>`
    })
    .join('')
  const sparkG = recent.length ? `<g transform="translate({x} {y})">${spark}</g>` : ''

  const ageMs = startedAt !== null ? now - startedAt : undefined
  const body =
    card(
      0,
      'CACHE HIT',
      rate !== undefined ? `${Math.round(rate * 100)}%` : '—',
      [rate !== undefined ? 'of input from cache' : 'after the first reply'],
      sparkG,
      'Share of input tokens read from the prompt cache; each bar is one turn',
    ) +
    card(
      1,
      'TURN SPEED',
      avgMs !== undefined ? `${secs(avgMs)} avg` : '—',
      avgMs !== undefined ? [`slowest ${secs(slowest)}`, tps !== undefined ? `~${Math.round(tps)} output tok/s` : ''] : ['after the first reply'],
      '',
      'Wall-clock time per main-loop turn, and output tokens per second across them',
    ) +
    card(
      2,
      'SESSION',
      ageMs !== undefined ? span(ageMs) : `${turns.length} turns`,
      [
        `${turns.length} turn${turns.length === 1 ? '' : 's'}${p.perTurn !== undefined ? ` · ~${fmtK(p.perTurn)}/turn` : ''}`,
        `${subagents} subagent${subagents === 1 ? '' : 's'}`,
      ],
      '',
      'Time since the session began, main-loop turns, context growth per turn, and subagents launched',
    )
  const H = Math.ceil(3 / cols) * (cardH + gap) - gap
  return { height: H, source: svgDoc(W, H, body) }
}

// What filled the context, by tool and by file, from the results the model read.
function boardSvg(tools: Record<string, ToolStat>, files: FileStat[], width: number) {
  const W = Math.round(width)
  const gap = 10
  const two = W >= 420
  const colW = two ? (W - gap) / 2 : W
  const rowH = 24
  const toolRows = Object.entries(tools)
    .sort(([, a], [, z]) => z.tokens - a.tokens)
    .slice(0, 5)
  const fileRows = files.slice(0, 5)
  // Both lists share a height: as tall as the longer one, one row when empty.
  const listH = 36 + Math.max(1, toolRows.length, fileRows.length) * rowH + 8

  const list = (x: number, y: number, label: string, rows: { name: string; tokens: number; note: string; tip: string }[], empty: string) => {
    let s = panel(x, y, colW, listH) + heading(x + 14, y + 22, label, '', 0)
    if (!rows.length) return s + `<text x="${x + 14}" y="${y + 50}" ${SANS} font-size="12" fill="${DIM}">${xml(empty)}</text>`
    const max = Math.max(1, ...rows.map(r0 => r0.tokens))
    const barX = x + 14
    const barW = colW - 28
    rows.forEach((row, i) => {
      const ry = y + 36 + i * rowH
      const name = row.name.length > 24 ? row.name.slice(0, 23) + '…' : row.name
      s +=
        `<g><title>${xml(row.tip)}</title>` +
        `<text x="${barX}" y="${ry + 10}" ${SANS} font-size="12" fill="${INK}">${xml(name)}</text>` +
        `<text x="${x + colW - 14}" y="${ry + 10}" text-anchor="end" ${MONO} font-size="10.5" fill="${DIM}">${xml(row.note)}</text>` +
        `<rect x="${barX}" y="${ry + 14}" width="${barW.toFixed(1)}" height="3" rx="1.5" fill="${ORANGE}" fill-opacity="0.14"/>` +
        `<rect x="${barX}" y="${ry + 14}" width="${Math.max(2, (row.tokens / max) * barW).toFixed(1)}" height="3" rx="1.5" fill="${SLICE_COLORS[i % SLICE_COLORS.length]}"/></g>`
    })
    return s
  }

  const body =
    list(
      0,
      0,
      'TOOLS BY CONTEXT',
      toolRows.map(([name, t]) => ({
        name,
        tokens: t.tokens,
        note: `×${t.calls} · ${fmtK(t.tokens)}`,
        tip: `${name}: ${t.calls} call${t.calls === 1 ? '' : 's'}, ~${fmtK(t.tokens)} tokens of results`,
      })),
      'No tool calls yet',
    ) +
    list(
      two ? colW + gap : 0,
      two ? 0 : listH + gap,
      'FILES BY CONTEXT',
      fileRows.map(f => ({
        name: f.path.split(/[\\/]/).pop() ?? f.path,
        tokens: f.tokens,
        note: `${f.reads > 1 ? `×${f.reads} · ` : ''}~${fmtK(f.tokens)}`,
        tip: `${f.path}: read ${f.reads} time${f.reads === 1 ? '' : 's'}, ~${fmtK(f.tokens)} tokens`,
      })),
      'No files read yet',
    )
  const H = two ? listH : listH * 2 + gap
  return { height: H, source: svgDoc(W, H, body) }
}

const SPARK = '▁▂▃▄▅▆▇█'
const sparkline = (values: number[]) => {
  const max = Math.max(1, ...values)
  return values.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}

// The same stats as the drawn sections, as label/value rows for the terminal.
function textStats(
  turns: TurnStat[],
  tools: Record<string, ToolStat>,
  files: FileStat[],
  compactions: Compaction[],
  startedAt: number | null,
  subagents: number,
  samples: Sample[],
  r: Reading,
  now: number,
): [string, string][] {
  const rows: [string, string][] = []
  const ctx = samples.filter(x => x.tokens !== undefined).slice(-32).map(x => x.tokens ?? 0)
  const freed = compactions.reduce((a, c) => a + Math.max(0, (c.before ?? 0) - (c.after ?? 0)), 0)
  if (ctx.length >= 2 || compactions.length)
    rows.push([
      'CONTEXT',
      `${ctx.length >= 2 ? sparkline(ctx) : ''}${compactions.length ? ` · ${compactions.length} compaction${compactions.length === 1 ? '' : 's'}${freed ? `, ${fmtK(freed)} freed` : ''}` : ''}`,
    ])
  const five = r.limits.find(l => l.kind === 'five_hour')
  const reset = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
  if (five && Number.isFinite(reset)) {
    const even = Math.round(Math.max(0, Math.min(100, ((now - (reset - 5 * 60 * 60_000)) / (5 * 60 * 60_000)) * 100)))
    rows.push(['5H PACE', `${Math.round(five.pct)}% used · even pace is ${even}% by now`])
  }
  const totalIn = turns.reduce((a, t) => a + t.input + t.cacheRead + t.cacheWrite, 0)
  const timed = turns.filter(t => t.ms > 0)
  if (turns.length) {
    const avg = timed.length ? timed.reduce((a, t) => a + t.ms, 0) / timed.length : 0
    const tps = timed.length ? timed.reduce((a, t) => a + t.output, 0) / (timed.reduce((a, t) => a + t.ms, 0) / 1000) : 0
    rows.push(['CACHE', totalIn ? `${Math.round((turns.reduce((a, t) => a + t.cacheRead, 0) / totalIn) * 100)}% of input from cache` : '—'])
    rows.push([
      'TURNS',
      `${turns.length} · avg ${secs(avg)} · slowest ${secs(timed.reduce((a, t) => Math.max(a, t.ms), 0))} · ~${Math.round(tps)} tok/s`,
    ])
  }
  rows.push(['SESSION', `${startedAt !== null ? span(now - startedAt) : '—'} · ${subagents} subagent${subagents === 1 ? '' : 's'}`])
  const topTools = Object.entries(tools)
    .sort(([, a], [, z]) => z.tokens - a.tokens)
    .slice(0, 4)
  if (topTools.length) rows.push(['TOOLS', topTools.map(([n, t]) => `${n} ×${t.calls} ${fmtK(t.tokens)}`).join(' · ')])
  if (files.length) rows.push(['FILES', files.slice(0, 3).map(f => `${f.path.split(/[\\/]/).pop()} ${fmtK(f.tokens)}`).join(' · ')])
  return rows
}

type Wedge = { name: string; tokens: number; color: string }

function wedges(b: Breakdown): Wedge[] {
  return b.slices
    .filter(x => x.kind === 'used' && x.tokens > 0)
    .sort((a, z) => z.tokens - a.tokens)
    .map((x, i) => ({ name: x.name, tokens: x.tokens, color: SLICE_COLORS[i % SLICE_COLORS.length]! }))
}

// A donut of the whole window: each category a wedge, free space the dark rest,
// the auto-compact point a tick on the rim; a legend beside it. Wedges sweep in.
function donutSvg(b: Breakdown, ws: Wedge[]) {
  const cx = 82
  const cy = 92
  const rad = 60
  const len = 2 * Math.PI * rad
  const usedTokens = ws.reduce((a, w) => a + w.tokens, 0)
  let offset = 0
  const arcs = ws
    .map((w, i) => {
      const frac = w.tokens / b.max
      const dash = Math.max(0.5, frac * len - 1.5)
      const arc =
        `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${w.color}" stroke-width="24" ` +
        `stroke-dasharray="0 ${len.toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})">` +
        `<title>${xml(w.name)}: ${fmtK(w.tokens)} tokens (${Math.round(frac * 100)}% of window)</title>` +
        `<animate attributeName="stroke-dasharray" from="0 ${len.toFixed(1)}" to="${dash.toFixed(1)} ${len.toFixed(1)}" ` +
        `begin="${(i * 0.12).toFixed(2)}s" dur="0.7s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1"/>` +
        `</circle>`
      offset += frac * len
      return arc
    })
    .join('')

  const tick =
    b.compactAt !== undefined
      ? (() => {
          const a = (b.compactAt / b.max) * 2 * Math.PI - Math.PI / 2
          const x1 = cx + Math.cos(a) * (rad - 16)
          const y1 = cy + Math.sin(a) * (rad - 16)
          const x2 = cx + Math.cos(a) * (rad + 16)
          const y2 = cy + Math.sin(a) * (rad + 16)
          return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"><title>Auto-compact at ${fmtK(b.compactAt)}</title></line>`
        })()
      : ''

  const rows = ws.slice(0, 7)
  const legend = rows
    .map((w, i) => {
      const y = 30 + i * 22
      const pct = Math.round((w.tokens / Math.max(1, usedTokens)) * 100)
      const barW = Math.max(2, (w.tokens / Math.max(1, ws[0]!.tokens)) * 120)
      return (
        `<g><title>${xml(hintFor(w.name)[1])}</title>` +
        `<rect x="164" y="${y - 9}" width="8" height="8" rx="2" fill="${w.color}"/>` +
        `<text x="178" y="${y - 2}" font-family="Segoe UI, system-ui, sans-serif" font-size="10.5" fill="#f4e6de">${xml(w.name.length > 16 ? w.name.slice(0, 15) + '…' : w.name)}</text>` +
        `<text x="304" y="${y - 2}" text-anchor="end" font-family="Consolas, Menlo, monospace" font-size="10" fill="${DIM}">${fmtK(w.tokens)} · ${pct}%</text>` +
        `<rect x="178" y="${y + 2}" width="126" height="3" rx="1.5" fill="#3a2419"/>` +
        `<rect x="178" y="${y + 2}" width="0" height="3" rx="1.5" fill="${w.color}">` +
        `<animate attributeName="width" from="0" to="${barW.toFixed(1)}" begin="${(i * 0.12).toFixed(2)}s" dur="0.7s" fill="freeze"/></rect>` +
        `</g>`
      )
    })
    .join('')

  const freePct = Math.max(0, Math.round(((b.max - usedTokens) / b.max) * 100))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 316 184" width="316" height="184">
<rect width="316" height="184" rx="16" fill="#1a0f0a"/>
<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="#3a2419" stroke-width="24"/>
${arcs}${tick}
<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="Consolas, Menlo, monospace" font-size="20" font-weight="700" fill="#fff3ec">${fmtK(usedTokens)}</text>
<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="9" letter-spacing="1.5" fill="${DIM}">IN USE · ${freePct}% FREE</text>
${legend}
</svg>`
}

// ── register ─────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('settings')) as Partial<HudSettings> | undefined
    if (saved) await update($, settingsA, () => ({ ...DEFAULTS, ...saved }))

    await $.command.register({
      name: 'jarvis',
      description: 'JARVIS token HUD: status, compact, auto on|off|<pct>, voice on|off, guard on|off, band on|off',
      argumentHint: '[status|compact|auto|voice|guard|band]',
    })
    $.clock.every(30_000, () => void update($, tickA, n => n + 1))

    try {
      const u = await $.session.usage()
      await update($, startedAtA, () => u.startedAt)
      // Kept even before the first response (no tokens yet): the band shows it is online.
      const at = await $.clock.now()
      await update($, readingA, () => ({
        tokens: u.context.tokens,
        window: u.context.window,
        pct: u.context.percent,
        limits: u.rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt })),
        at,
      }))
    } catch {
      // measured on the first response instead
    }
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const reading: Reading = {
      tokens: e.context.tokens,
      window: e.context.window,
      pct: e.context.percent,
      limits: e.rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt })),
      at: await $.clock.now(),
    }
    await update($, readingA, () => reading)
    if (reading.tokens !== undefined) await checkAlerts($, reading)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const r = await read($, readingA)
    if (r) {
      const fiveHour = r.limits.find(l => l.kind === 'five_hour')?.pct
      await update($, samplesA, list => [...list, { at: r.at, tokens: r.tokens, fiveHour }].slice(-120))
    }
    if (e.usage) {
      const u = e.usage
      const turn: TurnStat = {
        at: await $.clock.now(),
        ms: e.durationMs,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      }
      await update($, turnsA, list => [...list, turn].slice(-200))
    }
    $.clock.after(0, () => void refreshBreakdown($))

    const s = await read($, settingsA)
    if (r && s.autoCompact && e.reason === 'answer' && usedPct(r) >= s.compactAt && !(await read($, compactingA))) {
      $.clock.after(300, () => void compactNow($, 'auto'))
    }

    return next(e)
  })

  // Tally what each main-loop tool call put into the context, and each file read.
  on('tool.call', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined || res.deny !== undefined) return res
    const tokens = Math.round((res.text?.length ?? 0) / 4)
    await update($, toolsA, t => {
      const was = t[e.tool] ?? { calls: 0, tokens: 0 }
      return { ...t, [e.tool]: { calls: was.calls + 1, tokens: was.tokens + tokens } }
    })
    if (e.tool === 'Agent') await update($, subagentsA, n => n + 1)
    if (e.tool === 'Read' && res.isError === undefined) {
      const path = e.file_path
      await update($, filesA, list => {
        const was = list.find(f => f.path === path)
        const rest = list.filter(f => f.path !== path)
        const file: FileStat = { path, tokens: (was?.tokens ?? 0) + tokens, reads: (was?.reads ?? 0) + 1 }
        return [...rest, file].sort((a, z) => z.tokens - a.tokens).slice(0, 50)
      })
    }
    return res
  })

  // Every compaction of the main conversation, whoever started it.
  on('session.compact', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && res.skip === undefined) {
      const c: Compaction = { at: await $.clock.now(), before: res.tokensBefore, after: res.tokensAfter, trigger: e.trigger }
      await update($, compactionsA, list => [...list, c].slice(-50))
    }
    return res
  })

  // Read guard: warn before a file read that would eat a big slice of what is left.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const s = await read($, settingsA)
    const r = await read($, readingA)
    if (s.readGuard && r && e.limit === undefined && !/\.(png|jpe?g|gif|webp|pdf|ipynb)$/i.test(e.file_path)) {
      try {
        const st = await $.fs.stat(e.file_path)
        const est = Math.min(25_000, Math.round(st.size / 4))
        const reserve = left(r)
        if (st.kind === 'file' && est > 8_000 && est > reserve * 0.08) {
          const name = e.file_path.split(/[\\/]/).pop() ?? e.file_path
          await say($, `Incoming: ~${fmtK(est)} tokens from ${name}, ${Math.round((est / reserve) * 100)}% of reserves.`, 'warn')
        }
      } catch {
        // a path that does not stat is the tool's problem, not ours
      }
    }

    return next(e)
  })

  on('command.run', { command: 'jarvis' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const flag = arg === 'on' ? true : arg === 'off' ? false : undefined

    switch (verb) {
      case '':
      case 'hud':
        await $.ui.open({ id: PANE, title: TITLE })
        return { text: 'HUD online.' }
      case 'status':
        return { text: await briefing($) }
      case 'compact':
        return { text: await compactNow($, 'manual') }
      case 'auto': {
        const at = Number(arg)
        if (Number.isFinite(at) && at >= 30 && at <= 98) {
          await setSetting($, { autoCompact: true, compactAt: Math.round(at) })
          return { text: `Auto-compact armed at ${Math.round(at)}%.` }
        }
        if (flag === undefined) return { text: 'Usage: /jarvis auto on|off|<30-98>' }
        await setSetting($, { autoCompact: flag })
        return { text: `Auto-compact ${flag ? 'armed' : 'disarmed'}.` }
      }
      case 'voice':
        if (flag === undefined) return { text: 'Usage: /jarvis voice on|off' }
        await setSetting($, { voice: flag })
        if (flag) void $.audio.speak('Voice systems online.').catch(() => $.ui.toast('◢ No speech synthesizer available here.'))
        return { text: `Voice ${flag ? 'online' : 'offline'}.` }
      case 'guard':
        if (flag === undefined) return { text: 'Usage: /jarvis guard on|off' }
        await setSetting($, { readGuard: flag })
        return { text: `Read guard ${flag ? 'on' : 'off'}.` }
      case 'band':
        if (flag === undefined) return { text: 'Usage: /jarvis band on|off' }
        await update($, bandHiddenA, () => !flag)
        return { text: `Band ${flag ? 'shown' : 'hidden'}.` }
      default:
        return { text: 'Commands: /jarvis [hud|status|compact|auto on|off|<pct>|voice on|off|guard on|off|band on|off]' }
    }
  })

  // ── band above the prompt ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, bandHiddenA))) return next(e)
    const r = await read($, readingA)
    await read($, tickA)
    const compacting = await read($, compactingA)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    if (!r || r.tokens === undefined) {
      return (
        <Box flexDirection="row" flexWrap="nowrap" columnGap={1} alignItems="center">
          <Button key="hud" label="◢" plain onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
          <Text wrap="truncate-end">
            <Text color={ORANGE} bold>
              JARVIS online
            </Text>
            <Text color={DIM}>{r ? ` · ${fmtK(r.window)} context window · gauges light up after the first reply` : ' · awaiting telemetry'}</Text>
          </Text>
        </Box>
      )
    }
    const pct = usedPct(r)

    // Surfaces that draw vectors get the reactor strip; the terminal keeps the text row.
    if (Svg) {
      const s = await read($, settingsA)
      const now = await $.clock.now()
      const p = project(r, await read($, samplesA), s, await read($, breakdownA), now)
      // Size the frame ourselves: a cell is about 7.5 px on the desktop, and an
      // unsized interactive frame falls back to a default box and shrinks the drawing.
      const width = Math.max(420, Math.min(1200, (e.props.bodyColumns - 3) * 7.5))
      return (
        <Box flexDirection="row" flexWrap="nowrap" columnGap={1} alignItems="center">
          <Button key="hud" label="◢" plain onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
          <Svg
            key="strip"
            source={stripSvg(r, p, s, compacting, now, width)}
            alt={`Context ${pct}% used, ${fmtK(left(r))} tokens left`}
            width={Math.round(width)}
            height={STRIP_H}
            isInteractive
          />
        </Box>
      )
    }

    // One row, always: try the richest layout that fits the band's width, then
    // shed detail (bar length, reset timers, the weekly quota) until it does.
    type Run = { text: string; color?: string }
    type Seg = Run[]
    const layout = (cells: number, limitCells: number, resets: boolean, week: boolean): Seg[] => {
      const segs: Seg[] = [
        [
          { text: 'CTX ', color: DIM },
          { text: bar(1 - pct / 100, cells), color: heat(pct) },
          { text: ` ${compacting ? 'COMPACTING' : fmtK(left(r))}`, color: heat(pct) },
        ],
      ]
      for (const l of r.limits) {
        if (l.kind === 'seven_day' && !week) continue
        const seg: Seg = [{ text: `${limitName(l.kind)} `, color: DIM }]
        if (limitCells > 0) seg.push({ text: `${bar(1 - l.pct / 100, limitCells)} `, color: heat(l.pct) })
        seg.push({ text: `${Math.round(100 - l.pct)}%`, color: heat(l.pct) })
        if (resets && l.resetsAt) seg.push({ text: ` ↻${span(Date.parse(l.resetsAt) - r.at)}`, color: DIM })
        segs.push(seg)
      }
      return segs
    }
    const width = (segs: Seg[]) => segs.reduce((n, seg) => n + seg.reduce((m, run) => m + run.text.length, 0), 0) + (segs.length - 1) * 3
    const room = e.props.bodyColumns - 3 // the ◢ button and its gap
    const tries: Parameters<typeof layout>[] = [
      [10, 5, true, true],
      [8, 4, true, true],
      [8, 0, true, true],
      [6, 0, false, true],
      [6, 0, false, false],
      [5, 0, false, false],
    ]
    const segs = tries.map(t => layout(...t)).find(x => width(x) <= room) ?? layout(4, 0, false, false)

    return (
      <Box flexDirection="row" flexWrap="nowrap" columnGap={1} alignItems="center">
        <Button key="hud" label="◢" plain onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
        <Text wrap="truncate-end">
          {segs.map((seg, i) => (
            <Text>
              {i > 0 ? <Text color={DIM}> · </Text> : null}
              {seg.map(run => (
                <Text color={run.color}>{run.text}</Text>
              ))}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })

  // ── the HUD pane ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const r = await read($, readingA)
    const s = await read($, settingsA)
    const b = await read($, breakdownA)
    const log = await read($, logA)
    const compacting = await read($, compactingA)
    const bandHidden = await read($, bandHiddenA)
    await read($, tickA)
    const now = await $.clock.now()

    const header = (
      <Box flexDirection="column">
        <Text color={ORANGE} bold>
          ◢ J.A.R.V.I.S. // TOKEN TELEMETRY
        </Text>
        <Text color={DIM}>
          {r ? `last reading ${clock(r.at)}` : 'awaiting first reading'}
        </Text>
      </Box>
    )

    if (!r || r.tokens === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text color={DIM}>Telemetry comes online after the first response. Send a prompt.</Text>
        </Box>
      )
    }

    const pct = usedPct(r)
    const p = project(r, await read($, samplesA), s, b, now)
    const ws = b ? wedges(b) : []
    // Every frame is sized here: an unsized interactive frame falls back to a
    // 150 px box and shrinks the drawing inside it. A cell is about 7.5 px.
    const paneW = Math.max(300, Math.min(720, (e.props.bodyColumns - 2) * 7.5))
    const donutW = Math.min(440, paneW)
    const stats = Svg ? statsSvg(r, p, s, compacting, now, paneW) : undefined
    const samples = await read($, samplesA)
    const turns = await read($, turnsA)
    const tools = await read($, toolsA)
    const files = await read($, filesA)
    const compactions = await read($, compactionsA)
    const startedAt = await read($, startedAtA)
    const subagents = await read($, subagentsA)
    const timeline = Svg ? timelineSvg(samples, compactions, r, p, paneW) : undefined
    const pace = Svg ? paceSvg(samples, r, p, now, paneW) : undefined
    const eff = Svg ? effSvg(turns, startedAt, subagents, p, now, paneW) : undefined
    const board = Svg ? boardSvg(tools, files, paneW) : undefined
    const section = (key: string, alt: string, d: { height: number; source: string } | undefined) =>
      Svg && d ? <Svg key={key} source={d.source} alt={alt} width={Math.round(paneW)} height={d.height} isInteractive /> : null

    return (
      <Box flexDirection="column" gap={1}>
        {header}

        {Svg ? null : (
          <Text color={heat(pct)}>
            CTX {bar(1 - pct / 100, 20)} {fmtK(left(r))} left
          </Text>
        )}

        {Svg && stats ? (
          <Svg
            key="stats"
            source={stats.source}
            alt={`Context ${fmtK(left(r))} left; ${r.limits.map(l => `${limitLong(l.kind)} ${Math.round(100 - l.pct)}% left`).join('; ')}`}
            width={Math.round(paneW)}
            height={stats.height}
            isInteractive
          />
        ) : null}

        {section('timeline', 'Context used after each turn, with compactions marked', timeline)}
        {section('pace', '5-hour quota used against an even pace to its reset', pace)}
        {section('efficiency', 'Cache hit rate, turn speed and session summary', eff)}

        {Svg ? null : (
          <Box flexDirection="column">
            <Text color={ORANGE} bold>
              ▸ SESSION
            </Text>
            {(() => {
              const t = textStats(turns, tools, files, compactions, startedAt, subagents, samples, r, now)
              return t.map(([label, value]) => (
                <Text>
                  <Text color={DIM}>{label.padEnd(10)}</Text>
                  <Text>{value}</Text>
                </Text>
              ))
            })()}
          </Box>
        )}

        {Svg ? null : <Box flexDirection="column">
          <Text>
            <Text color={DIM}>CONTEXT   </Text>
            <Text color={heat(pct)}>
              {fmtK(r.tokens)} / {fmtK(r.window)} · {pct}%
            </Text>
          </Text>
          {r.limits.map(l => (
            <Text>
              <Text color={DIM}>{limitName(l.kind).padEnd(10)}</Text>
              <Text color={heat(l.pct)}>{bar(1 - l.pct / 100, 10)} {Math.round(100 - l.pct)}% left</Text>
              {l.resetsAt ? <Text color={DIM}> · resets {span(Date.parse(l.resetsAt) - now)}</Text> : null}
            </Text>
          ))}
        </Box>}

        {Svg ? null : <Box flexDirection="column">
          <Text color={ORANGE} bold>
            ▸ PROJECTIONS
          </Text>
          <Text color={p.turnsLeft !== undefined && p.turnsLeft < 4 ? AMBER : undefined}>
            {p.turnsLeft !== undefined
              ? `~${fmtK(p.perTurn ?? 0)}/turn · ${p.turnsLeft} turns to ${s.autoCompact ? `compact (${s.compactAt}%)` : 'auto-compact'}`
              : 'Burn rate: calibrating (needs a few turns)'}
          </Text>
          {p.quotaEta !== undefined ? (
            <Text color={p.quotaSafe ? undefined : RED}>
              {p.quotaSafe ? '5H quota resets before you hit it' : `5H quota exhausted ≈ ${clock(p.quotaEta)}`}
            </Text>
          ) : null}
        </Box>}

        {ws.length > 0 && b ? (
          <Box flexDirection="column" gap={1}>
            <Text color={ORANGE} bold>
              ▸ WHERE IT WENT
            </Text>
            {Svg ? (
              <Svg
                key="donut"
                source={donutSvg(b, ws)}
                alt="Context window by category"
                width={Math.round(donutW)}
                height={Math.round((donutW * 184) / 316)}
                isInteractive
              />
            ) : (
              <Box flexDirection="column">
                {ws.slice(0, 6).map(w => (
                  <Text>
                    <Text color={w.color}>{'█'.repeat(Math.max(1, Math.round((w.tokens / ws[0]!.tokens) * 14))).padEnd(14, ' ')}</Text>
                    <Text> {w.name.padEnd(16).slice(0, 16)}</Text>
                    <Text color={DIM}> {fmtK(w.tokens)}</Text>
                  </Text>
                ))}
              </Box>
            )}
            {(() => {
              const top = ws[0]!
              const share = Math.round((top.tokens / ws.reduce((a, w) => a + w.tokens, 0)) * 100)
              const [, what, fix] = hintFor(top.name)
              return (
                <Box flexDirection="column">
                  <Text>
                    <Text color={top.color} bold>
                      {top.name}
                    </Text>
                    <Text> is {share}% of what's in use</Text>
                    <Text color={DIM}> ({what.toLowerCase()})</Text>
                  </Text>
                  {fix ? <Text color={DIM}>↳ {fix}</Text> : null}
                </Box>
              )
            })()}
          </Box>
        ) : null}

        {section('board', 'Tools and files ranked by the context their results took', board)}

        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="compact" label={compacting ? 'Compacting…' : 'Compact now'} variant="primary" hotkey="c" onPress={() => void compactNow($, 'manual')} />
          <Button
            key="auto"
            label={`Auto-compact ${s.autoCompact ? `${s.compactAt}%` : 'off'}`}
            hotkey="a"
            onPress={() => setSetting($, { autoCompact: !s.autoCompact })}
          />
          <Button key="guard" label={`Read guard ${s.readGuard ? 'on' : 'off'}`} hotkey="g" onPress={() => setSetting($, { readGuard: !s.readGuard })} />
          <Button key="voice" label={`Voice ${s.voice ? 'on' : 'off'}`} hotkey="v" onPress={() => setSetting($, { voice: !s.voice })} />
          <Button key="band" label={bandHidden ? 'Show band' : 'Hide band'} hotkey="b" onPress={() => update($, bandHiddenA, h => !h)} />
          <Button key="refresh" label="Rescan" hotkey="r" onPress={() => refreshBreakdown($)} />
        </Box>

        <Box flexDirection="column">
          <Text color={ORANGE} bold>
            ▸ LOG
          </Text>
          {log.length === 0 ? <Text color={DIM}>All systems nominal.</Text> : null}
          {log
            .slice(-8)
            .reverse()
            .map(l => (
              <Text>
                <Text color={DIM}>{clock(l.at)} </Text>
                <Text color={l.level === 'crit' ? RED : l.level === 'warn' ? AMBER : l.level === 'act' ? ORANGE : undefined}>
                  {l.text}
                </Text>
              </Text>
            ))}
        </Box>
      </Box>
    )
  })
}
