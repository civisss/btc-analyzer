import { useTab } from '../lib/useTab'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity, BarChart3, CandlestickChart, CirclePlus, Clock, Coins, DollarSign, FlipHorizontal2, Gauge, GitCompare, History, Layers, Lightbulb, LineChart, Link2, ListChecks, MessageSquareText,
  Percent, PieChart, Route, Scale, ScanSearch, Settings2, SlidersHorizontal, Spline, Split, Target, Timer, Unlink, Waypoints,
} from 'lucide-react'
import { useUsdt } from '../api/client'
import { useStablecoins, useUsdtAnalogs, type Stablecoins, type UsdtAnalogMatch, type UsdtAnalogs, type UsdtPattern, type UsdtTf } from '../api/usdtAnalogs'
import Sparkline from '../components/charts/Sparkline'
import { C, hexA } from '../components/charts/theme'
import {
  Badge, Card, CardBody, CardHeader, Change, EmptyState, Fill, KpiCell, KpiStrip, Legend, MethodNote, PageTitle, PointsChange, ProgressBar, Q, Segmented, Skeleton, Toggle, ToneBadge, clsx, TabBar,
} from '../components/ui'
import { TimeLinesChart } from '../widgets/charts'
import { DCell, VisualBreakdown, plabel } from '../widgets/analogs'
import { SignalList } from '../widgets/flows'
import {
  ANALOG_COLOR, AfterPathsChart, LEG_COLOR, LINE_STYLE, LeadLagBars, MintBurnChart, MirrorChart, SsrChart, SupplyChart, USDT_COLOR, UsdtCurve, UsdtDominanceChart, UsdtLegTable,
  UsdtMappingList, UsdtTechChart, analogMedian, stripWhen, usdtRanges,
} from '../widgets/usdtAnalogs'
import { date, dayUnit, pct, pts, usd, usdCompact } from '../lib/format'
import { usePrice } from '../widgets/hooks'
import { cap, t, tfLabel } from '../i18n'

type Tab = 'overview' | 'analogs' | 'stables'
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Panoramica' }, { value: 'analogs', label: 'Analoghi USDT' }, { value: 'stables', label: 'Stablecoin' },
]

