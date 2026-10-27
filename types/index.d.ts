export type Limit = { kind: string; pct: number; resetsAt?: string }

export type Reading = {
  tokens?: number
  window: number
  pct?: number
  limits: Limit[]
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

export type LogLine = { at: number; text: string; level: 'info' | 'warn' | 'crit' | 'act' }

// One main-loop turn: how long it took and what its requests cost in tokens.
export type TurnStat = { at: number; ms: number; input: number; output: number; cacheRead: number; cacheWrite: number }

// What a tool's results put into the context, estimated at 4 characters a token.
export type ToolStat = { calls: number; tokens: number }

export type FileStat = { path: string; tokens: number; reads: number }

export type Compaction = { at: number; before?: number; after?: number; trigger: string }

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
      turns: TurnStat[]
      tools: Record<string, ToolStat>
      files: FileStat[]
      compactions: Compaction[]
      startedAt: number | null
      subagents: number
    }
  }
}
