// Domanda e offerta — tipi (vedi CONTRACT.md § SUPPLY DEMAND) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Pt, T } from './types'

type N = number | null

// ------------------------------------------------------------------ Exchange (CoinMetrics community)
export type FlowRegime = 'deflussi_forti' | 'deflussi' | 'neutro' | 'afflussi' | 'afflussi_forti'
export interface FwdBlock {                       // forward BTC returns (median %, share positive %, sample size)
  days: number; episodes: number; last: T | null
  r7?: N; hit7?: N; n7?: number; r30: N; hit30: N; n30: number; r90: N; hit90: N; n90: number; r180?: N; hit180?: N; n180?: number
}
export interface ExtremeDay { time: T; net: N; inflow: N; outflow: N; z: N; price: N; r30: N; r90: N }
export interface CyclePhase {
  kind: 'rialzo' | 'ribasso'; start: T; end: T; ongoing: boolean; days: number; price_change: N
  reserve_start: N; reserve_end: N; reserve_change: N; reserve_change_pct: N; share_change_pt: N
  avg_daily_net: N; outflow_days_pct: N; start_partial: boolean
}
export interface ExchangesData {
  as_of: T                                        // last CoinMetrics day (UTC, +1 day publication delay)
  flash_computed_at: T | null                     // when CoinMetrics computed the latest "flash" (preliminary) value
  kpi: {
    reserve: N; reserve_pct: N                    // BTC on exchanges; % of circulating supply
    reserve_change_30d: N; reserve_change_365d: N; reserve_change_365d_pct: N; share_change_365d_pt: N
    net_1d: N; z_1d: N; net_7d: N; net_30d: N; net_90d: N; z_30d: N; regime: FlowRegime | null
    lowest_since: T | null; reserve_ath: N; reserve_ath_time: T; inflow_1d: N; outflow_1d: N; price: N
  }
  series: {                                       // weekly samples, daily over the last 365 days
    reserve: Pt[]; reserve_pct: Pt[]; price: Pt[]; net30: Pt[]; net90: Pt[]; z30: Pt[]
    net_daily: Pt[]                               // daily net flow, last 365 days (BTC, + = into exchanges)
    net_weekly: Pt[]                              // weekly sums (Mon→Sun) since 2015
  }
  recent: { time: T; inflow: N; outflow: N; net: N; reserve: N; z: N; flash: boolean }[]   // last 30 days, newest first
  extremes: { inflows: ExtremeDay[]; outflows: ExtremeDay[] }                              // top 10 by daily z-score, ≥ 10 days apart
  regimes: { since: T; rows: (FwdBlock & { key: FlowRegime; lo: N; hi: N })[]; baseline: FwdBlock
             daily: { outflow: FwdBlock; inflow: FwdBlock; baseline: FwdBlock } }          // daily |z| ≥ 2, horizons 7/30/90
  phases: CyclePhase[]
  checks: {
    black_thursday: { date: T; expected_inflow: number; inflow: N; outflow: N; net: N }
    ftx: { date: T; expected_net: number; inflow: N; outflow: N; net: N }
    identity_days: number; identity_ok_pct: N     // % of days where Δreserve = inflow − outflow (±1 BTC)
    adjustments: number; adjustment_btc: N; adjustments_list: { time: T; btc: N }[]   // coverage changes > 1,000 BTC
    flash_rows_pct: N; issuance_30d_avg: N
  }
  stats_since: T
}

