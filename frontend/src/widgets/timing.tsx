// Timing (Gann · Wyckoff · ritmi): etichette, grafici e tabelle della pagina /timing.
import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type {
  BucketResponse, GannResponse, GannTypeId, ScoreBin, ThirdsResponse, Verdict, WyBacktestRow, WyEvent, WyKey, WyPhase, WyRange, WyckoffResponse,
} from '../api/timing'
import type { LiveTf } from '../api/live'
import EChart from '../components/charts/EChart'
import ProChart, { type LineDef, type MarkerDef, type OverlayMarkerDef, type PaneDef, type PriceLineDef, type ZoneDef } from '../components/charts/ProChart'
import { C, FONT, axisLabel, hexA, legendBase, tooltipBase, valueAxis } from '../components/charts/theme'
import { Legend, clsx } from '../components/ui'
import { date, pct, usd } from '../lib/format'
import { months, t, tfLabel, tr, weekdays } from '../i18n'
import { VerdictBadge, fin, fmtP } from './astro'

export { VerdictBadge, fin, fmtP }
type Num = number | null | undefined

// ------------------------------------------------------------------ labels (Italian source strings, translated at render)
const GANN_LABEL: Record<GannTypeId, string> = {
  c30: '30 giorni', c45: '45 giorni', c60: '60 giorni', c90: '90 giorni', c120: '120 giorni', c144: '144 giorni', c180: '180 giorni',
  c270: '270 giorni', c360: '360 giorni', c_mult: 'Multipli lunghi', sq9: 'Quadrato del 9 nel tempo', yeardiv: 'Divisioni dell’anno',
  anniv: 'Anniversari', seasonal: 'Date stagionali',
}
const GANN_DESC: Record<GannTypeId, string> = {
  c30: 'Data a 30 giorni da ogni pivot maggiore.', c45: 'Data a 45 giorni da ogni pivot maggiore.', c60: 'Data a 60 giorni da ogni pivot maggiore.',
  c90: 'Data a 90 giorni da ogni pivot maggiore.', c120: 'Data a 120 giorni da ogni pivot maggiore.', c144: 'Data a 144 giorni (12²) da ogni pivot maggiore.',
  c180: 'Data a 180 giorni da ogni pivot maggiore.', c270: 'Data a 270 giorni da ogni pivot maggiore.', c360: 'Data a 360 giorni (un giro) da ogni pivot maggiore.',
  c_mult: 'Date a 540, 720 e 1080 giorni da ogni pivot maggiore.',
  sq9: 'Conteggi che cadono sulle croci cardinale e diagonale del quadrato del 9 (23, 25, 28, 31, 34 … fino a 400 giorni).',
  yeardiv: 'Frazioni dell’anno dal pivot: 1/8, 1/6, 1/4 e 1/3 di 365.25 giorni (46, 61, 91, 122 giorni).',
  anniv: 'Stesso giorno 1, 2, 3 e 4 anni dopo ogni pivot maggiore.',
  seasonal: 'Date fisse del calendario: equinozi, solstizi e date intermedie (4 feb, 6 mag, 8 ago, 8 nov).',
}
export const gannLabel = (id: GannTypeId) => t(GANN_LABEL[id] ?? id)
export const gannDesc = (id: GannTypeId) => t(GANN_DESC[id] ?? '')

