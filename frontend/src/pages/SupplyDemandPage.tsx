import { useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowDownUp, BarChart3, BookOpen, Building2, CalendarRange, Clock, Coins, Eye, Flame, Gauge, History, Landmark, Layers, ListChecks,
  MessageSquareText, Mountain, Percent, Pickaxe, Repeat, Sigma, TrendingDown, TrendingUp, Vault, Waves,
} from 'lucide-react'
import {
  useAttention, useEtf, useExchanges, type AttentionData, type AttentionZone, type EtfData, type ExchangesData, type FlowRegime, type FwdBlock,
} from '../api/supplyDemand'
import { C, hexA } from '../components/charts/theme'
import {
  Badge, Card, CardBody, CardHeader, Change, Fill, KpiCell, KpiStrip, Legend, MethodNote, PageTitle, Q, Segmented, Skeleton, TabBar, Toggle, clsx,
} from '../components/ui'
import { getLang, t, tr } from '../i18n'
import { useTab } from '../lib/useTab'
import { DASH, date, dayUnit, pct, usd } from '../lib/format'
import { TimeLinesChart } from '../widgets/charts'
import {
  AttentionChart, EtfFlowsChart, ISSUER_COLORS, ISSUER_NAME, MonthlyAbsorptionChart, NetflowBars, RatioChart, ReservesChart, btcAmt, fin, intg, mult, sfx, usdM,
} from '../widgets/supplyDemand'

const TW = '-mx-4 overflow-x-auto no-scrollbar sm:-mx-5'
const TL = 'pl-4 sm:pl-5'
const TR = 'pr-4 text-right sm:pr-5'
const unit = (s: string) => <span className="ml-1 text-sm font-normal text-slate-400">{s}</span>
const PageSkeleton = () => <div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[380px]" /><Skeleton className="h-[300px]" /></div>

/** Labels: Italian source strings, translated at render. */
const REGIME_LABEL: Record<FlowRegime, string> = {
  deflussi_forti: 'Deflussi forti', deflussi: 'Deflussi', neutro: 'Neutro', afflussi: 'Afflussi', afflussi_forti: 'Afflussi forti',
}
const REGIME_RANGE: Record<FlowRegime, string> = {
  deflussi_forti: 'z ≤ −1.5', deflussi: '−1.5 < z ≤ −0.5', neutro: '−0.5 < z ≤ 0.5', afflussi: '0.5 < z ≤ 1.5', afflussi_forti: 'z > 1.5',
}
const ZONE_LABEL: Record<AttentionZone, string> = {
  bassa: 'Bassa', sotto_media: 'Sotto la media', sopra_media: 'Sopra la media', alta: 'Alta', estrema: 'Estrema',
}
const regimeLabel = (r: FlowRegime | null | undefined) => (r ? t(REGIME_LABEL[r]) : DASH)

function Stat({ k, v, sub }: { k: ReactNode; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="label truncate">{k}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-white">{v}</div>
      {sub && <div className="truncate text-xs text-slate-400">{sub}</div>}
    </div>
  )
}

function Bullets({ items }: { items: { text: ReactNode; tone?: 'bullish' | 'bearish' | 'neutral' }[] }) {
  const dot = { bullish: 'bg-up', bearish: 'bg-down', neutral: 'bg-slate-400' }
  return (
    // in a stretched side card the bullets spread over the free height
    <ul className="flex flex-1 flex-col justify-around">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2.5 border-t border-line py-2 text-sm leading-relaxed text-slate-300 first:border-t-0 first:pt-0">
          <span className={clsx('mt-2 h-1.5 w-1.5 shrink-0 rounded-full', dot[s.tone ?? 'neutral'])} />
          <span>{s.text}</span>
        </li>
      ))}
    </ul>
  )
}

function Notice({ icon, children, tone = 'muted' }: { icon: ReactNode; children: ReactNode; tone?: 'muted' | 'amber' }) {
  return (
    <div className={clsx('flex items-start gap-2 rounded-lg border px-3 py-1.5 text-xs',
      tone === 'amber' ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : 'border-white/[0.06] bg-white/[0.03] text-slate-300')}>
      <span className={clsx('mt-px shrink-0', tone === 'amber' ? 'text-amber-400' : 'text-slate-400')}>{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}

/** Verification line: ✓ / ! + text. */
function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p className="flex gap-2">
      <span className={clsx('shrink-0 font-semibold', ok ? 'text-up' : 'text-amber-400')}>{ok ? '✓' : '!'}</span>
      <span>{children}</span>
    </p>
  )
}

/** Forward-return cells: median (coloured) · share positive. */
function Fwd({ b, h }: { b: FwdBlock; h: 7 | 30 | 90 | 180 }) {
  const r = b[`r${h}` as const] as number | null | undefined
  const hit = b[`hit${h}` as const] as number | null | undefined
  return <><Change value={r ?? null} digits={1} /> <span className="text-xs text-slate-400">· {fin(hit) ? `${hit.toFixed(0)}%` : DASH}</span></>
}

