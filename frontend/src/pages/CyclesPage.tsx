import { useTab } from '../lib/useTab'
import { useMemo, useState, type ReactNode } from 'react'
import { useCycles } from '../api/client'
import { Bullets, ClockTab, CompareTab, LeverageTab, MinerTab } from '../widgets/cycleAdvanced'
import type { Cycles, Pt } from '../api/types'
import EChart from '../components/charts/EChart'
import { C, SEQ_BLUE, axisLabel, axisNum, dataZoomInside, dataZoomSlider, dateFmt, hexA, legendBase, lineSeries, timeAxis, toXY, tooltipBase, usdAxisFmt, valueAxis } from '../components/charts/theme'
import { Card, CardBody, CardHeader, Fill, PageTitle, ProgressBar, Q, Segmented, Skeleton, SkeletonBlock, Toggle, clsx, TabBar } from '../components/ui'
import { PHASE_LABEL, date, dayUnit, daysUntil, int, pct, quarter, toPct, usd, usdCompact } from '../lib/format'
import { t } from '../i18n'
import { AlarmClock, CalendarClock, Hourglass, LineChart, Table2, TrendingUp } from 'lucide-react'
import { usePrice } from '../widgets/hooks'

function HalvingTimeline({ d }: { d: Cycles }) {
  const hs = d.halvings
  const curN = [...hs].filter((h) => !(h.estimated || h.time * 1000 > Date.now())).pop()?.n
  return (
    <div className="relative overflow-x-auto pb-2">
      <div className="relative flex min-w-[640px] justify-between px-4 pt-2">
        <div className="absolute left-8 right-8 top-[24px] h-px bg-white/[0.12]" />
        {hs.map((h) => {
          const est = h.estimated || h.time * 1000 > Date.now()
          const dd = daysUntil(h.time)
          return (
            <div key={h.n} className="relative z-10 flex w-36 flex-col items-center text-center">
              <span className={clsx('grid h-7 w-7 place-items-center rounded-full border text-xs font-semibold ring-4 ring-surface',
                h.n === curN ? 'border-btc bg-btc text-bg' : est ? 'border-dashed border-slate-500 bg-surface text-slate-400' : 'border-slate-500 bg-raised text-slate-200')}>{h.n}</span>
              <div className="mt-2 text-sm text-white">{date(h.time)}</div>
              <div className="tnum text-xs text-slate-400">{t('Blocco {n}', { n: int(h.block) })}</div>
              <div className="tnum mt-0.5 text-xs text-slate-300">{h.price != null ? usd(h.price) : est && dd != null ? t('Tra {n} giorni (stima)', { n: int(dd) }) : '—'}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}


function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-t border-line py-1.5 first:border-t-0">
      <span className="min-w-0 text-sm text-slate-400">{k}</span>
      <span className="tnum text-right text-sm text-white">{children}</span>
    </div>
  )
}

function CurrentStatus({ d }: { d: Cycles }) {
  const c = d.current
  const probs = c.phase_probabilities ?? { [c.phase]: c.phase_confidence }
  const price = usePrice()
  const win = (w: Cycles['current']['est_next_bottom']) => {
    if (!w) return null
    const dist = price ? ((w.price_low + w.price_high) / 2 / price - 1) * 100 : null
    return <>{quarter(w.mid)} <span className="text-slate-400">· {usdCompact(w.price_low, 0)}–{usdCompact(w.price_high, 0)}{dist != null ? ` (${pct(dist, 0)})` : ''}</span></>
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xl font-semibold text-white">{PHASE_LABEL[c.phase] ?? c.phase}</span>
        <span className="tnum text-xs text-slate-400">{t('Confidenza {v}%', { v: toPct(c.phase_confidence)?.toFixed(0) })}</span>
      </div>
      <div className="flex flex-col gap-2">
        {(['accumulation', 'bull', 'distribution', 'bear'] as const).map((p) => {
          const v = toPct(probs[p] ?? 0) ?? 0
          return (
            <div key={p} className="grid grid-cols-[96px_1fr_40px] items-center gap-3 text-xs">
              <span className={p === c.phase ? 'text-white' : 'text-slate-400'}>{PHASE_LABEL[p]}</span>
              <ProgressBar value={v} color={p === c.phase ? C.blue : '#5B6475'} className="h-1" />
              <span className="tnum text-right text-slate-300">{v.toFixed(0)}%</span>
            </div>
          )
        })}
      </div>
      <div>
        <div className="flex justify-between text-sm"><span className="text-slate-400">{c.probable_bottom ? t('Progresso del nuovo ciclo') : t('Progresso del ciclo')}</span><span className="tnum text-white">{c.progress.toFixed(0)}%</span></div>
        <ProgressBar value={c.progress} className="mt-2 h-1" />
      </div>
      <div className="flex flex-col">
        <KV k={c.probable_bottom ? t('Giorni dal minimo') : t('Giorni dal bottom')}>{int(c.days_since_bottom)}</KV>
        <KV k={t('Giorni dal top')}>{c.days_since_top != null ? int(c.days_since_top) : '—'}</KV>
        <KV k={t("Giorni dall'halving")}>{c.days_since_halving != null ? int(c.days_since_halving) : '—'}</KV>
        {c.probable_bottom && <KV k={t('Minimo probabile')}>{usd(c.probable_bottom.price)} <span className="text-slate-400">· {date(c.probable_bottom.time)} · {t('rimbalzo {v}', { v: pct(c.probable_bottom.rebound, 1) })}</span></KV>}
        {c.days_since_confirmed_bottom != null && c.probable_bottom && <KV k={t('Dal bottom confermato')}>{int(c.days_since_confirmed_bottom)} {dayUnit()}</KV>}
        {c.est_next_bottom && <KV k={c.bottom_window_kind === 'retest' ? t('Retest del minimo') : t('Prossimo minimo')}>{win(c.est_next_bottom)}</KV>}
        {c.est_next_top && <KV k={t('Prossimo top')}>{win(c.est_next_top)}</KV>}
      </div>
      {c.notes.length > 0 && (
        <div className="flex flex-col">
          <div className="label mb-1">{t('Note')}</div>
          <Bullets items={c.notes} />
        </div>
      )}
    </div>
  )
}

function CyclesTable({ d }: { d: Cycles }) {
  // below 1700px the half-width card cannot show 9 columns: the two phase durations (also in the chart below) are hidden
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>{t('Ciclo')}</th><th>Bottom</th><th>Top</th><th className="text-right">Bottom→Top</th><th className="text-right max-[1699px]:hidden">Halving→Top</th><th className="text-right max-[1699px]:hidden">Top→Bottom</th><th className="text-right">{t('Guadagno')}</th><th className="text-right">Drawdown</th><th>{t('Stato')}</th></tr></thead>
        <tbody>
          {d.cycles.map((c) => (
            <tr key={c.n}>
              <td className="text-white">{c.n}</td>
              <td>{date(c.bottom.time)} <span className="text-slate-400">{usdCompact(c.bottom.price, 1)}</span></td>
              <td>{c.top ? <>{date(c.top.time)} <span className="text-slate-400">{usdCompact(c.top.price, 1)}</span></> : '—'}</td>
              <td className="text-right">{c.days_bottom_to_top != null ? `${int(c.days_bottom_to_top)} ${dayUnit()}` : '—'}</td>
              <td className="text-right max-[1699px]:hidden">{c.days_halving_to_top != null ? `${int(c.days_halving_to_top)} ${dayUnit()}` : '—'}</td>
              <td className="text-right max-[1699px]:hidden">{c.days_top_to_bottom != null ? `${int(c.days_top_to_bottom)} ${dayUnit()}` : '—'}</td>
              <td className="text-right text-up">{pct(c.gain, 0)}</td>
              <td className="text-right text-down">{pct(c.drawdown, 1)}</td>
              <td className="text-slate-400">{c.status === 'in_progress' ? t('In corso') : t('Completo')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Distinct hue per metric (theme C palette) + solid bars for completed cycles, hatched/outlined bar for the estimate. */
const DUR_COLORS = [C.blue, C.purple, C.teal, C.amber, C.grey]
function DurationsChart({ d }: { d: Cycles }) {
  const option = useMemo(() => {
    const ns = [...new Set(d.durations_trend.flatMap((t) => t.values.map((v) => v.n)))].sort((a, b) => a - b)
    const next = (ns[ns.length - 1] ?? 0) + 1
    const cats = [...ns.map((n) => t('Ciclo {n}', { n })), t('Ciclo {n} (stima)', { n: next })]
    return {
      grid: { left: 8, right: 8, top: 36, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: d.durations_trend.map((x) => x.metric) },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => (v == null ? '—' : t('{n} giorni', { n: int(v) })) },
      xAxis: { type: 'category', data: cats, axisLabel, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: (v: number) => `${v}${dayUnit()}` } }),
      series: d.durations_trend.map((tr, i) => {
        const col = DUR_COLORS[i % DUR_COLORS.length]
        return {
          name: tr.metric, type: 'bar', barMaxWidth: 22, barGap: '18%', itemStyle: { color: col, borderRadius: [2, 2, 0, 0] },
          data: [...ns.map((n) => tr.values.find((v) => v.n === n)?.days ?? null),
            { value: tr.projected_next, itemStyle: { color: hexA(col, 0.22), borderColor: col, borderType: 'dashed', borderWidth: 1.25, borderRadius: [2, 2, 0, 0] } }],
          label: { show: false },
        }
      }),
    }
  }, [d])
  return <EChart option={option} height="100%" />
}

function OverlayChart({ d }: { d: Cycles }) {
  const [anchor, setAnchor] = useState<'bottom' | 'halving' | 'top'>('bottom')
  const [log, setLog] = useState(true)
  const ov = d.overlay.find((o) => o.anchor === anchor)
  const option = useMemo(() => {
    if (!ov) return {}
    const n = ov.series.length
    return {
      grid: { left: 8, right: 16, top: 36, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: ov.series.map((s) => s.name) },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => `<div style="color:#94a3b8;margin-bottom:4px">${t('Giorno {n}', { n: ps[0]?.value[0] })}</div>` + ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}</span><b>${p.value[1].toFixed(2)}×</b></div>`).join('') },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: { type: 'value', name: t('Giorni'), nameTextStyle: { color: C.muted }, axisLabel, splitLine: { show: false }, axisLine: { lineStyle: { color: C.axis } } },
      yAxis: valueAxis({ type: log ? 'log' : 'value', axisLabel: { ...axisLabel, formatter: (v: number) => `${axisNum(v)}×` } }),
      series: ov.series.map((s, i) => {
        const cur = i === n - 1
        const col = cur ? C.btc : [C.blue, C.purple, C.teal, C.grey, C.grey2][(n - 2 - i) % 5]
        return lineSeries(s.name, s.points.map((p) => [p.day, p.roi]), col, { lineStyle: { width: cur ? 2.6 : 1.4, color: col, opacity: cur ? 1 : 0.7 }, z: cur ? 10 : 2 })
      }),
    }
  }, [ov, log])
  return (
    <Card>
      <CardHeader title={t('Sovrapposizione cicli')} icon={<TrendingUp />} subtitle={t("Rendimento (x) dall'ancora scelta")} right={<>
        <Segmented value={anchor} onChange={setAnchor} options={[{ value: 'bottom', label: 'Bottom' }, { value: 'halving', label: 'Halving' }, { value: 'top', label: 'Top' }]} />
        <Toggle on={log} onClick={() => setLog(!log)}>Log</Toggle>
      </>} />
      <CardBody>{ov ? <EChart option={option} height={380} /> : <Skeleton className="h-[380px]" />}</CardBody>
    </Card>
  )
}

type ModelKey = 'power_law' | 'rainbow' | 'pi_cycle' | 'mayer' | 'two_year_ma'
const MODEL_LABEL: Record<ModelKey, string> = { power_law: 'Power Law', rainbow: 'Rainbow', pi_cycle: 'Pi Cycle Top', mayer: 'Mayer Multiple', two_year_ma: 'MA 2 anni' } // wrapped with t() at render

function ModelsChart({ d }: { d: Cycles }) {
  const [m, setM] = useState<ModelKey>('power_law')
  const [log, setLog] = useState(true)
  const M = d.models
  const option = useMemo(() => {
    const PRICE = t('Prezzo BTC')
    const price = lineSeries(PRICE, toXY(d.price_log), C.btc, { lineStyle: { width: 1.5, color: C.btc }, z: 10 })
    const series: unknown[] = []
    let y2 = false
    if (m === 'power_law') {
      series.push(
        lineSeries(t('Resistenza'), toXY(M.power_law.resistance), C.grey, { lineStyle: { width: 1.25, type: 'dashed', color: C.grey } }),
        lineSeries(t('Fair value'), toXY(M.power_law.fair), C.blue, { lineStyle: { width: 1.5, color: C.blue } }),
        lineSeries(t('Supporto'), toXY(M.power_law.support), C.grey2, { lineStyle: { width: 1.25, type: 'dashed', color: C.grey2 } }),
        price,
      )
    } else if (m === 'rainbow') {
      const floor: Pt[] = M.rainbow.floor ?? []
      const times = (floor.length ? floor : M.rainbow.bands[0]?.series ?? []).map((p) => p.time)
      const maps = M.rainbow.bands.map((b) => new Map(b.series.map((p) => [p.time, p.value])))
      const floorMap = new Map(floor.map((p) => [p.time, p.value]))
      series.push(lineSeries('_floor', times.map((t) => [t * 1000, floorMap.get(t) ?? null]), 'transparent', { stack: 'rb', lineStyle: { width: 0 }, tooltip: { show: false } }))
      M.rainbow.bands.forEach((b, i) => {
        const data = times.map((t) => {
          const up = maps[i].get(t)
          const lo = i === 0 ? floorMap.get(t) : maps[i - 1].get(t)
          return [t * 1000, up != null && lo != null ? up - lo : null]
        })
        series.push(lineSeries(b.name, data, SEQ_BLUE[Math.min(SEQ_BLUE.length - 1, 1 + Math.round((i * (SEQ_BLUE.length - 2)) / Math.max(1, M.rainbow.bands.length - 1)))], { stack: 'rb', lineStyle: { width: 0 }, areaStyle: { color: SEQ_BLUE[Math.min(SEQ_BLUE.length - 1, 1 + Math.round((i * (SEQ_BLUE.length - 2)) / Math.max(1, M.rainbow.bands.length - 1)))], opacity: 0.7 } }))
      })
      series.push(price)
    } else if (m === 'pi_cycle') {
      series.push(
        lineSeries('SMA 111', toXY(M.pi_cycle.sma111), C.cyan),
        lineSeries('SMA 350 × 2', toXY(M.pi_cycle.sma350x2), C.pink),
        { ...price, markLine: { symbol: 'none', silent: true, lineStyle: { color: 'rgba(148,163,184,0.5)', type: 'dashed' }, label: { color: C.text, formatter: t('Incrocio'), fontSize: 11 }, data: M.pi_cycle.crosses.map((t) => ({ xAxis: t * 1000 })) } },
      )
    } else if (m === 'mayer') {
      y2 = true
      series.push(price, lineSeries('Mayer Multiple', toXY(M.mayer.series), C.purple, {
        yAxisIndex: 1, lineStyle: { width: 1.4, color: C.purple },
        markLine: { symbol: 'none', silent: true, data: [{ yAxis: 2.4, lineStyle: { color: 'rgba(148,163,184,0.5)', type: 'dashed' }, label: { color: C.text, formatter: t('2.4 surriscaldato'), fontSize: 11, position: 'insideEndTop' } }, { yAxis: 1, lineStyle: { color: 'rgba(148,163,184,0.5)', type: 'dashed' }, label: { color: C.text, formatter: '1.0', fontSize: 11, position: 'insideEndTop' } }] },
      }))
    } else {
      series.push(
        lineSeries(t('MA 2 anni × 5'), toXY(M.two_year_ma.ma_x5), C.grey, { lineStyle: { width: 1.5, color: C.grey, type: 'dashed' } }),
        lineSeries(t('MA 2 anni'), toXY(M.two_year_ma.ma), C.blue, { lineStyle: { width: 1.5, color: C.blue } }),
        price,
      )
    }
    const legendNames = (series as { name: string }[]).map((s) => s.name).filter((n) => n !== '_floor')
    return {
      grid: { left: 8, right: 8, top: 36, bottom: 36, containLabel: true },
      legend: { ...legendBase, type: 'scroll', data: legendNames, pageTextStyle: { color: C.muted } },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => `<div style="color:#94a3b8;margin-bottom:4px">${dateFmt(ps[0]?.value[0])}</div>` +
          ps.filter((p) => p.seriesName !== '_floor' && p.value[1] != null && m !== 'rainbow' || p.seriesName === PRICE).map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}</span><b>${p.seriesName === 'Mayer Multiple' ? p.value[1].toFixed(2) : usd(p.value[1])}</b></div>`).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ type: log ? 'log' : 'value', axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
        ...(y2 ? [valueAxis({ position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(1) } })] : []),
      ],
      series,
    }
  }, [d, m, log, M])
  const info: Record<ModelKey, string> = {
    power_law: t('Fair value attuale {v} · deviazione {d}', { v: usd(M.power_law.current_fair), d: pct(M.power_law.deviation, 1) }),
    rainbow: t('Banda attuale: {b}', { b: M.rainbow.current_band }),
    pi_cycle: t("Distanza dall'incrocio: {v}", { v: pct(M.pi_cycle.distance, 1, false) }),
    mayer: t('Mayer Multiple attuale: {v}', { v: M.mayer.current.toFixed(2) }),
    two_year_ma: t('Sotto la MA 2 anni = zona di accumulo; sopra × 5 = zona di top'),
  }
  return (
    <Card>
      <CardHeader title={t('Modelli di valutazione')} icon={<LineChart />} subtitle={info[m]} right={<>
        <Segmented value={m} onChange={setM} options={(Object.keys(MODEL_LABEL) as ModelKey[]).map((k) => ({ value: k, label: t(MODEL_LABEL[k]) }))} />
        <Toggle on={log} onClick={() => setLog(!log)}>Log</Toggle>
      </>} />
      <CardBody><EChart option={option} height={460} /></CardBody>
    </Card>
  )
}

type Tab = 'overview' | 'clock' | 'miner' | 'compare' | 'leverage'
const TABS: { value: Tab; label: string; subtitle: string }[] = [
  { value: 'overview', label: 'Panoramica', subtitle: 'Halving, durate, proiezioni e modelli di lungo periodo.' },
  { value: 'clock', label: 'Orologio del ciclo', subtitle: 'Cycle Score 0–100 da 9 indicatori, con backtest sui cicli passati.' },
  { value: 'miner', label: 'Miner', subtitle: "Hash Ribbons, difficoltà e ricavi dei miner." },
  { value: 'compare', label: 'Confronto cicli', subtitle: "I cicli precedenti allo stesso punto del ciclo attuale." },
  { value: 'leverage', label: 'Leva', subtitle: 'Funding, perp/spot e open interest per fase del ciclo.' },
]

export default function CyclesPage() {
  const [tab, changeTab] = useTab<Tab>(TABS.map((x) => x.value), 'overview')
  const cur = TABS.find((x) => x.value === tab) ?? TABS[0]
  return (
    <div>
      <PageTitle title={t('Cicli')} subtitle={t(cur.subtitle)} />
      <TabBar tabs={TABS.map((x) => ({ value: x.value, label: t(x.label) }))} value={tab} onChange={changeTab} />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'clock' && <ClockTab />}
      {tab === 'miner' && <MinerTab />}
      {tab === 'compare' && <CompareTab />}
      {tab === 'leverage' && <LeverageTab />}
    </div>
  )
}

