import { useState, type ReactNode } from 'react'
import {
  Activity, ArrowDownToLine, ArrowUpToLine, BarChart3, CalendarCheck, CalendarClock, CalendarDays, CalendarRange, Compass, Crosshair, DollarSign, GitBranch, History, Layers,
  ListOrdered, Magnet, MoveHorizontal, Percent, Route, Scale, Signpost, Sparkles, Split, Target, TrendingUp,
} from 'lucide-react'
import { useCandles } from '../api/client'
import {
  useStructurePivots, useStructureRanges, useStructureScenarios,
  type MondayCurrent, type Scenario, type StructurePivots, type StructureRanges, type StructureScenarios, type TfStructure,
} from '../api/structure'
import { Badge, Card, CardBody, CardHeader, EmptyState, Fill, KpiCell, KpiStrip, MethodNote, PageTitle, ProgressBar, Q, Segmented, Skeleton, TabBar, ToneBadge, clsx } from '../components/ui'
import { useTab } from '../lib/useTab'
import { TONE_LABEL, date, pct, usd } from '../lib/format'
import { cap, t, tfIn, tfLabel, tr } from '../i18n'
import type { Candle } from '../api/types'
import {
  EventStatsTable, EventsTable, KV, MagnetTable, MondayHistoryTable, MondaySplitTable, MondayStatsTable, MoreList, OpeningChart, PathSketch, RangeChart,
  Sgn, TBL_WRAP, TILE, WeeklyCloseTable, dist, fin, rt, sentences,
} from '../widgets/structure'

type TF = '4h' | '1d' | '1w'
const tfOpts = (): { value: TF; label: string }[] => (['4h', '1d', '1w'] as TF[]).map((v) => ({ value: v, label: tfLabel(v) }))
/** Short state word for KPI values (module level: Italian, translated at render); the full backend label goes in the foot. */
const STATE_WORD: Record<string, string> = {
  inside: 'Dentro', inside_after_sweep_low: 'Dentro', inside_after_sweep_high: 'Dentro', inside_after_failed_breakout: 'Dentro',
  above_unconfirmed: 'Sopra', accepted_above: 'Accettato sopra', retest_held_above: 'Retest sopra',
  below_unconfirmed: 'Sotto', accepted_below: 'Accettato sotto', retest_held_below: 'Retest sotto',
}
const stateWord = (x: { state: string | null; state_label: string }) => (x.state && STATE_WORD[x.state] ? t(STATE_WORD[x.state]) : cap(x.state_label))
/** "Rialzista (HH · HL)" -> "HH · HL" */
const swingsOf = (label: string) => /\(([^)]+)\)/.exec(label)?.[1] ?? ''
const TF_NAME: Record<TF, [string, string]> = { '4h': ['4 ore', '4-hour'], '1d': ['Giornaliero', 'Daily'], '1w': ['Settimanale', 'Weekly'] }   // tr(...) at render
const LIMIT: Record<TF, number> = { '4h': 240, '1d': 180, '1w': 200 }
const TABS = [{ value: 'range', label: 'Range e struttura' }, { value: 'pivot', label: 'Pivot di apertura' }, { value: 'scenari', label: 'Scenari' }] as const
type TabId = (typeof TABS)[number]['value']
const TAB_IDS = TABS.map((x) => x.value) as TabId[]

const loading = <div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[460px]" /><Skeleton className="h-[320px]" /></div>

function Sub({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('label mb-1.5', className)}>{children}</div>
}

