// Analisi avanzata del ciclo: Orologio del ciclo, Miner, Confronto stesso giorno, Leva (CONTRACT.md § CYCLE ADVANCED).
import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity, AlarmClock, BarChart3, CalendarRange, Cpu, Flame, Gauge, GitCompareArrows, Hourglass, Info, Layers, LineChart,
  ListChecks, Pickaxe, Scale, Sigma, Target, Timer, TrendingUp, Zap,
} from 'lucide-react'
import {
  useCycleAdvanced, useCycleClock, useCycleCompare, useCycleLeverage, useCycleMiner,
  type AnchorKey, type CycleClock, type CycleCompare, type CycleLeverage, type CycleMiner, type HitRow, type N, type PhaseKey, type ReturnsH, type Zone,
} from '../api/cycleAdvanced'
import type { Pt } from '../api/types'
import EChart from '../components/charts/EChart'
import Sparkline from '../components/charts/Sparkline'
import {
  C, FONT, SERIES_COLORS, axisLabel, dataZoomInside, dataZoomSlider, dateFmt, hexA, legendBase, lineSeries, timeAxis, toXY, tooltipBase, usdAxisFmt, valueAxis, axisNum,
} from '../components/charts/theme'
import { Card, CardBody, CardHeader, Fill, IconBox, KpiCell, KpiStrip, MethodNote as SharedMethodNote, ProgressBar, Q, Segmented, Skeleton, Toggle, clsx } from '../components/ui'
import { date, dayUnit, int, monthYear, num, pct, usd, usdCompact } from '../lib/format'
import { getLang, t, tr } from '../i18n'