function OverviewTab() {
  const q = useCycles()
  return (
    <>
      <Q q={q} loading={<div className="grid gap-5"><Skeleton className="h-40" /><Skeleton className="h-96" /></div>}>
        {(d) => (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader title="Halving" icon={<CalendarClock />} updatedAt={q.dataUpdatedAt} />
              <CardBody><HalvingTimeline d={d} /></CardBody>
            </Card>
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-4">
                <CardHeader title={t('Ciclo attuale')} icon={<AlarmClock />} />
                <CardBody><CurrentStatus d={d} /></CardBody>
              </Card>
              <div className="flex flex-col gap-3 xl:col-span-8">
                <Card>
                  <CardHeader title={t('Cicli storici')} icon={<Table2 />} />
                  <CardBody className="px-2">{d.cycles.length ? <CyclesTable d={d} /> : <SkeletonBlock />}</CardBody>
                </Card>
                <Card className="flex-1">
                  <CardHeader title={t('Durata dei cicli')} icon={<Hourglass />} subtitle={t('Giorni per fase · barre tratteggiate = ciclo in corso (stima)')} info={t('Confronto delle durate per ciclo; un colore per metrica. Le barre tratteggiate sono la stima per il ciclo in corso, ottenuta dalla tendenza dei cicli precedenti.')} />
                  <CardBody className="flex flex-col"><Fill min={300}><DurationsChart d={d} /></Fill></CardBody>
                </Card>
              </div>
            </div>
            <OverlayChart d={d} />
            <ModelsChart d={d} />
          </div>
        )}
      </Q>
    </>
  )
}
