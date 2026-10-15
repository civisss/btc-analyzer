import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  Activity, Bot, BrainCircuit, Blocks, Flame, GitCompareArrows, Layers, Orbit, Shapes, Target, Telescope, LineChart, Gauge,
  Radar, Network, Coins, CircleDollarSign, Waves, Sparkles, Zap, ArrowLeftRight, BadgeCheck, Bell, BellRing, CalendarClock,
  CalendarDays, CalendarRange, Clock, ImageUp, NotebookPen, Pickaxe, RefreshCcw, Route, Scale, ScanLine, ScanSearch, Sigma,
  SquareDashed, Thermometer, TrendingUp, Users, MoonStar, Anchor, Hourglass, type LucideProps,
  Grid3x3,
} from 'lucide-react'
import { useAgentMessages, useAgents } from '../api/client'
import { live, useLive } from '../api/live'
import type { Agent, AgentEdge, AgentId, AgentMessage } from '../api/types'
import { clsx } from '../components/ui'
import { int } from '../lib/format'
import { dateLocale, t, tr } from '../i18n'

// ------------------------------------------------------------------ icons (kept for backward compatibility)
const ICONS: Record<string, ComponentType<LucideProps>> = {
  Activity, Bot, BrainCircuit, Blocks, Flame, GitCompareArrows, Layers, Orbit, Shapes, Target, Telescope, LineChart, Gauge, Radar,
  Network, Coins, CircleDollarSign, Waves, Sparkles, Zap, ArrowLeftRight, BadgeCheck, Bell, BellRing, CalendarClock, CalendarDays,
  CalendarRange, Clock, ImageUp, NotebookPen, Pickaxe, RefreshCcw, Route, Scale, ScanLine, ScanSearch, Sigma, SquareDashed,
  Thermometer, TrendingUp, Users, MoonStar, Anchor, Hourglass,
  Grid3x3,
}
export function AgentIcon({ name, ...p }: { name: string } & LucideProps) {
  const I = ICONS[name] ?? Bot
  return <I {...p} />
}

// ------------------------------------------------------------------ palette (same sober system as the rest of the app)
export const FONT_UI = '"Inter Variable", Inter, system-ui, sans-serif'
export const MONO = FONT_UI
export const PAL = {
  node: '#161C28', border: 'rgba(255,255,255,0.08)', wire: '#3A4458', wireIdle: '#2A3140',
  text: '#E6E9EF', text2: '#B3BCD0', muted: '#8B94A7', disabled: '#5B6475',
  active: '#5B8DEF', idle: '#5B6475', down: '#EF5466', amber: '#E8B04B', teal: '#3CC6B0',
}
/** @deprecated legacy alias */
export const HUD = { cyan: PAL.active, cyanDim: PAL.active, orange: PAL.active, red: PAL.down, wire: PAL.wire, panel: PAL.node, panelHi: PAL.node, border: PAL.border, text: PAL.text, muted: PAL.muted }
/** Italian source labels: wrap with t() at the use site. */
export const STATUS_LABEL = { idle: 'In attesa', running: 'In esecuzione', error: 'Errore' } as const
export const statusLabel = (s: Agent['status']) => (s === 'idle' ? tr('In attesa', 'Idle') : t(STATUS_LABEL[s]))
export const statusColor = (s: Agent['status']) => (s === 'error' ? PAL.down : s === 'running' ? PAL.active : PAL.idle)