/** Plain row list item (1px dividers, no boxes). */
function Row({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <div title={title} className={clsx('border-t border-line py-2.5 first:border-t-0 first:pt-0', className)}>{children}</div>
}

function ShowAll({ open, total, onClick }: { open: boolean; total: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="link mt-1 h-8">{open ? t('Mostra meno') : t('Mostra tutti ({n})', { n: total })}</button>
}

const signedUsd = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${usdCompact(Math.abs(v), 2)}`)
const signTone = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'text-up' : 'text-down')
/** "30g" / "30d" */
const nd = (n: number | string) => `${n}${dayUnit()}`
/** Backend enum words (Italian, lowercase) → translated sentence case. */
const word = (s: string | null | undefined) => (s ? t(cap(s)) : '—')

/** Group heading for long tabs: same typography as the shared Section, without the accent bar. */
function Section({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="min-w-0 pb-1 pt-3">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-white">{title}</h2>
        {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

/** Up to 3 lines, then a "Mostra tutto" toggle when the text is longer. */
function ClampText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => { if (!open) setOver(el.scrollHeight > el.clientHeight + 1) }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, open])
  return (
    <div>
      <p ref={ref} className={clsx('max-w-[72ch] text-sm leading-relaxed text-slate-300', !open && 'line-clamp-3', className)}>{text}</p>
      {(over || open) && <button type="button" onClick={() => setOpen((v) => !v)} className="link mt-1 text-xs">{open ? t('Mostra meno') : t('Mostra tutto')}</button>}
    </div>
  )
}

// ================================================================== PANORAMICA
function OverviewTab() {
  const q = useUsdt()
  return (
    <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[460px]" /></div>} isEmpty={(d) => !d.series.length}>
      {(d) => {
        const lag = d.correlation.best_lag
        return (
          <div className="flex flex-col gap-3">
            <KpiStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
              <KpiCell icon={<PieChart />} label={t('USDT dominance')} value={`${d.current.usdt_d.toFixed(2)}%`} delta={<PointsChange value={d.current.usdt_d_change_7d} suffix={nd(7)} />} />
              <KpiCell icon={<Coins />} label={t('USDT market cap')} value={usdCompact(d.current.usdt_mcap)} foot={t('Capitalizzazione Tether')} />
              <KpiCell icon={<CirclePlus />} label={t('Emissione {n}', { n: nd(30) })} value={<span className={signTone(d.current.mint_30d)}>{signedUsd(d.current.mint_30d)}</span>} foot={t('Mint netto USDT')} />
              <KpiCell icon={<Link2 />} label={t('Correlazione {n}', { n: nd(30) })} value={d.correlation.current_30.toFixed(2)} foot={`${t('Correlazione {n}', { n: nd(90) })} ${d.correlation.current_90.toFixed(2)}`} />
              <KpiCell icon={<Timer />} label={t('Anticipo migliore')} value={`${lag > 0 ? '+' : lag < 0 ? '−' : ''}${Math.abs(lag)} ${dayUnit()}`}
                foot={lag > 0 ? t('USDT.D anticipa BTC') : lag < 0 ? t('BTC anticipa USDT.D') : t('Nessun anticipo')} className="col-span-2 md:col-span-1" />
            </KpiStrip>
            <Card>
              <CardHeader title={t('BTC vs USDT dominance')} subtitle={t('Asse destro ↓ invertito: dominance giù, BTC su')} icon={<LineChart />} updatedAt={q.dataUpdatedAt}
                info={t('La dominance di USDT è disegnata su un asse invertito: quando sale (capitali che si rifugiano in stablecoin) la curva scende, così i due grafici si muovono nella stessa direzione. Linee tratteggiate = livelli storici di rifiuto della dominance (R = resistenza, S = supporto); passa sopra per vedere tutte le etichette.')} />
              <CardBody><UsdtDominanceChart data={d} height={460} /></CardBody>
            </Card>
            <div className="grid items-start gap-3 xl:grid-cols-2">
              <Card>
                <CardHeader title={t('Correlazione mobile')} icon={<Activity />} subtitle={t('Rendimenti giornalieri BTC vs USDT.D')} />
                <CardBody>
                  <TimeLinesChart height={260} yFmt={(v) => v.toFixed(2)} markLines={[{ y: 0, color: hexA(C.grey, 0.5) }]}
                    lines={[{ name: t('30 giorni'), data: d.correlation.r30, color: C.blue }, { name: t('90 giorni'), data: d.correlation.r90, color: C.purple }]} />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={t('Anticipo / ritardo')} icon={<Timer />} subtitle={t('Lag positivo = USDT.D anticipa BTC · migliore {n}', { n: `${lag > 0 ? '+' : ''}${lag} ${dayUnit()}` })}
                  info={t('Correlazione tra i rendimenti di BTC e quelli della USDT.D spostati di N giorni. La barra blu è il lag con la correlazione più forte.')} />
                <CardBody><LeadLagBars data={d.correlation.lead_lag} best={lag} unit={dayUnit()} height={260} /></CardBody>
              </Card>
            </div>
            <div className="grid items-start gap-3 xl:grid-cols-3">
              <Card>
                <CardHeader title={t('Livelli USDT.D')} icon={<Layers />} subtitle={t('Zone di rifiuto storiche · distanza in pt')} />
                <CardBody className="pt-0">
                  {[...d.levels].sort((a, b) => b.price - a.price).map((l, i) => (
                    <Row key={i} className="flex min-h-8 items-center justify-between gap-3 py-1.5">
                      <span className="text-sm text-slate-400">{l.kind === 'resistance' ? t('Resistenza') : t('Supporto')}</span>
                      <span className="tnum whitespace-nowrap text-sm font-medium text-white">{l.price.toFixed(2)}% <span className="ml-1 text-xs font-normal text-slate-400">{pts(l.price - d.current.usdt_d, 2)}</span></span>
                    </Row>
                  ))}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={t('Divergenze')} icon={<Split />} subtitle={t('BTC e USDT.D in disaccordo')} />
                <CardBody className="pt-0">
                  {d.divergences.length === 0 && <EmptyState text={t('Nessuna divergenza recente')} compact />}
                  {d.divergences.map((v, i) => (
                    <Row key={i}>
                      <div className="flex items-center justify-between"><ToneBadge tone={v.kind} /><span className="text-xs text-slate-400">{date(v.time)}</span></div>
                      <p className="mt-1 line-clamp-2 text-sm text-slate-300" title={v.note}>{cap(v.note)}</p>
                    </Row>
                  ))}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={t('Frattale congiunto')} icon={<Waypoints />} subtitle={t('BTC + USDT.D · similarità {n}%', { n: d.fractal.similarity.toFixed(1) })} />
                <CardBody className="pt-0">
                  {d.fractal.matches.map((m, i) => (
                    <Row key={i}>
                      <div className="flex justify-between text-sm"><span className="font-medium text-white">{date(m.start)} → {date(m.end)}</span><span className="tnum text-slate-300">{m.similarity.toFixed(1)}%</span></div>
                      <ProgressBar value={m.similarity} color={C.blue} className="mt-1.5 h-1" />
                      <div className="tnum mt-1.5 flex justify-between text-xs text-slate-400"><span>{t('Esito BTC')} <Change value={m.btc_outcome} digits={1} /></span><span>USDT.D <Change value={m.usdt_outcome} digits={1} /></span></div>
                    </Row>
                  ))}
                </CardBody>
              </Card>
            </div>
            <MethodNote><p>{d.note}</p></MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

// ================================================================== ANALOGHI USDT
function useDebounced<V>(v: V, ms = 400) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms)
    return () => clearTimeout(id)
  }, [v, ms])
  return d
}

function Slider({ label, value, min, max, step = 1, onChange, suffix }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <label className="flex min-w-[160px] flex-1 flex-col gap-2">
      <span className="flex items-baseline justify-between"><span className="label">{label}</span><span className="tnum text-sm text-white">{value}{suffix}</span></span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

/** Detected figures as plain text (confidence muted); the BTC reading is in the tooltip, never colour-coded. */
function UsdtPatternLine({ patterns }: { patterns: UsdtPattern[] }) {
  if (!patterns.length) return <div className="flex min-h-5 items-center text-xs text-slate-400">{t('Nessuna figura classica')}</div>
  return (
    <div className="flex min-h-5 flex-wrap items-center gap-x-3 text-xs text-slate-300">
      {patterns.map((p) => (
        <span key={p.key} title={t('Confidenza {c}% · lettura per BTC: {r}', { c: p.confidence.toFixed(0), r: (p.btc_tone === 'bullish' ? t('Rialzista') : p.btc_tone === 'bearish' ? t('Ribassista') : t('Neutrale')).toLowerCase() })}>
          {cap(p.label)} <span className="tnum text-slate-400">{p.confidence.toFixed(0)}%</span>
        </span>
      ))}
    </div>
  )
}

function MatchPicker({ m, selected, onClick }: { m: UsdtAnalogMatch; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={selected}
      className={clsx('relative flex h-full flex-col rounded-2xl border border-line p-4 text-left transition-colors', selected ? 'bg-raised' : 'bg-surface hover:bg-white/[0.02]')}>
      {selected && <span className="absolute inset-x-4 top-0 h-0.5 bg-accent-blue" />}
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="tnum text-xs text-slate-400">#{m.rank}</span>
        <span className="truncate text-sm font-medium text-white">{plabel(m.period.label)}</span>
      </div>
      <div className="mt-2 h-8"><Sparkline data={m.usdt.values} color={selected ? C.blue : undefined} height={32} /></div>
      <div className="mt-2 flex items-center justify-between text-xs"><span className="text-slate-400">{t('Similarità')}</span><span className="tnum font-medium text-white">{m.similarity.toFixed(0)}%</span></div>
      <ProgressBar value={m.similarity} color={C.blue} className="mt-1 h-1" />
      <div className="mt-2 flex items-center justify-between text-xs"><span className="text-slate-400">{t('BTC dopo')}</span><Change value={m.outcome.change} digits={1} /></div>
      <div className="mt-1 flex items-center justify-between text-xs"><span className="text-slate-400">{t('USDT.D dopo')}</span><PointsChange value={m.outcome.usdt_change_pts} /></div>
    </button>
  )
}

function AnalogsTab() {
  const [tf, setTf] = useState<UsdtTf>('1d')
  const [win, setWin] = useState(60)
  const [horizon, setHorizon] = useState(30)
  const [top, setTop] = useState(5)
  const [sel, setSel] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [layers, setLayers] = useState({ points: true, legs: true, patterns: true })
  const [showBtc, setShowBtc] = useState(() => typeof window === 'undefined' || window.innerWidth >= 640)
  const [pathMode, setPathMode] = useState<'btc' | 'usdt'>('btc')
  const params = useDebounced({ tf, window: win, top, horizon })
  const q = useUsdtAnalogs(params)
  useEffect(() => setSel(0), [params.tf, params.window, params.top, params.horizon])
  const live = usePrice()
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title={t('Parametri')} icon={<Settings2 />} subtitle={t('Frattali storici della USDT dominance')} right={q.isFetching ? <span className="text-xs text-slate-400">{t('Calcolo in corso…')}</span> : null} />
        <CardBody className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="flex flex-col gap-2">
            <span className="label">{t('Timeframe')}</span>
            <Segmented value={tf} onChange={setTf} options={[{ value: '1d', label: tfLabel('1d') }, { value: '4h', label: `${tfLabel('4h')} (${t('stimato')})` }]} />
          </div>
          <Slider label={t('Finestra attuale (candele)')} value={win} min={20} max={200} step={2} onChange={setWin} />
          <Slider label={t('Orizzonte (candele dopo)')} value={horizon} min={5} max={100} onChange={setHorizon} />
          <Slider label={t('Numero di analoghi')} value={top} min={1} max={8} onChange={setTop} />
        </CardBody>
      </Card>
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-44" /><Skeleton className="h-[400px]" /><Skeleton className="h-72" /></div>}
        isEmpty={(d) => !d.matches.length} empty={t('Nessun analogo trovato con questi parametri: prova una finestra più corta.')}>
        {(d) => <AnalogsBody d={d} sel={Math.min(sel, d.matches.length - 1)} setSel={setSel} hover={hover} setHover={setHover} layers={layers} setLayers={setLayers}
          showBtc={showBtc} setShowBtc={setShowBtc} pathMode={pathMode} setPathMode={setPathMode} livePrice={live} narrow={narrow} updatedAt={q.dataUpdatedAt} />}
      </Q>
    </div>
  )
}

function AnalogsBody({ d, sel, setSel, hover, setHover, layers, setLayers, showBtc, setShowBtc, pathMode, setPathMode, livePrice, narrow, updatedAt }: {
  d: UsdtAnalogs; sel: number; setSel: (n: number) => void; hover: number | null; setHover: (n: number | null) => void
  layers: { points: boolean; legs: boolean; patterns: boolean }; setLayers: (l: { points: boolean; legs: boolean; patterns: boolean }) => void
  showBtc: boolean; setShowBtc: (b: boolean) => void; pathMode: 'btc' | 'usdt'; setPathMode: (m: 'btc' | 'usdt') => void; livePrice: number | null; narrow: boolean
  updatedAt: number
}) {
  const m = d.matches[sel]
  const w = d.window
  const anaWin = m.usdt.values.slice(0, w)
  const [rc, ra] = usdtRanges(d.current.usdt, m.usdt.values)
  const price = livePrice ?? d.current.btc
  const unit = d.tf === '1d' ? t('giorni') : t('candele {tf}', { tf: tfLabel('4h') })
  const yr = stripWhen(m.period.when)
  const chartH = narrow ? 300 : 380
  const s = d.summary
  // headline = median across ALL analogs (P25–P75 range); the selected analog is secondary
  const med = useMemo(() => analogMedian(d.matches), [d.matches])
  const toPrice = (c: number | null) => (c == null ? null : price * (1 + c / 100))
  const selTarget = toPrice(m.outcome.change)
  const pl = plabel(m.period.label)
  const meta = [t('{n} analoghi', { n: d.matches.length }), plabel(d.current.label), d.estimated ? t('USDT.D {tf} stimata', { tf: tfLabel('4h') }) : null, d.live ? t('Live') : null].filter(Boolean).join(' · ')
  return (
    <div className="flex flex-col gap-6">
      <Section title={t('Esito mediano degli analoghi')} subtitle={meta}>
        <Card>
          <CardHeader title={t('Cosa suggeriscono gli analoghi')} subtitle={t('Mediana di {n} analoghi applicata al prezzo di oggi', { n: med.n })} icon={<Target />} updatedAt={updatedAt}
            info={t("L'obiettivo principale è la mediana degli esiti di BTC di tutti gli analoghi trovati, con l'intervallo tra il 25° e il 75° percentile. L'esito dell'analogo selezionato è mostrato a parte come riferimento.")} />
          <CardBody className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
              <div className="min-w-0 flex-1 basis-[420px]">
                <h3 className="text-title font-semibold text-white">
                  <span className="font-normal text-slate-400">{t('Mediana analoghi')}: </span>
                  <Change value={med.p50} digits={1} />
                  <span className="text-slate-500"> · </span>
                  <span className="tnum">{med.p50 != null ? usd(toPrice(med.p50)) : '—'}</span>
                  {med.p25 != null && med.p75 != null && (
                    <span className="tnum font-normal text-slate-400"> ({t('range')} {usd(toPrice(med.p25))}–{usd(toPrice(med.p75))})</span>
                  )}
                </h3>
                <p className="mt-1 text-sm text-slate-400">
                  {t('In {n} {u} · da {p} · P25–P75 {a} / {b}', { n: d.horizon, u: unit, p: usd(price), a: pct(med.p25, 1), b: pct(med.p75, 1) })}
                </p>
              </div>
              <div className="min-w-0 flex-1 basis-[320px] border-line text-sm text-slate-400 sm:border-l sm:pl-6">
                <div className="flex items-center gap-2 text-slate-300">
                  <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: C.blue }} />
                  <span>{t('Analogo selezionato')} #{m.rank} · <span className="text-white">{pl}</span></span>
                </div>
                <p className="mt-1">
                  {t('Similarità {n}%', { n: Math.round(m.similarity) })} · {t('BTC dopo')} <Change value={m.outcome.change} digits={1} />
                  {selTarget != null && <> · <span className="tnum text-slate-300">{usd(selTarget)}</span></>}
                </p>
              </div>
            </div>
          </CardBody>
        </Card>
        <KpiStrip cols="grid-cols-2 lg:grid-cols-4">
          <KpiCell icon={<Gauge />} label={t('USDT.D oggi')} value={`${d.current.usdt_d.toFixed(2)}%`} delta={<PointsChange value={d.current.change_pts} suffix={t('finestra')} />} />
          <KpiCell icon={<Target />} label={t('BTC mediana analoghi')} value={<Change value={med.p50} digits={1} />} foot={`P25–P75 ${pct(med.p25, 1)} / ${pct(med.p75, 1)}`} />
          <KpiCell icon={<DollarSign />} label={t('Prezzo mediano')} value={med.p50 != null ? usd(toPrice(med.p50)) : '—'} foot={med.p25 != null && med.p75 != null ? `${usd(toPrice(med.p25))}–${usd(toPrice(med.p75))}` : undefined} />
          <KpiCell icon={<History />} label={t('Analogo #{n} ({y})', { n: m.rank, y: yr })} value={<Change value={m.outcome.change} digits={1} />}
            foot={<>{t('Max')} <Change value={m.outcome.max_up} digits={1} /> / <Change value={m.outcome.max_down} digits={1} /> · USDT.D <PointsChange value={m.outcome.usdt_change_pts} /></>} />
        </KpiStrip>

        <Card>
          <CardHeader title={t('Confronto della USDT.D')} subtitle={t('Stessa ampiezza in punti · BTC su asse sinistro ↓ invertito')} icon={<GitCompare />}
            info={t("Le due curve sono disegnate con la stessa ampiezza in punti percentuali, ciascuna centrata sul proprio livello. Gambe ZigZag (G1, G2…), figure classiche e punti strutturali numerati corrispondenti. BTC è sull'asse sinistro invertito. Il tratteggio a destra è ciò che è successo dopo nell'analogo.")}
            right={<>
              <Toggle on={layers.legs} onClick={() => setLayers({ ...layers, legs: !layers.legs })} color={LEG_COLOR}>{t('Gambe')}</Toggle>
              <Toggle on={layers.patterns} onClick={() => setLayers({ ...layers, patterns: !layers.patterns })} color={LINE_STYLE.neckline.color}>{t('Figure')}</Toggle>
              <Toggle on={layers.points} onClick={() => setLayers({ ...layers, points: !layers.points })} color={C.text}>{t('Punti')}</Toggle>
              <Toggle on={showBtc} onClick={() => setShowBtc(!showBtc)} color={C.btc}>BTC</Toggle>
            </>} />
          <CardBody>
            <p className="mb-3 text-sm text-slate-400">
              {t('La USDT.D attuale somiglia a {p}', { p: pl.replace(/ \(\w+\)$/, '') })} · {t('Somiglianza grafica')} <span className="tnum text-white">{Math.round(m.visual_similarity)}%</span> · {t('contesto')} <span className="tnum text-white">{Math.round(m.context_similarity)}%</span> ·{' '}
              {t('USDT.D nella finestra')} <PointsChange value={d.current.change_pts} /> {t('oggi vs')} <PointsChange value={m.usdt.window_change_pts} /> {m.period.when}
            </p>
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 font-medium text-white"><span className="h-2 w-2 rounded-sm" style={{ background: USDT_COLOR }} />{t('Oggi')} · {plabel(d.current.label)}</span>
                  <span className="tnum text-slate-400">{d.current.usdt_d.toFixed(2)}% · BTC {usd(price)}</span>
                </div>
                <UsdtPatternLine patterns={m.patterns.current} />
                <UsdtCurve times={d.current.times} values={d.current.usdt} btc={d.current.btc_path} windowLen={w} side="current" mapping={m.mapping} legs={m.legs_current}
                  patterns={m.patterns.current} tf={d.tf} yMin={rc[0]} yMax={rc[1]} height={chartH} active={hover} accent={USDT_COLOR} showBtc={showBtc} layers={layers} />
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 font-medium text-white"><span className="h-2 w-2 rounded-sm" style={{ background: ANALOG_COLOR }} />{t('Analogo')} · {pl}</span>
                  <span className="tnum text-slate-400">{anaWin[anaWin.length - 1]?.toFixed(2)}% · {t('Tratteggio = dopo')}</span>
                </div>
                <UsdtPatternLine patterns={m.patterns.analog} />
                <UsdtCurve times={m.usdt.times} values={m.usdt.values} btc={m.btc.values} windowLen={w} side="analog" mapping={m.mapping} legs={m.legs_analog}
                  patterns={m.patterns.analog} tf={d.tf} yMin={ra[0]} yMax={ra[1]} height={chartH} active={hover} accent={ANALOG_COLOR} showBtc={showBtc} layers={layers} />
              </div>
            </div>
            <div className="mt-3">
              <Legend items={[
                { label: t('Gambe ZigZag'), color: LEG_COLOR },
                { label: t('Resistenza'), color: LINE_STYLE.resistance.color, dashed: true },
                { label: t('Supporto'), color: LINE_STYLE.support.color, dashed: true },
                { label: t('Neckline'), color: LINE_STYLE.neckline.color, dashed: true },
                { label: t('BTC (↓ invertito)'), color: C.btc },
              ]} />
            </div>
          </CardBody>
        </Card>
      </Section>

      <Section title={t('Esiti')} subtitle={t('{n} analoghi · orizzonte {h} {u}', { n: s.count, h: d.horizon, u: unit })}>
        {/* right column: agreement + narrative; the paths chart grows to the column height */}
        <div className="grid gap-3 xl:grid-cols-12">
          <Card className="xl:col-span-8">
            <CardHeader title={t('Cosa ha fatto BTC dopo')} icon={<Route />} subtitle={t('Percorsi riportati sul valore di oggi · grigio = altri analoghi')}
              right={<Segmented value={pathMode} onChange={setPathMode} options={[{ value: 'btc', label: 'BTC' }, { value: 'usdt', label: 'USDT.D' }]} />} />
            <CardBody className="flex flex-col"><Fill min={narrow ? 320 : 340}><AfterPathsChart d={d} mode={pathMode} sel={sel} height="100%" /></Fill></CardBody>
          </Card>
          <div className="flex flex-col gap-3 xl:col-span-4">
          <Card>
            <CardHeader title={t('Concordanza')} icon={<Scale />} right={<ToneBadge tone={s.bias} />} />
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between text-sm text-slate-400">
                <span>BTC <span className="tnum text-white">{s.up}</span> {t('saliti')} · <span className="tnum text-white">{s.down}</span> {t('scesi')}</span>
                <span>{t('Accordo')} <span className="tnum text-white">{s.agreement?.toFixed(0) ?? '—'}%</span></span>
              </div>
              <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="bg-up/70" style={{ width: `${(s.up / Math.max(1, s.count)) * 100}%` }} />
                <div className="bg-down/60" style={{ width: `${(s.down / Math.max(1, s.count)) * 100}%` }} />
              </div>
              <div className="dgrid grid-cols-2">
                <DCell label={t('BTC mediana')} value={<Change value={s.median_outcome} digits={1} />} foot={t('Esito a fine orizzonte')} />
                <DCell label={t('Media pesata')} value={<Change value={s.weighted_outcome} digits={1} />} foot={t('Pesata per similarità')} />
                <DCell label={t('Prezzo mediano (percorso)')} value={s.band ? usd(price * (s.band.p50[s.band.p50.length - 1] / d.current.btc)) : '—'} foot={t('Da {p}', { p: usd(price) })} />
                <DCell label={t('USDT.D mediana')} value={<PointsChange value={s.usdt_median_pts} />} foot={t('Variazione in punti')} />
              </div>
              <ClampText text={s.text} />
            </CardBody>
          </Card>
          <Card className="flex-1">
            <CardHeader title={t('In sintesi')} icon={<MessageSquareText />} />
            <CardBody className="flex flex-col gap-2 text-sm text-slate-300">
              {m.narrative_llm ? <p>{m.narrative_llm}</p> : m.narrative.map((x, i) => <p key={i}>{x}</p>)}
            </CardBody>
          </Card>
          </div>
        </div>
      </Section>

      <Section title={t('Perché si somigliano')}>
        <div className="grid items-start gap-3 xl:grid-cols-12">
          <Card className="xl:col-span-5">
            <CardHeader title={t('Somiglianza grafica')} icon={<ScanSearch />} subtitle={t('Componenti visive (80% del punteggio)')}
              right={<span className="text-xs text-slate-400">{t('Totale')} <b className="tnum text-lg font-semibold text-white">{Math.round(m.visual_similarity)}%</b></span>} />
            <CardBody><VisualBreakdown components={m.visual.components} /></CardBody>
          </Card>
          <div className="flex flex-col gap-3 xl:col-span-7">
            <Card>
              <CardHeader title={t('Gamba per gamba')} icon={<Spline />} subtitle={t('USDT.D in punti · oggi vs {y}', { y: yr })}
                info={t('Ampiezza di ogni gamba ZigZag della USDT.D in punti percentuali. Il colore segue la lettura per BTC: dominance in salita (rosso) è sfavorevole a BTC, in discesa (verde) favorevole.')} />
              <CardBody className="px-2"><UsdtLegTable pairs={m.leg_pairs} cur={m.legs_current} ana={m.legs_analog} when={m.period.when} /></CardBody>
            </Card>
            <Card>
              <CardHeader title={t('Contesto')} icon={<SlidersHorizontal />} subtitle={t('20% del punteggio · {n}%', { n: Math.round(m.context_similarity) })} />
              <CardBody className="grid gap-x-6 pt-0 sm:grid-cols-2">
                {m.context.map((f) => (
                  <div key={f.key} className="border-t border-line py-2" title={f.explanation}>
                    <div className="flex items-baseline justify-between gap-2 text-sm"><span className="text-slate-200">{cap(f.label)}</span><span className="tnum text-white">{f.similarity == null ? t('n/d') : `${Math.round(f.similarity)}%`}</span></div>
                    <div className="tnum mt-0.5 text-xs text-slate-400">{t('Oggi')} {f.display_current} · {yr} {f.display_analog}</div>
                  </div>
                ))}
              </CardBody>
            </Card>
          </div>
        </div>
        <Card>
          <CardHeader title={t('Punti strutturali allineati')} icon={<ListChecks />} subtitle={t('{a} su {b} con lo stesso ruolo', { a: m.mapping.filter((p) => p.same_role).length, b: m.mapping.length })}
            info={t('Passa sopra a un punto per evidenziarlo su entrambi i grafici.')} />
          <CardBody className="pt-0"><UsdtMappingList twoCol mapping={m.mapping} tf={d.tf} when={m.period.when} active={hover} onHover={setHover} /></CardBody>
        </Card>
      </Section>

      <Section title={t('Tutti gli analoghi')} subtitle={t('Seleziona per confrontare')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
          {d.matches.map((mm, i) => <MatchPicker key={mm.rank} m={mm} selected={i === sel} onClick={() => setSel(i)} />)}
        </div>
      </Section>

      {d.mirror && <MirrorSection d={d} />}
      {d.technicals && <TechSection d={d} />}

      <MethodNote><p>{d.method}</p><p>{t('Gli analoghi descrivono precedenti storici, non garantiscono esiti futuri.')}</p></MethodNote>
    </div>
  )
}

const BREAK_ROWS = 6
function MirrorSection({ d }: { d: UsdtAnalogs }) {
  const mi = d.mirror!
  const [all, setAll] = useState(false)
  // ≥ xl the card is as tall as "Intensità dello specchio" and the full list scrolls inside it
  const wide = typeof window !== 'undefined' && window.innerWidth >= 1280
  const breaks = all || wide ? mi.breaks : mi.breaks.slice(0, BREAK_ROWS)
  return (
    <Section title={t('Specchio BTC ↔ USDT.D')} subtitle={t('Stato attuale: {s}', { s: word(mi.state).toLowerCase() })}>
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-7">
          <CardHeader title={t('Intensità dello specchio')} icon={<FlipHorizontal2 />} subtitle={t('−correlazione a {n} giorni · ultimi 2 anni', { n: mi.window })}
            info={t("Correlazione negativa dei rendimenti giornalieri di BTC e USDT.D: 1 = specchio perfetto (quando una sale l'altra scende).")} />
          <CardBody className="flex flex-col gap-4">
            <div className="dgrid grid-cols-2 sm:grid-cols-3">
              <DCell label={t('Oggi')} value={mi.current != null ? mi.current.toFixed(2) : '—'} foot={t('Percentile {n}', { n: mi.percentile?.toFixed(0) ?? '—' })} />
              <DCell label={t('Media 1 anno')} value={mi.avg_1y.toFixed(2)} foot={t('Ultimi 365 giorni')} />
              <DCell label={t('Mediana storica')} value={mi.p50.toFixed(2)} foot={t('10° pct {n}', { n: mi.p10.toFixed(2) })} />
            </div>
            <MirrorChart m={mi} height={220} />
            <ClampText text={mi.text} />
            <div>
              <div className="label mb-1">{t('Configurazioni congiunte simili')}</div>
              <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
                <table className="tbl">
                  <thead><tr><th className="pl-4 sm:pl-5">{t('Periodo')}</th><th className="text-right">{t('Simil.')}</th><th className="text-right">{t('Specchio')}</th><th className="text-right">{t('BTC dopo')}</th><th className="pr-4 text-right sm:pr-5">{t('USDT.D dopo')}</th></tr></thead>
                  <tbody>
                    {mi.joint.map((j) => (
                      <tr key={j.rank}>
                        <td className="pl-4 font-medium text-white sm:pl-5">{plabel(j.label)}</td>
                        <td className="text-right">{j.similarity.toFixed(0)}%</td>
                        <td className="text-right">{j.mirror_then?.toFixed(2) ?? '—'}</td>
                        <td className="text-right"><Change value={j.btc_outcome} digits={1} /></td>
                        <td className="pr-4 text-right sm:pr-5"><PointsChange value={j.usdt_outcome_pts} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="xl:col-span-5 xl:h-0 xl:min-h-full">
          <CardHeader title={t('Rotture dello specchio')} icon={<Unlink />} subtitle={t('BTC e USDT.D nella stessa direzione su 7 giorni')} />
          <CardBody className="flex min-h-0 flex-col gap-3">
            <div className="dgrid grid-cols-2">
              {mi.break_stats.map((b) => (
                <DCell key={b.kind} label={b.kind === 'both_up' ? t('Su insieme · BTC {n}', { n: nd(30) }) : t('Giù insieme · BTC {n}', { n: nd(30) })} value={<Change value={b.median_after_30} digits={1} />}
                  foot={t('{n} casi · {p}% positivi', { n: b.n, p: b.up_rate_30?.toFixed(0) ?? '—' })} />
              ))}
            </div>
            {mi.current_break && (
              <p className="flex gap-2 text-sm text-slate-300"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" /><span><span className="font-medium text-white">{t('In corso')}: </span>{mi.current_break.text}</span></p>
            )}
            {mi.breaks.length === 0 && <EmptyState text={t('Nessuna rottura registrata')} compact />}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {breaks.map((b, i) => (
                <Row key={i}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-slate-200">{b.kind === 'both_up' ? t('Entrambi su') : t('Entrambi giù')}</span>
                    <span className="text-xs text-slate-400">{b.label}</span>
                  </div>
                  <div className="tnum mt-1 grid grid-cols-3 gap-2 text-xs text-slate-400">
                    <span>BTC <Change value={b.btc_change} digits={1} /></span>
                    <span>USDT.D <PointsChange value={b.usdt_change_pts} /></span>
                    <span className="text-right">{t('Dopo {n}', { n: nd(30) })} <Change value={b.btc_after_30} digits={1} /></span>
                  </div>
                </Row>
              ))}
              {!wide && mi.breaks.length > BREAK_ROWS && <ShowAll open={all} total={mi.breaks.length} onClick={() => setAll((v) => !v)} />}
            </div>
          </CardBody>
        </Card>
      </div>
    </Section>
  )
}

function TechSection({ d }: { d: UsdtAnalogs }) {
  const tc = d.technicals!
  const it = d.intraday
  return (
    <Section title={t('Tecnica sulla USDT.D')} subtitle={t('Toni espressi dal punto di vista di BTC')}>
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-8">
          <CardHeader title={t('USDT.D giornaliera')} icon={<CandlestickChart />} subtitle={t('EMA 50/200, RSI 14 e zone di rifiuto')} />
          <CardBody className="flex flex-col gap-4">
            <div className="dgrid grid-cols-2 lg:grid-cols-4">
              <DCell label="USDT.D" value={`${tc.usdt_d.toFixed(2)}%`} foot={`${t('Trend')} ${word(tc.trend).toLowerCase()}`} />
              <DCell label="RSI 14" value={tc.rsi.toFixed(0)} foot={word(tc.rsi_zone)} />
              <DCell label="vs EMA 50" value={<PointsChange value={tc.dist_ema50_pts} />} foot={`EMA ${tc.ema50.toFixed(2)}%`} />
              <DCell label="vs EMA 200" value={<PointsChange value={tc.dist_ema200_pts} />} foot={`EMA ${tc.ema200.toFixed(2)}%`} />
            </div>
            <Fill min={340}><UsdtTechChart t={tc} height="100%" /></Fill>
            <SignalList signals={tc.signals} />
          </CardBody>
        </Card>
        <div className="flex flex-col gap-3 xl:col-span-4">
          <Card>
            <CardHeader title={t('Zone della USDT.D')} icon={<Layers />} subtitle={t('Reazione di BTC dopo i rifiuti della dominance')} />
            <CardBody className="pt-0">
              {tc.zones.map((z, i) => (
                <Row key={i}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-slate-400">{z.kind === 'resistance' ? t('Resistenza') : t('Supporto')}</span>
                    <span className="tnum whitespace-nowrap font-medium text-white">{z.low.toFixed(2)}–{z.high.toFixed(2)}% <span className="text-xs font-normal text-slate-400">{pts(z.distance_pts, 2)}</span></span>
                  </div>
                  <div className="tnum mt-1 flex justify-between gap-2 text-xs text-slate-400">
                    <span>{t('{r} reazioni · {t} tocchi', { r: z.reactions, t: z.touches })}</span>
                    <span>BTC {nd(30)} <Change value={z.btc_after_30_median} digits={1} /> · {z.btc_up_rate_30 != null ? t('{n}% su', { n: z.btc_up_rate_30.toFixed(0) }) : '—'}</span>
                  </div>
                </Row>
              ))}
            </CardBody>
          </Card>
          {it && (
            <Card className="flex-1">
              <CardHeader title={t('USDT.D intraday')} icon={<Clock />} subtitle={t('Stima {tf} · ultimi 30 giorni', { tf: tfLabel('4h') })} info={it.note} />
              <CardBody className="flex flex-col gap-3">
                <div className="dgrid grid-cols-2">
                  <DCell label={t('Ultima {tf}', { tf: tfLabel('4h') })} value={`${it.last.toFixed(2)}%`} foot={<PointsChange value={it.change_24h_pts} suffix="24h" />} />
                  <DCell label={t('Giornaliera')} value={`${it.daily_last.toFixed(2)}%`} foot={t('Differenza {n}', { n: pts(it.last - it.daily_last, 2) })} />
                </div>
                <div className="relative min-h-12 flex-1"><Sparkline data={it.series} height={48} className="absolute inset-0 h-full" /></div>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </Section>
  )
}

// ================================================================== STABLECOIN
function StablesTab() {
  const q = useStablecoins()
  return (
    <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[360px]" /></div>} isEmpty={(s) => !s.series.length}>
      {(s) => <StablesBody s={s} updatedAt={q.dataUpdatedAt} />}
    </Q>
  )
}

function StablesBody({ s, updatedAt }: { s: Stablecoins; updatedAt: number }) {
  const c = s.current
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <KpiCell icon={<Coins />} label={t('Supply stablecoin')} value={usdCompact(c.supply, 1)} foot={c.at_ath ? t('Massimo storico') : undefined}
          delta={c.at_ath ? undefined : <Change value={(c.supply / c.supply_ath - 1) * 100} digits={1} suffix={t('dal max')} />} />
        <KpiCell icon={<CirclePlus />} label={t('Emissione netta {n}', { n: nd(30) })} value={<span className={signTone(c.net_30d)}>{signedUsd(c.net_30d)}</span>} delta={<><Change value={c.pct_30d} digits={2} /> <span className="text-slate-400">· {nd(90)}</span> <Change value={c.pct_90d} digits={1} /></>} />
        <KpiCell icon={<PieChart />} label={t('Dominance')} value={`${c.dominance.toFixed(2)}%`} delta={<PointsChange value={c.dominance_change_30d} suffix={nd(30)} />} />
        <KpiCell icon={<Gauge />} label="SSR" value={c.ssr.toFixed(2)} foot={`z ${c.ssr_z != null ? `${c.ssr_z >= 0 ? '+' : '−'}${Math.abs(c.ssr_z).toFixed(2)}` : '—'} · ${t('media')} ${c.ssr_mid?.toFixed(2) ?? '—'}`} />
        <KpiCell icon={<Percent />} label={t('Quota USDT')} value={`${c.usdt_share.toFixed(1)}%`} foot={t('Sul totale stablecoin')} className="col-span-2 md:col-span-1" />
      </KpiStrip>
      <div className="grid items-start gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('Supply totale e dominance')} subtitle={t('Stablecoin in USD (DefiLlama)')} icon={<Coins />} updatedAt={updatedAt}
            info={t('Dominance = quota delle stablecoin sulla capitalizzazione crypto totale.')} />
          <CardBody><SupplyChart s={s} height={340} /></CardBody>
        </Card>
        <Card>
          <CardHeader title={t('Stablecoin Supply Ratio')} icon={<Gauge />} subtitle={`${t('Cap BTC / supply stablecoin')}${s.live ? ` · ${t('Live')}` : ''}`}
            info={t("SSR basso = molta liquidità in stablecoin rispetto a BTC (potere d'acquisto potenziale). Bande = media 365 giorni ± 1σ e ± 2σ.")} />
          <CardBody><SsrChart s={s} height={340} /></CardBody>
        </Card>
      </div>
      <div className="grid items-start gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-7">
          <CardHeader title={t('Mint / burn settimanale')} icon={<BarChart3 />} subtitle={t('Variazione netta della supply · ultime 104 settimane')} />
          <CardBody>
            <div className="dgrid mb-3 grid-cols-2 sm:grid-cols-4">
              <DCell label={t('7 giorni')} value={<span className={signTone(c.net_7d)}>{signedUsd(c.net_7d)}</span>} foot={<><Change value={c.pct_7d} digits={2} /> <span className="text-slate-500">{t('della supply')}</span></>} />
              <DCell label={t('30 giorni')} value={<span className={signTone(c.net_30d)}>{signedUsd(c.net_30d)}</span>} foot={<><Change value={c.pct_30d} digits={2} /> <span className="text-slate-500">{t('della supply')}</span></>} />
              <DCell label={t('90 giorni')} value={<span className={signTone(c.net_90d)}>{signedUsd(c.net_90d)}</span>} foot={<><Change value={c.pct_90d} digits={2} /> <span className="text-slate-500">{t('della supply')}</span></>} />
              <DCell label={t('1 anno')} value={<span className={signTone(c.net_365d)}>{signedUsd(c.net_365d)}</span>} foot={<><Change value={c.pct_365d} digits={1} /> <span className="text-slate-500">{t('della supply')}</span></>} />
            </div>
            <MintBurnChart data={s.weekly_net} height={260} />
          </CardBody>
        </Card>
        <Card className="xl:col-span-5">
          <CardHeader title={t('Emissione vs rendimenti BTC')} icon={<Timer />} subtitle={t('Correlazione a 4 settimane · lag in settimane')}
            info={t("Lag positivo = l'emissione di stablecoin anticipa i rendimenti di BTC. La barra blu è il lag con la correlazione più forte.")} />
          <CardBody className="flex flex-col gap-3">
            <LeadLagBars data={s.issuance.lead_lag} best={s.issuance.best_lag} unit={t('sett.')} height={200} />
            <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
              <table className="tbl">
                <thead><tr><th className="pl-4 sm:pl-5">{t('Regime (dal 2020)')}</th><th className="text-right">BTC {nd(30)}</th><th className="pr-4 text-right sm:pr-5">{t('Positivi')}</th></tr></thead>
                <tbody>
                  {s.issuance.regimes.map((r) => (
                    <tr key={r.key}>
                      <td className="whitespace-normal pl-4 text-slate-200 sm:pl-5">{cap(r.label)}{r.key === s.issuance.current_regime && <Badge color="blue" className="ml-2">{t('Oggi')}</Badge>}</td>
                      <td className="text-right"><Change value={r.median} digits={1} /></td>
                      <td className="pr-4 text-right sm:pr-5">{r.up_rate?.toFixed(0) ?? '—'}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3 min-[2200px]:grid-cols-5">
        {s.interpretation.map((it) => (
          <Card key={it.key}>
            <CardHeader title={it.title} icon={<Lightbulb />} right={<ToneBadge tone={it.tone} />} />
            <CardBody><ClampText text={it.text} /></CardBody>
          </Card>
        ))}
      </div>
      <MethodNote><p>{s.note}</p></MethodNote>
    </div>
  )
}

// ================================================================== pagina
export default function UsdtPage() {
  const [tab, setTab] = useTab<Tab>(TABS.map((x) => x.value), 'overview')
  const sub: Record<Tab, string> = {
    overview: t('Dominance di Tether e prezzo di Bitcoin: correlazioni, anticipo, livelli.'),
    analogs: t('Periodi storici in cui la USDT dominance aveva la stessa forma di oggi.'),
    stables: t('Liquidità delle stablecoin: supply, dominance, SSR ed effetto su BTC.'),
  }
  return (
    <div>
      <PageTitle title="USDT" subtitle={sub[tab]} />
      <TabBar tabs={TABS.map((x) => ({ ...x, label: t(x.label) }))} value={tab} onChange={setTab} />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'analogs' && <AnalogsTab />}
      {tab === 'stables' && <StablesTab />}
    </div>
  )
}
