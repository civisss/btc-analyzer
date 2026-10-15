/* Derivati PRO: basis e curva dei futures, posizionamento CME (COT), leva aggregata Binance + Bybit + OKX. */
import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity, BadgeCheck, Building2, CalendarClock, Coins, Gauge, GitCompareArrows, History, Landmark, Layers, LineChart, ListChecks,
  Percent, PieChart, Scale, Signal, Spline, TrendingUp, Users,
} from 'lucide-react'
import {
  useAggregate, useBasis, useCme, type AggregateData, type BasisData, type BasisRow, type BasisVenue, type CmeData, type CotCat, type ExchangeId, type Signal as Sig,
} from '../api/derivPro'
import type { Pt } from '../api/types'
import EChart from '../components/charts/EChart'
import {
  C, axisLabel, dataZoomInside, dataZoomSlider, hexA, legendBase, lineSeries, timeAxis, toXY, tooltipBase, valueAxis,
} from '../components/charts/theme'
import {
  Card, CardBody, CardHeader, EmptyState, Fill, KpiCell, KpiStrip, MethodNote, ProgressBar, Q, Segmented, Skeleton, ToneBadge, clsx,
} from '../components/ui'
import { getLang, t, tr } from '../i18n'
import { DASH, compact, date, dateTime, dayUnit, int, pct, pts, usd, usdCompact } from '../lib/format'
import { TimeLinesChart } from './charts'
import { TL, TR, TW } from './positioning'

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
/** "+1,234 BTC" / "−34,260 BTC" */
const btc = (v: Num, signed = false) => (fin(v) ? `${signed && v > 0 ? '+' : ''}${int(v)} BTC` : DASH)
/** KPI tiles: compact BTC ("199.3K BTC", "−34.3K BTC") so the 28px value fits on phones */
const btcK = (v: Num, signed = false) => (fin(v) ? `${signed && v > 0 ? '+' : ''}${compact(v, 1)} BTC` : DASH)
const signedInt = (v: Num) => (fin(v) ? `${v > 0 ? '+' : ''}${int(v)}` : DASH)
const pct8h = (v: Num, d = 4) => (fin(v) ? pct(v, d) : DASH)
/** percentile ordinal: 38° (IT) / 38th (EN) */
const ord = (v: Num) => {
  if (!fin(v)) return DASH
  const n = Math.round(v)
  if (getLang() !== 'en') return `${n}°`
  const sfx = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${sfx}`
}

const tipHead = (s: string) => `<div style="color:#94a3b8;font-size:11px;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)">${s}</div>`
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:18px;align-items:center;line-height:20px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`

// ===================================================================== exchange identity (shared with Liquidazioni)
export const EX_COLOR: Record<ExchangeId, string> = { binance: C.blue, bybit: C.purple, okx: C.teal }
export const EX_NAME: Record<ExchangeId, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX' }
export function ExchangeBadge({ ex, className }: { ex: ExchangeId | string | undefined; className?: string }) {
  const id = (ex && ex in EX_COLOR ? ex : 'binance') as ExchangeId
  const col = EX_COLOR[id]
  return (
    <span className={clsx('inline-flex h-5 w-fit items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-2xs font-medium ring-1 ring-inset', className)}
      style={{ color: col, background: hexA(col, 0.1), boxShadow: `inset 0 0 0 1px ${hexA(col, 0.22)}` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: col }} />{EX_NAME[id]}
    </span>
  )
}

/** Reading list; in a stretched side card the items spread over the free height. */
function Signals({ items }: { items: Sig[] }) {
  if (!items.length) return <EmptyState text={t('Nessun segnale')} compact />
  return (
    <ul className="flex flex-1 flex-col justify-around">
      {items.map((s, i) => (
        <li key={i} className="flex flex-col gap-1 border-t border-line py-2.5 first:border-t-0 first:pt-0">
          <ToneBadge tone={s.tone} className="self-start" />
          <p className="text-sm leading-relaxed text-slate-300">{s.text}</p>
        </li>
      ))}
    </ul>
  )
}

/** Divider-grid cell: label · value · sub-line. */
function Stat({ k, v, sub }: { k: ReactNode; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="label truncate">{k}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-white">{v}</div>
      <div className="tnum truncate text-xs text-slate-400">{sub ?? DASH}</div>
    </div>
  )
}

/** Verification row: check mark (or amber dot) · label · detail. */
function Check({ ok, label, children }: { ok: boolean | null; label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 border-t border-line py-2.5 text-sm first:border-t-0 first:pt-0">
      <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', ok === true ? 'bg-up' : ok === false ? 'bg-amber-400' : 'bg-slate-500')} />
      <div className="min-w-0">
        <div className="font-medium text-white">{label}</div>
        <div className="tnum mt-0.5 text-xs leading-relaxed text-slate-400">{children}</div>
      </div>
    </div>
  )
}

const Skel = () => <div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[380px]" /><Skeleton className="h-[300px]" /></div>

// ===================================================================== BASIS
const VENUE_LABEL: Record<BasisVenue, string> = { deribit: 'Deribit', binance_usdm: 'Binance USDⓈ-M', binance_coinm: 'Binance COIN-M' }
const VENUE_COLOR: Record<BasisVenue, string> = { deribit: C.primary, binance_usdm: C.blue, binance_coinm: C.purple }
const shapeLabel = (s: BasisData['shape']) => (s ? { contango: 'Contango', backwardation: 'Backwardation', flat: 'Contango', mixed: t('Mista') }[s] : DASH)
const daysTxt = (d: number) => (d < 1 ? `${Math.max(1, Math.round(d * 24))}h` : `${Math.round(d)}${dayUnit()}`)

function CurveChart({ rows, height = 340 }: { rows: BasisRow[]; height?: number | string }) {
  const option = useMemo(() => {
    const venues: BasisVenue[] = ['deribit', 'binance_usdm', 'binance_coinm']
    const names = venues.map((v) => VENUE_LABEL[v])
    const ok = rows.filter((r) => !r.noisy)
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: names },
      tooltip: {
        ...tooltipBase, trigger: 'item',
        formatter: (p: { seriesName: string; color: string; value: [number, number, number, string, number] }) =>
          tipHead(`${p.value[3]} · ${t('scadenza {d}', { d: date(p.value[2]) })}`) + tipRow(p.color, t('Annualizzato'), pct(p.value[1], 2)) +
          tipRow(p.color, 'Basis', pct(p.value[4], 3)) + tipRow(p.color, t('Giorni'), daysTxt(p.value[0])),
      },
      xAxis: { type: 'log', logBase: 2, min: 4, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { ...axisLabel, formatter: (v: number) => `${v}${dayUnit()}` } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series: venues.map((v, i) => {
        const data = ok.filter((r) => r.venue === v).map((r) => [r.days, r.annualized_pct, r.expiry, r.instrument, r.basis_pct])
        return v === 'deribit'
          ? lineSeries(names[i], data, VENUE_COLOR[v], { showSymbol: true, symbol: 'circle', symbolSize: 7, lineStyle: { width: 1.6, color: VENUE_COLOR[v] } })
          : { name: names[i], type: 'scatter', data, symbol: i === 1 ? 'diamond' : 'triangle', symbolSize: 11, itemStyle: { color: VENUE_COLOR[v] } }
      }),
    }
  }, [rows])
  return <EChart option={option} height={height} />
}