const WY_SHORT: Record<WyKey, string> = {
  PS: 'PS', SC: 'SC', AR_A: 'AR', ST_A: 'ST', SPRING: 'Spring', TEST: 'Test', SOS: 'SOS', LPS: 'LPS', BRK_DN: 'Rottura',
  PSY: 'PSY', BC: 'BC', AR_D: 'AR', ST_D: 'ST', UT: 'UT', UTAD: 'UTAD', SOW: 'SOW', LPSY: 'LPSY', BRK_UP: 'Rottura',
}
const WY_NAME: Record<WyKey, string> = {
  PS: 'Preliminary support', SC: 'Selling climax', AR_A: 'Automatic rally', ST_A: 'Secondary test', SPRING: 'Spring', TEST: 'Test dello Spring',
  SOS: 'Sign of strength', LPS: 'Last point of support', BRK_DN: 'Rottura al ribasso: range fallito',
  PSY: 'Preliminary supply', BC: 'Buying climax', AR_D: 'Automatic reaction', ST_D: 'Secondary test', UT: 'Upthrust', UTAD: 'Upthrust after distribution',
  SOW: 'Sign of weakness', LPSY: 'Last point of supply', BRK_UP: 'Rottura al rialzo: range fallito',
}
const WY_RULE: Partial<Record<WyKey, string>> = {
  SC: 'Nuovo minimo dopo un ribasso, volume relativo ≥ 1.8 (o ≥ 1.4 con candela ampia)',
  BC: 'Nuovo massimo dopo un rialzo, volume relativo ≥ 1.8 (o ≥ 1.4 con candela ampia)',
  ST_A: 'Ritorno nel 20% basso del range dopo l’AR', ST_D: 'Ritorno nel 20% alto del range dopo l’AR',
  SPRING: 'In fase B: minimo sotto il range e chiusura di nuovo dentro entro 2 candele',
  TEST: 'Dopo lo Spring: minimo più alto nel 25% basso del range, volume minore',
  UT: 'In fase B: massimo sopra il range di ≤ 0.5 ATR e chiusura di nuovo dentro',
  UTAD: 'Upthrust più profondo di 0.5 ATR (o oltre un UT precedente) con chiusura dentro',
  SOS: 'Chiusura sopra il range con volume relativo ≥ 1.2 o candela ampia',
  SOW: 'Chiusura sotto il range con volume relativo ≥ 1.2 o candela ampia',
  LPS: 'Primo minimo dopo la rottura che resta sopra metà range', LPSY: 'Primo massimo dopo la rottura che resta sotto metà range',
}
export const wyShort = (k: WyKey) => t(WY_SHORT[k] ?? k)
export const wyName = (k: WyKey) => t(WY_NAME[k] ?? k)
export const wyRule = (k: WyKey) => (WY_RULE[k] ? t(WY_RULE[k]!) : '')
export const sideLabel = (s: 'acc' | 'dist') => (s === 'acc' ? t('Accumulazione') : t('Distribuzione'))
const STATUS: Record<WyRange['status'], string> = { active: 'In corso', up: 'Uscita al rialzo', down: 'Uscita al ribasso', failed: 'Fallito', expired: 'Scaduto' }
export const statusLabel = (s: WyRange['status']) => t(STATUS[s])
const PHASE_DESC: Record<WyPhase, string> = {
  A: 'Arresto del trend precedente', B: 'Costruzione della causa', C: 'Test finale (Spring o UTAD)', D: 'Uscita dal range in corso', E: 'Trend fuori dal range',
}
export const phaseDesc = (p: WyPhase) => t(PHASE_DESC[p])

const LEVEL_SRC: Record<string, string> = {
  wy_1d_high: 'Massimo range Wyckoff 1G', wy_1d_low: 'Minimo range Wyckoff 1G', wy_4h_high: 'Massimo range Wyckoff 4h', wy_4h_low: 'Minimo range Wyckoff 4h',
  st_1d_high: 'Massimo range 1G (Struttura)', st_1d_low: 'Minimo range 1G (Struttura)', st_1d_mid: 'Metà range 1G (Struttura)',
  vwap_w: 'VWAP settimanale', vwap_m: 'VWAP mensile', vwap_q: 'VWAP trimestrale', vwap_y: 'VWAP annuale',
  vwap_pw: 'VWAP settimana precedente', vwap_pm: 'VWAP mese precedente',
}
export const levelSrc = (s: string) => tfIn(t(LEVEL_SRC[s] ?? s))
const tfIn = (s: string) => s.replace(/\b1G\b/g, tfLabel('1d')).replace(/\b4h\b/g, tfLabel('4h'))

export const verdictText = (v: Verdict | null | undefined) =>
  v === 'strong' ? t('effetto significativo e stabile') : v === 'weak' ? t('effetto debole: non regge alla correzione per test multipli')
    : v === 'anecdotal' ? t('casi troppo pochi per un giudizio') : t('nessun vantaggio rispetto al caso')