// ================================================================== Range e struttura
function RangeKpis({ d }: { d: StructureRanges }) {
  const x = d.timeframes['1d']
  const r = x.range
  const st = x.structure
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 min-[1700px]:grid-cols-6">
      <KpiCell accent icon={<DollarSign />} label={t('Prezzo BTC')} value={usd(d.price)} foot={tfIn(`ATR 1D ${usd(x.atr)}`)} />
      <KpiCell icon={<MoveHorizontal />} label={tfIn(t('Range 1D'))} value={r ? rt(r.width_pct) : '—'}
        foot={r ? `${usd(r.low)}–${usd(r.high)} · ${t('{n} giorni', { n: r.bars })}` : t('Nessun range riconosciuto')} />
      <KpiCell icon={<Percent />} label={t('Posizione nel range')} value={r && fin(r.position) ? `${r.position.toFixed(0)}%` : '—'}
        foot={r ? `${t('Metà range')} ${usd(r.mid)}` : undefined} />
      <KpiCell icon={<Scale />} label={tfIn(t('Stato 1D'))} value={stateWord(x)} foot={cap(x.state_label)} title={cap(x.state_label)} />
      <KpiCell icon={<GitBranch />} label={tfIn(t('Struttura 1D'))} value={TONE_LABEL[st.trend] ?? cap(st.trend_label)}
        foot={[swingsOf(st.trend_label), st.last_event ? `${st.last_event.label} ${date(st.last_event.time)}` : ''].filter(Boolean).join(' · ')} />
      <KpiCell icon={<Layers />} label={tfIn(t('Range 4H / 1W'))} value={`${stateWord(d.timeframes['4h'])} / ${stateWord(d.timeframes['1w'])}`}
        foot={`${tfLabel('4h')}: ${cap(d.timeframes['4h'].state_label)}`} title={`${tfLabel('1w')}: ${cap(d.timeframes['1w'].state_label)}`} />
    </KpiStrip>
  )
}

function ChartCard({ d, updatedAt }: { d: StructureRanges; updatedAt: number }) {
  const [tf, setTf] = useState<TF>('1d')
  const x = d.timeframes[tf]
  const cq = useCandles(tf, LIMIT[tf])
  return (
    // stretch: the chart (Fill) grows to the state card's height and vice versa
    <div className="grid gap-3 xl:grid-cols-3 2xl:grid-cols-4">
      <Card className="flex flex-col xl:col-span-2 2xl:col-span-3">
        <CardHeader icon={<Layers />} updatedAt={updatedAt} title={t('Range e livelli')}
          subtitle={t('{tf} · range corrente, eventi numerati, livelli chiave', { tf: tr(...TF_NAME[tf]) })}
          right={<Segmented options={tfOpts()} value={tf} onChange={setTf} />}
          info={t('Linee piene: massimo e minimo del range corrente; tratteggio: metà range e range più ampio. I numeri sulle candele corrispondono alla tabella degli eventi. Le linee orizzontali grigie sono i livelli chiave (etichettati i più vicini al prezzo).')} />
        <CardBody className="flex flex-col">
          <Fill min={480}>
            <Q q={cq} loading={<Skeleton className="h-full" />} isEmpty={(c) => !c.length}>
              {(candles) => <RangeChart d={x} candles={candles} tf={tf} height="100%" />}
            </Q>
          </Fill>
        </CardBody>
      </Card>
      <StateCard x={x} />
    </div>
  )
}

