export type Limit = { kind: string; pct: number; resetsAt?: string }

export type Reading = {
  tokens?: number
  window: number
  pct?: number
  limits: Limit[]
  usd?: number
  at: number
}

export type Sample = { at: number; tokens?: number; fiveHour?: number }

export type Slice = {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type Breakdown = { slices: Slice[]; max: number; compactAt?: number }

export type HudSettings = {
  autoCompact: boolean
  compactAt: number
  voice: boolean
  readGuard: boolean
}

// `rate` is units of `code` per US dollar.
export type Fx = { code: string; rate: number; source: 'live' | 'manual' | 'default'; at?: number }

export type LogLine = { at: number; text: string; level: 'info' | 'warn' | 'crit' | 'act' }

declare module 'claude-code' {
  interface PluginState {
    'jarvis-hud': {
      reading: Reading | null
      samples: Sample[]
      breakdown: Breakdown | null
      settings: HudSettings
      log: LogLine[]
      alerted: string[]
      tick: number
      bandHidden: boolean
      compacting: boolean
      fx: Fx
    }
  }
}
