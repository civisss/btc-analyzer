// Analisi avanzata del ciclo — tipi (vedi CONTRACT.md § CYCLE ADVANCED) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Pt, T } from './types'

export type N = number | null
export type ZoneKey = 'bottom' | 'accumulation' | 'mid' | 'euphoria' | 'top'
export type PhaseKey = 'accumulation' | 'bull' | 'distribution' | 'bear'
export type CompKey = 'pi' | 'mvrv_z' | 'nupl' | 'puell' | 'mayer' | 'power_law' | 'ma2y' | 'drawdown' | 'halving'

export interface Zone { from: number; to: number; key: ZoneKey; label: string; color: string }
export interface ClockComponent {
  key: CompKey; label: string; description: string
  raw: N; display: string
  pct: N          // 0..100 (percentile storico senza lookahead; per "halving" valore di fase 0..100)
  weight: number  // peso attuale in %
}
export interface ClockCurrent {
  time: T; score: N; score_equal: N; score_instant: N
  zone: ZoneKey | null; zone_label: string | null
  change_7d: N; change_30d: N; change_90d: N
  components: ClockComponent[]; text: string[]; live: boolean
}
export interface BacktestEvent {
  kind: 'top' | 'bottom'; time: T; price: number
  score: N; extreme_30d: N             // score il giorno dell'evento / max (top) o min (bottom) entro ±30 g
  extreme_365: N; extreme_365_time: T | null   // max/min nei 365 g precedenti (+30 g dopo)
  lead_1: N; lead_2: N; thresholds: [number, number]   // giorni di anticipo del primo attraversamento di 80/90 (top) o 20/10 (bottom) entro 365 g prima
  probable: boolean                    // minimo probabile (non confermato)
}
export interface SignalEpisode { start: T; end: T; days: number; extreme: number; status: 'vero' | 'falso' | 'in_corso'; event: T | null; lead: N }
export interface SignalStats {
  threshold: number; direction: 'above' | 'below'
  episodes: number; true: number; false: number; pending: number; items: SignalEpisode[]
}
export interface Backtest { events: BacktestEvent[]; signals: SignalStats[]; mean_at_tops: N; mean_at_bottoms: N }

// GET /api/cycle/advanced/clock
export interface CycleClock {
  generated_at: T
  current: ClockCurrent
  zones: Zone[]
  history: Pt[]            // score walk-forward (settimanale, giornaliero ultimi 2 anni)
  history_equal: Pt[]      // variante a pesi uguali
  price: Pt[]
  components_history: Record<CompKey, Pt[]>   // settimanale
  backtest: Backtest
  backtest_equal: Omit<Backtest, 'signals'>
  weights: { current: Record<CompKey, number>; history: { from: T; events: number; weights: Record<CompKey, number>; separation: Record<CompKey, N> }[] }
  method: string
}

// GET /api/cycle/advanced/miner
export interface ReturnsH { '30'?: N; '90'?: N; '180'?: N }
export interface HashSignal {
  time: T; cap_start: T; cap_days: number; hr_drawdown: number; price: number; ret: ReturnsH
  momentum_time: T | null; momentum_ret: ReturnsH
}
export interface HitRow { horizon: number; n: number; hit_rate: N; avg: N; median: N; base_hit_rate: N; base_median: N }
export interface MinerCurrent {
  state: 'capitulation' | 'recovery' | 'healthy'; label: string; days_in_state: number
  hashrate: N; sma30: N; sma60: N; ribbon_gap: N          // EH/s; gap % SMA30 vs SMA60
  ribbon_compression: N; ribbon_compression_pct: N; ribbon_inverted: boolean
  hr_drawdown: N; puell: N; issuance_usd: N; issuance_change_90d: N
  last_signal: HashSignal | null; days_since_signal: N
}
export interface CycleMiner {
  generated_at: T
  current: MinerCurrent; text: string[]
  series: { hashrate: Pt[]; sma30: Pt[]; sma60: Pt[]; ribbon_compression: Pt[]; hr_drawdown: Pt[]; puell: Pt[]; issuance_usd: Pt[]; price: Pt[] }
  ribbon: { periods: number[]; times: T[]; values: N[][] }   // ultimi 4 anni, 1 punto ogni 3 g, values[i][k] = SMA periods[k] (EH/s)
  capitulations: { from: T; to: T | null; days: number }[]
  signals: HashSignal[]     // più recenti per primi
  stats: { basic: HitRow[]; momentum: HitRow[] }
  method: string
}

