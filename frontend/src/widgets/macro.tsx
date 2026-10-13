import { useMemo, type ReactNode } from 'react'
import type { Pt } from '../api/types'
import type { LagAnalysis, Macro, RegimeStat } from '../api/macro'
import EChart from '../components/charts/EChart'
import { C, DIVERGING, FONT, areaGradient, axisLabel, dataZoomInside, dataZoomSlider, dateFmt, hexA, legendBase, lineSeries, timeAxis, toXY, tooltipBase, usdAxisFmt, valueAxis } from '../components/charts/theme'
import { Link } from 'react-router-dom'
import { ArrowRight, Gauge } from 'lucide-react'
import { useMacro } from '../api/macro'
import { Badge, Card, CardBody, CardHeader, ICON, Q, Skeleton, ToneBadge, clsx } from '../components/ui'
import { dayUnit, pct, usdCompact } from '../lib/format'
import { cap, t, tr } from '../i18n'

// ------------------------------------------------------------------ helpers
type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
type Tip = { seriesName: string; value: [number, number | null]; color: string }

function row(color: string, name: string, val: string) {
  return `<div style="display:flex;justify-content:space-between;gap:16px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`
}


/** Vertical cycle annotations (tops / bottoms / halvings) as an echarts markLine. */
function cycleMarkLine(marks: Macro['rotation']['cycle_marks']) {
  return {
    symbol: 'none', silent: true,
    data: marks.map((m) => ({
      xAxis: m.time * 1000,
      lineStyle: { color: hexA(C.grey, m.kind === 'halving' ? 0.3 : 0.45), type: m.kind === 'halving' ? 'dotted' : 'dashed', width: 1 },
      label: { formatter: m.kind === 'halving' ? 'H' : m.kind === 'top' ? 'Top' : 'Bottom', color: C.muted, fontSize: 10, fontFamily: FONT, position: 'insideEndTop' },
    })),
  }
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mt-3 border-b border-line pb-2 pt-2">
      <h2 className="text-lg font-semibold text-white">{children}</h2>
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
    </div>
  )
}

// ------------------------------------------------------------------ liquidity
export function LiquidityOverlayChart({ lag, btcPrice, mode, height = 340 }: { lag: LagAnalysis; btcPrice: Pt[]; mode: 'shift' | 'level'; height?: number | string }) {
  const option = useMemo(() => {
    const shift = mode === 'shift'
    const short = lag.key === 'stables' ? 'Stablecoin' : lag.key === 'm2' ? 'M2' : t('Liq. netta USA')
    const du = dayUnit()
    const liqName = shift ? t('{s} var. {p} (+{n})', { s: short, p: `90${du}`, n: `${lag.best_lag}${du}` }) : `${short} (USD)`
    const btcName = shift ? t('BTC · var. {p}', { p: `90${du}` }) : 'BTC (USD)'
    const start = lag.btc_change[0]?.time ?? 0
    const btcLevel = btcPrice.filter((p) => p.time >= start)
    const fL = shift ? (v: number) => `${v.toFixed(0)}%` : (v: number) => usdCompact(v, 0)
    const fR = shift ? (v: number) => `${v.toFixed(0)}%` : usdAxisFmt
    const now = Date.now()
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: [btcName, liqName] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: Tip[]) => `<div style="color:${C.muted};margin-bottom:4px">${dateFmt(ps[0]?.value[0])}</div>` +
          ps.filter((p) => p.value[1] != null).map((p) => row(p.color, p.seriesName, p.seriesName === btcName ? fR(p.value[1] as number) : fL(p.value[1] as number))).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ position: 'left', axisLabel: { ...axisLabel, formatter: fL }, ...(shift ? {} : { type: 'log' }) }),
        valueAxis({ position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: fR }, ...(shift ? {} : { type: 'log' }) }),
      ],
      series: [
        lineSeries(btcName, toXY(shift ? lag.btc_change : btcLevel), C.btc, { yAxisIndex: 1 }),
        lineSeries(liqName, toXY(shift ? lag.liq_change_shifted : lag.liq_level), C.blue, {
          yAxisIndex: 0, areaStyle: shift ? undefined : { color: areaGradient(C.blue, 0.12) },
          markLine: shift ? { symbol: 'none', silent: true, lineStyle: { color: hexA(C.primary, 0.35), type: 'dashed' }, label: { color: C.muted, formatter: t('Oggi'), fontSize: 10, position: 'insideEndTop' }, data: [{ xAxis: now }] } : undefined,
        }),
      ],
    }
  }, [lag, btcPrice, mode])
  return <EChart option={option} height={height} />
}

