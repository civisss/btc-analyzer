/*
 * Heatmap dell'order book (stile Bookmap) in canvas: asse X tempo, asse Y prezzo, colore = liquidità resting nel bucket.
 * Rendering: la matrice tempo × prezzo vive in un canvas offscreen (1 pixel per cella, ImageData); a ogni frame si copia la
 * porzione visibile con drawImage (smoothing off) e sopra si disegnano prezzo, bolle dei trade, eventi, assi e crosshair.
 * Le colonne live (WebSocket, 1/s) aggiornano solo la colonna toccata dell'offscreen.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ObEvent, ObHeatmap, ObLiveCol } from '../api/orderbook'
import { decodeU16 } from '../api/orderbook'
import { HEAT, FONT, hexA } from '../components/charts/theme'
import { t } from '../i18n'
import { compact, usd } from '../lib/format'
import { T, alpha } from '../theme/tokens'

type N = number | null

// ------------------------------------------------------------------ colour LUT (nero → arancione → bianco)
function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export const LUT: Uint8ClampedArray = (() => {
  const stops = HEAT.map(hexRgb)
  const out = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (stops.length - 1)
    const a = Math.floor(x)
    const b = Math.min(stops.length - 1, a + 1)
    const f = x - a
    for (let k = 0; k < 3; k++) out[i * 3 + k] = stops[a][k] + (stops[b][k] - stops[a][k]) * f
  }
  return out
})()
const NODATA = hexRgb(T.bg)
const GAMMA = 0.95

// ------------------------------------------------------------------ data store (mutable, column-major)
export interface HmStore {
  market: string; from: number; dt: number; priceLo: number; bucket: number; rows: number; tier: 's' | 'm'
  cols: Float32Array[]; cnt: number[]
  last: N[]; mid: N[]; hi: N[]; lo: N[]; vb: number[]; vs: number[]; vwap: N[]; tlo: N[]; thi: N[]; imb: N[]
  events: ObEvent[]; gaps: [number, number][]; collectionStart: N
  version: number; shifted: number; dirtyCols: Set<number>; maxCols: number
}

export function buildStore(d: ObHeatmap): HmStore | null {
  if (!d.cols || !d.rows || d.price_lo == null) return null
  const flat = decodeU16(d.q, d.scale)
  const cols: Float32Array[] = []
  for (let c = 0; c < d.cols; c++) cols.push(flat.subarray(c * d.rows, (c + 1) * d.rows))
  const nz = (a: N[]) => a.map((x) => x ?? 0)
  return {
    market: d.market, from: d.from, dt: d.dt, priceLo: d.price_lo, bucket: d.bucket, rows: d.rows, tier: d.tier,
    cols, cnt: cols.map(() => 1),
    last: [...d.last], mid: [...d.mid], hi: [...d.hi], lo: [...d.lo], vb: nz(d.vb), vs: nz(d.vs), vwap: [...d.vwap], tlo: [...d.tlo], thi: [...d.thi], imb: [...d.imb],
    events: [...d.events], gaps: [...d.gaps], collectionStart: d.collection_start,
    version: 0, shifted: 0, dirtyCols: new Set(), maxCols: Math.max(d.cols + 900, Math.round(d.cols * 1.3)),
  }
}

/** Integra una colonna live nella colonna di tempo corrispondente (media dei campioni). */
export function appendLive(s: HmStore, col: ObLiveCol) {
  let c = Math.floor((col.t - s.from) / s.dt)
  if (c < 0) return
  while (c >= s.cols.length) {
    s.cols.push(new Float32Array(s.rows).fill(NaN)); s.cnt.push(0)
    s.last.push(null); s.mid.push(null); s.hi.push(null); s.lo.push(null); s.vb.push(0); s.vs.push(0); s.vwap.push(null)
    s.tlo.push(null); s.thi.push(null); s.imb.push(null)
  }
  const arr = s.cols[c]
  const n = s.cnt[c]
  for (let j = 0; j < col.q.length; j++) {
    const r = Math.round((col.plo + j * s.bucket - s.priceLo) / s.bucket)
    if (r < 0 || r >= s.rows) continue
    const v = col.q[j]
    const old = arr[r]
    arr[r] = n === 0 || Number.isNaN(old) ? v : (old * n + v) / (n + 1)
  }
  s.cnt[c] = n + 1
  s.last[c] = col.last ?? s.last[c]
  s.mid[c] = col.mid
  if (col.hi != null) s.hi[c] = s.hi[c] == null ? col.hi : Math.max(s.hi[c]!, col.hi)
  if (col.lo != null) s.lo[c] = s.lo[c] == null ? col.lo : Math.min(s.lo[c]!, col.lo)
  const v0 = s.vb[c] + s.vs[c]
  const v1 = (col.vb ?? 0) + (col.vs ?? 0)
  if (v1 > 0 && col.vwap != null) s.vwap[c] = ((s.vwap[c] ?? col.vwap) * v0 + col.vwap * v1) / (v0 + v1)
  s.vb[c] += col.vb ?? 0
  s.vs[c] += col.vs ?? 0
  s.tlo[c] = col.tlo; s.thi[c] = col.thi; s.imb[c] = col.imb
  s.dirtyCols.add(c)
  // finestra scorrevole: oltre maxCols si scartano le colonne più vecchie
  const extra = s.cols.length - s.maxCols
  if (extra > 0) {
    for (const k of ['cols', 'cnt', 'last', 'mid', 'hi', 'lo', 'vb', 'vs', 'vwap', 'tlo', 'thi', 'imb'] as const) (s[k] as unknown[]).splice(0, extra)
    s.from += extra * s.dt
    s.shifted++
  }
  s.version++
}

