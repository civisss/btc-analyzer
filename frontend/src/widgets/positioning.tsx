/* Posizionamento: grafici e tabelle (opzioni, holder, sentiment). */
import { useMemo, type ReactNode } from 'react'
import type { Pt } from '../api/types'
import type { BacktestBlock, ExpiryRow, OptionsData, SentimentData, StrikeOi } from '../api/positioning'
import EChart from '../components/charts/EChart'
import { C, FONT, areaGradient, axisLabel, hexA, legendBase, lineSeries, tooltipBase, valueAxis } from '../components/charts/theme'
import { Badge, clsx } from '../components/ui'
import { cap, t, tr } from '../i18n'
import { DASH, date, dayUnit, pct, usd, usdCompact } from '../lib/format'

type Num = number | null | undefined
export const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
export const fx = (v: Num, d = 2) => (fin(v) ? (v < 0 ? '−' : '') + Math.abs(v).toFixed(d) : DASH)
/** Signed number with Unicode minus ("+2.4", "−1.3"). */
export const sfx = (v: Num, d = 1) => (fin(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) : DASH)
/** Table edge cells aligned with CardBody padding. */
export const TW = '-mx-4 overflow-x-auto no-scrollbar sm:-mx-5'
export const TL = 'pl-4 sm:pl-5'
export const TR = 'pr-4 text-right sm:pr-5'
const strikeFmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : String(v))

function row(color: string, name: string, val: string) {
  return `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`
}
const head = (s: string) => `<div style="color:${C.muted};margin-bottom:4px">${s}</div>`
const priceLine = (x: number, label: string) => ({
  xAxis: x, lineStyle: { color: C.btc, type: 'solid', width: 1 },
  label: { formatter: label, color: C.btc, fontSize: 11, fontFamily: FONT, position: 'end', rotate: 0, distance: 4 },
})
const greyLine = (x: number, label: string) => ({
  xAxis: x, lineStyle: { color: hexA(C.grey, 0.7), type: 'dashed', width: 1 },
  label: { formatter: label, color: C.text, fontSize: 11, fontFamily: FONT, position: 'start', rotate: 0, distance: 4 },
})

// ------------------------------------------------------------------ OI per strike (call sopra, put sotto)
export function OiStrikeChart({ strikes, price, maxPain, unit, range, height = 360 }: {
  strikes: StrikeOi[]; price: number; maxPain?: number | null; unit: 'btc' | 'usd'; range: number; height?: number | string
}) {
  const option = useMemo(() => {
    const val = (s: StrikeOi, side: 'calls' | 'puts') => (unit === 'usd' ? s[`${side}_usd` as const] : s[side])
    const fmt = (v: number) => (unit === 'usd' ? usdCompact(Math.abs(v), 1) : `${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} BTC`)
    const marks = [priceLine(price, `${t('Prezzo')} ${usd(price)}`)]
    if (fin(maxPain)) marks.push(greyLine(maxPain, `Max pain ${strikeFmt(maxPain)}`))
    return {
      grid: { left: 8, right: 12, top: 52, bottom: 24, containLabel: true },
      legend: { ...legendBase, data: ['Call', 'Put'] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => {
          const k = ps[0]?.value[0]
          return head(t('Strike {k} · {p} dal prezzo', { k: usd(k), p: pct((k / price - 1) * 100, 1) })) + ps.map((p) => row(p.color, p.seriesName, fmt(p.value[1]))).join('')
        },
      },
      xAxis: { type: 'value', min: Math.floor(price * (1 - range / 100) / 1000) * 1000, max: Math.ceil(price * (1 + range / 100) / 1000) * 1000,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { ...axisLabel, formatter: strikeFmt, hideOverlap: true } },
      yAxis: valueAxis({ scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => (unit === 'usd' ? usdCompact(Math.abs(v), 1).replace(/\.0(?=[KMBT]?$)/, '') : Math.abs(v).toLocaleString('en-US')) } }),
      series: [
        { name: 'Call', type: 'bar', data: strikes.map((s) => [s.strike, val(s, 'calls')]), itemStyle: { color: C.blue }, barMaxWidth: 10, barGap: '-100%',
          markLine: { symbol: 'none', silent: true, data: marks } },
        { name: 'Put', type: 'bar', data: strikes.map((s) => [s.strike, -val(s, 'puts')]), itemStyle: { color: C.purple }, barMaxWidth: 10 },
      ],
    }
  }, [strikes, price, maxPain, unit, range])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ gamma per strike