export function LagBarsChart({ lag, height = 260 }: { lag: LagAnalysis; height?: number }) {
  const option = useMemo(() => ({
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: { name: string; value: number | null }[]) => `${t('Ritardo {n} giorni', { n: ps[0].name })}<br/><b>ρ ${fin(ps[0].value) ? ps[0].value.toFixed(3) : '—'}</b>` },
    xAxis: { type: 'category', data: lag.lags.map((l) => String(l.lag)), axisLabel: { ...axisLabel, formatter: (v: string) => `${v}${dayUnit()}` }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
    yAxis: valueAxis({ scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(1) } }),
    series: [{
      type: 'bar', barMaxWidth: 16,
      data: lag.lags.map((l) => ({
        value: l.corr,
        itemStyle: { color: l.lag === lag.best_lag ? C.blue : hexA(C.grey, 0.45), borderRadius: (l.corr ?? 0) < 0 ? [0, 0, 2, 2] : [2, 2, 0, 0] },
      })),
    }],
  }), [lag])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ dollar
export function DxyBtcChart({ d, inverted, height = 380 }: { d: Macro['dollar_rates']['dxy']; inverted: boolean; height?: number | string }) {
  const option = useMemo(() => {
    const dxyName = inverted ? t('DXY (asse ↓ invertito)') : 'DXY'
    const maName = t('DXY media {p}', { p: `200${dayUnit()}` })
    return {
    grid: { left: 8, right: 8, top: 34, bottom: 36, containLabel: true },
    legend: { ...legendBase, data: ['BTC (USD)', dxyName, maName] },
    tooltip: {
      ...tooltipBase, trigger: 'axis',
      formatter: (ps: Tip[]) => `<div style="color:${C.muted};margin-bottom:4px">${dateFmt(ps[0]?.value[0])}</div>` +
        ps.filter((p) => p.value[1] != null).map((p) => row(p.color, p.seriesName, p.seriesName.startsWith('BTC') ? usdAxisFmt(p.value[1] as number) : (p.value[1] as number).toFixed(2))).join(''),
    },
    dataZoom: [{ ...dataZoomInside, startValue: Date.now() - 6 * 365 * 86400e3 }, dataZoomSlider],
    xAxis: timeAxis(),
    yAxis: [
      valueAxis({ type: 'log', position: 'right', axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      valueAxis({ position: 'left', inverse: inverted, name: inverted ? t('↓ invertito') : undefined, nameLocation: 'start', nameGap: 10, nameTextStyle: { color: C.muted, fontSize: 10, align: 'left' }, splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(0) } }),
    ],
    series: [
      lineSeries('BTC (USD)', toXY(d.btc_series), C.btc, { yAxisIndex: 0 }),
      lineSeries(dxyName, toXY(d.series), C.blue, { yAxisIndex: 1, areaStyle: undefined }),
      lineSeries(maName, toXY(d.ma200_series), C.muted, { yAxisIndex: 1, lineStyle: { width: 1.25, color: C.muted, type: 'dashed' } }),
    ],
  }
  }, [d, inverted])
  return <EChart option={option} height={height} />
}

export function RegimeTable({ stats, current, fwd }: { stats: RegimeStat[]; current: string; fwd: number }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="tbl min-w-[420px]">
        <thead>
          <tr>
            <th className="pl-4">{t('Regime')}</th>
            <th className="text-right">{t('Tempo')}</th>
            <th className="text-right">{t('BTC {n} mediana', { n: `${fwd}${dayUnit()}` })}</th>
            <th className="text-right">{t('% positivi')}</th>
            <th className="pr-4 text-right">{t('Annualizzato')}</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.regime}>
              <td className="pl-4 text-slate-200">{cap(s.label)}{s.regime === current && <Badge color="blue" className="ml-2">{t('Ora')}</Badge>}</td>
              <td className="text-right text-slate-300">{fin(s.share) ? `${s.share.toFixed(0)}%` : '—'}</td>
              <td className={clsx('text-right font-medium', !fin(s.fwd_median) ? 'text-slate-400' : s.fwd_median >= 0 ? 'text-up' : 'text-down')}>{pct(s.fwd_median, 1)}</td>
              <td className="text-right text-slate-300">{fin(s.win_rate) ? `${s.win_rate.toFixed(0)}%` : '—'}</td>
              <td className={clsx('pr-4 text-right', !fin(s.ann_return) ? 'text-slate-400' : s.ann_return >= 0 ? 'text-up' : 'text-down')}>{pct(s.ann_return, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ correlations
export function CorrHeatmap({ assets, values, height = 360 }: { assets: { key: string; label: string }[]; values: (number | null)[][]; height?: number }) {
  const option = useMemo(() => {
    const SHORT: Record<string, string> = { spx: 'SPX', ndx: 'NDX', us10y: '10Y' }
    const labels = assets.map((a) => SHORT[a.key] ?? a.label)
    const data: [number, number, number | null][] = []
    values.forEach((r, i) => r.forEach((v, j) => data.push([j, labels.length - 1 - i, v])))
    return {
      grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, formatter: (p: { value: [number, number, number | null] }) => `${labels[p.value[0]]} · ${labels[labels.length - 1 - p.value[1]]}<br/><b>ρ ${fin(p.value[2]) ? p.value[2].toFixed(2) : '—'}</b>` },
      xAxis: { type: 'category', data: labels, axisLabel: { ...axisLabel, interval: 0, rotate: 0, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false } },
      yAxis: { type: 'category', data: [...labels].reverse(), axisLabel: { ...axisLabel, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } },
      visualMap: { show: false, min: -1, max: 1, inRange: { color: DIVERGING } },
      series: [{
        type: 'heatmap', data,
        label: { show: true, color: C.primary, fontSize: 10, fontFamily: FONT, formatter: (p: { value: [number, number, number | null] }) => (fin(p.value[2]) ? p.value[2].toFixed(2) : '—') },
        itemStyle: { borderColor: C.bg, borderWidth: 2, borderRadius: 2 },
        emphasis: { disabled: true },
      }],
    }
  }, [assets, values])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ rotation
export function SeriesWithMaChart({
  series, ma, name, color, marks, fmt, height = 340, bands,
}: {
  series: Pt[]; ma?: Pt[]; name: string; color: string; marks: Macro['rotation']['cycle_marks']; fmt: (v: number) => string; height?: number | string
  bands?: { from: number; to: number; color: string; label: string }[]
}) {
  const option = useMemo(() => {
    const maName = t('Media {p}', { p: `200${dayUnit()}` })
    const names = [name, ...(ma ? [maName] : [])]
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: names },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: Tip[]) => `<div style="color:${C.muted};margin-bottom:4px">${dateFmt(ps[0]?.value[0])}</div>` +
          ps.filter((p) => p.value[1] != null).map((p) => row(p.color, p.seriesName, fmt(p.value[1] as number))).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: valueAxis({ position: 'right', ...(bands ? { min: 0, max: 100, scale: false } : {}), axisLabel: { ...axisLabel, formatter: fmt } }),
      series: [
        lineSeries(name, toXY(series), color, {
          areaStyle: bands ? undefined : { color: areaGradient(color, 0.1) },
          markLine: cycleMarkLine(marks),
          markArea: bands ? { silent: true, data: bands.map((b) => [{ yAxis: b.from, itemStyle: { color: hexA(b.color, 0.07) }, label: { show: true, formatter: t(b.label), color: hexA(b.color, 0.9), fontSize: 10, position: 'insideTopLeft' } }, { yAxis: b.to }]) } : undefined,
        }),
        ...(ma ? [lineSeries(maName, toXY(ma), C.muted, { lineStyle: { width: 1.25, color: C.muted, type: 'dashed' } })] : []),
      ],
    }
  }, [series, ma, name, color, marks, fmt, bands])
  return <EChart option={option} height={height} />
}

