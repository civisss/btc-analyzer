import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity, AlertTriangle, BookOpenText, CheckCircle2, Database, Gauge, Grid3x3, Layers, RefreshCw, ScanLine, ShieldCheck, Waves,
} from 'lucide-react'
import {
  useObFootprint, useObHeatmap, useObLive, useObSignals, useObStatus,
  type ObEvent, type ObLiveMsg, type ObMarket, type ObMarketStatus, type ObSignals, type ObStatus, type ObTf,
} from '../api/orderbook'
import { HEAT, T, alpha } from '../theme/tokens'
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorState, KpiCell, KpiStrip, MethodNote, Segmented, Skeleton, Toggle, clsx, PageActions, SettingsPanel, SettingRow } from '../components/ui'
import HeatmapCanvas, { appendLive, buildStore, type HeatmapHandle, type HeatmapOpts, type HmStore } from '../widgets/orderbookHeatmap'
import FootprintCanvas, { applyLiveFp, buildFp, type FpHandle, type FpStore } from '../widgets/orderbookFootprint'
import { agoSeconds, dateTime, dayUnit, pct, usd } from '../lib/format'
import { t } from '../i18n'

// ------------------------------------------------------------------ constants
const MARKET_LABEL: Record<ObMarket, string> = { futures: 'Binance perp', spot: 'Binance spot' }
const MARKET_VENUE: Record<ObMarket, string> = { futures: 'Binance USDⓈ-M BTCUSDT', spot: 'Binance BTCUSDT spot' }
const SPANS = [
  { v: 900, l: '15m' }, { v: 3600, l: '1h' }, { v: 4 * 3600, l: '4h' }, { v: 12 * 3600, l: '12h' }, { v: 86400, l: '24h' }, { v: 3 * 86400, l: '3g' }, { v: 7 * 86400, l: '7g' },
] as const
const BUCKETS = [10, 20, 50, 100, 250]
const RANGES = [0.5, 1, 1.5]
const FP_TFS: ObTf[] = ['1m', '5m', '15m', '1h']
const FP_BINS = [5, 10, 25, 50, 100]
const CONTRASTS = [95, 98, 99, 99.5]

const spanLabel = (l: string) => l.replace('g', dayUnit())

function usePersist<V extends string | number>(key: string, def: V, allowed: readonly V[]): [V, (v: V) => void] {
  const [v, setV] = useState<V>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return def
      const parsed = (typeof def === 'number' ? Number(raw) : raw) as V
      return allowed.includes(parsed) ? parsed : def
    } catch { return def }
  })
  const set = useCallback((x: V) => { setV(x); try { localStorage.setItem(key, String(x)) } catch { /* ignore */ } }, [key])
  return [v, set]
}
function usePersistBool(key: string, def: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => { try { const r = localStorage.getItem(key); return r == null ? def : r === '1' } catch { return def } })
  const set = useCallback((x: boolean) => { setV(x); try { localStorage.setItem(key, x ? '1' : '0') } catch { /* ignore */ } }, [key])
  return [v, set]
}
function useMedia(q: string) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const h = () => setM(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [q])
  return m
}
/** Width of an element, rounded to `step` px (avoids refetch storms while resizing). */
function useWidth(step = 200): [React.RefObject<HTMLDivElement>, number | null] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(step, Math.round(el.getBoundingClientRect().width / step) * step)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [step])
  return [ref, w]
}

const btc = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)} BTC`)
const signedBtc = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)} BTC`)

// ------------------------------------------------------------------ live state shared by the page
interface LiveInfo { mid: number | null; bb: number | null; ba: number | null; imb: number | null; fpDelta: number | null; fpPoc: number | null; fpT: number | null; at: number }

// ------------------------------------------------------------------ toolbar
function LivePill({ open, synced }: { open: boolean; synced: boolean }) {
  const state = !open ? 'off' : synced ? 'live' : 'sync'
  const txt = state === 'live' ? t('Live') : state === 'sync' ? t('Sincronizzazione') : t('Riconnessione')
  return (
    <span className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset',
      state === 'live' ? 'bg-accent/10 text-accent-hi ring-accent/25' : state === 'sync' ? 'bg-warn/10 text-warn ring-warn/20' : 'bg-white/[0.04] text-fg-3 ring-line')}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', state === 'live' ? 'live-dot bg-accent' : state === 'sync' ? 'bg-warn' : 'bg-fg-4')} />
      {txt}
    </span>
  )
}

