// Avvisi personalizzati — tipi (CONTRACT.md § CUSTOM ALERTS) + hook react-query.
// Le regole contengono testo scritto dall'utente (nome, nota): le richieste usano un oggetto URL invece di una stringa,
// così la patch globale di fetch NON aggiunge ?lang=en e il traduttore automatico del backend non tocca quei campi.
// Tutto il resto è fatto di codici e numeri, tradotti qui nel frontend.
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { ApiError } from './client'
import type { Alert, AlertSeverity } from './alerts'
import type { T } from './types'

export type RuleType = 'price_cross' | 'pct_move' | 'zone' | 'level_distance' | 'indicator' | 'cycle_zone' | 'timepivot' | 'candle_close' | 'liq_burst'
export type MetricKey = 'rsi_1h' | 'rsi_4h' | 'rsi_1d' | 'funding' | 'oi_change_1h' | 'oi_change_4h' | 'oi_change_24h' | 'fng' | 'cycle_score' | 'usdt_d' | 'usdt_d_change_7d'
export type MetricUnit = 'idx' | 'pct8h' | 'pct' | 'pt'
export type CycleZone = 'bottom' | 'accumulation' | 'mid' | 'euphoria' | 'top'
export type LevelId =
  | 'key_r1' | 'key_r2' | 'key_r3' | 'key_s1' | 'key_s2' | 'key_s3'
  | 'piv_d_P' | 'piv_d_R1' | 'piv_d_S1' | 'piv_w_P' | 'piv_w_R1' | 'piv_w_R2' | 'piv_w_S1' | 'piv_w_S2' | 'piv_m_P' | 'piv_m_R1' | 'piv_m_S1'
  | 'weekly_open' | 'monthly_open' | 'quarterly_open' | 'yearly_open' | 'prev_week_high' | 'prev_week_low' | 'prev_month_high' | 'prev_month_low'
  | 'monday_high' | 'monday_low' | 'monday_mid' | 'range_high' | 'range_mid' | 'range_low' | 'ath'
  | 'vwap_w' | 'vwap_w_up1' | 'vwap_w_dn1' | 'vwap_m' | 'vwap_m_up1' | 'vwap_m_dn1' | 'vwap_q' | 'vwap_q_up1' | 'vwap_q_dn1'
  | 'vwap_y' | 'vwap_y_up1' | 'vwap_y_dn1' | 'vwap_pw' | 'vwap_pm' | 'vwap_pq' | 'vwap_py'
  | 'vp_pw_poc' | 'vp_pw_vah' | 'vp_pw_val'

export type RuleParams =
  | { direction: 'above' | 'below'; price: number }                                   // price_cross
  | { direction: 'up' | 'down' | 'any'; pct: number; window_min: number }             // pct_move (5…1440 min)
  | { low: number; high: number; mode: 'enter' | 'exit' }                             // zone
  | { level: LevelId; pct: number }                                                   // level_distance
  | { metric: MetricKey; op: 'above' | 'below'; value: number }                       // indicator
  | { zone: 'any' | CycleZone }                                                       // cycle_zone
  | { min_confluence: number; lead_days: 0 | 1 | 3 | 7 }                              // timepivot
  | { tf: '1d' | '1w'; direction: 'above' | 'below'; price: number }                  // candle_close
  | { usd: number; window_min: number; side: 'any' | 'long' | 'short' }               // liq_burst (1…240 min)
export type AnyParams = Record<string, string | number>

