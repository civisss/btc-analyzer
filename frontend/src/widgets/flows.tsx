/* Flussi spot vs futures: card per la dashboard + sezione completa per la pagina Derivati. */
import { useMemo, useState, type ReactNode } from 'react'
import { Activity, ArrowLeftRight, BarChart3, Compass, Crown, LineChart, Link2, ShoppingCart, Signal, Table2, Timer } from 'lucide-react'
import { t, tfLabel, tr } from '../i18n'
import { useFlows, useLiveFlow, type FlowRange, type FlowTf, type FlowWindow, type FlowWindowLabel, type Flows } from '../api/flows'
import EChart from '../components/charts/EChart'
import { C, axisLabel, dataZoomInside, dataZoomSlider, dateFmt, hexA, timeAxis, tooltipBase, valueAxis } from '../components/charts/theme'
import { Card, CardBody, CardHeader, Change, EmptyState, Fill, KpiCell, KpiStrip, MethodNote, Q, Segmented, Skeleton, ToneBadge, clsx } from '../components/ui'
import { TONE_LABEL, usd, usdCompact } from '../lib/format'
import { TimeLinesChart } from './charts'

// ------------------------------------------------------------------ helpers
const signedUsd = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${usdCompact(v, d)}`.replace(/\.0(?=[KMBT])/, ''))
const deltaCls = (v: number | null | undefined) => (v == null ? 'text-fg-3' : v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-fg-2')
/** '7d' → '7G' (IT) / '7D' (EN): the shared timeframe label */
const winLabel = (l: string) => tfLabel(l)
const WINDOW_VALUES: FlowWindowLabel[] = ['1h', '4h', '24h', '7d', '30d']
const windowOpts = () => WINDOW_VALUES.map((v) => ({ value: v, label: winLabel(v) }))

/** Tone as a dot + word, then the text: one row per signal (no tinted backgrounds). */
export function SignalList({ signals }: { signals: { text: string; tone: string }[] }) {
  if (!signals.length) return <EmptyState text={t('Nessun segnale')} compact />
  return (
    // rows share the card height when the card is stretched next to a chart (few signals: no blank bottom)
    <ul className="flex flex-1 flex-col">
      {signals.map((s, i) => (
        <li key={i} className="flex flex-1 flex-col justify-center gap-1 border-t border-line py-2.5 first:border-t-0 first:pt-0">
          <ToneBadge tone={s.tone} className="self-start" />
          <p className="line-clamp-2 text-sm text-fg-2" title={s.text}>{s.text}</p>
        </li>
      ))}
    </ul>
  )
}

/** One-line reading of a window: "24h: spot +$8M, perp −$446M. Domanda spot, leva in uscita." */
export function flowSummary(label: string, spot: number | null | undefined, perp: number | null | undefined): string {
  const head = `${winLabel(label)}: spot ${signedUsd(spot, 0)}, perp ${signedUsd(perp, 0)}.`
  if (spot == null || perp == null) return head
  const read = spot >= 0
    ? (perp >= 0 ? t('Acquisti su spot e futures.') : t('Domanda spot, leva in uscita.'))
    : (perp >= 0 ? t('Vendite spot, leva in entrata.') : t('Vendite su spot e futures.'))
  return `${head} ${read}`
}

/** Horizontal buy/sell pressure bar: share of aggressive buys vs sells. */
export function PressureBar({ label, buyPct, delta }: { label: string; buyPct: number | null; delta: number | null }) {
  const b = buyPct == null ? 50 : Math.max(0, Math.min(100, buyPct))
  return (
    <div>
      <div className="flex h-5 items-center justify-between gap-2 text-sm">
        <span className="font-medium text-fg">{label}</span>
        <span className={clsx('tnum font-medium', deltaCls(delta))}>{signedUsd(delta)}</span>
      </div>
      <div className="relative mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full bg-up/70 transition-[width] duration-700" style={{ width: `${b}%` }} />
        <div className="h-full flex-1 bg-down/60" />
        <span className="absolute inset-y-0 left-1/2 w-px bg-bg" />
      </div>
      <div className="tnum mt-1 flex justify-between text-xs text-fg-3">
        <span>{t('Acquisti')} {buyPct == null ? '—' : `${b.toFixed(1)}%`}</span>
        <span>{t('Vendite')} {buyPct == null ? '—' : `${(100 - b).toFixed(1)}%`}</span>
      </div>
    </div>
  )
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-t border-line text-sm">
      <span className="text-fg-3">{k}</span>
      <span className="tnum whitespace-nowrap text-fg">{children}</span>
    </div>
  )
}

// ------------------------------------------------------------------ dashboard card
export function FlowsCard() {
  const [win, setWin] = useState<FlowWindowLabel>('24h')
  const q = useFlows('1h', '30d')
  const lf = useLiveFlow()
  const liveFull = lf.minutes >= 60 && !!lf.spot && !!lf.perp
  return (
    <Card className="h-full">
      <CardHeader title={t('Flussi spot vs futures')} subtitle={t('Flussi taker · Binance')} icon={<ArrowLeftRight />}
        info={t('Taker = ordini aggressivi a mercato. Netto = acquisti aggressivi − vendite aggressive, in dollari. Perp/spot = rapporto tra i volumi dei futures perpetui e dello spot.')}
        right={<Segmented value={win} onChange={setWin} options={windowOpts()} />} />
      <CardBody className="flex flex-col gap-4">
        <Q q={q} loading={<div className="flex flex-col gap-3"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-16" /></div>}
          isEmpty={(d) => !d.windows.length} empty={t('Flussi non disponibili')}>
          {(d) => {
            const w = d.windows.find((x) => x.label === win) ?? d.windows[0]
            const useLive = win === '1h' && liveFull
            const spotDelta = useLive ? lf.spot!.delta : w.spot_delta
            const perpDelta = useLive ? lf.perp!.delta : w.perp_delta
            const spotBuy = useLive ? lf.spot!.buyPct : w.spot_buy_pct
            const perpBuy = useLive ? lf.perp!.buyPct : w.perp_buy_pct
            const ratio = useLive && lf.spot!.volume > 0 ? lf.perp!.volume / lf.spot!.volume : w.perp_spot_ratio
            return (
              <>
                <p className="text-sm text-fg-2">{flowSummary(w.label, spotDelta, perpDelta)}</p>
                <PressureBar label="Spot" buyPct={spotBuy} delta={spotDelta} />
                <PressureBar label={t('Futures (perp)')} buyPct={perpBuy} delta={perpDelta} />
                {/* rows stretch to the card height so the card matches its row neighbours without a blank bottom */}
                <div className="flex flex-1 flex-col [&>*]:flex-1">
                  <KV k="Perp / spot">{ratio.toFixed(1)}×</KV>
                  <KV k={t('Prezzo {w}', { w: winLabel(w.label) })}><Change value={w.price_change} digits={2} /></KV>
                  <KV k={t('Bias spot')}>{TONE_LABEL[d.current.bias] ?? d.current.bias}</KV>
                  <KV k={t('Ultimi 60 min (live)')}>
                    {lf.minutes > 0 ? (
                      <>Spot <span className={deltaCls(lf.spot?.delta)}>{signedUsd(lf.spot?.delta)}</span> · perp <span className={deltaCls(lf.perp?.delta)}>{signedUsd(lf.perp?.delta)}</span>{lf.minutes < 60 && <span className="text-fg-3"> · {lf.minutes}/60 min</span>}</>
                    ) : <span className="text-fg-3">{t('In attesa dello stream…')}</span>}
                  </KV>
                </div>
              </>
            )
          }}
        </Q>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ full section (Derivati → Spot vs Futures)
const tfOpts = (): { value: FlowTf; label: string }[] => [{ value: '1h', label: '1h' }, { value: '4h', label: '4h' }, { value: '1d', label: tfLabel('1d') }]
const rangeOpts = (): { value: FlowRange; label: string }[] => {
  const Y = tr('A', 'Y')
  return [
    { value: '1d', label: tfLabel('1d') }, { value: '3d', label: tfLabel('3d') }, { value: '7d', label: tfLabel('7d') }, { value: '30d', label: tfLabel('30d') }, { value: '90d', label: tfLabel('90d') }, { value: '1y', label: `1${Y}` }, { value: '3y', label: `3${Y}` },
  ]
}
/** sensible range for each tf (keeps the number of candles reasonable) */
const RANGES_FOR: Record<FlowTf, FlowRange[]> = { '1h': ['1d', '3d', '7d', '30d'], '4h': ['7d', '30d', '90d'], '1d': ['90d', '1y', '3y'] }

function DeltaBarsChart({ d }: { d: Flows }) {
  const option = useMemo(() => {
    const spot = d.series.map((p) => [p.time * 1000, p.spot_delta])
    const perp = d.series.map((p) => [p.time * 1000, p.perp_delta])
    const color = (p: { value: [number, number] }) => (p.value[1] >= 0 ? hexA(C.up, 0.75) : hexA(C.down, 0.75))
    const fmt = (v: number) => usdCompact(v, 0)
    return {
      grid: [{ left: 8, right: 8, top: 26, height: '36%', containLabel: true }, { left: 8, right: 8, top: '55%', bottom: 36, containLabel: true }],
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => `<div style="color:${C.muted};margin-bottom:4px">${dateFmt(ps[0]?.value[0])}</div>` +
          ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.seriesName}</span><b style="font-variant-numeric:tabular-nums;color:${p.value[1] >= 0 ? C.up : C.down}">${signedUsd(p.value[1])}</b></div>`).join(''),
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      dataZoom: [{ ...dataZoomInside, xAxisIndex: [0, 1] }, { ...dataZoomSlider, xAxisIndex: [0, 1] }],
      title: [
        { text: t('Netto spot'), right: 12, top: 26, textStyle: { color: C.muted, fontSize: 11, fontWeight: 500 } },
        { text: t('Netto futures (perp)'), right: 12, top: '55%', textStyle: { color: C.muted, fontSize: 11, fontWeight: 500 } },
      ],
      xAxis: [timeAxis({ gridIndex: 0, axisLabel: { show: false } }), timeAxis({ gridIndex: 1 })],
      yAxis: [
        valueAxis({ gridIndex: 0, scale: false, axisLabel: { ...axisLabel, formatter: fmt } }),
        valueAxis({ gridIndex: 1, scale: false, axisLabel: { ...axisLabel, formatter: fmt } }),
      ],
      series: [
        { name: 'Spot', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, data: spot, barMaxWidth: 8, itemStyle: { color } },
        { name: 'Futures', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: perp, barMaxWidth: 8, itemStyle: { color } },
      ],
    }
  }, [d])
  return <EChart option={option} height="100%" />
}

