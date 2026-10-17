/*
 * Stato live del Terminale: un WebSocket (/api/ws/terminal, ≤ 4 msg/s) per pagina, riconnessione con backoff e fallback a polling
 * ogni 5 s (GET /api/terminal/snapshot) quando il socket non è aperto. Lo stato è mutabile (niente re-render a ogni messaggio):
 * i componenti si abbonano a una "fetta" e vengono notificati al massimo una volta per frame (requestAnimationFrame).
 * Il grafico riceve prezzo, barra corrente, colonne heatmap e liquidazioni con callback dirette (aggiornamento imperativo).
 */
import { useSyncExternalStore } from 'react'
import {
  fetchSnapshot, type FeedItem, type LiqItem, type ObLiveCol, type StreamsBrief, type TermBar, type TermDom, type TermFlow, type TermSnapshot,
  type TermTf, type TermTicker,
} from '../api/terminal'

export type Conn = 'connecting' | 'live' | 'polling' | 'offline'
export type Slice = 'px' | 'ticker' | 'flow' | 'dom' | 'feed' | 'liqs' | 'conn' | 'perf'
export interface Ctl { tf: TermTf; dm: 'futures' | 'spot'; ds: number; dn: number; hm: boolean; hb: number; hr: number }
interface TermMsg {
  type: 'term'; time: number; px?: number | null; ticker?: TermTicker; flow?: TermFlow; bar?: TermBar; dom?: TermDom; trades?: FeedItem[]
  liqs?: LiqItem[]; hm?: ObLiveCol[]; streams?: StreamsBrief
}
export interface Perf { fps: number | null; msgsPerS: number; latMs: number | null; latP95: number | null; longTasks: number; drawMs: number | null }

const FEED_MAX = 400
const LIQ_MAX = 300

export class TermLive {
  ticker: TermTicker | null = null
  px: number | null = null
  flow: TermFlow | null = null
  dom: TermDom | null = null
  feed: FeedItem[] = []        // più recenti prima
  liqs: LiqItem[] = []
  bar: TermBar | null = null
  streams: StreamsBrief | null = null
  conn: Conn = 'connecting'
  lastMsgAt = 0
  perf: Perf = { fps: null, msgsPerS: 0, latMs: null, latP95: null, longTasks: 0, drawMs: null }
  pxListeners = new Set<(px: number, t: number) => void>()
  barListeners = new Set<(b: TermBar) => void>()
  hmListeners = new Set<(c: ObLiveCol[]) => void>()
  liqListeners = new Set<(l: LiqItem[]) => void>()
  private ver: Record<Slice, number> = { px: 0, ticker: 0, flow: 0, dom: 0, feed: 0, liqs: 0, conn: 0, perf: 0 }
  private subs = new Map<Slice, Set<() => void>>()
  private dirty = new Set<Slice>()
  private raf = 0
  private ws: WebSocket | null = null
  private attempt = 0
  private closed = false
  private timers: number[] = []
  private pollTimer = 0
  private lastFeedK = 0
  private lastLiqK = 0
  private msgTimes: number[] = []
  private lats: number[] = []
  ctl: Ctl

  constructor(ctl: Ctl) {
    this.ctl = { ...ctl }
  }

