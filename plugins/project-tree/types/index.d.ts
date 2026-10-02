export type TreeLine = {
  prefix: string
  name: string
  isDir: boolean
  mark?: string
  note?: string
}

export type TreeView = {
  root: string
  depth: number
  lines: TreeLine[]
  files: number
  dirs: number
  changed: number
  source: 'git' | 'find'
  builtAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'project-tree': { view: TreeView | null; isOpen: boolean }
  }
}
