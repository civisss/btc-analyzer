/* Scheda "Previsione a 1 giorno" della pagina Previsioni: prezzo reale vs previsto fuori campione, confronto onesto con il
 * naive "domani = oggi" e con la replica del metodo CryptoPredictions. Testi composti qui (codici dal backend). */
import { useState } from 'react'
import { Activity, BookOpenCheck, CalendarClock, Gauge, GitCompareArrows, LineChart, Scale, ShieldCheck, Sigma, Target as TargetIcon } from 'lucide-react'
import { ApiError } from '../api/client'
import { useLivePrice } from '../api/live'
import { useForecastOneDay, type ForecastOneDay, type OneDayMetrics, type OneDayPeriod, type VerdictCode } from '../api/forecastOneDay'
import { Badge, Card, CardBody, CardHeader, Change, ErrorState, Fill, KpiCell, KpiStrip, MethodNote, Segmented, Skeleton, Toggle, clsx } from '../components/ui'
import { BandBar, OneDayErrorChart, OneDayPriceChart, OneDayScatter, periodRange, type Target } from '../widgets/forecastOneDay'
import { t } from '../i18n'
import { date, dateTime, usd, usdCompact } from '../lib/format'

type Num = number | null | undefined
const fin = (v: Num): v is number => v != null && Number.isFinite(v)
const pc = (v: Num, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const x3 = (v: Num) => (fin(v) ? v.toFixed(3) : '—')
const x2 = (v: Num) => (fin(v) ? v.toFixed(2) : '—')
const pv = (v: Num) => (!fin(v) ? '—' : v < 0.001 ? '< 0.001' : v < 0.01 ? v.toFixed(3) : v.toFixed(2))
const k0 = (v: Num) => (fin(v) ? usdCompact(v, 1) : '—')

const PERIODS: { value: OneDayPeriod; label: string }[] = [
  { value: 'd90', label: '90 g' }, { value: 'y1', label: '1 anno' }, { value: 'all', label: 'Tutto' }, { value: 'repo', label: 'Periodo del repo' },
]
const PERIOD_LONG: Record<OneDayPeriod, string> = { d90: 'Ultimi 90 giorni', y1: 'Ultimo anno', all: 'Intero periodo fuori campione', repo: 'Periodo di validazione del repo' }

const VERDICT: Record<VerdictCode, { label: string; color: 'up' | 'down' | 'slate' | 'blue' }> = {
  edge: { label: 'Vantaggio significativo sul naive', color: 'up' },
  small_edge: { label: 'Vantaggio piccolo ma significativo', color: 'up' },
  no_edge: { label: 'Nessun vantaggio significativo sul naive', color: 'slate' },
  worse: { label: 'Peggiore del naive', color: 'down' },
  worse_ns: { label: 'Nessun vantaggio sul naive', color: 'slate' },
  baseline: { label: 'Riferimento', color: 'blue' },
  n_a: { label: 'Dati insufficienti', color: 'slate' },
}
/** MASE colour (naive = 1): clearly below = better, above = worse. */
const maseCls = (v: Num) => (!fin(v) ? 'text-slate-400' : v <= 0.97 ? 'text-up' : v >= 1.03 ? 'text-down' : 'text-white')

const VERDICT_SHORT: Record<VerdictCode, string> = {
  edge: 'Vantaggio', small_edge: 'Vantaggio piccolo', no_edge: 'Nessun vantaggio', worse: 'Peggiore', worse_ns: 'Nessun vantaggio',
  baseline: 'Riferimento', n_a: 'Dati insufficienti',
}
function VerdictBadge({ code, short }: { code: VerdictCode | undefined; short?: boolean }) {
  const v = VERDICT[code ?? 'n_a']
  return <Badge color={v.color} className="max-w-full truncate">{t(short ? VERDICT_SHORT[code ?? 'n_a'] : v.label)}</Badge>
}

function Cell({ k, v, sub, className }: { k: React.ReactNode; v: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0 px-3 py-2.5', className)}>
      <div className="label truncate">{k}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-white">{v}</div>
      <div className="tnum mt-0.5 truncate text-xs text-slate-400">{sub ?? <span className="text-slate-600">—</span>}</div>
    </div>
  )
}

/** Sentence on direction accuracy vs 50% and vs "always up", from the numbers. */
function directionText(m: OneDayMetrics): string {
  if (!fin(m.hit_rate)) return t('Direzione non disponibile.')
  const a = { h: m.hit_rate.toFixed(1), u: pc(m.always_up), p1: pv(m.p_dir), p2: pv(m.p_dir_vs_up) }
  if (m.verdict.direction_beats_always_up) return t('Direzione corretta nel {h}% dei giorni: meglio sia del 50% (p {p1}) sia di "sempre rialzo" ({u}, p {p2}).', a)
  if (m.verdict.direction_significant) return t('Direzione corretta nel {h}% dei giorni: sopra il 50% (p {p1}) ma non significativamente meglio di "sempre rialzo" ({u}, p {p2}).', a)
  return t('Direzione corretta nel {h}% dei giorni: non distinguibile dal caso (p {p1}); "sempre rialzo" avrebbe fatto {u}.', a)
}

// ------------------------------------------------------------------ previsione per domani
function TomorrowCard({ d }: { d: ForecastOneDay }) {
  const tm = d.tomorrow
  const wsLive = useLivePrice()
  const live = wsLive ?? tm.live_price
  const liveChg = fin(live) ? (live / tm.ref_price - 1) * 100 : null
  const where = !fin(live) ? null : live >= tm.p25 && live <= tm.p75 ? t('banda 50%') : live >= tm.p05 && live <= tm.p95 ? t('banda 90%') : t('fuori banda')
  const all = d.evaluation.all.close.model
  const sig = all.verdict.code === 'edge' || all.verdict.code === 'small_edge'
  return (
    <Card>
      <CardHeader title={t('Previsione per domani')} icon={<CalendarClock />}
        subtitle={t('Chiusura del {d} · 00:00 UTC del giorno dopo', { d: date(tm.target) })} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <div className="label">{t('Chiusura prevista (mediana)')}</div>
            <div className="tnum mt-1 text-3xl font-semibold tracking-[-0.02em] text-white">{usd(tm.median)}</div>
          </div>
          <div className="pb-1 text-right text-xs text-slate-400">
            <Change value={tm.change_pct} digits={2} /> <span className="ml-1">{t('vs {p}', { p: usd(tm.ref_price) })}</span>
          </div>
        </div>
        <BandBar p05={tm.p05} p25={tm.p25} p50={tm.median} p75={tm.p75} p95={tm.p95} refPrice={tm.ref_price} live={live} />
        <div className="dgrid -mx-1 grid-cols-2">
          <Cell k={t('Banda 50%')} v={`${k0(tm.p25)}–${k0(tm.p75)}`} sub={t('Metà dei casi')} />
          <Cell k={t('Banda 90%')} v={`${k0(tm.p05)}–${k0(tm.p95)}`} sub={t('9 casi su 10')} />
          <Cell k={t('Prob. rialzo')} v={pc(tm.up_prob, 0)} sub={t('Calibrata · grezza {p}', { p: pc(tm.up_prob_raw, 0) })} />
          <Cell k={t('Prezzo live')} v={fin(live) ? usd(live) : '—'} sub={fin(liveChg) ? <><Change value={liveChg} digits={2} /> · {where}</> : undefined} />
        </div>
        <p className="text-xs leading-relaxed text-slate-400">
          {sig ? t('Fuori campione il modello batte il naive in modo significativo, ma il margine resta piccolo: la miglior stima è vicina alla chiusura di ieri.')
            : t('Fuori campione il modello non batte il naive in modo significativo (MASE {m}, p {p}): la stima di domani è, in pratica, la chiusura di ieri con una banda di incertezza ben calibrata.', { m: x3(all.mase), p: pv(all.dm_p) })}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ verdetto per periodo
function VerdictCard({ d }: { d: ForecastOneDay }) {
  const rows: OneDayPeriod[] = ['all', 'y1', 'd90', 'repo']
  const all = d.evaluation.all.close.model
  return (
    <Card className="flex-1">
      <CardHeader title={t('Verdetto')} icon={<Scale />} subtitle={t('Chiusura · modello contro naive, calcolato dai dati')} />
      <CardBody className="flex flex-col gap-3">
        <div>
          <VerdictBadge code={all.verdict.code} />
          <p className="mt-2 text-sm leading-relaxed text-slate-300">{directionText(all)}</p>
        </div>
        <div className="flex flex-col">
          {rows.map((p) => {
            const m = d.evaluation[p].close.model
            return (
              <div key={p} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-200">{t(PERIOD_LONG[p])}</div>
                  <div className="tnum truncate text-2xs text-slate-500">{t('MASE {m} · p {p} · n {n}', { m: x3(m.mase), p: pv(m.dm_p), n: m.n })}</div>
                </div>
                <VerdictBadge code={m.verdict.code} short />
              </div>
            )
          })}
        </div>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ perché quel grafico sembra perfetto
function WhyCard({ d }: { d: ForecastOneDay }) {
  const r = d.evaluation.repo.mid
  const rep = r.replica, nai = r.naive
  const y1 = d.evaluation.y1.mid.replica
  const rows: { k: string; rep: string; nai: string; good?: 'rep' | 'nai' }[] = [
    { k: t('Correlazione dei prezzi'), rep: x3(rep.corr_price), nai: x3(nai.corr_price) },
    { k: t('Errore medio (MAPE)'), rep: pc(rep.mape, 2), nai: pc(nai.mape, 2), good: (rep.mape ?? 0) < (nai.mape ?? 0) ? 'rep' : 'nai' },
    { k: 'MASE', rep: x2(rep.mase), nai: '1.00', good: (rep.mase ?? 1) < 1 ? 'rep' : 'nai' },
    { k: t('Correlazione dei rendimenti'), rep: x2(rep.corr_ret), nai: '—' },
    { k: t('Direzione corretta'), rep: pc(rep.hit_rate), nai: '—' },
  ]
  return (
    <Card className="xl:col-span-5">
      <CardHeader title={t('Perché quel grafico sembra perfetto')} icon={<BookOpenCheck />}
        subtitle={t('Replica del metodo CryptoPredictions sul periodo del repo ({a} – {b})', { a: date(d.periods.repo.from), b: date(d.periods.repo.to) })} />
      <CardBody className="flex flex-col gap-3">
        <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
          <table className="tbl min-w-[320px]">
            <thead><tr><th className="pl-4 sm:pl-5">{t('Prezzo medio di domani')}</th><th className="text-right">{t('Replica')}</th><th className="pr-4 text-right sm:pr-5">{t('Naive')}</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.k}>
                  <td className="pl-4 text-slate-300 sm:pl-5">{x.k}</td>
                  <td className={clsx('text-right font-medium', x.good === 'rep' ? 'text-up' : x.good === 'nai' ? 'text-down' : 'text-white')}>{x.rep}</td>
                  <td className={clsx('pr-4 text-right sm:pr-5', x.good === 'nai' ? 'font-medium text-up' : 'text-slate-300')}>{x.nai}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="flex flex-col gap-2 text-sm leading-relaxed text-slate-300">
          <li className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />{t('A un giorno ogni previsione parte dal prezzo di ieri: la curva prevista ricalca quella reale con un giorno di ritardo. Anche il naive "domani = oggi" ha correlazione {c}.', { c: x3(nai.corr_price) })}</li>
          <li className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />{t('Conta la correlazione dei rendimenti (quanto il modello anticipa la variazione): qui è {c}. Il secondo grafico mostra la variazione prevista contro quella reale.', { c: x2(rep.corr_ret) })}</li>
          <li className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />{t('Un target in livello non supera i prezzi visti in addestramento (massimo {m}): dopo il periodo del repo la replica resta piatta mentre il prezzo sale (MAPE ultimo anno {e}).', { m: k0(d.replica.train_max_price), e: pc(y1.mape) })}</li>
        </ul>
        <p className="text-2xs text-slate-500">
          {t('Esempio citato:')} <a className="text-slate-300 underline decoration-white/20 underline-offset-2 hover:text-white" href={d.replica.url} target="_blank" rel="noreferrer">CryptoPredictions (GitHub)</a>
          {' · '}{t('Reimplementazione indipendente con dati Binance: i numeri possono differire leggermente da quelli del repo.')}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ tabella metriche
const CLOSE_ROWS = [
  { key: 'model', name: 'Modello LightGBM (chiusura)' }, { key: 'naive', name: 'Naive: domani = oggi', base: true }, { key: 'drift', name: 'Deriva media storica', base: true },
] as const
const MID_ROWS = [
  { key: 'model', name: 'Modello LightGBM (prezzo medio)' }, { key: 'naive', name: 'Naive: medio di domani = medio di oggi', base: true },
  { key: 'naive_close', name: 'Naive: medio di domani = chiusura di oggi', base: true }, { key: 'replica', name: 'Replica CryptoPredictions (Random Forest)' },
] as const

function MetricsTable({ d, period }: { d: ForecastOneDay; period: OneDayPeriod }) {
  const e = d.evaluation[period]
  const groups = [
    { title: t('Target: chiusura di domani'), rows: CLOSE_ROWS.map((r) => ({ ...r, m: e.close[r.key] })) },
    { title: t('Target: prezzo medio (H+L)/2 di domani'), rows: MID_ROWS.map((r) => ({ ...r, m: e.mid[r.key] })) },
  ]
  // below 1700px four secondary columns (p, always up, price corr., DM p) are hidden so the verdict stays visible
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[860px] min-[1700px]:min-w-[1180px]">
        <thead><tr>
          <th className="pl-4 sm:pl-5">{t('Modello')}</th><th className="text-right">n</th><th className="text-right">MAPE</th>
          <th className="text-right" title={t('Errore medio diviso quello del naive sugli stessi giorni: sotto 1 batte il naive')}>MASE</th>
          <th className="text-right" title={t('Solo prezzo medio: MASE rispetto al naive "chiusura di oggi"')}>{t('vs chiusura')}</th>
          <th className="text-right">{t('Direzione')}</th><th className="text-right max-[1699px]:hidden">{t('p (vs 50%)')}</th><th className="text-right max-[1699px]:hidden">{t('Sempre rialzo')}</th>
          <th className="text-right">{t('Corr. rendimenti')}</th><th className="text-right max-[1699px]:hidden">{t('Corr. prezzi')}</th>
          <th className="text-right">{t('Copertura 50/90%')}</th><th className="text-right max-[1699px]:hidden" title={t('Diebold-Mariano sull\'errore assoluto, contro il naive')}>{t('DM p')}</th>
          <th className="pr-4 sm:pr-5">{t('Verdetto')}</th>
        </tr></thead>
        <tbody>
          {groups.map((g) => [
            <tr key={g.title}><td colSpan={13} className="pl-4 pt-3 sm:pl-5"><span className="label">{g.title}</span></td></tr>,
            ...g.rows.map((r) => {
              const m = r.m
              const isModel = r.key === 'model'
              return (
                <tr key={`${g.title}-${r.key}`} className={clsx(isModel && '[&>td]:bg-white/[0.035]')}>
                  <td className="pl-4 sm:pl-5">
                    <span className={clsx(isModel ? 'font-semibold text-white' : 'text-slate-200')}>{t(r.name)}</span>
                    {'base' in r && r.base && <span className="ml-1.5 text-2xs text-slate-500">{t('baseline')}</span>}
                  </td>
                  <td className="text-right text-slate-400">{m?.n ?? '—'}</td>
                  <td className="text-right text-slate-300">{pc(m?.mape, 2)}</td>
                  <td className={clsx('text-right text-base font-semibold', maseCls(m?.mase))}>{x3(m?.mase)}</td>
                  <td className={clsx('text-right', maseCls(m?.mase_vs_close))}>{x3(m?.mase_vs_close)}</td>
                  <td className="text-right font-semibold text-white">{pc(m?.hit_rate)}</td>
                  <td className={clsx('text-right max-[1699px]:hidden', fin(m?.p_dir) && m!.p_dir! < 0.05 ? 'text-slate-100' : 'text-slate-400')}>{pv(m?.p_dir)}</td>
                  <td className="text-right text-slate-400 max-[1699px]:hidden">{pc(m?.always_up)}</td>
                  <td className="text-right text-slate-200">{x2(m?.corr_ret)}</td>
                  <td className="text-right text-slate-400 max-[1699px]:hidden">{x3(m?.corr_price)}</td>
                  <td className="text-right text-slate-300">{fin(m?.coverage_90) ? `${pc(m?.coverage_50, 0)} / ${pc(m?.coverage_90, 0)}` : '—'}</td>
                  <td className="text-right text-slate-300 max-[1699px]:hidden">{pv(m?.dm_p)}</td>
                  <td className="pr-4 sm:pr-5"><VerdictBadge code={m?.verdict?.code} /></td>
                </tr>
              )
            }),
          ])}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ corpo
function Body({ d, updatedAt }: { d: ForecastOneDay; updatedAt: number }) {
  const [period, setPeriod] = useState<OneDayPeriod>('y1')
  const [target, setTarget] = useState<Target>('close')
  const [band, setBand] = useState(true)
  const [naive, setNaive] = useState(true)
  const [replica, setReplica] = useState(false)
  const [view, setView] = useState<'error' | 'scatter'>('scatter')
  const [tblPeriod, setTblPeriod] = useState<OneDayPeriod>('all')
  const toggleReplica = () => { const on = !replica; setReplica(on); if (on) setTarget('mid') }
  const changeTarget = (v: Target) => { setTarget(v); if (v === 'close') setReplica(false) }
  const all = d.evaluation.all.close
  const sel = target === 'close' ? d.evaluation[period].close.model : d.evaluation[period].mid.model
  const selNaive = target === 'close' ? d.evaluation[period].close.naive : d.evaluation[period].mid.naive
  const selRep = d.evaluation[period].mid.replica
  const [a, b] = periodRange(d, period)
  const periodOpts = PERIODS.map((p) => ({ value: p.value, label: t(p.label) }))
  const tm = d.tomorrow
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip cols="grid-cols-2 md:grid-cols-3 min-[1700px]:grid-cols-6">
        <KpiCell accent icon={<CalendarClock />} label={t('Prossima chiusura')} value={usd(tm.median)} delta={<Change value={tm.change_pct} digits={2} />} foot={date(tm.target)} />
        <KpiCell icon={<Gauge />} label={t('Prob. rialzo')} value={pc(tm.up_prob, 0)} foot={t('Rialzi storici {p}', { p: pc(all.model.always_up, 0) })} />
        <KpiCell icon={<Scale />} label={t('MASE vs naive')} value={x3(all.model.mase)} foot={t('Naive = 1 · DM p {p}', { p: pv(all.model.dm_p) })} />
        <KpiCell icon={<TargetIcon />} label={t('Direzione corretta')} value={pc(all.model.hit_rate)} foot={t('Sempre rialzo {u}', { u: pc(all.model.always_up) })} title={t('p vs sempre rialzo {p}', { p: pv(all.model.p_dir_vs_up) })} />
        <KpiCell icon={<Activity />} label={t('Corr. rendimenti')} value={x2(all.model.corr_ret)} foot={t('Corr. prezzi {c}', { c: x3(all.model.corr_price) })} />
        <KpiCell icon={<ShieldCheck />} label={t('Copertura 90%')} value={pc(all.model.coverage_90)} foot={t('Banda 50%: {c}', { c: pc(all.model.coverage_50) })} />
      </KpiStrip>

      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-8 2xl:col-span-9">
          <CardHeader title={t('Prezzo reale vs previsto')} icon={<LineChart />} updatedAt={updatedAt}
            subtitle={t('Fuori campione, un giorno avanti · {p}', { p: t(PERIOD_LONG[period]).toLowerCase() })}
            right={<>
              <Segmented value={target} onChange={changeTarget} options={[{ value: 'close', label: t('Chiusura') }, { value: 'mid', label: t('Prezzo medio') }]} />
              <Segmented value={period} onChange={setPeriod} options={periodOpts} />
            </>} />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {target === 'close' && <Toggle on={band} onClick={() => setBand(!band)}>{t('Banda 90%')}</Toggle>}
              <Toggle on={naive} onClick={() => setNaive(!naive)}>{t('Naive')}</Toggle>
              <Toggle on={replica} onClick={toggleReplica}>{t('Replica CryptoPredictions')}</Toggle>
              <span className="ml-auto hidden text-2xs text-slate-500 md:inline">{t('Trascina per scorrere · Maiusc + rotella per lo zoom')}</span>
            </div>
            <Fill min={400}><OneDayPriceChart d={d} target={target} period={period} band={band} naive={naive} replica={replica} /></Fill>
            <div className="dgrid -mx-1 grid-cols-2 md:grid-cols-4">
              <Cell k={t('MAPE modello')} v={pc(sel.mape, 2)} sub={t('Naive {v}', { v: pc(selNaive.mape, 2) })} />
              <Cell k={t('MASE')} v={<span className={maseCls(target === 'mid' ? sel.mase_vs_close : sel.mase)}>{x3(target === 'mid' ? sel.mase_vs_close : sel.mase)}</span>}
                sub={target === 'mid' ? t('vs chiusura di oggi') : t('Naive = 1')} />
              <Cell k={t('Direzione')} v={pc(sel.hit_rate)} sub={t('p {p} · {n} giorni', { p: pv(sel.p_dir), n: sel.n_dir ?? b - a })} />
              {replica && target === 'mid'
                ? <Cell k={t('MAPE replica')} v={pc(selRep.mape, 2)} sub={t('MASE {m}', { m: x2(selRep.mase) })} />
                : <Cell k={t('Corr. rendimenti')} v={x2(sel.corr_ret)} sub={t('Prezzi {c}', { c: x3(sel.corr_price) })} />}
            </div>
          </CardBody>
        </Card>
        <div className="flex flex-col gap-3 xl:col-span-4 2xl:col-span-3">
          <TomorrowCard d={d} />
          <VerdictCard d={d} />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-7">
          <CardHeader title={view === 'scatter' ? t('Variazione prevista vs reale') : t('Errore giornaliero contro il naive')} icon={<GitCompareArrows />}
            subtitle={view === 'scatter' ? t('Ogni punto è un giorno · stessa scala sui due assi: la verità che il grafico dei prezzi nasconde')
              : t('Barre: errore del modello meno errore del naive (verde = meglio) · linea: vantaggio cumulato')}
            right={<Segmented value={view} onChange={setView} options={[{ value: 'scatter', label: t('Rendimenti') }, { value: 'error', label: t('Errore') }]} />} />
          <CardBody className="flex flex-col gap-3">
            <Fill min={340}>{view === 'scatter'
              ? <OneDayScatter d={d} target={target} period={period} replica={replica} />
              : <OneDayErrorChart d={d} target={target} period={period} replica={replica} />}</Fill>
            <p className="text-xs leading-relaxed text-slate-400">
              {view === 'scatter' && target === 'mid'
                ? t('Con il prezzo medio una parte della variazione è già nota oggi (la distanza tra chiusura e medio di oggi): i punti si inclinano, ma la stessa inclinazione la ottiene il naive "chiusura di oggi". Correlazione dei rendimenti {c}.', { c: x2((replica ? selRep : sel).corr_ret) })
                : view === 'scatter'
                ? t('Se il modello prevedesse davvero, i punti seguirebbero la diagonale. A un giorno restano una nuvola verticale: la variazione prevista è minima rispetto a quella reale. Correlazione dei rendimenti {c}.', { c: x2((replica && target === 'mid' ? selRep : sel).corr_ret) })
                : t('Somma nel tempo di quanto il modello sbaglia meno (sopra lo zero) o più (sotto) del naive, in punti percentuali. Una linea piatta vuol dire nessun vantaggio.')}
            </p>
          </CardBody>
        </Card>
        <WhyCard d={d} />
      </div>

      <Card>
        <CardHeader title={t('Metriche fuori campione')} icon={<Sigma />}
          subtitle={t('{p} · {a} – {b}', { p: t(PERIOD_LONG[tblPeriod]), a: date(d.evaluation[tblPeriod].from), b: date(d.evaluation[tblPeriod].to) })}
          right={<Segmented value={tblPeriod} onChange={setTblPeriod} options={periodOpts} />} />
        <CardBody className="flex flex-col gap-3 pt-0">
          <MetricsTable d={d} period={tblPeriod} />
          <p className="text-xs leading-relaxed text-slate-400">
            {t('MASE = errore assoluto medio (in %) diviso quello del naive sugli stessi giorni: 1 = come il naive, sotto 1 meglio. Direzione: giorni con variazione prevista sotto lo {e}% esclusi; p = test binomiale. DM = Diebold-Mariano sull\'errore assoluto. Per il prezzo medio il termine di paragone più severo è la chiusura di oggi.', { e: d.settings.dir_eps_pct.toFixed(2) })}
          </p>
        </CardBody>
      </Card>

      <p className="text-xs text-slate-400">{t('Stime statistiche su dati storici. Non è consulenza finanziaria.')}</p>
      <MethodNote>
        <p>{t('Target: rendimento logaritmico dalla chiusura di oggi a quella di domani (UTC); in parallelo il prezzo medio (massimo + minimo)/2 di domani rispetto alla chiusura di oggi. Prezzo previsto = prezzo di oggi × e^(rendimento previsto). Si usano solo candele giornaliere chiuse.')}</p>
        <p>{t('Modello: LightGBM a quantili (5, 25, 50, 75, 95%) su {n} variabili point-in-time (prezzo, volatilità, ciclo, on-chain, derivati, stablecoin, macro, sentiment, indicatori tecnici) con i ritardi di pubblicazione delle fonti; target normalizzato per la volatilità.', { n: d.settings.n_features })}</p>
        <p>{t('Walk-forward a finestra espandente con riaddestramento mensile ({r} modelli): le previsioni di ogni mese usano solo righe il cui target era già realizzato all\'origine. Previsioni fuori campione dal {d}; la previsione di domani usa il modello del mese in corso.', { r: d.n_refits, d: date(d.settings.oos_start) })}</p>
        <p>{t('Bande 50% e 90% calibrate con conformal (CQR relativo) sugli errori realizzati degli ultimi {w} giorni; probabilità di rialzo calibrata con Platt sulle sole previsioni passate (finestra {p} giorni).', { w: d.settings.conformal_window, p: d.settings.platt_window })}</p>
        <p>{d.leakage.passed
          ? t('Controllo di leakage superato: {v} violazioni su {n} previsioni (ogni modello addestrato su target realizzati entro l\'origine, distacco {a}–{b} giorni); feature ricostruite con tutte le sorgenti troncate al giorno di previsione identiche a quelle dello storico completo ({k} date controllate, {c} variabili ciascuna).', { v: d.leakage.structural_violations, n: d.leakage.rows, a: d.leakage.min_gap_days, b: d.leakage.max_gap_days, k: d.leakage.point_in_time.dates.length, c: d.leakage.point_in_time.dates[0]?.compared ?? '—' })
          : t('Attenzione: il controllo di leakage ha segnalato un problema ({v} violazioni strutturali).', { v: d.leakage.structural_violations })}</p>
        <p>{t('Replica CryptoPredictions (solo dimostrativa): finestra di {w} giorni del loro config (4 giorni di input, il quinto è il target), per giorno apertura, massimo, minimo, chiusura, volume, RSI 14 e MACD 12/26 sul prezzo medio e prezzo medio; target = prezzo medio di domani in livello; Random Forest scikit-learn con {t} alberi; addestramento {a} – {b} ({n} righe), validazione {c} – {e}. Reimplementata con dati Binance, senza usare il loro codice; dopo la validazione il modello congelato continua solo per mostrare il limite del target in livello.', { w: d.replica.window_size, t: d.replica.n_estimators, a: date(d.replica.train_from), b: date(d.replica.train_to), n: d.replica.train_rows, c: date(d.replica.valid_from), e: date(d.replica.valid_to) })}</p>
        <p>{t('Limiti: a un giorno il rumore domina e i vantaggi plausibili sono di pochi centesimi di punto; i risultati dipendono dal periodo; le previsioni fino al primo aggiornamento sono un backtest (rigorosamente fuori campione), quelle successive sono registrate in tempo reale{l}.', { l: d.live_from ? t(' dal {d}', { d: date(d.live_from) }) : '' })}</p>
        <p>{t('Calcolo: una volta al giorno dopo la chiusura UTC della candela giornaliera; ultimo aggiornamento {d}, dati fino al {g}.', { d: dateTime(d.training.trained_at), g: d.data_day })}</p>
      </MethodNote>
    </div>
  )
}

function Pending({ q }: { q: ReturnType<typeof useForecastOneDay> }) {
  const busy = q.error instanceof ApiError && q.error.status === 503
  return (
    <div className="grid gap-3">
      {busy && <p className="text-sm text-slate-400">{t('Primo calcolo del walk-forward in corso (circa un minuto)…')}</p>}
      <Skeleton className="h-24" /><Skeleton className="h-[520px]" /><Skeleton className="h-72" />
    </div>
  )
}

export default function ForecastOneDayTab() {
  const q = useForecastOneDay()
  if (q.data) return <Body d={q.data} updatedAt={q.dataUpdatedAt} />
  if (q.isPending || (q.error instanceof ApiError && q.error.status === 503)) return <Pending q={q} />
  return <ErrorState error={q.error} onRetry={() => q.refetch()} />
}