export type RuleStatus = 'active' | 'paused' | 'expired' | 'triggered' | 'error'
export interface RuleInput {
  name: string; type: RuleType; params: AnyParams
  enabled: boolean; severity: AlertSeverity; cooldown_min: number; repeat: boolean
  expires_at: T | null; note: string
}
export interface AlertRule extends RuleInput {
  id: string; created_at: T; updated_at: T
  last_fired: T | null; fire_count: number
  status: RuleStatus; last_checked: T | null; next_check: T | null; cooldown_until: T | null
  current: { value: number | null; condition: boolean | null; error: string | null }
}
export interface RulesResponse {
  items: AlertRule[]; types: RuleType[]; levels: LevelId[]; metrics: Record<MetricKey, MetricUnit>
  tick_s: number; last_eval: T | null
}
export type PreviewReason = 'ready' | 'not_met' | 'pending_event' | 'cooldown' | 'already_fired' | 'disabled' | 'expired' | 'triggered' | 'no_data'
export interface RulePreview {
  value: number | null; threshold: number | null; condition: boolean | null; unit: string
  would_fire: boolean; reason: PreviewReason; checked_at: T; event?: boolean
  detail: Record<string, unknown>
}
export interface RuleMetrics {
  price: number | null; time: T
  metrics: Partial<Record<MetricKey | 'cycle_zone', number | string | null>>
  levels: Partial<Record<LevelId, { price: number; source: string | null; distance: number | null }>>
  timepivots: { id: string; start: T; end: T; confluence: number | null; expected: string | null; probability: number | null }[]
  liq_15m: number | null
  moves: Record<string, number | null>
  closes: Record<'1d' | '1w', { time: T | null; close: number | null }>
}

/** fetch with a URL object (skips the ?lang=en patch: user text must never be machine-translated). */
export async function rawJson<R>(method: string, path: string, body?: unknown): Promise<R> {
  const url = new URL(`/api${path}`, window.location.origin)
  const res = await fetch(url, {
    method, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

export const rulesApi = {
  list: () => rawJson<RulesResponse>('GET', '/alerts/rules'),
  metrics: () => rawJson<RuleMetrics>('GET', '/alerts/rules/metrics'),
  create: (r: RuleInput) => rawJson<AlertRule>('POST', '/alerts/rules', r),
  update: (id: string, r: Partial<RuleInput>) => rawJson<AlertRule>('PUT', `/alerts/rules/${encodeURIComponent(id)}`, r),
  remove: (id: string) => rawJson<{ ok: boolean }>('DELETE', `/alerts/rules/${encodeURIComponent(id)}`),
  test: (id: string) => rawJson<RulePreview>('POST', `/alerts/rules/${encodeURIComponent(id)}/test`),
  preview: (r: Pick<RuleInput, 'type' | 'params' | 'cooldown_min'>) => rawJson<RulePreview>('POST', '/alerts/rules/preview', r),
  /** generated alert texts: plain string URL so the backend translator applies (?lang=en) */
  history: async (limit = 100): Promise<{ items: Alert[] }> => {
    const res = await fetch(`/api/alerts?limit=${limit}&category=custom,journal`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new ApiError(res.status, res.statusText || `HTTP ${res.status}`)
    return res.json()
  },
}

export const useAlertRules = () =>
  useQuery({ queryKey: ['alertRules'], queryFn: rulesApi.list, refetchInterval: 20_000, placeholderData: keepPreviousData, retry: 1 })
export const useRuleMetrics = (enabled = true) =>
  useQuery({ queryKey: ['alertRules', 'metrics'], queryFn: rulesApi.metrics, refetchInterval: 15_000, enabled, placeholderData: keepPreviousData, retry: 1 })
export const useCustomAlertHistory = () =>
  useQuery({ queryKey: ['alerts', 'custom'], queryFn: () => rulesApi.history(100), refetchInterval: 30_000, placeholderData: keepPreviousData, retry: 1 })

export function useRuleMutations() {
  const qc = useQueryClient()
  const done = () => { qc.invalidateQueries({ queryKey: ['alertRules'] }) }
  return {
    create: useMutation({ mutationFn: rulesApi.create, onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, r }: { id: string; r: Partial<RuleInput> }) => rulesApi.update(id, r), onSuccess: done }),
    remove: useMutation({ mutationFn: rulesApi.remove, onSuccess: done }),
  }
}