// ------------------------------------------------------------------ ids
const PREFIX: Record<string, string> = {
  market: 'MKT', levels: 'LVL', liquidity: 'LIQ', patterns: 'PAT', correlation: 'COR', cycles: 'CYC', onchain: 'ONC',
  derivatives: 'DER', forecast: 'FCT', analyst: 'ANL', flows: 'FLW', analogs: 'ANA', timepivots: 'TPV',
  macro: 'MAC', clock: 'CLK', miners: 'MIN', leverage: 'LEV', usdt_analogs: 'UAN', stablecoins: 'STB',
}
/** Generic 3-letter prefix for unknown agent ids: consonant skeleton of the id (e.g. "sentiment" -> "SNT"). */
export function agentPrefix(id: string) {
  if (PREFIX[id]) return PREFIX[id]
  const clean = id.replace(/[^a-z0-9]/gi, '').toUpperCase()
  const cons = clean[0] + clean.slice(1).replace(/[AEIOU]/g, '')
  return (cons.length >= 3 ? cons : clean).slice(0, 3).padEnd(3, 'X')
}
/** Stable technical codes like `LIQ-04` derived from the agent order. */
export function useAgentCodes(agents: Agent[] | undefined) {
  return useMemo(() => {
    const m = new Map<string, string>()
    ;(agents ?? []).forEach((a, i) => m.set(a.id, `${agentPrefix(a.id)}-${String(i + 1).padStart(2, '0')}`))
    m.set('*', 'BCAST')
    return m
  }, [agents])
}
export const hexId = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
export const clock = (t: number) => new Date(t * 1000).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
export function fmtMs(ms: number | null | undefined) {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
export function fmtAgo(s: number | null | undefined) {
  if (s == null || !Number.isFinite(s)) return '—'
  s = Math.max(0, Math.round(s))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

// ------------------------------------------------------------------ merged live data
/** Agents (REST) merged with live agent_status updates. */
export function useAgentsLive() {
  const q = useAgents()
  const status = useLive((s) => s.agentStatus)
  const agents = useMemo<Agent[] | undefined>(() => q.data?.agents.map((a) => {
    const st = status[a.id]
    return st ? { ...a, status: st.status, last_run: st.last_run ?? a.last_run, next_run: st.next_run ?? a.next_run, last_duration_ms: st.last_duration_ms ?? a.last_duration_ms } : a
  }), [q.data, status])
  return { q, agents, edges: q.data?.edges ?? [] }
}

/** REST history + live WS messages, newest first, deduped by id. */
export function useAgentFeed(limit = 150) {
  const q = useAgentMessages(limit)
  const liveMsgs = useLive((s) => s.agentMessages)
  const messages = useMemo(() => {
    const seen = new Set<number>()
    const out: AgentMessage[] = []
    for (const m of [...liveMsgs, ...(q.data ?? [])]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
    return out.sort((a, b) => b.time - a.time || b.id - a.id).slice(0, 300)
  }, [liveMsgs, q.data])
  return { q, messages }
}

/** Most recent alert, looking at the whole server history (GET /api/agents/messages, max 600) plus live WS messages. */
export function useLastAlert() {
  const q = useAgentMessages(600)
  const liveMsgs = useLive((s) => s.agentMessages)
  return useMemo(() => {
    let best: AgentMessage | undefined
    for (const m of liveMsgs) if (m.kind === 'alert' && (!best || m.time > best.time)) best = m
    for (const m of q.data ?? []) if (m.kind === 'alert' && (!best || m.time > best.time)) best = m
    return { alert: best, loading: q.isPending }
  }, [liveMsgs, q.data, q.isPending])
}

export function recipientsOf(m: AgentMessage, agents: Agent[]): AgentId[] {
  if (m.to !== '*') return [m.to]
  const subs = agents.filter((a) => a.id !== m.from && (a.subscribes.some((s) => s === '*' || s === m.topic || ((s.endsWith('.') || s.endsWith('*')) && m.topic.startsWith(s.replace(/\*$/, ''))))))
  const ids = subs.map((a) => a.id)
  if (!ids.length && m.from !== 'analyst') ids.push('analyst')
  return ids
}

// ------------------------------------------------------------------ topology layout (radial: analyst at the centre)
type Box = { x: number; y: number; w: number; h: number; tier: number; cx: number; cy: number }
const BASE_NW = 200
const BASE_NH = 56
const BASE_HUB_W = 248
const BASE_HUB_H = 76
/** Dense modules (name only, details in the tooltip) for tight containers. */
const DENSE = { nw: 168, nh: 38, hw: 228, hh: 58 }

/** Point where the segment centre→target leaves a rectangle (so lines start/end at the node border). */
function exitPoint(b: Box, tx: number, ty: number, pad = 4) {
  const dx = tx - b.cx, dy = ty - b.cy
  if (!dx && !dy) return { x: b.cx, y: b.cy }
  const sx = (b.w / 2 + pad) / Math.abs(dx || 1e-9), sy = (b.h / 2 + pad) / Math.abs(dy || 1e-9)
  const k = Math.min(sx, sy)
  return { x: b.cx + dx * k, y: b.cy + dy * k }
}

type Pt = { x: number; y: number }
const qAt = (a: Pt, q: Pt, b: Pt, t: number) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * q.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * q.y + t * t * b.y })
const fmtPath = (a: Pt, q: Pt, b: Pt) => `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${q.x.toFixed(1)},${q.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`

/** Number of other boxes a quadratic A→Q→B crosses (sampled), ignoring its own endpoints. */
function hits(a: Pt, q: Pt, b: Pt, boxes: Box[], pad = 10) {
  let n = 0
  for (const bx of boxes) {
    for (let i = 1; i < 48; i++) {
      const p = qAt(a, q, b, i / 48)
      if (p.x > bx.x - pad && p.x < bx.x + bx.w + pad && p.y > bx.y - pad && p.y < bx.y + bx.h + pad) { n++; break }
    }
  }
  return n
}

/**
 * Route between two boxes. Spokes (to/from the hub) are straight radial lines; agent↔agent edges bow outward,
 * away from the centre. If the default route crosses another node, the bend grows (or flips) until it is clear.
 */
function route(A: Box, B: Box, c: Pt, all: Box[], spoke: boolean) {
  const others = all.filter((b) => b !== A && b !== B)
  const M = { x: (A.cx + B.cx) / 2, y: (A.cy + B.cy) / 2 }
  const dist = Math.hypot(B.cx - A.cx, B.cy - A.cy) || 1
  // outward direction: from the centre through the midpoint (perpendicular to AB when the midpoint is near the centre)
  let ox = M.x - c.x, oy = M.y - c.y
  const ol = Math.hypot(ox, oy)
  const px = -(B.cy - A.cy) / dist, py = (B.cx - A.cx) / dist
  if (ol < 40) { ox = px; oy = py } else { ox /= ol; oy /= ol }
  const base = spoke ? 0 : 0.09 * dist
  const tries = spoke
    ? [0, 0.08, -0.08, 0.14, -0.14, 0.22, -0.22, 0.32, -0.32, 0.45, -0.45, 0.6, -0.6].map((k) => ({ dx: px * k * dist, dy: py * k * dist }))
    : [1, 1.8, 2.6, 3.6, -1, -1.8, -2.6, 4.8].map((k) => ({ dx: ox * base * k, dy: oy * base * k }))
  let best: { a: Pt; q: Pt; b: Pt; n: number } | null = null
  for (const t of tries) {
    // quadratic control point = 2× the desired apex offset
    const q = { x: M.x + t.dx * 2, y: M.y + t.dy * 2 }
    const a = exitPoint(A, q.x, q.y), b = exitPoint(B, q.x, q.y)
    const n = hits(a, q, b, others)
    if (!best || n < best.n) best = { a, q, b, n }
    if (n === 0) break
  }
  return best!
}

/** Bounding box of a quadratic (sampled). */
function qBounds(a: Pt, q: Pt, b: Pt) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i <= 16; i++) { const p = qAt(a, q, b, i / 16); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
  return { x0, y0, x1, y1 }
}

