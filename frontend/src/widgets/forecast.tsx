/* Widget della pagina Previsioni (forecast v2): ventaglio a 365 giorni con i cicli passati riscalati, pesi dei modelli
 * per orizzonte, contributi delle variabili (driver) e diagramma di calibrazione di P(rialzo). */
import { useMemo } from 'react'
import type { CalBucket, Driver, ForecastMemberKey, ForecastV2, PastCycle } from '../api/forecastV2'
import EChart from '../components/charts/EChart'
import { C, areaGradient, axisLabel, dateFmt, hexA, lineSeries, timeAxis, tooltipBase, usdAxisFmt, valueAxis } from '../components/charts/theme'
import { clsx } from '../components/ui'
import { usd, usdCompact } from '../lib/format'
import { cap, t } from '../i18n'

export const MEMBER_COLOR: Record<ForecastMemberKey, string> = { cycle: C.btc, lgb: C.blue, mc: C.purple, rw0: C.grey2 }
export const MEMBER_ORDER: ForecastMemberKey[] = ['cycle', 'lgb', 'mc', 'rw0']
/** Short member names (module level: Italian, translated at render). */
export const MEMBER_SHORT: Record<ForecastMemberKey, string> = { cycle: 'Posizione nel ciclo', lgb: 'LightGBM', mc: 'Monte Carlo', rw0: 'Random walk' }

