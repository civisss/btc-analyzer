/* Scheda "Analogia di struttura" (Analoghi → ?tab=struttura): il movimento attuale confrontato con quelli passati per
 * sequenza di massimi e minimi ZigZag (HH/HL/LH/LL, BOS/CHoCH), proiezione dei prossimi pivot e backtest walk-forward.
 * I testi sono composti qui (chiavi + numeri dell'API). */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FlaskConical, Scale, GitCompareArrows, History, ListOrdered, Radio, Route, Spline, Target, X } from 'lucide-react'
import { useStructAnalogs, type SaAnalog, type SaAsset, type SaBacktest, type SaBreak, type SaCandle, type SaKind, type SaPivot, type SaProjPivot, type SaTf, type SaUnit, type StructAnalogs } from '../api/structAnalogs'
import type { SaVerdict } from '../api/structAnalogs'
import { useLive } from '../api/live'
import EChart from '../components/charts/EChart'
import { C, axisLabel, hexA, tooltipBase, valueAxis } from '../components/charts/theme'
import { Badge, Card, CardBody, CardHeader, KpiCell, KpiStrip, Legend, MethodNote, ProgressBar, Q, Segmented, Skeleton, clsx, PageActions, SettingsPanel } from '../components/ui'
import { date, dateTime, pct, usd, usdCompact } from '../lib/format'
import { months, t, tfLabel } from '../i18n'
import { usePrice } from './hooks'
import { DCell, tickLabel } from './analogs'
import { T, alpha } from '../theme/tokens'

export const ASSET_LABEL: Record<SaAsset, string> = { btc: 'BTC', usdtd: 'USDT.D', ethbtc: 'ETH/BTC' }
const DEFAULT_MULT: Record<SaTf, number> = { '4h': 3, '1d': 2.5, '1w': 2 }
const PIV_COLOR = T.fg
const PROJ = C.steel
const BRK = T.fg3

// ------------------------------------------------------------------ formattazione
const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/** Value in the asset's unit: $86,234 / $86.2K (short) · 6.652% · 0.02961. */
export function fmtV(v: number | null | undefined, unit: SaUnit, short = false): string {
  if (!fin(v)) return '—'
  if (unit === 'usd') return short ? usdCompact(v, 1) : usd(v)
  if (unit === 'pct') return `${v.toFixed(short ? 2 : 3)}%`
  return v.toFixed(short ? 4 : 5)
}

const p2 = (n: number) => String(n).padStart(2, '0')
/** "2–9 nov" · "28 ott–4 nov" · "15 ott 08–20h" · "dic 2026–gen 2027". */
export function dRange(a: number, b: number, tf: SaTf): string {
  const M = months()
  const A = new Date(a * 1000), B = new Date(b * 1000)
  const dA = A.getUTCDate(), dB = B.getUTCDate(), mA = A.getUTCMonth(), mB = B.getUTCMonth(), yA = A.getUTCFullYear(), yB = B.getUTCFullYear()
  const sameDay = dA === dB && mA === mB && yA === yB
  if (tf === '4h' && sameDay) return A.getTime() === B.getTime() ? `${dA} ${M[mA]} ${p2(A.getUTCHours())}h` : `${dA} ${M[mA]} ${p2(A.getUTCHours())}–${p2(B.getUTCHours())}h`
  if (sameDay) return `${dA} ${M[mA]}`
  if (yA !== yB) return `${dA} ${M[mA]}–${dB} ${M[mB]} '${String(yB).slice(2)}`
  if (mA === mB) return `${dA}–${dB} ${M[mA]}`
  return `${dA} ${M[mA]}–${dB} ${M[mB]}`
}

/** Analog period: "12–28 mar 2021" for short spans, "mar–giu 2021" / "nov 2020–feb 2021" otherwise. */
export function periodLabel(a: number, b: number): string {
  const M = months()
  const A = new Date(a * 1000), B = new Date(b * 1000)
  const yA = A.getUTCFullYear(), yB = B.getUTCFullYear()
  if (b - a < 45 * 86400) return yA === yB ? `${A.getUTCDate()} ${M[A.getUTCMonth()]}–${B.getUTCDate()} ${M[B.getUTCMonth()]} ${yB}` : `${date(a)}–${date(b)}`
  if (yA === yB) return A.getUTCMonth() === B.getUTCMonth() ? `${M[A.getUTCMonth()]} ${yA}` : `${M[A.getUTCMonth()]}–${M[B.getUTCMonth()]} ${yA}`
  return `${M[A.getUTCMonth()]} ${yA}–${M[B.getUTCMonth()]} ${yB}`
}

const kindName = (k: SaKind) => (k === 'high' ? t('Massimo') : t('Minimo'))
const barsTxt = (n: number, tf: SaTf) => (tf === '4h' ? t('{n} candele', { n: Math.round(n) }) : tf === '1w' ? t('{n} sett.', { n: Math.round(n) }) : t('{n} g', { n: Math.round(n) }))
const brkName = (k: SaBreak['kind']) => (k.startsWith('bos') ? 'BOS' : 'CHoCH')

/** Market structure from the last high/low labels: HH+HL bullish, LH+LL bearish, otherwise mixed. */
function structureOf(pivots: SaPivot[]): 'bullish' | 'bearish' | 'mixed' {
  const lh = [...pivots].reverse().find((p) => p.kind === 'high')?.label
  const ll = [...pivots].reverse().find((p) => p.kind === 'low')?.label
  if (lh === 'HH' && ll === 'HL') return 'bullish'
  if (lh === 'LH' && ll === 'LL') return 'bearish'
  return 'mixed'
}
const STRUCT_TXT = { bullish: 'Rialzista', bearish: 'Ribassista', mixed: 'Mista' } as const

// ------------------------------------------------------------------ live (solo BTC)
/** Last candle and pivot in formation updated with the live kline/ticker (BTC only); refetch when a new candle opens. */
function useLiveCurrent(d: StructAnalogs | undefined, refetch: () => void) {
  const isBtc = d?.asset === 'btc'
  const kline = useLive((s) => (isBtc && d ? s.klines[d.tf] ?? null : null))
  const price = usePrice()
  const lastT = d?.current.candles[d.current.candles.length - 1]?.time ?? 0
  const asked = useRef(0)
  useEffect(() => {
    // the live kline moved to a new candle: the backend recalculates at the close → reload once per candle
    if (kline && lastT && kline.time > lastT && asked.current !== kline.time) {
      asked.current = kline.time
      const id = setTimeout(refetch, 4000)
      return () => clearTimeout(id)
    }
  }, [kline, lastT, refetch])
  return useMemo(() => {
    if (!d) return null
    const cs = d.current.candles
    const pend = d.current.pending
    if (!isBtc || !cs.length) return { candles: cs, pending: pend, price: d.current.last.price, live: false }
    const last = cs[cs.length - 1]
    let upd: SaCandle | null = null
    if (kline && kline.time === last.time) upd = { ...last, high: Math.max(last.high, kline.high), low: Math.min(last.low, kline.low), close: kline.close }
    else if (price && price > 0 && Math.abs(price / last.close - 1) < 0.2) upd = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }
    if (!upd) return { candles: cs, pending: pend, price: last.close, live: false }
    let p2_ = pend
    if (pend.kind === 'high' && upd.high > pend.price) p2_ = { ...pend, price: upd.high, time: upd.time, idx: cs.length - 1, move: (upd.high / (pend.price / (1 + pend.move / 100)) - 1) * 100 }
    if (pend.kind === 'low' && upd.low < pend.price) p2_ = { ...pend, price: upd.low, time: upd.time, idx: cs.length - 1, move: (upd.low / (pend.price / (1 + pend.move / 100)) - 1) * 100 }
    return { candles: [...cs.slice(0, -1), upd], pending: p2_, price: upd.close, live: true }
  }, [d, isBtc, kline, price])
}

