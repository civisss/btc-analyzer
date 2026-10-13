/*
 * Shared helpers for the VWAP charts (lightweight-charts): own price/time axis labels drawn as HTML so that
 *  - price ticks covered by a level pill are hidden (never half-covered),
 *  - time labels that would be clipped at the plot edges are skipped,
 *  - price format matches the rest of the app ($84.8K on the axis, $83,173 in pills).
 * Also: pill layout (collision avoidance) and opaque colour blending for pills/labels.
 */
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts'
import { cap, months } from '../../i18n'
import { usdAxis } from './theme'

export const PILL_H = 16
const p2 = (n: number) => String(n).padStart(2, '0')

/** Opaque blend of `hex` at alpha `a` over the card surface (#0E1424). */
export function mix(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  const bg = [14, 20, 36]
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x, i) => Math.round(x * a + bg[i] * (1 - a)))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

/** "$83,173" — whole dollars (pills, labels); `d` decimals when precision matters. */
export const usdP = (v: number | null | undefined, d = 0) =>
  v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`

/** Pushes overlapping items apart (sorted by y) and keeps them inside [PILL_H/2+2, h−PILL_H/2−2]. Off-screen items are pinned to the edge. */
export function layoutPills<X extends { y: number }>(items: X[], h: number, gap = PILL_H + 1): (X & { off: -1 | 0 | 1 })[] {
  const vis = items.map((i) => ({ ...i, off: (i.y < 0 ? -1 : i.y > h ? 1 : 0) as -1 | 0 | 1 })).sort((a, b) => a.y - b.y)
  const top = PILL_H / 2 + 2
  const bot = h - PILL_H / 2 - 2
  for (let i = 0; i < vis.length; i++) vis[i].y = Math.max(Math.min(Math.max(vis[i].y, top), bot), i ? vis[i - 1].y + gap : top)
  for (let i = vis.length - 1; i >= 0; i--) vis[i].y = Math.min(vis[i].y, i < vis.length - 1 ? vis[i + 1].y - gap : bot)
  return vis
}

const NICE = [1, 2, 2.5, 5, 10]
/** Price ticks for the visible range, ~every `px` pixels, without the ones hidden by pills (|y − pill| < PILL_H/2 + 6). */
export function priceTicks(series: ISeriesApi<SeriesType>, h: number, pillYs: number[], px = 46): { y: number; label: string }[] {
  const top = series.coordinateToPrice(0)
  const bot = series.coordinateToPrice(h)
  if (top == null || bot == null || !(top > bot)) return []
  const raw = ((top - bot) / Math.max(1, h)) * px
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = (NICE.find((n) => n * mag >= raw) ?? 10) * mag
  const out: { y: number; label: string }[] = []
  for (let p = Math.ceil(bot / step) * step; p <= top; p += step) {
    const y = series.priceToCoordinate(p)
    if (y == null || y < 7 || y > h - 7) continue
    if (pillYs.some((py) => Math.abs(py - y) < PILL_H / 2 + 6)) continue
    out.push({ y, label: usdAxis(p) })
  }
  return out
}

const STEPS = [1800, 3600, 7200, 10800, 21600, 43200, 86400, 2 * 86400, 7 * 86400, 14 * 86400, -1 /* month */, -3 /* quarter */]

/** Bar index (fractional) of a UTC time on the bar grid `t` (step `step`), extrapolated past the last bar. */
export function timeLogical(t: number[], step: number, x: number): number {
  const n = t.length
  if (!n) return 0
  if (x >= t[n - 1]) return n - 1 + (x - t[n - 1]) / step
  if (x <= t[0]) return (x - t[0]) / step
  let lo = 0, hi = n - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m }
  return lo + (x - t[lo]) / Math.max(1, t[hi] - t[lo])
}

function monthStart(ms: number, add: number): number {
  const d = new Date(ms * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1) / 1000
}

/** UTC time labels (~every 90 px), skipping those that would be clipped at the plot edges. */
export function timeTicks(chart: IChartApi, t: number[], step: number, plotW: number): { x: number; label: string; major: boolean }[] {
  const ts = chart.timeScale()
  const r = ts.getVisibleLogicalRange()
  const n = t.length
  if (!r || n < 2) return []
  const x0 = ts.logicalToCoordinate(0 as never)
  const x1 = ts.logicalToCoordinate(1 as never)
  if (x0 == null || x1 == null) return []
  const pxPerSec = (x1 - x0) / step
  const tOf = (l: number) => (l <= n - 1 ? (l < 0 ? t[0] + l * step : t[Math.floor(l)] + (l - Math.floor(l)) * step) : t[n - 1] + (l - (n - 1)) * step)
  const from = tOf(Math.max(r.from, -1e6))
  const to = tOf(r.to)
  const minSec = 90 / Math.max(1e-9, pxPerSec)
  const s = STEPS.find((x) => (x > 0 ? x : -x * 30 * 86400) >= minSec) ?? -3
  const ticks: number[] = []
  if (s > 0) {
    // weekly steps aligned to Mondays, daily to 00:00, intraday to the step
    const base = s >= 7 * 86400 ? 4 * 86400 : 0
    for (let x = Math.ceil((from - base) / s) * s + base; x <= to; x += s) ticks.push(x)
  } else {
    for (let x = monthStart(from, 1); x <= to; x = monthStart(x, -s)) ticks.push(x)
  }
  const out: { x: number; label: string; major: boolean }[] = []
  for (const x of ticks) {
    const cx = ts.logicalToCoordinate(timeLogical(t, step, x) as never)
    if (cx == null) continue
    const d = new Date(x * 1000)
    const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0
    const label = midnight && d.getUTCDate() === 1 ? (d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : cap(months()[d.getUTCMonth()]))
      : midnight ? String(d.getUTCDate()) : `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
    const half = label.length * 3.3 + 2
    if (cx - half < 2 || cx + half > plotW - 2) continue
    out.push({ x: cx, label, major: midnight && (d.getUTCDate() === 1 || s < 86400) })
  }
  return out
}