// ------------------------------------------------------------------ ETF spot (Farside)
export interface Streak { sign: 1 | -1; start: T; end: T; days: number; usd: N; btc: N }
export interface IssuerRow {
  ticker: string; first: T | null; cum_usd: N; cum_btc: N; last: N; d5: N; d30: N   // M$ (d30 = last 21 sessions); BTC estimate
  max_in: N; max_in_time: T | null; max_out: N; max_out_time: T | null
}
export interface AbsorptionRow { time: T; etf_btc: N; issued_btc: N; etf_usd: N; ratio: N; complete: boolean }
export interface EtfData {
  as_of: T; provisional: boolean; partial_issuers: string[]
  source: { name: string; url: string; mode: 'all' | 'recent' | 'cache'; fetched_at: T | null; error: string | null; age_s: N }
  kpi: {
    last_usd: N; last_btc: N; d5_usd: N; d5_btc: N; d20_usd: N; d20_btc: N; cum_usd: N; cum_btc: N   // USD in M$
    ratio_30d: N; ratio_30d_time: T | null; issued_30d: N; etf_30d_btc: N
    days: number; inflow_days_pct: N; price_last: N
  }
  streaks: { current: Streak | null; longest_in: Streak | null; longest_out: Streak | null }
  issuers: IssuerRow[]                            // sorted by cumulative flow
  daily: {                                        // trading days since 11 Jan 2024, arrays aligned with `dates`
    dates: T[]; issuers: Record<string, N[]>; total: N[]; btc: N[]; cum_usd: N[]; cum_btc: N[]; price: N[]   // price = BTC at 16:00 New York
  }
  recent: { time: T; total: N; btc: N; price: N; by: Record<string, N>; provisional: boolean }[]   // last 20 sessions, newest first
  absorption: {
    ratio30: Pt[]                                 // rolling 30 calendar days: ETF net BTC ÷ BTC issued by miners
    weekly: AbsorptionRow[]; monthly: AbsorptionRow[]
    since_launch: { etf_btc: N; issued_btc: N; ratio: N }
    post_halving: { since: T; etf_btc: N; issued_btc: N; ratio: N }
  }
  reaction: { big_in: FwdBlock; big_out: FwdBlock; all: FwdBlock }   // total ≥ +500 M$ / ≤ −500 M$, horizons 7/30/90
  checks: {
    day1_total: N; day1_expected: number; row_mismatches: number; rows: number; footer_total: N; sum_total: N
    known: { date: T; col: string; expected: number; observed: N; ok: boolean }[]
    ibit_2024: { date: T; estimate: N; published: number; ok: boolean }
  }
}

// ------------------------------------------------------------------ Attenzione (Wikipedia)
export type AttentionZone = 'bassa' | 'sotto_media' | 'sopra_media' | 'alta' | 'estrema'
export interface AttentionData {
  as_of: T
  kpi: {
    views_1d: N; avg_30d: N; avg_7d: N; change_365d: N; percentile: N; zone: AttentionZone | null
    ath_30d: N; ath_30d_time: T; vs_ath_pct: N; ath_day: N; ath_day_time: T
    it_avg_30d: N; it_ath_day_time: T | null; it_ath_day: N; lowest_since: T | null
  }
  series: { views30: Pt[]; it30: Pt[]; price: Pt[]; percentile: Pt[] }   // weekly samples, daily over the last 365 days (percentile weekly)
  peaks: { top: T; top_price: N; peak30: T; peak30_views: N; lag30_days: number; peak_day: T; peak_day_views: N; lag_day_days: number; complete: boolean }[]
  spikes: { time: T; views: N; price: N; r30: N; r90: N }[]
  backtest: { since: T; rows: (FwdBlock & { key: AttentionZone; lo: number; hi: number })[]; baseline: FwdBlock }
  checks: { en_peak_day: T; en_peak_views: N; it_peak_day: T | null; days: number; first: T }
}

export interface SupplyDemand {
  exchanges: ExchangesData | null; etf: EtfData | null; attention: AttentionData | null
  errors: Record<string, string>; generated_at: T
}

/*
 * The page composes every sentence in the frontend (IT/EN dictionaries), so these requests skip the backend LLM
 * translation: an absolute URL is not rewritten by installFetchLang() (it only patches "/api…" strings).
 */
async function get<R>(path: string): Promise<R> {
  const res = await fetch(new URL(`/api${path}`, window.location.origin), { headers: { Accept: 'application/json' } })
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

const opts = { retry: 1, placeholderData: keepPreviousData, staleTime: 60_000 } as const
export const useExchanges = () =>
  useQuery({ queryKey: ['supplyDemand', 'exchanges'], queryFn: () => get<ExchangesData>('/supply-demand/exchanges'), refetchInterval: 10 * 60_000, ...opts })
export const useEtf = () =>
  useQuery({ queryKey: ['supplyDemand', 'etf'], queryFn: () => get<EtfData>('/supply-demand/etf'), refetchInterval: 5 * 60_000, ...opts })
export const useAttention = () =>
  useQuery({ queryKey: ['supplyDemand', 'attention'], queryFn: () => get<AttentionData>('/supply-demand/attention'), refetchInterval: 10 * 60_000, ...opts })
