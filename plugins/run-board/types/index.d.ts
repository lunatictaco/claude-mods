export type RunKind = 'shell' | 'monitor' | 'agent'
export type RunStatus = 'running' | 'done' | 'failed' | 'killed'

export type Run = {
  id: string
  kind: RunKind
  label: string
  startedAt: number
  endedAt?: number
  status: RunStatus
  exitCode?: number
  outputFile?: string
  last?: string
}

declare module 'claude-code' {
  interface PluginState {
    'run-board': { runs: Run[]; now: number }
  }
}