/** Circular mean of a list of angles (null when empty). */
function meanAngle(list: number[]) {
  if (!list.length) return null
  let s = 0, k = 0
  for (const t of list) { s += Math.sin(t); k += Math.cos(t) }
  return Math.atan2(s, k)
}

/**
 * Data-driven radial layout: the analyst (or the agent with most subscriptions) is the hub at the centre;
 * processing agents sit on an inner ellipse, data sources on an outer ellipse (offset by half a step).
 * Ring order is chosen by barycentric passes (agents next to the ones they talk to) to minimise crossings;
 * radii grow until no modules overlap, so it works for any number of agents.
 */
type Layout = ReturnType<typeof computeLayout>

/**
 * k = node scale (bigger modules/fonts relative to the spacing, used when the map has to shrink to fit);
 * sx / sy = multipliers of the starting ring radii (spread to fill wide containers, compact for tight ones).
 */
function computeLayout(agents: Agent[], edges: AgentEdge[], k = 1, sx = 1, sy = 1, dense = false) {
  {
    const NW = (dense ? DENSE.nw : BASE_NW) * k, NH = (dense ? DENSE.nh : BASE_NH) * k
    const HUB_W = (dense ? DENSE.hw : BASE_HUB_W) * k, HUB_H = (dense ? DENSE.hh : BASE_HUB_H) * k
    const hub = agents.find((a) => a.id === 'analyst') ?? [...agents].sort((a, b) => b.subscribes.length - a.subscribes.length)[0]
    // inner ring: the most connected processing agents (capacity ≈ 40% of the team), outer ring: sources + overflow
    const deg = (id: string) => edges.filter((e) => e.from === id || e.to === id).length
    const others = agents.filter((a) => a !== hub)
    const cap = Math.max(3, Math.min(8, Math.round(others.length * 0.4)))
    const proc = others.filter((a) => a.subscribes.length > 0).sort((a, b) => deg(b.id) - deg(a.id))
    const innerSet = new Set(proc.slice(0, cap).map((a) => a.id))
    const inner = others.filter((a) => innerSet.has(a.id))
    const outer = others.filter((a) => !innerSet.has(a.id))
    // single ring when one of the groups is empty
    const rings = [inner, outer].filter((r) => r.length)
    const offOf = (ri: number, n: number) => (ri === 1 ? Math.PI / n : 0)
    const angleAt = (ri: number, i: number, n: number) => -Math.PI / 2 + offOf(ri, n) + (i / n) * Math.PI * 2

    // undirected neighbours, hub excluded (every agent talks to the hub, so it carries no ordering information)
    const nb = new Map<string, Map<string, number>>()
    for (const e of edges) {
      if (e.from === e.to || e.from === hub?.id || e.to === hub?.id) continue
      const w = 1
      for (const [x, y] of [[e.from, e.to], [e.to, e.from]] as const) {
        if (!nb.has(x)) nb.set(x, new Map())
        nb.get(x)!.set(y, (nb.get(x)!.get(y) ?? 0) + w)
      }
    }
    // barycentric ordering: a few alternating passes, each ring sorted by the circular mean angle of its neighbours
    const ang = new Map<string, number>()
    const place = () => rings.forEach((list, ri) => list.forEach((a, i) => ang.set(a.id, angleAt(ri, i, list.length))))
    place()
    const norm = (t: number) => { let x = t + Math.PI / 2; x = ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return x }
    for (let pass = 0; pass < 6; pass++) {
      rings.forEach((list, ri) => {
        const target = new Map<string, number>()
        list.forEach((a) => {
          const ns = nb.get(a.id)
          const ts: number[] = []
          ns?.forEach((w, id) => { const t = ang.get(id); if (t != null) for (let k = 0; k < Math.round(w); k++) ts.push(t) })
          const m = meanAngle(ts)
          target.set(a.id, norm(m ?? ang.get(a.id)!))
        })
        list.sort((a, b) => target.get(a.id)! - target.get(b.id)!)
        list.forEach((a, i) => ang.set(a.id, angleAt(ri, i, list.length)))
      })
    }

    // rings are sized one at a time (inner first): each grows only along the axis that resolves its overlaps
    const rx = [330 * sx, 650 * sx], ry = [160 * sy, 330 * sy]
    const gap = 22 * k
    const boxes = new Map<string, Box>()
    if (hub) boxes.set(hub.id, { x: -HUB_W / 2, y: -HUB_H / 2, w: HUB_W, h: HUB_H, tier: 2, cx: 0, cy: 0 })
    rings.forEach((list, ri) => {
      if (ri > 0) { rx[ri] = Math.max(rx[ri], rx[ri - 1] + NW * 0.5); ry[ri] = Math.max(ry[ri], ry[ri - 1] + NH * 1.2) }
      const fixed = [...boxes.values()]
      let mine: [string, Box][] = []
      for (let it = 0; it < 90; it++) {
        mine = list.map((ag, i) => {
          const t = angleAt(ri, i, list.length)
          const cx = rx[ri] * Math.cos(t), cy = ry[ri] * Math.sin(t)
          return [ag.id, { x: cx - NW / 2, y: cy - NH / 2, w: NW, h: NH, tier: ri === 0 && rings.length > 1 ? 1 : 0, cx, cy }]
        })
        let gx = false, gy = false
        const bs = mine.map((m) => m[1])
        const test = (a: Box, b: Box) => {
          const ox = Math.min(a.x + a.w + gap - b.x, b.x + b.w + gap - a.x)
          const oy = Math.min(a.y + a.h + gap - b.y, b.y + b.h + gap - a.y)
          if (ox > 0 && oy > 0) { if (ox / (a.w + b.w) < oy / (a.h + b.h)) gx = true; else gy = true }
        }
        for (let i = 0; i < bs.length; i++) {
          for (let j = i + 1; j < bs.length; j++) test(bs[i], bs[j])
          for (const f of fixed) test(bs[i], f)
        }
        if (!gx && !gy) break
        if (gx) rx[ri] *= 1.03
        if (gy) ry[ri] *= 1.03
      }
      mine.forEach(([id, b]) => boxes.set(id, b))
    })
    // normalise to a positive viewBox with margins
    const all = [...boxes.values()]
    const minX = Math.min(...all.map((b) => b.x)) - 24, minY = Math.min(...all.map((b) => b.y)) - 24
    const maxX = Math.max(...all.map((b) => b.x + b.w)) + 24, maxY = Math.max(...all.map((b) => b.y + b.h)) + 24
    const box = new Map<string, Box>()
    boxes.forEach((b, id) => box.set(id, { ...b, x: b.x - minX, y: b.y - minY, cx: b.cx - minX, cy: b.cy - minY }))
    const W = maxX - minX, H = maxY - minY
    const centre = { x: -minX, y: -minY }
    const boxList = [...box.values()]

    // one route per unordered pair (reciprocal edges share the line, with arrows at both ends)
    type Route = { key: string; a: string; b: string; kind: 'spoke' | 'arc'; fwd: boolean; back: boolean; d: string }
    const byPair = new Map<string, Route>()
    const geo: { a: Pt; q: Pt; b: Pt }[] = []
    const paths = new Map<string, string>()
    for (const e of edges) {
      const A = box.get(e.from), B = box.get(e.to)
      if (!A || !B || e.from === e.to) continue
      const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from]
      const pk = `${a}|${b}`
      let r = byPair.get(pk)
      if (!r) {
        const spoke = a === hub?.id || b === hub?.id
        const g = route(box.get(a)!, box.get(b)!, centre, boxList, spoke)
        geo.push(g)
        r = { key: pk, a, b, kind: spoke ? 'spoke' : 'arc', fwd: false, back: false, d: fmtPath(g.a, g.q, g.b) }
        paths.set(`${a}>${b}`, r.d)
        paths.set(`${b}>${a}`, fmtPath(g.b, g.q, g.a))
        byPair.set(pk, r)
      }
      if (e.from === a) r.fwd = true; else r.back = true
    }
    const routes = [...byPair.values()]
    // grow the viewBox so arcs bowing outside the outer ring are never clipped
    let vx = 0, vy = 0, x1 = W, y1 = H
    for (const g of geo) {
      const bb = qBounds(g.a, g.q, g.b)
      vx = Math.min(vx, bb.x0 - 12); vy = Math.min(vy, bb.y0 - 12)
      x1 = Math.max(x1, bb.x1 + 12); y1 = Math.max(y1, bb.y1 + 12)
    }
    const vW = x1 - vx, vH = y1 - vy
    const pathFor = (from: string, to: string) => {
      const k = `${from}>${to}`
      if (paths.has(k)) return paths.get(k)!
      const A = box.get(from), B = box.get(to)
      if (!A || !B) return null
      const g = route(A, B, centre, boxList, from === hub?.id || to === hub?.id)
      return fmtPath(g.a, g.q, g.b)
    }
    return { W: vW, H: vH, vx, vy, box, routes, paths, pathFor, hubId: hub?.id, k, dense }
  }
}

