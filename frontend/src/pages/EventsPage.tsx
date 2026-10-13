import { useState, type ReactNode } from 'react'
import { Activity, BarChart3, CalendarClock, CalendarDays, CandlestickChart, CalendarRange, History, Landmark, LineChart, ListOrdered, ScrollText, ShieldCheck, TrendingDown, Vote } from 'lucide-react'
import { useEvents, type EventsResponse } from '../api/events'
import { Card, CardBody, CardHeader, Fill, KpiCell, KpiStrip, MethodNote, PageTitle, Q, Segmented, Skeleton, clsx } from '../components/ui'
import { SectionTitle } from '../widgets/macro'
import {
  ElectionPathChart, EventPathChart, EventStatsTable, LaterList, MidtermLowsTable, QualityTag, RecentOccurrences, UpcomingList, YearTypeTable, whenLabel,
} from '../widgets/events'
import { date, dayUnit, pct, usd } from '../lib/format'
import { cap, t, tr } from '../i18n'

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)

function Tile({ label, value, foot }: { label: ReactNode; value: ReactNode; foot?: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="label">{label}</div>
      <div className="tnum mt-1 text-xl font-semibold tracking-[-0.02em] text-white">{value}</div>
      {foot && <div className="mt-0.5 text-xs text-slate-400">{foot}</div>}
    </div>
  )
}

function Kpis({ d }: { d: EventsResponse }) {
  const next = d.upcoming[0]
  const fomc = d.upcoming.find((u) => u.key === 'fomc')
  const mt = d.political.midterm
  const yt = d.political.year_types.find((x) => x.current)
  const cme = d.cme_gap
  const g = dayUnit()
  const mtWhen = mt.days_to > 0 ? t('Tra {n} giorni', { n: mt.days_to }) : mt.days_to === 0 ? tr('Oggi', 'Today') : t('{n} giorni fa', { n: -mt.days_to })
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
      <KpiCell className="col-span-2 md:col-span-1" icon={<CalendarClock />} label={t('Prossimo evento')} value={next ? next.title : '—'}
        foot={next ? `${next.date_label} · ${whenLabel(next.days_away)}` : undefined} title={next?.text} />
      <KpiCell className="col-span-2 md:col-span-1" icon={<Landmark />} label={t('Prossimo FOMC')} value={fomc ? fomc.date_label : '—'}
        foot={fomc ? <>{whenLabel(fomc.days_away)}{fin(fomc.expected_abs_1d) ? ` · ${t('±{v}% atteso', { v: fomc.expected_abs_1d.toFixed(1) })}` : ''}</> : t('Nessuna riunione nei prossimi 90 giorni')} title={fomc?.text} />
      <KpiCell className="col-span-2 md:col-span-1" icon={<Vote />} label={t('Midterm USA')} value={date(mt.next)} foot={mtWhen} />
      <KpiCell icon={<CalendarRange />} label={yt ? yt.label : t('Anno del ciclo USA')}
        value={<>{pct(yt?.median, 0)}<span className="ml-1 text-sm font-normal text-slate-400">{tr('mediana', 'median')}</span></>}
        foot={yt ? t('{y} · positivi {p}%', { y: yt.years.join(', '), p: fin(yt.win_rate) ? yt.win_rate.toFixed(0) : '—' }) : undefined} />
      <KpiCell icon={<Activity />} label={t('Volatilità normale (3 {g})', { g })} value={`±${d.baseline_now.abs_1d.toFixed(1)}%`}
        foot={t('Movimento mediano ultimi 90 {g} · ±{usd}', { g, usd: usd(d.price * d.baseline_now.abs_1d / 100) })} />
      <KpiCell className="col-span-2 md:col-span-1" icon={<CandlestickChart />} label={t('Gap CME del weekend')} value={cme && fin(cme.avg_abs_gap) ? `±${cme.avg_abs_gap.toFixed(2)}%` : '—'}
        foot={cme && fin(cme.fill_rate) ? t('Livello del venerdì ritoccato nel {p}% dei casi', { p: cme.fill_rate.toFixed(0) }) : undefined} title={cme?.text} />
    </KpiStrip>
  )
}

