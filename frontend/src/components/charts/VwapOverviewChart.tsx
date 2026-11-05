import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart, CrosshairMode, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesPrimitive, type ISeriesPrimitivePaneRenderer, type ISeriesPrimitivePaneView,
  type Logical, type SeriesAttachedParameter, type Time, type UTCTimestamp, type LineData, type WhitespaceData,
} from 'lightweight-charts'
import { live } from '../../api/live'
import type { VwapOverview, VwapPeriod, VwapProfileSession, VwapSource } from '../../api/vwap'
import { months } from '../../i18n'
import { C, FONT, hexA } from './theme'
import { PILL_H, layoutPills, mix, priceTicks, timeLogical, timeTicks, usdP } from './vwapAxis'
import { clsx } from '../ui'
import { T, alpha } from '../../theme/tokens'

/*
 * Single VWAP chart ("Grafico unico"): candles + current W/M/Q/Y VWAPs evolving from their anchor, current ±1σ (VAH/VAL)
 * and previous-period levels as horizontal dotted lines extended to the right edge (empty space on the right like
 * TradingView), level names + price pills on the axis, and a per-session volume profile (grey, POC / value area 70%)
 * drawn behind the candles with "VAH ▸ / POC ▸ / VAL ▸" on the left of each session.
 */

export type OverviewOpts = {
  periods: Record<VwapPeriod, boolean>
  cur: boolean        // current VWAP lines (evolving) + their extension
  curBands: boolean   // current VAH/VAL (= VWAP ±1σ), extended
  prev: boolean       // previous-period VWAP, extended
  prevBands: boolean  // previous-period VAH/VAL, extended
}
export type OverviewHover = { time: number; open: number; high: number; low: number; close: number; vwap: Partial<Record<VwapPeriod, number | null>> }
type Bar = { time: number; open: number; high: number; low: number; close: number }
type Level = { id: string; name: string; short: string; value: number; color: string; kind: 'cur' | 'curBand' | 'prev' | 'prevBand'; from: number }

const PERIODS: VwapPeriod[] = ['w', 'm', 'q', 'y']
export const PERIOD_COLOR: Record<VwapPeriod, string> = { w: T.steel, m: T.accent, q: T.mauve, y: T.sand }
const NAME: Record<VwapPeriod, string> = { w: 'Week', m: 'Month', q: 'Quarter', y: 'Year' }
const TAG: Record<VwapPeriod, string> = { w: 'W', m: 'M', q: 'Q', y: 'Y' }
const AXIS_W = 78
const PROFILE = { bar: alpha(T.fg3, 0.10), va: alpha(T.fg3, 0.20), poc: alpha(T.fg, 0.55), line: alpha(T.fg3, 0.55), text: T.fg2 }
const p2 = (n: number) => String(n).padStart(2, '0')

const lineData = (t: number[], v: (number | null)[]): (LineData | WhitespaceData)[] =>
  t.map((x, i) => (v[i] == null ? { time: x as UTCTimestamp } : { time: x as UTCTimestamp, value: v[i] as number }))

// ------------------------------------------------------------------ canvas primitive: volume profile + extended levels
type DrawState = {
  t: number[]; step: number; sessions: VwapProfileSession[]; levels: Level[]; showProfile: boolean; compact: boolean
}
class OverlayPrimitive implements ISeriesPrimitive<Time> {
  state: DrawState = { t: [], step: 3600, sessions: [], levels: [], showProfile: true, compact: false }
  private chart: IChartApi | null = null
  private series: ISeriesApi<'Candlestick'> | null = null
  private request: (() => void) | null = null
  private views: ISeriesPrimitivePaneView[]

