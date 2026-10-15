import { Fragment, useMemo, useState, type ReactNode } from 'react'
import {
  CalendarClock, CalendarDays, ChevronDown, Clock3, Hourglass, ListOrdered, Orbit, Repeat, Ruler, Sigma, Sun, SunMoon, Timer,
} from 'lucide-react'
import type { CalendarItem, Expected, PivotWindow, SourceType, TimePivots } from '../api/timepivots'
import EChart from '../components/charts/EChart'
import { C, DIVERGING, FONT, axisLabel, dataZoomInside, hexA, legendBase, timeAxis, tooltipBase, usdAxisFmt, valueAxis } from '../components/charts/theme'
import { Card, CardBody, CardHeader, EmptyState, KpiCell, KpiStrip, MethodNote as SharedMethodNote, ProgressBar, Segmented, clsx } from '../components/ui'
import { date, dayUnit, int, ordinal, pct, usd } from '../lib/format'
import { cap, months, monthsLong, t, tfLabel, tr, weekdays } from '../i18n'

// ------------------------------------------------------------------ meta
export const EXP: Record<Expected, { label: string; short: string; color: string }> = {
  rialzo: { label: 'Rialzo', short: 'Rialzo', color: C.up },
  ribasso: { label: 'Ribasso', short: 'Ribasso', color: C.down },
  inversione_rialzista: { label: 'Inversione al rialzo', short: 'Inv. rialzo', color: C.up },
  inversione_ribassista: { label: 'Inversione al ribasso', short: 'Inv. ribasso', color: C.down },
  inversione: { label: 'Possibile inversione', short: 'Inversione', color: '#8B94A7' },
  volatilita: { label: 'Volatilità', short: 'Volatilità', color: '#8B94A7' },
}
const SRC: Record<SourceType, { label: string; color: string }> = {
  stagionale: { label: 'Stagionale', color: '#8B94A7' },
  ciclo: { label: 'Ciclo', color: '#8B94A7' },
  fibonacci: { label: 'Fibonacci', color: '#8B94A7' },
  gambe: { label: 'Gambe uguali', color: '#8B94A7' },
  spaziatura: { label: 'Spaziatura swing', color: '#8B94A7' },
  evento: { label: 'Evento', color: '#8B94A7' },
}
/** Short month names, capitalised (current language) — call at render time. */
const mesi = () => months().map((m) => cap(m))
/** Monday-first short weekday names, capitalised (current language). */
const dow = () => { const w = weekdays(); return [...w.slice(1), w[0]].map((x) => cap(x)) }
const expLabel = (e: Expected) => t((EXP[e] ?? EXP.volatilita).label)
const expShort = (e: Expected) => t((EXP[e] ?? EXP.volatilita).short)
const srcLabel = (s: SourceType) => t(SRC[s]?.label ?? s)
const STATUS: Record<string, string> = { futuro: 'Futuro', 'in corso': 'In corso', passato: 'Passato' }
const statusLabel = (s: string) => (STATUS[s] ? t(STATUS[s]) : cap(s))
const KIND: Record<string, string> = { minimo: 'Minimo', massimo: 'Massimo', low: 'Minimo', high: 'Massimo', bottom: 'Minimo', top: 'Massimo' }
const kindLabel = (k: string) => (KIND[k] ? t(KIND[k]) : cap(k))
const du = () => dayUnit()
/** "Anno 2 · mid-cycle" → "Anno 2 · Mid-cycle": capitalise every " · " segment of a backend label. */
const capSeg = (s: string) => s.split(' · ').map((x) => cap(x)).join(' · ')
/** Neutral ▲/▼ glyph + label for categorical max/min markers. */
function KindTag({ k }: { k: string }) {
  const low = k === 'minimo' || k === 'low' || k === 'bottom'
  return <span className="whitespace-nowrap text-slate-300"><span className="mr-1 text-2xs text-slate-500">{low ? '▼' : '▲'}</span>{kindLabel(k)}</span>
}
/** Replace {name} placeholders of an (already translated) string with React nodes. */
function rich(s: string, vars: Record<string, ReactNode>): ReactNode {
  return s.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part)
    return m && m[1] in vars ? <Fragment key={i}>{vars[m[1]]}</Fragment> : part
  })
}
const DAY_S = 86400

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
const signCls = (v: Num) => (!fin(v) || v === 0 ? 'text-slate-400' : v > 0 ? 'text-up' : 'text-down')
const pctOf = (v: Num, d = 0) => (fin(v) ? `${v.toFixed(d)}%` : '—')

function countdown(start: number, end: number): string {
  const now = Date.now() / 1000
  if (now >= start && now <= end + DAY_S) return t('In corso')
  const today0 = Math.floor(now / DAY_S) * DAY_S
  const d = Math.round((start - today0) / DAY_S)
  if (d <= 0) return t('Passato')
  if (d === 1) return t('Domani')
  return t('Tra {n} giorni', { n: d })
}

function ExpBadge({ e, className }: { e: Expected; className?: string }) {
  const m = EXP[e] ?? EXP.volatilita
  return <span className={clsx('whitespace-nowrap text-xs font-medium', className)} style={{ color: m.color }}>{t(m.label)}</span>
}

function SrcChip({ s }: { s: SourceType }) {
  return <span className="whitespace-nowrap text-xs text-slate-400">{srcLabel(s)}</span>
}

function ConfidenceBadge({ c }: { c: 'alta' | 'media' | 'bassa' }) {
  const label = { alta: 'Affidabilità alta', media: 'Affidabilità media', bassa: 'Affidabilità bassa' }[c] ?? 'Affidabilità media'
  return <span className="whitespace-nowrap text-xs text-slate-400">{t(label)}</span>
}

// ------------------------------------------------------------------ KPI
function Kpi({ icon, label, value, sub, foot, title }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; foot?: ReactNode; title?: string }) {
  return <KpiCell icon={icon} label={label} value={value} delta={sub} foot={foot} title={title} />
}

export function TpKpiRow({ d }: { d: TimePivots }) {
  const k = d.kpi
  const np = k.next_pivot
  const cm = k.current_month
  const cp = k.cycle_position
  return (
    <KpiStrip cols="grid-cols-1 min-[480px]:grid-cols-2 xl:grid-cols-4">
      <Kpi icon={<CalendarClock />} label={t('Prossimo pivot')}
        value={np ? np.label : '—'}
        title={np ? `${expLabel(np.expected)}${fin(np.probability) ? ` · ${t('Prob. storica {p}', { p: pctOf(np.probability) })}` : ''}` : undefined}
        sub={np && <span className="font-medium text-slate-200">{countdown(np.start, np.end)}</span>}
        foot={np && <>{t('Confl. {n}', { n: int(np.confluence) })} · <span style={{ color: (EXP[np.expected] ?? EXP.volatilita).color }}>{expShort(np.expected)}</span></>} />
      <Kpi icon={<CalendarDays />} label={t('{m}, storico', { m: cm.label })}
        value={<span className={signCls(cm.avg)}>{pct(cm.avg, 1)}</span>}
        title={`${t('Mediana')} ${pct(cm.median, 1)}`}
        sub={<>{t('Positivo {p} ({n} anni)', { p: pctOf(cm.win_rate), n: cm.n })}</>}
        foot={<>{t('Da inizio mese')} <span className={signCls(cm.mtd)}>{pct(cm.mtd, 1)}</span></>} />
      <Kpi icon={<Orbit />} label={t('Anno di ciclo')}
        value={<>{t('Anno {n}', { n: cp.idx })} <span className="text-sm font-normal !text-slate-400">{cap(cp.short.split('· ')[1] ?? '')}</span></>}
        title={`${t('Mediana annua di questo anno-ciclo')} ${pct(cp.annual_avg, 0)}`}
        sub={<>{t("{n} giorni dall'halving", { n: int(cp.days_since_halving) })}</>}
        foot={<>{mesi()[cp.month - 1]} <span className={signCls(cp.avg)}>{pct(cp.avg, 1)}</span> {t('in media')}</>} />
      <Kpi icon={<Clock3 />} label={t('Giorno/ora migliori')}
        value={<>{k.best_day?.name ?? '—'} · {k.best_hour ? `${String(k.best_hour.hour).padStart(2, '0')}:00` : '—'}</>}
        title={`${t('Più debole')}: ${k.worst_day?.name ?? '—'} (${pct(k.worst_day?.avg, 2)}) · ${k.worst_hour ? `${String(k.worst_hour.hour).padStart(2, '0')}:00 UTC` : '—'} (${pct(k.worst_hour?.avg, 3)})`}
        sub={<>{t('Giorno')} <span className={signCls(k.best_day?.avg)}>{pct(k.best_day?.avg, 2)}</span></>}
        foot={<>{t('Ora UTC')} <span className={signCls(k.best_hour?.avg)}>{pct(k.best_hour?.avg, 3)}</span></>} />
    </KpiStrip>
  )
}

