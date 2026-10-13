import { useMemo, useState } from 'react'
import { Crosshair, Gauge, History, Hourglass, ListChecks, Ruler, Scale, ShieldCheck, Target, Weight } from 'lucide-react'
import { useTracking, type TrackMode, type Tracking } from '../api/tracking'
import { Badge, Card, CardBody, CardHeader, KpiCell, KpiStrip, MethodNote, PageTitle, Q, Segmented, Skeleton, clsx } from '../components/ui'
import { PredictionList, ReliabilityMulti, SourceTable, WeightsList } from '../widgets/tracking'
import { pct } from '../lib/format'
import { t, tr } from '../i18n'

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
const pctU = (v: Num, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const AGENT_LABEL: Record<string, string> = {
  forecast: 'Previsioni ML', patterns: 'Frattali & Pattern', analogs: 'Analoghi grafici', timepivots: 'Pivot temporali',
  cycles: 'Cicli', flows: 'Flussi Spot/Futures', analyst: 'Analista AI',
}

function Kpis({ d }: { d: Tracking }) {
  const o = d.overall
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
      <KpiCell icon={<Target />} label={t('Direzione corretta')} value={pctU(o.hit_rate)}
        foot={t('{n} previsioni direzionali · 50% = moneta', { n: o.n_dir.toLocaleString('en-US') })} />
      <KpiCell icon={<Gauge />} label="Brier score" value={fin(o.brier) ? o.brier.toFixed(3) : '—'}
        delta={fin(o.brier_skill) ? <span className={o.brier_skill >= 0 ? 'text-up' : 'text-down'}>{pct(o.brier_skill, 0)} <span className="text-slate-400">{t('vs frequenza di base')}</span></span> : undefined} />
      <KpiCell icon={<Scale />} label={t('Calibrazione (ECE)')} value={fin(o.ece) ? <>{o.ece.toFixed(1)}<span className="ml-1 text-sm font-normal text-slate-400">pt</span></> : '—'}
        foot={t('Scarto medio probabilità ↔ esiti')} />
      <KpiCell icon={<Ruler />} label={t('Errore della mediana')} value={pctU(o.mae_pct)} foot={t('MAE % sul prezzo a scadenza')} />
      <KpiCell icon={<ShieldCheck />} label={t('Copertura bande')} value={pctU(o.coverage, 0)} foot={t('Esiti dentro la banda prevista')} />
      <KpiCell icon={<ListChecks />} label={t('Previsioni verificate')} value={o.n_resolved.toLocaleString('en-US')}
        foot={t('Live {a} · In attesa: {b} · Backtest {c}', { a: d.split.live.n_resolved, b: d.split.live.n_pending, c: d.split.backtest.n_resolved.toLocaleString('en-US') })} />
    </KpiStrip>
  )
}