/**
 * Fit the radial map into a cw × ch box (CSS px) with preserved aspect ratio:
 * - roomy container → spread the rings to use the space (text scale capped at ~1.12);
 * - tight container → compact rings, matched to the container aspect, and larger modules so labels stay ≥ ~12px.
 */
function fitLayout(agents: Agent[], edges: AgentEdge[], cw: number, ch: number): Layout {
  if (!cw || !ch) return computeLayout(agents, edges)
  const scaleOf = (L: Layout) => Math.min(cw / L.W, ch / L.H)
  const A = cw / ch
  /** Compact rings (minimum radii found by the overlap growth), re-run once with radii matched to the container aspect. */
  const tight = (k: number, dense: boolean) => {
    const L = computeLayout(agents, edges, k, 0.6, 0.6, dense)
    const r = L.W / L.H / A
    return r > 1.06 || r < 0.94 ? computeLayout(agents, edges, k, 0.6 / Math.sqrt(r), 0.6 * Math.sqrt(r), dense) : L
  }
  const n = tight(1, false)
  const s = scaleOf(n)
  if (s >= 1) {
    // roomy: spread the rings to fill the box (labels at most ~12% larger than nominal)
    const sT = Math.min(s, 1.12)
    return computeLayout(agents, edges, 1, (cw / sT - BASE_NW - 80) / 1300, (ch / sT - BASE_NH - 80) / 660)
  }
  if (s >= 0.9) return n
  // tight: dense modules, enlarged until labels read at >= ~12px
  let best = n, bestEff = s
  for (const k of [1, 1.1, 1.2, 1.32, 1.45, 1.6, 1.75, 1.9]) {
    const L = tight(k, true)
    const eff = k * scaleOf(L)
    if (eff > bestEff) { best = L; bestEff = eff }
    if (eff >= 0.95) break
  }
  return best
}