type HistMode = 'cm' | 'contract'
function BasisHistoryChart({ d, mode, height = 380 }: { d: BasisData; mode: HistMode; height?: number | string }) {
  const option = useMemo(() => {
    const h = d.history
    const nC = mode === 'cm' ? t('COIN-M · 90 giorni') : t('COIN-M · per contratto')
    const nU = mode === 'cm' ? t('USDⓈ-M · 90 giorni') : t('USDⓈ-M · per contratto')
    const nR = t('Giorno di roll')
    const c = mode === 'cm' ? h.coinm : h.coinm_contract
    const u = mode === 'cm' ? h.usdm : h.usdm_contract
    const byT = new Map(h.coinm_contract.map((p) => [p.time, p.value]))
    const rolls = h.rolls.coinm.map((tm) => [tm * 1000, byT.get(tm) ?? null]).filter((x) => x[1] != null)
    const series: unknown[] = [
      lineSeries(nC, toXY(c), C.purple, { lineStyle: { width: 1.5, color: C.purple },
        markLine: { symbol: 'none', silent: true, data: [{ yAxis: 0, lineStyle: { color: hexA(C.grey, 0.45), type: 'dashed' }, label: { show: false } }] } }),
      lineSeries(nU, toXY(u), C.blue, { lineStyle: { width: 1.2, color: C.blue } }),
    ]
    if (mode === 'contract') series.push({ name: nR, type: 'scatter', data: rolls, symbol: 'circle', symbolSize: 7, itemStyle: { color: C.amber }, z: 5 })
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: mode === 'contract' ? [nC, nU, nR] : [nC, nU] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; color: string; value: [number, number | null] }[]) =>
          tipHead(date(Number(ps[0]?.value[0]) / 1000)) + ps.filter((p) => p.value[1] != null)
            .map((p) => tipRow(p.color, p.seriesName, p.seriesName === nR ? t('cambio contratto') : pct(p.value[1], 2))).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series,
    }
  }, [d, mode])
  return <EChart option={option} height={height} />
}

