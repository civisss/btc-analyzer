import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity, BarChart3, BrickWall, CalendarClock, CalendarX, Clock, Coins, Gauge, History, Layers, LineChart, ListChecks, MessageSquareText, Percent, Repeat,
  Scale, Sigma, Spline, Target, TrendingDown, TrendingUp, Users, Waves,
} from 'lucide-react'
import { useHolders, useOptions, useSentiment, type HoldersData, type OptionsData, type SentimentData } from '../api/positioning'
import { C, hexA } from '../components/charts/theme'
import {
  Badge, Card, CardBody, CardHeader, Change, EmptyState, Fill, KpiCell, KpiStrip, Legend, MethodNote, PageTitle, Q, Segmented, Skeleton, TabBar, Toggle, clsx,
} from '../components/ui'
import { cap, t, tr } from '../i18n'
import { MoreList } from '../widgets/structure'
import { useTab } from '../lib/useTab'
import { MiniTrend } from '../components/MiniTrend'
import { TimeLinesChart } from '../widgets/charts'
import {
  ComponentBacktestTable, ExpiryTable, GammaChart, OiStrikeChart, ScoreTrack, SentimentTrack, SmileChart, TL, TR, TW, TermChart, ZoneBacktestTable, fin, fx, sfx,
} from '../widgets/positioning'
import { DASH, date, dayUnit, ordinal, pct, usd, usdCompact } from '../lib/format'

const GRID0 = hexA(C.grey, 0.5)
const toneDot = { bullish: 'bg-up', bearish: 'bg-down', neutral: 'bg-slate-400' } as const
const unit = (s: string) => <span className="ml-1 text-sm font-normal text-slate-400">{s}</span>

/** STH-MVRV zone labels arrive as lowercase Italian keys from the backend. */
const holderZone = (z: string) => ({
  capitolazione: tr('Capitolazione', 'Capitulation'), 'sotto costo': tr('Sotto costo', 'Below cost'), neutrale: tr('Neutrale', 'Neutral'),
  caldo: tr('Caldo', 'Hot'), surriscaldato: tr('Surriscaldato', 'Overheated'),
} as Record<string, string>)[z] ?? cap(z)

function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-t border-line py-1 text-sm first:border-t-0">
      <span className="min-w-0 text-slate-400">{k}</span>
      <span className="tnum whitespace-nowrap text-right font-medium text-white">{children}</span>
    </div>
  )
}