function WindowsTable({ rows }: { rows: FlowWindow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('Finestra')}</th><th className="text-right">{t('Netto spot')}</th><th className="text-right">{t('Netto perp')}</th>
            <th className="text-right">{t('Acquisti spot')}</th><th className="text-right">{t('Acquisti perp')}</th><th className="text-right">Perp/spot</th><th className="text-right">{t('Prezzo')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.label}>
              <td className="font-semibold text-white">{winLabel(w.label)}</td>
              <td className={clsx('text-right font-medium', deltaCls(w.spot_delta))}>{signedUsd(w.spot_delta)}</td>
              <td className={clsx('text-right font-medium', deltaCls(w.perp_delta))}>{signedUsd(w.perp_delta)}</td>
              <td className="text-right">{w.spot_buy_pct.toFixed(1)}%</td>
              <td className="text-right">{w.perp_buy_pct.toFixed(1)}%</td>
              <td className="text-right">{w.perp_spot_ratio.toFixed(1)}×</td>
              <td className="text-right"><Change value={w.price_change} digits={2} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function FlowsSection() {
  const [tf, setTf] = useState<FlowTf>('1h')
  const [range, setRange] = useState<FlowRange>('7d')
  const changeTf = (t: FlowTf) => { setTf(t); if (!RANGES_FOR[t].includes(range)) setRange(RANGES_FOR[t][Math.min(1, RANGES_FOR[t].length - 1)]) }
  const q = useFlows(tf, range)
  const lf = useLiveFlow()
  const cvdLines = useMemo(() => {
    const s = q.data?.series ?? []
    return [
      { name: 'CVD spot', data: s.map((p) => ({ time: p.time, value: p.spot_cvd })), color: C.accent, width: 1.5, area: true },
      { name: 'CVD futures', data: s.map((p) => ({ time: p.time, value: p.perp_cvd })), color: C.steel, width: 1.5 },
      { name: t('Prezzo BTC'), data: s.map((p) => ({ time: p.time, value: p.price })), color: C.price, axis: 1 as const, width: 1.4, dashed: true },
    ]
  }, [q.data])
  const controls = (
    <>
      <span className="flex items-center gap-2"><span className="label">{t('Candela')}</span><Segmented value={tf} onChange={changeTf} options={tfOpts()} /></span>
      <span className="flex items-center gap-2"><span className="label">{tr('Periodo', 'Range')}</span><Segmented value={range} onChange={setRange} options={rangeOpts().filter((o) => RANGES_FOR[tf].includes(o.value))} /></span>
    </>
  )
  return (
    <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[420px]" /></div>} isEmpty={(d) => !d.series.length} empty={t('Flussi non disponibili')}>
      {(d) => {
        const w24 = d.windows.find((w) => w.label === '24h')
        return (
          <div className="flex flex-col gap-3">
            <KpiStrip>
              <KpiCell icon={<ShoppingCart />} label={t('Acquisti spot 24h')} value={`${d.current.spot_buy_pct_24h.toFixed(1)}%`} delta={<><span className="text-fg-3">{t('Netto')}</span> <span className={deltaCls(w24?.spot_delta)}>{signedUsd(w24?.spot_delta)}</span></>} />
              <KpiCell icon={<Activity />} label={t('Acquisti perp 24h')} value={`${d.current.perp_buy_pct_24h.toFixed(1)}%`} delta={<><span className="text-fg-3">{t('Netto')}</span> <span className={deltaCls(w24?.perp_delta)}>{signedUsd(w24?.perp_delta)}</span></>} />
              <KpiCell icon={<Crown />} label={t('Mercato dominante')} value={d.current.dominant === 'perp' ? 'Futures' : 'Spot'} foot={`Perp/spot ${w24 ? `${w24.perp_spot_ratio.toFixed(1)}×` : '—'}`} />
              <KpiCell icon={<Compass />} label={t('Bias spot')} value={TONE_LABEL[d.current.bias] ?? d.current.bias} foot={t('Da flussi spot e perp')} />
              <KpiCell icon={<Link2 />} label={t('Correlazione delta')} value={d.delta_correlation != null ? d.delta_correlation.toFixed(2) : '—'} foot={t('Spot vs perp')} />
              <KpiCell icon={<Timer />} label={t('Ultimi 60 min (live)')} value={<span className={deltaCls(lf.spot?.delta)}>{signedUsd(lf.spot?.delta)}</span>}
                foot={<>Perp <span className={deltaCls(lf.perp?.delta)}>{signedUsd(lf.perp?.delta)}</span>{lf.minutes > 0 && lf.minutes < 60 ? ` · ${lf.minutes}/60 min` : ''}</>} />
            </KpiStrip>
            {w24 && <p className="text-sm text-fg-2">{flowSummary('24h', w24.spot_delta, w24.perp_delta)}</p>}
            <div className="grid gap-3 xl:grid-cols-2">
              <Card className="h-full">
                <CardHeader title={t('CVD spot vs futures')} subtitle={t("Delta cumulato taker · prezzo sull'asse destro")} icon={<LineChart />} updatedAt={q.dataUpdatedAt} right={controls} />
                <CardBody className="flex flex-col"><Fill min={380}><TimeLinesChart height="100%" lines={cvdLines} yFmt={(v) => usdCompact(v, 1)} y2Fmt={(v) => usdCompact(v, 0)} zoom compactTip={tf !== '1d'} /></Fill></CardBody>
              </Card>
              <Card className="h-full">
                <CardHeader title={t('Netto per candela')} subtitle={t('Acquisti − vendite taker · spot sopra, futures sotto')} icon={<BarChart3 />} />
                <CardBody className="flex flex-col"><Fill min={380}><DeltaBarsChart d={d} /></Fill></CardBody>
              </Card>
            </div>
            <div className="grid gap-3 xl:grid-cols-12">
              <Card className="h-full xl:col-span-7">
                <CardHeader title={t('Finestre temporali')} icon={<Table2 />} subtitle={t('Ultimo prezzo {p}', { p: usd(d.series[d.series.length - 1]?.price) })} />
                <CardBody className="px-2"><WindowsTable rows={d.windows} /></CardBody>
              </Card>
              <Card className="h-full xl:col-span-5">
                <CardHeader title={t('Segnali')} icon={<Signal />} />
                <CardBody className="pt-0"><SignalList signals={d.signals} /></CardBody>
              </Card>
            </div>
            <MethodNote>
              <p>{d.note}</p>
              <p>{t('Il valore live a 60 minuti è calcolato nel browser dalle candele a 1 minuto dello stream (spot e perpetual): netto = (2 × acquisti taker − volume) × prezzo.')}</p>
            </MethodNote>
          </div>
        )
      }}
    </Q>
  )
}

