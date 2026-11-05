// Segnali BTC seguiti sulla carta: tipi (CONTRACT.md § SIGNALS) e hook react-query.
// fetch con un oggetto URL: la patch globale non aggiunge ?lang=en. Le API danno chiavi e numeri, i testi li compone il frontend.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Candle } from './types'

export type SignalSide = 'long' | 'short'
export type SignalTf = '15m' | '1h' | '4h' | '1d'
export type SignalFamily = 'low' | 'high'
export type SignalTier = 'validated' | 'experimental' | 'off'
export type SignalStatus = 'pending' | 'active' | 'closed'
export type SignalOutcome = 'tp2' | 'sl' | 'be' | 'timeout' | 'invalidated' | 'expired' | 'canceled'
export type SignalEventType = 'emitted' | 'active' | 'tp1' | 'leave' | SignalOutcome

export interface SignalEvent { type: SignalEventType; time: number; price: number | null; rebuilt: boolean; rec: number; r?: number | null }
export interface SignalReason { k: string; v: Record<string, number | string | null> }
export interface SignalContext {
  trend: number; vol: number | null; adx: number | null; atr: number | null; atr_pct: number | null; vwap: number | null; sigma: number | null
  funding: number | null; funding_z: number | null; oi7: number | null; close: number; anchor: string
}
export interface Signal {
  id: string; setup: string; tf: SignalTf; family: SignalFamily; side: SignalSide; kind: 'market' | 'limit'; tier: SignalTier
  entry: number; sl: number; tp1: number; tp2: number; inv: number | null; rr1: number; rr2: number; risk_pct: number
  emitted_at: number; pending_until: number; exit_by: number
  reasons: SignalReason[]; context: SignalContext; reason_verdict: string | null
  bt: { n: number | null; mean_r: number | null; win_rate: number | null }
  status: SignalStatus; outcome: SignalOutcome | null; tp1_hit: boolean; rebuilt: boolean; comment: string | null
  events: SignalEvent[]; last_event: SignalEvent | null
  fill?: number; fill_t?: number; exit_t?: number; exit_px?: number | null
  r?: number | null; gross_pct?: number | null; funding_pct?: number | null; cost_pct?: number | null; open_r?: number | null
}
export interface SignalDetail extends Signal { candles: Candle[] }
export interface SignalsOverview {
  time: number; price: number | null; open: Signal[]; recent: Signal[]
  enabled: { setup: string; tf: SignalTf; family: SignalFamily; side: SignalSide; tier: SignalTier }[]
  summary: { validated: number; dev_passed: number; tested: number } | null
  backtest_ready: boolean; backtest_running: boolean
  tiers: Record<SignalTier, number>; ml_active: boolean
  agent: { last_tick: number | null; last_eval: Record<string, number>; bars: number }
  integrity: { ok: boolean; rows: number; broken_at: number | null }; total: number
}
export interface SignalsHistory { items: Signal[]; total: number; setups: string[] }

export interface PerfBlock { n: number; win_rate: number | null; mean_r: number | null; total_r: number; pf: number | null; max_dd_r: number }
export interface PerfCurve extends PerfBlock { curve: { time: number; value: number; id: string }[] }
export type PerfGroup = PerfBlock & { key: string }
export interface SignalsPerformance {
  all: PerfCurve; validated: PerfCurve; experimental: PerfCurve
  by_setup: PerfGroup[]; by_tf: PerfGroup[]; by_family: PerfGroup[]; by_side: PerfGroup[]
  counts: { emitted: number; open: number; closed: number; never_filled: number; rebuilt: number }
  first: number | null; costs: { fee_pct: number; slip_pct: number; cost_pct: number }
}

export interface BtStats {
  n: number; win_rate: number | null; mean_r: number | null; total_r: number; pf: number | null; max_dd_r: number; ci: [number | null, number | null]; tp1_rate: number | null
  by_year: { year: number; n: number; mean_r: number }[]; by_regime: { regime: string; n: number; mean_r: number }[]
  p?: number | null; q?: number | null; q_all?: number | null; pool_mean_r?: number | null
}
export interface BtRow {
  setup: string; tf: SignalTf; family: SignalFamily; side: SignalSide; params: Record<string, unknown>; n_grid: number
  wf: BtStats; dev: BtStats; holdout: BtStats; post: BtStats; curve: [number, number][]; verdict: 'validated' | 'experimental'; reason: string; tier: SignalTier
}
export interface MlBlock {
  n: number; kept?: number; rules_mean_r?: number; filtered_mean_r?: number | null; brier?: number; brier_base?: number; ece?: number | null; base_rate?: number; auc?: number | null
  delta?: number; delta_ci?: [number, number]; reliability?: { p: number; obs: number; n: number }[]
}
export interface SignalsBacktest {
  status: 'ok' | 'computing' | 'missing'; generated_at?: number; data_to?: number; rows: BtRow[]; frozen_ok?: boolean
  protocol: {
    dev_from: number; dev_end: number; wf_years: number[]; holdout_start: number; freeze: number; min_n_fit: number; min_n_dev: number; min_n_hold: number; q_max: number; min_years_pos: number
    fee_pct: number; slip_pct: number; cost_pct: number; tp1_fraction: number; min_risk_pct: number; hypotheses: number; trials: number; pool: number; mc: number
  }
  resolution_check: { n: number; mean_diff_r: number; mean_abs_diff_r: number; changed_pct: number } | null
  ml: { kept: boolean; reason: string; n: number; features: string[]; dev: MlBlock; holdout: MlBlock; holdout_passed_dev: MlBlock; ece_max: number }
  summary: { validated: number; dev_passed: number; tested: number }
}

async function get<R>(path: string, params?: Record<string, string | undefined>): Promise<R> {
  const u = new URL(`/api${path}`, window.location.origin)
  for (const [k, v] of Object.entries(params ?? {})) if (v) u.searchParams.set(k, v)
  const res = await fetch(u, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new ApiError(res.status, res.statusText)
  return res.json() as Promise<R>
}

export const useSignals = () =>
  useQuery({ queryKey: ['signals', 'overview'], queryFn: () => get<SignalsOverview>('/signals'), refetchInterval: 60_000, staleTime: 15_000 })
export const useSignalHistory = (f: Record<string, string | undefined>) =>
  useQuery({ queryKey: ['signals', 'history', f], queryFn: () => get<SignalsHistory>('/signals/history', f), refetchInterval: 120_000, staleTime: 30_000, placeholderData: keepPreviousData })
export const useSignalPerformance = () =>
  useQuery({ queryKey: ['signals', 'performance'], queryFn: () => get<SignalsPerformance>('/signals/performance'), refetchInterval: 120_000, staleTime: 30_000 })
export const useSignalBacktest = () =>
  useQuery({ queryKey: ['signals', 'backtest'], queryFn: () => get<SignalsBacktest>('/signals/backtest'), staleTime: 600_000 })
export const useSignalDetail = (id: string | null) =>
  useQuery({ queryKey: ['signals', 'detail', id], queryFn: () => get<SignalDetail>(`/signals/${encodeURIComponent(id ?? '')}`), enabled: !!id, staleTime: 30_000, refetchInterval: 60_000 })
