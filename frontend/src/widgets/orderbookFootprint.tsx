/*
 * Footprint chart in canvas: per candela i volumi aggressivi in vendita × acquisto per livello di prezzo, sfondo = delta del
 * livello, POC contornato, imbalance diagonali ≥ ratio:1 evidenziati, zone impilate (≥3 livelli) sul bordo, delta/volume per
 * candela e CVD sotto. Con colonne strette (mobile o zoom indietro) passa alla vista compatta: solo celle colorate e POC.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ObFootprint, ObLiveFp } from '../api/orderbook'
import { FONT } from '../components/charts/theme'
import { t } from '../i18n'
import { usd } from '../lib/format'

type N = number | null
export interface FpCandle {
  t: number; o: number; h: number; l: number; c: number; buy: number; sell: number; delta: number; poc: N; n: number; ok: boolean
  p: number[]; b: number[]; s: number[]; imb: number[]; stacked: { side: 'buy' | 'sell'; from: number; to: number; n: number }[]
}
export interface FpStore { tf: string; bin: number; ratio: number; candles: FpCandle[]; version: number; collectionStart: N }

export function buildFp(d: ObFootprint): FpStore {
  const C = d.candles
  const candles: FpCandle[] = C.t.map((tt, i) => {
    const a = C.off[i], n = C.cnt[i]
    return {
      t: tt, o: C.o[i], h: C.h[i], l: C.l[i], c: C.c[i], buy: C.buy[i], sell: C.sell[i], delta: C.delta[i], poc: C.poc[i], n: C.n[i], ok: C.ok[i],
      p: d.levels.p.slice(a, a + n), b: d.levels.buy.slice(a, a + n), s: d.levels.sell.slice(a, a + n), imb: d.levels.imb.slice(a, a + n),
      stacked: d.stacked.filter((x) => x.i === i),
    }
  })
  return { tf: d.tf, bin: d.bin, ratio: d.ratio, candles, version: 0, collectionStart: d.collection_start }
}

export function applyLiveFp(s: FpStore, f: ObLiveFp) {
  if (f.tf !== s.tf || f.bin !== s.bin) return
  const c: FpCandle = { t: f.t, o: f.o, h: f.h, l: f.l, c: f.c, buy: f.buy, sell: f.sell, delta: f.delta, poc: f.poc, n: f.n, ok: f.ok,
    p: f.p, b: f.lbuy, s: f.lsell, imb: f.imb, stacked: f.stacked }
  const last = s.candles[s.candles.length - 1]
  if (last && last.t === f.t) s.candles[s.candles.length - 1] = c
  else if (!last || f.t > last.t) { s.candles.push(c); if (s.candles.length > 400) s.candles.shift() }
  else return
  s.version++
}

const qf = (v: number, tight: boolean) => (v === 0 ? '0' : v < 10 ? v.toFixed(tight ? 1 : 2) : v < 100 ? v.toFixed(1) : v.toFixed(0))
const pad2 = (n: number) => String(n).padStart(2, '0')
const hm = (ts: number) => { const d = new Date(ts * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

export interface FpHandle { reset: () => void; renderMs: () => number }
interface View { i0: number; cw: number; p0: number; p1: number }

const AXIS_R = 64
const AXIS_B = 20
const SUMMARY = 38
const CVD_H = 74

const FootprintCanvas = forwardRef<FpHandle, { store: FpStore; compactUi?: boolean }>(function FootprintCanvas({ store, compactUi }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const size = useRef({ w: 0, h: 0, dpr: 1 })
  const view = useRef<View | null>(null)
  const follow = useRef(true)
  const raf = useRef(0)
  const hover = useRef<{ x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; v: View } | null>(null)
  const renderMs = useRef(0)
  const seen = useRef(-1)
  const [tip, setTip] = useState<{ x: number; y: number; title: string; rows: { k: string; v: string; c?: string }[] } | null>(null)

  const plotH = () => size.current.h - AXIS_B - SUMMARY - CVD_H
  const fitPrice = (v: View) => {
    const pw = size.current.w - AXIS_R
    const a = Math.max(0, Math.floor(v.i0)), b = Math.min(store.candles.length, Math.ceil(v.i0 + pw / v.cw))
    let lo = Infinity, hi = -Infinity
    for (let i = a; i < b; i++) { lo = Math.min(lo, store.candles[i].l); hi = Math.max(hi, store.candles[i].h) }
    if (!Number.isFinite(lo)) return
    const pad = Math.max(store.bin * 2, (hi - lo) * 0.06)
    v.p0 = lo - pad; v.p1 = hi + pad
  }
  const defaultView = useCallback((): View => {
    const pw = Math.max(100, size.current.w - AXIS_R)
    const cw = compactUi ? 26 : pw > 1400 ? 132 : 116
    const n = store.candles.length
    const v: View = { i0: n - pw / cw + 0.4, cw, p0: 0, p1: 1 }
    fitPrice(v)
    return v
  }, [store, compactUi]) // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({ reset: () => { follow.current = true; view.current = defaultView(); schedule() }, renderMs: () => renderMs.current }), [defaultView]) // eslint-disable-line react-hooks/exhaustive-deps

  const draw = () => {
    const t0p = performance.now()
    const canvas = cv.current
    const { w, h, dpr } = size.current
    if (!canvas || !w || !h) return
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#060912'; ctx.fillRect(0, 0, w, h)
    if (!view.current) view.current = defaultView()
    const v = view.current
    const n = store.candles.length
    const pw = w - AXIS_R
    const ph = plotH()
    if (follow.current) {
      const want = n - pw / v.cw + 0.4
      if (Math.abs(v.i0 - want) > 1e-6) { v.i0 = want }
      fitPrice(v)
    }
    const Y = (p: number) => ((v.p1 - p) / (v.p1 - v.p0)) * ph
    const a = Math.max(0, Math.floor(v.i0)), b = Math.min(n, Math.ceil(v.i0 + pw / v.cw))
    const rowH = (store.bin / (v.p1 - v.p0)) * ph
    const full = v.cw >= 76 && rowH >= 11
    // scala colore: delta massimo per livello tra le candele visibili
    let maxD = 1e-9, maxV = 1e-9
    for (let i = a; i < b; i++) {
      const c = store.candles[i]
      for (let k = 0; k < c.p.length; k++) { maxD = Math.max(maxD, Math.abs(c.b[k] - c.s[k])); maxV = Math.max(maxV, c.b[k] + c.s[k]) }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip()
    // griglia prezzi
    const pstep = Math.max(store.bin, niceStep(((v.p1 - v.p0) / ph) * 40))
    ctx.strokeStyle = 'rgba(148,163,210,0.05)'; ctx.lineWidth = 1
    for (let p = Math.ceil(v.p0 / pstep) * pstep; p <= v.p1; p += pstep) { const y = Math.round(Y(p)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke() }
    ctx.textBaseline = 'middle'
    for (let i = a; i < b; i++) {
      const c = store.candles[i]
      const x = (i - v.i0) * v.cw
      const strip = compactUi ? 3 : 6
      const cx = x + strip + 3
      const cwid = v.cw - strip - 6
      const up = c.c >= c.o
      // candela (wick + corpo) sul bordo sinistro
      ctx.strokeStyle = up ? '#2EBD85' : '#EF5466'; ctx.fillStyle = up ? '#2EBD85' : '#EF5466'
      ctx.beginPath(); ctx.moveTo(x + strip / 2 + 0.5, Y(c.h)); ctx.lineTo(x + strip / 2 + 0.5, Y(c.l)); ctx.stroke()
      const yo = Y(c.o), yc = Y(c.c)
      ctx.fillRect(x, Math.min(yo, yc), strip, Math.max(1, Math.abs(yc - yo)))
      for (let k = 0; k < c.p.length; k++) {
        const p = c.p[k]
        const y0 = Y(p + store.bin), y1 = Y(p)
        if (y1 < 0 || y0 > ph) continue
        const hh = Math.max(1, y1 - y0 - (rowH > 4 ? 1 : 0))
        const d = c.b[k] - c.s[k]
        const al = 0.08 + Math.min(1, Math.abs(d) / maxD) * 0.55
        ctx.fillStyle = d >= 0 ? `rgba(46,189,133,${al})` : `rgba(239,84,102,${al})`
        ctx.fillRect(cx, y0, cwid, hh)
        // profilo del volume (barra sottile)
        if (full) {
          ctx.fillStyle = 'rgba(232,236,244,0.10)'
          ctx.fillRect(cx, y1 - 2.5, ((c.b[k] + c.s[k]) / maxV) * cwid, 2)
        }
        if (c.poc === p) { ctx.strokeStyle = '#E8B04B'; ctx.lineWidth = 1.25; ctx.strokeRect(cx + 0.5, y0 + 0.5, cwid - 1, hh - 1) }
        if (full) {
          const tight = cwid < 100
          const fs = rowH >= 15 ? 11 : 10
          const ym = y0 + hh / 2
          const im = c.imb[k]
          ctx.font = `${im & 2 ? 600 : 400} ${fs}px ${FONT}`
          ctx.fillStyle = im & 2 ? '#FF7A88' : '#B3BCD0'; ctx.textAlign = 'right'
          ctx.fillText(qf(c.s[k], tight), cx + cwid / 2 - 6, ym)
          ctx.fillStyle = '#566079'; ctx.textAlign = 'center'; ctx.font = `400 ${fs}px ${FONT}`
          ctx.fillText('×', cx + cwid / 2, ym)
          ctx.font = `${im & 1 ? 600 : 400} ${fs}px ${FONT}`
          ctx.fillStyle = im & 1 ? '#4BE0A6' : '#B3BCD0'; ctx.textAlign = 'left'
          ctx.fillText(qf(c.b[k], tight), cx + cwid / 2 + 6, ym)
        } else if (c.imb[k]) {
          ctx.fillStyle = c.imb[k] & 1 ? '#4BE0A6' : '#FF7A88'
          ctx.fillRect(c.imb[k] & 1 ? cx + cwid - 2 : cx, y0, 2, hh)
        }
      }
      for (const z of c.stacked) {
        ctx.fillStyle = z.side === 'buy' ? '#4BE0A6' : '#FF7A88'
        const y0 = Y(z.to), y1 = Y(z.from)
        ctx.fillRect(z.side === 'buy' ? cx + cwid + 1 : cx - 3, y0, 2, y1 - y0)
      }
      if (!c.ok) { ctx.fillStyle = '#E8B04B'; ctx.beginPath(); ctx.arc(x + v.cw / 2, 7, 2.5, 0, Math.PI * 2); ctx.fill() }
    }
    ctx.restore()
    // riepilogo per candela + CVD
    const sy = ph + AXIS_B
    ctx.fillStyle = '#0B1020'; ctx.fillRect(0, ph, pw, AXIS_B + SUMMARY + CVD_H)
    ctx.strokeStyle = 'rgba(148,163,210,0.12)'
    ctx.beginPath(); ctx.moveTo(0, ph + 0.5); ctx.lineTo(w, ph + 0.5); ctx.moveTo(0, sy + SUMMARY + 0.5); ctx.lineTo(w, sy + SUMMARY + 0.5); ctx.stroke()
    ctx.font = `400 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const every = Math.max(1, Math.ceil(70 / v.cw))
    let maxAbsCvd = 1e-9
    const cvd: number[] = []
    let acc = 0
    for (let i = 0; i < n; i++) { acc += store.candles[i].delta; cvd.push(acc) }
    for (let i = a; i < b; i++) maxAbsCvd = Math.max(maxAbsCvd, Math.abs(cvd[i]))
    let cmin = Infinity, cmax = -Infinity
    for (let i = a; i < b; i++) { cmin = Math.min(cmin, cvd[i]); cmax = Math.max(cmax, cvd[i]) }
    if (cmin === cmax) { cmin -= 1; cmax += 1 }
    const cy = (val: number) => sy + SUMMARY + 8 + ((cmax - val) / (cmax - cmin)) * (CVD_H - 16)
    for (let i = a; i < b; i++) {
      const c = store.candles[i]
      const xm = (i - v.i0 + 0.5) * v.cw
      if ((i % every) === 0 && xm > 20 && xm < pw - 20) { ctx.fillStyle = '#8892A8'; ctx.fillText(hm(c.t), xm, ph + AXIS_B / 2 + 1) }
      if (v.cw >= 46) {
        ctx.fillStyle = c.delta >= 0 ? '#2EBD85' : '#EF5466'
        ctx.font = `600 11px ${FONT}`
        ctx.fillText(`${c.delta >= 0 ? '+' : '−'}${qf(Math.abs(c.delta), v.cw < 100)}`, xm, sy + 11)
        ctx.fillStyle = '#8892A8'; ctx.font = `400 10px ${FONT}`
        ctx.fillText(qf(c.buy + c.sell, v.cw < 100), xm, sy + 27)
      } else {
        const hh = Math.min(14, (Math.abs(c.delta) / Math.max(1e-9, ...store.candles.slice(a, b).map((x) => Math.abs(x.delta)))) * 14)
        ctx.fillStyle = c.delta >= 0 ? '#2EBD85' : '#EF5466'
        ctx.fillRect(xm - v.cw * 0.3, c.delta >= 0 ? sy + 18 - hh : sy + 18, v.cw * 0.6, hh)
      }
    }
    // CVD
    if (b > a) {
      if (cmin < 0 && cmax > 0) { ctx.strokeStyle = 'rgba(148,163,210,0.18)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, cy(0)); ctx.lineTo(pw, cy(0)); ctx.stroke(); ctx.setLineDash([]) }
      ctx.strokeStyle = '#5B8DEF'; ctx.lineWidth = 1.5; ctx.beginPath()
      for (let i = a; i < b; i++) { const xm = (i - v.i0 + 0.5) * v.cw; if (i === a) ctx.moveTo(xm, cy(cvd[i])); else ctx.lineTo(xm, cy(cvd[i])) }
      ctx.stroke()
    }
    ctx.textAlign = 'left'; ctx.font = `500 10px ${FONT}`; ctx.fillStyle = '#6B7590'
    ctx.fillText('DELTA · VOL', 6, sy + 11 + (v.cw >= 46 ? 0 : 0))
    ctx.fillText(`CVD ${t('dalla prima candela caricata')}`, 6, sy + SUMMARY + 9)
    // asse prezzi
    ctx.fillStyle = '#060912'; ctx.fillRect(pw, 0, AXIS_R, h)
    ctx.strokeStyle = 'rgba(148,163,210,0.12)'; ctx.beginPath(); ctx.moveTo(pw + 0.5, 0); ctx.lineTo(pw + 0.5, h); ctx.stroke()
    ctx.fillStyle = '#8892A8'; ctx.font = `400 11px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
    for (let p = Math.ceil(v.p0 / pstep) * pstep; p <= v.p1; p += pstep) { const y = Y(p); if (y > 6 && y < ph - 6) ctx.fillText(usd(p, 0), pw + 6, y) }
    ctx.fillText(`${cmax >= 0 ? '+' : '−'}${qf(Math.abs(cmax), true)}`, pw + 6, cy(cmax))
    ctx.fillText(`${cmin >= 0 ? '+' : '−'}${qf(Math.abs(cmin), true)}`, pw + 6, cy(cmin))
    const last = store.candles[n - 1]
    if (last) {
      const y = Math.min(ph - 8, Math.max(8, Y(last.c)))
      ctx.fillStyle = '#E8ECF4'; ctx.fillRect(pw + 1, y - 9, AXIS_R - 2, 18)
      ctx.fillStyle = '#060912'; ctx.font = `600 11px ${FONT}`; ctx.fillText(usd(last.c, 1), pw + 5, y)
    }
    const hv = hover.current
    if (hv && !drag.current && hv.x < pw && hv.y < ph) {
      ctx.strokeStyle = 'rgba(232,236,244,0.3)'; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(0, Math.round(hv.y) + 0.5); ctx.lineTo(pw, Math.round(hv.y) + 0.5); ctx.stroke(); ctx.setLineDash([])
    }
    renderMs.current = renderMs.current ? renderMs.current * 0.8 + (performance.now() - t0p) * 0.2 : performance.now() - t0p
    canvas.dataset.renderMs = renderMs.current.toFixed(2)
  }
  const schedule = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => { raf.current = 0; draw() })
  }

  const updateTip = () => {
    const hv = hover.current, v = view.current
    if (!hv || !v || drag.current) { setTip(null); return }
    const pw = size.current.w - AXIS_R, ph = plotH()
    if (hv.x > pw || hv.y > ph) { setTip(null); return }
    const i = Math.floor(v.i0 + hv.x / v.cw)
    const c = store.candles[i]
    if (!c) { setTip(null); return }
    const p = v.p1 - (hv.y / ph) * (v.p1 - v.p0)
    const pb = Math.floor(p / store.bin + 1e-9) * store.bin
    const k = c.p.indexOf(pb)
    const rows: { k: string; v: string; c?: string }[] = []
    if (k >= 0) {
      rows.push({ k: t('Livello'), v: `${usd(pb, 0)} – ${usd(pb + store.bin, 0)}` })
      rows.push({ k: t('Acquisti aggressivi'), v: `${c.b[k].toFixed(3)} BTC`, c: c.imb[k] & 1 ? '#4BE0A6' : undefined })
      rows.push({ k: t('Vendite aggressive'), v: `${c.s[k].toFixed(3)} BTC`, c: c.imb[k] & 2 ? '#FF7A88' : undefined })
      rows.push({ k: t('Delta livello'), v: `${c.b[k] - c.s[k] >= 0 ? '+' : '−'}${Math.abs(c.b[k] - c.s[k]).toFixed(3)}` })
      if (c.imb[k]) rows.push({ k: t('Imbalance'), v: [c.imb[k] & 1 ? t('acquisto') : '', c.imb[k] & 2 ? t('vendita') : ''].filter(Boolean).join(' · ') + ` ≥ ${store.ratio}:1`, c: '#E8B04B' })
      if (c.poc === pb) rows.push({ k: 'POC', v: t('Livello con più volume della candela'), c: '#E8B04B' })
    }
    rows.push({ k: t('Candela'), v: `O ${usd(c.o, 1)} · C ${usd(c.c, 1)}` })
    rows.push({ k: t('Delta candela'), v: `${c.delta >= 0 ? '+' : '−'}${Math.abs(c.delta).toFixed(2)} BTC`, c: c.delta >= 0 ? '#2EBD85' : '#EF5466' })
    rows.push({ k: t('Volume'), v: `${(c.buy + c.sell).toFixed(2)} BTC · ${c.n.toLocaleString('en-US')} ${t('trade')}` })
    if (!c.ok) rows.push({ k: t('Nota'), v: t('Candela parziale (raccolta incompleta)'), c: '#E8B04B' })
    const d = new Date(c.t * 1000)
    setTip({ x: hv.x, y: hv.y, title: `${d.getDate()}/${pad2(d.getMonth() + 1)} ${hm(c.t)} · ${store.tf}`, rows })
  }

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
      if (follow.current) view.current = null
      schedule()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { view.current = null; follow.current = true; schedule() }, [store, compactUi]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => { if (store.version !== seen.current) { seen.current = store.version; schedule() } }, 250)
    return () => clearInterval(id)
  }, [store]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = cv.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = view.current
      if (!v) return
      const rect = c.getBoundingClientRect()
      const x = e.clientX - rect.left, y = e.clientY - rect.top
      const pw = size.current.w - AXIS_R, ph = plotH()
      if (x > pw) {
        const p = v.p1 - (y / ph) * (v.p1 - v.p0)
        const f = Math.exp(Math.sign(e.deltaY) * 0.12)
        const sp = Math.max(store.bin * 6, (v.p1 - v.p0) * f)
        v.p1 = p + (v.p1 - p) * (sp / (v.p1 - v.p0)); v.p0 = v.p1 - sp
        follow.current = false
      } else if (e.ctrlKey || e.shiftKey) {
        const ci = v.i0 + x / v.cw
        v.cw = Math.min(260, Math.max(14, v.cw * Math.exp(-Math.sign(e.deltaY) * 0.12)))
        v.i0 = ci - x / v.cw
        if (follow.current) fitPrice(v)
      } else {
        v.i0 += Math.sign(e.deltaY) * Math.max(1, 3 * (40 / v.cw))
        const maxI0 = store.candles.length - pw / v.cw + 0.4
        if (v.i0 >= maxI0) { v.i0 = maxI0; follow.current = true } else follow.current = false
        fitPrice(v)
      }
      schedule()
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [store]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrap} className="relative h-full w-full select-none overflow-hidden rounded-xl" style={{ touchAction: 'none' }}>
      <canvas ref={cv} data-testid="ob-footprint" className="block cursor-crosshair"
        onPointerDown={(e) => { if (!view.current) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, v: { ...view.current } }; setTip(null) }}
        onPointerMove={(e) => {
          const rect = cv.current!.getBoundingClientRect()
          hover.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
          const d = drag.current
          if (d && view.current) {
            const pw = size.current.w - AXIS_R, ph = plotH()
            const di = -(e.clientX - d.x) / d.v.cw
            const dp = ((e.clientY - d.y) / ph) * (d.v.p1 - d.v.p0)
            const maxI0 = store.candles.length - pw / d.v.cw + 0.4
            const i0 = Math.min(maxI0, d.v.i0 + di)
            view.current = { ...d.v, i0, p0: d.v.p0 + dp, p1: d.v.p1 + dp }
            follow.current = i0 >= maxI0 - 0.01 && Math.abs(e.clientY - d.y) < 4
          } else updateTip()
          schedule()
        }}
        onPointerUp={() => { drag.current = null; schedule() }} onPointerCancel={() => { drag.current = null }}
        onPointerLeave={() => { hover.current = null; setTip(null); schedule() }}
        onDoubleClick={() => { follow.current = true; view.current = defaultView(); schedule() }} />
      {tip && (
        <div className="pop pointer-events-none absolute z-10 w-64 rounded-xl p-2.5 text-xs"
          style={{ left: Math.min(tip.x + 14, (size.current.w || 300) - 270), top: Math.max(4, Math.min(tip.y + 14, (size.current.h || 300) - 200)) }}>
          <div className="label mb-1.5 text-slate-300">{tip.title}</div>
          {tip.rows.map((r) => (
            <div key={r.k} className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="shrink-0 text-slate-400">{r.k}</span>
              <span className="tnum text-right font-medium text-white" style={r.c ? { color: r.c } : undefined}>{r.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

const NICE = [1, 2, 2.5, 5]
function niceStep(raw: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))))
  for (const m of NICE) if (m * e >= raw) return m * e
  return 10 * e
}

export default FootprintCanvas
