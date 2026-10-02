import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { Item, ItemKind, Source } from '../types'

const PANE = 'figure-ledger'
const SCAN_MS = 60000
const MAX_ITEMS = 300
const MAX_TRACED_PER_SCAN = 20
const SCRIPT_WINDOW = 40

const items = atom({ plugin: 'figure-ledger', key: 'items' } as const, [] as Item[])
const since = atom({ plugin: 'figure-ledger', key: 'since' } as const, 0)
const now = atom({ plugin: 'figure-ledger', key: 'now' } as const, 0)

const EXT: Record<ItemKind, string[]> = {
  figure: ['png', 'svg', 'pdf', 'jpg', 'jpeg', 'eps', 'tif', 'tiff', 'gif'],
  structure: ['pdb', 'psf', 'gro', 'cif', 'mol2', 'crd', 'xyz', 'dcd', 'xtc', 'trr', 'top', 'itp', 'tpr'],
  table: ['csv', 'tsv', 'npy', 'npz', 'pkl', 'pickle', 'h5', 'hdf5', 'parquet', 'feather', 'jld2', 'xvg', 'dat', 'xlsx'],
}
const SOURCE_EXT = ['ipynb', 'py', 'jl', 'R', 'r', 'm', 'gp', 'sh', 'tcl']
const PRUNE = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.ipynb_checkpoints', '.julia', '.cache']
const DATA_REF = /["']([^"'\n]{1,200}\.(?:csv|tsv|npy|npz|pkl|pickle|h5|hdf5|parquet|feather|json|jld2|xvg|dat|txt|xlsx|pdb|psf|dcd|xtc|gro))["']/gi
const LABEL: Record<ItemKind, string> = { figure: 'Figures', structure: 'Structures', table: 'Tables & data' }

function kindOf(path: string): ItemKind | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return (Object.keys(EXT) as ItemKind[]).find(k => EXT[k].includes(ext))
}

function base(path: string): string {
  return path.split('/').pop() ?? path
}