export const pp = (v: Num, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : '—')
export const signed = (v: Num, d = 2) => pct(v, d)
export const sign = (v: Num) => (!fin(v) || v === 0 ? 'text-slate-300' : v > 0 ? 'text-up' : 'text-down')
export const daysTxt = (n: number) => (n === 0 ? t('oggi') : n === 1 ? t('domani') : t('tra {n} g', { n }))
export const PATTERN_GLYPH = (p: string) => p.split('').map((c) => (c === '+' ? '▲' : c === '-' ? '▼' : '·')).join(' ')

// ------------------------------------------------------------------ small bits
export function Mini({ label, value, title, cls }: { label: ReactNode; value: ReactNode; title?: string; cls?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="label truncate">{label}</div>
      <div className={clsx('tnum mt-0.5 truncate text-sm font-semibold text-white', cls)}>{value}</div>
    </div>
  )
}

export function ScoreDots({ score, max = 6 }: { score: number; max?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={t('Punteggio {s}', { s: score })} title={t('Punteggio {s}', { s: score })}>
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} className={clsx('h-1.5 w-1.5 rounded-full', i < score ? 'bg-accent-purple' : 'bg-white/[0.10]')} />
      ))}
    </span>
  )
}

// ------------------------------------------------------------------ Gann: calendario di confluenza (prossimi giorni)
export function ScoreCalendarChart({ g, height = '100%' }: { g: GannResponse; height?: number | string }) {
  const option = useMemo(() => {
    const rows = g.score_future
    const wd = weekdays(), mo = months()
    const lab = (s: number) => { const d = new Date(s * 1000); return `${d.getUTCDate()} ${mo[d.getUTCMonth()]}` }
    const keyDays = new Set(g.upcoming.filter((u) => u.score >= 2).map((u) => u.time))
    const bins = g.score_bins
    const binOf = (s: number) => bins.find((b) => s >= b.min && (b.max == null || s <= b.max))
    return {
      grid: { left: 8, right: 10, top: 14, bottom: 8, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(155,135,245,0.06)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const r = rows[ps[0]?.dataIndex ?? 0]
          if (!r) return ''
          const d = new Date(r.time * 1000)
          const b = binOf(r.score)
          const head = `${wd[d.getUTCDay()]} ${d.getUTCDate()} ${mo[d.getUTCMonth()]} ${d.getUTCFullYear()}`
          const list = r.types.length ? r.types.map((x) => `<div>· ${gannLabel(x)}</div>`).join('') : `<div style="color:${C.muted}">${t('Nessun conteggio')}</div>`
          const hist = b && fin(b.hit_rate) ? `<div style="color:${C.muted};margin-top:6px">${t('Storico per punteggio {s}: pivot nel {h} dei casi contro {c} per caso', { s: r.score, h: pp(b.hit_rate), c: pp(b.base_rate) })}</div>` : ''
          return `<div style="color:${C.muted};margin-bottom:4px">${head}</div><div style="display:flex;justify-content:space-between;gap:16px"><span>${t('Punteggio')}</span><b>${r.score}</b></div>${list}${hist}`
        },
      },
      xAxis: { type: 'category', data: rows.map((r) => lab(r.time)), axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: { ...axisLabel, hideOverlap: true } },
      yAxis: valueAxis({ scale: false, minInterval: 1, max: (v: { max: number }) => Math.max(4, v.max) }),
      series: [{
        type: 'bar', barMaxWidth: 12, data: rows.map((r) => ({
          value: r.score,
          itemStyle: { borderRadius: [2, 2, 0, 0], color: keyDays.has(r.time) ? C.purple : r.score >= 2 ? hexA(C.purple, 0.45) : hexA(C.grey, 0.28) },
        })),
      }],
    }
  }, [g])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Gann: hit rate per tipo contro la banda del caso
