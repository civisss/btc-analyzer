import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  CandlestickChart, Shapes, GitCompareArrows, Flame, Activity, Bitcoin, Landmark, BarChart3, Crown, CircleDollarSign, Gauge, Orbit,
  ArrowRight, History, Layers3, Globe2, Blocks, Telescope,
} from 'lucide-react'
import {
  useCycles, useForecast, useFractals, useIndicators, useLevels, useLiquidations, useOnChain, useOverview, useUsdt,
} from '../api/client'
import type { Cycles, Indicators, Insights, Levels, OnChainMetric } from '../api/types'
import { Card, CardBody, CardHeader, Change, Fill, ICON, KpiCell, KpiStrip, PointsChange, ProgressBar, Q, Segmented, Skeleton, SkeletonBlock, ToneBadge, clsx } from '../components/ui'
import { useLive } from '../api/live'
import { useMacro } from '../api/macro'
import { useCycleAdvanced } from '../api/cycleAdvanced'
import Sparkline from '../components/charts/Sparkline'
import FearGreedGauge, { fngLabel } from '../components/charts/FearGreedGauge'
import ProChart, { type LineDef, type MarkerDef, type PaneDef, type PriceLineDef, type ZoneDef } from '../components/charts/ProChart'
import EChart from '../components/charts/EChart'
import { C, axisLabel, axisNum, legendBase, lineSeries, tooltipBase, valueAxis } from '../components/charts/theme'
import { CATEGORY_LABEL, PHASE_LABEL, date, dayUnit, int, pct, pts, quarter, toPct, usd, usdCompact, zoneName } from '../lib/format'
import { cap, t, tfLabel, tr } from '../i18n'
import { emaPts, useApp } from '../lib/store'
import { usePrice, useThrottledPrice, useTfCandles } from './hooks'
import { ForecastFanChart, FractalChart, LiqHeatmapChart, UsdtBtcChart } from './charts'
import { T, alpha } from '../theme/tokens'

// ------------------------------------------------------------------ KPI strip
/** Live price flash: the digits fade in for 300ms on change (no colour flash, no glow). */
function useFlash(value: number | null) {
  const prev = useRef<number | null>(null)
  const [k, setK] = useState(0)
  useEffect(() => {
    if (value == null) return
    if (prev.current != null && value !== prev.current) setK((x) => x + 1)
    prev.current = value
  }, [value])
  return k
}

function usePriceChange24() {
  return useLive((s) => s.ticker?.change_24h ?? null)
}

export function LiveChange24() {
  const ov = useOverview()
  const ch = usePriceChange24()
  return <div className="mt-1.5 text-sm"><Change value={ch ?? ov.data?.change_24h} suffix="(24h)" /></div>
}

/** KPI sparkline: series colour + soft gradient area. */
const spark = (data: Parameters<typeof Sparkline>[0]['data'], color: string) => <Sparkline data={data} color={color} height={36} fill strokeWidth={1.5} />

/** Small 0–100 ring (cycle clock): gradient arc from the low zone to the high zone. */
function Ring({ value, size = 72 }: { value: number | null | undefined; size?: number }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value))
  const r = 26, c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="ringg" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor={C.accentLo} />
          <stop offset="100%" stopColor={C.accent} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r={r} fill="none" stroke={alpha(T.fg, 0.07)} strokeWidth="5" />
      <circle cx="32" cy="32" r={r} fill="none" stroke="url(#ringg)" strokeWidth="5" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 32 32)" />
    </svg>
  )
}

function CycleClockCell() {
  const q = useCycleAdvanced()
  const c = q.data?.clock
  return (
    <KpiCell className="min-[480px]:col-span-2 min-[1800px]:col-span-1" label={t('Orologio del ciclo')} icon={<Orbit />} accent="violet"
      title={t('Cycle Score 0–100: 0 = zona di minimo, 100 = zona di massimo')}
      value={c ? (c.score != null ? `${c.score.toFixed(0)}` : '—') : q.isError ? '—' : <Skeleton className="h-7 w-14" />}
      delta={c && <span className="text-fg-2">{zoneName(c.zone, c.zone_label)}</span>}
      foot={c?.change_30d != null && <span className="tnum text-fg-4">{t('{v} in 30g', { v: pts(c.change_30d, 0) })}</span>}
      aside={c && <Ring value={c.score} />} />
  )
}