// ------------------------------------------------------------------ grafico
type TipP = { seriesId?: string; data?: { value?: [number, number]; ref?: unknown }; axisValue?: number; value?: unknown }
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`

export type SaScale = 'pct' | 'log'
export type SaStyle = 'line' | 'candles'

/**
 * One structure chart (time axis). Matched pivots = light numbered dots with their HH/HL/LH/LL label; BOS/CHoCH = dotted
 * line from the broken pivot to the breaking close. Analog side: the tract after the last matched pivot is dimmed and its
 * next pivots are violet. Current side: pivot in formation (dashed ring) and projected pivots (violet, P25–P75 box).
 */
export function StructChart({
  candles, pivots, breaks, unit, tf, scale, style, side, endTime, proj, projFirstN = 0, pending, accent, height, compact,
}: {
  candles: SaCandle[]; pivots: SaPivot[]; breaks: SaBreak[]; unit: SaUnit; tf: SaTf; scale: SaScale; style: SaStyle
  side: 'analog' | 'current'; endTime?: number; proj?: SaProjPivot[]; projFirstN?: number
  pending?: StructAnalogs['current']['pending'] | null; accent: string; height: number; compact: boolean
}) {
  const option = useMemo(() => {
    const base = pivots.find((p) => p.n === 1)?.price ?? candles[0]?.close ?? 1
    const y = (v: number) => (scale === 'pct' ? +((v / base - 1) * 100).toFixed(3) : v)
    const cut = side === 'analog' && endTime ? endTime : Infinity
    const main = candles.filter((c) => c.time <= cut)
    const after = candles.filter((c) => c.time > cut)
    const lastC = candles[candles.length - 1]
    const xMin = candles[0]?.time ?? 0
    const xMaxData = lastC?.time ?? 0
    const projMax = proj?.length ? Math.max(...proj.map((q) => q.t_hi)) : 0
    const step = candles.length > 1 ? candles[1].time - candles[0].time : 86400
    const xMax = Math.max(xMaxData, projMax) + step * 2
    const fmtAx = (v: number) => (scale === 'pct' ? `${v > 0 ? '+' : ''}${+v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%` : fmtV(v, unit, true))
    const series: unknown[] = []
    const ohlc = (c: SaCandle) => [c.time * 1000, y(c.open), y(c.close), y(c.low), y(c.high)]
    const markLines: unknown[] = breaks.map((b) => [
      { coord: [b.from_time * 1000, y(b.level)], lineStyle: { color: BRK, type: 'dotted', width: 1.25, opacity: 0.9 } },
      { coord: [b.time * 1000, y(b.level)], label: { show: !compact, position: 'end', formatter: brkName(b.kind), color: BRK, fontSize: 10, distance: 4 } },
    ])
    const areas: unknown[] = []
    if (side === 'analog' && after.length) {
      markLines.push({ xAxis: cut * 1000, lineStyle: { color: alpha(T.fg3, 0.5), type: 'dashed', width: 1 }, label: { show: true, position: 'end', formatter: t('Fine tratto'), color: T.fg2, fontSize: 11 } })
      areas.push([{ xAxis: cut * 1000, itemStyle: { color: alpha(T.fg3, 0.045) }, label: { show: !compact, position: 'insideTopRight', formatter: t('Dopo'), color: T.fg3, fontSize: 11 } }, { xAxis: xMaxData * 1000 }])
    }
    if (side === 'current' && proj?.length) {
      markLines.push({ xAxis: xMaxData * 1000, lineStyle: { color: alpha(T.fg3, 0.5), type: 'dashed', width: 1 }, label: { show: true, position: 'end', formatter: t('Oggi'), color: T.fg2, fontSize: 11 } })
      areas.push([{ xAxis: xMaxData * 1000, itemStyle: { color: alpha(T.steel, 0.035) } }, { xAxis: xMax * 1000 }])
    }
    const mainSeriesExtra = { markLine: { symbol: ['none', 'none'], silent: true, animation: false, data: markLines }, markArea: areas.length ? { silent: true, data: areas } : undefined }
    if (style === 'candles') {
      series.push({ type: 'candlestick', id: 'px', name: t('Prezzo'), data: main.map(ohlc), barMaxWidth: 8, z: 3,
        itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down }, ...mainSeriesExtra })
      if (after.length) series.push({ type: 'candlestick', id: 'px2', name: t('Dopo'), data: after.map(ohlc), barMaxWidth: 8, z: 2,
        itemStyle: { color: hexA(C.up, 0.35), color0: hexA(C.down, 0.35), borderColor: hexA(C.up, 0.45), borderColor0: hexA(C.down, 0.45) } })
    } else {
      series.push({ type: 'line', id: 'px', name: t('Prezzo'), data: main.map((c) => [c.time * 1000, y(c.close)]), showSymbol: false, z: 3,
        lineStyle: { color: accent, width: 1.5 }, itemStyle: { color: accent }, ...mainSeriesExtra })
      if (after.length) series.push({ type: 'line', id: 'px2', name: t('Dopo'), data: [main[main.length - 1], ...after].filter(Boolean).map((c) => [c.time * 1000, y(c.close)]),
        showSymbol: false, z: 2, lineStyle: { color: hexA(T.fg3, 0.55), width: 1.4 }, itemStyle: { color: T.fg3 } })
    }
    // ---- pivot numerati + etichette di struttura
    const off = (k: SaKind) => (k === 'high' ? -11 : 11)
    series.push({
      type: 'scatter', id: 'piv', name: t('Pivot'), symbol: 'circle', symbolSize: 17, z: 6,
      data: pivots.map((p) => ({
        value: [p.time * 1000, y(p.price)], ref: p, symbolOffset: [0, off(p.kind)],
        itemStyle: { color: p.after ? PROJ : PIV_COLOR, borderColor: T.surface, borderWidth: 1.5 },
        label: { show: true, position: 'inside', formatter: String(p.n), color: p.after ? T.fg : T.bg, fontSize: 10, fontWeight: 700 },
      })),
    })
    series.push({
      type: 'scatter', id: 'pivlab', name: '_lab', symbolSize: 1, silent: true, z: 5, tooltip: { show: false }, itemStyle: { color: 'transparent' },
      data: pivots.filter((p) => p.label).map((p) => ({
        value: [p.time * 1000, y(p.price)],
        label: { show: true, position: p.kind === 'high' ? 'top' : 'bottom', distance: 22, formatter: p.label, color: p.after ? PROJ : T.fg2, fontSize: 11, fontWeight: 600 },
      })),
    })
    // ---- pivot in formazione
    if (pending) {
      series.push({
        type: 'scatter', id: 'pend', name: t('In formazione'), symbol: 'circle', symbolSize: 15, z: 6,
        data: [{ value: [pending.time * 1000, y(pending.price)], ref: pending, symbolOffset: [0, off(pending.kind)],
          label: { show: !compact, position: pending.kind === 'high' ? 'top' : 'bottom', distance: 20, formatter: t('In formazione'), color: T.fg3, fontSize: 10 } }],
        itemStyle: { color: alpha(T.steel, 0.12), borderColor: PROJ, borderType: 'dashed', borderWidth: 1.5 },
      })
    }
    // ---- pivot proiettati
    if (proj?.length && lastC) {
      series.push({
        type: 'line', id: 'ppath', name: '_path', silent: true, z: 4, symbol: 'none',
        data: [[lastC.time * 1000, y(lastC.close)], ...proj.map((q) => [q.time * 1000, y(q.price)])],
        lineStyle: { color: PROJ, type: 'dashed', width: 1.25, opacity: 0.75 },
        markArea: { silent: true, data: proj.map((q) => [
          { coord: [q.t_lo * 1000, y(q.lo)], itemStyle: { color: hexA(PROJ, 0.09), borderColor: hexA(PROJ, 0.4), borderWidth: 1, borderType: 'dashed' } },
          { coord: [Math.max(q.t_hi, q.t_lo + step / 2) * 1000, y(q.hi)] },
        ]) },
      })
      series.push({
        type: 'scatter', id: 'proj', name: t('Pivot proiettato'), symbol: 'circle', symbolSize: 17, z: 7,
        data: proj.map((q) => ({
          value: [q.time * 1000, y(q.price)], ref: q, symbolOffset: [0, off(q.kind)],
          itemStyle: { color: PROJ, borderColor: T.surface, borderWidth: 1.5 },
          label: { show: true, position: 'inside', formatter: String(projFirstN + q.h - 1), color: T.fg, fontSize: 10, fontWeight: 700 },
        })),
      })
      // label overlap: same-side labels closer than ~110px (h1 and h3) are stacked further out
      const plotW = 900
      const xpx = (ts: number) => ((ts - xMin) / Math.max(1, xMax - xMin)) * plotW
      series.push({
        type: 'scatter', id: 'projlab', name: '_plab', symbolSize: 1, silent: true, z: 7, tooltip: { show: false }, itemStyle: { color: 'transparent' },
        data: proj.map((q, i) => {
          const clash = proj.slice(0, i).some((o) => o.kind === q.kind && Math.abs(xpx(o.time) - xpx(q.time)) < (compact ? 140 : 120))
          return {
            value: [q.time * 1000, y(q.price)],
            label: {
              show: true, position: q.kind === 'high' ? 'top' : 'bottom', distance: 22 + (clash ? 30 : 0), lineHeight: 14,
              formatter: compact ? `{a|${q.label} ${fmtV(q.price, unit, true)}}` : `{a|${q.label} ~${fmtV(q.price, unit, true)}}\n{b|${dRange(q.t_lo, q.t_hi, tf)}}`,
              rich: { a: { color: T.fg, fontSize: 11, fontWeight: 600 }, b: { color: T.fg2, fontSize: 10 } },
              backgroundColor: alpha(T.surface, 0.82), padding: [3, 5], borderRadius: 4,
            },
          }
        }),
      })
    }
    const byTime = new Map(candles.map((c) => [c.time * 1000, c]))
    return {
      grid: { left: 6, right: 6, top: 34, bottom: 6, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'axis', confine: true, axisPointer: { type: 'line', lineStyle: { color: alpha(T.fg3, 0.35) } },
        formatter: (raw: TipP[] | TipP) => {
          const ps = Array.isArray(raw) ? raw : [raw]
          const ms = Number(ps[0]?.axisValue ?? (ps[0]?.data?.value?.[0]))
          const c = byTime.get(ms)
          const rel = (v: number) => (scale === 'pct' ? ` (${pct((v / base - 1) * 100, 1)})` : '')
          let h = `<div style="color:${T.fg3};margin-bottom:4px">${tf === '4h' ? dateTime(ms / 1000) : date(ms / 1000)}</div>`
          if (c) h += tipRow(c.close >= c.open ? C.up : C.down, t('Chiusura'), `${fmtV(c.close, unit)}${rel(c.close)}`) +
            (style === 'candles' ? tipRow(T.fg3, t('Massimo'), fmtV(c.high, unit)) + tipRow(T.fg3, t('Minimo'), fmtV(c.low, unit)) : '')
          for (const p of ps) {
            const ref = p.data?.ref as SaPivot | SaProjPivot | undefined
            if (!ref) continue
            if (p.seriesId === 'piv') {
              const v = ref as SaPivot
              h += tipRow(v.after ? PROJ : PIV_COLOR, `${v.n}. ${kindName(v.kind)}${v.label ? ` ${v.label}` : ''}`, fmtV(v.price, unit))
            } else if (p.seriesId === 'proj') {
              const q = ref as SaProjPivot
              h += tipRow(PROJ, `${projFirstN + q.h - 1}. ${t('Proiezione')} · ${kindName(q.kind)} ${q.label}`, fmtV(q.price, unit)) +
                tipRow('transparent', 'P25–P75', `${fmtV(q.lo, unit, true)} – ${fmtV(q.hi, unit, true)}`) +
                tipRow('transparent', t('Quando'), dRange(q.t_lo, q.t_hi, tf)) +
                (q.btc ? tipRow(C.price, t('BTC stimato'), `${usdCompact(q.btc.price, 1)} (${usdCompact(q.btc.lo, 1)}–${usdCompact(q.btc.hi, 1)})`) : '')
            } else if (p.seriesId === 'pend') {
              const q = ref as unknown as StructAnalogs['current']['pending']
              h += tipRow(PROJ, `${t('In formazione')} · ${kindName(q.kind)}`, `${fmtV(q.price, unit)} (${pct(q.move, 1)})`)
            }
          }
          return h
        },
      },
      xAxis: {
        type: 'time', min: xMin * 1000, max: xMax * 1000,
        axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: number) => tickLabel(v / 1000, tf) },
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
      },
      yAxis: scale === 'log'
        ? valueAxis({ type: 'log', logBase: 10, position: 'right', scale: true, min: (e: { min: number }) => e.min / 1.06, max: (e: { max: number }) => e.max * 1.06, axisLabel: { ...axisLabel, formatter: fmtAx } })
        : valueAxis({ position: 'right', scale: true, boundaryGap: ['9%', '9%'], axisLabel: { ...axisLabel, formatter: fmtAx } }),
      series,
    }
  }, [candles, pivots, breaks, unit, tf, scale, style, side, endTime, proj, projFirstN, pending, accent, compact])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ pezzi della scheda
const fmtP = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(p < 0.1 ? 3 : 2))

const VERDICT: Record<SaVerdict, string> = {
  none: 'Nessun effetto distinguibile dal caso', strong: 'Effetto significativo e stabile', anecdotal: 'Troppo pochi casi: aneddotico', weak: 'Effetto debole e instabile',
}

function VerdictBadge({ v }: { v: SaVerdict | null | undefined; short?: boolean }) {
  if (!v) return null
  const cls = v === 'strong' ? 'bg-accent/10 text-white ring-accent/30' : v === 'weak' ? 'bg-warn/10 text-warn ring-warn/25'
    : 'bg-white/[0.04] text-fg-2 ring-line'
  const dot = v === 'strong' ? 'bg-accent' : v === 'weak' ? 'bg-warn' : v === 'anecdotal' ? 'bg-fg-4' : 'bg-fg-3'
  const label = { none: t('Caso'), weak: t('Debole'), strong: t('Significativo'), anecdotal: t('Aneddotico') }[v]
  return (
    <span className={clsx('inline-flex h-5 max-w-full items-center gap-1.5 rounded-full px-2 text-2xs font-medium ring-1 ring-inset', cls)} title={t(VERDICT[v])}>
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <span className="truncate">{label}</span>
    </span>
  )
}

function Slider({ label, value, min, max, step = 1, onChange, fmt }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="flex min-w-[160px] flex-1 flex-col gap-2">
      <span className="flex items-baseline justify-between gap-2"><span className="label">{label}</span><span className="tnum text-sm text-white">{fmt ? fmt(value) : value}</span></span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function useDebounced<V>(v: V, ms = 450) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms)
    return () => clearTimeout(id)
  }, [v, ms])
  return d
}

function LabelSeq({ labels, className }: { labels: (string | null)[]; className?: string }) {
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-1', className)}>
      {labels.map((l, i) => (
        <span key={i} className={clsx('tnum rounded px-1 text-2xs font-semibold ring-1 ring-inset',
          l === 'HH' || l === 'HL' ? 'text-up ring-up/25' : l === 'LH' || l === 'LL' ? 'text-down ring-down/25' : 'text-fg-3 ring-line')}>{l ?? '·'}</span>
      ))}
    </span>
  )
}

function verdictSentence(bt: SaBacktest): string {
  if (bt.verdict === 'strong') return t('Su {n} casi la proiezione strutturale ha battuto entrambe le baseline in modo significativo e stabile nelle due metà del campione.', { n: bt.n })
  if (bt.verdict === 'weak') return t('Vantaggio piccolo o non significativo sulle baseline: usala come ipotesi di studio, non come previsione.')
  if (bt.verdict === 'anecdotal') return t('Troppo pochi casi ({n}) per giudicare: abbassa la soglia ZigZag o il numero di swing per avere più storia.', { n: bt.n })
  return t('Nessun vantaggio dimostrato sulle baseline: la somiglianza di struttura non aggiunge informazione misurabile su questa serie.')
}

const fmtR = (v: number | null | undefined) => (fin(v) ? v.toFixed(2) : '—')

function BacktestCard({ bt, tf, className }: { bt: SaBacktest; tf: SaTf; className?: string }) {
  if (!bt.n || !bt.model || !bt.base_median || !bt.base_random) {
    return (
      <Card className={className}>
        <CardHeader title={t('Backtest walk-forward')} icon={<FlaskConical />} subtitle={t('Nessun istante con abbastanza candidati')} />
        <CardBody><p className="text-sm text-fg-3">{verdictSentence(bt)}</p></CardBody>
      </Card>
    )
  }
  const m = bt.model, b = bt.base_median, r = bt.base_random
  const rows: { k: string; m: string; b: string; r: string; best: 'm' | 'b' | 'r' | null }[] = [
    { k: t('Etichetta corretta (prossimo pivot)'), m: pct(m.hit, 0, false), b: pct(b.hit, 0, false), r: pct(r.hit, 0, false), best: m.hit >= Math.max(b.hit, r.hit) ? 'm' : null },
    { k: t('Errore di prezzo mediano'), m: pct(m.err_med, 1, false), b: pct(b.err_med, 1, false), r: pct(r.err_med, 1, false), best: m.err_med <= Math.min(b.err_med, r.err_med) ? 'm' : null },
    { k: t('Errore di tempo mediano'), m: barsTxt(m.time_err_med, tf), b: barsTxt(b.time_err_med, tf), r: barsTxt(r.time_err_med, tf), best: m.time_err_med <= Math.min(b.time_err_med, r.time_err_med) ? 'm' : null },
    { k: t('Copertura P25–P75 (attesa 50%)'), m: pct(m.cov, 0, false), b: '—', r: '—', best: null },
  ]
  return (
    <Card className={className}>
      <CardHeader title={t('Backtest walk-forward')} icon={<FlaskConical />}
        subtitle={t('{n} conferme di pivot · {a} → {b} · solo dati noti a ogni istante', { n: bt.n, a: date(bt.from), b: date(bt.to) })}
        right={<VerdictBadge v={bt.verdict} short />} />
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-fg-2">{verdictSentence(bt)}</p>
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[440px] text-sm">
            <thead>
              <tr className="text-left">
                <th className="label px-1 pb-2 font-normal">{t('Metrica')}</th>
                <th className="label px-1 pb-2 text-right font-normal">{t('Struttura')}</th>
                <th className="label px-1 pb-2 text-right font-normal" title={t('Prossimo swing = ampiezza e durata mediane storiche nella direzione alternata')}>{t('Ampiezza mediana')}</th>
                <th className="label px-1 pb-2 text-right font-normal" title={t('Stessa struttura, analoghi scelti a caso (400 estrazioni)')}>{t('Analogo casuale')}</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {rows.map((x) => (
                <tr key={x.k} className="border-t border-line">
                  <td className="px-1 py-2 text-fg-2">{x.k}</td>
                  <td className={clsx('px-1 py-2 text-right', x.best === 'm' ? 'font-semibold text-white' : 'text-fg')}>{x.m}</td>
                  <td className="px-1 py-2 text-right text-fg-3">{x.b}</td>
                  <td className="px-1 py-2 text-right text-fg-3">{x.r}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dgrid grid-cols-2 2xl:grid-cols-4">
          <DCell label={t('Errore vs mediana')} value={fmtR(bt.mase)} foot={t('< 1 = meglio')} title={t('Rapporto tra errori medi di prezzo (MASE-like)')} />
          <DCell label={t('Errore vs casuale')} value={fmtR(bt.mase_random)} foot={`p ${fmtP(bt.p_err_random)}`} title={t('p = quota di estrazioni casuali con errore medio non peggiore')} />
          <DCell label={t('Test del segno')} value={fmtP(bt.p_err_median)} foot={t('Vs ampiezza mediana')} title={t('Quante volte l\'errore è minore di quello della baseline, contro il 50% atteso')} />
          <DCell label={t('2° pivot')} value={pct(bt.next2?.hit, 0, false)} foot={t('Baseline {x}', { x: pct(bt.next2?.base_hit, 0, false) })} title={t('Etichetta corretta del secondo pivot proiettato')} />
        </div>
        {!!bt.halves?.length && (
          <div className="flex flex-col gap-1.5">
            <span className="label">{t('Stabilità nel tempo')}</span>
            {bt.halves.map((hf) => (
              <div key={hf.from} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 text-xs text-fg-3">
                <span>{date(hf.from)} → {date(hf.to)} · {hf.n} {t('casi')}</span>
                <span className="tnum">{t('Etichetta {a} vs {b}', { a: pct(hf.hit, 0, false), b: pct(hf.base_hit, 0, false) })} · {t('errore rel. {x}', { x: fmtR(hf.mase) })}</span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function RecentCard({ bt, unit, tf, className }: { bt: SaBacktest; unit: SaUnit; tf: SaTf; className?: string }) {
  const rows = [...(bt.recent ?? [])].reverse()
  return (
    <Card className={clsx('flex flex-col', className)}>
      <CardHeader title={t('Ultimi casi del backtest')} icon={<History />} subtitle={t('Proiezione al momento della conferma vs pivot reale')} />
      <CardBody className="flex min-h-0 flex-1 flex-col px-2 sm:px-3">
        {rows.length ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((r) => (
              <div key={r.time} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-line px-2 py-2 last:border-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 text-sm text-fg">
                    <span className="tnum text-fg-3">{tf === '4h' ? dateTime(r.time) : date(r.time)}</span>
                    <span>{t('Atteso')} <b className={r.hit ? 'text-white' : 'text-fg-2'}>{r.pred_label}</b> · {t('reale')} <b className="text-white">{r.actual_label}</b></span>
                  </div>
                  <div className="tnum text-xs text-fg-3">
                    {fmtV(r.pred, unit, true)} ({fmtV(r.lo, unit, true)}–{fmtV(r.hi, unit, true)}) → {fmtV(r.actual, unit, true)} · {t('errore {x}', { x: pct(r.err, 1, false) })}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span title={r.hit ? t('Etichetta corretta') : t('Etichetta sbagliata')} className={clsx('grid h-5 w-5 place-items-center rounded-full', r.hit ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn')}>{r.hit ? <Check size={12} /> : <X size={12} />}</span>
                  <span title={r.inside ? t('Prezzo dentro P25–P75') : t('Prezzo fuori da P25–P75')} className={clsx('rounded px-1.5 text-2xs ring-1 ring-inset', r.inside ? 'text-fg ring-white/15' : 'text-fg-4 ring-line')}>P25–75</span>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="px-2 text-sm text-fg-3">{t('Nessun caso disponibile.')}</p>}
      </CardBody>
    </Card>
  )
}

function ProjectionCard({ d, proj, title, analog, pending, className }: { d: StructAnalogs; proj: SaProjPivot[]; title: string; analog?: SaAnalog; pending: StructAnalogs['current']['pending']; className?: string }) {
  const firstN = d.k + 2
  return (
    <Card className={clsx('flex flex-col', className)}>
      <CardHeader title={t('Prossimi pivot')} icon={<Target />} subtitle={title} />
      <CardBody className="flex flex-col justify-between gap-4">
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[460px] text-sm">
            <thead>
              <tr className="text-left">
                <th className="label px-1 pb-2 font-normal">#</th>
                <th className="label px-1 pb-2 font-normal">{t('Pivot')}</th>
                <th className="label px-1 pb-2 text-right font-normal">{t('Livello')}</th>
                <th className="label px-1 pb-2 text-right font-normal">{t('Da ora')}</th>
                <th className="label px-1 pb-2 font-normal">{t('Quando (P25–P75)')}</th>
                {d.asset !== 'btc' && <th className="label px-1 pb-2 text-right font-normal">{t('BTC stimato')}</th>}
              </tr>
            </thead>
            <tbody className="tnum">
              {proj.map((q) => (
                <tr key={q.h} className="border-t border-line align-top">
                  <td className="px-1 py-2"><span className="grid h-5 w-5 place-items-center rounded-full text-2xs font-bold text-white" style={{ background: PROJ }}>{firstN + q.h - 1}</span></td>
                  <td className="px-1 py-2">
                    <div className="text-white">{kindName(q.kind)} <b>{q.label}</b></div>
                    <div className="text-xs text-fg-3">{q.reached ? t('Già toccato dal pivot in formazione') : q.agree != null ? t('{n}% degli analoghi concorda', { n: Math.round(q.agree) }) : t('Analogo selezionato')}</div>
                  </td>
                  <td className="px-1 py-2 text-right">
                    <div className="font-semibold text-white">~{fmtV(q.price, d.unit)}</div>
                    <div className="text-xs text-fg-3">{fmtV(q.lo, d.unit, true)}–{fmtV(q.hi, d.unit, true)}</div>
                  </td>
                  <td className={clsx('px-1 py-2 text-right', d.asset !== 'btc' ? 'text-fg' : q.change >= 0 ? 'text-up' : 'text-down')}>{pct(q.change, 1)}</td>
                  <td className="px-1 py-2 text-fg-2">{dRange(q.t_lo, q.t_hi, d.tf)}<div className="text-xs text-fg-4">{t('Centrale {x}', { x: dRange(q.time, q.time, d.tf) })}</div></td>
                  {d.asset !== 'btc' && (
                    <td className="px-1 py-2 text-right">
                      <div className="text-white">{q.btc ? `~${usdCompact(q.btc.price, 1)}` : '—'}</div>
                      <div className="text-xs text-fg-3">{q.btc ? `${usdCompact(q.btc.lo, 1)}–${usdCompact(q.btc.hi, 1)}` : ''}</div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {analog && <SwingCompare d={d} analog={analog} />}
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="label">{t('Tratto attuale vs analogo #{r}', { r: analog?.rank ?? 1 })}</span>
          <div className="dgrid grid-cols-2 sm:grid-cols-4">
            <DCell label={t('Swing medio')} value={pct(d.current.scale.amp, 1, false)} foot={analog ? t('Analogo {x}', { x: pct(analog.scale.amp, 1, false) }) : undefined} />
            <DCell label={t('Durata media')} value={barsTxt(d.current.scale.bars, d.tf)} foot={analog ? t('Analogo {x}', { x: barsTxt(analog.scale.bars, d.tf) }) : undefined} />
            <DCell label={t('In formazione')} value={pct(pending.move, 1)} foot={`${kindName(pending.kind)} ${pending.label} · ${fmtV(pending.price, d.unit, true)}`} />
            <DCell label={t("Poi nell'analogo")} value={analog ? <span className={d.asset !== 'btc' ? 'text-white' : analog.outcome[0].change >= 0 ? 'text-up' : 'text-down'}>{pct(analog.outcome[0].change, 1)}</span> : '—'}
              foot={analog ? t('{l} dopo {x}', { l: analog.outcome[0].label ?? '—', x: barsTxt(analog.outcome[0].bars, d.tf) }) : undefined} />
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

/** USDT.D / ETH-BTC → BTC translation: method, fit and backtest check (full-width card). */
function TranslationCard({ d }: { d: StructAnalogs }) {
  const tr = d.translation
  const btb = d.backtest.btc
  return (
    <Card>
      <CardHeader title={t('Traduzione in BTC')} icon={<Scale />} subtitle={t('Dal pivot proiettato di {a} al prezzo di BTC', { a: ASSET_LABEL[d.asset] })}
        right={tr ? <Badge color={tr.strength === 'weak' ? 'warn' : tr.strength === 'moderate' ? 'slate' : 'btc'}>{t(tr.strength === 'strong' ? 'Relazione forte' : tr.strength === 'moderate' ? 'Relazione moderata' : 'Relazione debole')}</Badge> : null} />
      <CardBody className="flex flex-col gap-3">
        {tr ? (
              <>
                <p className="text-xs leading-relaxed text-fg-3">
                  {t('BTC ≈ BTC attuale × ({a} / {a} attuale)^β, con β stimata swing per swing sugli ultimi {n} swing di {a} (regressione per l\'origine dei Δlog). L\'intervallo somma P25–P75 della proiezione e l\'errore residuo.', { a: ASSET_LABEL[d.asset], n: tr.n })}
                </p>
                <div className="dgrid grid-cols-2 lg:grid-cols-4">
                  <DCell label={t('Elasticità β')} value={tr.beta.toFixed(2)} foot={t('Per swing')} title={t('Δlog BTC per Δlog {a}', { a: ASSET_LABEL[d.asset] })} />
                  <DCell label="R²" value={tr.r2.toFixed(2)} foot={t('Su {n} swing', { n: tr.n })} />
                  <DCell label={t('Errore BTC')} value={btb ? pct(btb.err_med, 1, false) : '—'} foot={btb ? t('«BTC invariato» {x}', { x: pct(btb.base_err_med, 1, false) }) : undefined} />
                  <DCell label={t('Direzione BTC')} value={btb ? pct(btb.dir_hit, 0, false) : '—'} foot={btb ? t('Copertura {x}', { x: pct(btb.cov, 0, false) }) : undefined} />
                </div>
                {btb && (btb.mase ?? 9) >= 1 && (
                  <p className="text-xs text-warn/90">{t('Nel backtest il prezzo BTC tradotto non è più vicino al pivot reale di un semplice «BTC invariato»: la traduzione è indicativa, non una stima affidabile.')}</p>
                )}
              </>
            ) : <p className="text-xs text-fg-3">{t('Relazione non stimabile: troppi pochi swing con BTC allineato.')}</p>}
      </CardBody>
    </Card>
  )
}

/** Swing by swing: today's last K legs vs the selected analog's (size % and duration). */
function SwingCompare({ d, analog }: { d: StructAnalogs; analog: SaAnalog }) {
  const step = d.analogs[0]?.candles.length > 1 ? d.analogs[0].candles[1].time - d.analogs[0].candles[0].time : 86400
  const ap = analog.pivots.filter((p) => !p.after)
  const ana = ap.slice(1).map((p, i) => ({ amp: (p.price / ap[i].price - 1) * 100, bars: (p.time - ap[i].time) / step }))
  const rows: [string, { amp: number; bars: number }[]][] = [[t('Oggi'), d.current.swings], [t('Analogo #{r}', { r: analog.rank }), ana]]
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="label">{t('Swing per swing')}</span>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[440px] text-xs">
          <thead><tr className="text-left">
            <th className="label px-1 pb-1.5 font-normal" />
            {d.current.swings.map((_, i) => <th key={i} className="label px-1 pb-1.5 text-right font-normal">{`${i + 1}→${i + 2}`}</th>)}
          </tr></thead>
          <tbody className="tnum">
            {rows.map(([name, sw]) => (
              <tr key={name} className="border-t border-line">
                <td className="whitespace-nowrap px-1 py-1.5 text-fg-2">{name}</td>
                {sw.map((x, i) => (
                  <td key={i} className="px-1 py-1.5 text-right">
                    <div className={d.asset !== 'btc' ? 'text-fg' : x.amp >= 0 ? 'text-up' : 'text-down'}>{pct(x.amp, 1)}</div>
                    <div className="text-fg-4">{barsTxt(x.bars, d.tf)}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AnalogList({ d, sel, onSel, className }: { d: StructAnalogs; sel: number; onSel: (i: number) => void; className?: string }) {
  return (
    <Card className={clsx('flex flex-col', className)}>
      <CardHeader title={t('Analoghi di struttura')} icon={<ListOrdered />}
        subtitle={t('{n} candidati con la stessa sequenza · clicca per confrontare', { n: d.history.candidates })} />
      <CardBody className="flex flex-1 flex-col justify-between gap-1.5 px-3 sm:px-4">
        {d.analogs.map((a, i) => {
          const o = a.outcome[0]
          return (
            <button key={a.rank} onClick={() => onSel(i)}
              className={clsx('grid grid-cols-[auto_1fr_auto] items-center gap-x-3 rounded-xl border px-3 py-2 text-left transition-colors',
                i === sel ? 'border-accent/50 bg-accent/[0.06]' : 'border-transparent hover:border-line hover:bg-white/[0.02]')}>
              <span className="tnum text-xs text-fg-3">#{a.rank}</span>
              <div className="min-w-0">
                <div className="truncate text-sm text-white">{periodLabel(a.start, a.end)}</div>
                <div className="mt-1 flex items-center gap-2">
                  <ProgressBar value={a.similarity} color={T.accent} className="h-1 max-w-[140px]" />
                  <span className="tnum text-2xs text-fg-3">{Math.round(a.similarity)}%</span>
                </div>
                <LabelSeq labels={a.labels} className="mt-1.5" />
              </div>
              <div className="text-right">
                <div className="text-xs text-fg-3">{t('Poi')} <b className={clsx(o.label === 'HH' || o.label === 'HL' ? 'text-up' : 'text-down')}>{o.label}</b></div>
                <div className={clsx('tnum text-sm font-medium', d.asset !== 'btc' ? 'text-fg' : o.change >= 0 ? 'text-up' : 'text-down')}>{pct(o.change, 1)}</div>
              </div>
            </button>
          )
        })}
        <AnalogSummary d={d} />
      </CardBody>
    </Card>
  )
}

/** Footer of the analog list: how the top-N continued (label of the next pivot, median move and duration). */
function AnalogSummary({ d }: { d: StructAnalogs }) {
  const os = d.analogs.map((a) => a.outcome[0]).filter(Boolean)
  if (!os.length) return null
  const up = os.filter((o) => o.label === 'HH' || o.label === 'HL').length
  const med = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 }
  const kind = os[0].kind
  return (
    <div className="mt-auto border-t border-line pt-3">
      <span className="label px-1">{t('Come sono proseguiti')}</span>
      <div className="dgrid mt-1 grid-cols-1 min-[440px]:grid-cols-3">
        <DCell label={kind === 'high' ? 'HH / LH' : 'HL / LL'} value={`${up} / ${os.length - up}`} foot={t('Prossimo pivot')} />
        <DCell label={t('Mediana')} value={pct(med(os.map((o) => o.change)), 1)} foot={t('Dal pivot {n}', { n: d.k + 1 })} />
        <DCell label={t('Durata')} value={barsTxt(med(os.map((o) => o.bars)), d.tf)} foot={t('Mediana')} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ scheda
export function StructureAnalogsTab() {
  const [asset, setAsset] = useState<SaAsset>('btc')
  const [tf, setTf] = useState<SaTf>('1d')
  const [mult, setMult] = useState(DEFAULT_MULT['1d'])
  const [k, setK] = useState(5)
  const [top, setTop] = useState(5)
  const [sel, setSel] = useState(0)
  const [projMode, setProjMode] = useState<'median' | 'analog'>('median')
  const [scale, setScale] = useState<SaScale>('pct')
  const [style, setStyle] = useState<SaStyle>('candles')
  const params = useDebounced({ asset, tf, mult, k, top })
  const q = useStructAnalogs(params)
  useEffect(() => setSel(0), [params.asset, params.tf, params.mult, params.k, params.top])
  const tfs: SaTf[] = asset === 'ethbtc' ? ['1d', '1w'] : ['4h', '1d', '1w']
  const onAsset = (a: SaAsset) => {
    setAsset(a)
    setStyle(a === 'btc' ? 'candles' : 'line')
    if (a === 'ethbtc' && tf === '4h') { setTf('1d'); setMult(DEFAULT_MULT['1d']) }
  }
  const onTf = (v: SaTf) => { setTf(v); setMult(DEFAULT_MULT[v]) }
  const refetch = q.refetch
  const liveCur = useLiveCurrent(q.data, () => { void refetch() })
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 640)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  return (
    <div>
      <PageActions>
        <Segmented value={asset} onChange={onAsset} options={(['btc', 'usdtd', 'ethbtc'] as const).map((v) => ({ value: v, label: ASSET_LABEL[v] }))} />
        <Segmented value={tf} onChange={onTf} options={tfs.map((v) => ({ value: v, label: tfLabel(v) }))} />
        <SettingsPanel busy={q.isFetching}>
          <Slider label={t('Soglia ZigZag')} value={mult} min={1.5} max={6} step={0.5} onChange={setMult} fmt={(v) => `${v.toFixed(1)}× ATR`} />
          <Slider label={t('Swing confrontati')} value={k} min={3} max={8} onChange={setK} />
          <Slider label={t('Analoghi (top-N)')} value={top} min={1} max={10} onChange={setTop} />
        </SettingsPanel>
      </PageActions>

      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-28" /><Skeleton className="h-[440px]" /><Skeleton className="h-72" /></div>}
        isEmpty={(d) => !d.current.pivots.length} empty={t('Pivot insufficienti con questi parametri.')}>
        {(d) => {
          const lc = liveCur ?? { candles: d.current.candles, pending: d.current.pending, price: d.current.last.price, live: false }
          const a: SaAnalog | undefined = d.analogs[Math.min(sel, d.analogs.length - 1)]
          const useSel = projMode === 'analog' && !!a
          const proj = useSel ? a!.projection : d.projection?.pivots ?? []
          const firstN = d.k + 2
          const st = structureOf(d.current.pivots)
          const bt = d.backtest
          const p1 = proj[0], p2 = proj[1]
          const projTitle = useSel ? t('Analogo #{r} riportato sul presente', { r: a!.rank }) : d.projection
            ? t('Mediana di {n} analoghi · intervalli {x}', { n: d.projection.n, x: d.projection.calibrated ? t('calibrati sugli errori del backtest') : t('dalla dispersione degli analoghi') })
            : ''
          const chartH = narrow ? 340 : 440
          const accent = d.asset === 'btc' ? C.price : C.primary
          const asLbl = ASSET_LABEL[d.asset]
          const kpiVal = (q2?: SaProjPivot) => (q2 ? `${q2.label} ~${fmtV(q2.price, d.unit, true)}` : '—')
          return (
            <div className="flex flex-col gap-3">
              {/* ---------------- KPI */}
              <KpiStrip cols="grid-cols-1 min-[440px]:grid-cols-2 lg:grid-cols-4">
                <KpiCell icon={<Target />} accent="violet" label={t('Prossimo pivot · {k}', { k: p1 ? kindName(p1.kind).toLowerCase() : '—' })} value={kpiVal(p1)}
                  foot={p1 ? (p1.reached ? t('Già toccato · {x}', { x: dRange(p1.t_lo, p1.t_hi, d.tf) }) : `${fmtV(p1.lo, d.unit, true)}–${fmtV(p1.hi, d.unit, true)} · ${dRange(p1.t_lo, p1.t_hi, d.tf)}`) : t('Nessun analogo')} />
                <KpiCell icon={<Route />} accent="violet" label={t('Pivot successivo · {k}', { k: p2 ? kindName(p2.kind).toLowerCase() : '—' })} value={kpiVal(p2)}
                  foot={p2 ? `${fmtV(p2.lo, d.unit, true)}–${fmtV(p2.hi, d.unit, true)} · ${dRange(p2.t_lo, p2.t_hi, d.tf)}` : null} />
                <KpiCell icon={<Spline />} label={t('Struttura attuale')} value={t(STRUCT_TXT[st])}
                  foot={<LabelSeq labels={d.current.pivots.map((p) => p.label)} />} />
                <KpiCell icon={<FlaskConical />} label={t('Backtest · {n} casi', { n: bt.n })} value={bt.model ? pct(bt.model.hit, 0, false) : '—'}
                  foot={bt.model && bt.base_median ? <span className="inline-flex items-center gap-2"><VerdictBadge v={bt.verdict} short /><span>{t('Baseline {x}', { x: pct(bt.base_median.hit, 0, false) })}</span></span> : <VerdictBadge v={bt.verdict} short />}
                  title={t('Etichetta del prossimo pivot indovinata (HH/LH o HL/LL) nel backtest walk-forward')} />
              </KpiStrip>

              {/* ---------------- confronto */}
              <Card>
                <CardHeader title={t('Confronto di struttura')} icon={<GitCompareArrows />} updatedAt={q.dataUpdatedAt}
                  subtitle={t('Gli ultimi {k} swing di {a} ({tf}) e il tratto passato con la stessa sequenza di massimi e minimi', { k: d.k, a: asLbl, tf: tfLabel(d.tf) })}
                  right={
                    <>
                      <Segmented value={projMode} onChange={setProjMode} options={[{ value: 'median', label: t('Mediana top-{n}', { n: d.projection?.n ?? d.top }) }, { value: 'analog', label: t('Analogo #{r}', { r: a?.rank ?? 1 }) }]} />
                      <Segmented value={scale} onChange={setScale} options={[{ value: 'pct', label: '%' }, { value: 'log', label: 'Log' }]} />
                      <Segmented value={style} onChange={setStyle} options={[{ value: 'candles', label: t('Candele') }, { value: 'line', label: t('Linea') }]} />
                    </>
                  } />
                <CardBody>
                  {a ? (
                    <div className="grid gap-5 xl:grid-cols-2">
                      <div className="min-w-0">
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium text-white"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-fg-3" />{t('Analogo #{r}', { r: a.rank })} · {periodLabel(a.start, a.end)}</span>
                          <span className="tnum text-fg-3">{t('Somiglianza {n}%', { n: Math.round(a.similarity) })}</span>
                        </div>
                        <div className="mb-1 flex min-h-6 flex-wrap items-center gap-2 text-xs text-fg-3"><LabelSeq labels={a.labels} /><span>· {t('scala ×{a} in ampiezza, ×{b} in durata', { a: a.ratio.amp.toFixed(2), b: a.ratio.time.toFixed(2) })}</span></div>
                        <StructChart candles={a.candles} pivots={a.pivots} breaks={a.breaks} unit={d.unit} tf={d.tf} scale={scale} style={style} side="analog"
                          endTime={a.pivots.find((p) => p.n === d.k + 1)?.time} accent={T.fg2} height={chartH} compact={narrow} />
                      </div>
                      <div className="min-w-0">
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium text-white"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: accent }} />{t('Oggi')} · {asLbl} {tfLabel(d.tf)}</span>
                          <span className="tnum inline-flex items-center gap-2 text-fg-2">{lc.live && <Badge color="btc"><Radio size={12} /> {t('Live')}</Badge>}{fmtV(lc.price, d.unit)}</span>
                        </div>
                        <div className="mb-1 flex min-h-6 flex-wrap items-center gap-2 text-xs text-fg-3"><LabelSeq labels={d.current.pivots.map((p) => p.label)} /><span>· {t('in formazione: {k} {l}', { k: kindName(lc.pending.kind).toLowerCase(), l: lc.pending.label })}</span></div>
                        <StructChart candles={lc.candles} pivots={d.current.pivots} breaks={d.current.breaks} unit={d.unit} tf={d.tf} scale={scale} style={style} side="current"
                          proj={proj} projFirstN={firstN} pending={lc.pending} accent={accent} height={chartH} compact={narrow} />
                      </div>
                    </div>
                  ) : (
                    <p className="py-10 text-center text-sm text-fg-3">{t('Nessun tratto passato con questa sequenza di etichette: riduci gli swing confrontati o cambia soglia.')}</p>
                  )}
                  <div className="mt-3">
                    <Legend items={[
                      { label: t('Pivot abbinati (1…{n})', { n: d.k + 1 }), color: PIV_COLOR },
                      { label: t('Pivot successivi / proiettati ({a}…{b})', { a: firstN, b: firstN + 2 }), color: PROJ },
                      { label: t('Rottura di struttura (BOS / CHoCH)'), color: BRK, dashed: true },
                      { label: t('Intervallo P25–P75 (prezzo × data)'), color: hexA(PROJ, 0.5) },
                    ]} />
                  </div>
                  {d.projection?.few && <p className="mt-2 text-xs text-warn/90">{t('Solo {n} candidati nello storico: proiezione poco robusta.', { n: d.history.candidates })}</p>}
                </CardBody>
              </Card>

              {/* ---------------- proiezione + analoghi */}
              {a && (
                <div className="grid gap-3 xl:grid-cols-12">
                  <ProjectionCard d={d} proj={proj} title={projTitle} analog={a} pending={lc.pending} className="xl:col-span-7" />
                  <AnalogList d={d} sel={Math.min(sel, d.analogs.length - 1)} onSel={(i) => { setSel(i); if (projMode === 'analog') setProjMode('analog') }} className="xl:col-span-5" />
                </div>
              )}

              {d.asset !== 'btc' && a && <TranslationCard d={d} />}

              {/* ---------------- backtest */}
              <div className="grid gap-3 xl:grid-cols-12">
                <BacktestCard bt={bt} tf={d.tf} className="xl:col-span-7" />
                <RecentCard bt={bt} unit={d.unit} tf={d.tf} className="xl:col-span-5 xl:h-0 xl:min-h-full" />
              </div>

              <MethodNote>
                <p>{t('Pivot = ZigZag su ATR(14): un massimo o un minimo è confermato solo quando il prezzo ritraccia di {m}× ATR (data di conferma nota, nessun dato futuro). Etichette: HH/LH confrontano un massimo con il massimo precedente, HL/LL un minimo con il minimo precedente. BOS/CHoCH = prima chiusura oltre l\'ultimo massimo o minimo confermato, nella direzione della struttura (BOS) o contro (CHoCH).', { m: d.mult })}</p>
                <p>{t('Abbinamento: gli ultimi {k} swing diventano ampiezze log relative (÷ media) e durate relative; si cercano nello storico i tratti con lo stesso tipo di ultimo pivot e al massimo {x} etichette diverse, senza sovrapposizioni con il presente. Distanza = differenza delle ampiezze + ½ differenza delle durate + 0.15 per etichetta diversa + 0.1 × rapporto di scala + penalità se lo swing successivo dell\'analogo è più corto di quanto il pivot in formazione abbia già percorso. Somiglianza = 100·e^(−distanza).', { k: d.k, x: d.history.max_mismatch })}</p>
                <p>{t('Proiezione: i 3 pivot successivi di ogni analogo sono riportati sul presente riscalando ampiezze e tempi con il rapporto delle scale del tratto abbinato; si combina la mediana dei top-N. Il primo pivot non può essere meno estremo del prezzo già toccato. Gli intervalli P25–P75 sono calibrati sui residui del backtest (walk-forward: solo errori già noti), altrimenti sulla dispersione degli analoghi.')}</p>
                <p>{t('Backtest: a ogni conferma di un pivot si ripete tutto con i soli dati noti in quel momento e si confronta con il pivot reale. Baseline: ampiezza e durata mediane storiche nella direzione alternata; analogo casuale con la stessa struttura (400 estrazioni, da cui il p-value). Il verdetto «significativo» richiede errore medio inferiore a entrambe le baseline, p < 0.05 su entrambi i test e stabilità nelle due metà del campione.')}</p>
                <p>{t('Limiti: pochi casi indipendenti (gli analoghi si sovrappongono e condividono i regimi di mercato), soggettività della soglia ZigZag (cambiare soglia cambia i pivot), serie USDT.D ed ETH/BTC di sole chiusure (OHLC sintetico). È un\'ipotesi di studio, non un segnale di trading.')}</p>
              </MethodNote>
            </div>
          )
        }}
      </Q>
    </div>
  )
}