export function GannTypeChart({ g, height = '100%' }: { g: GannResponse; height?: number | string }) {
  const option = useMemo(() => {
    const rows = [...g.types].filter((r) => r.n > 0).reverse()
    const cats = rows.map((r) => gannLabel(r.id))
    const sHit = t('Hit rate delle date proiettate'), sBand = t('Banda del caso 90%'), sCtrl = t('Conteggi vicini non di Gann')
    const vals = rows.flatMap((r) => [r.null_q05, r.null_q95, r.hit_rate, r.ctrl_rate]).filter(fin)
    const lo = vals.length ? Math.max(0, Math.floor((Math.min(...vals) - 3) / 5) * 5) : 0
    const hi = vals.length ? Math.ceil((Math.max(...vals) + 3) / 5) * 5 : undefined
    return {
      grid: { left: 8, right: 16, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sHit, sCtrl, sBand] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(155,135,245,0.05)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const r = rows[ps[0]?.dataIndex ?? 0]
          if (!r) return ''
          const line = (a: string, b: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${a}</span><b>${b}</b></div>`
          return `<div style="color:${C.muted};margin-bottom:4px">${gannLabel(r.id)} · n = ${r.n}</div>` + line(sHit, pp(r.hit_rate)) + line(t('Caso (media placebo)'), pp(r.base_rate)) +
            line(sBand, `${pp(r.null_q05)} … ${pp(r.null_q95)}`) + line(sCtrl, pp(r.ctrl_rate)) + line(t('p corretto'), fmtP(r.p_bh_all ?? r.p_bh))
        },
      },
      // zoom on the populated range (rates sit around 25–35%): from 0 the dots and bands were squeezed into a third of the plot
      xAxis: valueAxis({ scale: false, min: lo, max: hi,
        axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      yAxis: { type: 'category', data: cats, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...axisLabel, color: C.text } },
      series: [
        { name: '_q05', type: 'bar', stack: 'band', data: rows.map((r) => r.null_q05), itemStyle: { color: 'transparent' }, silent: true, barWidth: 10 },
        { name: sBand, type: 'bar', stack: 'band', data: rows.map((r) => (fin(r.null_q95) && fin(r.null_q05) ? r.null_q95 - r.null_q05 : null)),
          itemStyle: { color: 'rgba(148,163,210,0.22)', borderRadius: 2 }, silent: true, barWidth: 10 },
        { name: sCtrl, type: 'scatter', data: rows.map((r) => r.ctrl_rate), symbol: 'rect', symbolSize: [2, 12], itemStyle: { color: C.grey } },
        { name: sHit, type: 'scatter', data: rows.map((r) => r.hit_rate), symbolSize: 9,
          itemStyle: { color: (q: { dataIndex: number }) => (rows[q.dataIndex]?.verdict === 'strong' ? C.purple : rows[q.dataIndex]?.verdict === 'weak' ? C.amber : C.primary) } },
      ],
    }
  }, [g])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Gann: storico per punteggio di confluenza
export function ScoreBinsChart({ bins, height = '100%' }: { bins: ScoreBin[]; height?: number | string }) {
  const option = useMemo(() => {
    const rows = bins.filter((b) => b.n > 0)
    const cats = rows.map((b) => (b.max == null ? `≥ ${b.min}` : b.min === b.max ? String(b.min) : `${b.min}–${b.max}`))
    const sHit = t('Pivot entro la finestra'), sBase = t('Giorno qualsiasi'), sQ = t('Soglia del caso (95°)')
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sHit, sBase, sQ] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(155,135,245,0.05)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const b = rows[ps[0]?.dataIndex ?? 0]
          if (!b) return ''
          const line = (a: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${a}</span><b>${v}</b></div>`
          return `<div style="color:${C.muted};margin-bottom:4px">${t('Punteggio {s}', { s: cats[ps[0].dataIndex] })} · ${t('{n} giorni', { n: b.n.toLocaleString('en-US') })}</div>` +
            line(sHit, pp(b.hit_rate)) + line(sBase, pp(b.base_rate)) + line(sQ, pp(b.null_q95)) + line('p', fmtP(b.p)) + line(t('p BH'), fmtP(b.p_bh))
        },
      },
      xAxis: { type: 'category', data: cats, name: t('Punteggio'), nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: C.muted, fontFamily: FONT, fontSize: 11 },
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, axisLabel },
      yAxis: valueAxis({ scale: false, min: 0, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series: [
        { name: sHit, type: 'bar', barMaxWidth: 34, data: rows.map((b) => b.hit_rate), itemStyle: { color: hexA(C.purple, 0.75), borderRadius: [3, 3, 0, 0] } },
        { name: sBase, type: 'line', data: rows.map((b) => b.base_rate), symbol: 'none', lineStyle: { color: C.grey, width: 1.5, type: 'dashed' }, itemStyle: { color: C.grey } },
        { name: sQ, type: 'scatter', data: rows.map((b) => b.null_q95), symbol: 'rect', symbolSize: [22, 2], itemStyle: { color: C.amber } },
      ],
    }
  }, [bins])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Gann: grafico prezzo con pivot maggiori
const NO_LINES: LineDef[] = []
const NO_ZONES: ZoneDef[] = []
const NO_PANES: PaneDef[] = []
const NO_PL: PriceLineDef[] = []
export function GannPriceChart({ g, height = '100%' }: { g: GannResponse; height?: number | string }) {
  const markers = useMemo<MarkerDef[]>(() => {
    const t0 = g.candles[0]?.time ?? 0
    const out: MarkerDef[] = []
    for (const a of g.anchors) {
      if (a.time < t0) continue
      out.push(a.kind === 'high' ? { time: a.time, position: 'aboveBar', color: C.purple, shape: 'arrowDown', text: t('Pivot maggiore') }
        : { time: a.time, position: 'belowBar', color: C.purple, shape: 'arrowUp', text: t('Pivot maggiore') })
    }
    const oe = g.open_extreme
    if (oe && oe.time >= t0) out.push({ time: oe.time, position: oe.kind === 'high' ? 'aboveBar' : 'belowBar', color: C.amber, shape: oe.kind === 'high' ? 'arrowDown' : 'arrowUp', text: t('Estremo non ancora confermato') })
    for (const x of g.targets_recent) {
      if (x.time < t0 || g.anchors.some((a) => a.time === x.time) || x.time === oe?.time) continue
      out.push({ time: x.time, position: x.kind === 'high' ? 'aboveBar' : 'belowBar', color: 'rgba(232,236,244,0.45)', shape: 'circle', size: 0.6 })
    }
    return out.sort((a, b) => a.time - b.time)
  }, [g])
  const priceLines = useMemo<PriceLineDef[]>(() => (g.fan?.lines ?? []).filter((l) => fin(l.price) && Math.abs(l.dist ?? 99) < 25)
    .map((l) => ({ price: l.price as number, color: hexA(C.amber, 0.6), title: `Gann ${l.key.replace('x', '×')}`, dashed: true })), [g])
  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      <div className="min-h-0 flex-1">
        <ProChart candles={g.candles} liveTf="1d" markers={markers} lines={NO_LINES} priceLines={priceLines.length ? priceLines : NO_PL} zones={NO_ZONES} panes={NO_PANES}
          height="100%" volume={false} logScale={false} tfLabel={tfLabel('1d')} fitKey="timing-gann" wheel={false} />
      </div>
      <Legend items={[
        { label: t('Pivot maggiori (ancore dei conteggi)'), color: C.purple },
        { label: t('Pivot a {n} giorni (bersagli)', { n: g.params.pivot_n }), color: '#C4CAD6' },
        ...(g.open_extreme ? [{ label: t('Estremo non ancora confermato'), color: C.amber }] : []),
        ...(priceLines.length ? [{ label: t('Angoli di Gann oggi (scala arbitraria)'), color: C.amber, dashed: true }] : []),
      ]} />
    </div>
  )
}

