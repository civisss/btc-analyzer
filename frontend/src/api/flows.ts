// Flussi spot vs futures — tipi (CONTRACT.md § FLOWS), hook react-query e accumulatore live 1m dal WebSocket.
import { useSyncExternalStore } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import { live } from './live'
import type { Candle, T, Tone } from './types'

export type FlowTf = '1h' | '4h' | '1d'
export type FlowRange = '1d' | '3d' | '7d' | '30d' | '90d' | '1y' | '3y'
export type FlowWindowLabel = '1h' | '4h' | '24h' | '7d' | '30d'

export interface FlowPoint {
  time: T; price: number
  spot_buy: number; spot_sell: number; spot_delta: number
  perp_buy: number; perp_sell: number; perp_delta: number
  spot_cvd: number; perp_cvd: number
}
export interface FlowWindow {
  label: FlowWindowLabel
  spot_delta: number; perp_delta: number
  spot_buy_pct: number; perp_buy_pct: number
  spot_volume: number; perp_volume: number
  perp_spot_ratio: number; price_change: number
}
export interface Flows {
  tf: string; range: string
  series: FlowPoint[]
  windows: FlowWindow[]
  current: { dominant: 'spot' | 'perp'; bias: Tone; spot_buy_pct_24h: number; perp_buy_pct_24h: number }
  signals: { text: string; tone: Tone }[]
  delta_correlation: number | null
  note: string
}

async function getFlows(tf: FlowTf, range: FlowRange): Promise<Flows> {
  const res = await fetch(`/api/flows?tf=${tf}&range=${range}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<Flows>
}

export const useFlows = (tf: FlowTf, range: FlowRange) =>
  useQuery({ queryKey: ['flows', tf, range], queryFn: () => getFlows(tf, range), refetchInterval: 60_000, retry: 1, placeholderData: keepPreviousData })

// ------------------------------------------------------------------ live rolling 60-minute delta
type Min = { delta: number; buy: number; vol: number }
export interface LiveFlow {
  /** minutes of WS data available inside the rolling 60-minute window */
  minutes: number
  spot: { delta: number; buyPct: number | null; volume: number } | null
  perp: { delta: number; buyPct: number | null; volume: number } | null
  updatedAt: number | null
}

const WINDOW_S = 60 * 60
const spotMin = new Map<number, Min>()
const perpMin = new Map<number, Min>()
let snapshot: LiveFlow = { minutes: 0, spot: null, perp: null, updatedAt: null }
const listeners = new Set<() => void>()
let started = false
let dirty = false

function toMin(c: Candle): Min | null {
  if (c.taker_buy == null || !Number.isFinite(c.volume)) return null
  // delta = (buy - sell) * close = (2*taker_buy - volume) * close
  return { delta: (2 * c.taker_buy - c.volume) * c.close, buy: c.taker_buy * c.close, vol: c.volume * c.close }
}
function sum(m: Map<number, Min>, from: number) {
  let delta = 0, buy = 0, vol = 0, n = 0
  for (const [t, v] of m) {
    if (t < from) { m.delete(t); continue }
    delta += v.delta; buy += v.buy; vol += v.vol; n++
  }
  return n ? { delta, buyPct: vol > 0 ? (buy / vol) * 100 : null, volume: vol, n } : null
}
function recompute() {
  const from = Math.floor(Date.now() / 1000) - WINDOW_S + 60
  const s = sum(spotMin, from), p = sum(perpMin, from)
  const mins = Math.max(s?.n ?? 0, p?.n ?? 0)
  snapshot = {
    minutes: Math.min(60, mins),
    spot: s && { delta: s.delta, buyPct: s.buyPct, volume: s.volume },
    perp: p && { delta: p.delta, buyPct: p.buyPct, volume: p.volume },
    updatedAt: Date.now(),
  }
  listeners.forEach((l) => l())
}
/** Start accumulating WS 1m flows (called once at app start so data survives page changes). */
export function startLiveFlow() {
  ensureStarted()
}
function ensureStarted() {
  if (started) return
  started = true
  live.onKline((m) => {
    if (m.tf !== '1m') return
    const v = toMin(m.candle)
    if (v) { spotMin.set(m.candle.time, v); dirty = true } // replace on update, keyed by candle time
  })
  live.onPerpKline((m) => {
    if (m.tf !== '1m') return
    const v = toMin(m.candle)
    if (v) { perpMin.set(m.candle.time, v); dirty = true }
  })
  // throttle React notifications to 1/s
  setInterval(() => { if (dirty) { dirty = false; recompute() } }, 1000)
}

/** Rolling 60-minute aggressive-flow delta built from the WS 1m spot klines and perp klines. */
export function useLiveFlow(): LiveFlow {
  ensureStarted()
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l) },
    () => snapshot,
  )
}