const tipHead = (s: string) => `<div style="color:#94a3b8;font-size:11px;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)">${s}</div>`
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`

/** History shown before "today" for each forecast horizon (days). */
const HIST_DAYS: Record<number, number> = { 30: 120, 90: 210, 180: 300, 365: 365 }
export const cycleColor = (i: number, w: number, maxW: number) => (i === 0 ? C.blue : hexA('#B3BCD0', 0.22 + 0.5 * (w / Math.max(1, maxW))))

// ------------------------------------------------------------------ ventaglio 0–365 giorni
type Tip = { seriesName: string; value: [number, number | null]; color: string }
export function ForecastPathChart({ d, horizon, cycles, height = '100%' }: { d: ForecastV2; horizon: number; cycles: PastCycle[]; height?: number | string }) {
  const option = useMemo(() => {
    const ms = (s: number) => s * 1000
    const hist = d.history.slice(-(HIST_DAYS[horizon] ?? 365))
    const path = d.path.filter((p) => p.day <= horizon)
    const today = path[0]?.time ?? hist[hist.length - 1]?.time
    const N = { hist: t('Prezzo'), med: t('Mediana'), b50: t('Range 50%'), b90: t('Range 90%') }
    const maxW = Math.max(...cycles.map((c) => c.weight), 1)
    const t0 = hist[0]?.time ?? today
    const events = d.cycle_model.events.filter((e) => e.time >= t0 && e.time <= today)
    const evLabel = (k: string, probable: boolean) => (k === 'top' ? t('Massimo di ciclo') : k === 'bottom' ? (probable ? t('Minimo probabile') : t('Minimo di ciclo')) : t('Halving'))
    return {
      grid: { left: 8, right: 8, top: 18, bottom: 8, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: Tip[]) => {
          const x = ps[0]?.value[0]
          if (x == null) return ''
          const pp = path.find((p) => ms(p.time) === x)
          let s = tipHead(dateFmt(x))
          const h = ps.find((p) => p.seriesName === N.hist)
          if (h?.value[1] != null) s += tipRow(C.btc, N.hist, usd(h.value[1]))
          if (pp && pp.day > 0) {
            s += tipRow('#E6E9EF', `${N.med} · ${t('giorno {n}', { n: pp.day })}`, usd(pp.p50))
            s += tipRow(hexA(C.purple, 0.9), N.b50, `${usdCompact(pp.p25, 1)} – ${usdCompact(pp.p75, 1)}`)
            s += tipRow(hexA(C.blue, 0.7), N.b90, `${usdCompact(pp.p05, 1)} – ${usdCompact(pp.p95, 1)}`)
          }
          ps.filter((p) => cycles.some((c) => c.label === p.seriesName) && p.value[1] != null).slice(0, 6)
            .forEach((p) => { s += tipRow(p.color, p.seriesName, usd(p.value[1])) })
          return s
        },
      },
      xAxis: timeAxis(),
      yAxis: valueAxis({ position: 'right', scale: true, axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      series: [
        lineSeries('_p05', path.map((p) => [ms(p.time), p.p05]), 'transparent', { stack: 'b90', lineStyle: { width: 0 }, tooltip: { show: false } }),
        lineSeries(N.b90, path.map((p) => [ms(p.time), p.p95 - p.p05]), hexA(C.blue, 0.6), { stack: 'b90', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.blue, 0.13) }, tooltip: { show: false } }),
        lineSeries('_p25', path.map((p) => [ms(p.time), p.p25]), 'transparent', { stack: 'b50', lineStyle: { width: 0 }, tooltip: { show: false } }),
        lineSeries(N.b50, path.map((p) => [ms(p.time), p.p75 - p.p25]), hexA(C.purple, 0.8), { stack: 'b50', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.purple, 0.24) }, tooltip: { show: false } }),
        ...cycles.map((c, i) => lineSeries(c.label, c.path.filter((p) => p.day <= horizon).map((p) => [ms(p.time), p.value]), cycleColor(i, c.weight, maxW), {
          lineStyle: { width: i === 0 ? 1.6 : 1.1, color: cycleColor(i, c.weight, maxW), type: i === 0 ? 'solid' : 'dashed' }, z: 3,
        })),
        lineSeries(N.hist, hist.map((p) => [ms(p.time), p.value]), C.btc, {
          lineStyle: { width: 2, color: C.btc }, areaStyle: { color: areaGradient(C.btc, 0.12, 0) }, z: 4,
          markLine: {
            symbol: 'none', silent: true,
            data: [
              { xAxis: ms(today), lineStyle: { color: 'rgba(226,232,240,0.5)', type: 'dashed' }, label: { formatter: t('Oggi'), color: C.text, fontSize: 11, position: 'insideEndTop' } },
              ...events.map((e) => ({ xAxis: ms(e.time), lineStyle: { color: e.kind === 'top' ? hexA(C.down, 0.55) : e.kind === 'bottom' ? hexA(C.up, 0.55) : hexA(C.amber, 0.5), type: 'dotted' },
                label: { formatter: evLabel(e.kind, e.probable), color: C.muted, fontSize: 10, position: 'insideEndTop' } })),
            ],
          },
        }),
        lineSeries(N.med, path.map((p) => [ms(p.time), p.p50]), '#E6E9EF', { lineStyle: { width: 2, type: 'dashed', color: '#E6E9EF' }, z: 5 }),
      ],
    }
  }, [d, horizon, cycles])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ pesi dei modelli per orizzonte (barre impilate)
export function WeightsByHorizon({ d, className }: { d: ForecastV2; className?: string }) {
  // rows spread over the free height when the card is stretched next to the drivers card
  return (
    <div className={clsx('flex flex-col justify-around gap-2.5', className)}>
      {d.horizons.map((h) => (
        <div key={h.days} className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-3">
          <span className="tnum text-sm text-slate-300">{t('{n} g', { n: h.days })}</span>
          <div className="flex h-5 overflow-hidden rounded-md bg-white/[0.04]">
            {MEMBER_ORDER.map((k) => {
              const w = h.weights[k] ?? 0
              if (w < 0.5) return null
              return (
                <div key={k} className="flex items-center justify-center overflow-hidden border-r border-bg/60 text-2xs font-medium text-bg last:border-r-0"
                  style={{ width: `${w}%`, background: MEMBER_COLOR[k] }} title={`${t(MEMBER_SHORT[k])} · ${w.toFixed(0)}%`}>
                  {w >= 9 ? `${w.toFixed(0)}%` : ''}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-[64px] text-xs text-slate-400">
        {MEMBER_ORDER.map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: MEMBER_COLOR[k] }} />{t(MEMBER_SHORT[k])}</span>)}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ contributi delle variabili (barre con segno)
export function DriverBars({ top }: { top: Driver[] }) {
  const max = Math.max(...top.map((x) => Math.abs(x.contribution)), 0.01)
  return (
    <div className="flex flex-col">
      {top.map((x) => (
        <div key={x.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_56px] items-center gap-3 border-t border-line py-1.5 first:border-t-0">
          <div className="min-w-0">
            <div className="truncate text-sm text-slate-200" title={x.name}>{cap(t(x.name))}</div>
            <div className="truncate text-2xs text-slate-500">{t(x.group)}</div>
          </div>
          <div className="relative h-2 rounded-full bg-white/[0.04]">
            <span className="absolute inset-y-[-3px] left-1/2 w-px bg-white/20" />
            <span className={clsx('absolute inset-y-0 rounded-full', x.contribution >= 0 ? 'left-1/2 bg-up' : 'right-1/2 bg-down')}
              style={{ width: `${(Math.abs(x.contribution) / max) * 50}%` }} />
          </div>
          <span className={clsx('tnum text-right text-xs font-medium', x.contribution >= 0 ? 'text-up' : 'text-down')}>
            {x.contribution >= 0 ? '+' : '−'}{Math.abs(x.contribution).toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ calibrazione di P(rialzo)
export function CalibrationChart({ buckets, height = '100%' }: { buckets: CalBucket[]; height?: number | string }) {
  const option = useMemo(() => {
    const pts = buckets.filter((b) => b.n > 0 && b.predicted != null && b.observed != null)
    const maxN = Math.max(...pts.map((b) => b.n), 1)
    const OBS = t('Osservato'), PERF = t('Calibrazione perfetta')
    return {
      grid: { left: 8, right: 14, top: 14, bottom: 26, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'item',
        formatter: (p: { seriesName: string; value: [number, number, number] }) => p.seriesName === OBS
          ? `${tipHead(t('Fascia {a}–{b}%', { a: Math.floor(p.value[0] / 10) * 10, b: Math.floor(p.value[0] / 10) * 10 + 10 }))}${tipRow(C.blue, t('Previsto'), `${p.value[0].toFixed(0)}%`)}${tipRow('#E6E9EF', OBS, `${p.value[1].toFixed(0)}%`)}${tipRow(C.grey2, t('Casi'), String(p.value[2]))}`
          : '',
      },
      xAxis: { type: 'value', min: 0, max: 100, interval: 25, name: t('P(rialzo) prevista'), nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: C.muted, fontSize: 10 },
        axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: C.grid } }, axisLine: { lineStyle: { color: C.axis } } },
      yAxis: { type: 'value', min: 0, max: 100, interval: 25, position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: C.grid } } },
      series: [
        { name: PERF, type: 'line', data: [[0, 0], [100, 100]], symbol: 'none', silent: true, lineStyle: { color: hexA('#B3BCD0', 0.35), type: 'dashed', width: 1 } },
        { name: OBS, type: 'line', data: pts.map((b) => [b.predicted, b.observed, b.n]), smooth: false, lineStyle: { color: hexA(C.blue, 0.5), width: 1.2 },
          symbol: 'circle', symbolSize: (v: number[]) => 6 + 12 * Math.sqrt(v[2] / maxN), itemStyle: { color: C.blue, borderColor: '#0A0E17', borderWidth: 1 } },
      ],
    }
  }, [buckets])
  return <EChart option={option} height={height} />
}