function StatsSection({ d }: { d: EventsResponse }) {
  const [sel, setSel] = useState<string>(d.types[0]?.key ?? 'fomc')
  const st = d.types.find((x) => x.key === sel) ?? d.types[0]
  return (
    <>
      <Card>
        <CardHeader icon={<BarChart3 />} title={t('Reazione storica per tipo di evento')} subtitle={t('Seleziona una riga per vedere percorso e ultimi casi')}
          info={t("±1 g = dalla chiusura del giorno prima di ieri alla chiusura di domani rispetto all'evento (3 candele giornaliere UTC). Volatilità = movimento assoluto mediano diviso quello di 3 giorni qualsiasi dello stesso periodo: sopra ×1.15 l'evento muove il mercato più del normale.")} />
        <CardBody><EventStatsTable types={d.types} selected={st?.key} onSelect={setSel} /></CardBody>
      </Card>
      {st && (
        <div className="grid gap-3 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader icon={<LineChart />} title={t('Percorso medio · {name}', { name: st.label })} subtitle={t('% rispetto alla chiusura del giorno prima · n={n}', { n: st.n })}
              right={<QualityTag q={st.quality} label={cap(st.quality_label)} />} />
            <CardBody className="flex flex-col gap-3">
              <Fill min={260}><EventPathChart stat={st} height="100%" /></Fill>
              <p className="text-sm text-slate-300">{st.note}</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader icon={<History />} title={t('Ultimi casi')} subtitle={st.description} />
            <CardBody><RecentOccurrences stat={st} /></CardBody>
          </Card>
        </div>
      )}
    </>
  )
}