export const ALT_BANDS = [
  { from: 0, to: 35, color: C.grey, label: 'BTC season' },
  { from: 65, to: 100, color: C.grey, label: 'Rotazione altcoin' },
]

/** Semi-circular 0..100 gauge with three zones: BTC season / neutrale / rotazione verso altcoin. */
export function AltseasonGauge({ value, size = 220 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(100, value))
  const r = 44, cx = 60, cy = 56
  const p = (a: number) => [cx + r * Math.cos(Math.PI * (1 - a)), cy - r * Math.sin(Math.PI * (1 - a))]
  const arc = (a0: number, a1: number) => {
    const [x0, y0] = p(a0), [x1, y1] = p(a1)
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`
  }
  const ang = Math.PI * (1 - v / 100)
  const nx = cx + (r - 12) * Math.cos(ang), ny = cy - (r - 12) * Math.sin(ang)
  const segs: [number, number][] = [[0, 0.35], [0.35, 0.65], [0.65, 1]]
  return (
    <svg viewBox="0 0 120 64" width={size} height={(size * 64) / 120} aria-label={`${t('Indice altseason')} ${v.toFixed(0)}`}>
      {segs.map(([a, b]) => {
        const active = v / 100 >= a && v / 100 <= b
        return <path key={a} d={arc(a + 0.008, b - 0.008)} stroke={active ? C.blue : hexA(C.grey, 0.22)} strokeWidth="7" fill="none" />
      })}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.primary} strokeWidth="2" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="3.5" fill={C.primary} />
    </svg>
  )
}

/** Horizontal 0..100 risk-off → risk-on bar with a marker. */
export function RiskMeter({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div>
      <div className="relative h-1.5 w-full rounded-full bg-white/[0.06]">
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
        <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-white" style={{ left: `${v}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-2xs text-slate-400"><span>Risk-off</span><span>{t('Neutrale')}</span><span>Risk-on</span></div>
    </div>
  )
}