// ------------------------------------------------------------------ Wyckoff: grafico a candele con range ed eventi numerati
const ACC_COLOR = '#3CC6B0'
const DIST_COLOR = '#9B87F5'
const seg = (t0: number, t1: number, v: number) => [{ time: t0, value: v }, { time: t1, value: v }]
const ABOVE: WyKey[] = ['AR_A', 'SOS', 'PSY', 'BC', 'ST_D', 'UT', 'UTAD', 'LPSY', 'BRK_UP']

let wyHover: string | null = null
const wySubs = new Set<() => void>()
export const setWyHover = (id: string | null) => { if (id !== wyHover) { wyHover = id; wySubs.forEach((f) => f()) } }
export const useWyHover = () => useSyncExternalStore((f) => { wySubs.add(f); return () => { wySubs.delete(f) } }, () => wyHover)

/** Visible ranges' events, numbered 1..n in time order (shared by the chart circles and the events table). */
export function numberedEvents(w: WyckoffResponse): (WyEvent & { n: number; rid: number; side: 'acc' | 'dist' })[] {
  const t0 = w.candles[0]?.time ?? 0
  const all = w.ranges.flatMap((r, ri) => r.events.map((e) => ({ ...e, rid: ri, side: r.side }))).filter((e) => e.time >= t0)
  all.sort((a, b) => a.time - b.time)
  return all.map((e, i) => ({ ...e, n: i + 1 }))
}

