// Struttura e livelli — tipi (vedi CONTRACT.md § STRUCTURE) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Candle, T } from './types'

type N = number | null
export type Tone = 'bullish' | 'bearish' | 'neutral'

// ---------------------------------------------------------------- comuni
export interface DistStats { n: number; median: N; mean: N; p25: N; p75: N; p90: N }          // percent
export interface FwdStats { n: number; median: N; mean: N; win_rate: N }                      // percent

// ---------------------------------------------------------------- A) pivot di apertura
export interface MondaySide {
  weeks: number; broken: number; broken_pct: N; first_pct: N
  back_inside_pct: N            // % of breaks followed by a 1h close back inside the Monday range
  rev2_pct: N; rev3_pct: N      // % of breaks with return inside AND a move ≥2% / ≥3% beyond the broken level in the opposite direction
  reversal: DistStats           // move from the broken level in the opposite direction (percent)
  reach_opposite_pct: N; close_beyond_pct: N
  extension: DistStats          // max extension beyond the broken level (percent)
  inverse: DistStats            // max peak-to-trough after the break (percent)
  hours_to_break_median: N
}
export interface MondayCurrent {
  week_start: T; monday_complete: boolean; high: number; low: number; mid: number; open: number
  range_pct: N; range_rank: N   // percentile of the Monday range width vs history
  price: number; position: 'sopra' | 'sotto' | 'dentro'; dist_high: N; dist_low: N
  broke_high: boolean; broke_low: boolean; first_break: 'high' | 'low' | null; ext_high: N; ext_low: N
  regime: 'ranging' | 'trending' | null; adx: N; text: string
}
export interface MondayWeek {
  week_start: T; high: number; low: number; range_pct: N; broke_high: boolean; broke_low: boolean
  first_break: 'high' | 'low' | null; ext_high: N; ext_low: N; reversal: N; back_inside: boolean | null
  week_return: N; regime: 'ranging' | 'trending' | null
}
export interface MondayRange {
  current: MondayCurrent | null
  previous: { week_start: T; high: number; low: number; close: number; broke_high: boolean; broke_low: boolean; first_break: 'high' | 'low' | null; text: string } | null
  stats: {
    weeks: number; since: T | null; high: MondaySide; low: MondaySide; both_pct: N; none_pct: N; range_pct: DistStats
    by_regime: { key: 'ranging' | 'trending'; label: string; weeks: number; high: MondaySide; low: MondaySide }[]
    by_year: { year: number; weeks: number; high_broken_pct: N; high_rev2_pct: N; high_rev3_pct: N; low_broken_pct: N; low_rev2_pct: N; low_rev3_pct: N }[]
  }
  history: MondayWeek[]          // last 26 completed weeks, newest first
}
export interface Magnet { threshold: number; periods: number; n: number; reached_pct: N; revisit_pct: N; median_hours: N }
export interface Excursion { max_exc: N; revisited: boolean | null; side: 'sopra' | 'sotto' }
export interface OpenBlock { open: N; excursion: Excursion | null; magnet: Magnet[]; since: string; text?: string }
export interface OpenLevel { key: string; label: string; price: number; distance: N; group: 'open' | 'prev'; side: 'sopra' | 'sotto'; note: string | null }
export interface FirstWeek {
  current: { days: number; fw_return: N; fw_high?: number; fw_low?: number; mtd?: N } | null
  stats: {
    months: number; same_direction_pct: N; high_in_first_week_pct: N; low_in_first_week_pct: N; extreme_in_first_week_pct: N
    after_up: FwdStats & { month_up_pct: N }; after_down: FwdStats & { month_up_pct: N }; first_week: FwdStats
  }
  text: string; since: string
}
export interface Opens {
  week_start: T; month_start: T; quarter_start: T; year_start: T
  weekly: OpenBlock; monthly: OpenBlock; quarterly: OpenBlock; yearly: OpenBlock
  prev_week: { high: N; low: N; close: N }; prev_month: { high: N; low: N; close: N }
  levels: OpenLevel[]
  first_week: FirstWeek
}
export interface WeeklyEvent { key: string; label: string; description: string; n: number; freq_pct: N; w1: FwdStats; w2: FwdStats; w4: FwdStats; last: T | null }
export interface WeeklyClose {
  events: WeeklyEvent[]
  current: { week_start: T; open: number; high: number; low: number; price: number; prev_high: number; prev_low: number
             range4_high: number; range4_low: number; provisional_events: string[]; text: string
             levels: { label: string; price: number; distance: N }[] } | null
  last_closed: { week_start: T; open: number; high: number; low: number; close: number; prev_high: number; prev_low: number; events: string[] } | null
  weeks: number; since: T | null
}
export interface StructurePivots {
  generated_at: T; price: number
  monday: MondayRange; opens: Opens; weekly_close: WeeklyClose
  chart: { candles: Candle[]; prev_monday: { week_start: T; high: number; low: number } | null }   // 1h, previous + current week
  method: string
}

// ---------------------------------------------------------------- B) range e struttura
export type RangeStateKey =
  | 'inside' | 'inside_after_sweep_low' | 'inside_after_sweep_high' | 'inside_after_failed_breakout'
  | 'above_unconfirmed' | 'accepted_above' | 'retest_held_above'
  | 'below_unconfirmed' | 'accepted_below' | 'retest_held_below'