// ------------------------------------------------------------------ helpers
const ok = (v: N | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const signCls = (v: N | undefined) => (!ok(v) ? 'text-slate-400' : v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-slate-300')
/** Cycle zones are an ordered scale, not categories: single blue ramp (dim → bright). */
const ZONE_RAMP = ['#2B4F86', '#3A68B0', '#5B8DEF', '#7AA9FF', '#A9C8FF']
/** Re-colour zones coming from the API with the ramp. */
export const rampZones = (zones: Zone[]) => zones.map((z, i) => ({ ...z, color: ZONE_RAMP[Math.min(ZONE_RAMP.length - 1, Math.round((i * (ZONE_RAMP.length - 1)) / Math.max(1, zones.length - 1)))] }))
const DEFAULT_ZONES: Zone[] = [
  { from: 0, to: 20, key: 'bottom', label: 'Zona di minimo', color: ZONE_RAMP[0] },
  { from: 20, to: 40, key: 'accumulation', label: 'Accumulo', color: ZONE_RAMP[1] },
  { from: 40, to: 60, key: 'mid', label: 'Metà ciclo', color: ZONE_RAMP[2] },
  { from: 60, to: 80, key: 'euphoria', label: 'Euforia', color: ZONE_RAMP[3] },
  { from: 80, to: 100, key: 'top', label: 'Zona di massimo', color: ZONE_RAMP[4] },
]
export function zoneColor(v: N | undefined, zonesIn: Zone[] = DEFAULT_ZONES) {
  const zones = rampZones(zonesIn)
  if (!ok(v)) return C.muted
  return (zones.find((z) => v < z.to) ?? zones[zones.length - 1]).color
}
/** Ordinal suffix: 4° (IT) · 4th (EN). */
const ordSfx = (n: number) => (getLang() !== 'en' ? '°' : n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'))
const ord = (v: N | undefined) => (ok(v) ? `${v.toFixed(0)}${ordSfx(Math.round(v))}` : '—')
const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—')
/** Phase bands are categorical: distinct hues from the theme palette (no green/red — not up/down values). */
export const PHASE_COLOR: Record<PhaseKey, string> = { accumulation: C.teal, bull: C.blue, distribution: C.purple, bear: C.grey }
const PHASE_EN: Record<PhaseKey, string> = { accumulation: 'Accumulation', bull: 'Bull', distribution: 'Distribution', bear: 'Bear' }
const PHASE_IT: Record<PhaseKey, string> = { accumulation: 'Accumulo', bull: 'Rialzo', distribution: 'Distribuzione', bear: 'Ribasso' }
const phaseName = (p: PhaseKey) => tr(PHASE_IT[p], PHASE_EN[p])

function Kpi({ icon, label, value, sub, foot, hint }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; foot?: ReactNode; hint?: string }) {
  return <KpiCell icon={icon} label={label} value={value} delta={sub} foot={foot} title={hint ?? (typeof foot === 'string' ? foot : undefined)} />
}

/** Text wall → ≤`max` one-line bullets (full text on hover), max 72ch; "Mostra tutto" expands to the full, wrapped list. */
export function Bullets({ items, max = 3 }: { items: string[]; max?: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, max)
  const more = items.length > max || items.some((x) => x.length > 70)
  return (
    <div className="flex min-w-0 max-w-[72ch] flex-col">
      <ul className="flex min-w-0 flex-col text-sm text-slate-300">
        {shown.map((x, i) => (
          <li key={i} className="flex min-w-0 gap-2 border-t border-line py-1.5 first:border-t-0" title={all ? undefined : x}>
            <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-slate-500" />
            <span className={clsx('min-w-0', !all && 'truncate')}>{x}</span>
          </li>
        ))}
      </ul>
      {more && <button className="link mt-1 self-start" onClick={() => setAll(!all)}>{all ? t('Mostra meno') : items.length > max ? t('Mostra tutto ({n})', { n: items.length }) : t('Mostra tutto')}</button>}
    </div>
  )
}

function MethodNote({ text, extra }: { text: string; extra?: string[] }) {
  return (
    <SharedMethodNote>
      <p>{text}</p>
      {extra && extra.length > 0 && <ul className="list-disc space-y-1 pl-4">{extra.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    </SharedMethodNote>
  )
}

const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:16px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b>${val}</b></div>`
const tipHead = (s: string) => `<div style="color:#94a3b8;margin-bottom:4px">${s}</div>`

// ------------------------------------------------------------------ Gauge "orologio"
const START = 210, SWEEP = 240
function polar(cx: number, cy: number, r: number, v: number) {
  const a = ((START - (v / 100) * SWEEP) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}
function arcPath(cx: number, cy: number, r: number, v0: number, v1: number) {
  const [x0, y0] = polar(cx, cy, r, v0), [x1, y1] = polar(cx, cy, r, v1)
  const large = ((v1 - v0) / 100) * SWEEP > 180 ? 1 : 0
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`
}

/** Quadrante 0–100 a 240° con le 5 zone del ciclo e la lancetta sul Cycle Score. */
export function CycleClockGauge({ score, zones = DEFAULT_ZONES, size = 240, showLabels = true }: { score: N; zones?: Zone[]; size?: number; showLabels?: boolean }) {
  const v = ok(score) ? Math.max(0, Math.min(100, score)) : null
  const cx = 100, cy = 100, r = 78
  zones = rampZones(zones)
  const col = zoneColor(v, zones)
  const [nx, ny] = polar(cx, cy, r - 18, v ?? 0)
  return (
    <svg viewBox="0 0 200 172" width={size} height={(size * 172) / 200} role="img" aria-label={t('Cycle Score {v} su 100', { v: v != null ? v.toFixed(0) : t('n/d') })}>
      <path d={arcPath(cx, cy, r, 0, 100)} stroke="rgba(148,163,184,0.10)" strokeWidth="16" fill="none" />
      {zones.map((z) => {
        const active = v != null && v >= z.from && (v < z.to || (z.to >= 100 && v <= 100))
        return (
          <path key={z.key} d={arcPath(cx, cy, r, z.from + 0.6, Math.min(z.to, 100) - 0.6)} stroke={z.color} strokeWidth="14" fill="none"
            strokeOpacity={active ? 1 : 0.28} />
        )
      })}
      {Array.from({ length: 21 }).map((_, i) => {
        const t = i * 5
        const [x0, y0] = polar(cx, cy, r - 11, t), [x1, y1] = polar(cx, cy, r - (i % 4 === 0 ? 17 : 14), t)
        return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(148,163,184,0.45)" strokeWidth={i % 4 === 0 ? 1.4 : 0.8} />
      })}
      {showLabels && [0, 20, 40, 60, 80, 100].map((t) => {
        const [x, y] = polar(cx, cy, r + 15, t)
        return <text key={t} x={x} y={y + 3} textAnchor="middle" fontSize="11" fill="#8B94A7" fontFamily={FONT}>{t}</text>
      })}
      {v != null && (
        <>
          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#E6E9EF" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={cx} cy={cy} r="5" fill="#E6E9EF" />
          <circle cx={cx} cy={cy} r="2.5" fill={col} />
        </>
      )}
      <text x={cx} y={cy + 40} textAnchor="middle" fontSize="30" fontWeight="600" fill="#E6E9EF" fontFamily={FONT}>{v != null ? v.toFixed(0) : '—'}</text>
      <text x={cx} y={cy + 56} textAnchor="middle" fontSize="11" fill="#8B94A7" fontFamily={FONT}>SCORE / 100</text>
    </svg>
  )
}

/** Widget compatto (stessa geometria delle KPI della Dashboard): score, zona, variazione 30 g, sparkline 1 anno, mini quadrante. */
export function CycleClockMini({ className }: { className?: string }) {
  const q = useCycleAdvanced()
  const c = q.data?.clock
  const col = zoneColor(c?.score, c?.zones)
  return (
    <Card className={clsx('h-full overflow-hidden p-4', className)}>
      <div className="flex h-8 items-center gap-2.5">
        <IconBox icon={<AlarmClock />} color={col === C.muted ? C.purple : col} />
        <span className="truncate text-sm font-medium text-slate-300">{t('Orologio del ciclo')}</span>
        <span className="ml-auto shrink-0 rounded bg-white/[0.05] px-1.5 text-2xs font-medium leading-5 text-slate-400">0–100</span>
      </div>
      <div className="mt-3 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex h-8 items-center">
            {c ? <span className="tnum truncate text-3xl font-bold leading-8 tracking-tight" style={{ color: col }}>{ok(c.score) ? c.score.toFixed(0) : '—'}</span>
              : q.isError ? <span className="text-sm text-slate-400">—</span> : <Skeleton className="h-7 w-14" />}
          </div>
          <div className="mt-1 flex h-5 items-center gap-1.5 overflow-hidden whitespace-nowrap text-sm">
            {c && <><span className="truncate font-medium" style={{ color: col }}>{cap(c.zone_label)}</span>
              {ok(c.change_30d) && <span className={clsx('tnum text-xs', signCls(c.change_30d))}>{c.change_30d > 0 ? '+' : ''}{c.change_30d.toFixed(0)} pt (30{dayUnit()})</span>}</>}
          </div>
          <div className="pointer-events-none mt-2 h-10">{c && <Sparkline data={c.spark} color={col} height={40} />}</div>
        </div>
        {c && <div className="shrink-0 pb-1"><CycleClockGauge score={c.score} zones={c.zones} size={112} showLabels={false} /></div>}
      </div>
    </Card>
  )
}

// ================================================================== TAB: OROLOGIO DEL CICLO

function ClockCard({ d, updatedAt }: { d: CycleClock; updatedAt?: number }) {
  const c = d.current
  return (
    <Card className="h-full">
      <CardHeader title={t('Orologio del ciclo')} icon={<AlarmClock />} updatedAt={updatedAt} subtitle={t('Cycle Score composito: 0 = zona di minimo, 100 = zona di massimo')}
        right={c.live ? <span className="inline-flex items-center gap-1.5 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-up" />{t('Live')}</span> : undefined} />
      <CardBody className="flex flex-col items-center gap-4">
        <div className="flex w-full flex-col items-center">
          <CycleClockGauge score={c.score} zones={d.zones} size={220} />
          <span className="-mt-1 text-lg font-semibold text-white">{cap(c.zone_label)}</span>
        </div>
        <div className="grid w-full grid-cols-3 gap-2 text-center">
          {([[7, c.change_7d], [30, c.change_30d], [90, c.change_90d]] as const).map(([n, v]) => (
            <div key={n} className="px-2 py-1">
              <div className={clsx('tnum text-lg font-semibold', signCls(v))}>{ok(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}` : '—'} <span className="text-xs font-normal text-slate-500">pt</span></div>
              <div className="text-2xs text-slate-400">{t('In {n} giorni', { n })}</div>
            </div>
          ))}
        </div>
        <div className="w-full">
          <div className="flex h-2 w-full overflow-hidden rounded-full">
            {rampZones(d.zones).map((z) => <div key={z.key} style={{ width: `${z.to - z.from}%`, background: z.color }} />)}
          </div>
          <div className="mt-1.5 grid grid-cols-5 text-center text-2xs leading-3 text-slate-400">
            {d.zones.map((z) => <span key={z.key}>{cap(z.label)}</span>)}
          </div>
        </div>
        <div className="w-full"><Bullets items={c.text} /></div>
        {ok(c.score_equal) && <div className="w-full text-xs text-slate-400">{t('Variante a pesi uguali:')} <b className="tnum text-slate-300">{c.score_equal.toFixed(0)}</b>/100</div>}
      </CardBody>
    </Card>
  )
}

/** Percentile track: dim zone ramp background, bar filled up to the percentile in the zone colour, white marker. */
function PctTrack({ v, zones }: { v: N; zones: Zone[] }) {
  const x = ok(v) ? Math.max(0, Math.min(100, v)) : null
  return (
    <div className="relative h-3 w-full">
      <div className="absolute inset-x-0 top-1/2 flex h-1.5 -translate-y-1/2 overflow-hidden rounded-full">
        {rampZones(zones).map((z) => <div key={z.key} className="h-full border-r-2 border-black/40 last:border-r-0" style={{ width: `${z.to - z.from}%`, background: hexA(z.color, 0.22) }} />)}
      </div>
      {x != null && <>
        <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ width: `${x}%`, background: zoneColor(x, zones) }} />
        <span className="absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full bg-white" style={{ left: `${x}%` }} />
      </>}
    </div>
  )
}

function ComponentsCard({ d }: { d: CycleClock }) {
  const zones = d.zones.length ? d.zones : DEFAULT_ZONES
  const zoneOf = (v: N) => (ok(v) ? zones.find((z) => v < z.to) ?? zones[zones.length - 1] : null)
  const comps = d.current.components
  const maxContrib = Math.max(1, ...comps.map((c) => (ok(c.pct) ? (c.pct * c.weight) / 100 : 0)))
  // name | track | percentile | zone (2xl) | weight | contribution (2xl)
  const cols = 'sm:grid-cols-[minmax(140px,200px)_minmax(0,1fr)_40px_60px] 2xl:grid-cols-[minmax(180px,240px)_minmax(0,1fr)_44px_120px_60px_minmax(110px,160px)]'
  return (
    <Card className="h-full">
      <CardHeader title={t('Componenti dello score')} icon={<Layers />} subtitle={t('Percentile storico senza lookahead (0–100) · peso attuale walk-forward')} />
      <CardBody>
        <div className={clsx('label hidden items-center gap-x-4 pb-2 sm:grid', cols)}>
          <span>{t('Indicatore')}</span>
          <span className="flex justify-between">{[0, 20, 40, 60, 80, 100].map((x) => <span key={x} className="tnum">{x}</span>)}</span>
          <span className="text-right">{t('Perc.')}</span>
          <span className="hidden 2xl:block">{t('Zona')}</span>
          <span className="text-right">{t('Peso')}</span>
          <span className="hidden text-right 2xl:block" title={t('Punti di score apportati = percentile × peso')}>{t('Contributo')}</span>
        </div>
        <div className="flex flex-col divide-y divide-white/[0.05] border-t border-white/[0.05]">
          {comps.map((c) => {
            const z = zoneOf(c.pct)
            const contrib = ok(c.pct) ? (c.pct * c.weight) / 100 : null
            return (
              <div key={c.key} className={clsx('grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-2', cols)}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-200" title={c.description}>{c.label}</div>
                  <div className="tnum truncate text-xs text-slate-400" title={c.display}>{c.display}</div>
                </div>
                <div className="order-3 col-span-2 sm:order-none sm:col-span-1"><PctTrack v={c.pct} zones={zones} /></div>
                <span className="tnum text-right text-sm font-semibold text-white">{ok(c.pct) ? c.pct.toFixed(0) : '—'}</span>
                <span className="hidden min-w-0 truncate text-xs text-slate-300 2xl:block">{z ? cap(z.label) : '—'}</span>
                <span className="tnum order-4 col-span-2 text-xs text-slate-400 sm:order-none sm:col-span-1 sm:text-right">
                  <span className="sm:hidden">{t('Peso')} </span><b className="font-medium text-slate-200">{c.weight.toFixed(1)}%</b>
                  {contrib != null && <span className="sm:hidden"> · {t('Contributo')} <b className="font-medium text-slate-200">{contrib.toFixed(1)} pt</b>{z ? ` · ${cap(z.label)}` : ''}</span>}
                </span>
                <span className="hidden items-center justify-end gap-2 2xl:flex">
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.05]"><span className="block h-full rounded-full" style={{ width: `${((contrib ?? 0) / maxContrib) * 100}%`, background: C.grey2 }} /></span>
                  <span className="tnum w-12 text-right text-xs text-slate-200">{contrib != null ? `${contrib.toFixed(1)} pt` : '—'}</span>
                </span>
              </div>
            )
          })}
        </div>
      </CardBody>
    </Card>
  )
}

function ScoreHistoryChart({ d }: { d: CycleClock }) {
  const [eq, setEq] = useState(false)
  const [showPrice, setShowPrice] = useState(true)
  const option = useMemo(() => {
    const PRICE = t('Prezzo BTC')
    const tops = d.backtest.events.filter((e) => e.kind === 'top')
    const bots = d.backtest.events.filter((e) => e.kind === 'bottom')
    const series: unknown[] = [
      lineSeries('Cycle Score', toXY(d.history), C.purple, {
        lineStyle: { width: 1.5, color: C.blue }, z: 5,
        markArea: { silent: true, data: rampZones(d.zones).map((z) => [{ yAxis: z.from, itemStyle: { color: hexA(z.color, 0.06) } }, { yAxis: z.to }]) },
        markLine: { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: 'rgba(148,163,184,0.35)' }, label: { show: false }, data: [{ yAxis: 20 }, { yAxis: 80 }] },
      }),
      { name: t('Massimi di ciclo'), type: 'scatter', symbol: 'triangle', symbolSize: 10, z: 9, itemStyle: { color: '#E6E9EF' }, data: tops.map((e) => [e.time * 1000, e.score]) },
      { name: t('Minimi di ciclo'), type: 'scatter', symbol: 'triangle', symbolRotate: 180, symbolSize: 10, z: 9, itemStyle: { color: '#8B94A7' }, data: bots.map((e) => [e.time * 1000, e.score]) },
    ]
    if (eq) series.push(lineSeries(t('Pesi uguali'), toXY(d.history_equal), C.grey, { lineStyle: { width: 1.25, color: C.grey, type: 'dashed' } }))
    if (showPrice) series.push(lineSeries(PRICE, toXY(d.price), C.btc, { yAxisIndex: 1, lineStyle: { width: 1.25, color: C.btc, opacity: 0.7 } }))
    return {
      grid: { left: 8, right: 8, top: 36, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: (series as { name: string }[]).map((s) => s.name) },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(dateFmt(ps[0]?.value[0])) +
          ps.filter((p) => p.value[1] != null).map((p) => tipRow(p.color, p.seriesName, p.seriesName === PRICE ? usd(p.value[1]) : `${p.value[1].toFixed(0)} / 100`)).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ min: 0, max: 100, scale: false, interval: 20, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}` } }),
        valueAxis({ type: 'log', position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: usdAxisFmt }, show: showPrice }),
      ],
      series,
    }
  }, [d, eq, showPrice])
  return (
    <Card>
      <CardHeader title={t('Storico del Cycle Score')} icon={<LineChart />} subtitle={t('Score giornaliero (settimanale prima degli ultimi 2 anni) · ▲ massimi e ▼ minimi di ciclo rilevati')}
        right={<><Toggle on={showPrice} onClick={() => setShowPrice(!showPrice)} color="#E6E9EF">{t('Prezzo (log)')}</Toggle><Toggle on={eq} onClick={() => setEq(!eq)} color={C.cyan}>{t('Pesi uguali')}</Toggle></>} />
      <CardBody><EChart option={option} height={420} /></CardBody>
    </Card>
  )
}

function BacktestCard({ d }: { d: CycleClock }) {
  const bt = d.backtest
  return (
    <Card className="h-full">
      <CardHeader title={t('Backtest ai massimi e minimi')} icon={<Target />}
        subtitle={t('Media ai massimi {a} · ai minimi {b} · anticipo = primo attraversamento nei 365 g prima', { a: ok(bt.mean_at_tops) ? bt.mean_at_tops.toFixed(0) : '—', b: ok(bt.mean_at_bottoms) ? bt.mean_at_bottoms.toFixed(0) : '—' })} />
      <CardBody className="px-2">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>{t('Evento')}</th><th>{t('Data')}</th><th className="text-right">{t('Prezzo')}</th><th className="text-right">Score</th><th className="text-right">{t('Estremo ±30 g')}</th><th className="text-right">{t('Estremo 12 mesi')}</th><th className="text-right">{t('Anticipo soglia 1')}</th><th className="text-right">{t('Anticipo soglia 2')}</th></tr></thead>
            <tbody>
              {bt.events.map((e) => (
                <tr key={`${e.kind}${e.time}`}>
                  <td className="text-white">{e.kind === 'top' ? tr('Massimo', 'Top') : e.probable ? t('Minimo prob.') : tr('Minimo', 'Low')}</td>
                  <td>{date(e.time)}</td>
                  <td className="text-right">{usd(e.price)}</td>
                  <td className="text-right text-white">{ok(e.score) ? e.score.toFixed(0) : '—'}</td>
                  <td className="text-right">{ok(e.extreme_30d) ? e.extreme_30d.toFixed(0) : '—'}</td>
                  <td className="text-right">{ok(e.extreme_365) ? <>{e.extreme_365.toFixed(0)} <span className="text-xs text-slate-400">{monthYear(e.extreme_365_time)}</span></> : '—'}</td>
                  <td className="text-right">{ok(e.lead_1) ? `${int(e.lead_1)} ${dayUnit()}` : <span className="text-slate-400">{t('Mai')} {e.kind === 'top' ? '≥' : '≤'}{e.thresholds[0]}</span>}</td>
                  <td className="text-right">{ok(e.lead_2) ? `${int(e.lead_2)} ${dayUnit()}` : <span className="text-slate-400">{t('Mai')} {e.kind === 'top' ? '≥' : '≤'}{e.thresholds[1]}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-3 pt-3 text-xs text-slate-400">{t('Soglie: massimi 80 / 90, minimi 20 / 10. "Estremo 12 mesi" = punto più alto (massimi) o più basso (minimi) dello score nei 365 g prima dell\'evento.')}</p>
      </CardBody>
    </Card>
  )
}

function SignalsCard({ d }: { d: CycleClock }) {
  return (
    <Card className="h-full">
      <CardHeader title={t('Affidabilità dei segnali')} icon={<ListChecks />} subtitle={t('Episodi sopra/sotto soglia · vero = evento di ciclo tra −60 e +365 g')} />
      {/* stretched next to the backtest table: the signal blocks spread over the card height */}
      <CardBody className="flex flex-col justify-between gap-3">
        {d.backtest.signals.map((s) => {
          const label = `${s.direction === 'above' ? t('Sopra') : t('Sotto')} ${s.threshold}`
          return (
            <div key={label} className="border-t border-line py-2 first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">{label}</span>
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="tnum text-slate-300">{t('{a} veri · {b} falsi', { a: s.true, b: s.false })}{s.pending > 0 ? ` · ${t('{n} in corso', { n: s.pending })}` : ''}</span>
                </span>
              </div>
              {s.true + s.false > 0 && (
                <div className="mt-1.5 flex items-center gap-2">
                  <ProgressBar value={(s.true / (s.true + s.false)) * 100} color={s.true >= s.false ? C.up : C.down} className="h-1 flex-1" />
                  <span className="tnum w-9 text-right text-2xs text-slate-400">{Math.round((s.true / (s.true + s.false)) * 100)}%</span>
                </div>
              )}
              <p className="tnum mt-1 text-xs text-slate-400">
                {s.items.map((i, k) => (
                  <span key={i.start} title={`${date(i.start)} → ${date(i.end)} · ${i.days} ${dayUnit()} · ${t('Estremo {v}', { v: i.extreme.toFixed(0) })}${i.lead != null ? ` · ${t('Evento dopo {n} g', { n: i.lead })}` : ''}`}
                    className={i.status === 'falso' ? 'text-slate-300 line-through decoration-slate-500' : i.status === 'vero' ? 'text-slate-300' : 'text-slate-400'}>
                    {monthYear(i.start)}{k < s.items.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </p>
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}

function ComponentsHistoryChart({ d }: { d: CycleClock }) {
  const option = useMemo(() => {
    const comps = d.current.components
    return {
      grid: { left: 8, right: 8, top: 56, bottom: 36, containLabel: true },
      legend: { ...legendBase, type: 'scroll', pageTextStyle: { color: C.muted }, data: comps.map((c) => c.label),
        selected: Object.fromEntries(comps.map((c) => [c.label, ['mvrv_z', 'pi', 'halving'].includes(c.key)])) },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(dateFmt(ps[0]?.value[0])) + ps.filter((p) => p.value[1] != null).map((p) => tipRow(p.color, p.seriesName, p.value[1].toFixed(0))).join('') },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: valueAxis({ min: 0, max: 100, scale: false, interval: 20 }),
      series: comps.map((c, i) => lineSeries(c.label, toXY(d.components_history[c.key]), [...SERIES_COLORS, C.grey][i % 9], { lineStyle: { width: 1.3 } })),
    }
  }, [d])
  return (
    <Card>
      <CardHeader title={t('Storico delle componenti')} icon={<Sigma />} subtitle={t('Percentile (0–100) di ciascuna componente, settimanale · clic sulla legenda per mostrare/nascondere')} />
      <CardBody><EChart option={option} height={340} /></CardBody>
    </Card>
  )
}

export function ClockTab() {
  const q = useCycleClock()
  return (
    <Q q={q} loading={<div className="grid gap-3 xl:grid-cols-12"><Skeleton className="h-[560px] xl:col-span-4" /><Skeleton className="h-[560px] xl:col-span-8" /></div>}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 xl:grid-cols-12">
            <div className="xl:col-span-4"><ClockCard d={d} updatedAt={q.dataUpdatedAt} /></div>
            <div className="xl:col-span-8"><ComponentsCard d={d} /></div>
          </div>
          <ScoreHistoryChart d={d} />
          <div className="grid gap-3 xl:grid-cols-12">
            <div className="xl:col-span-8"><BacktestCard d={d} /></div>
            <div className="xl:col-span-4"><SignalsCard d={d} /></div>
          </div>
          <ComponentsHistoryChart d={d} />
          <MethodNote text={d.method} />
        </div>
      )}
    </Q>
  )
}

// ================================================================== TAB: MINER

const hrFmt = (v: number) => (v >= 1000 ? `${num(v / 1000, 0)}K` : num(v, 0))
const retCell = (r: ReturnsH, h: '30' | '90' | '180') => {
  const v = r[h]
  return <span className={clsx('font-medium', signCls(v))}>{ok(v) ? pct(v, 0) : '—'}</span>
}

function MinerKpis({ d }: { d: CycleMiner }) {
  const c = d.current
  return (
    <KpiStrip cols="grid-cols-1 min-[480px]:grid-cols-2 xl:grid-cols-4">
      <Kpi icon={<Pickaxe />} label={t('Stato Hash Ribbons')}
        value={c.state === 'capitulation' ? t('Capitolazione') : c.state === 'recovery' ? t('Ripresa') : t('Espansione')}
        sub={<span className="text-slate-300">{t('Da {n} g', { n: int(c.days_in_state) })} · SMA30/60 <b className={signCls(c.ribbon_gap)}>{pct(c.ribbon_gap, 1)}</b></span>}
        foot={c.last_signal ? t('Segnale {d}', { d: date(c.last_signal.time) }) : t('Nessun segnale storico')}
        hint={c.last_signal ? t('Ultimo segnale {d} ({n} g fa) dopo {c} g di capitolazione', { d: date(c.last_signal.time), n: int(c.days_since_signal), c: c.last_signal.cap_days }) : undefined} />
      <Kpi icon={<Cpu />} label={t('Hashrate (media 30 g)')}
        value={<>{num(c.sma30, 0)} <span className="text-sm font-normal text-slate-400">EH/s</span></>}
        sub={<span className="text-slate-300">{t('Dal massimo')} <b className={signCls(c.hr_drawdown)}>{pct(c.hr_drawdown, 1)}</b></span>}
        foot={t('SMA 60: {b} EH/s', { b: num(c.sma60, 0) })}
        hint={t('Ultimo dato giornaliero {a} EH/s · SMA 60 {b} EH/s', { a: num(c.hashrate, 0), b: num(c.sma60, 0) })} />
      <Kpi icon={<Layers />} label="Difficulty Ribbon"
        value={<>{num(c.ribbon_compression, 1)}%</>}
        sub={<span className="text-slate-300">{t('Percentile {v}', { v: ord(c.ribbon_compression_pct) })}</span>}
        foot={c.ribbon_inverted ? t('Invertito') : t('Compressione SMA 9…200 g')}
        hint={t('Distanza tra la SMA più alta e la più bassa (9…200 g) della difficoltà stimata: bassa = crescita in stallo, stress dei miner.')} />
      <Kpi icon={<Zap />} label="Puell Multiple"
        value={num(c.puell, 2)}
        sub={<span className="text-slate-300">{t('Emissione')} <b className="text-white">{usdCompact(c.issuance_usd, 1)}</b>/{t('giorno')}</span>}
        foot={<>{t('Ricavi 90 g')} <span className={signCls(c.issuance_change_90d)}>{pct(c.issuance_change_90d, 0)}</span></>}
        hint={t('Ricavi da emissione (media 30 g), variazione in 90 giorni · commissioni escluse')} />
    </KpiStrip>
  )
}

function HashRibbonChart({ d, updatedAt }: { d: CycleMiner; updatedAt?: number }) {
  const option = useMemo(() => {
    const now = Date.now()
    const N = { price: t('Prezzo BTC'), sig: t('Segnale Hash Ribbon'), mom: t('Con conferma momentum') }
    const capAreas = d.capitulations.map((p) => [{ xAxis: p.from * 1000, itemStyle: { color: hexA(C.amber, 0.08) } }, { xAxis: (p.to ?? now / 1000) * 1000 }])
    const priceMap = new Map(d.series.price.map((p) => [p.time, p.value]))
    const nearestPrice = (t: number) => {
      if (priceMap.has(t)) return priceMap.get(t)
      let best: N = null, bd = Infinity
      for (const p of d.series.price) { const dd = Math.abs(p.time - t); if (dd < bd) { bd = dd; best = p.value } }
      return best
    }
    return {
      grid: [{ left: 8, right: 8, top: 56, height: '46%', containLabel: true }, { left: 8, right: 8, top: '68%', bottom: 36, containLabel: true }],
      legend: { ...legendBase, data: [N.price, N.sig, N.mom, 'Hashrate SMA 30', 'Hashrate SMA 60'] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(dateFmt(ps[0]?.value[0])) +
          ps.filter((p) => p.value[1] != null).map((p) => tipRow(p.color, p.seriesName, p.seriesName.startsWith('Hashrate') ? `${num(p.value[1], 0)} EH/s` : usd(p.value[1]))).join(''),
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      dataZoom: [{ ...dataZoomInside, xAxisIndex: [0, 1], startValue: Date.UTC(2014, 0, 1) }, { ...dataZoomSlider, xAxisIndex: [0, 1], startValue: Date.UTC(2014, 0, 1) }],
      xAxis: [timeAxis({ gridIndex: 0, axisLabel: { show: false } }), timeAxis({ gridIndex: 1 })],
      yAxis: [
        valueAxis({ type: 'log', gridIndex: 0, axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
        valueAxis({ type: 'log', gridIndex: 1, min: 1, logBase: 10, axisLabel: { ...axisLabel, formatter: hrFmt }, name: 'EH/s', nameLocation: 'end', nameGap: 6, nameTextStyle: { color: C.muted, fontSize: 11 } }),
      ],
      series: [
        lineSeries(N.price, toXY(d.series.price), C.btc, { lineStyle: { width: 1.5, color: C.btc }, markArea: { silent: true, data: capAreas } }),
        { name: N.sig, type: 'scatter', symbol: 'circle', symbolSize: 8, z: 10, itemStyle: { color: C.up, borderColor: '#0A0E17', borderWidth: 1 }, data: d.signals.map((s) => [s.time * 1000, s.price]) },
        { name: N.mom, type: 'scatter', symbol: 'diamond', symbolSize: 9, z: 11, itemStyle: { color: C.btc, borderColor: '#0A0E17', borderWidth: 1 },
          data: d.signals.filter((s) => s.momentum_time != null && s.momentum_time !== s.time).map((s) => [s.momentum_time! * 1000, nearestPrice(s.momentum_time!)]) },
        lineSeries('Hashrate SMA 30', toXY(d.series.sma30), C.cyan, { xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1.4, color: C.cyan } }),
        lineSeries('Hashrate SMA 60', toXY(d.series.sma60), C.pink, { xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1.4, color: C.pink } }),
      ],
    }
  }, [d])
  return (
    <Card className="h-full">
      <CardHeader title="Hash Ribbons" icon={<Activity />} updatedAt={updatedAt} subtitle={t('Bande ambra = capitolazione dei miner')} info={t("Bande ambra = capitolazione (SMA30 < SMA60 dell'hashrate) · ● segnale di fine capitolazione · ◆ conferma con SMA10 > SMA20 del prezzo.")} />
      <CardBody className="flex flex-col"><Fill min={420}><EChart option={option} height="100%" /></Fill></CardBody>
    </Card>
  )
}

type MinerView = 'ribbon' | 'compression' | 'drawdown' | 'puell' | 'issuance'
function MinerStressChart({ d }: { d: CycleMiner }) {
  const [v, setV] = useState<MinerView>('ribbon')
  const option = useMemo(() => {
    const base = { grid: { left: 8, right: 8, top: 36, bottom: 36, containLabel: true }, dataZoom: [dataZoomInside, dataZoomSlider], xAxis: timeAxis() }
    const tip = (fmt: (x: number) => string) => ({ ...tooltipBase, trigger: 'axis', formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(dateFmt(ps[0]?.value[0])) + ps.filter((p) => p.value[1] != null).map((p) => tipRow(p.color, p.seriesName, fmt(p.value[1]))).join('') })
    if (v === 'ribbon') {
      const cols = ['#A9C8FF', '#8DB6FF', '#7AA9FF', '#5E98FF', '#5B8DEF', '#3A75D6', '#2E62B4', '#244F91']
      return {
        ...base, legend: { ...legendBase, type: 'scroll', data: d.ribbon.periods.map((p) => `SMA ${p}`), pageTextStyle: { color: C.muted } },
        tooltip: tip((x) => `${num(x, 0)} EH/s`),
        yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: axisNum } }),
        series: d.ribbon.periods.map((p, k) => lineSeries(`SMA ${p}`, d.ribbon.times.map((t, i) => [t * 1000, d.ribbon.values[i][k]]), cols[k], { lineStyle: { width: 1.25, color: cols[k] } })),
      }
    }
    const map: Record<Exclude<MinerView, 'ribbon'>, { s: Pt[]; name: string; color: string; fmt: (x: number) => string; lines?: number[] }> = {
      compression: { s: d.series.ribbon_compression, name: t('Compressione ribbon'), color: C.purple, fmt: (x) => `${x.toFixed(1)}%` },
      drawdown: { s: d.series.hr_drawdown, name: t('Drawdown hashrate'), color: C.blue, fmt: (x) => pct(x, 1) },
      puell: { s: d.series.puell, name: 'Puell Multiple', color: C.blue, fmt: (x) => x.toFixed(2), lines: [0.5, 4] },
      issuance: { s: d.series.issuance_usd, name: t('Emissione giornaliera (media 7 g)'), color: C.teal, fmt: (x) => usdCompact(x, 1) },
    }
    const m = map[v]
    return {
      ...base, legend: { ...legendBase, data: [m.name] }, tooltip: tip(m.fmt),
      yAxis: valueAxis({ type: v === 'issuance' || v === 'puell' ? 'log' : 'value', axisLabel: { ...axisLabel, formatter: (x: number) => (v === 'issuance' ? `$${axisNum(x)}` : v === 'puell' ? axisNum(x) : `${axisNum(x)}%`) } }),
      series: [lineSeries(m.name, toXY(m.s), m.color, {
        lineStyle: { width: 1.4, color: m.color }, areaStyle: v === 'drawdown' ? { color: hexA(m.color, 0.12) } : undefined,
        markLine: m.lines ? { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: 'rgba(148,163,184,0.45)' }, label: { color: C.muted, fontSize: 11, position: 'insideEndTop' }, data: m.lines.map((y) => ({ yAxis: y })) } : undefined,
      })],
    }
  }, [d, v])
  const sub: Record<MinerView, string> = {
    ribbon: t('Difficoltà stimata (EH/s) · SMA 9…200 giorni, ultimi 4 anni'),
    compression: t('Distanza % tra SMA più alta e più bassa del ribbon'),
    drawdown: t('Hashrate (media 7 g) vs massimo storico'),
    puell: t('Ricavi da emissione vs media 365 g · <0.5 stress, >4 euforia'),
    issuance: t('Ricavi dei miner da nuova emissione (USD/giorno)'),
  }
  return (
    <Card>
      <CardHeader title={t('Difficulty Ribbon e stress dei miner')} icon={<Layers />} subtitle={sub[v]}
        right={<Segmented value={v} onChange={setV} options={[{ value: 'ribbon', label: 'Ribbon' }, { value: 'compression', label: t('Compressione') }, { value: 'drawdown', label: 'Drawdown' }, { value: 'puell', label: 'Puell' }, { value: 'issuance', label: t('Ricavi') }]} />} />
      <CardBody><EChart option={option} height={360} /></CardBody>
    </Card>
  )
}

function HitTable({ basic, momentum }: { basic: HitRow[]; momentum: HitRow[] }) {
  const cell = (hit: N, med: N) => <><b className="font-semibold text-white">{pct(hit, 0, false)}</b> <span className={clsx('text-xs', signCls(med))}>{pct(med, 0)}</span></>
  return (
    <div className="overflow-x-auto no-scrollbar">
      <table className="tbl">
        <thead><tr><th>{t('Orizzonte')}</th><th className="text-right">{t('Segnale base')}</th><th className="text-right">{t('Con conferma')}</th><th className="text-right">{t('Tutti i giorni')}</th></tr></thead>
        <tbody>
          {basic.map((b, i) => {
            const m = momentum[i]
            return (
              <tr key={b.horizon}>
                <td className="whitespace-nowrap font-medium text-white">{t('{n} giorni', { n: b.horizon })} <span className="text-xs text-slate-500">n={b.n}</span></td>
                <td className="whitespace-nowrap text-right">{cell(b.hit_rate, b.median)}</td>
                <td className="whitespace-nowrap text-right">{cell(m?.hit_rate, m?.median)}</td>
                <td className="whitespace-nowrap text-right text-slate-400">{pct(b.base_hit_rate, 0, false)} <span className="text-xs">{pct(b.base_median, 0)}</span></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="px-3 pt-2 text-xs text-slate-400">{t('% di segnali con BTC più alto dopo N giorni · a destra la mediana del rendimento')}</p>
    </div>
  )
}

function SignalsTable({ d }: { d: CycleMiner }) {
  const [all, setAll] = useState(false)
  const rows = all ? d.signals : d.signals.slice(0, 10)
  return (
    <Card className="h-full">
      <CardHeader title={t('Segnali Hash Ribbon storici')} icon={<ListChecks />} subtitle={t('{n} segnali dal 2011 · rendimento BTC dopo il segnale', { n: d.signals.length })}
        right={d.signals.length > 10 ? <Toggle on={all} onClick={() => setAll(!all)}>{all ? t('Ultimi 10') : t('Tutti')}</Toggle> : undefined} />
      <CardBody className="px-2">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>{t('Segnale')}</th><th className="text-right">{t('Capitolazione')}</th><th className="text-right">{t('DD hashrate')}</th><th className="text-right">{t('Prezzo')}</th><th className="text-right">+30 {dayUnit()}</th><th className="text-right">+90 {dayUnit()}</th><th className="text-right">+180 {dayUnit()}</th><th className="text-right">{t('Conferma')}</th><th className="text-right">{t('+90 g conf.')}</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.time}>
                  <td className="font-medium text-white">{date(s.time)}</td>
                  <td className="text-right">{s.cap_days} {dayUnit()}</td>
                  <td className="text-right text-down">{pct(s.hr_drawdown, 0)}</td>
                  <td className="text-right">{usd(s.price)}</td>
                  <td className="text-right">{retCell(s.ret, '30')}</td>
                  <td className="text-right">{retCell(s.ret, '90')}</td>
                  <td className="text-right">{retCell(s.ret, '180')}</td>
                  <td className="text-right text-slate-400">{s.momentum_time ? (s.momentum_time === s.time ? t('Stesso giorno') : date(s.momentum_time)) : '—'}</td>
                  <td className="text-right">{retCell(s.momentum_ret, '90')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

export function MinerTab() {
  const q = useCycleMiner()
  return (
    <Q q={q} loading={<div className="flex flex-col gap-3"><div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[164px]" />)}</div><Skeleton className="h-[520px]" /></div>}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <MinerKpis d={d} />
          <div className="grid gap-3 xl:grid-cols-12">
            <div className="xl:col-span-8"><HashRibbonChart d={d} updatedAt={q.dataUpdatedAt} /></div>
            <div className="flex flex-col items-stretch gap-3 self-start xl:col-span-4">
              <Card>
                <CardHeader title={t('Lettura attuale')} icon={<Info />} subtitle={cap(d.current.label)} />
                <CardBody className="flex flex-col gap-4">
                  <Bullets items={d.text} />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={t('Hit rate dei segnali')} icon={<Target />} subtitle={t('Segnali vs tasso base di tutti i giorni')} />
                <CardBody className="px-2"><HitTable basic={d.stats.basic} momentum={d.stats.momentum} /></CardBody>
              </Card>
            </div>
          </div>
          <MinerStressChart d={d} />
          <SignalsTable d={d} />
          <MethodNote text={d.method} />
        </div>
      )}
    </Q>
  )
}

// ================================================================== TAB: CONFRONTO CICLI

function SameDayTable({ a }: { a: CycleCompare['anchors'][number] }) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>{t('Ciclo')}</th><th>{t('Data (giorno {n})', { n: int(a.days) })}</th><th className="text-right">{t('Prezzo')}</th><th className="text-right">{t('Multiplo vs ancora')}</th><th className="text-right">{t("Dall'ATH")}</th><th className="text-right">{t('Giorni al nuovo ATH')}</th><th className="text-right">MVRV</th><th className="text-right">Cycle Score</th><th className="text-right">+90 {dayUnit()}</th><th className="text-right">+180 {dayUnit()}</th><th className="text-right">+365 {dayUnit()}</th></tr></thead>
        <tbody>
          {a.rows.map((r) => (
            <tr key={r.label} className={r.is_current ? 'bg-white/[0.03]' : undefined}>
              <td className="text-white">{r.label}{r.is_current && <span className="ml-1.5 text-xs text-slate-400">({t('Oggi')})</span>}</td>
              <td>{date(r.time)}</td>
              <td className="text-right">{usd(r.price)}</td>
              <td className="text-right text-white">{ok(r.multiple) ? `${r.multiple.toFixed(2)}×` : '—'}</td>
              <td className={clsx('text-right', signCls(r.drawdown_ath))}>{pct(r.drawdown_ath, 1)}</td>
              <td className="text-right">{r.days_to_ath === 0 ? t('Sui massimi') : ok(r.days_to_ath) ? `${int(r.days_to_ath)} ${dayUnit()}` : <span className="text-slate-400">{r.is_current ? t('In attesa') : t('Mai')}</span>}</td>
              <td className="text-right">{num(r.mvrv, 2)}</td>
              <td className="text-right text-white">{ok(r.score) ? r.score.toFixed(0) : '—'}</td>
              {(['90', '180', '365'] as const).map((h) => <td key={h} className={clsx('text-right', signCls(r.fwd[h]))}>{r.is_current ? <span className="text-slate-400">—</span> : pct(r.fwd[h], 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SameDayOverlay({ a }: { a: CycleCompare['anchors'][number] }) {
  const [metric, setMetric] = useState<'roi' | 'score'>('roi')
  const option = useMemo(() => {
    const idx = metric === 'roi' ? 1 : 2
    const prevCols = [C.blue, C.purple, C.teal, C.grey, C.grey2]
    let pi = 0
    return {
      grid: { left: 8, right: 16, top: 64, bottom: 36, containLabel: true },
      legend: { ...legendBase, type: 'scroll', data: a.series.map((s) => s.name), pageTextStyle: { color: C.muted } },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(t('Giorno {n}', { n: ps[0]?.value[0] })) + ps.filter((p) => p.value[1] != null).map((p) => tipRow(p.color, p.seriesName, metric === 'roi' ? `${p.value[1].toFixed(2)}×` : p.value[1].toFixed(0))).join('') },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: { type: 'value', name: t('Giorni'), nameTextStyle: { color: C.muted }, axisLabel, splitLine: { show: false }, axisLine: { lineStyle: { color: C.axis } }, max: a.days + 400 },
      yAxis: metric === 'roi' ? valueAxis({ type: 'log', axisLabel: { ...axisLabel, formatter: (v: number) => `${axisNum(v)}×` } }) : valueAxis({ min: 0, max: 100, scale: false, interval: 20 }),
      series: a.series.map((s) => {
        const col = s.current ? C.btc : prevCols[pi++ % prevCols.length]
        return lineSeries(s.name, s.points.map((p) => [p[0], p[idx]]), col, {
          lineStyle: { width: s.current ? 2.6 : 1.3, color: col, opacity: s.current ? 1 : 0.75 }, z: s.current ? 10 : 2,
          markLine: s.current ? { symbol: 'none', silent: true, lineStyle: { color: 'rgba(148,163,184,0.6)', type: 'dashed' }, label: { color: C.text, formatter: t('Oggi · giorno {n}', { n: a.days }), fontSize: 11 }, data: [{ xAxis: a.days }] } : undefined,
        })
      }),
    }
  }, [a, metric])
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex justify-end"><Segmented value={metric} onChange={setMetric} options={[{ value: 'roi', label: t('Prezzo (× ancora)') }, { value: 'score', label: 'Cycle Score' }]} /></div>
      <Fill min={340}><EChart option={option} height="100%" /></Fill>
    </div>
  )
}

function DurationsSurvival({ d }: { d: CycleCompare }) {
  const [si, setSi] = useState(0)
  const s = d.survival[si]
  const durOption = useMemo(() => {
    const ns = [...new Set([...d.durations.bull.map((x) => x.n), ...d.durations.bear.map((x) => x.n)])].sort((a, b) => a - b)
    const B2T = t('Minimo → massimo'), T2B = t('Massimo → minimo')
    return {
      grid: { left: 8, right: 8, top: 36, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [B2T, T2B] },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => (v == null ? '—' : t('{n} giorni', { n: int(v) })) },
      xAxis: { type: 'category', data: ns.map((n) => t('Ciclo {n}', { n })), axisLabel, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: valueAxis({ min: 0, scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}${dayUnit()}` } }),
      series: [
        { name: B2T, type: 'bar', barMaxWidth: 26, itemStyle: { color: C.blue, borderRadius: [2, 2, 0, 0] }, data: ns.map((n) => d.durations.bull.find((x) => x.n === n)?.days ?? null) },
        { name: T2B, type: 'bar', barMaxWidth: 26, itemStyle: { color: C.grey, borderRadius: [2, 2, 0, 0] },
          data: ns.map((n) => { const x = d.durations.bear.find((b) => b.n === n); return x ? (x.probable ? { value: x.days, itemStyle: { color: hexA(C.grey, 0.25), borderColor: C.grey, borderType: 'dashed', borderWidth: 1.25 } } : x.days) : null }) },
      ],
    }
  }, [d])
  const survOption = useMemo(() => {
    if (!s) return {}
    const LN = t('Log-normale')
    return {
      grid: { left: 8, right: 16, top: 52, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: ['Kaplan-Meier', LN] },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(t('Giorno {n}', { n: ps[0]?.value[0] })) + ps.map((p) => tipRow(p.color, p.seriesName, `${p.value[1].toFixed(0)}%`)).join('') },
      xAxis: { type: 'value', name: t('Giorni'), nameTextStyle: { color: C.muted }, axisLabel, splitLine: { show: false }, axisLine: { lineStyle: { color: C.axis } } },
      yAxis: valueAxis({ min: 0, max: 100, scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series: [
        lineSeries('Kaplan-Meier', s.curve.map((p) => [p.day, p.km]), C.blue, { step: 'end', lineStyle: { width: 1.8, color: C.blue },
          markLine: { symbol: 'none', silent: true, lineStyle: { color: 'rgba(148,163,184,0.6)', type: 'dashed' }, label: { color: C.text, formatter: t('Oggi · giorno {n}', { n: s.elapsed }), fontSize: 11 }, data: [{ xAxis: s.elapsed }] } }),
        lineSeries(LN, s.curve.map((p) => [p.day, p.lognormal]), C.purple, { smooth: true, lineStyle: { width: 1.4, color: C.purple, type: 'dashed' } }),
      ],
    }
  }, [s])
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card className="h-full">
        <CardHeader title={t('Durata delle fasi')} icon={<Hourglass />} subtitle={t('Giorni minimo→massimo e massimo→minimo per ciclo · tratteggio = minimo probabile non confermato')} />
        <CardBody className="flex flex-col"><Fill min={300}><EChart option={durOption} height="100%" /></Fill></CardBody>
      </Card>
      <Card className="h-full">
        <CardHeader title={t('Quanto può durare ancora la fase?')} icon={<Timer />} subtitle={s ? cap(s.label) : t('Analisi di sopravvivenza')}
          right={d.survival.length > 1 ? <Segmented value={si} onChange={setSi} options={d.survival.map((x, i) => ({ value: i, label: x.phase === 'bull' ? t('Scenario rialzo') : t('Scenario ribasso') }))} /> : undefined} />
        <CardBody className="flex flex-col gap-4">
          <p className="-mb-1 text-xs text-slate-400">{t('Probabilità che la fase duri ancora almeno X giorni (Kaplan-Meier; LN = curva log-normale)')}</p>
          {s ? (
            <>
              {s.horizons.every((h) => ok(h.km) && h.km >= 99.5 && ok(h.lognormal) && h.lognormal >= 99.5) && <p className="text-sm text-slate-400">{t('Nessun precedente più breve: tutte le fasi storiche sono durate più di così.')}</p>}
              <div className="dgrid grid-cols-2 sm:grid-cols-4">
                {s.horizons.filter((h) => !(ok(h.km) && h.km >= 99.5 && ok(h.lognormal) && h.lognormal >= 99.5)).map((h) => (
                  <div key={h.days} className="px-3 py-2.5 text-center">
                    <div className="tnum text-lg font-semibold text-white">{ok(h.km) ? `${h.km.toFixed(0)}%` : '—'}</div>
                    <div className="tnum text-2xs text-slate-400">{t('≥ altri {n} g', { n: h.days })} · LN {ok(h.lognormal) ? `${h.lognormal.toFixed(0)}%` : '—'}</div>
                  </div>
                ))}
              </div>
              <div className="text-xs leading-5 text-slate-400">
                {s.note} {t('Giorno {n} della fase; durate storiche {list}.', { n: int(s.elapsed), list: s.samples.map((x) => `${int(x)} ${dayUnit()}`).join(', ') })}
                {' '}{ok(s.remaining_median) ? t('Mediana dei giorni restanti nei cicli che hanno superato oggi: {n} g.', { n: int(s.remaining_median) }) : t('Oggi la fase ha già superato tutte le durate storiche.')}
              </div>
              <Fill min={220}><EChart option={survOption} height="100%" /></Fill>
            </>
          ) : <div className="text-sm text-slate-400">{t('Nessuna fase in corso analizzabile.')}</div>}
        </CardBody>
      </Card>
    </div>
  )
}

export function CompareTab() {
  const q = useCycleCompare()
  const [key, setKey] = useState<AnchorKey | null>(null)
  return (
    <Q q={q} loading={<div className="flex flex-col gap-3"><Skeleton className="h-[320px]" /><Skeleton className="h-[420px]" /></div>} isEmpty={(d) => !d.anchors.length}>
      {(d) => {
        const a = d.anchors.find((x) => x.key === key) ?? d.anchors.find((x) => x.key === 'probable_bottom') ?? d.anchors[0]
        return (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('Confronto allo stesso giorno del ciclo')} icon={<GitCompareArrows />} updatedAt={q.dataUpdatedAt} subtitle={t('{a}: giorno {n} (ancora {d}) · dove erano i cicli precedenti e cosa è successo dopo', { a: cap(a.label), n: int(a.days), d: date(a.anchor_time) })}
                right={<Segmented value={a.key} onChange={setKey} options={d.anchors.map((x) => ({ value: x.key, label: x.key === 'halving' ? 'Halving' : x.key === 'top' ? tr('Massimo', 'Top') : x.key === 'bottom' ? t('Minimo conf.') : t('Minimo prob.') }))} />} />
              <CardBody className="px-2"><SameDayTable a={a} /></CardBody>
            </Card>
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-8">
                <CardHeader title={t('Sovrapposizione dei cicli')} icon={<TrendingUp />} subtitle={t("Dall'ancora \"{a}\" · linea tratteggiata = oggi", { a: a.label.toLowerCase() })} />
                <CardBody className="flex flex-col"><SameDayOverlay a={a} /></CardBody>
              </Card>
              <div className="flex flex-col gap-3 self-start xl:col-span-4">
                <Card>
                  <CardHeader title={t('Cosa è successo dopo')} icon={<CalendarRange />} subtitle={t('Rendimento dei cicli precedenti da questo giorno')} />
                  <CardBody className="px-2">
                    <div className="overflow-x-auto no-scrollbar">
                      <table className="tbl">
                        <thead><tr><th>{t('Orizzonte')}</th><th className="text-right">{t('Mediana')}</th><th className="text-right">{t('Positivi')}</th><th className="text-right">{t('Min')}</th><th className="text-right">{t('Max')}</th></tr></thead>
                        <tbody>
                          {(['90', '180', '365'] as const).map((h) => {
                            const f = a.fwd_stats[h]
                            return (
                              <tr key={h}>
                                <td className="whitespace-nowrap font-medium text-white">+{h} {dayUnit()}</td>
                                <td className={clsx('text-right font-semibold', signCls(f.median))}>{pct(f.median, 0)}</td>
                                <td className="text-right">{f.up}/{f.n}</td>
                                <td className={clsx('text-right', signCls(f.min))}>{pct(f.min, 0)}</td>
                                <td className={clsx('text-right', signCls(f.max))}>{pct(f.max, 0)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader title={t('In sintesi')} icon={<ListChecks />} subtitle={t('Oggi vs cicli precedenti, per ogni ancora')} />
                  <CardBody><Bullets items={d.highlights} /></CardBody>
                </Card>
              </div>
            </div>
            <DurationsSurvival d={d} />
            <MethodNote text={d.caveat} extra={[t('Multiplo = prezzo del giorno / prezzo all\'ancora (halving, massimo o minimo).'), t('Giorni al nuovo ATH = giorni da quella data al superamento del massimo storico vigente allora.'), t('Lo score storico è quello walk-forward (senza dati futuri) dell\'Orologio del ciclo.')]} />
          </div>
        )
      }}
    </Q>
  )
}

// ================================================================== TAB: LEVA

function LeverageKpis({ d }: { d: CycleLeverage }) {
  const c = d.current
  return (
    <KpiStrip cols="grid-cols-1 min-[480px]:grid-cols-2 xl:grid-cols-4">
      <Kpi icon={<Gauge />} label={t('Fase del ciclo')} value={cap(c.phase_label)}
        sub={<span className="text-slate-300">{t('Giorno {n}', { n: int(c.days_in_phase) })}</span>}
        foot={t('Ciclo {n}', { n: c.cycle })}
        hint={t('Fasi storiche ricostruite da massimi e minimi di ciclo (vedi metodologia).')} />
      <Kpi icon={<Flame />} label={t('Funding 7 g (% annuo)')} value={pct(c.funding_7d, 1)}
        sub={<span className="text-slate-300">{t('Perc. {a} storico · {b} in fase', { a: ord(c.funding_pct_all), b: ord(c.funding_pct_phase) })}</span>}
        foot={t('Media 30 g {a}', { a: pct(c.funding_30d, 1) })}
        hint={t('Media 30 g {a} · stessa fase ciclo precedente {b}', { a: pct(c.funding_30d, 1), b: pct(c.funding_prev_cycle_phase_avg, 1) })} />
      <Kpi icon={<Scale />} label={t('Volume perp/spot 30 g')} value={<>{num(c.spec, 2)}×</>}
        sub={<span className="text-slate-300">{t('Perc. {a} storico · {b} in fase', { a: ord(c.spec_pct_all), b: ord(c.spec_pct_phase) })}</span>}
        foot={t('Ciclo prec. {v}×', { v: num(c.spec_prev_cycle_phase_avg, 2) })}
        hint={t('Stessa fase ciclo precedente {v}× · proxy di lungo periodo della speculazione con leva', { v: num(c.spec_prev_cycle_phase_avg, 2) })} />
      <Kpi icon={<BarChart3 />} label="OI / market cap" value={<>{num(c.leverage_ratio, 2)}%</>}
        sub={<span className="text-slate-300">OI <b className="text-white">{usdCompact(c.oi_usd, 1)}</b>{ok(c.leverage_pct_available) ? ` · ${t('Perc. {v}', { v: ord(c.leverage_pct_available) })}` : ''}</span>}
        foot={t('Storico {n} g', { n: int(c.oi_days_available) })}
        hint={`${t('Storico disponibile: {n} giorni', { n: int(c.oi_days_available) })}${c.oi_since ? ` (${t('dal {d}', { d: date(c.oi_since) })})` : ''} — ${t('limite API Binance')}`} />
    </KpiStrip>
  )
}

function LeverageChart({ d, updatedAt }: { d: CycleLeverage; updatedAt?: number }) {
  const [v, setV] = useState<'funding' | 'spec'>('funding')
  const option = useMemo(() => {
    const s = v === 'funding' ? d.series.funding : d.series.spec
    const bands = d.phases.map((p) => [{ xAxis: p.from * 1000, itemStyle: { color: hexA(PHASE_COLOR[p.phase], 0.11) } }, { xAxis: p.to * 1000 }])
    const name = v === 'funding' ? t('Funding (media 30 g, % annuo)') : t('Volume perp / spot (30 g)')
    const PRICE = t('Prezzo BTC')
    return {
      grid: { left: 8, right: 8, top: 36, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: [name, PRICE] },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(dateFmt(ps[0]?.value[0])) + ps.filter((p) => p.value[1] != null).map((p) => tipRow(p.color, p.seriesName, p.seriesName === PRICE ? usd(p.value[1]) : v === 'funding' ? pct(p.value[1], 1) : `${p.value[1].toFixed(2)}×`)).join('') },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ axisLabel: { ...axisLabel, formatter: (x: number) => (v === 'funding' ? `${x}%` : `${x}×`) } }),
        valueAxis({ type: 'log', position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      ],
      series: [
        lineSeries(name, toXY(s), v === 'funding' ? C.btc : C.purple, { lineStyle: { width: 1.6, color: v === 'funding' ? C.btc : C.purple }, markArea: { silent: true, data: bands },
          markLine: v === 'funding' ? { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: 'rgba(148,163,184,0.4)' }, label: { show: false }, data: [{ yAxis: 0 }, { yAxis: 10.95 }] } : undefined }),
        lineSeries(PRICE, toXY(d.series.price), '#E6E9EF', { yAxisIndex: 1, lineStyle: { width: 1.1, color: 'rgba(226,232,240,0.55)' } }),
      ],
    }
  }, [d, v])
  return (
    <Card className="h-full">
      <CardHeader title={t('Leva lungo il ciclo')} icon={<Activity />} updatedAt={updatedAt} subtitle={t('Tratteggio = funding 0% e 10.95% (0.01%/8h, base Binance)')}
        right={<Segmented value={v} onChange={setV} options={[{ value: 'funding', label: 'Funding' }, { value: 'spec', label: 'Perp / spot' }]} />} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
          <span className="text-slate-500">{t('Sfondo = fase')}:</span>
          {(Object.keys(PHASE_COLOR) as PhaseKey[]).map((p) => <span key={p} className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border" style={{ background: hexA(PHASE_COLOR[p], 0.28), borderColor: hexA(PHASE_COLOR[p], 0.6) }} />{phaseName(p)}</span>)}
        </div>
        <Fill min={380}><EChart option={option} height="100%" /></Fill>
      </CardBody>
    </Card>
  )
}

function PhaseTable({ d }: { d: CycleLeverage }) {
  return (
    <Card className="h-full">
      <CardHeader title={t('Leva per fase e ciclo')} icon={<Layers />} subtitle={t('Funding annualizzato e rapporto perp/spot medi in ogni fase (dal 2019)')} />
      <CardBody className="px-2">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>{t('Ciclo')}</th><th>{t('Fase')}</th><th>{t('Periodo')}</th><th className="text-right">{t('Giorni')}</th><th className="text-right">{t('Funding medio')}</th><th className="text-right">{t('Giorni positivi')}</th><th className="text-right">Funding p90</th><th className="text-right">Perp/spot</th></tr></thead>
            <tbody>
              {d.by_phase.map((r) => (
                <tr key={`${r.cycle}${r.phase}${r.from}`} className={r.current ? 'bg-btc/[0.06]' : undefined}>
                  <td className="font-medium text-white">{r.cycle}</td>
                  <td className={r.current ? 'text-white' : 'text-slate-300'}>{cap(r.label)}{r.current && <span className="ml-1.5 text-xs text-slate-400">({tr('Ora', 'Now')})</span>}</td>
                  <td className="text-slate-400">{monthYear(r.from)} – {monthYear(r.to)}</td>
                  <td className="text-right">{int(r.days)}</td>
                  <td className={clsx('text-right font-semibold', signCls(r.funding_avg))}>{pct(r.funding_avg, 1)}</td>
                  <td className="text-right">{pct(r.funding_pos_pct, 0, false)}</td>
                  <td className="text-right">{pct(r.funding_p90, 1)}</td>
                  <td className="text-right">{ok(r.spec_avg) ? `${r.spec_avg.toFixed(2)}×` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function PhaseAggTable({ d }: { d: CycleLeverage }) {
  return (
    <Card>
      <CardHeader title={t('Media per fase (tutti i cicli)')} icon={<BarChart3 />} subtitle={t('Funding annuo e perp/spot medi dal 2019')} />
      <CardBody className="px-2">
        <div className="overflow-x-auto no-scrollbar">
          <table className="tbl">
            <thead><tr><th>{t('Fase')}</th><th className="text-right">{t('Giorni')}</th><th className="text-right">{t('Funding medio')}</th><th className="text-right">Perp/spot</th></tr></thead>
            <tbody>
              {d.by_phase_all.map((r) => (
                <tr key={r.phase} className={r.phase === d.current.phase ? 'bg-white/[0.03]' : undefined}>
                  <td className="whitespace-nowrap text-white"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-[3px] align-[-1px]" style={{ background: hexA(PHASE_COLOR[r.phase], 0.6) }} />{phaseName(r.phase)}</td>
                  <td className="text-right">{int(r.days)}</td>
                  <td className={clsx('text-right font-semibold', signCls(r.funding_avg))}>{pct(r.funding_avg, 1)}</td>
                  <td className="text-right">{ok(r.spec_avg) ? `${r.spec_avg.toFixed(2)}×` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function OiChart({ d }: { d: CycleLeverage }) {
  const option = useMemo(() => ({
    grid: { left: 8, right: 8, top: 36, bottom: 8, containLabel: true },
    legend: { ...legendBase, data: ['Open interest (USD)', 'OI / market cap'] },
    tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => tipHead(dateFmt(ps[0]?.value[0])) + ps.filter((p) => p.value[1] != null).map((p) => tipRow(p.color, p.seriesName, p.seriesName.startsWith('OI /') ? `${p.value[1].toFixed(3)}%` : usdCompact(p.value[1], 2))).join('') },
    xAxis: timeAxis(),
    yAxis: [valueAxis({ axisLabel: { ...axisLabel, formatter: (x: number) => usdCompact(x, 1) } }), valueAxis({ position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (x: number) => `${x.toFixed(2)}%` } })],
    series: [
      lineSeries('Open interest (USD)', toXY(d.series.oi_usd), C.cyan, { areaStyle: { color: hexA(C.cyan, 0.1) } }),
      lineSeries('OI / market cap', toXY(d.series.leverage_ratio), C.pink, { yAxisIndex: 1, lineStyle: { width: 1.4, color: C.pink, type: 'dashed' } }),
    ],
  }), [d])
  return (
    <Card className="h-full">
      <CardHeader title={t('Open interest e leverage ratio')} icon={<Cpu />} subtitle={t('Binance BTCUSDT perpetuo · {n} giorni disponibili', { n: int(d.current.oi_days_available) })} />
      <CardBody className="flex flex-col">{d.series.oi_usd.length ? <Fill min={260}><EChart option={option} height="100%" /></Fill> : <div className="py-10 text-center text-sm text-slate-400">{t('Open interest non disponibile')}</div>}</CardBody>
    </Card>
  )
}

export function LeverageTab() {
  const q = useCycleLeverage()
  return (
    <Q q={q} loading={<div className="flex flex-col gap-3"><div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[164px]" />)}</div><Skeleton className="h-[440px]" /></div>}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <LeverageKpis d={d} />
          <div className="grid gap-3 xl:grid-cols-12">
            <div className="xl:col-span-8"><LeverageChart d={d} updatedAt={q.dataUpdatedAt} /></div>
            <div className="flex flex-col gap-3 self-start xl:col-span-4">
              <Card>
                <CardHeader title={t('Interpretazione')} icon={<Info />} subtitle={t('Fase: {p}', { p: cap(d.current.phase_label) })} />
                <CardBody><Bullets items={d.text} /></CardBody>
              </Card>
              <PhaseAggTable d={d} />
            </div>
          </div>
          <div className="grid gap-3 xl:grid-cols-12">
            <div className="xl:col-span-7"><PhaseTable d={d} /></div>
            <div className="xl:col-span-5"><OiChart d={d} /></div>
          </div>
          <MethodNote text={d.method} extra={d.limitations} />
        </div>
      )}
    </Q>
  )
}
