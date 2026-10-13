/* Widget della pagina "Analoghi": candele normalizzate con gambe ZigZag, figure grafiche e punti strutturali numerati,
 * modalità sovrapposta (analogo in trasparenza), overlay con proiezione, scomposizione della somiglianza grafica,
 * confronto gamba per gamba, feature e tabella di corrispondenza dei punti. */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, Check, Equal } from 'lucide-react'
import type { AnalogCandle, AnalogFeature, AnalogLeg, AnalogLegPair, AnalogMapping, AnalogMatch, AnalogTf, ChartPattern, VisualComponent } from '../api/analogs'
import EChart from '../components/charts/EChart'
import { C, axisLabel, hexA, legendBase, lineSeries, tooltipBase, valueAxis } from '../components/charts/theme'
import { clsx } from '../components/ui'
import { date, dateTime, pct, usd } from '../lib/format'
import { cap, months, t, tfIn, tr } from '../i18n'

/** Backend period label ("ago–ott 2026 (1G)") → sentence case with the locale timeframe token. */
export const plabel = (s: string | null | undefined) => (s ? cap(tfIn(s)) : '')

/** Plain cell of a divider grid (`.dgrid`): label · value · one muted sub-line. No box, no fill. */
export function DCell({ label, value, foot, title, className }: { label: ReactNode; value: ReactNode; foot?: ReactNode; title?: string; className?: string }) {
  return (
    <div className={clsx('min-w-0 px-3 py-2.5', className)} title={title}>
      <div className="label truncate">{label}</div>
      <div className="tnum mt-1 truncate text-xl font-semibold text-white">{value}</div>
      <div className="tnum mt-0.5 truncate text-xs text-slate-400">{foot ?? <span className="text-slate-600">—</span>}</div>
    </div>
  )
}

/** "nel 2024" / "in 2024" → "2024" (backend `period.when`). */
export const whenYear = (when: string) => when.replace(/^(nel|in)\s+/i, '')

/** Numbered mapping markers: neutral (the number carries the identity, not the colour). */
export const POINT_COLORS = ['#B3BCD0']
export const pointColor = (n: number) => POINT_COLORS[(n - 1) % POINT_COLORS.length]

export function tickLabel(ts: number, tf: AnalogTf) {
  const MONTHS = months()
  const d = new Date(ts * 1000)
  if (tf === '1h' || tf === '4h') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}h`
  if (tf === '1w') return `${cap(MONTHS[d.getUTCMonth()])} ${String(d.getUTCFullYear()).slice(2)}`
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
const fullTime = (ts: number, tf: AnalogTf) => (tf === '1h' || tf === '4h' ? dateTime(ts) : date(ts))

type TipP = { dataIndex: number; seriesName: string; value: unknown; color: string }
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`

/** Range % comune (min/max) per avere la stessa scala visiva sui due grafici affiancati. */
export function pctRange(sets: AnalogCandle[][]): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (const cs of sets) {
    if (!cs.length) continue
    const b = cs[0].close
    for (const c of cs) {
      lo = Math.min(lo, (c.low / b - 1) * 100)
      hi = Math.max(hi, (c.high / b - 1) * 100)
    }
  }
  const pad = Math.max(1, (hi - lo) * 0.12)
  return [Math.floor(lo - pad), Math.ceil(hi + pad)]
}

// ------------------------------------------------------------------ candele normalizzate + gambe, figure e punti numerati
export const LINE_STYLE: Record<string, { color: string; type: 'solid' | 'dashed' | 'dotted'; width: number }> = {
  resistance: { color: '#94A3B8', type: 'dashed', width: 1.25 },
  support: { color: '#64748B', type: 'dashed', width: 1.25 },
  neckline: { color: '#B3BCD0', type: 'dashed', width: 1.25 },
  pole: { color: '#B3BCD0', type: 'solid', width: 1.25 },
  leg: { color: '#5B8DEF', type: 'dotted', width: 1.5 },
}
export const LEG_COLOR = '#5B8DEF'

export type ChartLayers = { points: boolean; legs: boolean; patterns: boolean }

/** Width of an element, kept in sync with a ResizeObserver. */
function useWidth<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/**
 * Picks which leg labels to draw so they never overlap: biggest moves first, a label is kept only if its centre
 * is at least `labelPx` away (in pixels) from every label already kept. Hidden labels stay available in the tooltip.
 */
function visibleLegLabels(legs: AnalogLeg[], n: number, plotPx: number, labelPx: number): Set<number> {
  const keep = new Set<number>()
  if (!legs.length || n <= 0 || plotPx <= 0) return keep
  const pxPerCandle = plotPx / n
  const mids: number[] = []
  ;[...legs].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).forEach((g) => {
    const mid = ((g.from_idx + g.to_idx) / 2) * pxPerCandle
    if (mids.every((m) => Math.abs(m - mid) >= labelPx)) { keep.add(g.n); mids.push(mid) }
  })
  return keep
}

