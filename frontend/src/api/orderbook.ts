// Order book — heatmap della liquidità + footprint (CONTRACT.md § ORDER BOOK). Query key roots: 'orderbook' (status/segnali,
// invalidati dall'agente via realtime.ts '/orderbook'), 'ob-heatmap' e 'ob-footprint' (dati pesanti, mai invalidati in blocco).
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { ApiError } from './client'

type N = number | null
export type ObMarket = 'futures' | 'spot'
export type ObTf = '1m' | '5m' | '15m' | '1h'

export interface ObEvent {
  t: number; kind: 'pulled' | 'consumed' | 'appeared'; side: 'bid' | 'ask'; price: number
  qmax: number; q: number; age_s: number; dist_pct: number; executed?: N
}
export interface ObWall { price: number; side: 'bid' | 'ask'; q: number; qmax: number; age_s: number; dist_pct: number }
export interface ObWallRule { k: number; min_qty: number; min_age_s?: number; near_pct?: number; median: N; threshold: N; window_pct?: number }

export interface ObHeatmap {
  market: ObMarket; from: number; to: number; tier: 's' | 'm'; dt: number; range_pct: number; bucket: number
  cols: number; rows: number; price_lo: N; q: string; scale: number; empty?: boolean
  pct?: Record<string, number>
  t: number[]; mid: N[]; last: N[]; hi: N[]; lo: N[]; vb: N[]; vs: N[]; vwap: N[]; bb: N[]; ba: N[]; imb: N[]; tlo: N[]; thi: N[]
  gaps: [number, number][]; events: ObEvent[]; walls: ObWall[]; wall_rule: ObWallRule; collection_start: N
}

export interface ObFootprint {
  market: ObMarket; tf: ObTf; bin: number; from: number; to: number; ratio: number; min_share: number; collection_start: N; empty?: boolean
  candles: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; buy: number[]; sell: number[]; delta: number[]; cvd: number[]
    poc: N[]; n: number[]; ok: boolean[]; off: number[]; cnt: number[] }
  levels: { p: number[]; buy: number[]; sell: number[]; imb: number[] }
  stacked: { side: 'buy' | 'sell'; from: number; to: number; n: number; i: number }[]
}

export interface ObVerify {
  best_bid: N; best_ask: N; ref_best_bid: N; ref_best_ask: N; best_match: boolean; top_levels: number; top_mismatch: number
  range_levels: number; range_mismatch: number; update_id_a: N; update_id_b: N; t: number; snapshot_id: N; lo: N; hi: N; diff_only: number
}
export interface ObPStats { n: number; median_abs?: number; p95_abs?: number; max_abs?: number; within_05?: number }
export interface ObMarketStatus {
  depth_connected: boolean; trade_connected: boolean; synced: boolean; last_update_id: N; levels: { bids: number; asks: number }
  best_bid: N; best_ask: N; mid: N; last_sample: N; samples_mem: number; trusted: [N, N]; trusted_pct: [N, N]
  msgs: { depth: number; trades: number }; snapshots: number; disconnects: { depth: number; trades: number }; book_gaps: number
  resyncs: { n: number; last: { t: number; reason: 'connect' | 'gap' }[] }
  verify: { n: number; ok: number; top_mismatch: number; range_mismatch: number; levels_compared: number; diff_only_levels: number
    new_zone_levels: number; new_zone_mismatch: number; every_s: number; last: ObVerify | null }
  kline_check: ObPStats & { buy: ObPStats; last: { t: number; ours: number; official: number; diff_pct: N; buy_diff_pct: N }[]; every_s: number }
  backfills: { t: number; from: number; to: number; n: number; ok: boolean; fetched: number }[]; incomplete_minutes: number
  collection_start: N; sessions: [number, number][]; coverage: [number, number][]
  storage: { total_mb: number; mb_per_day: N; hs_mb_per_day: N; other_mb_per_day: N; hours_measured: number; files: number; by_kind_mb: Record<string, number> }
  mem_est_mb: number; flush_ms_p50: N
}
export interface ObStatus {
  markets: Partial<Record<ObMarket, ObMarketStatus>>; time: number; enabled: ObMarket[]
  cpu: { collector_pct: number; flush_pct: number; window_s?: number }; rss_mb: N
  config: { range_pct: number; sample_s: number; base_bucket: number; fp_base_bin: number; buckets: number[]; fp_bins: number[]
    retention_days: { hs: number; hm: number; fp: number }; imb_ratio: number; imb_min_share: number; debug: boolean }
}
export interface ObSignals {
  market: ObMarket; time: number; synced: boolean; mid: N; wall_rule: ObWallRule; walls: ObWall[]; events: ObEvent[]
  imbalance?: { mean: number; share_bid: number; share_ask: number; now: number; minutes: number; persistent: 'bid' | 'ask' | null }
  cvd?: { minutes: number; price_change_pct: number; cvd: number; volume: number; cvd_share: N; divergence: 'price_up_cvd_down' | 'price_down_cvd_up' | null }
}

/** Fetch senza ?lang: i payload numerici non passano dal traduttore (URL non-stringa = nessuna patch di installFetchLang). */
async function getRaw<R>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<R> {
  const u = new URL(`/api${path}`, location.origin)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v))
  const res = await fetch(u, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}