  constructor() {
    const self = this
    const mk = (z: 'bottom' | 'normal', fn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): ISeriesPrimitivePaneView => {
      const r: ISeriesPrimitivePaneRenderer = {
        draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => fn(context, mediaSize.width, mediaSize.height)),
      }
      return { zOrder: () => z, renderer: () => r }
    }
    this.views = [mk('bottom', (c, w, h) => self.drawProfile(c, w, h)), mk('normal', (c, w, h) => self.drawLevels(c, w, h))]
  }
  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi
    this.series = p.series as ISeriesApi<'Candlestick'>
    this.request = p.requestUpdate
  }
  detached() { this.chart = null; this.series = null; this.request = null }
  paneViews() { return this.views }
  updateAllViews() { /* geometry is computed at draw time */ }
  set(s: Partial<DrawState>) { this.state = { ...this.state, ...s }; this.request?.() }

  private x(time: number): number | null {
    if (!this.chart) return null
    return this.chart.timeScale().logicalToCoordinate(timeLogical(this.state.t, this.state.step, time) as Logical)
  }

  private drawProfile(ctx: CanvasRenderingContext2D, w: number, _h: number) {
    const { sessions, showProfile } = this.state
    const s = this.series
    if (!showProfile || !s || !sessions.length) return
    const lastEnd = this.state.t.length ? this.state.t[this.state.t.length - 1] + this.state.step : 0
    for (const ss of sessions) {
      const xa = this.x(ss.start)
      const xb = this.x(Math.min(ss.end, lastEnd))
      if (xa == null || xb == null || xb < 0 || xa > w) continue
      const width = Math.max(4, (xb - xa) * 0.62)
      const max = Math.max(...ss.vols, 1e-9)
      for (let i = 0; i < ss.vols.length; i++) {
        const v = ss.vols[i]
        if (v <= 0) continue
        const y0 = s.priceToCoordinate(ss.lo + i * ss.bin)
        const y1 = s.priceToCoordinate(ss.lo + (i + 1) * ss.bin)
        if (y0 == null || y1 == null) continue
        const top = Math.min(y0, y1)
        const hh = Math.abs(y1 - y0)
        const inVa = i >= ss.va_bins[0] && i <= ss.va_bins[1]
        ctx.fillStyle = i === ss.poc_bin ? PROFILE.poc : inVa ? PROFILE.va : PROFILE.bar
        ctx.fillRect(xa, top + (hh > 3 ? 0.5 : 0), (v / max) * width, Math.max(0.75, hh - (hh > 3 ? 1 : 0)))
      }
    }
  }

  private drawLevels(ctx: CanvasRenderingContext2D, w: number, _h: number) {
    const s = this.series
    const ts = this.chart?.timeScale()
    if (!s || !ts) return
    const { sessions, showProfile, levels, compact } = this.state
    ctx.save()
    ctx.font = `500 10px ${FONT}`
    ctx.textBaseline = 'middle'
    // profile VAH / POC / VAL: dashed from the session start to the end of the next session
    if (showProfile) {
      const lastEnd = this.state.t.length ? this.state.t[this.state.t.length - 1] + this.state.step : 0
      sessions.forEach((ss, k) => {
        const xa = this.x(ss.start)
        const endT = k + 1 < sessions.length ? sessions[k + 1].end : ss.end
        let xb = this.x(Math.min(endT, lastEnd))
        if (k === sessions.length - 1) xb = this.x(lastEnd)
        if (xa == null || xb == null || xb < 0 || xa > w) return
        const rows = [{ k: 'VAH', v: ss.vah }, { k: 'POC', v: ss.poc }, { k: 'VAL', v: ss.val }]
          .map((r) => ({ ...r, y: s.priceToCoordinate(r.v) as number | null }))
          .filter((r): r is { k: string; v: number; y: number } => r.y != null)
        ctx.setLineDash([3, 3])
        for (const r of rows) {
          ctx.strokeStyle = r.k === 'POC' ? alpha(T.fg, 0.75) : PROFILE.line
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(Math.max(0, xa), Math.round(r.y) + 0.5)
          ctx.lineTo(Math.min(w, xb), Math.round(r.y) + 0.5)
          ctx.stroke()
        }
        ctx.setLineDash([])
        if (compact || xa < 0) return   // session start off-screen: lines only (labels would pile up at the left edge)
        // labels left of the session start, pushed apart when closer than 11 px
        const lab = [...rows].sort((a, b) => a.y - b.y)
        for (let i = 1; i < lab.length; i++) if (lab[i].y - lab[i - 1].y < 11) lab[i].y = lab[i - 1].y + 11
        const inside = xa < 46
        ctx.textAlign = inside ? 'left' : 'right'
        for (const r of lab) {
          const tx = inside ? Math.max(2, xa) + 3 : xa - 3
          const text = inside ? `◂ ${r.k}` : `${r.k} ▸`
          const tw = ctx.measureText(text).width
          ctx.fillStyle = alpha(T.surface, 0.82)
          ctx.fillRect(inside ? tx - 2 : tx - tw - 2, r.y - 6, tw + 4, 12)
          ctx.fillStyle = r.k === 'POC' ? T.fg : PROFILE.text
          ctx.fillText(text, tx, r.y)
        }
      })
    }
    // VWAP levels: horizontal dotted lines from `from` to the right edge
    for (const L of levels) {
      const y = s.priceToCoordinate(L.value)
      const xa = this.x(L.from)
      if (y == null || xa == null || xa > w) continue
      ctx.strokeStyle = L.kind === 'prev' ? hexA(L.color, 0.85) : L.kind === 'cur' ? hexA(L.color, 0.7) : hexA(L.color, 0.42)
      ctx.lineWidth = L.kind === 'prev' ? 1.25 : 1
      ctx.setLineDash(L.kind === 'prev' ? [2, 3] : L.kind === 'cur' ? [1, 2] : [1, 3])
      ctx.beginPath()
      ctx.moveTo(Math.max(0, xa), Math.round(y) + 0.5)
      ctx.lineTo(w, Math.round(y) + 0.5)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.restore()
  }
}

