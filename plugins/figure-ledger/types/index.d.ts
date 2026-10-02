export type ItemKind = 'figure' | 'structure' | 'table'

export type Source = {
  file: string
  cell?: number
  execCount?: number
  line?: number
}

export type Item = {
  path: string
  kind: ItemKind
  firstAt: number
  lastAt: number
  writes: number
  isNew: boolean
  via?: string
  source?: Source
  data?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'figure-ledger': { items: Item[]; since: number; now: number }
  }
}
