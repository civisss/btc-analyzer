/* Scheda "Kronos" della pagina Previsioni: foundation model per candele (arXiv:2508.02739) integrato in modo onesto —
 * ventaglio di percorsi sulle candele reali, regime dichiarato con soglie fisse, backtest fuori campione prima/dopo il
 * pre-addestramento contro naive, deriva, passeggiata aleatoria e il nostro modello a 1 giorno, registro live separato.
 * Nessuna regola di trading. Testi composti qui (dal backend arrivano solo chiavi e numeri). */
import { useEffect, useMemo, useState } from 'react'
import { Activity, Cpu, FlaskConical, Gauge, History, LineChart, Megaphone, Scale, ShieldCheck, Sigma, Sparkles, Waypoints } from 'lucide-react'
import { live, useLive, useLivePrice } from '../api/live'
import type { Candle } from '../api/types'
import {
  useKronos, useKronosBacktest, useKronosStatus, useKronosTrack,
  type KMetrics, type KPeriod, type KRowKey, type KVerdictCode, type KronosBacktest, type KronosForecast, type KronosStatus,
  type KronosTf, type KronosTrack, type RegimeCode, type RegimeVerdict,
} from '../api/kronos'
import { Badge, Card, CardBody, CardHeader, Change, Fill, KpiCell, KpiStrip, MethodNote, Segmented, Skeleton, Toggle, clsx } from '../components/ui'
import { BandBar } from '../widgets/forecastOneDay'
import { KronosFanChart, KronosStepChart, TF_SEC, type CurveMetric } from '../widgets/kronos'
import { t, tfLabel } from '../i18n'
import { date, dateTime, dayUnit, usd, usdCompact } from '../lib/format'