// ------------------------------------------------------------------ Oggi / settimana
/** Compact list of the next pivots (date order) — sits under "Oggi" so the right column carries content, not space. */
export function NextPivotsCard({ d, onSelect, n = 8 }: { d: TimePivots; onSelect?: (id: string) => void; n?: number }) {
  const now = Date.now() / 1000
  const next = d.calendar.filter((c) => c.end + DAY_S >= now).slice(0, n)
  return (
    <Card>
      <CardHeader title={t('Prossimi pivot')} icon={<ListOrdered />} subtitle={t('In ordine di data')} />
      <CardBody className="px-2 pb-2">
        {next.length === 0 ? <EmptyState compact text={t('Nessun pivot in arrivo')} /> : (
          <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>{t('Finestra')}</th><th>{t('Atteso')}</th><th className="text-right">{t('Confluenza')}</th></tr></thead>
            <tbody>
              {next.map((c) => (
                <tr key={c.id} className={onSelect ? 'cursor-pointer' : undefined} onClick={() => onSelect?.(c.id)}>
                  {/* narrow side card: long windows and expectations wrap so the confluence column stays in view */}
                  <td className="!whitespace-normal text-white">{c.label}<div className="text-xs text-slate-400">{countdown(c.start, c.end)}</div></td>
                  <td className="!whitespace-normal"><ExpBadge e={c.expected} className="!whitespace-normal" /></td>
                  <td className="text-right"><span className="tnum text-white">{int(c.confluence)}</span><span className="text-xs text-slate-400">/100</span>{fin(c.probability) && <div className="text-2xs text-slate-400">{t('Prob. storica {p}', { p: pctOf(c.probability) })}</div>}</td>
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

export function TodayCard({ d }: { d: TimePivots }) {
  return (
    <Card>
      <CardHeader title={t('Oggi')} icon={<Sun />} subtitle={date(d.today_info.date)} />
      <CardBody>
        <ul className="flex flex-col text-sm text-slate-300">
          {d.today_info.lines.map((l, i) => <li key={i} className="border-t border-line py-1.5 first:border-t-0">{l}</li>)}
        </ul>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ Timeline 90 giorni
type P = { value: unknown; data: unknown; seriesName?: string; color?: string; dataIndex: number }

function tooltipFor(c: CalendarItem) {
  const m = EXP[c.expected]
  const src = c.sources.slice(0, 5).map((s) => `<div style="display:flex;gap:6px;align-items:flex-start;margin-top:3px;max-width:340px;white-space:normal"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${SRC[s.type].color};margin-top:5px;flex-shrink:0"></span><span style="color:#B3BCD0">${cap(s.title)}</span></div>`).join('')
  return `<div style="font-weight:600;color:#fff">${c.label} · ${countdown(c.start, c.end)}</div>
    <div style="margin-top:2px"><span style="color:${m.color};font-weight:600">${t(m.label)}</span>${fin(c.probability) ? ` · ${t('prob.')} ${c.probability.toFixed(0)}%` : ''} · ${t('confluenza')} <b>${int(c.confluence)}</b>/100</div>${src}`
}

const dirColor = (e: Expected) => (e === 'rialzo' || e === 'inversione_rialzista' ? C.up : e === 'ribasso' || e === 'inversione_ribassista' ? C.down : '#8B94A7')

/** Single-row event strip: one dot per pivot, colour = expected direction, opacity = confluence. Details in the tooltip. */
export function PivotTimeline({ d, onSelect }: { d: TimePivots; onSelect?: (id: string) => void }) {
  const option = useMemo(() => {
    const t0 = d.today * 1000
    const t1 = (d.today + d.horizon * DAY_S) * 1000
    return {
      grid: { left: 8, right: 16, top: 20, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: P) => {
        const c = d.calendar.find((x) => x.id === (p.data as { id: string })?.id)
        return c ? tooltipFor(c) : ''
      } },
      xAxis: timeAxis({ min: t0 - 2 * DAY_S * 1000, max: t1 + DAY_S * 1000 }),
      yAxis: { type: 'value', min: -1, max: 1, show: false },
      series: [{
        name: 'pivot', type: 'scatter', symbolSize: 12, z: 5,
        data: d.calendar.map((c) => ({
          value: [c.time * 1000, 0], id: c.id,
          itemStyle: { color: dirColor(c.expected), opacity: 0.25 + 0.75 * Math.min(1, (c.confluence ?? 0) / 100) },
        })),
        markLine: { symbol: 'none', silent: true, lineStyle: { color: 'rgba(148,163,184,0.5)', type: 'dashed', width: 1 }, label: { color: C.text, formatter: t('Oggi'), fontSize: 11 }, data: [{ xAxis: Date.now() }] },
      }, {
        name: '_axis', type: 'line', data: [[t0, 0], [t1, 0]], symbol: 'none', silent: true, lineStyle: { color: 'rgba(255,255,255,0.08)', width: 1 }, z: 1,
      }],
    }
  }, [d])
  const onEvents = useMemo(() => ({
    click: (p: unknown) => {
      const id = ((p as P).data as { id?: string } | undefined)?.id
      if (id && onSelect) onSelect(id)
    },
  }), [onSelect])
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-up" />{tr('Rialzo', 'Up move')}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-down" />{tr('Ribasso', 'Down move')}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-400" />{t('Inversione o volatilità')}</span>
        <span>{t('Opacità = confluenza')}</span>
      </div>
      <div className="h-[108px]"><EChart option={option} height="100%" onEvents={onEvents} /></div>
    </div>
  )
}

// ------------------------------------------------------------------ Prezzo + bande future
export function PivotPriceChart({ d }: { d: TimePivots }) {
  const option = useMemo(() => {
    const cs = d.chart.candles
    const end = (d.today + d.horizon * DAY_S) * 1000
    // label only the strongest windows, at least ~1/16 of the visible span apart so "Confl. 74" labels never collide
    const span = cs.length ? end / 1000 - cs[0].time : (d.horizon + 180) * DAY_S
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920
    const narrow = vw < 640
    // ~80 px per label on the plot (≈ 2/3 of the content width beside the sidebar on desktop)
    const plotPx = narrow ? vw - 64 : (vw - 330) * 0.66
    const gap = span / Math.max(3, Math.floor(plotPx / 80))
    const top: string[] = []
    const picked: number[] = []
    for (const c of [...d.calendar].sort((a, b) => (b.confluence ?? 0) - (a.confluence ?? 0))) {
      if (top.length >= (narrow ? 1 : 6)) break
      if (picked.some((x) => Math.abs(x - c.time) < gap)) continue
      top.push(c.id); picked.push(c.time)
    }
    return {
      grid: { left: 8, right: 8, top: 20, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'cross' }, formatter: (ps: P[]) => {
        const p = ps.find((x) => x.seriesName === 'BTC')
        if (!p) return ''
        const v = p.value as [number, number, number, number, number]
        const ts = v[0] / 1000
        const cal = d.calendar.filter((c) => ts >= c.start && ts <= c.end + DAY_S)
        return `<div style="color:#8B94A7;margin-bottom:4px">${date(ts)}</div>
          <div>${t('Apertura')} <b>${usd(v[1])}</b> · ${t('Chiusura')} <b>${usd(v[2])}</b></div><div>${tr('Min', 'Low')} <b>${usd(v[3])}</b> · ${tr('Max', 'High')} <b>${usd(v[4])}</b></div>` +
          cal.map((c) => `<div style="margin-top:4px">Pivot ${c.label} · <span style="color:${EXP[c.expected].color}">${expLabel(c.expected)}</span></div>`).join('')
      } },
      dataZoom: [dataZoomInside],
      xAxis: timeAxis({ max: end, splitLine: { show: false } }),
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
      series: [
        {
          name: 'BTC', type: 'candlestick',
          data: cs.map((c) => [c.time * 1000, c.open, c.close, c.low, c.high]),
          itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down },
          barMaxWidth: 8,
          markArea: { silent: true, data: d.calendar.map((c) => [
            { xAxis: c.start * 1000, itemStyle: { color: `rgba(148,163,184,${(0.03 + (c.confluence ?? 0) / 1100).toFixed(3)})` },
              label: { show: top.includes(c.id), position: 'insideTop', color: C.text, fontSize: 11, fontFamily: FONT, formatter: t('Confl. {n}', { n: int(c.confluence) }) } },
            { xAxis: (c.end + DAY_S) * 1000 },
          ]) },
          markLine: { symbol: 'none', silent: true, data: [
            { xAxis: Date.now(), lineStyle: { color: 'rgba(148,163,184,0.5)', type: 'dashed', width: 1 }, label: { color: C.text, formatter: t('Oggi'), fontSize: 11 } },
            { yAxis: d.price, lineStyle: { color: 'rgba(148,163,184,0.45)', type: 'dotted' }, label: { color: C.text, formatter: usd(d.price), fontSize: 11, position: 'insideEndTop' } },
          ] },
        },
      ],
    }
  }, [d])
  return <EChart option={option} height="100%" />
}

// ------------------------------------------------------------------ Percorso medio
function AvgPathChart({ w, height = 220 }: { w: PivotWindow; height?: number }) {
  const option = useMemo(() => {
    const p = w.path
    if (!p) return {}
    const lo = p.p25.map((v) => v ?? null)
    const band = p.p75.map((v, i) => (fin(v) && fin(lo[i]) ? v - (lo[i] as number) : null))
    const col = EXP[w.expected].color
    return {
      grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: P[]) => {
        const i = ps[0]?.dataIndex ?? 0
        return `<div style="color:#8B94A7">${t('Giorno')} ${p.days[i] > 0 ? '+' : ''}${p.days[i]}</div><div>${t('Media')} <b>${pct(p.mean[i], 1)}</b> · ${t('Mediana')} <b>${pct(p.median[i], 1)}</b></div><div style="color:#8B94A7">${t('25°–75° pct')}: ${pct(p.p25[i], 1)} / ${pct(p.p75[i], 1)}</div>`
      } },
      xAxis: { type: 'category', data: p.days.map((x) => (x > 0 ? `+${x}` : String(x))), boundaryGap: false, axisLabel: { ...axisLabel, interval: 6 }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series: [
        { name: '_lo', type: 'line', data: lo, stack: 'b', stackStrategy: 'all', symbol: 'none', lineStyle: { width: 0 }, silent: true },
        { name: `${ordinal(25)}–${ordinal(75)}`, type: 'line', data: band, stack: 'b', stackStrategy: 'all', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: hexA(col, 0.14) }, silent: true },
        { name: t('Mediana'), type: 'line', data: p.median, symbol: 'none', lineStyle: { width: 1.4, color: hexA(col, 0.7), type: 'dashed' } },
        { name: t('Media'), type: 'line', data: p.mean, symbol: 'none', lineStyle: { width: 2.2, color: col },
          markLine: { symbol: 'none', silent: true, lineStyle: { color: 'rgba(148,163,184,0.4)', type: 'dashed' }, label: { show: false }, data: [{ xAxis: '0' }, { yAxis: 0 }] } },
      ],
    }
  }, [w])
  if (!w.path) return <EmptyState compact text={t('Storico insufficiente per il percorso medio')} />
  return <EChart option={option} height={height} />
}

export function WindowDetail({ w }: { w: PivotWindow }) {
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>{t('Coerenza')} <b className="text-white">{pctOf(w.consistency)}</b> {t('vs base')} {pctOf(w.base_rate)}</span>
          <span>· Wilson LB {pctOf(w.wilson_lb)}</span>
          <span>· p = {fin(w.p_value) ? w.p_value.toFixed(3) : '—'}</span>
          <span>· {t('Recenti {a} / vecchi {b}', { a: pctOf(w.recent_consistency), b: pctOf(w.older_consistency) })}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>{t('Anno')}</th><th className="text-right">{t('Prima')} ({w.K}{du()})</th><th className="text-right">{t('Dopo')} ({w.K}{du()})</th><th>{t('Comportamento')}</th><th>Swing ±{w.N}{du()}</th></tr></thead>
            <tbody>
              {[...w.years].reverse().map((y) => (
                <tr key={y.year}>
                  <td className={y.match ? 'text-white' : 'text-slate-400'}>{y.match && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-slate-300 align-middle" />}{y.year}</td>
                  <td className={clsx('text-right', signCls(y.pre))}>{pct(y.pre, 1)}</td>
                  <td className={clsx('text-right font-medium', signCls(y.post))}>{pct(y.post, 1)}</td>
                  <td className="text-slate-300">{cap(t(y.type))}</td>
                  <td className="text-xs text-slate-400">{y.pivot ? <span title={t('Swing {l}', { l: t(y.pivot.level) })}><KindTag k={y.pivot.kind} />{y.pivot.level === 'forte' ? ' ★' : ''} · {date(y.pivot.time, false)}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="lg:col-span-2">
        <div className="mb-2 text-xs text-slate-400">{t('Percorso medio normalizzato (−14…+14 giorni, {n} anni)', { n: w.path?.n ?? 0 })}</div>
        <AvgPathChart w={w} />
        {w.pivot_text && <p className="mt-2 text-xs text-slate-400">{w.pivot_text}</p>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Calendario dei pivot
export function PivotCalendarList({ d, open, setOpen }: { d: TimePivots; open: string | null; setOpen: (id: string | null) => void }) {
  const winById = useMemo(() => new Map([...d.windows.upcoming, ...d.windows.active].map((w) => [w.id, w])), [d])
  const [all, setAll] = useState(false)
  if (!d.calendar.length) return <EmptyState text={t('Nessun pivot nel periodo')} />
  const rows = all || d.calendar.length <= 10 ? d.calendar : d.calendar.slice(0, 10)
  // md: window · direction · sources/title · confluence · chevron
  // 2xl: + a separate historical-probability column (the summary lives in the expanded detail / row tooltip)
  const COLS = 'md:grid-cols-[170px_150px_minmax(0,1fr)_200px_24px] xl:grid-cols-[200px_180px_minmax(0,1fr)_260px_24px] 2xl:grid-cols-[minmax(190px,0.8fr)_minmax(170px,0.7fr)_minmax(0,2.4fr)_minmax(200px,1fr)_minmax(150px,0.6fr)_24px]'
  return (
    <div className="flex flex-col divide-y divide-line">
      <div className={clsx('hidden items-end gap-x-6 px-2 pb-2 md:grid', COLS)}>
        <div className="label mb-0">{t('Finestra')}</div>
        <div className="label mb-0">{t('Atteso')}</div>
        <div className="label mb-0">{t('Fonti')}</div>
        <div className="label mb-0">{t('Confluenza')}</div>
        <div className="label mb-0 hidden text-right 2xl:block">{t('Prob. storica')}</div>
        <span />
      </div>
      {rows.map((c) => {
        const isOpen = open === c.id
        const wins = c.sources.filter((s) => s.ref && winById.has(s.ref)).map((s) => winById.get(s.ref as string) as PivotWindow)
        const chips = (
          <div className="flex flex-wrap gap-1">
            {c.source_types.map((st) => <span key={st} className="whitespace-nowrap rounded-md border border-line px-1.5 py-px text-2xs text-slate-300">{srcLabel(st)}</span>)}
          </div>
        )
        return (
          <div key={c.id} id={`pv-${c.id}`}>
            <button onClick={() => setOpen(isOpen ? null : c.id)} title={c.summary} className={clsx('grid w-full grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 px-2 py-3 text-left transition-colors hover:bg-white/[0.02]', COLS)}>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-white">{c.label}</div>
                <div className="text-xs text-slate-400">{countdown(c.start, c.end)}</div>
              </div>
              <div className="hidden md:block"><ExpBadge e={c.expected} /><div className="mt-0.5 text-2xs text-slate-500">{t('{n} fonti', { n: c.sources.length })}</div></div>
              <div className="col-span-2 hidden min-w-0 md:col-span-1 md:block">
                {chips}
                <div className="mt-1 truncate text-xs text-slate-300">{cap(c.title)}</div>
                <div className="mt-0.5 hidden truncate text-2xs text-slate-500 lg:block">{[...new Set(c.sources.map((x) => cap(x.title)))].filter((x) => x !== cap(c.title)).join(' · ')}</div>
              </div>
              <div className="flex items-center gap-2 md:block">
                <div className="flex items-center justify-between gap-2 text-xs"><span className="text-slate-400 md:hidden">{t('Confluenza')}</span><span className="tnum text-sm font-semibold text-white">{int(c.confluence)}<span className="text-2xs font-normal text-slate-500">/100</span></span></div>
                <ProgressBar value={c.confluence ?? 0} color="#5B8DEF" className="mt-1 hidden h-1 md:block" />
                {fin(c.probability) && <div className="mt-0.5 hidden text-2xs text-slate-400 md:block 2xl:hidden">{t('Prob. storica {p}', { p: pctOf(c.probability) })}</div>}
              </div>
              <div className="hidden text-right 2xl:block">
                {fin(c.probability) ? (
                  <>
                    <div className={clsx('tnum text-sm font-semibold', c.probability >= 60 ? 'text-white' : 'text-slate-300')}>{pctOf(c.probability)}</div>
                    <ProgressBar value={c.probability} color={dirColor(c.expected)} className="ml-auto mt-1 h-1 w-20" />
                  </>
                ) : <span className="text-slate-500">—</span>}
              </div>
              <ChevronDown size={16} className={clsx('hidden text-slate-400 transition-transform md:block', isOpen && 'rotate-180')} />
              <div className="col-span-2 flex flex-col gap-1.5 md:hidden">
                <div className="flex flex-wrap items-center gap-x-2"><ExpBadge e={c.expected} />{fin(c.probability) && <span className="text-2xs text-slate-400">{t('Prob. storica {p}', { p: pctOf(c.probability) })}</span>}</div>
                {chips}
                <div className="truncate text-xs text-slate-300">{cap(c.title)}</div>
              </div>
            </button>
            {isOpen && (
              <div className="flex flex-col gap-4 px-2 pb-5">
                <p className="text-sm text-slate-300">{c.summary}</p>
                <div className="grid gap-2 md:grid-cols-2">
                  {c.sources.map((s, i) => (
                    <div key={i} className="border-t border-line pt-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <SrcChip s={s.type} />
                        <span className="flex items-center gap-2 text-xs text-slate-400"><span style={{ color: EXP[s.expected].color }}>{expShort(s.expected)}</span>· {t('Peso {n}', { n: int(s.strength) })}</span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-300">{s.text}</p>
                    </div>
                  ))}
                </div>
                {wins.map((w) => (
                  <div key={w.id} className="border-t border-line pt-3">
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-white">{t('Storico per anno · finestra {w}', { w: w.label })} <ConfidenceBadge c={w.confidence} /></div>
                    <WindowDetail w={w} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {d.calendar.length > 10 && <button className="link self-start pt-2" onClick={() => setAll(!all)}>{all ? t('Mostra meno') : t('Mostra tutti ({n})', { n: d.calendar.length })}</button>}
    </div>
  )
}

// ------------------------------------------------------------------ Finestre ricorrenti
/** Year-by-year outcome strip (wide screens only): one cell per year, coloured by the move after the window, faded when it did not match. */
function YearDots({ w }: { w: PivotWindow }) {
  const ys = w.years
  if (!ys.length) return <div className="hidden 2xl:block" />
  return (
    <div className="hidden min-w-0 2xl:block">
      <div className="flex gap-[3px]">
        {ys.map((y) => (
          <span key={y.year} title={t('{y}: dopo {v} · {m}', { y: y.year, v: pct(y.post, 1), m: y.match ? t('in linea') : t('non in linea') })}
            className="h-3.5 min-w-0 flex-1 rounded-[2px]"
            style={{ background: !fin(y.post) ? '#2A3140' : y.post >= 0 ? C.up : C.down, opacity: y.match ? 0.9 : 0.28 }} />
        ))}
      </div>
    </div>
  )
}

function WindowRows({ list, showDate }: { list: PivotWindow[]; showDate: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!list.length) return <EmptyState text={t('Nessuna finestra significativa')} />
  const yrs = list.flatMap((w) => w.years.map((y) => y.year))
  const COLS = 'md:grid-cols-[170px_minmax(0,1fr)_200px_24px] 2xl:grid-cols-[180px_minmax(0,1.25fr)_200px_minmax(0,1fr)_24px]'
  return (
    <div className="flex flex-col divide-y divide-white/[0.05]">
      <div className={clsx('hidden items-end gap-x-6 px-2 pb-2 md:grid', COLS)}>
        <div className="label mb-0">{t('Finestra')}</div>
        <div className="label mb-0">{t('Atteso')}</div>
        <div className="label mb-0">{t('Coerenza')}</div>
        <div className="hidden min-w-0 2xl:block">
          <div className="label mb-0">{t('Esito anno per anno')}{yrs.length ? ` · ${Math.min(...yrs)}–${Math.max(...yrs)}` : ''}</div>
          <div className="truncate text-2xs text-slate-500">{t("Pieno = in linea con l'esito atteso")}</div>
        </div>
        <span />
      </div>
      {list.map((w) => {
        const isOpen = open === w.id
        return (
          <div key={w.id}>
            <button onClick={() => setOpen(isOpen ? null : w.id)} className={clsx('grid w-full grid-cols-[1fr_auto] items-center gap-3 gap-x-6 px-2 py-3 text-left hover:bg-white/[0.02]', COLS)}>
              <div className="min-w-0">
                <div className="truncate text-sm text-white">{w.label}</div>
                <div className="text-xs text-slate-400">{showDate && w.start != null && w.end != null ? countdown(w.start, w.end) : `K = ${w.K}${du()} · ±${w.N}${du()}`}</div>
              </div>
              <div className="col-span-2 order-last min-w-0 md:order-none md:col-span-1">
                <div className="flex flex-wrap items-center gap-2"><ExpBadge e={w.expected} /><ConfidenceBadge c={w.confidence} /></div>
                <p className="mt-1 text-xs leading-5 text-slate-300">{w.text}</p>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2 text-xs"><span className="text-slate-400">{t('{h}/{n} anni', { h: w.hits, n: w.n })}</span><span className="tnum font-bold text-white">{pctOf(w.consistency)}</span></div>
                <ProgressBar value={w.consistency ?? 0} color="#5B8DEF" className="mt-1 h-1" />
                <div className="mt-0.5 text-2xs text-slate-400">{t('Base')} {pctOf(w.base_rate)} · p {fin(w.p_value) ? w.p_value.toFixed(3) : '—'}</div>
              </div>
              <YearDots w={w} />
              <ChevronDown size={16} className={clsx('hidden text-slate-400 transition-transform md:block', isOpen && 'rotate-180')} />
            </button>
            {isOpen && <div className="px-2 pb-5"><WindowDetail w={w} /></div>}
          </div>
        )
      })}
    </div>
  )
}

function YearMap({ d }: { d: TimePivots }) {
  const option = useMemo(() => {
    const data = d.windows.strip.map(([m, day, e, rate, score]) => {
      const dir = e === 'rialzo' || e === 'inversione_rialzista' ? 1 : e === 'ribasso' || e === 'inversione_ribassista' ? -1 : 0
      return { value: [day - 1, m - 1, dir * Math.min(3, score ?? 0)], e, rate }
    })
    const now = new Date(d.today * 1000)
    const MESI = mesi()
    return {
      grid: { left: 8, right: 8, top: 8, bottom: 30, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: P) => {
        const x = p.data as { value: [number, number, number]; e: Expected; rate: number }
        return `<b>${x.value[0] + 1} ${MESI[x.value[1]]}</b><div style="color:${EXP[x.e].color}">${expLabel(x.e)}</div><div>${t('Coerenza {r}% · forza {f}', { r: x.rate, f: Math.abs(x.value[2]).toFixed(2) })}</div>`
      } },
      xAxis: { type: 'category', data: Array.from({ length: 31 }, (_, i) => String(i + 1)), axisLabel: { ...axisLabel, interval: 1 }, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false } },
      yAxis: { type: 'category', data: MESI, inverse: true, axisLabel, axisLine: { show: false }, axisTick: { show: false } },
      visualMap: { show: true, min: -3, max: 3, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 140, itemWidth: 10,
        text: [t('Rialzista'), t('Ribassista')], textStyle: { color: C.muted, fontSize: 11, fontFamily: FONT },
        inRange: { color: DIVERGING } },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: '#10151F', borderWidth: 1.5, borderRadius: 2 },
        markPoint: { symbol: 'rect', symbolSize: [14, 14], silent: true, itemStyle: { color: 'transparent', borderColor: '#E6E9EF', borderWidth: 1.5 }, label: { show: false },
          data: [{ coord: [String(now.getUTCDate()), MESI[now.getUTCMonth()]] }] } }],
    }
  }, [d])
  return <EChart option={option} height={420} />
}

export function WindowsCard({ d, updatedAt }: { d: TimePivots; updatedAt?: number }) {
  const [tab, setTab] = useState<'upcoming' | 'top' | 'map'>('upcoming')
  return (
    <Card>
      <CardHeader title={t('Date pivot ricorrenti')} icon={<Repeat />} updatedAt={updatedAt} subtitle={t("Finestre dell'anno in cui BTC ha reagito sempre allo stesso modo (test binomiale vs tasso base)")}
        right={<Segmented value={tab} onChange={setTab} options={[{ value: 'upcoming', label: t('Prossimi {n}{u}', { n: d.horizon, u: du() }) }, { value: 'top', label: t("Tutto l'anno") }, { value: 'map', label: t('Mappa annuale') }]} />} />
      <CardBody>
        {tab === 'upcoming' && <WindowRows list={d.windows.upcoming} showDate />}
        {tab === 'top' && <WindowRows list={d.windows.top} showDate={false} />}
        {tab === 'map' && <YearMap d={d} />}
        <SharedMethodNote className="mt-4"><p>{d.windows.method}</p></SharedMethodNote>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ Stagionalità
const divergingRange = [C.down, hexA(C.down, 0.45), '#2A3140', hexA(C.up, 0.45), C.up]

export function SeasonHeatmap({ d }: { d: TimePivots }) {
  const [mode, setMode] = useState<'m' | 'q'>('m')
  const s = d.seasonality
  const option = useMemo(() => {
    const isM = mode === 'm'
    const years = isM ? s.monthly.years : s.quarterly.years
    const mat = isM ? s.monthly.matrix : s.quarterly.matrix
    const cols = isM ? mesi() : ['Q1', 'Q2', 'Q3', 'Q4']
    const cur = isM ? [s.monthly.current.month - 1, s.monthly.current.year] : [s.quarterly.current.quarter - 1, s.quarterly.current.year]
    const data: unknown[] = []
    years.forEach((y, yi) => mat[yi].forEach((v, ci) => {
      if (v == null) return
      const isCur = ci === cur[0] && y === cur[1]
      data.push({ value: [ci, yi, v], itemStyle: isCur ? { borderColor: C.btc, borderWidth: 2 } : undefined })
    }))
    const stats = isM ? s.monthly.stats : s.quarterly.stats
    const extra = [t('Media'), t('Mediana'), t('% positivi')]
    const statRows = extra.map((_, ri) => stats.map((st, ci) => [ci, years.length + ri, ri === 0 ? st.avg : ri === 1 ? st.median : st.win_rate]))
    const lim = isM ? 60 : 120
    return {
      grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: P) => {
        const v = (p.data as { value: [number, number, number] }).value ?? (p.value as [number, number, number])
        const row = v[1] < years.length ? String(years[v[1]]) : extra[v[1] - years.length]
        const unit = v[1] === years.length + 2 ? '%' : ''
        return `<b>${cols[v[0]]} ${row}</b><div>${v[1] === years.length + 2 ? `${v[2]?.toFixed(0)}${unit}` : pct(v[2], 1)}</div>`
      } },
      xAxis: { type: 'category', data: cols, position: 'top', axisLabel, axisLine: { show: false }, axisTick: { show: false } },
      yAxis: { type: 'category', data: [...years.map(String), ...extra], inverse: true, axisLabel: { ...axisLabel, formatter: (v: string) => v }, axisLine: { show: false }, axisTick: { show: false } },
      visualMap: [
        { show: false, seriesIndex: 0, min: -lim, max: lim, inRange: { color: divergingRange } },
        { show: false, seriesIndex: 1, min: -lim / 3, max: lim / 3, inRange: { color: divergingRange } },
        { show: false, seriesIndex: 2, min: 20, max: 80, inRange: { color: divergingRange } },
      ],
      series: [
        { type: 'heatmap', data, label: { show: true, color: '#E6E9EF', fontSize: 11, fontFamily: FONT, formatter: (p: P) => {
          const v = (p.data as { value: [number, number, number] }).value[2]
          return `${v > 0 ? '+' : ''}${v.toFixed(isM ? 0 : 0)}`
        } }, itemStyle: { borderColor: '#10151F', borderWidth: 2, borderRadius: 3 } },
        { type: 'heatmap', data: [...statRows[0], ...statRows[1]], label: { show: true, color: '#fff', fontWeight: 600, fontSize: 11, fontFamily: FONT, formatter: (p: P) => {
          const v = (p.value as [number, number, number])[2]
          return v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`
        } }, itemStyle: { borderColor: '#10151F', borderWidth: 2, borderRadius: 3 } },
        { type: 'heatmap', data: statRows[2], label: { show: true, color: '#fff', fontWeight: 600, fontSize: 11, fontFamily: FONT, formatter: (p: P) => {
          const v = (p.value as [number, number, number])[2]
          return v == null ? '' : `${v.toFixed(0)}%`
        } }, itemStyle: { borderColor: '#10151F', borderWidth: 2, borderRadius: 3 } },
      ],
    }
  }, [s, mode])
  const rows = (mode === 'm' ? s.monthly.years.length : s.quarterly.years.length) + 3
  return (
    <Card className="h-full">
      <CardHeader title={t('Rendimenti per anno')} icon={<CalendarDays />} subtitle={t('Variazione % chiusura su chiusura · bordo arancione = periodo in corso (parziale)')}
        right={<Segmented value={mode} onChange={setMode} options={[{ value: 'm', label: t('Mesi') }, { value: 'q', label: t('Trimestri') }]} />} />
      <CardBody className="overflow-x-auto">
        <div className="min-w-[520px]"><EChart option={option} height={rows * 24 + 30} /></div>
      </CardBody>
    </Card>
  )
}

function barsWithWin(cats: string[], avg: Num[], win: Num[], opts: { highlight?: number; avgDigits?: number; extraLine?: { name: string; data: Num[]; color: string } } = {}) {
  return {
    grid: { left: 8, right: 8, top: 36, bottom: 8, containLabel: true },
    legend: { ...legendBase, data: [t('Rendimento medio'), t('% positivi')] },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: P[]) => {
      const i = ps[0]?.dataIndex ?? 0
      return `<b>${cats[i]}</b><div>${t('Media')} <b>${pct(avg[i], opts.avgDigits ?? 2)}</b></div><div>${t('Positivi')} <b>${pctOf(win[i])}</b></div>` +
        (opts.extraLine ? `<div>${t(opts.extraLine.name)} <b>${fin(opts.extraLine.data[i]) ? (opts.extraLine.data[i] as number).toFixed(2) + '%' : '—'}</b></div>` : '')
    } },
    xAxis: { type: 'category', data: cats, axisLabel: { ...axisLabel, hideOverlap: true }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
    yAxis: [
      valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      valueAxis({ min: 0, max: 100, position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
    ],
    series: [
      { name: t('Rendimento medio'), type: 'bar', barMaxWidth: 22,
        data: avg.map((v, i) => ({ value: v, itemStyle: { color: (v ?? 0) >= 0 ? hexA(C.up, i === opts.highlight ? 1 : 0.7) : hexA(C.down, i === opts.highlight ? 1 : 0.7), borderRadius: (v ?? 0) >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4], borderColor: i === opts.highlight ? C.btc : undefined, borderWidth: i === opts.highlight ? 2 : 0 } })) },
      { name: t('% positivi'), type: 'line', yAxisIndex: 1, data: win, symbol: 'circle', symbolSize: 5, lineStyle: { width: 1.6, color: C.btc }, itemStyle: { color: C.btc },
        markLine: { symbol: 'none', silent: true, lineStyle: { color: 'rgba(247,147,26,0.35)', type: 'dashed' }, label: { show: false }, data: [{ yAxis: 50 }] } },
    ],
  }
}

export function MonthlyBars({ d }: { d: TimePivots }) {
  const st = d.seasonality.monthly.stats
  const option = useMemo(() => barsWithWin(st.map((x) => mesi()[x.month - 1] ?? x.label), st.map((x) => x.avg), st.map((x) => x.win_rate), { highlight: d.seasonality.monthly.current.month - 1, avgDigits: 1 }), [st, d])
  const cur = st[d.seasonality.monthly.current.month - 1]
  return (
    <Card className="h-full">
      <CardHeader title={t('Stagionalità mensile')} icon={<Sigma />} subtitle={t('Rendimento medio e % di anni positivi per mese (dal 2011)')} />
      <CardBody className="flex flex-col gap-3">
        <div className="min-h-[280px] flex-1"><EChart option={option} height="100%" /></div>
        {cur && (
          <div className="dgrid grid-cols-3">
            {[[t('Migliore'), cur.best ? `${pct(cur.best.value, 0)} (${cur.best.year})` : '—', 'text-up'], [t('Peggiore'), cur.worst ? `${pct(cur.worst.value, 0)} (${cur.worst.year})` : '—', 'text-down'], [t('Mediana'), pct(cur.median, 1), signCls(cur.median)]].map(([l, v, cls]) => (
              <div key={l} className="min-w-0 px-3 py-2.5">
                <div className="label mb-0.5 truncate">{l} · {mesi()[cur.month - 1] ?? cur.label}</div>
                <div className={clsx('tnum text-sm font-semibold', cls)}>{v}</div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function HourDowHeatmap({ d }: { d: TimePivots }) {
  const [metric, setMetric] = useState<'avg' | 'range'>('avg')
  const option = useMemo(() => {
    const m = d.seasonality.hour_dow[metric]
    const data: [number, number, number | null][] = []
    m.forEach((row, i) => row.forEach((v, j) => data.push([j, i, v])))
    const vals = data.map((x) => x[2]).filter(fin)
    const lim = metric === 'avg' ? Math.max(0.05, ...vals.map((v) => Math.abs(v))) : 0
    const now = new Date()
    const DOW = dow()
    return {
      grid: { left: 8, right: 8, top: 8, bottom: 30, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: P) => {
        const v = p.value as [number, number, number]
        return `<b>${DOW[v[1]]} ${String(v[0]).padStart(2, '0')}:00 UTC</b><div>${metric === 'avg' ? `${t('Rendimento medio')} ${pct(v[2], 3)}` : `${t('Escursione media')} ${v[2]?.toFixed(2)}%`}</div>`
      } },
      xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')), axisLabel: { ...axisLabel, interval: 1 }, axisLine: { show: false }, axisTick: { show: false } },
      yAxis: { type: 'category', data: DOW, inverse: true, axisLabel, axisLine: { show: false }, axisTick: { show: false } },
      visualMap: metric === 'avg'
        ? { show: false, min: -lim, max: lim, inRange: { color: divergingRange } }
        : { show: false, min: Math.min(...vals), max: Math.max(...vals), inRange: { color: ['#2A3140', hexA(C.purple, 0.6), C.btc] } },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: '#10151F', borderWidth: 1.5, borderRadius: 2 },
        markPoint: { symbol: 'rect', symbolSize: [18, 18], silent: true, itemStyle: { color: 'transparent', borderColor: '#fff', borderWidth: 1.5 }, label: { show: false },
          data: [{ coord: [String(now.getUTCHours()).padStart(2, '0'), DOW[(now.getUTCDay() + 6) % 7]] }] } }],
    }
  }, [d, metric])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end"><Segmented value={metric} onChange={setMetric} options={[{ value: 'avg', label: t('Rendimento') }, { value: 'range', label: t('Volatilità') }]} /></div>
      <EChart option={option} height={300} />
    </div>
  )
}

export function IntradayCard({ d }: { d: TimePivots }) {
  const [tab, setTab] = useState<'dow' | 'hour' | 'hd' | 'md' | 'wk'>('dow')
  const s = d.seasonality
  const option = useMemo(() => {
    if (tab === 'dow') return barsWithWin(s.weekday.stats.map((x) => dow()[x.dow] ?? x.name), s.weekday.stats.map((x) => x.avg), s.weekday.stats.map((x) => x.win_rate), { highlight: s.weekday.current_dow, extraLine: { name: 'Escursione media', data: s.weekday.stats.map((x) => x.avg_range), color: C.purple } })
    if (tab === 'hour') return barsWithWin(s.hourly.stats.map((x) => `${String(x.hour).padStart(2, '0')}:00`), s.hourly.stats.map((x) => x.avg), s.hourly.stats.map((x) => x.win_rate), { highlight: new Date().getUTCHours(), avgDigits: 3, extraLine: { name: 'Escursione media', data: s.hourly.stats.map((x) => x.avg_range), color: C.purple } })
    if (tab === 'md') return barsWithWin(s.monthday.stats.map((x) => String(x.day)), s.monthday.stats.map((x) => x.avg), s.monthday.stats.map((x) => x.win_rate), { highlight: s.monthday.current_day - 1 })
    if (tab === 'wk') {
      const idx = s.weekly.stats.findIndex((x) => x.week === s.weekly.current_week)
      return barsWithWin(s.weekly.stats.map((x) => `${t('S')}${x.week}`), s.weekly.stats.map((x) => x.avg), s.weekly.stats.map((x) => x.win_rate), { highlight: idx, avgDigits: 1 })
    }
    return {}
  }, [s, tab])
  const sub = {
    dow: 'Candele daily Binance (apertura→chiusura UTC) dal 2017 · barra evidenziata = oggi',
    hour: 'Candele orarie Binance dal 2017, ore UTC · barra evidenziata = ora attuale',
    hd: 'Rendimento medio (o escursione) per giorno × ora UTC · riquadro bianco = adesso',
    md: 'Rendimento medio per giorno del mese (dal 2011)',
    wk: 'Rendimento medio per settimana ISO dell\'anno (dal 2011)',
  }[tab]
  const subT = t(sub)
  return (
    <Card className="h-full">
      <CardHeader title={t('Giorni e orari')} icon={<SunMoon />} subtitle={subT}
        right={<div className="max-w-full overflow-x-auto"><Segmented value={tab} onChange={setTab} options={[{ value: 'dow', label: tr('Settimana', 'Weekday') }, { value: 'hour', label: tr('Ora', 'Hour') }, { value: 'hd', label: t('Giorno×ora') }, { value: 'md', label: t('Giorno mese') }, { value: 'wk', label: t('Sett. anno') }]} /></div>} />
      <CardBody>
        {tab === 'hd' ? <HourDowHeatmap d={d} /> : <EChart option={option} height={340} />}
      </CardBody>
    </Card>
  )
}

export function SessionsCard({ d }: { d: TimePivots }) {
  const ss = d.seasonality.sessions
  return (
    <Card className="h-full">
      <CardHeader title={t('Sessioni di mercato')} icon={<Timer />} subtitle={t('Rendimento per sessione (UTC), storico e ultimi 12 mesi')} />
      <CardBody className="flex flex-col px-2">
        {ss.length ? (
          // rows spread over the card height when it is stretched next to the taller "Giorni e orari" chart
          <div className="flex-1 overflow-x-auto">
            <table className="tbl xl:h-full">
              <thead><tr><th>{t('Sessione')}</th><th className="text-right">{t('Media')}</th><th className="text-right">{t('Positivi')}</th><th className="text-right">{t('Escursione')}</th><th className="text-right">{t('12 mesi')}</th></tr></thead>
              <tbody>
                {ss.map((x) => (
                  <tr key={x.key}>
                    <td><div className="font-semibold text-white">{x.label}</div><div className="text-xs text-slate-400">{x.hours}</div></td>
                    <td className={clsx('text-right font-medium', signCls(x.avg))}>{pct(x.avg, 3)}</td>
                    <td className="text-right">{pctOf(x.win_rate, 1)}</td>
                    <td className="text-right text-slate-300">{fin(x.avg_range) ? `${x.avg_range.toFixed(2)}%` : '—'}</td>
                    <td className="text-right"><span className={signCls(x.recent_avg)}>{pct(x.recent_avg, 3)}</span><div className="text-xs text-slate-400">{t('{p} pos.', { p: pctOf(x.recent_win_rate) })}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState compact />}
      </CardBody>
    </Card>
  )
}

export function HalvingCycleHeatmap({ d, updatedAt }: { d: TimePivots; updatedAt?: number }) {
  const hc = d.seasonality.halving_cycle
  const option = useMemo(() => {
    const cols = [...mesi(), t('Anno (med.)')]
    const data: unknown[] = []
    hc.rows.forEach((r, ri) => {
      r.months.forEach((m, ci) => {
        if (m.avg == null) return
        const cur = ri === hc.current.idx && ci === hc.current.month - 1
        data.push({ value: [ci, ri, m.avg], win: m.win_rate, n: m.n, vals: m.values, itemStyle: cur ? { borderColor: C.btc, borderWidth: 3, shadowBlur: 12, shadowColor: C.btc } : undefined })
      })
    })
    const annual = hc.rows.map((r, ri) => ({ value: [12, ri, r.annual.median], win: r.annual.win_rate, n: r.annual.values.length, vals: r.annual.values, itemStyle: ri === hc.current.idx ? { borderColor: C.btc, borderWidth: 2 } : undefined }))
    return {
      grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: P) => {
        const x = p.data as { value: [number, number, number]; win: number; n: number; vals: { year: number; value: number | null }[] }
        return `<b>${cap(hc.rows[x.value[1]].label)} · ${cols[x.value[0]]}</b><div>${t('Media')} <b>${pct(x.value[2], 1)}</b> · ${t('positivi')} ${pctOf(x.win)} (${x.n})</div>` +
          `<div style="color:#8B94A7;margin-top:3px">${x.vals.map((v) => `${v.year}: ${pct(v.value, 1)}`).join(' · ')}</div>`
      } },
      xAxis: { type: 'category', data: cols, position: 'top', axisLabel, axisLine: { show: false }, axisTick: { show: false } },
      yAxis: { type: 'category', data: hc.rows.map((r) => capSeg(r.short)), inverse: true, axisLabel, axisLine: { show: false }, axisTick: { show: false } },
      visualMap: [
        { show: false, seriesIndex: 0, min: -40, max: 40, inRange: { color: divergingRange } },
        { show: false, seriesIndex: 1, min: -150, max: 150, inRange: { color: divergingRange } },
      ],
      series: [
        { type: 'heatmap', data, label: { show: true, color: '#E6E9EF', fontSize: 11, fontFamily: FONT, formatter: (p: P) => {
          const v = (p.data as { value: [number, number, number] }).value[2]
          return `${v > 0 ? '+' : ''}${v.toFixed(0)}%`
        } }, itemStyle: { borderColor: '#10151F', borderWidth: 2, borderRadius: 4 } },
        { type: 'heatmap', data: annual, label: { show: true, color: '#fff', fontWeight: 700, fontSize: 11, fontFamily: FONT, formatter: (p: P) => {
          const v = (p.data as { value: [number, number, number] }).value[2]
          return v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`
        } }, itemStyle: { borderColor: '#10151F', borderWidth: 2, borderRadius: 4 } },
      ],
    }
  }, [hc])
  const r = hc.rows[hc.current.idx]
  const cell = r?.months[hc.current.month - 1]
  return (
    <Card>
      <CardHeader title={t("Stagionalità del ciclo dell'halving")} icon={<Orbit />} updatedAt={updatedAt} subtitle={t('Anno del ciclo di 4 anni × mese · media dei rendimenti mensili · bordo arancione = oggi')} />
      <CardBody className="flex flex-col gap-3">
        <div className="overflow-x-auto"><div className="min-w-[640px]"><EChart option={option} height={4 * 52 + 40} /></div></div>
        {r && cell && (
          <p className="text-sm text-slate-300">
            {rich(t("Siamo nell'{label} ({years}), mese di {month}: storicamente {avg} in media, positivo nel {win} dei casi ({vals})."), {
              label: <b className="text-white">{r.label.toLowerCase()}</b>, years: r.years.join(', '), month: monthsLong()[hc.current.month - 1],
              avg: <b className={signCls(cell.avg)}>{pct(cell.avg, 1)}</b>, win: pctOf(cell.win_rate), vals: cell.values.map((v) => `${v.year} ${pct(v.value, 0)}`).join(', '),
            })}{' '}
            {t('Rendimento annuo mediano di questo anno-ciclo')}: <b className={signCls(r.annual.median)}>{pct(r.annual.median, 0)}</b>.
          </p>
        )}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ Ciclo

export function CyclePivotsCard({ d, className, bodyClassName }: { d: TimePivots; className?: string; bodyClassName?: string }) {
  const cp = d.cycle_pivots
  const [showAll, setShowAll] = useState(false)
  const clusters = showAll ? cp.clusters : cp.clusters.filter((c) => c.days_away > -120)
  return (
    <Card className={className}>
      <CardHeader title={t('Pivot di ciclo')} icon={<Hourglass />} subtitle={t("{n} giorni dall'halving del {d}", { n: int(cp.days_since_halving), d: date(cp.last_halving) }) + (cp.next_halving ? ` · ${t('Prossimo ≈ {d}', { d: date(cp.next_halving) })}` : '')} />
      <CardBody className={clsx('flex flex-col gap-4', bodyClassName)}>
        <div className="flex flex-col divide-y divide-line">
          {cp.items.map((it) => (
            <div key={it.key} className="py-3 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">{it.label}</span>
                <span className="flex items-center gap-2 text-xs"><KindTag k={it.kind} /><span className="text-slate-500">·</span><span className="text-slate-400">{statusLabel(it.status)}</span></span>
              </div>
              <div className="tnum mt-1 text-xs text-slate-400">{date(it.from)} – {date(it.to)} · {t('Centro')} <b className="text-slate-200">{date(it.mid)}</b>{it.days_away > 0 ? ` (${t('tra {n}{u}', { n: int(it.days_away), u: du() })})` : ''}</div>
              <p className="mt-1.5 text-xs leading-5 text-slate-300">{it.text}</p>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between"><div className="label mb-0">{t("Swing maggiori ricorrenti (giorni dall'halving)")}</div>
            <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? t('Solo recenti/futuri') : t('Mostra tutti')}</button></div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t('Tipo')}</th><th className="text-right">{t("Giorni dall'halving per ciclo")}</th><th>{t('Proiezione')}</th><th>{t('Stato')}</th></tr></thead>
              <tbody>
                {clusters.map((c, i) => (
                  <tr key={i} title={c.text}>
                    <td><KindTag k={c.kind} /><div className="text-xs text-slate-400">{t('{a}/{b} cicli', { a: c.cycles, b: c.of })}</div></td>
                    <td className="tnum text-right" title={c.members.map((m) => t("Ciclo {c}: {d} giorni dall'halving", { c: m.halving, d: m.days })).join('\n')}>{c.members.map((m) => `C${m.halving} ${m.days}${du()}`).join(' · ')}<div className="text-xs text-slate-400">{t('Proiezione ≈ {d}{u} ±{e}', { d: int(c.projected_days), u: du(), e: int(c.uncertainty) })}</div></td>
                    <td>{date(c.mid)}<div className="text-xs text-slate-400">{c.confirmed ? t('Confermato: {d}', { d: date(c.confirmed.time) }) : c.days_away > 0 ? t('Tra {n}{u}', { n: int(c.days_away), u: du() }) : t('Non visto in questo ciclo')}</div></td>
                    <td className="text-slate-400">{statusLabel(c.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs leading-5 text-slate-500">{cp.method}</p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ Proiezioni temporali
export function ProjectionsCard({ d }: { d: TimePivots }) {
  const p = d.projections
  const fibFuture = p.fib.filter((f) => f.days_away > -20)
  return (
    <Card>
      <CardHeader title={t('Proiezioni temporali dagli swing')} icon={<Ruler />} subtitle={p.next_kind ? `${t('Prossimo pivot atteso')}: ${p.next_kind === 'top' ? t('massimo (gamba rialzista in corso)') : t('minimo (gamba ribassista in corso)')}` : t('Fibonacci time zones, gambe uguali, spaziatura')} />
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="label">{t('Ultime gambe maggiori (zigzag 4× ATR)')}</div>
          <div className="dgrid grid-cols-2 sm:grid-cols-3">
            {p.legs.slice(-6).map((l, i) => (
              <div key={i} className="tnum min-w-0 px-3 py-2 text-xs text-slate-400">
                <div className="truncate text-slate-300">{date(l.from, false)} → {date(l.to, false)}</div>
                <div className="mt-0.5"><b className="font-semibold text-white">{l.days}{du()}</b> · <span className={signCls(l.change)}>{pct(l.change, 0)}</span></div>
              </div>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Fibonacci time zone</th><th>{t('Data')}</th><th className="text-right">{t('Distanza')}</th></tr></thead>
            <tbody>
              {fibFuture.map((f, i) => (
                <tr key={i}>
                  <td className="!whitespace-normal"><b className="text-white">{f.ratio}×</b><div className="text-xs text-slate-400">{t('Gamba')} {date(f.anchor_from, false)} → {date(f.anchor_to, false)} ({f.leg_days}{du()})</div></td>
                  <td>{date(f.time)}</td>
                  <td className="text-right">{f.days_away > 0 ? <span className="text-slate-200">{t('Tra {n}{u}', { n: f.days_away, u: du() })}</span> : <span className="text-slate-400">{t('{n}{u} fa', { n: -f.days_away, u: du() })}</span>}</td>
                </tr>
              ))}
              {p.equal_legs.map((e, i) => (
                <tr key={`e${i}`}>
                  <td className="!whitespace-normal"><b className="text-white">{t('Gamba uguale')}</b><div className="text-xs text-slate-400">{cap(e.label)} ({int(e.days)}{du()})</div></td>
                  <td>{date(e.time)}</td>
                  <td className="text-right">{e.days_away > 0 ? <span className="text-slate-200">{t('Tra {n}{u}', { n: e.days_away, u: du() })}</span> : <span className="text-slate-400">{t('{n}{u} fa', { n: -e.days_away, u: du() })}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dgrid grid-cols-1 sm:grid-cols-2">
          {p.spacing.map((s) => (
            <div key={s.tf} className="min-w-0 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2 text-sm"><span className="font-semibold text-white">{t('Spaziatura swing {tf}', { tf: tfLabel(s.tf) })}</span><span className="tnum text-slate-300">{t('Mediana {n}{u}', { n: s.median_days, u: du() })}</span></div>
              <div className="mt-1 text-xs text-slate-400">IQR {s.iqr[0]}–{s.iqr[1]}{du()} · {t('Ultimo {k}', { k: kindLabel(s.last_pivot.kind).toLowerCase() })} {date(s.last_pivot.time, false)}</div>
              <p className="tnum mt-1 text-xs text-slate-400">{t('Prossimi')}: {s.next.map((x) => date(x, false)).join(', ')}</p>
            </div>
          ))}
        </div>
        <p className="text-xs leading-5 text-slate-500">{p.method}</p>
      </CardBody>
    </Card>
  )
}

export function MethodNote({ text }: { text: string }) {
  return <SharedMethodNote><p>{text}</p></SharedMethodNote>
}

