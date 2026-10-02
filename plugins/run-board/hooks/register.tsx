import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { Run, RunKind, RunStatus } from '../types'

const PANE = 'run-board'
const TICK_MS = 5000
const MAX_RUNS = 100
const TAIL_BYTES = '4000'

const runs = atom({ plugin: 'run-board', key: 'runs' } as const, [] as Run[])
const now = atom({ plugin: 'run-board', key: 'now' } as const, 0)

const GLYPH: Record<RunStatus, string> = { running: '⟳', done: '✓', failed: '✗', killed: '■' }
const COLOR: Record<RunStatus, string | undefined> = {
  running: 'yellow',
  done: 'green',
  failed: 'red',
  killed: 'gray',
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

function tag(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1].trim() : undefined
}

function lastLine(text: string): string | undefined {
  const lines = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
  return lines.at(-1)
}

function counts(list: Run[]): string {
  const n = (s: RunStatus) => list.filter(r => r.status === s).length
  const parts = [`${n('running')} running`, `${n('done')} done`]
  if (n('failed') > 0) parts.push(`${n('failed')} failed`)
  if (n('killed') > 0) parts.push(`${n('killed')} stopped`)
  return parts.join(' · ')
}

async function started($: $, run: Run) {
  const list = await read($, runs)
  const isFirst = list.length === 0
  await update($, runs, l => [...l.filter(r => r.id !== run.id), run].slice(-MAX_RUNS))
  await update($, now, () => run.startedAt)
  await refreshStatus($)
  if (isFirst) void $.ui.open({ id: PANE, title: 'Runs' })
}

async function finished($: $, id: string, status: RunStatus, summary?: string) {
  const list = await read($, runs)
  const run = list.find(r => r.id === id)
  if (!run || run.status !== 'running') return
  const endedAt = await $.clock.now()
  const code = summary?.match(/exit code (-?\d+)/i)
  const exitCode = code ? Number(code[1]) : undefined
  const final: RunStatus = status === 'done' && exitCode !== undefined && exitCode !== 0 ? 'failed' : status
  await update($, runs, l =>
    l.map(r => (r.id === id ? { ...r, status: final, endedAt, exitCode, last: r.last ?? summary } : r)),
  )
  await refreshStatus($)
  const took = elapsed(endedAt - run.startedAt)
  const why = final === 'failed' ? (exitCode !== undefined ? ` — exit ${exitCode}` : ' — failed') : ''
  $.ui.toast(`${GLYPH[final]} ${clip(run.label, 50)} (${took})${why}`, {
    timeoutMs: final === 'failed' ? 10000 : 5000,
  })
}

async function refreshStatus($: $) {
  const list = await read($, runs)
  const running = list.filter(r => r.status === 'running').length
  const failed = list.filter(r => r.status === 'failed').length
  if (running === 0 && failed === 0) return $.ui.status(undefined)
  const bits = [running > 0 ? `⟳ ${running} running` : '', failed > 0 ? `✗ ${failed} failed` : '']
  $.ui.status(bits.filter(Boolean).join(' · '))
}

async function onNotification($: $, text: string) {
  if (!text.includes('<task-notification>')) return
  for (const block of text.split('</task-notification>')) {
    const id = tag(block, 'task-id')
    if (!id) continue
    const raw = tag(block, 'status')
    const summary = tag(block, 'summary')
    const event = tag(block, 'event')
    if (event && !raw) {
      const line = lastLine(event)
      if (line) await update($, runs, l => l.map(r => (r.id === id ? { ...r, last: line } : r)))
      continue
    }
    const status: RunStatus | undefined =
      raw === 'completed' ? 'done' : raw === 'failed' ? 'failed' : raw === 'killed' ? 'killed' : undefined
    if (status) await finished($, id, status, summary)
  }
}

