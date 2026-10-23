/* Widget della scheda "Kronos" (pagina Previsioni): candele reali + ventaglio dei percorsi di Kronos, curve del backtest per
 * passo (MASE e copertura delle bande). Stessa grammatica visiva della scheda "Previsione a 1 giorno". */
import { useMemo } from 'react'
import type { KPeriod, KronosBacktest, KronosForecast, KronosTf } from '../api/kronos'
import type { Candle } from '../api/types'
import EChart from '../components/charts/EChart'
import { C, axisLabel, dataZoomInside, hexA, lineSeries, timeAxis, tooltipBase, usdAxisFmt, valueAxis } from '../components/charts/theme'
import { dateTime, usd, usdCompact } from '../lib/format'
import { t } from '../i18n'

/** Colours: real price = BTC orange (candles up/down), Kronos = violet (fan + median), mean of paths = blue, paths = grey. */
export const KR_COLOR = { median: C.purple, band: C.purple, mean: C.blue, path: C.grey, naive: C.grey, ref: C.grey2 } as const
export const TF_SEC: Record<KronosTf, number> = { '1h': 3600, '4h': 14400, '1d': 86400 }

type Num = number | null | undefined
const fin = (v: Num): v is number => v != null && Number.isFinite(v)
const sgn = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`

const tipHead = (s: string) => `<div style="color:#94a3b8;font-size:11px;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)">${s}</div>`
const tipRow = (color: string, name: string, val: string, extra = '', dashed = false) =>
  `<div style="display:flex;justify-content:space-between;gap:14px;align-items:center;line-height:20px"><span style="display:inline-flex;align-items:center;white-space:nowrap">${dashed
    ? `<span style="display:inline-block;width:10px;border-top:2px dashed ${color};margin-right:6px"></span>`
    : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`}${name}</span><span style="white-space:nowrap"><b style="font-variant-numeric:tabular-nums">${val}</b>${extra ? `<span style="color:#8892a8;margin-left:8px;font-variant-numeric:tabular-nums">${extra}</span>` : ''}</span></div>`
/** Tooltip anchored to the top edge, left or right of the pointer: it never jumps vertically while scrubbing. */
const topTip = (pt: number[], _p: unknown, _d: unknown, _r: unknown, size: { contentSize: number[]; viewSize: number[] }) => {
  const [w] = size.contentSize
  const x = pt[0] + 18 + w > size.viewSize[0] ? Math.max(4, pt[0] - w - 18) : pt[0] + 18
  return [x, 6]
}

// ------------------------------------------------------------------ candele + ventaglio
export function KronosFanChart({ d, candles, band50, band90, paths, mean, compact, height = '100%' }: {
  d: KronosForecast; candles: Candle[]; band50: boolean; band90: boolean; paths: boolean; mean: boolean; compact?: boolean; height?: number | string
}) {
  const option = useMemo(() => {
    const sec = TF_SEC[d.tf]
    const steps = d.steps ?? []
    const H = steps.length
    const show = Math.min(candles.length, Math.max(compact ? 36 : 60, H * (compact ? 2 : 3)))
    const cs = candles.slice(-show)
    const ms = (s: number) => s * 1000
    const o = d.origin ?? 0
    // fan anchored on the last closed candle (its close = ref price), then one point per forecast candle (at its open time)
    const x = [ms(o), ...steps.map(ms)]
    const ref = d.ref_price ?? 0
    const pad = (arr: number[] | undefined) => (arr ? [ref, ...arr] : [])
    const p05 = pad(d.p05), p25 = pad(d.p25), p75 = pad(d.p75), p95 = pad(d.p95), med = pad(d.median), mu = pad(d.mean)
    const N = {
      px: t('Prezzo'), med: t('Mediana Kronos'), mean: t('Media dei percorsi'), b50: t('Banda 50%'), b90: t('Banda 90%'),
      path: t('Percorsi campione'), now: t('Ora'),
    }
    const xy = (arr: number[]) => arr.map((v, i) => [x[i], v])
    const series: Record<string, unknown>[] = []
    series.push({
      type: 'candlestick', id: 'px', name: N.px, data: cs.map((c) => [ms(c.time), c.open, c.close, c.low, c.high]), barMaxWidth: 8, z: 3,
      itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down },
      markLine: !d.origin ? undefined : {
        symbol: ['none', 'none'], silent: true, animation: false,
        lineStyle: { color: 'rgba(226,232,240,0.45)', type: 'dashed', width: 1 },
        label: { show: true, formatter: N.now, position: 'end', color: C.text, fontSize: 11 },
        data: [{ xAxis: ms(o) + (sec * 1000) / 2 }],
      },
    })
    if (band90 && p05.length) {
      series.push(lineSeries('_lo90', xy(p05), 'transparent', { stack: 'b90', lineStyle: { width: 0 }, tooltip: { show: false }, silent: true, z: 1 }))
      series.push(lineSeries(N.b90, p05.map((v, i) => [x[i], p95[i] - v]), hexA(KR_COLOR.band, 0.6),
        { stack: 'b90', lineStyle: { width: 0 }, areaStyle: { color: hexA(KR_COLOR.band, 0.10) }, tooltip: { show: false }, silent: true, z: 1 }))
    }
    if (band50 && p25.length) {
      series.push(lineSeries('_lo50', xy(p25), 'transparent', { stack: 'b50', lineStyle: { width: 0 }, tooltip: { show: false }, silent: true, z: 2 }))
      series.push(lineSeries(N.b50, p25.map((v, i) => [x[i], p75[i] - v]), hexA(KR_COLOR.band, 0.8),
        { stack: 'b50', lineStyle: { width: 0 }, areaStyle: { color: hexA(KR_COLOR.band, 0.20) }, tooltip: { show: false }, silent: true, z: 2 }))
    }
    if (paths && d.paths?.length) {
      d.paths.forEach((p, i) => series.push(lineSeries(i === 0 ? N.path : `_p${i}`, xy([ref, ...p]), KR_COLOR.path,
        { lineStyle: { width: 0.8, color: hexA(KR_COLOR.path, 0.45) }, tooltip: { show: false }, silent: true, z: 4 })))
    }
    if (mean && mu.length) series.push(lineSeries(N.mean, xy(mu), KR_COLOR.mean, { lineStyle: { width: 1.4, type: 'dashed', color: KR_COLOR.mean }, z: 5 }))
    if (med.length) series.push(lineSeries(N.med, xy(med), KR_COLOR.median, { lineStyle: { width: 2, color: KR_COLOR.median }, z: 6 }))
    const legend = [N.med, ...(mean ? [N.mean] : []), ...(band50 ? [N.b50] : []), ...(band90 ? [N.b90] : []), ...(paths && d.paths?.length ? [N.path] : [])]
    const byTime = new Map(cs.map((c) => [ms(c.time), c]))
    const fIdx = new Map(x.map((v, i) => [v, i]))
    const yVals = [...cs.flatMap((c) => [c.low, c.high]), ...(band90 ? [...p05, ...p95] : [...p25, ...p75]), ...med]
    const lo = Math.min(...yVals), hi = Math.max(...yVals)
    const padY = (hi - lo) * 0.04
    const fmtT = (v: number) => (d.tf === '1d' ? dateTime(v / 1000).replace(/ \d\d:\d\d$/, '') : dateTime(v / 1000))
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 26, containLabel: true },
      legend: { top: 0, data: legend, selectedMode: false },
      tooltip: {
        ...tooltipBase, trigger: 'axis', confine: true, position: topTip, transitionDuration: 0,
        axisPointer: { ...tooltipBase.axisPointer, type: 'line' },
        formatter: (ps: { axisValue: number }[]) => {
          const xv = Number(ps[0]?.axisValue)
          if (!Number.isFinite(xv)) return ''
          const c = byTime.get(xv)
          let h = tipHead(fmtT(xv))
          if (c) {
            const chg = c.open > 0 ? (c.close / c.open - 1) * 100 : 0
            h += tipRow(chg >= 0 ? C.up : C.down, t('Chiusura'), usd(c.close), sgn(chg))
            h += tipRow(C.grey2, t('Massimo / minimo'), `${usdCompact(c.high, 1)} / ${usdCompact(c.low, 1)}`)
          }
          const i = fIdx.get(xv)
          if (i != null && i > 0) {
            const e = (v: number) => (ref > 0 ? sgn((v / ref - 1) * 100) : '')
            h += tipRow(KR_COLOR.median, N.med, usd(med[i]), e(med[i]))
            if (mean) h += tipRow(KR_COLOR.mean, N.mean, usd(mu[i]), e(mu[i]), true)
            h += tipRow(hexA(KR_COLOR.band, 0.8), N.b50, `${usdCompact(p25[i], 1)} – ${usdCompact(p75[i], 1)}`)
            h += tipRow(hexA(KR_COLOR.band, 0.5), N.b90, `${usdCompact(p05[i], 1)} – ${usdCompact(p95[i], 1)}`)
            h += `<div style="color:#8892a8;font-size:11px;margin-top:4px">${t('Candela prevista {n} di {h}', { n: i, h: H })}</div>`
          }
          return h
        },
      },
      xAxis: timeAxis({ min: cs.length ? ms(cs[0].time) : undefined, max: H ? ms(steps[H - 1]) + sec * 500 : undefined }),
      yAxis: valueAxis({ position: 'right', scale: true, min: lo - padY, max: hi + padY, axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      dataZoom: [{ ...dataZoomInside, xAxisIndex: 0 }],
      series,
    }
  }, [d, candles, band50, band90, paths, mean, compact])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ curve per passo (backtest)
export type CurveMetric = 'mase' | 'coverage'
export function KronosStepChart({ bt, model, tf, metric, height = '100%' }: {
  bt: KronosBacktest; model: string; tf: KronosTf; metric: CurveMetric; height?: number | string
}) {
  const option = useMemo(() => {
    const cv = bt.curves?.[model]?.[tf] ?? {}
    const per: KPeriod[] = ['post', 'pre']
    const N: Record<KPeriod, string> = { post: t('Dopo il pre-addestramento'), pre: t('Prima (possibile contaminazione)') }
    const series: Record<string, unknown>[] = []
    const legend: string[] = []
    const col: Record<KPeriod, string> = { post: KR_COLOR.median, pre: C.grey }
    for (const p of per) {
      const rows = cv[p]
      if (!rows?.length) continue
      if (metric === 'mase') {
        legend.push(N[p])
        series.push(lineSeries(N[p], rows.map((r) => [r.step, r.mase]), col[p], { lineStyle: { width: p === 'post' ? 2 : 1.4, color: col[p], type: p === 'post' ? 'solid' : 'dashed' }, showSymbol: true, symbolSize: 4 }))
      } else {
        const n90 = `${N[p]} · 90%`, n50 = `${N[p]} · 50%`
        legend.push(n90, n50)
        series.push(lineSeries(n90, rows.map((r) => [r.step, r.coverage_90 ?? null]), col[p], { lineStyle: { width: p === 'post' ? 2 : 1.4, color: col[p], type: p === 'post' ? 'solid' : 'dashed' } }))
        series.push(lineSeries(n50, rows.map((r) => [r.step, r.coverage_50 ?? null]), p === 'post' ? C.blue : C.grey2, { lineStyle: { width: p === 'post' ? 1.6 : 1.2, color: p === 'post' ? C.blue : C.grey2, type: p === 'post' ? 'solid' : 'dashed' } }))
      }
    }
    const ref = metric === 'mase'
      ? [{ yAxis: 1, label: { formatter: t('Naive = 1'), position: 'insideEndTop', color: C.muted, fontSize: 10 } }]
      : [{ yAxis: 90, label: { formatter: t('Obiettivo 90%'), position: 'insideEndTop', color: C.muted, fontSize: 10 } },
         { yAxis: 50, label: { formatter: t('Obiettivo 50%'), position: 'insideEndTop', color: C.muted, fontSize: 10 } }]
    if (series[0]) (series[0] as Record<string, unknown>).markLine = { silent: true, symbol: 'none', lineStyle: { color: 'rgba(226,232,240,0.35)', type: 'dashed' }, data: ref }
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 24, containLabel: true },
      legend: { top: 0, data: legend, selectedMode: false },
      tooltip: {
        ...tooltipBase, trigger: 'axis', confine: true, position: topTip, transitionDuration: 0,
        formatter: (ps: { seriesName: string; value: [number, number | null]; color: string }[]) => {
          if (!ps.length) return ''
          let h = tipHead(t('{n} candele avanti', { n: ps[0].value[0] }))
          for (const p of ps) if (!p.seriesName.startsWith('_') && fin(p.value[1])) h += tipRow(p.color, p.seriesName, metric === 'mase' ? p.value[1].toFixed(3) : `${p.value[1].toFixed(0)}%`)
          return h
        },
      },
      xAxis: valueAxis({ type: 'value', min: 1, max: bt.meta?.H ?? 24, interval: tf === '1h' ? 6 : tf === '4h' ? 6 : 7, scale: false, splitLine: { show: false },
        name: t('Candele avanti'), nameLocation: 'middle', nameGap: 22, axisLabel: { ...axisLabel } }),
      yAxis: valueAxis(metric === 'mase' ? { scale: true, axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(2) } }
        : { min: 0, max: 100, scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series,
    }
  }, [bt, model, tf, metric])
  return <EChart option={option} height={height} />
}