function rel(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} ago`
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `…${text.slice(text.length - Math.max(1, width - 1))}`
}

function dataRefs(code: string, self: string): string[] {
  const found = new Set<string>()
  for (const m of code.matchAll(DATA_REF)) {
    if (base(m[1]) !== base(self)) found.add(m[1])
  }
  return [...found].slice(0, 3)
}

function cellText(cell: any): string {
  return Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source ?? '')
}

function findCell(nb: any, needles: string[]): { cell: number; execCount?: number; code: string } | undefined {
  const cells: any[] = Array.isArray(nb?.cells) ? nb.cells : []
  for (let i = cells.length - 1; i >= 0; i--) {
    const code = cellText(cells[i])
    if (cells[i]?.cell_type === 'code' && needles.some(n => code.includes(n))) {
      return { cell: i + 1, execCount: cells[i].execution_count ?? undefined, code }
    }
  }
  return undefined
}

function needlesFor(path: string): string[] {
  const name = base(path)
  const stem = name.replace(/\.[^.]+$/, '')
  return stem.length >= 4 && stem !== name ? [name, stem] : [name]
}

async function readNotebook($: $, file: string): Promise<any> {
  const text = await $.fs.read(file).catch(() => undefined)
  if (typeof text === 'string') return JSON.parse(text)
  // Over 4 MiB (embedded outputs): let python strip the outputs first.
  const out = await $.process.run(
    ['python3', '-c', 'import json,sys;nb=json.load(open(sys.argv[1]));[c.pop("outputs",None) for c in nb.get("cells",[])];print(json.dumps(nb))', file],
    { timeoutMs: 15000 },
  )
  return out.exitCode === 0 ? JSON.parse(out.stdout) : undefined
}

async function traceSource($: $, cwd: string, path: string): Promise<{ source?: Source; data?: string[] }> {
  const needles = needlesFor(path)
  const argv = ['grep', '-rlF', ...SOURCE_EXT.map(x => `--include=*.${x}`), ...PRUNE.map(d => `--exclude-dir=${d}`)]
  for (const n of needles) argv.push('-e', n)
  argv.push(cwd)
  const hit = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => undefined)
  const files = (hit?.stdout ?? '').split('\n').filter(Boolean)
  if (files.length === 0) return {}
  const stamped = await Promise.all(
    files.slice(0, 20).map(async f => ({ f, t: (await $.fs.stat(f).catch(() => undefined))?.mtimeMs ?? 0 })),
  )
  const ranked = stamped.sort((a, b) => Number(b.f.endsWith('.ipynb')) - Number(a.f.endsWith('.ipynb')) || b.t - a.t)
  for (const { f } of ranked) {
    if (f.endsWith('.ipynb')) {
      const nb = await readNotebook($, f).catch(() => undefined)
      const found = nb && findCell(nb, needles)
      if (found) {
        return {
          source: { file: rel(f, cwd), cell: found.cell, execCount: found.execCount },
          data: dataRefs(found.code, path),
        }
      }
      continue
    }
    const text = await $.fs.read(f).catch(() => undefined)
    if (typeof text !== 'string') continue
    const lines = text.split('\n')
    const at = lines.findIndex(l => needles.some(n => l.includes(n)))
    if (at < 0) continue
    const window = lines.slice(Math.max(0, at - SCRIPT_WINDOW), at + 5).join('\n')
    return { source: { file: rel(f, cwd), line: at + 1 }, data: dataRefs(window, path) }
  }
  return {}
}

async function record($: $, cwd: string, path: string, at: number, isNew: boolean, via?: string, isTraced = true) {
  const kind = kindOf(path)
  if (!kind) return
  const shown = rel(path, cwd)
  const list = await read($, items)
  const old = list.find(i => i.path === shown)
  if (old && old.lastAt >= at) return
  const entry: Item = old
    ? { ...old, lastAt: at, writes: old.writes + 1, via: via ?? old.via }
    : { path: shown, kind, firstAt: at, lastAt: at, writes: 1, isNew, via }
  await update($, items, l => [...l.filter(i => i.path !== shown), entry].slice(-MAX_ITEMS))
  if (kind === 'figure' && isTraced) {
    const traced = await traceSource($, cwd, path).catch(() => ({}))
    await update($, items, l => l.map(i => (i.path === shown ? { ...i, ...traced } : i)))
  }
}

async function scan($: $, via?: string) {
  const cwd = await $.session.cwd()
  const from = await read($, since)
  const started = await $.clock.now()
  const names = Object.values(EXT).flat()
  const argv = ['find', cwd, '-maxdepth', '6', '(']
  PRUNE.forEach((d, i) => argv.push(...(i ? ['-o'] : []), '-name', d))
  argv.push(')', '-prune', '-o', '-type', 'f', '-newermt', `@${Math.floor(from / 1000)}`, '(')
  names.forEach((x, i) => argv.push(...(i ? ['-o'] : []), '-iname', `*.${x}`))
  argv.push(')', '-printf', '%T@\t%B@\t%p\n')
  const out = await $.process.run(argv, { timeoutMs: 20000 }).catch(() => undefined)
  await update($, since, () => started)
  const rows = (out?.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => l.split('\t'))
    .filter(r => r.length === 3)
  let traced = 0
  for (const [mtime, birth, path] of rows) {
    const at = Math.round(Number(mtime) * 1000)
    const born = Number(birth) * 1000
    const isNew = born > 0 ? born >= from - 1000 : true
    const isTraced = kindOf(path) !== 'figure' || ++traced <= MAX_TRACED_PER_SCAN
    await record($, cwd, path, at, isNew, via, isTraced).catch(() => undefined)
  }
  await update($, now, () => started)
}

async function clearAll($: $) {
  await update($, items, () => [])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'figure-ledger',
      description: 'Show figures, structures and data written this session (close, clear)',
    })
    if ((await read($, since)) === 0) {
      const t = await $.clock.now()
      await update($, since, () => t)
    }
    $.clock.every(SCAN_MS, () => void scan($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'figure-ledger' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close' || arg === 'hide') {
      await $.ui.close({ id: PANE })
      return { text: 'figure-ledger: closed (still recording; /figure-ledger reopens it).' }
    }
    if (arg === 'clear') {
      await clearAll($)
      return { text: 'figure-ledger: cleared.' }
    }
    await scan($)
    await $.ui.open({ id: PANE, title: 'Figures' })
    const list = await read($, items)
    const n = (k: ItemKind) => list.filter(i => i.kind === k).length
    return { text: `figure-ledger: ${n('figure')} figures, ${n('structure')} structures, ${n('table')} data files this session` }
  })

  on('tool.call', async ($, e, next) => {
    const ran: any = await next(e)
    if (!ran || ran.deny !== undefined || ran.isError) return ran
    const input: any = e
    if (e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'NotebookEdit') {
      const path: string = input.file_path ?? input.notebook_path ?? ''
      if (kindOf(path)) {
        const cwd = await $.session.cwd()
        const t = await $.clock.now()
        await record($, cwd, path, t, e.tool === 'Write', e.tool).catch(() => undefined)
      }
    } else if (e.tool === 'Bash' && !ran.result?.backgroundTaskId) {
      await scan($, String(input.description || input.command || 'Bash')).catch(() => undefined)
    }
    return ran
  })

  on('session.receive', async ($, e, next) => {
    if (e.text.includes('<task-notification>')) await scan($, 'background job').catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, items)
    const t = Math.max(await read($, now), ...list.map(i => i.lastAt))
    const width = Math.max(24, (e.props as any).bodyColumns ?? 60)
    const groups = (Object.keys(LABEL) as ItemKind[]).map(k => ({
      kind: k,
      rows: list.filter(i => i.kind === k).sort((a, b) => b.lastAt - a.lastAt),
    }))

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>Nothing written yet this session.</Text>}
        {groups
          .filter(g => g.rows.length > 0)
          .map(g => (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>{`${LABEL[g.kind]} (${g.rows.length})`}</Text>
              {g.rows.slice(0, g.kind === 'figure' ? 30 : 12).map(i => {
                const mark = i.isNew && i.writes === 1 ? '●' : '↻'
                const when = ` ${ago(t - i.lastAt)}${i.writes > 1 ? ` ×${i.writes}` : ''}`
                const src = i.source
                const where = src
                  ? src.cell !== undefined
                    ? `${src.file} · cell ${src.cell}${src.execCount ? ` [${src.execCount}]` : ''}`
                    : `${src.file}:${src.line} (script, no notebook cell)`
                  : undefined
                return (
                  <Box flexDirection="column">
                    <Box flexDirection="row" justifyContent="space-between">
                      <Text color={mark === '●' ? 'green' : 'cyan'} wrap="truncate-start">
                        {`${mark} ${clip(i.path, width - when.length - 3)}`}
                      </Text>
                      <Text dimColor>{when}</Text>
                    </Box>
                    {g.kind === 'figure' && where && (
                      <Text dimColor wrap="truncate-start">{`  ↳ ${clip(where, width - 4)}`}</Text>
                    )}
                    {g.kind === 'figure' && !where && (
                      <Text color="yellow" wrap="truncate-end">{`  ⚠ no notebook cell${i.via ? ` — via ${i.via}` : ''}`}</Text>
                    )}
                    {g.kind === 'figure' && (i.data?.length ?? 0) > 0 && (
                      <Text dimColor wrap="truncate-start">{`  ↳ data: ${clip(i.data!.join(', '), width - 12)}`}</Text>
                    )}
                  </Box>
                )
              })}
            </Box>
          ))}
        <Text dimColor>● new  ↻ rewritten · /figure-ledger scan</Text>
      </Box>
    )
  })
}