export function WyckoffChart({ w, height = '100%' }: { w: WyckoffResponse; height?: number | string }) {
  const candles = w.candles
  const last = candles.length ? candles[candles.length - 1].time : 0
  const first = candles.length ? candles[0].time : 0
  const lines = useMemo<LineDef[]>(() => {
    const out: LineDef[] = []
    w.ranges.forEach((r, i) => {
      const s = Math.max(r.start, first)
      const e = r.end ?? last
      if (e < first) return
      const col = r.side === 'acc' ? ACC_COLOR : DIST_COLOR
      const dashed = r.status !== 'active'
      out.push({ id: `h${i}`, data: seg(s, e, r.high), color: col, width: r.status === 'active' ? 2 : 1, dashed })
      out.push({ id: `l${i}`, data: seg(s, e, r.low), color: col, width: r.status === 'active' ? 2 : 1, dashed })
    })
    return out
  }, [w, first, last])
  const overlay = useMemo<OverlayMarkerDef[]>(() => {
    const evs = numberedEvents(w)
    const out: OverlayMarkerDef[] = []
    let j = 0
    for (const e of evs) {
      while (j + 1 < candles.length && candles[j + 1].time <= e.time) j++
      const c = candles[j]
      if (!c) continue
      const above = ABOVE.includes(e.key)
      out.push({ id: `${w.tf}:${e.n}`, time: c.time, price: above ? c.high : c.low, position: above ? 'above' : 'below', label: String(e.n),
        title: `${wyShort(e.key)} · ${wyName(e.key)}`, sub: `${date(e.time)} · ${usd(e.price)}` })
    }
    return out
  }, [w, candles])
  const active = useWyHover()
  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      <div className="min-h-0 flex-1">
        <ProChart candles={candles} liveTf={w.tf as LiveTf} height="100%" lines={lines} priceLines={NO_PL} overlayMarkers={overlay} activeOverlayId={active}
          onOverlayHover={setWyHover} zones={NO_ZONES} panes={NO_PANES} volume tfLabel={tfLabel(w.tf)} fitKey={`wy-${w.tf}`} wheel={false} />
      </div>
      <Legend items={[
        { label: t('Range di accumulazione'), color: ACC_COLOR },
        { label: t('Range di distribuzione'), color: DIST_COLOR },
        { label: t('Range concluso'), color: '#8B94A7', dashed: true },
        { label: t('Eventi numerati: vedi tabella'), color: '#8B94A7' },
      ]} />
    </div>
  )
}