/** For each period, the earlier period with the same anchor (its current levels are identical), if any. */
function sharedAnchor(data: VwapOverview, opts: OverviewOpts): Partial<Record<VwapPeriod, VwapPeriod>> {
  const out: Partial<Record<VwapPeriod, VwapPeriod>> = {}
  PERIODS.forEach((p, i) => {
    const a = data.levels[p]?.anchor
    const first = PERIODS.slice(0, i).find((x) => opts.periods[x] && data.levels[x]?.anchor === a)
    if (first) out[p] = first
  })
  return out
}

/** Levels closer than 5 px share one pill ("Month VAH · pWeek VAH"): never two labels on the same line. */
function groupLevels<X extends { L: Level | null; y: number }>(items: X[], compact: boolean): X[] {
  const sorted = [...items].sort((a, b) => a.y - b.y)
  const out: X[] = []
  for (const it of sorted) {
    const g = out[out.length - 1]
    if (g && g.L && it.L && Math.abs(it.y - g.y) < 5) {
      const sep = compact ? '·' : ' · '
      g.L = { ...g.L, id: `${g.L.id}+${it.L.id}`, name: `${g.L.name}${sep}${it.L.name}`, short: `${g.L.short}${sep}${it.L.short}`,
        kind: g.L.kind === 'cur' || it.L.kind === 'cur' ? 'cur' : g.L.kind === 'prev' || it.L.kind === 'prev' ? 'prev' : g.L.kind }
      continue
    }
    out.push({ ...it })
  }
  return out
}

