import type { Pt } from '../../api/types'
import { compact, date } from '../../lib/format'
import { cap, months } from '../../i18n'
import { ANALOGS, DIVERGING, HEAT, LINE, SEQ, SERIES, T, alpha } from '../../theme/tokens'

/*
 * Chart roles (values live in theme/tokens.ts):
 *   price  : warm white, always the BTC price and the reference series
 *   accent : orange, the series in focus (the metric being read, the current path, the selection)
 *   steel · sand · mauve : further series, then greys. up/down only for signed values and long/short.
 * The last-price line and label stay white, so orange in a chart never means "the price".
 */
const roles = {
  price: T.fg,
  accent: T.accent,
  accentLo: T.accentLo,
  up: T.up,
  down: T.down,
  warn: T.warn,
  primary: T.fg,
  steel: T.steel,
  sand: T.sand,
  mauve: T.mauve,
  grey: T.fg3,
  grey2: T.fg4,
  text: T.fg2,
  muted: T.fg4,
  grid: alpha(T.fg3, 0.07),
  axis: alpha(T.fg3, 0.14),
  bg: T.surface,
  raised: T.raised,
}
export const C: { [K in keyof typeof roles]: string } = roles
/** Series order for multi-series charts (first = primary). */
export const SERIES_COLORS: string[] = [...SERIES]
/** Distinct tints for overlaid analogs (no orange = current path, no green/red = gain/loss). */
export const ANALOG_COLORS: string[] = [...ANALOGS]
export { SEQ, DIVERGING, HEAT }
/*
 * Colour rule for deltas: green/red only when the sign is good/bad for BTC holders (price, flows, gains).
 * Macro inputs (DXY, rates, VIX, difficulty, volume…) show their change in neutral text — their direction is not
 * intrinsically good or bad, so it's left to the score/tone that interprets them.
 */
export const FONT = 'Geist Variable, Geist, Inter Variable, system-ui, sans-serif'

/** Pt[] -> echarts [ms, value] pairs */
export const toXY = (pts: Pt[] | undefined) => (pts ?? []).map((p) => [p.time * 1000, p.value] as [number, number | null])

export const tooltipBase = {
  backgroundColor: T.overlay,
  borderColor: LINE.strong,
  borderWidth: 1,
  padding: [10, 12],
  textStyle: { color: T.fg, fontSize: 12, fontFamily: FONT },
  extraCssText: `border-radius:8px;box-shadow:0 16px 36px -12px ${alpha(T.black, 0.8)};font-variant-numeric:tabular-nums;`,
  axisPointer: {
    lineStyle: { color: alpha(T.fg3, 0.4), type: 'dashed' },
    crossStyle: { color: alpha(T.fg3, 0.4), type: 'dashed' },
    label: { backgroundColor: T.overlay, color: T.fg, fontFamily: FONT, borderColor: LINE.strong, borderWidth: 1, borderRadius: 6 },
  },
}

export const axisLabel = { color: C.muted, fontSize: 11, fontFamily: FONT }

/** Axis number formatter that also handles log scales: 0.001 · 0.5 · 1 · 250 · 1K · 2.5M (never 1e-3). */
export function axisNum(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a < 1) return String(+v.toPrecision(2)).replace('-', '−')
  // trailing zeros off (1.00 → 1, 2.50 → 2.5, 1.0K → 1K) so ticks read the same as 10 · 100 · 1K
  return compact(v, a >= 1e3 ? 1 : 0).replace(/(\.\d*?)0+(?=[KMBT]|$)/, '$1').replace(/\.(?=[KMBT]|$)/, '')
}

/** Short month names in the current UI language (call at render time). */
export const mesiBrevi = () => months()
/** @deprecated use mesiBrevi() — kept for the Italian-only call sites. */
export const MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']
const p2 = (n: number) => String(n).padStart(2, '0')
/** Italian time-axis tick label (local time): "2026" at new year, "ott" at month start, "12 ott" for days, "21:00" intraday. */
export function itTimeLabel(v: number | string): string {
  const d = new Date(Number(v))
  if (Number.isNaN(d.getTime())) return String(v)
  const h = d.getHours(), mi = d.getMinutes()
  if (h || mi) return `${p2(h)}:${p2(mi)}`
  if (d.getDate() === 1) return d.getMonth() === 0 ? String(d.getFullYear()) : cap(months()[d.getMonth()])
  return `${d.getDate()} ${months()[d.getMonth()]}`
}

export function timeAxis(extra: Record<string, unknown> = {}) {
  return {
    type: 'time',
    axisLine: { lineStyle: { color: C.axis } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { ...axisLabel, hideOverlap: true, formatter: itTimeLabel },
    ...extra,
  }
}
export function valueAxis(extra: Record<string, unknown> = {}) {
  return {
    type: 'value',
    scale: true,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: C.grid } },
    axisLabel: { ...axisLabel, formatter: axisNum },
    nameTextStyle: { color: C.muted, fontFamily: FONT, fontSize: 11 },
    ...extra,
  }
}
/** One price-axis format app-wide (same as ECharts usd axes): $91K · $82.9K · $105K · $950. */
export function usdAxis(p: number): string {
  const a = Math.abs(p)
  const sign = p < 0 ? '−' : ''
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 100000 ? 0 : 1).replace(/\.0$/, '')}K`
  return `${sign}$${a >= 10 ? Math.round(a) : a.toFixed(2)}`
}
export const usdAxisFmt = usdAxis
export const dateFmt = (ms: number) => date(ms / 1000)

/** Legend: top-left, inline, 8px square swatches, never paginated. */
export const legendBase = {
  type: 'plain',
  textStyle: { color: C.text, fontSize: 12, fontFamily: FONT },
  icon: 'roundRect',
  itemWidth: 8,
  itemHeight: 8,
  itemGap: 14,
  inactiveColor: T.fgOff,
  top: 0,
  left: 0,
}

export const dataZoomInside = { type: 'inside', throttle: 30, zoomOnMouseWheel: 'shift', moveOnMouseWheel: false, moveOnMouseMove: true }
export const dataZoomSlider = {
  type: 'slider',
  height: 16,
  bottom: 4,
  borderColor: LINE.base,
  backgroundColor: 'transparent',
  fillerColor: alpha(T.accent, 0.1),
  dataBackground: { lineStyle: { color: alpha(T.fg3, 0.25) }, areaStyle: { color: alpha(T.fg3, 0.05) } },
  selectedDataBackground: { lineStyle: { color: alpha(T.fg3, 0.5) }, areaStyle: { color: alpha(T.fg3, 0.08) } },
  handleStyle: { color: C.raised, borderColor: alpha(T.fg3, 0.4) },
  moveHandleStyle: { color: C.raised },
  textStyle: { color: C.muted, fontFamily: FONT, fontSize: 11 },
  labelFormatter: '',
}

export function lineSeries(name: string, data: unknown[], color: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: 'line',
    data,
    showSymbol: false,
    symbol: 'none',
    smooth: false,
    lineStyle: { width: 1.5, color },
    itemStyle: { color },
    emphasis: { disabled: true },
    ...extra,
  }
}

/** Vertical gradient fill for areas under a line (top alpha a1 → bottom a2). */
export function areaGradient(color: string, a1 = 0.16, a2 = 0) {
  return {
    type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color: hexA(color, a1) },
      { offset: 1, color: hexA(color, a2) },
    ],
  }
}

export const hexA = alpha
