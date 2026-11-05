/*
 * Grafico principale del Terminale: candele Binance perp (lightweight-charts) + overlay in canvas:
 *   sotto le candele  heatmap della liquidità del book Binance perp (dati e colonne live dell'order book, stessa scala magma);
 *   sopra le candele  livelli di liquidazione STIMATI (bande tratteggiate) e bolle delle liquidazioni REALI (area ∝ USD).
 * Le coordinate degli overlay vengono da logicalToCoordinate / priceToCoordinate: un ciclo rAF ridisegna solo quando la mappatura
 * (zoom, pan, scala prezzi) o i dati cambiano. Zoom/pan e crosshair sono sincronizzati con i pannelli (SyncBus).
 */
import { useEffect, useRef, useState } from 'react'
import {
  createChart, CrosshairMode, LineStyle, TickMarkType,
  type IChartApi, type ISeriesApi, type LogicalRange, type MouseEventParams, type Time, type UTCTimestamp,
} from 'lightweight-charts'
import type { EstLevel, LiqItem, TermSeries, TermTf } from '../api/terminal'
import { C, FONT, hexA } from '../components/charts/theme'
import { compact, usd, usdCompact } from '../lib/format'
import { cap, months, t } from '../i18n'
import { LUT, appendLive, type HmStore } from './orderbookHeatmap'
import type { TermLive } from './terminalLive'
import { T, alpha } from '../theme/tokens'

export const TZ = -new Date().getTimezoneOffset() * 60
export const lt = (x: number) => (x + TZ) as UTCTimestamp
export const TF_S: Record<TermTf, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }
const SCALE_W = 74
/** prezzo sull'asse: $81,550 (non compattato: serve la precisione al dollaro sui timeframe brevi) */
const pxFmt = (p: number) => (p < 0 ? '−$' : '$') + Math.abs(p).toLocaleString('en-US', { maximumFractionDigits: Math.abs(p) >= 1000 ? 0 : 2 })
const GAMMA = 0.55

export const EX_LABEL: Record<string, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', coinbase: 'Coinbase' }

