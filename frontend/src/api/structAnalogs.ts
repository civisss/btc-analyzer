// Analogia di struttura — tipi (vedi CONTRACT.md § STRUCTURE ANALOGS) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

export type SaAsset = 'btc' | 'usdtd' | 'ethbtc'
export type SaTf = '4h' | '1d' | '1w'
export type SaUnit = 'usd' | 'pct' | 'ratio'
export type SaLabel = 'HH' | 'LH' | 'HL' | 'LL'
export type SaKind = 'high' | 'low'
export type SaVerdict = 'none' | 'weak' | 'strong' | 'anecdotal'
type N = number | null

export type SaCandle = { time: T; open: number; high: number; low: number; close: number }
/** A confirmed ZigZag pivot inside a chart segment (`idx` = index in that segment's candles). */
export interface SaPivot {
  n: number; idx: number; time: T; price: number; kind: SaKind
  label: SaLabel | null; confirmed: T
  after: boolean // analog only: one of the 3 pivots that followed the matched tract
}
/** Structure break: first close beyond a confirmed swing (dotted line from the pivot to the break candle). */
export interface SaBreak { kind: 'bos_up' | 'bos_down' | 'choch_up' | 'choch_down'; from_idx: number; to_idx: number; level: number; from_time: T; time: T }
/** Projected pivot h = 1..3 after the last confirmed one (price/time with P25–P75). */
export interface SaProjPivot {
  h: number; kind: SaKind; label: SaLabel; agree: N // % of top-N analogs giving the same label
  price: number; lo: number; hi: number; change: number // % from the last price
  time: T; t_lo: T; t_hi: T; bar: number; reached: boolean // reached = the pivot in formation already went this far
  btc: { price: number; lo: number; hi: number } | null // USDT.D / ETH-BTC → BTC translation
}
export interface SaAnalog {
  rank: number; similarity: number; distance: number
  parts: { amp: number; dur: number; mismatch: number; scale: number; short: number }
  start: T; end: T; after_end: T
  candles: SaCandle[]; pivots: SaPivot[]; breaks: SaBreak[]; end_idx: number
  ratio: { amp: number; time: number } // present / analog scale (amplitude, duration), clipped 1/3..3
  scale: { amp: number; bars: number }
  labels: (SaLabel | null)[]
  outcome: { h: number; label: SaLabel | null; kind: SaKind; change: number; bars: number }[] // what followed (from the analog's last matched pivot)
  projection: SaProjPivot[] // this analog alone, rescaled onto the present
}
export interface SaRecent {
  time: T; kind: SaKind; pred_label: SaLabel; actual_label: SaLabel; hit: boolean
  pred: number; lo: number; hi: number; actual: number; actual_time: T; inside: boolean; err: number; base_err: number
}
export interface SaBacktest {
  n: number; from?: T; to?: T; ms?: number
  model?: { hit: number; cov: number; cov_raw: number; err_med: number; err_mean: number; time_err_med: number; time_cov: number; agree_hit: { n: number; hit: number } | null }
  base_median?: { hit: number; err_med: number; err_mean: number; time_err_med: number }
  base_random?: { hit: number; err_med: number; err_mean: number; time_err_med: number; hit_q95: number; err_q05: number }
  mase?: N; mase_random?: N; mase_time?: N
  p_err_random?: number; p_hit_random?: number; p_err_median?: N
  next2?: { hit: number; base_hit: number; cov: number; err_med: number; base_err_med: number; mase: N }
  btc?: { n: number; err_med: number; base_err_med: number; mase: N; cov: number; p_sign: N; dir_hit: number } | null
  halves?: { from: T; to: T; n: number; hit: number; base_hit: number; mase: N }[]
  verdict: SaVerdict
  recent?: SaRecent[]
  calibration?: { n: number[]; lr: ([number, number] | null)[]; dt: ([number, number] | null)[] }
}
export interface StructAnalogs {
  asset: SaAsset; tf: SaTf; mult: number; k: number; top: number; unit: SaUnit; generated_at: T
  assets: Record<SaAsset, SaTf[]>
  synthetic: boolean // close-only series (USDT.D, ETH/BTC): OHLC is synthetic
  current: {
    candles: SaCandle[]; pivots: SaPivot[]; breaks: SaBreak[]
    pending: { idx: number; time: T; price: number; kind: SaKind; label: SaLabel; move: number }
    last: { time: T; price: number; forming: boolean }
    btc_price: number
    swings: { amp: number; bars: number }[]
    scale: { amp: number; bars: number }
    start: T; end: T
  }
  projection: { n: number; pivots: SaProjPivot[]; calibrated: boolean; few: boolean } | null
  analogs: SaAnalog[]
  translation: { method: 'leg_elasticity'; beta: number; r2: number; corr: number; n: number; resid_sd: number; strength: 'strong' | 'moderate' | 'weak'; legs: number } | null
  history: { pivots: number; candidates: number; first: T; max_mismatch: number }
  backtest: SaBacktest
}

export type SaParams = { asset: SaAsset; tf: SaTf; mult: number; k: number; top: number }

export async function fetchStructAnalogs(p: SaParams): Promise<StructAnalogs> {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) s.set(k, String(v))
  const res = await fetch(`/api/analogs/structure?${s}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<StructAnalogs>
}

export const useStructAnalogs = (p: SaParams) =>
  useQuery({
    queryKey: ['structAnalogs', p],
    queryFn: () => fetchStructAnalogs(p),
    refetchInterval: p.tf === '4h' ? 60_000 : 120_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })
