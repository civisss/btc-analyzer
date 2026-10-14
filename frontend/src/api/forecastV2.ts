// Forecast v2 — tipi (vedi CONTRACT.md § FORECAST) + hook react-query.
// The v2 payload extends the legacy `Forecast` (still used by the dashboard card); `path` always spans 0–365 days,
// so the page fetches horizon=365 once and the horizon selector only crops the chart.
import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Forecast, T } from './types'

type N = number | null
export type ForecastMemberKey = 'cycle' | 'lgb' | 'mc' | 'rw0'
export type HorizonKey = '7' | '30' | '60' | '90' | '180' | '365'

export interface ForecastMember {
  key: ForecastMemberKey; name: string; note: string
  weight: number; median_30d: number | null
  weights: Partial<Record<HorizonKey, number>>
  medians: Record<string, number>
  live: Partial<Record<'7' | '30', { pinball: number; n: number }>>
}
export interface ForecastMetrics {
  n: number; hit_rate: N; brier: N; brier_skill: N; mape: N; mase: N; pinball: N
  coverage_50: N; coverage_90: N; width_50: N; width_90: N
}
export interface ForecastHorizon {
  days: number; time: T; median: number; p05: number; p25: number; p75: number; p95: number
  change_pct: number; up_prob: number
  weights: Partial<Record<ForecastMemberKey, number>>
  conformal: { c90: N; c50: N }
  backtest: { n: number; hit_rate: N; mape: N; mase: N; coverage_50: N; coverage_90: N; brier_skill: N }
}
export interface PastCycle {
  key: string; anchor: 'top' | 'bottom' | 'halving'; anchor_label: string; label: string
  anchor_time: T; anchor_price: number; aligned_time: T
  time_scale: number; amplitude_scale: number; weight: number; similarity: number
  return_180: N; return_365: N
  path: { day: number; time: T; value: number }[]
}
export interface CycleModel {
  position: {
    text: string; phase: 'post_bottom' | 'bear' | 'bull'; phase_label: string
    days_since_top: N; days_since_bottom: N; days_since_halving: N
    next_halving_est: T; probable_bottom: boolean; provisional_top: boolean
  }
  events: { kind: 'top' | 'bottom' | 'halving'; time: T; price: number; probable: boolean }[]
  anchors: { key: 'top' | 'bottom' | 'halving'; label: string; event_time: T; days: number; weight: number }[]
  time_scale: {
    segment: string; current_days: number
    past: { from: T; to: T; days: number; ratio: number }[]
    gammas: { gamma: number; weight: number }[]
  } | null
  cycles: PastCycle[]
  horizons: { days: number; median: number; p05: number; p25: number; p75: number; p95: number; up_prob: number }[]
  method: string
}
export type EvalModelKey = 'ensemble' | ForecastMemberKey | 'rw_drift' | 'previous'
export interface EvalHorizon {
  horizon: number; summary: string; skill_vs_naive: boolean
  models: { key: EvalModelKey; name: string; kind: 'ensemble' | 'member' | 'baseline'; test: ForecastMetrics; last12: ForecastMetrics }[]
  by_regime: { regime: 'bull' | 'bear' | 'accumulation'; label: string; ensemble: ForecastMetrics; rw0: ForecastMetrics; cycle: ForecastMetrics }[]
}
export interface CalBucket { bin: number; from: number; to: number; n: number; predicted: N; observed: N }
export interface Driver { key: string; name: string; group: string; value: N; contribution: number }
export interface ForecastV2 extends Omit<Forecast, 'models'> {
  version: number
  models: ForecastMember[]
  path: { day: number; time: T; p05: number; p25: number; p50: number; p75: number; p95: number }[]
  horizons: ForecastHorizon[]
  cycle_model: CycleModel
  evaluation: {
    note: string; test_from: T
    horizons: EvalHorizon[]
    cycle_by_cycle: { horizon: number; from: T; to: T; label: string; cycle: ForecastMetrics; ensemble: ForecastMetrics; rw0: ForecastMetrics; rw_drift: ForecastMetrics }[]
  }
  calibration: { method: string; horizons: { horizon: number; ece: N; brier: N; brier_clim: N; brier_skill: N; buckets: CalBucket[] }[] }
  drivers: Partial<Record<'7' | '30' | '60' | '90', {
    horizon: number; lgb_weight: number; baseline: number; lgb_median: number
    top: Driver[]; groups: { group: string; contribution: number }[]
  }>>
  regime: {
    key: 'bull' | 'bear' | 'accumulation'; label: string; text: string; cycle_phase: string; cycle_phase_label: string
    indicators: { mayer: N; ma200_slope: N; dd_ath: N; days_low: N }
  }
  training: {
    status: 'ready' | 'training' | 'error'; progress: string | null; error: string | null; trained_at: T
    data_day: string; seconds: Record<string, number>
    features: { n_features: number; available_now: number; first_valid: Record<string, T | null> }
  }
}

/** v2 forecast at 365 days (the page crops the view client-side). Re-fetched every minute (bands re-anchored to the live price). */
export const useForecastV2 = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: ['forecast', 365],
    queryFn: async () => (await api.forecast(365)) as ForecastV2,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