function percentile(s: HmStore, p: number): number {
  const vals: number[] = []
  const stride = Math.max(1, Math.floor((s.cols.length * s.rows) / 150_000))
  let k = 0
  for (const col of s.cols) for (let r = 0; r < col.length; r++) { if (k++ % stride) continue; const v = col[r]; if (v > 0) vals.push(v) }
  if (!vals.length) return 1
  vals.sort((a, b) => a - b)
  return vals[Math.min(vals.length - 1, Math.floor((p / 100) * vals.length))] || 1
}

// ------------------------------------------------------------------ axis helpers
const NICE = [1, 2, 2.5, 5]
function niceStep(raw: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of NICE) if (m * e >= raw) return m * e
  return 10 * e
}
const TSTEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]
const pad2 = (n: number) => String(n).padStart(2, '0')
function tLabel(ts: number, step: number): string {
  const d = new Date(ts * 1000)
  if (step >= 86400) return `${d.getDate()}/${d.getMonth() + 1}`
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return step < 60 ? `${hm}:${pad2(d.getSeconds())}` : hm
}
const fullTime = (ts: number) => {
  const d = new Date(ts * 1000)
  return `${d.getDate()}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

// ------------------------------------------------------------------ component
export interface HeatmapOpts { contrast: number; bubbles: boolean; events: boolean; priceLine: boolean; ladder: boolean }
export interface HeatmapHandle { reset: () => void; renderMs: () => number }
interface View { t0: number; t1: number; p0: number; p1: number }
interface Hover { x: number; y: number }

const AXIS_R = 64
const AXIS_B = 22

const HeatmapCanvas = forwardRef<HeatmapHandle, { store: HmStore; opts: HeatmapOpts; span: number; compactUi?: boolean }>(function HeatmapCanvas(
  { store, opts, span, compactUi }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const off = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData; w: number; key: string } | null>(null)
  const view = useRef<View | null>(null)
  const follow = useRef(true)
  const size = useRef({ w: 0, h: 0, dpr: 1 })
  const clip = useRef<{ v: number; at: number; contrast: number; key: string }>({ v: 1, at: -1, contrast: 0, key: '' })
  const dirty = useRef(true)
  const raf = useRef(0)
  const hover = useRef<Hover | null>(null)
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean } | null>(null)
  const renderMs = useRef(0)
  const seenVersion = useRef(-1)
  const [tip, setTip] = useState<{ x: number; y: number; html: { k: string; v: string; c?: string }[]; title: string } | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const latestEnd = () => store.from + store.cols.length * store.dt
  const defaultView = useCallback((): View => {
    const t1 = latestEnd()
    // dall'inizio dei dati disponibili (lo storico esiste solo da quando l'app è accesa), al massimo l'intervallo scelto
    let first = 0
    while (first < store.cols.length - 1 && store.mid[first] == null) first++
    const t0 = Math.max(t1 - span, store.from + first * store.dt, t1 - store.cols.length * store.dt)
    let mid: number | null = null
    for (let i = store.mid.length - 1; i >= 0; i--) if (store.mid[i] != null) { mid = store.mid[i]; break }
    const top = store.priceLo + store.rows * store.bucket
    const half = mid ? Math.min((top - store.priceLo) / 2, mid * 0.006) : (top - store.priceLo) / 2
    const c = mid ?? (top + store.priceLo) / 2
    return { t0, t1, p0: c - half, p1: c + half }
  }, [store, span]) // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    reset: () => { follow.current = true; view.current = defaultView(); dirty.current = true },
    renderMs: () => renderMs.current,
  }), [defaultView])

  // ------------------------------------------------------------ offscreen image
  const paintCol = (img: ImageData, c: number, clipV: number) => {
    const { rows, cols } = store
    const arr = cols[c]
    const W = img.width
    const data = img.data
    const tlo = store.tlo[c], thi = store.thi[c]
    for (let r = 0; r < rows; r++) {
      const y = rows - 1 - r
      const o = (y * W + c) * 4
      const v = arr[r]
      if (Number.isNaN(v)) { data[o] = NODATA[0]; data[o + 1] = NODATA[1]; data[o + 2] = NODATA[2]; data[o + 3] = 255; continue }
      const x = Math.min(1, Math.max(0, v / clipV))
      const price = store.priceLo + (r + 0.5) * store.bucket
      // fuori dallo snapshot: più scuro lungo la stessa scala, così il colore resta caldo invece di virare al grigio
      const dim = tlo != null && thi != null && (price < tlo || price > thi) ? 0.62 : 1
      const li = Math.round(Math.pow(x, GAMMA) * dim * 255) * 3
      data[o] = LUT[li]; data[o + 1] = LUT[li + 1]; data[o + 2] = LUT[li + 2]; data[o + 3] = 255
    }
  }
  const ensureOff = () => {
    const w = Math.max(1, store.maxCols)   // capacità fissa: aggiungere colonne non obbliga a ridisegnare tutto
    const key = `${store.priceLo}-${store.rows}-${store.bucket}-${store.shifted}-${store.market}`
    const cl = clip.current
    const needClip = cl.contrast !== optsRef.current.contrast || cl.key !== `${store.priceLo}-${store.rows}-${store.bucket}-${store.market}` || store.version - cl.at > 300
    if (needClip) {
      clip.current = { v: percentile(store, optsRef.current.contrast), at: store.version, contrast: optsRef.current.contrast, key: `${store.priceLo}-${store.rows}-${store.bucket}-${store.market}` }
    }
    const o = off.current
    if (!o || o.w !== w || o.key !== key || needClip) {
      const canvas = o?.canvas ?? document.createElement('canvas')
      canvas.width = w
      canvas.height = store.rows
      const ctx = canvas.getContext('2d')!
      const img = ctx.createImageData(w, store.rows)
      for (let c = 0; c < store.cols.length; c++) paintCol(img, c, clip.current.v)
      ctx.putImageData(img, 0, 0)
      off.current = { canvas, ctx, img, w, key }
      store.dirtyCols.clear()
    } else if (store.dirtyCols.size) {
      for (const c of store.dirtyCols) {
        if (c >= o.w) continue
        paintCol(o.img, c, clip.current.v)
        o.ctx.putImageData(o.img, 0, 0, c, 0, 1, store.rows)
      }
      store.dirtyCols.clear()
    }
  }

  // ------------------------------------------------------------ draw
  const draw = () => {
    const t0p = performance.now()
    const canvas = cv.current
    if (!canvas) return
    const { w, h, dpr } = size.current
    if (!w || !h) return
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = T.bg
    ctx.fillRect(0, 0, w, h)
    ensureOff()
    const o = off.current!
    if (!view.current) view.current = defaultView()
    const v = view.current
    if (follow.current) {
      const t1 = latestEnd()
      const sp = v.t1 - v.t0
      v.t1 = t1; v.t0 = t1 - sp
      let lastMid: number | null = null
      for (let i = store.mid.length - 1; i >= Math.max(0, store.mid.length - 5); i--) if (store.mid[i] != null) { lastMid = store.mid[i]; break }
      if (lastMid != null) {
        const ph = v.p1 - v.p0
        if (lastMid > v.p1 - ph * 0.15 || lastMid < v.p0 + ph * 0.15) { v.p0 = lastMid - ph / 2; v.p1 = lastMid + ph / 2 }
      }
    }
    const pw = w - AXIS_R
    const ph = h - AXIS_B
    const X = (tt: number) => ((tt - v.t0) / (v.t1 - v.t0)) * pw
    const Y = (p: number) => ((v.p1 - p) / (v.p1 - v.p0)) * ph
    // heatmap
    ctx.save()
    ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip()
    ctx.imageSmoothingEnabled = false
    const sx = (v.t0 - store.from) / store.dt
    const sw = (v.t1 - v.t0) / store.dt
    const top = store.priceLo + store.rows * store.bucket
    const sy = (top - v.p1) / store.bucket
    const sh = (v.p1 - v.p0) / store.bucket
    // clip della sorgente ai bordi dell'immagine (drawImage con rettangoli fuori immagine non è uniforme tra browser)
    const cx0 = Math.max(0, sx), cx1 = Math.min(store.cols.length, sx + sw)
    const cy0 = Math.max(0, sy), cy1 = Math.min(store.rows, sy + sh)
    if (cx1 > cx0 && cy1 > cy0) {
      const dx0 = ((cx0 - sx) / sw) * pw, dx1 = ((cx1 - sx) / sw) * pw
      const dy0 = ((cy0 - sy) / sh) * ph, dy1 = ((cy1 - sy) / sh) * ph
      ctx.drawImage(o.canvas, cx0, cy0, cx1 - cx0, cy1 - cy0, dx0, dy0, dx1 - dx0, dy1 - dy0)
    }
    // buchi
    ctx.fillStyle = alpha(T.fg3, 0.06)
    for (const [a, b] of store.gaps) {
      const x0 = X(a), x1 = X(b)
      if (x1 < 0 || x0 > pw || x1 - x0 < 1) continue
      ctx.fillRect(x0, 0, x1 - x0, ph)
      if (x1 - x0 > 70) {
        ctx.fillStyle = alpha(T.fg2, 0.55); ctx.font = `500 11px ${FONT}`; ctx.textAlign = 'center'
        ctx.fillText(t('Nessun dato'), (x0 + x1) / 2, 18)
        ctx.fillStyle = alpha(T.fg3, 0.06)
      }
    }
    // inizio raccolta
    if (store.collectionStart && store.collectionStart > v.t0 && store.collectionStart < v.t1) {
      const x = X(store.collectionStart)
      ctx.strokeStyle = alpha(T.warn, 0.7); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = T.warn; ctx.font = `500 11px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(t('Inizio raccolta'), x + 4, ph - 6)
    }
    const i0 = Math.max(0, Math.floor(sx) - 1)
    const i1 = Math.min(store.cols.length, Math.ceil(sx + sw) + 1)
    const colW = pw / sw
    // bolle dei trade aggressivi (volume della colonna al VWAP; area ∝ volume)
    if (optsRef.current.bubbles) {
      let vmax = 0
      const vols: number[] = []
      for (let i = i0; i < i1; i++) { const vv = store.vb[i] + store.vs[i]; vols.push(vv); if (vv > vmax) vmax = vv }
      const sorted = vols.filter((x) => x > 0).sort((a, b) => a - b)
      const thr = sorted.length ? sorted[Math.floor(sorted.length * 0.7)] : Infinity
      const rmax = Math.max(6, Math.min(26, colW * 5))
      for (let i = i0; i < i1; i++) {
        const vv = store.vb[i] + store.vs[i]
        const pr = store.vwap[i] ?? store.last[i]
        if (!(vv > 0) || vv < thr || pr == null) continue
        const r = Math.max(2.5, Math.sqrt(vv / vmax) * rmax)
        const x = X(store.from + (i + 0.5) * store.dt), y = Y(pr)
        const buyShare = store.vb[i] / vv
        const col = buyShare >= 0.5 ? T.up : T.down
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = hexA(col, 0.22 + Math.abs(buyShare - 0.5) * 0.5); ctx.fill()
        ctx.lineWidth = 1; ctx.strokeStyle = hexA(col, 0.9); ctx.stroke()
      }
    }
    // linea del prezzo (ultimo trade della colonna; mid se assente)
    if (optsRef.current.priceLine) {
      ctx.lineWidth = 3; ctx.strokeStyle = alpha(T.bg, 0.9)
      const path = () => {
        ctx.beginPath()
        let started = false
        for (let i = i0; i < i1; i++) {
          const p = store.last[i] ?? store.mid[i]
          if (p == null) { started = false; continue }
          const x = X(store.from + (i + 0.5) * store.dt), y = Y(p)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        }
      }
      path(); ctx.stroke()
      ctx.lineWidth = 1.5; ctx.strokeStyle = T.fg; path(); ctx.stroke()
    }
    // eventi: liquidità ritirata prima del tocco (anello ambra) e muro consumato (punto chiaro)
    if (optsRef.current.events) {
      for (const e of store.events) {
        if (e.t < v.t0 || e.t > v.t1 || e.kind === 'appeared') continue
        const x = X(e.t), y = Y(e.price + store.bucket / 2)
        if (y < -10 || y > ph + 10) continue
        if (e.kind === 'pulled') {
          ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath()
          ctx.lineWidth = 1.5; ctx.strokeStyle = T.warn; ctx.stroke()
        } else {
          ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fillStyle = T.fg; ctx.fill()
        }
      }
    }
    // profilo del book attuale (ultima colonna) a destra
    if (optsRef.current.ladder && follow.current && !compactUi) {
      const lc = store.cols.length - 1
      const arr = store.cols[lc]
      const mid = store.mid[lc]
      if (arr && mid != null) {
        let mx = 0
        for (let r = 0; r < arr.length; r++) if (arr[r] > mx) mx = arr[r]
        const LW = 72
        for (let r = 0; r < arr.length; r++) {
          const val = arr[r]
          if (!(val > 0)) continue
          const p0 = store.priceLo + r * store.bucket
          const y0 = Y(p0 + store.bucket), y1 = Y(p0)
          if (y1 < 0 || y0 > ph) continue
          const bw = (val / mx) * LW
          ctx.fillStyle = p0 + store.bucket <= mid ? alpha(T.up, 0.55) : alpha(T.down, 0.55)
          ctx.fillRect(pw - bw, y0, bw, Math.max(1, y1 - y0 - 0.5))
        }
      }
    }
    ctx.restore()
    // assi
    ctx.fillStyle = T.bg
    ctx.fillRect(pw, 0, AXIS_R, h); ctx.fillRect(0, ph, w, AXIS_B)
    ctx.strokeStyle = alpha(T.fg3, 0.12); ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(pw + 0.5, 0); ctx.lineTo(pw + 0.5, ph); ctx.lineTo(0, ph + 0.5); ctx.stroke()
    ctx.font = `400 11px ${FONT}`; ctx.fillStyle = T.fg3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    const pstep = niceStep(((v.p1 - v.p0) / ph) * 38)
    for (let p = Math.ceil(v.p0 / pstep) * pstep; p <= v.p1; p += pstep) {
      const y = Y(p)
      ctx.fillText(usd(p, pstep < 1 ? 2 : 0), pw + 6, y)
      ctx.fillStyle = alpha(T.fg3, 0.25); ctx.fillRect(pw, Math.round(y), 3, 1); ctx.fillStyle = T.fg3
    }
    const tstep = TSTEPS.find((s) => (s / (v.t1 - v.t0)) * pw >= 90) ?? 86400
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
    const tzOff = new Date().getTimezoneOffset() * 60
    for (let tt = Math.ceil((v.t0 - tzOff) / tstep) * tstep + tzOff; tt <= v.t1; tt += tstep) {
      const x = X(tt)
      if (x < 24 || x > pw - 24) continue
      ctx.fillText(tLabel(tt, tstep), x, h - 7)
    }
    // etichetta prezzo attuale
    let lastP: number | null = null
    for (let i = store.last.length - 1; i >= Math.max(0, store.last.length - 10); i--) if ((store.last[i] ?? store.mid[i]) != null) { lastP = store.last[i] ?? store.mid[i]; break }
    if (lastP != null) {
      const y = Math.min(ph - 8, Math.max(8, Y(lastP)))
      ctx.fillStyle = T.fg; ctx.fillRect(pw + 1, y - 9, AXIS_R - 2, 18)
      ctx.fillStyle = T.bg; ctx.font = `600 11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(usd(lastP, 1), pw + 5, y)
    }
    // crosshair
    const hv = hover.current
    if (hv && !drag.current && hv.x < pw && hv.y < ph) {
      ctx.strokeStyle = alpha(T.fg, 0.35); ctx.setLineDash([3, 3]); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(Math.round(hv.x) + 0.5, 0); ctx.lineTo(Math.round(hv.x) + 0.5, ph); ctx.moveTo(0, Math.round(hv.y) + 0.5); ctx.lineTo(pw, Math.round(hv.y) + 0.5); ctx.stroke()
      ctx.setLineDash([])
      const p = v.p1 - (hv.y / ph) * (v.p1 - v.p0)
      ctx.fillStyle = T.raised; ctx.fillRect(pw + 1, hv.y - 9, AXIS_R - 2, 18)
      ctx.fillStyle = T.fg; ctx.font = `500 11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(usd(p, 0), pw + 5, hv.y)
    }
    renderMs.current = renderMs.current ? renderMs.current * 0.8 + (performance.now() - t0p) * 0.2 : performance.now() - t0p
    canvas.dataset.renderMs = renderMs.current.toFixed(2)
  }

  const schedule = () => {
    dirty.current = true
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      if (dirty.current) { dirty.current = false; draw() }
    })
  }

  // tooltip dal punto del crosshair
  const updateTip = () => {
    const hv = hover.current
    const v = view.current
    const { w, h } = size.current
    if (!hv || !v || drag.current || hv.x > w - AXIS_R || hv.y > h - AXIS_B) { setTip(null); return }
    const pw = w - AXIS_R, ph = h - AXIS_B
    const tt = v.t0 + (hv.x / pw) * (v.t1 - v.t0)
    const p = v.p1 - (hv.y / ph) * (v.p1 - v.p0)
    const c = Math.floor((tt - store.from) / store.dt)
    const r = Math.floor((p - store.priceLo) / store.bucket)
    if (c < 0 || c >= store.cols.length || r < 0 || r >= store.rows) { setTip(null); return }
    const val = store.cols[c][r]
    const pb = store.priceLo + r * store.bucket
    const mid = store.mid[c]
    const rows: { k: string; v: string; c?: string }[] = []
    rows.push({ k: t('Prezzo'), v: `${usd(pb, 0)} – ${usd(pb + store.bucket, 0)}` })
    if (Number.isNaN(val)) rows.push({ k: t('Liquidità'), v: t('Nessun dato') })
    else {
      const side = mid == null ? '' : pb + store.bucket <= mid ? t('Bid') : pb >= mid ? t('Ask') : t('Bid/ask')
      rows.push({ k: t('Liquidità'), v: `${val.toFixed(val < 10 ? 2 : 1)} BTC · ${'$' + compact(val * (mid ?? pb))}`, c: side === t('Bid') ? T.up : side === t('Ask') ? T.down : undefined })
      if (side) rows.push({ k: t('Lato'), v: side })
    }
    if (store.last[c] != null) rows.push({ k: t('Ultimo prezzo'), v: usd(store.last[c], 1) })
    const vv = store.vb[c] + store.vs[c]
    if (vv > 0) rows.push({ k: t('Trade aggressivi'), v: `${t('acq.')} ${store.vb[c].toFixed(2)} · ${t('vend.')} ${store.vs[c].toFixed(2)} BTC` })
    const tl = store.tlo[c], th = store.thi[c]
    if (tl != null && th != null && (pb < tl || pb > th)) rows.push({ k: t('Nota'), v: t('Fuori dallo snapshot: solo diff stream'), c: T.warn })
    const ev = store.events.find((e) => e.kind !== 'appeared' && Math.abs(e.t - (store.from + (c + 0.5) * store.dt)) <= Math.max(store.dt, 2) && e.price === pb)
    if (ev) rows.push({ k: ev.kind === 'pulled' ? t('Liquidità ritirata prima del tocco') : t('Muro consumato'), v: `${ev.qmax.toFixed(1)} → ${ev.q.toFixed(1)} BTC`, c: T.warn })
    setTip({ x: hv.x, y: hv.y, title: fullTime(store.from + c * store.dt), html: rows })
  }

  // resize
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      size.current = { w: Math.floor(r.width), h: Math.floor(r.height), dpr }
      const c = cv.current!
      c.width = Math.floor(r.width * dpr); c.height = Math.floor(r.height * dpr)
      c.style.width = `${Math.floor(r.width)}px`; c.style.height = `${Math.floor(r.height)}px`
      schedule()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // nuovo dataset -> vista di default; nuove versioni live -> ridisegno
  useEffect(() => { view.current = null; follow.current = true; off.current = null; schedule() }, [store]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { schedule() }, [opts.contrast, opts.bubbles, opts.events, opts.priceLine, opts.ladder]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => { if (store.version !== seenVersion.current) { seenVersion.current = store.version; schedule() } }, 250)
    return () => clearInterval(id)
  }, [store]) // eslint-disable-line react-hooks/exhaustive-deps

  // interazioni: drag = pan, rotella = zoom tempo (sull'asse prezzi o con Shift = zoom prezzo), doppio clic = reset
  useEffect(() => {
    const c = cv.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = view.current
      if (!v) return
      const rect = c.getBoundingClientRect()
      const x = e.clientX - rect.left, y = e.clientY - rect.top
      const { w, h } = size.current
      const pw = w - AXIS_R, ph = h - AXIS_B
      const f = Math.exp(Math.sign(e.deltaY) * 0.12)
      if (e.shiftKey || x > pw) {
        const p = v.p1 - (y / ph) * (v.p1 - v.p0)
        const span2 = Math.max(store.bucket * 8, (v.p1 - v.p0) * f)
        v.p1 = p + (v.p1 - p) * (span2 / (v.p1 - v.p0)); v.p0 = v.p1 - span2
      } else {
        const tt = v.t0 + (x / pw) * (v.t1 - v.t0)
        const span2 = Math.min(Math.max(store.dt * 20, (v.t1 - v.t0) * f), store.cols.length * store.dt * 1.05 + 60)
        if (follow.current) { v.t0 = v.t1 - span2 } else { v.t0 = tt - (tt - v.t0) * (span2 / (v.t1 - v.t0)); v.t1 = v.t0 + span2 }
      }
      schedule()
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [store]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view.current) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, v: { ...view.current }, moved: false }
    setTip(null)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = cv.current!.getBoundingClientRect()
    hover.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const d = drag.current
    if (d && view.current) {
      const { w, h } = size.current
      const pw = w - AXIS_R, ph = h - AXIS_B
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      const dt = (-dx / pw) * (d.v.t1 - d.v.t0)
      const dp = (dy / ph) * (d.v.p1 - d.v.p0)
      const end = latestEnd()
      const span2 = d.v.t1 - d.v.t0
      const t1 = Math.min(end + span2 * 0.1, d.v.t1 + dt)
      view.current = { t0: t1 - span2, t1, p0: d.v.p0 + dp, p1: d.v.p1 + dp }
      follow.current = t1 >= end - store.dt * 1.5
    } else updateTip()
    schedule()
  }
  const onPointerUp = () => { drag.current = null; schedule() }
  const onLeave = () => { hover.current = null; setTip(null); schedule() }

  return (
    <div ref={wrap} className="relative h-full w-full select-none overflow-hidden rounded-xl" style={{ touchAction: 'none' }}>
      <canvas ref={cv} data-testid="ob-heatmap" className="block cursor-crosshair" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onLeave}
        onDoubleClick={() => { follow.current = true; view.current = defaultView(); schedule() }} />
      {tip && (
        <div className="pop pointer-events-none absolute z-10 w-60 rounded-xl p-2.5 text-xs"
          style={{ left: Math.min(tip.x + 14, (size.current.w || 300) - 250), top: Math.max(4, Math.min(tip.y + 14, (size.current.h || 300) - 150)) }}>
          <div className="label mb-1.5 text-fg-2">{tip.title}</div>
          {tip.html.map((r) => (
            <div key={r.k} className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-fg-3">{r.k}</span>
              <span className="tnum text-right font-medium text-white" style={r.c ? { color: r.c } : undefined}>{r.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default HeatmapCanvas
