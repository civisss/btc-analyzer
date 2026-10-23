// Kronos — tipi (CONTRACT.md § KRONOS) + hook react-query.
// Query key root 'kronos' (realtime.ts: '/forecast/kronos'): l'agente "kronos" invalida via WS dopo ogni ricalcolo.
import { useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Candle, T } from './types'

type N = number | null
export type KronosTf = '1h' | '4h' | '1d'
export type KVerdictCode = 'edge' | 'small_edge' | 'no_edge' | 'worse' | 'worse_ns' | 'baseline' | 'n_a'
export interface KVerdict { code: KVerdictCode; mase?: N; dm_p?: N; direction_significant?: boolean; direction_beats_always_up?: boolean }
export type RegimeCode = 'trend_up' | 'trend_down' | 'choppy'
export interface KRegime {
  code: RegimeCode; up_share: number; agree: number; snr: number; median_ret_pct: number; sd_ret_pct: number
  er?: number; agree_min?: number; snr_min?: number
}
export interface KWorker { busy: boolean; job: { tf: string; h: number; samples: number } | null; started_at: T | null; queue: number }
export interface KronosForecast {
  tf: KronosTf; h: number; samples: number
  params: { T: number; top_p: number; top_k: number; lookback: number; model: string; clip: number }
  candles: Candle[]
  live_price: N
  ready: boolean
  state?: 'loading' | 'computing' | 'error' | 'torch_missing'; error?: string; eta_s?: N
  stale?: boolean
  origin?: T; origin_close?: T; ref_price?: number; lookback?: number
  steps?: T[]
  median?: number[]; p05?: number[]; p25?: number[]; p75?: number[]; p95?: number[]; mean?: number[]
  paths?: number[][]
  end?: { median: number; mean: number; p05: number; p25: number; p75: number; p95: number; change_pct: number; mean_change_pct: number
          up_prob: number; width50_pct: number; width90_pct: number }
  regime?: KRegime; computed_at?: T; seconds?: number; device?: 'cpu' | 'cuda'
  worker?: KWorker
}
export interface KMetrics {
  n: number; mae?: number; mape?: number; mase?: N; bias_pct?: number; corr_ret?: N
  n_dir?: number; hit_rate?: number; always_up?: number; share_up_calls?: number; n_dir_indep?: number; hit_rate_indep?: N
  p_dir?: N; p_dir_vs_up?: N; dm_stat?: N; dm_p?: N
  coverage_50?: number; coverage_90?: number; width_50?: number; width_90?: number; brier?: number; brier_half?: number; brier_skill?: N
  crps?: number; crps_ref?: number; crps_skill?: N
  kronos_mase_same?: N; dm_vs_kronos?: N; dm_p_vs_kronos?: N
  verdict?: KVerdict
  pending?: number
}
export type KRowKey = 'kronos' | 'kronos_median' | 'naive' | 'drift' | 'rw_vol' | 'oneday'
export type KPeriod = 'pre' | 'post'
export type RegimeVerdict = 'useful' | 'magnitude_only' | 'direction_only' | 'not_useful' | 'too_few'
export interface KRegimeEval {
  n: number; n_trend?: number; n_choppy?: number; share_trend?: number
  trend?: { abs_ret_pct: N; er: N }; choppy?: { abs_ret_pct: N; er: N }
  p_absret?: number; p_er?: number; hit_trend?: number; n_trend_indep?: number; p_hit_trend?: N; hit_trend_all?: number
  spearman_disp_absret?: N; p_spearman?: N
  verdict?: RegimeVerdict
}
export interface KTimings { tf: string; h: number; samples: number; lookback?: number; cpu?: { seconds: number; threads: number; name?: string }; cuda?: { seconds: number; name: string } }
export interface KHeadline {
  day: KVerdict; end: KVerdict; day_mase: N; end_mase: N; day_hit: N; day_always_up: N; cov90_day: N; crps_skill_day: N; regime?: RegimeVerdict
}
export interface KronosBacktest {
  available: boolean
  meta?: {
    version: number; created_at: T; samples: number; H: number; lookback: number; T: number; top_p: number; pretrain_end: T
    pre_every_days: number; post_every_days: number; device: string; gpu: string | null; torch: string; models: string[]
    seconds: Record<string, number>; origins: Record<string, { pre?: number; post?: number }>; complete: boolean; timings?: KTimings
  }
  evaluation?: Record<string, Partial<Record<KronosTf, Partial<Record<KPeriod, Record<string, { from: T; to: T; rows: Partial<Record<KRowKey, KMetrics>> }>>>>>>
  curves?: Record<string, Partial<Record<KronosTf, Partial<Record<KPeriod, { step: number; mase: N; coverage_50?: number; coverage_90?: number; hit_rate?: number; dm_p?: N }[]>>>>>
  regime?: Record<string, Partial<Record<KronosTf, Partial<Record<KPeriod, KRegimeEval>>>>>
  series?: Record<string, Partial<Record<KronosTf, { t: T[]; ref: number[]; actual: number[]; mean: number[]; p05: number[]; p95: number[] }>>>
  headline?: Record<string, Partial<Record<KronosTf, KHeadline>>>
  overall?: 'edge' | 'mixed' | 'no_edge' | 'worse'
  key_steps?: Record<KronosTf, number[]>; day_step?: Record<KronosTf, number>; pretrain_end?: T
  settings?: { agree_min: number; snr_min: number; dir_eps_pct: number }
}
export interface KronosTrack {
  n_forecasts: number; from: T | null
  tf: Partial<Record<KronosTf, {
    n_forecasts: number; last_origin?: T; steps?: Record<string, KMetrics>
    recent?: { origin: T; regime: RegimeCode; ref: number; end_q50: number; end_actual: N; day_q50: N; day_actual: N }[]
  }>>
}
export interface KWeights { state: 'absent' | 'downloading' | 'ready' | 'error'; bytes: number; total: N; error: string | null; path: string | null }
export interface KronosStatus {
  torch: boolean; torch_version: string | null; cuda: boolean | null; device: 'cpu' | 'cuda' | null; gpu_name: string | null
  threads: N; loaded: boolean; load_seconds: N; error: string | null; live_model: string
  models: Record<string, { repo: string; rev: string; tokenizer: string; ctx: number; params_m: number }>
  weights: Record<string, KWeights>
  weights_dir: string; worker: KWorker; recent: { tf: string; h: number; samples: number; seconds: number; device: string; at: T }[]
  live_enabled: boolean; pretrain_end: T; backtest_timings: KTimings | null; backtest_device: string | null
  sources: { repo: string; paper: string; hf: string; license: string }
  defaults: { h: number; samples: number; T: number; top_p: number; lookback: number; h_options: number[]; sample_options: number[] }
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

/** Previsione corrente: ready=false mentre il thread di lavoro calcola (poll ogni 3 s), poi ogni minuto + invalidazione WS. */
export const useKronos = (tf: KronosTf, h: number, samples: number, enabled = true) =>
  useQuery({
    queryKey: ['kronos', 'forecast', tf, h, samples],
    queryFn: () => get<KronosForecast>(`/forecast/kronos?tf=${tf}&h=${h}&samples=${samples}`),
    refetchInterval: (q) => (!q.state.data?.ready || q.state.data?.stale ? 3_000 : 60_000),
    placeholderData: (prev) => (prev && prev.tf === tf ? prev : undefined),
    retry: 1,
    staleTime: 2_000,
    enabled,
  })

export const useKronosBacktest = (enabled = true) =>
  useQuery({ queryKey: ['kronos', 'backtest'], queryFn: () => get<KronosBacktest>('/forecast/kronos/backtest'), staleTime: 10 * 60_000, enabled })

export const useKronosTrack = (enabled = true) =>
  useQuery({ queryKey: ['kronos', 'track'], queryFn: () => get<KronosTrack>('/forecast/kronos/track'), refetchInterval: 60_000, staleTime: 30_000, enabled })

export const useKronosStatus = (enabled = true) =>
  useQuery({
    queryKey: ['kronos', 'status'], queryFn: () => get<KronosStatus>('/forecast/kronos/status'),
    refetchInterval: (q) => (q.state.data?.worker?.busy || Object.values(q.state.data?.weights ?? {}).some((w) => w.state === 'downloading') ? 3_000 : 30_000),
    staleTime: 2_000, enabled,
  })
