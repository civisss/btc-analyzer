import { useMemo } from 'react'
import type { EventTypeStat, EventsResponse, PathSeries, PoliticalCycle, UpcomingEvent } from '../api/events'
import EChart from '../components/charts/EChart'
import { C, FONT, areaGradient, axisLabel, hexA, legendBase, tooltipBase, valueAxis } from '../components/charts/theme'
import { Badge, EmptyState, ProgressBar, clsx } from '../components/ui'
import { date, dayUnit, pct, usd } from '../lib/format'
import { months, t, tr, weekdays } from '../i18n'

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
const signCls = (v: Num) => (!fin(v) || v === 0 ? 'text-fg-3' : v > 0 ? 'text-up' : 'text-down')
const pctU = (v: Num, d = 0) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const ratio = (v: Num) => (fin(v) ? `×${v.toFixed(2)}` : '—')
/** Inner tile surface used inside cards. */
export const TILE = 'tile'

export function whenLabel(days: number): string {
  if (days <= 0) return tr('Oggi', 'Today')
  if (days === 1) return tr('Domani', 'Tomorrow')
  const n = days.toLocaleString('en-US')
  return tr(`Tra ${n} g`, `In ${n} d`)
}

export function QualityTag({ q, label }: { q: 'esatta' | 'regola' | 'stimata'; label?: string }) {
  if (q === 'esatta') return null
  return <Badge className={q === 'stimata' ? '!text-warn !ring-warn/25' : undefined}>{label ?? (q === 'stimata' ? t('Data stimata') : t('Da regola'))}</Badge>
}