function Signals({ items }: { items: { text: string; tone: string }[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2.5 border-t border-line py-2 text-sm leading-relaxed text-slate-300 first:border-t-0 first:pt-0">
          <span className={clsx('mt-2 h-1.5 w-1.5 shrink-0 rounded-full', toneDot[(s.tone in toneDot ? s.tone : 'neutral') as keyof typeof toneDot])} />
          <span>{s.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** Plain divider-grid cell (use inside `<div className="dgrid …">`): label · value · optional sub-line. */
function Stat({ k, v, sub }: { k: ReactNode; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="label truncate">{k}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-white">{v}</div>
      {sub && <div className="truncate text-xs text-slate-400">{sub}</div>}
    </div>
  )
}

const PageSkeleton = () => <div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[380px]" /><Skeleton className="h-[300px]" /></div>

// ===================================================================== OPZIONI
function OptionsKpis({ d }: { d: OptionsData }) {
  const k = d.kpi
  const du = dayUnit()
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 min-[1700px]:grid-cols-6">
      <KpiCell icon={<Layers />} label={t('Open interest opzioni')} value={usdCompact(k.oi_usd, 2)} foot={`${Math.round(k.oi_btc).toLocaleString('en-US')} BTC · Deribit`} />
      <KpiCell icon={<Scale />} label="Put/Call (OI)" value={fx(k.pc_oi)} foot={t('Volume 24h: {a} · {b}', { a: fx(k.pc_vol), b: usdCompact(k.volume_usd_24h, 1) })} />
      <KpiCell icon={<Target />} label={t('Prossimo max pain')} value={usd(k.next_max_pain)}
        foot={k.next_expiry ? t('{d} · {p} dal prezzo', { d: date(k.next_expiry, false), p: pct(k.next_max_pain_dist, 1) }) : undefined} />
      <KpiCell icon={<Spline />} label={t('Skew 25Δ 30 giorni')} value={<>{sfx(k.skew_30d)}{unit('pt')}</>} foot={`7${du} ${sfx(k.skew_7d)} · 90${du} ${sfx(k.skew_90d)} pt`} />
      <KpiCell icon={<Percent />} label={t('IV ATM 30 giorni')} value={fin(k.atm_30d) ? `${k.atm_30d.toFixed(1)}%` : DASH} foot={`7${du} ${fx(k.atm_7d, 1)}% · 90${du} ${fx(k.atm_90d, 1)}%`} />
      <KpiCell icon={<Activity />} label="DVOL" value={fx(k.dvol, 1)} foot={fin(d.dvol.pct_1y) ? t('{o} percentile a 1 anno', { o: ordinal(d.dvol.pct_1y) }) : undefined} />
    </KpiStrip>
  )
}

type Range = 15 | 30 | 50
function OiCard({ d, updatedAt }: { d: OptionsData; updatedAt: number }) {
  const [exp, setExp] = useState<number>(0)
  const [range, setRange] = useState<Range>(30)
  const [u, setU] = useState<'btc' | 'usd'>('usd')
  const px = d.index_price
  const sel = d.oi_by_strike.by_expiry.find((e) => e.expiry === exp)
  const strikes = useMemo(() => (sel ? sel.strikes : d.oi_by_strike.all).filter((s) => Math.abs(s.strike / px - 1) * 100 <= range), [sel, d, px, range])
  const tot = strikes.reduce((a, s) => ({ c: a.c + s.calls, p: a.p + s.puts }), { c: 0, p: 0 })
  return (
    <Card className="h-full">
      <CardHeader icon={<BarChart3 />} updatedAt={updatedAt} title={t('Open interest per strike')}
        subtitle={`${sel ? t('Scadenza {d}', { d: date(sel.expiry) }) : t('Tutte le scadenze')} · ${t('Call sopra, put sotto · ±{r}% dal prezzo', { r: range })}`}
        info={t('Contratti aperti per prezzo di esercizio. Grandi concentrazioni di call sopra il prezzo e di put sotto tendono a fare da resistenza e supporto, soprattutto vicino alla scadenza.')}
        right={<>
          <Segmented options={[{ value: 0, label: tr('Tutte', 'All') }, ...d.oi_by_strike.by_expiry.map((e) => ({ value: e.expiry, label: date(e.expiry, false) }))]} value={exp} onChange={setExp} />
          <Segmented options={[{ value: 15 as Range, label: '±15%' }, { value: 30 as Range, label: '±30%' }, { value: 50 as Range, label: '±50%' }]} value={range} onChange={setRange} />
          <Segmented options={[{ value: 'usd' as const, label: 'USD' }, { value: 'btc' as const, label: 'BTC' }]} value={u} onChange={setU} />
        </>} />
      <CardBody className="flex flex-col gap-3">
        <div className="dgrid grid-cols-2 sm:grid-cols-4">
          <Stat k="Call" v={`${Math.round(tot.c).toLocaleString('en-US')} BTC`} />
          <Stat k="Put" v={`${Math.round(tot.p).toLocaleString('en-US')} BTC`} />
          <Stat k="Put/Call" v={tot.c ? (tot.p / tot.c).toFixed(2) : DASH} />
          <Stat k={sel ? 'Max pain' : t('Prezzo indice')} v={usd(sel ? sel.max_pain : px)} />
        </div>
        <Fill min={360}><OiStrikeChart strikes={strikes} price={px} maxPain={sel?.max_pain} unit={u} range={range} height="100%" /></Fill>
      </CardBody>
    </Card>
  )
}

function WallsCard({ d }: { d: OptionsData }) {
  const px = d.index_price
  const maxOi = Math.max(1, ...d.gamma.oi_walls.map((w) => w.calls_usd + w.puts_usd))
  const maxG = Math.max(1, ...d.gamma.walls.map((w) => w.total))
  const strikeK = (s: number) => <>{usd(s)} <span className="text-xs text-slate-400">{pct((s / px - 1) * 100, 1)}</span></>
  return (
    <Card className="h-full">
      <CardHeader icon={<BrickWall />} title={t('Muri di open interest e gamma')} subtitle={t('Strike con più contratti e più gamma vicino al prezzo')}
        info={t("Gamma = quanto cambia il delta delle opzioni a un movimento dell'1% del prezzo (in dollari, lordo). Dove la gamma è concentrata, la copertura dei dealer può frenare il prezzo (se sono lunghi gamma) o accelerarlo (se sono corti): il segno delle loro posizioni non è pubblico.")} />
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="label">Open interest · ±15%</div>
            <Legend items={[{ label: 'Call', color: C.blue }, { label: 'Put', color: C.purple }]} />
          </div>
          {d.gamma.oi_walls.map((w) => {
            const tot = w.calls_usd + w.puts_usd
            const callSide = w.calls >= w.puts
            return (
              <div key={w.strike} className="border-t border-line py-1.5 first:border-t-0">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 text-slate-300">{strikeK(w.strike)}</span>
                  <span className="tnum whitespace-nowrap font-medium text-white">{usdCompact(tot, 2)}
                    <span className="ml-1.5 text-xs font-normal text-slate-400">{callSide ? 'Call' : 'Put'} {Math.round(Math.max(w.calls, w.puts) / (w.calls + w.puts) * 100)}%</span></span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.05]">
                  <div className="h-full rounded-full" style={{ width: `${(tot / maxOi) * 100}%`, background: `linear-gradient(90deg, ${hexA(callSide ? C.blue : C.purple, 0.35)}, ${callSide ? C.blue : C.purple})` }} />
                </div>
              </div>
            )
          })}
        </div>
        <div>
          <div className="label mb-1.5">{t('Gamma per 1% di movimento · ±20%')}</div>
          {d.gamma.walls.map((w) => (
            <div key={w.strike} className="border-t border-line py-1.5 first:border-t-0">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 text-slate-300">{strikeK(w.strike)}</span>
                <span className="tnum whitespace-nowrap font-medium text-white">{usdCompact(w.total, 1)}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.05]">
                <div className="h-full rounded-full bg-gradient-to-r from-white/10 to-slate-300/70" style={{ width: `${(w.total / maxG) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function ExpiryHistoryCard({ h }: { h: OptionsData['expiry_history'] }) {
  return (
    <Card className="h-full">
      <CardHeader icon={<CalendarX />} title={t('Prezzo alla scadenza vs max pain')} subtitle={t('Scadenze passate: max pain ~7 giorni prima e prezzo di regolamento')}
        right={h.n ? <span className="text-xs text-slate-400">{t('Convergenza {p}% su {n} scadenze', { p: fx(h.converged_pct, 0), n: h.n })}</span> : undefined} />
      <CardBody>
        {h.rows.length === 0 ? (
          <EmptyState compact text={t("Lo storico si accumula dal {d}: Deribit non pubblica l'open interest passato, quindi gli snapshot giornalieri partono da oggi. Le prime scadenze compariranno dopo il loro regolamento.", { d: date(h.since) })} />
        ) : (
          <div className={TW}>
            <table className="tbl min-w-[600px]">
              <thead><tr>
                <th className={TL}>{tr('Scadenza', 'Expiry')}</th><th className="text-right">Max pain</th><th className="text-right">{t('Prezzo prima')}</th>
                <th className="text-right">{tr('Regolamento', 'Settlement')}</th><th className="text-right">{t('Scarto finale')}</th><th className={TR}>{t('Verso il max pain')}</th>
              </tr></thead>
              <tbody>
                {[...h.rows].reverse().map((r) => (
                  <tr key={r.expiry}>
                    <td className={clsx(TL, 'whitespace-nowrap text-slate-200')}>{date(r.expiry)} <span className="text-xs text-slate-400">({t('{n} prima', { n: `${Math.round(r.lead_days)}${dayUnit()}` })})</span></td>
                    <td className="text-right">{usd(r.max_pain)}</td>
                    <td className="text-right text-slate-300">{usd(r.spot_before)}</td>
                    <td className="text-right">{usd(r.settlement)}</td>
                    <td className="text-right text-slate-300">{pct(r.gap_settle, 1)}</td>
                    <td className={clsx(TR, 'text-slate-300')}>{r.converged ? tr('Sì', 'Yes') : 'No'}</td>
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

function OptionsTab() {
  const q = useOptions()
  return (
    <Q q={q} loading={<PageSkeleton />} isEmpty={(d) => !d.expiries?.length}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <OptionsKpis d={d} />
          <div className="grid gap-3 xl:grid-cols-3">
            <div className="xl:col-span-2"><OiCard d={d} updatedAt={q.dataUpdatedAt} /></div>
            <WallsCard d={d} />
          </div>
          <Card>
            <CardHeader icon={<CalendarClock />} title={t('Max pain per scadenza')}
              subtitle={t('Prossime scadenze e grandi scadenze mensili/trimestrali · prezzo indice {p}', { p: usd(d.index_price) })}
              info={t("Max pain = prezzo di regolamento al quale il valore totale pagato a chi detiene call e put è minimo (cioè la perdita massima per gli acquirenti di opzioni). Le scadenze mensili e trimestrali (venerdì alle 08:00 UTC) concentrano la maggior parte dell'open interest.")} />
            <CardBody><ExpiryTable rows={d.expiries} /></CardBody>
          </Card>
          <div className="grid gap-3 xl:grid-cols-3">
            <Card>
              <CardHeader icon={<MessageSquareText />} title={t('Lettura del posizionamento')} subtitle={t('Interpretazione dei dati opzioni')} />
              <CardBody><Signals items={d.signals} /></CardBody>
            </Card>
            <Card>
              <CardHeader icon={<Spline />} title={t('Smile di volatilità')} subtitle={t('IV per moneyness (strike / forward) · 3 scadenze')}
                info={t('Una curva più alta a sinistra (strike bassi) indica put più care: il mercato paga per proteggersi dai ribassi.')} />
              <CardBody className="flex flex-col"><Fill min={280}><SmileChart smiles={d.smiles} height="100%" /></Fill></CardBody>
            </Card>
            <Card>
              <CardHeader icon={<LineChart />} title={t('Struttura a termine')} subtitle={t('IV ATM e skew 25Δ per scadenza (asse giorni log)')}
                info={t('Struttura crescente (contango) = mercato calmo; IV a breve sopra quella a lungo (backwardation) = tensione immediata. Skew positivo = put più care delle call.')} />
              <CardBody className="flex flex-col"><Fill min={280}><TermChart term={d.term_structure} height="100%" /></Fill></CardBody>
            </Card>
          </div>
          <div className="grid gap-3 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader icon={<Activity />} title={t('DVOL — indice di volatilità implicita')} subtitle={t('Volatilità attesa a 30 giorni dalle opzioni Deribit (%, annualizzata)')} />
              <CardBody className="flex flex-col"><Fill min={240}>
                <TimeLinesChart height="100%" zoom legend={false} yFmt={(v) => v.toFixed(0)} lines={[{ name: 'DVOL', data: d.dvol.series, color: C.blue, area: true }]} />
              </Fill></CardBody>
            </Card>
            <Card>
              <CardHeader icon={<Waves />} title={tr('Volatilità', 'Volatility')} subtitle={t('Implicita vs realizzata')} />
              <CardBody className="flex flex-col gap-3">
                <div className="dgrid grid-cols-2">
                  <Stat k={t('DVOL attuale')} v={fx(d.dvol.current, 1)} />
                  <Stat k={t('Variazione 7 giorni')} v={fin(d.dvol.change_7d) ? `${sfx(d.dvol.change_7d)} pt` : DASH} />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                    <span>{t('Percentile 1 anno')}</span><span className="tnum font-medium text-white">{ordinal(d.dvol.pct_1y)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="h-full rounded-full" style={{ width: `${fin(d.dvol.pct_1y) ? d.dvol.pct_1y : 0}%`, background: `linear-gradient(90deg, ${hexA(C.blue, 0.35)}, ${C.blue})` }} />
                  </div>
                </div>
                <div>
                  <KV k={t('Percentile dal 2021')}>{ordinal(d.dvol.pct_all)}</KV>
                  <KV k={t('Minimo / massimo 1 anno')}>{fx(d.dvol.min_1y, 1)} / {fx(d.dvol.max_1y, 1)}</KV>
                  <KV k={t('Volatilità realizzata 30 giorni')}>{fin(d.dvol.rv_30d) ? `${d.dvol.rv_30d.toFixed(1)}%` : DASH}</KV>
                  <KV k={t('Spread implicita − realizzata')}>{fin(d.dvol.iv_rv_spread) ? `${sfx(d.dvol.iv_rv_spread)} pt` : DASH}</KV>
                </div>
              </CardBody>
            </Card>
          </div>
          {/* gamma profile and settlement history each span the width (the history is a short, wide table) */}
          <Card>
            <CardHeader icon={<Sigma />} title={t('Profilo gamma per strike')} subtitle={t("Dollari di delta per un movimento dell'1% · tutte le scadenze · ±20%")} />
            <CardBody><GammaChart profile={d.gamma.profile} price={d.index_price} height={300} /></CardBody>
          </Card>
          <ExpiryHistoryCard h={d.expiry_history} />
          <MethodNote title={t('Fonti e metodo')}><p>{d.note}</p><p>{t('Aggiornato {d} · dati live con cache di 45 secondi.', { d: date(d.updated_at) })}</p></MethodNote>
        </div>
      )}
    </Q>
  )
}

// ===================================================================== HOLDER
function HoldersKpis({ d }: { d: HoldersData }) {
  const k = d.kpi
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 min-[1700px]:grid-cols-6">
      <KpiCell icon={<Coins />} label={t('Costo medio STH')} value={usd(k.sth_realized_price)} foot={t('Prezzo {p} dal costo medio', { p: pct(k.dist_sth, 1) })} />
      <KpiCell icon={<Gauge />} label="STH-MVRV" value={<>{fx(k.sth_mvrv)}{unit('×')}</>} foot={cap(t('Zona {z}', { z: holderZone(k.zone).toLowerCase() }))} />
      <KpiCell icon={<Coins />} label={t('Costo medio LTH')} value={usd(k.lth_realized_price)} foot={t('Prezzo {p} dal costo medio', { p: pct(k.dist_lth, 1) })} />
      <KpiCell icon={<Gauge />} label="LTH-MVRV" value={<>{fx(k.lth_mvrv)}{unit('×')}</>} foot={t('Prezzo / costo medio LTH')} />
      <KpiCell icon={<Repeat />} label={t('SOPR STH (7 giorni)')} value={fx(k.sth_sopr_7d, 3)} foot={fin(k.sth_sopr_7d) ? (k.sth_sopr_7d < 1 ? t('Vendite in perdita') : t('Vendite in profitto')) : undefined} />
      <KpiCell icon={k.regime === 'above' ? <TrendingUp /> : <TrendingDown />} label={k.regime === 'above' ? t('Sopra il costo STH da') : t('Sotto il costo STH da')} value={fin(k.regime_days) ? <>{k.regime_days}{unit(dayUnit())}</> : DASH}
        foot={t('{n} giorni entro ±3% in 1 anno', { n: d.tests_1y })} />
    </KpiStrip>
  )
}

function HoldersTab() {
  const q = useHolders()
  const [log, setLog] = useState(false)
  const [mv, setMv] = useState<'sth' | 'lth'>('sth')
  return (
    <Q q={q} loading={<PageSkeleton />} isEmpty={(d) => !d.series?.price?.length}>
      {(d) => {
        const b = d.bands
        const mvLines = mv === 'sth'
          ? [{ y: 1, color: GRID0, label: '1.0' }, { y: 0.9, color: hexA(C.grey, 0.35), label: '0.9' }, { y: 1.2, color: hexA(C.grey, 0.35), label: '1.2' }, { y: 1.4, color: hexA(C.grey, 0.35), label: '1.4' },
            { y: b.sd2_high, color: hexA(C.purple, 0.55), label: '+2σ' }, { y: b.sd2_low, color: hexA(C.purple, 0.55), label: '−2σ' }]
          : [{ y: 1, color: GRID0, label: '1.0' }]
        return (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <Clock size={14} className="shrink-0 text-slate-400" />
              <span className="min-w-0">{t('Dati on-chain con 7 giorni di ritardo (BGeometrics, piano gratuito) · ultimo dato {d} · MVRV e distanze calcolati sul prezzo attuale {p}', { d: date(d.as_of), p: usd(d.price) })}</span>
            </div>
            <HoldersKpis d={d} />
            <div className="grid gap-3 xl:grid-cols-3">
              <Card className="xl:col-span-2">
                <CardHeader icon={<Users />} updatedAt={q.dataUpdatedAt} title={t('Prezzo vs costo medio degli holder')} subtitle={t('Prezzo realizzato STH (< 155 giorni) e LTH (> 155 giorni)')}
                  right={<Toggle on={log} onClick={() => setLog(!log)}>{t('Scala log')}</Toggle>} />
                <CardBody className="flex flex-col"><Fill min={380}>
                  <TimeLinesChart height="100%" zoom log={log} lines={[
                    { name: t('Prezzo BTC'), data: d.series.price, color: C.btc, area: true },
                    { name: t('Costo medio STH'), data: d.series.sth_rp, color: C.blue },
                    { name: t('Costo medio LTH'), data: d.series.lth_rp, color: C.purple },
                  ]} />
                </Fill></CardBody>
              </Card>
              <div className="flex flex-col gap-3">
                <Card>
                  <CardHeader icon={<MessageSquareText />} title={tr('Lettura', 'Reading')} subtitle={t('Holder recenti e di lungo periodo')} />
                  <CardBody><MoreList items={d.bullets} /></CardBody>
                </Card>
                <Card>
                  <CardHeader icon={<History />} title={t('Sopra / sotto il costo medio STH')} subtitle={t("Ultimi periodi · {n} giorni entro ±3% nell'ultimo anno", { n: d.tests_1y })} />
                  <CardBody>
                    {[...d.regimes].reverse().map((r) => (
                      <KV key={r.start} k={<>{date(r.start)} – {date(r.end)}</>}>
                        <span className="text-xs font-normal text-slate-400">{r.days}{dayUnit()}</span>
                        <Badge color={r.above ? 'up' : 'down'} className="ml-2 w-14 justify-center">{r.above ? tr('Sopra', 'Above') : tr('Sotto', 'Below')}</Badge>
                      </KV>
                    ))}
                  </CardBody>
                </Card>
              </div>
            </div>
            <div className="grid gap-3 xl:grid-cols-3">
              <Card className="xl:col-span-2">
                <CardHeader icon={<Gauge />} title={mv === 'sth' ? 'STH-MVRV' : 'LTH-MVRV'} subtitle={mv === 'sth' ? t('Prezzo / costo medio STH · livelli 0.9–1.4 e bande ±2σ dello storico') : t('Prezzo / costo medio LTH')}
                  info={t('Sotto 1 gli holder recenti sono in perdita (capitolazione, spesso vicino ai minimi); sopra 1.3–1.4 hanno profitti eccessivi (surriscaldamento). Il costo medio STH funge da supporto nei bull market e da resistenza nei bear market.')}
                  right={<Segmented options={[{ value: 'sth' as const, label: 'STH' }, { value: 'lth' as const, label: 'LTH' }]} value={mv} onChange={setMv} />} />
                <CardBody className="flex flex-col"><Fill min={320}>
                  <TimeLinesChart height="100%" zoom legend={false} yFmt={(v) => v.toFixed(2)} markLines={mvLines}
                    lines={[{ name: mv === 'sth' ? 'STH-MVRV' : 'LTH-MVRV', data: mv === 'sth' ? d.series.sth_mvrv : d.series.lth_mvrv, color: C.blue, area: true }]} />
                </Fill></CardBody>
              </Card>
              <Card>
                <CardHeader icon={<ListChecks />} title={t('BTC per zona STH-MVRV')} subtitle={t('Rendimenti successivi dal {d}', { d: date(d.series.sth_mvrv[0]?.time) })}
                  info={t('Rendimento mediano di BTC a 30 e 90 giorni dai giorni in cui STH-MVRV era nella fascia indicata. Lo storico gratuito copre circa un ciclo: campione piccolo, da leggere come indicazione.')} />
                <CardBody>
                  <div className={TW}>
                    <table className="tbl min-w-[380px]">
                      <thead><tr>
                        <th className={TL}>{tr('Fascia', 'Band')}</th><th className="text-right">{tr('Giorni', 'Days')}</th>
                        <th className="text-right">{`30${dayUnit()}`}</th><th className={TR}>{t('{n} · positivi', { n: `90${dayUnit()}` })}</th>
                      </tr></thead>
                      <tbody>
                        {d.buckets.map((r) => {
                          const cur = r.label === d.kpi.zone
                          return (
                            <tr key={r.range}>
                              <td className={clsx(TL, 'whitespace-nowrap', cur ? 'font-medium text-white' : 'text-slate-200')}>{r.range} <span className="text-xs text-slate-400">{holderZone(r.label)}</span>
                                {cur && <Badge color="blue" className="ml-2">{tr('Ora', 'Now')}</Badge>}</td>
                              <td className="text-right text-slate-300">{r.days}</td>
                              <td className="text-right"><Change value={r.fwd30_median} digits={1} /></td>
                              <td className={TR}><Change value={r.fwd90_median} digits={1} /> <span className="text-slate-400">· {fin(r.fwd90_hit) ? `${r.fwd90_hit.toFixed(0)}%` : DASH}</span></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="dgrid mt-3 grid-cols-2">
                    <Stat k={t('Minimo STH-MVRV')} v={fx(d.extremes.min)} sub={date(d.extremes.min_time)} />
                    <Stat k={t('Massimo STH-MVRV')} v={fx(d.extremes.max)} sub={date(d.extremes.max_time)} />
                  </div>
                </CardBody>
              </Card>
            </div>
              <Card>
                <CardHeader icon={<Repeat />} title={t('SOPR degli holder recenti')} subtitle={t('Media 7 giorni · sotto 1 = monete vendute in perdita')} />
                <CardBody>
                  {d.series.sth_sopr.length
                    ? <TimeLinesChart height={260} zoom legend={false} yFmt={(v) => v.toFixed(3)} markLines={[{ y: 1, color: GRID0, label: '1.0' }]} lines={[{ name: t('SOPR STH (7 giorni)'), data: d.series.sth_sopr, color: C.purple }]} />
                    : <EmptyState compact text={t('SOPR non disponibile dalla fonte gratuita.')} />}
                </CardBody>
              </Card>
            <MethodNote title={t('Fonti e metodo')}><p>{d.note}</p></MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

// ===================================================================== SENTIMENT
function SentimentHero({ d, updatedAt }: { d: SentimentData; updatedAt: number }) {
  const c = d.current
  const cz = d.backtest.zones.find((z) => z.zone === c.zone)
  return (
    <Card>
      <CardHeader icon={<Gauge />} updatedAt={updatedAt} title={t('Indice di sentiment contrarian')} subtitle={t('0 = paura massima · 100 = euforia')}
        info={t("Media dei punteggi delle componenti (percentile storico senza lookahead). In chiave contrarian la paura estrema è storicamente un'opportunità, l'euforia un rischio.")}
        right={<span className="text-xs text-slate-400">{t('Al {d}', { d: date(c.as_of) })}</span>} />
      <CardBody className="grid gap-x-8 gap-y-5 xl:grid-cols-5">
        <div className="flex flex-col gap-4 xl:col-span-2">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
              <div className="tnum text-4xl font-semibold tracking-[-0.02em] text-white">{c.value.toFixed(0)}<span className="ml-1 text-sm font-normal text-slate-400">/ 100</span></div>
              <Badge color="blue" className="mb-1.5">{t(c.zone)}</Badge>
              <div className="tnum pb-1.5 text-xs text-slate-400">{`7${dayUnit()}`} {fin(c.change_7d) ? `${sfx(c.change_7d, 0)} pt` : DASH} · {t('{o} percentile storico', { o: ordinal(c.percentile) })}</div>
            </div>
            <SentimentTrack value={c.value} />
          </div>
          <MoreList items={d.explanation} />
          {cz && (
            <div>
              <div className="label mb-1">{t('Storico nella zona attuale · {z}', { z: t(cz.zone) })}</div>
              <div className="dgrid grid-cols-2 sm:grid-cols-4">
                <Stat k={t('Giorni in zona')} v={cz.days.toLocaleString('en-US')} sub={t('{n} episodi', { n: cz.episodes })} />
                <Stat k={t('Mediana {n}', { n: `30${dayUnit()}` })} v={<Change value={cz.r30_median} digits={1} />} sub={fin(cz.hit30) ? t('Positivi {p}%', { p: cz.hit30.toFixed(0) }) : undefined} />
                <Stat k={t('Mediana {n}', { n: `90${dayUnit()}` })} v={<Change value={cz.r90_median} digits={1} />} sub={fin(cz.hit90) ? t('Positivi {p}%', { p: cz.hit90.toFixed(0) }) : undefined} />
                <Stat k={t('Tutti i giorni · {n}', { n: `90${dayUnit()}` })} v={<Change value={d.backtest.baseline.r90_median} digits={1} />}
                  sub={fin(d.backtest.baseline.hit90) ? t('Positivi {p}%', { p: d.backtest.baseline.hit90.toFixed(0) }) : undefined} />
              </div>
            </div>
          )}
          <MiniTrend data={d.history.composite.slice(-90)} label={t('Indice · ultimi 90 giorni')} color={C.blue} min={64} />
        </div>
        <div className="flex flex-col xl:col-span-3">
          <div className="label mb-1">{t('Componenti · punteggio 0–100')}</div>
          {d.components.map((k, i) => (
            <div key={k.key} className={clsx('flex flex-col gap-1.5 py-2.5', i > 0 && 'border-t border-line')} title={k.text}>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-slate-200">{k.label} <span className="text-xs text-slate-400">{k.method !== 'percentile' ? `· ${k.method}` : ''}</span></span>
                <span className="tnum shrink-0 text-xs text-slate-400">{k.raw_display}<span className="ml-3">{t('Punteggio')} <b className="font-medium text-white">{fin(k.score) ? k.score.toFixed(0) : DASH}</b></span></span>
              </div>
              <ScoreTrack score={k.score} />
              <span className="line-clamp-1 text-xs text-slate-400">{k.text}</span>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function PremiumCard({ d }: { d: SentimentData }) {
  const [v, setV] = useState<'daily' | 'hourly'>('daily')
  const p = d.premium
  return (
    <Card>
      <CardHeader icon={<Coins />} title="Coinbase premium" subtitle={v === 'daily' ? t('Coinbase BTC-USD vs Binance BTC-USDT · media 7 giorni, 4 anni (%)') : t('Premio orario, ultimi 30 giorni (%)')}
        info={t('Premio positivo = su Coinbase (clientela USA e istituzionale) si paga più che su Binance: domanda statunitense forte. Negativo = domanda USA debole, spesso nelle fasi di paura.')}
        right={<Segmented options={[{ value: 'daily' as const, label: t('Media 7 giorni') }, { value: 'hourly' as const, label: t('Orario 30 giorni') }]} value={v} onChange={setV} />} />
      <CardBody className="flex flex-col gap-3">
        <div className="dgrid grid-cols-2 md:grid-cols-4">
          <Stat k={t('Premio attuale')} v={<Change value={p.live} digits={3} />}
            sub={fin(p.live_usd) ? t('{v} per BTC', { v: `${p.live_usd < 0 ? '−' : '+'}$${Math.abs(p.live_usd).toFixed(0)}` }) : undefined} />
          <Stat k={t('Media 7 giorni')} v={<Change value={p.avg_7d} digits={3} />} />
          <Stat k={t('Percentile 4 anni')} v={ordinal(p.percentile_4y)} />
          <Stat k="Coinbase / Binance" v={usd(p.coinbase)} sub={`Binance ${usd(p.binance)}`} />
        </div>
        <TimeLinesChart height={260} zoom={v === 'daily'} legend={false} compactTip={v === 'hourly'} yFmt={(x) => `${x.toFixed(2)}%`} markLines={[{ y: 0, color: GRID0 }]}
          lines={[{ name: t('Premio Coinbase'), data: v === 'daily' ? p.daily : p.hourly, color: C.blue, type: 'bar' }]} />
        {p.text && <p className="text-sm text-slate-300">{p.text}</p>}
      </CardBody>
    </Card>
  )
}

function SentimentTab() {
  const q = useSentiment()
  return (
    <Q q={q} loading={<PageSkeleton />} isEmpty={(d) => !d.history?.composite?.length}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <SentimentHero d={d} updatedAt={q.dataUpdatedAt} />
          <Card>
            <CardHeader icon={<LineChart />} title={t("Storico dell'indice")} subtitle={t('Indice contrarian (sinistra) e prezzo BTC (destra) · soglie 25 e 75')} />
            <CardBody className="flex flex-col"><Fill min={340}>
              <TimeLinesChart height="100%" zoom yMin={0} yMax={100} yFmt={(v) => v.toFixed(0)} y2Fmt={(v) => `$${Math.round(v / 1000)}K`}
                markLines={[{ y: 25, color: hexA(C.grey, 0.5), label: t('Paura estrema') }, { y: 75, color: hexA(C.grey, 0.5), label: t('Euforia') }]}
                lines={[{ name: t('Indice sentiment'), data: d.history.composite, color: C.blue, area: true }, { name: t('Prezzo BTC'), data: d.history.price, color: C.btc, axis: 1, width: 1.25 }]} />
            </Fill></CardBody>
          </Card>
          <div className="grid gap-3 min-[2200px]:grid-cols-2">
            <Card>
              <CardHeader icon={<History />} title={t("Backtest dell'indice")} subtitle={t('Rendimenti BTC successivi per zona · dal {d}', { d: date(d.backtest.since) })}
                info={t("Mediana dei rendimenti di BTC a 7/30/90 giorni dalla chiusura dei giorni in cui l'indice era nella zona. 'Positivi' = quota di casi con rendimento > 0. Episodi = gruppi di giorni separati da almeno 7 giorni.")} />
              <CardBody><ZoneBacktestTable bt={d.backtest} currentZone={d.current.zone} /></CardBody>
            </Card>
            <Card>
              <CardHeader icon={<ListChecks />} title={t('Backtest per componente')} subtitle={t('Paura = punteggio ≤ {a} · euforia ≥ {b}', { a: d.backtest.thresholds.component_fear, b: d.backtest.thresholds.component_greed })}
                info={t('Ogni componente presa da sola: rendimento mediano di BTC dopo i suoi estremi. Le componenti senza abbastanza storico (rapporto long/short, skew) contribuiscono solo alla lettura attuale.')} />
              <CardBody><ComponentBacktestTable bt={d.backtest} /></CardBody>
            </Card>
          </div>
          <PremiumCard d={d} />
          <MethodNote title={t('Fonti e metodo')}><p>{d.note}</p></MethodNote>
        </div>
      )}
    </Q>
  )
}

// ===================================================================== pagina
/** Labels stay Italian (module level); translated at render with t(). */
const TABS = [
  { value: 'opzioni', label: 'Opzioni', sub: 'Open interest, max pain, put/call, skew e volatilità implicita delle opzioni BTC su Deribit.' },
  { value: 'holder', label: 'Holder', sub: 'Costo medio e profitto degli holder recenti (STH) e di lungo periodo (LTH).' },
  { value: 'sentiment', label: 'Sentiment', sub: 'Indice contrarian di paura ed euforia con backtest dei rendimenti successivi.' },
] as const
type Tab = (typeof TABS)[number]['value']

export default function PositioningPage() {
  const [tab, changeTab] = useTab<Tab>(TABS.map((x) => x.value), 'opzioni')
  const cur = TABS.find((x) => x.value === tab) ?? TABS[0]
  return (
    <div>
      <PageTitle title={t('Posizionamento')} subtitle={t(cur.sub)} />
      <TabBar tabs={TABS.map((x) => ({ value: x.value, label: x.value === 'opzioni' ? tr('Opzioni', 'Options') : t(x.label) }))} value={tab} onChange={changeTab} />
      {tab === 'opzioni' && <OptionsTab />}
      {tab === 'holder' && <HoldersTab />}
      {tab === 'sentiment' && <SentimentTab />}
    </div>
  )
}
