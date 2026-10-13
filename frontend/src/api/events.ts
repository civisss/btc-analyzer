// Calendario eventi e ciclo politico — tipi (vedi CONTRACT.md § EVENTS) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

type N = number | null
export type EventKey = 'fomc' | 'cpi' | 'nfp' | 'opex_month' | 'opex_quarter' | 'midterm' | 'election' | 'halving'
export type EventCategory = 'politica' | 'macro' | 'derivati' | 'ciclo'
export type DateQuality = 'esatta' | 'regola' | 'stimata'

/** Statistiche di una finestra (percentuali). */
export interface WinStat { avg: N; median: N; abs_avg: N; abs_median: N; win_rate: N; n: number }

export interface EventTypeStat {
  key: EventKey; label: string; category: EventCategory
  quality: DateQuality; quality_label: string; description: string
  n: number; since: T
  d1: WinStat          // ±1 g: chiusura d−2 → chiusura d+1
  d7: WinStat          // −7..+7 g: chiusura d−8 → chiusura d+7
  pre7: WinStat; post7: WinStat
  range_1d: N; range_7d: N                     // escursione high/low mediana (%)
  vol_ratio_1d: N; vol_ratio_7d: N             // |movimento| mediano evento ÷ mediana di tutti i giorni dello stesso periodo
  range_ratio_1d: N; range_ratio_7d: N
  baseline: { abs_1d: number; abs_7d: number; range_1d: number; range_7d: number; up_1d: number }
  path: { day: number; median: N; mean: N }[]  // −7..+7, % vs chiusura di d−1
  recent: { time: T; label: string; d1: N; d7: N; post7: N; range_1d: N }[]   // ultimi 10, più recenti prima
  note: string
}

export interface UpcomingEvent {
  id: string; key: EventKey; type_label: string; category: EventCategory
  title: string; time: T; date: T; date_label: string; hour: string
  days_away: number; quality: DateQuality; quality_label: string
  importance: 'alta' | 'media' | 'bassa'
  expected_abs_1d: N; expected_abs_7d: N; expected_usd_1d: N   // volatilità attesa = vol_ratio storico × volatilità degli ultimi 90 g
  hist_abs_1d: N; vol_ratio_1d: N; vol_ratio_7d: N; up_rate_1d: N; up_rate_7d: N; n: number
  text: string
}

export interface PathSeries { name: string; time: T; current: boolean; points: [number, N][] }   // [giorni dall'evento, %]

export interface PoliticalCycle {
  years: { year: number; type: 'presidential' | 'post' | 'midterm' | 'pre'; label: string; return: N; partial: boolean; halving_year: boolean }[]
  year_types: { type: 'presidential' | 'post' | 'midterm' | 'pre'; label: string; n: number; avg: N; median: N; win_rate: N; years: number[]; current: boolean }[]
  current_year_type: 'presidential' | 'post' | 'midterm' | 'pre'
  midterm: {
    next: T; days_to: number; anchor_day: number; anchor_label: string
    paths: PathSeries[]            // 2014, 2018, 2022 + 2026 (current) — % vs chiusura al giorno `anchor_day`
    mean: [number, N][]            // media dei cicli passati
    lows: { year: number; midterm: T; low_time: T; low_label: string; low_price: number; days_from_midterm: number
            drawdown_from_ath: number; midterm_price: number; fwd_365: N; low_to_365: N }[]
    pre180: { avg: N; current: N }
    fwd_365: { avg: N; up: number; n: number }
  }
  presidential: { next: T; paths: PathSeries[] }   // % vs chiusura del giorno del voto
  text: string[]
}

export interface CmeGap {
  n: number; avg_gap: N; avg_abs_gap: N; up_rate: N; big_gap_rate: N; fill_rate: N; big_fill_rate: N
  median_fill_hours: N; monday_avg: N; monday_win_rate: N; text: string
}

export interface EventsResponse {
  generated_at: T; today: T; price: number; horizon: number
  types: EventTypeStat[]
  upcoming: UpcomingEvent[]
  later: { key: EventKey; title: string; time: T; date_label: string; days_away: number; quality: DateQuality; quality_label: string }[]
  political: PoliticalCycle
  cme_gap: CmeGap | null
  baseline_now: { abs_1d: number; abs_7d: number; range_1d: number; range_7d: number; up_1d: number }
  quality: { cpi_rule_accuracy: { n: number; exact: number; within_1: number; within_3: number }; notes: string[] }
  method: string
}

export async function fetchEvents(horizon = 90): Promise<EventsResponse> {
  const res = await fetch(`/api/events?horizon=${horizon}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<EventsResponse>
}

export const useEvents = (horizon = 90) =>
  useQuery({ queryKey: ['events', horizon], queryFn: () => fetchEvents(horizon), refetchInterval: 15 * 60_000, staleTime: 5 * 60_000, retry: 1, placeholderData: keepPreviousData })