const du = () => dayUnit()
/** Ordinal percentile: IT "3°" · EN "3rd". */
const ord = (v: number | null | undefined) => {
  if (!fin(v)) return DASH
  const n = Math.round(v)
  if (getLang() !== 'en') return `${n}°`
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${s}`
}

// ===================================================================== EXCHANGE
function ExchangeKpis({ d }: { d: ExchangesData }) {
  const k = d.kpi
  return (
    <KpiStrip>
      <KpiCell icon={<Vault />} label={t('Riserve sugli exchange')} value={<>{btcAmt(k.reserve, false, false)}{unit('BTC')}</>} foot={t("{p}% dell'offerta in circolazione", { p: fin(k.reserve_pct) ? k.reserve_pct.toFixed(2) : DASH })} />
      <KpiCell icon={<CalendarRange />} label={t('Variazione 1 anno')} value={<>{btcAmt(k.reserve_change_365d, true, false)}{unit('BTC')}</>}
        foot={t("{p} · {s} pt dell'offerta", { p: pct(k.reserve_change_365d_pct, 2), s: sfx(k.share_change_365d_pt, 2) })} />
      <KpiCell icon={<ArrowDownUp />} label={t('Flusso netto {d}', { d: date(d.as_of, false) })} value={<>{btcAmt(k.net_1d, true, false)}{unit('BTC')}</>}
        foot={t('Entrate {a} · uscite {b}', { a: btcAmt(k.inflow_1d, false, false), b: btcAmt(k.outflow_1d, false, false) })} />
      <KpiCell icon={<Waves />} label={t('Flusso netto 30 giorni')} value={<>{btcAmt(k.net_30d, true, false)}{unit('BTC')}</>}
        foot={`7${du()} ${btcAmt(k.net_7d, true, false)} · 90${du()} ${btcAmt(k.net_90d, true, false)}`} />
      <KpiCell icon={<Sigma />} label={t('Z-score flusso 30 giorni')} value={sfx(k.z_30d, 2)} foot={t('Regime: {r}', { r: regimeLabel(k.regime).toLowerCase() })} />
      <KpiCell icon={<TrendingDown />} label={t('Riserve ai minimi dal')} value={k.lowest_since ? date(k.lowest_since) : DASH}
        foot={t('Massimo {v} · {d}', { v: btcAmt(k.reserve_ath), d: date(k.reserve_ath_time) })} />
    </KpiStrip>
  )
}

function exchangeReading(d: ExchangesData) {
  const k = d.kpi
  const out: { text: ReactNode; tone?: 'bullish' | 'bearish' | 'neutral' }[] = []
  const n30 = k.net_30d ?? 0
  out.push({
    tone: n30 < 0 ? 'bullish' : n30 > 0 ? 'bearish' : 'neutral',
    text: n30 < 0
      ? t("Negli ultimi 30 giorni sono usciti dagli exchange {v} netti (z {z}): regime «{r}». Le monete ritirate di solito vanno in custodia propria o presso custodi non coperti dai dati, e riducono l'offerta pronta alla vendita.", { v: btcAmt(-n30), z: sfx(k.z_30d, 2), r: regimeLabel(k.regime).toLowerCase() })
      : t('Negli ultimi 30 giorni sono entrati negli exchange {v} netti (z {z}): regime «{r}». Afflussi elevati spesso precedono vendite, ma possono essere anche collaterale per derivati.', { v: btcAmt(n30), z: sfx(k.z_30d, 2), r: regimeLabel(k.regime).toLowerCase() }),
  })
  const cur = d.regimes.rows.find((r) => r.key === k.regime)
  if (cur) {
    out.push({
      text: t('Dal {s}, nei giorni nello stesso regime BTC ha reso in mediana {a} a 90 giorni (positivi {h}%), contro {b} di tutti i giorni. Sono {e} episodi indipendenti su {n} giorni sovrapposti: indicazione, non previsione.', {
        s: date(d.regimes.since), a: pct(cur.r90, 1), h: fin(cur.hit90) ? cur.hit90.toFixed(0) : DASH, b: pct(d.regimes.baseline.r90, 1), e: cur.episodes, n: intg(cur.days),
      }),
    })
  }
  out.push({
    text: t("Le riserve sono {r} ({p}% dell'offerta), ai minimi dal {d}; in un anno {c} ({cp}). Il massimo resta {m} del {md}.", {
      r: btcAmt(k.reserve), p: fin(k.reserve_pct) ? k.reserve_pct.toFixed(2) : DASH, d: date(k.lowest_since), c: btcAmt(k.reserve_change_365d, true),
      cp: pct(k.reserve_change_365d_pct, 2), m: btcAmt(k.reserve_ath), md: date(k.reserve_ath_time),
    }),
  })
  const ph = d.phases[d.phases.length - 1]
  if (ph) {
    const same = d.phases.filter((p) => p.kind === ph.kind && !p.ongoing)
    const avg = same.length ? same.reduce((a, p) => a + (p.avg_daily_net ?? 0), 0) / same.length : null
    out.push({
      text: t('Fase di ciclo in corso: {k} dal {s} ({n} giorni). Flusso medio {a} al giorno, uscite nel {o}% dei giorni; media delle fasi di {k} precedenti {b} al giorno.', {
        k: ph.kind === 'rialzo' ? tr('rialzo', 'uptrend') : tr('ribasso', 'downtrend'), s: date(ph.start), n: intg(ph.days), a: btcAmt(ph.avg_daily_net, true),
        o: fin(ph.outflow_days_pct) ? ph.outflow_days_pct.toFixed(0) : DASH, b: btcAmt(avg, true),
      }),
    })
  }
  return out
}

function ReservesCard({ d, updatedAt }: { d: ExchangesData; updatedAt: number }) {
  const [mode, setMode] = useState<'btc' | 'pct'>('btc')
  const [log, setLog] = useState(true)
  return (
    <Card className="h-full">
      <CardHeader icon={<Landmark />} updatedAt={updatedAt} interval={10 * 60_000} title={t('Riserve degli exchange vs prezzo')}
        subtitle={t('BTC sugli indirizzi exchange coperti da CoinMetrics · dal 2012')}
        info={t("Saldo dei BTC sugli indirizzi attribuiti agli exchange. Il livello dipende dalla copertura degli indirizzi di CoinMetrics: Glassnode e CryptoQuant usano cluster diversi e mostrano livelli diversi, ma la direzione è confrontabile.")}
        right={<>
          <Segmented options={[{ value: 'btc' as const, label: 'BTC' }, { value: 'pct' as const, label: t('% offerta') }]} value={mode} onChange={setMode} />
          <Toggle on={log} onClick={() => setLog(!log)}>{t('Prezzo log')}</Toggle>
        </>} />
      <CardBody className="flex flex-col"><Fill min={300}>
        <ReservesChart reserve={mode === 'btc' ? d.series.reserve : d.series.reserve_pct} price={d.series.price} mode={mode} logPrice={log} height="100%" />
      </Fill></CardBody>
    </Card>
  )
}

function NetflowCard({ d }: { d: ExchangesData }) {
  const [v, setV] = useState<'daily' | 'weekly' | 'rolling'>('daily')
  return (
    <Card>
      <CardHeader icon={<BarChart3 />} title={t('Flusso netto verso gli exchange')}
        subtitle={v === 'daily' ? t('Giornaliero, ultimi 12 mesi · entrate − uscite (BTC)') : v === 'weekly' ? t('Somma settimanale dal 2015 (BTC)') : t('Somme mobili a 30 e 90 giorni (BTC)')}
        info={t('Positivo (rosso) = più BTC entrati che usciti: potenziale offerta in vendita. Negativo (verde) = più BTC ritirati: accumulo o spostamento in custodia.')}
        right={<Segmented options={[{ value: 'daily' as const, label: tr('Giornaliero', 'Daily') }, { value: 'weekly' as const, label: tr('Settimanale', 'Weekly') }, { value: 'rolling' as const, label: t('Somme mobili') }]} value={v} onChange={setV} />} />
      <CardBody className="flex flex-col gap-2">
        {v !== 'rolling' && <Legend items={[{ label: t('Uscite nette (verde)'), color: C.up }, { label: t('Entrate nette (rosso)'), color: C.down }]} />}
        {v === 'daily' && <NetflowBars data={d.series.net_daily} height={300} unitLabel={tr('giornaliero', 'daily')} />}
        {v === 'weekly' && <NetflowBars data={d.series.net_weekly} height={300} zoom unitLabel={tr('settimana', 'week')} />}
        {v === 'rolling' && (
          <TimeLinesChart height={300} zoom yFmt={(x) => btcAmt(x, true, false)} markLines={[{ y: 0, color: hexA(C.grey, 0.5) }]}
            lines={[{ name: t('Flusso netto 30 giorni'), data: d.series.net30, color: C.blue }, { name: t('Flusso netto 90 giorni'), data: d.series.net90, color: C.purple }]} />
        )}
      </CardBody>
    </Card>
  )
}

function RegimesCard({ d }: { d: ExchangesData }) {
  const cur = d.kpi.regime
  return (
    <Card className="h-full">
      <CardHeader icon={<History />} title={t('Rendimenti dopo i regimi di flusso')} subtitle={t('Z-score del flusso netto a 30 giorni · dal {d}', { d: date(d.regimes.since) })}
        info={t('Ogni giorno è classificato con lo z-score del flusso netto a 30 giorni rispetto ai 2 anni precedenti (solo dati passati). Le colonne riportano il rendimento mediano di BTC a 30/90/180 giorni e la quota di casi positivi. I giorni consecutivi si sovrappongono: il campione indipendente è il numero di episodi.')} />
      <CardBody>
        <div className={TW}>
          <table className="tbl min-w-[620px]">
            <thead><tr>
              <th className={TL}>{tr('Regime', 'Regime')}</th><th className="text-right">{tr('Giorni', 'Days')}</th><th className="text-right">{tr('Episodi', 'Episodes')}</th>
              <th className="text-right">{`30${du()}`}</th><th className="text-right">{`90${du()}`}</th><th className={TR}>{`180${du()}`}</th>
            </tr></thead>
            <tbody>
              {d.regimes.rows.map((r) => (
                <tr key={r.key}>
                  <td className={clsx(TL, r.key === cur ? 'font-medium text-white' : 'text-slate-200')}>
                    {t(REGIME_LABEL[r.key])} <span className="text-xs text-slate-400">{REGIME_RANGE[r.key]}</span>
                    {r.key === cur && <Badge color="blue" className="ml-2">{tr('Ora', 'Now')}</Badge>}
                  </td>
                  <td className="text-right text-slate-300">{intg(r.days)}</td>
                  <td className="text-right text-slate-300">{r.episodes}</td>
                  <td className="text-right"><Fwd b={r} h={30} /></td>
                  <td className="text-right"><Fwd b={r} h={90} /></td>
                  <td className={TR}><Fwd b={r} h={180} /></td>
                </tr>
              ))}
              <tr>
                <td className={clsx(TL, 'text-slate-400')}>{t('Tutti i giorni')}</td>
                <td className="text-right text-slate-400">{intg(d.regimes.baseline.days)}</td><td className="text-right text-slate-400">—</td>
                <td className="text-right"><Fwd b={d.regimes.baseline} h={30} /></td>
                <td className="text-right"><Fwd b={d.regimes.baseline} h={90} /></td>
                <td className={TR}><Fwd b={d.regimes.baseline} h={180} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="label mb-1 mt-4">{t('Singoli giorni estremi (|z| ≥ 2)')}</div>
        <div className="dgrid grid-cols-1 sm:grid-cols-3">
          <Stat k={t('Grandi uscite · {n} giorni', { n: d.regimes.daily.outflow.days })} v={<Fwd b={d.regimes.daily.outflow} h={30} />} sub={t('Mediana a 30 giorni · positivi')} />
          <Stat k={t('Grandi entrate · {n} giorni', { n: d.regimes.daily.inflow.days })} v={<Fwd b={d.regimes.daily.inflow} h={30} />} sub={t('Mediana a 30 giorni · positivi')} />
          <Stat k={t('Tutti i giorni')} v={<Fwd b={d.regimes.daily.baseline} h={30} />} sub={t('Mediana a 30 giorni · positivi')} />
        </div>
      </CardBody>
    </Card>
  )
}

function ExtremesCard({ d }: { d: ExchangesData }) {
  const [side, setSide] = useState<'outflows' | 'inflows'>('outflows')
  const rows = d.extremes[side]
  return (
    <Card className="h-full">
      <CardHeader icon={<Flame />} title={t('Giorni di flusso estremo')} subtitle={t('Primi 10 per z-score giornaliero dal 2015 (episodi distinti)')}
        info={t('Z-score = flusso netto del giorno rispetto a media e deviazione standard dei 365 giorni precedenti. Alcuni picchi isolati possono essere spostamenti interni tra wallet dello stesso exchange, non distinguibili nei dati.')}
        right={<Segmented options={[{ value: 'outflows' as const, label: tr('Uscite', 'Outflows') }, { value: 'inflows' as const, label: tr('Entrate', 'Inflows') }]} value={side} onChange={setSide} />} />
      <CardBody>
        <div className={TW}>
          <table className="tbl min-w-[560px]">
            <thead><tr>
              <th className={TL}>{tr('Data', 'Date')}</th><th className="text-right">{t('Netto')}</th><th className="text-right">z</th>
              <th className="text-right">{t('Prezzo')}</th><th className="text-right">{`30${du()}`}</th><th className={TR}>{`90${du()}`}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.time}>
                  <td className={clsx(TL, 'text-slate-200')}>{date(r.time)}</td>
                  <td className={clsx('text-right font-medium', (r.net ?? 0) > 0 ? 'text-down' : 'text-up')}>{btcAmt(r.net, true, false)}</td>
                  <td className="text-right text-slate-300">{sfx(r.z, 1)}</td>
                  <td className="text-right text-slate-300">{usd(r.price, 0)}</td>
                  <td className="text-right"><Change value={r.r30} digits={1} /></td>
                  <td className={TR}><Change value={r.r90} digits={1} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function PhasesCard({ d }: { d: ExchangesData }) {
  return (
    <Card>
      <CardHeader icon={<Repeat />} title={t('Riserve per fase di ciclo')} subtitle={t('Gambe minimo → massimo (rialzo) e massimo → minimo (ribasso) dal 2015')}
        info={t("Massimi e minimi di ciclo dello stesso modulo Cicli. Variazione delle riserve tra inizio e fine della fase e flusso netto medio giornaliero. Nel 2015–2018 la crescita delle riserve riflette anche l'aumento della copertura degli indirizzi.")} />
      <CardBody>
        <div className={TW}>
          <table className="tbl min-w-[760px]">
            <thead><tr>
              <th className={TL}>{tr('Fase', 'Phase')}</th><th>{tr('Periodo', 'Period')}</th><th className="text-right">{t('Prezzo')}</th>
              <th className="text-right">{t('Riserve')}</th><th className="text-right">{t("Quota dell'offerta")}</th><th className="text-right">{t('Flusso medio/giorno')}</th><th className={TR}>{t('Giorni in uscita')}</th>
            </tr></thead>
            <tbody>
              {[...d.phases].reverse().map((p) => (
                <tr key={p.start}>
                  <td className={TL}>
                    <Badge color={p.kind === 'rialzo' ? 'up' : 'down'}>{p.kind === 'rialzo' ? tr('Rialzo', 'Uptrend') : tr('Ribasso', 'Downtrend')}</Badge>
                    {p.ongoing && <Badge color="blue" className="ml-1.5">{tr('In corso', 'Ongoing')}</Badge>}
                  </td>
                  <td className="text-slate-300">{date(p.start)} – {p.ongoing ? tr('oggi', 'today') : date(p.end)} <span className="text-xs text-slate-400">{intg(p.days)}{du()}</span></td>
                  <td className="text-right"><Change value={p.price_change} digits={0} /></td>
                  <td className="text-right text-slate-200">{btcAmt(p.reserve_change, true, false)} <span className="text-xs text-slate-400">{pct(p.reserve_change_pct, 1)}</span></td>
                  <td className="text-right text-slate-300">{sfx(p.share_change_pt, 2)} pt</td>
                  <td className={clsx('text-right font-medium', (p.avg_daily_net ?? 0) > 0 ? 'text-down' : 'text-up')}>{btcAmt(p.avg_daily_net, true)}</td>
                  <td className={clsx(TR, 'text-slate-300')}>{fin(p.outflow_days_pct) ? `${p.outflow_days_pct.toFixed(0)}%` : DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function RecentFlowsCard({ d }: { d: ExchangesData }) {
  return (
    <Card>
      <CardHeader icon={<ListChecks />} title={t('Ultimi 30 giorni')} subtitle={t('Entrate, uscite e saldo giornaliero · valori «flash» rivedibili')} />
      <CardBody>
        <div className={clsx(TW, 'max-h-[420px] overflow-y-auto')}>
          <table className="tbl min-w-[560px]">
            <thead className="sticky top-0 z-10 bg-[#0E1424]"><tr>
              <th className={TL}>{tr('Data', 'Date')}</th><th className="text-right">{t('Entrate')}</th><th className="text-right">{t('Uscite')}</th>
              <th className="text-right">{t('Netto')}</th><th className="text-right">z</th><th className={TR}>{t('Riserve')}</th>
            </tr></thead>
            <tbody>
              {d.recent.map((r, i) => (
                <tr key={r.time}>
                  <td className={clsx(TL, 'text-slate-200')}>{date(r.time)}{i === 0 && r.flash && <Badge className="ml-2">flash</Badge>}</td>
                  <td className="text-right text-slate-300">{intg(r.inflow)}</td>
                  <td className="text-right text-slate-300">{intg(r.outflow)}</td>
                  <td className={clsx('text-right font-medium', (r.net ?? 0) > 0 ? 'text-down' : 'text-up')}>{intg(r.net, true)}</td>
                  <td className="text-right text-slate-300">{sfx(r.z, 1)}</td>
                  <td className={clsx(TR, 'text-slate-300')}>{intg(r.reserve)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function ExchangeTab() {
  const q = useExchanges()
  return (
    <Q q={q} loading={<PageSkeleton />} isEmpty={(d) => !d.series?.reserve?.length}>
      {(d) => {
        const c = d.checks
        return (
          <div className="flex flex-col gap-3">
            <Notice icon={<Clock size={14} />}>
              {t('CoinMetrics community, 1 giorno di ritardo · ultimo dato {d} · tutti i valori sono «flash» (preliminari, rivedibili) e vengono ricaricati per intero a ogni aggiornamento', { d: date(d.as_of) })}
            </Notice>
            <ExchangeKpis d={d} />
            <div className="grid gap-3 xl:grid-cols-3">
              <div className="xl:col-span-2"><ReservesCard d={d} updatedAt={q.dataUpdatedAt} /></div>
              <Card className="h-full">
                <CardHeader icon={<MessageSquareText />} title={tr('Lettura', 'Reading')} subtitle={t('Cosa dicono riserve e flussi oggi')} />
                <CardBody className="flex flex-col"><Bullets items={exchangeReading(d)} /></CardBody>
              </Card>
            </div>
            <NetflowCard d={d} />
            <div className="grid items-start gap-3 xl:grid-cols-2">
              <RegimesCard d={d} />
              <ExtremesCard d={d} />
            </div>
            <PhasesCard d={d} />
            <RecentFlowsCard d={d} />
            <MethodNote title={t('Fonti, metodo e verifiche')}>
              <p>{t('Fonte: CoinMetrics Community API, metriche SplyExNtv (saldo exchange), FlowInExNtv e FlowOutExNtv (afflussi e deflussi giornalieri, BTC), SplyCur (offerta) e IssTotNtv (emissione). Gratuite, nessuna chiave. Statistiche dal {s}: prima la copertura degli indirizzi exchange era incompleta.', { s: date(d.stats_since) })}</p>
              <p>{t('Z-score giornaliero sui 365 giorni precedenti; z-score del flusso a 30 giorni sui 2 anni precedenti. Rendimenti successivi calcolati sulla chiusura giornaliera di BTC.')}</p>
              <Check ok={Math.abs((c.black_thursday.inflow ?? 0) - c.black_thursday.expected_inflow) < 5000}>
                {t('Black Thursday {d}: afflussi {v} (valore pubblico noto ≈ 191K BTC).', { d: date(c.black_thursday.date), v: btcAmt(c.black_thursday.inflow) })}
              </Check>
              <Check ok={Math.abs((c.ftx.net ?? 0) - c.ftx.expected_net) < 2000}>
                {t('Crollo di FTX {d}: flusso netto {v} (deflusso netto ≈ −34.8K BTC).', { d: date(c.ftx.date), v: btcAmt(c.ftx.net, true) })}
              </Check>
              <Check ok={(c.identity_ok_pct ?? 0) > 90}>
                {t("Coerenza interna: nel {p}% dei {n} giorni la variazione delle riserve coincide con entrate − uscite (±1 BTC). {a} giorni con scarti > 1,000 BTC (totale {b}) sono rettifiche di copertura degli indirizzi, non flussi.", { p: fin(c.identity_ok_pct) ? c.identity_ok_pct.toFixed(1) : DASH, n: intg(c.identity_days), a: c.adjustments, b: btcAmt(c.adjustment_btc) })}
              </Check>
              <Check ok>{t('Emissione media 30 giorni {v} BTC/giorno (3.125 BTC × ~144 blocchi = 450 dopo il halving di aprile 2024).', { v: fin(c.issuance_30d_avg) ? c.issuance_30d_avg.toFixed(1) : DASH })}</Check>
              <p>{t('Limiti: il livello delle riserve dipende da quali indirizzi CoinMetrics attribuisce agli exchange; gli ETF e molti custodi non sono inclusi, quindi i deflussi verso di loro risultano come uscite. Analisi a scopo di studio, non consulenza finanziaria.')}</p>
            </MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

// ===================================================================== ETF
function EtfKpis({ d }: { d: EtfData }) {
  const k = d.kpi
  const cur = d.streaks.current
  const longest = cur && cur.sign < 0 ? d.streaks.longest_out : d.streaks.longest_in
  return (
    <KpiStrip>
      <KpiCell icon={<Building2 />} label={t('Seduta {d}', { d: date(d.as_of, false) })} value={usdM(k.last_usd)}
        foot={t('{b} stimati · provvisorio', { b: btcAmt(k.last_btc, true) })} />
      <KpiCell icon={<CalendarRange />} label={t('Ultime 5 sedute')} value={usdM(k.d5_usd)} foot={t('{b} stimati', { b: btcAmt(k.d5_btc, true) })} />
      <KpiCell icon={<BarChart3 />} label={t('Ultime 20 sedute')} value={usdM(k.d20_usd)} foot={t('{b} stimati', { b: btcAmt(k.d20_btc, true) })} />
      <KpiCell icon={<Layers />} label={t('Flusso netto dal lancio')} value={usdM(k.cum_usd, false)} foot={t('≈ {b} stimati · {n} sedute', { b: btcAmt(k.cum_btc), n: k.days })} />
      <KpiCell icon={<Pickaxe />} label={t('Assorbimento 30 giorni')} value={mult(k.ratio_30d)}
        foot={t('ETF {a} · miner {b}', { a: btcAmt(k.etf_30d_btc, true, false), b: btcAmt(k.issued_30d, false, false) })} />
      <KpiCell icon={cur && cur.sign < 0 ? <TrendingDown /> : <TrendingUp />} label={cur && cur.sign < 0 ? t('Serie di deflussi') : t('Serie di afflussi')}
        value={cur ? <>{cur.days}{unit(cur.days === 1 ? tr('seduta', 'session') : tr('sedute', 'sessions'))}</> : DASH}
        foot={longest ? t('Record {n} sedute · {v}', { n: longest.days, v: usdM(longest.usd) }) : undefined} />
    </KpiStrip>
  )
}

function etfReading(d: EtfData) {
  const k = d.kpi
  const out: { text: ReactNode; tone?: 'bullish' | 'bearish' | 'neutral' }[] = []
  const tone = (v: number | null) => (fin(v) ? (v > 0 ? 'bullish' : v < 0 ? 'bearish' : 'neutral') : 'neutral') as 'bullish' | 'bearish' | 'neutral'
  out.push({ tone: tone(k.last_usd), text: t('Seduta del {d} (provvisoria): {u}, circa {b}. Nelle ultime 5 sedute {u5}, nelle ultime 20 {u20}.', {
    d: date(d.as_of), u: usdM(k.last_usd), b: btcAmt(k.last_btc, true), u5: usdM(k.d5_usd), u20: usdM(k.d20_usd) }) })
  if (fin(k.ratio_30d)) {
    out.push({ tone: tone(k.ratio_30d), text: k.ratio_30d >= 0
      ? t("Negli ultimi 30 giorni gli ETF hanno comprato in netto {a} contro {b} emessi dai miner: {r} dell'emissione. Sopra 1× la domanda degli ETF da sola supera la nuova offerta.", { a: btcAmt(k.etf_30d_btc), b: btcAmt(k.issued_30d), r: mult(k.ratio_30d) })
      : t('Negli ultimi 30 giorni gli ETF hanno venduto in netto {a} mentre i miner ne emettevano {b}: gli ETF aggiungono offerta invece di assorbirla.', { a: btcAmt(-(k.etf_30d_btc ?? 0)), b: btcAmt(k.issued_30d) }) })
  }
  const pl = d.absorption.post_halving
  out.push({ text: t('Dal halving del {d} gli ETF hanno assorbito {a} contro {b} emessi ({r}).', { d: date(pl.since), a: btcAmt(pl.etf_btc), b: btcAmt(pl.issued_btc), r: mult(pl.ratio) }) })
  const s = d.streaks.current
  if (s) {
    out.push({ tone: s.sign > 0 ? 'bullish' : 'bearish', text: s.days === 1
      ? (s.sign > 0 ? t('Ultima seduta in afflusso ({u}) dopo una seduta di segno opposto o nulla.', { u: usdM(s.usd) }) : t('Ultima seduta in deflusso ({u}) dopo una seduta di segno opposto o nulla.', { u: usdM(s.usd) }))
      : s.sign > 0
      ? t('Serie in corso: {n} sedute consecutive di afflussi ({u}).', { n: s.days, u: usdM(s.usd) })
      : t('Serie in corso: {n} sedute consecutive di deflussi ({u}).', { n: s.days, u: usdM(s.usd) }) })
  }
  const r = d.reaction
  out.push({ text: t('Dopo sedute con afflussi ≥ $500M ({n}) il rendimento mediano a 30 giorni è stato {a}, dopo deflussi ≤ −$500M ({m}) {b}, contro {c} di tutte le sedute: i grandi flussi tendono a seguire il prezzo più che anticiparlo. Campione piccolo.', {
    n: r.big_in.days, a: pct(r.big_in.r30, 1), m: r.big_out.days, b: pct(r.big_out.r30, 1), c: pct(r.all.r30, 1) }) })
  return out
}

type Range = '3m' | '6m' | '1y' | 'all'
function EtfFlowsCard({ d, updatedAt }: { d: EtfData; updatedAt: number }) {
  const [range, setRange] = useState<Range>('6m')
  const [u, setU] = useState<'usd' | 'btc'>('usd')
  const start = useMemo(() => {
    const last = d.daily.dates[d.daily.dates.length - 1] ?? 0
    const days = { '3m': 92, '6m': 183, '1y': 366, all: 99999 }[range]
    return last - days * 86400
  }, [d, range])
  return (
    <Card className="h-full">
      <CardHeader icon={<BarChart3 />} updatedAt={updatedAt} interval={5 * 60_000} title={t('Flussi giornalieri per emittente')}
        subtitle={u === 'usd' ? t('Milioni di USD per seduta · linea = cumulato dal lancio (asse destro)') : t('BTC stimati per seduta (flusso ÷ prezzo alle 16:00 di New York)')}
        info={t("Creazioni e rimborsi netti di quote comunicati dagli emittenti (fonte Farside). L'ultima seduta è provvisoria: alcuni emittenti pubblicano il dato in ritardo e Farside può correggerlo.")}
        right={<>
          <Segmented options={[{ value: '3m' as Range, label: tr('3M', '3M') }, { value: '6m' as Range, label: '6M' }, { value: '1y' as Range, label: tr('1A', '1Y') }, { value: 'all' as Range, label: tr('Tutto', 'All') }]} value={range} onChange={setRange} />
          <Segmented options={[{ value: 'usd' as const, label: 'USD' }, { value: 'btc' as const, label: 'BTC' }]} value={u} onChange={setU} />
        </>} />
      <CardBody className="flex flex-col"><Fill min={320}><EtfFlowsChart d={d.daily} start={start} unit={u} height="100%" /></Fill></CardBody>
    </Card>
  )
}

function AbsorptionCard({ d }: { d: EtfData }) {
  const [v, setV] = useState<'ratio' | 'monthly'>('ratio')
  const a = d.absorption
  return (
    <Card className="h-full">
      <CardHeader icon={<Pickaxe />} title={t("Assorbimento dell'offerta")} subtitle={v === 'ratio' ? t('BTC netti degli ETF ÷ BTC emessi dai miner · finestra mobile 30 giorni') : t('BTC netti degli ETF vs BTC emessi, per mese')}
        info={t("Rapporto tra i BTC comprati (o venduti) in netto dagli ETF e i BTC nuovi creati dai miner nello stesso periodo (CoinMetrics IssTotNtv, ~450 BTC al giorno dopo il halving dell'aprile 2024). 2× = gli ETF hanno assorbito il doppio della nuova offerta; negativo = vendite nette.")}
        right={<Segmented options={[{ value: 'ratio' as const, label: t('Rapporto 30 giorni') }, { value: 'monthly' as const, label: tr('Mensile', 'Monthly') }]} value={v} onChange={setV} />} />
      <CardBody className="flex flex-col gap-3">
        <div className="dgrid grid-cols-2 md:grid-cols-4">
          <Stat k={t('Dal lancio')} v={mult(a.since_launch.ratio)} sub={t('{a} vs {b}', { a: btcAmt(a.since_launch.etf_btc), b: btcAmt(a.since_launch.issued_btc) })} />
          <Stat k={t('Dal halving 2024')} v={mult(a.post_halving.ratio)} sub={t('{a} vs {b}', { a: btcAmt(a.post_halving.etf_btc), b: btcAmt(a.post_halving.issued_btc) })} />
          <Stat k={t('Ultimi 30 giorni')} v={mult(d.kpi.ratio_30d)} sub={t('Al {d}', { d: date(d.kpi.ratio_30d_time) })} />
          <Stat k={t('Sedute con afflussi')} v={fin(d.kpi.inflow_days_pct) ? `${d.kpi.inflow_days_pct.toFixed(0)}%` : DASH} sub={t('Su {n} sedute', { n: d.kpi.days })} />
        </div>
        <Fill min={240}>{v === 'ratio' ? <RatioChart data={a.ratio30} height="100%" /> : <MonthlyAbsorptionChart rows={a.monthly} height="100%" />}</Fill>
      </CardBody>
    </Card>
  )
}

function IssuersCard({ d }: { d: EtfData }) {
  return (
    <Card>
      <CardHeader icon={<Coins />} title={t('Emittenti')} subtitle={t('Flussi netti cumulati e recenti (M$) · BTC stimati')}
        info={t("GBTC è nato dalla conversione del trust Grayscale (circa 619K BTC già detenuti l'11 gennaio 2024): i suoi deflussi sono rimborsi di quote esistenti. Il controvalore in BTC è la somma di ogni flusso giornaliero diviso per il prezzo delle 16:00 di New York: non sono le detenzioni ufficiali.")} />
      <CardBody>
        <div className={TW}>
          <table className="tbl min-w-[760px]">
            <thead><tr>
              <th className={TL}>Ticker</th><th className="text-right">{t('Cumulato')}</th><th className="text-right">{t('BTC stimati')}</th>
              <th className="text-right">{t('Ultima seduta')}</th><th className="text-right">{t('5 sedute')}</th><th className="text-right">{t('20 sedute')}</th>
              <th className="text-right">{t('Massimo afflusso')}</th><th className={TR}>{t('Massimo deflusso')}</th>
            </tr></thead>
            <tbody>
              {d.issuers.map((r) => (
                <tr key={r.ticker}>
                  <td className={clsx(TL, 'font-medium text-white')}>
                    <span className="mr-2 inline-block h-2 w-2 rounded-sm" style={{ background: ISSUER_COLORS[r.ticker] ?? '#3B4560' }} />{r.ticker}
                    {ISSUER_NAME[r.ticker] && <span className="ml-1.5 text-xs font-normal text-slate-400">{ISSUER_NAME[r.ticker]}</span>}
                    {d.partial_issuers.includes(r.ticker) && <Badge className="ml-2">{tr('In attesa', 'Pending')}</Badge>}
                  </td>
                  <td className={clsx('text-right font-medium', (r.cum_usd ?? 0) >= 0 ? 'text-up' : 'text-down')}>{usdM(r.cum_usd)}</td>
                  <td className="text-right text-slate-300">{btcAmt(r.cum_btc, true, false)}</td>
                  <td className="text-right text-slate-300">{usdM(r.last)}</td>
                  <td className="text-right text-slate-300">{usdM(r.d5)}</td>
                  <td className="text-right text-slate-300">{usdM(r.d30)}</td>
                  <td className="text-right text-slate-300">{usdM(r.max_in)} <span className="text-xs text-slate-500">{date(r.max_in_time)}</span></td>
                  <td className={clsx(TR, 'text-slate-300')}>{usdM(r.max_out)} <span className="text-xs text-slate-500">{date(r.max_out_time)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function StreaksCard({ d }: { d: EtfData }) {
  const s = d.streaks
  const r = d.reaction
  const line = (x: typeof s.current) => x ? t('{a} – {b} · {u} · {c}', { a: date(x.start), b: date(x.end), u: usdM(x.usd), c: btcAmt(x.btc, true) }) : DASH
  return (
    <Card className="h-full">
      <CardHeader icon={<Repeat />} title={t('Serie e reazione del prezzo')} subtitle={t('Sedute consecutive dello stesso segno · rendimenti dopo i grandi flussi')} />
      <CardBody className="flex flex-col gap-4">
        <div className="dgrid grid-cols-1 sm:grid-cols-3">
          <Stat k={s.current && s.current.sign < 0 ? t('Serie di deflussi in corso') : t('Serie di afflussi in corso')} v={s.current ? `${s.current.days} ${s.current.days === 1 ? tr('seduta', 'session') : tr('sedute', 'sessions')}` : DASH} sub={line(s.current)} />
          <Stat k={t('Serie record di afflussi')} v={s.longest_in ? `${s.longest_in.days} ${tr('sedute', 'sessions')}` : DASH} sub={line(s.longest_in)} />
          <Stat k={t('Serie record di deflussi')} v={s.longest_out ? `${s.longest_out.days} ${tr('sedute', 'sessions')}` : DASH} sub={line(s.longest_out)} />
        </div>
        <div className={clsx(TW, 'flex-1')}>
          <table className="tbl min-w-[460px] min-[1700px]:h-full">
            <thead><tr>
              <th className={TL}>{t('Dopo sedute con')}</th><th className="text-right">{tr('Sedute', 'Sessions')}</th>
              <th className="text-right">{`7${du()}`}</th><th className="text-right">{`30${du()}`}</th><th className={TR}>{`90${du()}`}</th>
            </tr></thead>
            <tbody>
              {([['big_in', t('Afflussi ≥ $500M')], ['big_out', t('Deflussi ≤ −$500M')], ['all', t('Tutte le sedute')]] as const).map(([key, label]) => (
                <tr key={key}>
                  <td className={clsx(TL, key === 'all' ? 'text-slate-400' : 'text-slate-200')}>{label}</td>
                  <td className="text-right text-slate-300">{r[key].days}</td>
                  <td className="text-right"><Fwd b={r[key]} h={7} /></td>
                  <td className="text-right"><Fwd b={r[key]} h={30} /></td>
                  <td className={TR}><Fwd b={r[key]} h={90} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-400">{t('Mediana del rendimento di BTC (giorni di calendario) e quota di casi positivi. Giorni vicini si sovrappongono: campione piccolo, solo indicativo.')}</p>
      </CardBody>
    </Card>
  )
}

function RecentEtfCard({ d }: { d: EtfData }) {
  const cols = ['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB'].filter((c) => d.daily.issuers[c])
  const others = Object.keys(d.daily.issuers).filter((c) => !cols.includes(c))
  return (
    <Card>
      <CardHeader icon={<ListChecks />} title={t('Ultime 20 sedute')} subtitle={t('Milioni di USD per emittente · totale in BTC stimato')} />
      <CardBody>
        <div className={clsx(TW, 'max-h-[460px] overflow-y-auto')}>
          <table className="tbl min-w-[820px]">
            <thead className="sticky top-0 z-10 bg-[#0E1424]"><tr>
              <th className={TL}>{tr('Data', 'Date')}</th>
              {cols.map((c) => <th key={c} className="text-right">{c}</th>)}
              <th className="text-right">{t('Altri')}</th><th className="text-right">{t('Totale')}</th><th className="text-right">BTC</th><th className={TR}>{t('Prezzo 16:00 NY')}</th>
            </tr></thead>
            <tbody>
              {d.recent.map((r) => {
                const oth = others.reduce((a, c) => a + (r.by[c] ?? 0), 0)
                return (
                  <tr key={r.time}>
                    <td className={clsx(TL, 'text-slate-200')}>{date(r.time)}{r.provisional && <Badge color="btc" className="ml-2">{tr('Provvisorio', 'Provisional')}</Badge>}</td>
                    {cols.map((c) => <td key={c} className={clsx('text-right', (r.by[c] ?? 0) > 0 ? 'text-up' : (r.by[c] ?? 0) < 0 ? 'text-down' : 'text-slate-500')}>{fin(r.by[c]) ? sfx(r.by[c], 1) : DASH}</td>)}
                    <td className={clsx('text-right', oth > 0 ? 'text-up' : oth < 0 ? 'text-down' : 'text-slate-500')}>{sfx(oth, 1)}</td>
                    <td className={clsx('text-right font-medium', (r.total ?? 0) > 0 ? 'text-up' : (r.total ?? 0) < 0 ? 'text-down' : 'text-slate-300')}>{sfx(r.total, 1)}</td>
                    <td className="text-right text-slate-300">{intg(r.btc, true)}</td>
                    <td className={clsx(TR, 'text-slate-300')}>{usd(r.price)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function EtfTab() {
  const q = useEtf()
  return (
    <Q q={q} loading={<PageSkeleton />} isEmpty={(d) => !d.daily?.dates?.length}>
      {(d) => {
        const c = d.checks
        return (
          <div className="flex flex-col gap-3">
            <Notice icon={<Clock size={14} />}>
              {t('Seduta del {d} provvisoria: gli emittenti comunicano i flussi nella serata USA e Farside può correggerli. Gli importi in BTC sono stime.', { d: date(d.as_of) })}
              {d.partial_issuers.length > 0 && ` ${t('In attesa: {l}.', { l: d.partial_issuers.join(', ') })}`}
            </Notice>
            {d.source.mode !== 'all' && (
              <Notice tone="amber" icon={<AlertTriangle size={14} />}>
                {d.source.mode === 'recent'
                  ? t('Storico completo Farside non raggiungibile: storico dalla cache locale + ultime settimane dalla pagina recente.')
                  : t('Farside non raggiungibile: dati dalla cache locale (ultimo scaricamento {d}).', { d: d.source.fetched_at ? date(d.source.fetched_at) : DASH })}
              </Notice>
            )}
            <EtfKpis d={d} />
            <div className="grid gap-3 xl:grid-cols-3">
              <div className="xl:col-span-2"><EtfFlowsCard d={d} updatedAt={q.dataUpdatedAt} /></div>
              <Card className="h-full">
                <CardHeader icon={<MessageSquareText />} title={tr('Lettura', 'Reading')} subtitle={t('Domanda istituzionale tramite ETF spot USA')} />
                <CardBody className="flex flex-col"><Bullets items={etfReading(d)} /></CardBody>
              </Card>
            </div>
            {/* side by side only from 1700px: at half width the stat labels and dates were cut with an ellipsis */}
            <div className="grid gap-3 min-[1700px]:grid-cols-2">
              <AbsorptionCard d={d} />
              <StreaksCard d={d} />
            </div>
            <IssuersCard d={d} />
            <RecentEtfCard d={d} />
            <MethodNote title={t('Fonti, metodo e verifiche')}>
              <p>{t("Fonte: Farside Investors (farside.co.uk), tabella completa dei flussi giornalieri per emittente dall'11 gennaio 2024, in milioni di USD; numeri tra parentesi = deflussi. Se la pagina completa non è raggiungibile si usa la cache locale più la pagina delle ultime settimane.")}</p>
              <p>{t("BTC stimati = flusso in USD ÷ prezzo BTC alle 16:00 di New York (chiusura della candela oraria Binance), lo stesso orario del NAV; lo scarto rispetto al prezzo di riferimento degli emittenti è normalmente sotto l'1–2%. Emissione dei miner: CoinMetrics IssTotNtv.")}</p>
              <Check ok={Math.abs((c.day1_total ?? 0) - c.day1_expected) < 0.05}>{t('Primo giorno 11 gen 2024: {v} (dato pubblicato +$655.3M).', { v: usdM(c.day1_total) })}</Check>
              {c.known.filter((x) => x.col !== 'Total' || x.expected !== c.day1_expected).map((x) => (
                <Check key={`${x.date}${x.col}`} ok={x.ok}>{t("{c} del {d}: {v} (valore riportato all'epoca {e}).", { c: x.col === 'Total' ? t("Totale") : x.col, d: date(x.date), v: usdM(x.observed), e: usdM(x.expected) })}</Check>
              ))}
              <Check ok={c.row_mismatches === 0}>{t('Somma degli emittenti = colonna Total di Farside in {n} sedute su {m}; totale cumulato {s} vs riga Total {f}.', { n: c.rows - c.row_mismatches, m: c.rows, s: usdM(c.sum_total, false), f: usdM(c.footer_total, false) })}</Check>
              <Check ok={c.ibit_2024.ok}>{t('Stima in BTC verificata su IBIT (nessuna dotazione iniziale): {v} al {d}, contro circa 552K BTC detenuti secondo BlackRock.', { v: btcAmt(c.ibit_2024.estimate), d: date(c.ibit_2024.date) })}</Check>
              <p>{t('Limiti: le detenzioni totali degli ETF non sono mostrate perché GBTC e il Mini Trust (BTC) sono nati da monete già esistenti e pagano commissioni in BTC; la fonte è uno scraping HTML (rischio di cambio layout, controllato a ogni download). Analisi a scopo di studio, non consulenza finanziaria.')}</p>
            </MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

// ===================================================================== ATTENZIONE
function AttentionKpis({ d }: { d: AttentionData }) {
  const k = d.kpi
  return (
    <KpiStrip>
      <KpiCell icon={<Eye />} label={t('Visite {d}', { d: date(d.as_of, false) })} value={intg(k.views_1d)} foot={t('Pagina «Bitcoin» · en.wikipedia')} />
      <KpiCell icon={<Waves />} label={t('Media 30 giorni')} value={intg(k.avg_30d)} foot={t('Media 7 giorni {v}', { v: intg(k.avg_7d) })} />
      <KpiCell icon={<Gauge />} label={t('Percentile storico')} value={ord(k.percentile)}
        foot={t('Zona {z}', { z: k.zone ? t(ZONE_LABEL[k.zone]).toLowerCase() : DASH })} />
      <KpiCell icon={<CalendarRange />} label={t('Variazione 1 anno')} value={pct(k.change_365d, 1)} foot={t('Media 30 giorni vs un anno fa')} />
      <KpiCell icon={<Mountain />} label={t('Rispetto al picco')} value={<>{fin(k.vs_ath_pct) ? k.vs_ath_pct.toFixed(1) : DASH}{unit('%')}</>}
        foot={t('Picco {v} · {d}', { v: intg(k.ath_30d), d: date(k.ath_30d_time) })} />
      <KpiCell icon={<BookOpen />} label={t('it.wikipedia · media 30 giorni')} value={intg(k.it_avg_30d)} foot={t('Picco {v} · {d}', { v: intg(k.it_ath_day), d: date(k.it_ath_day_time) })} />
    </KpiStrip>
  )
}

function attentionReading(d: AttentionData) {
  const k = d.kpi
  const out: { text: ReactNode; tone?: 'bullish' | 'bearish' | 'neutral' }[] = []
  out.push({ text: t('Media degli ultimi 30 giorni {v} visite al giorno: {p} percentile dal 2015, zona «{z}», minimo dal {d}.', {
    v: intg(k.avg_30d), p: ord(k.percentile), z: k.zone ? t(ZONE_LABEL[k.zone]).toLowerCase() : DASH, d: date(k.lowest_since) }) })
  out.push({ text: t('È il {p}% del picco di attenzione del {d} ({v} al giorno in media; record giornaliero {r} il {rd}).', {
    p: fin(k.vs_ath_pct) ? k.vs_ath_pct.toFixed(1) : DASH, d: date(k.ath_30d_time), v: intg(k.ath_30d), r: intg(k.ath_day), rd: date(k.ath_day_time) }) })
  if (d.peaks.length) {
    const parts = d.peaks.map((p) => {
      const y = new Date(p.top * 1000).getUTCFullYear()
      const n = Math.abs(p.lag30_days)
      return p.lag30_days >= 0 ? t('{y}: {n} giorni dopo', { y, n }) : t('{y}: {n} giorni prima', { y, n })
    })
    const early = d.peaks.filter((p) => p.lag30_days < -60).length
    out.push({ text: t('Picco della media a 30 giorni rispetto al massimo di ciclo del prezzo — {l}.', { l: parts.join(' · ') }) +
      (early ? ' ' + t('In {n} cicli su {m} il picco di attenzione è arrivato più di 2 mesi prima del massimo del prezzo.', { n: early, m: d.peaks.length }) : '') })
  }
  const z = d.backtest.rows.find((r) => r.key === k.zone)
  if (z) {
    out.push({ text: t('Storicamente, con attenzione in zona «{z}» il rendimento mediano di BTC a 90 giorni è stato {a} (positivi {h}%) contro {b} di tutti i giorni ({e} episodi).', {
      z: t(ZONE_LABEL[z.key]).toLowerCase(), a: pct(z.r90, 1), h: fin(z.hit90) ? z.hit90.toFixed(0) : DASH, b: pct(d.backtest.baseline.r90, 1), e: z.episodes }) })
  }
  out.push({ text: t("Misura quante persone leggono di Bitcoin, non se comprano o vendono: è un indicatore di attenzione, non di sentiment.") })
  return out
}

function AttentionTab() {
  const q = useAttention()
  const [showIt, setShowIt] = useState(false)
  return (
    <Q q={q} loading={<PageSkeleton />} isEmpty={(d) => !d.series?.views30?.length}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <Notice icon={<Eye size={14} />}>
            {t('Proxy di attenzione retail, non di sentiment · visite umane (agent=user) alla pagina «Bitcoin» di Wikipedia · ultimo dato {d}', { d: date(d.as_of) })}
          </Notice>
          <AttentionKpis d={d} />
          <div className="grid gap-3 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader icon={<Eye />} updatedAt={q.dataUpdatedAt} interval={10 * 60_000} title={t('Attenzione vs prezzo')} subtitle={t('Visite giornaliere, media 30 giorni (scala log) · prezzo BTC (scala log)')}
                right={<Toggle on={showIt} onClick={() => setShowIt(!showIt)}>it.wikipedia</Toggle>} />
              <CardBody className="flex flex-col"><Fill min={300}>
                <AttentionChart views={d.series.views30} it={d.series.it30} price={d.series.price} showIt={showIt} height="100%" />
              </Fill></CardBody>
            </Card>
            <Card className="h-full">
              <CardHeader icon={<MessageSquareText />} title={tr('Lettura', 'Reading')} subtitle={t('Interesse del pubblico per Bitcoin')} />
              <CardBody className="flex flex-col"><Bullets items={attentionReading(d)} /></CardBody>
            </Card>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <Card>
              <CardHeader icon={<Mountain />} title={t('Picchi di attenzione e massimi di ciclo')} subtitle={t('Finestra da 365 giorni prima a 180 giorni dopo il massimo')}
                info={t("Massimi di ciclo del prezzo dal modulo Cicli. Ritardo = giorni tra il massimo del prezzo e il picco dell'attenzione (negativo = l'attenzione ha raggiunto il picco prima).")} />
              <CardBody className="flex flex-col">
                <div className={clsx(TW, 'flex-1')}>
                  <table className="tbl min-w-[600px] xl:h-full">
                    <thead><tr>
                      <th className={TL}>{t('Massimo di ciclo')}</th><th className="text-right">{t('Picco media 30 giorni')}</th><th className="text-right">{t('Ritardo')}</th>
                      <th className="text-right">{t('Picco giornaliero')}</th><th className={TR}>{t('Ritardo')}</th>
                    </tr></thead>
                    <tbody>
                      {d.peaks.map((p) => (
                        <tr key={p.top}>
                          <td className={clsx(TL, 'text-slate-200')}>{date(p.top)} <span className="text-xs text-slate-400">{usd(p.top_price)}</span></td>
                          <td className="text-right text-slate-300">{intg(p.peak30_views)} <span className="text-xs text-slate-500">{date(p.peak30)}</span></td>
                          <td className="text-right text-slate-200">{intg(p.lag30_days, true)}{du()}</td>
                          <td className="text-right text-slate-300">{intg(p.peak_day_views)} <span className="text-xs text-slate-500">{date(p.peak_day)}</span></td>
                          <td className={clsx(TR, 'text-slate-200')}>{intg(p.lag_day_days, true)}{du()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader icon={<Percent />} title={t('Rendimenti per zona di attenzione')} subtitle={t('Percentile della media 30 giorni senza lookahead · dal {d}', { d: date(d.backtest.since) })}
                info={t('Percentile calcolato ogni giorno solo sui dati disponibili fino a quel giorno (almeno un anno di storia). Rendimento mediano di BTC a 30/90/180 giorni e quota di casi positivi; il campione indipendente è il numero di episodi.')} />
              <CardBody>
                <div className={TW}>
                  <table className="tbl min-w-[560px]">
                    <thead><tr>
                      <th className={TL}>{tr('Zona', 'Zone')}</th><th className="text-right">{tr('Giorni', 'Days')}</th><th className="text-right">{tr('Episodi', 'Episodes')}</th>
                      <th className="text-right">{`30${du()}`}</th><th className="text-right">{`90${du()}`}</th><th className={TR}>{`180${du()}`}</th>
                    </tr></thead>
                    <tbody>
                      {d.backtest.rows.map((r) => (
                        <tr key={r.key}>
                          <td className={clsx(TL, r.key === d.kpi.zone ? 'font-medium text-white' : 'text-slate-200')}>
                            {t(ZONE_LABEL[r.key])} <span className="text-xs text-slate-400">{r.lo}–{r.hi}°</span>
                            {r.key === d.kpi.zone && <Badge color="blue" className="ml-2">{tr('Ora', 'Now')}</Badge>}
                          </td>
                          <td className="text-right text-slate-300">{intg(r.days)}</td>
                          <td className="text-right text-slate-300">{r.episodes}</td>
                          <td className="text-right"><Fwd b={r} h={30} /></td>
                          <td className="text-right"><Fwd b={r} h={90} /></td>
                          <td className={TR}><Fwd b={r} h={180} /></td>
                        </tr>
                      ))}
                      <tr>
                        <td className={clsx(TL, 'text-slate-400')}>{t('Tutti i giorni')}</td>
                        <td className="text-right text-slate-400">{intg(d.backtest.baseline.days)}</td><td className="text-right text-slate-400">—</td>
                        <td className="text-right"><Fwd b={d.backtest.baseline} h={30} /></td>
                        <td className="text-right"><Fwd b={d.backtest.baseline} h={90} /></td>
                        <td className={TR}><Fwd b={d.backtest.baseline} h={180} /></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader icon={<Flame />} title={t('Giorni di massima attenzione')} subtitle={t('Primi 10 giorni per visite (episodi distanti almeno 30 giorni) e rendimento successivo di BTC')} />
            <CardBody>
              <div className={TW}>
                <table className="tbl min-w-[520px]">
                  <thead><tr>
                    <th className={TL}>{tr('Data', 'Date')}</th><th className="text-right">{t('Visite')}</th><th className="text-right">{t('Prezzo')}</th>
                    <th className="text-right">{`30${du()}`}</th><th className={TR}>{`90${du()}`}</th>
                  </tr></thead>
                  <tbody>
                    {d.spikes.map((s) => (
                      <tr key={s.time}>
                        <td className={clsx(TL, 'text-slate-200')}>{date(s.time)}</td>
                        <td className="text-right font-medium text-white">{intg(s.views)}</td>
                        <td className="text-right text-slate-300">{usd(s.price, 0)}</td>
                        <td className="text-right"><Change value={s.r30} digits={1} /></td>
                        <td className={TR}><Change value={s.r90} digits={1} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
          <MethodNote title={t('Fonti, metodo e verifiche')}>
            <p>{t('Fonte: Wikimedia REST API (pageviews per articolo, accesso desktop + mobile, solo utenti umani), pagina «Bitcoin» di en.wikipedia e it.wikipedia, giornaliera dal 1 luglio 2015, con User-Agent descrittivo come richiesto da Wikimedia.')}</p>
            <Check ok={Math.abs(d.checks.en_peak_day - Date.UTC(2017, 11, 8) / 1000) <= 86400 && Math.abs((d.checks.en_peak_views ?? 0) - 344_686) < 5000}>
              {t('Record giornaliero {d}: {v} visite, il noto picco di attenzione retail del dicembre 2017 (7–8 dic, ≈ 344K).', { d: date(d.checks.en_peak_day), v: intg(d.checks.en_peak_views) })}
            </Check>
            <Check ok={!!d.checks.it_peak_day && Math.abs(d.checks.it_peak_day - d.checks.en_peak_day) < 10 * 86400}>
              {t('Seconda fonte indipendente: il record di it.wikipedia cade il {d}, nello stesso episodio.', { d: date(d.checks.it_peak_day) })}
            </Check>
            <p>{t('Limiti: il traffico di Wikipedia è in calo strutturale (motori di ricerca e assistenti AI rispondono direttamente), quindi i livelli recenti sono sottostimati rispetto al 2017; i percentili sono quindi bassi per costruzione negli ultimi anni. Indicatore di attenzione, non di sentiment né di flussi. Analisi a scopo di studio, non consulenza finanziaria.')}</p>
          </MethodNote>
        </div>
      )}
    </Q>
  )
}

// ===================================================================== pagina
const TABS = [
  { value: 'exchange', label: 'Exchange', sub: 'Riserve di BTC sugli exchange, afflussi e deflussi giornalieri, regimi di flusso e rendimenti successivi.' },
  { value: 'etf', label: 'ETF spot', sub: "Flussi giornalieri degli ETF spot USA per emittente e assorbimento dei BTC emessi dai miner." },
  { value: 'attenzione', label: 'Attenzione', sub: 'Attenzione retail misurata dalle visite alla pagina Bitcoin di Wikipedia.' },
] as const
type Tab = (typeof TABS)[number]['value']

export default function SupplyDemandPage() {
  const [tab, changeTab] = useTab<Tab>(TABS.map((x) => x.value), 'exchange')
  const cur = TABS.find((x) => x.value === tab) ?? TABS[0]
  return (
    <div>
      <PageTitle title={t('Domanda e offerta')} subtitle={t(cur.sub)} />
      <TabBar tabs={TABS.map((x) => ({ value: x.value, label: t(x.label) }))} value={tab} onChange={changeTab} />
      {tab === 'exchange' && <ExchangeTab />}
      {tab === 'etf' && <EtfTab />}
      {tab === 'attenzione' && <AttentionTab />}
    </div>
  )
}

