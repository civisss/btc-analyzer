import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart, CrosshairMode, LineStyle, TickMarkType,
  type IChartApi, type ISeriesApi, type Time, type UTCTimestamp, type WhitespaceData, type LineData,
} from 'lightweight-charts'
import { live } from '../../api/live'
import type { VwapPanel, VwapSource } from '../../api/vwap'
import { cap, months } from '../../i18n'
import { clsx } from '../ui'
import { C, FONT, hexA } from './theme'
import { PILL_H, layoutPills, mix, priceTicks, timeTicks, usdP } from './vwapAxis'
import { T, alpha } from '../../theme/tokens'

/*
 * VWAP panel chart (lightweight-charts): candles of the panel timeframe, current-period VWAP (thick) with ±1σ / ±2σ bands,
 * previous-period VWAP (dashed) and ±1σ (dotted) that grow during the previous period and stay flat (extended) afterwards.
 * Times are UTC (calendar anchors are UTC). Price-axis labels are HTML "pills" (name + value) with collision avoidance.
 */

export type VwapHover = {
  time: number; open: number; high: number; low: number; close: number
  vwap: number | null; up1: number | null; dn1: number | null; pvwap: number | null; pup1: number | null; pdn1: number | null
}
type Bar = { time: number; open: number; high: number; low: number; close: number }
type Pill = { id: string; name: string; value: number; bg: string; fg: string; nameBg: string; nameFg: string; border: string }

const PREV = T.fg2
const PREV_DIM = T.fg3
const AXIS_W = 78
const p2 = (n: number) => String(n).padStart(2, '0')
/** Precise value with cents (header rows): $82,946.35 */
export const fmt2 = (p: number | null | undefined) => usdP(p, 2)

const baseOptions = {
  // axis labels are drawn as HTML (vwapAxis.ts): transparent here, crosshair labels keep their own colours
  layout: { background: { color: 'transparent' }, textColor: 'transparent', fontFamily: FONT, fontSize: 11, attributionLogo: false },
  grid: { vertLines: { color: alpha(T.fg3, 0.035) }, horzLines: { color: C.grid } },
  rightPriceScale: { borderColor: C.axis, scaleMargins: { top: 0.08, bottom: 0.06 }, minimumWidth: AXIS_W },
  timeScale: {
    borderColor: C.axis, rightOffset: 4, timeVisible: true, secondsVisible: false, minBarSpacing: 0.2,
    tickMarkFormatter: (t: Time, type: TickMarkType) => {
      const d = new Date((t as number) * 1000)
      if (type === TickMarkType.Year) return String(d.getUTCFullYear())
      if (type === TickMarkType.Month) return cap(months()[d.getUTCMonth()])
      if (type === TickMarkType.DayOfMonth) return String(d.getUTCDate())
      return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
    },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: alpha(T.fg3, 0.35), labelBackgroundColor: T.overlay, style: LineStyle.Dashed },
    horzLine: { color: alpha(T.fg3, 0.35), labelBackgroundColor: T.overlay, style: LineStyle.Dashed },
  },
  localization: {
    locale: 'en-US',
    timeFormatter: (t: Time) => {
      const d = new Date((t as number) * 1000)
      return `${d.getUTCDate()} ${months()[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`
    },
    priceFormatter: (p: number) => usdP(p),
  },
  handleScale: { axisPressedMouseMove: true },
}

const lineData = (t: number[], v: (number | null)[]): (LineData | WhitespaceData)[] =>
  t.map((x, i) => (v[i] == null ? { time: x as UTCTimestamp } : { time: x as UTCTimestamp, value: v[i] as number }))

