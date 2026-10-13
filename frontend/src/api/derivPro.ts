// Derivati PRO — basis e struttura a termine, posizionamento CME (COT), leva aggregata multi-exchange.
// Tipi: CONTRACT.md § DERIVATIVES PRO. Query key roots: 'deriv-basis' | 'deriv-cme' | 'deriv-agg' (realtime.ts).
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Pt, T, Tone } from './types'

type N = number | null
export type Signal = { text: string; tone: Tone }

// ------------------------------------------------------------------ basis
export type BasisVenue = 'deribit' | 'binance_usdm' | 'binance_coinm'
export interface BasisRow {
  venue: BasisVenue; instrument: string; expiry: T; days: number
  mark: number; index: number; basis_pct: number; annualized_pct: number   // percent; simple annualization ×365/days
  oi_usd: N; noisy: boolean                                                  // noisy = < 7 days to expiry
}
export interface PerpPremium { mark: number; index: number; premium_pct: number; funding_8h: N; oi_usd: N }
export interface BasisData {
  time: T; index_price: N
  curve: BasisRow[]
  perpetual: Partial<Record<BasisVenue, PerpPremium>>
  shape: 'contango' | 'backwardation' | 'flat' | 'mixed' | null; slope_pp: N
  stats: {
    current_pct: N; percentile: N; percentile_1y: N; avg_30d: N             // 90-day constant-maturity annualized basis, Binance COIN-M
    max: { value: number; time: T } | null; min: { value: number; time: T } | null
    source: 'binance_coinm'; live: boolean; usdm_live_pct?: N
  }
  crosscheck: {
    pairs: { expiry: T; deribit_pct: number; binance_usdm_pct: N; binance_coinm_pct: N; diff_pp: number }[]
    binance_official: { time: T; binance_pct: number; ours_pct: number; diff_pp: number; days: number } | null
    coinm_vs_usdm: { n: number; mean_abs_diff_pp: number; mean_abs_diff_1y_pp: number; corr: number } | null
    roll_check: { n_rolls: number; contract_roll_pp: number; contract_other_pp: number; cm90_roll_pp: number; cm90_other_pp: number } | null
  }
  history: {
    coinm: Pt[]; usdm: Pt[]                         // 90-day constant maturity (no roll steps)
    coinm_contract: Pt[]; usdm_contract: Pt[]       // per-contract annualized, stitched (roll 14 d before expiry)
    rolls: { coinm: T[]; usdm: T[] }
    start: { coinm: T | null; usdm: T | null }
  }
  deribit_cm90: { since: T | null; series: Pt[] }  // daily snapshots collected by the app
  signals: Signal[]
  params: { roll_days: number; noisy_days: number; cm_days: number }
}

// ------------------------------------------------------------------ CME COT
export type CotCat = 'lev' | 'am' | 'dealer' | 'other' | 'nr'
export interface CotCategory {
  id: CotCat; label: string
  long: number; short: number; spread: N; net: number; net_btc: number         // contracts (5 BTC); net_btc = net × 5
  net_change: N; long_change: N; short_change: N
  pct_oi_long: number; pct_oi_short: number; net_pctl_3y: N
}
export interface CmeData {
  report_date: T; published: T; next_report: T; next_publication: T            // Tuesday data, Friday release
  contract_btc: number; oi_contracts: number; oi_btc: number; oi_change: N; oi_change_btc: N; oi_pctl_3y: N
  micro: { oi_contracts: N; oi_btc: N; since: T | null }
  traders: { total: N; lev_long: N; lev_short: N; am_long: N; am_short: N }
  categories: CotCategory[]
  history: { oi_btc: Pt[]; micro_oi_btc: Pt[]; lev_net: Pt[]; am_net: Pt[]; dealer_net: Pt[]; other_net: Pt[]; nr_net: Pt[] }
  since: T; weeks: number
  verification: { report_date: T | null; same_week: boolean; match: boolean; diffs: Record<string, number>; source: string } | null
  signals: Signal[]
}

// ------------------------------------------------------------------ leva aggregata
export type ExchangeId = 'binance' | 'bybit' | 'okx'
export interface AggContract {
  symbol: string; kind: 'USDT' | 'USDC' | 'COIN-M'; oi_btc: number; oi_usd: number
  funding_8h: number; interval_h: number; mark: number; oi_usd_both_sides: N   // funding in % per 8h
}
export interface AggExchange {
  id: ExchangeId; name: string; ok: boolean; error: string | null
  oi_btc: N; oi_usd: N; funding_8h: N; share_pct: N; long_pct: N; long_pct_time: T | null
  contracts: AggContract[]
}
export interface AggregateData {
  time: T
  exchanges: AggExchange[]
  total: { oi_btc: N; oi_usd: N; funding_8h: N; funding_annual: N; funding_simple_avg: N; exchanges_ok: number; change_7d_pct: N; binance_usdt_share_pct: N }
  crosscheck: {
    rows: { exchange: ExchangeId; symbol: string; ours_usd: number; coingecko_usd: N; diff_pct: N; both_sides: boolean }[]
    global_perp_oi_usd: N; coverage_pct: N; source_time: T | null; contracts_global: N
  }
  history: {
    oi_btc: Partial<Record<ExchangeId | 'total', Pt[]>>
    starts: Partial<Record<ExchangeId | 'total', T | null>>
    funding: Partial<Record<ExchangeId | 'weighted', Pt[]>>   // % per 8h, daily mean
    long_pct: Partial<Record<ExchangeId, Pt[]>>               // percent of accounts long
  }
  intraday: { since: T | null; total_oi_btc: Pt[]; funding_weighted: Pt[] }
  signals: Signal[]
  excluded: string[]
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
export const useBasis = () =>
  useQuery({ queryKey: ['deriv-basis'], queryFn: () => get<BasisData>('/derivatives/basis'), refetchInterval: 60_000, staleTime: 30_000, ...opts })
export const useCme = () =>
  useQuery({ queryKey: ['deriv-cme'], queryFn: () => get<CmeData>('/derivatives/cme'), refetchInterval: 15 * 60_000, staleTime: 5 * 60_000, ...opts })
export const useAggregate = () =>
  useQuery({ queryKey: ['deriv-agg'], queryFn: () => get<AggregateData>('/derivatives/aggregate'), refetchInterval: 60_000, staleTime: 30_000, ...opts })
