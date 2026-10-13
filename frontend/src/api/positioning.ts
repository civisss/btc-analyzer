// Posizionamento — tipi (vedi CONTRACT.md § POSITIONING) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Pt, T } from './types'

type N = number | null
export type Tone = 'bullish' | 'bearish' | 'neutral'
export type ExpiryKind = 'giornaliera' | 'settimanale' | 'mensile' | 'trimestrale'

// ------------------------------------------------------------------ Opzioni
export interface StrikeOi { strike: number; calls: number; puts: number; calls_usd: number; puts_usd: number }   // OI in BTC, *_usd notional
export interface ExpiryRow {
  expiry: T; days: number; kind: ExpiryKind
  max_pain: N; max_pain_dist: N                  // USD; percent vs index price
  oi_calls: number; oi_puts: number; oi_btc: number; notional_usd: number
  pc_oi: N; pc_vol: N; atm_iv: N; skew_25d: N    // IV in vol points; skew = IV put25Δ − IV call25Δ
}
export interface OptionsData {
  index_price: number; updated_at: T
  kpi: {
    oi_usd: number; oi_btc: number; pc_oi: N; pc_vol: N; volume_usd_24h: number
    next_expiry: T | null; next_max_pain: N; next_max_pain_dist: N; next_notional_usd: N
    skew_7d: N; skew_30d: N; skew_90d: N; atm_7d: N; atm_30d: N; atm_90d: N; dvol: N
  }
  expiries: ExpiryRow[]                          // next 6 + later monthly/quarterly (max 10)
  oi_by_strike: {
    all: StrikeOi[]                              // all expiries, strikes 50%..160% of index
    by_expiry: { expiry: T; kind: ExpiryKind; max_pain: N; strikes: StrikeOi[] }[]
  }
  gamma: {
    profile: { strike: number; calls: number; puts: number; total: number }[]   // USD of delta per 1% move (gross), strikes ±20%
    walls: { strike: number; calls: number; puts: number; total: number }[]     // top 5 by total
    oi_walls: StrikeOi[]                                                        // top 6 OI strikes within ±15%
  }
  term_structure: { expiry: T; days: number; atm_iv: N; skew_25d: N; iv_put25: N; iv_call25: N }[]
  smiles: { expiry: T; days: number; forward: number; atm_iv: N; points: { strike: number; moneyness: number; iv: number }[] }[]  // moneyness = K/F·100
  dvol: { current: N; series: Pt[]; pct_1y: N; pct_all: N; rv_30d: N; iv_rv_spread: N; min_1y: N; max_1y: N; change_7d: N }
  expiry_history: {
    since: T | null; n: number; converged_pct: N; median_abs_gap: N
    rows: { expiry: T; lead_days: number; max_pain: number; spot_before: number; settlement: number
            gap_before: number; gap_settle: number; converged: boolean; oi_btc: number }[]
  }
  signals: { text: string; tone: Tone }[]
  note: string
}

// ------------------------------------------------------------------ Holder
export interface HoldersData {
  price: number; as_of: T; delay_days: number
  kpi: {
    sth_realized_price: number; lth_realized_price: number; sth_mvrv: number; lth_mvrv: number; sth_mvrv_as_of: number
    dist_sth: number; dist_lth: number                      // percent price vs cost basis
    sth_sopr: N; sth_sopr_7d: N; lth_share: N               // percent of (STH+LTH) supply
    regime: 'above' | 'below'; regime_days: number | null; zone: string
  }
  series: { price: Pt[]; sth_rp: Pt[]; lth_rp: Pt[]; sth_mvrv: Pt[]; lth_mvrv: Pt[]; sth_sopr: Pt[] }   // daily, sth_sopr = 7d MA
  bands: { mean: number; sd1_low: number; sd1_high: number; sd2_low: number; sd2_high: number; levels: number[] }
  extremes: { min: number; min_time: T; max: number; max_time: T }
  buckets: { range: string; label: string; days: number; fwd30_median: N; fwd30_hit: N; fwd90_median: N; fwd90_hit: N }[]
  regimes: { start: T; end: T; above: boolean; days: number }[]
  tests_1y: number
  supply: { sth: number; lth: number; lth_share: number; lth_share_change_30d: N; series_lth_share: Pt[] } | null
  bullets: string[]
  note: string
}

// ------------------------------------------------------------------ Sentiment
export interface BacktestBlock {
  days: number; episodes: number; last: T | null
  r7_median: N; r7_mean: N; hit7: N; n7: number
  r30_median: N; r30_mean: N; hit30: N; n30: number
  r90_median: N; r90_mean: N; hit90: N; n90: number
}
export interface SentimentComponent {
  key: 'fng' | 'funding' | 'flows' | 'premium' | 'dvol' | 'ls' | 'skew'
  label: string; unit: string; score: N; raw: N; raw_display: string; as_of: T | null; history_days: number
  method: string; text: string; in_composite: boolean
}
export interface SentimentData {
  current: { value: number; zone: string; change_7d: N; percentile: number; as_of: T; n_components: number }
  components: SentimentComponent[]
  explanation: string[]
  history: { composite: Pt[]; price: Pt[] }
  backtest: {
    since: T; baseline: BacktestBlock
    zones: (BacktestBlock & { zone: string; lo: number; hi: number })[]
    components: { key: string; label: string; since: T | null; enough: boolean; fear: BacktestBlock | null; greed: BacktestBlock | null }[]
    thresholds: { composite_fear: number; composite_greed: number; component_fear: number; component_greed: number }
  }
  premium: {
    live: N; live_usd: N; coinbase: N; binance: N; avg_7d: N; percentile_4y: N; text: string | null
    daily: Pt[]                    // 7d average premium, percent, last 4 years
    hourly: Pt[]                   // hourly premium, percent, last 30 days
  }
  note: string
}

export interface Positioning {
  options: OptionsData | null; holders: HoldersData | null; sentiment: SentimentData | null
  errors: Record<string, string>; generated_at: T
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
export const useOptions = () =>
  useQuery({ queryKey: ['positioning', 'options'], queryFn: () => get<OptionsData>('/positioning/options'), refetchInterval: 60_000, staleTime: 30_000, ...opts })
export const useHolders = () =>
  useQuery({ queryKey: ['positioning', 'holders'], queryFn: () => get<HoldersData>('/positioning/holders'), refetchInterval: 5 * 60_000, staleTime: 60_000, ...opts })
export const useSentiment = () =>
  useQuery({ queryKey: ['positioning', 'sentiment'], queryFn: () => get<SentimentData>('/positioning/sentiment'), refetchInterval: 2 * 60_000, staleTime: 60_000, ...opts })
