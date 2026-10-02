import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { Mood } from '../types'

// The chain: 25 residues whose native state is a 5 × 5 spiral, the last
// nine (the spiral's centre) hydrophobic, so folding buries them in a core.
const N = 25
const TARGET = 20
const FRAME_MS = 120
const NATIVE_HOLD_MS = 20000
const MISFOLD_MS = 3000
const W = 50
const H = 10
const ROWS = H / 2
const KEY = 'protein'
const DEFAULT = 0x01000000
const BOND = 0x5c6370
const POLAR = 0x4fb3d9
const CORE = 0xf0a040
const NATIVE = 0x7ee787
const MISFOLD = 0xff5555

const steps = atom({ plugin: 'protein-pet', key: 'steps' } as const, 0)
const folded = atom({ plugin: 'protein-pet', key: 'folded' } as const, 0)
const mood = atom({ plugin: 'protein-pet', key: 'mood' } as const, 'folding' as Mood)
const isHidden = atom({ plugin: 'protein-pet', key: 'isHidden' } as const, false)

// Module-level animation state: a hot reload just restarts the wiggle.
const anim = { frame: 0, shown: 0, requestId: '', isWorking: false, seen: new Set<string>() }

function spiral(): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let [x0, y0, x1, y1] = [0, 0, 4, 4]
  while (out.length < N) {
    for (let y = y1; y >= y0 && out.length < N; y--) out.push([x0, y])
    for (let x = x0 + 1; x <= x1 && out.length < N; x++) out.push([x, y0])
    for (let y = y0 + 1; y <= y1 && out.length < N; y++) out.push([x1, y])
    for (let x = x1 - 1; x > x0 && out.length < N; x--) out.push([x, y1])
    x0++; y0++; x1--; y1--
  }
  return out
}

const NATIVE_XY = spiral().map(([bx, by]) => [20 + bx * 2, 1 + by * 2] as const)
const OPEN_XY = Array.from({ length: N }, (_, i) => [i * 2, 5] as const)
const isCore = (i: number) => i >= N - 9

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

// Residue i's own progress: the core nucleates first, the termini zip in last.
function residueP(p: number, i: number): number {
  const lag = ((N - 1 - i) / (N - 1)) * 0.5
  return ease(Math.min(1, Math.max(0, (p * 1.5 - lag) / 1)))
}

function positions(p: number, frame: number, m: Mood): Array<[number, number]> {
  const speed = anim.isWorking ? 0.9 : 0.45
  return OPEN_XY.map(([ox, oy], i) => {
    const t = residueP(p, i)
    const [nx, ny] = NATIVE_XY[i]
    const amp = m === 'misfold' ? 2 : (1 - t) * 1.6 + (t === 1 ? 0 : 0.2)
    const dy = Math.sin(frame * speed + i * 0.8) * amp
    const dx = m === 'misfold' ? Math.sin(frame * 1.7 + i) : 0
    return [Math.round(ox + (nx - ox) * t + dx), Math.round(oy + (ny - oy) * t + dy)]
  })
}

function plot(px: Uint32Array, x: number, y: number, c: number) {
  if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = c
}

function line(px: Uint32Array, a: [number, number], b: [number, number], c: number) {
  let [x0, y0] = a
  const [x1, y1] = b
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    plot(px, x0, y0, c)
    if (x0 === x1 && y0 === y1) return
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x0 += sx }
    if (e2 <= dx) { err += dx; y0 += sy }
  }
}

function frameCells(p: number, frame: number, m: Mood): string {
  const px = new Uint32Array(W * H)
  const at = positions(p, frame, m)
  for (let i = 1; i < N; i++) line(px, at[i - 1], at[i], BOND)
  const glow = m === 'native' && Math.floor(frame / 4) % 2 === 0
  at.forEach(([x, y], i) => {
    const c = m === 'misfold' ? MISFOLD : glow ? NATIVE : isCore(i) ? CORE : POLAR
    plot(px, x, y, c)
  })
  const words = new Uint32Array(W * ROWS * 3)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < W; c++) {
      const top = px[2 * r * W + c], bottom = px[(2 * r + 1) * W + c]
      const k = (r * W + c) * 3
      if (top && bottom) words.set([0x2580, top, bottom], k)
      else if (top) words.set([0x2580, top, DEFAULT], k)
      else if (bottom) words.set([0x2584, bottom, DEFAULT], k)
      else words.set([0x20, DEFAULT, DEFAULT], k)
    }
  }
  return (new Uint8Array(words.buffer) as any).toBase64()
}

async function tick($: $) {
  anim.frame++
  const target = Math.min(1, (await read($, steps)) / TARGET)
  anim.shown += (target - anim.shown) * 0.08
  if (!anim.requestId) return
  const m = await read($, mood)
  const p = m === 'native' ? 1 : anim.shown
  const res = await $.ui.blit({ requestId: anim.requestId, key: KEY, cells: frameCells(p, anim.frame, m) })
  if ('deny' in res && res.deny) anim.requestId = ''
}