// ------------------------------------------------------------------ Wyckoff: forest plot (eccesso di rendimento con IC 95%)
export function ForestChart({ rows, days, height = '100%' }: { rows: WyBacktestRow[]; days: number; height?: number | string }) {
  const option = useMemo(() => {
    const list = rows.map((r) => ({ r, h: r.horizons.find((x) => x.days === days)! })).filter((x) => x.h && x.h.n > 0).reverse()
    const cats = list.map((x) => `${wyShort(x.r.key)} · ${x.r.side === 'acc' ? tr('acc.', 'acc.') : tr('distr.', 'dist.')}`)
    const sEx = t('Rendimento oltre il normale'), sCi = t('IC 95% bootstrap')
    return {
      grid: { left: 8, right: 16, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sEx, sCi] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(155,135,245,0.05)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const x = list[ps[0]?.dataIndex ?? 0]
          if (!x) return ''
          const line = (a: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${a}</span><b>${v}</b></div>`
          return `<div style="color:${C.muted};margin-bottom:4px">${wyName(x.r.key)} · ${t('{d} giorni', { d: days })} · n = ${x.h.n}</div>` +
            line(t('Media dopo l’evento'), signed(x.h.mean)) + line(t('Normale'), signed(x.h.base_mean)) + line(sEx, signed(x.h.excess)) +
            line(sCi, `${signed(x.h.ci?.[0])} … ${signed(x.h.ci?.[1])}`) + line(t('Direzione attesa'), x.r.direction === 'up' ? t('Rialzo') : t('Ribasso')) +
            line(t('p BH'), fmtP(x.h.p_bh))
        },
      },
      xAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%` } }),
      yAxis: { type: 'category', data: cats, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...axisLabel, color: C.text } },
      series: [
        { name: sCi, type: 'custom', silent: true, itemStyle: { color: 'rgba(148,163,210,0.45)' },
          data: list.map((x, i) => [i, x.h.ci?.[0] ?? null, x.h.ci?.[1] ?? null]),
          renderItem: (_p: unknown, api: { value: (k: number) => number; coord: (v: [number, number]) => [number, number] }) => {
            const lo = api.value(1), hi = api.value(2), i = api.value(0)
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
            const a0 = api.coord([lo, i]), a1 = api.coord([hi, i])
            return { type: 'line', shape: { x1: a0[0], y1: a0[1], x2: a1[0], y2: a1[1] }, style: { stroke: 'rgba(148,163,210,0.45)', lineWidth: 3, lineCap: 'round' } }
          },
          encode: { x: [1, 2], y: 0 } },
        { name: sEx, type: 'scatter', data: list.map((x) => x.h.excess), symbolSize: 9,
          itemStyle: { color: (q: { dataIndex: number }) => { const x = list[q.dataIndex]; return x?.h.n < 12 ? C.grey2 : x?.h.agrees ? C.teal : C.amber } },
          markLine: { symbol: 'none', silent: true, data: [{ xAxis: 0 }], lineStyle: { color: 'rgba(160,175,225,0.35)', type: 'dashed' }, label: { show: false } } },
      ],
    }
  }, [rows, days])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Ritmi: frequenza dello schema per anno
export function ThirdsYearChart({ r, height = '100%' }: { r: ThirdsResponse; height?: number | string }) {
  const option = useMemo(() => {
    const ys = r.by_year
    const sRate = t('Mesi con lo schema'), sNull = t('Atteso per caso')
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sRate, sNull] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(155,135,245,0.05)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const y = ys[ps[0]?.dataIndex ?? 0]
          if (!y) return ''
          return `<div style="color:${C.muted};margin-bottom:4px">${y.year}</div><div style="display:flex;justify-content:space-between;gap:16px"><span>${sRate}</span><b>${y.k} / ${y.n} · ${pp(y.rate)}</b></div>` +
            `<div style="display:flex;justify-content:space-between;gap:16px"><span>${sNull}</span><b>${pp(r.full.null)}</b></div>`
        },
      },
      xAxis: { type: 'category', data: ys.map((y) => String(y.year)), axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, axisLabel },
      yAxis: valueAxis({ scale: false, min: 0, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series: [
        { name: sRate, type: 'bar', barMaxWidth: 26, data: ys.map((y) => y.rate), itemStyle: { color: (q: { value: number }) => (q.value > (r.full.null ?? 0) ? hexA(C.purple, 0.8) : hexA(C.grey, 0.45)), borderRadius: [3, 3, 0, 0] } },
        { name: sNull, type: 'line', data: ys.map(() => r.full.null), symbol: 'none', lineStyle: { color: C.amber, width: 1.5, type: 'dashed' }, itemStyle: { color: C.amber } },
      ],
    }
  }, [r])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ Ritmi: caselle (media storica vs periodo recente)
export function bucketLabel(kind: BucketResponse['kind'], b: number): string {
  if (kind === 'weekday') return [tr('Lun', 'Mon'), tr('Mar', 'Tue'), tr('Mer', 'Wed'), tr('Gio', 'Thu'), tr('Ven', 'Fri'), tr('Sab', 'Sat'), tr('Dom', 'Sun')][b]
  if (kind === 'monthweek') return [t('Giorni 1–7'), t('Giorni 8–14'), t('Giorni 15–21'), t('Giorni 22–28'), t('Giorni 29–31')][b]
  if (kind === 'hour') return `${String(b).padStart(2, '0')}:00`
  return String(b)
}

