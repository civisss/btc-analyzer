// Analoghi della USDT.D + liquidità stablecoin — tipi (vedi CONTRACT.md § USDT ANALOGS & STABLECOINS) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { AnalogLeg, AnalogLegPair, ChartPattern, VisualComponent } from './analogs'
import type { Pt, T, Tone } from './types'

export type UsdtTf = '1d' | '4h'

/** Leg on the USDT.D curve: prices are USDT.D values in %, `pts` = change in percentage points, `pct` = relative % change. */
export type UsdtLeg = AnalogLeg & { pts: number }
/** Pattern detected on the USDT.D curve; `tone` refers to USDT.D itself, `btc_tone` is the reading for BTC (inverted). */
export type UsdtPattern = ChartPattern & { btc_tone: Tone; label: string }

export interface UsdtMapPoint { time: T; price: number; idx: number; pct: number; pts: number; btc: number }
export interface UsdtMapping {
  n: number; kind: 'start' | 'end' | 'high' | 'low'
  label: string; analog_label: string; same_role: boolean
  current: UsdtMapPoint; analog: UsdtMapPoint; note: string
}
export interface UsdtContextFeature {
  key: 'level' | 'change' | 'rsi' | 'btc' | 'mirror'; label: string
  current: number | null; analog: number | null; display_current: string; display_analog: string
  similarity: number | null; weight: number; explanation: string
}
export interface UsdtAnalogMatch {
  rank: number
  period: { start: T; end: T; label: string; when: string }
  similarity: number; visual_similarity: number; shape_similarity: number; context_similarity: number
  correlation: number; dtw: number
  visual: { score: number; components: VisualComponent[] } // candles & volume: score null (not applicable)
  patterns: { current: UsdtPattern[]; analog: UsdtPattern[]; common: string | null; common_name: string | null; text: string; score: number }
  legs_current: UsdtLeg[]; legs_analog: UsdtLeg[]; leg_pairs: AnalogLegPair[]
  context: UsdtContextFeature[]
  mapping: UsdtMapping[]
  usdt: { times: T[]; values: number[]; window_change_pts: number; window_change: number } // analog window + following candles (USDT.D %)
  btc: { values: number[]; window_change: number }                                         // BTC closes aligned with usdt.times
  outcome: { candles: number; change: number | null; max_up: number | null; max_down: number | null
             usdt_change_pts: number | null; usdt_change: number | null; end_time: T | null }   // BTC % (closes), USDT.D in pt
  projection: { times: T[]; close: number[] }        // BTC path after the analog rescaled onto today's price
  usdt_projection: { times: T[]; value: number[] }   // USDT.D path after, shifted onto today's level (USDT.D %)
  narrative: string[]; narrative_llm: string | null
}
export interface MirrorJoint {
  rank: number; start: T; end: T; label: string; similarity: number; btc_shape: number; usdt_shape: number
  mirror_then: number | null; btc_outcome: number; btc_max_up: number; btc_max_down: number; usdt_outcome_pts: number
}
export interface MirrorBreak {
  kind: 'both_up' | 'both_down'; start: T; end: T; days: number; label: string
  btc_change: number; usdt_change_pts: number; btc_after_14: number | null; btc_after_30: number | null; ongoing: boolean; text: string
}
export interface UsdtMirror {
  window: number; current: number | null; avg_1y: number; percentile: number | null; p10: number; p50: number
  state: 'forte' | 'moderato' | 'rotto' | 'n/d'; text: string
  series: Pt[]                     // mirror = −rolling corr(BTC log returns, USDT.D log returns), last 2 years daily
  joint: MirrorJoint[]; breaks: MirrorBreak[]
  break_stats: { kind: 'both_up' | 'both_down'; label: string; n: number; median_after_30: number | null; up_rate_30: number | null }[]
  current_break: MirrorBreak | null
}
export interface UsdtZone {
  low: number; high: number; mid: number; kind: 'support' | 'resistance'; touches: number; reactions: number; last_touch: T
  distance_pts: number; btc_after_14_median: number | null; btc_after_30_median: number | null; btc_up_rate_30: number | null; text: string
}
export interface UsdtTechnicals {
  usdt_d: number; rsi: number; rsi_zone: 'ipercomprato' | 'ipervenduto' | 'neutra'
  ema50: number; ema200: number; dist_ema50_pts: number; dist_ema200_pts: number; trend: 'rialzista' | 'ribassista' | 'laterale'
  zones: UsdtZone[]; signals: { text: string; tone: Tone }[]
  series: { time: T; value: number; ema50: number; ema200: number; rsi: number | null }[] // last ~400 days
}
export interface UsdtIntraday { estimated: true; last: number; time: T; change_24h_pts: number | null; daily_last: number; series: Pt[]; note: string }

