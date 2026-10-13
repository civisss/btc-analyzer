import { useMemo, useState, type CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Prediction, ReliabilityBucket, SourceStat } from '../api/tracking'
import EChart from '../components/charts/EChart'
import { C, FONT, axisLabel, hexA, legendBase, tooltipBase, valueAxis } from '../components/charts/theme'
import { Badge, EmptyState, ProgressBar, ToneBadge, clsx } from '../components/ui'
import { date, dayUnit, pct, usd } from '../lib/format'
import { t, tr } from '../i18n'

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
const pctU = (v: Num, d = 0) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const signCls = (v: Num) => (!fin(v) || v === 0 ? 'text-slate-400' : v > 0 ? 'text-up' : 'text-down')
/** Hit rate colour: green only when clearly better than a coin flip, red when clearly worse. */
const hitCls = (v: Num, n = 0) => (!fin(v) || n < 20 ? 'text-slate-300' : v >= 55 ? 'text-up' : v <= 45 ? 'text-down' : 'text-slate-200')

export const MODE_LABEL: Record<string, string> = { live: 'Live', backtest: 'Backtest' }

export function ModeTag({ mode }: { mode: 'live' | 'backtest' }) {
  return <Badge color={mode === 'live' ? 'blue' : 'slate'}>{MODE_LABEL[mode]}</Badge>
}

