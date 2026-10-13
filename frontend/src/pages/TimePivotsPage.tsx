import { useCallback, useState } from 'react'
import { ArrowRight, CalendarClock, ListChecks } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTimePivots } from '../api/timepivots'
import { Card, CardBody, CardHeader, Fill, PageTitle, Q, Segmented, Skeleton, TabBar } from '../components/ui'
import { useTab } from '../lib/useTab'
import { dayUnit } from '../lib/format'
import { t } from '../i18n'
import {
  CyclePivotsCard, NextPivotsCard, HalvingCycleHeatmap, IntradayCard, MethodNote, MonthlyBars, PivotCalendarList, PivotPriceChart,
  PivotTimeline, ProjectionsCard, SeasonHeatmap, SessionsCard, TodayCard, TpKpiRow, WindowsCard,
} from '../widgets/timepivots'

const Loading = () => (
  <div className="flex flex-col gap-5">
    <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[164px]" />)}</div>
    <div className="grid gap-5 xl:grid-cols-12"><Skeleton className="h-[380px] xl:col-span-8" /><Skeleton className="h-[380px] xl:col-span-4" /></div>
    <Skeleton className="h-[420px]" />
  </div>
)

type Tab = 'calendar' | 'season' | 'cycles'
const TABS: { value: Tab; label: string }[] = [
  { value: 'calendar', label: 'Calendario' }, { value: 'season', label: 'Stagionalità' }, { value: 'cycles', label: 'Cicli' },
]

export default function TimePivotsPage() {
  const [horizon, setHorizon] = useState(90)
  const [tab, setTab] = useTab<Tab>(TABS.map((x) => x.value), 'calendar')
  const q = useTimePivots(horizon)
  const [open, setOpen] = useState<string | null>(null)
  const select = useCallback((id: string) => {
    setTab('calendar')
    setOpen(id)
    setTimeout(() => document.getElementById(`pv-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60)
  }, [setTab])
  return (
    <div>
      <PageTitle title={t('Pivot temporali')} subtitle={t('Date in cui BTC ha storicamente invertito o accelerato.')}
        right={<Link to="/eventi" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-white/20 hover:text-white">{t('Calendario eventi')}<ArrowRight size={14} /></Link>} />
      <TabBar tabs={TABS.map((x) => ({ ...x, label: t(x.label) }))} value={tab} onChange={setTab} />
      <Q q={q} loading={<Loading />} isEmpty={(d) => !d.seasonality}>
        {(d) => (
          <div className="flex flex-col gap-3">
            {tab === 'calendar' && (
              <>
                <TpKpiRow d={d} />
                {/* left: event strip (content height) above the price chart; right: today card — the price chart absorbs the height */}
                <div className="grid gap-3 xl:grid-cols-12">
                  <Card className="xl:col-span-8">
                    <CardHeader title={t('Prossimi {n} giorni', { n: d.horizon })} icon={<CalendarClock />} updatedAt={q.dataUpdatedAt}
                      subtitle={t('Un punto per pivot · bande sul prezzo = finestre, intensità = confluenza')}
                      right={<Segmented value={horizon} onChange={setHorizon} options={[30, 90, 180].map((n) => ({ value: n, label: `${n} ${dayUnit()}` }))} />} />
                    <CardBody className="flex flex-col gap-2">
                      <PivotTimeline d={d} onSelect={select} />
                      <Fill min={380}><PivotPriceChart d={d} /></Fill>
                    </CardBody>
                  </Card>
                  <div className="flex flex-col gap-3 xl:col-span-4">
                    <TodayCard d={d} />
                    <NextPivotsCard d={d} onSelect={select} />
                  </div>
                </div>
                <Card>
                  <CardHeader title={t('Calendario dei pivot')} icon={<ListChecks />} subtitle={t('Fonti indipendenti sugli stessi giorni → confluenza 0–100')} />
                  <CardBody className="px-3">
                    <PivotCalendarList d={d} open={open} setOpen={setOpen} />
                  </CardBody>
                </Card>
              </>
            )}
            {tab === 'season' && (
              <>
                <WindowsCard d={d} updatedAt={q.dataUpdatedAt} />
                <div className="grid gap-3 xl:grid-cols-12">
                  <div className="xl:col-span-7"><SeasonHeatmap d={d} /></div>
                  <div className="xl:col-span-5"><MonthlyBars d={d} /></div>
                </div>
                <div className="grid gap-3 xl:grid-cols-12">
                  <div className="xl:col-span-8"><IntradayCard d={d} /></div>
                  <div className="xl:col-span-4"><SessionsCard d={d} /></div>
                </div>
              </>
            )}
            {tab === 'cycles' && (
              <>
                <HalvingCycleHeatmap d={d} updatedAt={q.dataUpdatedAt} />
                {/* the projections card sets the row height; the long cycle-pivot list scrolls inside its card */}
                <div className="grid gap-3 xl:grid-cols-2">
                  <CyclePivotsCard d={d} className="xl:h-0 xl:min-h-full" bodyClassName="min-h-0 overflow-y-auto" />
                  <ProjectionsCard d={d} />
                </div>
              </>
            )}
            <MethodNote text={d.method} />
          </div>
        )}
      </Q>
    </div>
  )
}
