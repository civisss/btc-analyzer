// Previsione a 1 giorno — tipi (CONTRACT.md § FORECAST 1 DAY) + hook react-query.
// Query key root 'forecast' (realtime.ts: '/forecast'): the forecast agent's WS invalidate refreshes it too.
import { useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

type N = number | null
export type VerdictCode = 'edge' | 'small_edge' | 'no_edge' | 'worse' | 'worse_ns' | 'baseline' | 'n_a'
export interface OneDayVerdict {
  code: VerdictCode; mase?: N; dm_p?: N; benchmark?: 'naive' | 'naive_close'
  direction_significant?: boolean; direction_beats_always_up?: boolean
}
export interface OneDayMetrics {
  n: number
  mae?: number; mape?: number; rmse_pct?: number; mase?: N; bias_pct?: number
  corr_price?: N; corr_ret?: N
  n_dir?: number; hit_rate?: N; always_up?: N; p_dir?: N; p_dir_vs_up?: N; share_up_calls?: N
  dm_stat?: N; dm_p?: N
  mase_vs_close?: N; dm_stat_vs_close?: N; dm_p_vs_close?: N        // prezzo medio: vs "chiusura di oggi"
  coverage_50?: number; coverage_90?: number; width_50?: number; width_90?: number
  brier?: number; brier_skill?: N
  verdict: OneDayVerdict
}
export type OneDayPeriod = 'd90' | 'y1' | 'all' | 'repo'
export type CloseKey = 'model' | 'naive' | 'drift'
export type MidKey = 'model' | 'naive' | 'naive_close' | 'replica'
export interface OneDayPeriodEval {
  from: T | null; to: T | null
  close: Record<CloseKey, OneDayMetrics>
  mid: Record<MidKey, OneDayMetrics>
}
export interface OneDayTomorrow {
  origin: T; target: T; closes_at: T
  ref_price: number; median: number; p05: number; p25: number; p75: number; p95: number
  change_pct: number; up_prob: number; up_prob_raw: number
  mid: { median: number; p05: number; p95: number }
  drift_price: number; naive_price: number
  live_price: N; live_change_pct: N; live_in_band: '50' | '90' | 'out' | null
}
/** Columnar out-of-sample series, one entry per TARGET day (prices in USD, rounded). */
export interface OneDaySeries {
  t: T[]; close: N[]; ref: N[]; model: N[]; p05: N[]; p25: N[]; p75: N[]; p95: N[]; up: N[]; drift: N[]
  mid: N[]; ref_mid: N[]; model_mid: N[]; replica: N[]; replica_valid: boolean[]; live: boolean[]
}
export interface OneDayLeakage {
  structural_violations: number; rows: number; min_gap_days: number; max_gap_days: number; replica_no_overlap: boolean
  point_in_time: { passed: boolean | null; dates: { date: T; compared: number; mismatch: string[]; nan_mismatch: string[]; max_rel_diff: number; close_equal: boolean }[] }
  passed: boolean
}
export interface ForecastOneDay {
  version: number; generated_at: T; data_day: string
  tomorrow: OneDayTomorrow
  series: OneDaySeries
  evaluation: Record<OneDayPeriod, OneDayPeriodEval>
  periods: { repo: { from: T; to: T } }
  replica: {
    url: string; window_size: number; train_start: string; train_end: string; valid_start: string; valid_end: string
    features: string[]; n_estimators: number
    train_rows: number; train_from: T; train_to: T; valid_from: T; valid_to: T; valid_rows: number
    train_max_price: number; no_overlap: boolean
  }
  leakage: OneDayLeakage
  live_from: T | null; n_refits: number
  settings: { oos_start: T; dir_eps_pct: number; conformal_window: number; platt_window: number; n_features: number
              refit: string; window: string; train_start_close: string; train_start_mid: T }
  training: { status: 'ready' | 'training' | 'error'; progress: string | null; error: string | null; trained_at: T | null
              data_day: string | null; seconds: Record<string, number>; started_at: T | null }
}

async function get<R>(path: string): Promise<R> {
  const res = await fetch(`/api${path}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

/** Out-of-sample series + tomorrow's forecast. The heavy part changes once a day; the live price inside every minute. */
export const useForecastOneDay = (enabled = true) =>
  useQuery({
    queryKey: ['forecast', 'oneday'],
    queryFn: () => get<ForecastOneDay>('/forecast/oneday'),
    // 503 while the first walk-forward runs (~1 min): poll faster until it is ready
    refetchInterval: (q) => (q.state.error ? 15_000 : 60_000),
    retry: 1,
    staleTime: 30_000,
    enabled,
  })
