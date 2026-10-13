/* Shared real-time store: one WebSocket (/api/ws) for the whole app, auto-reconnect
 * with exponential backoff. In mock mode a local emitter produces the same messages. */
import { useSyncExternalStore } from 'react'
import { USE_MOCKS } from './client'
import type { AgentMessage, AgentStatusMsg, Candle, T } from './types'
import { getLang } from '../i18n'
import type { Alert } from './alerts'

export type LiveTf = '1m' | '15m' | '1h' | '4h' | '1d' | '1w'
export type Ticker = { time: T; price: number; change_24h: number; high_24h: number; low_24h: number; volume_24h_usd: number }
export type Mark = { time: T; mark: number; index: number; funding_rate: number; next_funding: T }
export type LiveLiq = { time: T; side: 'long' | 'short'; price: number; qty: number; usd: number; exchange?: 'binance' | 'bybit' | 'okx'; symbol?: string }
export type KlineMsg = { type: 'kline'; tf: LiveTf; closed: boolean; candle: Candle }
/** Binance USDⓈ-M perpetual 1m candle (with taker_buy) */
export type PerpKlineMsg = { type: 'perp_kline'; tf: LiveTf; closed: boolean; candle: Candle }
/** Kraken Futures PF_XBTUSD trades (≤2/s): last price + high/low of the trades since the previous tick (VWAP page) */
export type VwapTickMsg = { type: 'vwap_tick'; source: 'kraken'; time: T; price: number; high: number; low: number }
export type LiveMsg =
  | ({ type: 'ticker' } & Ticker)
  | ({ type: 'mark' } & Mark)
  | ({ type: 'liquidation' } & LiveLiq)
  | KlineMsg
  | PerpKlineMsg
  | VwapTickMsg
  | ({ type: 'agent_message' } & AgentMessage)
  | ({ type: 'agent_status' } & AgentStatusMsg)
  | { type: 'invalidate'; source?: string; keys: string[]; time?: T }
  | ({ type: 'toast' } & Alert)

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'offline'

export interface LiveState {
  conn: ConnState
  lastMessageAt: number | null // ms
  ticker: Ticker | null
  prevPrice: number | null
  mark: Mark | null
  klines: Partial<Record<LiveTf, Candle>>
  liquidations: LiveLiq[] // most recent first, ring buffer
  agentMessages: AgentMessage[] // most recent first, ring buffer
  agentStatus: Partial<Record<string, AgentStatusMsg>>
}

const LIQ_MAX = 200

class LiveStore {
  state: LiveState = { conn: 'connecting', lastMessageAt: null, ticker: null, prevPrice: null, mark: null, klines: {}, liquidations: [], agentMessages: [], agentStatus: {} }
  private listeners = new Set<() => void>()
  private klineListeners = new Set<(m: KlineMsg) => void>()
  private liqListeners = new Set<(l: LiveLiq) => void>()
  private perpKlineListeners = new Set<(m: PerpKlineMsg) => void>()
  private vwapTickListeners = new Set<(m: VwapTickMsg) => void>()
  private agentListeners = new Set<(m: AgentMessage) => void>()
  private invalidateListeners = new Set<(keys: string[]) => void>()
  private toastListeners = new Set<(a: Alert) => void>()
  private ws: WebSocket | null = null
  private attempt = 0
  private started = false
  private pending: Partial<LiveState> | null = null
  private raf = 0