export function BucketChart({ r, height = '100%' }: { r: BucketResponse; height?: number | string }) {
  const option = useMemo(() => {
    const rows = r.rows
    const cats = rows.map((x) => bucketLabel(r.kind, x.bucket))
    const sFull = t('Media su tutto lo storico'), sRec = t('Media nel periodo recente')
    const d = r.kind === 'hour' ? 3 : 2
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sFull, sRec] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(155,135,245,0.05)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const x = rows[ps[0]?.dataIndex ?? 0]
          if (!x) return ''
          const line = (a: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${a}</span><b>${v}</b></div>`
          return `<div style="color:${C.muted};margin-bottom:4px">${cats[ps[0].dataIndex]} · n = ${x.n.toLocaleString('en-US')}</div>` +
            line(sFull, signed(x.mean, d)) + line(t('In rialzo'), pp(x.up)) + line(t('Scarto dalle altre caselle'), signed(x.diff, d)) + line('p', fmtP(x.p)) + line(t('p BH'), fmtP(x.p_bh)) +
            line(sRec, `${signed(x.recent.mean, d)} · n = ${x.recent.n}`)
        },
      },
      xAxis: { type: 'category', data: cats, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, axisLabel: { ...axisLabel, hideOverlap: true } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%` } }),
      series: [
        { name: sFull, type: 'bar', barMaxWidth: 22, data: rows.map((x) => x.mean),
          itemStyle: { borderRadius: 2, color: (q: { dataIndex: number; value: number }) => { const v = rows[q.dataIndex]?.verdict; const base = q.value >= 0 ? C.up : C.down; return hexA(base, v === 'strong' ? 0.95 : v === 'weak' ? 0.7 : 0.4) } } },
        { name: sRec, type: 'scatter', data: rows.map((x) => x.recent.mean), symbolSize: 7, itemStyle: { color: C.primary } },
      ],
    }
  }, [r])
  return <EChart option={option} height={height} />
}

export function BucketHeat({ r, height = '100%' }: { r: BucketResponse; height?: number | string }) {
  const option = useMemo(() => {
    const cats = r.labels.map((b) => bucketLabel(r.kind, b))
    const years = r.heat.map((h) => String(h.year))
    const data: [number, number, number | null][] = []
    const abs: number[] = []
    r.heat.forEach((h, yi) => h.values.forEach((v, bi) => { data.push([bi, yi, v]); if (fin(v)) abs.push(Math.abs(v)) }))
    abs.sort((x, y) => x - y)
    const mx = abs.length ? abs[Math.floor(abs.length * 0.9)] || abs[abs.length - 1] || 1 : 1   // 90° percentile: pochi estremi non schiacciano i colori
    return {
      grid: { left: 8, right: 12, top: 8, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: { value: [number, number, number | null] }) => `${years[p.value[1]]} · ${cats[p.value[0]]}<br/><b>${signed(p.value[2], r.kind === 'hour' ? 3 : 2)}</b>` },
      xAxis: { type: 'category', data: cats, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...axisLabel, hideOverlap: true }, splitArea: { show: false } },
      yAxis: { type: 'category', data: years, axisLine: { show: false }, axisTick: { show: false }, axisLabel },
      visualMap: { show: false, min: -mx, max: mx, inRange: { color: ['#EF5466', '#5E4558', '#262F48', '#3D6457', '#2EBD85'] } },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: '#0E1424', borderWidth: 1, borderRadius: 2 }, emphasis: { itemStyle: { borderColor: '#E8ECF4' } } }],
    }
  }, [r])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ misc
export function SourceChips({ sources }: { sources: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {sources.map((s) => <span key={s} className="inline-flex h-5 items-center whitespace-nowrap rounded-md bg-white/[0.05] px-1.5 text-2xs text-slate-300 ring-1 ring-inset ring-white/10">{levelSrc(s)}</span>)}
    </span>
  )
}

export function VerdictLine({ v, children }: { v: Verdict | null | undefined; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-400">
      <VerdictBadge v={v ?? 'none'} short />
      {children}
    </div>
  )
}