/** Text tag for a score component: categorical, so neutral colours (no green/red). */
export function ScoreTag({ score, className }: { score: number; className?: string }) {
  const label = score > 20 ? tr('A favore', 'Supportive') : score < -20 ? tr('Contro', 'Headwind') : t('Neutrale')
  return <span className={clsx('shrink-0 rounded px-1.5 py-px text-2xs font-medium', score > 20 ? 'bg-white/[0.08] text-slate-100' : 'bg-white/[0.04] text-slate-400', className)}>{label}</span>
}

/** Diverging -100..100 bar for a score component (neutral fill; the direction is told by ScoreTag). */
export function ScoreBar({ score }: { score: number }) {
  const s = Math.max(-100, Math.min(100, score))
  const color = Math.abs(s) > 20 ? 'rgba(203,213,225,0.75)' : hexA(C.grey, 0.6)
  return (
    <div className="relative h-1.5 w-full rounded-full bg-white/[0.06]">
      <div className="absolute top-0 h-full w-px bg-white/25" style={{ left: '50%' }} />
      <div className="absolute top-0 h-full rounded-full" style={{ left: s >= 0 ? '50%' : `${50 + s / 2}%`, width: `${Math.abs(s) / 2}%`, background: color }} />
    </div>
  )
}

// ------------------------------------------------------------------ dashboard card
/** Compact "Contesto macro" card for the Dashboard: composite risk-on/off score + component bars. */
export function MacroMiniCard() {
  const q = useMacro()
  return (
    <Card className="h-full">
      <CardHeader title={t('Contesto macro')} subtitle={t('Punteggio risk-on / risk-off')} icon={<Gauge />}
        right={<Link to="/macro" className="link">{t('Dettagli')} <ArrowRight size={ICON.chip} /></Link>} />
      <CardBody className="flex flex-col gap-4">
        <Q q={q} compact loading={<div className="flex flex-col gap-3"><Skeleton className="h-10" /><Skeleton className="h-3" />{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>}>
          {(d) => {
            const s = d.summary
            return (
              <>
                <div className="flex h-10 items-center justify-between gap-3">
                  <div className="tnum text-3xl font-semibold leading-8 text-white">{s.score.toFixed(0)}<span className="ml-1 text-sm font-normal text-slate-400">/ 100</span></div>
                  <ToneBadge tone={s.tone} label={s.label} />
                </div>
                <RiskMeter value={s.score} />
                <div className="flex flex-col divide-y divide-white/[0.05]">
                  {s.components.map((c) => (
                    <div key={c.key} className="flex flex-col gap-1.5 py-2" title={c.text}>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium text-slate-200">{c.label}</span>
                        <span className="flex shrink-0 items-center gap-2"><span className="tnum text-slate-400">{c.value}</span><ScoreTag score={c.score} /></span>
                      </div>
                      <ScoreBar score={c.score} />
                    </div>
                  ))}
                </div>
                {s.bullets[0] && <p className="mt-auto text-sm leading-snug text-slate-300">{s.bullets[0]}</p>}
              </>
            )
          }}
        </Q>
      </CardBody>
    </Card>
  )
}
