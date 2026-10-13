import { useEffect, useState, type ReactNode } from 'react'
import { Blocks, LineChart, Thermometer } from 'lucide-react'
import { cap, t } from '../i18n'
import { useOnChain } from '../api/client'
import type { OnChainMetric } from '../api/types'
import Sparkline from '../components/charts/Sparkline'
import { C } from '../components/charts/theme'
import { Card, CardBody, CardHeader, Change, Fill, PageTitle, ProgressBar, Q, Skeleton, Toggle, clsx } from '../components/ui'
import { TimeLinesChart } from '../widgets/charts'
import { compact, date, dayUnit, daysUntil, int, usdCompact, pct } from '../lib/format'

// ------------------------------------------------------------------ copy & formatting (front-end only, never truncated)
// Italian source strings: translated at the use site with t().
const LABEL: Record<string, string> = {
  nupl: 'NUPL',
  issuance_usd: 'Emissione giornaliera',
  tx_count: 'Transazioni giornaliere',
  mvrv_z: 'MVRV Z-Score',
}
const INFO: Record<string, string> = {
  mvrv: 'Market value / realized value: capitalizzazione divisa per il valore al quale ogni moneta si è mossa l’ultima volta. Sopra 3.5 storicamente zona di euforia, sotto 1 zona di capitolazione.',
  mvrv_z: 'Distanza tra capitalizzazione e valore realizzato in deviazioni standard. Sopra 6 storicamente top di ciclo, sotto 0 bottom.',
  realized_price: 'Costo medio a cui sono state acquistate le monete in circolazione (valore realizzato / offerta).',
  hashrate: 'Potenza di calcolo totale della rete: misura la sicurezza e l’impegno dei miner.',
  active_addresses: 'Indirizzi unici attivi in un giorno (mittenti o destinatari).',
  tx_count: 'Numero di transazioni on-chain confermate ogni giorno.',
  supply: 'BTC emessi finora, sui 21 milioni massimi.',
  issuance_usd: 'Valore in dollari dei BTC nuovi emessi ai miner ogni giorno.',
  puell: 'Emissione giornaliera in USD divisa per la sua media annua. Sopra 3 miner in forte profitto, sotto 0.5 miner sotto pressione.',
  nupl: 'Net Unrealized Profit/Loss: quota della capitalizzazione in profitto (o perdita) non realizzato. Sopra 0.75 euforia, sotto 0 capitolazione.',
}
/** status copy: short, with "vs media 1a"; Unicode minus */
const STATUS: Record<string, string> = {
  'Valutazione equa': 'Neutrale',
  'Valutazione bassa / neutrale': 'Neutrale',
  'Ottimismo / Ansia': 'Ottimismo',
  'Rete in crescita e sicura': 'Hashrate in crescita',
}
function shortStatus(s: string): string {
  if (STATUS[s]) return t(STATUS[s])
  const m = s.match(/([+\-−]\d+(?:\.\d+)?%) vs media annua/)
  if (m) return t('{v} vs media 1a', { v: m[1].replace('-', '−') })
  const c = s.match(/^Prezzo (sopra|sotto) il costo medio \((.+)\)$/)
  if (c) return t('{v} sul costo medio', { v: c[2].replace('-', '−') })
  return cap(s)
}
function display(m: OnChainMetric): string {
  const v = m.value
  if (!Number.isFinite(v)) return m.display
  switch (m.key) {
    case 'realized_price': return usdCompact(v, 1)
    case 'hashrate': return v >= 1000 ? `${(v / 1000).toFixed(2)}K EH/s` : `${v.toFixed(0)} EH/s`
    case 'active_addresses':
    case 'tx_count': return compact(v)
    case 'supply': return `${(v / 1e6).toFixed(2)}M BTC`
    case 'issuance_usd': return usdCompact(v, 1)
    case 'nupl': return v.toFixed(2)
    default: return m.display
  }
}
/** extreme readings are the only ones worth colouring (amber = attention) */
function isExtreme(m: OnChainMetric): boolean {
  const v = m.value
  switch (m.key) {
    case 'mvrv': return v > 3.5 || v < 1
    case 'mvrv_z': return v > 6 || v < 0
    case 'nupl': return v > 0.75 || v < 0
    case 'puell': return v > 3 || v < 0.5
    default: return false
  }
}

