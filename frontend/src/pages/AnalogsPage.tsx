import { useEffect, useMemo, useState } from 'react'
import { ScanSearch, GitCompareArrows, ListChecks, MessageSquareText, Target, Layers, Radio, Spline, SlidersHorizontal, ChevronDown, ChevronUp, Scale, Activity, History, Crosshair } from 'lucide-react'
import { useAnalogs, type AnalogCandle, type AnalogMatch, type AnalogTf } from '../api/analogs'
import { useLive } from '../api/live'
import Sparkline from '../components/charts/Sparkline'
import { C } from '../components/charts/theme'
import { Badge, Card, CardBody, CardHeader, Change, ICON, KpiCell, KpiStrip, Legend, MethodNote, ProgressBar, Q, Segmented, Skeleton, Toggle, ToneBadge, clsx, PageActions, SettingsPanel, SectionHead } from '../components/ui'
import { date, pct, usd } from '../lib/format'
import { t, tfLabel } from '../i18n'
import { usePrice } from '../widgets/hooks'
import {
  AnalogCandles, AnalogOverlay, DCell, FeatureCard, LEG_COLOR, LINE_STYLE, LegBars, LegTable, MATCH_GRID, MappingList, balancedCols, PatternBadges, VisualBreakdown, analogStats, buildFuture, pctRangeWithFuture, plabel, whenYear, type ChartLayers,
} from '../widgets/analogs'
import { T, alpha } from '../theme/tokens'

const DEFAULT_WINDOW: Record<AnalogTf, number> = { '1h': 72, '4h': 60, '1d': 60, '1w': 26 }

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
    <label className="flex min-w-[180px] flex-1 flex-col gap-2">
      <span className="flex items-baseline justify-between"><span className="label">{label}</span><span className="tnum text-sm text-white">{value}{suffix}</span></span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

/** Aggiorna l'ultima candela della finestra attuale con il prezzo live (kline WS del tf se presente, altrimenti ticker). */
function useLiveCandles(candles: AnalogCandle[], tf: AnalogTf): { candles: AnalogCandle[]; live: boolean } {
  const kline = useLive((s) => s.klines[tf] ?? null)
  const price = usePrice()
  return useMemo(() => {
    if (!candles.length) return { candles, live: false }
    const last = candles[candles.length - 1]
    let upd: AnalogCandle | null = null
    if (kline && kline.time === last.time) upd = { ...last, high: Math.max(last.high, kline.high), low: Math.min(last.low, kline.low), close: kline.close }
    else if (price && price > 0) upd = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }
    if (!upd || upd.close === last.close) return { candles, live: !!upd }
    return { candles: [...candles.slice(0, -1), upd], live: true }
  }, [candles, kline, price])
}

function SimRing({ value, caption }: { value: number; size?: number; caption?: string }) {
  return (
    <div className="shrink-0">
      <div className="tnum text-3xl font-semibold text-white">{Math.round(value)}%</div>
      <div className="label">{caption ?? t('Similarità')}</div>
    </div>
  )
}