// GET /api/cycle/advanced/compare
export type AnchorKey = 'halving' | 'top' | 'bottom' | 'probable_bottom'
export interface SameDayRow {
  label: string; anchor_time: T; anchor_price: N; time: T; price: number
  multiple: N; drawdown_ath: number; days_to_ath: N; mvrv: N; score: N
  fwd: { '90': N; '180': N; '365': N }; max_gain_365: N; max_dd_365: N; is_current: boolean
}
export interface CompareAnchor {
  key: AnchorKey; label: string; anchor_time: T; days: number
  rows: SameDayRow[]                       // cicli precedenti + riga corrente (is_current)
  series: { name: string; current: boolean; points: [number, N, N][] }[]   // [giorno, prezzo/ancora (x), score]
  fwd_stats: Record<'90' | '180' | '365', { n: number; median: N; min: N; max: N; up: number }>
}
export interface Survival {
  phase: 'bull' | 'bear'; label: string; elapsed: number; anchor_time: T; samples: number[]
  remaining_median: N; exceeded_all: boolean
  horizons: { days: number; km: N; lognormal: N }[]   // P(fase dura ancora ≥ X giorni | già durata `elapsed`) in %
  curve: { day: number; km: number; lognormal: number }[]   // S(t) non condizionata in %
  note: string
}
export interface CycleCompare {
  generated_at: T
  anchors: CompareAnchor[]
  durations: { bull: { n: number; days: number; from: T; to: T }[]; bear: { n: number; days: number; from: T; to: T; probable?: boolean }[] }
  survival: Survival[]
  highlights: string[]; caveat: string
}

// GET /api/cycle/advanced/leverage
export interface PhaseRow {
  cycle: number; phase: PhaseKey; label: string; from: T; to: T; days: number
  funding_avg: N; funding_median: N; funding_pos_pct: N; funding_p90: N; spec_avg: N; current: boolean
}
export interface CycleLeverage {
  generated_at: T
  current: {
    phase: PhaseKey; phase_label: string; cycle: number; days_in_phase: number
    funding_7d: N; funding_30d: N; funding_pct_all: N; funding_pct_phase: N; funding_prev_cycle_phase_avg: N   // % annualizzato
    spec: N; spec_pct_all: N; spec_pct_phase: N; spec_prev_cycle_phase_avg: N                               // volume perp / spot (x)
    prev_cycle_same_day: { time: T; funding_30d: N; spec: N } | null
    oi_usd: N; leverage_ratio: N; leverage_pct_available: N; oi_days_available: number; oi_since: T | null   // leverage_ratio in % della market cap
  }
  text: string[]
  series: { funding: Pt[]; spec: Pt[]; price: Pt[]; oi_usd: Pt[]; leverage_ratio: Pt[] }   // funding = media 30 g, % annuo
  phases: { from: T; to: T; phase: PhaseKey }[]
  by_phase: PhaseRow[]
  by_phase_all: { phase: PhaseKey; label: string; days: number; funding_avg: N; funding_median: N; funding_pos_pct: N; spec_avg: N }[]
  limitations: string[]
  method: string
}

// GET /api/cycle/advanced  (riepilogo leggero, per widget e agenti)
export interface CycleAdvancedSummary {
  generated_at: T; price: number
  clock: Pick<ClockCurrent, 'time' | 'score' | 'score_equal' | 'zone' | 'zone_label' | 'change_7d' | 'change_30d' | 'change_90d' | 'text' | 'live'> & {
    components: Pick<ClockComponent, 'key' | 'label' | 'pct' | 'display' | 'weight'>[]
    spark: Pt[]; zones: Zone[]; mean_at_tops: N; mean_at_bottoms: N
  }
  miner: Pick<MinerCurrent, 'state' | 'label' | 'days_in_state' | 'ribbon_gap' | 'ribbon_compression' | 'hr_drawdown' | 'puell' | 'last_signal' | 'days_since_signal'> & { hit_rate_90: N }
  compare: { highlights: string[]; survival: Pick<Survival, 'phase' | 'label' | 'elapsed' | 'horizons' | 'remaining_median'>[] }
  leverage: Pick<CycleLeverage['current'], 'phase' | 'phase_label' | 'funding_7d' | 'funding_pct_all' | 'spec' | 'spec_pct_all' | 'leverage_ratio'>
  sections: string[]
}

async function get<R>(path: string): Promise<R> {
  const res = await fetch(`/api${path}`, { headers: { Accept: 'application/json' } })
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

const opts = { refetchInterval: 60_000, staleTime: 30_000, retry: 1, placeholderData: keepPreviousData } as const

export const useCycleAdvanced = () => useQuery({ queryKey: ['cycle-adv'], queryFn: () => get<CycleAdvancedSummary>('/cycle/advanced'), ...opts, refetchInterval: 60_000 })
export const useCycleClock = () => useQuery({ queryKey: ['cycle-adv', 'clock'], queryFn: () => get<CycleClock>('/cycle/advanced/clock'), ...opts })
export const useCycleMiner = () => useQuery({ queryKey: ['cycle-adv', 'miner'], queryFn: () => get<CycleMiner>('/cycle/advanced/miner'), ...opts })
export const useCycleCompare = () => useQuery({ queryKey: ['cycle-adv', 'compare'], queryFn: () => get<CycleCompare>('/cycle/advanced/compare'), ...opts })
export const useCycleLeverage = () => useQuery({ queryKey: ['cycle-adv', 'leverage'], queryFn: () => get<CycleLeverage>('/cycle/advanced/leverage'), ...opts })