/** Historical valuation zones (front-end thresholds, same as the INFO copy). */
const ZONES: Record<string, { min: number; max: number; lo: number; hi: number; loLabel: string; hiLabel: string; fmt: (v: number) => string }> = {
  mvrv: { min: 0, max: 4.5, lo: 1, hi: 3.5, loLabel: 'Capitolazione', hiLabel: 'Euforia', fmt: (v) => v.toFixed(2) },
  mvrv_z: { min: -1, max: 8, lo: 0, hi: 6, loLabel: 'Bottom di ciclo', hiLabel: 'Top di ciclo', fmt: (v) => v.toFixed(2) },
  nupl: { min: -0.5, max: 1, lo: 0, hi: 0.75, loLabel: 'Capitolazione', hiLabel: 'Euforia', fmt: (v) => v.toFixed(2) },
  puell: { min: 0, max: 4, lo: 0.5, hi: 3, loLabel: 'Stress miner', hiLabel: 'Miner in profitto', fmt: (v) => v.toFixed(2) },
}
function zoneOf(key: string, v: number): string {
  const z = ZONES[key]
  if (!z) return ''
  return v < z.lo ? z.loLabel : v > z.hi ? z.hiLabel : 'Zona neutrale'
}

function ZonesCard({ metrics, active, onSelect }: { metrics: OnChainMetric[]; active: string; onSelect: (k: string) => void }) {
  const rows = metrics.filter((m) => ZONES[m.key] && Number.isFinite(m.value))
  if (!rows.length) return null
  return (
    <Card>
      <CardHeader title={t('Zone di valutazione')} subtitle={t('Clicca una metrica per il grafico')} icon={<Thermometer />}
        info={t('Soglie storiche: sotto la soglia bassa i bottom di ciclo, sopra la soglia alta i top. Il marcatore indica il valore attuale.')} />
      <CardBody className="flex flex-col pt-0">
        {rows.map((m) => {
          const z = ZONES[m.key]
          const pos = (v: number) => Math.max(0, Math.min(100, ((v - z.min) / (z.max - z.min)) * 100))
          const on = m.key === active
          return (
            <button key={m.key} onClick={() => onSelect(m.key)} aria-pressed={on}
              className={clsx('-mx-2 flex min-w-0 flex-col gap-1.5 rounded-lg border-t border-line px-2 py-2.5 text-left transition-colors first:border-t-0 hover:bg-white/[0.03]', on && 'bg-white/[0.04]')}>
              <span className="flex items-baseline justify-between gap-2 text-sm">
                <span className={clsx('min-w-0 truncate', on ? 'text-white' : 'text-slate-300')}>{LABEL[m.key] ? t(LABEL[m.key]) : m.label}</span>
                <span className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
                  <span className="text-2xs text-slate-400">{t(zoneOf(m.key, m.value))}</span>
                  <span className="tnum font-medium text-white">{z.fmt(m.value)}</span>
                </span>
              </span>
              <span className="relative block h-1.5 w-full rounded-full bg-white/[0.06]">
                <span className="absolute inset-y-0 rounded-full bg-white/[0.10]" style={{ left: `${pos(z.lo)}%`, width: `${pos(z.hi) - pos(z.lo)}%` }} />
                <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-white" style={{ left: `${pos(m.value)}%` }} />
              </span>
              {/* thresholds only (the current zone sits next to the value): fits the narrow 1440 column without overflowing */}
              <span className="tnum flex min-w-0 justify-between gap-2 whitespace-nowrap text-2xs text-slate-400">
                <span className="min-w-0 truncate">{t('{l} < {v}', { l: t(z.loLabel), v: z.fmt(z.lo) })}</span>
                <span className="min-w-0 truncate text-right">{t('{l} > {v}', { l: t(z.hiLabel), v: z.fmt(z.hi) })}</span>
              </span>
            </button>
          )
        })}
      </CardBody>
    </Card>
  )
}

function MetricCell({ m, active, onClick }: { m: OnChainMetric; active: boolean; onClick: () => void }) {
  const label = LABEL[m.key] ? t(LABEL[m.key]) : m.label
  const status = shortStatus(m.status)
  return (
    <div className={clsx('relative min-w-0', active ? 'bg-raised' : 'bg-surface')}>
      {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-accent-blue" />}
      <button onClick={onClick} aria-pressed={active} title={INFO[m.key] ? `${m.label}: ${t(INFO[m.key])}` : m.label}
        className="flex h-full w-full min-w-0 flex-col px-4 py-3 text-left transition-colors hover:bg-white/[0.02]">
        <span className={clsx('label', active && 'text-slate-200')}>{label}</span>
        <span className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="tnum whitespace-nowrap text-xl font-semibold text-white">{display(m)}</span>
          <Change value={m.change_30d} digits={1} suffix={`30${dayUnit()}`} className="text-xs" />
        </span>
        <span className={clsx('mt-0.5 text-xs', isExtreme(m) ? 'text-amber-400' : 'text-slate-400')}>{status}</span>
        <span className="mt-2 block h-8"><Sparkline data={m.spark} height={32} /></span>
      </button>
    </div>
  )
}

function Row({ k, children, foot }: { k: string; children: ReactNode; foot?: string }) {
  return (
    <div className="border-t border-line py-2 first:border-t-0 first:pt-0">
      <div className="flex min-h-6 items-center justify-between gap-3 text-sm">
        <span className="min-w-0 text-slate-400">{k}</span>
        <span className="tnum whitespace-nowrap font-medium text-white">{children}</span>
      </div>
      {foot && <div className="text-right text-2xs text-slate-400">{foot}</div>}
    </div>
  )
}

function useTick() {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), 60000)
    return () => clearInterval(id)
  }, [])
}

