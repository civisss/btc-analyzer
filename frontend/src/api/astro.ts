// Astronomia e numeri — tipi (vedi CONTRACT.md § ASTRO) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Candle, T } from './types'

type N = number | null

export type HypId =
  | 'moon_full' | 'moon_new' | 'moon_halves' | 'supermoon' | 'lunar_eclipse_total' | 'lunar_eclipse_all' | 'solar_eclipse'
  | 'mercury_retro' | 'seasons' | 'friday13' | 'geomag_storm' | 'solar_cycle'
  | 'round_major' | 'round_minor' | 'gann_sq9' | 'fib_price' | 'fib_time'
export type HypGroup = 'luna' | 'eclissi' | 'pianeti' | 'sole' | 'numeri'
export type Verdict = 'none' | 'weak' | 'strong' | 'anecdotal'
/** '%' = rendimento cumulato della finestra · 'pp/g' = punti % al giorno · 'pp' = punti percentuali di frequenza · 'r' = correlazione */
export type HypUnit = '%' | 'pp/g' | 'pp' | 'r'

export interface SubEffect { effect: N; n: number }
export interface Hypothesis {
  id: HypId; group: HypGroup
  metric: 'window_ret' | 'daily_diff' | 'corr' | 'reject_rate' | 'hit_rate'
  unit: HypUnit
  window: [number, number] | null     // finestra [a, b] in giorni rispetto all'evento (solo studi di evento)
  n: number                           // eventi (giorni nel periodo per 'daily_diff', tocchi per i livelli, mesi per 'corr')
  n_events?: number                   // episodi indipendenti per i test a periodi (cicli lunari, periodi retrogradi)
  observed: N; baseline: N            // valore negli eventi / valore di controllo
  effect: N                           // observed − baseline (per 'corr' = r)
  ci: [N, N]                          // IC 95% bootstrap dell'effetto
  p: N; p_bh: N                       // p placebo (bilaterale) e p corretto Benjamini-Hochberg su tutte le ipotesi
  naive_p?: N                         // solo solar_cycle: p del test t classico (ignora l'autocorrelazione)
  null: { q05: N; q95: N }            // banda 90% dell'effetto sotto il placebo
  vol_ratio?: N; vol_p?: N            // |rendimento| medio nella finestra ÷ normale, e p placebo
  up_rate?: N; up_base?: N            // % finestre in rialzo vs tutte le finestre
  dd?: N; dd_base?: N                 // drawdown medio nella finestra vs normale (%)
  median?: N
  halves: SubEffect[]                 // prima / seconda metà del campione
  cycles: (SubEffect & { label: string })[]   // per ciclo dell'halving (label = anno di inizio)
  stable: boolean
  verdict: Verdict
  values?: { time: T; ret: N }[]      // rendimento della finestra per ogni evento
  control_hist?: { x: N; n: number }[]          // livelli: distribuzione del tasso nelle griglie di controllo (centrata)
  touch_days?: number
  ratios_hist?: { x: N; n: number }[]           // Fibonacci: istogramma dei rapporti osservati
  levels?: number[]; tolerance?: N
  solar_cycles_in_sample?: N
}

export type MoonPhaseKey = 'new' | 'waxing_crescent' | 'first_quarter' | 'waxing_gibbous' | 'full' | 'waning_gibbous' | 'last_quarter' | 'waning_crescent'
export type AstroEventKey =
  | 'full' | 'new' | 'supermoon' | 'lunar_eclipse_total' | 'lunar_eclipse' | 'solar_eclipse' | 'mercury_retro_start' | 'mercury_retro_end'
  | 'mar_equinox' | 'jun_solstice' | 'sep_equinox' | 'dec_solstice' | 'friday13' | 'geomag_storm'
export type EclipseKind = 'penumbral' | 'partial' | 'annular' | 'total' | 'hybrid'

export interface AstroUpcoming {
  id: string; key: AstroEventKey; time: T; hyp: HypId | null
  n: N; observed: N; baseline: N; effect: N; up_rate: N; up_base: N; unit: HypUnit | null
  p: N; p_bh: N; verdict: Verdict | null; window: [number, number] | null
  kind?: EclipseKind; distance_km?: N; kp?: N
}