/**
 * Projected future for the "Oggi" chart, all in absolute prices:
 * `path` = MEDIAN across all analogs per step (headline), p25–p75 / p10–p90 bands across all analogs,
 * `sel` = the selected analog's own continuation (secondary, dashed).
 */
export type AnalogFuture = {
  times: number[]; path: number[]; p25?: number[]; p75?: number[]; p10?: number[]; p90?: number[]
  sel?: number[]; selLabel?: string; n: number
}

/** Percentile (0..1) of a numeric list (linear interpolation, non-finite values ignored). */
export function quant(xs: (number | null | undefined)[], q: number) {
  const a = xs.filter((x): x is number => x != null && Number.isFinite(x)).sort((x, y) => x - y)
  if (!a.length) return NaN
  const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
  return a[lo] + (a[hi] - a[lo]) * (i - lo)
}

/** Median and P25–P75 of the analogs' outcomes (% change after the horizon), applied to the live price. */
export type AnalogStats = { n: number; median: number; p25: number; p75: number; price: number; lo: number; hi: number }
export function analogStats(all: AnalogMatch[], lastClose: number): AnalogStats | null {
  const xs = all.map((m) => m.outcome.change).filter((x): x is number => x != null && Number.isFinite(x))
  if (!xs.length || !lastClose) return null
  const median = quant(xs, 0.5), p25 = quant(xs, 0.25), p75 = quant(xs, 0.75)
  const at = (c: number) => lastClose * (1 + c / 100)
  return { n: xs.length, median, p25, p75, price: at(median), lo: at(p25), hi: at(p75) }
}

/**
 * Builds the future for today's chart. Each analog's continuation is normalised on its own last window close and
 * rescaled onto the live price; the headline path is the per-step MEDIAN of all those paths, with P25–P75 (≥2 analogs)
 * and P10–P90 (≥4 analogs) bands. The selected analog's own path is returned separately as `sel`.
 */
export function buildFuture(sel: AnalogMatch, all: AnalogMatch[], window: number, cur: AnalogCandle[]): AnalogFuture | undefined {
  const lastClose = cur[cur.length - 1]?.close
  if (!lastClose) return undefined
  const scale = (m: AnalogMatch) => {
    const end = m.candles[window - 1]?.close
    return end ? m.candles.slice(window).map((c) => (lastClose * c.close) / end) : []
  }
  const paths = all.map(scale).filter((x) => x.length)
  const L = paths.reduce((a, x) => Math.max(a, x.length), 0)
  if (!L) return undefined
  const steps = Array.from({ length: L }, (_, k) => k)
  const at = (q: number) => steps.map((k) => quant(paths.map((x) => x[k]), q))
  const withTimes = all.find((m) => m.projection?.times?.length === L)
  const dt = cur.length > 1 ? cur[cur.length - 1].time - cur[cur.length - 2].time : 86400
  const times = withTimes ? withTimes.projection.times : steps.map((k) => cur[cur.length - 1].time + (k + 1) * dt)
  const selPath = scale(sel)
  return {
    times, path: at(0.5), n: paths.length,
    ...(paths.length >= 2 ? { p25: at(0.25), p75: at(0.75) } : {}),
    ...(paths.length >= 4 ? { p10: at(0.1), p90: at(0.9) } : {}),
    ...(selPath.length ? { sel: selPath, selLabel: plabel(sel.period.label) } : {}),
  }
}

/** Shared % range so "Oggi" and the analog line up (window + continuation + projection bands). */
export function pctRangeWithFuture(cur: AnalogCandle[], ana: AnalogCandle[], future?: AnalogFuture): [number, number] {
  const [lo0, hi0] = pctRange([cur, ana])
  const b = cur[0]?.close
  if (!future || !b) return [lo0, hi0]
  const vals = [...future.path, ...(future.p10 ?? future.p25 ?? []), ...(future.p90 ?? future.p75 ?? []), ...(future.sel ?? [])].map((v) => (v / b - 1) * 100).filter(Number.isFinite)
  if (!vals.length) return [lo0, hi0]
  const pad = Math.max(1, (Math.max(...vals) - Math.min(...vals)) * 0.06)
  return [Math.min(lo0, Math.floor(Math.min(...vals) - pad)), Math.max(hi0, Math.ceil(Math.max(...vals) + pad))]
}

