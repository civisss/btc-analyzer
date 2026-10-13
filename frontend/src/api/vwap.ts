// VWAP ancorati W/M/Q/Y — tipi (CONTRACT.md § VWAP) + hook react-query. Query key root: 'vwap' (realtime.ts: '/vwap').
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

type N = number | null
export type VwapSource = 'kraken' | 'binance'
export type VwapCalc = 'fine' | 'chart'
export type VwapPeriod = 'w' | 'm' | 'q' | 'y'

export interface VwapStatus {
  ready: boolean; progress: number /* 0..1, share of expected 1m candles present */
  first: T | null; last: T | null; last_closed_end: T | null; rows: number
  missing_min: number; big_gaps: number; history_start: T
}
export interface VwapPrevLevels { vwap: N; sd: N; up1: N; dn1: N }
export interface VwapLevels {
  id: VwapPeriod; tf: number /* chart timeframe, seconds */
  anchor: T; prev_anchor: T; prev_end: T
  vwap: N; sd: N; up1: N; dn1: N; up2: N; dn2: N
  prev: VwapPrevLevels
  rows: number; prev_rows: number
}
export interface VwapPeriodData extends VwapLevels {
  dist_pct: N; z: N; prev_dist_pct: N   // price vs current VWAP (percent, σ units), price vs previous-period VWAP
}
export interface VwapConfluence {
  low: number; high: number; mid: number; width_pct: number; n: number
  members: string[]                     // 'w_vwap' | 'pm_up1' | … (p prefix = previous period)
  distance_pct: N
}
/** [vwap, +1σ, −1σ, prev vwap, prev +1σ, prev −1σ] */
export type VwapSix = [N, N, N, N, N, N]
export interface VwapSummary {
  source: VwapSource; calc: VwapCalc
  periods: VwapPeriod[]; tf: Record<VwapPeriod, number>
  sources: Record<VwapSource, { ready: boolean; progress: number }>
  status: VwapStatus
  periods_data: Record<VwapPeriod, VwapPeriodData> | null   // null until the 1m history is complete
  price?: number; price_time?: T; price_live?: boolean; close?: number; time?: T
  confluence?: VwapConfluence[]; confluence_pct?: number
  resolution_check?: Record<VwapPeriod, { diff_bp: VwapSix; tf: number }>      // other calc mode vs this one (basis points)
  crosscheck?: {
    other: VwapSource
    price_basis_bp_24h: N                                                   // median close(other)/close(this) − 1, last 24 h
    periods: Record<VwapPeriod, { other: VwapSix; diff_bp: VwapSix }>
  } | null
}
export interface VwapPanel {
  id: VwapPeriod; source: VwapSource; calc: VwapCalc; tf: number; status: VwapStatus
  anchor: T; prev_anchor: T; prev_end: T; last_closed_end: T; forming: boolean
  candles: { t: T[]; o: number[]; h: number[]; l: number[]; c: number[] } | null
  lines: { vwap: N[]; up1: N[]; dn1: N[]; pvwap: N[]; pup1: N[]; pdn1: N[] }   // aligned with candles.t
  levels: VwapLevels
}

async function get<R>(path: string): Promise<R> {
  const res = await fetch(`/api${path}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = String(b.detail)
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

const opts = { retry: 1, placeholderData: keepPreviousData } as const
export const useVwap = (source: VwapSource, calc: VwapCalc) =>
  useQuery({ queryKey: ['vwap', 'summary', source, calc], queryFn: () => get<VwapSummary>(`/vwap?source=${source}&calc=${calc}`),
    refetchInterval: (q) => (q.state.data?.status.ready === false ? 10_000 : 60_000), staleTime: 20_000, ...opts })
export const useVwapPanel = (p: VwapPeriod, source: VwapSource, calc: VwapCalc, enabled = true) =>
  useQuery({ queryKey: ['vwap', 'panel', p, source, calc], queryFn: () => get<VwapPanel>(`/vwap/panel?p=${p}&source=${source}&calc=${calc}`),
    refetchInterval: 60_000, staleTime: 20_000, enabled, ...opts })

// ------------------------------------------------------------------ single chart + session volume profile
export type VwapOverviewTf = '30m' | '1h' | '2h' | '4h'
export type VwapProfileMode = 'week' | 'month' | 'off'
export interface VwapProfileSession {
  start: T; end: T; complete: boolean
  bin: number; lo: number; vols: number[]            // volume (BTC) per price bin [lo + i·bin, lo + (i+1)·bin)
  volume: number
  poc: number; vah: number; val: number              // value area 70% (expanded from the POC, adding the larger adjacent bin)
  va_bins: [number, number]; poc_bin: number
  robust_bp: { poc: number; vah: number; val: number } // max |Δ| (bp) with half and double bin width
}
export interface VwapOverview {
  source: VwapSource; calc: VwapCalc; tf: VwapOverviewTf; step: number; status: VwapStatus
  from: T; last_closed_end: T; forming: boolean
  candles: { t: T[]; o: number[]; h: number[]; l: number[]; c: number[] } | null
  lines: Record<VwapPeriod, { vwap: N[]; up1: N[]; dn1: N[] }>   // current period, from the anchor (null before)
  levels: Record<VwapPeriod, VwapLevels>
  profile: { mode: VwapProfileMode; va_pct: number; sessions: VwapProfileSession[] }
}
export const useVwapOverview = (source: VwapSource, calc: VwapCalc, tf: VwapOverviewTf, profile: VwapProfileMode) =>
  useQuery({ queryKey: ['vwap', 'overview', source, calc, tf, profile],
    queryFn: () => get<VwapOverview>(`/vwap/overview?source=${source}&calc=${calc}&tf=${tf}&profile=${profile}`),
    refetchInterval: 60_000, staleTime: 20_000, ...opts })