export function KpiRow() {
  const ov = useOverview()
  const price = usePrice()
  const flash = useFlash(price)
  const ch24 = usePriceChange24()
  const d = ov.data
  const err = ov.isError && !d
  const v = (s: string) => (err ? '—' : d ? s : <Skeleton className="h-7 w-28" />)
  const fng = d?.fear_greed
  return (
    <KpiStrip cols="grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-4 min-[1800px]:grid-cols-7">
      <KpiCell accent="btc" icon={<Bitcoin />} label={t('Prezzo BTC')}
        value={price == null ? (ov.isError ? '—' : <Skeleton className="h-7 w-32" />) : <span key={flash} className="flash-in">{usd(price)}</span>}
        delta={price != null && <Change value={ch24 ?? d?.change_24h} suffix="24h" />}
        spark={d && spark(d.sparklines.price, C.price)} />
      <KpiCell label={t('Market cap')} icon={<Landmark />} accent="blue" value={v(usdCompact(d?.market_cap))}
        delta={d && <Change value={d.market_cap_change_24h} suffix="24h" />}
        spark={d && spark(d.sparklines.market_cap, C.grey)} />
      <KpiCell label={t('Volume 24h')} icon={<BarChart3 />} accent="violet" title={t('Volume spot BTC/USDT su Binance (non il volume globale)')} value={v(usdCompact(d?.volume_24h_usd))}
        delta={d && <span className="text-fg-3">{pct(d.volume_change, 2)} <span className="text-fg-4">24h</span></span>}
        foot="Binance spot"
        spark={d && spark(d.sparklines.volume, C.grey)} />
      <KpiCell label={t('Dominance BTC')} icon={<Crown />} accent="amber" value={v(d ? `${d.btc_dominance.toFixed(1)}%` : '')}
        delta={d?.btc_dominance_change_24h != null ? <PointsChange value={d.btc_dominance_change_24h} suffix="24h" /> : undefined}
        spark={d && spark(d.sparklines.dominance, C.grey)} />
      <KpiCell label={t('USDT market cap')} icon={<CircleDollarSign />} accent="teal" value={v(usdCompact(d?.usdt_market_cap))}
        delta={d && <><Change value={d.usdt_mcap_change_7d} suffix={`7${dayUnit()}`} /><span className="ml-2 text-fg-4">{t('Dominance')} {d.usdt_dominance.toFixed(2)}%</span></>}
        spark={d && spark(d.sparklines.usdt, C.grey)} />
      <KpiCell label="Fear & Greed" icon={<Gauge />} accent="amber"
        value={fng ? fng.value : err ? '—' : <Skeleton className="h-7 w-14" />}
        delta={fng && <span className="text-fg-2">{fngLabel(fng.value)}</span>}
        foot={fng?.change_1d != null && <span className="tnum text-fg-4">{t('{v} da ieri', { v: `${fng.change_1d > 0 ? '+' : fng.change_1d < 0 ? '−' : ''}${Math.abs(fng.change_1d)}` })}</span>}
        aside={fng && <FearGreedGauge value={fng.value} size={72} />} />
      <CycleClockCell />
    </KpiStrip>
  )
}

// ------------------------------------------------------------------ Price chart w/ overlays (shared with Grafici)
export function useLevelOverlays(levels: Levels | undefined, opts: { keyLevels?: boolean; swings?: boolean; zones?: boolean }) {
  return useMemo(() => {
    const priceLines: PriceLineDef[] = []
    const markers: MarkerDef[] = []
    const zones: ZoneDef[] = []
    if (!levels) return { priceLines, markers, zones }
    if (opts.keyLevels) levels.key_levels.forEach((k) => priceLines.push({ price: k.price, color: k.kind === 'resistance' ? alpha(T.down, 0.75) : alpha(T.up, 0.75), title: k.label.split(' · ')[0] }))
    if (opts.swings) levels.swings.slice(-30).forEach((s) => markers.push({ time: s.time, position: s.kind === 'high' ? 'aboveBar' : 'belowBar', color: s.kind === 'high' ? C.down : C.up, shape: s.kind === 'high' ? 'arrowDown' : 'arrowUp', text: s.kind === 'high' ? 'H' : 'L' }))
    if (opts.zones) [...levels.zones].sort((a, b) => b.strength - a.strength).slice(0, 5).forEach((z) => zones.push({ low: z.low, high: z.high, color: z.kind === 'resistance' ? alpha(T.down, 0.10) : alpha(T.up, 0.10), label: `${z.kind === 'resistance' ? t('Resistenza') : t('Supporto')} · ${t('{n} tocchi', { n: z.touches })}` }))
    return { priceLines, markers, zones }
  }, [levels, opts.keyLevels, opts.swings, opts.zones])
}

function emaLines(ind: Indicators | undefined): LineDef[] {
  if (!ind) return []
  const col: Record<string, string> = { '21': C.steel, '50': C.sand, '200': C.accent }
  return Object.entries(ind.ema).map(([p, data]) => ({ id: `ema${p}`, data, color: col[p] ?? C.accent, width: 1.5 }))
}

