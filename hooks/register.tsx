import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Breakdown, HudSettings, Limit, LogLine, Reading, Sample } from '../types'

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

// ── SVG: arc reactor & breakdown strip ───────────────────────────────────

function reactorSvg(r: Reading, compacting: boolean) {
  const pct = usedPct(r)
  const c = heat(pct)
  const frac = left(r) / r.window
  const lit = Math.round(frac * 60)
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const on = i < lit
    return `<rect x="147" y="12" width="6" height="20" rx="1.5" fill="${c}" opacity="${on ? 1 : 0.12}" transform="rotate(${i * 6} 150 150)"/>`
  }).join('')

  const ring = (l: Limit | undefined, radius: number, width: number) => {
    if (!l) return ''
    const len = 2 * Math.PI * radius
    const f = Math.max(0, Math.min(1, (100 - l.pct) / 100))
    const col = heat(l.pct)
    return (
      `<circle cx="150" cy="150" r="${radius}" fill="none" stroke="${col}" stroke-opacity="0.14" stroke-width="${width}"/>` +
      `<circle cx="150" cy="150" r="${radius}" fill="none" stroke="${col}" stroke-width="${width}" stroke-linecap="round" ` +
      `stroke-dasharray="${(len * f).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 150 150)"/>`
    )
  }

  const five = r.limits.find(l => l.kind === 'five_hour')
  const week = r.limits.find(l => l.kind === 'seven_day')
  const spin = compacting ? 4 : 30
  const pulse =
    pct >= 85 || compacting
      ? `<animate attributeName="opacity" values="0.2;0.65;0.2" dur="${compacting ? 0.8 : 1.4}s" repeatCount="indefinite"/>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
<defs>
  <radialGradient id="bg" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="#2e1810"/><stop offset="65%" stop-color="#150b07"/><stop offset="100%" stop-color="#080403"/></radialGradient>
  <radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ffffff"/><stop offset="30%" stop-color="${c}"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient>
  <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="300" height="300" rx="20" fill="url(#bg)"/>
<g stroke="${ORANGE}" stroke-opacity="0.08">${Array.from({ length: 11 }, (_, i) => `<line x1="${i * 30}" y1="0" x2="${i * 30}" y2="300"/><line x1="0" y1="${i * 30}" x2="300" y2="${i * 30}"/>`).join('')}</g>
<g filter="url(#glow)">${ticks}</g>
<circle cx="150" cy="150" r="117" fill="none" stroke="${ORANGE}" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="2 7">
  <animateTransform attributeName="transform" type="rotate" from="0 150 150" to="360 150 150" dur="${spin}s" repeatCount="indefinite"/>
</circle>
<g filter="url(#glow)">${ring(five, 104, 6)}${ring(week, 92, 4)}</g>
<circle cx="150" cy="150" r="78" fill="none" stroke="${c}" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="22 12">
  <animateTransform attributeName="transform" type="rotate" from="360 150 150" to="0 150 150" dur="${spin * 0.6}s" repeatCount="indefinite"/>
</circle>
<circle cx="150" cy="150" r="66" fill="#140a06" stroke="${c}" stroke-opacity="0.8" stroke-width="1.5"/>
<circle cx="150" cy="150" r="64" fill="url(#core)" opacity="0.25">${pulse}</circle>
<text x="150" y="146" text-anchor="middle" font-family="Consolas, Menlo, monospace" font-size="34" font-weight="700" fill="#fff3ec" filter="url(#glow)">${fmtK(left(r))}</text>
<text x="150" y="166" text-anchor="middle" font-family="Consolas, Menlo, monospace" font-size="9.5" letter-spacing="3" fill="${c}">${compacting ? 'COMPACTING' : 'TOKENS LEFT'}</text>
<text x="150" y="184" text-anchor="middle" font-family="Consolas, Menlo, monospace" font-size="11" fill="#d8b4a3">${pct}% USED</text>
<text x="18" y="286" font-family="Consolas, Menlo, monospace" font-size="9" letter-spacing="1.5" fill="${DIM}">CTX ${fmtK(r.window)}</text>
<text x="282" y="286" text-anchor="end" font-family="Consolas, Menlo, monospace" font-size="9" letter-spacing="1.5" fill="${DIM}">${five ? `5H ${Math.round(100 - five.pct)}%` : ''}${week ? ` · 7D ${Math.round(100 - week.pct)}%` : ''}</text>
</svg>`
}

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
      await update($, samplesA, list => [...list, { at: r.at, tokens: r.tokens, fiveHour }].slice(-60))
    }
    $.clock.after(0, () => void refreshBreakdown($))

    const s = await read($, settingsA)
    if (r && s.autoCompact && e.reason === 'answer' && usedPct(r) >= s.compactAt && !(await read($, compactingA))) {
      $.clock.after(300, () => void compactNow($, 'auto'))
    }

    return next(e)
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
    const Svg = 'Svg' in table ? table.Svg : undefined
    const r = await read($, readingA)
    const s = await read($, settingsA)
    const b = await read($, breakdownA)
    const log = await read($, logA)
    const compacting = await read($, compactingA)
    const bandHidden = await read($, bandHiddenA)
    await read($, tickA)
    const now = await $.clock.now()
    const narrow = e.props.bodyColumns < 44

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

    return (
      <Box flexDirection="column" gap={1}>
        {header}

        {Svg ? (
          <Box alignItems="center">
            <Svg
              source={reactorSvg(r, compacting)}
              alt={`Context ${pct}% used, ${fmtK(left(r))} tokens left`}
              width={narrow ? 220 : 280}
              isInteractive
            />
          </Box>
        ) : (
          <Text color={heat(pct)}>
            CTX {bar(1 - pct / 100, 20)} {fmtK(left(r))} left
          </Text>
        )}

        <Box flexDirection="column">
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
        </Box>

        <Box flexDirection="column">
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
        </Box>

        {ws.length > 0 && b ? (
          <Box flexDirection="column" gap={1}>
            <Text color={ORANGE} bold>
              ▸ WHERE IT WENT
            </Text>
            {Svg ? (
              <Svg source={donutSvg(b, ws)} alt="Context window by category" width={narrow ? 240 : 316} isInteractive />
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