export type StructEventKey =
  | 'dev_high' | 'dev_low' | 'failed_break_high' | 'reclaim_low' | 'accept_high' | 'accept_low'
  | 'retest_hold_high' | 'retest_fail_high' | 'retest_hold_low' | 'retest_fail_low' | 'close_above' | 'close_below'
  | 'sfp_high' | 'sfp_low' | 'bos_up' | 'bos_down' | 'choch_up' | 'choch_down'
export interface StructSwing { time: T; price: number; kind: 'high' | 'low'; label: 'HH' | 'HL' | 'LH' | 'LL' | null; confirmed: boolean }
export interface MarketStructure {
  trend: Tone; trend_label: string; swings: StructSwing[]
  last_high_label: string | null; last_low_label: string | null
  last_high: N; last_low: N; last_high_time: T | null; last_low_time: T | null
  last_event: { key: StructEventKey; label: string; time: T; level: N } | null
}
export interface RangeBox {
  high: number; low: number; mid: number; start: T; end: T; bars: number; days: N
  touches_high: number; touches_low: number; width_pct: N; width_atr: N
  position: N                    // 0 = range low, 100 = range high (can be <0 / >100 outside)
  containment: N                 // % of closes inside the range
  touch_points: { time: T; price: number; kind: 'high' | 'low' }[]
}
export interface MacroRange { high: number; low: number; mid: number; start: T; bars: number; touches_high: number; touches_low: number; width_pct: N }
export interface StructEvent { n: number; key: StructEventKey; label: string; time: T; price: number; kind: 'range' | 'sfp' | 'structure' }
export interface TfStructure {
  tf: '4h' | '1d' | '1w'; price: number
  structure: MarketStructure
  range: RangeBox | null; macro_range: MacroRange | null
  events: StructEvent[]          // numbered chronologically (markers "1", "2", …)
  state: RangeStateKey | null; state_label: string; text: string
  key_levels: { label: string; price: number; kind: string; distance: N }[]
  atr?: N
}
export interface EventStat {
  key: StructEventKey; label: string; description: string; direction: 'up' | 'down'
  n: number; fwd: Record<'d1' | 'd3' | 'd7' | 'd14', FwdStats>
  follow_pct: N                  // % of 7-day returns in the expected direction
  target1: string; target2: string; invalidation: string
  p_target1: N; p_target2: N; p_invalid: N   // within 14 days, invalidation checked first
  n_outcome: number; last: T | null
}
export interface EventStats { tf: '1d' | '4h'; since: T; bars: number; events: EventStat[]; base: Record<'d1' | 'd3' | 'd7' | 'd14', FwdStats> }
export interface StructureRanges {
  generated_at: T; price: number
  timeframes: Record<'4h' | '1d' | '1w', TfStructure>
  stats: Record<'1d' | '4h', EventStats>
  summary: string; method: string
}

// ---------------------------------------------------------------- C) scenari
export interface ScenarioTarget { price: number; label: string; reasons: string[]; distance: N; confluence: number }
export interface TimingItem { time: T; start: T; end: T; label: string; title: string; expected: string; confluence: N; days_away: number }
export interface Scenario {
  id: string; n: number; title: string; tone: Tone
  trigger: { text: string; level: N; condition: 'close_above' | 'close_below' | 'inside'; tf: string }
  targets: ScenarioTarget[]
  invalidation: { price: N; text: string }
  probability: { value: N; target2: N; invalid: N; n: N; tf: string; basis: string; text: string } | null
  timing: TimingItem[]
  supports: string[]; against: string[]
  narrative: string
  path: { time: T; price: number; label: string }[]   // indicative path sketch (first point = now)
}
export interface StructureScenarios {
  generated_at: T; price: number; atr_d: number
  state: RangeStateKey | null; state_label: string
  range: { high: number; low: number; mid: number; start: T } | null
  scenarios: Scenario[]
  summary: string
  levels: { price: number; label: string; reasons: string[]; distance: N; weight: number; sources: string[] }[]
  disclaimer: string
  timing: TimingItem[]
  analogs: { bias: string | null; median_outcome: N; up: N; down: N; count: N; text: string; horizon: N
             best: { label: string; similarity: N; change: N; max_up: N; max_down: N } | null } | null
  sources: { liquidity: boolean; analogs: boolean; timepivots: boolean; levels: boolean }
  method: string
}

// ---------------------------------------------------------------- fetch + hooks
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

const opts = { retry: 1, placeholderData: keepPreviousData, staleTime: 30_000 } as const
export const useStructurePivots = () =>
  useQuery({ queryKey: ['structure', 'pivots'], queryFn: () => get<StructurePivots>('/structure/pivots'), refetchInterval: 60_000, ...opts })
export const useStructureRanges = () =>
  useQuery({ queryKey: ['structure', 'ranges'], queryFn: () => get<StructureRanges>('/structure/ranges'), refetchInterval: 60_000, ...opts })
export const useStructureScenarios = () =>
  useQuery({ queryKey: ['structure', 'scenarios'], queryFn: () => get<StructureScenarios>('/structure/scenarios'), refetchInterval: 90_000, ...opts })