export function GammaChart({ profile, price, height = 260 }: { profile: OptionsData['gamma']['profile']; price: number; height?: number | string }) {
  const option = useMemo(() => ({
    grid: { left: 8, right: 12, top: 52, bottom: 8, containLabel: true },
    legend: { ...legendBase, data: ['Gamma call', 'Gamma put'] },
    tooltip: {
      ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) =>
        head(`Strike ${usd(ps[0]?.value[0])}`) + ps.map((p) => row(p.color, p.seriesName, t('{v} per 1%', { v: usdCompact(p.value[1], 1) }))).join(''),
    },
    xAxis: { type: 'value', min: Math.floor(price * 0.8 / 1000) * 1000, max: Math.ceil(price * 1.2 / 1000) * 1000,
      axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { ...axisLabel, formatter: strikeFmt, hideOverlap: true } },
    yAxis: valueAxis({ scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => usdCompact(v, 0) } }),
    series: [
      { name: 'Gamma call', type: 'bar', stack: 'g', data: profile.map((p) => [p.strike, p.calls]), itemStyle: { color: C.blue }, barMaxWidth: 10,
        markLine: { symbol: 'none', silent: true, data: [priceLine(price, t('Prezzo'))] } },
      { name: 'Gamma put', type: 'bar', stack: 'g', data: profile.map((p) => [p.strike, p.puts]), itemStyle: { color: C.purple }, barMaxWidth: 10 },
    ],
  }), [profile, price])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ smile IV
const SMILE_COLORS = [C.blue, C.purple, C.teal]
export function SmileChart({ smiles, height = 280 }: { smiles: OptionsData['smiles']; height?: number | string }) {
  const option = useMemo(() => {
    const names = smiles.map((s) => `${date(s.expiry, false)} · ${Math.round(s.days)}${dayUnit()}`)
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: names },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: [number, number, number]; color: string }[]) =>
          head(t('Moneyness {m}% del forward', { m: ps[0]?.value[0].toFixed(0) })) + ps.map((p) => row(p.color, `${p.seriesName} · strike ${usd(p.value[2])}`, `${p.value[1].toFixed(1)}%`)).join(''),
      },
      xAxis: { type: 'value', min: 60, max: 160, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series: smiles.map((s, i) => lineSeries(names[i], s.points.map((p) => [p.moneyness, p.iv, p.strike]), SMILE_COLORS[i % 3], {
        ...(i === 0 ? { markLine: { symbol: 'none', silent: true, data: [{ xAxis: 100, lineStyle: { color: hexA(C.grey, 0.5), type: 'dashed' }, label: { formatter: 'ATM', color: C.muted, fontSize: 11 } }] } } : {}),
      })),
    }
  }, [smiles])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ struttura a termine
export function TermChart({ term, height = 280 }: { term: OptionsData['term_structure']; height?: number | string }) {
  const option = useMemo(() => {
    const nIv = t('IV ATM (%)'), nSk = t('Skew 25Δ (punti)')
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [nIv, nSk] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; seriesIndex: number; value: [number, number, number]; color: string }[]) =>
          head(t('Scadenza {d} · {n}', { d: date(ps[0]?.value[2]), n: `${Math.round(ps[0]?.value[0])}${dayUnit()}` })) +
          ps.map((p) => row(p.color, p.seriesName, p.seriesIndex === 0 ? `${p.value[1].toFixed(1)}%` : sfx(p.value[1], 1))).join(''),
      },
      xAxis: { type: 'log', logBase: 2, min: 1, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { ...axisLabel, formatter: (v: number) => `${v}${dayUnit()}` } },
      yAxis: [
        valueAxis({ position: 'left', axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
        valueAxis({ position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => sfx(v, 1) } }),
      ],
      series: [
        lineSeries(nIv, term.filter((x) => fin(x.atm_iv)).map((x) => [x.days, x.atm_iv, x.expiry]), C.blue, {
          showSymbol: true, symbol: 'circle', symbolSize: 5, areaStyle: { color: areaGradient(C.blue, 0.18, 0) } }),
        lineSeries(nSk, term.filter((x) => fin(x.skew_25d)).map((x) => [x.days, x.skew_25d, x.expiry]), C.grey, {
          yAxisIndex: 1, showSymbol: true, symbol: 'circle', symbolSize: 4, lineStyle: { width: 1.25, color: C.grey, type: 'dashed' },
          markLine: { symbol: 'none', silent: true, data: [{ yAxis: 0, lineStyle: { color: hexA(C.grey, 0.35), type: 'dotted' }, label: { show: false } }] },
        }),
      ],
    }
  }, [term])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ tabella scadenze
const kindLabel = (k: string) => ({
  giornaliera: tr('Giornaliera', 'Daily'), settimanale: tr('Settimanale', 'Weekly'), mensile: tr('Mensile', 'Monthly'), trimestrale: tr('Trimestrale', 'Quarterly'),
} as Record<string, string>)[k] ?? cap(k)
export function ExpiryTable({ rows }: { rows: ExpiryRow[] }) {
  return (
    <div className={TW}>
      <table className="tbl min-w-[860px]">
        <thead>
          <tr>
            <th className={TL}>{tr('Scadenza', 'Expiry')}</th>
            <th>{tr('Tipo', 'Type')}</th>
            <th className="text-right">{tr('Tempo', 'Time left')}</th>
            <th className="text-right">Max pain</th>
            <th className="text-right">{tr('Distanza', 'Distance')}</th>
            <th className="text-right">{t('OI nozionale')}</th>
            <th className="text-right">{t('Call / Put (BTC)')}</th>
            <th className="text-right">{t('Put/Call OI')}</th>
            <th className="text-right">{t('IV ATM')}</th>
            <th className={TR}>Skew 25Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const big = r.kind === 'mensile' || r.kind === 'trimestrale'
            return (
              <tr key={r.expiry}>
                <td className={clsx(TL, big ? 'font-medium text-white' : 'text-slate-200')}>{date(r.expiry)}</td>
                <td className={big ? 'text-slate-200' : 'text-slate-400'}>{kindLabel(r.kind)}</td>
                <td className="text-right text-slate-300">{r.days < 1 ? `${Math.max(1, Math.round(r.days * 24))}h` : `${Math.round(r.days)}${dayUnit()}`}</td>
                <td className="text-right font-medium text-white">{usd(r.max_pain)}</td>
                <td className="text-right text-slate-300">{pct(r.max_pain_dist, 1)}</td>
                <td className="text-right text-slate-200">{usdCompact(r.notional_usd, 2)}</td>
                <td className="text-right text-slate-300">{Math.round(r.oi_calls).toLocaleString('en-US')} / {Math.round(r.oi_puts).toLocaleString('en-US')}</td>
                <td className="text-right text-slate-200">{fx(r.pc_oi)}</td>
                <td className="text-right text-slate-300">{fin(r.atm_iv) ? `${r.atm_iv.toFixed(1)}%` : DASH}</td>
                <td className={clsx(TR, 'text-slate-300')}>{fin(r.skew_25d) ? `${sfx(r.skew_25d)} pt` : DASH}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ sentiment: indice su traccia lineare
/** Zone labels stay Italian here (module level); translate at render with t(). */
export const SENT_ZONES = [
  { lo: 0, hi: 25, label: 'Paura estrema' }, { lo: 25, hi: 40, label: 'Paura' }, { lo: 40, hi: 60, label: 'Neutrale' },
  { lo: 60, hi: 75, label: 'Avidità' }, { lo: 75, hi: 100, label: 'Euforia' },
]
const ZONE_GRAD = 'linear-gradient(90deg, rgba(239,84,102,0.55), rgba(239,84,102,0.16) 32%, rgba(140,150,173,0.16) 50%, rgba(46,189,133,0.16) 68%, rgba(46,189,133,0.55))'
export function SentimentTrack({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div>
      <div className="relative h-2 w-full rounded-full" style={{ background: ZONE_GRAD }}>
        {[25, 40, 60, 75].map((b) => <div key={b} className="absolute inset-y-0 w-px bg-black/50" style={{ left: `${b}%` }} />)}
        <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-white shadow" style={{ left: `${v}%` }} />
      </div>
      <div className="relative mt-1.5 h-4 text-2xs text-slate-400">
        {SENT_ZONES.map((z, i) => (
          <span key={z.label} className={clsx('absolute whitespace-nowrap', i === 0 ? 'left-0' : i === SENT_ZONES.length - 1 ? 'right-0' : '-translate-x-1/2', (i === 1 || i === 3) && 'hidden sm:inline')}
            style={i === 0 || i === SENT_ZONES.length - 1 ? undefined : { left: `${(z.lo + z.hi) / 2}%` }}>{t(z.label)}</span>
        ))}
      </div>
    </div>
  )
}

/** Score 0..100 bar for one component (neutral grey; the number carries the meaning). */
export function ScoreTrack({ score }: { score: Num }) {
  const s = fin(score) ? Math.max(0, Math.min(100, score)) : null
  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
      {s != null && <div className="absolute inset-y-0 left-0 rounded-full bg-slate-300/60" style={{ width: `${s}%` }} />}
    </div>
  )
}

// ------------------------------------------------------------------ backtest
const ret = (v: Num) => { const z = fin(v) && Math.abs(v) < 0.05; return <span className={clsx('tnum', !fin(v) || z ? 'text-slate-400' : v >= 0 ? 'text-up' : 'text-down')}>{pct(z ? 0 : v, 1)}</span> }
const hit = (v: Num) => <span className="tnum text-slate-300">{fin(v) ? `${v.toFixed(0)}%` : DASH}</span>
const med = (n: number) => t('{n}g mediana', { n })

export function ZoneBacktestTable({ bt, currentZone }: { bt: SentimentData['backtest']; currentZone: string }) {
  const rows: { label: ReactNode; b: BacktestBlock; cur?: boolean; base?: boolean }[] = [
    ...bt.zones.map((z) => ({ label: <>{t(z.zone)} <span className="text-slate-400">{z.lo}–{z.hi}</span></>, b: z, cur: z.zone === currentZone })),
    { label: t('Tutti i giorni'), b: bt.baseline, base: true },
  ]
  return (
    <div className={TW}>
      <table className="tbl min-w-[680px]">
        <thead>
          <tr>
            <th className={TL}>{t('Zona indice')}</th>
            <th className="text-right">{tr('Giorni', 'Days')}</th>
            <th className="text-right">{tr('Episodi', 'Episodes')}</th>
            <th className="text-right">{med(7)}</th>
            <th className="text-right">{med(30)}</th>
            <th className="text-right">{t('{n}g positivi', { n: 30 })}</th>
            <th className="text-right">{med(90)}</th>
            <th className={TR}>{t('{n}g positivi', { n: 90 })}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={clsx(r.base && '[&_td]:border-t-white/15')}>
              <td className={clsx(TL, 'whitespace-nowrap', r.cur ? 'font-medium text-white' : 'text-slate-200')}>{r.label}{r.cur && <Badge color="blue" className="ml-2">{tr('Ora', 'Now')}</Badge>}</td>
              <td className="text-right text-slate-300">{r.b.days.toLocaleString('en-US')}</td>
              <td className="text-right text-slate-300">{r.base ? DASH : r.b.episodes}</td>
              <td className="text-right">{ret(r.b.r7_median)}</td>
              <td className="text-right">{ret(r.b.r30_median)}</td>
              <td className="text-right">{hit(r.b.hit30)}</td>
              <td className="text-right">{ret(r.b.r90_median)}</td>
              <td className={TR}>{hit(r.b.hit90)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ComponentBacktestTable({ bt }: { bt: SentimentData['backtest'] }) {
  return (
    <div className={TW}>
      <table className="tbl min-w-[720px]">
        <thead>
          <tr>
            <th className={TL}>{tr('Componente', 'Component')}</th>
            <th className="text-right">{t('Paura · episodi')}</th>
            <th className="text-right">{med(30)}</th>
            <th className="text-right">{t('{n}g mediana · positivi', { n: 90 })}</th>
            <th className="text-right">{t('Euforia · episodi')}</th>
            <th className="text-right">{med(30)}</th>
            <th className={TR}>{t('{n}g mediana · positivi', { n: 90 })}</th>
          </tr>
        </thead>
        <tbody>
          {bt.components.map((c) => (
            <tr key={c.key}>
              <td className={clsx(TL, 'whitespace-nowrap text-slate-200')}>{c.label}</td>
              {c.enough && c.fear && c.greed ? (
                <>
                  <td className="text-right text-slate-300">{c.fear.episodes}</td>
                  <td className="text-right">{ret(c.fear.r30_median)}</td>
                  <td className="text-right">{ret(c.fear.r90_median)} <span className="text-slate-400">·</span> {hit(c.fear.hit90)}</td>
                  <td className="text-right text-slate-300">{c.greed.episodes}</td>
                  <td className="text-right">{ret(c.greed.r30_median)}</td>
                  <td className={TR}>{ret(c.greed.r90_median)} <span className="text-slate-400">·</span> {hit(c.greed.hit90)}</td>
                </>
              ) : (
                <td colSpan={6} className={clsx(TR, 'text-slate-400')}>{c.since ? t('Storico insufficiente (dal {d})', { d: date(c.since) }) : t('Storico insufficiente')}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ util serie
export const lastValue = (pts: Pt[] | undefined): number | null => {
  if (!pts) return null
  for (let i = pts.length - 1; i >= 0; i--) if (fin(pts[i].value)) return pts[i].value
  return null
}