export function AnalogCandles({
  candles, points, side, tf, yMin, yMax, height = 340, active, accent, legs = [], patterns = [], layers = { points: true, legs: true, patterns: true }, ghost, ghostLabel, compact = false,
  after, future, ghostAfter, outcome,
}: {
  candles: AnalogCandle[]; points: AnalogMapping[]; side: 'current' | 'analog'; tf: AnalogTf
  yMin: number; yMax: number; height?: number; active?: number | null; accent: string
  legs?: AnalogLeg[]; patterns?: ChartPattern[]; layers?: ChartLayers
  /** candele dell'analogo disegnate in trasparenza dietro (modalità sovrapposta), normalizzate sulla propria prima chiusura */
  ghost?: AnalogCandle[]; ghostLabel?: string
  /** etichette brevi delle gambe (schermi stretti) */
  compact?: boolean
  /** analog side: the candles that followed the matched window (drawn dimmed after "Fine finestra") */
  after?: AnalogCandle[]
  /** current side: projected path / bands after "Oggi" */
  future?: AnalogFuture
  /** overlay mode: the ghost analog's continuation (dashed after today) */
  ghostAfter?: AnalogCandle[]
  /** outcome % annotated at the end of the continuation */
  outcome?: number | null
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>()
  const option = useMemo(() => {
    const base = candles[0]?.close || 1
    const p = (v: number) => +((v / base - 1) * 100).toFixed(3)
    const w = Math.max(candles.length, ghost?.length ?? 0)
    const extraLen = after?.length ?? future?.path.length ?? ghostAfter?.length ?? 0
    const n = w + extraLen
    const data = candles.map((c) => [p(c.open), p(c.close), p(c.low), p(c.high)])
    const gb = ghost?.[0]?.close || 1
    const gp = (v: number) => +((v / gb - 1) * 100).toFixed(3)
    const ghostData = ghost ? ghost.map((c) => [gp(c.open), gp(c.close), gp(c.low), gp(c.high)]) : []
    const futTimes = after ? after.map((c) => c.time) : future ? future.times : ghostAfter ? ghostAfter.map((_, i) => (candles[candles.length - 1]?.time ?? 0) + (i + 1) * ((candles[1]?.time ?? 0) - (candles[0]?.time ?? 0))) : []
    const xs = Array.from({ length: n }, (_, i) => String(i < w ? candles[i]?.time ?? ghost?.[i]?.time ?? i : futTimes[i - w] ?? i))
    const lastIdx = w - 1
    const mp = layers.points ? points.map((m) => {
      const pt = m[side]
      const isHigh = m.kind === 'high'
      const isLow = m.kind === 'low'
      const big = active === m.n
      return {
        coord: [Math.min(pt.idx, candles.length - 1), p(pt.price)],
        value: m.n,
        symbol: 'circle',
        symbolSize: big ? 26 : 19,
        symbolOffset: [0, isHigh ? -17 : isLow ? 17 : 0],
        itemStyle: { color: big ? '#5B8DEF' : pointColor(m.n), borderColor: '#10151F', borderWidth: 2 },
        label: { show: true, formatter: String(m.n), color: '#0A0E17', fontWeight: 600, fontSize: 11 },
      }
    }) : []
    // ZigZag delle gambe come linea con valori solo sugli estremi
    const zz: (number | null)[] = new Array(n).fill(null)
    const legLabels: unknown[] = []
    if (layers.legs && legs.length) {
      // ~56px for the y-axis labels; label width depends on the text shown
      const shown = visibleLegLabels(legs, n, Math.max(0, width - 56), compact ? 28 : 74)
      legs.forEach((g) => {
        zz[g.from_idx] = p(g.from_price)
        zz[g.to_idx] = p(g.to_price)
        if (!shown.has(g.n)) return
        const mid = Math.round((g.from_idx + g.to_idx) / 2)
        const up = g.pct >= 0
        legLabels.push({
          coord: [mid, (p(g.from_price) + p(g.to_price)) / 2], value: g.label, symbol: 'roundRect', symbolSize: [1, 1],
          label: {
            show: true, formatter: compact ? g.label : `${g.label} ${up ? '+' : '−'}${Math.abs(g.pct).toFixed(1)}%`, color: '#E6E9EF', fontSize: 11, fontWeight: 500,
            backgroundColor: 'rgba(22,28,40,0.92)', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1, padding: [2, 4], borderRadius: 4,
            offset: [0, up ? -2 : 2],
          },
        })
      })
    }
    const patLines: unknown[] = []
    if (layers.patterns) {
      patterns.slice(0, 2).forEach((pt, pi) => {
        pt.lines.forEach((ln, li) => {
          const st = LINE_STYLE[ln.kind] ?? LINE_STYLE.leg
          const [a, b] = ln.points
          patLines.push([
            { coord: [Math.min(a.idx, n - 1), p(a.price)], lineStyle: { color: st.color, type: st.type, width: st.width, opacity: pi === 0 ? 0.95 : 0.55 } },
            {
              coord: [Math.min(b.idx, n - 1), p(b.price)],
              label: li === 0 ? { show: true, formatter: pt.name, color: '#B3BCD0', fontSize: 11, fontWeight: 500, position: 'insideEndTop', backgroundColor: 'rgba(16,21,31,0.85)', padding: [2, 4], borderRadius: 4 } : { show: false },
            },
          ])
        })
      })
    }
    const series: unknown[] = []
    const contArea: unknown[] = []
    if (extraLen > 0) {
      contArea.push([{ xAxis: xs[lastIdx], itemStyle: { color: 'rgba(148,163,184,0.05)' },
        label: { show: true, position: 'insideTopRight', color: '#8B94A7', fontSize: 11, formatter: after ? t('Dopo · {n} candele', { n: extraLen }) : t('Proiezione · {n} candele', { n: extraLen }) } }, { xAxis: xs[n - 1] }])
    }
    if (ghost) {
      series.push({
        type: 'candlestick', name: ghostLabel ?? t('Analogo'), data: ghostData, barMaxWidth: 12, z: 1, silent: true,
        itemStyle: { color: 'rgba(148,163,184,0.22)', color0: 'rgba(148,163,184,0.08)', borderColor: 'rgba(148,163,184,0.5)', borderColor0: 'rgba(148,163,184,0.35)' },
      })
    }
    series.push({
      type: 'candlestick', name: side === 'current' ? t('Oggi') : t('Analogo'), data, barMaxWidth: 10, z: 3,
      itemStyle: ghost
        ? { color: hexA(C.btc, 0.9), color0: '#10151F', borderColor: C.btc, borderColor0: C.btc }
        : { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down },
      markLine: {
        symbol: 'none', silent: true, animation: false,
        data: [
          { yAxis: 0, lineStyle: { color: 'rgba(148,163,184,0.3)', type: 'dashed' }, label: { show: false } },
          ...(extraLen > 0 ? [{ xAxis: xs[lastIdx], lineStyle: { color: 'rgba(148,163,184,0.55)', type: 'dashed' }, label: { show: true, position: 'end', color: '#B3BCD0', fontSize: 11, formatter: after ? t('Fine finestra') : t('Oggi') } }] : []),
          ...patLines,
        ],
      },
      markArea: contArea.length ? { silent: true, data: contArea } : undefined,
      markPoint: { data: [...legLabels, ...mp], animation: false },
    })
    // ---- continuation after the matched window / projection after today
    if (after && after.length) {
      const pad = new Array(w).fill('-')
      series.push({
        type: 'candlestick', name: t('Dopo'), data: [...pad, ...after.map((c) => [p(c.open), p(c.close), p(c.low), p(c.high)])], barMaxWidth: 10, z: 2, silent: true,
        itemStyle: { color: hexA(C.up, 0.45), color0: hexA(C.down, 0.45), borderColor: hexA(C.up, 0.6), borderColor0: hexA(C.down, 0.6) },
      })
    }
    const lastPct = data.length ? data[data.length - 1][1] : 0
    if (future && future.path.length) {
      const nul = new Array(lastIdx).fill(null)
      const f = (arr: number[]) => [...nul, lastPct, ...arr.map((v) => p(v))]
      if (future.p10 && future.p90) {
        const lo = f(future.p10), hi = f(future.p90)
        series.push({ type: 'line', name: '_p10', data: lo, stack: 'b90', symbol: 'none', lineStyle: { width: 0 }, silent: true, z: 1 })
        series.push({ type: 'line', name: 'P10–P90', data: hi.map((v, i) => (v == null || lo[i] == null ? null : +(v - (lo[i] as number)).toFixed(3))), stack: 'b90', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(91,141,239,0.08)' }, silent: true, z: 1 })
      }
      if (future.p25 && future.p75) {
        const lo = f(future.p25), hi = f(future.p75)
        series.push({ type: 'line', name: '_p25', data: lo, stack: 'b50', symbol: 'none', lineStyle: { width: 0 }, silent: true, z: 1 })
        series.push({ type: 'line', name: 'P25–P75', data: hi.map((v, i) => (v == null || lo[i] == null ? null : +(v - (lo[i] as number)).toFixed(3))), stack: 'b50', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(91,141,239,0.14)' }, silent: true, z: 1 })
      }
      if (future.sel && future.sel.length) {
        const sp = f(future.sel)
        series.push({ type: 'line', name: t('Analogo selezionato'), data: sp, symbol: 'none', z: 4, silent: true, lineStyle: { color: C.grey, width: 1.25, type: 'dashed', opacity: 0.9 } })
      }
      const path = f(future.path)
      const endV = path[path.length - 1] as number
      const lastC = candles[candles.length - 1]?.close || 1
      const dEnd = (future.path[future.path.length - 1] / lastC - 1) * 100
      series.push({ type: 'line', name: t('Mediana analoghi'), data: path, symbol: 'none', z: 5, lineStyle: { color: C.primary, width: 2 },
        markPoint: { symbol: 'circle', symbolSize: 6, itemStyle: { color: C.primary }, data: [{ coord: [xs[n - 1], endV],
          label: { show: true, position: 'left', color: '#E6E9EF', fontSize: 11, backgroundColor: 'rgba(16,21,31,0.85)', padding: [2, 4], borderRadius: 4,
            formatter: compact ? `${dEnd >= 0 ? '+' : '−'}${Math.abs(dEnd).toFixed(1)}%` : `${t('Mediana')} ${dEnd >= 0 ? '+' : '−'}${Math.abs(dEnd).toFixed(1)}% · ${usd(future.path[future.path.length - 1])}` } }] } })
    }
    if (ghostAfter && ghostAfter.length && ghost) {
      const nul = new Array(ghost.length - 1).fill(null)
      series.push({ type: 'line', name: t('Continuazione analogo'), data: [...nul, gp(ghost[ghost.length - 1].close), ...ghostAfter.map((c) => gp(c.close))], symbol: 'none', z: 2,
        lineStyle: { color: C.grey, width: 1.5, type: 'dashed' } })
    }
    if (after && after.length && outcome != null) {
      const endV = p(after[after.length - 1].close)
      series.push({ type: 'scatter', name: '_esito', data: [[xs[n - 1], endV]], symbolSize: 1, silent: true, z: 6,
        label: { show: true, position: 'left', color: '#E6E9EF', fontSize: 11, formatter: `${outcome >= 0 ? '+' : '−'}${Math.abs(outcome).toFixed(1)}%` } })
    }
    if (layers.legs && legs.length) {
      series.push({ type: 'line', name: t('Gambe'), data: zz, connectNulls: true, showSymbol: true, symbol: 'circle', symbolSize: 4, z: 4, silent: true,
        lineStyle: { color: LEG_COLOR, width: 1.6, opacity: 0.85 }, itemStyle: { color: LEG_COLOR } })
    }
    return {
      grid: { left: 6, right: 6, top: 28, bottom: 6, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: 'rgba(148,163,184,0.35)' } },
        formatter: (ps: TipP[]) => {
          const i = ps[0]?.dataIndex ?? 0
          const c = candles[i]
          if (!c && i >= w) {
            const k = i - w
            if (after?.[k]) return `<div style="color:#8B94A7;margin-bottom:4px">${t('Dopo · candela {n}', { n: k + 1 })} · ${fullTime(after[k].time, tf)}</div>` + tipRow('#8B94A7', t('Chiusura'), `${usd(after[k].close)} (${pct(p(after[k].close), 1)})`)
            if (future?.path[k] != null) {
              const lc = candles[candles.length - 1]?.close || 1
              const fromNow = (v: number) => pct((v / lc - 1) * 100, 1)
              return `<div style="color:#8B94A7;margin-bottom:4px">${t('Proiezione · +{n} candele', { n: k + 1 })}${future.times[k] ? ` · ${fullTime(future.times[k], tf)}` : ''}</div>` +
                tipRow(C.primary, t('Mediana analoghi ({n})', { n: future.n }), `${usd(future.path[k])} (${fromNow(future.path[k])})`) +
                (future.p25 && future.p75 ? tipRow('#5B8DEF', 'P25–P75', `${usd(future.p25[k])} – ${usd(future.p75[k])}`) : '') +
                (future.sel?.[k] != null ? tipRow(C.grey, `${t('Analogo selezionato')} · ${future.selLabel ?? ''}`, `${usd(future.sel[k])} (${fromNow(future.sel[k])})`) : '')
            }
            return ''
          }
          if (!c) return ''
          const hit = points.filter((m) => m[side].idx === i)
          const g = ghost?.[i]
          const leg = layers.legs ? legs.find((x) => i >= x.from_idx && i <= x.to_idx) : undefined
          return `<div style="color:#94a3b8;margin-bottom:4px">${t('Candela {n}', { n: i + 1 })} · ${fullTime(c.time, tf)}</div>` +
            tipRow(c.close >= c.open ? C.up : C.down, t('Chiusura'), `${usd(c.close)} (${pct(p(c.close), 1)})`) +
            tipRow('#8B94A7', tr('Massimo', 'High'), `${usd(c.high)} (${pct(p(c.high), 1)})`) +
            tipRow('#8B94A7', t('Minimo'), `${usd(c.low)} (${pct(p(c.low), 1)})`) +
            (g ? tipRow('#8B94A7', `${ghostLabel ?? t('Analogo')} · ${fullTime(g.time, tf)}`, pct(gp(g.close), 1)) : '') +
            (leg ? tipRow(LEG_COLOR, t('Gamba {l} · {n} candele', { l: leg.label, n: leg.candles }), pct(leg.pct, 1)) : '') +
            hit.map((m) => tipRow(pointColor(m.n), `${m.n}. ${side === 'current' ? m.label : m.analog_label}`, '')).join('')
        },
      },
      xAxis: {
        type: 'category', data: xs, boundaryGap: true,
        axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: string) => tickLabel(Number(v), tf) },
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
      },
      yAxis: valueAxis({ position: 'right', scale: false, min: yMin, max: yMax, axisLabel: { ...axisLabel, formatter: (v: number) => `${v > 0 ? '+' : ''}${v}%` } }),
      series,
    }
  }, [candles, points, side, tf, yMin, yMax, active, accent, legs, patterns, layers, ghost, ghostLabel, compact, width, after, future, ghostAfter, outcome])
  return <div ref={wrapRef} className="min-w-0"><EChart option={option} height={height} /></div>
}

// ------------------------------------------------------------------ badge delle figure
export function PatternBadges({ patterns, empty }: { patterns: ChartPattern[]; empty?: string }) {
  if (!patterns.length) return <div className="flex min-h-6 items-center text-xs text-slate-500">{empty ?? t('Nessuna figura classica')}</div>
  return (
    <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
      {patterns.map((p) => (
        <span key={p.key} title={t('Confidenza {n}%', { n: p.confidence.toFixed(0) })}
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-300">
          {p.name}
          <span className="tnum text-slate-400">{p.confidence.toFixed(0)}%</span>
        </span>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ somiglianza grafica (scomposizione)
export function VisualBreakdown({ components }: { components: VisualComponent[] }) {
  return (
    <div className="flex flex-col gap-3.5">
      {components.map((c) => (
        <div key={c.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-slate-200">{c.label} <span className="ml-1 text-2xs font-normal text-slate-500">{t('Peso {n}%', { n: +(c.weight * 100).toFixed(1) })}</span></span>
            <span className="tnum text-sm text-white">{c.score == null ? t('n/d') : `${Math.round(c.score)}%`}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full" style={{ width: `${c.score ?? 0}%`, background: simColor(c.score) }} />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{c.explanation}</p>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ gambe a confronto
export function LegTable({ pairs, cur, ana, when, curLabel }: { pairs: AnalogLegPair[]; cur: AnalogLeg[]; ana: AnalogLeg[]; when: string; /** header of the 'current' column (default: Oggi) */ curLabel?: string }) {
  return (
    <div className="no-scrollbar overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>{t('Gamba')}</th><th className="text-right">{curLabel ?? t('Oggi')}</th><th className="text-right">{whenYear(when)}</th><th className="min-w-[140px]">{t('Somiglianza')}</th></tr></thead>
        <tbody>
          {pairs.map((p, i) => {
            const a = cur[p.current - 1]
            const b = ana[p.analog - 1]
            if (!a || !b) return null
            return (
              <tr key={i}>
                <td className="text-white">G{p.current}{b.n !== p.current ? <span className="ml-1 text-xs font-normal text-slate-500">↔ {t('{n}ª', { n: b.n })}</span> : null}</td>
                <td className="text-right"><span className={clsx('font-medium', a.pct >= 0 ? 'text-up' : 'text-down')}>{pct(a.pct, 1)}</span> <span className="text-xs text-slate-400">{t('In {n} cand.', { n: a.candles })}</span></td>
                <td className="text-right"><span className={clsx('font-medium', b.pct >= 0 ? 'text-up' : 'text-down')}>{pct(b.pct, 1)}</span> <span className="text-xs text-slate-400">{t('In {n} cand.', { n: b.candles })}</span></td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full" style={{ width: `${p.similarity}%`, background: simColor(p.similarity) }} /></div>
                    <span className="tnum text-xs">{Math.round(p.similarity)}%</span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Card-grid columns that keep rows full: n items on one row when they fit, otherwise two balanced rows.
 *  `lg`/`xxl` = max columns at those breakpoints. Use with the `match-grid` classes below. */
export function balancedCols(n: number, lg: number, xxl: number): CSSProperties {
  const fit = (max: number) => (n <= max ? Math.max(1, n) : Math.ceil(n / Math.ceil(n / max)))
  return { '--c-lg': fit(lg), '--c-2xl': fit(xxl) } as CSSProperties
}
export const MATCH_GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(var(--c-lg),minmax(0,1fr))] 2xl:grid-cols-[repeat(var(--c-2xl),minmax(0,1fr))]'

/** Paired bars per aligned leg (today vs analog), zero-centred. Grows to fill the card's free height (min 112px). */
export function LegBars({ pairs, cur, ana, when, curLabel, className }: { pairs: AnalogLegPair[]; cur: AnalogLeg[]; ana: AnalogLeg[]; when: string; curLabel?: string; className?: string }) {
  const rows = pairs.map((p) => ({ n: p.current, a: cur[p.current - 1], b: ana[p.analog - 1], s: p.similarity })).filter((r) => r.a && r.b)
  if (!rows.length) return null
  const max = Math.max(...rows.flatMap((r) => [Math.abs(r.a.pct), Math.abs(r.b.pct)]), 0.1)
  const same = rows.filter((r) => Math.sign(r.a.pct) === Math.sign(r.b.pct)).length
  const avg = rows.reduce((x, r) => x + r.s, 0) / rows.length
  const bar = (v: number, color: string) => (
    <div className="relative h-full w-full max-w-[14px]">
      <div className="absolute inset-x-0 rounded-[2px]" style={{ background: color, height: `${Math.max(1.5, (Math.abs(v) / max) * 50)}%`, ...(v >= 0 ? { bottom: '50%' } : { top: '50%' }) }} />
    </div>
  )
  return (
    <div className={clsx('flex flex-col', className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="label">{t('Ampiezza delle gambe')}</span>
        <span className="flex items-center gap-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: C.btc }} />{curLabel ?? t('Oggi')}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: C.blue }} />{whenYear(when)}</span>
        </span>
      </div>
      <div className="relative min-h-[64px] flex-1">
        <div className="absolute inset-x-0 top-1/2 border-t border-line" />
        <div className="absolute inset-0 flex gap-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex min-w-0 flex-1 justify-center gap-[3px]" title={`G${r.n} · ${pct(r.a.pct, 1)} / ${pct(r.b.pct, 1)}`}>
              {bar(r.a.pct, C.btc)}{bar(r.b.pct, hexA(C.blue, 0.85))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 flex gap-1.5">
        {rows.map((r, i) => <span key={i} className="tnum min-w-0 flex-1 truncate text-center text-2xs text-slate-500">G{r.n}</span>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-3 text-xs text-slate-400">
        <span>{t('Gambe allineate')} <b className="tnum font-semibold text-white">{rows.length}</b></span>
        <span>{t('Stessa direzione')} <b className="tnum font-semibold text-white">{same}/{rows.length}</b></span>
        <span>{t('Somiglianza media')} <b className="tnum font-semibold text-white">{Math.round(avg)}%</b></span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ overlay normalizzato (base 100) + continuazione + proiezione
export function AnalogOverlay({ current, match, window: w, tf, height = 340, median }: {
  current: AnalogCandle[]; match: AnalogMatch; window: number; tf: AnalogTf; height?: number
  /** per-step median across all analogs (absolute prices, rescaled on the live price) — see buildFuture */
  median?: number[]
}) {
  const option = useMemo(() => {
    const ac = match.candles
    const h = Math.max(0, ac.length - w, median?.length ?? 0)
    const n = w + h
    const xs = Array.from({ length: n }, (_, i) => i - (w - 1))
    const cb = current[0]?.close || 1
    const ab = ac[0]?.close || 1
    const cur = [...current.map((c) => +(100 * c.close / cb).toFixed(2)), ...new Array(h).fill(null)]
    const anaWin = ac.slice(0, w).map((c) => +(100 * c.close / ab).toFixed(2))
    const ana = [...anaWin, ...new Array(h).fill(null)]
    const anaEnd = ac[w - 1]?.close || 1
    const cont = [...new Array(w - 1).fill(null), anaWin[w - 1], ...ac.slice(w).map((c) => +(100 * c.close / ab).toFixed(2))]
    const curEnd = cur[w - 1] as number
    const proj = (vals: number[]) => [...new Array(w - 1).fill(null), curEnd, ...vals.map((v) => +(curEnd * v / anaEnd).toFixed(2))]
    const pClose = proj(ac.slice(w).map((c) => c.close))
    const pLow = proj(ac.slice(w).map((c) => c.low))
    const pHigh = proj(ac.slice(w).map((c) => c.high))
    const diff = pHigh.map((v, i) => (v == null || pLow[i] == null ? null : +(v - (pLow[i] as number)).toFixed(2)))
    const curPrice = current[current.length - 1]?.close ?? 0
    const toUsd = (v: number) => usd(curPrice * v / curEnd)
    const med = median?.length && curPrice ? [...new Array(w - 1).fill(null), curEnd, ...median.map((v) => +(curEnd * v / curPrice).toFixed(2))] : null
    const N = {
      cur: t('Attuale'), cont: t('Continuazione analogo'), proj: t('Analogo selezionato su oggi'), med: t('Mediana analoghi'), range: t('Range analogo'),
    }
    const now = tr('Ora', 'Now')
    return {
      grid: { left: 6, right: 6, top: 34, bottom: 6, containLabel: true },
      legend: { ...legendBase, type: 'scroll', pageTextStyle: { color: C.muted }, data: [N.cur, plabel(match.period.label), N.cont, N.proj, ...(med ? [N.med] : [])] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => {
          const x = Number(xs[ps[0]?.dataIndex ?? 0])
          const head = `<div style="color:#94a3b8;margin-bottom:4px">${x === 0 ? now : t('{n} candele', { n: x > 0 ? `+${x}` : x })}</div>`
          return head + ps.filter((p) => p.value != null && !['_low', N.range].includes(p.seriesName)).map((p) =>
            tipRow(p.color, p.seriesName, p.seriesName === N.proj || p.seriesName === N.med ? `${(p.value as number).toFixed(1)} · ${toUsd(p.value as number)}` : (p.value as number).toFixed(1))).join('')
        },
      },
      xAxis: { type: 'category', data: xs.map(String), boundaryGap: false, axisLabel: { ...axisLabel, formatter: (v: string) => (v === '0' ? now : Number(v) > 0 ? `+${v}` : v) }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: valueAxis({ position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(0) } }),
      series: [
        lineSeries('_low', pLow, 'transparent', { stack: 'band', lineStyle: { width: 0 }, tooltip: { show: false } }),
        lineSeries(N.range, diff, 'transparent', { stack: 'band', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(148,163,184,0.10)' } }),
        lineSeries(plabel(match.period.label), ana, C.grey, { lineStyle: { width: 1.5, color: C.grey } }),
        lineSeries(N.cont, cont, C.grey2, { lineStyle: { width: 1.5, color: C.grey2, type: 'dashed' } }),
        lineSeries(N.cur, cur, C.btc, { lineStyle: { width: 2, color: C.btc }, z: 10 }),
        lineSeries(N.proj, pClose, C.blue, {
          lineStyle: { width: 1.5, type: 'dashed', color: C.blue }, z: 9,
          markLine: { symbol: 'none', silent: true, lineStyle: { color: 'rgba(226,232,240,0.45)', type: 'dashed' }, label: { color: C.text, formatter: now, fontSize: 11 }, data: [{ xAxis: '0' }] },
        }),
        ...(med ? [lineSeries(N.med, med, C.primary, { lineStyle: { width: 2, color: C.primary }, z: 11 })] : []),
      ],
    }
  }, [current, match, w, median])
  void tf
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ feature
/** Similarity / quality is not a direction: single neutral blue (dimmed when unavailable). */
export function simColor(s: number | null) {
  return s == null ? '#5B6475' : '#5B8DEF'
}

export function FeatureCard({ f, when }: { f: AnalogFeature; when: string }) {
  const col = simColor(f.similarity)
  const na = f.similarity == null
  return (
    <div className={clsx('flex h-full flex-col gap-2 px-3 py-3', na && 'opacity-60')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold leading-tight text-white">{f.label}</span>
        <span className="tnum shrink-0 text-sm font-bold" style={{ color: col }}>{na ? t('n/d') : `${Math.round(f.similarity!)}%`}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full" style={{ width: `${f.similarity ?? 0}%`, background: col }} />
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
        <div className="min-w-0">
          <div className="label">{t('Oggi')}</div>
          <div className="tnum break-words font-semibold leading-snug text-white">{f.display_current}</div>
        </div>
        {f.similarity != null && f.similarity >= 85 ? <Equal size={14} className="text-slate-500" /> : <ArrowRight size={14} className="text-slate-600" />}
        <div className="min-w-0">
          <div className="label">{whenYear(when)}</div>
          <div className="tnum break-words font-semibold leading-snug text-white">{f.display_analog}</div>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">{f.explanation}</p>
    </div>
  )
}

// ------------------------------------------------------------------ tabella corrispondenze
export function MappingList({ mapping, tf, when, active, onHover, curLabel, twoFrom = '2xl' }: { mapping: AnalogMapping[]; tf: AnalogTf; when: string; active: number | null; onHover: (n: number | null) => void; /** prefix of the 'current' side (default: Oggi) */ curLabel?: string
  /** breakpoint from which long lists (> 6 points) flow in two columns */ twoFrom?: 'xl' | '2xl' }) {
  // long lists flow in two columns on wide screens (keeps the card as tall as its neighbours)
  const two = mapping.length > 6
  return (
    <div className={clsx('grid content-start', two && (twoFrom === 'xl'
      ? 'xl:grid-cols-2 xl:gap-x-6 xl:[&>*:nth-child(2)]:border-t-0 xl:[&>*:nth-child(2)]:pt-0'
      : '2xl:grid-cols-2 2xl:gap-x-6 2xl:[&>*:nth-child(2)]:border-t-0 2xl:[&>*:nth-child(2)]:pt-0'))}>
      {mapping.map((m) => (
        <div
          key={m.n}
          onMouseEnter={() => onHover(m.n)}
          onMouseLeave={() => onHover(null)}
          className={clsx('grid grid-cols-[auto_1fr] gap-3 border-t border-line px-1 py-2.5 transition-colors first:border-t-0 first:pt-0 sm:grid-cols-[auto_1.1fr_1fr_1fr]',
            active === m.n && 'bg-white/[0.03]')}
        >
          <span className={clsx('grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs', active === m.n ? 'border-accent-blue text-white' : 'border-slate-500 text-slate-300')}>{m.n}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
              {m.label}
              {m.same_role && <Check size={14} className="text-up" aria-label={t('Stesso ruolo')} />}
            </div>
            {!m.same_role && <div className="text-xs text-slate-400">{cap(when)}: {m.analog_label.toLowerCase()}</div>}
          </div>
          <div className="col-span-2 grid grid-cols-2 gap-3 sm:col-span-2">
            <div className="min-w-0 text-xs">
              <div className="text-slate-400">{curLabel ? `${curLabel} · ${t('candela {n}', { n: m.current.idx + 1 })}` : t('Oggi · candela {n}', { n: m.current.idx + 1 })}</div>
              <div className="tnum font-semibold text-slate-100">{usd(m.current.price)} <span className={m.current.pct >= 0 ? 'text-up' : 'text-down'}>{pct(m.current.pct, 1)}</span></div>
              <div className="truncate text-slate-500">{curLabel ? ' ' : fullTime(m.current.time, tf)}</div>
            </div>
            <div className="min-w-0 text-xs">
              <div className="text-slate-400">{t('Analogo · candela {n}', { n: m.analog.idx + 1 })}</div>
              <div className="tnum font-semibold text-slate-100">{usd(m.analog.price)} <span className={m.analog.pct >= 0 ? 'text-up' : 'text-down'}>{pct(m.analog.pct, 1)}</span></div>
              <div className="truncate text-slate-500">{fullTime(m.analog.time, tf)}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