function BasisKpis({ d }: { d: BasisData }) {
  const s = d.stats
  // prossimo trimestrale (stessa scadenza dei trimestrali Binance) con almeno 14 giorni alla scadenza
  const qExp = d.curve.filter((r) => r.venue !== 'deribit' && r.days >= 14).sort((a, b) => a.days - b.days)[0]?.expiry
  const q = d.curve.find((r) => r.venue === 'deribit' && qExp != null && Math.abs(r.expiry - qExp) < 3600)
  const pb = d.perpetual.binance_usdm, pd = d.perpetual.deribit
  return (
    <KpiStrip>
      <KpiCell icon={<Percent />} label={t('Basis annualizzato 90 g')} value={pct(s.current_pct, 2)}
        foot={`COIN-M${s.live ? ' live' : ''} · USDⓈ-M ${pct(s.usdm_live_pct, 2)}`} />
      <KpiCell icon={<Gauge />} label={t('Percentile storico')} value={ord(s.percentile)}
        foot={t('Dal 2020 · 1 anno {p}', { p: ord(s.percentile_1y) })} />
      <KpiCell icon={<History />} label={t('Media 30 giorni')} value={pct(s.avg_30d, 2)}
        foot={s.max ? t('Massimo {v} il {d}', { v: pct(s.max.value, 1), d: date(s.max.time) }) : undefined} />
      <KpiCell icon={<CalendarClock />} label={t('Deribit trimestrale')} value={q ? pct(q.annualized_pct, 2) : DASH}
        foot={q ? t('{d} · {n} · basis {b}', { d: date(q.expiry, false), n: daysTxt(q.days), b: pct(q.basis_pct, 2) }) : undefined} />
      <KpiCell icon={<Activity />} label={t('Premium perpetuo')} value={pct(pb?.premium_pct, 3)}
        foot={`Binance · Deribit ${pct(pd?.premium_pct, 3)}`} />
      <KpiCell icon={<Spline />} label={t('Forma della curva')} value={shapeLabel(d.shape)}
        foot={fin(d.slope_pp) ? t('Da breve a lungo {v}', { v: pts(d.slope_pp, 2) }) : undefined} />
    </KpiStrip>
  )
}

