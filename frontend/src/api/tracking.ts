// Track record / affidabilità — tipi (vedi CONTRACT.md § TRACKING) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

type N = number | null
export type TrackMode = 'all' | 'live' | 'backtest'
export type TrackSource = 'forecast_7d' | 'forecast_30d' | 'fractals_4h' | 'fractals_1d' | 'analogs_4h' | 'analogs_1d'
  | 'timepivots' | 'cycle_phase' | 'flows' | 'analyst'

export interface ReliabilityBucket { bin: number; from: number; to: number; n: number; predicted: N; observed: N }   // % (0..100)
export interface WindowPerf { n: number; hit_rate: N }

export interface TrackMetrics {
  n_total: number; n_resolved: number; n_pending: number; n_dir: number
  hit_rate: N            // % direzioni corrette (neutrali escluse)
  brier: N               // 0 = perfetto, 0.25 = moneta
  brier_ref: N           // p̄(1−p̄) della frequenza di rialzo osservata nel campione
  brier_skill: N         // % di miglioramento vs brier_ref (negativo = peggio della frequenza di base)
  avg_up_prob: N; up_rate_actual: N
  mae_pct: N             // errore % medio della mediana
  coverage: N; band_nominal: N   // % esiti dentro la banda; nominale 90 (forecast) / 80 (frattali)
  ece: N                 // errore di calibrazione atteso (punti %)
  last30: WindowPerf; last90: WindowPerf
}

export interface SourceStat extends TrackMetrics {
  source: TrackSource; agent: string; agent_label: string; label: string; horizon: string
  mode: 'live' | 'backtest'; first: T | null; last: T | null; note: string
}

export interface Prediction {
  id: string; source: TrackSource; label: string; agent: string; mode: 'live' | 'backtest'
  made_at: T; due_at: T; price0: N; direction: 'up' | 'down' | 'neutral'
  up_prob: N; median: N; low: N; high: N; actual: N; change: N   // change = % realizzata
  hit: boolean | null; err_pct: N; in_band: boolean | null; resolved: boolean
  context: string | null
}

export interface Tracking {
  generated_at: T; mode: TrackMode
  overall: TrackMetrics   // sulle righe del `mode` richiesto
  split: Record<'live' | 'backtest', { n_total: number; n_resolved: number; n_pending: number; hit_rate: N }>
  sources: SourceStat[]
  reliability: { overall: ReliabilityBucket[]; by_source: Record<string, ReliabilityBucket[]> }   // key "source|mode"
  recent: Prediction[]    // risolte, live prima poi backtest (max 40)
  pending: Prediction[]   // live in attesa, prossime a scadere prima (max 20)
  weights: Record<string, number>   // agent_id -> 0..1 (0.5 neutro)
  backfill: { status: 'idle' | 'running' | 'done' | 'error'; done: string[]; started_at: T | null; finished_at: T | null; error: string | null; progress: string | null }
  method: string
}

export async function fetchTracking(mode: TrackMode = 'all'): Promise<Tracking> {
  const res = await fetch(`/api/tracking?mode=${mode}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<Tracking>
}

export const useTracking = (mode: TrackMode = 'all') =>
  useQuery({ queryKey: ['tracking', mode], queryFn: () => fetchTracking(mode), refetchInterval: 5 * 60_000, staleTime: 60_000, retry: 1, placeholderData: keepPreviousData })