export default function OnChainPage() {
  const q = useOnChain()
  const [sel, setSel] = useState<string | null>(null)
  const [log, setLog] = useState(true)
  useTick()
  return (
    <div>
      <PageTitle title={t('On-Chain')} subtitle={t('Metriche della blockchain: valutazione, attività di rete e sicurezza.')} />
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-64" /><Skeleton className="h-[440px]" /></div>} isEmpty={(d) => !d.metrics.length}>
        {(d) => {
          const key = sel ?? d.metrics[0]?.key
          const m = d.metrics.find((x) => x.key === key)
          const label = m ? (LABEL[m.key] ? t(LABEL[m.key]) : m.label) : key
          const FROM = Date.UTC(2013, 0, 1) / 1000 // early-history MVRV spikes flatten everything after
          const series = (d.series[key] ?? m?.spark ?? []).filter((x) => x.time >= FROM)
          const n = d.network
          const halvDays = daysUntil(n.halving_eta)
          const zone = ZONES[key]
          return (
            <div className="flex flex-col gap-3">
              <div className="overflow-hidden rounded-2xl border border-line bg-line">
                <div className={clsx('grid gap-px', d.metrics.length % 5 === 0 ? 'grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-5' : 'grid-cols-[repeat(auto-fill,minmax(180px,1fr))]')}>
                  {d.metrics.map((x) => <MetricCell key={x.key} m={x} active={x.key === key} onClick={() => setSel(x.key)} />)}
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-12">
                <Card className="h-full xl:col-span-9">
                  <CardHeader title={t('{m} vs prezzo', { m: label })} subtitle={t('Seleziona una metrica per visualizzarla')} info={m && INFO[m.key] ? t(INFO[m.key]) : undefined}
                    icon={<LineChart />} updatedAt={q.dataUpdatedAt}
                    right={<Toggle on={log} onClick={() => setLog(!log)}>{t('Prezzo log')}</Toggle>} />
                  <CardBody className="flex flex-col">
                    <Fill min={440}><TimeLinesChart height="100%" zoom log={log}
                      lines={[
                        { name: label, data: series, color: C.blue, axis: 1, area: true },
                        { name: t('Prezzo BTC'), data: (d.series.price ?? []).filter((x) => x.time >= FROM), color: C.btc, axis: 0 },
                      ]}
                      markLines={zone ? [
                        { y: zone.lo, color: 'rgba(148,163,184,0.55)', label: `${t(zone.loLabel)} ${zone.fmt(zone.lo)}` },
                        { y: zone.hi, color: 'rgba(148,163,184,0.55)', label: `${t(zone.hiLabel)} ${zone.fmt(zone.hi)}` },
                      ] : undefined}
                      y2Fmt={(v) => compact(v, 2)} /></Fill>
                  </CardBody>
                </Card>
                <div className="flex min-w-0 flex-col gap-3 xl:col-span-3">
                <ZonesCard metrics={d.metrics} active={key} onSelect={setSel} />
                <Card>
                  <CardHeader title={t('Rete Bitcoin')} icon={<Blocks />} />
                  <CardBody>
                    <Row k={t('Altezza blocco')}>{n.block_height != null ? int(n.block_height) : '—'}</Row>
                    <Row k={t('Commissioni (sat/vB)')} foot={n.fees ? t('Veloce · 1 ora · economica') : undefined}>{n.fees ? `${n.fees.fastest} · ${n.fees.hour} · ${n.fees.economy}` : '—'}</Row>
                    <Row k={t('Prossima difficoltà')}><span className="text-slate-300">{n.difficulty_change != null ? pct(n.difficulty_change, 2) : '—'}</span></Row>
                    <Row k={t('Data aggiustamento')}>{n.next_retarget ? date(n.next_retarget) : '—'}</Row>
                    <div className="mt-3 border-t border-line pt-3">
                      <div className="label">{t('Prossimo halving')}</div>
                      <div className="tnum mt-1.5 text-3xl font-semibold text-white">{halvDays != null ? `${int(halvDays)} ${dayUnit()}` : '—'}</div>
                      <div className="tnum mt-1 text-xs text-slate-400">{n.halving_eta ? t('Stima {d}', { d: date(n.halving_eta) }) : ''}{n.blocks_to_halving != null && ` · ${t('{n} blocchi', { n: int(n.blocks_to_halving) })}`}</div>
                      {n.blocks_to_halving != null && <ProgressBar className="mt-3" value={100 - (n.blocks_to_halving / 210000) * 100} />}
                    </div>
                  </CardBody>
                </Card>
                </div>
              </div>
            </div>
          )
        }}
      </Q>
    </div>
  )
}