export function SourceTable({ sources, selected, onSelect }: { sources: SourceStat[]; selected?: string; onSelect?: (k: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!sources.length) return <EmptyState compact text={t('Nessuna previsione registrata')} />
  // live sources with nothing resolved yet (only pending) collapse into one summary row
  const waiting = sources.filter((s) => s.mode === 'live' && s.n_resolved === 0)
  const shown = open || waiting.length < 2 ? sources : sources.filter((s) => !waiting.includes(s))
  const pendingTotal = waiting.reduce((a, s) => a + s.n_pending, 0)
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[980px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{tr('Fonte', 'Source')}</th>
            <th>{tr('Orizzonte', 'Horizon')}</th>
            <th>{tr('Tipo', 'Type')}</th>
            <th className="text-right">{tr('Verificate', 'Resolved')}</th>
            <th className="text-right" title={t('% di direzioni corrette (previsioni neutrali escluse)')}>Hit rate</th>
            <th className="text-right" title={t('Errore quadratico della probabilità di rialzo: 0 perfetto, 0.25 = moneta')}>Brier</th>
            <th className="text-right" title={t('Miglioramento rispetto alla frequenza di rialzo del campione')}>Skill</th>
            <th className="text-right" title={t('Scarto medio tra probabilità dichiarata e frequenza osservata')}>{tr('Calibrazione', 'Calibration')}</th>
            <th className="text-right" title={t('Errore % medio della mediana prevista')}>MAE</th>
            <th className="text-right" title={t('% di esiti dentro la banda prevista (nominale tra parentesi)')}>{tr('Copertura', 'Coverage')}</th>
            <th className="pr-4 text-right sm:pr-5">{t('Ultimi 90 {g}', { g: dayUnit() })}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => {
            const k = `${s.source}|${s.mode}`
            return (
              <tr key={k} onClick={() => onSelect?.(k)} className={clsx(onSelect && 'cursor-pointer', selected === k && '[&>td]:bg-white/[0.035]')} title={s.note}>
                <td className="pl-4 sm:pl-5">
                  <div className={clsx('font-medium', selected === k ? 'text-white' : 'text-slate-200')}>{s.label}</div>
                  <div className="text-2xs text-slate-400">{t('Agente {name}', { name: s.agent_label })}</div>
                </td>
                <td className="text-xs text-slate-400">{s.horizon}</td>
                <td><ModeTag mode={s.mode} /></td>
                <td className="text-right text-slate-300">{s.n_resolved.toLocaleString('en-US')}{s.n_pending > 0 && <span className="ml-1.5 text-2xs text-slate-400">{t('In attesa: {n}', { n: s.n_pending })}</span>}</td>
                <td className={clsx('text-right font-medium', hitCls(s.hit_rate, s.n_dir))}>{pctU(s.hit_rate, 1)}</td>
                <td className="text-right text-slate-200">{fin(s.brier) ? s.brier.toFixed(3) : '—'}</td>
                <td className={clsx('text-right', signCls(s.brier_skill))}>{pct(s.brier_skill, 0)}</td>
                <td className="text-right text-slate-300">{fin(s.ece) ? `${s.ece.toFixed(1)} pt` : '—'}</td>
                <td className="text-right text-slate-300">{pctU(s.mae_pct, 1)}</td>
                <td className="text-right text-slate-300">{pctU(s.coverage)}{fin(s.band_nominal) && <span className="ml-1 text-2xs text-slate-400">({s.band_nominal.toFixed(0)}%)</span>}</td>
                <td className={clsx('pr-4 text-right sm:pr-5', hitCls(s.last90.hit_rate, s.last90.n))}>{pctU(s.last90.hit_rate)}<span className="ml-1 text-2xs text-slate-400">n={s.last90.n}</span></td>
              </tr>
            )
          })}
          {waiting.length >= 2 && (
            <tr className="cursor-pointer" onClick={() => setOpen(!open)}>
              <td className="pl-4 sm:pl-5" colSpan={3}>
                <span className="inline-flex items-center gap-1.5 text-slate-300">
                  <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
                  {t('{n} fonti live in attesa di esito', { n: waiting.length })}
                </span>
              </td>
              <td className="text-right text-xs text-slate-400">{t('In attesa: {n}', { n: pendingTotal })}</td>
              <td className="pr-4 text-right text-xs text-slate-400 sm:pr-5" colSpan={7}>{open ? t('Nascondi') : t('Mostra')}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Diagramma di calibrazione: probabilità di rialzo dichiarata vs frequenza osservata (diagonale = perfetto). */
export function ReliabilityChart({ series, height = 320, compact = false }: { series: { name: string; color: string; buckets: ReliabilityBucket[] }[]; height?: number | string; compact?: boolean }) {
  const option = useMemo(() => {
    const maxN = Math.max(1, ...series.flatMap((s) => s.buckets.map((b) => b.n)))
    return {
      grid: compact ? { left: 4, right: 18, top: 10, bottom: 4, containLabel: true } : { left: 8, right: 16, top: 34, bottom: 8, containLabel: true },
      legend: compact ? { show: false } : { ...legendBase, data: series.map((s) => s.name) },
      tooltip: {
        ...tooltipBase, trigger: 'item',
        formatter: (p: { seriesName: string; value: [number, number, number, number, number] }) =>
          `<div style="color:${C.muted};margin-bottom:4px">${p.seriesName} · ${tr('fascia', 'bin')} ${p.value[3]}–${p.value[4]}%</div>` +
          `<div>${t('Probabilità media')} <b>${p.value[0].toFixed(0)}%</b></div><div>${t('Rialzi osservati')} <b>${p.value[1].toFixed(0)}%</b></div><div>${tr('Previsioni', 'Forecasts')} <b>${p.value[2]}</b></div>`,
      },
      xAxis: { type: 'value', min: 0, max: 100, interval: compact ? 25 : 20, name: compact ? undefined : t('Probabilità di rialzo prevista'), nameLocation: 'middle', nameGap: 26,
               nameTextStyle: { color: C.muted, fontSize: 11, fontFamily: FONT }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
               axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } },
      yAxis: valueAxis({ scale: false, min: 0, max: 100, interval: compact ? 25 : 20, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
      series: [
        { name: '_diag', type: 'line', data: [[0, 0], [100, 100]], showSymbol: false, silent: true, lineStyle: { color: hexA(C.grey, 0.45), type: 'dashed', width: 1 }, tooltip: { show: false } },
        ...series.map((s) => ({
          name: s.name, type: 'line', smooth: false,
          data: s.buckets.filter((b) => fin(b.predicted) && fin(b.observed)).map((b) => [b.predicted, b.observed, b.n, b.from, b.to]),
          symbol: 'circle', symbolSize: (v: number[]) => { const m = compact ? Math.max(1, ...s.buckets.map((b) => b.n)) : maxN; return compact ? 4 + 7 * Math.sqrt(v[2] / m) : 5 + 11 * Math.sqrt(v[2] / m) },
          lineStyle: { width: 1.25, color: s.color, opacity: 0.7 }, itemStyle: { color: s.color }, emphasis: { disabled: true },
        })),
      ],
    }
  }, [series, compact])
  return <EChart option={option} height={height} />
}

/** One small calibration panel per source (same axes everywhere): source in blue, all sources in grey, diagonal = perfect. */
export function ReliabilityMulti({ items, overall, selected, onSelect, wide }: {
  items: { key: string; name: string; sub: string; buckets: ReliabilityBucket[] }[]
  overall: ReliabilityBucket[]; selected?: string; onSelect?: (k: string) => void
  /** full-width card: three panels per row from lg, all panels on one row (up to 5) from xl */
  wide?: boolean
}) {
  if (!items.length) return <EmptyState compact text={t('Nessuna probabilità verificata per questa fonte')} />
  const n = items.length
  return (
    <div className={clsx('dgrid grid-cols-1 sm:grid-cols-2', wide
      ? 'lg:grid-cols-[repeat(var(--c-lg),minmax(0,1fr))] xl:grid-cols-[repeat(var(--c-xl),minmax(0,1fr))]'
      : n > 4 && '2xl:grid-cols-3')}
      style={wide ? { '--c-lg': Math.min(n, 3), '--c-xl': n <= 5 ? n : Math.ceil(n / 2) } as CSSProperties : undefined}>
      {items.map((it) => (
        <div key={it.key} role="button" tabIndex={0} onClick={() => onSelect?.(it.key)} onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(it.key) }}
          className={clsx('min-w-0 cursor-pointer px-3 pb-1 pt-2.5 text-left transition-colors', selected === it.key ? 'bg-white/[0.035]' : 'hover:bg-white/[0.02]')}>
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span className={clsx('truncate text-sm font-medium', selected === it.key ? 'text-white' : 'text-slate-200')}>{it.name}</span>
            <span className="tnum shrink-0 text-2xs text-slate-400">{it.sub}</span>
          </div>
          <ReliabilityChart compact height={190}
            series={[{ name: t('Tutte le fonti'), color: C.grey2, buckets: overall }, { name: it.name, color: C.blue, buckets: it.buckets }]} />
        </div>
      ))}
    </div>
  )
}

const DIR_TONE = { up: 'bullish', down: 'bearish', neutral: 'neutral' } as const

export function PredictionList({ items, empty }: { items: Prediction[]; empty?: string }) {
  if (!items.length) return <EmptyState compact text={empty ?? t('Nessuna previsione')} />
  const dirLabel = { up: tr('Rialzo', 'Up'), down: tr('Ribasso', 'Down'), neutral: tr('Neutrale', 'Neutral') }
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[760px]">
        <thead>
          <tr>
            <th className="pl-4 sm:pl-5">{tr('Fonte', 'Source')}</th><th>{tr('Emessa', 'Issued')}</th><th>{tr('Scadenza', 'Due')}</th><th>{tr('Previsione', 'Forecast')}</th>
            <th className="text-right">{t('Prezzo iniziale')}</th>
            <th className="text-right">{items[0].resolved ? tr('Esito', 'Outcome') : tr('Mediana', 'Median')}</th>
            <th className="pr-4 text-right sm:pr-5">{items[0].resolved ? tr('Risultato', 'Result') : t('Prob. rialzo')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td className="pl-4 sm:pl-5"><span className="text-slate-200">{p.label}</span> <ModeTag mode={p.mode} /></td>
              <td className="text-xs text-slate-400">{date(p.made_at)}</td>
              <td className="text-xs text-slate-400">{date(p.due_at)}</td>
              <td className="text-xs">
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <ToneBadge tone={DIR_TONE[p.direction]} label={dirLabel[p.direction]} />
                  {fin(p.up_prob) && <span className="tnum text-slate-400">{p.up_prob.toFixed(0)}%</span>}
                  {p.context && <span className="text-slate-500">· {p.context}</span>}
                </span>
              </td>
              <td className="text-right text-slate-300">{usd(p.price0)}</td>
              {p.resolved ? (
                <>
                  <td className="text-right text-slate-200">{usd(p.actual)} <span className={clsx('text-xs', signCls(p.change))}>{pct(p.change, 1)}</span></td>
                  <td className="pr-4 text-right sm:pr-5">
                    {fin(p.err_pct) && <span className="mr-1.5 text-2xs text-slate-400">{t('Err. {v}%', { v: p.err_pct.toFixed(1) })}</span>}
                    {p.hit === null ? <Badge>{tr('Neutrale', 'Neutral')}</Badge>
                      : <Badge color={p.hit ? 'up' : 'down'}>{p.hit ? tr('Corretta', 'Hit') : tr('Errata', 'Miss')}</Badge>}
                  </td>
                </>
              ) : (
                <>
                  <td className="text-right text-slate-200">{usd(p.median)}</td>
                  <td className="pr-4 text-right text-slate-300 sm:pr-5">{pctU(p.up_prob)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function WeightsList({ weights, labels, className }: { weights: Record<string, number>; labels: Record<string, string>; className?: string }) {
  const rows = Object.entries(weights).sort((a, b) => b[1] - a[1])
  return (
    // bottom borders + -mb-px: the last row's border is clipped, so dividers work for any column count
    <ul className={clsx('-mt-2.5 grid content-start gap-x-8 overflow-hidden', className)}>
      {rows.map(([k, w]) => (
        <li key={k} className="-mb-px flex flex-col justify-center gap-1.5 border-b border-line py-2.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-200">{labels[k] ?? k}</span>
            <span className={clsx('tnum font-medium', w > 0.52 ? 'text-up' : w < 0.48 ? 'text-down' : 'text-slate-400')}>{w.toFixed(2)}</span>
          </div>
          <div className="relative">
            <ProgressBar value={w * 100} color={w > 0.52 ? C.up : w < 0.48 ? C.down : undefined} />
            <span aria-hidden className="absolute -top-0.5 left-1/2 h-2.5 w-px bg-white/30" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export const SOURCE_COLORS = [C.blue, C.purple, C.teal, C.grey, C.primary, C.grey2]