export default function VwapChart({
  panel, color, tag, showBands, show2, showPrev, fitSignal, source, wheel = false, compact = false, onHover,
}: {
  panel: VwapPanel
  color: string
  tag: string
  showBands: boolean
  show2: boolean
  showPrev: boolean
  /** increment to reset the view (Fit chart) */
  fitSignal: number
  source: VwapSource
  wheel?: boolean
  /** narrow container: value pills only, no name pills */
  compact?: boolean
  onHover?: (h: VwapHover | null) => void
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const sRef = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lastBar = useRef<Bar | null>(null)
  const liveBar = useRef<Bar | null>(null)
  const viewKey = useRef<string>('')
  const nBars = useRef(0)
  const panelRef = useRef(panel)
  panelRef.current = panel
  const hoverRef = useRef(onHover)
  const compactRef = useRef(compact)
  compactRef.current = compact
  hoverRef.current = onHover
  const [pills, setPills] = useState<{ pill: Pill; y: number }[]>([])
  const [axisW, setAxisW] = useState(AXIS_W)
  const [ticks, setTicks] = useState<{ py: { y: number; label: string }[]; tx: { x: number; label: string; major: boolean }[]; axisY: number }>({ py: [], tx: [], axisY: 0 })
  const [livePx, setLivePx] = useState<number | null>(null)

  // ---------- create
  useEffect(() => {
    const el = elRef.current!
    const chart = createChart(el, { ...baseOptions, width: el.clientWidth, height: el.clientHeight })
    const cs = chart.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, lastValueVisible: false, priceLineVisible: false,
    })
    const mk = (opts: Parameters<IChartApi['addLineSeries']>[0]) =>
      chart.addLineSeries({ lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, ...opts })
    sRef.current = {
      pup1: mk({ color: hexA(PREV_DIM, 0.75), lineWidth: 1, lineStyle: LineStyle.SparseDotted }),
      pdn1: mk({ color: hexA(PREV_DIM, 0.75), lineWidth: 1, lineStyle: LineStyle.SparseDotted }),
      pvwap: mk({ color: PREV, lineWidth: 2, lineStyle: LineStyle.Dashed }),
      up2: mk({ color: hexA(color, 0.35), lineWidth: 1, lineStyle: LineStyle.Dashed }),
      dn2: mk({ color: hexA(color, 0.35), lineWidth: 1, lineStyle: LineStyle.Dashed }),
      up1: mk({ color: hexA(color, 0.6), lineWidth: 1 }),
      dn1: mk({ color: hexA(color, 0.6), lineWidth: 1 }),
      vwap: mk({ color, lineWidth: 2 }),
    }
    candleRef.current = cs
    chartRef.current = chart
    chart.subscribeCrosshairMove((p) => {
      const fn = hoverRef.current
      if (!fn) return
      const P = panelRef.current
      const i = p.time != null && P.candles ? P.candles.t.indexOf(p.time as number) : -1
      if (i < 0 || !P.candles) { fn(null); return }
      const c = P.candles
      fn({ time: c.t[i], open: c.o[i], high: c.h[i], low: c.l[i], close: c.c[i], vwap: P.lines.vwap[i], up1: P.lines.up1[i], dn1: P.lines.dn1[i],
        pvwap: P.lines.pvwap[i], pup1: P.lines.pup1[i], pdn1: P.lines.pdn1[i] })
    })
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      sRef.current = {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    chartRef.current?.applyOptions({
      handleScroll: { mouseWheel: wheel, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: wheel, pinch: true, axisPressedMouseMove: true },
    })
  }, [wheel])

  useEffect(() => {
    const s = sRef.current
    s.vwap?.applyOptions({ color })
    s.up1?.applyOptions({ color: hexA(color, 0.6), visible: showBands })
    s.dn1?.applyOptions({ color: hexA(color, 0.6), visible: showBands })
    s.up2?.applyOptions({ color: hexA(color, 0.35), visible: show2 })
    s.dn2?.applyOptions({ color: hexA(color, 0.35), visible: show2 })
    for (const k of ['pvwap', 'pup1', 'pdn1']) s[k]?.applyOptions({ visible: showPrev })
  }, [color, showBands, show2, showPrev])

  // ---------- default view: W = current week + context, M/Q/Y = everything (previous period included)
  const applyView = () => {
    const chart = chartRef.current
    const P = panelRef.current
    if (!chart || !P.candles || !P.candles.t.length) return
    const t = P.candles.t
    const n = t.length
    // empty bars on the right so the last candles stay clear of the name pills (~90 px)
    const plotW = Math.max(200, (elRef.current?.clientWidth ?? 600) - chart.priceScale('right').width())
    const padPx = compactRef.current ? 8 : 90
    const rightPad = (from: number) => Math.max(3, (padPx * (n - 1 - from)) / (plotW - padPx))
    if (P.id === 'w') {
      const end = t[n - 1] + P.tf
      const from = P.anchor - Math.max(6 * 3600, 0.2 * (end - P.anchor))
      let i = t.findIndex((x) => x >= from)
      if (i < 0) i = 0
      i = Math.min(i, Math.max(0, n - 120))
      chart.timeScale().setVisibleLogicalRange({ from: i, to: n - 1 + rightPad(i) })
    } else {
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: n - 1 + rightPad(0) })
    }
  }

  // ---------- data
  const ld = useMemo(() => {
    const c = panel.candles
    if (!c) return null
    const t = c.t
    const L = panel.lines
    const up2 = L.vwap.map((v, i) => (v == null || L.up1[i] == null ? null : v + 2 * ((L.up1[i] as number) - v)))
    const dn2 = L.vwap.map((v, i) => (v == null || L.dn1[i] == null ? null : v - 2 * (v - (L.dn1[i] as number))))
    return {
      bars: t.map((x, i) => ({ time: x as UTCTimestamp, open: c.o[i], high: c.h[i], low: c.l[i], close: c.c[i] })),
      lines: {
        vwap: lineData(t, L.vwap), up1: lineData(t, L.up1), dn1: lineData(t, L.dn1), up2: lineData(t, up2), dn2: lineData(t, dn2),
        pvwap: lineData(t, L.pvwap), pup1: lineData(t, L.pup1), pdn1: lineData(t, L.pdn1),
      },
    }
  }, [panel])

  useEffect(() => {
    const chart = chartRef.current
    const cs = candleRef.current
    if (!chart || !cs || !ld) return
    const ts = chart.timeScale()
    const before = ts.getVisibleLogicalRange()
    const prevN = nBars.current
    cs.setData(ld.bars)
    for (const [k, data] of Object.entries(ld.lines)) sRef.current[k]?.setData(data)
    const n = ld.bars.length
    nBars.current = n
    const last = ld.bars[n - 1]
    lastBar.current = last ? { time: last.time as number, open: last.open, high: last.high, low: last.low, close: last.close } : null
    // live bar newer than the server data (in-progress minute): keep its extremes
    const lb = liveBar.current
    if (lb && lastBar.current && lb.time >= lastBar.current.time) {
      const m = lb.time === lastBar.current.time
        ? { ...lastBar.current, high: Math.max(lastBar.current.high, lb.high), low: Math.min(lastBar.current.low, lb.low), close: lb.close }
        : lb
      try { cs.update({ ...m, time: m.time as UTCTimestamp }); lastBar.current = m } catch { /* ignore */ }
    }
    const key = `${panel.id}|${panel.source}|${panel.calc}`
    if (viewKey.current !== key) {
      viewKey.current = key
      // after the first render lightweight-charts applies its default bar spacing: set the view on the next frame
      requestAnimationFrame(() => requestAnimationFrame(applyView))
    } else if (before) {
      // keep the user's view; if it was pinned to the right edge, follow the new bars
      const shift = before.to >= prevN - 2 ? n - prevN : 0
      ts.setVisibleLogicalRange({ from: before.from + shift, to: before.to + shift })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ld])

  useEffect(() => {
    if (viewKey.current) applyView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact])

  useEffect(() => {
    if (fitSignal) applyView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal])

  // ---------- live forming candle (Kraken trades / Binance perp 1m kline)
  useEffect(() => {
    setLivePx(null)
    liveBar.current = null
    const onTick = (price: number, hi: number, lo: number, ts: number) => {
      const cs = candleRef.current
      const last = lastBar.current
      const tf = panelRef.current.tf
      if (!cs || !last || panelRef.current.source !== source) return
      let bar: Bar
      if (ts >= last.time + tf) {
        const t0 = ts - (ts % tf)
        bar = { time: t0, open: last.close, high: Math.max(hi, price, last.close), low: Math.min(lo, price, last.close), close: price }
      } else if (ts >= last.time) {
        bar = { ...last, high: Math.max(last.high, hi, price), low: Math.min(last.low, lo, price), close: price }
      } else return
      try {
        cs.update({ ...bar, time: bar.time as UTCTimestamp })
        lastBar.current = bar
        liveBar.current = bar
        setLivePx(price)
      } catch { /* out of order */ }
    }
    if (source === 'kraken') return live.onVwapTick((m) => onTick(m.price, m.high, m.low, m.time))
    return live.onPerpKline((m) => onTick(m.candle.close, m.candle.high, m.candle.low, m.candle.time))
  }, [source])

  // ---------- price-axis pills (positions follow zoom/scroll/autoscale: checked every frame, state only on change)
  const pillDefs = useMemo<Pill[]>(() => {
    const L = panel.levels
    const out: Pill[] = []
    const cur = (id: string, name: string, v: number | null, strong: boolean) => {
      if (v != null) out.push({ id, name, value: v, bg: strong ? color : mix(color, 0.78), fg: T.bg, nameBg: mix(color, 0.16), nameFg: color, border: hexA(color, 0.4) })
    }
    const prev = (id: string, name: string, v: number | null, strong: boolean) => {
      if (v != null) out.push({ id, name, value: v, bg: strong ? T.fg : T.fg3, fg: T.bg, nameBg: mix(T.fg3, 0.16), nameFg: strong ? T.fg : T.fg2, border: alpha(T.fg3, 0.3) })
    }
    const p = `p${tag}`
    if (showPrev) {
      prev('pvwap', `${p} VWAP`, L.prev.vwap, true)
      if (showBands) { prev('pup1', `${p} +1σ`, L.prev.up1, false); prev('pdn1', `${p} −1σ`, L.prev.dn1, false) }
    }
    if (show2) { cur('up2', `${tag} +2σ`, L.up2, false); cur('dn2', `${tag} −2σ`, L.dn2, false) }
    if (showBands) { cur('up1', `${tag} +1σ`, L.up1, false); cur('dn1', `${tag} −1σ`, L.dn1, false) }
    cur('vwap', `${tag} VWAP`, L.vwap, true)
    // narrow panels: value pills only (colour = series), so the candles keep the plot width
    return compact ? out.map((x) => ({ ...x, name: '' })) : out
  }, [panel.levels, color, tag, showBands, show2, showPrev, compact])

  useEffect(() => {
    let raf = 0
    let lastSig = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (document.visibilityState !== 'visible') return
      const chart = chartRef.current
      const cs = candleRef.current
      const el = elRef.current
      if (!chart || !cs || !el) return
      const h = el.clientHeight - chart.timeScale().height()
      const w = chart.priceScale('right').width()
      const px = lastBar.current?.close
      const defs = [...pillDefs]
      if (px != null) {
        const up = lastBar.current ? lastBar.current.close >= lastBar.current.open : true
        defs.push({ id: 'price', name: '', value: px, bg: up ? C.up : C.down, fg: T.bg, nameBg: '', nameFg: '', border: 'transparent' })
      }
      const items = defs.map((d) => ({ pill: d, y: cs.priceToCoordinate(d.value) ?? -9999 }))
      const lay = layoutPills(items, h).map((i) => ({ ...i, pill: i.off ? { ...i.pill, name: `${i.off < 0 ? '▲' : '▼'} ${i.pill.name}`.trim() } : i.pill }))
      const py = priceTicks(cs, h, lay.map((i) => i.y))
      const P = panelRef.current
      const tx = P.candles ? timeTicks(chart, P.candles.t, P.tf, el.clientWidth - w) : []
      const sig = `${w}|${h}|` + lay.map((i) => `${i.pill.id}:${Math.round(i.y)}:${i.pill.value}`).join(',') + '|' + py.map((x) => Math.round(x.y)).join(',') + '|' + tx.map((x) => Math.round(x.x)).join(',')
      if (sig !== lastSig) {
        lastSig = sig
        setPills(lay)
        setAxisW(w)
        setTicks({ py, tx, axisY: h })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pillDefs, livePx])

  return (
    <div className="relative h-full w-full">
      <div ref={elRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-0 z-[4] overflow-hidden text-[11px] text-fg-4" aria-hidden>
        {ticks.py.map((tk) => (
          <span key={`p${tk.label}`} className="tnum absolute right-0 -translate-y-1/2 pr-2 text-right" style={{ top: tk.y, width: axisW }}>{tk.label}</span>
        ))}
        {ticks.tx.map((tk) => (
          <span key={`t${tk.x}`} className={clsx('tnum absolute -translate-x-1/2 whitespace-nowrap', tk.major && 'font-medium text-fg-2')} style={{ left: tk.x, top: ticks.axisY + 7 }}>{tk.label}</span>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-hidden>
        {pills.map(({ pill, y }) => (
          <div key={pill.id} className="tnum absolute right-0 flex items-stretch text-[10px] font-medium leading-none" style={{ top: y - PILL_H / 2, height: PILL_H }}>
            {pill.name && (
              <span className="mr-px flex items-center whitespace-nowrap rounded-l-[4px] px-1.5" style={{ background: pill.nameBg, color: pill.nameFg, boxShadow: `inset 0 0 0 1px ${pill.border}` }}>
                {pill.name}
              </span>
            )}
            <span className={pill.name ? 'flex items-center justify-end rounded-r-[4px] px-1.5' : 'flex items-center justify-end rounded-[4px] px-1.5'}
              style={{ background: pill.bg, color: pill.fg, width: axisW }}>
              {usdP(pill.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
