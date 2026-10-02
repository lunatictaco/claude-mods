import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { TreeLine, TreeView } from '../types'

const PANE = 'tree'
const DEFAULT_DEPTH = 3
const MAX_DEPTH = 12
const MAX_CHILDREN = 40
const MAX_LINES = 600
const REFRESH_GAP_MS = 2000
const PRUNE = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.ipynb_checkpoints', '.cache', '.mypy_cache', '.pytest_cache']

const view = atom({ plugin: 'project-tree', key: 'view' } as const, null as TreeView | null)
const isOpen = atom({ plugin: 'project-tree', key: 'isOpen' } as const, false)

// Module state: the depth asked for and when the tree was last built.
const opts = { depth: DEFAULT_DEPTH, lastBuild: 0 }

type Node = { dirs: Map<string, Node>; files: string[]; count: number }

const newNode = (): Node => ({ dirs: new Map(), files: [], count: 0 })

function insert(root: Node, path: string) {
  const parts = path.split('/').filter(Boolean)
  let node = root
  node.count++
  for (const dir of parts.slice(0, -1)) {
    if (!node.dirs.has(dir)) node.dirs.set(dir, newNode())
    node = node.dirs.get(dir)!
    node.count++
  }
  if (parts.length > 0) node.files.push(parts[parts.length - 1])
}

// Git porcelain → marker per path, and a marker per directory holding changes.
function changeMarks(porcelain: string): Map<string, string> {
  const marks = new Map<string, string>()
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const path = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '').replace(/\/$/, '')
    const mark = code === '??' ? '+' : code.includes('D') ? '-' : code.includes('A') ? '+' : 'M'
    marks.set(path, mark)
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!marks.has(dir)) marks.set(dir, '•')
    }
  }
  return marks
}

function walk(node: Node, path: string, prefix: string, depth: number, maxDepth: number,
              marks: Map<string, string>, out: TreeLine[]) {
  const dirs = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))
  const files = [...node.files].sort((a, b) => a.localeCompare(b))
  const entries: Array<{ name: string; isDir: boolean }> = [
    ...dirs.map(name => ({ name, isDir: true })),
    ...files.map(name => ({ name, isDir: false })),
  ]
  const shown = entries.slice(0, MAX_CHILDREN)
  shown.forEach((entry, i) => {
    if (out.length >= MAX_LINES) return
    const isLast = i === shown.length - 1 && entries.length <= MAX_CHILDREN
    const full = path ? `${path}/${entry.name}` : entry.name
    const branch = isLast ? '└── ' : '├── '
    if (!entry.isDir) {
      out.push({ prefix: prefix + branch, name: entry.name, isDir: false, mark: marks.get(full) })
      return
    }
    const child = node.dirs.get(entry.name)!
    const isCollapsed = depth + 1 >= maxDepth
    out.push({
      prefix: prefix + branch,
      name: `${entry.name}/`,
      isDir: true,
      mark: marks.get(full),
      note: isCollapsed ? `${child.count} file${child.count === 1 ? "" : "s"}` : undefined,
    })
    if (!isCollapsed) walk(child, full, prefix + (isLast ? '    ' : '│   '), depth + 1, maxDepth, marks, out)
  })
  if (entries.length > MAX_CHILDREN && out.length < MAX_LINES) {
    out.push({ prefix: `${prefix}└── `, name: '', isDir: false, note: `… ${entries.length - MAX_CHILDREN} more` })
  }
}

async function listFiles($: $, cwd: string): Promise<{ paths: string[]; source: 'git' | 'find' }> {
  const git = await $.process
    .run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeoutMs: 20000 })
    .catch(() => undefined)
  if (git && git.exitCode === 0) return { paths: git.stdout.split('\n').filter(Boolean), source: 'git' }
  const argv = ['find', '.', '-maxdepth', String(MAX_DEPTH), '(']
  PRUNE.forEach((d, i) => argv.push(...(i ? ['-o'] : []), '-name', d))
  argv.push(')', '-prune', '-o', '-type', 'f', '-printf', '%P\n')
  const found = await $.process.run(argv, { cwd, timeoutMs: 20000 }).catch(() => undefined)
  return { paths: (found?.stdout ?? '').split('\n').filter(Boolean), source: 'find' }
}