// ------------------------------------------------------------------ map panel (plain surface, no HUD decoration)
/** Panel that hosts the map: inset surface with a small caption row. (Legacy name kept for call sites.) */
export function Blueprint({ children, className, label, meta }: { children: ReactNode; className?: string; label?: ReactNode; meta?: ReactNode }) {
  return (
    <div className={clsx('relative overflow-hidden rounded-xl border border-line bg-bg', className)}>
      {(label || meta) && (
        <div className="pointer-events-none absolute inset-x-4 top-2.5 z-10 flex items-center justify-between gap-3 text-2xs text-slate-400">
          <span className="truncate">{label}</span>
          <span className="truncate">{meta}</span>
        </div>
      )}
      <div className="relative w-full">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------------ network map
type Particle = { trail: SVGPathElement; head: SVGCircleElement; len: number; t0: number; dur: number }

const structSig = (agents: Agent[], edges: AgentEdge[]) =>
  agents.map((a) => `${a.id}:${a.subscribes.length}`).join(',') + '#' + edges.map((e) => `${e.from}>${e.to}`).sort().join(',')

/**
 * Agent map. Measures its container and fits the radial map into (container width × maxVh of the viewport),
 * preserving the aspect ratio; below `compactBelow` px it switches to a compact grid (hub on top, agents below).
 */
export function AgentNetwork({
  agents, edges, selected, onSelect, className, showAll = false, maxVh = 0.7, compactBelow = 720,
}: { agents: Agent[]; edges: AgentEdge[]; selected?: AgentId | null; onSelect?: (id: AgentId) => void; compact?: boolean; className?: string; showAll?: boolean; maxVh?: number; compactBelow?: number }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const upd = () => {
      const w = Math.floor(el.clientWidth / 8) * 8
      // a large team needs more height for readable labels (≥ ~12px): let the map use almost the full viewport
      const vh = agents.length > 30 ? Math.max(maxVh, 0.92) : maxVh
      const h = Math.floor((window.innerHeight * vh) / 8) * 8
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }))
    }
    upd()
    const ro = new ResizeObserver(upd)
    ro.observe(el)
    window.addEventListener('resize', upd)
    return () => { ro.disconnect(); window.removeEventListener('resize', upd) }
  }, [maxVh, agents.length])
  return (
    <div ref={wrap} className={clsx('w-full', className)}>
      {size.w === 0 ? <div style={{ height: 200 }} /> : size.w < compactBelow
        ? <CompactNetwork agents={agents} selected={selected} onSelect={onSelect} />
        : <RadialNetwork agents={agents} edges={edges} selected={selected} onSelect={onSelect} showAll={showAll} cw={size.w} ch={size.h} />}
    </div>
  )
}

/** Hub + agents grid for narrow screens: status dot, last run, blue ring while sending/receiving a message. */
function CompactNetwork({ agents, selected, onSelect }: { agents: Agent[]; selected?: AgentId | null; onSelect?: (id: AgentId) => void }) {
  const now = useNow(1000)
  const [activity, setActivity] = useState<Record<string, number>>({})
  useEffect(() => live.onAgentMessage((m) => {
    const ts = Date.now()
    const touched: Record<string, number> = { [m.from]: ts }
    recipientsOf(m, agents).forEach((id) => { touched[id] = ts + 600 })
    setActivity((a) => ({ ...a, ...touched }))
  }), [agents])
  const hub = agents.find((a) => a.id === 'analyst') ?? [...agents].sort((a, b) => b.subscribes.length - a.subscribes.length)[0]
  const rest = agents.filter((a) => a !== hub)
  const hot = (id: string) => activity[id] != null && now - activity[id] < 1200 && now >= activity[id] - 1000
  const chip = (a: Agent, isHub = false) => {
    const sel = selected === a.id
    const err = a.status === 'error'
    const running = a.status === 'running'
    const lastAgo = a.last_run ? now / 1000 - a.last_run : null
    return (
      <button key={a.id} type="button" onClick={() => onSelect?.(a.id)} title={`${a.name} — ${a.role}`}
        className={clsx('flex min-w-0 flex-col items-start rounded-lg border px-2.5 py-2 text-left transition-colors duration-500',
          isHub && 'col-span-2', sel ? 'bg-[#1A2130]' : 'bg-[#161C28]',
          err ? 'border-down/70' : sel || hot(a.id) || running || isHub ? 'border-accent-blue/80' : 'border-white/[0.08]')}>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: err ? PAL.down : running ? PAL.active : PAL.idle }} />
          <span className={clsx('truncate font-medium text-white', isHub ? 'text-sm' : 'text-xs')}>{a.name}</span>
        </span>
        <span className="tnum mt-0.5 truncate text-2xs text-slate-400">
          {err ? t('Errore') : running ? t('In esecuzione') : !a.last_run ? t('Non ancora eseguito') : t('{t} fa', { t: fmtAgo(lastAgo) })}
        </span>
      </button>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {hub && chip(hub, true)}
      {rest.map((a) => chip(a))}
    </div>
  )
}