export interface UsdtAnalogs {
  tf: UsdtTf; window: number; horizon: number; top: number; generated_at: T; estimated: boolean; live: boolean
  current: {
    start: T; end: T; label: string; usdt_d: number; btc: number; change_pts: number; change: number; btc_change: number
    times: T[]; usdt: number[]; btc_path: number[]; patterns: UsdtPattern[]; legs: UsdtLeg[]; rsi: number | null
  }
  summary: {
    count: number; up: number; down: number; agreement: number | null; median_outcome: number | null; weighted_outcome: number | null
    usdt_median_pts: number | null; best_similarity: number | null; bias: Tone; text: string
    band: { times: T[]; p25: number[]; p50: number[]; p75: number[]; usdt_p50: number[] } | null
  }
  matches: UsdtAnalogMatch[]
  mirror: UsdtMirror | null
  technicals: UsdtTechnicals | null
  intraday: UsdtIntraday | null
  method: string
}

export interface StableRow { time: T; supply: number; dominance: number; ssr: number; ssr_mid: number | null; ssr_sd: number | null; chg30: number | null }
export interface Stablecoins {
  generated_at: T; live: boolean
  current: {
    supply: number; supply_ath: number; supply_ath_time: T; at_ath: boolean
    net_7d: number | null; net_30d: number | null; net_90d: number | null; net_365d: number | null       // USD
    pct_7d: number | null; pct_30d: number | null; pct_90d: number | null; pct_365d: number | null       // %
    dominance: number; dominance_change_30d: number | null                                               // % / pt
    ssr: number; ssr_mid: number | null; ssr_sd: number | null; ssr_z: number | null; ssr_percentile: number | null
    usdt_share: number; btc_cap: number; total_cap: number; time: T
  }
  series: StableRow[]      // daily since 2020 (supply USD, dominance %, SSR ratio + 365d mean/sd, chg30 %)
  weekly_net: Pt[]         // weekly net mint(+)/burn(−) USD, last 104 weeks (time = Monday)
  daily_net: Pt[]          // daily net change USD, last 90 days
  issuance: {
    lead_lag: { lag: number; corr: number | null }[]; best_lag: number; best_corr: number | null; corr_0: number | null // lag in weeks, + = issuance leads
    regimes: { key: 'strong' | 'mid' | 'weak'; label: string; n: number; median: number | null; up_rate: number | null }[]
    current_regime: 'strong' | 'mid' | 'weak' | null; current_chg30: number | null
  }
  interpretation: { key: string; title: string; tone: Tone; text: string }[]
  note: string
}

async function get<R>(path: string, params?: Record<string, string | number | undefined>): Promise<R> {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) s.set(k, String(v))
  const q = s.toString()
  const res = await fetch(`/api${path}${q ? `?${q}` : ''}`, { headers: { Accept: 'application/json' } })
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

export type UsdtAnalogParams = { tf: UsdtTf; window: number; top: number; horizon: number }

export const useUsdtAnalogs = (p: UsdtAnalogParams, enabled = true) =>
  useQuery({
    queryKey: ['usdtAnalogs', p],
    queryFn: () => get<UsdtAnalogs>('/usdt/analogs', p),
    refetchInterval: 60_000,
    retry: 1,
    enabled,
    placeholderData: keepPreviousData,
  })

export const useStablecoins = (enabled = true) =>
  useQuery({ queryKey: ['stablecoins'], queryFn: () => get<Stablecoins>('/stablecoins'), refetchInterval: 2 * 60_000, retry: 1, enabled, placeholderData: keepPreviousData })
