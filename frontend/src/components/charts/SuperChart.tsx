/*
 * SuperChart — candlestick chart + N synchronised indicator panes (lightweight-charts 4, one chart per pane).
 * Every chart is fed the SAME bar grid (whitespace where a series has no value), so logical indexes match: zoom/pan
 * and the crosshair are mirrored across panes by logical range / bar time. `end` cuts every series at the same bar
 * (replay: nothing after the cursor is ever handed to the charts). Step-by-step replay appends one bar with update().
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  createChart, CrosshairMode, LineStyle, PriceScaleMode, TickMarkType,
  type IChartApi, type ISeriesApi, type LogicalRange, type MouseEventParams, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts'
import { C, FONT, usdAxis } from './theme'
import { cap, months } from '../../i18n'
import { T, alpha } from '../../theme/tokens'

const TZ = -new Date().getTimezoneOffset() * 60
const lt = (t: number) => (t + TZ) as UTCTimestamp
const SCALE_W = 74
/** events that make a chart the sync source (wheel/touch can arrive without a prior pointer move) */
const ACT_EVENTS = ['pointerenter', 'pointermove', 'pointerdown', 'wheel', 'touchstart'] as const
const ANOMALY = T.warn

export type EngineSeries = {
  key: string; type: 'line' | 'hist'; color: string; values: (number | null)[]
  /** per-bar colours for histograms (same length as values) */
  colors?: string[] | null
  width?: number; dashed?: boolean
}
export type EnginePane = {
  key: string
  /** drawn on the price chart (own hidden scale unless `priceScale` is 'right') */
  ov: boolean
  priceScale?: 'right' | 'own'
  h: number
  series: EngineSeries[]
  levels?: number[]
  fmt: (v: number) => string
  /** anomaly markers: bar index + z (sign → above/below) */
  markers: { i: number; z: number }[]
}
export type EngineCandles = { o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }
export type LiveBar = { time: number; open: number; high: number; low: number; close: number }

type PaneRT = { chart: IChartApi; series: Map<string, ISeriesApi<SeriesType>>; levelsKey: string }