function RadialNetwork({
  agents, edges, selected, onSelect, showAll, cw, ch,
}: { agents: Agent[]; edges: AgentEdge[]; selected?: AgentId | null; onSelect?: (id: AgentId) => void; showAll: boolean; cw: number; ch: number }) {
  const sig = structSig(agents, edges)
  // structural signature only: live status / message counts must not reshuffle the map
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const L = useMemo(() => fitLayout(agents, edges, cw, ch), [sig, cw, ch])
  const scale = Math.min(cw / L.W, ch / L.H, 1.12)
  const codes = useAgentCodes(agents)
  const now = useNow(1000)
  const [hover, setHover] = useState<AgentId | null>(null)
  const [activity, setActivity] = useState<Record<string, number>>({}) // node id / edge key -> ms timestamp
  const [liveCounts, setLiveCounts] = useState<Record<string, number>>({})
  const layer = useRef<SVGGElement>(null)
  const particles = useRef<Particle[]>([])
  const raf = useRef(0)

  // packet animation loop (imperative for smoothness)
  useEffect(() => {
    const step = (t: number) => {
      const list = particles.current
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i]
        const k = (t - p.t0) / p.dur
        if (k < 0) continue
        if (k >= 1) { p.trail.remove(); p.head.remove(); list.splice(i, 1); continue }
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
        const seg = 28
        const at = e * p.len
        p.trail.setAttribute('stroke-dashoffset', String(seg - at))
        const pt = p.trail.getPointAtLength(at)
        p.head.setAttribute('cx', pt.x.toFixed(1)); p.head.setAttribute('cy', pt.y.toFixed(1))
        const o = k < 0.08 ? k / 0.08 : k > 0.92 ? (1 - k) / 0.08 : 1
        p.trail.setAttribute('opacity', (o * 0.8).toFixed(2)); p.head.setAttribute('opacity', o.toFixed(2))
      }
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf.current); particles.current.forEach((p) => { p.trail.remove(); p.head.remove() }); particles.current = [] }
  }, [])

  // live agent messages -> pulses travelling along the connections (sizes compensate the fit scale)
  useEffect(() => live.onAgentMessage((m) => {
    if (document.visibilityState !== 'visible') return
    const g = layer.current
    if (!g) return
    const targets = recipientsOf(m, agents)
    const col = m.kind === 'alert' ? PAL.amber : m.kind === 'finding' ? PAL.active : PAL.teal
    const t0 = performance.now()
    const ts = Date.now()
    const touched: Record<string, number> = { [m.from]: ts }
    const u = 1 / Math.max(0.6, Math.min(1, scale))
    targets.forEach((id, i) => {
      const d = L.pathFor(m.from, id)
      if (!d) return
      const trail = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      trail.setAttribute('d', d); trail.setAttribute('fill', 'none'); trail.setAttribute('stroke', col)
      trail.setAttribute('stroke-width', (1.75 * u).toFixed(2)); trail.setAttribute('stroke-linecap', 'round'); trail.setAttribute('opacity', '0')
      g.appendChild(trail)
      const len = trail.getTotalLength()
      trail.setAttribute('stroke-dasharray', `28 ${len + 40}`)
      const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      head.setAttribute('r', (3 * u).toFixed(2)); head.setAttribute('fill', col); head.setAttribute('opacity', '0')
      g.appendChild(head)
      particles.current.push({ trail, head, len, t0: t0 + i * 110, dur: 900 + len * 1.1 })
      touched[id] = ts + 600
      touched[`${m.from}>${id}`] = ts
      touched[m.from < id ? `${m.from}|${id}` : `${id}|${m.from}`] = ts
    })
    setActivity((a) => ({ ...a, ...touched }))
    setLiveCounts((c) => {
      const n = { ...c }
      targets.forEach((id) => { const k = `${m.from}>${id}`; n[k] = (n[k] ?? 0) + 1 })
      return n
    })
  }), [agents, L, scale])

  const active = (k: string, win = 1200) => activity[k] != null && now - activity[k] < win && now >= activity[k] - 1000
  // only hovering highlights a node's connections (selection just marks the node)
  const focus = hover ?? null
  const related = (id: string) => !focus || id === focus || edges.some((e) => (e.from === focus && e.to === id) || (e.to === focus && e.from === id))
  // last traffic per pair (REST snapshot + live), ms
  const lastByPair = useMemo(() => {
    const m: Record<string, number> = {}
    for (const e of edges) {
      if (!e.last) continue
      const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`
      m[k] = Math.max(m[k] ?? 0, e.last * 1000)
    }
    return m
  }, [edges])
  const RECENT_MS = 60_000
  const mu = 1 / Math.max(0.6, Math.min(1, scale)) // arrowheads keep their on-screen size

  return (
    <svg viewBox={`${L.vx.toFixed(0)} ${L.vy.toFixed(0)} ${L.W.toFixed(0)} ${L.H.toFixed(0)}`} width={Math.round(L.W * scale)} height={Math.round(L.H * scale)}
      className="mx-auto block max-w-full select-none" role="img" aria-label={t('Rete degli agenti')}>
      <defs>
        <marker id="agArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={7 * mu} markerHeight={7 * mu} markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={PAL.wire} /></marker>
        <marker id="agArrowHi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={7 * mu} markerHeight={7 * mu} markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={PAL.active} /></marker>
        <marker id="agArrowIdle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={6 * mu} markerHeight={6 * mu} markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={PAL.wireIdle} /></marker>
      </defs>

      {/* connections */}
      <g fill="none">
        {L.routes.map((r) => {
          const last = Math.max(lastByPair[r.key] ?? 0, activity[r.key] ?? 0)
          const recent = now - last < RECENT_MS
          const hot = active(r.key)
          const rel = focus ? r.a === focus || r.b === focus : false
          // agent↔agent arcs only when recently used (or "all links" / hovered); spokes to the analyst always
          if (r.kind === 'arc' && !showAll && !recent && !rel && !hot) return null
          const lit = hot || rel
          const stroke = lit ? PAL.active : recent ? PAL.wire : PAL.wireIdle
          const op = focus && !rel && !hot ? 0.3 : 1
          const ae = r.fwd ? edges.find((x) => x.from === r.a && x.to === r.b) : undefined
          const be = r.back ? edges.find((x) => x.from === r.b && x.to === r.a) : undefined
          const cnt = (ae?.count ?? 0) + (be?.count ?? 0) + (liveCounts[`${r.a}>${r.b}`] ?? 0) + (liveCounts[`${r.b}>${r.a}`] ?? 0)
          const mk = lit ? 'agArrowHi' : recent ? 'agArrow' : 'agArrowIdle'
          const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id
          return (
            <path key={r.key} d={r.d} stroke={stroke} strokeOpacity={op} strokeWidth={lit ? 1.5 : recent ? 1.25 : 1} vectorEffect="non-scaling-stroke"
              markerEnd={r.fwd ? `url(#${mk})` : undefined} markerStart={r.back ? `url(#${mk})` : undefined}
              style={{ transition: 'stroke-opacity 400ms, stroke 600ms ease-out' }}>
              <title>{`${name(r.a)} ${r.fwd && r.back ? '↔' : r.fwd ? '→' : '←'} ${name(r.b)} · ${t('{n} messaggi', { n: int(cnt) })}${last ? ` · ${t('Ultimo {t} fa', { t: fmtAgo((now - last) / 1000) })}` : ''}`}</title>
            </path>
          )
        })}
      </g>
      <g ref={layer} />

      {/* agents: drawn in base units (200×56 / 248×76) and scaled by the layout's node scale k */}
      {agents.map((a) => {
        const b = L.box.get(a.id)
        if (!b) return null
        const w = b.w / L.k, h = b.h / L.k
        const sel = selected === a.id
        const hot = active(a.id)
        const running = a.status === 'running'
        const err = a.status === 'error'
        const dim = !related(a.id)
        const lastAgo = a.last_run ? now / 1000 - a.last_run : null
        const prog = a.last_run && a.next_run && a.next_run > a.last_run ? Math.max(0, Math.min(1, (now / 1000 - a.last_run) / (a.next_run - a.last_run))) : 0
        const isHub = a.id === L.hubId
        const waiting = isHub && !a.runs && !a.last_run && !running && !err
        const stroke = err ? PAL.down : sel || hot || running || isHub ? PAL.active : PAL.border
        // message counts appear exactly once per node: on the meta line, except for the full-size hub (own third line)
        const counts = isHub && !L.dense ? '' : ` · ${t('{r} ric. · {s} inv.', { r: a.stats.messages_received, s: a.stats.messages_sent })}`
        const meta = err ? t('Errore') : running ? t('In esecuzione') : waiting ? t('In attesa della prima sintesi') : !a.last_run ? t('Non ancora eseguito') : `${t('{t} fa', { t: fmtAgo(lastAgo) })} · ${fmtMs(a.last_duration_ms)}${counts}`
        const maxName = L.dense ? 19 : 21
        return (
          <g key={a.id} transform={`translate(${b.x.toFixed(1)},${b.y.toFixed(1)}) scale(${L.k})`} className={onSelect ? 'cursor-pointer' : undefined}
            onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(a.id)}>
            {/* opaque backing: edges are drawn first and never show through a node box, even when it is dimmed */}
            <rect width={w} height={h} rx="6" fill="#060912" />
            <g opacity={dim ? 0.4 : 1} style={{ transition: 'opacity 200ms' }}>
            <title>{L.dense ? `${a.name} — ${meta}
${a.role}` : `${a.name} — ${a.role}`}</title>
            {hot && <rect x="-4" y="-4" width={w + 8} height={h + 8} rx="9" fill="none" stroke={PAL.active} strokeOpacity="0.45" strokeWidth="1" />}
            <rect width={w} height={h} rx="6" fill={sel ? '#1A2130' : PAL.node} stroke={stroke} strokeOpacity={isHub && !sel && !hot && !running ? 0.6 : 1} strokeWidth={sel ? 1.5 : 1} style={{ transition: 'stroke 600ms ease-out' }} />
            <circle cx="14" cy={L.dense ? 18 : 20} r="3" fill={err ? PAL.down : running ? PAL.active : PAL.idle} />
            <text x="24" y={L.dense ? 22.5 : 24} fontSize={isHub ? 15 : 13} fontWeight={isHub ? 600 : 500} fill={PAL.text} style={{ fontFamily: FONT_UI }}>
              {a.name.length > maxName ? a.name.slice(0, maxName - 1) + '…' : a.name}
            </text>
            {!L.dense && a.name.length <= (isHub ? 18 : 16) && <text x={w - 10} y="23" textAnchor="end" fontSize="11" fill={PAL.disabled} style={{ fontFamily: FONT_UI }}>{codes.get(a.id)}</text>}
            {(!L.dense || isHub) && <text x="14" y={L.dense ? 42 : 42} fontSize="11" fill={PAL.muted} style={{ fontFamily: FONT_UI }}>{meta}</text>}
            {isHub && !L.dense && <text x="14" y="60" fontSize="11" fill={PAL.muted} style={{ fontFamily: FONT_UI }}>{t('{n} esecuzioni · {r} ricevuti · {s} inviati', { n: a.runs, r: a.stats.messages_received, s: a.stats.messages_sent })}</text>}
            <rect x="12" y={h - 7} width={w - 24} height="1.5" rx="0.75" fill="rgba(148,163,184,0.12)" />
            <rect x="12" y={h - 7} width={(w - 24) * prog} height="1.5" rx="0.75" fill={err ? PAL.down : PAL.active} opacity="0.6" />
            </g>
          </g>
        )
      })}
    </svg>
  )
}

