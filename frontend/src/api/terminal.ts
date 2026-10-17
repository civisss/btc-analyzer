// Terminale — order flow multi-exchange, CVD/OI/funding aggregati, premio Coinbase, book a scala (CONTRACT.md § TERMINAL).
// Query key roots: 'terminal' (status/segnali, invalidati dall'agente "flow" via realtime.ts '/terminal'); 'term-series' e
// 'term-snap' (dati pesanti/live, mai invalidati in blocco: si aggiornano dal WebSocket /api/ws/terminal + ricarica periodica).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from './client'

type N = number | null
export type TermTf = '1m' | '5m' | '15m' | '1h'
export type StreamKey = 'binance_perp' | 'bybit_perp' | 'okx_perp' | 'binance_spot' | 'coinbase_spot' | 'bybit_spot' | 'okx_spot'
export type Group = 'spot' | 'perp' | 'all'

export interface TermTicker {
  last: N; last_ts: N; mark: N; index: N; funding_rate: N /* % per periodo Binance */; next_funding: N; high_24h: N; low_24h: N
  vol_24h_btc: N; vol_24h_usd: N; change_24h: N; oi_btc: N; oi_usd: N; oi_chg_1h?: N; f8: N /* % 8h ponderato OI */; oi_t: N
  premium: N /* % Coinbase vs Binance spot */; cb: N; bn: N
}
export interface FlowW {
  buy_usd: number; sell_usd: number; buy_btc: number; sell_btc: number; delta_usd: number; delta_btc: number; buy_share: N
  n_buy: number; n_sell: number; avg_buy_usd: N; avg_sell_usd: N; avg_usd: N; large_buy: number; large_sell: number; exchanges: number
  perp_delta_usd: number; spot_delta_usd: number; perp_usd: number; spot_usd: number
  win_s: number; cov_s: number /* secondi della finestra coperti dalla raccolta (meno di win_s subito dopo l'avvio) */
}
export type TermFlow = { w1: FlowW; w5: FlowW; w15: FlowW }
export interface TermDom { market: 'futures' | 'spot'; synced: boolean; step?: number; bb?: number; ba?: number; bids?: [number, number][]; asks?: [number, number][]; t?: number }
/** trade del feed: a = 1 aggregato (trade < $10K dello stesso stream e lato in 250 ms), n = numero di trade */
export interface FeedItem { k: number; s: StreamKey; t: number /* ms */; p: N; u: number; q: number; b: 0 | 1; n: number; a: 0 | 1 }
export interface LiqItem { k: number; t: number; side: 'long' | 'short'; price: number; qty: number; usd: number; ex: string; sym?: string }
export interface EstLevel { price: number; usd: number; side: 'long' | 'short'; distance: number }
/** barra in formazione: cvd[g] = [delta, max, min] relativi all'apertura; oi = [o,h,l,c] */
export interface TermBar { tf: TermTf; t: number; cvd: Record<Group, [number, number, number]>; v: N; vb: number; vs: number; oi?: [number, number, number, number]; f8?: N; pm?: N }
export type StreamsBrief = Record<StreamKey, { c: boolean; age: N }>

export interface TermSnapshot {
  time: number; ticker: TermTicker; flow: TermFlow; dom: TermDom | null; feed: FeedItem[]; feed_seq: number; liqs: LiqItem[]; liq_seq: number
  est: EstLevel[]; bar: TermBar; streams: StreamsBrief
  cfg: { streams: Record<StreamKey, { ex: string; mkt: 'perp' | 'spot'; label: string }>; large_usd: number; feed_min_usd: number; dom_steps: number[]; tfs: TermTf[]; okx_ct_val: number; enabled: boolean }
}

export interface Ohlc { o: N[]; h: N[]; l: N[]; c: N[] }
export interface TermSeries {
  tf: TermTf; from: number; to: number; t: number[]; o: N[]; h: N[]; l: N[]; c: N[]; v: N[]; vb: N[]; vs: N[]
  cvd: Record<Group, Ohlc>; oi: Ohlc; f8: N[]; pm: N[]
  liq: { t: number[]; p: number[]; u: number[]; s: (0 | 1)[] /* 1 = long liquidati */; x: string[] }
  cov: Record<StreamKey, { ws_from: N; kline_from?: N }>; multi_from: N
  oi_info: { own_from: N; snap_from: N; est_from: N; f8_settled_fill?: boolean }; pm_info: { live_from: N; kline_from: N; hourly_fallback: boolean }
  collection_start: Partial<Record<StreamKey, number>>; ms: number
}

