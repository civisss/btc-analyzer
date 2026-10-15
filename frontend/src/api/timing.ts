// Timing (Gann · Wyckoff · ritmi) — tipi (vedi CONTRACT.md § TIMING) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Candle, T } from './types'

type N = number | null
export type Verdict = 'none' | 'weak' | 'strong' | 'anecdotal'

// ------------------------------------------------------------------ Gann
export type GannTypeId = 'c30' | 'c45' | 'c60' | 'c90' | 'c120' | 'c144' | 'c180' | 'c270' | 'c360' | 'c_mult' | 'sq9' | 'yeardiv' | 'anniv' | 'seasonal'
export interface GannTypeRow {
  id: GannTypeId; group?: 'giorni' | 'quadrato' | 'anno'; days?: number[]
  n: number; hits?: number
  hit_rate?: N; base_rate?: N; lift?: N            // % date proiettate con un pivot entro ±W · media placebo a traslazione · rapporto
  null_q05?: N; null_q95?: N                       // banda 90% del placebo (%)
  ctrl_rate?: N                                    // hit rate con conteggi vicini non di Gann (stesse ancore)
  p_shift?: N; p_counts?: N; p_bh?: N; p_bh_all?: N   // p placebo traslazione · p placebo conteggi · BH tra i tipi · BH su tutte le definizioni
  halves?: { n: number; rate: N; base: N; lift: N }[]
  stable?: boolean; verdict: Verdict
}
export interface ScoreBin { min: number; max: number | null; n: number; hit_rate?: N; base_rate?: N; lift?: N; null_q95?: N; p?: N; p_bh?: N; verdict?: Verdict | null }
export interface GannSource { type: GannTypeId; days: number | null; exact: T; anchor: T | null; anchor_kind: 'high' | 'low' | null; anchor_price: N; verdict: Verdict | null; lift: N }
export interface GannDate {
  time: T; start: T; end: T; days_away: number; score: number; types: GannTypeId[]; sources: GannSource[]
  hist_hit_rate: N; hist_base_rate: N; hist_lift: N; hist_n: number | null; hist_verdict: Verdict | null
}
export interface GannResponse {
  generated_at: T; today: T; price: number; horizon: number
  params: { pivot_n: number; win: number; anchor_mult: number; min_shift: number; n_ctrl: number; cluster_tol: number; min_n: number; alpha: number; defs: [number, number][]; tests_all: number }
  sample: { start: T; end: T; days: number; anchors: number; targets: number; base_rate: N }
  types: GannTypeRow[]
  score_bins: ScoreBin[]
  upcoming: GannDate[]
  score_future: { time: T; score: number; types: GannTypeId[] }[]   // punteggio di ogni giorno da oggi a oggi + horizon
  anchors: { time: T; confirmed: T; kind: 'high' | 'low'; price: number }[]
  targets_recent: { time: T; kind: 'high' | 'low'; price: number }[]
  open_extreme: { time: T; kind: 'high' | 'low'; price: number } | null
  recent: { time: T; type: GannTypeId; hit: boolean; score: number | null }[]
  sq9: { anchor: { price: number; kind: 'high' | 'low' }; levels: { deg: number; turns: number; price: number; dist: number }[]; step_usd: number } | null
  fan: { anchor: { time: T; price: number; kind: 'high' | 'low' }; prev: { time: T; price: number; kind: 'high' | 'low' }; leg_days: number; slope_1x1: number
         days_since: number; direction: 'up' | 'down'; lines: { key: '1x2' | '1x1' | '2x1'; factor: number; slope: number; price: N; dist: N }[] } | null
  counts: Record<GannTypeId, number[]>
  seasonal_dates: [number, number][]
  candles: Candle[]
}

// ------------------------------------------------------------------ Wyckoff
export type WyKey = 'PS' | 'SC' | 'AR_A' | 'ST_A' | 'SPRING' | 'TEST' | 'SOS' | 'LPS' | 'BRK_DN' | 'PSY' | 'BC' | 'AR_D' | 'ST_D' | 'UT' | 'UTAD' | 'SOW' | 'LPSY' | 'BRK_UP'
export type WyPhase = 'A' | 'B' | 'C' | 'D' | 'E'
export interface WyEvent { key: WyKey; time: T; confirmed: T; price: number; rv: N; phase: WyPhase; bu?: boolean; pen?: N; low_vol?: boolean }
export interface WyRange {
  side: 'acc' | 'dist'; status: 'active' | 'up' | 'down' | 'failed' | 'expired'; phase: WyPhase
  high: number; low: number; start: T; confirmed: T; end: T | null; bars: number; width_pct: N; after_20: N   // after_20 = % 20 candele dopo la fine
  events: WyEvent[]
}
export interface WyHorizon {
  days: number; n: number; base_mean: N; base_up: N
  mean?: N; median?: N; excess?: N; ci?: [N, N]; hit?: N; base_hit?: N; p?: N; p_bh?: N; stable?: boolean; agrees?: boolean
  halves?: { n: number; excess: N }[]; verdict: Verdict
}
export interface WyBacktestRow { key: WyKey; side: 'acc' | 'dist'; direction: 'up' | 'down'; n: number; horizons: WyHorizon[] }
export interface WyckoffResponse {
  tf: '1d' | '4h'; bars: number; since: T; last_closed: T; generated_at: T; price: number
  active: WyRange | null; last_range: WyRange | null; ranges: WyRange[]; timeline: WyRange[]
  outcomes: Record<string, number>
  backtest: { rows: WyBacktestRow[]; base: Record<string, { mean: N; up: N }>; segments: { since: T; until: T; bars: number }[]; bars: number; tests: number; split: T }
  chart_from: T
  params: { lb: number; trend: number; trend_pct: number; ps_lb: number; ar_max: number; max_bars: number; min_age: number; min_w: number; bpd: number; vol_n: number
            horizons: number[]; n_perm: number; n_boot: number; min_n: number; alpha: number }
  candles: Candle[]
}

// ------------------------------------------------------------------ Ritmi
export type RhythmKind = 'thirds' | 'weekday' | 'monthweek' | 'monthday' | 'hour'
export type RhythmDef = 'close' | 'extremes'
export interface ThirdsFam { pattern: string; n: number; k: number; rate: N; null: N; lift: N; p: N; p_bh?: N }
export interface ThirdsSeg { ret: N; high: N; low: N; close: N }
export interface ThirdsResponse {
  kind: 'thirds'; pattern: string; def: RhythmDef; theta: number; cuts: [number, number]
  full: ThirdsFam & { naive: N; coin: N }
  recent: { from: T; n: number; k: number; rate: N; p: N; months: { month: T; match: boolean }[] }
  family: ThirdsFam[]; combos: number; p_sidak: N; verdict: Verdict; stable: boolean
  by_year: { year: number; n: number; k: number; rate: N }[]
  seg_means: { seg: number; n: number; mean: N; median: N; up: N; others_mean: N; p: N }[]
  months: { month: T; open: N; segs: (ThirdsSeg | null)[]; match: boolean | null; partial: (boolean | null)[] | null }[]
  null_windows: number
  generated_at: T; start: T; start_key: '2017' | '2013'; thetas: number[]; patterns: string[]
}
export interface BucketRow {
  bucket: number; n: number; mean: N; median: N; up: N; diff: N; t: N; p: N; p_bh: N; stable: boolean; share_same_sign: N; verdict: Verdict
  recent: { n: number; mean: N; up: N; diff: N; p: N; p_bh: N }
  years: { year: number; diff: N; n: number }[]
}
export interface BucketResponse {
  kind: Exclude<RhythmKind, 'thirds'>; labels: number[]; rows: BucketRow[]
  family: { max_t: N; p: N; n_perm: number; tests: number }
  heat: { year: number; values: N[] }[]; n: number; since: T | null; recent: { from: T; n: number }
  generated_at: T; start: T; start_key: '2017' | '2013'; combos: number
}
export type RhythmResponse = ThirdsResponse | BucketResponse

