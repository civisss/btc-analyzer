/* Segnali BTC seguiti sulla carta. Le API danno chiavi e numeri: tutti i testi nascono qui, in italiano, e passano da t(). */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, BookOpenCheck, BrainCircuit, ClipboardList, Crosshair, FlaskConical, GitCommitHorizontal, History, Layers, LineChart, Radio, Receipt, Scale, ShieldCheck, Sigma, Target, Timer, TriangleAlert } from 'lucide-react'
import {
  useSignalBacktest, useSignalDetail, useSignalHistory, useSignalPerformance, useSignals,
  type BtRow, type MlBlock, type PerfBlock, type PerfGroup, type Signal, type SignalDetail, type SignalEvent, type SignalFamily, type SignalOutcome, type SignalsBacktest, type SignalsOverview, type SignalsPerformance, type SignalTier,
} from '../api/signals'
import { useLive } from '../api/live'
import EChart from '../components/charts/EChart'
import ProChart, { type LineDef, type MarkerDef, type PriceLineDef, type ZoneDef } from '../components/charts/ProChart'
import { C, FONT, axisLabel, hexA, legendBase, lineSeries, timeAxis, tooltipBase, valueAxis } from '../components/charts/theme'
import { Badge, Card, CardBody, CardHeader, EmptyState, Fill, KpiCell, KpiStrip, MethodNote, PageActions, Q, Segmented, Skeleton, clsx } from '../components/ui'
import { date, dateTime, int, usd } from '../lib/format'
import { t } from '../i18n'
import { ANALOGS, T, alpha } from '../theme/tokens'

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
/** +0.12R, sign always shown */
const rr = (v: Num, d = 2) => (fin(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}R` : '—')
const n2 = (v: Num, d = 2) => (fin(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}` : '—')
const p1 = (v: Num, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const sp = (v: Num, d = 2) => (fin(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%` : '—')
const pv = (v: Num) => (fin(v) ? (v < 0.001 ? '<0.001' : v.toFixed(3)) : '—')
const rClass = (v: Num) => (fin(v) ? (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-fg-2') : 'text-fg-3')
const TF_LABEL = (tf: string) => (tf === '1d' ? t('1g') : tf)

const SETUP: Record<string, string> = {
  vwap_reclaim: 'Riconquista VWAP', vwap_reject: 'Rifiuto VWAP', band_revert: 'Ritorno alla media', sweep: 'Sweep di liquidità',
  bos_retest: 'Rottura e retest', cvd_div: 'Divergenza delta', funding_ext: 'Estremo di funding', donchian: 'Rottura canale',
}
const setupName = (k: string) => t(SETUP[k] ?? k)
const ANCHOR: Record<string, string> = { w: 'settimanale', m: 'mensile', q: 'trimestrale' }
const OUTCOME: Record<SignalOutcome, string> = {
  tp2: 'TP2 preso', sl: 'Stop preso', be: 'TP1, poi pareggio', timeout: 'Chiuso a scadenza', invalidated: 'Invalidato', expired: 'Scaduto senza entrata', canceled: 'Annullato',
}
const EVENT: Record<string, string> = {
  emitted: 'Segnale emesso', active: 'Entrata eseguita', tp1: 'TP1 preso, stop a pareggio', leave: 'Invalidazione decisa alla chiusura', ...OUTCOME,
}
const VERDICT: Record<string, string> = {
  passed: 'Ha passato tutti i controlli', dev_small: 'Pochi trade nello sviluppo', dev_negative: 'Negativo nel walk-forward', pending: 'Holdout non ancora valutato',
  holdout_small: "Pochi trade nell'holdout", holdout_negative: "Negativo nell'holdout", ci_includes_zero: 'Intervallo di confidenza su zero',
  not_significant: 'Non significativo dopo la correzione BH', unstable: 'Instabile tra gli anni',
}
const ML_REASON: Record<string, string> = {
  passed: 'Ha migliorato il risultato fuori campione', no_data: 'Dati insufficienti', dev_no_gain: 'Nessun miglioramento nel walk-forward', holdout_no_gain: "Nessun miglioramento nell'holdout",
  holdout_gain_uncertain: "Miglioramento nell'holdout non distinguibile da zero", holdout_small: "Troppi pochi trade filtrati nell'holdout", filtered_negative: 'Trade filtrati ancora in perdita', not_calibrated: 'Probabilità non calibrate',
}

function stateLabel(s: Signal): string {
  if (s.outcome) return t(OUTCOME[s.outcome])
  if (s.status === 'pending') return t('In attesa')
  return s.tp1_hit ? t('Attivo, TP1 preso') : t('Posizione attiva')
}

function reasonText(s: Signal): string[] {
  const up = s.side === 'long'
  return s.reasons.map(({ k, v }) => {
    const anchor = t(ANCHOR[String(v.anchor)] ?? String(v.anchor ?? ''))
    switch (k) {
      case 'vwap_reclaim': return up
        ? t('Chiusura di nuovo sopra il VWAP {a} ({v}) dopo almeno 4 chiusure su 6 sotto.', { a: anchor, v: usd(v.vwap as number) })
        : t('Chiusura di nuovo sotto il VWAP {a} ({v}) dopo almeno 4 chiusure su 6 sopra.', { a: anchor, v: usd(v.vwap as number) })
      case 'vwap_reject': return up
        ? t('Candela che tocca il VWAP {a} ({v}) dall’alto e chiude respinta verso l’alto.', { a: anchor, v: usd(v.vwap as number) })
        : t('Candela che tocca il VWAP {a} ({v}) dal basso e chiude respinta verso il basso.', { a: anchor, v: usd(v.vwap as number) })
      case 'band_revert': return t('Rientro dentro la banda {k}σ del VWAP {a} ({b}): target sulla banda 1σ e sul VWAP ({v}).', { k: n2(v.sigma as number, 1), a: anchor, b: usd(v.band as number), v: usd(v.vwap as number) })
      case 'sweep': return up
        ? t('La candela scende sotto il minimo di swing {l} fino a {e} e chiude di nuovo sopra.', { l: usd(v.level as number), e: usd(v.extreme as number) })
        : t('La candela sale sopra il massimo di swing {l} fino a {e} e chiude di nuovo sotto.', { l: usd(v.level as number), e: usd(v.extreme as number) })
      case 'bos_retest': return t('Rottura di struttura in chiusura oltre {l}: entrata limite sul retest del livello.', { l: usd(v.level as number) })
      case 'cvd_div': return t('Nuovo estremo di prezzo su {b} candele con delta spot a {s}σ e delta perp a {p}σ.', { b: n2(v.bars as number, 0), s: n2(v.spot_z as number, 1), p: n2(v.perp_z as number, 1) })
      case 'funding_ext': return t('Funding {f} per 8 ore, z {z} contro il segnale, con prezzo oltre 1σ dal VWAP ({v}).', { f: sp(v.funding as number, 3), z: n2(v.z as number, 1), v: usd(v.vwap as number) })
      case 'donchian': return t('Chiusura oltre l’estremo delle ultime {b} candele ({l}).', { b: n2(v.bars as number, 0), l: usd(v.level as number) })
      default: return k
    }
  })
}

function Side({ side }: { side: Signal['side'] }) {
  return <Badge color={side === 'long' ? 'up' : 'down'}>{side === 'long' ? 'Long' : 'Short'}</Badge>
}
function Tier({ tier }: { tier: SignalTier }) {
  if (tier === 'validated') return <Badge color="btc">{t('Validato')}</Badge>
  if (tier === 'experimental') return <Badge color="warn">{t('Sperimentale')}</Badge>
  return <Badge>{t('Disattivato')}</Badge>
}
const priceNow = (mark: number | null | undefined, fallback: Num) => (fin(mark) ? mark : fallback ?? null)

/** Linee del piano: arancione l'entrata, tinte neutre per target e stop (verde e rosso restano alla direzione). */
function planLines(s: Signal): PriceLineDef[] {
  const out: PriceLineDef[] = [
    { price: s.entry, color: T.accent, title: 'Entry', width: 2 },
    { price: s.tp1, color: T.steel, title: 'TP1' },
    { price: s.tp2, color: T.steel, title: 'TP2', dashed: true },
    { price: s.sl, color: T.sand, title: 'SL' },
  ]
  if (s.inv != null) out.push({ price: s.inv, color: T.fg4, title: 'Inv.', dashed: true })
  return out
}

function floorTo(tf: string, x: number): number {
  const step = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[tf] ?? 3600
  return Math.floor(x / step) * step
}

function planMarkers(s: Signal): MarkerDef[] {
  const up = s.side === 'long'
  const out: MarkerDef[] = [{ time: floorTo(s.tf, s.emitted_at - 1), position: up ? 'belowBar' : 'aboveBar', color: T.accent, shape: up ? 'arrowUp' : 'arrowDown', text: t('Segnale') }]
  for (const e of s.events) {
    if (e.type === 'emitted' || e.type === 'leave') continue
    const label = e.type === 'active' ? '' : e.type === 'tp1' ? 'TP1' : e.type === 'tp2' ? 'TP2' : e.type === 'sl' ? 'SL' : t(EVENT[e.type] ?? e.type)
    out.push({ time: floorTo(s.tf, e.time), position: 'inBar', color: T.fg2, shape: 'circle', text: label })
  }
  return out
}

const NO_ZONES: ZoneDef[] = []

/** Serie invisibili agli estremi del piano: la scala del grafico segue le serie, non le linee di prezzo. */
function planRange(d: SignalDetail): LineDef[] {
  const c = d.candles
  if (!c.length) return []
  const edge = (id: string, v: number): LineDef => ({ id, color: alpha(T.black, 0), width: 1, data: [{ time: c[0].time, value: v }, { time: c[c.length - 1].time, value: v }] })
  return [edge('plan-hi', Math.max(d.tp2, d.sl, d.entry)), edge('plan-lo', Math.min(d.tp2, d.sl, d.entry))]
}

function SignalChart({ d, height }: { d: SignalDetail; height: number }) {
  const lines = useMemo(() => planLines(d), [d])
  const marks = useMemo(() => planMarkers(d), [d])
  const range = useMemo(() => planRange(d), [d])
  return <ProChart candles={d.candles} height={height} lines={range} priceLines={lines} markers={marks} zones={NO_ZONES} volume={false} wheel={false} symbol="BTCUSDT perp" tfLabel={TF_LABEL(d.tf)} fitKey={d.id} />
}

function ChartLoader({ id, height }: { id: string; height: number }) {
  const q = useSignalDetail(id)
  return <Q q={q} loading={<Skeleton style={{ height }} />}>{(d) => (d.candles.length ? <SignalChart d={d} height={height} /> : <EmptyState text={t('Candele non disponibili')} compact />)}</Q>
}

function Level({ label, value, dist }: { label: string; value: number | null; dist?: number | null }) {
  return (
    <div className="tile min-w-0 px-2.5 py-2">
      <div className="label truncate">{label}</div>
      <div className="tnum mt-0.5 truncate text-sm font-semibold text-white">{usd(value, value != null && value < 1000 ? 2 : 0)}</div>
      <div className="tnum truncate text-2xs text-fg-3">{fin(dist) ? sp(dist, 2) : ' '}</div>
    </div>
  )
}

function SignalCard({ s, price }: { s: Signal; price: number | null }) {
  const dist = (x: number) => (price ? ((x - price) / price) * 100 : null)
  const reasons = reasonText(s)
  return (
    <div className="tile flex min-w-0 flex-col gap-3 p-3 sm:p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Side side={s.side} />
        <span className="text-sm font-semibold text-white">{setupName(s.setup)}</span>
        <span className="tnum text-xs text-fg-3">{TF_LABEL(s.tf)}</span>
        <Tier tier={s.tier} />
        <span className="ml-auto flex items-center gap-2 text-xs text-fg-2">
          {s.status === 'active' && fin(s.open_r) && <span className={clsx('tnum font-medium', rClass(s.open_r))}>{rr(s.open_r)}</span>}
          <Badge>{stateLabel(s)}</Badge>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Level label={s.kind === 'limit' ? t('Entry limite') : 'Entry'} value={s.fill ?? s.entry} dist={dist(s.fill ?? s.entry)} />
        <Level label={t('Stop')} value={s.sl} dist={dist(s.sl)} />
        <Level label={`TP1 · ${n2(s.rr1, 1)}R`} value={s.tp1} dist={dist(s.tp1)} />
        <Level label={`TP2 · ${n2(s.rr2, 1)}R`} value={s.tp2} dist={dist(s.tp2)} />
      </div>
      <ChartLoader id={s.id} height={250} />
      <ul className="flex flex-col gap-1 text-xs leading-relaxed text-fg-2">
        {reasons.map((r, i) => <li key={i}>{r}</li>)}
        {s.comment && <li className="text-fg-3">{s.comment}</li>}
      </ul>
      <div className="tnum flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-3">
        <span>{t('Emesso il {d}', { d: dateTime(s.emitted_at) })}</span>
        <span>{s.status === 'pending' ? t('Entrata valida fino al {d}', { d: dateTime(s.pending_until) }) : t('Scadenza {d}', { d: dateTime(s.exit_by) })}</span>
        <span>{t('Rischio {p}', { p: p1(s.risk_pct, 2) })}</span>
      </div>
    </div>
  )
}

/** Countdown to the next close of a timeframe, refreshed every 30 s. */
function useNow(ms = 30_000) {
  const [n, setN] = useState(() => Date.now() / 1000)
  useEffect(() => { const h = setInterval(() => setN(Date.now() / 1000), ms); return () => clearInterval(h) }, [ms])
  return n
}
const nextClose = (now: number, s: number) => (Math.floor(now / s) + 1) * s

function Watching({ d, family }: { d: SignalsOverview; family: SignalFamily }) {
  const now = useNow()
  const items = d.enabled.filter((x) => x.family === family)
  const tfs: [string, number][] = family === 'low' ? [['15m', 900], ['1h', 3600]] : [['4h', 14400], ['1d', 86400]]
  return (
    <div className="flex h-full flex-col gap-3">
      <p className="text-sm text-fg-2">{t('Nessun segnale aperto. Una riga di setup si accende solo alla chiusura di una candela, se le sue regole sono tutte vere.')}</p>
      <div className="grid grid-cols-2 gap-2">
        {tfs.map(([tf, s]) => (
          <div key={tf} className="tile px-3 py-2">
            <div className="label">{t('Prossima chiusura {tf}', { tf: TF_LABEL(tf) })}</div>
            <div className="tnum mt-0.5 text-sm font-semibold text-white">{dateTime(nextClose(now, s))}</div>
          </div>
        ))}
      </div>
      <div className="min-h-0">
        <div className="label mb-1.5">{t('In osservazione')}</div>
        {items.length ? (
          <table className="tbl">
            <tbody>
              {items.map((x) => (
                <tr key={`${x.setup}${x.tf}${x.side}`}>
                  <td>{setupName(x.setup)}</td>
                  <td className="text-fg-3">{TF_LABEL(x.tf)}</td>
                  <td><Side side={x.side} /></td>
                  <td className="text-right"><Tier tier={x.tier} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-xs text-fg-3">{t('Nessun setup attivo in questa famiglia: il backtest non ha dato appigli.')}</p>}
      </div>
    </div>
  )
}

function Recent({ items }: { items: Signal[] }) {
  if (!items.length) return null
  return (
    <div>
      <div className="label mb-1.5">{t('Ultimi esiti')}</div>
      <table className="tbl">
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td className="text-fg-2 max-sm:hidden">{date(s.exit_t ?? s.emitted_at, false)}</td>
              <td>{setupName(s.setup)}</td>
              <td className="text-fg-3">{TF_LABEL(s.tf)}</td>
              <td><Side side={s.side} /></td>
              <td className={clsx('text-right font-medium', rClass(s.r))}>{fin(s.r) ? rr(s.r) : stateLabel(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Family({ d, family, price }: { d: SignalsOverview; family: SignalFamily; price: number | null }) {
  const items = d.open.filter((s) => s.family === family)
  return (
    <Card>
      <CardHeader icon={family === 'low' ? <Timer /> : <Layers />} title={family === 'low' ? t('Basso timeframe') : t('Alto timeframe')}
        subtitle={family === 'low' ? t('15m e 1h, durata in ore') : t('4h e 1g, durata in giorni o settimane')}
        right={<Badge>{items.length === 1 ? t('1 aperto') : t('{n} aperti', { n: items.length })}</Badge>} />
      <CardBody className="flex flex-col gap-3">
        {items.length ? items.map((s) => <SignalCard key={s.id} s={s} price={price} />) : <Watching d={d} family={family} />}
        <Recent items={d.recent.filter((s) => s.family === family).slice(0, items.length ? 5 : 10)} />
      </CardBody>
    </Card>
  )
}

function Status({ d }: { d: SignalsOverview }) {
  const mark = useLive((s) => s.mark?.mark)
  const price = priceNow(mark, d.price)
  const sum = d.summary
  return (
    <KpiStrip>
      <KpiCell icon={<ShieldCheck />} label={t('Setup validati')} value={sum ? `${sum.validated} / ${sum.tested}` : '—'} foot={sum ? t('{n} hanno passato lo sviluppo', { n: sum.dev_passed }) : t('Backtest in calcolo')} />
      <KpiCell icon={<FlaskConical />} label={t('Sperimentali attivi')} value={d.tiers.experimental} foot={t('{n} disattivati dai dati', { n: d.tiers.off })} />
      <KpiCell icon={<Crosshair />} label={t('Segnali aperti')} value={d.open.length} foot={t('{n} emessi in totale', { n: d.total })} />
      <KpiCell icon={<Radio />} label={t('Prezzo perp live')} value={usd(price)} foot={t('Binance USDⓈ-M, mark price')} />
      <KpiCell icon={<Activity />} label={t('Ultimo controllo')} value={d.agent.last_tick ? dateTime(d.agent.last_tick).split(' ').slice(-1)[0] : '—'} foot={t('Candele 1m chiuse, ogni 15 secondi')} />
      <KpiCell icon={<ClipboardList />} label={t('Registro')} value={d.integrity.ok ? t('Integro') : t('Alterato')} foot={t('{n} eventi in catena', { n: int(d.integrity.rows) })} />
    </KpiStrip>
  )
}

function Notice({ d }: { d: SignalsOverview }) {
  const sum = d.summary
  const none = sum && sum.validated === 0
  return (
    <Card>
      <div className="flex flex-col gap-1.5 px-4 py-3.5 sm:px-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <TriangleAlert size={15} className={none ? 'text-warn' : 'text-fg-3'} />
          {!sum ? t('Backtest in calcolo: nessun segnale viene emesso finché non c’è un verdetto') : none ? t('Nessun setup ha superato il test') : t('{n} setup validati su {m}', { n: sum.validated, m: sum.tested })}
        </div>
        {sum && (
          <p className="text-xs leading-relaxed text-fg-2">
            {none
              ? t('{a} ipotesi provate, {b} hanno passato lo sviluppo, nessuna l’holdout. I segnali qui sotto sono sperimentali: dopo i costi non hanno un vantaggio dimostrato e servono a misurarli dal vivo.', { a: sum.tested, b: sum.dev_passed })
              : t('Solo i setup marcati Validato hanno superato holdout e correzione per test multipli. Gli altri restano sperimentali.')}
            {' '}{t('Output di un sistema statistico seguito sulla carta, non consulenza finanziaria personalizzata: nessun ordine, leva o dimensione di posizione.')}
          </p>
        )}
      </div>
    </Card>
  )
}

export function ActiveTab() {
  const q = useSignals()
  const mark = useLive((s) => s.mark?.mark)
  return (
    <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[420px]" /></div>}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <Status d={d} />
          <Notice d={d} />
          <div className="grid gap-3 xl:grid-cols-2">
            <Family d={d} family="low" price={priceNow(mark, d.price)} />
            <Family d={d} family="high" price={priceNow(mark, d.price)} />
          </div>
        </div>
      )}
    </Q>
  )
}

// ------------------------------------------------------------------ Storico

function Timeline({ events }: { events: SignalEvent[] }) {
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => (
        <li key={i} className="flex gap-3 pb-2.5 last:pb-0">
          <span className="relative mt-1.5 flex w-2 shrink-0 justify-center">
            <span className="h-2 w-2 rounded-full bg-fg-3" />
            {i < events.length - 1 && <span className="absolute top-2.5 h-[calc(100%+2px)] w-px bg-line" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-white">
              {t(EVENT[e.type] ?? e.type)}
              {e.price != null && <span className="tnum text-xs text-fg-2">{usd(e.price)}</span>}
              {fin(e.r) && <span className={clsx('tnum text-xs font-medium', rClass(e.r))}>{rr(e.r)}</span>}
              {e.rebuilt && <Badge>{t('Ricostruito')}</Badge>}
            </div>
            <div className="tnum text-2xs text-fg-3">{dateTime(e.time)}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function Detail({ id }: { id: string }) {
  const q = useSignalDetail(id)
  return (
    <Q q={q} loading={<Skeleton className="h-[520px]" />}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Side side={d.side} /><span className="text-sm font-semibold text-white">{setupName(d.setup)}</span><span className="tnum text-xs text-fg-3">{TF_LABEL(d.tf)}</span><Tier tier={d.tier} />
            <Badge>{stateLabel(d)}</Badge>
            {fin(d.r) && <span className={clsx('tnum ml-auto text-sm font-semibold', rClass(d.r))}>{rr(d.r)}</span>}
          </div>
          {d.candles.length ? <SignalChart d={d} height={300} /> : <EmptyState text={t('Candele non disponibili')} compact />}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Level label={d.kind === 'limit' ? t('Entry limite') : 'Entry'} value={d.entry} />
            <Level label={t('Stop')} value={d.sl} />
            <Level label="TP1" value={d.tp1} />
            <Level label="TP2" value={d.tp2} />
          </div>
          <div>
            <div className="label mb-1.5">{t('Motivi al momento del segnale')}</div>
            <ul className="flex flex-col gap-1 text-xs leading-relaxed text-fg-2">
              {reasonText(d).map((r, i) => <li key={i}>{r}</li>)}
              <li>{t('Regime {r}, ADX {a}, volatilità al {v} percentile dell’ultimo anno.', { r: t(d.context.trend > 0 ? 'rialzista' : d.context.trend < 0 ? 'ribassista' : 'laterale'), a: n2(d.context.adx, 0), v: fin(d.context.vol) ? Math.round(d.context.vol * 100) : '—' })}</li>
              {d.comment && <li className="text-fg-3">{d.comment}</li>}
            </ul>
          </div>
          <div>
            <div className="label mb-2">{t('Timeline')}</div>
            <Timeline events={d.events} />
          </div>
          {fin(d.r) && <Costs d={d} />}
        </div>
      )}
    </Q>
  )
}

function Costs({ d }: { d: SignalDetail }) {
  return (
    <div className="tnum flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
      <span>{t('Lordo {v}', { v: sp(d.gross_pct) })}</span>
      <span>{t('Costi {v}', { v: sp(fin(d.cost_pct) ? -d.cost_pct : null) })}</span>
      <span>{t('Funding {v}', { v: sp(fin(d.funding_pct) ? -d.funding_pct : null, 3) })}</span>
      <span>{t('1R = {v}', { v: p1(d.risk_pct, 2) })}</span>
    </div>
  )
}

const OUTCOME_FILTER = ['pending', 'active', 'tp2', 'be', 'sl', 'timeout', 'invalidated', 'expired', 'canceled'] as const

function Select({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 max-w-[160px] rounded-lg border border-line bg-raised px-2 text-xs text-fg-2 outline-none focus:border-accent/50 sm:h-7">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export function HistoryTab() {
  const [sp_, setSp] = useSearchParams()
  const [setup, setSetup] = useState('')
  const [outcome, setOutcome] = useState('')
  const [tf, setTf] = useState('')
  const [side, setSide] = useState('')
  const q = useSignalHistory({ setup, outcome, tf, side, limit: '1000' })
  const id = sp_.get('id')
  const pick = (x: string) => { const n = new URLSearchParams(sp_); n.set('id', x); setSp(n, { replace: true }) }
  const items = q.data?.items
  useEffect(() => { if (!id && items?.length) pick(items[0].id) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id, items])
  const all = t('Tutti')
  return (
    <div className="grid items-start gap-3 min-[1500px]:grid-cols-5">
      <Card className="min-[1500px]:col-span-3">
        <CardHeader icon={<History />} title={t('Storico dei segnali')} subtitle={q.data ? t('{n} su {m} emessi, mai modificati dopo l’emissione', { n: q.data.items.length, m: q.data.total }) : undefined}
          right={(
            <>
              <Select label={t('Setup')} value={setup} onChange={setSetup} options={[{ value: '', label: t('Tutti i setup') }, ...Object.keys(SETUP).map((k) => ({ value: k, label: setupName(k) }))]} />
              <Select label={t('Esito')} value={outcome} onChange={setOutcome} options={[{ value: '', label: t('Tutti gli esiti') }, ...OUTCOME_FILTER.map((k) => ({ value: k, label: k === 'pending' ? t('In attesa') : k === 'active' ? t('Posizione attiva') : t(OUTCOME[k]) }))]} />
              <Segmented value={tf} onChange={setTf} options={[{ value: '', label: all }, ...['15m', '1h', '4h', '1d'].map((x) => ({ value: x, label: TF_LABEL(x) }))]} />
              <Segmented value={side} onChange={setSide} options={[{ value: '', label: all }, { value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} />
            </>
          )} />
        <Q q={q} loading={<div className="p-4"><Skeleton className="h-[420px]" /></div>}>
          {(d) => (d.items.length ? (
            <div className="max-h-[900px] overflow-auto pb-2">
              <table className="tbl">
                <thead className="sticky top-0 z-10 bg-surface"><tr><th>{t('Emesso')}</th><th>{t('Setup')}</th><th>TF</th><th>{t('Direzione')}</th><th>{t('Verdetto')}</th><th>{t('Esito')}</th><th className="text-right">R</th></tr></thead>
                <tbody>
                  {d.items.map((s) => (
                    <tr key={s.id} onClick={() => pick(s.id)} className={clsx('cursor-pointer', s.id === id && '[&_td]:bg-accent/[0.06]')}>
                      <td className="text-fg-2">{dateTime(s.emitted_at)}</td>
                      <td>{setupName(s.setup)}</td>
                      <td className="text-fg-3">{TF_LABEL(s.tf)}</td>
                      <td><Side side={s.side} /></td>
                      <td><Tier tier={s.tier} /></td>
                      <td className="text-fg-2">{stateLabel(s)}{s.rebuilt ? ' *' : ''}</td>
                      <td className={clsx('text-right font-medium', rClass(s.r))}>{rr(s.r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.items.some((s) => s.rebuilt) && <p className="px-4 pt-2 text-2xs text-fg-3 sm:px-5">{t('* Stato ricostruito dalle candele dopo un periodo con l’app spenta.')}</p>}
            </div>
          ) : (
            <CardBody><EmptyState text={d.total ? t('Nessun segnale con questi filtri') : t('Nessun segnale emesso finora: il registro parte da zero e cresce a ogni chiusura di candela.')} /></CardBody>
          ))}
        </Q>
      </Card>
      <Card className="min-[1500px]:col-span-2 min-[1500px]:sticky min-[1500px]:top-3">
        <CardHeader icon={<BookOpenCheck />} title={t('Dettaglio del segnale')} subtitle={t('Grafico, motivi di allora e timeline degli eventi')} />
        <CardBody>{id ? <Detail key={id} id={id} /> : <EmptyState text={t('Seleziona un segnale')} />}</CardBody>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ Performance

function CurveR({ data }: { data: { time: number; value: number }[] }) {
  const option = useMemo(() => ({
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v: number) => rr(v) },
    xAxis: timeAxis(),
    yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${n2(v, 0)}R` } }),
    series: [lineSeries(t('Risultato cumulato'), data.map((p) => [p.time * 1000, p.value]), C.accent, { step: 'end', markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: C.grey2, type: 'dashed', width: 1 }, data: [{ yAxis: 0 }] } })],
  }), [data])
  return <EChart option={option} height={320} />
}