function PriceTab() {
  const { tf } = useApp()
  const { q, candles, liveTf, monthly, apiTf, label } = useTfCandles(tf)
  const ind = useIndicators(apiTf)
  const lv = useLevels(apiTf)
  const lines = useMemo<LineDef[]>(() => {
    if (monthly && candles) return [{ id: 'ema21', data: emaPts(candles, 21), color: C.sand }, { id: 'ema50', data: emaPts(candles, 50), color: C.steel }]
    return emaLines(ind.data)
  }, [monthly, candles, ind.data])
  const ov = useLevelOverlays(monthly ? undefined : lv.data, { keyLevels: true, swings: true, zones: true })
  return (
    <Q q={q} loading={<Skeleton className="h-[440px] w-full" />} isEmpty={(d) => d.length === 0}>
      {() => (
        <div className="flex flex-1 flex-col">
          <Fill min={440}>
            <ProChart candles={candles!} liveTf={liveTf} liveMergeMonthly={monthly} height="100%" lines={lines} priceLines={ov.priceLines} markers={ov.markers} zones={ov.zones} tfLabel={label} fitKey={tf} wheel={false} />
          </Fill>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
            <span className="inline-flex items-center gap-1.5"><i className="h-1 w-2.5 rounded-full" style={{ background: C.sand }} />EMA 21</span>
            <span className="inline-flex items-center gap-1.5"><i className="h-1 w-2.5 rounded-full" style={{ background: C.steel }} />EMA 50</span>
            {!monthly && <span className="inline-flex items-center gap-1.5"><i className="h-1 w-2.5 rounded-full" style={{ background: C.accent }} />EMA 200</span>}
            <span className="inline-flex items-center gap-1.5"><i className="h-0 w-3 border-t-2 border-dashed border-fg-3" />{t('Livelli e zone S/R')}</span>
          </div>
        </div>
      )}
    </Q>
  )
}

function IndicatorsTab() {
  const { tf } = useApp()
  const { q, candles, liveTf, apiTf, label, monthly } = useTfCandles(tf === '1M' ? '1W' : tf)
  void monthly
  const ind = useIndicators(apiTf)
  const panes = useMemo<PaneDef[]>(() => {
    if (!ind.data) return []
    return [
      { id: 'rsi', title: 'RSI 14', height: 110, series: [{ id: 'rsi', type: 'line', data: ind.data.rsi, color: C.steel }], levels: [{ value: 70, color: alpha(T.down, 0.5) }, { value: 30, color: alpha(T.up, 0.5) }] },
      {
        id: 'macd', title: 'MACD 12·26·9', height: 110, series: [
          { id: 'hist', type: 'histogram', data: ind.data.macd.hist, color: C.up, colorFn: (v) => (v >= 0 ? alpha(T.up, 0.6) : alpha(T.down, 0.6)) },
          { id: 'macd', type: 'line', data: ind.data.macd.macd, color: C.accent },
          { id: 'sig', type: 'line', data: ind.data.macd.signal, color: C.accent },
        ],
      },
    ]
  }, [ind.data])
  return (
    <div className="grid flex-1 gap-4 xl:grid-cols-[1fr_260px]">
      <Q q={q} loading={<Skeleton className="h-[440px] w-full" />}>
        {() => <div className="flex min-h-[440px] flex-col"><Fill min={440}><ProChart candles={candles!} liveTf={liveTf} height="100%" panes={panes} volume={false} tfLabel={label} fitKey={'i' + tf} wheel={false} /></Fill></div>}
      </Q>
      <Q q={ind} compact>
        {(d) => <IndicatorSummary items={d.summary} />}
      </Q>
    </div>
  )
}

