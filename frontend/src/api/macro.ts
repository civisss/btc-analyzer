// Macro & Rotazione — tipi (vedi CONTRACT.md § MACRO) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Pt, T } from './types'

type N = number | null
export type Tone = 'bullish' | 'bearish' | 'neutral'

export interface RegimeStat {
  regime: string; label: string; days: number; share: N
  fwd_median: N; fwd_mean: N; win_rate: N; ann_return: N   // percent; fwd = 90d (DXY, US10Y) or 30d (VIX)
}
export interface LagAnalysis {
  key: 'stables' | 'net_liquidity' | 'm2'; label: string; unit: 'usd'
  lags: { lag: number; corr: N }[]          // lag in days 0..120 step 5: corr(liquidity 90d chg at t, BTC 90d chg at t+lag)
  best_lag: number; best_corr: number; corr_lag0: N; text: string
  liq_level: Pt[]                           // USD
  liq_change_shifted: Pt[]                  // liquidity 90d log change (%) shifted forward by best_lag days (extends into the future)
  btc_change: Pt[]                          // BTC 90d log change (%)
}
export interface Macro {
  kpi: {
    dxy: { value: N; change_1d: N; change_30d: N }            // change percent
    us10y: { value: N; change_30d: N }                         // value = yield percent, change in points
    vix: { value: N; change_1d: N }
    stables: { value: N; growth_90d: N }                       // USD, percent
    ethbtc: { value: N; change_30d: N }
    dominance: { value: N; change_30d: N }                     // percent, change in points
    altseason: { value: N; phase_label: string }               // 0..100
    spx: { value: N; change_1d: N }
    gold: { value: N; change_1d: N }
  }
  liquidity: {
    stables: { supply: N; change_30d: N; growth_90d: N; source: string; series: Pt[]; growth_series: Pt[] }
    lags: LagAnalysis[]                    // "stables" always (if data), + "net_liquidity" & "m2" when FRED is configured
    btc_price: Pt[]
  }
  fred: {
    available: boolean; message: string
    net_liquidity: { value: number; change_13w: N; walcl: N; rrp: N; tga: N; as_of: T } | null   // USD
    m2_yoy: N
    series: { m2_yoy: Pt[] } | null
  }
  dollar_rates: {
    dxy: { value: N; change_1d: N; change_30d: N; change_6m: N; ma200: N; above_ma200: boolean
           regime: 'strong' | 'mixed' | 'weak' | 'na'; regime_label: string; text: string; stats: RegimeStat[]
           series: Pt[]; ma200_series: Pt[]; btc_series: Pt[] }
    us10y: { value: N; change_1d: N; change_30d: N; change_6m: N               // changes in points
             regime: 'rising' | 'stable' | 'falling' | 'na'; regime_label: string; text: string; stats: RegimeStat[]; series: Pt[] }
    vix: { value: N; change_1d: N; change_30d: N
           regime: 'calm' | 'normal' | 'tense' | 'panic'; regime_label: string; text: string; stats: RegimeStat[]; series: Pt[] }
  }
  correlations: {
    assets: { key: string; label: string }[]                                  // btc eth spx ndx gold dxy us10y vix
    matrices: { window: string; days: number; values: N[][] }[]               // "90g" (63 sedute), "1 anno" (252)
    rolling: { dxy: { r30: Pt[]; r90: Pt[]; r180: Pt[] }; spx: { r90: Pt[] }; ndx: { r90: Pt[] }; gold: { r90: Pt[] }; us10y: { r90: Pt[] } }
    betas: { asset: string; label: string; corr_90d: N; beta_90d: N; corr_1y: N; beta_1y: N }[]
  }
  rotation: {
    ethbtc: { value: N; change_30d: N; change_90d: N; ma200: N; above_ma200: boolean; series: Pt[]; ma200_series: Pt[] }
    dominance: { value: N; change_30d: N; change_90d: N; ma200: N; series: Pt[]; ma200_series: Pt[] }   // percent / points
    altseason: { value: N; phase: 'btc_season' | 'neutral' | 'alt_rotation'; phase_label: string
                 components: { key: string; label: string; value: N }[]; series: Pt[]; explanation: string }
    cycle_marks: { time: T; kind: 'top' | 'bottom' | 'halving'; label: string }[]
    cycle_phase: string | null; days_since_halving: number
    compare: { cycle: string; halving: T; time: T; ethbtc: N; ethbtc_since_halving: N; dominance: N; altseason: N
               ethbtc_next_180d: N; dominance_next_180d: N }[]
    bullets: string[]
  }
  summary: {
    score: number; label: 'Risk-on' | 'Neutrale' | 'Risk-off'; tone: Tone
    components: { key: string; label: string; value: string; score: number; tone: Tone; text: string }[]   // score -100..100
    bullets: string[]
  }
  as_of: Record<string, T>
  note: string
  generated_at: T
}

export async function fetchMacro(): Promise<Macro> {
  const res = await fetch('/api/macro', { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = String(b.detail)
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<Macro>
}

export const useMacro = () =>
  useQuery({ queryKey: ['macro'], queryFn: fetchMacro, refetchInterval: 2 * 60_000, staleTime: 60_000, retry: 1, placeholderData: keepPreviousData })