function PoliticalSection({ d }: { d: EventsResponse }) {
  const [view, setView] = useState<'midterm' | 'presidential'>('midterm')
  const p = d.political
  const mt = p.midterm
  const g = dayUnit()
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader icon={<Landmark />}
            title={view === 'midterm' ? t('BTC attorno alle midterm') : t('BTC attorno alle presidenziali')}
            subtitle={view === 'midterm' ? t('% rispetto a {x} (stessa distanza di oggi)', { x: mt.anchor_label }) : t('% rispetto al giorno del voto')}
            right={<Segmented options={[{ value: 'midterm', label: 'Midterm' }, { value: 'presidential', label: t('Presidenziali') }]} value={view} onChange={setView} />}
          />
          <CardBody className="flex flex-col">
            {view === 'midterm'
              ? <Fill min={280}><ElectionPathChart paths={mt.paths} mean={mt.mean} anchorDay={mt.anchor_day} height="100%" /></Fill>
              : <Fill min={280}><ElectionPathChart paths={p.presidential.paths} anchorDay={0} height="100%" /></Fill>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<ScrollText />} title={t('Cosa dice la storia')} subtitle={t('Midterm 2014, 2018, 2022 · prossime {d}', { d: date(mt.next) })} />
          <CardBody className="flex flex-col gap-3">
            <div className="dgrid grid-cols-2">
              <Tile label={t('180 {g} prima del voto', { g })} value={pct(mt.pre180.current, 1)} foot={t('Media passata {v}', { v: pct(mt.pre180.avg, 1) })} />
              <Tile label={t('12 mesi dopo il voto')} value={pct(mt.fwd_365.avg, 0)} foot={t('Positivi {a} su {b}', { a: mt.fwd_365.up, b: mt.fwd_365.n })} />
            </div>
            <ul className="flex flex-col gap-2 text-sm leading-relaxed text-slate-300">
              {p.text.map((x, i) => (
                <li key={i} className="flex gap-2.5"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-500" />{x}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-3 min-[2200px]:grid-cols-2">
        <Card className="h-full">
          <CardHeader icon={<TrendingDown />} title={t('Minimi di ciclo e midterm')} subtitle={t('Minimo nei 200 {g} prima / 120 {g} dopo il voto', { g })} />
          <CardBody className="flex flex-col"><MidtermLowsTable lows={mt.lows} /></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<ListOrdered />} title={t('Rendimento annuo per anno del ciclo USA')} subtitle={t("Anni solari completi · coincidono con il ciclo dell'halving")}
            info={t("Anno presidenziale = anno dell'halving (2012, 2016, 2020, 2024); anno di midterm = secondo anno dopo l'halving. Con 3–4 casi per gruppo i numeri sono aneddotici.")} />
          <CardBody className="flex flex-col"><YearTypeTable p={p} /></CardBody>
        </Card>
      </div>
    </>
  )
}

export default function EventsPage() {
  const q = useEvents(90)
  return (
    <div>
      <PageTitle title={t('Eventi e ciclo politico')} subtitle={t('Calendario macro, scadenze dei derivati ed elezioni USA, con la reazione storica di BTC e la volatilità attesa.')} />
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[420px]" /><Skeleton className="h-[320px]" /></div>} isEmpty={(d) => !d.types?.length}>
        {(d) => (
          <div className="flex flex-col gap-3">
            <Kpis d={d} />
            {/* ≥ 1700px: 90-day list (2/3, scrolls to the rail height) + rail with "later" and date-quality cards.
                < 1700px: the list spans the width with the later events as its footer; date quality becomes a full-width strip. */}
            <div className="grid gap-3 min-[1700px]:grid-cols-3">
              <Card className="min-[1700px]:col-span-2 min-[1700px]:h-0 min-[1700px]:min-h-full">
                <CardHeader icon={<CalendarDays />} title={t('Prossimi 90 giorni')} subtitle={t("Movimento atteso nei 3 giorni attorno all'evento")}
                  updatedAt={q.dataUpdatedAt}
                  info={t("Movimento atteso = rapporto storico di volatilità dell'evento × movimento mediano di BTC negli ultimi 90 giorni. Le date stimate vanno verificate sul calendario ufficiale.")} />
                <CardBody className="min-h-0 overflow-y-auto pt-0">
                  <UpcomingList items={d.upcoming} wide />
                  <div className="mt-3 border-t border-line pt-3 min-[1700px]:hidden">
                    <div className="label mb-1.5">{t('Più avanti')} · {t('Eventi di ciclo oltre i 90 giorni')}</div>
                    <LaterList d={d} className="md:grid md:grid-cols-2 md:gap-x-8 md:[&>li:nth-child(2)]:border-t-0" />
                  </div>
                </CardBody>
              </Card>
              <div className="flex flex-col gap-3">
                <Card className="hidden min-[1700px]:flex">
                  <CardHeader icon={<CalendarClock />} title={t('Più avanti')} subtitle={t('Eventi di ciclo oltre i 90 giorni')} />
                  <CardBody className="pt-0"><LaterList d={d} /></CardBody>
                </Card>
                <Card className="flex-1">
                  <CardHeader icon={<ShieldCheck />} title={t('Qualità delle date')} subtitle={t('Esatte, da regola o stimate')} />
                  <CardBody className="grid gap-x-6 pt-0 text-xs leading-relaxed text-slate-400 md:grid-cols-2 xl:grid-cols-4 min-[1700px]:flex min-[1700px]:flex-col">
                    {d.quality.notes.map((n, i) => <p key={i} className={clsx('py-2 first:pt-0 md:pt-0 min-[1700px]:pt-2 min-[1700px]:first:pt-0', i > 0 && 'border-t border-line md:border-t-0 min-[1700px]:border-t')}>{n}</p>)}
                  </CardBody>
                </Card>
              </div>
            </div>
            <SectionTitle sub={t('Quanto si muove BTC attorno a ogni tipo di evento')}>{t('Statistiche per evento')}</SectionTitle>
            <StatsSection d={d} />
            <SectionTitle sub={t('Elezioni USA, midterm e minimi di ciclo')}>{t('Ciclo politico USA')}</SectionTitle>
            <PoliticalSection d={d} />
            <MethodNote title={t('Metodo e fonti')}>
              <p>{d.method}</p>
              {d.cme_gap && <p>{d.cme_gap.text}</p>}
            </MethodNote>
          </div>
        )}
      </Q>
    </div>
  )
}