const tickFmt = (t: Time, type: TickMarkType) => {
  const d = new Date((t as number) * 1000)
  if (type === TickMarkType.Year) return String(d.getUTCFullYear())
  if (type === TickMarkType.Month) return cap(months()[d.getUTCMonth()])
  if (type === TickMarkType.DayOfMonth) return String(d.getUTCDate())
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const timeFmt = (t: Time) => {
  const d = new Date((t as number) * 1000)
  const hm = d.getUTCHours() || d.getUTCMinutes() ? ` ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : ''
  return `${d.getUTCDate()} ${months()[d.getUTCMonth()]} ${d.getUTCFullYear()}${hm}`
}

function baseOptions(el: HTMLElement, fmt: (p: number) => string) {
  return {
    width: el.clientWidth, height: el.clientHeight,
    layout: { background: { color: 'transparent' }, textColor: C.muted, fontFamily: FONT, fontSize: 11, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.axis, minimumWidth: SCALE_W, scaleMargins: { top: 0.14, bottom: 0.08 } },
    timeScale: { borderColor: C.axis, rightOffset: 6, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickFmt, visible: false },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: alpha(T.fg3, 0.35), labelBackgroundColor: T.overlay, style: LineStyle.Dashed },
      horzLine: { color: alpha(T.fg3, 0.35), labelBackgroundColor: T.overlay, style: LineStyle.Dashed },
    },
    localization: { locale: 'en-US', timeFormatter: timeFmt, priceFormatter: fmt },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
  }
}

/** series data up to `end` (inclusive), whitespace for missing values */
/** per-point colours (optional): a line segment takes the colour of the point it starts from */
function lineData(t: number[], vals: (number | null)[], end: number, colors?: string[] | null) {
  const out = new Array(end + 1)
  for (let i = 0; i <= end; i++) {
    const v = vals[i]
    out[i] = v == null || !Number.isFinite(v) ? { time: lt(t[i]) } : colors ? { time: lt(t[i]), value: v, color: colors[i] } : { time: lt(t[i]), value: v }
  }
  return out
}
function histData(t: number[], vals: (number | null)[], colors: string[] | null | undefined, end: number, color: string) {
  const out = new Array(end + 1)
  for (let i = 0; i <= end; i++) {
    const v = vals[i]
    out[i] = v == null || !Number.isFinite(v) ? { time: lt(t[i]) } : { time: lt(t[i]), value: v, color: colors?.[i] ?? color }
  }
  return out
}
function pointAt(s: EngineSeries, t: number[], i: number) {
  const v = s.values[i]
  if (v == null || !Number.isFinite(v)) return { time: lt(t[i]) }
  return s.type === 'hist' ? { time: lt(t[i]), value: v, color: s.colors?.[i] ?? s.color } : s.colors ? { time: lt(t[i]), value: v, color: s.colors[i] } : { time: lt(t[i]), value: v }
}
function markersFor(p: EnginePane, t: number[], end: number): SeriesMarker<Time>[] {
  return p.markers.filter((m) => m.i <= end).map((m) => ({
    time: lt(t[m.i]), position: m.z >= 0 ? 'aboveBar' : 'belowBar', color: ANOMALY, shape: 'circle', size: 0.7,
  }))
}

export default function SuperChart({
  t, candles, end, panes, log, mainH, fitKey, onHover, onResize, header, paneHeader, liveBar, mainFmt = usdAxis,
}: {
  t: number[]
  candles: EngineCandles
  /** index of the last bar handed to the charts (replay cursor; live = t.length − 1) */
  end: number
  panes: EnginePane[]
  log: boolean
  mainH: number
  /** a change re-frames the view on the last ~200 bars up to `end` */
  fitKey: string
  onHover?: (i: number | null) => void
  onResize?: (key: string, h: number) => void
  header?: ReactNode
  paneHeader?: (key: string) => ReactNode
  liveBar?: LiveBar | null
  mainFmt?: (v: number) => string
}) {
  const mainEl = useRef<HTMLDivElement>(null)
  const paneEls = useRef(new Map<string, HTMLDivElement | null>())
  const mainRef = useRef<{ chart: IChartApi; candle: ISeriesApi<'Candlestick'> } | null>(null)
  const panesRT = useRef(new Map<string, PaneRT>())
  const overlays = useRef(new Map<string, Map<string, ISeriesApi<SeriesType>>>())
  const active = useRef<IChartApi | null>(null)
  const horz = useRef<IChartApi | null>(null)
  const state = useRef({ t, end, panes, candles })
  state.current = { t, end, panes, candles }
  const rendered = useRef<{ t: number[] | null; candles: EngineCandles | null; end: number; panes: EnginePane[] | null; struct: string }>({ t: null, candles: null, end: -1, panes: null, struct: '' })
  const [, setTick] = useState(0)
  const hoverCb = useRef(onHover)
  hoverCb.current = onHover

  const sep = useMemo(() => panes.filter((p) => !p.ov), [panes])
  const ovs = useMemo(() => panes.filter((p) => p.ov), [panes])
  const struct = sep.map((p) => `${p.key}:${p.series.map((s) => `${s.key}.${s.type}`).join('+')}`).join('|') + '#' + ovs.map((p) => `${p.key}:${p.priceScale}:${p.series.map((s) => s.key).join('+')}`).join('|')

  // ---------- main chart (once)
  useEffect(() => {
    const el = mainEl.current!
    const chart = createChart(el, baseOptions(el, usdAxis))
    const candle = chart.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 0, minMove: 1 }, lastValueVisible: true, priceLineVisible: true, priceLineColor: C.price, priceLineStyle: LineStyle.Dotted,
    })
    mainRef.current = { chart, candle }
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    const enter = () => { active.current = chart }
    ACT_EVENTS.forEach((ev) => el.addEventListener(ev, enter, { capture: true, passive: true }))
    const ovMap = overlays.current
    const prt = panesRT.current
    // QA probe: what each chart actually holds (max data time, visible logical range) — used by the automated UI tests
    const w = window as unknown as { __scProbe?: () => unknown }
    const probe = () => {
      const lastT = (s: ISeriesApi<SeriesType>) => { const d = s.data(); return d.length ? (d[d.length - 1].time as number) - TZ : null }
      const panes: Record<string, { n: number; lastTime: number | null; range: LogicalRange | null }> = {}
      prt.forEach((p, k) => {
        const ss = [...p.series.values()]
        panes[k] = { n: ss[0]?.data().length ?? 0, lastTime: Math.max(...ss.map((s) => lastT(s) ?? -Infinity)), range: p.chart.timeScale().getVisibleLogicalRange() }
      })
      const ov: Record<string, number | null> = {}
      ovMap.forEach((m, k) => { ov[k] = Math.max(...[...m.values()].map((s) => lastT(s) ?? -Infinity)) })
      return { main: { n: candle.data().length, lastTime: lastT(candle), range: chart.timeScale().getVisibleLogicalRange() }, panes, overlays: ov }
    }
    w.__scProbe = probe
    return () => {
      if (w.__scProbe === probe) delete w.__scProbe
      ACT_EVENTS.forEach((ev) => el.removeEventListener(ev, enter, { capture: true }))
      ro.disconnect()
      prt.forEach((p) => p.chart.remove())
      prt.clear()
      ovMap.clear()
      chart.remove()
      mainRef.current = null
    }
  }, [])

  useEffect(() => {
    mainRef.current?.chart.applyOptions({ localization: { locale: 'en-US', timeFormatter: timeFmt, priceFormatter: mainFmt } })
  }, [mainFmt])
  useEffect(() => {
    mainRef.current?.chart.priceScale('right').applyOptions({ mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal })
  }, [log])

  // ---------- structure: pane charts + overlay series
  useEffect(() => {
    const m = mainRef.current
    if (!m) return
    const prt = panesRT.current
    // remove panes no longer present
    for (const [k, p] of prt) if (!sep.some((x) => x.key === k)) { p.chart.remove(); prt.delete(k) }
    // create / rebuild panes
    for (const p of sep) {
      const el = paneEls.current.get(p.key)
      if (!el) continue
      let rt = prt.get(p.key)
      const sig = p.series.map((s) => `${s.key}.${s.type}`).join('+')
      if (rt && [...rt.series.keys()].join('+') !== p.series.map((s) => s.key).join('+')) { rt.chart.remove(); prt.delete(p.key); rt = undefined }
      if (!rt) {
        const chart = createChart(el, baseOptions(el, p.fmt))
        const series = new Map<string, ISeriesApi<SeriesType>>()
        for (const s of p.series) {
          const common = { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom' as const, formatter: p.fmt, minMove: 1e-9 } }
          series.set(s.key, s.type === 'hist'
            ? chart.addHistogramSeries({ ...common, color: s.color })
            : chart.addLineSeries({ ...common, color: s.color, lineWidth: (s.width ?? 1.5) as 1, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid, crosshairMarkerVisible: true, crosshairMarkerRadius: 3 }))
        }
        const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }))
        ro.observe(el)
        const enter = () => { active.current = chart }
            ACT_EVENTS.forEach((ev) => el.addEventListener(ev, enter, { capture: true, passive: true }))
        const orig = chart.remove.bind(chart)
        chart.remove = () => { ro.disconnect(); ACT_EVENTS.forEach((ev) => el.removeEventListener(ev, enter, { capture: true })); orig() }
        rt = { chart, series, levelsKey: '' }
        prt.set(p.key, rt)
        void sig
      }
    }
    // overlays on the price chart
    const ov = overlays.current
    for (const [k, mm] of ov) if (!ovs.some((x) => x.key === k)) { mm.forEach((s) => m.chart.removeSeries(s)); ov.delete(k) }
    for (const p of ovs) {
      let mm = ov.get(p.key)
      if (mm && [...mm.keys()].join('+') !== p.series.map((s) => s.key).join('+')) { mm.forEach((s) => m.chart.removeSeries(s)); ov.delete(p.key); mm = undefined }
      if (!mm) {
        mm = new Map()
        const scaleId = p.priceScale === 'right' ? 'right' : `ov_${p.key}`
        for (const s of p.series) {
          const opts = { priceScaleId: scaleId, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, color: s.color,
            priceFormat: { type: 'custom' as const, formatter: p.fmt, minMove: 1e-9 } }
          mm.set(s.key, s.type === 'hist' ? m.chart.addHistogramSeries(opts) : m.chart.addLineSeries({ ...opts, lineWidth: (s.width ?? 1.5) as 1, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid }))
        }
        if (scaleId !== 'right') m.chart.priceScale(scaleId).applyOptions({ visible: false, scaleMargins: { top: 0.12, bottom: 0.12 } })
        ov.set(p.key, mm)
      }
    }
    // time axis only under the last chart
    const charts = [m.chart, ...sep.map((p) => prt.get(p.key)?.chart).filter(Boolean)] as IChartApi[]
    charts.forEach((c, i) => c.applyOptions({ timeScale: { visible: i === charts.length - 1 } }))
    rendered.current.struct = ''      // force a full data push
    setTick((x) => x + 1)
    // ---------- synchronisation: logical range + crosshair (only events coming from the chart under the pointer)
    const unsubs: (() => void)[] = []
    for (const c of charts) {
      const onRange = (r: LogicalRange | null) => {
        if (!r || active.current !== c) return
        for (const o of charts) if (o !== c) o.timeScale().setVisibleLogicalRange(r)
      }
      const onMove = (p: MouseEventParams) => {
        if (active.current !== c) return
        const idx = p.point && p.logical != null ? Math.round(p.logical as number) : null
        const { t: tt, end: e, panes: ps, candles: cd } = state.current
        const ok = idx != null && idx >= 0 && idx <= e
        for (const o of charts) {
          if (o === c) continue
          if (!ok) { o.clearCrosshairPosition(); continue }
          const target = syncTarget(o, idx!, ps, cd, tt)
          if (target) o.setCrosshairPosition(target.price, lt(tt[idx!]), target.series)
          else o.clearCrosshairPosition()
        }
        if (horz.current !== c) { horz.current = c; for (const o of charts) o.applyOptions({ crosshair: { horzLine: { visible: o === c } } }) }
        hoverCb.current?.(ok ? idx : null)
      }
      c.timeScale().subscribeVisibleLogicalRangeChange(onRange)
      c.subscribeCrosshairMove(onMove)
      unsubs.push(() => { try { c.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); c.unsubscribeCrosshairMove(onMove) } catch { /* removed */ } })
    }
    // align a freshly created pane to the current view
    const r = m.chart.timeScale().getVisibleLogicalRange()
    if (r) charts.forEach((c) => c !== m.chart && c.timeScale().setVisibleLogicalRange(r))
    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [struct])

  /** a series (and its value) of chart `o` usable to draw the synced crosshair at bar `i` */
  function syncTarget(o: IChartApi, i: number, ps: EnginePane[], cd: EngineCandles, tt: number[]) {
    const m = mainRef.current!
    void tt
    if (o === m.chart) return Number.isFinite(cd.c[i]) ? { series: m.candle as ISeriesApi<SeriesType>, price: cd.c[i] } : null
    for (const p of ps) {
      const rt = panesRT.current.get(p.key)
      if (!rt || rt.chart !== o) continue
      for (const s of p.series) {
        const se = rt.series.get(s.key)
        if (!se) continue
        for (let k = i; k >= Math.max(0, i - 2000); k--) {
          const v = s.values[k]
          if (v != null && Number.isFinite(v)) return { series: se, price: v }
        }
      }
    }
    return null
  }

  // ---------- data push (full or incremental)
  useEffect(() => {
    const m = mainRef.current
    if (!m || !t.length) return
    const e = Math.min(end, t.length - 1)
    const R = rendered.current
    const sameData = R.t === t && R.candles === candles && R.panes === panes && R.struct === struct
    if (sameData && e === R.end) return
    const step = sameData && e > R.end && e - R.end <= 64 && R.end >= 0
    const p0 = performance.now()
    const candleAt = (i: number) => ({ time: lt(t[i]), open: candles.o[i], high: candles.h[i], low: candles.l[i], close: candles.c[i] })
    if (step) {
      const from = R.end + 1
      for (let i = from; i <= e; i++) m.candle.update(candleAt(i))
      const hit = (p: EnginePane) => p.markers.some((mk) => mk.i >= from && mk.i <= e)
      for (const p of sep) {
        const rt = panesRT.current.get(p.key)
        if (!rt) continue
        p.series.forEach((s) => { const se = rt.series.get(s.key); if (se) for (let i = from; i <= e; i++) se.update(pointAt(s, t, i) as never) })
        if (hit(p)) rt.series.get(p.series[0].key)?.setMarkers(markersFor(p, t, e))
      }
      for (const p of ovs) {
        const mm = overlays.current.get(p.key)
        p.series.forEach((s) => { const se = mm?.get(s.key); if (se) for (let i = from; i <= e; i++) se.update(pointAt(s, t, i) as never) })
        if (hit(p)) mm?.get(p.series[0].key)?.setMarkers(markersFor(p, t, e))
      }
    } else {
      const cd = new Array(e + 1)
      for (let i = 0; i <= e; i++) cd[i] = candleAt(i)
      m.candle.setData(cd)
      for (const p of sep) {
        const rt = panesRT.current.get(p.key)
        if (!rt) continue
        for (const s of p.series) {
          const se = rt.series.get(s.key)
          if (!se) continue
          se.setData((s.type === 'hist' ? histData(t, s.values, s.colors, e, s.color) : lineData(t, s.values, e, s.colors)) as never)
        }
        const first = rt.series.get(p.series[0]?.key)
        if (first) {
          first.setMarkers(markersFor(p, t, e))
          const lk = (p.levels ?? []).join(',')
          if (rt.levelsKey !== lk) {
            p.levels?.forEach((lv) => first.createPriceLine({ price: lv, color: alpha(T.fg3, 0.45), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }))
            rt.levelsKey = lk
          }
        }
      }
      for (const p of ovs) {
        const mm = overlays.current.get(p.key)
        if (!mm) continue
        for (const s of p.series) mm.get(s.key)?.setData((s.type === 'hist' ? histData(t, s.values, s.colors, e, s.color) : lineData(t, s.values, e, s.colors)) as never)
        mm.get(p.series[0]?.key)?.setMarkers(markersFor(p, t, e))
      }
    }
    Object.assign(R, { t, candles, end: e, panes, struct })
    const perf = ((window as unknown as { __scPerf?: { full: number[]; step: number[] } }).__scPerf ??= { full: [], step: [] })
    ;(step ? perf.step : perf.full).push(Math.round((performance.now() - p0) * 10) / 10)
  })

  // ---------- framing
  const prevFit = useRef('')
  useEffect(() => {
    const m = mainRef.current
    if (!m || !t.length || prevFit.current === fitKey) return
    prevFit.current = fitKey
    const e = Math.min(end, t.length - 1)
    const r = { from: Math.max(0, e - 220), to: e + 8 }
    requestAnimationFrame(() => {
      m.chart.timeScale().setVisibleLogicalRange(r)
      panesRT.current.forEach((p) => p.chart.timeScale().setVisibleLogicalRange(r))
    })
  })

  // ---------- live candle (live mode only: end is the last bar)
  useEffect(() => {
    const m = mainRef.current
    if (!m || !liveBar || !t.length || end < t.length - 1) return
    const last = t[t.length - 1]
    if (liveBar.time !== last) return     // a new bar is appended by the next refetch (keeps every pane on the same grid)
    try {
      m.candle.update({ time: lt(liveBar.time), open: liveBar.open, high: liveBar.high, low: liveBar.low, close: liveBar.close })
    } catch { /* out of order */ }
  }, [liveBar, t, end])

  // ---------- pane resize (drag the bottom edge)
  const drag = useRef<{ key: string; y: number; h: number } | null>(null)
  const onDown = (key: string, h: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    drag.current = { key, y: e.clientY, h }
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (d) onResize?.(d.key, Math.round(Math.max(60, Math.min(600, d.h + ev.clientY - d.y))))
    }
    const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="flex w-full flex-col" onPointerLeave={() => { hoverCb.current?.(null); active.current = null }}>
      <div className="relative" style={{ height: mainH }}>
        <div ref={mainEl} className="absolute inset-0" data-pane="main" />
        {header && <div className="pointer-events-none absolute left-1 right-[80px] top-0 z-[5]">{header}</div>}
      </div>
      {sep.map((p) => (
        <div key={p.key} className="relative border-t border-line" style={{ height: p.h }} data-pane={p.key}>
          <div ref={(el) => { paneEls.current.set(p.key, el) }} className="absolute inset-0" />
          {paneHeader && <div className="pointer-events-none absolute left-1 right-[80px] top-0 z-[5]">{paneHeader(p.key)}</div>}
          {onResize && (
            <div role="separator" aria-orientation="horizontal" onPointerDown={onDown(p.key, p.h)}
              className="group absolute inset-x-0 -bottom-[3px] z-[6] flex h-[7px] cursor-row-resize items-center justify-center">
              <span className="h-[3px] w-10 rounded-full bg-white/0 transition-colors group-hover:bg-white/25" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
