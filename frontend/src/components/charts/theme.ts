import type { Pt } from '../../api/types'
import { compact, date } from '../../lib/format'
import { cap, months } from '../../i18n'

/*
 * Chart palette — max 4 hues per chart, in this order:
 *   primary (BTC orange for the BTC price, otherwise near-white) · blue #5B8DEF · violet #9B87F5 · teal #3CC6B0
 *   extra series: greys #94A3B8 / #64748B (solid / dashed). up/down only for signed values.
 * Legacy keys (pink, yellow, cyan) resolve into this palette so old call sites can't add new hues.
 */
export const C = {
  btc: '#F7931A',
  up: '#2EBD85',
  down: '#EF5466',
  amber: '#E8B04B',
  primary: '#E8ECF4',
  blue: '#5B8DEF',
  purple: '#9B87F5',
  teal: '#3CC6B0',
  cyan: '#3CC6B0',
  grey: '#94A0BC',
  grey2: '#626D88',
  pink: '#94A0BC',
  yellow: '#626D88',
  text: '#B3BCD0',
  muted: '#6E7894',
  grid: 'rgba(148,163,210,0.06)',
  axis: 'rgba(148,163,210,0.12)',
  bg: '#0E1424',
  raised: '#18213A',
}
/** Series order for multi-series charts (first = primary). */
export const SERIES_COLORS = [C.btc, C.blue, C.purple, C.teal, C.grey, C.grey2, C.grey, C.grey2]
/** Distinct hues for overlaid analogs (no orange = current price, no green/red = gain/loss). */
export const ANALOG_COLORS = ['#5B8DEF', '#B49CFF', '#3CC6B0', '#F28CC0', '#E8C25B', '#7DD3FC', '#D8B4FE', '#A7B4D0', '#6EE7C8', '#F9A8D4']
/** Sequential ramp (single blue) and diverging ramp (red ↔ grey ↔ green). Magma is reserved for the liquidation heatmap. */
export const SEQ_BLUE = ['#0E1424', '#12223F', '#163868', '#1D4F97', '#2C6AD0', '#5B8DEF', '#9BBCFF']
export const DIVERGING = ['#EF5466', '#B44B5C', '#5E4558', '#262F48', '#3D6457', '#2B946D', '#2EBD85']
/*
 * Colour rule for deltas: green/red only when the sign is good/bad for BTC holders (price, flows, gains).
 * Macro inputs (DXY, rates, VIX, difficulty, volume…) show their change in neutral text — their direction is not
 * intrinsically good or bad, so it's left to the score/tone that interprets them.
 */
export const MAGMA = ['#0A0E17', '#1d1147', '#51127c', '#822681', '#b73779', '#e75263', '#fc8961', '#fec287', '#fcfdbf']
export const FONT = 'Geist Variable, Geist, Inter Variable, system-ui, sans-serif'

/** Pt[] -> echarts [ms, value] pairs */
export const toXY = (pts: Pt[] | undefined) => (pts ?? []).map((p) => [p.time * 1000, p.value] as [number, number | null])

export const tooltipBase = {
  backgroundColor: 'rgba(22,30,52,0.96)',
  borderColor: 'rgba(160,175,225,0.18)',
  borderWidth: 1,
  padding: [10, 12],
  textStyle: { color: '#E8ECF4', fontSize: 12, fontFamily: FONT },
  extraCssText: 'border-radius:12px;box-shadow:0 18px 40px -12px rgba(0,0,0,0.75),inset 0 1px 0 rgba(255,255,255,0.06);backdrop-filter:blur(10px);font-variant-numeric:tabular-nums;',
  axisPointer: {
    lineStyle: { color: 'rgba(160,175,225,0.4)', type: 'dashed' },
    crossStyle: { color: 'rgba(160,175,225,0.4)', type: 'dashed' },
    label: { backgroundColor: '#1E2840', color: '#E8ECF4', fontFamily: FONT, borderColor: 'rgba(160,175,225,0.18)', borderWidth: 1, borderRadius: 6 },
  },
}

export const axisLabel = { color: C.muted, fontSize: 11, fontFamily: FONT }

/** Axis number formatter that also handles log scales: 0.001 · 0.5 · 1 · 250 · 1K · 2.5M (never 1e-3). */
export function axisNum(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a < 1) return String(+v.toPrecision(2)).replace('-', '−')
  return compact(v, a >= 1e3 ? 1 : 0).replace(/\.0(?=[KMBT]|$)/, '')
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
  inactiveColor: '#343D55',
  top: 0,
  left: 0,
}

export const dataZoomInside = { type: 'inside', throttle: 30, zoomOnMouseWheel: 'shift', moveOnMouseWheel: false, moveOnMouseMove: true }
export const dataZoomSlider = {
  type: 'slider',
  height: 16,
  bottom: 4,
  borderColor: 'rgba(255,255,255,0.07)',
  backgroundColor: 'transparent',
  fillerColor: 'rgba(148,163,184,0.10)',
  dataBackground: { lineStyle: { color: 'rgba(148,163,184,0.25)' }, areaStyle: { color: 'rgba(148,163,184,0.05)' } },
  selectedDataBackground: { lineStyle: { color: 'rgba(148,163,184,0.5)' }, areaStyle: { color: 'rgba(148,163,184,0.08)' } },
  handleStyle: { color: C.raised, borderColor: 'rgba(148,163,184,0.4)' },
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

export function hexA(hex: string, a: number) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