/** Short indicator names for narrow tables ("Prezzo vs EMA 21" → "EMA 21"). */
function shortInd(name: string) {
  const n = name.trim()
  let m = n.match(/vs\s+(EMA|SMA)\s*(\d+)/i)
  if (m) return `${m[1].toUpperCase()} ${m[2]}`
  if (/allineament/i.test(n)) return t('Allin. EMA')
  if (/SMA\s*50\s*\/\s*SMA\s*200|golden|death|cross/i.test(n)) return 'Cross 50/200'
  if (/bollinger/i.test(n)) return 'Bollinger'
  m = n.match(/^(RSI|ATR)\s*(\d+)/i)
  if (m) return `${m[1].toUpperCase()} ${m[2]}`
  if (/^MACD/i.test(n)) return 'MACD'
  if (/vwap/i.test(n)) return 'VWAP'
  return n.replace(/\s*\(.*\)\s*$/, '')
}
/** Numeric part of an indicator reading ("Sotto (−0.5%)" → "−0.5%"); falls back to the first word. */
function numInd(value: string) {
  const clean = (x: string) => x.replace(/^-/, '−').replace(/[,.]$/, '').trim()
  const pctM = value.match(/[−+-]?\d[\d,.]*\s*%/)
  if (pctM) return clean(pctM[0])
  const usdM = value.match(/\$\d[\d,.]*/)
  if (usdM) return clean(usdM[0])
  const lead = value.match(/^(?:%?[A-Za-z]{1,2}\s+)?([−+-]?\d[\d,.]*)/)
  if (lead) return clean(lead[1])
  return value.split(/[ ,(—]/)[0]
}

/** Compact table Indicatore | Valore | Segnale (28px rows) with the counts as one sentence. */
export function IndicatorSummary({ items }: { items: Indicators['summary'] }) {
  const counts = items.reduce((a, s) => ({ ...a, [s.signal]: (a[s.signal] ?? 0) + 1 }), {} as Record<string, number>)
  const word = (x: string) => (x === 'bullish' ? tr('Rialzo', 'Bullish') : x === 'bearish' ? tr('Ribasso', 'Bearish') : t('Neutro'))
  return (
    <div>
      <p className="px-3 pb-2 text-xs text-fg-3">
        <span className="text-up">{t('{n} rialzisti', { n: counts.bullish ?? 0 })}</span>, {t('{n} neutrali', { n: counts.neutral ?? 0 })}, <span className="text-down">{t('{n} ribassisti', { n: counts.bearish ?? 0 })}</span>
      </p>
      <table className="tbl table-fixed [&_td]:h-7 [&_th]:h-7">
        <thead><tr><th className="w-[38%]">{t('Indicatore')}</th><th>{t('Valore')}</th><th className="w-[72px] text-right">{t('Segnale')}</th></tr></thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.name}>
              <td className="truncate text-fg-2" title={s.name}>{shortInd(s.name)}</td>
              <td className="tnum truncate text-white" title={`${s.name}: ${s.value}`}>{numInd(s.value)}</td>
              <td className={clsx('text-right', s.signal === 'bullish' ? 'text-up' : s.signal === 'bearish' ? 'text-down' : 'text-fg-3')}>{word(s.signal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FractalTab() {
  const { tf } = useApp()
  const ftf = tf === '4H' ? '4h' : tf === '1D' ? '1d' : tf === '1W' || tf === '1M' ? '1w' : '4h'
  const q = useFractals({ tf: ftf, window: 60, horizon: 30, top: 5 })
  return <Q q={q} loading={<Skeleton className="h-[440px] w-full" />} isEmpty={(d) => !d.current.length}>{(d) => <Fill min={460}><FractalChart data={d} height="100%" /></Fill>}</Q>
}
function CorrelationTab() {
  const q = useUsdt()
  return <Q q={q} loading={<Skeleton className="h-[440px] w-full" />} isEmpty={(d) => !d.series.length}>{(d) => <Fill min={460}><UsdtBtcChart data={d} height="100%" levels zoom /></Fill>}</Q>
}
function LiqTab() {
  const q = useLiquidations('7d')
  const price = useThrottledPrice()
  return <Q q={q} loading={<Skeleton className="h-[440px] w-full" />} isEmpty={(d) => !d.heatmap.times.length}>{(d) => <Fill min={460}><LiqHeatmapChart data={d.heatmap} height="100%" livePrice={price} /></Fill>}</Q>
}

const TABS = [
  { id: 'price', label: 'Grafico prezzo', icon: CandlestickChart },
  { id: 'fractal', label: 'Frattali', icon: Shapes },
  { id: 'corr', label: 'Correlazione', icon: GitCompareArrows },
  { id: 'liq', label: 'Liquidazioni', icon: Flame },
  { id: 'ind', label: 'Indicatori', icon: Activity },
] as const

export function MainChartCard() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('price')
  const { tf, setTf } = useApp()
  return (
    <Card className="h-full min-h-[600px]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 sm:px-5">
        <div className="seg no-scrollbar flex max-w-full gap-0.5 overflow-x-auto rounded-xl p-1">
          {TABS.map((tb) => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={clsx('flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors', tab === tb.id ? 'seg-pill text-white' : 'text-fg-3 hover:text-white')}>
              <tb.icon size={14} className={tab === tb.id ? 'text-accent' : 'text-fg-4'} />
              {t(tb.label)}
            </button>
          ))}
        </div>
        {(tab === 'price' || tab === 'ind' || tab === 'fractal') && (
          <Segmented value={tf} onChange={setTf} options={[{ value: '4H', label: tfLabel('4h') }, { value: '1D', label: tfLabel('1d') }, { value: '1W', label: tfLabel('1w') }, { value: '1M', label: tfLabel('1M') }]} />
        )}
      </div>
      <CardBody className="flex flex-col pt-4">
        {tab === 'price' && <PriceTab />}
        {tab === 'fractal' && <FractalTab />}
        {tab === 'corr' && <CorrelationTab />}
        {tab === 'liq' && <LiqTab />}
        {tab === 'ind' && <IndicatorsTab />}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ Cycle cards
export function CycleOverlayMini({ cycles, height = 190 }: { cycles: Cycles; height?: number | string }) {
  const option = useMemo(() => {
    const ov = cycles.overlay.find((o) => o.anchor === 'bottom') ?? cycles.overlay[0]
    if (!ov) return {}
    const n = ov.series.length
    return {
      grid: { left: 4, right: 8, top: 34, bottom: 4, containLabel: true },
      // one legend row: "Dal minimo nov 2022" → "2022"
      legend: { ...legendBase, data: ov.series.map((s) => s.name), itemGap: 12, textStyle: { ...legendBase.textStyle, fontSize: 11 },
        formatter: (n: string) => (n.match(/(19|20)\d{2}/)?.[0] ?? n) },
      tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v: number) => `${v?.toFixed(2)}×` },
      xAxis: { type: 'value', max: 1500, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}${dayUnit()}` }, splitLine: { show: false }, axisLine: { lineStyle: { color: C.axis } } },
      yAxis: valueAxis({ type: 'log', axisLabel: { ...axisLabel, formatter: (v: number) => `${axisNum(v)}×` } }),
      series: ov.series.map((s, i) => {
        const current = i === n - 1
        const color = current ? C.accent : i % 2 ? C.grey : C.grey2
        return lineSeries(s.name, s.points.map((p) => [p.day, p.roi]), color, {
          lineStyle: { width: current ? 2 : 1.25, color, type: current || i % 2 ? 'solid' : 'dashed' },
        })
      }),
    }
  }, [cycles])
  return <EChart option={option} height={height} />
}

/** Compact key/value row (32px, divider). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-t border-line-subtle py-1.5 first:border-t-0">
      <span className="min-w-0 text-sm text-fg-3">{label}</span>
      <span className="tnum text-right text-sm text-white">{children}</span>
    </div>
  )
}

export function CycleAnalysisCard() {
  const q = useCycles()
  return (
    <Card className="h-full">
      <CardHeader title={t('Analisi del ciclo')} icon={<Orbit />} accent="violet" updatedAt={q.dataUpdatedAt} right={<Link to="/cicli" className="link">{t('Dettagli')} <ArrowRight size={ICON.chip} /></Link>} />
      <CardBody className="flex flex-col">
        <Q q={q} loading={<SkeletonBlock chart rows={4} />}>
          {(d) => {
            const c = d.current
            const conf = toPct(c.phase_confidence)
            const cur = d.cycles.find((x) => x.status === 'in_progress')
            const avgLen = d.durations_trend.find((t) => /bottom.*bottom/i.test(t.metric))?.projected_next
            return (
              <div className="flex flex-1 flex-col gap-3">
                <Fill min={220}><CycleOverlayMini cycles={d} height="100%" /></Fill>
                <div>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium text-white">{PHASE_LABEL[c.phase] ?? c.phase}</span>
                    <span className="tnum text-xs text-fg-3">{conf != null ? `${t('Confidenza {v}%', { v: conf.toFixed(0) })} · ` : ''}{t('Progresso {v}%', { v: c.progress.toFixed(0) })}</span>
                  </div>
                  <ProgressBar value={c.progress} className="mt-2 h-1" />
                </div>
                <div className="flex flex-col">
                  {c.probable_bottom && <Row label={t('Minimo probabile')}>{usd(c.probable_bottom.price)} <span className="text-fg-3">· {date(c.probable_bottom.time)}</span></Row>}
                  <Row label={c.probable_bottom ? t('Giorni dal minimo') : t('Giorni dal bottom')}>{int(c.days_since_bottom)}{avgLen && !c.probable_bottom ? <span className="text-fg-3"> / ~{int(avgLen)}</span> : null}</Row>
                  {c.days_since_confirmed_bottom != null && c.probable_bottom && <Row label={t('Dal bottom confermato')}>{int(c.days_since_confirmed_bottom)}</Row>}
                  {c.days_since_top != null && <Row label={t('Giorni dal top')}>{int(c.days_since_top)}</Row>}
                  {c.est_next_bottom && <Row label={c.bottom_window_kind === 'retest' ? t('Retest del minimo') : t('Prossimo bottom')}>{quarter(c.est_next_bottom.mid)} <span className="text-fg-3">· {usdCompact(c.est_next_bottom.price_low, 0)}–{usdCompact(c.est_next_bottom.price_high, 0)}</span></Row>}
                  {c.est_next_top && <Row label={t('Prossimo top')}>{quarter(c.est_next_top.mid)} <span className="text-fg-3">· {usdCompact(c.est_next_top.price_low, 0)}–{usdCompact(c.est_next_top.price_high, 0)}</span></Row>}
                  {cur?.drawdown != null && <Row label={t('Drawdown dal top')}><span className="text-down">{pct(cur.drawdown, 1)}</span></Row>}
                </div>
              </div>
            )
          }}
        </Q>
      </CardBody>
    </Card>
  )
}

export function HistoricalCyclesCard() {
  const q = useCycles()
  return (
    <Card>
      <CardHeader title={t('Cicli storici')} icon={<History />} accent="violet" />
      <CardBody className="px-1 pb-2">
        <Q q={q} compact isEmpty={(d) => !d.cycles.length}>
          {(d) => (
            <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t('Ciclo')}</th><th>{t('Anni')}</th><th className="text-right">{t('Bottom→top')}</th><th className="text-right">{t('Guadagno')}</th></tr></thead>
              <tbody>
                {d.cycles.map((c) => (
                  <tr key={c.n}>
                    <td className="text-white">{c.n}</td>
                    <td className="text-fg-3">{new Date(c.bottom.time * 1000).getUTCFullYear()}–{c.next_bottom ? new Date(c.next_bottom.time * 1000).getUTCFullYear() : t('oggi')}</td>
                    <td className="text-right">{c.days_bottom_to_top != null ? `${int(c.days_bottom_to_top)} ${dayUnit()}` : '—'}</td>
                    <td className="text-right">{c.status === 'in_progress' ? <span className="text-fg-3">{t('In corso')}</span> : <span className="text-up">{pct(c.gain, 0)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Q>
      </CardBody>
    </Card>
  )
}

export function KeyLevelsCard({ tf = '1d' as const, className }: { tf?: '1d' | '4h' | '1w'; className?: string }) {
  const q = useLevels(tf)
  const price = usePrice()
  return (
    <Card className={className}>
      <CardHeader title={t('Livelli chiave')} icon={<Layers3 />} right={price ? <span className="tnum text-xs text-fg-3">{t('Prezzo')} <span className="text-white">{usd(price)}</span></span> : null} />
      <CardBody className="px-1 pb-2">
        <Q q={q} compact isEmpty={(d) => !d.key_levels.length}>
          {(d) => (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th className="w-16">{t('Livello')}</th><th className="text-right">{t('Prezzo')}</th><th className="text-right">{t('Distanza')}</th></tr></thead>
                <tbody>
                  {[...d.key_levels].sort((a, b) => b.price - a.price).map((k) => {
                    const dist = price ? ((k.price - price) / price) * 100 : k.distance
                    const [head, ...rest] = k.label.split(' · ')
                    const res = k.kind === 'resistance'
                    return (
                      <tr key={k.label + k.price} title={rest.join(' · ') || undefined}>
                        <td className="text-white"><span className={clsx('mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle', res ? 'bg-down' : 'bg-up')} />{head}</td>
                        <td className="text-right text-white">{usd(k.price)}</td>
                        <td className="text-right text-fg-2">{pct(dist, 1)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Q>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ Bottom row cards
const RANGE_OPTS = [{ value: '1d', label: '1G' }, { value: '3d', label: '3G' }, { value: '7d', label: '7G' }, { value: '30d', label: '30G' }] as const
const rangeOpts = () => RANGE_OPTS.map((o) => ({ ...o, label: tfLabel(o.value) }))

export function LiqHeatmapCard() {
  const [range, setRange] = useState<'1d' | '3d' | '7d' | '30d'>('7d')
  const q = useLiquidations(range)
  const price = useThrottledPrice()
  return (
    <Card className="h-full">
      <CardHeader title={t('Heatmap liquidazioni')} icon={<Flame />} accent="blue" updatedAt={q.dataUpdatedAt} right={<Segmented value={range} onChange={setRange} options={rangeOpts()} />} />
      <CardBody className="flex flex-col">
        <Q q={q} loading={<Skeleton className="h-[260px]" />} isEmpty={(d) => !d.heatmap.times.length}>
          {(d) => (
            <>
              <Fill min={260}><LiqHeatmapChart data={d.heatmap} height="100%" livePrice={price} /></Fill>
              {d.magnet && (
                <p className="mt-2 truncate text-xs text-fg-3">
                  {t('Magnete')} <b className="font-medium text-white">{usd(d.magnet.price)}</b> · {t('{v} di {side} a rischio', { v: usdCompact(d.magnet.usd), side: d.magnet.side === 'long' ? 'long' : 'short' })}
                </p>
              )}
            </>
          )}
        </Q>
      </CardBody>
    </Card>
  )
}

export function FractalCard() {
  const [tf, setTf] = useState<'1h' | '4h' | '1d' | '1w'>('4h')
  const q = useFractals({ tf, window: 60, horizon: 30, top: 3 })
  return (
    <Card className="h-full">
      <CardHeader
        title={t('Analisi frattale')} icon={<Shapes />} accent="violet"
        subtitle={q.data?.matches[0] ? t('Similarità migliore {v}%', { v: q.data.matches[0].similarity.toFixed(0) }) : t('Pattern storici simili')}
        right={<Segmented value={tf} onChange={setTf} options={[{ value: '1h', label: tfLabel('1h') }, { value: '4h', label: tfLabel('4h') }, { value: '1d', label: tfLabel('1d') }, { value: '1w', label: tfLabel('1w') }]} />}
      />
      <CardBody className="flex flex-col">
        <Q q={q} loading={<Skeleton className="h-[260px]" />} isEmpty={(d) => !d.current.length}>
          {(d) => (
            <>
              <Fill min={260}><FractalChart data={d} height="100%" maxMatches={3} /></Fill>
              <p className="mt-2 flex h-5 items-center truncate text-xs text-fg-3">
                {t('Proiezione {n} candele:', { n: d.horizon })} <ToneBadge tone={d.projection.bias} className="mx-1" /> {t('Prob. rialzo')}&nbsp;<b className="text-white">{toPct(d.projection.up_prob)?.toFixed(0)}%</b>
              </p>
            </>
          )}
        </Q>
      </CardBody>
    </Card>
  )
}

export function UsdtCard() {
  const q = useUsdt()
  return (
    <Card className="h-full">
      <CardHeader title="USDT vs BTC" icon={<GitCompareArrows />} accent="teal" updatedAt={q.dataUpdatedAt} right={q.data && <span className="tnum text-xs text-fg-3">ρ 30{dayUnit()} <b className="text-white">{q.data.correlation.current_30.toFixed(2)}</b></span>} />
      <CardBody className="flex flex-col">
        <Q q={q} loading={<Skeleton className="h-[260px]" />} isEmpty={(d) => !d.series.length}>
          {(d) => {
            const s = { ...d, series: d.series.slice(-540) }
            return (
              <>
                <Fill min={260}><UsdtBtcChart data={s} height="100%" compact /></Fill>
                <p className="mt-2 truncate text-xs text-fg-3">USDT.D {d.current.usdt_d.toFixed(2)}% · 7{dayUnit()} <PointsChange value={d.current.usdt_d_change_7d} /> · {t('Lag migliore')} {d.correlation.best_lag > 0 ? '+' : ''}{d.correlation.best_lag}{dayUnit()}</p>
              </>
            )
          }}
        </Q>
      </CardBody>
    </Card>
  )
}

const sparkTone = (v: number | null | undefined) => (v == null ? C.grey : v >= 0 ? C.up : C.down)

export function OnChainMini({ m }: { m: OnChainMetric }) {
  return (
    <div className="flex min-w-0 flex-col px-3 py-3" title={`${m.label} · ${m.status}`}>
      <div className="label truncate">{m.label.replace(/\s*\(.*\)\s*$/, '')}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-white">{m.display.replace(/\s*\(.*\)\s*$/, '')}</div>
      <div className="flex h-4 items-center text-xs"><Change value={m.change_30d} digits={1} suffix={`30${dayUnit()}`} /></div>
      <div className="mt-1 line-clamp-1 text-xs text-fg-3">{cap(m.status)}</div>
      <div className="mt-1 h-8"><Sparkline data={m.spark} height={32} color={sparkTone(m.change_30d)} fill strokeWidth={1.4} /></div>
    </div>
  )
}

export function OnChainCard() {
  const q = useOnChain()
  return (
    <Card className="h-full">
      <CardHeader title={t('Metriche on-chain')} icon={<Blocks />} accent="teal" updatedAt={q.dataUpdatedAt} right={<Link to="/onchain" className="link">{t('Tutte')} <ArrowRight size={ICON.chip} /></Link>} />
      <CardBody>
        <Q q={q} isEmpty={(d) => !d.metrics.length} loading={<div className="grid grid-cols-3 gap-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>}>
          {(d) => {
            const pick = ['mvrv', 'nupl', 'hashrate', 'active_addresses', 'mvrv_z', 'puell']
            const ms = [...pick.map((k) => d.metrics.find((m) => m.key === k)).filter(Boolean) as OnChainMetric[], ...d.metrics.filter((m) => !pick.includes(m.key))].slice(0, 6)
            return <div className="dgrid -mx-1 grid-cols-2 sm:grid-cols-3 lg:grid-cols-2">{ms.map((m) => <OnChainMini key={m.key} m={m} />)}</div>
          }}
        </Q>
      </CardBody>
    </Card>
  )
}

/**
 * Headline-style insight row: title + direction word on one line, text muted below (1 line, or full with `full`),
 * optional category and confidence (meta line) — dividers between rows, no box. Use inside a <ul>.
 */
export function InsightHeadline({ it, full = false, showMeta = false }: { it: Insights['items'][number]; full?: boolean; showMeta?: boolean }) {
  const conf = toPct(it.confidence)
  return (
    <li className="border-t border-line-subtle py-2 first:border-t-0" title={full ? undefined : it.text}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={clsx('min-w-0 text-sm text-white', !full && 'truncate')}>{it.title}</span>
        <ToneBadge tone={it.tone} className="shrink-0" />
      </div>
      <p className={clsx('text-xs text-fg-3', full ? 'mt-0.5 leading-relaxed' : 'line-clamp-1')}>{it.text}</p>
      {showMeta && (
        <p className="tnum mt-1 text-2xs text-fg-3">{CATEGORY_LABEL[it.category] ?? it.category}{conf != null && ` · ${t('Confidenza {v}%', { v: conf.toFixed(0) })}`}</p>
      )}
    </li>
  )
}

export function ForecastCard() {
  const q = useForecast(90)
  return (
    <Card className="h-full">
      <CardHeader title={t('Previsione 30–90g')} icon={<Telescope />} accent="amber" updatedAt={q.dataUpdatedAt} right={<Link to="/previsioni" className="link">{t('Dettagli')} <ArrowRight size={ICON.chip} /></Link>} />
      <CardBody className="flex flex-col">
        <Q q={q} loading={<Skeleton className="h-[250px]" />} isEmpty={(d) => !d.bands.length}>
          {(d) => (
            <div className="flex flex-1 flex-col">
              <Fill min={250}><ForecastFanChart data={d} height="100%" historyDays={150} compact /></Fill>
              <div className="dgrid mt-3 grid-cols-3 border-t border-line-subtle">
                {d.targets.filter((x) => [30, 60, 90].includes(x.days)).map((x) => (
                  <div key={x.days} className="px-3 py-2.5">
                    <div className="label">{t('{n} giorni', { n: x.days })}</div>
                    <div className="tnum text-sm font-semibold text-white">{usdCompact(x.median, 1)}</div>
                    <div className="tnum text-2xs text-fg-3">{usdCompact(x.low, 0)}–{usdCompact(x.high, 0)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Q>
      </CardBody>
    </Card>
  )
}

export { date }

// ------------------------------------------------------------------ Contesto macro (dashboard card)
/** Neutral bar centred at 0 for a −100…+100 score (the direction is said in words next to it). */
function Diverging({ score }: { score: number }) {
  const v = Math.max(-100, Math.min(100, score))
  return (
    <div className="relative h-1 w-full rounded-full bg-white/[0.06]">
      <span className="absolute inset-y-[-3px] left-1/2 w-px bg-white/25" />
      <span className="absolute inset-y-0 rounded-full bg-fg-3/70" style={v >= 0 ? { left: '50%', width: `${v / 2}%` } : { right: '50%', width: `${-v / 2}%` }} />
    </div>
  )
}
const stance = (score: number) => (score >= 10 ? tr('A favore', 'Supportive') : score <= -10 ? tr('Contro', 'Headwind') : t('Neutrale'))

export function MacroContextCard() {
  const q = useMacro()
  return (
    <Card className="h-full">
      <CardHeader title={t('Contesto macro')} icon={<Globe2 />} accent="teal" updatedAt={q.dataUpdatedAt} right={<Link to="/macro" className="link">{t('Dettagli')} <ArrowRight size={ICON.chip} /></Link>} />
      <CardBody className="flex flex-col gap-3">
        <Q q={q} compact loading={<SkeletonBlock rows={6} />}>
          {(d) => {
            const s = d.summary
            return (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="tnum text-3xl font-semibold text-white">{s.score.toFixed(0)}<span className="ml-1 text-sm font-normal text-fg-3">/ 100</span></span>
                  <ToneBadge tone={s.tone} label={s.label} />
                </div>
                <div className="flex flex-col">
                  {s.components.map((c) => (
                    <div key={c.key} className="border-t border-line-subtle py-2 first:border-t-0" title={c.text}>
                      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate text-fg-2">{c.label}</span>
                        <span className="tnum shrink-0 text-fg-3">{c.value} <span className="ml-1.5 text-fg">{stance(c.score)}</span></span>
                      </div>
                      <Diverging score={c.score} />
                    </div>
                  ))}
                </div>
                {s.bullets[0] && <p className="mt-auto text-xs text-fg-3">{s.bullets[0]}</p>}
              </>
            )
          }}
        </Q>
      </CardBody>
    </Card>
  )
}