export const tickFmt = (x: Time, type: TickMarkType) => {
  const d = new Date((x as number) * 1000)
  if (type === TickMarkType.Year) return String(d.getUTCFullYear())
  if (type === TickMarkType.Month) return cap(months()[d.getUTCMonth()])
  if (type === TickMarkType.DayOfMonth) return `${d.getUTCDate()} ${months()[d.getUTCMonth()]}`
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
export const timeFmt = (x: Time) => {
  const d = new Date((x as number) * 1000)
  return `${d.getUTCDate()} ${months()[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function chartOptions(el: HTMLElement, fmt: (p: number) => string, timeVisible: boolean) {
  return {
    width: el.clientWidth, height: el.clientHeight,
    layout: { background: { color: 'transparent' }, textColor: C.muted, fontFamily: FONT, fontSize: 11, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.axis, minimumWidth: SCALE_W, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: C.axis, rightOffset: 4, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickFmt, visible: timeVisible },
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

// ------------------------------------------------------------------ sincronizzazione tra grafico e pannelli
type RangeFn = (r: LogicalRange) => void
type CrossFn = (time: number | null) => void
export class SyncBus {
  private ranges = new Map<string, RangeFn>()
  private crosses = new Map<string, CrossFn>()
  active: string | null = null
  last: LogicalRange | null = null
  on(id: string, r: RangeFn, c: CrossFn) {
    this.ranges.set(id, r); this.crosses.set(id, c)
    return () => { this.ranges.delete(id); this.crosses.delete(id) }
  }
  range(src: string, r: LogicalRange) {
    if (this.active && this.active !== src) return
    this.last = r
    this.ranges.forEach((fn, id) => { if (id !== src) fn(r) })
  }
  cross(src: string, time: number | null) {
    this.crosses.forEach((fn, id) => { if (id !== src) fn(time) })
  }
}

// ------------------------------------------------------------------ heatmap offscreen
function percentile(s: HmStore, p: number): number {
  const vals: number[] = []
  const stride = Math.max(1, Math.floor((s.cols.length * s.rows) / 120_000))
  let k = 0
  for (const col of s.cols) for (let r = 0; r < col.length; r++) { if (k++ % stride) continue; const v = col[r]; if (v > 0) vals.push(v) }
  if (!vals.length) return 1
  vals.sort((a, b) => a - b)
  return vals[Math.min(vals.length - 1, Math.floor((p / 100) * vals.length))] || 1
}

interface Off { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData; key: string; clip: number; at: number }

function paintCol(s: HmStore, img: ImageData, c: number, clip: number) {
  const arr = s.cols[c]
  const W = img.width
  const data = img.data
  for (let r = 0; r < s.rows; r++) {
    const o = ((s.rows - 1 - r) * W + c) * 4
    const v = arr[r]
    if (!(v > 0)) { data[o + 3] = 0; continue }
    const x = Math.min(1, v / clip)
    const li = Math.round(Math.pow(x, GAMMA) * 255) * 3
    data[o] = LUT[li]; data[o + 1] = LUT[li + 1]; data[o + 2] = LUT[li + 2]
    data[o + 3] = Math.round(28 + 215 * Math.pow(x, 0.85))   // celle povere quasi trasparenti: le candele restano leggibili
  }
}

export interface ChartOpts { heat: boolean; est: boolean; bubbles: boolean; vol: boolean }
interface Tip { x: number; y: number; title: string; rows: { k: string; v: string; c?: string }[] }

export default function TerminalChart({ data, tf, heat, est, opts, live, sync, onReady }: {
  data: TermSeries; tf: TermTf; heat: HmStore | null; est: EstLevel[]; opts: ChartOpts; live: TermLive; sync: SyncBus
  onReady?: (api: { reset: () => void }) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const el = useRef<HTMLDivElement>(null)
  const under = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const rt = useRef<{ chart: IChartApi; candle: ISeriesApi<'Candlestick'>; vol: ISeriesApi<'Histogram'> } | null>(null)
  const st = useRef({ data, tf, heat, est, opts, liqs: [] as { t: number; p: number; u: number; long: boolean; x: string }[],
    last: null as null | { t: number; o: number; h: number; l: number; c: number; v: number }, tArr: [] as number[] })
  st.current.data = data; st.current.tf = tf; st.current.heat = heat; st.current.est = est; st.current.opts = opts
  const off = useRef<Off | null>(null)
  const dirty = useRef(true)
  const sig = useRef('')
  const [tip, setTip] = useState<Tip | null>(null)
  const drawMs = useRef(0)

  // ---------- creazione (una volta)
  useEffect(() => {
    const e = el.current!
    const chart = createChart(e, chartOptions(e, pxFmt, true))
    const candle = chart.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 }, lastValueVisible: true, priceLineVisible: true, priceLineColor: C.price, priceLineStyle: LineStyle.Dotted,
    })
    const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false })
    rt.current = { chart, candle, vol }
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: e.clientWidth, height: e.clientHeight }); dirty.current = true })
    ro.observe(e)
    const id = 'main'
    const enter = () => { sync.active = id }
    e.addEventListener('pointerenter', enter, { capture: true, passive: true })
    e.addEventListener('wheel', enter, { capture: true, passive: true })
    e.addEventListener('touchstart', enter, { capture: true, passive: true })
    const onRange = (r: LogicalRange | null) => { if (r) sync.range(id, r); dirty.current = true }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    const off = sync.on(id, (r) => chart.timeScale().setVisibleLogicalRange(r), (time) => {
      if (time == null) { chart.clearCrosshairPosition(); return }
      const L = st.current.last
      const i = st.current.tArr.indexOf(time)
      const c = i >= 0 ? st.current.data.c[i] : L?.c
      if (c != null) chart.setCrosshairPosition(c, lt(time), candle)
    })
    onReady?.({ reset: () => { chart.timeScale().scrollToRealTime(); chart.priceScale('right').applyOptions({ autoScale: true }); dirty.current = true } })
    return () => {
      off()
      e.removeEventListener('pointerenter', enter, { capture: true })
      e.removeEventListener('wheel', enter, { capture: true })
      e.removeEventListener('touchstart', enter, { capture: true })
      ro.disconnect()
      chart.remove()
      rt.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- dati storici
  useEffect(() => {
    const r = rt.current
    if (!r) return
    const ts = r.chart.timeScale()
    const prevTf = sig.current.split('|')[0]
    const range = prevTf === tf ? ts.getVisibleRange() : null
    const atEnd = (() => { const lr = ts.getVisibleLogicalRange(); return !lr || lr.to >= st.current.tArr.length - 3 })()
    const cs = [], vs = []
    for (let i = 0; i < data.t.length; i++) {
      const o = data.o[i], h = data.h[i], l = data.l[i], c = data.c[i]
      if (o == null || h == null || l == null || c == null) { cs.push({ time: lt(data.t[i]) }); vs.push({ time: lt(data.t[i]) }); continue }
      cs.push({ time: lt(data.t[i]), open: o, high: h, low: l, close: c })
      vs.push({ time: lt(data.t[i]), value: data.v[i] ?? 0, color: hexA(c >= o ? C.up : C.down, 0.32) })
    }
    r.candle.setData(cs)
    r.vol.setData(vs)
    st.current.tArr = [...data.t]
    const n = data.t.length - 1
    st.current.last = n >= 0 && data.c[n] != null ? { t: data.t[n], o: data.o[n]!, h: data.h[n]!, l: data.l[n]!, c: data.c[n]!, v: data.v[n] ?? 0 } : null
    // liquidazioni storiche
    const L = data.liq
    st.current.liqs = L.t.map((x, i) => ({ t: x, p: L.p[i], u: L.u[i], long: L.s[i] === 1, x: L.x[i] }))
    if (range && !atEnd) {
      try { ts.setVisibleRange(range) } catch { /* fuori dai dati */ }
    } else if (prevTf !== tf) {
      const bars = tf === '1m' ? 240 : tf === '5m' ? 220 : tf === '15m' ? 200 : 240
      ts.setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 4 })
    }
    sig.current = `${tf}|${data.t[0]}`
    dirty.current = true
  }, [data, tf])

  useEffect(() => { rt.current?.vol.applyOptions({ visible: opts.vol }); dirty.current = true }, [opts.vol])
  useEffect(() => { dirty.current = true; off.current = null }, [heat, est, opts.heat, opts.est, opts.bubbles])

  // ---------- live: prezzo, barra corrente, liquidazioni, colonne heatmap
  useEffect(() => {
    const onPx = (px: number, time: number) => {
      const r = rt.current
      const s = st.current
      if (!r || !s.last) return
      const tf_s = TF_S[s.tf]
      const bt = Math.floor(time / tf_s) * tf_s
      if (bt < s.last.t) return
      if (bt > s.last.t) {
        s.last = { t: bt, o: s.last.c, h: Math.max(s.last.c, px), l: Math.min(s.last.c, px), c: px, v: 0 }
        s.tArr.push(bt)
      } else {
        s.last.c = px; s.last.h = Math.max(s.last.h, px); s.last.l = Math.min(s.last.l, px)
      }
      const b = s.last
      r.candle.update({ time: lt(b.t), open: b.o, high: b.h, low: b.l, close: b.c })
      dirty.current = true
    }
    const onBar = (bar: { t: number; v: number | null }) => {
      const r = rt.current
      const s = st.current
      if (!r || !s.last || bar.t !== s.last.t || bar.v == null) return
      s.last.v = Math.max(s.last.v, bar.v)
      r.vol.update({ time: lt(s.last.t), value: s.last.v, color: hexA(s.last.c >= s.last.o ? C.up : C.down, 0.32) })
    }
    const onLiq = (add: LiqItem[]) => {
      for (const l of add) st.current.liqs.push({ t: l.t, p: l.price, u: l.usd, long: l.side === 'long', x: l.ex })
      dirty.current = true
    }
    const onHm = (cols: Parameters<typeof appendLive>[1][]) => {
      const h = st.current.heat
      if (!h) return
      for (const c of cols) appendLive(h, c)
      dirty.current = true
    }
    live.pxListeners.add(onPx); live.barListeners.add(onBar); live.liqListeners.add(onLiq); live.hmListeners.add(onHm)
    return () => { live.pxListeners.delete(onPx); live.barListeners.delete(onBar); live.liqListeners.delete(onLiq); live.hmListeners.delete(onHm) }
  }, [live])

  // ---------- disegno degli overlay (rAF; solo se mappa o dati cambiano)
  useEffect(() => {
    let raf = 0
    let mapSig = ''
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const r = rt.current
      if (!r) return
      const ts = r.chart.timeScale()
      const x0 = ts.logicalToCoordinate(0 as never), x1 = ts.logicalToCoordinate(1 as never)
      const ref = st.current.last?.c ?? 100000
      const ya = r.candle.priceToCoordinate(ref), yb = r.candle.priceToCoordinate(ref * 1.01)
      const ps = r.chart.paneSize()
      const m = `${x0}|${x1}|${ya}|${yb}|${ps.width}|${ps.height}`
      if (m === mapSig && !dirty.current) return
      mapSig = m
      dirty.current = false
      if (x0 == null || x1 == null || ya == null || yb == null) return
      const t0p = performance.now()
      draw(ps.width, ps.height, x0, x1 - x0, ya, (yb - ya) / (ref * 0.01), ref)
      drawMs.current = drawMs.current * 0.9 + (performance.now() - t0p) * 0.1
      live.perf.drawMs = +drawMs.current.toFixed(2)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [live]) // eslint-disable-line react-hooks/exhaustive-deps

  function sizeCanvas(cv: HTMLCanvasElement, w: number, h: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`; cv.style.height = `${h}px`
    }
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    return ctx
  }

  /** x0 = coordinata del centro della barra 0, bw = larghezza di una barra; y(p) = ya + k·(p − ref). */
  function draw(w: number, h: number, x0: number, bw: number, ya: number, k: number, ref: number) {
    const s = st.current
    const tf_s = TF_S[s.tf]
    const tStart = s.tArr[0] ?? 0
    const X = (time: number) => x0 + ((time - tStart) / tf_s - 0.5) * bw
    const Y = (p: number) => ya + k * (p - ref)
    // ---- heatmap (sotto le candele)
    const u = under.current, o = over.current
    if (!u || !o) return
    const uc = sizeCanvas(u, w, h)
    const hs = s.heat
    if (hs && s.opts.heat && hs.cols.length) {
      const key = `${hs.priceLo}|${hs.rows}|${hs.bucket}|${hs.shifted}|${hs.maxCols}`
      let of = off.current
      if (!of || of.key !== key || hs.version - of.at > 300) {
        const clip = percentile(hs, 98.5)
        const canvas = of?.canvas ?? document.createElement('canvas')
        canvas.width = hs.maxCols; canvas.height = hs.rows
        const ctx = canvas.getContext('2d')!
        const img = ctx.createImageData(hs.maxCols, hs.rows)
        for (let c = 0; c < hs.cols.length; c++) paintCol(hs, img, c, clip)
        ctx.putImageData(img, 0, 0)
        of = off.current = { canvas, ctx, img, key, clip, at: hs.version }
        hs.dirtyCols.clear()
      } else if (hs.dirtyCols.size) {
        for (const c of hs.dirtyCols) {
          if (c >= of.img.width) continue
          paintCol(hs, of.img, c, of.clip)
          of.ctx.putImageData(of.img, 0, 0, c, 0, 1, hs.rows)
        }
        hs.dirtyCols.clear()
      }
      const xl = X(hs.from), xr = X(hs.from + hs.maxCols * hs.dt)
      const yt = Y(hs.priceLo + hs.rows * hs.bucket), yb2 = Y(hs.priceLo)
      uc.imageSmoothingEnabled = false
      uc.globalAlpha = 0.9
      uc.drawImage(of.canvas, 0, 0, hs.maxCols, hs.rows, xl, yt, xr - xl, yb2 - yt)
      uc.globalAlpha = 1
    }
    // ---- overlay (sopra le candele): livelli stimati, inizio raccolta, bolle
    const oc = sizeCanvas(o, w, h)
    if (s.opts.est && s.est.length) {
      const vis = s.est.filter((e) => { const y = Y(e.price); return y > -4 && y < h + 4 })
      const mx = Math.max(1, ...s.est.map((e) => e.usd))
      const top = [...vis].sort((a, b) => b.usd - a.usd).slice(0, 5)
      for (const e of vis) {
        const y = Math.round(Y(e.price)) + 0.5
        const a = 0.18 + 0.6 * (e.usd / mx)
        const col = e.side === 'long' ? C.down : C.up
        oc.strokeStyle = hexA(col, a); oc.lineWidth = 1 + 2 * (e.usd / mx); oc.setLineDash([5, 4])
        oc.beginPath(); oc.moveTo(0, y); oc.lineTo(w, y); oc.stroke()
      }
      oc.setLineDash([])
      oc.font = `500 10px ${FONT}`; oc.textBaseline = 'middle'; oc.textAlign = 'right'
      for (const e of top) {
        const y = Y(e.price)
        const txt = `${t('Stima')} ${e.side === 'long' ? 'long' : 'short'} ${usdCompact(e.usd, 0)}`
        const tw = oc.measureText(txt).width + 10
        oc.fillStyle = alpha(T.surface, 0.82); oc.fillRect(w - tw - 6, y - 8, tw, 16)
        oc.fillStyle = e.side === 'long' ? T.downHi : T.upHi; oc.fillText(txt, w - 11, y)
      }
    }
    const mf = s.data.multi_from
    if (mf && mf > tStart) {
      const x = Math.round(X(mf)) + 0.5
      if (x > 0 && x < w) {
        oc.strokeStyle = alpha(T.warn, 0.55); oc.setLineDash([4, 4]); oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, h); oc.stroke(); oc.setLineDash([])
        oc.fillStyle = C.warn; oc.font = `500 10px ${FONT}`; oc.textAlign = 'left'; oc.textBaseline = 'alphabetic'
        oc.fillText(t('Raccolta multi-exchange'), x + 4, h - 8)
      }
    }
    if (s.opts.bubbles && s.liqs.length) {
      const tA = tStart + (-x0 / bw) * tf_s - tf_s, tB = tStart + ((w - x0) / bw + 1) * tf_s
      const vis = s.liqs.filter((l) => l.t >= tA && l.t <= tB).sort((a, b) => a.u - b.u)
      for (const l of vis) {
        const y = Y(l.p)
        if (y < -30 || y > h + 30) continue
        const x = X(l.t)
        const r = Math.max(2.5, Math.min(30, Math.sqrt(l.u / 1e6) * 13))
        const col = l.long ? C.down : C.up
        oc.beginPath(); oc.arc(x, y, r, 0, Math.PI * 2)
        oc.fillStyle = hexA(col, 0.22); oc.fill()
        oc.lineWidth = 1; oc.strokeStyle = hexA(col, 0.85); oc.stroke()
      }
    }
  }

  // ---------- tooltip (crosshair)
  useEffect(() => {
    const r = rt.current
    if (!r) return
    let raf = 0
    const fn = (p: MouseEventParams<Time>) => {
      if (sync.active === 'main') sync.cross('main', p.time != null ? (p.time as number) - TZ : null)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!p.point || p.logical == null) { setTip(null); return }
        const s = st.current
        const i = Math.round(p.logical as number)
        const rows: Tip['rows'] = []
        const tt = s.tArr[i]
        if (tt == null) { setTip(null); return }
        const isLast = i === s.tArr.length - 1 && s.last
        const o = isLast ? s.last!.o : s.data.o[i], h = isLast ? s.last!.h : s.data.h[i], l = isLast ? s.last!.l : s.data.l[i], c = isLast ? s.last!.c : s.data.c[i]
        if (o != null && c != null) {
          rows.push({ k: t('Apertura · chiusura'), v: `${usd(o, 1)} · ${usd(c, 1)}`, c: c >= o ? C.up : C.down })
          rows.push({ k: t('Massimo · minimo'), v: `${usd(h, 1)} · ${usd(l, 1)}` })
        }
        const v = isLast ? s.last!.v : s.data.v[i]
        if (v != null) rows.push({ k: t('Volume Binance perp'), v: `${compact(v, 1)} BTC` })
        const vb = s.data.vb[i], vs = s.data.vs[i]
        if (vb != null && vs != null && i < s.data.t.length) rows.push({ k: t('Delta aggregato'), v: `${vb - vs >= 0 ? '+' : '−'}${compact(Math.abs(vb - vs), 1)} BTC`, c: vb >= vs ? C.up : C.down })
        // cella della heatmap sotto il cursore
        const price = r.candle.coordinateToPrice(p.point.y)
        const hs = s.heat
        if (hs && s.opts.heat && price != null) {
          const ts = r.chart.timeScale()
          const x0 = ts.logicalToCoordinate(0 as never), x1 = ts.logicalToCoordinate(1 as never)
          if (x0 != null && x1 != null) {
            const tm = (s.tArr[0] ?? 0) + ((p.point.x - x0) / (x1 - x0) + 0.5) * TF_S[s.tf]
            const ci = Math.floor((tm - hs.from) / hs.dt), ri = Math.floor((price - hs.priceLo) / hs.bucket)
            const val = hs.cols[ci]?.[ri]
            if (val != null && val > 0) rows.push({ k: t('Liquidità nel book'), v: `${val.toFixed(val < 10 ? 2 : 1)} BTC @ ${usd(hs.priceLo + ri * hs.bucket, 0)}` })
          }
        }
        // bolla di liquidazione più vicina
        if (s.opts.bubbles) {
          const ts = r.chart.timeScale()
          const x0 = ts.logicalToCoordinate(0 as never), x1 = ts.logicalToCoordinate(1 as never)
          if (x0 != null && x1 != null) {
            const bw = x1 - x0
            let best: (typeof s.liqs)[number] | null = null
            let bd = Infinity
            for (const q of s.liqs) {
              const x = x0 + ((q.t - (s.tArr[0] ?? 0)) / TF_S[s.tf] - 0.5) * bw
              if (Math.abs(x - p.point.x) > 32) continue
              const y = r.candle.priceToCoordinate(q.p)
              if (y == null) continue
              const rr = Math.max(2.5, Math.min(30, Math.sqrt(q.u / 1e6) * 13))
              const d = Math.hypot(x - p.point.x, y - p.point.y) - rr
              if (d < 4 && d < bd) { bd = d; best = q }
            }
            if (best) {
              rows.push({ k: best.long ? t('Long liquidato') : t('Short liquidato'), v: `${usdCompact(best.u, 2)} @ ${usd(best.p, 0)}`, c: best.long ? C.down : C.up })
              rows.push({ k: t('Exchange'), v: `${EX_LABEL[best.x] ?? best.x} · ${new Date(best.t * 1000).toLocaleTimeString('en-GB')}` })
            }
          }
        }
        setTip({ x: p.point.x, y: p.point.y, title: timeFmt(lt(tt)), rows })
      })
    }
    r.chart.subscribeCrosshairMove(fn)
    return () => { cancelAnimationFrame(raf); r.chart.unsubscribeCrosshairMove(fn) }
  }, [sync])

  const W = wrap.current?.clientWidth ?? 600
  const H = wrap.current?.clientHeight ?? 400
  return (
    <div ref={wrap} className="relative h-full w-full select-none overflow-hidden" data-testid="term-chart">
      <canvas ref={under} className="pointer-events-none absolute left-0 top-0" />
      <div ref={el} className="absolute inset-0" />
      <canvas ref={over} className="pointer-events-none absolute left-0 top-0" />
      {tip && tip.rows.length > 0 && (
        <div className="pop pointer-events-none absolute z-10 w-64 rounded-xl p-2.5 text-xs"
          style={{ left: tip.x + 16 + 256 > W - SCALE_W ? Math.max(4, tip.x - 16 - 256) : tip.x + 16,
            // lower half of the chart: anchored by its bottom edge above the cursor, so it is never cut by the tile
            ...(tip.y > H / 2 ? { bottom: Math.max(4, H - tip.y + 12) } : { top: Math.max(4, tip.y + 12) }) }}>
          <div className="label mb-1.5 text-fg-2">{tip.title}</div>
          {tip.rows.map((x) => (
            <div key={x.k} className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="whitespace-nowrap text-fg-3">{x.k}</span>
              <span className="tnum text-right font-medium text-white" style={x.c ? { color: x.c } : undefined}>{x.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