export interface PStats { n: number; median_abs?: number; p95_abs?: number; max_abs?: number; within_1?: number }
export interface StreamStatus {
  ex: string; mkt: 'perp' | 'spot'; label: string; connected: boolean; msgs: number; trades: number; dupes: number; reconnects: number
  last_age_s: N; last_price: N; latency_ms_p50: N; incomplete_minutes: number; id_check: boolean
  recoveries: { n: number; ok: number; new: number; last: { t: number; ok: boolean; new: number; n?: number }[] }
  kline_check: PStats & { buy: PStats; last: { t: number; ours: number; official: number; diff_pct: number; buy_diff_pct?: number }[] }
  first_start: N; sessions: [number, number][]
}
export interface TermStatus {
  time: number; enabled: boolean; cpu: { collector_pct: number; flush_pct: number; window_s?: number }; rss_mb: N
  streams: Record<StreamKey, StreamStatus>; okx_ct: { ct_val: number; ccy: string; ok: boolean } | null
  premium_check: { n: number; median_abs_pp: N; max_abs_pp: N } | null
  backfill: Record<string, { days: number; fetched: number; requests: number; error?: string }>
  storage: { total_mb: number; files: number; by_kind_mb: Record<string, number>; mb_per_day: N; retention_days: number }
  flush_ms_p50: N; collection_start: Partial<Record<StreamKey, number>>; large_usd: number
}

// ------------------------------------------------------------------ layout
export type TileId = 'dom' | 'chart' | 'feed' | 'flow' | 'panes' | 'liqs' | 'integrity'
export type PaneId = 'cvd_spot' | 'cvd_perp' | 'cvd_all' | 'oi' | 'funding' | 'premium'
export interface TileState { id: TileId; w: number; h: number; hidden: boolean }
export interface TermLayoutState { tf: TermTf; tiles: TileState[]; panes: PaneId[]; opts: { heat: boolean; est: boolean; bubbles: boolean; vol: boolean } }
export interface TermLayout { id: string; name: string; state: TermLayoutState; created_at: number; updated_at: number }

// ------------------------------------------------------------------ fetch
/** Fetch senza ?lang: i payload numerici non passano dal traduttore (URL non-stringa = nessuna patch di installFetchLang). */
async function getRaw<R>(path: string, params: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<R> {
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
async function req<R>(path: string, init?: RequestInit): Promise<R> {
  const res = await fetch(`/api${path}`, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

export const fetchSnapshot = (tf: TermTf, dm: string, ds: number) => getRaw<TermSnapshot>('/terminal/snapshot', { tf, dm, ds })

const SERIES_REFRESH: Record<TermTf, number> = { '1m': 60_000, '5m': 120_000, '15m': 180_000, '1h': 300_000 }
export const useTermSeries = (tf: TermTf) =>
  useQuery({
    queryKey: ['term-series', tf],
    queryFn: ({ signal }) => getRaw<TermSeries>('/terminal/series', { tf }, signal),
    // la barra in formazione arriva dal WebSocket; la ricarica periodica riallinea storico, OI e premio
    refetchInterval: SERIES_REFRESH[tf], refetchOnWindowFocus: false, staleTime: 30_000, placeholderData: keepPreviousData, retry: 1,
  })
export const useTermStatus = () =>
  useQuery({ queryKey: ['terminal', 'status'], queryFn: () => req<TermStatus>('/terminal/status'), refetchInterval: 20_000, staleTime: 10_000,
    placeholderData: keepPreviousData, retry: 1 })
export const useTermEst = () =>
  useQuery({ queryKey: ['term-snap', 'est'], queryFn: () => fetchSnapshot('5m', 'futures', 10).then((s) => s.est), refetchInterval: 300_000, staleTime: 240_000, retry: 1 })

export const useTermLayouts = () =>
  useQuery({ queryKey: ['terminal', 'layouts'], queryFn: () => req<{ layouts: TermLayout[] }>('/terminal/layouts'), staleTime: 60_000 })
export function useTermLayoutMutations() {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['terminal', 'layouts'] })
  return {
    create: useMutation({ mutationFn: (b: { name: string; state: TermLayoutState }) => req<TermLayout>('/terminal/layouts', { method: 'POST', body: JSON.stringify(b) }), onSuccess: done }),
    update: useMutation({ mutationFn: (b: { id: string; name?: string; state?: TermLayoutState }) => req<TermLayout>(`/terminal/layouts/${b.id}`, { method: 'PUT', body: JSON.stringify({ name: b.name, state: b.state }) }), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => req<{ ok: boolean }>(`/terminal/layouts/${id}`, { method: 'DELETE' }), onSuccess: done }),
  }
}

// ------------------------------------------------------------------ heatmap della liquidità (riuso dell'order book)
export { useObHeatmap } from './orderbook'
export type { ObLiveCol } from './orderbook'