  start() {
    if (this.started) return
    this.started = true
    if (USE_MOCKS) {
      import('./mocks').then(({ startMockLive }) => {
        this.set({ conn: 'open' })
        startMockLive((m) => this.handle(m as LiveMsg))
      })
    } else this.connect()
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/ws${getLang() === 'en' ? '?lang=en' : ''}`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.set({ conn: this.attempt === 0 ? 'connecting' : 'reconnecting' })
    ws.onopen = () => {
      this.attempt = 0
      this.set({ conn: 'open' })
    }
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (Array.isArray(data)) data.forEach((m) => this.handle(m))
        else if (data && Array.isArray(data.messages)) data.messages.forEach((m: LiveMsg) => this.handle(m))
        else this.handle(data)
      } catch {
        /* ignore malformed */
      }
    }
    ws.onclose = () => {
      this.ws = null
      this.scheduleReconnect()
    }
    ws.onerror = () => ws.close()
  }

  private scheduleReconnect() {
    this.attempt++
    this.set({ conn: this.attempt > 6 ? 'offline' : 'reconnecting' })
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt - 1, 5)) * (0.75 + Math.random() * 0.5)
    setTimeout(() => this.connect(), delay)
  }

  private handle(m: LiveMsg) {
    if (!m || typeof m !== 'object') return
    const now = Date.now()
    switch (m.type) {
      case 'ticker': {
        const { type: _t, ...t } = m
        void _t
        this.set({ ticker: t, prevPrice: this.peek().ticker?.price ?? null, lastMessageAt: now })
        break
      }
      case 'mark': {
        const { type: _t, ...mk } = m
        void _t
        this.set({ mark: mk, lastMessageAt: now })
        break
      }
      case 'kline': {
        this.set({ klines: { ...this.peek().klines, [m.tf]: m.candle }, lastMessageAt: now })
        this.klineListeners.forEach((l) => l(m))
        break
      }
      case 'perp_kline': {
        this.perpKlineListeners.forEach((l) => l(m))
        break
      }
      case 'vwap_tick': {
        this.vwapTickListeners.forEach((l) => l(m))
        break
      }
      case 'liquidation': {
        const { type: _t, ...l } = m
        void _t
        this.set({ liquidations: [l, ...this.peek().liquidations].slice(0, LIQ_MAX), lastMessageAt: now })
        this.liqListeners.forEach((fn) => fn(l))
        break
      }
      case 'agent_message': {
        const { type: _t, ...am } = m
        void _t
        const cur = this.peek().agentMessages
        if (cur.some((x) => x.id === am.id)) break
        this.set({ agentMessages: [am, ...cur].slice(0, 300), lastMessageAt: now })
        this.agentListeners.forEach((fn) => fn(am))
        break
      }
      case 'toast': {
        const { type: _t, ...a } = m
        void _t
        if (!a.silent) this.toastListeners.forEach((fn) => fn(a as Alert))
        break
      }
      case 'invalidate': {
        if (Array.isArray(m.keys) && m.keys.length) this.invalidateListeners.forEach((fn) => fn(m.keys))
        break
      }
      case 'agent_status': {
        const { type: _t, ...st } = m
        void _t
        this.set({ agentStatus: { ...this.peek().agentStatus, [st.id]: st }, lastMessageAt: now })
        break
      }
    }
  }

  private peek(): LiveState {
    return this.pending ? { ...this.state, ...this.pending } : this.state
  }

  /** Batches updates to one React notification per animation frame. */
  private set(p: Partial<LiveState>) {
    this.pending = { ...(this.pending ?? {}), ...p }
    if (this.raf) return
    const flush = () => {
      this.raf = 0
      if (!this.pending) return
      this.state = { ...this.state, ...this.pending }
      this.pending = null
      this.listeners.forEach((l) => l())
    }
    this.raf = typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible'
      ? requestAnimationFrame(flush)
      : (setTimeout(flush, 100) as unknown as number)
  }

  /** Send a control message (e.g. {tfs:[...]}) to the server when connected. */
  send(msg: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  onKline(fn: (m: KlineMsg) => void) {
    this.klineListeners.add(fn)
    return () => {
      this.klineListeners.delete(fn)
    }
  }
  onPerpKline(fn: (m: PerpKlineMsg) => void) {
    this.perpKlineListeners.add(fn)
    return () => {
      this.perpKlineListeners.delete(fn)
    }
  }
  onVwapTick(fn: (m: VwapTickMsg) => void) {
    this.vwapTickListeners.add(fn)
    return () => {
      this.vwapTickListeners.delete(fn)
    }
  }
  onLiquidation(fn: (l: LiveLiq) => void) {
    this.liqListeners.add(fn)
    return () => {
      this.liqListeners.delete(fn)
    }
  }
  /** WS {"type":"invalidate","keys":[...]} → API path prefixes whose data was recalculated. */
  onInvalidate(fn: (keys: string[]) => void) {
    this.invalidateListeners.add(fn)
    return () => {
      this.invalidateListeners.delete(fn)
    }
  }
  /** WS {"type":"toast", ...Alert} (never silent). */
  onToast(fn: (a: Alert) => void) {
    this.toastListeners.add(fn)
    return () => {
      this.toastListeners.delete(fn)
    }
  }
  /** Ask the server to translate pushed texts (agent messages, toasts). */
  setLang(lang: 'it' | 'en') {
    this.send({ lang })
  }
  onAgentMessage(fn: (m: AgentMessage) => void) {
    this.agentListeners.add(fn)
    return () => {
      this.agentListeners.delete(fn)
    }
  }
  getSnapshot = () => this.state
}

export const live = new LiveStore()

/** Select a slice of the live state; re-renders only when the selected value changes (Object.is). */
export function useLive<S>(selector: (s: LiveState) => S): S {
  return useSyncExternalStore(live.subscribe, () => selector(live.getSnapshot()))
}

export const useLivePrice = () => useLive((s) => s.ticker?.price ?? null)
export const useConn = () => useLive((s) => s.conn)