async function nudge($: $, delta: number) {
  if ((await read($, mood)) === 'native') return
  const next = Math.max(0, (await read($, steps)) + delta)
  await update($, steps, () => Math.min(TARGET, next))
  if (delta < 0) {
    await update($, mood, () => 'misfold' as Mood)
    $.clock.after(MISFOLD_MS, () => void settle($))
  }
  if (next >= TARGET) await reachNative($)
}

async function settle($: $) {
  if ((await read($, mood)) === 'misfold') await update($, mood, () => 'folding' as Mood)
}

async function reachNative($: $) {
  await update($, mood, () => 'native' as Mood)
  const total = Number((await $.store.get('folded')) ?? 0) + 1
  await $.store.set('folded', total)
  await update($, folded, () => total)
  $.ui.toast(`🧬 native state reached — protein #${total} folded`)
  $.clock.after(NATIVE_HOLD_MS, () => void newChain($))
}

async function newChain($: $) {
  await update($, steps, () => 0)
  await update($, mood, () => 'folding' as Mood)
  anim.shown = 0
}

async function onNotification($: $, text: string) {
  if (!text.includes('<task-notification>')) return
  for (const block of text.split('</task-notification>')) {
    const id = block.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
    const status = block.match(/<status>([^<]+)<\/status>/)?.[1]
    if (!id || !status || anim.seen.has(id)) continue
    anim.seen.add(id)
    const isFail = status === 'failed' || /exit code [1-9]/i.test(block)
    await nudge($, isFail ? -3 : status === 'completed' ? 3 : 0)
  }
}

// Scripted replay: one step every 0.8 s, a misfold at step 9, native at the end.
async function demo($: $) {
  await newChain($)
  const plan = [1, 1, 1, 1, 1, 1, 1, 1, 1, -3, 1, 1, 1, 1, 3, 1, 1, 3, 1, 1, 3]
  plan.forEach((delta, i) => {
    $.clock.after(800 * (i + 1) + (i >= 10 ? 2500 : 0), () => void nudge($, delta).catch(() => undefined))
  })
}

function bar(p: number): string {
  const n = Math.round(p * 10)
  return '▰'.repeat(n) + '▱'.repeat(10 - n)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'protein',
      description: 'The folding protein above the prompt (demo, hide, show, reset)',
    })
    const total = Number((await $.store.get('folded')) ?? 0)
    await update($, folded, () => total)
    $.clock.every(FRAME_MS, () => void tick($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'protein' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
      return { text: `protein: ${arg === 'hide' ? 'hidden' : 'shown'}.` }
    }
    if (arg === 'demo') {
      await demo($)
      return { text: 'protein: demo running — watch above the prompt (~20 s).' }
    }
    if (arg === 'reset') {
      await newChain($)
      return { text: 'protein: new unfolded chain.' }
    }
    const s = await read($, steps)
    return { text: `protein: ${Math.round((s / TARGET) * 100)}% folded, ${await read($, folded)} folded in total.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran: any = await next(e)
    if (e.tool === 'Bash' && ran && ran.deny === undefined && !ran.result?.backgroundTaskId) {
      await nudge($, ran.isError ? -1 : 1).catch(() => undefined)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.reason === 'answer') await nudge($, 1).catch(() => undefined)
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    await onNotification($, e.text).catch(() => undefined)
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const content: any = e.message?.content
    const text = Array.isArray(content)
      ? content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n')
      : typeof content === 'string' ? content : ''
    if (!e.agentId) await onNotification($, text).catch(() => undefined)
    return stored
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const s = await read($, steps)
    const m = await read($, mood)
    const total = await read($, folded)
    const p = m === 'native' ? 1 : s / TARGET
    anim.isWorking = e.props.isWorking
    const label = m === 'native'
      ? '✨ native state!'
      : m === 'misfold' ? '✗ misfold!' : `folding ${bar(p)} ${Math.round(p * 100)}%`
    const color = m === 'native' ? 'green' : m === 'misfold' ? 'red' : 'cyan'
    const sub = `${total} folded · ${anim.isWorking ? 'working…' : 'waiting'}`

    if (e.surface !== 'terminal' || e.props.bodyColumns < W + 24 || e.props.maxRows < ROWS) {
      const { Text } = $.ui.resolve(e)
      return <Text color={color}>{`🧬 ${label} · ${sub}`}</Text>
    }
    const { Box, Text, Raster } = $.ui.resolve(e)
    anim.requestId = e.requestId
    return (
      <Box flexDirection="row">
        <Raster key={KEY} columns={W} rows={ROWS} cells={frameCells(m === 'native' ? 1 : anim.shown, anim.frame, m)} />
        <Box flexDirection="column" justifyContent="center" marginLeft={2}>
          <Text color={color} bold>{label}</Text>
          <Text dimColor>{sub}</Text>
        </Box>
      </Box>
    )
  })
}