// ------------------------------------------------------------------ prossimi eventi
export function UpcomingList({ items, max, wide }: { items: UpcomingEvent[]; max?: number; /** the list spans the full content width below 1700px → two columns from xl */ wide?: boolean }) {
  const list = max ? items.slice(0, max) : items
  const top = Math.max(1, ...list.map((u) => u.expected_abs_1d ?? 0))
  const dow = weekdays()
  const mon = months()
  if (!list.length) return <EmptyState compact text={t('Nessun evento nei prossimi giorni')} />
  return (
    <ul className={clsx('grid gap-x-8', wide ? 'xl:grid-cols-2' : 'min-[1700px]:grid-cols-2')}>
      {list.map((u) => {
        const d = new Date(u.date * 1000)
        return (
          <li key={u.id} className={clsx('grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2.5 first:border-t-0', wide ? 'xl:[&:nth-child(2)]:border-t-0' : 'min-[1700px]:[&:nth-child(2)]:border-t-0')} title={u.text}>
            <div className="flex flex-col items-center border-r border-line py-1 pr-2 leading-tight">
              <span className="tnum text-base font-semibold text-white">{d.getUTCDate()}</span>
              <span className="text-2xs uppercase text-fg-3">{mon[d.getUTCMonth()]}</span>
              <span className="text-2xs capitalize text-fg-4">{dow[d.getUTCDay()]}</span>
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium text-white">{u.title}</span>
                {u.importance === 'alta' && <Badge>{t('Impatto alto')}</Badge>}
                <QualityTag q={u.quality} />
              </div>
              <div className="mt-0.5 truncate text-xs text-fg-3">{whenLabel(u.days_away)} · {u.hour || u.type_label}</div>
            </div>
            <div className="w-28 text-right sm:w-40">
              <div className="tnum text-sm font-medium text-white">{fin(u.expected_abs_1d) ? `±${u.expected_abs_1d.toFixed(1)}%` : '—'}
                {fin(u.expected_usd_1d) && <span className="ml-1 text-xs font-normal text-fg-3">±{usd(u.expected_usd_1d)}</span>}</div>
              <ProgressBar className="mt-1 !h-1" value={((u.expected_abs_1d ?? 0) / top) * 100} />
              <div className="mt-1 text-2xs text-fg-3">{fin(u.up_rate_1d) ? t('Rialzo nel {p}% · n={n}', { p: u.up_rate_1d.toFixed(0), n: u.n }) : t('Nessuno storico')}</div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ------------------------------------------------------------------ tabella per tipo
export function EventStatsTable({ types, selected, onSelect }: { types: EventTypeStat[]; selected?: string; onSelect?: (k: string) => void }) {
  const g = dayUnit()
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[860px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{tr('Evento', 'Event')}</th>
            <th className="text-right">n</th>
            <th className="text-right" title={t("Variazione media nelle 3 candele attorno all'evento")}>{t('±1 {g} media', { g })}</th>
            <th className="text-right" title={t("Movimento assoluto mediano nelle 3 candele attorno all'evento")}>{t('|±1 {g}| mediano', { g })}</th>
            <th className="text-right" title={t('Movimento assoluto mediano ÷ quello di 3 giorni qualsiasi dello stesso periodo')}>{tr('Volatilità', 'Volatility')}</th>
            <th className="text-right">{t('Rialzo ±1 {g}', { g })}</th>
            <th className="text-right">{t('−7..+7 {g} mediana', { g })}</th>
            <th className="text-right">{t('Rialzo 7 {g}', { g })}</th>
            <th className="pr-4 text-right sm:pr-5" title={t('Escursione mediana massimo/minimo sulle 15 candele')}>{t('Escursione 15 {g}', { g })}</th>
          </tr>
        </thead>
        <tbody>
          {types.map((ty) => (
            <tr key={ty.key} onClick={() => onSelect?.(ty.key)} className={clsx(onSelect && 'cursor-pointer', selected === ty.key && '[&>td]:bg-white/[0.035]')}>
              <td className="pl-4 sm:pl-5">
                <span className={clsx('font-medium', selected === ty.key ? 'text-white' : 'text-fg')}>{ty.label}</span>
                {ty.quality !== 'esatta' && <span className="ml-2 text-2xs text-fg-3">{ty.quality === 'regola' ? t('Date da regola') : t('Date stimate')}</span>}
              </td>
              <td className={clsx('text-right', ty.n < 8 ? 'text-warn' : 'text-fg-2')} title={ty.n < 8 ? t('Campione molto piccolo') : undefined}>{ty.n}</td>
              <td className={clsx('text-right', signCls(ty.d1.avg))}>{pct(ty.d1.avg, 2)}</td>
              <td className="text-right text-fg">{pctU(ty.d1.abs_median, 2)}</td>
              <td className={clsx('text-right font-medium', fin(ty.vol_ratio_1d) && ty.vol_ratio_1d >= 1.15 ? 'text-white' : 'text-fg-3')}>{ratio(ty.vol_ratio_1d)}</td>
              <td className="text-right text-fg-2">{pctU(ty.d1.win_rate)}</td>
              <td className={clsx('text-right', signCls(ty.d7.median))}>{pct(ty.d7.median, 1)}</td>
              <td className="text-right text-fg-2">{pctU(ty.d7.win_rate)}</td>
              <td className="pr-4 text-right text-fg-2 sm:pr-5">{pctU(ty.range_7d, 1)} <span className="text-2xs text-fg-3" title={t('Escursione rispetto a 15 giorni qualsiasi')}>{t('Vol. {v}', { v: ratio(ty.range_ratio_7d) })}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Percorso medio/mediano −7..+7 g (% vs chiusura del giorno prima dell'evento). */
export function EventPathChart({ stat, height = 220 }: { stat: EventTypeStat; height?: number | string }) {
  const option = useMemo(() => {
    const days = stat.path.map((p) => p.day)
    const sMedian = tr('Mediana', 'Median')
    const sMean = tr('Media', 'Mean')
    return {
      grid: { left: 8, right: 8, top: 30, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sMedian, sMean] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: number; color: string; axisValue: string | number }[]) => {
          const day = Number(ps[0]?.axisValue)
          const head = day === 0 ? tr("Giorno dell'evento", 'Event day') : `${tr('Giorno', 'Day')} ${day > 0 ? '+' : '−'}${Math.abs(day)}`
          return `<div style="color:${C.muted};margin-bottom:4px">${head}</div>` +
            ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.seriesName}</span><b>${pct(p.value, 2)}</b></div>`).join('')
        },
      },
      xAxis: { type: 'category', data: days, axisLabel: { ...axisLabel, formatter: (v: string) => (Number(v) === 0 ? tr('Evento', 'Event') : `${Number(v) > 0 ? '+' : ''}${v.replace('-', '−')}`) },
               axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v.toFixed(1).replace('-', '−')}%` } }),
      series: [
        { name: sMedian, type: 'bar', data: stat.path.map((p) => p.median), barMaxWidth: 16,
          itemStyle: { borderRadius: 3, color: (p: { value: number }) => (p.value >= 0 ? hexA(C.up, 0.75) : hexA(C.down, 0.75)) },
          markLine: { symbol: 'none', silent: true, data: [{ xAxis: '0' }], lineStyle: { color: hexA(C.primary, 0.35), type: 'dashed' }, label: { show: false } } },
        { name: sMean, type: 'line', data: stat.path.map((p) => p.mean), showSymbol: false, smooth: 0.2, lineStyle: { width: 1.75, color: C.accent }, itemStyle: { color: C.accent },
          areaStyle: { color: areaGradient(C.accent, 0.16, 0) } },
      ],
    }
  }, [stat])
  return <EChart option={option} height={height} />
}

export function RecentOccurrences({ stat }: { stat: EventTypeStat }) {
  const g = dayUnit()
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[360px]">
        <thead><tr><th className="pl-4 sm:pl-5">{tr('Data', 'Date')}</th><th className="text-right">±1 {g}</th><th className="text-right">−7..+7 {g}</th><th className="pr-4 text-right sm:pr-5">{t('Escursione 3 {g}', { g })}</th></tr></thead>
        <tbody>
          {stat.recent.map((r) => (
            <tr key={r.time}>
              <td className="pl-4 text-fg sm:pl-5">{r.label}</td>
              <td className={clsx('text-right', signCls(r.d1))}>{pct(r.d1, 1)}</td>
              <td className={clsx('text-right', signCls(r.d7))}>{pct(r.d7, 1)}</td>
              <td className="pr-4 text-right text-fg-2 sm:pr-5">{pctU(r.range_1d, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ ciclo politico
const YEAR_COLORS = [C.accent, C.steel, C.sand, C.grey]

/** Percorso di BTC attorno al voto (asse x = giorni dall'elezione). */
export function ElectionPathChart({ paths, mean, anchorDay, height = 340 }: {
  paths: PathSeries[]; mean?: [number, Num][]; anchorDay: number; height?: number | string
}) {
  const option = useMemo(() => {
    let k = 0
    const g = dayUnit()
    const series: Record<string, unknown>[] = paths.map((p) => {
      const color = p.current ? C.accent : YEAR_COLORS[k++ % YEAR_COLORS.length]
      return {
        name: p.current ? `${p.name} (${tr('in corso', 'ongoing')})` : p.name, type: 'line', data: p.points, showSymbol: false, smooth: false,
        lineStyle: { width: p.current ? 2.25 : 1.25, color, opacity: p.current ? 1 : 0.85 }, itemStyle: { color }, emphasis: { disabled: true }, z: p.current ? 5 : 2,
        ...(p.current ? { areaStyle: { color: areaGradient(C.accent, 0.18, 0) } } : {}),
      }
    })
    if (mean?.length) series.push({ name: t('Media cicli passati'), type: 'line', data: mean, showSymbol: false, lineStyle: { width: 1.5, color: C.primary, type: 'dashed' }, itemStyle: { color: C.primary }, z: 4 })
    series.push({
      name: '_mark', type: 'line', data: [], silent: true,
      markLine: { symbol: 'none', silent: true, data: [
        { xAxis: 0, lineStyle: { color: hexA(C.primary, 0.45), type: 'solid', width: 1 }, label: { formatter: tr('Voto', 'Vote'), color: C.muted, fontSize: 10, fontFamily: FONT, position: 'insideEndTop' } },
        ...(anchorDay !== 0 ? [{ xAxis: anchorDay, lineStyle: { color: hexA(C.accent, 0.6), type: 'dashed', width: 1 }, label: { formatter: tr('Oggi', 'Today'), color: C.accent, fontSize: 10, fontFamily: FONT, position: 'insideEndTop' } }] : []),
      ] },
    })
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: series.filter((s) => s.name !== '_mark').map((s) => s.name) },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: [number, number | null]; color: string }[]) => {
          const day = ps[0]?.value[0]
          const head = day === 0 ? tr('Giorno del voto', 'Election day') : t('{n} giorni dal voto', { n: `${day > 0 ? '+' : '−'}${Math.abs(day)}` })
          return `<div style="color:${C.muted};margin-bottom:4px">${head}</div>` +
            ps.filter((p) => p.seriesName !== '_mark' && p.value[1] != null).map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}</span><b style="font-variant-numeric:tabular-nums">${pct(p.value[1], 1)}</b></div>`).join('')
        },
      },
      xAxis: { type: 'value', min: -180, max: 365, interval: 60, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
               axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: number) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)} ${g}`) } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}%` } }),
      series,
    }
  }, [paths, mean, anchorDay])
  return <EChart option={option} height={height} />
}

export function YearTypeTable({ p }: { p: PoliticalCycle }) {
  return (
    <div className="no-scrollbar -mx-4 flex-1 overflow-x-auto sm:-mx-5">
      <table className="tbl h-full min-w-[460px]">
        <thead><tr><th className="pl-4 sm:pl-5">{t('Anno del ciclo USA')}</th><th className="text-right">n</th><th className="text-right">{t('Mediana annua')}</th><th className="text-right">{t('Anni positivi')}</th><th className="pr-4 sm:pr-5">{tr('Anni', 'Years')}</th></tr></thead>
        <tbody>
          {p.year_types.map((ty) => (
            <tr key={ty.type}>
              <td className="pl-4 text-fg sm:pl-5">{ty.label}{ty.current && <Badge className="ml-2">{tr('Ora', 'Now')}</Badge>}</td>
              <td className="text-right text-fg-2">{ty.n}</td>
              <td className={clsx('text-right font-medium', signCls(ty.median))}>{pct(ty.median, 0)}</td>
              <td className="text-right text-fg-2">{pctU(ty.win_rate)}</td>
              <td className="pr-4 text-xs text-fg-3 sm:pr-5">
                {ty.years.map((y) => {
                  const r = p.years.find((x) => x.year === y)?.return
                  return <span key={y} className="mr-2 whitespace-nowrap">{y} <span className={signCls(r)}>{pct(r, 0)}</span></span>
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MidtermLowsTable({ lows }: { lows: PoliticalCycle['midterm']['lows'] }) {
  const g = dayUnit()
  return (
    <div className="no-scrollbar -mx-4 flex-1 overflow-x-auto sm:-mx-5">
      <table className="tbl h-full min-w-[560px]">
        <thead><tr><th className="pl-4 sm:pl-5">Midterm</th><th>{t('Minimo di ciclo')}</th><th className="text-right">{t('Distanza dal voto')}</th><th className="text-right">{t('Dal massimo')}</th><th className="text-right">{t('+12 mesi dal voto')}</th><th className="pr-4 text-right sm:pr-5">{t('+12 mesi dal minimo')}</th></tr></thead>
        <tbody>
          {lows.map((l) => (
            <tr key={l.year}>
              <td className="pl-4 text-fg sm:pl-5">{date(l.midterm)} <span className="text-xs text-fg-3">{usd(l.midterm_price)}</span></td>
              <td className="text-fg">{l.low_label} <span className="text-xs text-fg-3">{usd(l.low_price)}</span></td>
              <td className="text-right text-fg-2">{l.days_from_midterm > 0 ? '+' : l.days_from_midterm < 0 ? '−' : ''}{Math.abs(l.days_from_midterm)} {g}</td>
              <td className="text-right text-down">{pct(l.drawdown_from_ath, 0)}</td>
              <td className={clsx('text-right font-medium', signCls(l.fwd_365))}>{pct(l.fwd_365, 0)}</td>
              <td className={clsx('pr-4 text-right sm:pr-5', signCls(l.low_to_365))}>{pct(l.low_to_365, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function LaterList({ d, className }: { d: EventsResponse; className?: string }) {
  if (!d.later.length) return null
  return (
    <ul className={clsx('flex flex-col', className)}>
      {d.later.map((l) => (
        <li key={l.key} className="flex items-center justify-between gap-3 border-t border-line py-2 text-sm first:border-t-0">
          <span className="flex min-w-0 items-center gap-2 text-fg"><span className="truncate">{l.title}</span> <QualityTag q={l.quality} /></span>
          <span className="tnum shrink-0 text-xs text-fg-3">{l.date_label} · {whenLabel(l.days_away)}</span>
        </li>
      ))}
    </ul>
  )
}