export interface EventRow { time: T; ret7: N; ret30: N }   // ret7 = rendimento −3..+3 g · ret30 = rendimento dei 30 g successivi (log %)

export interface AstroResponse {
  generated_at: T; today: T; price: number; horizon: number
  sample: { start: T; end: T; days: number; cycles: { label: string; start: T; end: T }[] }
  hypotheses: Hypothesis[]
  moon: {
    now: { time: T; illum: number; phase_angle: number; elongation: number; age_days: number; distance_km: number; waxing: boolean; phase: MoonPhaseKey }
    prev_new: T | null
    next: { key: 'new' | 'first_quarter' | 'full' | 'last_quarter'; time: T; supermoon: boolean; distance_km: N }[]
    profile: { day: number; deg: number; mean: N; lo: N; hi: N; placebo_lo: N; placebo_hi: N; n: number }[]
    paths: Record<'full' | 'new', { day: number; mean: N; placebo_lo: N; placebo_hi: N; placebo_mid: N }[]>
    events: { time: T; key: 'full' | 'new'; supermoon: boolean }[]
  }
  eclipses: {
    lunar: (EventRow & { kind: EclipseKind; obscuration: N; total_min: N })[]
    solar: (EventRow & { kind: EclipseKind; obscuration: N; lat: N; lon: N })[]
  }
  supermoons: (EventRow & { distance_km: N })[]
  mercury: {
    periods: { start: T; end: T; ret: N; days: N }[]      // ret = variazione % di BTC durante il periodo (null se futuro)
    now: { retro: boolean; start: T | null; end: T | null; next_start: T | null; next_end: T | null }
  }
  seasons: (EventRow & { key: 'mar_equinox' | 'jun_solstice' | 'sep_equinox' | 'dec_solstice' })[]
  solar: {
    monthly: { time: T; ssn: N; smooth: N; close: N; ret12: N }[]
    predicted: { time: T; ssn: N; lo: N; hi: N }[]
    solar_extrema?: { kind: 'min' | 'max'; time: T; ssn: N }[]
    btc_peaks?: { time: T; price: N }[]
  }
  geomag: {
    now: { time: T; kp: N } | null
    recent: { time: T; kp: N }[]; forecast: { time: T; kp: N }[]
    storms: { time: T; kp: N; ap: N; ret6: N }[]
    storms_year: { year: number; days_g1: number; days_g3: number }[]
    threshold: number
  }
  numbers: {
    milestones: {
      powers: { level: number; time: T | null; days_from_prev: number | null }[]
      repdigits: { level: number; time: T | null }[]
      palindromes: { time: T; price: N; ret30: N; future: boolean }[]
    }
    bitcoin: {
      max_supply: number; halving_interval: number; block_target_s: number; retarget_blocks: number; sats_per_btc: number
      genesis: T; pizza_day: T; pizza_btc: number
      halvings: { n: number; time: T; block: number; subsidy_after: number }[]
      next_halving_block: number; next_halving_eta: T; height: N; blocks_left: N
      sats_per_usd: N; pizza_usd: N
      issued?: number; issued_pct?: number; subsidy?: number; epoch?: number
    }
  }
  upcoming: AstroUpcoming[]
  candles: Candle[]
  verification: {
    generated_at: T; range: [number, number]
    checks: { id: string; source: string; url: string; range: string; n: number; mean_abs_min?: number; median_abs_min?: number; max_abs_min?: number
              missing?: number; extra?: number; type_match?: number; n_ref?: number; mean_abs_km?: number; max_abs_km?: number
              classification_flips?: number; mean_abs_ssn?: number; max_abs_ssn?: number; note?: string }[]
  } | null
  constants: { supermoon_km: number; synodic_days: number; alpha: number; min_n: number; min_shift: number; n_boot: number; n_ctrl: number }
}

export async function fetchAstro(horizon = 90): Promise<AstroResponse> {
  const res = await fetch(`/api/astro?horizon=${horizon}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<AstroResponse>
}

export const useAstro = (horizon = 90) =>
  useQuery({ queryKey: ['astro', horizon], queryFn: () => fetchAstro(horizon), refetchInterval: 15 * 60_000, staleTime: 5 * 60_000, retry: 1, placeholderData: keepPreviousData })
