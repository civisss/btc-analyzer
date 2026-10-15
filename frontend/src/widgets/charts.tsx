/* ECharts-based analytic charts shared by the dashboard and the detail pages. */
import { useMemo } from 'react'
import { Radar } from 'lucide-react'
import type { AnomalyMark } from '../api/superchart'
import { Toggle } from '../components/ui'
import type { Candle, Forecast, Fractals, Liquidations, Pt, UsdtAnalysis } from '../api/types'
import EChart from '../components/charts/EChart'
import {
  C, MAGMA, areaGradient, axisLabel, dataZoomInside, dataZoomSlider, dateFmt, hexA, legendBase, lineSeries, timeAxis,
  toXY, tooltipBase, usdAxisFmt, valueAxis,
  ANALOG_COLORS,
} from '../components/charts/theme'
import { date, dateTime, pct, usd, usdCompact } from '../lib/format'
import { dateLocale, t } from '../i18n'

type TipParam = { seriesName: string; value: unknown; color: string; axisValue?: number | string; marker?: string; data?: unknown }
const tipHead = (s: string) => `<div style="color:#94a3b8;font-size:11px;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)">${s}</div>`
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:18px;align-items:center;line-height:20px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`

// ------------------------------------------------------------------ anomaly markers (Superchart z-score on daily bars)
const dayKey = (sec: number) => Math.floor(sec / 86400)
/** Amber dots on the anomaly days, placed on the value of the series point of that day (x in ms). */
export function anomalyMarkPoint(marks: AnomalyMark[] | undefined, xy: [number, number | null][]) {
  if (!marks?.length || !xy.length) return undefined
  const byDay = new Map<number, [number, number]>()
  for (const [x, y] of xy) if (y != null) byDay.set(dayKey(x / 1000), [x, y])   // last point of each UTC day
  const data = marks.map((m) => byDay.get(dayKey(m.time))).filter((p): p is [number, number] => !!p).map((coord) => ({ coord }))
  if (!data.length) return undefined
  return { symbol: 'circle', symbolSize: 8, silent: true, animation: false, label: { show: false },
    itemStyle: { color: C.amber, borderColor: '#0E1424', borderWidth: 1.5 }, data }
}
/** Tooltip row for an anomaly day ('' when the hovered day is not one). */
export function anomalyTipRow(marks: AnomalyMark[] | undefined, ms: number) {
  const m = marks?.find((x) => dayKey(x.time) === dayKey(ms / 1000))
  return m ? tipRow(C.amber, t('Anomalia'), `z ${m.z > 0 ? '+' : '−'}${Math.abs(m.z).toFixed(1)}`) : ''
}
/** "Anomalie" toggle for a card header (the markers come from the Superchart anomaly engine, |z| ≥ 3 on daily data). */
export function AnomalyToggle({ on, onClick, loading, count }: { on: boolean; onClick: () => void; loading?: boolean; count?: number }) {
  return (
    <span title={t('Giorni anomali (|z| ≥ 3 sui dati giornalieri, stesso motore del Superchart)')}>
      <Toggle on={on} onClick={onClick}>
        <Radar size={13} className={loading ? 'animate-pulse' : undefined} />{t('Anomalie')}
        {/* how many fall inside the chart: 0 tells the toggle worked, there are simply none in this window */}
        {on && !loading && count != null && <span className="tnum rounded bg-white/[0.08] px-1 text-2xs text-slate-300">{count}</span>}
      </Toggle>
    </span>
  )
}
/** Anomalies inside the time span of a series (seconds). */
export function marksIn(marks: AnomalyMark[], pts: { time: number }[]): AnomalyMark[] {
  if (!pts.length) return []
  const a = pts[0].time - 86400, b = pts[pts.length - 1].time + 86400
  return marks.filter((m) => m.time >= a && m.time <= b)
}

// ------------------------------------------------------------------ Liquidation heatmap
const HEAT_COLORS = MAGMA // magma is reserved for the liquidation heatmap

export function LiqHeatmapChart({ data, height = 300, livePrice, compact = false }: { data: Liquidations['heatmap']; height?: number | string; livePrice?: number | null; compact?: boolean }) {
  const option = useMemo(() => {
    const { times, prices, values, max, candles } = data
    const step = prices.length > 1 ? prices[1] - prices[0] : 1
    const heat: [number, number, number][] = []
    values.forEach((row, xi) => row.forEach((v, yi) => { if (v > 0) heat.push([xi, yi, v]) }))
    const byTime = new Map(candles.map((c) => [c.time, c]))
    const candleData = times.map((ts) => {
      const c = byTime.get(ts)
      return c ? [c.open, c.close, c.low, c.high] : '-'
    })
    const multiDay = times.length > 1 && times[times.length - 1] - times[0] > 3 * 86400
    const fmtT = (ts: number) => (multiDay ? date(ts, false) : new Date(ts * 1000).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }))
    // multi-day ranges: one label per day boundary (first column of each local day)
    const dayStart = (i: number) => i === 0 || new Date(times[i] * 1000).getDate() !== new Date(times[i - 1] * 1000).getDate()
    return {
      grid: { left: 8, right: compact ? 52 : 64, top: 10, bottom: compact ? 24 : 48, containLabel: false },
      tooltip: {
        ...tooltipBase,
        formatter: (p: { seriesType: string; data: unknown }) => {
          if (p.seriesType === 'heatmap') {
            const [xi, yi, v] = p.data as [number, number, number]
            return `${tipHead(dateTime(times[xi]))}${tipRow(C.btc, t('Prezzo ~{p}', { p: usd(prices[yi]) }), usdCompact(v))}`
          }
          return ''
        },
      },
      xAxis: { type: 'category', data: times, axisLabel: { ...axisLabel, alignMinLabel: 'left', alignMaxLabel: 'right', formatter: (v: string) => fmtT(Number(v)), interval: multiDay ? (i: number) => i > 0 && dayStart(i) : 'auto', hideOverlap: true }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitArea: { show: false } },
      yAxis: [
        { type: 'category', data: prices, show: false },
        { type: 'value', position: 'right', min: prices[0] - step / 2, max: prices[prices.length - 1] + step / 2, splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: usdAxisFmt }, axisLine: { show: false } },
      ],
      visualMap: {
        min: 0, max: max || 1, calculable: false, show: !compact, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 140, itemWidth: 10,
        text: [t('Alta'), t('Bassa')], textStyle: { color: C.muted, fontSize: 11 }, inRange: { color: HEAT_COLORS }, seriesIndex: 0,
      },
      series: [
        { type: 'heatmap', data: heat, yAxisIndex: 0, progressive: 0, emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } } },
        {
          type: 'candlestick', data: candleData, yAxisIndex: 1, barMaxWidth: 6, silent: true,
          itemStyle: { color: '#E6E9EF', color0: 'rgba(15,23,42,0.9)', borderColor: '#E6E9EF', borderColor0: '#94a3b8' },
          markLine: livePrice ? { symbol: 'none', silent: true, lineStyle: { color: C.btc, type: 'dashed' }, label: { color: '#0A0E17', backgroundColor: C.btc, padding: [2, 4], borderRadius: 3, formatter: () => usd(livePrice), fontSize: 11 }, data: [{ yAxis: livePrice }] } : undefined,
        },
      ],
    }
  }, [data, livePrice, compact])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Fractal chart (current vs analogs + projection fan)
export function FractalChart({ data, height = 300, maxMatches = 5, showLegend = true }: { data: Fractals; height?: number | string; maxMatches?: number; showLegend?: boolean }) {
  const option = useMemo(() => {
    const w = data.current.length
    const h = data.projection.p50.length
    const xs = Array.from({ length: w + h }, (_, i) => i - (w - 1))
    const cur = [...data.current.map((c) => c.close), ...new Array(h).fill(null)]
    const pad = (arr: number[]) => [...new Array(w - 1).fill(null), data.current[w - 1].close, ...arr]
    const lower = pad(data.projection.p10)
    const upper = pad(data.projection.p90)
    const diff = upper.map((u, i) => (u == null || lower[i] == null ? null : u - (lower[i] as number)))
    const matches = data.matches.slice(0, maxMatches)
    const N = { band: t('Banda P10–P90'), cur: t('Attuale'), proj: t('Proiezione P50'), now: t('Ora') }
    const series: unknown[] = [
      lineSeries('P10', lower, 'transparent', { stack: 'band', lineStyle: { width: 0 }, tooltip: { show: false }, legendHoverLink: false }),
      lineSeries(N.band, diff, 'transparent', { stack: 'band', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.blue, 0.10) } }),
      ...matches.map((m, i) =>
        // one distinct hue per analog (same colour in legend and tooltip); hovering one fades the others
        lineSeries(m.label, [...m.path, ...m.future], ANALOG_COLORS[i % ANALOG_COLORS.length], {
          lineStyle: { width: 1.4, opacity: 0.85, color: ANALOG_COLORS[i % ANALOG_COLORS.length] },
          emphasis: { disabled: false, focus: 'series', lineStyle: { width: 2.4, opacity: 1 } },
        }),
      ),
      lineSeries(N.cur, cur, C.btc, { lineStyle: { width: 2, color: C.btc }, areaStyle: { color: areaGradient(C.btc, 0.14, 0), origin: 'start' }, z: 10 }),
      lineSeries(N.proj, pad(data.projection.p50), C.primary, {
        lineStyle: { width: 1.5, type: 'dashed', color: C.primary }, z: 9,
        markLine: { symbol: 'none', silent: true, lineStyle: { color: 'rgba(226,232,240,0.5)', type: 'dashed' }, label: { color: C.text, formatter: N.now, position: 'end', fontSize: 11 }, data: [{ xAxis: '0' }] },
      }),
    ]
    return {
      grid: { left: 8, right: 12, top: showLegend ? 68 : 24, bottom: 26, containLabel: true },
      legend: showLegend ? { ...legendBase, type: 'scroll', data: [N.cur, ...matches.map((m) => m.label), N.proj], pageTextStyle: { color: C.muted } } : undefined,
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipParam[]) => {
          const x = Number(ps[0]?.axisValue)
          const head = tipHead(x === 0 ? N.now : t('{n} candele', { n: x > 0 ? `+${x}` : x }))
          return head + ps.filter((p) => p.value != null && p.seriesName !== 'P10' && p.seriesName !== N.band).map((p) => tipRow(p.color, p.seriesName, usd(p.value as number))).join('')
        },
      },
      xAxis: { type: 'category', data: xs.map(String), boundaryGap: false, name: t('Candele da ora'), nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: C.muted, fontSize: 11 }, axisLabel: { ...axisLabel, formatter: (v: string) => (v === '0' ? N.now : Number(v) > 0 ? `+${v}` : v) }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: valueAxis({ position: 'right', axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      series,
    }
  }, [data, maxMatches, showLegend])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ USDT.D vs BTC (dual axis)
export function UsdtBtcChart({ data, height = 300, levels = false, zoom = false, compact = false }: { data: UsdtAnalysis; height?: number | string; levels?: boolean; zoom?: boolean; compact?: boolean }) {
  const option = useMemo(() => {
    const btc = data.series.map((s) => [s.time * 1000, s.btc])
    const ud = data.series.map((s) => [s.time * 1000, s.usdt_d])
    const cur = data.current.usdt_d
    const nearAbove = data.levels.filter((l) => l.price >= cur).sort((x, y) => x.price - y.price)[0]
    const nearBelow = data.levels.filter((l) => l.price < cur).sort((x, y) => y.price - x.price)[0]
    const nBtc = t('Prezzo BTC'), nUd = t('USDT Dominance (invertita)')
    return {
      grid: { left: 8, right: 8, top: 44, bottom: zoom ? 36 : 8, containLabel: true },
      legend: { ...legendBase, data: [nBtc, nUd] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipParam[]) => tipHead(dateFmt(Number((ps[0]?.value as number[])?.[0]))) +
          ps.map((p) => tipRow(p.color, p.seriesName, p.seriesName === nUd ? `${((p.value as number[])[1]).toFixed(2)}%` : usd((p.value as number[])[1]))).join(''),
      },
      dataZoom: zoom ? [dataZoomInside, dataZoomSlider] : undefined,
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ position: 'left', axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
        valueAxis({ position: 'right', inverse: true, splitLine: { show: false }, name: t('↓ Invertito'), nameLocation: 'start', nameGap: 10, nameTextStyle: { color: C.muted, fontSize: 11, align: 'right' }, axisLabel: { ...axisLabel, formatter: (v: number) => `${v.toFixed(1)}%` } }),
      ],
      series: [
        lineSeries(nBtc, btc, C.btc, { areaStyle: { color: areaGradient(C.btc, compact ? 0.1 : 0.16, 0) }, lineStyle: { width: 2, color: C.btc } }),
        lineSeries(nUd, ud, C.blue, {
          yAxisIndex: 1, lineStyle: { width: 1.8, color: C.blue },
          markLine: levels ? {
            symbol: 'none', silent: false,
            // only the nearest level above / below the current dominance is labelled; the others on hover
            data: data.levels.map((l) => {
              const tag = { color: C.text, fontSize: 11, position: 'insideEndTop', formatter: `${l.kind === 'resistance' ? 'R' : 'S'} ${l.price.toFixed(2)}%` }
              const on = l === nearAbove || l === nearBelow
              return {
                yAxis: l.price,
                lineStyle: { color: on ? 'rgba(148,163,184,0.6)' : 'rgba(148,163,184,0.3)', type: 'dashed', width: 1 },
                label: { ...tag, show: on },
                emphasis: { label: { ...tag, show: true }, lineStyle: { color: 'rgba(148,163,184,0.8)', width: 1 } },
              }
            }),
          } : undefined,
        }),
      ],
    }
  }, [data, levels, zoom, compact])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Forecast fan chart
export function ForecastFanChart({ data, height = 300, historyDays = 180, showScenarios = false, compact = false }: { data: Forecast; height?: number | string; historyDays?: number; showScenarios?: boolean; compact?: boolean }) {
  const option = useMemo(() => {
    const hist = data.history.slice(-historyDays)
    const lastH = hist[hist.length - 1]
    const b = data.bands
    const anchor = lastH ? [{ time: lastH.time, p05: lastH.value!, p25: lastH.value!, p50: lastH.value!, p75: lastH.value!, p95: lastH.value! }] : []
    const bb = [...anchor, ...b]
    const ms = (x: { time: number }) => x.time * 1000
    const N = { hist: t('Storico'), med: t('Mediana') }
    const scenColors: Record<string, string> = { 0: C.up, 1: C.blue, 2: C.down }
    return {
      grid: { left: 8, right: 8, top: compact ? 24 : 40, bottom: 8, containLabel: true },
      legend: compact ? undefined : { ...legendBase, data: [N.hist, N.med, '50%', '90%', ...(showScenarios ? data.scenarios.map((s) => s.name) : [])] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipParam[]) => {
          const x0 = Number((ps[0]?.value as number[])?.[0])
          const band = bb.find((x) => x.time * 1000 === x0)
          let s = tipHead(dateFmt(x0))
          const histP = ps.find((p) => p.seriesName === N.hist)
          if (histP) s += tipRow(C.btc, t('Prezzo'), usd((histP.value as number[])[1]))
          if (band && band.time !== lastH?.time) {
            s += tipRow('#E6E9EF', N.med, usd(band.p50)) + tipRow(hexA(C.purple, 0.8), t('Range 50%'), `${usdCompact(band.p25, 1)} – ${usdCompact(band.p75, 1)}`) + tipRow(hexA(C.blue, 0.6), t('Range 90%'), `${usdCompact(band.p05, 1)} – ${usdCompact(band.p95, 1)}`)
          }
          ps.filter((p) => data.scenarios.some((sc) => sc.name === p.seriesName)).forEach((p) => { s += tipRow(p.color, p.seriesName, usd((p.value as number[])[1])) })
          return s
        },
      },
      xAxis: timeAxis(),
      yAxis: valueAxis({ position: 'right', axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      series: [
        lineSeries('p05', bb.map((x) => [ms(x), x.p05]), 'transparent', { stack: 'b90', lineStyle: { width: 0 }, tooltip: { show: false } }),
        lineSeries('90%', bb.map((x) => [ms(x), x.p95 - x.p05]), hexA(C.blue, 0.6), { stack: 'b90', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.blue, 0.16) } }),
        lineSeries('p25', bb.map((x) => [ms(x), x.p25]), 'transparent', { stack: 'b50', lineStyle: { width: 0 }, tooltip: { show: false } }),
        lineSeries('50%', bb.map((x) => [ms(x), x.p75 - x.p25]), hexA(C.purple, 0.8), { stack: 'b50', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.purple, 0.3) } }),
        lineSeries(N.hist, hist.map((p) => [p.time * 1000, p.value]), C.btc, {
          lineStyle: { width: 2, color: C.btc }, areaStyle: { color: areaGradient(C.btc, 0.14, 0) },
          markLine: lastH ? { symbol: 'none', silent: true, lineStyle: { color: 'rgba(226,232,240,0.45)', type: 'dashed' }, label: { color: C.text, formatter: t('Oggi'), fontSize: 11, position: 'end' }, data: [{ xAxis: lastH.time * 1000 }] } : undefined,
        }),
        lineSeries(N.med, bb.map((x) => [ms(x), x.p50]), '#E6E9EF', { lineStyle: { width: 2, type: 'dashed', color: '#E6E9EF' } }),
        ...(showScenarios ? data.scenarios.map((s, i) => lineSeries(s.name, [[lastH.time * 1000, lastH.value], ...s.path.map((p) => [p.time * 1000, p.value])], scenColors[i] ?? C.cyan, { lineStyle: { width: 1.4, opacity: 0.85, color: scenColors[i] ?? C.cyan } })) : []),
      ],
    }
  }, [data, historyDays, showScenarios, compact])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Generic multi-line time chart
export type LineSpec = { name: string; data: Pt[]; color: string; axis?: 0 | 1; area?: boolean; dashed?: boolean; width?: number; type?: 'line' | 'bar' }
export function TimeLinesChart({
  lines, height = 260, log = false, yFmt, y2Fmt, zoom = false, legend = true, markLines, yMin, yMax, compactTip, anomalies,
}: {
  lines: LineSpec[]; height?: number | string; log?: boolean; yFmt?: (v: number) => string; y2Fmt?: (v: number) => string
  zoom?: boolean; legend?: boolean; markLines?: { y: number; color: string; label?: string; axis?: 0 | 1 }[]; yMin?: number; yMax?: number; compactTip?: boolean
  /** anomaly days drawn on the first series */
  anomalies?: AnomalyMark[]
}) {
  const option = useMemo(() => {
    const f1 = yFmt ?? ((v: number) => usdAxisFmt(v))
    const f2 = y2Fmt ?? f1
    const hasY2 = lines.some((l) => l.axis === 1)
    return {
      grid: { left: 8, right: 8, top: legend ? 34 : 12, bottom: zoom ? 36 : 8, containLabel: true },
      legend: legend ? { ...legendBase, type: 'scroll', pageTextStyle: { color: C.muted }, data: lines.map((l) => l.name) } : undefined,
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipParam[]) => tipHead(compactTip ? dateTime(Number((ps[0]?.value as number[])?.[0]) / 1000) : dateFmt(Number((ps[0]?.value as number[])?.[0]))) +
          ps.filter((p) => (p.value as number[])[1] != null).map((p) => {
            const l = lines.find((x) => x.name === p.seriesName)
            return tipRow(l?.color ?? p.color, p.seriesName, (l?.axis === 1 ? f2 : f1)((p.value as number[])[1]))
          }).join('') + anomalyTipRow(anomalies, Number((ps[0]?.value as number[])?.[0])),
      },
      dataZoom: zoom ? [dataZoomInside, dataZoomSlider] : undefined,
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ type: log ? 'log' : 'value', position: hasY2 ? 'left' : 'right', min: yMin, max: yMax, axisLabel: { ...axisLabel, formatter: f1 } }),
        ...(hasY2 ? [valueAxis({ position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: f2 } })] : []),
      ],
      series: lines.map((l, i) => {
        const base = l.type === 'bar'
          ? { name: l.name, type: 'bar', data: toXY(l.data), yAxisIndex: l.axis ?? 0, barMaxWidth: 6, itemStyle: { color: (p: { value: [number, number] }) => (p.value[1] >= 0 ? C.up : C.down) } }
          : lineSeries(l.name, toXY(l.data), l.color, {
            yAxisIndex: l.axis ?? 0,
            lineStyle: { width: l.width ?? 1.8, color: l.color, type: l.dashed ? 'dashed' : 'solid' },
            areaStyle: l.area ? { color: areaGradient(l.color, 0.22) } : undefined,
          })
        const mp = i === 0 ? anomalyMarkPoint(anomalies, toXY(l.data)) : undefined
        if (mp) Object.assign(base, { markPoint: mp })
        if (i === 0 && markLines?.length) {
          return {
            ...base,
            markLine: {
              symbol: 'none', silent: true,
              data: markLines.map((m) => ({ yAxis: m.y, lineStyle: { color: m.color, type: 'dashed' }, label: { color: m.color, formatter: m.label ?? '', fontSize: 10, position: 'insideEndTop' } })),
            },
          }
        }
        return base
      }),
    }
  }, [lines, log, yFmt, y2Fmt, zoom, legend, markLines, yMin, yMax, compactTip, anomalies])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ small candle line for overlays (price + series)
export function candlesToPts(c: Candle[]): Pt[] {
  return c.map((k) => ({ time: k.time, value: k.close }))
}

export const pctFmt = (v: number) => pct(v, 1, false)
