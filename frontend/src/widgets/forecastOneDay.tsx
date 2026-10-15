/* Widget della scheda "Previsione a 1 giorno" (pagina Previsioni): prezzo reale vs previsto fuori campione, errore
 * giornaliero contro il naive, rendimenti previsti vs reali e barra delle bande di domani. */
import { useMemo } from 'react'
import type { ForecastOneDay, OneDayPeriod } from '../api/forecastOneDay'
import EChart from '../components/charts/EChart'
import { C, axisLabel, dateFmt, hexA, lineSeries, timeAxis, tooltipBase, usdAxisFmt, valueAxis, dataZoomInside } from '../components/charts/theme'
import { clsx } from '../components/ui'
import { usd, usdCompact } from '../lib/format'
import { t } from '../i18n'

export type Target = 'close' | 'mid'
/** Line colours: actual = BTC orange, model = blue, naive = grey dashed, CryptoPredictions replica = violet. */
export const OD_COLOR = { actual: C.btc, model: C.blue, naive: C.grey, replica: C.purple, band: C.blue, drift: C.teal } as const

type Num = number | null | undefined
const fin = (v: Num): v is number => v != null && Number.isFinite(v)
const sgn = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`

/** Indices of the series rows inside a period (by target day). */
export function periodRange(d: ForecastOneDay, p: OneDayPeriod): [number, number] {
  const n = d.series.t.length
  if (p === 'all') return [0, n]
  if (p === 'repo') {
    const { from, to } = d.periods.repo
    let a = 0
    while (a < n && d.series.t[a] < from) a++
    let b = a
    while (b < n && d.series.t[b] <= to) b++
    return [a, b]
  }
  const last = d.series.t[n - 1]
  const span = (p === 'd90' ? 90 : 365) * 86400
  let a = n - 1
  while (a > 0 && d.series.t[a - 1] > last - span) a--
  return [a, n]
}

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

const errPct = (p: Num, a: Num) => (fin(p) && fin(a) && a > 0 ? (p / a - 1) * 100 : null)

// ------------------------------------------------------------------ prezzo reale vs previsto
export function OneDayPriceChart({ d, target, period, band, naive, replica, height = '100%' }: {
  d: ForecastOneDay; target: Target; period: OneDayPeriod; band: boolean; naive: boolean; replica: boolean; height?: number | string
}) {
  const option = useMemo(() => {
    const s = d.series
    const [a, b] = periodRange(d, period)
    const ms = s.t.slice(a, b).map((x) => x * 1000)
    const pick = (arr: (number | null)[]) => arr.slice(a, b)
    const act = pick(target === 'close' ? s.close : s.mid)
    const mod = pick(target === 'close' ? s.model : s.model_mid)
    const nai = pick(target === 'close' ? s.ref : s.ref_mid)
    const rep = target === 'mid' && replica ? pick(s.replica) : null
    const p05 = pick(s.p05), p95 = pick(s.p95)
    const N = {
      act: target === 'close' ? t('Chiusura reale') : t('Prezzo medio reale'),
      mod: t('Modello'), nai: t('Naive (domani = oggi)'), rep: t('Replica CryptoPredictions'), band: t('Banda 90%'),
    }
    const xy = (arr: (number | null)[]) => arr.map((v, i) => [ms[i], v])
    const series: Record<string, unknown>[] = []
    if (band && target === 'close') {
      series.push(lineSeries('_lo', xy(p05), 'transparent', { stack: 'b90', lineStyle: { width: 0 }, tooltip: { show: false }, silent: true }))
      series.push(lineSeries(N.band, p05.map((v, i) => [ms[i], fin(v) && fin(p95[i]) ? (p95[i] as number) - v : null]), hexA(OD_COLOR.band, 0.6),
        { stack: 'b90', lineStyle: { width: 0 }, areaStyle: { color: hexA(OD_COLOR.band, 0.12) }, tooltip: { show: false }, silent: true }))
    }
    series.push(lineSeries(N.act, xy(act), OD_COLOR.actual, { lineStyle: { width: 1.8, color: OD_COLOR.actual }, z: 3 }))
    if (naive) series.push(lineSeries(N.nai, xy(nai), OD_COLOR.naive, { lineStyle: { width: 1.2, type: 'dashed', color: OD_COLOR.naive }, z: 4 }))
    series.push(lineSeries(N.mod, xy(mod), OD_COLOR.model, { lineStyle: { width: 1.5, color: OD_COLOR.model }, z: 5 }))
    if (rep) series.push(lineSeries(N.rep, xy(rep), OD_COLOR.replica, { lineStyle: { width: 1.5, color: OD_COLOR.replica }, z: 6, connectNulls: false }))
    const repo = d.periods.repo
    const showRepoArea = period !== 'repo' && rep
    if (showRepoArea) {
      ;(series[series.length - 1] as Record<string, unknown>).markArea = {
        silent: true, itemStyle: { color: hexA(OD_COLOR.replica, 0.06) },
        label: { color: C.muted, fontSize: 10, position: 'insideTop' },
        data: [[{ xAxis: repo.from * 1000, name: t('Periodo del repo') }, { xAxis: repo.to * 1000 }]],
      }
    }
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 30, containLabel: true },
      legend: { top: 0, data: [N.act, N.mod, ...(naive ? [N.nai] : []), ...(rep ? [N.rep] : []), ...(band && target === 'close' ? [N.band] : [])], selectedMode: false },
      tooltip: {
        ...tooltipBase, trigger: 'axis', confine: true, position: topTip, transitionDuration: 0,
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex
          if (i == null || i < 0 || i >= ms.length) return ''
          const A = act[i]
          let h = tipHead(`${target === 'close' ? t('Chiusura del {d}', { d: dateFmt(ms[i]) }) : t('Prezzo medio del {d}', { d: dateFmt(ms[i]) })}`)
          h += tipRow(OD_COLOR.actual, N.act, fin(A) ? usd(A) : '—')
          const e = (p: Num) => { const v = errPct(p, A); return fin(v) ? t('errore {e}', { e: sgn(v) }) : '' }
          h += tipRow(OD_COLOR.model, N.mod, fin(mod[i]) ? usd(mod[i]) : '—', e(mod[i]))
          if (naive) h += tipRow(OD_COLOR.naive, N.nai, fin(nai[i]) ? usd(nai[i]) : '—', e(nai[i]), true)
          if (rep) h += tipRow(OD_COLOR.replica, N.rep, fin(rep[i]) ? usd(rep[i]) : '—', fin(rep[i]) ? e(rep[i]) : '')
          if (band && target === 'close' && fin(p05[i]) && fin(p95[i])) {
            const inside = fin(A) && A >= (p05[i] as number) && A <= (p95[i] as number)
            h += tipRow(hexA(OD_COLOR.band, 0.6), N.band, `${usdCompact(p05[i], 1)} – ${usdCompact(p95[i], 1)}`, fin(A) ? (inside ? t('dentro') : t('fuori')) : '')
          }
          return h
        },
      },
      xAxis: timeAxis(),
      yAxis: valueAxis({ position: 'right', scale: true, axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      dataZoom: [{ ...dataZoomInside, xAxisIndex: 0 }, { type: 'slider', height: 14, bottom: 4, borderColor: 'rgba(255,255,255,0.07)', backgroundColor: 'transparent', fillerColor: 'rgba(148,163,184,0.10)', showDataShadow: false, labelFormatter: '', textStyle: { color: C.muted, fontSize: 10 }, handleStyle: { color: C.raised, borderColor: 'rgba(148,163,184,0.4)' }, moveHandleStyle: { color: C.raised } }],
      series,
    }
  }, [d, target, period, band, naive, replica])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ errore giornaliero: |errore modello| − |errore naive|
export function OneDayErrorChart({ d, target, period, replica, height = '100%' }: {
  d: ForecastOneDay; target: Target; period: OneDayPeriod; replica: boolean; height?: number | string
}) {
  const option = useMemo(() => {
    const s = d.series
    const [a, b] = periodRange(d, period)
    const useRep = target === 'mid' && replica
    const act = (target === 'close' ? s.close : s.mid).slice(a, b)
    const mod = (useRep ? s.replica : target === 'close' ? s.model : s.model_mid).slice(a, b)
    const nai = (target === 'close' ? s.ref : s.ref_mid).slice(a, b)
    const ms = s.t.slice(a, b).map((x) => x * 1000)
    const diff = act.map((A, i) => {
      const em = errPct(mod[i], A), en = errPct(nai[i], A)
      return fin(em) && fin(en) ? Math.abs(em) - Math.abs(en) : null
    })
    let cum = 0
    const cumS = diff.map((v) => { if (fin(v)) cum += -v; return cum })
    const N = {
      better: useRep ? t('Replica meglio del naive') : t('Modello meglio del naive'),
      worse: useRep ? t('Replica peggio del naive') : t('Modello peggio del naive'),
      cum: t('Vantaggio cumulato'),
    }
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 8, containLabel: true },
      legend: { top: 0, data: [N.better, N.worse, N.cum], selectedMode: false },
      tooltip: {
        ...tooltipBase, trigger: 'axis', confine: true, position: topTip, transitionDuration: 0,
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex
          if (i == null || i < 0 || i >= ms.length) return ''
          const em = errPct(mod[i], act[i]), en = errPct(nai[i], act[i])
          let h = tipHead(dateFmt(ms[i]))
          h += tipRow(useRep ? OD_COLOR.replica : OD_COLOR.model, useRep ? t('Errore replica') : t('Errore modello'), fin(em) ? sgn(em) : '—')
          h += tipRow(OD_COLOR.naive, t('Errore naive'), fin(en) ? sgn(en) : '—', '', true)
          const v = diff[i]
          if (fin(v)) h += tipRow(v <= 0 ? C.up : C.down, v <= 0 ? N.better : N.worse, `${Math.abs(v).toFixed(2)} pt`)
          h += tipRow('#E6E9EF', N.cum, `${cumS[i] >= 0 ? '+' : '−'}${Math.abs(cumS[i]).toFixed(1)} pt`)
          return h
        },
      },
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ position: 'left', scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) < 1 && v !== 0 ? 1 : 0)}` }, name: 'pt', nameGap: 8 }),
        valueAxis({ position: 'right', scale: true, splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}` } }),
      ],
      dataZoom: [{ ...dataZoomInside, xAxisIndex: 0 }],
      series: [
        { name: N.better, type: 'bar', large: true, barMaxWidth: 4, barGap: '-100%', itemStyle: { color: hexA(C.up, 0.75) }, data: diff.map((v, i) => [ms[i], fin(v) && v <= 0 ? v : null]) },
        { name: N.worse, type: 'bar', large: true, barMaxWidth: 4, barGap: '-100%', itemStyle: { color: hexA(C.down, 0.75) }, data: diff.map((v, i) => [ms[i], fin(v) && v > 0 ? v : null]) },
        lineSeries(N.cum, cumS.map((v, i) => [ms[i], v]), '#E6E9EF', { yAxisIndex: 1, lineStyle: { width: 1.6, color: '#E6E9EF' }, z: 5 }),
      ],
    }
  }, [d, target, period, replica])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ rendimento previsto vs reale (stessa scala sui due assi)
export function OneDayScatter({ d, target, period, replica, height = '100%' }: {
  d: ForecastOneDay; target: Target; period: OneDayPeriod; replica: boolean; height?: number | string
}) {
  const option = useMemo(() => {
    const s = d.series
    const [a, b] = periodRange(d, period)
    const ref = target === 'close' ? s.ref : s.ref_mid
    const act = target === 'close' ? s.close : s.mid
    const mod = target === 'close' ? s.model : s.model_mid
    const ret = (p: Num, r: Num) => (fin(p) && fin(r) && r > 0 ? Math.log(p / r) * 100 : null)
    const pts = (pred: (number | null)[]) => {
      const out: [number, number, number][] = []
      for (let i = a; i < b; i++) {
        const x = ret(pred[i], ref[i]), y = ret(act[i], ref[i])
        if (fin(x) && fin(y)) out.push([x, y, s.t[i] * 1000])
      }
      return out
    }
    const pm = pts(mod)
    const pr = target === 'mid' && replica ? pts(s.replica) : []
    const ys = [...pm, ...pr].map((p) => Math.abs(p[1])).sort((x, y) => x - y)
    const raw = Math.max(1, Math.ceil(ys[Math.floor(ys.length * 0.99)] ?? 5))
    // symmetric limits on a round step so the ticks are evenly spaced (no "−7 −6 … 6 7" at the edges)
    const step = raw <= 4 ? 1 : raw <= 10 ? 2 : raw <= 25 ? 5 : 10
    const lim = Math.ceil(raw / step) * step
    const tick = (v: number) => (v < 0 ? `−${Math.abs(v)}` : `${v}`)
    const N = { mod: t('Modello'), rep: t('Replica CryptoPredictions'), perfect: t('Previsione perfetta') }
    const clip = (p: [number, number, number][]) => p.filter((q) => Math.abs(q[0]) <= lim && Math.abs(q[1]) <= lim)
    return {
      grid: { left: 8, right: 16, top: 34, bottom: 28, containLabel: true },
      legend: { top: 0, data: [N.mod, ...(pr.length ? [N.rep] : [])], selectedMode: false },
      tooltip: {
        ...tooltipBase, trigger: 'item', confine: true, transitionDuration: 0,
        formatter: (p: { seriesName: string; value: [number, number, number]; color: string }) =>
          tipHead(dateFmt(p.value[2])) + tipRow(p.color, t('Previsto'), sgn(p.value[0])) + tipRow(OD_COLOR.actual, t('Reale'), sgn(p.value[1])),
      },
      xAxis: valueAxis({ min: -lim, max: lim, interval: step, scale: false, name: t('Rendimento previsto %'), nameLocation: 'middle', nameGap: 22,
        splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: tick } }),
      yAxis: valueAxis({ min: -lim, max: lim, interval: step, scale: false, name: t('Reale %'), nameGap: 10,
        axisLabel: { ...axisLabel, formatter: tick } }),
      series: [
        { name: N.mod, type: 'scatter', symbolSize: 4, large: false, itemStyle: { color: hexA(OD_COLOR.model, 0.55) }, data: clip(pm), z: 3,
          markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(226,232,240,0.35)', type: 'dashed' },
            label: { formatter: N.perfect, color: C.muted, fontSize: 10, position: 'insideEndTop' },
            data: [[{ coord: [-lim, -lim] }, { coord: [lim, lim] }]] } },
        ...(pr.length ? [{ name: N.rep, type: 'scatter', symbolSize: 4, itemStyle: { color: hexA(OD_COLOR.replica, 0.5) }, data: clip(pr), z: 2 }] : []),
      ],
    }
  }, [d, target, period, replica])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ barra delle bande di domani (con prezzo live)
export function BandBar({ p05, p25, p50, p75, p95, refPrice: ref, live, className }: {
  p05: number; p25: number; p50: number; p75: number; p95: number; refPrice: number; live?: number | null; className?: string
}) {
  const lo = Math.min(p05, ref, live ?? p05), hi = Math.max(p95, ref, live ?? p95)
  const pad = (hi - lo) * 0.06
  const a = lo - pad, b = hi + pad
  const x = (v: number) => `${((v - a) / (b - a)) * 100}%`
  return (
    <div className={clsx('relative', className)}>
      <div className="relative h-9">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/[0.08]" />
        <div className="absolute top-1/2 h-3 -translate-y-1/2 rounded-full" style={{ left: x(p05), width: `calc(${x(p95)} - ${x(p05)})`, background: hexA(OD_COLOR.band, 0.22) }} title={t('Banda 90%')} />
        <div className="absolute top-1/2 h-3 -translate-y-1/2 rounded-full" style={{ left: x(p25), width: `calc(${x(p75)} - ${x(p25)})`, background: hexA(OD_COLOR.band, 0.55) }} title={t('Banda 50%')} />
        <div className="absolute top-1/2 h-5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded bg-white" style={{ left: x(p50) }} title={t('Mediana')} />
        <div className="absolute top-1/2 h-5 w-0 -translate-x-1/2 -translate-y-1/2 border-l border-dashed border-slate-400" style={{ left: x(ref) }} title={t('Chiusura di riferimento')} />
        {fin(live) && (
          <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: x(live) }} title={t('Prezzo live')}>
            <span className="block h-2.5 w-2.5 rounded-full ring-2 ring-[#0E1424]" style={{ background: OD_COLOR.actual }} />
          </div>
        )}
      </div>
      <div className="tnum mt-1 flex justify-between text-2xs text-slate-500">
        <span>{usdCompact(p05, 1)}</span><span>{usdCompact(p95, 1)}</span>
      </div>
    </div>
  )
}
