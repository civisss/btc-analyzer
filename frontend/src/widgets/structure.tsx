import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Candle } from '../api/types'
import type {
  EventStats, FwdStats, Magnet, MondayRange, MondaySide, Scenario, StructEvent, StructEventKey, StructurePivots, TfStructure, WeeklyClose,
} from '../api/structure'
import EChart from '../components/charts/EChart'
import ProChart, { type LineDef, type OverlayMarkerDef, type PriceLineDef, type ZoneDef } from '../components/charts/ProChart'
import { C, FONT, areaGradient, axisLabel, timeAxis, tooltipBase, usdAxisFmt, valueAxis } from '../components/charts/theme'
import { Legend, clsx } from '../components/ui'
import { date, dayUnit, pct, usd } from '../lib/format'
import { cap, t, tr } from '../i18n'
import type { LiveTf } from '../api/live'
import { T } from '../theme/tokens'

type Num = number | null | undefined
export const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
/** Plain percentage (rates, frequencies): "68.1%" — never coloured. */
export const rt = (v: Num, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const signCls = (v: Num) => (!fin(v) || v === 0 ? 'text-fg-3' : v > 0 ? 'text-up' : 'text-down')
/** Signed % coloured by sign (returns only). */
export function Sgn({ v, d = 1 }: { v: Num; d?: number }) {
  return <span className={clsx('tnum', signCls(v))}>{pct(v, d)}</span>
}
/** Rate with a thin neutral bar (frequencies 0–100%). */
export function RateBar({ v, d = 1 }: { v: Num; d?: number }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {fin(v) && <span className="hidden h-1 w-12 overflow-hidden rounded-full bg-white/[0.06] sm:inline-block"><span className="block h-full rounded-full bg-fg-2/70" style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></span>}
      <span className="tnum">{rt(v, d)}</span>
    </span>
  )
}
/** Neutral signed distance (distance of a level from price is not good/bad). */
export const dist = (v: Num, d = 1) => <span className="tnum text-fg-3">{pct(v, d)}</span>

/** Horizontal-scroll wrapper for tables inside a CardBody (bleeds to the card edges). */
export const TBL_WRAP = 'no-scrollbar -mx-4 overflow-x-auto sm:-mx-5'
/** Inner tile (sub-panels inside cards). */
export const TILE = 'tile'

export function KV({ k, children, title }: { k: ReactNode; children: ReactNode; title?: string }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-t border-line-subtle py-1 text-sm first:border-t-0" title={title}>
      <span className="min-w-0 text-fg-3">{k}</span>
      <span className="tnum whitespace-nowrap text-right font-medium text-white">{children}</span>
    </div>
  )
}