  // ------------------------------------------------------------ subscriptions
  subscribe = (slice: Slice, fn: () => void) => {
    let s = this.subs.get(slice)
    if (!s) this.subs.set(slice, (s = new Set()))
    s.add(fn)
    return () => { s!.delete(fn) }
  }
  version = (slice: Slice) => this.ver[slice]
  private touch(slice: Slice) {
    this.ver[slice]++
    this.dirty.add(slice)
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      const d = [...this.dirty]
      this.dirty.clear()
      for (const sl of d) this.subs.get(sl)?.forEach((fn) => fn())
    })
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    this.closed = false
    this.connect()
    // fallback: se il socket non è aperto da 3 s si interroga lo snapshot ogni 5 s
    this.pollTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) return
      if (Date.now() - this.lastMsgAt < 3000) return
      this.poll()
    }, 5000)
    const fpsLoop = { frames: 0, t0: performance.now(), id: 0 }
    const loop = () => {
      fpsLoop.frames++
      const now = performance.now()
      if (now - fpsLoop.t0 >= 1000) {
        this.perf.fps = Math.round((fpsLoop.frames * 1000) / (now - fpsLoop.t0))
        fpsLoop.frames = 0
        fpsLoop.t0 = now
        const cut = Date.now() - 5000
        this.msgTimes = this.msgTimes.filter((x) => x >= cut)
        this.perf.msgsPerS = +(this.msgTimes.length / 5).toFixed(1)
        if (this.lats.length) {
          const s = [...this.lats].sort((a, b) => a - b)
          this.perf.latMs = s[Math.floor(s.length / 2)]
          this.perf.latP95 = s[Math.floor(s.length * 0.95)]
        }
        ;(window as unknown as { __termPerf?: Perf }).__termPerf = { ...this.perf }
        this.touch('perf')
      }
      fpsLoop.id = requestAnimationFrame(loop)
    }
    fpsLoop.id = requestAnimationFrame(loop)
    try {
      const po = new PerformanceObserver((list) => { this.perf.longTasks += list.getEntries().length })
      po.observe({ entryTypes: ['longtask'] })
      this.stopPo = () => po.disconnect()
    } catch { /* longtask non supportato */ }
    this.stopFps = () => cancelAnimationFrame(fpsLoop.id)
  }
  private stopPo = () => {}
  private stopFps = () => {}

  stop() {
    this.closed = true
    clearInterval(this.pollTimer)
    this.timers.forEach((id) => clearTimeout(id))
    this.stopFps()
    this.stopPo()
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close()
    else ws?.close()
    this.ws = null
  }

  /** Solo test: chiude il socket e impedisce la riconnessione per `ms` (verifica del fallback a polling). */
  pauseWs(ms: number) {
    this.blockedUntil = Date.now() + ms
    this.ws?.close()
  }
  private blockedUntil = 0

  setCtl(p: Partial<Ctl>) {
    Object.assign(this.ctl, p)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(p))
  }

  /** Stato iniziale (o ripristino dopo un buco): snapshot completo. */
  applySnapshot(s: TermSnapshot) {
    this.ticker = s.ticker; this.touch('ticker')
    this.flow = s.flow; this.touch('flow')
    if (s.dom) { this.dom = s.dom; this.touch('dom') }
    // feed: solo gli elementi non ancora visti (snapshot iniziale, polling di ripiego o socket già attivo)
    const seen = new Set(this.feed.map((x) => x.k))
    const addF = s.feed.filter((x) => !seen.has(x.k) && (this.feed.length === 0 || x.k > this.lastFeedK))
    this.feed = [...addF.reverse(), ...this.feed].sort((a, b) => b.k - a.k).slice(0, FEED_MAX)
    this.lastFeedK = Math.max(this.lastFeedK, s.feed_seq)
    this.touch('feed')
    const known = new Set(this.liqs.map((l) => `${l.t}|${l.price}|${l.usd}`))
    const add = s.liqs.filter((l) => !known.has(`${l.t}|${l.price}|${l.usd}`))
    this.liqs = [...add.reverse(), ...this.liqs].sort((a, b) => b.t - a.t).slice(0, LIQ_MAX)
    this.lastLiqK = Math.max(this.lastLiqK, s.liq_seq)
    this.touch('liqs')
    if (add.length) this.liqListeners.forEach((fn) => fn(add))
    this.bar = s.bar
    this.barListeners.forEach((fn) => fn(s.bar))
    this.streams = s.streams
    if (s.ticker.last != null) this.pxListeners.forEach((fn) => fn(s.ticker.last!, s.time))
  }

  private async poll() {
    try {
      const s = await fetchSnapshot(this.ctl.tf, this.ctl.dm, this.ctl.ds)
      if (this.closed) return
      this.applySnapshot(s)
      if (s.ticker.last != null && s.ticker.last !== this.px) { this.px = s.ticker.last; this.touch('px') }
      this.lastMsgAt = Date.now()
      if (this.ws?.readyState !== WebSocket.OPEN) this.setConn('polling')
    } catch {
      if (this.ws?.readyState !== WebSocket.OPEN) this.setConn('offline')
    }
  }

  private setConn(c: Conn) {
    if (this.conn !== c) { this.conn = c; this.touch('conn') }
  }

  private connect() {
    if (this.closed) return
    if (Date.now() < this.blockedUntil) { this.retry(); return }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const c = this.ctl
    const q = new URLSearchParams({ tf: c.tf, dm: c.dm, ds: String(c.ds), dn: String(c.dn), hm: c.hm ? '1' : '0', hb: String(c.hb), hr: String(c.hr) })
    let ws: WebSocket
    try { ws = new WebSocket(`${proto}//${location.host}/api/ws/terminal?${q}`) } catch { this.retry(); return }
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.setConn('live')
      ws.send(JSON.stringify(this.ctl))   // parametri eventualmente cambiati durante la connessione
    }
    ws.onmessage = (ev) => {
      try { this.handle(JSON.parse(ev.data) as TermMsg) } catch { /* ignore */ }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return          // socket vecchio (chiuso da stop() o sostituito): nessun nuovo tentativo
      this.ws = null
      if (this.closed) return
      this.setConn(Date.now() - this.lastMsgAt < 6000 ? 'polling' : 'connecting')
      this.retry()
    }
    ws.onerror = () => ws.close()
  }
  private retry() {
    this.attempt++
    const delay = Date.now() < this.blockedUntil ? Math.max(500, this.blockedUntil - Date.now()) : Math.min(15000, 800 * 2 ** Math.min(this.attempt - 1, 5))
    this.timers.push(window.setTimeout(() => this.connect(), delay))
  }

  private handle(m: TermMsg) {
    if (m.type !== 'term') return
    const now = Date.now()
    this.lastMsgAt = now
    this.msgTimes.push(now)
    if (this.conn !== 'live') this.setConn('live')
    if (m.px != null) {
      const sent = m.time * 1000
      // latenza server -> schermo: invio del messaggio -> frame successivo dipinto
      requestAnimationFrame(() => {
        this.lats.push(Date.now() - sent)
        if (this.lats.length > 200) this.lats.splice(0, this.lats.length - 200)
      })
      this.pxListeners.forEach((fn) => fn(m.px!, m.time))
      if (m.px !== this.px) { this.px = m.px; this.touch('px') }
    }
    if (m.ticker) { this.ticker = m.ticker; this.touch('ticker') }
    if (m.flow) { this.flow = m.flow; this.touch('flow') }
    if (m.dom) { this.dom = m.dom; this.touch('dom') }
    if (m.trades?.length) {
      const add = m.trades.filter((x) => x.k > this.lastFeedK)
      if (add.length) {
        this.lastFeedK = add[add.length - 1].k
        this.feed = [...add.reverse(), ...this.feed.filter((x) => x.k < add[add.length - 1].k)].slice(0, FEED_MAX)
        this.touch('feed')
      }
    }
    if (m.liqs?.length) {
      const add = m.liqs.filter((x) => x.k > this.lastLiqK)
      if (add.length) {
        this.lastLiqK = add[add.length - 1].k
        this.liqs = [...[...add].reverse(), ...this.liqs].slice(0, LIQ_MAX)
        this.touch('liqs')
        this.liqListeners.forEach((fn) => fn(add))
      }
    }
    if (m.bar) { this.bar = m.bar; this.barListeners.forEach((fn) => fn(m.bar!)) }
    if (m.hm?.length) this.hmListeners.forEach((fn) => fn(m.hm!))
    if (m.streams) { this.streams = m.streams; this.touch('conn') }
  }
}

/** Re-render del componente al massimo una volta per frame quando cambia la fetta. */
export function useSlice(live: TermLive, slice: Slice): number {
  return useSyncExternalStore((fn) => live.subscribe(slice, fn), () => live.version(slice), () => live.version(slice))
}