async function tick($: $) {
  const list = await read($, runs)
  const live = list.filter(r => r.status === 'running')
  if (live.length === 0) return
  for (const run of live) {
    if (!run.outputFile) continue
    const out = await $.process
      .run(['tail', '-c', TAIL_BYTES, run.outputFile], { timeoutMs: 5000 })
      .catch(() => undefined)
    const line = out?.exitCode === 0 ? lastLine(out.stdout) : undefined
    if (line && line !== run.last) {
      await update($, runs, l => l.map(r => (r.id === run.id ? { ...r, last: line } : r)))
    }
  }
  { const t = await $.clock.now(); await update($, now, () => t) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'run-board',
      description: 'Show background shells, monitors and subagents in a pane (clear: drop finished rows)',
    })
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    void refreshStatus($)
    return next(e)
  })

  on('command.run', { command: 'run-board' }, async ($, e) => {
    if (String((e as any).args ?? '').trim() === 'clear') {
      await update($, runs, l => l.filter(r => r.status === 'running'))
      await refreshStatus($)
      return { text: 'run-board: finished rows cleared.' }
    }
    await $.ui.open({ id: PANE, title: 'Runs' })
    return { text: `run-board: ${counts(await read($, runs))}` }
  })

  on('tool.call', async ($, e, next) => {
    const ran: any = await next(e)
    if (!ran || ran.deny !== undefined || ran.isError) return ran
    const t0 = await $.clock.now()
    const text: string = ran.text ?? ''
    const fileFromText = text.match(/(?:written to|Output file|output_file)[:\s]+(\S+)/i)?.[1]
    const input: any = e
    let run: Run | undefined
    let kind: RunKind | undefined
    if (e.tool === 'Bash' && ran.result?.backgroundTaskId) {
      kind = 'shell'
      run = {
        id: ran.result.backgroundTaskId,
        kind,
        label: input.description || input.command,
        startedAt: t0,
        status: 'running',
        outputFile: fileFromText,
      }
    } else if (e.tool === 'Monitor' && ran.result?.taskId) {
      run = {
        id: ran.result.taskId,
        kind: 'monitor',
        label: input.description || input.command || 'monitor',
        startedAt: t0,
        status: 'running',
        outputFile: fileFromText,
      }
    } else if (e.tool === 'Agent' && ran.result?.status === 'async_launched') {
      run = {
        id: ran.result.agentId,
        kind: 'agent',
        label: ran.result.description || input.description || 'subagent',
        startedAt: t0,
        status: 'running',
        outputFile: ran.result.outputFile,
      }
    } else if (e.tool === 'TaskStop') {
      const id = input.task_id ?? input.shell_id ?? input.id
      if (id) await finished($, String(id), 'killed')
    }
    if (run) await started($, run)
    return ran
  })

  // Task completions reach the conversation as a <task-notification> row.
  // Both events are watched; finished() ignores a run already closed.
  on('session.receive', async ($, e, next) => {
    await onNotification($, e.text).catch(() => undefined)
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const content: any = e.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n')
        : ''
    if (!e.agentId) await onNotification($, text).catch(() => undefined)
    return stored
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const t = Math.max(await read($, now), ...list.map(r => r.endedAt ?? r.startedAt))
    const width = Math.max(20, (e.props as any).bodyColumns ?? 60)
    const order = [...list].sort((a, b) => {
      const rank = (r: Run) => (r.status === 'running' ? 0 : r.status === 'failed' ? 1 : 2)
      return rank(a) - rank(b) || b.startedAt - a.startedAt
    })
    const room = Math.max(2, Math.floor(((e.viewport?.rows ?? 30) - 3) / 2))

    return (
      <Box flexDirection="column">
        <Text bold>{counts(list)}</Text>
        {list.length === 0 && <Text dimColor>No background jobs yet.</Text>}
        {order.slice(0, room).map(r => {
          const time = elapsed((r.endedAt ?? t) - r.startedAt)
          const code = r.status === 'failed' && r.exitCode !== undefined ? ` exit ${r.exitCode}` : ''
          const right = ` ${r.kind}${code} ${time}`
          const head = `${GLYPH[r.status]} ${clip(r.label, Math.max(8, width - right.length - 2))}`
          return (
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text color={COLOR[r.status]} bold={r.status === 'failed'} wrap="truncate-end">
                  {head}
                </Text>
                <Text dimColor>{right}</Text>
              </Box>
              {r.last && (
                <Text dimColor color={r.status === 'failed' ? 'red' : undefined} wrap="truncate-end">
                  {`  └ ${clip(r.last, width - 4)}`}
                </Text>
              )}
            </Box>
          )
        })}
        {order.length > room && <Text dimColor>{`… ${order.length - room} more`}</Text>}
      </Box>
    )
  })
}
