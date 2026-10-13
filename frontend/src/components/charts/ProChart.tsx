import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart, CrosshairMode, LineStyle, PriceScaleMode, TickMarkType,
  type IChartApi, type ISeriesApi, type IPriceLine, type SeriesMarker, type Time, type UTCTimestamp, type LogicalRange, type Logical,
} from 'lightweight-charts'
import type { Candle, Pt } from '../../api/types'
import { live, type LiveTf } from '../../api/live'
import { pct, usd } from '../../lib/format'
import { C, FONT, usdAxis } from './theme'
export { usdAxis }
import { cap, months, t, tfIn, tr } from '../../i18n'

// lightweight-charts renders timestamps as UTC; shift to the viewer's local time.
const TZ = -new Date().getTimezoneOffset() * 60
export const lt = (t: number) => (t + TZ) as UTCTimestamp
const fromLt = (t: number) => t - TZ

export type LineDef = { id: string; data: Pt[]; color: string; width?: number; dashed?: boolean; title?: string }
export type PriceLineDef = { price: number; color: string; title?: string; dashed?: boolean; width?: number }
export type MarkerDef = { time: number; position: 'aboveBar' | 'belowBar' | 'inBar'; color: string; shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'; text?: string; size?: number }
/** HTML overlay marker: a numbered circle anchored to (time, price); `above`/`below` offset it off the candle. */
export type OverlayMarkerDef = { id: string; time: number; price: number; label: string; position?: 'above' | 'below' | 'at'; title?: string; sub?: string }
export type ZoneDef = { low: number; high: number; color: string; label?: string }
export type PaneSeries = { id: string; type: 'line' | 'histogram'; data: Pt[]; color: string; colorFn?: (v: number) => string; width?: number }
export type PaneDef = { id: string; title: string; height: number; series: PaneSeries[]; levels?: { value: number; color: string }[] }
/**
 * User drawing (journal annotations) rendered as an SVG overlay. Times may fall between bars or in the future (interpolated on
 * the bar grid). hline: points[0].price · vline: points[0].time · text: points[0] time+price · trendline: 2 points (`extend` → ray).
 */
export type ChartAnnotationDef = {
  id: string; kind: 'hline' | 'trendline' | 'vline' | 'text'; points: { time: number | null; price: number | null }[]
  color: string; text?: string; extend?: boolean; selected?: boolean
}
/** A point picked on the chart (click): bar time (or extrapolated future time) + price at the cursor. */
export type ChartPoint = { time: number; price: number }

// Same theme as the ECharts charts (theme.ts): horizontal hairline grid only, grey dashed crosshair, raised labels.
const NO_OVERLAY: OverlayMarkerDef[] = []
const LEVEL_COLOR = 'rgba(148,163,184,0.45)'
const MARKER_COLOR = '#8B94A7'
const baseOptions = {
  layout: { background: { color: 'transparent' }, textColor: C.muted, fontFamily: FONT, fontSize: 11 },
  grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
  // top/bottom padding so the highest tick label is never clipped
  rightPriceScale: { borderColor: C.axis, scaleMargins: { top: 0.1, bottom: 0.08 } },
  timeScale: {
    borderColor: C.axis, rightOffset: 6, timeVisible: true, secondsVisible: false,
    // Italian tick labels (times are already shifted to local, so read them as UTC)
    tickMarkFormatter: (t: Time, type: TickMarkType) => {
      const d = new Date((t as number) * 1000)
      if (type === TickMarkType.Year) return String(d.getUTCFullYear())
      if (type === TickMarkType.Month) return cap(months()[d.getUTCMonth()])
      if (type === TickMarkType.DayOfMonth) return String(d.getUTCDate())
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: 'rgba(160,175,225,0.35)', labelBackgroundColor: '#1E2840', style: LineStyle.Dashed },
    horzLine: { color: 'rgba(160,175,225,0.35)', labelBackgroundColor: '#1E2840', style: LineStyle.Dashed },
  },
  localization: {
    locale: 'en-US',
    timeFormatter: (t: Time) => {
      const d = new Date((t as number) * 1000)
      const hm = d.getUTCHours() || d.getUTCMinutes() ? ` ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : ''
      return `${d.getUTCDate()} ${months()[d.getUTCMonth()]} ${d.getUTCFullYear()}${hm}`
    },
    priceFormatter: usdAxis },
  handleScale: { axisPressedMouseMove: true },
}

/** Plain number formatter for indicator panes (RSI, MACD…). */
const plainNum = (p: number) => (Math.abs(p) >= 1000 ? Math.round(p).toLocaleString('en-US') : Number.isInteger(p) ? String(p) : Math.abs(p) >= 10 ? p.toFixed(1) : p.toFixed(2)).replace('-', '−')

const ptData = (pts: Pt[]) => pts.map((p) => (p.value == null ? { time: lt(p.time) } : { time: lt(p.time), value: p.value }))
const dedupeSorted = <X extends { time: number }>(arr: X[]) => {
  const out: X[] = []
  for (const x of [...arr].sort((a, b) => a.time - b.time)) {
    if (out.length && out[out.length - 1].time === x.time) out[out.length - 1] = x
    else out.push(x)
  }
  return out
}

export default function ProChart({
  candles, height = 420, liveTf, lines = [], priceLines = [], markers = [], zones = [], volume = true, panes = [],
  symbol = 'BTC / USDT', tfLabel, logScale = false, fitKey, liveMergeMonthly = false, wheel = true,
  overlayMarkers = NO_OVERLAY, activeOverlayId = null, onOverlayHover,
  annotations = NO_ANN, onPick, pickDraft = null, onAnnotationClick,
}: {
  candles: Candle[]
  /** px, or a CSS length such as '100%' to fill the parent */
  height?: number | string
  liveTf?: LiveTf
  lines?: LineDef[]
  priceLines?: PriceLineDef[]
  markers?: MarkerDef[]
  zones?: ZoneDef[]
  volume?: boolean
  panes?: PaneDef[]
  symbol?: string
  tfLabel?: string
  logScale?: boolean
  fitKey?: string
  /** merge live (daily) klines into the last monthly bar */
  liveMergeMonthly?: boolean
  /** mouse-wheel zoom/scroll (disable on dashboards so the page can scroll) */
  wheel?: boolean
  /** numbered circles drawn as an HTML overlay (true circles with the label inside) */
  overlayMarkers?: OverlayMarkerDef[]
  /** id highlighted from outside (e.g. a hovered table row) */
  activeOverlayId?: string | null
  onOverlayHover?: (id: string | null) => void
  /** user drawings shown as an SVG overlay */
  annotations?: ChartAnnotationDef[]
  /** when set, the chart is in "pick" mode: crosshair cursor, a click reports the time/price under the cursor */
  onPick?: (p: ChartPoint) => void
  /** first point of a two-point drawing in progress: a dashed rubber band follows the cursor */
  pickDraft?: ChartPoint | null
  onAnnotationClick?: (id: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lineRefs = useRef(new Map<string, ISeriesApi<'Line'>>())
  const plRefs = useRef<IPriceLine[]>([])
  const lastBarRef = useRef<Candle | null>(null)
  const paneRefs = useRef<{ el: HTMLDivElement | null; chart: IChartApi | null; series: Map<string, ISeriesApi<'Line' | 'Histogram'>> }[]>([])
  const [hover, setHover] = useState<Candle | null>(null)
  const [hoverPrice, setHoverPrice] = useState<number | null>(null)
  const [zoneBoxes, setZoneBoxes] = useState<{ top: number; height: number; color: string; label?: string }[]>([])
  const [lastBar, setLastBar] = useState<Candle | null>(null)
  const [ovPos, setOvPos] = useState<{ m: OverlayMarkerDef; x: number; y: number }[]>([])
  const [ovHover, setOvHover] = useState<string | null>(null)
  const [annGeo, setAnnGeo] = useState<{ w: number; h: number; items: AnnGeo[] }>({ w: 0, h: 0, items: [] })
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  const sorted = useMemo(() => dedupeSorted(candles), [candles])
  const sortedRef = useRef(sorted)
  sortedRef.current = sorted

  // ---------- create main chart
  useEffect(() => {
    const el = mainRef.current!
    const chart = createChart(el, { ...baseOptions, layout: { ...baseOptions.layout, attributionLogo: false }, width: el.clientWidth, height: el.clientHeight })
    const cs = chart.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
      lastValueVisible: true, priceLineVisible: true, priceLineColor: C.btc, priceLineStyle: LineStyle.Dotted,
    })
    chartRef.current = chart
    candleRef.current = cs
    chart.subscribeCrosshairMove((p) => {
      if (pickRef.current) setCursor(p.point ? { x: p.point.x, y: p.point.y } : null)
      setHoverPrice(p.point ? cs.coordinateToPrice(p.point.y) : null)
      const d = p.time ? (p.seriesData.get(cs) as { open: number; high: number; low: number; close: number } | undefined) : undefined
      setHover(d && p.time ? { time: fromLt(p.time as number), open: d.open, high: d.high, low: d.low, close: d.close, volume: 0 } : null)
    })
    chart.subscribeClick((p) => {
      const pick = pickRef.current
      if (!pick || !p.point) return
      const price = cs.coordinateToPrice(p.point.y)
      const time = p.time != null ? fromLt(p.time as number) : logicalToTime(sortedRef.current, p.logical as number | undefined)
      if (price == null || time == null) return
      pick({ time, price })
    })
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    const lines = lineRefs.current
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volRef.current = null
      lines.clear()
      plRefs.current = []
    }
  }, [])

  // ---------- wheel handling
  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: wheel, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }, handleScale: { mouseWheel: wheel, pinch: true, axisPressedMouseMove: true } })
  }, [wheel])

  // ---------- log scale
  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal })
  }, [logScale])

  // ---------- volume series
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    if (volume && !volRef.current) {
      volRef.current = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } })
    } else if (!volume && volRef.current) {
      chart.removeSeries(volRef.current)
      volRef.current = null
    }
  }, [volume])

  // ---------- candle data
  const prevFit = useRef<string | undefined>(undefined)
  useEffect(() => {
    const cs = candleRef.current
    if (!cs) return
    cs.setData(sorted.map((c) => ({ time: lt(c.time), open: c.open, high: c.high, low: c.low, close: c.close })))
    volRef.current?.setData(sorted.map((c) => ({ time: lt(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(46,189,133,0.32)' : 'rgba(239,84,102,0.32)' })))
    lastBarRef.current = sorted[sorted.length - 1] ?? null
    setLastBar(lastBarRef.current)
    if (prevFit.current !== fitKey) {
      prevFit.current = fitKey
      const n = sorted.length
      if (n > 0) chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 180), to: n + 8 })
    }
  }, [sorted, volume, fitKey])

  // ---------- live kline updates
  useEffect(() => {
    if (!liveTf) return
    return live.onKline((m) => {
      if (m.tf !== liveTf) return
      const last = lastBarRef.current
      let c = m.candle
      if (liveMergeMonthly && last) {
        const d = new Date(c.time * 1000)
        const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
        c = ms === last.time
          ? { ...last, high: Math.max(last.high, c.high), low: Math.min(last.low, c.low), close: c.close }
          : { time: ms, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
      }
      if (last && c.time < last.time) return
      const cs = candleRef.current
      if (!cs) return
      try {
        cs.update({ time: lt(c.time), open: c.open, high: c.high, low: c.low, close: c.close })
        volRef.current?.update({ time: lt(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(46,189,133,0.32)' : 'rgba(239,84,102,0.32)' })
        lastBarRef.current = c
        setLastBar(c)
      } catch {
        /* out-of-order update: ignore */
      }
    })
  }, [liveTf, liveMergeMonthly])

  // ---------- overlay lines
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const map = lineRefs.current
    const want = new Set(lines.map((l) => l.id))
    for (const [id, s] of map) if (!want.has(id)) { chart.removeSeries(s); map.delete(id) }
    for (const l of lines) {
      let s = map.get(l.id)
      const opts = {
        color: l.color, lineWidth: (l.width ?? 1.5) as 1 | 2 | 3 | 4, lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, title: '',
      }
      if (!s) { s = chart.addLineSeries(opts); map.set(l.id, s) } else s.applyOptions(opts)
      s.setData(dedupeSorted(ptData(l.data) as { time: UTCTimestamp }[]) as never)
    }
  }, [lines])

  // ---------- price lines: neutral grey hairlines; only the nearest level above (R) and below (S) the price is labelled,
  // the others are named in the header while the crosshair is near them.
  const lastClose = lastBar?.close ?? sorted[sorted.length - 1]?.close ?? null
  const nearestKey = useMemo(() => {
    if (lastClose == null) return ''
    let up = -1, dn = -1
    priceLines.forEach((p, i) => {
      if (p.price >= lastClose && (up < 0 || p.price < priceLines[up].price)) up = i
      if (p.price < lastClose && (dn < 0 || p.price > priceLines[dn].price)) dn = i
    })
    return `${up},${dn}`
  }, [priceLines, lastClose])
  useEffect(() => {
    const cs = candleRef.current
    if (!cs) return
    const show = new Set(nearestKey.split(',').map(Number))
    plRefs.current.forEach((p) => cs.removePriceLine(p))
    plRefs.current = priceLines.map((p, i) =>
      cs.createPriceLine({
        price: p.price, color: LEVEL_COLOR, lineWidth: 1, lineStyle: p.dashed === false ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: show.has(i), axisLabelColor: '#1E2840', axisLabelTextColor: '#B3BCD0', title: show.has(i) ? p.title ?? '' : '',
      }),
    )
  }, [priceLines, nearestKey])
  const hoverLevel = useMemo(() => {
    if (hoverPrice == null || !priceLines.length) return null
    let best: PriceLineDef | null = null
    for (const p of priceLines) if (Math.abs(p.price - hoverPrice) / p.price < 0.004 && (!best || Math.abs(p.price - hoverPrice) < Math.abs(best.price - hoverPrice))) best = p
    return best
  }, [hoverPrice, priceLines])

  // ---------- markers
  useEffect(() => {
    const cs = candleRef.current
    if (!cs) return
    const ms: SeriesMarker<Time>[] = dedupeSorted(markers.map((m) => ({ ...m, time: lt(m.time) as number })))
      .map((m) => ({ time: m.time as UTCTimestamp, position: m.position, color: MARKER_COLOR, shape: m.shape, text: m.text, size: m.size }))
    cs.setMarkers(ms)
  }, [markers, sorted])

  // ---------- zones (HTML overlay boxes positioned via priceToCoordinate)
  useEffect(() => {
    if (!zones.length) { setZoneBoxes([]); return }
    let prev = ''
    const calc = () => {
      const cs = candleRef.current
      if (!cs) return
      const boxes = zones.flatMap((z) => {
        const y1 = cs.priceToCoordinate(z.high), y2 = cs.priceToCoordinate(z.low)
        if (y1 == null || y2 == null) return []
        // zones are levels, not signals: neutral fill regardless of the caller's colour
        return [{ top: Math.min(y1, y2), height: Math.max(2, Math.abs(y2 - y1)), color: 'rgba(148,163,184,0.06)', label: z.label }]
      })
      const key = JSON.stringify(boxes.map((b) => [Math.round(b.top), Math.round(b.height)]))
      if (key !== prev) { prev = key; setZoneBoxes(boxes) }
    }
    calc()
    const id = setInterval(calc, 200)
    return () => clearInterval(id)
  }, [zones])

  // ---------- overlay markers (HTML circles positioned via timeToCoordinate / priceToCoordinate)
  useEffect(() => {
    const chart = chartRef.current, cs = candleRef.current, el = mainRef.current
    if (!chart || !cs || !el) return
    if (!overlayMarkers.length) { setOvPos([]); return }
    const R = 9, GAP = 6, STEP = 20
    let prev = '', raf = 0
    const calc = () => {
      raf = 0
      const ts = chart.timeScale()
      const w = ts.width(), h = el.clientHeight - ts.height()
      const stack = new Map<string, number>()
      const out: { m: OverlayMarkerDef; x: number; y: number }[] = []
      for (const m of overlayMarkers) {
        const x = ts.timeToCoordinate(lt(m.time))
        const py = cs.priceToCoordinate(m.price)
        if (x == null || py == null) continue
        const pos = m.position ?? 'at'
        const k = `${m.time}|${pos}`
        const i = stack.get(k) ?? 0
        stack.set(k, i + 1)
        const y = pos === 'above' ? py - GAP - R - i * STEP : pos === 'below' ? py + GAP + R + i * STEP : py + i * STEP
        if (x < R || x > w - R || y < R || y > h - R) continue
        out.push({ m, x, y })
      }
      const key = out.map((o) => `${o.m.id}:${Math.round(o.x)},${Math.round(o.y)}`).join(';')
      if (key !== prev) { prev = key; setOvPos(out) }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(calc) }
    schedule()
    const ts = chart.timeScale()
    ts.subscribeVisibleLogicalRangeChange(schedule)
    ts.subscribeSizeChange(schedule)
    chart.subscribeCrosshairMove(schedule)   // covers price-axis drags / autoscale shifts
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const off = live.onKline(schedule)       // live bars can rescale the price axis
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ts.unsubscribeVisibleLogicalRangeChange(schedule)
      ts.unsubscribeSizeChange(schedule)
      chart.unsubscribeCrosshairMove(schedule)
      ro.disconnect()
      off()
    }
  }, [overlayMarkers, sorted])
  // ---------- user annotations (SVG overlay): recomputed on scroll/zoom/resize/live bars
  useEffect(() => {
    const chart = chartRef.current, cs = candleRef.current, el = mainRef.current
    if (!chart || !cs || !el) return
    if (!annotations.length && !pickDraft) { setAnnGeo({ w: 0, h: 0, items: [] }); return }
    let prev = '', raf = 0
    const calc = () => {
      raf = 0
      const ts = chart.timeScale()
      const w = Math.max(0, ts.width()), h = Math.max(0, el.clientHeight - ts.height())
      const X = (t: number | null | undefined) => (t == null ? null : timeToX(ts, sorted, t))
      const Y = (p: number | null | undefined) => (p == null ? null : cs.priceToCoordinate(p))
      const items: AnnGeo[] = []
      for (const a of annotations) {
        const [p1, p2] = a.points
        if (a.kind === 'hline') { const y = Y(p1?.price); if (y != null) items.push({ a, x1: 0, y1: y, x2: w, y2: y }) }
        else if (a.kind === 'vline') { const x = X(p1?.time); if (x != null) items.push({ a, x1: x, y1: 0, x2: x, y2: h }) }
        else if (a.kind === 'text') { const x = X(p1?.time), y = Y(p1?.price); if (x != null && y != null) items.push({ a, x1: x, y1: y, x2: x, y2: y }) }
        else if (a.kind === 'trendline' && p1 && p2) {
          const x1 = X(p1.time), y1 = Y(p1.price), x2 = X(p2.time), y2 = Y(p2.price)
          if (x1 == null || y1 == null || x2 == null || y2 == null) continue
          let ex: number = x2, ey: number = y2
          if (a.extend && x2 !== x1) { const k = (y2 - y1) / (x2 - x1); ex = x2 > x1 ? w : 0; ey = y1 + k * (ex - x1) }
          items.push({ a, x1, y1, x2: ex, y2: ey })
        }
      }
      if (pickDraft) {
        const x = X(pickDraft.time), y = Y(pickDraft.price)
        if (x != null && y != null) items.push({ a: { id: '__draft', kind: 'text', points: [], color: '#B3BCD0' }, x1: x, y1: y, x2: x, y2: y, draft: true })
      }
      const key = `${w},${h};` + items.map((g) => `${g.a.id}:${Math.round(g.x1)},${Math.round(g.y1)},${Math.round(g.x2)},${Math.round(g.y2)},${g.a.selected ? 1 : 0},${g.a.color},${g.a.text ?? ''},${g.a.extend ? 1 : 0}`).join(';')
      if (key !== prev) { prev = key; setAnnGeo({ w, h, items }) }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(calc) }
    schedule()
    const ts = chart.timeScale()
    ts.subscribeVisibleLogicalRangeChange(schedule)
    ts.subscribeSizeChange(schedule)
    chart.subscribeCrosshairMove(schedule)
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const off = live.onKline(schedule)
    const id = setInterval(schedule, 400)   // price-axis autoscale / drags that emit no event
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ts.unsubscribeVisibleLogicalRangeChange(schedule)
      ts.unsubscribeSizeChange(schedule)
      chart.unsubscribeCrosshairMove(schedule)
      ro.disconnect()
      off()
      clearInterval(id)
    }
  }, [annotations, pickDraft, sorted])
  const draftGeo = annGeo.items.find((g) => g.draft)

  const setOv = (id: string | null) => { setOvHover(id); onOverlayHover?.(id) }
  const ovActive = ovHover ?? activeOverlayId
  const ovTip = ovHover ? ovPos.find((o) => o.m.id === ovHover) : undefined

  // ---------- sub panes (RSI / MACD), synced to the main time scale
  const paneKey = panes.map((p) => p.id).join(',')
  useEffect(() => {
    const main = chartRef.current
    if (!main) return
    const created = paneRefs.current.map((ref, i) => {
      if (!ref.el) return null
      const chart = createChart(ref.el, {
        ...baseOptions, width: ref.el.clientWidth, height: ref.el.clientHeight,
        layout: { ...baseOptions.layout, attributionLogo: false },
        timeScale: { ...baseOptions.timeScale, visible: false },
        rightPriceScale: { borderColor: C.axis, minimumWidth: 70, scaleMargins: { top: 0.12, bottom: 0.08 } },
        localization: { ...baseOptions.localization, priceFormatter: plainNum },
      })
      ref.chart = chart
      ref.series = new Map()
      const ro = new ResizeObserver(() => ref.el && chart.applyOptions({ width: ref.el.clientWidth, height: ref.el.clientHeight }))
      ro.observe(ref.el)
      void i
      return { chart, ro }
    })
    main.priceScale('right').applyOptions({ minimumWidth: 70 })
    const sync = (r: LogicalRange | null) => {
      if (!r) return
      created.forEach((c) => c?.chart.timeScale().setVisibleLogicalRange(r))
    }
    main.timeScale().subscribeVisibleLogicalRangeChange(sync)
    return () => {
      main.timeScale().unsubscribeVisibleLogicalRangeChange(sync)
      created.forEach((c) => { c?.ro.disconnect(); c?.chart.remove() })
      paneRefs.current.forEach((r) => { r.chart = null; r.series = new Map() })
    }
  }, [paneKey])

  useEffect(() => {
    panes.forEach((p, i) => {
      const ref = paneRefs.current[i]
      if (!ref?.chart) return
      for (const s of ref.series.values()) ref.chart.removeSeries(s)
      ref.series.clear()
      // align to main candles' timeline with whitespace so logical indexes match
      const base = new Map<number, number | null>()
      sorted.forEach((c) => base.set(c.time, null))
      p.series.forEach((ps, k) => {
        const vals = new Map(ps.data.map((d) => [d.time, d.value]))
        const data = [...base.keys()].map((t) => {
          const v = vals.get(t)
          if (v == null) return { time: lt(t) }
          return ps.type === 'histogram' ? { time: lt(t), value: v, color: ps.colorFn ? ps.colorFn(v) : ps.color } : { time: lt(t), value: v }
        })
        const s = ps.type === 'histogram'
          ? ref.chart!.addHistogramSeries({ color: ps.color, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } })
          : ref.chart!.addLineSeries({ color: ps.color, lineWidth: (ps.width ?? 1.5) as 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: p.id === 'rsi' ? { type: 'price', precision: 0, minMove: 1 } : { type: 'price', precision: 1, minMove: 0.1 } })
        s.setData(data as never)
        if (k === 0) p.levels?.forEach((lv) => s.createPriceLine({ price: lv.value, color: LEVEL_COLOR, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }))
        ref.series.set(ps.id, s)
      })
      const r = chartRef.current?.timeScale().getVisibleLogicalRange()
      if (r) ref.chart.timeScale().setVisibleLogicalRange(r)
    })
  }, [panes, sorted])

  const shown = hover ?? lastBar
  const prevClose = useMemo(() => (sorted.length > 1 ? sorted[sorted.length - 2].close : null), [sorted])
  const chg = shown ? (hover ? ((shown.close - shown.open) / shown.open) * 100 : prevClose ? ((shown.close - prevClose) / prevClose) * 100 : null) : null
  const panesH = panes.reduce((s, p) => s + p.height, 0)

  return (
    <div ref={wrapRef} className="flex w-full flex-col" style={{ height }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pb-2 text-xs">
        <span className="text-sm font-semibold text-white">{symbol}{tfLabel && <span className="text-slate-400"> · {tfIn(tfLabel)}</span>}</span>
        {shown && (
          <span className="tnum flex flex-wrap gap-x-3 text-slate-400">
            <span>{tr('A', 'O')} <b className="font-medium text-slate-200">{usd(shown.open)}</b></span>
            <span>{tr('Max', 'H')} <b className="font-medium text-slate-200">{usd(shown.high)}</b></span>
            <span>{tr('Min', 'L')} <b className="font-medium text-slate-200">{usd(shown.low)}</b></span>
            <span>{tr('C', 'C')} <b className="font-medium text-slate-200">{usd(shown.close)}</b></span>
            {chg != null && <b className={chg >= 0 ? 'font-medium text-up' : 'font-medium text-down'}>{pct(chg)}</b>}
          </span>
        )}
        {hoverLevel && <span className="tnum text-slate-300">{t('Livello')} <b className="font-medium text-white">{hoverLevel.title || '—'}</b> {usd(hoverLevel.price)}</span>}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={mainRef} className={`absolute inset-0${onPick ? ' [&_td]:!cursor-crosshair [&_canvas]:!cursor-crosshair' : ''}`} />
        <div className="pointer-events-none absolute inset-y-0 left-0 right-[70px] overflow-hidden">
          {zoneBoxes.map((z, i) => (
            <div key={i} className="absolute left-0 right-0 border-y border-white/[0.08]" style={{ top: z.top, height: z.height, background: z.color }} title={z.label}>
              {/* zone names live in the tooltip (no text over the candles) */}
            </div>
          ))}
        </div>
        {annGeo.items.length > 0 && annGeo.w > 0 && annGeo.h > 0 && (
          <svg className="pointer-events-none absolute left-0 top-0 z-[2] overflow-hidden" width={annGeo.w} height={annGeo.h}>
            {annGeo.items.filter((g) => !g.draft).map((g) => <AnnShape key={g.a.id} g={g} w={annGeo.w} onClick={onPick ? undefined : onAnnotationClick} />)}
            {draftGeo && (
              <g>
                {cursor && <line x1={draftGeo.x1} y1={draftGeo.y1} x2={cursor.x} y2={cursor.y} stroke="#B3BCD0" strokeWidth={1.5} strokeDasharray="5 4" />}
                <circle cx={draftGeo.x1} cy={draftGeo.y1} r={4} fill="#0E1424" stroke="#E8ECF4" strokeWidth={1.5} />
              </g>
            )}
          </svg>
        )}
        {ovPos.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-[3]">
            {ovPos.map(({ m, x, y }) => {
              const on = m.id === ovActive
              return (
                <button key={m.id} type="button" aria-label={m.title ?? m.label}
                  onMouseEnter={() => setOv(m.id)} onMouseLeave={() => setOv(null)} onFocus={() => setOv(m.id)} onBlur={() => setOv(null)}
                  className={`tnum pointer-events-auto absolute flex h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-surface font-semibold leading-none ${m.label.length > 1 ? 'text-[10.5px] tracking-[-0.03em]' : 'text-[13px]'} text-white transition-colors ${on ? 'z-[1] border-[#4C8DFF] bg-raised' : 'border-white/[0.16]'}`}
                  style={{ left: x, top: y }}>
                  {m.label}
                </button>
              )
            })}
            {ovTip && (
              <div className="pointer-events-none absolute z-[2] whitespace-nowrap rounded-md border border-line bg-raised px-2 py-1 text-xs shadow-lg"
                style={{ left: Math.max(80, Math.min(ovTip.x, (mainRef.current?.clientWidth ?? 0) - 150)), top: ovTip.y < 48 ? ovTip.y + 14 : ovTip.y - 14, transform: `translate(-50%, ${ovTip.y < 48 ? '0' : '-100%'})` }}>
                <span className="tnum mr-1.5 text-slate-400">{ovTip.m.label}</span>
                <span className="text-white">{ovTip.m.title}</span>
                {ovTip.m.sub && <span className="tnum ml-1.5 text-slate-400">{ovTip.m.sub}</span>}
              </div>
            )}
          </div>
        )}
      </div>
      {panes.map((p, i) => (
        <div key={p.id} className="relative mt-1 border-t border-line" style={{ height: p.height }}>
          <span className="absolute left-2 top-1 z-10 text-2xs font-medium text-slate-400">{p.title}</span>
          <div ref={(el) => { paneRefs.current[i] = paneRefs.current[i] ?? { el: null, chart: null, series: new Map() }; paneRefs.current[i].el = el }} className="absolute inset-0" />
        </div>
      ))}
      {panesH > 0 && <div className="h-1" />}
      {/* attribution required by the lightweight-charts licence (in place of the in-chart logo) */}
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="mt-1 self-end text-2xs text-slate-600 hover:text-slate-400">{t('Grafico: TradingView Lightweight Charts™')}</a>
    </div>
  )
}

// ------------------------------------------------------------------ user annotations (journal) helpers
type AnnGeo = { a: ChartAnnotationDef; x1: number; y1: number; x2: number; y2: number; draft?: boolean }
const NO_ANN: ChartAnnotationDef[] = []

/** median bar spacing in seconds (robust to gaps) */
function barStep(sorted: Candle[]): number {
  const n = sorted.length
  if (n < 2) return 86400
  const d: number[] = []
  for (let i = Math.max(1, n - 50); i < n; i++) d.push(sorted[i].time - sorted[i - 1].time)
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)] || 86400
}

/** unix time → fractional logical bar index (interpolated between bars, extrapolated past the ends) → x pixel */
function timeToX(ts: ReturnType<IChartApi['timeScale']>, sorted: Candle[], t: number): number | null {
  const n = sorted.length
  if (!n) return null
  let logical: number
  if (t >= sorted[n - 1].time) logical = n - 1 + (t - sorted[n - 1].time) / barStep(sorted)
  else if (t <= sorted[0].time) logical = (t - sorted[0].time) / barStep(sorted)
  else {
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sorted[mid].time <= t) lo = mid; else hi = mid }
    logical = lo + (t - sorted[lo].time) / (sorted[hi].time - sorted[lo].time || 1)
  }
  return ts.logicalToCoordinate(logical as Logical)
}

/** logical index (a click past the last bar has no bar time) → extrapolated unix time */
function logicalToTime(sorted: Candle[], logical: number | undefined): number | null {
  const n = sorted.length
  if (!n || logical == null || !Number.isFinite(logical)) return null
  const i = Math.round(logical)
  if (i >= 0 && i < n) return sorted[i].time
  return i >= n ? sorted[n - 1].time + (i - (n - 1)) * barStep(sorted) : sorted[0].time + i * barStep(sorted)
}

function AnnShape({ g, w, onClick }: { g: AnnGeo; w: number; onClick?: (id: string) => void }) {
  const { a } = g
  const sw = a.selected ? 2 : 1.5
  const click = onClick ? { onClick: () => onClick(a.id), style: { pointerEvents: 'auto' as const, cursor: 'pointer' } } : {}
  const label = (a.text ?? '').trim()
  const pill = (x: number, y: number, txt: string, anchor: 'start' | 'end' | 'middle' = 'start') => {
    const shown = txt.length > 34 ? txt.slice(0, 33) + '…' : txt
    const width = 14 + shown.length * 6.1
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x
    const lx = Math.max(2, Math.min(left, w - width - 2))
    return (
      <g {...click}>
        <title>{txt}</title>
        <rect x={lx} y={y - 10} width={width} height={20} rx={6} fill="#161E31" fillOpacity={0.94} stroke={a.color} strokeOpacity={a.selected ? 0.95 : 0.5} />
        <text x={lx + 7} y={y + 4} fontSize={11} fill="#E8ECF4" fontFamily={FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>{shown}</text>
      </g>
    )
  }
  const dash = a.selected ? undefined : '6 4'
  if (a.kind === 'hline') {
    const txt = `${label ? label + ' · ' : ''}${usd(a.points[0]?.price ?? null)}`
    return (
      <g>
        <line x1={0} y1={g.y1} x2={w} y2={g.y1} stroke={a.color} strokeWidth={sw} strokeDasharray={dash} />
        {pill(w - 8, g.y1 < 26 ? g.y1 + 14 : g.y1 - 14, txt, 'end')}
      </g>
    )
  }
  if (a.kind === 'vline') {
    return (
      <g>
        <line x1={g.x1} y1={0} x2={g.x1} y2={g.y2} stroke={a.color} strokeWidth={sw} strokeDasharray={dash} />
        {pill(g.x1 + 6, 16, label || '•')}
      </g>
    )
  }
  if (a.kind === 'trendline') {
    return (
      <g>
        <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={a.color} strokeWidth={sw + 0.5} strokeLinecap="round" />
        {onClick && <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="transparent" strokeWidth={12} {...click} />}
        <circle cx={g.x1} cy={g.y1} r={a.selected ? 4 : 3} fill="#0E1424" stroke={a.color} strokeWidth={1.5} />
        {!a.extend && <circle cx={g.x2} cy={g.y2} r={a.selected ? 4 : 3} fill="#0E1424" stroke={a.color} strokeWidth={1.5} />}
        {label && pill((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2 - 16, label, 'middle')}
      </g>
    )
  }
  // text note pinned to a time/price
  return (
    <g>
      <circle cx={g.x1} cy={g.y1} r={a.selected ? 5 : 4} fill={a.color} stroke="#0E1424" strokeWidth={1.5} {...click} />
      {pill(g.x1 + 9, g.y1 - 16, label || '•')}
    </g>
  )
}