function StateCard({ x }: { x: TfStructure }) {
  const r = x.range
  return (
    <Card className="flex flex-col">
      <CardHeader icon={<Compass />} title={t('Stato attuale')} subtitle={`${tr(...TF_NAME[x.tf])} · ${cap(x.state_label)}`} />
      <CardBody className="flex flex-col gap-4">
        <MoreList items={sentences(x.text)} />
        {r && fin(r.position) && (
          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="label">{t('Posizione nel range')}</span>
              <span className="tnum text-sm font-medium text-white">{r.position.toFixed(0)}%</span>
            </div>
            <ProgressBar value={r.position} />
            <div className="tnum mt-1 flex justify-between text-2xs text-slate-500"><span>{usd(r.low)}</span><span>{usd(r.mid)}</span><span>{usd(r.high)}</span></div>
          </div>
        )}
        {r && (
          <div className="dgrid -mx-1 grid-cols-2">
            <RangeCell k={t('Ampiezza')} v={rt(r.width_pct)} sub={fin(r.width_atr) ? `${r.width_atr.toFixed(1)}× ATR` : undefined} />
            <RangeCell k={t('Durata')} v={t('{n} candele', { n: r.bars })} sub={fin(r.days) ? t('{n} giorni', { n: Math.round(r.days) }) : undefined} />
            <RangeCell k={t('Tocchi alto / basso')} v={`${r.touches_high} / ${r.touches_low}`} sub={t('Dal {d}', { d: date(r.start) })} />
            <RangeCell k={t('Chiusure nel range')} v={fin(r.containment) ? `${r.containment.toFixed(0)}%` : '—'} sub={t('Delle candele del range')} />
          </div>
        )}
        <div>
          <Sub>{t('Livelli da monitorare')}</Sub>
          {x.key_levels.map((k) => (
            <KV key={`${k.kind}-${k.price}`} k={cap(k.label)}>{usd(k.price)} <span className="ml-1 text-xs font-normal">{dist(k.distance)}</span></KV>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function RangeCell({ k, v, sub }: { k: ReactNode; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="label truncate">{k}</div>
      <div className="tnum mt-0.5 truncate text-base font-semibold text-white">{v}</div>
      {sub && <div className="tnum truncate text-xs text-slate-400">{sub}</div>}
    </div>
  )
}

function StructureCard({ d }: { d: StructureRanges }) {
  return (
    <Card>
      <CardHeader icon={<GitBranch />} title={t('Struttura di mercato')} subtitle={t('Swing HH/HL/LH/LL, ultimo BOS o CHoCH per timeframe')}
        info={tfIn(t("Swing da zigzag ATR (3× sul 4H, 2.5× sul 1D, 2× sul 1W). BOS = chiusura oltre l'ultimo swing nella direzione della struttura; CHoCH = chiusura oltre l'ultimo swing contro la struttura (cambio di carattere)."))} />
      <CardBody className="pt-0">
        <div className={TBL_WRAP}>
          <table className="tbl min-w-[620px]">
            <thead><tr><th className="pl-4 sm:pl-5">Timeframe</th><th>{tr('Struttura', 'Structure')}</th><th>{t('Ultimi swing')}</th><th>{t('Ultimo evento')}</th><th className="pr-4 text-right sm:pr-5">{tr('Livello', 'Level')}</th></tr></thead>
            <tbody>
              {(['1w', '1d', '4h'] as TF[]).map((tf) => {
                const s = d.timeframes[tf].structure
                return (
                  <tr key={tf}>
                    <td className="pl-4 text-slate-200 sm:pl-5">{tr(...TF_NAME[tf])} <span className="text-xs text-slate-500">{tfLabel(tf)}</span></td>
                    <td><ToneBadge tone={s.trend} label={cap(s.trend_label)} /></td>
                    <td className="text-slate-300">{s.swings.filter((w) => w.label).slice(-4).map((w) => `${w.label} ${usd(w.price)}${w.confirmed ? '' : '*'}`).join(' · ')}</td>
                    <td className="text-slate-300">{s.last_event ? `${s.last_event.label} · ${date(s.last_event.time)}` : '—'}</td>
                    <td className="pr-4 text-right sm:pr-5">{usd(s.last_event?.level)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-400">{t('* Swing in formazione, non ancora confermato.')}</p>
      </CardBody>
    </Card>
  )
}

function EventsCard({ d }: { d: StructureRanges }) {
  const [tf, setTf] = useState<TF>('1d')
  return (
    <Card>
      <CardHeader icon={<ListOrdered />} title={t('Eventi recenti')} subtitle={t('Sweep, recuperi, accettazioni, retest, SFP, BOS/CHoCH')} right={<Segmented options={tfOpts()} value={tf} onChange={setTf} />} />
      <CardBody className="pt-0"><EventsTable events={d.timeframes[tf].events} tf={tf} /></CardBody>
    </Card>
  )
}

function StatsCard({ d }: { d: StructureRanges }) {
  const [tf, setTf] = useState<'1d' | '4h'>('1d')
  const s = d.stats[tf]
  return (
    <Card>
      <CardHeader icon={<Activity />} title={t('Esiti storici per tipo di evento')}
        subtitle={t('{tf} dal {d} · rendimenti mediani dalla chiusura dell\'evento', { tf: tf === '1d' ? tr('Giornaliero', 'Daily') : tr('4 ore', '4-hour'), d: date(s.since) })}
        right={<Segmented options={[{ value: '1d' as const, label: tfLabel('1d') }, { value: '4h' as const, label: tfLabel('4h') }]} value={tf} onChange={setTf} />}
        info={t("Rendimenti mediani a 1/3/7/14 giorni (passa sopra una cella per media e % positivi). Obiettivo 1/2 e invalidazione dipendono dall'evento (passa sopra la percentuale per vederli) e sono verificati sulle 14 giornate successive: se nella stessa candela si toccano obiettivo e invalidazione conta l'invalidazione. Campioni sotto 15 casi in grigio.")} />
      <CardBody className="pt-0"><EventStatsTable stats={s} /></CardBody>
    </Card>
  )
}

function RangeTab() {
  const q = useStructureRanges()
  return (
    <Q q={q} loading={loading}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <RangeKpis d={d} />
          <ChartCard d={d} updatedAt={q.dataUpdatedAt} />
          {/* both are wide tables of very different length: full width each, no half-empty column */}
          <StructureCard d={d} />
          <EventsCard d={d} />
          <StatsCard d={d} />
          <MethodNote><p>{d.method}</p></MethodNote>
        </div>
      )}
    </Q>
  )
}

// ================================================================== Pivot di apertura
const POSITION: Record<string, string> = {
  sopra: 'Sopra il range del lunedì', above: 'Sopra il range del lunedì',
  sotto: 'Sotto il range del lunedì', below: 'Sotto il range del lunedì',
  dentro: 'Dentro il range del lunedì', inside: 'Dentro il range del lunedì',
}
const posText = (m: MondayCurrent) => (POSITION[m.position] ? t(POSITION[m.position]) : cap(m.position))

function PivotKpis({ p }: { p: StructurePivots }) {
  const m = p.monday.current
  const o = p.opens
  const wo = o.levels.find((l) => l.key === 'weekly_open')
  const mo = o.levels.find((l) => l.key === 'monthly_open')
  const prov = m && !m.monday_complete ? t('Provvisorio') : ''
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 min-[1700px]:grid-cols-6">
      <KpiCell accent icon={<DollarSign />} label={t('Prezzo BTC')} value={usd(p.price)} foot={m ? posText(m) : undefined} />
      <KpiCell icon={<ArrowUpToLine />} label={t('Massimo del lunedì')} value={usd(m?.high)} delta={m ? dist(m.dist_high) : undefined} foot={prov} />
      <KpiCell icon={<ArrowDownToLine />} label={t('Minimo del lunedì')} value={usd(m?.low)} delta={m ? dist(m.dist_low) : undefined} foot={prov} />
      <KpiCell icon={<MoveHorizontal />} label={t('Ampiezza del lunedì')} value={rt(m?.range_pct, 2)}
        foot={m && fin(m.range_rank) ? t('Percentile {p} dal 2018', { p: m.range_rank.toFixed(0) }) : undefined} />
      <KpiCell icon={<CalendarDays />} label={t('Apertura settimanale')} value={usd(wo?.price)} delta={dist(wo?.distance)} />
      <KpiCell icon={<CalendarRange />} label={t('Apertura mensile')} value={usd(mo?.price)} delta={dist(mo?.distance)}
        foot={m ? `${tfIn('ADX 1D')} ${fin(m.adx) ? m.adx.toFixed(0) : '—'} · ${m.regime === 'trending' ? tr('In trend', 'Trending') : tr('Laterale', 'Ranging')}` : undefined} />
    </KpiStrip>
  )
}

function FirstWeekCard({ p }: { p: StructurePivots }) {
  const fw = p.opens.first_week
  const st = fw.stats
  const rows: { k: string; v: number | null; n?: number }[] = [
    { k: 'Mese nella stessa direzione della prima settimana', v: st.same_direction_pct },
    { k: 'Massimo del mese nella prima settimana', v: st.high_in_first_week_pct },
    { k: 'Minimo del mese nella prima settimana', v: st.low_in_first_week_pct },
    { k: 'Prima settimana positiva → mese positivo', v: st.after_up.month_up_pct, n: st.after_up.n },
    { k: 'Prima settimana negativa → mese positivo', v: st.after_down.month_up_pct, n: st.after_down.n },
  ]
  return (
    <Card className="flex flex-col">
      <CardHeader icon={<CalendarRange />} title={t('Prima settimana del mese')} subtitle={t('Dal 2012 · {n} mesi', { n: st.months })}
        info={t('Prima settimana = primi 7 giorni del mese (apertura del giorno 1 → chiusura del giorno 7). Resto del mese = dalla chiusura del giorno 7 alla chiusura del mese.')} />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.k}>
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 text-slate-400">{t(r.k)}</span>
                <span className="tnum whitespace-nowrap font-medium text-white">{rt(r.v)}{r.n != null && <span className="ml-1.5 text-xs font-normal text-slate-500">n {r.n}</span>}</span>
              </div>
              <ProgressBar value={fin(r.v) ? r.v : 0} />
            </div>
          ))}
        </div>
        {fw.current && <KV k={t('Prima settimana del mese corrente')}><Sgn v={fw.current.fw_return} /></KV>}
        <MoreList items={sentences(fw.text)} max={2} />
      </CardBody>
    </Card>
  )
}

function PivotTab() {
  const q = useStructurePivots()
  return (
    <Q q={q} loading={loading}>
      {(p) => {
        const m = p.monday
        const o = p.opens
        const wc = p.weekly_close
        return (
          <div className="flex flex-col gap-3">
            <PivotKpis p={p} />
            <div className="grid gap-3 xl:grid-cols-3 2xl:grid-cols-4">
              <Card className="flex flex-col xl:col-span-2 2xl:col-span-3">
                <CardHeader icon={<CalendarClock />} updatedAt={q.dataUpdatedAt} title={t('Range del lunedì e aperture')} subtitle={t('{tf} · settimana precedente e corrente (UTC)', { tf: tfLabel('1h') })}
                  info={t('Linee piene: massimo e minimo del lunedì corrente; tratteggio scuro: lunedì precedente; tratteggio blu: apertura settimanale. Le linee orizzontali grigie sono apertura mensile/annuale e massimi/minimi della settimana e del mese precedenti.')} />
                <CardBody className="flex flex-col"><Fill min={440}><OpeningChart p={p} height="100%" /></Fill></CardBody>
              </Card>
              <Card className="flex flex-col">
                <CardHeader icon={<CalendarCheck />} title={t('Settimana corrente')} subtitle={m.current ? t('Dal {d}', { d: date(m.current.week_start) }) : undefined}
                  right={m.current && !m.current.monday_complete ? <Badge color="btc">{t('Lunedì in corso')}</Badge> : undefined} />
                <CardBody className="flex flex-col gap-4">
                  {m.current && <MoreList items={sentences(m.current.text)} />}
                  {m.previous && (
                    <div>
                      <Sub>{t('Settimana precedente')}</Sub>
                      <KV k={t('Range del lunedì')}>{usd(m.previous.low)}–{usd(m.previous.high)}</KV>
                      <KV k={tr('Chiusura', 'Close')}>{usd(m.previous.close)}</KV>
                      <p className="mt-1 text-xs text-slate-400">{cap(m.previous.text)}</p>
                    </div>
                  )}
                  <div>
                    <Sub>{t('Aperture e livelli del periodo')}</Sub>
                    {o.levels.map((l) => (
                      <KV key={l.key} k={cap(l.label)} title={l.note ?? undefined}>{usd(l.price)} <span className="ml-1 text-xs font-normal">{dist(l.distance)}</span></KV>
                    ))}
                  </div>
                </CardBody>
              </Card>
            </div>
            <div className="grid items-start gap-3 xl:grid-cols-2">
              <Card>
                <CardHeader icon={<Crosshair />} title={t('Rottura del range del lunedì')} subtitle={t('Cosa succede dopo la rottura del massimo o del minimo')}
                  info={t('Il «movimento inverso» di KillaXBT: dopo che il massimo (minimo) del lunedì viene preso, quanto spesso il prezzo rientra nel range e si muove di almeno 2–3% dal livello rotto nella direzione opposta entro la domenica. Tra parentesi il 75° percentile.')} />
                <CardBody className="pt-0"><MondayStatsTable m={m} /></CardBody>
              </Card>
              <Card>
                <CardHeader icon={<Split />} title={t('Per regime e per anno')} subtitle={t('Rottura e movimento inverso (% delle settimane / delle rotture)')}
                  info={t('Regime: ADX(14) giornaliero al lunedì; ≥ 25 = mercato in trend, < 25 = laterale. «Inverso ≥2%» è calcolato sulle settimane in cui il livello è stato rotto.')} />
                <CardBody className="pt-0"><MondaySplitTable m={m} /></CardBody>
              </Card>
            </div>
            {/* ≥2200px side by side: the 12-week table spreads its rows to the magnet card's height */}
            <div className="grid gap-3 min-[2200px]:grid-cols-2">
              <Card>
                <CardHeader icon={<History />} title={t('Storico recente del lunedì')} subtitle={t('Ultime 12 settimane complete')} />
                <CardBody className="flex flex-col pt-0 min-[2200px]:[&_table]:h-full min-[2200px]:[&>*]:flex-1"><MondayHistoryTable m={m} /></CardBody>
              </Card>
              <Card>
                <CardHeader icon={<Magnet />} title={t('Aperture come magnete')} subtitle={t("Rivisitazione dell'apertura dopo uno scostamento")}
                  info={t("Per ogni periodo: dopo che il prezzo si è allontanato almeno della soglia dall'apertura, quante volte è tornato a toccarla prima della fine del periodo. Settimanale da candele 1h dal 2018; mensile, trimestrale e annuale dal giornaliero dal 2012.")} />
                <CardBody className="flex flex-col gap-3 pt-0">
                  <MagnetTable rows={[
                    { label: tr('Settimanale', 'Weekly'), data: o.weekly.magnet }, { label: tr('Mensile', 'Monthly'), data: o.monthly.magnet },
                    { label: tr('Trimestrale', 'Quarterly'), data: o.quarterly.magnet }, { label: tr('Annuale', 'Yearly'), data: o.yearly.magnet },
                  ]} />
                  <MoreList items={[...sentences(o.weekly.text), ...sentences(o.monthly.text)]} />
                </CardBody>
              </Card>
            </div>
            {/* side by side only when the 9-column table fits without horizontal scrolling */}
            <div className="grid items-start gap-3 min-[1700px]:grid-cols-3">
              <Card className="min-[1700px]:col-span-2">
                <CardHeader icon={<BarChart3 />} title={t('Chiusure settimanali')} subtitle={t('Rendimenti mediani dopo la chiusura · {n} settimane dal 2012', { n: wc.weeks })}
                  info={t('Settimane lunedì–domenica (UTC). «Sweep del minimo precedente e chiusura sopra» = la settimana scende sotto il minimo (wick) della precedente ma chiude sopra: la lettura di KillaXBT delle chiusure sopra i minimi precedenti.')} />
                <CardBody className="pt-0"><WeeklyCloseTable w={wc} /></CardBody>
              </Card>
              <FirstWeekCard p={p} />
            </div>
            {wc.current && (
              <Card>
                <CardHeader icon={<TrendingUp />} title={t('Chiusura della settimana in corso')} subtitle={t('Lettura provvisoria e livelli di riferimento')} />
                <CardBody className="grid items-start gap-x-8 gap-y-3 md:grid-cols-2">
                  <MoreList items={sentences(wc.current.text)} />
                  <div>{wc.current.levels.map((l) => <KV key={l.label} k={cap(l.label)}>{usd(l.price)} <span className="ml-1 text-xs font-normal">{dist(l.distance)}</span></KV>)}</div>
                </CardBody>
              </Card>
            )}
            <MethodNote><p>{p.method}</p></MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

// ================================================================== Scenari
const COND: Record<Scenario['trigger']['condition'], string> = { close_above: 'Chiusura sopra', close_below: 'Chiusura sotto', inside: 'Dentro il range' }

function ScenarioCard({ s, history }: { s: Scenario; history: Candle[] }) {
  return (
    <Card className="flex flex-col">
      <CardHeader icon={<Route />} title={`${s.n}. ${s.title}`} right={<ToneBadge tone={s.tone} />} />
      <CardBody className="flex flex-col gap-4">
        <div className={clsx(TILE, 'p-3')}>
          <Sub>{tr('Condizione', 'Condition')}</Sub>
          <p className="text-sm text-slate-200">{cap(s.trigger.text)}</p>
          {fin(s.trigger.level) && <p className="tnum mt-0.5 text-xs text-slate-400">{t(COND[s.trigger.condition])} {usd(s.trigger.level)} · {tfLabel(s.trigger.tf)}</p>}
        </div>
        <PathSketch s={s} history={history} />
        <div>
          <Sub>{tr('Percorso', 'Path')}</Sub>
          {s.targets.length ? s.targets.map((x) => (
            <div key={x.price} className="border-t border-white/[0.05] py-1.5 first:border-t-0">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-slate-200">{cap(x.label)}</span>
                <span className="tnum whitespace-nowrap font-medium text-white">{usd(x.price)} <span className="ml-1 text-xs font-normal">{dist(x.distance)}</span></span>
              </div>
              <p className="truncate text-xs text-slate-400" title={x.reasons.join(' · ')}>{cap(x.reasons.join(' · '))}</p>
            </div>
          )) : <p className="text-sm text-slate-400">{t('Nessun livello chiaro nel raggio considerato')}</p>}
        </div>
        <div className="dgrid -mx-1 grid-cols-1 sm:grid-cols-2">
          <div className="min-w-0 px-3 py-2.5">
            <div className="label">{t('Frequenza storica')}</div>
            {s.probability ? (
              <>
                <div className="tnum mt-1 text-xl font-semibold text-white">{rt(s.probability.value)}</div>
                <div className="truncate text-xs text-slate-400">{s.probability.n != null ? `${t('{n} casi', { n: s.probability.n })} · ${tfLabel(s.probability.tf)}` : tfLabel(s.probability.tf)}</div>
              </>
            ) : <p className="mt-1 text-sm text-slate-400">{t('Non calcolabile per questa condizione')}</p>}
          </div>
          <div className="min-w-0 px-3 py-2.5">
            <div className="label">{tr('Invalidazione', 'Invalidation')}</div>
            <div className="tnum mt-1 text-xl font-semibold text-white">{fin(s.invalidation.price) ? usd(s.invalidation.price) : '—'}</div>
            <div className="line-clamp-2 text-xs text-slate-400" title={cap(s.invalidation.text)}>{cap(s.invalidation.text)}</div>
          </div>
        </div>
        {s.probability?.text && <MoreList items={sentences(s.probability.text)} max={2} />}
        {/* always shown (also when empty) so the scenario cards keep the same sections and no blank block opens up beside a taller card */}
        <div>
          <Sub>{t('Finestre temporali')}</Sub>
          {s.timing.length ? s.timing.map((x) => (
            <KV key={x.time} k={cap(x.title)}>{x.label} <span className="ml-1 text-xs font-normal text-slate-400">{fin(x.confluence) ? t('Confl. {n}', { n: x.confluence.toFixed(0) }) : ''}</span></KV>
          )) : <p className="text-sm text-slate-400">{t('Nessuna finestra temporale rilevante per questo scenario')}</p>}
        </div>
        {(s.supports.length > 0 || s.against.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Sub>{t('A favore')}</Sub>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-slate-300 marker:text-up">{s.supports.length ? s.supports.map((x) => <li key={x}>{cap(x)}</li>) : <li className="text-slate-400">—</li>}</ul>
            </div>
            <div>
              <Sub>{tr('Contro', 'Against')}</Sub>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-slate-300 marker:text-down">{s.against.length ? s.against.map((x) => <li key={x}>{cap(x)}</li>) : <li className="text-slate-400">—</li>}</ul>
            </div>
          </div>
        )}
        <div className="mt-auto">
          <Sub>{t('Lettura completa')}</Sub>
          <MoreList items={sentences(s.narrative)} max={1} />
        </div>
      </CardBody>
    </Card>
  )
}

function ScenariosBody({ d, updatedAt }: { d: StructureScenarios; updatedAt: number }) {
  const cq = useCandles('1d', 60)
  const hist = cq.data ?? []
  const r = d.range
  const nearest = d.scenarios.filter((s) => fin(s.trigger.level)).sort((a, b) => Math.abs(a.trigger.level! - d.price) - Math.abs(b.trigger.level! - d.price))[0]
  const maxW = Math.max(1, ...d.levels.map((l) => l.weight))
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip cols="grid-cols-2 md:grid-cols-4">
        <KpiCell accent icon={<DollarSign />} label={t('Prezzo BTC')} value={usd(d.price)} foot={tfIn(`ATR 1D ${usd(d.atr_d)}`)} />
        <KpiCell icon={<Scale />} label={tfIn(t('Stato del range 1D'))} value={stateWord(d)} foot={`${cap(d.state_label)}${r ? ` · ${usd(r.low)}–${usd(r.high)}` : ''}`} title={cap(d.state_label)} />
        <KpiCell icon={<Signpost />} label={t('Livello decisivo più vicino')} value={nearest ? usd(nearest.trigger.level) : '—'}
          delta={nearest && fin(nearest.trigger.level) ? dist((nearest.trigger.level / d.price - 1) * 100) : undefined} foot={t('Separa i primi due scenari')} />
        <KpiCell icon={<Route />} label={tfIn(t('Analoghi frattali 1D'))}
          value={d.analogs ? t('{up} su {n} in rialzo', { up: d.analogs.up ?? 0, n: d.analogs.count ?? 0 }) : '—'}
          foot={d.analogs ? t('Mediana {m} a {h} candele', { m: pct(d.analogs.median_outcome, 1), h: d.analogs.horizon ?? '—' }) : undefined} />
      </KpiStrip>
      <Card>
        <CardHeader icon={<Sparkles />} updatedAt={updatedAt} title={tr('Sintesi', 'Summary')} subtitle={t('Lettura deterministica di struttura, livelli, liquidità, analoghi e tempi')} />
        <CardBody><MoreList items={sentences(d.summary)} /></CardBody>
      </Card>
      {d.scenarios.length ? (
        <div className={clsx('grid gap-3', d.scenarios.length >= 3 ? 'lg:grid-cols-2 2xl:grid-cols-3' : 'xl:grid-cols-2')}>
          {d.scenarios.map((s) => <ScenarioCard key={s.id} s={s} history={hist} />)}
        </div>
      ) : <Card><CardBody className="pt-5"><EmptyState text={t('Nessuno scenario costruibile con i dati attuali')} /></CardBody></Card>}
      <Card>
        <CardHeader icon={<Target />} title={t('Livelli considerati')} subtitle={t('Zone entro ±12% che uniscono più fonti (tolleranza 0.6%)')}
          info={tfIn(t('Fonti: range 4H/1D/1W, estremi degli sweep, aperture e massimi/minimi precedenti, zone e pivot 1D, cluster stimati di liquidazioni, pool di liquidità (massimi/minimi uguali e swing intatti). Peso = somma dei pesi delle fonti.'))} />
        <CardBody className="pt-0">
          <div className={TBL_WRAP}>
            <table className="tbl min-w-[720px]">
              <thead><tr><th className="pl-4 text-right sm:pl-5">{tr('Prezzo', 'Price')}</th><th className="text-right">{tr('Distanza', 'Distance')}</th><th>{tr('Livello', 'Level')}</th><th>{tr('Peso', 'Weight')}</th><th className="pr-4 sm:pr-5">{tr('Motivi', 'Reasons')}</th></tr></thead>
              <tbody>
                {[...d.levels].sort((a, b) => b.price - a.price).map((l) => (
                  <tr key={l.price}>
                    <td className="pl-4 text-right font-medium text-white sm:pl-5">{usd(l.price)}</td>
                    <td className="text-right">{dist(l.distance)}</td>
                    <td className="text-slate-200">{tfIn(cap(l.label))}</td>
                    <td><div className="flex w-36 items-center gap-2"><ProgressBar value={(l.weight / maxW) * 100} /><span className="tnum whitespace-nowrap text-xs text-slate-400">{l.reasons.length === 1 ? t('1 fonte') : t('{n} fonti', { n: l.reasons.length })}</span></div></td>
                    <td className="max-w-[640px] truncate pr-4 text-slate-400 sm:pr-5" title={l.reasons.join(' · ')}>{cap(l.reasons.join(' · '))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      <p className="text-xs text-slate-500">{d.disclaimer}</p>
      <MethodNote><p>{d.method}</p></MethodNote>
    </div>
  )
}

function ScenariosTab() {
  const q = useStructureScenarios()
  return <Q q={q} loading={loading}>{(d) => <ScenariosBody d={d} updatedAt={q.dataUpdatedAt} />}</Q>
}

// ================================================================== page
export default function StructurePage() {
  const [tab, setTab] = useTab<TabId>(TAB_IDS, 'range')
  return (
    <div>
      <PageTitle title={t('Struttura e livelli')} subtitle={t('Range, sweep, pivot di apertura e scenari condizionali.')} />
      <TabBar tabs={TABS.map((x) => ({ value: x.value, label: t(x.label) }))} value={tab} onChange={setTab} />
      {tab === 'range' && <RangeTab />}
      {tab === 'pivot' && <PivotTab />}
      {tab === 'scenari' && <ScenariosTab />}
    </div>
  )
}