// ------------------------------------------------------------------ message log
/** Italian source labels: wrap with t() at the use site. */
export const KIND_LABEL: Record<string, string> = { finding: 'Analisi', request: 'Richiesta', reply: 'Risposta', alert: 'Allerta' }

/** One message: time · sender → recipient · kind · text (topic only with "Dettagli tecnici"). */
export function LogLine({ m, byId, compact, showTopic = false }: { m: AgentMessage; byId: Map<string, Agent>; codes?: Map<string, string>; compact?: boolean; showTopic?: boolean }) {
  const from = byId.get(m.from)
  const to = m.to === '*' ? undefined : byId.get(m.to)
  const alert = m.kind === 'alert'
  return (
    <div className={clsx('flex gap-3 border-l-2 px-3 py-1.5 text-sm hover:bg-white/[0.02]', alert ? 'border-amber-400' : 'border-transparent', compact && 'whitespace-nowrap')}>
      <span className="tnum shrink-0 text-xs leading-5 text-slate-400">{clock(m.time)}</span>
      <div className={clsx('min-w-0 flex-1', compact && 'truncate')}>
        <span className="font-medium text-white">{from?.name ?? m.from}</span>
        <span className="mx-1.5 text-slate-400">→</span>
        <span className="text-slate-300">{m.to === '*' ? t('Tutti') : to?.name ?? m.to}</span>
        <span className={clsx('ml-2 text-xs', alert ? 'text-amber-400' : 'text-slate-400')}>{KIND_LABEL[m.kind] ? t(KIND_LABEL[m.kind]) : m.kind}</span>
        {showTopic && <span className="ml-2 font-mono text-xs text-slate-400">{m.topic}</span>}
        <span className={clsx('text-slate-300', compact ? 'ml-2' : 'mt-0.5 block')}>{m.text}</span>
      </div>
    </div>
  )
}

/** Scrollable log container (legacy name). */
export function Terminal({ children, className, status }: { children: ReactNode; className?: string; title?: string; status?: ReactNode }) {
  return (
    <div className={clsx('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-bg', className)}>
      {status && <div className="flex h-8 shrink-0 items-center justify-end border-b border-line px-3 text-2xs text-slate-400">{status}</div>}
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------------ legacy (kept for backward compatibility)
export function AgentMessageRow({ m, byId, compact }: { m: AgentMessage; byId: Map<string, Agent>; compact?: boolean }) {
  return <LogLine m={m} byId={byId} compact={compact} />
}
export function AgentAvatar({ a, id, size = 18 }: { a?: Agent; id: string; size?: number }) {
  return (
    <span className="inline-grid shrink-0 place-items-center rounded bg-raised text-2xs font-semibold text-slate-300" style={{ width: size, height: size }} title={a?.name}>
      {id === '*' ? '*' : agentPrefix(id).slice(0, 1)}
    </span>
  )
}
