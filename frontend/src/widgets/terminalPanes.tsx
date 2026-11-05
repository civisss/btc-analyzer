/*
 * Pannelli sincronizzati del Terminale (stile Velo): CVD spot / perp / totale aggregati a candele, OI aggregato in coin a candele,
 * funding ponderato per OI (% su 8 h) e premio Coinbase a barre. Un grafico lightweight-charts per pannello, stessa griglia di
 * barre del grafico principale (indici logici allineati): zoom/pan e crosshair passano dal SyncBus. La barra in formazione arriva
 * dal WebSocket (delta relativo all'apertura -> candela del cumulato).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { LineStyle, type IChartApi, type ISeriesApi, type LogicalRange, type MouseEventParams, type SeriesType, type Time } from 'lightweight-charts'
import { createChart } from 'lightweight-charts'
import type { Group, PaneId, TermBar, TermSeries, TermTf } from '../api/terminal'
import { C, hexA } from '../components/charts/theme'
import { compact, dateTime } from '../lib/format'
import { t } from '../i18n'
import { TF_S, TZ, chartOptions, lt, type SyncBus } from './terminalChart'
import type { TermLive } from './terminalLive'

type N = number | null
export const PANE_META: Record<PaneId, { label: string; kind: 'candle' | 'hist'; info: string }> = {
  cvd_spot: { label: 'CVD spot aggregato', kind: 'candle', info: 'Delta cumulato (acquisti − vendite aggressivi, in BTC) di Binance, Coinbase, Bybit e OKX spot. Candele: apertura, massimo, minimo e chiusura del cumulato nella barra.' },
  cvd_perp: { label: 'CVD perp aggregato', kind: 'candle', info: 'Delta cumulato in BTC dei perpetual Binance USDⓈ-M, Bybit e OKX (contratti OKX convertiti: 1 contratto = 0.01 BTC).' },
  cvd_all: { label: 'CVD totale aggregato', kind: 'candle', info: 'Delta cumulato in BTC di tutti i 7 mercati (spot + perp).' },
  oi: { label: 'Open interest aggregato (BTC)', kind: 'candle', info: 'OI di Binance, Bybit e OKX (tutti i perpetual BTC inclusi) in BTC, campionato ogni 30 s; prima della raccolta: fotografie a 5 min e stima a 15 min (contratti USDT × fattore di scala).' },
  funding: { label: 'Funding ponderato per OI (8 h)', kind: 'hist', info: 'Funding dei tre exchange riportato a 8 ore e ponderato per l\'open interest in USD. Prima della raccolta: funding liquidato ogni 8 h attribuito al periodo in cui matura.' },
  premium: { label: 'Premio Coinbase', kind: 'hist', info: 'Coinbase BTC-USD rispetto a Binance BTCUSDT spot, in %: media per barra dei campioni al secondo (live) o delle chiusure 1m ufficiali (storico).' },
}
const GROUP_OF: Partial<Record<PaneId, Group>> = { cvd_spot: 'spot', cvd_perp: 'perp', cvd_all: 'all' }

const fmtCvd = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${compact(Math.abs(v), 1)}`
const fmtOi = (v: number) => compact(v, 1)
const fmtPct = (d: number) => (v: number) => `${v > 0 ? '' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`
const FMT: Record<PaneId, (v: number) => string> = { cvd_spot: fmtCvd, cvd_perp: fmtCvd, cvd_all: fmtCvd, oi: fmtOi, funding: fmtPct(4), premium: fmtPct(3) }

function ohlcOf(d: TermSeries, id: PaneId): { o: N[]; h: N[]; l: N[]; c: N[] } {
  const g = GROUP_OF[id]
  return g ? d.cvd[g] : d.oi
}

function Pane({ id, data, tf, live, sync, height, last }: { id: PaneId; data: TermSeries; tf: TermTf; live: TermLive; sync: SyncBus; height: number; last: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  const rt = useRef<{ chart: IChartApi; s: ISeriesApi<SeriesType> } | null>(null)
  const meta = PANE_META[id]
  const st = useRef({ data, tf, tArr: [] as number[], vals: [] as N[], base: null as null | { t: number; o: number }, cur: null as null | { t: number; o: number; h: number; l: number; c: number } })
  st.current.data = data; st.current.tf = tf
  const [val, setVal] = useState<{ v: N; hover: boolean; t: number | null }>({ v: null, hover: false, t: null })

  useEffect(() => {
    const e = el.current!
    const chart = createChart(e, chartOptions(e, FMT[id], last))
    chart.applyOptions({ rightPriceScale: { scaleMargins: { top: meta.kind === 'hist' ? 0.24 : 0.12, bottom: 0.08 } } })
    const s: ISeriesApi<SeriesType> = meta.kind === 'candle'
      ? chart.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
        priceFormat: { type: 'custom', formatter: FMT[id], minMove: 0.001 }, priceLineStyle: LineStyle.Dotted, priceLineColor: C.text })
      : chart.addHistogramSeries({ priceFormat: { type: 'custom', formatter: FMT[id], minMove: 0.00001 }, priceLineVisible: false, lastValueVisible: false, base: 0 })
    rt.current = { chart, s }
    const ro = new ResizeObserver(() => chart.applyOptions({ width: e.clientWidth, height: e.clientHeight }))
    ro.observe(e)
    const enter = () => { sync.active = id }
    e.addEventListener('pointerenter', enter, { capture: true, passive: true })
    e.addEventListener('wheel', enter, { capture: true, passive: true })
    e.addEventListener('touchstart', enter, { capture: true, passive: true })
    const onRange = (r: LogicalRange | null) => { if (r) sync.range(id, r) }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    const unsub = sync.on(id, (r) => chart.timeScale().setVisibleLogicalRange(r), (time) => {
      if (time == null) { chart.clearCrosshairPosition(); setVal((v) => ({ ...v, hover: false })); return }
      const i = st.current.tArr.indexOf(time)
      const v = i >= 0 ? st.current.vals[i] : null
      if (v != null) chart.setCrosshairPosition(v, lt(time), s)
      else chart.clearCrosshairPosition()
      setVal({ v, hover: true, t: time })
    })
    const onCross = (p: MouseEventParams<Time>) => {
      if (sync.active !== id) return
      const time = p.time != null ? (p.time as number) - TZ : null
      sync.cross(id, time)
      if (time == null) { setVal((v) => ({ ...v, hover: false })); return }
      const i = st.current.tArr.indexOf(time)
      setVal({ v: i >= 0 ? st.current.vals[i] : null, hover: true, t: time })
    }
    chart.subscribeCrosshairMove(onCross)
    if (sync.last) chart.timeScale().setVisibleLogicalRange(sync.last)
    return () => {
      unsub()
      chart.unsubscribeCrosshairMove(onCross)
      e.removeEventListener('pointerenter', enter, { capture: true })
      e.removeEventListener('wheel', enter, { capture: true })
      e.removeEventListener('touchstart', enter, { capture: true })
      ro.disconnect()
      chart.remove()
      rt.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { rt.current?.chart.applyOptions({ timeScale: { visible: last } }) }, [last])

  // dati storici
  useEffect(() => {
    const r = rt.current
    if (!r) return
    const s = st.current
    s.tArr = [...data.t]
    const pts: unknown[] = []
    const vals: N[] = []
    if (meta.kind === 'candle') {
      const x = ohlcOf(data, id)
      for (let i = 0; i < data.t.length; i++) {
        const o = x.o[i], h = x.h[i], l = x.l[i], c = x.c[i]
        vals.push(c)
        pts.push(o == null || h == null || l == null || c == null ? { time: lt(data.t[i]) } : { time: lt(data.t[i]), open: o, high: h, low: l, close: c })
      }
      // base della barra in formazione: apertura = chiusura del cumulato precedente
      const n = data.t.length - 1
      let prevC: number | null = null
      for (let i = n - 1; i >= 0; i--) if (x.c[i] != null) { prevC = x.c[i]; break }
      const o = x.o[n] ?? prevC
      s.base = o != null ? { t: data.t[n], o } : null
      s.cur = null
    } else {
      const arr = id === 'funding' ? data.f8 : data.pm
      for (let i = 0; i < data.t.length; i++) {
        const v = arr[i]
        vals.push(v)
        pts.push(v == null ? { time: lt(data.t[i]) } : { time: lt(data.t[i]), value: v, color: hexA(v >= 0 ? C.accent : C.steel, 0.5) })
      }
    }
    s.vals = vals
    r.s.setData(pts as never)
    // inizio della raccolta multi-exchange sui CVD (prima: solo Binance, dalle kline ufficiali)
    if (GROUP_OF[id] && data.multi_from) {
      const bt = Math.floor(data.multi_from / TF_S[tf]) * TF_S[tf]
      if (bt > data.t[0]) r.s.setMarkers([{ time: lt(bt), position: 'aboveBar', color: C.warn, shape: 'arrowDown', text: t('7 mercati') }])
      else r.s.setMarkers([])
    }
    if (sync.last) r.chart.timeScale().setVisibleLogicalRange(sync.last)
    let lastV: N = null
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) { lastV = vals[i]; break }
    setVal((v) => (v.hover ? v : { v: lastV, hover: false, t: null }))
  }, [data, tf]) // eslint-disable-line react-hooks/exhaustive-deps

  // barra in formazione (1/s)
  useEffect(() => {
    const onBar = (b: TermBar) => {
      const r = rt.current
      const s = st.current
      if (!r || b.tf !== s.tf || !s.tArr.length) return
      const lastT = s.tArr[s.tArr.length - 1]
      if (b.t < lastT) return
      if (b.t > lastT) {          // nuova barra: la precedente chiude dove era arrivata
        s.tArr.push(b.t)
        s.vals.push(null)
        if (meta.kind === 'candle') s.base = { t: b.t, o: s.cur?.c ?? s.base?.o ?? 0 }
      }
      let v: N = null
      const g = GROUP_OF[id]
      if (g && s.base) {
        const [d, hi, lo] = b.cvd[g]
        const o = s.base.o
        s.cur = { t: b.t, o, h: o + hi, l: o + lo, c: o + d }
        r.s.update({ time: lt(b.t), open: s.cur.o, high: s.cur.h, low: s.cur.l, close: s.cur.c } as never)
        v = s.cur.c
      } else if (id === 'oi' && b.oi) {
        r.s.update({ time: lt(b.t), open: b.oi[0], high: b.oi[1], low: b.oi[2], close: b.oi[3] } as never)
        v = b.oi[3]
      } else if ((id === 'funding' && b.f8 != null) || (id === 'premium' && b.pm != null)) {
        v = (id === 'funding' ? b.f8 : b.pm) as number
        r.s.update({ time: lt(b.t), value: v, color: hexA(v >= 0 ? C.accent : C.steel, 0.5) } as never)
      }
      if (v != null) {
        s.vals[s.vals.length - 1] = v
        setVal((x) => (x.hover ? x : { v, hover: false, t: null }))
      }
    }
    live.barListeners.add(onBar)
    return () => { live.barListeners.delete(onBar) }
  }, [live, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const unit = id.startsWith('cvd') || id === 'oi' ? ' BTC' : ''
  return (
    <div className="relative flex min-h-0 flex-col border-t border-line-subtle first:border-t-0" style={{ height }}>
      {/* right-0 + pr-20: the header can shrink (label truncates) and the value never wraps over the plot */}
      <div className="pointer-events-none absolute left-2 right-0 top-1 z-[2] flex min-w-0 items-baseline gap-2 pr-20">
        <span className="label min-w-0 truncate !text-fg-3">{t(meta.label)}</span>
        <span className={`tnum shrink-0 whitespace-nowrap text-xs font-semibold ${val.v == null ? 'text-fg-4' : id === 'oi' ? 'text-white' : meta.kind === 'hist' ? 'text-white' : val.v >= 0 ? 'text-up' : 'text-down'}`}>
          {val.v == null ? '—' : FMT[id](val.v) + unit}
        </span>
        {val.hover && val.t != null && <span className="tnum hidden text-2xs text-fg-4 sm:inline">{dateTime(val.t)}</span>}
      </div>
      <div ref={el} className="min-h-0 flex-1" />
    </div>
  )
}

export default function TerminalPanes({ data, tf, panes, live, sync, height }: { data: TermSeries; tf: TermTf; panes: PaneId[]; live: TermLive; sync: SyncBus; height: number }) {
  const list = useMemo(() => panes.filter((p) => p in PANE_META), [panes])
  const axis = 26
  const each = list.length ? Math.max(70, Math.floor((height - axis) / list.length)) : 0
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="term-panes">
      {list.map((p, i) => <Pane key={p} id={p} data={data} tf={tf} live={live} sync={sync} height={each + (i === list.length - 1 ? axis : 0)} last={i === list.length - 1} />)}
    </div>
  )
}