function MatchPicker({ m, selected, onClick }: { m: AnalogMatch; selected: boolean; onClick: () => void }) {
  const path = m.candles.map((c) => c.close)
  return (
    <button
      onClick={onClick}
      className={clsx('flex h-full flex-col rounded-2xl border bg-surface p-4 text-left transition-colors',
        selected ? 'border-accent/60' : 'border-line hover:border-line-strong')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="tnum text-xs text-fg-3">#{m.rank}</span>
          <span className="truncate text-sm text-white">{plabel(m.period.label)}</span>
        </div>
        <Change value={m.outcome.change} digits={1} className="text-sm" />
      </div>
      <div className="relative mt-2 min-h-10 flex-1"><Sparkline className="absolute inset-0 h-full" data={path} color={selected ? C.accent : T.fg3} height={40} /></div>
      <div className="mt-2 flex items-center justify-between text-xs"><span className="text-fg-3">{t('Similarità')}</span><span className="tnum text-white">{m.similarity.toFixed(0)}%</span></div>
      <ProgressBar value={m.similarity} color={T.accent} className="mt-1 h-1" />
      <div className="mt-1.5 flex justify-between text-2xs text-fg-3"><span>{t('Grafica {n}%', { n: m.visual_similarity.toFixed(0) })}</span><span>{t('Indicatori {n}%', { n: m.feature_similarity.toFixed(0) })}</span></div>
      <div className="mt-1.5 h-4 truncate text-2xs text-fg-3">{m.patterns.common_name ? t('Entrambi: {x}', { x: m.patterns.common_name.toLowerCase() }) : ''}</div>
    </button>
  )
}

export default function LiveAnalogs() {
  const [tf, setTf] = useState<AnalogTf>('1d')
  const [win, setWin] = useState(DEFAULT_WINDOW['1d'])
  const [top, setTop] = useState(5)
  const [sel, setSel] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [sortBy, setSortBy] = useState<'sim' | 'weight'>('sim')
  const [mode, setMode] = useState<'side' | 'overlay'>('side')
  const [layers, setLayers] = useState<ChartLayers>({ points: true, legs: true, patterns: true })
  const [showFeats, setShowFeats] = useState(false)
  const params = useDebounced({ tf, window: win, top })
  const q = useAnalogs(params)
  useEffect(() => setSel(0), [params.tf, params.window, params.top])
  const onTf = (v: AnalogTf) => { setTf(v); setWin(DEFAULT_WINDOW[v]) }

  const rawCur = q.data?.current.candles ?? []
  const { candles: curCandles, live } = useLiveCandles(rawCur, (q.data?.tf ?? tf) as AnalogTf)

  return (
    <div>
      <PageActions>
        <Segmented value={tf} onChange={onTf} options={(['1h', '4h', '1d', '1w'] as const).map((v) => ({ value: v, label: tfLabel(v) }))} />
        <SettingsPanel busy={q.isFetching}>
          <Slider label={t('Finestra attuale (candele)')} value={win} min={20} max={200} step={2} onChange={setWin} />
          <Slider label={t('Numero di analoghi')} value={top} min={1} max={8} onChange={setTop} />
        </SettingsPanel>
      </PageActions>

      <Q q={q} loading={<div className="grid gap-5"><Skeleton className="h-44" /><Skeleton className="h-[380px]" /><Skeleton className="h-64" /></div>}
        isEmpty={(d) => !d.matches.length} empty={t('Nessun analogo trovato con questi parametri: prova una finestra più corta.')}>
        {(d) => {
          const m = d.matches[Math.min(sel, d.matches.length - 1)]
          const w = d.window
          const anaWin = m.candles.slice(0, w)
          const anaAfter = m.candles.slice(w)
          const future = buildFuture(m, d.matches, w, curCandles.length ? curCandles : d.current.candles)
          const [yMin, yMax] = pctRangeWithFuture(curCandles, [...anaWin, ...anaAfter], future)
          const curChg = curCandles.length ? (curCandles[curCandles.length - 1].close / curCandles[0].close - 1) * 100 : null
          const anaChg = anaWin.length ? (anaWin[anaWin.length - 1].close / anaWin[0].close - 1) * 100 : null
          const livePrice = curCandles[curCandles.length - 1]?.close ?? d.current.close
          const target = m.outcome.change != null ? livePrice * (1 + m.outcome.change / 100) : null
          const stats = analogStats(d.matches, livePrice)
          const rangeTxt = stats ? t('Range {a}–{b} (P25–P75)', { a: usd(stats.lo), b: usd(stats.hi) }) : ''
          const feats = [...m.features].sort((a, b) =>
            sortBy === 'sim' ? (b.similarity ?? -1) - (a.similarity ?? -1) : b.weight - a.weight || (b.similarity ?? -1) - (a.similarity ?? -1))
          const nAvail = m.features.filter((f) => f.similarity != null).length
          const yr = whenYear(m.period.when)
          const narrow = typeof window !== 'undefined' && window.innerWidth < 640
          const chartH = narrow ? 340 : 420
          const pl = plabel(m.period.label)
          return (
            <div className="flex flex-col gap-3">
              {/* ---------------- hero */}
              <Card>
                <CardBody className="pt-4 sm:pt-5">
                  <div className="flex items-start gap-4 sm:gap-6">
                  <SimRing value={m.visual_similarity} caption={t('Grafica')} />
                  <div className="min-w-0 max-w-[900px] flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <Badge>{t('Analogo #{n}', { n: m.rank })}</Badge>
                      <Badge color="slate">{plabel(d.current.label)}</Badge>
                      {live && <Badge color="btc"><Radio size={12} /> {t('Live')}</Badge>}
                    </div>
                    <h2 className="text-lg font-semibold leading-snug tracking-tight text-white">
                      {t('Il grafico attuale ({w} candele {tf}) somiglia a', { w, tf: tfLabel(d.tf) })}{' '}
                      <span className="text-white">{pl.replace(/ \(\w+\)$/, '')}</span>
                      <span className="text-fg-3"> · {t('somiglianza grafica {n}%', { n: Math.round(m.visual_similarity) })}</span>
                    </h2>
                    <p className="mt-1.5 text-sm text-fg-2">{m.patterns.text}</p>
                    <p className="mt-1 text-sm text-fg-3">
                      {t('Complessiva')} <b className="text-fg">{m.similarity.toFixed(0)}%</b> {t('= 70% grafica + 30% indicatori')}
                      {' '}(<b className="text-fg">{m.feature_similarity.toFixed(0)}%</b> {t('su {n}', { n: nAvail })}) · {date(m.period.start)} → {date(m.period.end)}
                    </p>
                  </div>
                  </div>
                </CardBody>
              </Card>
              <KpiStrip cols="grid-cols-2 lg:grid-cols-4">
                <KpiCell icon={<Target />} label={t('Mediana analoghi ({n})', { n: stats?.n ?? d.matches.length })}
                  value={stats ? pct(stats.median, 1) : '—'}
                  delta={stats ? <span className="text-fg">{usd(stats.price)}</span> : null}
                  foot={stats ? rangeTxt : null}
                  title={t('Esito mediano di tutti gli analoghi applicato al prezzo attuale; range = 25°–75° percentile degli esiti.')} />
                <KpiCell icon={<Activity />} label={t('Oggi')} value={<Change value={curChg} digits={1} />} foot={t("Dall'inizio finestra")} />
                <KpiCell icon={<History />} label={t('Nel {y}', { y: whenYear(m.period.when) })} value={<Change value={anaChg} digits={1} />} foot={t('Stessa finestra')} />
                <KpiCell icon={<Crosshair />} label={t('Analogo #{r} · dopo {n} candele', { r: m.rank, n: m.outcome.candles })} value={<Change value={m.outcome.change} digits={1} />}
                  foot={target ? t('Se si ripetesse: {p}', { p: usd(target) }) : t('Esito analogo')} />
              </KpiStrip>

              {/* ---------------- confronto grafico */}
              <Card>
                <CardHeader
                  title={t('Confronto grafico')}
                  icon={<GitCompareArrows />}
                  updatedAt={q.dataUpdatedAt}
                  subtitle={t('Stessa scala in % dalla prima chiusura · gambe ZigZag, figure e punti corrispondenti su entrambi i grafici')}
                  right={
                    <>
                      <Segmented value={mode} onChange={setMode} options={[{ value: 'side', label: t('Affiancati') }, { value: 'overlay', label: t('Sovrapposti') }]} />
                      <Toggle on={layers.legs} onClick={() => setLayers({ ...layers, legs: !layers.legs })} color={LEG_COLOR}>{t('Gambe')}</Toggle>
                      <Toggle on={layers.patterns} onClick={() => setLayers({ ...layers, patterns: !layers.patterns })} color={LINE_STYLE.neckline.color}>{t('Figure')}</Toggle>
                      <Toggle on={layers.points} onClick={() => setLayers({ ...layers, points: !layers.points })} color={C.accent}>{t('Punti')}</Toggle>
                    </>
                  }
                />
                <CardBody>
                  {mode === 'side' ? (
                    <div className="grid gap-4 xl:grid-cols-2">
                      <div className="min-w-0">
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium text-white"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-accent" />{t('Oggi')} · {plabel(d.current.label)}</span>
                          <span className="tnum text-fg-2">{usd(livePrice)}</span>
                        </div>
                        <PatternBadges patterns={m.patterns.current} />
                        <AnalogCandles candles={curCandles} future={future} points={m.mapping} side="current" tf={d.tf} yMin={yMin} yMax={yMax} active={hover} accent={C.accent}
                          height={chartH} legs={m.legs_current} patterns={m.patterns.current} layers={layers} compact={narrow} />
                      </div>
                      <div className="min-w-0">
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium text-white"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-fg-3" />{t('Analogo')} · {pl}</span>
                          <span className="tnum text-fg-2">{usd(anaWin[anaWin.length - 1]?.close)}</span>
                        </div>
                        <PatternBadges patterns={m.patterns.analog} />
                        <AnalogCandles candles={anaWin} after={anaAfter} outcome={m.outcome.change} points={m.mapping} side="analog" tf={d.tf} yMin={yMin} yMax={yMax} active={hover} accent={C.accent}
                          height={chartH} legs={m.legs_analog} patterns={m.patterns.analog} layers={layers} compact={narrow} />
                      </div>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <span className="font-medium text-white">{t('Oggi (candele piene)')}</span>
                        <span className="text-fg-3">{t('{x} (in trasparenza)', { x: pl })}</span>
                      </div>
                      <PatternBadges patterns={m.patterns.current} />
                      <AnalogCandles candles={curCandles} ghost={anaWin} ghostAfter={anaAfter} ghostLabel={pl} points={m.mapping} side="current" tf={d.tf}
                        yMin={yMin} yMax={yMax} active={hover} accent={C.accent} height={chartH + 60} legs={m.legs_current} patterns={m.patterns.current} layers={layers} compact={narrow} />
                    </div>
                  )}
                  <div className="mt-4">
                    <div className="label mb-1.5">{t('Cosa è successo dopo')} · {pl}</div>
                    <div className="dgrid grid-cols-2 md:grid-cols-4">
                      <DCell label={t('Esito a {n} candele', { n: m.outcome.candles })} value={<Change value={m.outcome.change} digits={1} />} foot={t('Dalla fine finestra')} />
                      <DCell label={t('Massimo rialzo')} value={<Change value={m.outcome.max_up} digits={1} />} foot={t('Picco nella continuazione')} />
                      <DCell label={t('Massimo ribasso')} value={<Change value={m.outcome.max_down} digits={1} />} foot={t('Minimo nella continuazione')} />
                      <DCell label={t('Se si ripetesse questo analogo')} value={target ? usd(target) : '—'} foot={t('Da {p}', { p: usd(livePrice) })} />
                    </div>
                  </div>
                  <div className="mt-3">
                    <Legend items={[
                      ...(mode === 'side' && future ? [
                        { label: t('Mediana analoghi ({n})', { n: future.n }), color: C.primary },
                        ...(future.p25 ? [{ label: t('Banda P25–P75 analoghi'), color: alpha(T.accent, 0.55) }] : []),
                        ...(future.sel ? [{ label: t('Analogo selezionato · {x}', { x: pl }), color: C.grey, dashed: true }] : []),
                      ] : []),
                      { label: t('Gambe ZigZag (G1, G2…)'), color: LEG_COLOR },
                      { label: t('Resistenza'), color: LINE_STYLE.resistance.color, dashed: true },
                      { label: t('Supporto'), color: LINE_STYLE.support.color, dashed: true },
                      { label: t('Neckline'), color: LINE_STYLE.neckline.color, dashed: true },
                      { label: t('Asta (bandiera)'), color: LINE_STYLE.pole.color },
                    ]} />
                  </div>
                </CardBody>
              </Card>

              {/* ---------------- somiglianza grafica + gambe */}
              <div className="grid gap-3 xl:grid-cols-12">
                <Card className="xl:col-span-5">
                  <CardHeader title={t('Somiglianza grafica')} icon={<ScanSearch />} subtitle={t('Componenti visive e relativo peso (70% del punteggio)')}
                    right={<span className="text-xs text-fg-3">{t('Totale')} <b className="tnum text-lg font-semibold text-white">{Math.round(m.visual_similarity)}%</b></span>} />
                  <CardBody><VisualBreakdown components={m.visual.components} /></CardBody>
                </Card>
                <Card className="flex flex-col xl:col-span-7 xl:h-0 xl:min-h-full">
                  <CardHeader title={t('Gamba per gamba')} icon={<Spline />} subtitle={t('Movimenti ZigZag allineati · oggi vs {y}', { y: yr })} />
                  <CardBody className="flex min-h-0 flex-1 flex-col px-2">
                    <div className="min-h-0 shrink overflow-y-auto"><LegTable pairs={m.leg_pairs} cur={m.legs_current} ana={m.legs_analog} when={m.period.when} /></div>
                    <LegBars className="mt-4 flex-1 px-3" pairs={m.leg_pairs} cur={m.legs_current} ana={m.legs_analog} when={m.period.when} />
                  </CardBody>
                </Card>
              </div>

              <div className="grid gap-3 xl:grid-cols-12">
                <Card className="xl:col-span-7">
                  <CardHeader title={t('Punti strutturali allineati')} icon={<ListChecks />} subtitle={t('{a} su {b} con lo stesso ruolo nei due periodi', { a: m.mapping.filter((p) => p.same_role).length, b: m.mapping.length })} />
                  <CardBody className="flex flex-col"><MappingList mapping={m.mapping} tf={d.tf} when={m.period.when} active={hover} onHover={setHover} /></CardBody>
                </Card>
                <div className="flex flex-col gap-3 xl:col-span-5">
                  <Card className="flex-1">
                    <CardHeader title={t('Perché si somigliano')} icon={<MessageSquareText />} />
                    <CardBody className="flex flex-col gap-2.5 text-sm leading-relaxed text-fg-2">
                      {m.narrative_llm ? <p>{m.narrative_llm}</p> : m.narrative.map((s, i) => <p key={i}>{s}</p>)}
                    </CardBody>
                  </Card>
                  <Card>
                    <CardHeader title={t('Cosa successe dopo')} icon={<Target />} subtitle={t('{x} · {n} candele successive', { x: pl, n: m.outcome.candles })} />
                    <CardBody><div className="dgrid grid-cols-3">
                      <DCell label={t('Esito')} value={<Change value={m.outcome.change} digits={1} />} foot={t('A fine orizzonte')} />
                      <DCell label={t('Max rialzo')} value={<Change value={m.outcome.max_up} digits={1} />} foot={t('Picco')} />
                      <DCell label={t('Max ribasso')} value={<Change value={m.outcome.max_down} digits={1} />} foot={t('Minimo')} />
                    </div></CardBody>
                  </Card>
                </div>
              </div>

              {/* ---------------- overlay continuazione */}
              <Card>
                <CardHeader title={t('Sovrapposizione e continuazione')} icon={<Layers />} subtitle={t("Base 100 all'inizio della finestra · tratteggio = l'analogo selezionato riportato sul prezzo attuale · linea chiara = mediana di tutti gli analoghi")} />
                <CardBody>
                  <AnalogOverlay current={curCandles} match={m} window={w} tf={d.tf} height={360} median={future?.path} />
                  <div className="mt-2"><Legend items={[{ label: t("Banda = massimi/minimi dell'analogo nella continuazione"), color: alpha(T.fg3, 0.4) }]} /></div>
                </CardBody>
              </Card>

              {/* ---------------- altri analoghi + riepilogo */}
              <div className="grid gap-3 xl:grid-cols-12">
                <div className="flex flex-col xl:col-span-9">
                  <SectionHead title={t('Tutti gli analoghi')} subtitle={t('clicca per confrontare')} className="mb-3 !pt-0" />
                  <div className={clsx(MATCH_GRID, 'flex-1', d.matches.length === 5 && 'grid-5-md')} style={balancedCols(d.matches.length, 3, 5)}>
                    {d.matches.map((mm, i) => <MatchPicker key={mm.rank} m={mm} selected={i === sel} onClick={() => { setSel(i); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />)}
                  </div>
                </div>
                <Card className="xl:col-span-3">
                  <CardHeader title={t('Concordanza')} icon={<Scale />} subtitle={t('{n} analoghi', { n: d.summary.count })} />
                  <CardBody className="flex flex-col gap-3">
                    <div className="flex h-8 items-center justify-between">
                      <ToneBadge tone={d.summary.bias} />
                      <span className="text-sm text-fg-3">{t('Accordo')} <b className="tnum text-lg font-semibold text-white">{d.summary.agreement?.toFixed(0) ?? '—'}%</b></span>
                    </div>
                    <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
                      <div className="bg-up" style={{ width: `${(d.summary.up / Math.max(1, d.summary.count)) * 100}%` }} />
                      <div className="bg-down" style={{ width: `${(d.summary.down / Math.max(1, d.summary.count)) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-xs text-fg-3"><span><b className="text-up">{d.summary.up}</b> {t('saliti')}</span><span><b className="text-down">{d.summary.down}</b> {t('scesi')}</span></div>
                    <div className="dgrid grid-cols-2">
                      <DCell label={t('Esito mediano')} value={<Change value={stats?.median ?? d.summary.median_outcome} digits={1} />} foot={stats && stats.n > 1 ? `P25–P75 ${pct(stats.p25, 1)} / ${pct(stats.p75, 1)}` : undefined} />
                      <DCell label={t('Media pesata')} value={<Change value={d.summary.weighted_outcome} digits={1} />} foot={t('Pesata per similarità')} />
                    </div>
                    <p className="text-sm text-fg-2">{d.summary.text}</p>
                  </CardBody>
                </Card>
              </div>

              {/* ---------------- indicatori (secondari) */}
              <Card>
                <CardHeader
                  title={t('Indicatori di contesto')}
                  icon={<SlidersHorizontal />}
                  subtitle={t('30% del punteggio · oggi vs {x}', { x: pl })}
                  right={
                    <>
                      {showFeats && <Segmented value={sortBy} onChange={setSortBy} options={[{ value: 'sim', label: t('Per similarità') }, { value: 'weight', label: t('Per peso') }]} />}
                      <button className="btn-ghost" onClick={() => setShowFeats(!showFeats)}>
                        {showFeats ? <ChevronUp size={ICON.chip} /> : <ChevronDown size={ICON.chip} />} {showFeats ? t('Nascondi') : t('Mostra {n}', { n: m.features.length })}
                      </button>
                    </>
                  }
                />
                {showFeats ? (
                  <CardBody>
                    <div className="dgrid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                      {feats.map((f) => <FeatureCard key={f.key} f={f} when={m.period.when} />)}
                    </div>
                  </CardBody>
                ) : (
                  <CardBody className="flex flex-wrap gap-2">
                    {feats.slice(0, 6).map((f) => (
                      <span key={f.key} className="inline-flex h-7 items-center gap-1.5 rounded border border-line px-2 text-xs text-fg-2">
                        {f.label}<b className="tnum font-medium text-white">{f.similarity == null ? t('n/d') : `${Math.round(f.similarity)}%`}</b>
                      </span>
                    ))}
                  </CardBody>
                )}
              </Card>

              <MethodNote>
                <p>{d.method} {t('Gli analoghi descrivono precedenti storici, non garantiscono esiti futuri.')}</p>
                <p>{t("Proiezione principale = mediana di tutti gli analoghi: per ogni candela futura si prende la mediana dei percorsi degli analoghi (ognuno normalizzato sulla propria ultima chiusura della finestra e riportato sul prezzo attuale), con banda 25°–75° percentile. Il percorso dell'analogo selezionato è mostrato a parte, tratteggiato.")}</p>
              </MethodNote>
            </div>
          )
        }}
      </Q>
    </div>
  )
}