/** Split a backend paragraph into sentences (keeps "$82,563", "1.5%", "(…)" intact). */
export function sentences(text: string | null | undefined): string[] {
  if (!text) return []
  return text.split(/(?<=[.!?])\s+(?=[A-ZÀ-ÝÈÉ«"(\d$])/).map((x) => x.trim()).filter(Boolean)
}

/**
 * Text wall → ≤`max` one-line bullets (max 72ch) + "Mostra tutto" toggle that expands every bullet in full.
 * `items` may carry a tone (dot colour) — green/red only for up/down.
 */
export function MoreList({ items, max = 3, className }: { items: (string | { text: string; tone?: string })[]; max?: number; className?: string }) {
  const [open, setOpen] = useState(false)
  const rows = items.map((x) => (typeof x === 'string' ? { text: x, tone: 'neutral' } : { text: x.text, tone: x.tone ?? 'neutral' })).filter((x) => x.text)
  if (!rows.length) return null
  const shown = open ? rows : rows.slice(0, max)
  const dot = (tone: string) => (tone === 'bullish' ? 'bg-up' : tone === 'bearish' ? 'bg-down' : 'bg-fg-4')
  return (
    <div className={clsx('flex max-w-[72ch] flex-col gap-1', className)}>
      <ul className="flex flex-col gap-1">
        {shown.map((r, i) => (
          <li key={i} className="flex min-w-0 items-baseline gap-2 text-sm leading-relaxed text-fg-2" title={open ? undefined : r.text}>
            <span className={clsx('relative -top-px h-1.5 w-1.5 shrink-0 rounded-full', dot(r.tone))} />
            <span className={clsx('min-w-0', !open && 'truncate')}>{cap(r.text)}</span>
          </li>
        ))}
      </ul>
      {(rows.length > max || rows.some((r) => r.text.length > 70)) && (
        <button type="button" onClick={() => setOpen(!open)} className="w-fit text-xs font-medium text-fg-3 hover:text-white">
          {open ? t('Mostra meno') : t('Mostra tutto')}{!open && rows.length > max ? ` (${rows.length})` : ''}
        </button>
      )}
    </div>
  )
}

const LINE_RANGE = T.fg2
const LINE_MID = T.fg3
const LINE_MACRO = T.fg4
const NO_ZONES: ZoneDef[] = []   // stable reference: ProChart resets zone boxes whenever `zones` changes

/** Price-axis titles (module level: Italian, translated at render). */
const SHORT_LEVEL: Record<string, string> = {
  sweep_low: 'Sweep min', sweep_high: 'Sweep max', swing_low: 'Swing min', swing_high: 'Swing max',
}

// ------------------------------------------------------------------ marker helpers
const ABOVE: StructEventKey[] = ['dev_high', 'failed_break_high', 'sfp_high', 'accept_high', 'close_above', 'retest_hold_low', 'retest_fail_low', 'bos_up', 'choch_up']
/** Numbered event circles anchored just above the candle high / below the candle low (ids `${tf}:${n}`, shared with EventsTable). */
export function eventMarkers(events: StructEvent[], candles: Candle[], tf: string): OverlayMarkerDef[] {
  if (!candles.length) return []
  const t0 = candles[0].time
  const out: OverlayMarkerDef[] = []
  let j = 0
  for (const e of [...events].filter((x) => x.time >= t0).sort((a, b) => a.time - b.time)) {
    while (j + 1 < candles.length && candles[j + 1].time <= e.time) j++
    const c = candles[j]
    const above = ABOVE.includes(e.key)
    out.push({ id: `${tf}:${e.n}`, time: c.time, price: above ? c.high : c.low, position: above ? 'above' : 'below', label: String(e.n), title: e.label, sub: `${date(e.time)} · ${usd(e.price)}` })
  }
  return out
}

/** Hovered event (`${tf}:${n}`), shared between the range chart circles and the events table rows. */
let evHover: string | null = null
const evSubs = new Set<() => void>()
const setEvHover = (id: string | null) => { if (id !== evHover) { evHover = id; evSubs.forEach((f) => f()) } }
const useEvHover = () => useSyncExternalStore((f) => { evSubs.add(f); return () => { evSubs.delete(f) } }, () => evHover)
const seg = (t0: number, t1: number, v: number) => [{ time: t0, value: v }, { time: t1, value: v }]

// ------------------------------------------------------------------ range chart
export function RangeChart({ d, candles, tf, height = "100%" }: { d: TfStructure; candles: Candle[]; tf: "4h" | "1d" | "1w"; height?: number | string }) {
  const last = candles.length ? candles[candles.length - 1].time : 0
  const first = candles.length ? candles[0].time : 0
  const lines = useMemo<LineDef[]>(() => {
    const out: LineDef[] = []
    const r = d.range
    if (r && last) {
      const s = Math.max(r.start, first)
      out.push({ id: 'rh', data: seg(s, last, r.high), color: LINE_RANGE, width: 2 })
      out.push({ id: 'rm', data: seg(s, last, r.mid), color: LINE_MID, width: 1, dashed: true })
      out.push({ id: 'rl', data: seg(s, last, r.low), color: LINE_RANGE, width: 2 })
    }
    const m = d.macro_range
    if (m && last) {
      const s = Math.max(m.start, first)
      out.push({ id: 'mh', data: seg(s, last, m.high), color: LINE_MACRO, width: 1, dashed: true })
      out.push({ id: 'ml', data: seg(s, last, m.low), color: LINE_MACRO, width: 1, dashed: true })
    }
    return out
  }, [d, last, first])
  // short titles: lightweight-charts draws the title next to the axis label, so keep it to a word or two (no text over candles)
  const priceLines = useMemo<PriceLineDef[]>(() => d.key_levels
    .filter((k) => !['range_high', 'range_low', 'range_mid'].includes(k.kind))
    .map((k) => ({ price: k.price, color: LINE_MID, title: SHORT_LEVEL[k.kind] ? t(SHORT_LEVEL[k.kind]) : k.label })), [d])
  const overlay = useMemo(() => eventMarkers(d.events, candles, tf), [d, candles, tf])
  const active = useEvHover()
  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      <div className="min-h-0 flex-1">
        <ProChart candles={candles} liveTf={tf as LiveTf} height="100%" lines={lines} priceLines={priceLines} overlayMarkers={overlay} activeOverlayId={active} onOverlayHover={setEvHover} zones={NO_ZONES} volume={false} tfLabel={tf} fitKey={`st-${tf}`} wheel={false} />
      </div>
      <Legend items={[
        { label: d.range ? `Range ${usd(d.range.low)}–${usd(d.range.high)}` : t('Nessun range'), color: LINE_RANGE },
        ...(d.range ? [{ label: `${t('Metà range')} ${usd(d.range.mid)}`, color: LINE_MID, dashed: true }] : []),
        ...(d.macro_range ? [{ label: `${t('Range ampio')} ${usd(d.macro_range.low)}–${usd(d.macro_range.high)}`, color: LINE_MACRO, dashed: true }] : []),
        { label: t('Eventi numerati: vedi tabella'), color: T.fg3 },
      ]} />
    </div>
  )
}

// ------------------------------------------------------------------ opening-range chart (1h)
/** "Minimo settimana precedente" → "Min sett. prec." style abbreviations for the axis gutter. */
function shortOpen(label: string): string {
  const l = label.toLowerCase()
  const has = (...k: string[]) => k.some((x) => l.includes(x))
  const side = has('massimo', 'high') ? tr('Max', 'High') : has('minimo', 'low') ? tr('Min', 'Low') : has('apertura', 'open') ? tr('Apert.', 'Open') : null
  const per = has('settiman', 'week') ? tr('sett.', 'wk') : has('mese', 'mensil', 'month') ? tr('mese', 'month') : has('trimest', 'quarter') ? tr('trim.', 'qtr')
    : has('annual', 'anno', 'year') ? tr('anno', 'year') : null
  if (!side || !per) return label
  const prev = has('precedente', 'previous', 'prev')
  return tr(`${side} ${per}${prev ? ' prec.' : ''}`, cap(`${prev ? 'prev. ' : ''}${per} ${side.toLowerCase()}`))
}
export function OpeningChart({ p, height = "100%" }: { p: StructurePivots; height?: number | string }) {
  const candles = p.chart.candles
  const last = candles.length ? candles[candles.length - 1].time : 0
  const m = p.monday.current
  const pm = p.chart.prev_monday
  const o = p.opens
  const lines = useMemo<LineDef[]>(() => {
    const out: LineDef[] = []
    if (!last) return out
    if (m) {
      out.push({ id: 'mh', data: seg(m.week_start, last, m.high), color: LINE_RANGE, width: 2 })
      out.push({ id: 'ml', data: seg(m.week_start, last, m.low), color: LINE_RANGE, width: 2 })
    }
    if (pm) {
      const end = Math.min(pm.week_start + 7 * 86400 - 3600, last)
      out.push({ id: 'pmh', data: seg(pm.week_start, end, pm.high), color: LINE_MACRO, width: 1, dashed: true })
      out.push({ id: 'pml', data: seg(pm.week_start, end, pm.low), color: LINE_MACRO, width: 1, dashed: true })
    }
    if (fin(o.weekly.open)) out.push({ id: 'wo', data: seg(o.week_start, last, o.weekly.open), color: C.accent, width: 1, dashed: true })
    return out
  }, [m, pm, o, last])
  const priceLines = useMemo<PriceLineDef[]>(() => o.levels
    .filter((l) => l.key !== 'weekly_open' && l.key !== 'quarterly_open' && Math.abs(l.distance ?? 99) < 8)
    .map((l) => ({ price: l.price, color: LINE_MID, title: shortOpen(l.label) })), [o])
  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      <div className="min-h-0 flex-1">
        <ProChart candles={candles} liveTf="1h" height="100%" lines={lines} priceLines={priceLines} zones={NO_ZONES} volume={false} tfLabel="1h" fitKey="opening" wheel={false} />
      </div>
      <Legend items={[
        ...(m ? [{ label: `${tr('Lunedì', 'Monday')} ${usd(m.low)}–${usd(m.high)}${m.monday_complete ? '' : ` (${tr('in formazione', 'forming')})`}`, color: LINE_RANGE }] : []),
        ...(pm ? [{ label: `${t('Lunedì precedente')} ${usd(pm.low)}–${usd(pm.high)}`, color: LINE_MACRO, dashed: true }] : []),
        ...(fin(o.weekly.open) ? [{ label: `${t('Apertura settimanale')} ${usd(o.weekly.open)}`, color: C.accent, dashed: true }] : []),
        { label: t('Grigio tratteggiato: aperture e massimi/minimi precedenti'), color: LINE_MID, dashed: true },
      ]} />
    </div>
  )
}

// ------------------------------------------------------------------ tables
const fwdCell = (s: FwdStats) => (
  <td className="text-right" title={t('Casi {n} · media {m} · positivi {w}', { n: s.n, m: pct(s.mean, 1), w: rt(s.win_rate) })}><Sgn v={s.median} /></td>
)

export function EventStatsTable({ stats }: { stats: EventStats }) {
  const b = stats.base
  return (
    <div className={TBL_WRAP}>
      <table className="tbl min-w-[980px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{tr('Evento', 'Event')}</th>
            <th>{tr('Atteso', 'Expected')}</th>
            <th className="text-right">{tr('Casi', 'Cases')}</th>
            {[1, 3, 7, 14].map((n) => <th key={n} className="text-right">{n}{dayUnit()}</th>)}
            <th className="text-right" title={t('% dei casi con rendimento a 7 giorni nella direzione attesa')}>{tr('Nella direzione', 'In direction')} 7{dayUnit()}</th>
            <th className="text-right" title={t("Primo obiettivo raggiunto entro 14 giorni prima dell'invalidazione")}>{tr('Obiettivo', 'Target')} 1</th>
            <th className="text-right" title={t("Secondo obiettivo raggiunto entro 14 giorni prima dell'invalidazione")}>{tr('Obiettivo', 'Target')} 2</th>
            <th className="pr-4 text-right sm:pr-5" title={t('Invalidazione raggiunta per prima entro 14 giorni')}>{tr('Invalidazione', 'Invalidation')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pl-4 text-fg-3 sm:pl-5">{t('Tutte le barre (base)')}</td>
            <td className="text-fg-3">—</td>
            <td className="text-right text-fg-3">{b.d1.n.toLocaleString('en-US')}</td>
            {fwdCell(b.d1)}{fwdCell(b.d3)}{fwdCell(b.d7)}{fwdCell(b.d14)}
            <td className="text-right text-fg-3" title={t('Rialzo a 7 giorni')}>{rt(b.d7.win_rate)}</td>
            <td /><td /><td className="pr-4 sm:pr-5" />
          </tr>
          {stats.events.filter((e) => e.n > 0).map((e) => (
            <tr key={e.key} title={e.description}>
              <td className="pl-4 text-fg sm:pl-5">{e.label}</td>
              <td className="text-fg-3">{e.direction === 'up' ? tr('Rialzo', 'Up') : tr('Ribasso', 'Down')}</td>
              <td className={clsx('text-right', e.n < 15 ? 'text-fg-4' : 'text-fg-2')} title={e.n < 15 ? t('Campione ridotto: statistica poco affidabile') : undefined}>{e.n}</td>
              {fwdCell(e.fwd.d1)}{fwdCell(e.fwd.d3)}{fwdCell(e.fwd.d7)}{fwdCell(e.fwd.d14)}
              <td className="text-right">{rt(e.follow_pct)}</td>
              <td className="text-right" title={e.target1}>{rt(e.p_target1)}</td>
              <td className="text-right" title={e.target2}>{rt(e.p_target2)}</td>
              <td className="pr-4 text-right sm:pr-5" title={e.invalidation}>{rt(e.p_invalid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function EventsTable({ events, tf }: { events: StructEvent[]; tf?: string }) {
  const active = useEvHover()
  if (!events.length) return <p className="py-4 text-center text-sm text-fg-3">{t('Nessun evento recente')}</p>
  return (
    <div className={TBL_WRAP}>
      <table className="tbl min-w-[420px]">
        <thead><tr><th className="pl-4 sm:pl-5">#</th><th>{tr('Data', 'Date')}</th><th>{tr('Evento', 'Event')}</th><th className="pr-4 text-right sm:pr-5">{tr('Prezzo', 'Price')}</th></tr></thead>
        <tbody>
          {[...events].reverse().map((e) => (
            <tr key={`${e.n}-${e.key}`} onMouseEnter={tf ? () => setEvHover(`${tf}:${e.n}`) : undefined} onMouseLeave={tf ? () => setEvHover(null) : undefined}
              className={clsx(tf && active === `${tf}:${e.n}` && 'bg-white/[0.03]')}>
              <td className="pl-4 sm:pl-5">
                <span className={clsx('tnum inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-surface font-semibold leading-none text-white transition-colors', String(e.n).length > 1 ? 'text-[10.5px] tracking-[-0.03em]' : 'text-[13px]', tf && active === `${tf}:${e.n}` ? 'border-accent' : 'border-line-strong')}>{e.n}</span>
              </td>
              <td className="text-fg-2">{date(e.time)}</td>
              <td className="text-fg">{e.label}</td>
              <td className="pr-4 text-right sm:pr-5">{usd(e.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const SIDE_ROWS: { k: keyof MondaySide | 'ext' | 'rev'; label: string; title?: string }[] = [
  { k: 'broken_pct', label: 'Settimane con rottura', title: 'Il resto della settimana (mar–dom) supera il livello del lunedì' },
  { k: 'first_pct', label: 'Rotto per primo', title: 'Quota delle settimane in cui questo lato viene rotto per primo' },
  { k: 'back_inside_pct', label: 'Rientro nel range', title: 'Dopo la rottura, una chiusura 1h torna dentro il range del lunedì' },
  { k: 'rev2_pct', label: 'Rientro + inverso ≥2%', title: 'Rientro e movimento ≥2% dal livello rotto nella direzione opposta' },
  { k: 'rev3_pct', label: 'Rientro + inverso ≥3%' },
  { k: 'reach_opposite_pct', label: "Raggiunge l'estremo opposto" },
  { k: 'close_beyond_pct', label: 'Chiude la settimana oltre', title: 'Chiusura settimanale oltre il livello rotto (accettazione)' },
  { k: 'ext', label: 'Estensione mediana (p75)', title: 'Estensione massima oltre il livello rotto' },
  { k: 'rev', label: 'Inverso mediano (p75)', title: 'Movimento dal livello rotto nella direzione opposta' },
  { k: 'hours_to_break_median', label: 'Ore alla rottura (mediana)', title: 'Ore dopo la fine del lunedì' },
]
function sideVal(s: MondaySide, k: string): string {
  if (k === 'ext') return `${rt(s.extension.median)} (${rt(s.extension.p75)})`
  if (k === 'rev') return `${rt(s.reversal.median)} (${rt(s.reversal.p75)})`
  if (k === 'hours_to_break_median') return fin(s.hours_to_break_median) ? `${s.hours_to_break_median.toFixed(0)}h` : '—'
  return rt(s[k as keyof MondaySide] as number | null)
}
export function MondayStatsTable({ m }: { m: MondayRange }) {
  const s = m.stats
  return (
    <div className={TBL_WRAP}>
      <table className="tbl min-w-[420px]">
        <thead><tr><th className="pl-4 sm:pl-5">{t('Dal 2018 · {n} settimane', { n: s.weeks })}</th><th className="text-right">{t('Massimo del lunedì')}</th><th className="pr-4 text-right sm:pr-5">{t('Minimo del lunedì')}</th></tr></thead>
        <tbody>
          {SIDE_ROWS.map((r) => (
            <tr key={r.k} title={r.title ? t(r.title) : undefined}>
              <td className="pl-4 text-fg-2 sm:pl-5">{t(r.label)}</td>
              <td className="text-right">{sideVal(s.high, r.k)}</td>
              <td className="pr-4 text-right sm:pr-5">{sideVal(s.low, r.k)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MondaySplitTable({ m }: { m: MondayRange }) {
  const s = m.stats
  return (
    <div className={TBL_WRAP}>
      <table className="tbl min-w-[560px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{tr('Gruppo', 'Group')}</th><th className="text-right">{tr('Settimane', 'Weeks')}</th>
            <th className="text-right">{t('Rottura max')}</th><th className="text-right">{t('Inverso ≥2%')}</th><th className="text-right">≥3%</th>
            <th className="text-right">{t('Rottura min')}</th><th className="text-right">{t('Inverso ≥2%')}</th><th className="pr-4 text-right sm:pr-5">≥3%</th>
          </tr>
        </thead>
        <tbody>
          {s.by_regime.map((r) => (
            <tr key={r.key}>
              <td className="pl-4 text-fg sm:pl-5">{r.label}</td><td className="text-right text-fg-3">{r.weeks}</td>
              <td className="text-right">{rt(r.high.broken_pct)}</td><td className="text-right">{rt(r.high.rev2_pct)}</td><td className="text-right">{rt(r.high.rev3_pct)}</td>
              <td className="text-right">{rt(r.low.broken_pct)}</td><td className="text-right">{rt(r.low.rev2_pct)}</td><td className="pr-4 text-right sm:pr-5">{rt(r.low.rev3_pct)}</td>
            </tr>
          ))}
          {[...s.by_year].reverse().map((y) => (
            <tr key={y.year}>
              <td className="pl-4 text-fg-2 sm:pl-5">{y.year}</td><td className="text-right text-fg-3">{y.weeks}</td>
              <td className="text-right">{rt(y.high_broken_pct)}</td><td className="text-right">{rt(y.high_rev2_pct)}</td><td className="text-right">{rt(y.high_rev3_pct)}</td>
              <td className="text-right">{rt(y.low_broken_pct)}</td><td className="text-right">{rt(y.low_rev2_pct)}</td><td className="pr-4 text-right sm:pr-5">{rt(y.low_rev3_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MondayHistoryTable({ m, rows = 12 }: { m: MondayRange; rows?: number }) {
  return (
    <div className={TBL_WRAP}>
      <table className="tbl min-w-[640px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{tr('Settimana', 'Week')}</th><th className="text-right">{t('Min lunedì')}</th><th className="text-right">{t('Max lunedì')}</th><th className="text-right">{tr('Ampiezza', 'Width')}</th>
            <th>{t('Rotto prima')}</th><th className="text-right">{tr('Inverso', 'Reversal')}</th><th>{tr('Rientro', 'Back inside')}</th><th className="pr-4 text-right sm:pr-5" title={t('Dalla chiusura del lunedì alla chiusura della settimana')}>{t('Rendimento settimana')}</th>
          </tr>
        </thead>
        <tbody>
          {m.history.slice(0, rows).map((w) => (
            <tr key={w.week_start}>
              <td className="pl-4 text-fg-2 sm:pl-5">{date(w.week_start)}</td>
              <td className="text-right">{usd(w.low)}</td>
              <td className="text-right">{usd(w.high)}</td>
              <td className="text-right text-fg-2">{rt(w.range_pct, 2)}</td>
              <td className="text-fg-2">{w.first_break === 'high' ? tr('Massimo', 'High') : w.first_break === 'low' ? tr('Minimo', 'Low') : tr('Nessuno', 'None')}{w.broke_high && w.broke_low ? ` (${tr('entrambi', 'both')})` : ''}</td>
              <td className="text-right text-fg-2">{rt(w.reversal)}</td>
              <td className="text-fg-2">{w.back_inside == null ? '—' : w.back_inside ? tr('Sì', 'Yes') : 'No'}</td>
              <td className="pr-4 text-right sm:pr-5"><Sgn v={w.week_return} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const lag = (h: Num) => (!fin(h) ? '—' : h >= 48 ? `${(h / 24).toFixed(0)}${dayUnit()}` : `${h.toFixed(0)}h`)
export function MagnetTable({ rows, name }: { rows: { label: string; data: Magnet[] }[]; name?: string }) {
  return (
    <div className={TBL_WRAP}>
      <table className="tbl min-w-[460px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{name ?? tr('Apertura', 'Open')}</th><th className="text-right">{tr('Scostamento', 'Deviation')}</th><th className="text-right" title={t('Periodi in cui lo scostamento è stato raggiunto')}>{tr('Periodi', 'Periods')}</th>
            <th className="text-right" title={t("Il prezzo torna a toccare l'apertura prima della fine del periodo")}>{tr('Rivisitata', 'Revisited')}</th><th className="pr-4 text-right sm:pr-5">{t('Tempo mediano')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((r) => r.data.map((m, i) => (
            <tr key={`${r.label}-${m.threshold}`}>
              <td className="pl-4 text-fg-2 sm:pl-5">{i === 0 ? r.label : ''}</td>
              <td className="text-right text-fg-2">≥{m.threshold}%</td>
              <td className="text-right text-fg-3">{m.n} / {m.periods}</td>
              <td className="text-right"><RateBar v={m.revisit_pct} /></td>
              <td className="pr-4 text-right text-fg-2 sm:pr-5">{lag(m.median_hours)}</td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  )
}

export function WeeklyCloseTable({ w }: { w: WeeklyClose }) {
  return (
    <div className={TBL_WRAP}>
      <table className="tbl min-w-[720px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{t('Chiusura settimanale')}</th><th className="text-right">{tr('Casi', 'Cases')}</th><th className="text-right">{tr('Frequenza', 'Frequency')}</th>
            <th className="text-right">{t('1 sett.')}</th><th className="text-right">{tr('Positive', 'Positive')}</th><th className="text-right">{t('2 sett.')}</th><th className="text-right">{t('4 sett.')}</th><th className="pr-4 text-right sm:pr-5">{t('Positive 4 sett.')}</th>
          </tr>
        </thead>
        <tbody>
          {w.events.map((e) => (
            <tr key={e.key} title={e.description}>
              <td className={clsx('pl-4 sm:pl-5', e.key === 'all' ? 'text-fg-3' : 'text-fg')}>{e.label}</td>
              <td className="text-right text-fg-3">{e.n}</td>
              <td className="text-right text-fg-3">{rt(e.freq_pct)}</td>
              <td className="text-right"><Sgn v={e.w1.median} /></td>
              <td className="text-right">{rt(e.w1.win_rate)}</td>
              <td className="text-right"><Sgn v={e.w2.median} /></td>
              <td className="text-right"><Sgn v={e.w4.median} /></td>
              <td className="pr-4 text-right sm:pr-5">{rt(e.w4.win_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ scenario path sketch
export function PathSketch({ s, history, height = 170 }: { s: Scenario; history: Candle[]; height?: number }) {
  const option = useMemo(() => {
    const PATH = tr('Percorso', 'Path')
    const hist = history.slice(-40).map((c) => [c.time * 1000, c.close])
    const path = s.path.map((p) => [p.time * 1000, p.price])
    const marks: Record<string, unknown>[] = []
    // trigger and invalidation often coincide: one line, one label
    const same = fin(s.trigger.level) && fin(s.invalidation.price) && Math.abs(s.trigger.level / s.invalidation.price - 1) < 0.004
    if (fin(s.trigger.level)) marks.push({ yAxis: s.trigger.level, label: { formatter: same ? 'Trig. · Inv.' : 'Trigger', position: 'end' }, lineStyle: { color: T.fg3, type: 'dashed' } })
    if (fin(s.invalidation.price) && !same) marks.push({ yAxis: s.invalidation.price, label: { formatter: 'Invalid.', position: 'end' }, lineStyle: { color: T.fg4, type: 'dotted' } })
    const ys = [...hist.map((h) => h[1]), ...path.map((p) => p[1]), ...marks.map((m) => m.yAxis as number)]
    const lo = Math.min(...ys), hi = Math.max(...ys)
    const pad = (hi - lo) * 0.08
    return {
      grid: { left: 46, right: 56, top: 10, bottom: 22, containLabel: false },
      tooltip: {
        ...tooltipBase, trigger: 'item',
        formatter: (p: { seriesName: string; value: [number, number]; dataIndex: number }) => {
          const lab = p.seriesName === PATH ? s.path[p.dataIndex]?.label : tr('Chiusura', 'Close')
          return `<div style="color:${C.muted};margin-bottom:2px">${date(p.value[0] / 1000)}</div>${lab}: <b>${usd(p.value[1])}</b>`
        },
      },
      xAxis: timeAxis({ axisLabel: { ...axisLabel, hideOverlap: true, fontSize: 10 } }),
      yAxis: valueAxis({ position: 'left', min: lo - pad, max: hi + pad, axisLabel: { ...axisLabel, fontSize: 10, formatter: usdAxisFmt }, splitNumber: 3 }),
      series: [
        { name: 'BTC', type: 'line', data: hist, showSymbol: false, symbol: 'none', lineStyle: { width: 1.5, color: C.price }, itemStyle: { color: C.price }, emphasis: { disabled: true },
          areaStyle: { color: areaGradient(C.price, 0.2, 0), origin: 'start' },
          markLine: marks.length ? { symbol: 'none', silent: true, label: { color: C.text, fontSize: 10, fontFamily: FONT, distance: 4 }, data: marks } : undefined },
        { name: PATH, type: 'line', data: path, symbol: 'circle', symbolSize: 5, showSymbol: true, lineStyle: { width: 1.5, color: C.primary, type: 'dashed' }, itemStyle: { color: C.primary }, emphasis: { disabled: true } },
      ],
    }
  }, [s, history])
  return <EChart option={option} height={height} />
}
