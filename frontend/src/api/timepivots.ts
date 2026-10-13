// Pivot temporali — tipi (vedi CONTRACT.md § TIME PIVOTS) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

export type Expected = 'rialzo' | 'ribasso' | 'inversione_rialzista' | 'inversione_ribassista' | 'inversione' | 'volatilita'
export type SourceType = 'stagionale' | 'ciclo' | 'fibonacci' | 'gambe' | 'spaziatura' | 'evento'
export type N = number | null

export interface Stats {
  avg: N; median: N; win_rate: N; n: number; std: N
  best?: { year: number; value: number } | null
  worst?: { year: number; value: number } | null
}

export interface WindowYear {
  year: number; pre: N; post: N; type: string; match: boolean
  pivot: { kind: 'minimo' | 'massimo'; level: 'minore' | 'medio' | 'forte'; time: T } | null
}
export interface AvgPath { days: number[]; mean: N[]; median: N[]; p25: N[]; p75: N[]; n: number }
export interface PivotWindow {
  id: string; month: number; day: number; label: string; N: number; K: number
  pattern: 'rev_up' | 'rev_down' | 'up' | 'down' | 'cont_up' | 'cont_down'
  expected: Expected; pattern_label: string
  hits: number; n: number; consistency: N; base_rate: N; wilson_lb: N; p_value: N
  confidence: 'alta' | 'media' | 'bassa'; score: N
  avg_pre: N; avg_post: N; median_post: N; avg_post_hits: N; avg_abs_post: N; threshold: N
  pivots: { low: number; high: number; major: number; rate: N }
  recent_consistency: N; older_consistency: N
  text: string; pivot_text: string | null
  years: WindowYear[]; path: AvgPath | null
  date?: T; start?: T; end?: T
}

export interface CalendarSource {
  type: SourceType; label: string; title: string; text: string; expected: Expected; strength: N; probability: N; ref?: string | null
}
export interface CalendarItem {
  id: string; time: T; start: T; end: T; label: string; title: string
  confluence: N; expected: Expected; probability: N
  sources: CalendarSource[]; source_types: SourceType[]; summary: string; days_away: number
}

export interface CycleItem {
  key: string; label: string; kind: 'top' | 'bottom'; anchor: string; anchor_time: T | null
  history: { n: number; days: number; time?: T }[]; projected_days: N; uncertainty: N
  mid: T; from: T; to: T; status: 'futuro' | 'in corso' | 'passato'; days_away: number; text: string; note: string | null
}
export interface CycleCluster {
  kind: 'top' | 'bottom'; kind_label: string; cycles: number; of: number
  members: { halving: number; days: number; time: T; price: N }[]
  mean_days: N; projected_days: N; uncertainty: N; mid: T; from: T; to: T; days_away: number
  confirmed: { days: number; time: T } | null; status: 'futuro' | 'in corso' | 'passato'; text: string
}

export interface MonthStat extends Stats { month: number; label: string }
export interface HalvingRow {
  idx: number; label: string; short: string; years: number[]
  months: (Stats & { values: { year: number; value: number }[] })[]
  annual: { avg: N; median: N; win_rate: N; values: { year: number; value: N }[] }
}
export interface Seasonality {
  monthly: { years: number[]; matrix: N[][]; stats: MonthStat[]; year_totals: { year: number; total: N; cycle_year: number }[]
             current: { year: number; month: number; value: N; partial: boolean } }
  quarterly: { years: number[]; matrix: N[][]; stats: (Stats & { quarter: number; label: string })[]; current: { year: number; quarter: number } }
  weekly: { stats: (Stats & { week: number })[]; current_week: number }
  weekday: { stats: (Stats & { dow: number; label: string; name: string; avg_range: N })[]; current_dow: number }
  monthday: { stats: (Stats & { day: number })[]; current_day: number }
  hourly: { stats: (Stats & { hour: number; avg_range: N; vol_share: N })[]; current_hour: number; since: T | null }
  hour_dow: { avg: N[][]; range: N[][] }
  sessions: (Stats & { key: string; label: string; hours: string; avg_range: N; recent_avg: N; recent_win_rate: N })[]
  halving_cycle: { rows: HalvingRow[]; current: { idx: number; month: number; year: number; label: string } }
}