async function build($: $) {
  const cwd = await $.session.cwd()
  const { paths, source } = await listFiles($, cwd)
  const status = source === 'git'
    ? await $.process.run(['git', 'status', '--porcelain', '-uall'], { cwd, timeoutMs: 20000 }).catch(() => undefined)
    : undefined
  const marks = changeMarks(status?.exitCode === 0 ? status.stdout : '')
  const root = newNode()
  paths.forEach(p => insert(root, p))
  const lines: TreeLine[] = []
  walk(root, '', '', 0, opts.depth, marks, lines)
  const countDirs = (n: Node): number => [...n.dirs.values()].reduce((s, c) => s + 1 + countDirs(c), 0)
  const builtAt = await $.clock.now()
  opts.lastBuild = builtAt
  const changed = [...marks.values()].filter(m => m !== '•').length
  await update($, view, () => ({
    root: cwd, depth: opts.depth, lines, files: paths.length, dirs: countDirs(root), changed, source, builtAt,
  }))
}

async function refreshIfOpen($: $) {
  if (!(await read($, isOpen))) return
  if ((await $.clock.now()) - opts.lastBuild < REFRESH_GAP_MS) return
  await build($)
}

function summary(v: TreeView | null): string {
  if (!v) return 'no tree yet'
  const changes = v.changed > 0 ? ` · ${v.changed} changed` : ''
  return `${v.files} files in ${v.dirs} folders${changes} · depth ${v.depth}`
}

const MARK_COLOR: Record<string, string> = { M: 'yellow', '+': 'green', '-': 'red', '•': 'yellow' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tree',
      description: 'Show the project directory tree in the side panel (/tree [depth] · /tree all · /tree close)',
      argumentHint: '[depth|all|close]',
    })
    return next(e)
  })

  on('command.run', { command: 'tree' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close' || arg === 'hide') {
      await update($, isOpen, () => false)
      await $.ui.close({ id: PANE })
      return { text: 'tree: closed.' }
    }
    if (arg === 'all') opts.depth = MAX_DEPTH
    else if (/^\d+$/.test(arg)) opts.depth = Math.min(MAX_DEPTH, Math.max(1, Number(arg)))
    else if (arg !== '') return { text: `tree: unknown argument "${arg}" — use /tree, /tree <depth>, /tree all or /tree close.` }
    await build($)
    await update($, isOpen, () => true)
    const opened = await $.ui.open({ id: PANE, title: 'Tree' })
    const where = opened.isPlaced ? '' : ' (panel waiting for room)'
    return { text: `tree: ${summary(await read($, view))}${where}.` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)
    return next(e)
  })

  // Rebuild after anything that may have changed files: edits and shell commands.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (['Write', 'Edit', 'NotebookEdit', 'Bash'].includes(e.tool)) await refreshIfOpen($).catch(() => undefined)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const width = Math.max(20, e.props.bodyColumns)
    if (!v) return <Text dimColor>Building tree…</Text>
    const rootName = v.root.split('/').filter(Boolean).pop() ?? v.root
    return (
      <Box flexDirection="column">
        <Text bold color="cyan" wrap="truncate-end">{`${rootName}/`}</Text>
        <Text dimColor wrap="truncate-end">{summary(v)}</Text>
        {v.lines.map(l => (
          <Box flexDirection="row">
            <Text dimColor>{l.prefix}</Text>
            <Text bold={l.isDir} color={l.isDir ? 'blue' : undefined} wrap="truncate-end">{l.name}</Text>
            {l.note && <Text dimColor wrap="truncate-end">{l.name ? ` (${l.note})` : l.note}</Text>}
            {l.mark && <Text color={MARK_COLOR[l.mark]}>{` ${l.mark}`}</Text>}
          </Box>
        ))}
        {v.lines.length >= MAX_LINES && <Text dimColor>{`… cut at ${MAX_LINES} lines — try /tree ${Math.max(1, v.depth - 1)}`}</Text>}
        <Text dimColor wrap="truncate-end">{width > 40 ? 'M modified · + new · - deleted · • holds changes' : 'M mod · + new · - del'}</Text>
      </Box>
    )
  })
}
