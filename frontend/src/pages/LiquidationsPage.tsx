import { useEffect, useMemo, useState } from 'react'
import { useLiquidations } from '../api/client'
import { live, useLive, type LiveLiq } from '../api/live'
import type { LiqExchange, LiqRange, Liquidations } from '../api/types'
import { Card, CardBody, CardHeader, EmptyState, Fill, KpiCell, KpiStrip, ProgressBar, Q, Segmented, Skeleton, clsx } from '../components/ui'
import { LiqHeatmapChart } from '../widgets/charts'
import { LeverageMapCard } from '../widgets/liqLeverage'
import { EX_NAME, ExchangeBadge } from '../widgets/derivPro'
import { date, dateTime, int, pct, time, usd, usdCompact as usdC } from '../lib/format'
import { usePrice, useThrottledPrice } from '../widgets/hooks'
import { cap, getLang, t, tfLabel, tr } from '../i18n'
import { ArrowDownRight, ArrowUpRight, BadgeCheck, Building2, CalendarDays, Crosshair, Droplets, Flame, Layers, Magnet, Radio, ShieldAlert, Timer } from 'lucide-react'

/** Pool source from the API ("Swing high 4h intatto", "Equal highs 1h (2 tocchi)"): the field is not translated server side. */
const poolSource = (s: string) => cap(getLang() === 'en' ? s.replace(/\((\d+) tocchi\)/, '($1 touches)').replace(/\bintatto\b/, 'intact') : s)

/** compact USD without a trailing ".0" ($500K, not $500.0K) */
const usdCompact = (v: number | null | undefined, d?: number) => usdC(v, d).replace(/\.0(?=[KMBT])/, '')

const BIG = 500_000
const FEED_ROWS = 15
const POOL_ROWS = 10
const CLUSTER_ROWS = 10

type Toast = LiveLiq & { key: number }
function useBigLiqToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => {
    let k = 0
    return live.onLiquidation((l) => {
      if (l.usd < BIG) return
      const key = ++k + Date.now()
      setToasts((ts) => [...ts.slice(-3), { ...l, key }])
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.key !== key)), 6000)
    })
  }, [])
  return toasts
}

/** Long / Short as a coloured word (long/short is a legitimate red/green use: liquidated longs = selling pressure). */
function Side({ side, className }: { side: 'long' | 'short'; className?: string }) {
  return <span className={clsx('font-medium', side === 'long' ? 'text-down' : 'text-up', className)}>{side === 'long' ? 'Long' : 'Short'}</span>
}

function ShowAll({ open, total, onClick }: { open: boolean; total: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="link mt-2 h-8">
      {open ? t('Mostra meno') : t('Mostra tutti ({n})', { n: total })}
    </button>
  )
}

export default function LiquidationsPage() {
  const [range, setRange] = useState<LiqRange>('7d')
  const q = useLiquidations(range, true)
  const price = usePrice()
  const heatPrice = useThrottledPrice()
  const liveLiqs = useLive((s) => s.liquidations)
  const toasts = useBigLiqToasts()
  const [minUsd, setMinUsd] = useState(0)
  const [feedAll, setFeedAll] = useState(false)
  const [poolsAll, setPoolsAll] = useState(false)
  const [clustersAll, setClustersAll] = useState(false)

  const events = useMemo(() => {
    const rest = q.data?.events ?? []
    const seen = new Set<string>()
    const out: (LiveLiq & { live?: boolean })[] = []
    for (const e of [...liveLiqs.map((l) => ({ ...l, live: true })), ...rest.map((e) => ({ ...e, qty: 0 }))]) {
      const k = `${e.exchange ?? 'binance'}-${e.time}-${e.side}-${Math.round(e.price)}-${Math.round(e.usd)}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(e)
    }
    return out.filter((e) => e.usd >= minUsd).sort((a, b) => b.time - a.time).slice(0, 200)
  }, [liveLiqs, q.data?.events, minUsd])

  const liveTotals = useMemo(() => {
    const cutoff = Date.now() / 1000 - 3600
    let L = 0, S = 0
    // stream + REST history (same list as the live table), so the KPI never contradicts the table
    for (const e of events) if (e.time >= cutoff) { if (e.side === 'long') L += e.usd; else S += e.usd }
    return { L, S }
  }, [events])

  return (
    <div>

      {/* toasts for large liquidations */}
      <div className="pointer-events-none fixed right-4 top-20 z-50 flex w-72 flex-col gap-2">
        {toasts.map((x) => (
          <div key={x.key} className="pointer-events-auto rounded-md border border-line bg-raised px-3 py-2 shadow-pop" style={{ animation: 'bubbleIn 6s ease forwards' }}>
            <div className="label flex items-center gap-2">{t('Grande liquidazione')} <ExchangeBadge ex={x.exchange} /></div>
            <div className="tnum mt-1 text-sm text-fg-2">
              <Side side={x.side} /> <span className="font-semibold text-white">{usdCompact(x.usd)}</span> {tr('a', 'at')} <span className="text-white">{usd(x.price)}</span>
            </div>
          </div>
        ))}
      </div>

      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[560px]" /></div>}>
        {(d) => {
          const tot = d.totals
          const has7d = !tot.collecting_since || Date.now() / 1000 - tot.collecting_since >= 7 * 86400
          const l24 = tot.long_24h, s24 = tot.short_24h
          const since = tot.collecting_since
          const coveredS = since ? Date.now() / 1000 - since : Infinity
          const full24 = coveredS >= 86400
          const longShare = l24 + s24 > 0 ? (l24 / (l24 + s24)) * 100 : null
          const pools = [...d.pools].sort((a, b) => b.price - a.price)
          const clusters = [...d.clusters].sort((a, b) => b.price - a.price)
          const maxCluster = Math.max(1, ...d.clusters.map((x) => x.usd))
          const shownClusters = clustersAll ? clusters : clusters.slice(0, CLUSTER_ROWS)
          const shownEvents = feedAll ? events : events.slice(0, FEED_ROWS)
          // clusters within ±5% of the live price, and the nearest one
          const ref = price ?? null
          const distOf = (c: { price: number; distance: number }) => (ref ? (c.price / ref - 1) * 100 : c.distance)
          const near = d.clusters.filter((c) => Math.abs(distOf(c)) <= 5)
          const nearL = d.near?.long ?? near.filter((c) => c.side === 'long').reduce((a, c) => a + c.usd, 0)
          const nearS = d.near?.short ?? near.filter((c) => c.side === 'short').reduce((a, c) => a + c.usd, 0)
          const hasNear = nearL + nearS > 0
          const nearest = [...d.clusters].sort((a, b) => Math.abs(distOf(a)) - Math.abs(distOf(b)))[0]
          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2 rounded-2xl border border-line bg-surface px-4 py-2.5 text-xs leading-relaxed text-fg-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                <span>
                  {t('Liquidazioni reali da Binance, Bybit e OKX (perpetui BTC). In raccolta: {l}.', {
                    l: EXS.map((x) => `${EX_NAME[x]} ${tot.by_exchange?.[x]?.collecting_since ? t('dal {d}', { d: dateTime(tot.by_exchange[x]!.collecting_since) }) : t('in avvio')}`).join(' · '),
                  })}{' '}
                  {coveredS < 7 * 86400 ? t('I totali coprono solo il periodo raccolto.') + ' ' : ''}
                  {t('Binance trasmette al massimo una liquidazione al secondo per contratto: nei picchi il dato Binance è sottostimato.')}
                </span>
              </div>

              {/* 7-day totals only once 7 days have been collected */}
              <KpiStrip cols={has7d ? 'grid-cols-2 md:grid-cols-4 xl:grid-cols-7' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5'}>
                <KpiCell icon={<ArrowDownRight />} label={t('Long liquidati 24h')} value={usdCompact(l24, 1)} foot={full24 && longShare != null ? t('{p}% del totale 24h', { p: longShare.toFixed(0) }) : t('Solo periodo raccolto')} />
                <KpiCell icon={<ArrowUpRight />} label={t('Short liquidati 24h')} value={usdCompact(s24, 1)} foot={full24 && longShare != null ? t('{p}% del totale 24h', { p: (100 - longShare).toFixed(0) }) : t('Solo periodo raccolto')} />
                {has7d && <KpiCell icon={<CalendarDays />} label={t('Long liquidati 7g')} value={usdCompact(tot.long_7d, 1)} foot={t('Ultimi 7 giorni')} />}
                {has7d && <KpiCell icon={<CalendarDays />} label={t('Short liquidati 7g')} value={usdCompact(tot.short_7d, 1)} foot={t('Ultimi 7 giorni')} />}
                <KpiCell icon={<ShieldAlert />} label={t('A rischio entro ±5%')} value={hasNear ? usdCompact(nearL + nearS, 1) : '—'}
                  foot={hasNear ? <span className="tnum">Long {usdCompact(nearL, 1)} · Short {usdCompact(nearS, 1)}</span> : t('Nessun cluster')} />
                <KpiCell icon={<Crosshair />} label={t('Cluster più vicino')} value={nearest ? usd(nearest.price) : '—'}
                  foot={nearest ? <span className="tnum">{nearest.side === 'long' ? 'Long' : 'Short'} {usdCompact(nearest.usd)} · {pct(distOf(nearest), 2)}</span> : undefined} />
                <KpiCell icon={<Timer />} label={t('Ultima ora (live)')} value={liveTotals.L + liveTotals.S > 0 ? usdCompact(liveTotals.L + liveTotals.S, 1) : '—'}
                  foot={liveTotals.L + liveTotals.S > 0 ? <span className="tnum">Long {usdCompact(liveTotals.L, 1)} · Short {usdCompact(liveTotals.S, 1)}</span> : t('Nessuna liquidazione')} className="col-span-2 md:col-span-1" />
              </KpiStrip>

              <div className="grid gap-3 xl:grid-cols-12">
                <Card className="xl:col-span-9">
                  <CardHeader title={t('Heatmap liquidazioni')} subtitle={d.coverage ? t('Stima da OI aggregato {x} · {p} dell\'OI dei tre exchange · leve 5–100×', { x: d.coverage.exchanges.filter((e) => e.included).map((e) => e.name).join(' + '), p: pct(d.coverage.share_of_three_pct, 0, false) }) : t('Livelli stimati (leva 5–100×) con candele sovrapposte')} icon={<Flame />} updatedAt={q.dataUpdatedAt}
                    info={t('Stima dei prezzi a cui verrebbero liquidate le posizioni aperte, con leve tipiche tra 5× e 100×, alimentata dall\'open interest di Binance, Bybit e OKX (un\'allocazione per exchange). Colori più chiari = maggiore concentrazione stimata. È un modello: vedi la validazione con le liquidazioni reali.')}
                    right={<Segmented value={range} onChange={setRange} options={(['1d', '3d', '7d', '30d'] as const).map((v) => ({ value: v, label: tfLabel(v) }))} />} />
                  <CardBody className="flex flex-col">
                    {d.heatmap.times.length ? <Fill min={600}><LiqHeatmapChart data={d.heatmap} height="100%" livePrice={heatPrice} /></Fill> : <EmptyState text={t('Heatmap non disponibile')} />}
                  </CardBody>
                </Card>
                <div className="flex flex-col gap-3 xl:col-span-3">
                  <Card>
                    <CardHeader title={t('Cluster principale')} icon={<Magnet />} info={t('Il cluster di liquidazioni stimato più consistente vicino al prezzo: il prezzo tende spesso a raggiungere queste zone.')} />
                    <CardBody>
                      {d.magnet ? (
                        <div>
                          <div className="tnum text-3xl font-semibold text-white">{usd(d.magnet.price)}</div>
                          <div className="tnum mt-1 text-xs text-fg-3">
                            {usdCompact(d.magnet.usd, 0)} <Side side={d.magnet.side} className="lowercase" />
                            {price ? <> · {t('{p} dal prezzo', { p: pct((d.magnet.price / price - 1) * 100, 2) })}</> : null}
                          </div>
                        </div>
                      ) : <EmptyState text={t('Nessun cluster dominante')} compact />}
                    </CardBody>
                  </Card>
                  <Card className="flex-1">
                    <CardHeader title={t('Pool di liquidità')} icon={<Droplets />} info={t('Zone con ordini stop accumulati: buy-side sopra i massimi (stop dei venditori), sell-side sotto i minimi (stop dei compratori). La barra indica la forza relativa.')} />
                    <CardBody className="pt-0">
                      {pools.length === 0 ? <EmptyState text={t('Nessun pool rilevato')} compact /> : (
                        <>
                          <div className="flex flex-col">
                            {(poolsAll ? pools : pools.slice(0, POOL_ROWS)).map((p, i) => (
                              <div key={i} className="grid min-h-8 grid-cols-[1fr_56px] items-center gap-x-3 border-t border-line py-1.5 first:border-t-0">
                                <div className="min-w-0">
                                  <div className="tnum text-sm"><span className="font-medium text-white">{usd(p.price)}</span> <span className="text-xs text-fg-3">{p.kind === 'buy_side' ? 'Buy-side' : 'Sell-side'}</span></div>
                                  <div className="text-xs text-fg-3">{poolSource(p.source)}</div>
                                </div>
                                <ProgressBar value={p.strength} className="h-1" />
                              </div>
                            ))}
                          </div>
                          {pools.length > POOL_ROWS && <ShowAll open={poolsAll} total={pools.length} onClick={() => setPoolsAll((v) => !v)} />}
                        </>
                      )}
                    </CardBody>
                  </Card>
                </div>
              </div>

              <LeverageMapCard />

              <div className="grid gap-3 xl:grid-cols-2">
                <ExchangeTotalsCard d={d} />
                <ModelCard d={d} />
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <Card className="h-full">
                  <CardHeader title={t('Cluster vicini al prezzo')} icon={<Layers />} subtitle={price ? t('Distanza dal prezzo live {p}', { p: usd(price) }) : undefined} />
                  <CardBody className="px-0">
                    {clusters.length === 0 ? <EmptyState text={t('Nessun cluster')} compact /> : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="tbl">
                            <thead><tr><th className="pl-4">{t('Prezzo')}</th><th>{t('Lato')}</th><th className="text-right">{t('Stima')}</th><th className="text-right">{t('Distanza')}</th><th className="w-1/4 pr-4">{t('Peso relativo')}</th></tr></thead>
                            <tbody>
                              {shownClusters.map((c, i) => {
                                const dist = price ? (c.price / price - 1) * 100 : c.distance
                                return (
                                  <tr key={i}>
                                    <td className="pl-4 font-medium text-white">{usd(c.price)}</td>
                                    <td><Side side={c.side} /></td>
                                    <td className="text-right">{usdCompact(c.usd)}</td>
                                    <td className="text-right text-fg-2">{pct(dist, 2)}</td>
                                    <td className="pr-4"><ProgressBar value={(c.usd / maxCluster) * 100} className="h-1" /></td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                        {clusters.length > CLUSTER_ROWS && <div className="px-1"><ShowAll open={clustersAll} total={clusters.length} onClick={() => setClustersAll((v) => !v)} /></div>}
                      </>
                    )}
                  </CardBody>
                </Card>
                {/* the live feed is as tall as the clusters card and scrolls inside it */}
                <Card className="h-full xl:h-0 xl:min-h-full">
                  <CardHeader title={t('Liquidazioni live')} subtitle={`Binance · Bybit · OKX${since ? ` · ${t('raccolta dal {d}', { d: date(since) })}` : ''}`} icon={<Radio />}
                    right={<Segmented value={minUsd} onChange={setMinUsd} options={[{ value: 0, label: t('Tutte') }, { value: 10000, label: '>10K' }, { value: 100000, label: '>100K' }, { value: BIG, label: '>500K' }]} />} />
                  <CardBody className="min-h-0 overflow-y-auto px-0">
                    {events.length === 0 ? (
                      <EmptyState text={since ? t('In raccolta dal {d}', { d: date(since) }) : t('Lo stream delle liquidazioni si sta avviando')} />
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="tbl">
                            <thead><tr><th className="pl-4">{tr('Ora', 'Time')}</th><th>Exchange</th><th>{t('Lato')}</th><th className="text-right">{t('Prezzo')}</th><th className="pr-4 text-right">{t('Valore')}</th></tr></thead>
                            <tbody>
                              {shownEvents.map((e, i) => (
                                <tr key={`${e.time}-${e.price}-${e.usd}-${i}`} className={clsx(e.live && i < 3 && 'flash-in')}>
                                  <td className="pl-4 text-fg-3">{time(e.time)}</td>
                                  <td><ExchangeBadge ex={e.exchange} /></td>
                                  <td><Side side={e.side} /></td>
                                  <td className="text-right">{usd(e.price)}</td>
                                  <td className={clsx('pr-4 text-right', e.usd >= BIG ? 'font-semibold text-white' : 'text-fg-2')}>{usdCompact(e.usd)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {events.length > FEED_ROWS && <div className="px-1"><ShowAll open={feedAll} total={events.length} onClick={() => setFeedAll((v) => !v)} /></div>}
                      </>
                    )}
                  </CardBody>
                </Card>
              </div>
            </div>
          )
        }}
      </Q>
    </div>
  )
}

const EXS: LiqExchange[] = ['binance', 'bybit', 'okx']

function ExchangeTotalsCard({ d }: { d: Liquidations }) {
  const by = d.totals.by_exchange ?? {}
  const sum = (k: 'long_24h' | 'short_24h') => EXS.reduce((a, x) => a + (by[x]?.[k] ?? 0), 0)
  const L = sum('long_24h'), S = sum('short_24h')
  return (
    <Card className="h-full">
      <CardHeader icon={<Building2 />} title={t('Liquidazioni reali per exchange')} subtitle={t('Ultime 24 ore · perpetui BTC (USDT, USDC, coin-margined)')}
        info={t('Raccolte in tempo reale dagli stream pubblici: Binance forceOrder (massimo 1 evento al secondo per contratto), Bybit allLiquidation (tutte le liquidazioni), OKX liquidation-orders con recupero REST ogni minuto. Lato = posizione liquidata.')} />
      {/* stretched next to the model card: rows spread over the height, long/short split as footer */}
      <CardBody className="flex flex-col px-0 pt-0">
        <div className="flex-1 overflow-x-auto">
          <table className="tbl min-w-[500px] xl:h-full min-[1700px]:min-w-[600px]">
            <thead><tr><th className="pl-4">Exchange</th><th className="text-right">Long</th><th className="text-right">Short</th><th className="text-right">{t('Totale')}</th><th className="text-right max-[1699px]:hidden">{t('Eventi')}</th><th className="pr-4">{t('In raccolta dal')}</th></tr></thead>
            <tbody>
              {EXS.map((x) => {
                const r = by[x]
                return (
                  <tr key={x}>
                    <td className="pl-4"><span className="inline-flex items-center gap-2"><ExchangeBadge ex={x} /><span className={clsx('h-1.5 w-1.5 rounded-full', r?.connected ? 'bg-accent' : 'bg-fg-off')} title={r?.connected ? t('Stream connesso') : t('Stream non connesso')} /></span></td>
                    <td className="text-right text-fg">{usdCompact(r?.long_24h ?? 0, 1)}</td>
                    <td className="text-right text-fg">{usdCompact(r?.short_24h ?? 0, 1)}</td>
                    <td className="text-right font-medium text-white">{usdCompact((r?.long_24h ?? 0) + (r?.short_24h ?? 0), 1)}</td>
                    <td className="text-right text-fg-2 max-[1699px]:hidden">{int(r?.count_24h ?? 0)}</td>
                    <td className="pr-4 text-fg-3">{r?.collecting_since ? dateTime(r.collecting_since) : t('In avvio')}</td>
                  </tr>
                )
              })}
              <tr>
                <td className="pl-4 font-semibold text-white">{t('Totale')}</td>
                <td className="text-right font-semibold text-white">{usdCompact(L, 1)}</td>
                <td className="text-right font-semibold text-white">{usdCompact(S, 1)}</td>
                <td className="text-right font-semibold text-white">{usdCompact(L + S, 1)}</td>
                <td className="text-right text-fg-2 max-[1699px]:hidden">{int(EXS.reduce((a, x) => a + (by[x]?.count_24h ?? 0), 0))}</td>
                <td className="pr-4 text-fg-3">{d.totals.all_since ? t('Tutti dal {d}', { d: dateTime(d.totals.all_since) }) : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {L + S > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 flex justify-between text-xs text-fg-3">
              <span>Long <b className="tnum font-medium text-down">{((L / (L + S)) * 100).toFixed(0)}%</b></span>
              <span>Short <b className="tnum font-medium text-up">{((S / (L + S)) * 100).toFixed(0)}%</b></span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="bg-down/80" style={{ width: `${(L / (L + S)) * 100}%` }} />
              <div className="bg-up/80" style={{ width: `${(S / (L + S)) * 100}%` }} />
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function ModelCard({ d }: { d: Liquidations }) {
  const c = d.coverage, v = d.validation
  const status = v ? ({ ok: t('Affidabile'), preliminary: t('Preliminare'), insufficient: t('Dati insufficienti') } as const)[v.status] : null
  return (
    <Card className="h-full">
      <CardHeader icon={<BadgeCheck />} title={t('Modello e validazione')} subtitle={t('Copertura dell\'OI e confronto con le liquidazioni reali')}
        info={t('Tempo: per ogni ora si confronta il volume che il modello prevede venga liquidato (livelli attraversati dal prezzo) con quello reale (correlazione di rango) e si conta quante ore di picco reale (10% più alto) erano anche nel quartile alto del modello: per caso sarebbe il 25%. Prezzo: quota del volume reale liquidato dentro le zone dense del modello rispetto a quella attesa per caso (lift).')} />
      <CardBody className="pt-0">
        {c && (
          <div className="mb-3 flex flex-col gap-1.5">
            {c.exchanges.map((e) => (
              <div key={e.id} className="grid grid-cols-[72px_minmax(48px,1fr)_auto] items-center gap-3 text-sm">
                <ExchangeBadge ex={e.id} />
                <ProgressBar value={e.share_pct ?? 0} className="h-1" />
                <span className="tnum whitespace-nowrap text-right text-xs text-fg-2">{pct(e.share_pct, 1, false)} · {usdCompact(e.oi_usd, 2)} · {e.resolution}</span>
              </div>
            ))}
            <p className="tnum mt-1 text-xs text-fg-3">
              {t('Prima: solo Binance BTCUSDT = {a} dell\'OI dei tre exchange. Ora: {b}. Quota dell\'OI perpetuo globale stimata {c} (CoinGecko).', {
                a: pct(c.previous_binance_usdt_share_pct, 0, false), b: pct(c.share_of_three_pct, 0, false), c: pct(c.share_of_global_pct, 0, false),
              })}
            </p>
          </div>
        )}
        {v && (
          <div className="dgrid grid-cols-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
            <div className="min-w-0 px-3 py-2.5"><div className="label truncate">{t('Stato')}</div><div className="mt-1 truncate text-lg font-semibold text-white">{status}</div>
              <div className="tnum truncate text-xs text-fg-3">{t('{h} ore · {n} eventi', { h: v.hours, n: int(v.events) })}</div></div>
            <div className="min-w-0 px-3 py-2.5"><div className="label truncate">{t('Correlazione oraria')}</div><div className="tnum mt-1 truncate text-lg font-semibold text-white">{v.spearman != null ? (v.spearman < 0 ? '−' : '') + Math.abs(v.spearman).toFixed(2) : '—'}</div>
              <div className="truncate text-xs text-fg-3">{t('Spearman, modello vs reale')}</div></div>
            <div className="min-w-0 px-3 py-2.5"><div className="label truncate">{t('Ore di picco colte')}</div><div className="tnum mt-1 truncate text-lg font-semibold text-white">{pct(v.peak_hit_pct, 0, false)}</div>
              <div className="tnum truncate text-xs text-fg-3">{t('{n} ore · per caso {b}', { n: v.peak_hours, b: pct(v.baseline_pct, 0, false) })}</div></div>
            <div className="min-w-0 px-3 py-2.5"><div className="label truncate">{t('Nelle zone dense')}</div><div className="tnum mt-1 truncate text-lg font-semibold text-white">{pct(v.price_hit_pct, 0, false)}</div>
              <div className="tnum truncate text-xs text-fg-3">{t('Per caso {e} · lift {l}', { e: pct(v.price_expected_pct, 0, false), l: v.price_lift != null ? v.price_lift.toFixed(2) + '×' : '—' })}</div></div>
          </div>
        )}
        {v && (
          <p className="mt-3 text-xs leading-relaxed text-fg-3">
            {v.status === 'ok' ? t('Campione: {f} → {to}, exchange {x}.', { f: dateTime(v.from), to: dateTime(v.to), x: v.exchanges.map((x) => EX_NAME[x]).join(', ') })
              : t('Campione ancora piccolo ({h} ore, exchange: {x}): i numeri sono indicativi e diventano significativi dopo alcuni giorni di raccolta e almeno un movimento ampio del prezzo.', { h: v.hours, x: v.exchanges.map((x) => EX_NAME[x]).join(', ') || '—' })}
            {' '}{c ? t('Ipotesi: leve {l}; margine di mantenimento {m}; quota long = {s}.', { l: c.assumptions.leverage.map((x) => `${x.lev}× ${x.weight.toFixed(0)}%`).join(', '), m: pct(c.assumptions.mmr_pct, 1, false), s: c.assumptions.long_share }) : ''}
          </p>
        )}
      </CardBody>
    </Card>
  )
}