// ------------------------------------------------------------------ Panoramica + scenari
export interface LevelGroup { price: number; low: number; high: number; sources: string[]; dist: number }
export interface WyStat { key: WyKey; days: number; n: number | null; mean: N; excess: N; hit: N; base_hit: N; p: N; p_bh: N; verdict: Verdict | null; direction: 'up' | 'down'; agrees: boolean | null }
export interface WySummary {
  tf: '1d' | '4h'
  active: (Pick<WyRange, 'side' | 'phase' | 'high' | 'low' | 'start' | 'confirmed' | 'bars' | 'width_pct'> & { last_event: WyEvent | null }) | null
  last_key_event: WyEvent | null; stat: WyStat | null
  last_closed: Pick<WyRange, 'side' | 'status' | 'phase' | 'high' | 'low' | 'start' | 'end'> | null
  key_stats: WyStat[]
}
export interface TimingOverview {
  generated_at: T; today: T; price: number
  gann: { next: GannDate | null; upcoming: GannDate[]; verdicts: Partial<Record<Verdict, number>>; score_bins: ScoreBin[]; best_bin: ScoreBin | null
          params: GannResponse['params']; sample: GannResponse['sample']
          types: Pick<GannTypeRow, 'id' | 'n' | 'hit_rate' | 'base_rate' | 'lift' | 'p_shift' | 'p_bh' | 'p_bh_all' | 'verdict'>[] }
  wyckoff: Record<'1d' | '4h', WySummary>
  rhythm: {
    close: Pick<ThirdsResponse, 'full' | 'recent' | 'verdict' | 'p_sidak' | 'combos'> & { current: ThirdsResponse['months'][number] }
    extremes: Pick<ThirdsResponse, 'full' | 'recent' | 'verdict' | 'p_sidak' | 'theta'> & { current: ThirdsResponse['months'][number] }
  }
  levels: LevelGroup[]
  scenarios: { pivot: LevelGroup; hold: { level: LevelGroup; next: LevelGroup[]; invalid: LevelGroup }; lose: { level: LevelGroup; next: LevelGroup[]; invalid: LevelGroup }
               resistance: LevelGroup | null } | null
}

// ------------------------------------------------------------------ fetch + hooks
async function getJson<R>(url: string): Promise<R> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

const common = { retry: 1, placeholderData: keepPreviousData } as const

export const useTiming = () =>
  useQuery({ queryKey: ['timing', 'overview'], queryFn: () => getJson<TimingOverview>('/api/timing'), refetchInterval: 60_000, staleTime: 30_000, ...common })

export const useTimingGann = (p: { horizon: number; pivot: number; win: number }) =>
  useQuery({ queryKey: ['timing', 'gann', p], queryFn: () => getJson<GannResponse>(`/api/timing/gann?horizon=${p.horizon}&pivot=${p.pivot}&win=${p.win}`),
    refetchInterval: 5 * 60_000, staleTime: 60_000, ...common })

export const useTimingWyckoff = (tf: '1d' | '4h') =>
  useQuery({ queryKey: ['timing', 'wyckoff', tf], queryFn: () => getJson<WyckoffResponse>(`/api/timing/wyckoff?tf=${tf}`),
    refetchInterval: 60_000, staleTime: 30_000, ...common })

export interface RhythmParams { kind: RhythmKind; how: RhythmDef; pattern: string; theta: number; start: '2017' | '2013'; recent: string }
export const useTimingRhythms = (p: RhythmParams) =>
  useQuery({
    queryKey: ['timing', 'rhythms', p],
    queryFn: () => getJson<RhythmResponse>(`/api/timing/rhythms?kind=${p.kind}&how=${p.how}&pattern=${encodeURIComponent(p.pattern)}&theta=${p.theta}&start=${p.start}&recent=${p.recent}`),
    refetchInterval: 10 * 60_000, staleTime: 60_000, ...common,
  })