function CurveTable({ rows }: { rows: BasisRow[] }) {
  return (
    <div className={TW}>
      <table className="tbl min-w-[720px]">
        <thead>
          <tr>
            <th className={TL}>{t('Scadenza')}</th><th>{t('Mercato')}</th><th className="text-right">{tr('Tempo', 'Time left')}</th>
            <th className="text-right">Mark</th><th className="text-right">Basis</th><th className="text-right">{t('Annualizzato')}</th><th className={TR}>OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.venue}-${r.instrument}`}>
              <td className={clsx(TL, 'font-medium text-white')}>{date(r.expiry)}</td>
              <td className="text-slate-300"><span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: VENUE_COLOR[r.venue] }} />{VENUE_LABEL[r.venue]}</td>
              <td className="text-right text-slate-300">{daysTxt(r.days)}</td>
              <td className="text-right text-slate-200">{usd(r.mark)}</td>
              <td className="text-right text-slate-300">{pct(r.basis_pct, 3)}</td>
              <td className={clsx('text-right', r.noisy ? 'text-slate-500' : 'font-medium text-white')} title={r.noisy ? t('Meno di 7 giorni alla scadenza: annualizzato rumoroso') : undefined}>
                {pct(r.annualized_pct, 2)}{r.noisy ? '*' : ''}
              </td>
              <td className={clsx(TR, 'text-slate-300')}>{fin(r.oi_usd) ? usdCompact(r.oi_usd, 1) : DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function BasisTab() {
  const q = useBasis()
  const [mode, setMode] = useState<HistMode>('cm')
  return (
    <Q q={q} loading={<Skel />}>
      {(d) => {
        const x = d.crosscheck
        const off = x.binance_official
        return (
          <div className="flex flex-col gap-3">
            <BasisKpis d={d} />
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-8">
                <CardHeader icon={<Spline />} title={t('Struttura a termine')} updatedAt={q.dataUpdatedAt}
                  subtitle={t('Basis annualizzato per giorni alla scadenza · indice {p}', { p: usd(d.index_price) })}
                  info={t('Ogni punto è un future con scadenza: (prezzo mark ÷ indice − 1) × 365 ÷ giorni alla scadenza. Una curva crescente (contango) è la norma; una curva invertita segnala stress. Esclusi i contratti con meno di 7 giorni.')} />
                <CardBody className="flex flex-col"><Fill min={300}><CurveChart rows={d.curve} height="100%" /></Fill></CardBody>
              </Card>
              <Card className="h-full xl:col-span-4">
                <CardHeader icon={<Signal />} title={t('Lettura')} />
                <CardBody className="flex flex-col pt-0"><Signals items={d.signals} /></CardBody>
              </Card>
            </div>
            <Card>
              <CardHeader icon={<LineChart />} title={t('Storico del basis trimestrale')}
                subtitle={mode === 'cm'
                  ? t('Scadenza costante 90 giorni · COIN-M dal {a}, USDⓈ-M dal {b}', { a: date(d.history.start.coinm), b: date(d.history.start.usdm) })
                  : t('Contratto trimestrale in uso, cambio {n} giorni prima della scadenza ({r} roll)', { n: d.params.roll_days, r: d.history.rolls.coinm.length })}
                info={t('Per contratto: basis annualizzato del trimestrale effettivamente in uso, con i giorni di cambio marcati; il gradino al roll è reale (si passa da una scadenza breve a una lunga). Scadenza costante 90 giorni: interpolazione tra trimestrale corrente e successivo, senza gradini: è la serie usata per percentili e lettura.')}
                right={<Segmented value={mode} onChange={setMode} options={[{ value: 'cm' as HistMode, label: t('90 giorni') }, { value: 'contract' as HistMode, label: t('Per contratto') }]} />} />
              <CardBody className="flex flex-col"><Fill min={380}><BasisHistoryChart d={d} mode={mode} height="100%" /></Fill></CardBody>
            </Card>
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-7">
                <CardHeader icon={<ListChecks />} title={t('Scadenze')} subtitle={t('Deribit e trimestrali Binance · * meno di 7 giorni')} />
                <CardBody className="pt-0"><CurveTable rows={d.curve} /></CardBody>
              </Card>
              <Card className="h-full xl:col-span-5">
                <CardHeader icon={<BadgeCheck />} title={t('Verifiche incrociate')} subtitle={t('Fonti indipendenti a confronto')} />
                <CardBody className="flex flex-col justify-around pt-0">
                  {off && (
                    <Check ok={Math.abs(off.diff_pp) < 0.1} label={t('Formula vs dato ufficiale Binance')}>
                      {t('Nostro {a} · Binance {b} (differenza {d}) · trimestrale USDⓈ-M del {t}', { a: pct(off.ours_pct, 2), b: pct(off.binance_pct, 2), d: pts(off.diff_pp, 2), t: date(off.time) })}
                    </Check>
                  )}
                  {x.pairs.map((p) => (
                    <Check key={p.expiry} ok={Math.abs(p.diff_pp) < 1.5} label={t('Stessa scadenza {d}', { d: date(p.expiry) })}>
                      Deribit {pct(p.deribit_pct, 2)} · USDⓈ-M {pct(p.binance_usdm_pct, 2)} · COIN-M {pct(p.binance_coinm_pct, 2)} · {t('scarto {d}', { d: pts(p.diff_pp, 2) })}
                    </Check>
                  ))}
                  {x.coinm_vs_usdm && (
                    <Check ok={x.coinm_vs_usdm.mean_abs_diff_1y_pp < 1} label={t('COIN-M vs USDⓈ-M (storico)')}>
                      {t('Scarto medio {a} (ultimo anno {b}) · correlazione {c} su {n} giorni', {
                        a: `${x.coinm_vs_usdm.mean_abs_diff_pp.toFixed(2)} pt`, b: `${x.coinm_vs_usdm.mean_abs_diff_1y_pp.toFixed(2)} pt`, c: x.coinm_vs_usdm.corr.toFixed(2), n: int(x.coinm_vs_usdm.n),
                      })}
                    </Check>
                  )}
                  {x.roll_check && (
                    <Check ok={x.roll_check.cm90_roll_pp <= x.roll_check.cm90_other_pp * 1.5} label={t('Nessun salto artificiale ai roll')}>
                      {t('Variazione mediana nei {n} giorni di roll: {a} (altri giorni {b}) sulla serie 90 g · per contratto {c} vs {e}', {
                        n: x.roll_check.n_rolls, a: `${x.roll_check.cm90_roll_pp.toFixed(2)} pt`, b: `${x.roll_check.cm90_other_pp.toFixed(2)} pt`,
                        c: `${x.roll_check.contract_roll_pp.toFixed(2)} pt`, e: `${x.roll_check.contract_other_pp.toFixed(2)} pt`,
                      })}
                    </Check>
                  )}
                  <Check ok={null} label={t('Curva Deribit a 90 giorni')}>
                    {d.deribit_cm90.since ? t('In raccolta dal {d} ({n} salvati): Deribit non offre lo storico della curva.', { d: date(d.deribit_cm90.since), n: `${d.deribit_cm90.series.length} ${d.deribit_cm90.series.length === 1 ? tr('giorno', 'day') : tr('giorni', 'days')}` }) : DASH}
                  </Check>
                </CardBody>
              </Card>
            </div>
            <MethodNote>
              <p>{t('Basis annualizzato semplice = (F ÷ S − 1) × 365 ÷ giorni, con F = prezzo mark del future e S = indice dello stesso exchange (Deribit: indice BTC/USD; Binance USDⓈ-M: indice BTC/USDT; COIN-M: indice BTC/USD). È la convenzione dell\'annualizedBasisRate pubblicato da Binance.')}</p>
              <p>{t('Scadenze trimestrali: ultimo venerdì di marzo, giugno, settembre e dicembre alle 08:00 UTC. Storico Binance dai continuousKlines giornalieri (CURRENT_QUARTER / NEXT_QUARTER) contro gli indexPriceKlines; le candele a volume zero (contratto non ancora quotato, es. USDⓈ-M nel 2021) sono scartate.')}</p>
              <p>{t('Il basis è il rendimento del cash-and-carry (compra spot, vendi il future): alto = forte domanda di leva long e carry istituzionale ricco (es. aprile 2021 ≈ 50%); vicino a zero o negativo = sfiducia (marzo 2023 ≈ −4%). Lettura di studio, non un segnale operativo.')}</p>
            </MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

// ===================================================================== CME
const COT_LABEL: Record<CotCat, () => string> = {
  lev: () => 'Leveraged funds', am: () => 'Asset manager', dealer: () => 'Dealer', other: () => t('Altri riportabili'), nr: () => t('Non riportabili'),
}
const COT_COLOR: Record<CotCat, string> = { lev: C.purple, am: C.blue, dealer: C.teal, other: C.grey, nr: C.grey2 }

function CotNetChart({ d, height = 360 }: { d: CmeData; height?: number | string }) {
  const lines = useMemo(() => (['lev', 'am', 'dealer'] as CotCat[]).map((c) => ({
    name: COT_LABEL[c](), color: COT_COLOR[c],
    data: (d.history[`${c}_net` as const] as Pt[]).map((p) => ({ time: p.time, value: p.value == null ? null : p.value * d.contract_btc })),
  })), [d])
  return <TimeLinesChart height={height} lines={lines} yFmt={(v) => `${int(v)} BTC`} zoom markLines={[{ y: 0, color: hexA(C.grey, 0.5) }]} />
}

function CotOiChart({ d, height = 300 }: { d: CmeData; height?: number | string }) {
  const lines = useMemo(() => [
    { name: t('OI CME (5 BTC)'), data: d.history.oi_btc, color: C.blue, area: true },
    { name: t('OI Micro (0.1 BTC)'), data: d.history.micro_oi_btc, color: C.grey, width: 1.2 },
  ], [d])
  return <TimeLinesChart height={height} lines={lines} yFmt={(v) => `${int(v)} BTC`} zoom />
}

export function CmeTab() {
  const q = useCme()
  return (
    <Q q={q} loading={<Skel />}>
      {(d) => {
        const by = Object.fromEntries(d.categories.map((c) => [c.id, c])) as Record<CotCat, CmeData['categories'][number]>
        const v = d.verification
        return (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-line bg-surface px-4 py-2.5 text-xs text-slate-300">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              {t('Dati del martedì {r}, pubblicati dalla CFTC venerdì {p} (ritardo di 3 giorni). Prossimo report: dati del {n}, pubblicazione prevista {q}.', {
                r: date(d.report_date), p: date(d.published), n: date(d.next_report, false), q: date(d.next_publication, false),
              })}
            </div>
            <KpiStrip>
              <KpiCell icon={<Layers />} label={t('Open interest CME')} value={btcK(d.oi_contracts * d.contract_btc)}
                foot={t('{n} contratti · Δ {c}', { n: int(d.oi_contracts), c: btc(d.oi_change_btc, true) })} />
              <KpiCell icon={<TrendingUp />} label={t('Leveraged funds netto')} value={btcK(by.lev.net_btc, true)}
                foot={t('{n} contratti · Δ {c}', { n: signedInt(by.lev.net), c: signedInt(by.lev.net_change) })} />
              <KpiCell icon={<Building2 />} label={t('Asset manager netto')} value={btcK(by.am.net_btc, true)}
                foot={t('{n} contratti · Δ {c}', { n: signedInt(by.am.net), c: signedInt(by.am.net_change) })} />
              <KpiCell icon={<Landmark />} label={t('Dealer netto')} value={btcK(by.dealer.net_btc, true)}
                foot={t('{n} contratti · Δ {c}', { n: signedInt(by.dealer.net), c: signedInt(by.dealer.net_change) })} />
              <KpiCell icon={<Coins />} label={t('Micro Bitcoin')} value={btcK(d.micro.oi_btc)}
                foot={t('{n} contratti da 0.1 BTC', { n: int(d.micro.oi_contracts) })} />
              <KpiCell icon={<BadgeCheck />} label={t('Verifica CFTC')} value={v ? (v.match ? t('Coincide') : t('Differenze')) : DASH}
                foot={v ? t('Report testuale ufficiale del {d}', { d: date(v.report_date) }) : t('Report testuale non raggiungibile')} />
            </KpiStrip>
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-8">
                <CardHeader icon={<Scale />} title={t('Posizioni nette per categoria')} updatedAt={q.dataUpdatedAt} interval={15 * 60_000}
                  subtitle={t('In BTC (contratti × 5) · settimanale dal {d}', { d: date(d.since) })}
                  info={t('Leveraged funds = hedge fund e CTA; asset manager = fondi istituzionali; dealer = banche e market maker. Netto = long − short. Gli short dei leveraged funds sono in larga parte la gamba corta del basis trade (long spot/ETF, short CME).')} />
                <CardBody className="flex flex-col"><Fill min={300}><CotNetChart d={d} height="100%" /></Fill></CardBody>
              </Card>
              <Card className="h-full xl:col-span-4">
                <CardHeader icon={<Signal />} title={t('Lettura')} />
                <CardBody className="flex flex-col pt-0"><Signals items={d.signals} /></CardBody>
              </Card>
            </div>
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-7">
                <CardHeader icon={<Users />} title={t('Posizioni della settimana')} subtitle={t('Contratti da 5 BTC · variazione rispetto alla settimana precedente')} />
                <CardBody className="pt-0">
                  <div className={TW}>
                    <table className="tbl min-w-[680px]">
                      <thead>
                        <tr>
                          <th className={TL}>{t('Categoria')}</th><th className="text-right">Long</th><th className="text-right">Short</th>
                          <th className="text-right">{t('Netto')}</th><th className="text-right">{t('Δ netto')}</th><th className="text-right">{t('% OI long / short')}</th>
                          <th className={TR}>{t('Percentile 3 anni')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.categories.map((c) => (
                          <tr key={c.id}>
                            <td className={clsx(TL, 'font-medium text-white')}><span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: COT_COLOR[c.id] }} />{COT_LABEL[c.id]()}</td>
                            <td className="text-right text-slate-200">{int(c.long)}</td>
                            <td className="text-right text-slate-200">{int(c.short)}</td>
                            <td className="text-right font-medium text-white">{signedInt(c.net)}</td>
                            <td className="text-right text-slate-300">{signedInt(c.net_change)}</td>
                            <td className="text-right text-slate-300">{c.pct_oi_long.toFixed(1)}% / {c.pct_oi_short.toFixed(1)}%</td>
                            <td className={clsx(TR, 'text-slate-300')}>{ord(c.net_pctl_3y)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="dgrid mt-3 grid-cols-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
                    <Stat k={t('Trader totali')} v={int(d.traders.total)} sub={t('Riportabili e non')} />
                    <Stat k={t('Lev. funds L / S')} v={`${int(d.traders.lev_long)} / ${int(d.traders.lev_short)}`} sub={t('Numero di trader')} />
                    <Stat k={t('Asset manager L / S')} v={`${int(d.traders.am_long)} / ${int(d.traders.am_short)}`} sub={t('Numero di trader')} />
                    <Stat k={t('OI percentile 3 anni')} v={ord(d.oi_pctl_3y)} sub={t('{n} report dal 2018', { n: d.weeks })} />
                  </div>
                </CardBody>
              </Card>
              <Card className="h-full xl:col-span-5">
                <CardHeader icon={<Layers />} title={t('Open interest CME in BTC')} subtitle={t('Bitcoin (5 BTC) e Micro (0.1 BTC) sono mercati separati')} />
                <CardBody className="flex flex-col"><Fill min={300}><CotOiChart d={d} height="100%" /></Fill></CardBody>
              </Card>
            </div>
            <MethodNote>
              <p>{t('Fonte: CFTC, Commitments of Traders — Traders in Financial Futures, solo futures (dataset pubblico gpe5-46if), codice 133741 Bitcoin CME (5 BTC) dal 10 apr 2018 e 133742 Micro Bitcoin (0.1 BTC) dal 4 mag 2021. Le posizioni in BTC sono contratti × dimensione del contratto.')}</p>
              <p>{t('Verifica automatica: i numeri dell\'ultima settimana sono confrontati con il report testuale ufficiale della CFTC (financial_lf.htm): open interest, long e short di dealer, asset manager, leveraged funds e non riportabili.')}</p>
              <p>{t('Il dato fotografa il martedì e viene pubblicato il venerdì successivo (15:30 ET): nei giorni intermedi il posizionamento reale può essere cambiato. Le festività USA possono spostare la pubblicazione.')}</p>
            </MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

// ===================================================================== LEVA AGGREGATA
type OiRange = 30 | 365 | 0
const sinceFilter = (p: Pt[], days: OiRange) => {
  if (!days || !p.length) return p
  const from = p[p.length - 1].time - days * 86400
  return p.filter((x) => x.time >= from)
}

function ExchangeTable({ d }: { d: AggregateData }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className={TW}>
        <table className="tbl min-w-[680px]">
          <thead>
            <tr>
              <th className={TL}>Exchange</th><th className="text-right">{t('OI (USD)')}</th><th className="text-right">{t('OI (BTC)')}</th>
              <th className="w-[18%]">{t('Quota')}</th><th className="text-right">{t('Funding /8h')}</th><th className="text-right">{t('Annuo')}</th><th className={TR}>{t('Long (account)')}</th>
            </tr>
          </thead>
          <tbody>
            {d.exchanges.map((e) => (
              <ExRows key={e.id} e={e} open={open} />
            ))}
            <tr>
              <td className={clsx(TL, 'font-semibold text-white')}>{t('Totale')}</td>
              <td className="text-right font-semibold text-white">{usdCompact(d.total.oi_usd, 2)}</td>
              <td className="text-right font-semibold text-white">{btc(d.total.oi_btc)}</td>
              <td className="text-slate-400">{t('{n} di 3 exchange', { n: d.total.exchanges_ok })}</td>
              <td className="text-right font-semibold text-white" title={t('Media ponderata per OI in USD')}>{pct8h(d.total.funding_8h)}</td>
              <td className="text-right text-slate-300">{pct(d.total.funding_annual, 1)}</td>
              <td className={TR} />
            </tr>
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="link mt-2 h-8 px-3">
        {open ? t('Nascondi i contratti') : t('Mostra i contratti ({n})', { n: d.exchanges.reduce((a, e) => a + e.contracts.length, 0) })}
      </button>
    </>
  )
}

function ExRows({ e, open }: { e: AggregateData['exchanges'][number]; open: boolean }) {
  return (
    <>
      <tr>
        <td className={TL}><ExchangeBadge ex={e.id} />{!e.ok && <span className="ml-2 text-xs text-amber-400">{t('non disponibile')}</span>}</td>
        <td className="text-right font-medium text-white">{usdCompact(e.oi_usd, 2)}</td>
        <td className="text-right text-slate-200">{btc(e.oi_btc)}</td>
        <td><div className="flex items-center gap-2"><ProgressBar value={e.share_pct ?? 0} color={EX_COLOR[e.id]} className="h-1 flex-1" /><span className="tnum w-12 text-right text-xs text-slate-300">{pct(e.share_pct, 1, false)}</span></div></td>
        <td className="text-right text-slate-200">{pct8h(e.funding_8h)}</td>
        <td className="text-right text-slate-300">{fin(e.funding_8h) ? pct(e.funding_8h * 3 * 365, 1) : DASH}</td>
        <td className={clsx(TR, 'text-slate-300')}>{fin(e.long_pct) ? `${e.long_pct.toFixed(1)}%` : DASH}</td>
      </tr>
      {open && e.contracts.map((c) => (
        <tr key={c.symbol} className="text-xs">
          <td className={clsx(TL, 'pl-8 text-slate-400')}>{c.symbol} <span className="text-slate-500">· {c.kind}</span></td>
          <td className="text-right text-slate-300">{usdCompact(c.oi_usd, 2)}</td>
          <td className="text-right text-slate-400">{btc(c.oi_btc)}</td>
          <td className="text-slate-500">{fin(c.oi_usd_both_sides) ? t('API: {v} a due lati', { v: usdCompact(c.oi_usd_both_sides, 2) }) : ''}</td>
          <td className="text-right text-slate-300">{pct8h(c.funding_8h)}</td>
          <td className="text-right text-slate-400">{c.interval_h !== 8 ? t('ogni {h}h', { h: c.interval_h }) : pct(c.funding_8h * 3 * 365, 1)}</td>
          <td className={clsx(TR, 'text-slate-400')}>{usd(c.mark)}</td>
        </tr>
      ))}
    </>
  )
}

export function LeverageTab() {
  const q = useAggregate()
  const [oiRange, setOiRange] = useState<OiRange>(0)
  const [fRange, setFRange] = useState<OiRange>(30)
  return (
    <Q q={q} loading={<Skel />}>
      {(d) => {
        const h = d.history
        const exs: ExchangeId[] = ['binance', 'bybit', 'okx']
        const oiLines = [
          ...exs.map((e) => ({ name: EX_NAME[e], data: sinceFilter(h.oi_btc[e] ?? [], oiRange), color: EX_COLOR[e], width: 1.4 })),
          { name: t('Totale (3 exchange)'), data: sinceFilter(h.oi_btc.total ?? [], oiRange), color: C.primary, width: 2 },
        ]
        const fLines = [
          ...exs.map((e) => ({ name: EX_NAME[e], data: sinceFilter(h.funding[e] ?? [], fRange), color: EX_COLOR[e], width: 1.2 })),
          { name: t('Ponderato per OI'), data: sinceFilter(h.funding.weighted ?? [], fRange), color: C.primary, width: 2 },
        ]
        const lsLines = exs.map((e) => ({ name: EX_NAME[e], data: sinceFilter(h.long_pct[e] ?? [], 365), color: EX_COLOR[e], width: 1.4 }))
        const cc = d.crosscheck
        const ranges = [{ value: 30 as OiRange, label: `30${dayUnit()}` }, { value: 365 as OiRange, label: tr('1A', '1Y') }, { value: 0 as OiRange, label: tr('Tutto', 'All') }]
        return (
          <div className="flex flex-col gap-3">
            <KpiStrip>
              <KpiCell icon={<Layers />} label={t('Open interest aggregato')} value={usdCompact(d.total.oi_usd, 2)} foot={t('Perpetui BTC · {n} di 3 exchange', { n: d.total.exchanges_ok })} />
              <KpiCell icon={<Coins />} label={t('OI aggregato in BTC')} value={btcK(d.total.oi_btc)}
                foot={fin(d.total.change_7d_pct) ? t('{c} in 7 giorni', { c: pct(d.total.change_7d_pct, 1) }) : t('Variazione 7 giorni non disponibile')} />
              <KpiCell icon={<Percent />} label={t('Funding ponderato')} value={pct8h(d.total.funding_8h)} foot={t('Per 8h · annuo {v}', { v: pct(d.total.funding_annual, 1) })} />
              <KpiCell icon={<Activity />} label={t('Funding medio semplice')} value={pct8h(d.total.funding_simple_avg)} foot={t('Media dei 3 exchange · per 8h')} />
              <KpiCell icon={<PieChart />} label={t('Quota Binance')} value={pct(d.exchanges.find((e) => e.id === 'binance')?.share_pct, 1, false)}
                foot={t('Solo BTCUSDT {v}', { v: pct(d.total.binance_usdt_share_pct, 0, false) })} />
              <KpiCell icon={<GitCompareArrows />} label={t('Copertura OI globale')} value={pct(cc.coverage_pct, 0, false)}
                foot={t('Su {v} di perpetui BTC (CoinGecko)', { v: usdCompact(cc.global_perp_oi_usd, 1) })} />
            </KpiStrip>
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-8">
                <CardHeader icon={<Building2 />} title={t('Leva per exchange')} updatedAt={q.dataUpdatedAt}
                  subtitle={t('Perpetui USDT, USDC e coin-margined · funding normalizzato a 8 ore')}
                  info={t('Open interest a un lato (convenzione standard). Bybit pubblica nel campo openInterest la somma dei due lati: qui si usa il valore a un lato (singleOpenInterest). Long (account) = quota di account con posizione long, ultimo dato giornaliero (Binance orario).')} />
                <CardBody className="pt-0"><ExchangeTable d={d} /></CardBody>
              </Card>
              <Card className="h-full xl:col-span-4">
                <CardHeader icon={<Signal />} title={t('Lettura')} />
                <CardBody className="flex flex-col pt-0"><Signals items={d.signals} /></CardBody>
              </Card>
            </div>
            <Card>
              <CardHeader icon={<LineChart />} title={t('Open interest per exchange')}
                subtitle={t('In BTC, giornaliero · Bybit dal {a}, OKX dal {b}, Binance dal {c} (in accumulo) · totale dal {d}', {
                  a: date(h.starts.bybit), b: date(h.starts.okx), c: date(h.starts.binance), d: date(h.starts.total),
                })}
                info={t('Binance fornisce solo 30 giorni di storico: da qui in avanti l\'app lo accumula ogni giorno. Il totale è mostrato solo nei giorni coperti da tutti e tre gli exchange.')}
                right={<Segmented value={oiRange} onChange={setOiRange} options={ranges} />} />
              <CardBody className="flex flex-col"><Fill min={360}><TimeLinesChart height="100%" lines={oiLines} yFmt={(v) => `${int(v)} BTC`} zoom /></Fill></CardBody>
            </Card>
            <div className="grid gap-3 xl:grid-cols-2">
              <Card className="h-full">
                <CardHeader icon={<Percent />} title={t('Funding per exchange')} subtitle={t('Media giornaliera, % per 8 ore · OKX conserva ~3 mesi (in accumulo)')}
                  right={<Segmented value={fRange} onChange={setFRange} options={ranges} />} />
                <CardBody className="flex flex-col"><Fill min={300}><TimeLinesChart height="100%" lines={fLines} yFmt={(v) => `${v.toFixed(3)}%`} markLines={[{ y: 0.01, color: hexA(C.grey, 0.5), label: '0.01%' }]} /></Fill></CardBody>
              </Card>
              <Card className="h-full">
                <CardHeader icon={<Users />} title={t('Account long per exchange')} subtitle={t('Quota di account con posizione long, ultimo anno')}
                  info={t('Binance: account dei futures USDⓈ-M (storico di 30 giorni, in accumulo); Bybit: buyRatio giornaliero; OKX: rapporto long/short degli account su BTC-USDT-SWAP convertito in quota long.')} />
                <CardBody className="flex flex-col"><Fill min={300}><TimeLinesChart height="100%" lines={lsLines} yFmt={(v) => `${v.toFixed(0)}%`} markLines={[{ y: 50, color: hexA(C.grey, 0.5) }]} /></Fill></CardBody>
              </Card>
            </div>
            <Card>
              <CardHeader icon={<BadgeCheck />} title={t('Verifica con CoinGecko')} subtitle={cc.source_time ? t('Dati CoinGecko del {d} · {n} perpetui BTC censiti', { d: dateTime(cc.source_time), n: int(cc.contracts_global) }) : undefined}
                info={t('Confronto dell\'OI di ogni contratto con l\'aggregatore CoinGecko. Per Bybit CoinGecko riporta il valore a due lati: lo scarto è calcolato su quel valore e mostra che coincide. La quota globale usa il totale CoinGecko corretto per Bybit; include exchange con OI non verificabile, quindi è una stima prudente.')} />
              <CardBody className="pt-0">
                <div className={TW}>
                  <table className="tbl min-w-[620px]">
                    <thead><tr><th className={TL}>Exchange</th><th>{t('Contratto')}</th><th className="text-right">{t('OI app')}</th><th className="text-right">{t('OI CoinGecko')}</th><th className={TR}>{t('Scarto')}</th></tr></thead>
                    <tbody>
                      {cc.rows.map((r) => (
                        <tr key={`${r.exchange}-${r.symbol}`}>
                          <td className={TL}><ExchangeBadge ex={r.exchange} /></td>
                          <td className="text-slate-300">{r.symbol}{r.both_sides && <span className="ml-1.5 text-xs text-slate-500">{t('(CoinGecko a due lati)')}</span>}</td>
                          <td className="text-right text-slate-200">{usdCompact(r.ours_usd, 2)}</td>
                          <td className="text-right text-slate-200">{usdCompact(r.coingecko_usd, 2)}</td>
                          <td className={clsx(TR, fin(r.diff_pct) && Math.abs(r.diff_pct) < 2 ? 'text-slate-300' : 'text-amber-400')}>{pct(r.diff_pct, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
            <MethodNote>
              <p>{t('Contratti inclusi: Binance BTCUSDT, BTCUSDC e BTCUSD_PERP (COIN-M); Bybit BTCUSDT, BTCPERP (USDC) e BTCUSD (inverso); OKX BTC-USDT-SWAP e BTC-USD-SWAP. Esclusi: {x}.', { x: d.excluded.join(', ') })}</p>
              <p>{t('Funding ponderato = Σ funding × OI in USD ÷ Σ OI in USD, con ogni tasso riportato a 8 ore. Storico giornaliero OKX: snapshot delle 16:00 UTC assegnato al giorno UTC successivo (scarto di 8 ore).')}</p>
              <p>{t('Raccolta in avanti: ogni 5 minuti l\'app salva OI e funding dei tre exchange{s}.', { s: d.intraday.since ? t(' (dal {d})', { d: dateTime(d.intraday.since) }) : '' })}</p>
            </MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