// ------------------------------------------------------------------ integrity card
function Row({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-subtle py-1.5 last:border-0">
      <span className="min-w-0 text-fg-3">{k}</span>
      <span className={clsx('tnum shrink-0 text-right font-medium', tone === 'warn' || tone === 'bad' ? 'text-warn' : 'text-white')}>{v}</span>
    </div>
  )
}

function IntegrityCard({ st, market, className }: { st: ObStatus | undefined; market: ObMarket; className?: string }) {
  const m = st?.markets[market]
  return (
    <Card className={className}>
      <CardHeader icon={<ShieldCheck />} accent="teal" title={t('Integrità dati')} subtitle={t('Verifiche incrociate con le API ufficiali')}
        info={t('Book locale confrontato con lo snapshot REST allo stesso update id (atteso 0 differenze); volume aggressivo per minuto confrontato con le kline 1m ufficiali (atteso < 0.5%).')} />
      <CardBody className="text-xs">
        {!m ? <Skeleton className="h-40" /> : <IntegrityBody m={m} st={st!} />}
      </CardBody>
    </Card>
  )
}

function IntegrityBody({ m, st }: { m: ObMarketStatus; st: ObStatus }) {
  const v = m.verify
  const vOk = v.n > 0 && v.ok === v.n
  const kc = m.kline_check
  const kOk = kc.n > 0 && (kc.within_05 ?? 0) >= 0.95
  const resGap = m.resyncs.last.filter((r) => r.reason === 'gap').length
  const tp = m.trusted_pct
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge color={m.depth_connected ? 'slate' : 'btc'}>{t('Book')} {m.depth_connected ? t('connesso') : t('disconnesso')}</Badge>
        <Badge color={m.trade_connected ? 'slate' : 'btc'}>{t('Trade')} {m.trade_connected ? t('connessi') : t('disconnessi')}</Badge>
        <Badge color={m.synced ? 'slate' : 'btc'}>{m.synced ? t('Sincronizzato') : t('In sincronizzazione')}</Badge>
      </div>
      <div>
        <div className="label mb-1 flex items-center gap-1.5">{vOk ? <CheckCircle2 size={12} className="text-accent" /> : <AlertTriangle size={12} className="text-warn" />}{t('Book vs snapshot REST')}</div>
        <Row k={t('Verifiche superate')} v={v.n ? `${v.ok}/${v.n}` : t('In attesa')} tone={v.n ? (vOk ? 'ok' : 'warn') : undefined} />
        <Row k={t('Livelli confrontati · differenze')} v={`${v.levels_compared.toLocaleString('en-US')} · ${v.range_mismatch}`} tone={v.n ? (v.range_mismatch === 0 ? 'ok' : 'warn') : undefined} />
        <Row k={t('Best bid/ask · primi 20 livelli')} v={v.last ? `${v.last.best_match ? t('identici') : t('diversi')} · ${v.top_mismatch} ${t('diff.')}` : '—'} />
        <Row k={t('Zona nuova (solo diff stream): livelli · mancanti')} v={`${v.new_zone_levels.toLocaleString('en-US')} · ${v.new_zone_mismatch}`} />
        <Row k={t('Ultima verifica')} v={v.last ? agoSeconds(Date.now() / 1000 - v.last.t) : '—'} />
      </div>
      <div>
        <div className="label mb-1 flex items-center gap-1.5">{kOk ? <CheckCircle2 size={12} className="text-accent" /> : <AlertTriangle size={12} className="text-warn" />}{t('Footprint vs kline 1m ufficiali')}</div>
        <Row k={t('Minuti confrontati')} v={kc.n || t('In attesa')} />
        <Row k={t('Scarto volume mediano · max')} v={kc.n ? `${(kc.median_abs ?? 0).toFixed(3)}% · ${(kc.max_abs ?? 0).toFixed(3)}%` : '—'} tone={kc.n ? ((kc.max_abs ?? 0) < 0.5 ? 'ok' : 'warn') : undefined} />
        <Row k={t('Minuti entro 0.5%')} v={kc.n ? pct((kc.within_05 ?? 0) * 100, 1, false) : '—'} />
        <Row k={t('Scarto acquisti (taker buy) mediano')} v={kc.buy.n ? `${(kc.buy.median_abs ?? 0).toFixed(3)}%` : '—'} />
      </div>
      <div>
        <div className="label mb-1">{t('Continuità')}</div>
        <Row k={t('Risincronizzazioni (buchi update id)')} v={`${m.resyncs.n} (${resGap})`} />
        <Row k={t('Disconnessioni book · trade')} v={`${m.disconnects.depth} · ${m.disconnects.trades}`} />
        <Row k={t('Trade recuperati via REST')} v={m.backfills.length ? `${m.backfills.reduce((a, b) => a + b.fetched, 0).toLocaleString('en-US')} · ${m.backfills.every((b) => b.ok) ? t('completi') : t('parziali')}` : '0'} />
        <Row k={t('Copertura snapshot (dal mid)')} v={tp[0] != null && tp[1] != null ? `${pct(tp[0], 2)} / ${pct(tp[1], 2)}` : '—'} />
      </div>
      <div>
        <div className="label mb-1">{t('Risorse')}</div>
        <Row k={t('Storage stimato')} v={m.storage.mb_per_day != null ? `${m.storage.mb_per_day.toFixed(1)} MB/${t('giorno')}` : t('In misura')} />
        <Row k={t('Su disco · retention')} v={`${m.storage.total_mb.toFixed(1)} MB · ${st.config.retention_days.hs}/${st.config.retention_days.hm} ${dayUnit()}`} />
        <Row k={t('CPU collector · scrittura')} v={`${st.cpu.collector_pct.toFixed(1)}% · ${st.cpu.flush_pct.toFixed(2)}%`} />
        <Row k={t('RAM processo · collector')} v={`${st.rss_mb != null ? st.rss_mb.toFixed(0) : '—'} · ${m.mem_est_mb.toFixed(0)} MB`} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ walls card
function WallsCard({ sig, className }: { sig: ObSignals | undefined; className?: string }) {
  const walls = sig?.walls ?? []
  const max = Math.max(1, ...walls.map((w) => w.q))
  return (
    <Card className={className}>
      <CardHeader icon={<Layers />} accent="blue" title={t('Muri di liquidità vicini')} subtitle={t('Entro ±1% dal prezzo, confermati da ≥ 20 s')}
        info={sig ? t('Soglia statistica: bucket da $10 con liquidità ≥ {k}× la mediana dei bucket entro ±1% (oggi {thr} BTC) e ≥ {min} BTC.', {
          k: sig.wall_rule.k, thr: sig.wall_rule.threshold?.toFixed(1) ?? '—', min: sig.wall_rule.min_qty }) : undefined} />
      <CardBody className="flex flex-col">
        {!sig ? <Skeleton className="h-32" /> : walls.length === 0 ? <EmptyState compact text={t('Nessun muro oltre la soglia in questo momento')} /> : (
          <div className="flex flex-1 flex-col justify-around gap-1.5">
            {walls.slice(0, 7).map((w) => (
              <div key={`${w.side}-${w.price}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-xs">
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="tnum font-medium text-white">{usd(w.price, 0)}</span>
                    <span className={clsx('tnum', w.side === 'bid' ? 'text-up' : 'text-down')}>{w.side === 'bid' ? t('Bid') : t('Ask')} · {pct(w.dist_pct, 2)}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                    <div className="h-full rounded-full" style={{ width: `${(w.q / max) * 100}%`, background: w.side === 'bid' ? alpha(T.up, 0.75) : alpha(T.down, 0.75) }} />
                  </div>
                </div>
                <div className="tnum w-20 text-right text-fg-2">{btc(w.q, w.q < 100 ? 1 : 0)}<div className="text-2xs text-fg-4">{agoSeconds(w.age_s).replace(/ (fa|ago)$/, '')}</div></div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ events table
const KIND_LABEL: Record<ObEvent['kind'], string> = { pulled: 'Ritirata prima del tocco', consumed: 'Consumata dagli scambi', appeared: 'Muro comparso' }
function EventsCard({ sig, className }: { sig: ObSignals | undefined; className?: string }) {
  const evs = [...(sig?.events ?? [])].reverse().slice(0, 12)
  return (
    <Card className={className}>
      <CardHeader icon={<Waves />} accent="amber" title={t('Muri spariti negli ultimi 30 minuti')} subtitle={t('Ritirati prima del tocco o consumati dagli scambi')}
        info={t('"Ritirata prima del tocco": il muro scende sotto il 30% del suo massimo mentre il prezzo è entro lo 0.15% e quasi nulla è stato scambiato a quel livello. È un fatto osservabile, non un\'accusa: la liquidità visibile viene spostata per molti motivi legittimi.')} />
      <CardBody>
        {!sig ? <Skeleton className="h-40" /> : evs.length === 0 ? <EmptyState compact text={t('Nessun muro sparito vicino al prezzo negli ultimi 30 minuti')} /> : (
          <div className="-mx-1 overflow-x-auto">
            <table className="tbl w-full text-xs">
              <thead><tr><th className="text-left">{t('Orario')}</th><th className="text-left">{t('Livello')}</th><th className="text-left">{t('Esito')}</th><th className="text-right">{t('Liquidità')}</th><th className="hidden text-right sm:table-cell">{t('Durata')}</th></tr></thead>
              <tbody>
                {evs.map((e, i) => (
                  <tr key={`${e.t}-${e.price}-${i}`} className="border-t border-line-subtle">
                    <td className="tnum px-2 py-1.5 text-fg-3 sm:px-3">{new Date(e.t * 1000).toLocaleTimeString('en-GB')}</td>
                    <td className="tnum px-2 py-1.5 sm:px-3"><span className="text-white">{usd(e.price, 0)}</span> <span className={e.side === 'bid' ? 'text-up' : 'text-down'}>{e.side === 'bid' ? t('Bid') : t('Ask')}</span></td>
                    <td className="px-2 py-1.5 sm:px-3"><span className={clsx('inline-flex items-center gap-1.5', e.kind === 'pulled' ? 'text-warn' : 'text-fg-2')}>
                      <span className={clsx('h-1.5 w-1.5 rounded-full', e.kind === 'pulled' ? 'bg-warn' : 'bg-fg-2')} />{t(KIND_LABEL[e.kind])}</span></td>
                    <td className="tnum px-2 py-1.5 text-right text-fg-2 sm:px-3">{e.qmax.toFixed(1)} → {e.q.toFixed(1)}</td>
                    <td className="tnum hidden px-2 py-1.5 text-right text-fg-3 sm:table-cell sm:px-3">{e.age_s}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ coverage card
function CoverageCard({ m, className }: { m: ObMarketStatus | undefined; className?: string }) {
  const now = Date.now() / 1000
  const from = now - 7 * 86400
  const segs = m?.coverage ?? []
  const covered = segs.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, now) - Math.max(s, from)), 0)
  const days = Array.from({ length: 8 }, (_, i) => from + i * 86400)
  return (
    <Card className={className}>
      <CardHeader icon={<Database />} accent="slate" title={t('Copertura dei dati')} subtitle={t('Lo storico esiste solo da quando l\'app è accesa')} />
      <CardBody className="flex flex-col gap-3">
        {!m ? <Skeleton className="h-28" /> : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <MiniStat label={t('Inizio raccolta')} value={m.collection_start ? dateTime(m.collection_start) : '—'} />
              <MiniStat label={t('Coperto (7 giorni)')} value={pct((covered / (7 * 86400)) * 100, 1, false)} />
              <MiniStat label={t('Buchi > 2 min')} value={String(Math.max(0, segs.length - 1))} />
            </div>
            <div>
              <div className="label mb-1.5">{t('Ultimi 7 giorni')}</div>
              <div className="relative h-7 overflow-hidden rounded-md bg-white/[0.04]">
                {segs.map(([s, e]) => {
                  const a = Math.max(s, from), b = Math.min(e, now)
                  if (b <= a) return null
                  return <div key={s} className="absolute inset-y-0 bg-accent/70" style={{ left: `${((a - from) / (now - from)) * 100}%`, width: `${Math.max(0.15, ((b - a) / (now - from)) * 100)}%` }} />
                })}
                {days.slice(1, -1).map((d) => <div key={d} className="absolute inset-y-0 w-px bg-white/10" style={{ left: `${((d - from) / (now - from)) * 100}%` }} />)}
              </div>
              <div className="tnum mt-1 flex justify-between text-2xs text-fg-4">
                <span>{dateTime(from).split(' ').slice(0, 2).join(' ')}</span><span>{t('Ora')}</span>
              </div>
            </div>
            <div>
              <div className="label mb-1.5">{t('Sessioni di raccolta recenti')}</div>
              <div className="flex flex-col">
                {[...(m.sessions ?? [])].reverse().slice(0, 8).map(([a, b]) => (
                  <div key={a} className="tnum flex items-baseline justify-between gap-3 border-b border-line-subtle py-1 text-xs last:border-0">
                    <span className="text-fg-2">{dateTime(a)} → {now - b < 120 ? t('in corso') : dateTime(b)}</span>
                    <span className="text-fg-4">{fmtDur(Math.min(b, now) - a)}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* note anchored to the bottom: the card is as tall as the events table next to it */}
            <p className="mt-auto border-t border-line pt-3 text-xs leading-relaxed text-fg-3">
              {t('I buchi (app spenta o book non sincronizzato) restano vuoti nella heatmap: il book passato non è ricostruibile. I trade persi in una disconnessione breve vengono recuperati via REST; altrimenti la candela è marcata parziale.')}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  )
}
const fmtDur = (s: number) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} ${dayUnit()}`)
const MiniStat = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="min-w-0 tile px-3 py-2">
    <div className="label truncate">{label}</div>
    <div className="tnum mt-0.5 truncate text-sm font-semibold text-white">{value}</div>
  </div>
)

// ------------------------------------------------------------------ KPIs
function Kpis({ live, sig, market }: { live: LiveInfo; sig: ObSignals | undefined; market: ObMarket }) {
  const spread = live.bb != null && live.ba != null ? live.ba - live.bb : null
  const imb = live.imb ?? sig?.imbalance?.now ?? null
  const pulled = (sig?.events ?? []).filter((e) => e.kind === 'pulled').length
  const consumed = (sig?.events ?? []).filter((e) => e.kind === 'consumed').length
  const near = sig?.walls ?? []
  const big = [...near].sort((a, b) => b.q - a.q)[0]
  const cvd = sig?.cvd
  return (
    <KpiStrip>
      <KpiCell icon={<Activity />} accent="blue" label={t('Mid')} value={usd(live.mid ?? sig?.mid ?? null, 1)} foot={`${t('Spread')} ${spread != null ? usd(spread, 2) : '—'} · ${MARKET_LABEL[market]}`} />
      <KpiCell icon={<Gauge />} accent="blue" label={t('Bid entro ±0.5%')} value={imb != null ? pct(imb * 100, 1, false) : '—'}
        foot={sig?.imbalance ? `${t('Media 15 min')} ${pct(sig.imbalance.mean * 100, 1, false)}${sig.imbalance.persistent ? ` · ${t(sig.imbalance.persistent === 'bid' ? 'Bid prevalente' : 'Ask prevalente')}` : ''}` : t('In raccolta')} />
      <KpiCell icon={<Layers />} accent="blue" label={t('Muri vicini')} value={sig ? String(near.length) : '—'}
        foot={big ? `${t('Max')} ${usd(big.price, 0)} · ${btc(big.q, 0)}` : t('Nessuno oltre la soglia')} />
      <KpiCell icon={<Waves />} accent="amber" label={t('Ritirati prima del tocco')} value={sig ? String(pulled) : '—'} foot={`${t('Ultimi 30 min')} · ${consumed} ${t('consumati')}`} />
      <KpiCell icon={<BookOpenText />} accent="blue" label={t('CVD 60 min')} value={cvd ? signedBtc(cvd.cvd, 0) : '—'}
        foot={cvd ? `${t('Prezzo')} ${pct(cvd.price_change_pct, 2)}${cvd.divergence ? ` · ${t('Divergenza')}` : ''}` : t('In raccolta')} />
      <KpiCell icon={<ScanLine />} accent="blue" label={t('Delta candela corrente')} value={signedBtc(live.fpDelta, 1)}
        foot={live.fpPoc != null ? `POC ${usd(live.fpPoc, 0)}` : '—'} />
    </KpiStrip>
  )
}

// ------------------------------------------------------------------ page
export default function OrderBookPage({ tab }: { tab: 'heatmap' | 'footprint' }) {
  const [market, setMarket] = usePersist<ObMarket>('ob.market', 'futures', ['futures', 'spot'])
  const [span, setSpan] = usePersist<number>('ob.span', 3600, SPANS.map((s) => s.v))
  const [bucket, setBucket] = usePersist<number>('ob.bucket', 10, BUCKETS)
  const [range, setRange] = usePersist<number>('ob.range', 1, RANGES)
  const [contrast, setContrast] = usePersist<number>('ob.contrast', 98, CONTRASTS)
  const [bubbles, setBubbles] = usePersistBool('ob.bubbles', true)
  const [events, setEvents] = usePersistBool('ob.events', true)
  const [priceLine, setPriceLine] = usePersistBool('ob.price', true)
  const [tf, setTf] = usePersist<ObTf>('ob.tf', '1m', FP_TFS)
  const [bin, setBin] = usePersist<number>('ob.bin', 10, FP_BINS)
  const mobile = useMedia('(max-width: 639px)')
  const [chartRef, chartW] = useWidth(200)

  const status = useObStatus()
  const sig = useObSignals(market)
  const cols = Math.min(2000, Math.max(300, chartW ?? 0))
  const hq = useObHeatmap({ market, span, bucket, range, cols }, tab === 'heatmap' && chartW != null)
  const fq = useObFootprint({ market, tf, bin, limit: mobile ? 60 : 160 }, tab === 'footprint')

  const store = useMemo<HmStore | null>(() => (hq.data ? buildStore(hq.data) : null), [hq.data])
  const fpStore = useMemo<FpStore | null>(() => (fq.data ? buildFp(fq.data) : null), [fq.data])
  const storeRef = useRef(store); storeRef.current = store
  const fpRef = useRef(fpStore); fpRef.current = fpStore
  const hmRef = useRef<HeatmapHandle>(null)
  const fpHandle = useRef<FpHandle>(null)

  const [wsOpen, setWsOpen] = useState(false)
  const [live, setLive] = useState<LiveInfo>({ mid: null, bb: null, ba: null, imb: null, fpDelta: null, fpPoc: null, fpT: null, at: 0 })
  const [synced, setSynced] = useState(false)
  const pendingLive = useRef<Partial<LiveInfo>>({})
  const onMsg = useCallback((m: ObLiveMsg) => {
    if (m.type !== 'ob_live' || m.market !== market) return
    const s = storeRef.current
    if (m.cols?.length) {
      if (s && s.market === m.market) for (const c of m.cols) appendLive(s, c)
      const c = m.cols[m.cols.length - 1]
      Object.assign(pendingLive.current, { mid: c.mid, bb: c.bb, ba: c.ba, imb: c.imb })
    }
    if (m.events?.length && s) { s.events.push(...m.events); s.version++ }
    if (m.fp) {
      if (fpRef.current) applyLiveFp(fpRef.current, m.fp)
      Object.assign(pendingLive.current, { fpDelta: m.fp.delta, fpPoc: m.fp.poc, fpT: m.fp.t })
    }
    setSynced(m.status.synced)
  }, [market])
  // KPI live al massimo 1 volta al secondo
  useEffect(() => {
    const id = setInterval(() => {
      if (Object.keys(pendingLive.current).length) { const p = pendingLive.current; pendingLive.current = {}; setLive((l) => ({ ...l, ...p, at: Date.now() })) }
    }, 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => { setLive({ mid: null, bb: null, ba: null, imb: null, fpDelta: null, fpPoc: null, fpT: null, at: 0 }) }, [market, tf, bin])
  useObLive({ market, bucket: store?.bucket ?? bucket, range, tf, bin }, onMsg, setWsOpen)

  const st = status.data
  const ms = st?.markets[market]
  const opts: HeatmapOpts = { contrast, bubbles, events, priceLine, ladder: !mobile }
  const autoBucket = hq.data && hq.data.bucket !== bucket ? hq.data.bucket : null
  const isLong = span > 6 * 3600

  return (
    <div>

      <div className="flex flex-col gap-3">
        <PageActions>
          <Segmented value={market} onChange={setMarket} options={(st?.enabled ?? ['futures', 'spot']).map((m) => ({ value: m, label: MARKET_LABEL[m] }))} />
          {tab === 'heatmap'
            ? <Segmented value={span} onChange={setSpan} options={SPANS.map((s) => ({ value: s.v, label: spanLabel(s.l) }))} />
            : <Segmented value={tf} onChange={setTf} options={FP_TFS.map((x) => ({ value: x, label: x }))} />}
          <SettingsPanel>
            {tab === 'heatmap' ? (
              <>
                <SettingRow label={t('Bucket')}><Segmented value={bucket} onChange={setBucket} options={BUCKETS.map((b) => ({ value: b, label: `$${b}` }))} /></SettingRow>
                <SettingRow label={t('Banda prezzi')}><Segmented value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: `±${r}%` }))} /></SettingRow>
                <SettingRow label={t('Contrasto')}><Segmented value={contrast} onChange={setContrast} options={CONTRASTS.map((c) => ({ value: c, label: `p${c}` }))} /></SettingRow>
                <SettingRow label={t('Mostra')}>
                  <Toggle on={bubbles} onClick={() => setBubbles(!bubbles)}>{t('Bolle trade')}</Toggle>
                  <Toggle on={events} onClick={() => setEvents(!events)}>{t('Muri spariti')}</Toggle>
                  <Toggle on={priceLine} onClick={() => setPriceLine(!priceLine)}>{t('Prezzo')}</Toggle>
                </SettingRow>
              </>
            ) : (
              <SettingRow label={t('Bin')}><Segmented value={bin} onChange={setBin} options={FP_BINS.map((b) => ({ value: b, label: `$${b}` }))} /></SettingRow>
            )}
          </SettingsPanel>
          <LivePill open={wsOpen} synced={synced || !!ms?.synced} />
          <button className="btn-ghost" onClick={() => (tab === 'heatmap' ? hmRef.current?.reset() : fpHandle.current?.reset())}><ScanLine size={14} />{t('Adatta')}</button>
          <button className="btn-ghost" onClick={() => (tab === 'heatmap' ? hq.refetch() : fq.refetch())} disabled={hq.isFetching || fq.isFetching}>
            <RefreshCw size={14} className={clsx((hq.isFetching || fq.isFetching) && 'animate-spin')} />{t('Ricarica')}</button>
        </PageActions>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-fg-3">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="font-semibold tracking-wide text-fg">{MARKET_VENUE[market]}</span>
              <span>{tab === 'heatmap'
                ? t('Book campionato ogni secondo in bucket da $10 entro ±1.5% dal mid')
                : t('Trade aggressivi (aggTrade) per candela e livello · imbalance diagonali ≥ 3:1')}</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-3">
              {autoBucket && tab === 'heatmap' && <span className="text-warn">{t('Bucket portato a ${b} per l\'ampiezza dell\'intervallo', { b: autoBucket })}</span>}
              {tab === 'heatmap' && hq.data && <span>{hq.data.tier === 's' ? t('Risoluzione {s} s', { s: Math.max(1, Math.round(hq.data.dt)) }) : t('Risoluzione {m} min (medie al minuto)', { m: Math.max(1, Math.round(hq.data.dt / 60)) })}</span>}
              <span className="hidden sm:inline">{t('Rotella: zoom tempo · Shift o asse prezzi: zoom prezzo · Trascina: sposta · Doppio clic: adatta')}</span>
            </span>
          </div>

        <Kpis live={live} sig={sig.data} market={market} />

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px] min-[2200px]:grid-cols-[minmax(0,1fr)_400px]">
          <Card className="min-h-0 xl:h-full">
            <CardHeader icon={tab === 'heatmap' ? <Grid3x3 /> : <BookOpenText />} accent="blue"
              title={tab === 'heatmap' ? t('Heatmap della liquidità') : t('Footprint {tf}', { tf })}
              subtitle={tab === 'heatmap'
                ? t('Colore = BTC in attesa nel livello · bolle = trade aggressivi · rombi = liquidità ritirata prima del tocco')
                : t('Vendite × acquisti aggressivi per livello · sfondo = delta · contorno = POC')}
              right={tab === 'heatmap' ? <HeatLegend /> : <FpLegend />} />
            <CardBody className="flex flex-col">
              <div ref={chartRef} className={clsx('relative w-full', mobile ? 'h-[440px]' : 'h-[clamp(520px,64vh,860px)] xl:h-auto xl:min-h-[560px] xl:flex-1')}>
                {tab === 'heatmap' ? (
                  hq.isError && !hq.data ? <ErrorState error={hq.error} onRetry={() => hq.refetch()} /> :
                  !store ? (hq.data?.empty ? <EmptyState text={t('Nessun campione ancora: la raccolta parte con l\'app e serve qualche secondo per sincronizzare il book.')} /> : <Skeleton className="h-full w-full" />) :
                  <HeatmapCanvas ref={hmRef} store={store} opts={opts} span={span} compactUi={mobile} />
                ) : (
                  fq.isError && !fq.data ? <ErrorState error={fq.error} onRetry={() => fq.refetch()} /> :
                  !fpStore ? <Skeleton className="h-full w-full" /> :
                  fpStore.candles.length === 0 ? <EmptyState text={t('Nessun trade raccolto ancora per questo mercato.')} /> :
                  <FootprintCanvas ref={fpHandle} store={fpStore} compactUi={mobile} />
                )}
              </div>
              {tab === 'heatmap' && isLong && <p className="mt-2 text-xs text-fg-4">{t('Intervalli oltre 6 ore usano le medie al minuto: i muri di pochi secondi si attenuano.')}</p>}
            </CardBody>
          </Card>
          <div className="grid gap-3 md:grid-cols-2 xl:flex xl:flex-col">
            {/* integrity at its natural height; the walls list takes (and spreads over) the rest of the column */}
            <IntegrityCard st={st} market={market} />
            <WallsCard sig={sig.data} className="xl:flex-1" />
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <EventsCard sig={sig.data} className="h-full" />
          <CoverageCard m={ms} className="h-full" />
        </div>

        <MethodNote title={t('Metodo, fonti e limiti')}>
          <p><b className="text-fg-2">{t('Fonte')}.</b> {t('Binance USDⓈ-M BTCUSDT (perpetual) e Binance spot BTCUSDT, WebSocket pubblici: diff depth @100ms e aggTrade. Il book locale segue la procedura ufficiale Binance: snapshot REST, scarto degli eventi più vecchi, controllo della continuità degli update id (pu/U) e risincronizzazione automatica a ogni buco.')}</p>
          <p><b className="text-fg-2">{t('Verifiche')}.</b> {t('Ogni 2 minuti (futures) o 5 minuti (spot) un nuovo snapshot REST viene portato allo stesso update id del book locale e confrontato livello per livello: le differenze attese sono 0 e i livelli dello snapshot riparano il book. Ogni 5 minuti il volume aggressivo raccolto per minuto viene confrontato con il volume delle kline 1m ufficiali.')}</p>
          <p><b className="text-fg-2">{t('Campionamento e storage')}.</b> {t('Ogni secondo la liquidità entro ±1.5% dal mid viene sommata in bucket da $10 (ri-aggregabili a $20, $50, $100, $250) e salvata in parquet orari; medie al minuto per gli intervalli lunghi. Retention: campioni al secondo 7 giorni, medie al minuto e footprint 30 giorni. Footprint in bin da $5 per minuto, ri-aggregati per timeframe e bin.')}</p>
          <p><b className="text-fg-2">{t('Muri e ritiri')}.</b> {t('Un bucket è un muro se supera k = 5 volte la mediana dei bucket entro ±1% (e almeno 2 BTC sul perpetual, 1 BTC sullo spot) per almeno 20 secondi. Se scende sotto il 30% del massimo con il prezzo entro lo 0.15% e senza scambi corrispondenti è segnalato come liquidità ritirata prima del tocco; con scambi o prezzo sul livello come consumato.')}</p>
          <p><b className="text-fg-2">{t('Footprint')}.</b> {t('Lato aggressore dal campo m di aggTrade (m = vero: il compratore è maker, quindi è una vendita aggressiva). Imbalance diagonale: acquisti a un livello ≥ 3 volte le vendite del livello sotto (e viceversa); con lato opposto nullo serve almeno l\'1% del volume della candela. Tre o più livelli consecutivi formano una zona impilata. CVD cumulato dalla prima candela caricata.')}</p>
          <p><b className="text-fg-2">{t('Limiti')}.</b> {t('Book di un solo exchange (Binance), non aggregato multi-exchange. La liquidità visibile non rivela le intenzioni: gli ordini possono essere spostati o cancellati in qualsiasi momento e gli ordini iceberg non sono visibili. Sul perpetual lo snapshot REST copre solo i 1000 livelli più vicini (circa ±0.15%): oltre, il book è ricostruito dal diff stream e le zone non ancora coperte da uno snapshot sono più scure. Lo storico esiste solo da quando l\'app è accesa; i periodi spenti restano buchi.')}</p>
        </MethodNote>
      </div>
    </div>
  )
}

function HeatLegend() {
  return (
    <div className="flex items-center gap-2 text-2xs text-fg-3">
      <span>{t('Poca')}</span>
      <span className="h-2 w-24 rounded-full" style={{ background: `linear-gradient(90deg,${HEAT.join(',')})` }} />
      <span>{t('Molta liquidità')}</span>
    </div>
  )
}
function FpLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-3">
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-up-hi" />{t('Imbalance acquisto')}</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-down-hi" />{t('Imbalance vendita')}</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm ring-1 ring-warn" />POC</span>
    </div>
  )
}