async function get<R>(path: string): Promise<R> {
  const res = await fetch(`/api${path}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new ApiError(res.status, res.statusText || `HTTP ${res.status}`)
  return res.json() as Promise<R>
}

export const useObStatus = () =>
  useQuery({ queryKey: ['orderbook', 'status'], queryFn: () => get<ObStatus>('/orderbook/status'), refetchInterval: 15_000, staleTime: 10_000,
    placeholderData: keepPreviousData, retry: 1 })
export const useObSignals = (market: ObMarket) =>
  useQuery({ queryKey: ['orderbook', 'signals', market], queryFn: () => get<ObSignals>(`/orderbook/signals?market=${market}`),
    refetchInterval: 20_000, staleTime: 10_000, placeholderData: keepPreviousData, retry: 1 })

export interface HeatmapParams { market: ObMarket; span: number; bucket: number; range: number; cols: number; to?: number }
export const useObHeatmap = (p: HeatmapParams, enabled = true) =>
  useQuery({
    queryKey: ['ob-heatmap', p.market, p.span, p.bucket, p.range, p.cols, p.to ?? 'live'],
    queryFn: ({ signal }) => {
      const to = p.to ?? Date.now() / 1000
      return getRaw<ObHeatmap>('/orderbook/heatmap', { market: p.market, from: Math.floor(to - p.span), to: p.to ? Math.floor(to) : undefined, bucket: p.bucket, range: p.range, cols: p.cols }, signal)
    },
    // live: le colonne nuove arrivano dal WebSocket; un ricaricamento completo ogni 5 min riallinea medie e buchi
    refetchInterval: p.to ? false : 300_000, refetchOnWindowFocus: false, staleTime: 120_000, placeholderData: keepPreviousData, retry: 1, enabled,
  })

export interface FootprintParams { market: ObMarket; tf: ObTf; bin: number; limit: number }
export const useObFootprint = (p: FootprintParams, enabled = true) =>
  useQuery({
    queryKey: ['ob-footprint', p.market, p.tf, p.bin, p.limit],
    queryFn: ({ signal }) => getRaw<ObFootprint>('/orderbook/footprint', { market: p.market, tf: p.tf, bin: p.bin, limit: p.limit }, signal),
    refetchInterval: 120_000, refetchOnWindowFocus: false, staleTime: 60_000, placeholderData: keepPreviousData, retry: 1, enabled,
  })

// ------------------------------------------------------------------ live WebSocket (/api/ws/orderbook)
export interface ObLiveCol {
  t: number; mid: number; bb: number; ba: number; last: N; hi: N; lo: N; vb: N; vs: N; vwap: N; imb: N; tlo: N; thi: N
  plo: number; q: number[]
}
export interface ObLiveFp {
  t: number; tf: ObTf; bin: number; o: number; h: number; l: number; c: number; buy: number; sell: number; delta: number; poc: N; n: number; ok: boolean
  p: number[]; lbuy: number[]; lsell: number[]; imb: number[]; stacked: ObFootprint['stacked']
}
export interface ObLiveMsg {
  type: 'ob_live'; market: ObMarket; time: number; status: { synced: boolean; depth: boolean; trades: boolean }
  cols?: ObLiveCol[]; fp?: ObLiveFp; events?: ObEvent[]
}
export interface LiveSub { market: ObMarket; bucket: number; range: number; tf: ObTf; bin: number }

/** One WebSocket per page; params changes are sent as control messages; auto-reconnect with backoff. */
export function useObLive(sub: LiveSub, onMsg: (m: ObLiveMsg) => void, onConn?: (open: boolean) => void) {
  const cb = useRef(onMsg)
  cb.current = onMsg
  const cc = useRef(onConn)
  cc.current = onConn
  const wsRef = useRef<WebSocket | null>(null)
  const subRef = useRef(sub)
  subRef.current = sub
  useEffect(() => {
    let closed = false
    let attempt = 0
    let timer = 0
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const s = subRef.current
      const q = new URLSearchParams({ market: s.market, bucket: String(s.bucket), range: String(s.range), tf: s.tf, bin: String(s.bin) })
      const ws = new WebSocket(`${proto}//${location.host}/api/ws/orderbook?${q}`)
      wsRef.current = ws
      ws.onopen = () => { attempt = 0; cc.current?.(true) }
      ws.onmessage = (ev) => { try { cb.current(JSON.parse(ev.data)) } catch { /* ignore */ } }
      ws.onclose = () => {
        wsRef.current = null
        cc.current?.(false)
        if (closed) return
        attempt++
        timer = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5)))
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      const ws = wsRef.current
      // chiudere un socket ancora in connessione genera un avviso in console: si chiude appena aperto
      if (ws && ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close()
      else ws?.close()
    }
  }, [])
  useEffect(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(sub))
  }, [sub.market, sub.bucket, sub.range, sub.tf, sub.bin]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** base64 uint16 LE -> Float32Array (NaN = assente). */
export function decodeU16(b64: string, scale: number): Float32Array {
  const bin = atob(b64)
  const n = bin.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const code = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
    out[i] = code === 0 ? NaN : (code - 1) * scale
  }
  return out
}