function Body({ d, updatedAt }: { d: Tracking; updatedAt: number }) {
  const withProb = d.sources.filter((s) => (d.reliability.by_source[`${s.source}|${s.mode}`] ?? []).length > 0)
  const [sel, setSel] = useState<string>('all')
  const multiples = useMemo(() => withProb.map((s) => {
    const k = `${s.source}|${s.mode}`
    return { key: k, name: `${s.label} · ${s.mode === 'live' ? 'Live' : 'BT'}`, sub: fin(s.ece) ? t('ECE {v} pt · n={n}', { v: s.ece.toFixed(1), n: s.n_resolved.toLocaleString('en-US') }) : `n=${s.n_resolved}`, buckets: d.reliability.by_source[k] ?? [] }
  }), [withProb, d])
  const agentLabels = { ...Object.fromEntries(Object.entries(AGENT_LABEL).map(([k, v]) => [k, t(v)])), ...Object.fromEntries(d.sources.map((s) => [s.agent, s.agent_label])) }
  const running = d.backfill.status === 'running'
  return (
    <div className="flex flex-col gap-3">
      <Kpis d={d} />
      {/* ≥1800px: source table + weights side by side; below, the weights become a full-width strip (2–4 columns) */}
      <div className="grid gap-3 min-[1800px]:grid-cols-3">
        <Card className="min-[1800px]:col-span-2">
          <CardHeader icon={<Crosshair />} title={t('Affidabilità per fonte')} subtitle={t('Seleziona una riga per vederne la calibrazione')} updatedAt={updatedAt}
            info={t("Live = previsioni registrate dall'app al momento dell'emissione. Backtest = ricostruite su date passate senza usare dati futuri. Hit rate verde sopra il 55%, rosso sotto il 45% (con almeno 20 casi).")}
            right={running ? <Badge>{t('Backtest in calcolo')}{d.backfill.progress ? ` (${d.backfill.progress})` : ''}…</Badge> : undefined} />
          <CardBody><SourceTable sources={d.sources} selected={sel} onSelect={(k) => setSel(sel === k ? 'all' : k)} /></CardBody>
        </Card>
        <Card>
          <CardHeader icon={<Weight />} title={t("Pesi per l'Analista")} subtitle={t('0.50 = neutro · più previsioni, più il peso si allontana')}
            info={t('Peso = 0.5 + skill (hit rate e Brier, live pesato 2× rispetto al backtest), ridotto verso 0.5 quando le previsioni verificate sono poche: w = 0.5 + (raw − 0.5)·n/(n+50).')} />
          <CardBody><WeightsList weights={d.weights} labels={agentLabels} className="sm:grid-cols-2 lg:grid-cols-4 min-[1800px]:grid-cols-2" /></CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader icon={<Scale />} title={t('Calibrazione delle probabilità')} subtitle={t('Probabilità di rialzo dichiarata vs rialzi osservati · diagonale = perfetto')}
          info={t('Un pannello per fonte (blu) con tutte le fonti in grigio. Le previsioni sono raggruppate in fasce di 10 punti di probabilità; la dimensione del punto è proporzionale al numero di casi. Sopra la diagonale la fonte è troppo pessimista, sotto troppo ottimista.')} />
        <CardBody className="flex flex-col">
          <ReliabilityMulti wide items={multiples} overall={d.reliability.overall} selected={sel} onSelect={(k) => setSel(sel === k ? 'all' : k)} />
        </CardBody>
      </Card>
      {/* the pending list sets the row height when it has enough rows; the long verified list then scrolls inside its card */}
      <div className="grid gap-3 min-[2200px]:grid-cols-2">
        <Card className={clsx(d.pending.length >= 8 && 'min-[2200px]:h-0 min-[2200px]:min-h-full')}>
          <CardHeader icon={<History />} title={t('Previsioni verificate di recente')} subtitle={t('Live prima, poi le ultime del backtest')} />
          <CardBody className="min-h-0 overflow-y-auto"><PredictionList items={d.recent} empty={t('Nessuna previsione ancora verificata')} /></CardBody>
        </Card>
        <Card>
          <CardHeader icon={<Hourglass />} title={t('In attesa di verifica')} subtitle={t('Previsioni live non ancora scadute')} />
          <CardBody><PredictionList items={d.pending} empty={t('Nessuna previsione live in attesa')} /></CardBody>
        </Card>
      </div>
      <MethodNote><p>{d.method}</p></MethodNote>
    </div>
  )
}

export default function TrackRecordPage() {
  const [mode, setMode] = useState<TrackMode>('backtest')
  const q = useTracking(mode)
  return (
    <div>
      <PageTitle title={t('Affidabilità')} subtitle={t('Quanto hanno avuto ragione agenti e modelli: ogni previsione è registrata e verificata sul prezzo reale alla scadenza.')}
        right={<Segmented size="md" options={[{ value: 'all', label: tr('Tutto', 'All') }, { value: 'live', label: 'Live' }, { value: 'backtest', label: 'Backtest' }]} value={mode} onChange={setMode} />} />
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[360px]" /><Skeleton className="h-[360px]" /></div>}>
        {(d) => <Body d={d} updatedAt={q.dataUpdatedAt} />}
      </Q>
    </div>
  )
}