export interface EventStat {
  key: string; label: string; kind: string; description: string; n: number
  post_avg: N; post_median: N; post_win_rate: N; pre_avg: N; pre_win_rate: N; day_avg: N; day_win_rate: N
  abs_post: N; vol_ratio: N; big_move_rate: N
  recent: { time: T; pre: N; post: N; day: N }[]
}

export interface TimePivots {
  generated_at: T; today: T; horizon: number; price: number
  kpi: {
    next_pivot: Pick<CalendarItem, 'id' | 'time' | 'start' | 'end' | 'label' | 'confluence' | 'expected' | 'probability' | 'title' | 'days_away'> | null
    current_month: { month: number; label: string; avg: N; median: N; win_rate: N; n: number; mtd: N }
    cycle_position: { idx: number; label: string; short: string; month: number; avg: N; win_rate: N; n: number; annual_avg: N; days_since_halving: number }
    best_day: (Stats & { label: string; name: string; dow: number }) | null
    worst_day: (Stats & { label: string; name: string; dow: number }) | null
    best_hour: (Stats & { hour: number }) | null
    worst_hour: (Stats & { hour: number }) | null
  }
  today_info: { date: T; lines: string[]; this_week: string[]; active_windows: string[] }
  calendar: CalendarItem[]
  seasonality: Seasonality
  windows: {
    years: number[]; base_rates: Record<string, Record<string, number>>
    top: PivotWindow[]; upcoming: PivotWindow[]; active: PivotWindow[]
    strip: [number, number, Expected, number, number][] // [mese, giorno, comportamento, coerenza %, punteggio]
    method: string
  }
  cycle_pivots: { days_since_halving: number; last_halving: T; next_halving: T | null; phase: string | null; items: CycleItem[]; clusters: CycleCluster[]; method: string }
  projections: {
    swings: { time: T; price: N; kind: 'high' | 'low'; open: boolean }[]
    legs: { from: T; to: T; days: number; from_price: N; to_price: N; change: N; dir: 'up' | 'down' }[]
    fib: { ratio: number; anchor_from: T; anchor_to: T; leg_days: number; time: T; status: string; days_away: number; label: string }[]
    equal_legs: { label: string; days: N; anchor: T; time: T; status: string; days_away: number }[]
    spacing: { tf: string; median_days: N; iqr: [N, N]; count: number; last_pivot: { time: T; price: N; kind: string }; next: T[] }[]
    next_kind: 'top' | 'bottom' | null
    method: string
  }
  events: {
    stats: EventStat[]
    weekend: { n: number; avg_gap: N; avg_abs_gap: N; up_rate: N; big_gap_rate: N; fill_rate: N; big_fill_rate: N; median_fill_hours: N; monday_avg: N; monday_win_rate: N; text: string } | null
    upcoming: { key: string; title: string; time: T; expected: Expected; probability: N; text: string }[]
    fomc: { dates: T[]; next: T[]; stats: EventStat | null; note: string }
    baseline: { abs_1d: N; abs_3d: N; up_rate_1d: N }
  }
  chart: { candles: { time: T; open: number; high: number; low: number; close: number }[] }
  method: string
}

export async function fetchTimePivots(horizon: number): Promise<TimePivots> {
  const res = await fetch(`/api/timepivots?horizon=${horizon}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<TimePivots>
}

export const useTimePivots = (horizon = 90) =>
  useQuery({
    queryKey: ['timepivots', horizon],
    queryFn: () => fetchTimePivots(horizon),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })
