// Onde di Elliott — tipi (vedi CONTRACT.md § ELLIOTT) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

export type EwTf = '4h' | '1d' | '1w'
export type EwDegree = 'supercycle' | 'cycle' | 'primary' | 'intermediate' | 'minor' | 'minute' | 'minuette' | 'subminuette'
export type EwPattern = 'impulse' | 'diagonal' | 'zigzag' | 'flat' | 'triangle' | 'double_zigzag' | 'double_three'
export type EwVerdict = 'none' | 'weak' | 'strong' | 'anecdotal'
/** wave keys: 1..5 · A..E · W X Y · a b c (sub-waves of W/Y) · next / next2 / thrust (wave after a completed pattern) */
export type EwWave = string
type N = number | null

export interface EwPoint { pos: number; time: T; price: number; label: EwWave | null; sub: boolean; kind: 'high' | 'low' }
export interface EwWaveRow { label: EwWave; n_sub: number; change: number; bars: number; from: T; to: T }
export interface EwLevel { key: string; ratio: N; price: number }
export interface EwProj { wave: EwWave; time: T; t_lo: T; t_hi: T; price: number; lo: number; hi: number; reached: boolean; levels: EwLevel[] }
export interface EwRule { key: string; value: number | null; limit: number | null }
export interface EwGuide { key: string; score: number; weight: number; value: number | (number | null)[] | null; ideal: number[] | null }
export interface EwProb { p: number; lo: N; hi: N; n: number; p_conf: N; ranker: 'rule' | 'ml' }
export interface EwCount {
  rank: number; id: string; pattern: EwPattern; variant: string | null; direction: 'up' | 'down'; state: 'complete' | 'progress'
  k: number; legs: number; degree: EwDegree; wave: EwWave; next_wave: EwWave; next_higher: boolean; cur_dir: 'up' | 'down'
  score: number; ml_p: N; prob: EwProb | null
  points: EwPoint[]; waves: EwWaveRow[]
  pending: { time: T; price: number; label: EwWave; change: number; bars: number }
  invalidation: { below: N; above: N; below_rule: string | null; above_rule: string | null }
  projection: EwProj[]
  channel: { time: T; price: number }[][] | null
  rules: EwRule[]; guidelines: EwGuide[]
}
export interface EwRank { rank: number; p_best: N; lo: N; hi: N; n: number; p_conf: N; n_conf: number }
export interface EwExample {
  time: T; pattern: EwPattern; variant: string | null; wave: EwWave; k: number; dir: number; target: number; lo: number; hi: number
  inv_below: N; inv_above: N; outcome: 'target' | 'invalid' | 'none' | 'reached'; inside: boolean; actual: number; actual_time: T
  hit: boolean; best: boolean; err: number; n_cand: number
}
export interface EwBacktest {
  n: number; from?: T; to?: T; ms?: number; ranker?: 'rule' | 'ml'
  model?: { hit: number; hit_ci: [number, number] | null; err_med: number; cov: number; target_first: number; invalid_first: number; best: number }
  base_alt?: { hit: number; err_med: number }
  base_random?: { hit: number; err_med: number; target_first: number; best: number; hit_q95: number }
  mase?: N; mase_random?: N; p_hit_random?: number; p_hit_alt?: N; p_err_random?: number; p_err_alt?: N; p_target_random?: number; p_best_random?: number
  candidates_med?: number; horizon_med?: number
  calibration?: { ranks: EwRank[]; none: N }
  rank_verdict?: EwVerdict; rank_halves?: number[]
  ml?: { n_oos: number; rule_best: number; ml_best: number; rule_err_med: number; ml_err_med: number; p: N; adopted: boolean; from: T } | null
  halves?: { from: T; to: T; n: number; hit: number; base_hit: number; mase: N }[]
  verdict: EwVerdict
  by_pattern?: { pattern: EwPattern; n: number; hit: number; err_med: number }[]
  examples?: EwExample[]
}
export type EwCandle = { time: T; open: number; high: number; low: number; close: number }
export interface Elliott {
  tf: EwTf; degree: EwDegree; degrees: { key: EwDegree; mult: number }[]; mult: number; generated_at: T; scale: 'log'
  last: { time: T; price: number; forming: boolean; closed_time: T }
  candles: EwCandle[]
  counts: EwCount[]; n_valid: number; higher: EwCount | null
  swings: { time: T; price: number; kind: 'high' | 'low' }[]
  weights: Record<string, number>; ranker: 'rule' | 'ml'
  backtest: EwBacktest
}
export interface ElliottBacktestAll { generated_at: T; items: ({ tf: EwTf; degree: EwDegree; mult: number } & EwBacktest)[] }
export interface ElliottAt { tf: EwTf; degree: EwDegree; t: T; candles: EwCandle[]; after: EwCandle[]; counts: EwCount[]; n_valid: number; higher: EwCount | null; ranker: 'rule' | 'ml' }

async function get<R>(url: string): Promise<R> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

export const useElliott = (tf: EwTf, degree: EwDegree | null) =>
  useQuery({
    queryKey: ['elliott', tf, degree],
    queryFn: () => get<Elliott>(`/api/elliott?tf=${tf}${degree ? `&degree=${degree}` : ''}`),
    refetchInterval: tf === '4h' ? 60_000 : 180_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })

export const useElliottBacktest = (mode: 'default' | 'all', enabled = true) =>
  useQuery({
    queryKey: ['elliott', 'backtest', mode],
    queryFn: () => get<ElliottBacktestAll>(`/api/elliott/backtest?mode=${mode}`),
    staleTime: 300_000,
    retry: 1,
    enabled,
    placeholderData: keepPreviousData,
  })

export const useElliottAt = (tf: EwTf, degree: EwDegree, t: T | null) =>
  useQuery({
    queryKey: ['elliott', 'at', tf, degree, t],
    queryFn: () => get<ElliottAt>(`/api/elliott/at?tf=${tf}&degree=${degree}&t=${t}`),
    enabled: t != null,
    staleTime: 600_000,
    retry: 1,
  })