type Num = number | null | undefined
const fin = (v: Num): v is number => v != null && Number.isFinite(v)
const pc = (v: Num, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const x3 = (v: Num) => (fin(v) ? v.toFixed(3) : '—')
const x2 = (v: Num) => (fin(v) ? v.toFixed(2) : '—')
const pv = (v: Num) => (!fin(v) ? '—' : v < 0.001 ? '< 0.001' : v < 0.01 ? v.toFixed(3) : v.toFixed(2))
const k0 = (v: Num) => (fin(v) ? usdCompact(v, 1) : '—')
const sec = (v: Num) => (!fin(v) ? '—' : v < 10 ? `${v.toFixed(1)} s` : v < 120 ? `${Math.round(v)} s` : `${(v / 60).toFixed(1)} min`)
const mb = (v: Num) => (fin(v) ? `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)} MB` : '—')

const TFS: KronosTf[] = ['1h', '4h', '1d']
const H_OPTS = [6, 12, 24, 48]
const S_OPTS = [20, 50, 100]
const MODEL = 'small'

const VERDICT: Record<KVerdictCode, { label: string; short: string; color: 'up' | 'down' | 'slate' | 'blue' }> = {
  edge: { label: 'Vantaggio significativo sul naive', short: 'Vantaggio', color: 'up' },
  small_edge: { label: 'Vantaggio piccolo ma significativo', short: 'Vantaggio piccolo', color: 'up' },
  no_edge: { label: 'Nessun vantaggio significativo sul naive', short: 'Nessun vantaggio', color: 'slate' },
  worse: { label: 'Peggiore del naive', short: 'Peggiore', color: 'down' },
  worse_ns: { label: 'Nessun vantaggio sul naive', short: 'Nessun vantaggio', color: 'slate' },
  baseline: { label: 'Riferimento', short: 'Riferimento', color: 'blue' },
  n_a: { label: 'Dati insufficienti', short: 'Dati insufficienti', color: 'slate' },
}
function VerdictBadge({ code, short }: { code: KVerdictCode | undefined; short?: boolean }) {
  const v = VERDICT[code ?? 'n_a']
  return <Badge color={v.color} className="max-w-full truncate">{t(short ? v.short : v.label)}</Badge>
}
const REGIME: Record<RegimeCode, { label: string; color: 'up' | 'down' | 'slate' }> = {
  trend_up: { label: 'Trend al rialzo', color: 'up' },
  trend_down: { label: 'Trend al ribasso', color: 'down' },
  choppy: { label: 'Laterale (choppy)', color: 'slate' },
}
const REGIME_SHORT: Record<RegimeCode, string> = { trend_up: 'Trend rialzo', trend_down: 'Trend ribasso', choppy: 'Laterale' }
const REG_VERDICT: Record<RegimeVerdict, { label: string; color: 'up' | 'slate' | 'blue' }> = {
  useful: { label: 'Utile: movimenti più ampi e direzione corretta', color: 'up' },
  magnitude_only: { label: 'Anticipa solo l\'ampiezza, non la direzione', color: 'blue' },
  direction_only: { label: 'Direzione sopra il caso, ampiezza no', color: 'blue' },
  not_useful: { label: 'Nessuna utilità dimostrata', color: 'slate' },
  too_few: { label: 'Troppi pochi casi', color: 'slate' },
}
const REG_SHORT: Record<RegimeVerdict, string> = {
  useful: 'Utile', magnitude_only: 'Solo ampiezza', direction_only: 'Solo direzione', not_useful: 'Non utile', too_few: 'Pochi casi',
}
/** MASE colour (naive = 1): clearly below = better, above = worse. */
const maseCls = (v: Num) => (!fin(v) ? 'text-slate-400' : v <= 0.97 ? 'text-up' : v >= 1.03 ? 'text-down' : 'text-white')
const ROWS: { key: KRowKey; name: string; base?: boolean }[] = [
  { key: 'kronos', name: 'Kronos-small · media dei percorsi' },
  { key: 'kronos_median', name: 'Kronos-small · mediana' },
  { key: 'naive', name: 'Naive: prezzo all\'origine', base: true },
  { key: 'drift', name: 'Deriva media storica', base: true },
  { key: 'rw_vol', name: 'Passeggiata aleatoria + volatilità storica', base: true },
  { key: 'oneday', name: 'Nostro modello a 1 giorno (LightGBM)' },
]

function Cell({ k, v, sub, className }: { k: React.ReactNode; v: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0 px-3 py-2.5', className)}>
      <div className="label truncate">{k}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-white">{v}</div>
      <div className="tnum mt-0.5 truncate text-xs text-slate-400">{sub ?? <span className="text-slate-600">—</span>}</div>
    </div>
  )
}

/** Candele reali con la candela in corso dal WebSocket (kline del timeframe se presente, altrimenti ticker). */
function useLiveCandles(candles: Candle[], tf: KronosTf): Candle[] {
  const kline = useLive((s) => s.klines[tf] ?? null)
  const price = useLivePrice()
  return useMemo(() => {
    if (!candles.length) return candles
    const last = candles[candles.length - 1]
    if (kline && kline.time === last.time) return [...candles.slice(0, -1), { ...last, high: Math.max(last.high, kline.high), low: Math.min(last.low, kline.low), close: kline.close }]
    if (kline && kline.time === last.time + TF_SEC[tf]) return [...candles, kline]
    if (price && price > 0 && Date.now() / 1000 < last.time + TF_SEC[tf]) return [...candles.slice(0, -1), { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }]
    return candles
  }, [candles, kline, price, tf])
}

const horizonText = (tf: KronosTf, h: number) => {
  const hours = (TF_SEC[tf] * h) / 3600
  return hours < 48 ? t('{n} ore', { n: hours }) : t('{n} giorni', { n: Math.round(hours / 24) })
}

// ------------------------------------------------------------------ previsione corrente
function CurrentCard({ d, bt }: { d: KronosForecast; bt?: KronosBacktest }) {
  const wsLive = useLivePrice()
  const live = wsLive ?? d.live_price
  const e = d.end
  const hl = bt?.headline?.[MODEL]?.[d.tf]
  const ref = d.ref_price
  const liveChg = fin(live) && fin(ref) ? (live / ref - 1) * 100 : null
  const target = d.steps?.length ? d.steps[d.steps.length - 1] + TF_SEC[d.tf] : null
  return (
    <Card>
      <CardHeader title={t('Previsione corrente')} icon={<Sparkles />}
        subtitle={target ? t('Chiusura del {d} · tra {h}', { d: dateTime(target), h: horizonText(d.tf, d.h) }) : t('In calcolo')} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <div className="label">{t('Mediana a fine orizzonte')}</div>
            <div className="tnum mt-1 text-3xl font-semibold tracking-[-0.02em] text-white">{e ? usd(e.median) : '—'}</div>
          </div>
          <div className="pb-1 text-right text-xs text-slate-400">
            {e && <Change value={e.change_pct} digits={2} />} <span className="ml-1">{t('vs {p}', { p: usd(ref) })}</span>
          </div>
        </div>
        {e && fin(ref) && <BandBar p05={e.p05} p25={e.p25} p50={e.median} p75={e.p75} p95={e.p95} refPrice={ref} live={live} />}
        <div className="dgrid -mx-1 grid-cols-2">
          <Cell k={t('Media dei percorsi')} v={e ? usd(e.mean) : '—'} sub={t('Punto di KronosPredictor')} />
          <Cell k={t('Prob. rialzo')} v={pc(e?.up_prob, 0)} sub={t('Quota dei {n} percorsi', { n: d.samples })} />
          <Cell k={t('Banda 90%')} v={e ? `${k0(e.p05)}–${k0(e.p95)}` : '—'} sub={t('Ampiezza {p}', { p: pc(e?.width90_pct) })} />
          <Cell k={t('Prezzo live')} v={fin(live) ? usd(live) : '—'} sub={fin(liveChg) ? <><Change value={liveChg} digits={2} /> {t('vs chiusura')}</> : undefined} />
        </div>
        <p className="text-xs leading-relaxed text-slate-400">
          {hl && fin(hl.day_mase)
            ? (hl.day.code === 'edge' || hl.day.code === 'small_edge'
              ? t('Nel backtest dopo il pre-addestramento Kronos batte il naive a 1 giorno su questo timeframe (MASE {m}), ma il margine è piccolo: la banda conta più della mediana.', { m: x3(hl.day_mase) })
              : t('Nel backtest dopo il pre-addestramento Kronos non batte il naive a 1 giorno su questo timeframe (MASE {m}): leggi il ventaglio come incertezza, non come direzione.', { m: x3(hl.day_mase) }))
            : t('Backtest non ancora calcolato: nessuna affermazione di accuratezza. Leggi il ventaglio come incertezza, non come direzione.')}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ regime
function RegimeCard({ d, bt }: { d: KronosForecast; bt?: KronosBacktest }) {
  const r = d.regime
  const ev = bt?.regime?.[MODEL]?.[d.tf]?.post
  const rv = ev?.verdict ? REG_VERDICT[ev.verdict] : null
  return (
    <Card className="flex-1">
      <CardHeader title={t('Regime dei percorsi')} icon={<Waypoints />} subtitle={t('Accordo sulla direzione e dispersione a fine orizzonte')}
        right={r ? <Badge color={REGIME[r.code].color}>{t(REGIME[r.code].label)}</Badge> : undefined} />
      <CardBody className="flex flex-col gap-3">
        <div className="dgrid -mx-1 grid-cols-2">
          <Cell k={t('Accordo')} v={r ? pc(100 * r.agree, 0) : '—'} sub={t('Soglia {s}', { s: pc(100 * (r?.agree_min ?? 0.65), 0) })} />
          <Cell k={t('Mediana / dev. std.')} v={r ? x2(r.snr) : '—'} sub={t('Soglia {s}', { s: x2(r?.snr_min ?? 0.3) })} />
          <Cell k={t('Dispersione')} v={r ? pc(r.sd_ret_pct) : '—'} sub={t('Dev. std. dei rendimenti')} />
          <Cell k={t('Efficienza')} v={r ? x2(r.er) : '—'} sub={t('1 = rettilineo')} />
        </div>
        <p className="text-xs leading-relaxed text-slate-400">
          {t('«Trend» se almeno il {a} dei percorsi finisce dalla stessa parte del prezzo di oggi e la mediana del rendimento vale almeno {s} deviazioni standard; altrimenti «laterale». Soglie fissate prima del backtest.', { a: pc(100 * (r?.agree_min ?? 0.65), 0), s: x2(r?.snr_min ?? 0.3) })}
        </p>
        {ev && rv && (
          <div className="mt-auto flex flex-col gap-1.5 border-t border-line pt-3">
            <div className="flex items-center justify-between gap-2"><span className="label">{t('Nel backtest (dopo il pre-addestramento)')}</span><Badge color={rv.color} className="max-w-[55%] truncate">{t(REG_SHORT[ev.verdict!])}</Badge></div>
            <p className="text-xs leading-relaxed text-slate-300">
              {t('Movimento medio successivo {a} con «trend» contro {b} con «laterale» (p {p}); direzione corretta nei «trend» {h} (p {q}, {n} casi indipendenti).', {
                a: pc(ev.trend?.abs_ret_pct, 2), b: pc(ev.choppy?.abs_ret_pct, 2), p: pv(ev.p_absret), h: pc(ev.hit_trend, 0), q: pv(ev.p_hit_trend), n: ev.n_trend_indep ?? 0,
              })}
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ tabella del backtest
function BacktestTable({ bt, tf, period, step }: { bt: KronosBacktest; tf: KronosTf; period: KPeriod; step: number }) {
  const blk = bt.evaluation?.[MODEL]?.[tf]?.[period]?.[String(step)]
  const rows = ROWS.filter((r) => blk?.rows[r.key])
  if (!blk) return <p className="py-6 text-sm text-slate-400">{t('Nessun dato per questa combinazione.')}</p>
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[860px] min-[1700px]:min-w-[1180px]">
        <thead><tr>
          <th className="pl-4 sm:pl-5">{t('Modello')}</th><th className="text-right">n</th><th className="text-right">MAPE</th>
          <th className="text-right" title={t('Errore medio diviso quello del naive sugli stessi giorni: sotto 1 batte il naive')}>MASE</th>
          <th className="text-right">{t('Direzione')}</th><th className="text-right max-[1699px]:hidden" title={t('Test binomiale su origini non sovrapposte')}>{t('p (vs 50%)')}</th>
          <th className="text-right max-[1699px]:hidden">{t('Sempre rialzo')}</th><th className="text-right">{t('Corr. rendimenti')}</th>
          <th className="text-right">{t('Copertura 50/90%')}</th>
          <th className="text-right" title={t('CRPS rispetto alla passeggiata aleatoria con volatilità storica: sopra 0 la distribuzione è migliore')}>{t('CRPS skill')}</th>
          <th className="text-right max-[1699px]:hidden" title={t('Diebold-Mariano sull\'errore assoluto, contro il naive (varianza HAC)')}>{t('DM p')}</th>
          <th className="pr-4 sm:pr-5">{t('Verdetto')}</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const m = blk.rows[r.key] as KMetrics
            const isModel = r.key === 'kronos'
            return (
              <tr key={r.key} className={clsx(isModel && '[&>td]:bg-white/[0.035]')}>
                <td className="pl-4 sm:pl-5">
                  <span className={clsx(isModel ? 'font-semibold text-white' : 'text-slate-200')}>{t(r.name)}</span>
                  {r.base && <span className="ml-1.5 text-2xs text-slate-500">{t('baseline')}</span>}
                </td>
                <td className="text-right text-slate-400">{m.n}</td>
                <td className="text-right text-slate-300">{pc(m.mape, 2)}</td>
                <td className={clsx('text-right text-base font-semibold', maseCls(m.mase))}>{x3(m.mase)}</td>
                <td className="text-right font-semibold text-white">{pc(m.hit_rate)}</td>
                <td className={clsx('text-right max-[1699px]:hidden', fin(m.p_dir) && m.p_dir < 0.05 ? 'text-slate-100' : 'text-slate-400')}>{pv(m.p_dir)}</td>
                <td className="text-right text-slate-400 max-[1699px]:hidden">{pc(m.always_up)}</td>
                <td className="text-right text-slate-200">{x2(m.corr_ret)}</td>
                <td className="text-right text-slate-300">{fin(m.coverage_90) ? `${pc(m.coverage_50, 0)} / ${pc(m.coverage_90, 0)}` : '—'}</td>
                <td className={clsx('text-right', fin(m.crps_skill) ? (m.crps_skill > 0 ? 'text-up' : 'text-down') : 'text-slate-400')}>{fin(m.crps_skill) ? `${m.crps_skill > 0 ? '+' : '−'}${Math.abs(m.crps_skill).toFixed(1)}%` : '—'}</td>
                <td className="text-right text-slate-300 max-[1699px]:hidden">{pv(m.dm_p)}</td>
                <td className="pr-4 sm:pr-5"><VerdictBadge code={m.verdict?.code} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ verdetto per timeframe
function VerdictCard({ bt }: { bt: KronosBacktest }) {
  const hl = bt.headline?.[MODEL] ?? {}
  const ev = bt.evaluation?.[MODEL] ?? {}
  return (
    <Card className="xl:col-span-5">
      <CardHeader title={t('Verdetto')} icon={<Scale />} subtitle={t('Kronos-small contro il naive, calcolato dai dati dopo il pre-addestramento')} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-col">
          {TFS.map((tf) => {
            const h = hl[tf]
            const ds = String(bt.day_step?.[tf] ?? 1)
            const pre = ev[tf]?.pre?.[ds]?.rows.kronos
            return (
              <div key={tf} className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2.5 first:border-t-0 first:pt-0">
                <span className="tnum text-sm font-semibold text-white">{tfLabel(tf)}</span>
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-200">{t('1 giorno avanti: MASE {m}', { m: x3(h?.day_mase) })}</div>
                  <div className="tnum truncate text-2xs text-slate-500">{t('Fine orizzonte {e} · prima del pre-addestramento {p}', { e: x3(h?.end_mase), p: x3(pre?.mase) })}</div>
                </div>
                <VerdictBadge code={h?.day.code} short />
              </div>
            )
          })}
        </div>
        <p className="mt-auto text-xs leading-relaxed text-slate-400">
          {bt.overall === 'edge' ? t('Vantaggio significativo su tutti i timeframe e orizzonti valutati.')
            : bt.overall === 'mixed' ? t('Risultato misto: un vantaggio compare solo in alcune combinazioni; va confermato dal registro live.')
              : bt.overall === 'worse' ? t('Su tutti i timeframe Kronos sbaglia più del naive dopo la fine del pre-addestramento.')
                : t('Nessun vantaggio significativo sul naive dopo la fine del pre-addestramento: le previsioni di Kronos non sono più accurate di «domani = oggi».')}
          {' '}{t('Il periodo precedente è mostrato a parte perché potrebbe essere stato visto in addestramento.')}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ utilità del regime (tutti i timeframe)
function RegimeUtilityCard({ bt, period }: { bt: KronosBacktest; period: KPeriod }) {
  const rg = bt.regime?.[MODEL] ?? {}
  return (
    <Card>
      <CardHeader title={t('Il regime serve?')} icon={<FlaskConical />} subtitle={t('Origini «trend» contro «laterale»: movimento successivo a fine orizzonte')} />
      <CardBody className="flex flex-col gap-3">
        <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
          <table className="tbl min-w-[520px]">
            <thead><tr>
              <th className="pl-4 sm:pl-5">{t('Timeframe')}</th><th className="text-right">{t('Trend')}</th>
              <th className="text-right" title={t('Movimento assoluto medio a fine orizzonte')}>{t('|Mov.| trend / laterale')}</th>
              <th className="text-right" title={t('Mann-Whitney unilaterale')}>p</th>
              <th className="text-right" title={t('Direzione corretta nelle origini «trend», casi non sovrapposti')}>{t('Direzione')}</th>
              <th className="pr-4 text-right sm:pr-5">{t('Verdetto')}</th>
            </tr></thead>
            <tbody>
              {TFS.map((tf) => {
                const r = rg[tf]?.[period]
                return (
                  <tr key={tf}>
                    <td className="pl-4 font-medium text-white sm:pl-5">{tfLabel(tf)}</td>
                    <td className="text-right text-slate-300">{pc(r?.share_trend, 0)}</td>
                    <td className="text-right text-slate-200">{r ? `${pc(r.trend?.abs_ret_pct, 2)} / ${pc(r.choppy?.abs_ret_pct, 2)}` : '—'}</td>
                    <td className="text-right text-slate-400">{pv(r?.p_absret)}</td>
                    <td className="text-right text-slate-200" title={t('p {p} · {n} casi', { p: pv(r?.p_hit_trend), n: r?.n_trend_indep ?? 0 })}>{pc(r?.hit_trend, 0)}</td>
                    <td className="pr-4 text-right sm:pr-5">{r?.verdict ? <Badge color={REG_VERDICT[r.verdict].color}>{t(REG_SHORT[r.verdict])}</Badge> : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-auto text-xs leading-relaxed text-slate-400">
          {t('«Utile» richiede entrambe le cose: movimenti successivi più ampi nelle origini «trend» (p < 0,05) e direzione corretta sopra il 50% su casi non sovrapposti (p < 0,05). La dispersione dei percorsi rispetto all\'ampiezza reale ha correlazione di Spearman {r} (1h), {s} (4h), {u} (1G).', {
            r: x2(rg['1h']?.[period]?.spearman_disp_absret), s: x2(rg['4h']?.[period]?.spearman_disp_absret), u: x2(rg['1d']?.[period]?.spearman_disp_absret),
          })}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ cosa promette il post e cosa dicono i dati
function ClaimsCard({ bt }: { bt: KronosBacktest }) {
  const hl = bt.headline?.[MODEL] ?? {}
  const ev = bt.evaluation?.[MODEL] ?? {}
  const anyEdge = TFS.some((tf) => ['edge', 'small_edge'].includes(hl[tf]?.day.code ?? ''))
  const corr = (tf: KronosTf) => ev[tf]?.post?.[String(bt.day_step?.[tf] ?? 1)]?.rows.kronos?.corr_ret
  const regOk = TFS.filter((tf) => hl[tf]?.regime === 'useful').map((tf) => tfLabel(tf))
  const items: { claim: string; data: string }[] = [
    { claim: t('«Previsioni accurate»'),
      data: t('Dopo il pre-addestramento, 1 giorno avanti: MASE {a} (1h), {b} (4h), {c} (1G) contro 1 del naive; direzione {d}, {e}, {f}.', {
        a: x3(hl['1h']?.day_mase), b: x3(hl['4h']?.day_mase), c: x3(hl['1d']?.day_mase), d: pc(hl['1h']?.day_hit, 0), e: pc(hl['4h']?.day_hit, 0), f: pc(hl['1d']?.day_hit, 0),
      }) },
    { claim: t('«Il previsto ricalca il reale»'),
      data: t('Ogni previsione parte dall\'ultimo prezzo: a breve termine anche il naive «ricalca» il grafico. Conta la correlazione dei rendimenti: {a} (1h), {b} (4h), {c} (1G).', { a: x2(corr('1h')), b: x2(corr('4h')), c: x2(corr('1d')) }) },
    { claim: t('«Riconosce trend e fasi laterali»'),
      data: regOk.length ? t('Regime utile nel backtest su: {l}. Negli altri timeframe nessuna utilità dimostrata.', { l: regOk.join(', ') })
        : t('Nessun timeframe supera il test: le origini «trend» non hanno movimenti successivi più ampi e più direzionali in modo significativo.') },
    { claim: t('«Sistema di trading»'),
      data: anyEdge ? t('Non incluso qui: un piccolo vantaggio statistico va verificato al netto di commissioni, slippage e su dati live prima di qualsiasi uso.')
        : t('Non incluso qui: senza un vantaggio statistico nemmeno al lordo dei costi, regole di entrata/uscita costruite sopra non hanno base.') },
  ]
  return (
    <Card>
      <CardHeader title={t('Cosa promette il post e cosa dicono i dati')} icon={<Megaphone />} subtitle={t('Affermazioni tipiche su Kronos, verificate sul nostro backtest')} />
      <CardBody className="flex flex-col gap-0">
        {items.map((x) => (
          <div key={x.claim} className="grid grid-cols-1 gap-1 border-t border-line py-2.5 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] sm:gap-3">
            <span className="text-sm font-medium text-white">{x.claim}</span>
            <span className="text-sm leading-relaxed text-slate-300">{x.data}</span>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ registro live
function TrackCard({ tr }: { tr: KronosTrack | undefined }) {
  const [rtf, setRtf] = useState<KronosTf>('1h')
  const recent = (tr?.tf?.[rtf]?.recent ?? []).slice(0, 6)
  return (
    <Card className="xl:col-span-7">
      <CardHeader title={t('Registro live')} icon={<History />}
        subtitle={tr?.from ? t('Previsioni emesse alla chiusura di ogni candela dal {d}, verificate alla scadenza', { d: date(tr.from) }) : t('Previsioni emesse alla chiusura di ogni candela, verificate alla scadenza')}
        right={<Segmented value={rtf} onChange={setRtf} options={TFS.map((x) => ({ value: x, label: tfLabel(x) }))} />} />
      <CardBody className="flex flex-col gap-3">
        <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
          <table className="tbl min-w-[560px]">
            <thead><tr>
              <th className="pl-4 sm:pl-5">{t('Timeframe')}</th><th className="text-right">{t('Emesse')}</th><th className="text-right" title={t('Verificate a 1 giorno dalla previsione')}>{t('Verificate')}</th>
              <th className="text-right">MASE</th><th className="text-right">{t('Direzione')}</th><th className="text-right">{t('Copertura 90%')}</th><th className="pr-4 text-right sm:pr-5">{t('In attesa')}</th>
            </tr></thead>
            <tbody>
              {TFS.map((tf) => {
                const g = tr?.tf?.[tf]
                const ds = { '1h': '24', '4h': '6', '1d': '1' }[tf]
                const m = g?.steps?.[ds]
                return (
                  <tr key={tf}>
                    <td className="pl-4 font-medium text-white sm:pl-5">{tfLabel(tf)}</td>
                    <td className="text-right text-slate-300">{g?.n_forecasts ?? 0}</td>
                    <td className="text-right text-slate-300">{m?.n ?? 0}</td>
                    <td className={clsx('text-right font-semibold', maseCls(m?.mase))}>{x3(m?.mase)}</td>
                    <td className="text-right text-slate-200">{pc(m?.hit_rate, 0)}</td>
                    <td className="text-right text-slate-200">{pc(m?.coverage_90, 0)}</td>
                    <td className="pr-4 text-right text-slate-400 sm:pr-5">{m?.pending ?? 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col">
          <div className="label mb-1">{t('Ultime previsioni {tf}', { tf: tfLabel(rtf) })}</div>
          {recent.length ? recent.map((x) => {
            const err = fin(x.day_actual) && fin(x.day_q50) ? (x.day_q50 / x.day_actual - 1) * 100 : null
            return (
              <div key={x.origin} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 border-t border-line py-2 first:border-t-0">
                <div className="min-w-0">
                  <div className="tnum truncate text-sm text-slate-200">{t('Chiusura del {d}', { d: dateTime(x.origin + TF_SEC[rtf]) })}</div>
                  <div className="tnum truncate text-2xs text-slate-500" title={t("Prezzo all'origine, media dei percorsi a 1 giorno, prezzo reale")}>{t('Prezzo {p} · fra 1 giorno {f} · reale {a}', { p: k0(x.ref), f: k0(x.day_q50), a: fin(x.day_actual) ? k0(x.day_actual) : t('in attesa') })}</div>
                </div>
                <span className="tnum text-right text-xs text-slate-300">{fin(err) ? t('errore {e}', { e: `${err > 0 ? '+' : err < 0 ? '−' : ''}${Math.abs(err).toFixed(2)}%` }) : '—'}</span>
                <Badge color={REGIME[x.regime]?.color ?? 'slate'}>{t(REGIME[x.regime]?.label ?? x.regime)}</Badge>
              </div>
            )
          }) : <p className="text-xs text-slate-400">{t('Nessuna previsione registrata per questo timeframe.')}</p>}
        </div>
        <p className="mt-auto text-xs leading-relaxed text-slate-400">
          {t('Separato dal backtest: qui entrano solo previsioni calcolate in tempo reale entro un periodo dalla chiusura della candela, mai ricostruite a posteriori. Con pochi casi i numeri sono indicativi; il verdetto resta quello del backtest.')}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ stato del modello
function StatusCard({ st, bt }: { st: KronosStatus | undefined; bt?: KronosBacktest }) {
  const w = st ? Object.entries(st.weights) : []
  const tim = bt?.meta?.timings ?? st?.backtest_timings
  const last = st?.recent?.[0]
  return (
    <Card className="xl:col-span-5">
      <CardHeader title={t('Stato del modello')} icon={<Cpu />} subtitle={st ? t('Kronos-{m} · {d}', { m: st.live_model, d: st.device === 'cuda' ? `GPU · ${st.gpu_name ?? ''}` : t('CPU · {n} thread', { n: st.threads ?? '—' }) }) : '—'}
        right={st ? <Badge color={st.loaded ? 'up' : st.error ? 'down' : 'slate'}>{st.loaded ? t('Caricato') : st.torch ? t('Non ancora caricato') : t('torch assente')}</Badge> : undefined} />
      <CardBody className="flex flex-col gap-3">
        <div className="dgrid -mx-1 grid-cols-2">
          <Cell k={t('Ultima previsione')} v={sec(last?.seconds)} sub={last ? t('{tf} · {s} × {h} candele', { tf: tfLabel(last.tf), s: last.samples, h: last.h }) : undefined} />
          <Cell k={t('Caricamento')} v={sec(st?.load_seconds)} sub={st?.torch_version ? `torch ${st.torch_version}` : undefined} />
          <Cell k={t('Misura CPU')} v={sec(tim?.cpu?.seconds)} sub={tim ? t('{s} percorsi × {h} candele', { s: tim.samples, h: tim.h }) : undefined} />
          <Cell k={t('Misura GPU')} v={sec(tim?.cuda?.seconds)} sub={tim?.cuda?.name ?? undefined} />
        </div>
        <div className="flex flex-col">
          {w.map(([repo, x]) => (
            <div key={repo} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2 first:border-t-0">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-200">{repo}</div>
                <div className="tnum truncate text-2xs text-slate-500">{x.state === 'downloading' ? t('Download {a} di {b}', { a: mb(x.bytes), b: mb(x.total) }) : mb(x.total ?? x.bytes)}</div>
              </div>
              <Badge color={x.state === 'ready' ? 'up' : x.state === 'error' ? 'down' : 'slate'}>
                {x.state === 'ready' ? t('Pesi pronti') : x.state === 'downloading' ? t('Download') : x.state === 'error' ? t('Non disponibile') : t('Da scaricare')}
              </Badge>
            </div>
          ))}
          {!w.length && <p className="text-xs text-slate-400">{t('I pesi si scaricano da Hugging Face al primo uso e restano nella cartella dati.')}</p>}
        </div>
        <p className="mt-auto text-xs leading-relaxed text-slate-400">
          {st?.worker?.busy ? t('Calcolo in corso: {tf}, {s} percorsi × {h} candele (in coda {q}).', { tf: tfLabel(st.worker.job?.tf ?? ''), s: st.worker.job?.samples ?? '—', h: st.worker.job?.h ?? '—', q: st.worker.queue })
            : st?.error && !st.loaded ? t('Ultimo errore: {e}', { e: st.error })
              : t('Una previsione standard (24 candele, 100 percorsi) a ogni chiusura 1h/4h/1G; le altre combinazioni si calcolano su richiesta.')}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ corpo
function pendingText(d: KronosForecast | undefined, st: KronosStatus | undefined): string {
  if (!d) return t('Caricamento…')
  if (d.state === 'torch_missing') return t('PyTorch non è installato in questo ambiente: Kronos non è disponibile.')
  const dl = st ? Object.values(st.weights).find((w) => w.state === 'downloading') : undefined
  if (dl) return t('Download dei pesi da Hugging Face: {a} di {b}…', { a: mb(dl.bytes), b: mb(dl.total) })
  if (d.state === 'error') return t('Previsione non riuscita: {e}', { e: d.error ?? '—' })
  if (d.state === 'loading') return t('Caricamento del modello…')
  return fin(d.eta_s) ? t('Kronos sta generando {s} percorsi × {h} candele (circa {e})…', { s: d.samples, h: d.h, e: sec(d.eta_s) })
    : t('Kronos sta generando {s} percorsi × {h} candele…', { s: d.samples, h: d.h })
}

export default function ForecastKronosTab() {
  const [tf, setTf] = useState<KronosTf>('1h')
  const [h, setH] = useState(24)
  const [samples, setSamples] = useState(100)
  const [b50, setB50] = useState(true)
  const [b90, setB90] = useState(true)
  const [paths, setPaths] = useState(true)
  const [mean, setMean] = useState(false)
  const [btTf, setBtTf] = useState<KronosTf>('1d')
  const [btPer, setBtPer] = useState<KPeriod>('post')
  const [btStep, setBtStep] = useState(1)
  const [curve, setCurve] = useState<CurveMetric>('mase')
  const q = useKronos(tf, h, samples)
  const bq = useKronosBacktest()
  const tq = useKronosTrack()
  const sq = useKronosStatus()
  const d = q.data && q.data.tf === tf ? q.data : undefined
  const bt = bq.data?.available ? bq.data : undefined
  const candles = useLiveCandles(d?.candles ?? [], tf)
  // nuova candela chiusa sul timeframe mostrato → richiedi subito la nuova previsione (il backend la mette in coda)
  useEffect(() => live.onKline((m) => { if (m.closed && m.tf === tf) setTimeout(() => q.refetch(), 3000) }), [tf, q])
  const keySteps = bt?.key_steps?.[btTf] ?? [1, 24]
  const step = keySteps.includes(btStep) ? btStep : keySteps[0]
  const hl = bt?.headline?.[MODEL]?.[tf]
  const pre = bt?.meta?.pretrain_end
  const fresh = d?.ready && !d.stale && q.data?.h === h && q.data?.samples === samples
  const e = d?.ready ? d.end : undefined
  const r = d?.ready ? d.regime : undefined
  const tfOpts = TFS.map((x) => ({ value: x, label: tfLabel(x) }))
  const dayStep = bt?.day_step?.[btTf]
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip cols="grid-cols-2 md:grid-cols-3 min-[1700px]:grid-cols-6">
        <KpiCell accent="violet" icon={<Sparkles />} label={t('Mediana a fine orizzonte')} value={e ? usd(e.median) : '—'} delta={e ? <Change value={e.change_pct} digits={2} /> : undefined} foot={horizonText(tf, h)} />
        <KpiCell icon={<Gauge />} label={t('Prob. rialzo')} value={pc(e?.up_prob, 0)} foot={t('Quota dei {n} percorsi', { n: samples })} />
        <KpiCell icon={<Waypoints />} label={t('Regime')} value={r ? t(REGIME_SHORT[r.code]) : '—'} foot={r ? t('Accordo {a} · soglia {s}', { a: pc(100 * r.agree, 0), s: pc(100 * (r.agree_min ?? 0.65), 0) }) : undefined} />
        <KpiCell icon={<Activity />} label={t('Ampiezza banda 90%')} value={pc(e?.width90_pct)} foot={e ? `${k0(e.p05)}–${k0(e.p95)}` : undefined} />
        <KpiCell icon={<Scale />} label={t('MASE 1 giorno · post')} value={x3(hl?.day_mase)} foot={hl ? t(VERDICT[hl.day.code].short) : t('Backtest non ancora calcolato')} title={t('Backtest fuori campione dopo la fine del pre-addestramento')} />
        <KpiCell icon={<ShieldCheck />} label={t('Copertura 90% · post')} value={pc(hl?.cov90_day)} foot={t('Obiettivo 90% · 1 giorno avanti')} />
      </KpiStrip>

      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-8 2xl:col-span-9">
          <CardHeader title={t('Candele e percorsi di Kronos')} icon={<LineChart />} updatedAt={q.dataUpdatedAt}
            subtitle={d?.ready ? t('{tf} · {h} candele avanti · {s} percorsi · T {T}, top-p {p}', { tf: tfLabel(tf), h: d.h, s: d.samples, T: d.params.T, p: d.params.top_p }) : t('In calcolo')}
            right={<Segmented value={tf} onChange={setTf} options={tfOpts} />} />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label">{t('Candele')}</span>
              <Segmented value={h} onChange={setH} options={H_OPTS.map((x) => ({ value: x, label: String(x) }))} />
              <span className="label ml-1">{t('Percorsi')}</span>
              <Segmented value={samples} onChange={setSamples} options={S_OPTS.map((x) => ({ value: x, label: String(x) }))} />
              <span className="hidden h-5 w-px bg-white/[0.08] md:inline-block" />
              <Toggle on={b50} onClick={() => setB50(!b50)}>{t('Banda 50%')}</Toggle>
              <Toggle on={b90} onClick={() => setB90(!b90)}>{t('Banda 90%')}</Toggle>
              <Toggle on={paths} onClick={() => setPaths(!paths)}>{t('Percorsi')}</Toggle>
              <Toggle on={mean} onClick={() => setMean(!mean)}>{t('Media')}</Toggle>
              {!fresh && d && <span className="inline-flex items-center gap-1.5 text-2xs text-slate-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />{d.ready ? t('Aggiornamento…') : pendingText(d, sq.data)}</span>}
            </div>
            {d ? (
              <div className="relative flex flex-1 flex-col">
                <Fill min={420}><KronosFanChart d={d.ready ? d : { ...d, steps: [], median: undefined }} candles={candles} band50={b50} band90={b90} paths={paths} mean={mean} /></Fill>
                {!d.ready && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-slate-300">{pendingText(d, sq.data)}</div>}
              </div>
            ) : <Skeleton className="h-[420px]" />}
            <div className="dgrid -mx-1 grid-cols-2 md:grid-cols-4">
              <Cell k={t('Mediana')} v={e ? usd(e.median) : '—'} sub={e ? <Change value={e.change_pct} digits={2} /> : undefined} />
              <Cell k={t('Banda 50%')} v={e ? `${k0(e.p25)}–${k0(e.p75)}` : '—'} sub={t('Metà dei percorsi')} />
              <Cell k={t('Banda 90%')} v={e ? `${k0(e.p05)}–${k0(e.p95)}` : '—'} sub={t('9 percorsi su 10')} />
              <Cell k={t('Calcolo')} v={sec(d?.seconds)} sub={d?.device ? t('{d} · {t}', { d: d.device.toUpperCase(), t: dateTime(d.computed_at) }) : undefined} />
            </div>
          </CardBody>
        </Card>
        <div className="flex flex-col gap-3 xl:col-span-4 2xl:col-span-3">
          {d?.ready ? <CurrentCard d={d} bt={bt} /> : <Skeleton className="h-[330px]" />}
          {d?.ready ? <RegimeCard d={d} bt={bt} /> : <Skeleton className="h-[300px] flex-1" />}
        </div>
      </div>

      {bt ? (
        <>
          <Card>
            <CardHeader title={t('Backtest fuori campione')} icon={<Sigma />}
              subtitle={(() => {
                const blk = bt.evaluation?.[MODEL]?.[btTf]?.[btPer]?.[String(step)]
                return t('{tf} · {n} candele avanti · {a} – {b}', { tf: tfLabel(btTf), n: step, a: date(blk?.from), b: date(blk?.to) })
              })()}
              right={<>
                <Segmented value={btTf} onChange={setBtTf} options={tfOpts} />
                <Segmented value={btPer} onChange={setBtPer} options={[{ value: 'post', label: t('Dopo il pre-addestramento') }, { value: 'pre', label: t('Prima') }]} />
                <Segmented value={step} onChange={setBtStep} options={keySteps.map((s) => ({ value: s, label: s === dayStep ? `+${s} · 1 ${dayUnit()}` : `+${s}` }))} />
              </>} />
            <CardBody className="flex flex-col gap-3 pt-0">
              <BacktestTable bt={bt} tf={btTf} period={btPer} step={step} />
              <p className="text-xs leading-relaxed text-slate-400">
                {btPer === 'pre'
                  ? t('Periodo prima del {d}: Kronos è stato pre-addestrato su dati fino a giugno 2024 (dal paper), quindi questi risultati possono essere ottimistici. Il verdetto usa solo il periodo successivo.', { d: date(pre) })
                  : t('Periodo dal {d}: dopo la fine dei dati di pre-addestramento dichiarata nel paper, quindi davvero fuori campione per Kronos.', { d: date(pre) })}
                {' '}{t('MASE = errore assoluto medio (in %) diviso quello del naive sulle stesse origini; direzione con test binomiale su origini non sovrapposte; DM = Diebold-Mariano con varianza HAC. Il nostro modello a 1 giorno compare solo al passo di 1 giorno, sugli stessi target.')}
              </p>
            </CardBody>
          </Card>

          <div className="grid gap-3 xl:grid-cols-12">
            <Card className="xl:col-span-7">
              <CardHeader title={curve === 'mase' ? t('Errore per orizzonte') : t('Calibrazione delle bande per orizzonte')} icon={<Activity />}
                subtitle={curve === 'mase' ? t('MASE di Kronos (media dei percorsi) a ogni passo · {tf}', { tf: tfLabel(btTf) }) : t('Quota di prezzi reali dentro le bande 50% e 90% · {tf}', { tf: tfLabel(btTf) })}
                right={<Segmented value={curve} onChange={setCurve} options={[{ value: 'mase', label: 'MASE' }, { value: 'coverage', label: t('Copertura') }]} />} />
              <CardBody className="flex flex-col gap-3">
                <Fill min={300}><KronosStepChart bt={bt} model={MODEL} tf={btTf} metric={curve} /></Fill>
                <p className="text-xs leading-relaxed text-slate-400">
                  {curve === 'mase' ? t('Sotto la linea tratteggiata Kronos sbaglia meno del naive su quell\'orizzonte. La linea continua è il periodo davvero fuori campione, quella tratteggiata il periodo che il modello potrebbe aver visto.')
                    : t('Bande ben calibrate restano vicine al 50% e al 90%: sotto vuol dire bande troppo strette (incertezza sottostimata), sopra troppo larghe.')}
                </p>
              </CardBody>
            </Card>
            <VerdictCard bt={bt} />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <RegimeUtilityCard bt={bt} period={btPer} />
            <ClaimsCard bt={bt} />
          </div>
        </>
      ) : bq.isPending ? <Skeleton className="h-72" /> : (
        <Card><CardBody className="py-6 text-sm text-slate-400">{t('Backtest non ancora calcolato: nessun verdetto e nessuna affermazione di accuratezza finché non sarà eseguito il backtest fuori campione.')}</CardBody></Card>
      )}

      <div className="grid gap-3 xl:grid-cols-12">
        <TrackCard tr={tq.data} />
        <StatusCard st={sq.data} bt={bt} />
      </div>

      <p className="text-xs text-slate-400">{t('Stime statistiche su dati storici. Non è consulenza finanziaria e non è un sistema di trading.')}</p>
      <MethodNote>
        <p>{t('Modello: Kronos-small (24,7 milioni di parametri, contesto 512 candele) con il tokenizer Kronos-Tokenizer-base, pesi pubblici di NeoQuasar su Hugging Face (revisioni fissate), codice del modello incluso dal repository ufficiale con licenza MIT. Kronos trasforma ogni candela (apertura, massimo, minimo, chiusura, volume, controvalore) in token discreti e genera le candele successive una alla volta, come un modello linguistico.')}</p>
        <p>{t('Input: le ultime {l} candele chiuse BTCUSDT di Binance del timeframe scelto, normalizzate sulla finestra, più ora, giorno e mese di ogni candela. Si generano {s} percorsi indipendenti con temperatura {T} e nucleus sampling top-p {p}; mediana e percentili 5/25/75/95 si calcolano a ogni passo, la media dei percorsi è il punto che restituirebbe KronosPredictor.', { l: d?.params.lookback ?? 512, s: samples, T: d?.params.T ?? 1, p: d?.params.top_p ?? 0.9 })}</p>
        <p>{t('Backtest walk-forward: origini alle 00:00 UTC (stesso target del nostro modello a 1 giorno), ogni {a} giorni dopo il pre-addestramento e ogni {b} giorni prima, {s} percorsi per origine, 24 candele avanti; ogni previsione usa solo le candele chiuse fino all\'origine (verificato nei test alterando i prezzi successivi). Baseline: naive, deriva media storica, passeggiata aleatoria con la volatilità della finestra (bande e CRPS di riferimento).', { a: bt?.meta?.post_every_days ?? '—', b: bt?.meta?.pre_every_days ?? '—', s: bt?.meta?.samples ?? '—' })}</p>
        <p>{t('Contaminazione: secondo il paper i dati di pre-addestramento arrivano a giugno 2024 e includono mercati crypto; i risultati prima di luglio 2024 possono essere ottimistici e sono mostrati a parte. Il verdetto principale usa solo il periodo successivo.')}</p>
        <p>{t('Limiti: nessuna informazione esterna (notizie, macro, flussi), solo la sequenza di candele; i percorsi sono campioni casuali e cambiano un po\' a ogni calcolo (seme fissato per candela); con 32 percorsi nel backtest i percentili estremi sono approssimati; il registro live ha ancora pochi casi.')}</p>
        <p>
          {t('Fonti:')} <a className="text-slate-300 underline decoration-white/20 underline-offset-2 hover:text-white" href="https://github.com/shiyu-coder/Kronos" target="_blank" rel="noreferrer">github.com/shiyu-coder/Kronos</a>
          {' · '}<a className="text-slate-300 underline decoration-white/20 underline-offset-2 hover:text-white" href="https://arxiv.org/abs/2508.02739" target="_blank" rel="noreferrer">arXiv:2508.02739</a>
          {' · '}<a className="text-slate-300 underline decoration-white/20 underline-offset-2 hover:text-white" href="https://huggingface.co/NeoQuasar" target="_blank" rel="noreferrer">Hugging Face NeoQuasar</a>
          {bt?.meta ? ` · ${t('Backtest calcolato il {d} su {g}', { d: dateTime(bt.meta.created_at), g: bt.meta.gpu ?? bt.meta.device })}` : ''}
        </p>
      </MethodNote>
    </div>
  )
}