// ------------------------------------------------------------------ component
export default function VwapOverviewChart({ data, opts, showProfile, fitSignal, source, compact = false, onHover }: {
  data: VwapOverview
  opts: OverviewOpts
  showProfile: boolean
  fitSignal: number
  source: VwapSource
  compact?: boolean
  onHover?: (h: OverviewHover | null) => void
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRefs = useRef<Partial<Record<VwapPeriod, ISeriesApi<'Line'>>>>({})
  const prim = useRef(new OverlayPrimitive())
  const lastBar = useRef<Bar | null>(null)
  const liveBar = useRef<Bar | null>(null)
  const viewKey = useRef('')
  const nBars = useRef(0)
  const dataRef = useRef(data)
  dataRef.current = data
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const compactRef = useRef(compact)
  compactRef.current = compact
  const [pills, setPills] = useState<{ L: Level | null; y: number; off: -1 | 0 | 1; price?: number; up?: boolean }[]>([])
  const [axisW, setAxisW] = useState(AXIS_W)
  const [ticks, setTicks] = useState<{ py: { y: number; label: string }[]; tx: { x: number; label: string; major: boolean }[]; axisY: number }>({ py: [], tx: [], axisY: 0 })
  const [livePx, setLivePx] = useState<number | null>(null)

  // future whitespace on the right (≈ 14% of the bars): room to read the extended levels
  const future = useMemo(() => {
    const t = data.candles?.t ?? []
    const n = Math.max(16, Math.round(t.length * 0.2))
    const last = t[t.length - 1] ?? 0
    return Array.from({ length: n }, (_, i) => last + (i + 1) * data.step)
  }, [data])

  // ---------- create
  useEffect(() => {
    const el = elRef.current!
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { color: 'transparent' }, textColor: 'transparent', fontFamily: FONT, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: alpha(T.fg3, 0.035) }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.axis, scaleMargins: { top: 0.06, bottom: 0.05 }, minimumWidth: AXIS_W },
      timeScale: { borderColor: C.axis, rightOffset: 0, timeVisible: true, secondsVisible: false, minBarSpacing: 0.3 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: alpha(T.fg3, 0.35), labelBackgroundColor: T.overlay, style: LineStyle.Dashed },
        horzLine: { color: alpha(T.fg3, 0.35), labelBackgroundColor: T.overlay, style: LineStyle.Dashed },
      },
      localization: {
        locale: 'en-US',
        timeFormatter: (t: Time) => {
          const d = new Date((t as number) * 1000)
          return `${d.getUTCDate()} ${months()[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`
        },
        priceFormatter: (p: number) => usdP(p),
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    })
    const cs = chart.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, lastValueVisible: false, priceLineVisible: false,
    })
    cs.attachPrimitive(prim.current)
    for (const p of PERIODS) {
      lineRefs.current[p] = chart.addLineSeries({ color: PERIOD_COLOR[p], lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false })
    }
    chartRef.current = chart
    candleRef.current = cs
    chart.subscribeCrosshairMove((p) => {
      const fn = hoverRef.current
      if (!fn) return
      const D = dataRef.current
      const i = p.time != null && D.candles ? D.candles.t.indexOf(p.time as number) : -1
      if (i < 0 || !D.candles) { fn(null); return }
      const c = D.candles
      fn({ time: c.t[i], open: c.o[i], high: c.h[i], low: c.l[i], close: c.c[i],
        vwap: Object.fromEntries(PERIODS.map((k) => [k, D.lines[k]?.vwap[i] ?? null])) as Partial<Record<VwapPeriod, number | null>> })
    })
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    const lines = lineRefs.current
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      for (const k of PERIODS) delete lines[k]
    }
  }, [])

  // ---------- levels (horizontal, extended) from options
  const levels = useMemo<Level[]>(() => {
    const out: Level[] = []
    const t = data.candles?.t ?? []
    const last = t[t.length - 1] ?? 0
    const wAnchor = data.levels.w?.anchor ?? last
    const from = Math.min(wAnchor, last - 2 * 86400)   // levels start near "now" (current week) like the reference
    // periods sharing the same anchor (M = Q in Oct, M = Q = Y in Jan) have identical current levels: shown once
    const sameAs = sharedAnchor(data, opts)
    for (const p of PERIODS) {
      if (!opts.periods[p]) continue
      const L = data.levels[p]
      if (!L) continue
      const c = PERIOD_COLOR[p]
      const N = PERIODS.filter((x) => x === p || sameAs[x] === p).map((x) => NAME[x]).join('/')
      const dupCur = sameAs[p] != null
      if (dupCur) {
        if (opts.prev && L.prev.vwap != null) out.push({ id: `p${p}_vwap`, name: `p${NAME[p]} VWAP`, short: `p${TAG[p]}`, value: L.prev.vwap, color: c, kind: 'prev', from })
        if (opts.prevBands && L.prev.up1 != null) out.push({ id: `p${p}_vah`, name: `p${NAME[p]} VAH`, short: `p${TAG[p]}+`, value: L.prev.up1, color: c, kind: 'prevBand', from })
        if (opts.prevBands && L.prev.dn1 != null) out.push({ id: `p${p}_val`, name: `p${NAME[p]} VAL`, short: `p${TAG[p]}−`, value: L.prev.dn1, color: c, kind: 'prevBand', from })
        continue
      }
      if (opts.cur && L.vwap != null) out.push({ id: `${p}_vwap`, name: `${N} VWAP`, short: TAG[p], value: L.vwap, color: c, kind: 'cur', from: last })
      if (opts.curBands && L.up1 != null) out.push({ id: `${p}_vah`, name: `${N} VAH`, short: `${TAG[p]}+`, value: L.up1, color: c, kind: 'curBand', from })
      if (opts.curBands && L.dn1 != null) out.push({ id: `${p}_val`, name: `${N} VAL`, short: `${TAG[p]}−`, value: L.dn1, color: c, kind: 'curBand', from })
      if (opts.prev && L.prev.vwap != null) out.push({ id: `p${p}_vwap`, name: `p${NAME[p]} VWAP`, short: `p${TAG[p]}`, value: L.prev.vwap, color: c, kind: 'prev', from })
      if (opts.prevBands && L.prev.up1 != null) out.push({ id: `p${p}_vah`, name: `p${NAME[p]} VAH`, short: `p${TAG[p]}+`, value: L.prev.up1, color: c, kind: 'prevBand', from })
      if (opts.prevBands && L.prev.dn1 != null) out.push({ id: `p${p}_val`, name: `p${NAME[p]} VAL`, short: `p${TAG[p]}−`, value: L.prev.dn1, color: c, kind: 'prevBand', from })
    }
    return out
  }, [data, opts])

  useEffect(() => {
    prim.current.set({ levels, showProfile, sessions: data.profile.sessions, compact })
  }, [levels, showProfile, data, compact])

  useEffect(() => {
    const sameAs = sharedAnchor(data, opts)
    for (const p of PERIODS) lineRefs.current[p]?.applyOptions({ visible: opts.periods[p] && opts.cur && sameAs[p] == null })
  }, [opts, data])

  // ---------- default view: last ~30 days + the empty space on the right
  const applyView = () => {
    const chart = chartRef.current
    const D = dataRef.current
    if (!chart || !D.candles) return
    const t = D.candles.t
    const n = t.length
    const span = Math.round((30 * 86400) / D.step)
    const nFut = Math.max(16, Math.round(n * 0.2))
    const from = Math.max(0, n - span)
    const extra = compactRef.current ? Math.round(nFut * 0.35) : Math.round(Math.min(nFut, (n - from) * 0.22))
    chart.timeScale().setVisibleLogicalRange({ from, to: n - 1 + extra })
  }

  // ---------- data
  useEffect(() => {
    const chart = chartRef.current
    const cs = candleRef.current
    const c = data.candles
    if (!chart || !cs || !c) return
    const ts = chart.timeScale()
    const before = ts.getVisibleLogicalRange()
    const prevN = nBars.current
    const bars = c.t.map((x, i) => ({ time: x as UTCTimestamp, open: c.o[i], high: c.h[i], low: c.l[i], close: c.c[i] }))
    cs.setData([...bars, ...future.map((x) => ({ time: x as UTCTimestamp }))])
    for (const p of PERIODS) lineRefs.current[p]?.setData(lineData(c.t, data.lines[p]?.vwap ?? []))
    prim.current.set({ t: c.t, step: data.step })
    const n = bars.length
    nBars.current = n
    const last = bars[n - 1]
    lastBar.current = last ? { time: last.time as number, open: last.open, high: last.high, low: last.low, close: last.close } : null
    const lb = liveBar.current
    if (lb && lastBar.current && lb.time >= lastBar.current.time) {
      const m = lb.time === lastBar.current.time
        ? { ...lastBar.current, high: Math.max(lastBar.current.high, lb.high), low: Math.min(lastBar.current.low, lb.low), close: lb.close }
        : lb
      try { cs.update({ ...m, time: m.time as UTCTimestamp }); lastBar.current = m } catch { /* ignore */ }
    }
    const key = `${data.source}|${data.calc}|${data.tf}`
    if (viewKey.current !== key) {
      viewKey.current = key
      requestAnimationFrame(() => requestAnimationFrame(applyView))
    } else if (before) {
      const shift = before.to >= prevN - 2 ? n - prevN : 0
      ts.setVisibleLogicalRange({ from: before.from + shift, to: before.to + shift })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, future])

  useEffect(() => {
    if (fitSignal) applyView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal])
  useEffect(() => {
    if (viewKey.current) applyView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact])

  // ---------- live forming candle
  useEffect(() => {
    setLivePx(null)
    liveBar.current = null
    const onTick = (price: number, hi: number, lo: number, ts: number) => {
      const cs = candleRef.current
      const last = lastBar.current
      const step = dataRef.current.step
      if (!cs || !last || dataRef.current.source !== source) return
      let bar: Bar
      if (ts >= last.time + step) {
        bar = { time: ts - (ts % step), open: last.close, high: Math.max(hi, price, last.close), low: Math.min(lo, price, last.close), close: price }
      } else if (ts >= last.time) {
        bar = { ...last, high: Math.max(last.high, hi, price), low: Math.min(last.low, lo, price), close: price }
      } else return
      try {
        cs.update({ ...bar, time: bar.time as UTCTimestamp })
        lastBar.current = bar
        liveBar.current = bar
        setLivePx(price)
      } catch { /* a new bar inside the whitespace area is fine; out-of-order updates are ignored */ }
    }
    if (source === 'kraken') return live.onVwapTick((m) => onTick(m.price, m.high, m.low, m.time))
    return live.onPerpKline((m) => onTick(m.candle.close, m.candle.high, m.candle.low, m.candle.time))
  }, [source])

  // ---------- axis labels + level pills (positions follow zoom/scroll; state only on change)
  useEffect(() => {
    let raf = 0
    let lastSig = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (document.visibilityState !== 'visible') return
      const chart = chartRef.current
      const cs = candleRef.current
      const el = elRef.current
      const D = dataRef.current
      if (!chart || !cs || !el || !D.candles) return
      const h = el.clientHeight - chart.timeScale().height()
      const w = chart.priceScale('right').width()
      const items: { L: Level | null; y: number; price?: number; up?: boolean }[] = groupLevels(levels.map((L) => ({ L, y: cs.priceToCoordinate(L.value) ?? -9999 })), compactRef.current)
      const lb = lastBar.current
      if (lb) items.push({ L: null, y: cs.priceToCoordinate(lb.close) ?? -9999, price: lb.close, up: lb.close >= lb.open })
      const lay = layoutPills(items, h)
      const py = priceTicks(cs, h, lay.map((i) => i.y))
      const tx = timeTicks(chart, [...D.candles.t, ...future], D.step, el.clientWidth - w)
      const sig = `${w}|${h}|${compactRef.current}|` + lay.map((i) => `${i.L?.id ?? 'px'}:${Math.round(i.y)}:${i.L?.value ?? i.price}`).join(',') + '|' + py.map((x) => Math.round(x.y)).join(',') + '|' + tx.map((x) => Math.round(x.x)).join(',')
      if (sig !== lastSig) {
        lastSig = sig
        setPills(lay)
        setAxisW(w)
        setTicks({ py, tx, axisY: h })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [levels, future, livePx])

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
        {pills.map(({ L, y, off, price, up }) => {
          if (!L) {
            return (
              <div key="price" className="tnum absolute right-0 flex text-[10px] font-semibold leading-none" style={{ top: y - PILL_H / 2, height: PILL_H }}>
                <span className="flex items-center justify-end rounded-[4px] px-1.5" style={{ width: axisW, background: up ? C.up : C.down, color: T.bg }}>{usdP(price)}</span>
              </div>
            )
          }
          const strong = L.kind === 'cur' || L.kind === 'prev'
          const name = `${off < 0 ? '▲ ' : off > 0 ? '▼ ' : ''}${compact ? L.short : L.name}`
          return (
            <div key={L.id} className="tnum absolute right-0 flex items-stretch text-[10px] font-medium leading-none" style={{ top: y - PILL_H / 2, height: PILL_H }}>
              <span className="mr-px flex items-center whitespace-nowrap rounded-l-[4px] px-1.5"
                style={{ background: mix(L.color, 0.12), color: L.kind === 'prevBand' || L.kind === 'curBand' ? hexA(L.color, 0.85) : L.color, boxShadow: `inset 0 0 0 1px ${hexA(L.color, strong ? 0.4 : 0.22)}` }}>
                {name}
              </span>
              <span className="flex items-center justify-end rounded-r-[4px] px-1.5"
                style={{ width: axisW, background: L.kind === 'cur' ? L.color : L.kind === 'prev' ? mix(L.color, 0.72) : mix(L.color, 0.38), color: L.kind === 'cur' || L.kind === 'prev' ? T.bg : T.fg }}>
                {usdP(L.value)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