function GroupTable({ rows, name }: { rows: PerfGroup[]; name: (k: string) => ReactNode }) {
  if (!rows.length) return <EmptyState text={t('Ancora nessun segnale chiuso')} compact />
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>{t('Gruppo')}</th><th className="text-right">{t('Trade')}</th><th className="text-right">{t('Vinti')}</th><th className="text-right">{t('R medio')}</th><th className="text-right">{t('R totale')}</th><th className="text-right">{t('Fattore di profitto')}</th><th className="text-right">{t('Drawdown')}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{name(r.key)}</td>
              <td className="text-right">{r.n}</td>
              <td className="text-right">{p1(r.win_rate, 0)}</td>
              <td className={clsx('text-right', rClass(r.mean_r))}>{rr(r.mean_r)}</td>
              <td className={clsx('text-right', rClass(r.total_r))}>{rr(r.total_r, 1)}</td>
              <td className="text-right">{n2(r.pf)}</td>
              <td className="text-right">{fin(r.max_dd_r) ? `${r.max_dd_r.toFixed(1)}R` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PerfKpis({ p, d }: { p: PerfBlock; d: SignalsPerformance }) {
  return (
    <KpiStrip>
      <KpiCell icon={<Receipt />} label={t('Trade chiusi')} value={p.n} foot={t('{a} emessi, {b} senza entrata', { a: d.counts.emitted, b: d.counts.never_filled })} />
      <KpiCell icon={<Target />} label={t('Vinti')} value={p1(p.win_rate, 0)} foot={t('R netto maggiore di zero')} />
      <KpiCell icon={<Sigma />} label={t('Aspettativa')} value={rr(p.mean_r)} foot={t('R medio dopo costi e funding')} />
      <KpiCell icon={<LineChart />} label={t('Risultato')} value={rr(p.total_r, 1)} foot={t('Somma dei trade chiusi')} />
      <KpiCell icon={<Scale />} label={t('Fattore di profitto')} value={n2(p.pf)} foot={t('Guadagni su perdite, in R')} />
      <KpiCell icon={<TriangleAlert />} label={t('Drawdown massimo')} value={`${p.max_dd_r.toFixed(1)}R`} foot={d.counts.rebuilt ? t('{n} segnali con stato ricostruito', { n: d.counts.rebuilt }) : t('Dal massimo della curva')} />
    </KpiStrip>
  )
}

export function PerformanceTab() {
  const q = useSignalPerformance()
  const [tier, setTier] = useState<'all' | 'validated' | 'experimental'>('all')
  return (
    <div>
      <PageActions><Segmented size="md" value={tier} onChange={setTier} options={[{ value: 'all', label: t('Tutti') }, { value: 'validated', label: t('Validati') }, { value: 'experimental', label: t('Sperimentali') }]} /></PageActions>
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[360px]" /></div>}>
        {(d) => {
          const p = d[tier]
          return (
            <div className="flex flex-col gap-3">
              <PerfKpis p={p} d={d} />
              <Card>
                <CardHeader icon={<LineChart />} title={t('Curva in R, dal vivo')} subtitle={d.first ? t('Track record dal {d}, separato dal backtest', { d: date(d.first) }) : t('Il track record live parte con il primo segnale chiuso')}
                  info={t('Ogni trade vale il suo risultato in R, cioè in multipli della distanza dallo stop, al netto di commissioni {f}% per lato, slittamento {s}% per esecuzione e funding reale.', { f: d.costs.fee_pct, s: d.costs.slip_pct })} />
                <CardBody>{p.curve.length ? <CurveR data={p.curve} /> : <EmptyState text={t('Ancora nessun segnale chiuso: il risultato dal vivo si misura solo da qui in avanti e non eredita nulla dal backtest.')} />}</CardBody>
              </Card>
              <div className="grid gap-3 xl:grid-cols-2">
                <Card>
                  <CardHeader icon={<Layers />} title={t('Per setup')} />
                  <CardBody><GroupTable rows={d.by_setup} name={setupName} /></CardBody>
                </Card>
                <Card>
                  <CardHeader icon={<Timer />} title={t('Per famiglia, timeframe e direzione')} />
                  <CardBody><GroupTable rows={[...d.by_family, ...d.by_tf, ...d.by_side]} name={(k) => (k === 'long' ? 'Long' : k === 'short' ? 'Short' : k === 'low' ? t('Basso timeframe') : k === 'high' ? t('Alto timeframe') : TF_LABEL(k))} /></CardBody>
                </Card>
              </div>
            </div>
          )
        }}
      </Q>
    </div>
  )
}

// ------------------------------------------------------------------ Backtest e metodo

function passedDev(r: BtRow, min: number) {
  return r.wf.n >= min && (r.wf.mean_r ?? 0) > 0
}

function VerdictTable({ d }: { d: SignalsBacktest }) {
  const [view, setView] = useState<'passed' | 'on' | 'all'>('passed')
  const [fam, setFam] = useState<'' | SignalFamily>('')
  const rows = d.rows.filter((r) => (view === 'all' || (view === 'on' ? r.tier !== 'off' : passedDev(r, d.protocol.min_n_dev))) && (!fam || r.family === fam))
  return (
    <Card>
      <CardHeader icon={<Scale />} title={t('Risultati fuori campione')} subtitle={t('Walk-forward {a}–{b} e holdout dal {c}, dopo i costi', { a: d.protocol.wf_years[0], b: d.protocol.wf_years[d.protocol.wf_years.length - 1], c: date(d.protocol.holdout_start) })}
        info={t('p: quanto spesso entrate casuali con la stessa direzione e la stessa geometria di stop e target fanno almeno altrettanto. q: p corretto con Benjamini-Hochberg sulle ipotesi che hanno passato lo sviluppo.')}
        right={(
          <>
            <Segmented value={fam} onChange={setFam} options={[{ value: '', label: t('Tutti') }, { value: 'low', label: t('Basso') }, { value: 'high', label: t('Alto') }]} />
            <Segmented value={view} onChange={setView} options={[{ value: 'passed', label: t('Passate lo sviluppo') }, { value: 'on', label: t('Attive') }, { value: 'all', label: t('Tutte') }]} />
          </>
        )} />
      <div className="max-h-[640px] overflow-auto pb-2">
        <table className="tbl">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              <th>{t('Setup')}</th><th>TF</th><th>{t('Direzione')}</th>
              <th className="text-right">{t('WF trade')}</th><th className="text-right">{t('WF R')}</th>
              <th className="text-right">{t('Holdout trade')}</th><th className="text-right">{t('Vinti')}</th><th className="text-right">{t('R medio')}</th><th className="text-right">{t('IC 95%')}</th>
              <th className="text-right">{t('Fatt. prof.')}</th><th className="text-right">{t('Drawdown')}</th><th className="text-right">p</th><th className="text-right">q</th><th>{t('Verdetto')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const h = r.holdout
              return (
                <tr key={`${r.setup}${r.tf}${r.side}`}>
                  <td>{setupName(r.setup)}</td>
                  <td className="text-fg-3">{TF_LABEL(r.tf)}</td>
                  <td><Side side={r.side} /></td>
                  <td className="text-right text-fg-2">{r.wf.n}</td>
                  <td className={clsx('text-right', rClass(r.wf.mean_r))}>{rr(r.wf.mean_r)}</td>
                  <td className="text-right text-fg-2">{h.n}</td>
                  <td className="text-right text-fg-2">{p1(h.win_rate, 0)}</td>
                  <td className={clsx('text-right font-medium', rClass(h.mean_r))}>{rr(h.mean_r)}</td>
                  <td className="text-right text-fg-3">{fin(h.ci[0]) ? `${n2(h.ci[0])} / ${n2(h.ci[1])}` : '—'}</td>
                  <td className="text-right text-fg-2">{n2(h.pf)}</td>
                  <td className="text-right text-fg-2">{h.n ? `${h.max_dd_r.toFixed(1)}R` : '—'}</td>
                  <td className="text-right text-fg-2">{pv(h.p)}</td>
                  <td className="text-right text-fg-2">{pv(h.q ?? h.q_all)}</td>
                  <td className="min-w-[132px] !whitespace-normal py-1.5"><div className="flex flex-col gap-0.5"><Tier tier={r.tier} /><span className="text-2xs leading-tight text-fg-3">{t(VERDICT[r.reason] ?? r.reason)}</span></div></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <div className="p-4"><EmptyState text={t('Nessuna ipotesi con questi filtri')} compact /></div>}
      </div>
    </Card>
  )
}

function HoldoutCurves({ d }: { d: SignalsBacktest }) {
  const rows = d.rows.filter((r) => passedDev(r, d.protocol.min_n_dev) && r.curve.length)
  const option = useMemo(() => ({
    grid: { left: 8, right: 16, top: window.innerWidth < 640 ? 104 : 44, bottom: 8, containLabel: true },
    legend: { ...legendBase, top: 0 },
    tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v: number) => rr(v, 1) },
    xAxis: timeAxis(),
    yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${n2(v, 0)}R` } }),
    series: rows.map((r, i) => lineSeries(`${setupName(r.setup)} ${TF_LABEL(r.tf)} ${r.side}`, r.curve.map(([x, y]) => [x * 1000, y]), i === 0 ? T.accent : ANALOGS[i - 1], { step: 'end' })),
  }), [rows])
  return (
    <Card>
      <CardHeader icon={<LineChart />} title={t('Curve nell’holdout')} subtitle={t('Ipotesi che hanno passato lo sviluppo, in R cumulati dopo i costi')} />
      <CardBody className="flex flex-col">{rows.length ? <Fill min={340}><EChart option={option} height="100%" /></Fill> : <EmptyState text={t('Nessuna ipotesi ha passato lo sviluppo')} />}</CardBody>
    </Card>
  )
}

function MlRow({ label, m }: { label: string; m: MlBlock }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="text-right text-fg-2">{int(m.n)}</td>
      <td className={clsx('text-right', rClass(m.rules_mean_r))}>{rr(m.rules_mean_r)}</td>
      <td className="text-right text-fg-2">{m.kept ?? '—'}</td>
      <td className={clsx('text-right', rClass(m.filtered_mean_r))}>{rr(m.filtered_mean_r)}</td>
      <td className="text-right text-fg-3">{m.delta_ci ? `${n2(m.delta_ci[0])} / ${n2(m.delta_ci[1])}` : '—'}</td>
      <td className="text-right text-fg-2">{n2(m.auc)}</td>
      <td className="text-right text-fg-2">{fin(m.ece) ? `${m.ece.toFixed(1)} pt` : '—'}</td>
    </tr>
  )
}

function MlCard({ d }: { d: SignalsBacktest }) {
  const ml = d.ml
  const rel = ml.holdout.reliability ?? []
  const option = useMemo(() => ({
    grid: { left: 8, right: 16, top: 12, bottom: 30, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: { value: [number, number, number] }) => t('Stimata {a}%, osservata {b}%, {n} trade', { a: p.value[0].toFixed(0), b: p.value[1].toFixed(0), n: p.value[2] }) },
    xAxis: { type: 'value', min: 0, max: 80, name: t('Probabilità stimata di TP1 prima dello stop'), nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: C.muted, fontSize: 11, fontFamily: FONT }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } },
    yAxis: valueAxis({ scale: false, min: 0, max: 80, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
    series: [
      { name: '_diag', type: 'line', data: [[0, 0], [80, 80]], showSymbol: false, silent: true, lineStyle: { color: hexA(C.grey, 0.45), type: 'dashed', width: 1 }, tooltip: { show: false } },
      { name: 'holdout', type: 'line', data: rel.map((b) => [b.p, b.obs, b.n]), symbol: 'circle', symbolSize: 7, lineStyle: { width: 1.5, color: T.accent }, itemStyle: { color: T.accent }, emphasis: { disabled: true } },
    ],
  }), [rel])
  return (
    <Card>
      <CardHeader icon={<BrainCircuit />} title={t('Meta-modello')} subtitle={t('LightGBM su {n} trade, solo walk-forward, calibrato', { n: int(ml.n) })}
        info={t('Stima la probabilità che il candidato arrivi a TP1 prima dello stop. Il filtro tiene il candidato se la probabilità supera il pareggio del trade: nessuna soglia scelta a mano.')}
        right={<Badge color={ml.kept ? 'btc' : 'warn'}>{ml.kept ? t('In uso') : t('Non in uso')}</Badge>} />
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-fg-2">{t(ML_REASON[ml.reason] ?? ml.reason)}{ml.kept ? '' : `: ${t('l’app non mostra nessuna probabilità.')}`}</p>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>{t('Periodo')}</th><th className="text-right">{t('Trade')}</th><th className="text-right">{t('Solo regole')}</th><th className="text-right">{t('Filtrati')}</th><th className="text-right">{t('Con filtro')}</th><th className="text-right">{t('IC delta')}</th><th className="text-right">AUC</th><th className="text-right">ECE</th></tr></thead>
            <tbody><MlRow label={t('Walk-forward')} m={ml.dev} /><MlRow label="Holdout" m={ml.holdout} /></tbody>
          </table>
        </div>
        {rel.length > 0 && <EChart option={option} height={210} />}
      </CardBody>
    </Card>
  )
}

const RULES: [string, string, string, string][] = [
  ['vwap_reclaim', 'Dopo almeno 4 chiusure su 6 dal lato sbagliato, chiusura oltre il VWAP di almeno 0.1 ATR.', 'Oltre l’estremo delle ultime 6 candele, più 0.2 ATR.', 'Chiusura di nuovo oltre il VWAP.'],
  ['vwap_reject', 'Almeno 5 chiusure su 6 dal lato giusto, la candela tocca il VWAP e chiude respinta.', 'Oltre l’estremo della candela, più 0.3 ATR.', 'Chiusura oltre il VWAP.'],
  ['band_revert', 'Chiusura oltre la banda 2σ o 2.5σ, poi di nuovo dentro. Banda almeno 0.5 ATR, volatilità sotto il 90° percentile.', 'Oltre l’estremo di 3 candele, più 0.25 ATR. Target: banda 1σ e VWAP.', 'Solo stop e scadenza.'],
  ['sweep', 'La candela supera l’ultimo swing zigzag confermato, chiude di nuovo dentro con stoppino di almeno metà candela. Ogni swing vale una volta.', 'Oltre l’estremo dello sweep, più 0.2 ATR.', 'Chiusura oltre il livello spazzato.'],
  ['bos_retest', 'Rottura in chiusura di uno swing confermato, almeno 0.25 ATR oltre. Entrata limite sul livello, volatilità sopra il 10° percentile.', '0.75 o 1.25 ATR oltre il livello.', 'Chiusura 0.5 ATR oltre il livello. Annullato se tocca TP1 prima dell’entrata.'],
  ['cvd_div', 'Nuovo estremo di chiusura sulla finestra con delta spot e delta perp di segno opposto, almeno 0.5σ o 1σ.', 'Oltre l’estremo di 4 candele, più 0.3 ATR.', 'Chiusura oltre quell’estremo.'],
  ['funding_ext', 'Funding oltre 2 o 3 z robusti contro il segnale e prezzo oltre 1σ dal VWAP. Filtro facoltativo: OI Bybit in crescita a 7 giorni.', '2 ATR.', 'Chiusura oltre 1.5 ATR.'],
  ['donchian', 'Prima chiusura oltre l’estremo di 20 o 55 candele, dal lato giusto della EMA 200, volatilità sopra il 10° percentile.', '2 ATR.', 'Chiusura 1 ATR dentro il canale.'],
]

function Rules() {
  return (
    <Card>
      <CardHeader icon={<ClipboardList />} title={t('Regole dei setup')} subtitle={t('Le stesse nel backtest e dal vivo. Entrata dopo la chiusura della candela segnale, TP in multipli di R salvo dove indicato.')}
        info={t('Scadenza: 24 ore sul 15m, 3 giorni sull’1h, 14 giorni sul 4h, 42 giorni sull’1g. Un’entrata limite vale 8 candele sul 15m e 1h, 6 sul 4h, 4 sull’1g. Il setup non emette se il rischio è sotto lo 0.4%: i costi supererebbero 0.35R.')} />
      <CardBody>
        <div className="grid gap-2 md:grid-cols-2 min-[1700px]:grid-cols-4">
          {RULES.map(([k, entry, stop, inv]) => (
            <div key={k} className="tile flex flex-col gap-1.5 p-3">
              <div className="text-sm font-semibold text-white">{setupName(k)}</div>
              <p className="text-xs leading-relaxed text-fg-2">{t(entry)}</p>
              <p className="text-xs leading-relaxed text-fg-3"><span className="label mr-1.5">{t('Stop')}</span>{t(stop)}</p>
              <p className="text-xs leading-relaxed text-fg-3"><span className="label mr-1.5">{t('Invalidazione')}</span>{t(inv)}</p>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function Protocol({ d }: { d: SignalsBacktest }) {
  const p = d.protocol
  const rc = d.resolution_check
  return (
    <MethodNote title={t('Protocollo, costi e limiti')}>
      <p>{t('Sviluppo dal {a} al {b}: regole e parametri si scelgono solo qui, con il walk-forward sul {y}. Holdout dal {c} al {d}, mai usato per scegliere regole o parametri. Quello che arriva dopo è fuori campione e non cambia il verdetto.', { a: date(p.dev_from), b: date(p.dev_end - 86400), y: p.wf_years.join(', '), c: date(p.holdout_start), d: date(p.freeze - 86400) })}</p>
      <p>{t('Validato richiede tutto questo: almeno {n} trade e R medio positivo nel walk-forward, almeno {m} trade nell’holdout con R medio positivo, intervallo di confidenza bootstrap sopra zero, q BH sotto {q} e almeno il {y}% degli anni in positivo. Sperimentale è tutto il resto. Disattivato: R medio non positivo in entrambi i periodi, o meno di 20 trade in tutto, più Ritorno alla media 15m short, escluso a mano per l’holdout negativo.', { n: p.min_n_dev, m: p.min_n_hold, q: p.q_max, y: p.min_years_pos * 100 })}</p>
      <p>{t('Costi: commissione taker {f}% per lato, slittamento {s}% per esecuzione ({c}% andata e ritorno), funding reale durante la permanenza. Metà posizione esce a TP1 e lo stop del resto va a pareggio. Se stop e target cadono nella stessa candela conta lo stop.', { f: p.fee_pct, s: p.slip_pct, c: p.cost_pct })}</p>
      {rc && <p>{t('Candele fini: il backtest usa le 5m, il live le 1m. Rifatti con le 1m, {n} trade dal 2025 cambiano esito nello {c}% dei casi e di {r}R in media.', { n: int(rc.n), c: rc.changed_pct.toFixed(1), r: rc.mean_diff_r.toFixed(3) })}</p>}
      <p>{t('Limiti: {h} ipotesi su {g} combinazioni, un numero alto che rende facile trovare risultati casuali. Delta spot e perp vengono da Binance, non dall’aggregato multi-exchange, che ha pochi mesi di storia. Liquidazioni reali, book e OI aggregato hanno storico troppo breve e non entrano nei setup. L’OI usato è quello giornaliero Bybit, dal 2020. Lo slittamento è una stima e il prezzo è quello del solo perpetuo Binance.', { h: p.hypotheses, g: p.trials })}</p>
    </MethodNote>
  )
}

function MethodBody({ d }: { d: SignalsBacktest }) {
  const s = d.summary
  const rc = d.resolution_check
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip>
        <KpiCell icon={<GitCommitHorizontal />} label={t('Ipotesi provate')} value={s.tested} foot={t('{n} combinazioni di parametri', { n: d.protocol.trials })} />
        <KpiCell icon={<FlaskConical />} label={t('Passate lo sviluppo')} value={s.dev_passed} foot={t('Walk-forward positivo, almeno {n} trade', { n: d.protocol.min_n_dev })} />
        <KpiCell icon={<ShieldCheck />} label={t('Validate')} value={s.validated} foot={t('Holdout e correzione BH')} />
        <KpiCell icon={<BrainCircuit />} label={t('Meta-modello')} value={d.ml.kept ? t('In uso') : t('Non in uso')} foot={t('Solo se migliora fuori campione')} />
        <KpiCell icon={<Receipt />} label={t('Costi andata e ritorno')} value={p1(d.protocol.cost_pct, 2)} foot={t('Più funding reale')} />
        <KpiCell icon={<Timer />} label={t('Dati fino al')} value={date(d.data_to, false)} foot={rc ? t('Controllo 1m: {c}% di esiti diversi', { c: rc.changed_pct.toFixed(1) }) : t('Candele fini a 5m')} />
      </KpiStrip>
      <VerdictTable d={d} />
      <div className="grid gap-3 xl:grid-cols-2">
        <HoldoutCurves d={d} />
        <MlCard d={d} />
      </div>
      <Rules />
      <Protocol d={d} />
    </div>
  )
}

export function MethodTab() {
  const q = useSignalBacktest()
  return (
    <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[480px]" /></div>}>
      {(d) => (d.status === 'ok' ? <MethodBody d={d} /> : <Card><CardBody><EmptyState text={t('Backtest in calcolo: servono alcuni minuti dopo il primo avvio.')} /></CardBody></Card>)}
    </Q>
  )
}
