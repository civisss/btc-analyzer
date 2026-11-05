// Avvisi — tipi (vedi CONTRACT.md § ALERTS) + hook react-query per lo storico.
// I toast live arrivano sul WebSocket condiviso /api/ws come { type: 'toast', ...Alert }.
import { useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertCategory = 'price' | 'levels' | 'liquidity' | 'derivatives' | 'time' | 'cycle' | 'onchain' | 'stablecoins'
  | 'macro' | 'agents' | 'events' | 'test' | 'custom'

export interface Alert {
  id: number; time: T
  severity: AlertSeverity
  category: AlertCategory; category_label: string
  title: string        // ≤ 60 caratteri
  text: string         // 1–2 righe
  link: string         // rotta frontend da aprire, es. "/liquidazioni", "/cicli?tab=clock"
  data: Record<string, unknown>
  rule: string; key?: string
  silent: boolean      // true = solo storico (budget anti-spam superato), nessun toast
}
/** Messaggio WebSocket: { type: 'toast', ...Alert } (mai con silent=true). */
export type ToastMsg = { type: 'toast' } & Alert

export interface AlertRuleInfo { rule: string; category: string; severity: string; threshold: string; cooldown: string }
export interface AlertsResponse {
  items: Alert[]                // più recenti prima
  running: boolean; started_at: T | null; last_eval: T | null; evals: number
  errors: Record<string, string>
  rules: AlertRuleInfo[]
  thresholds: Record<string, number>
}

export async function fetchAlerts(limit = 50, severity?: AlertSeverity): Promise<AlertsResponse> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (severity) q.set('severity', severity)
  const res = await fetch(`/api/alerts?${q}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail) } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<AlertsResponse>
}

export const useAlerts = (limit = 50, severity?: AlertSeverity) =>
  useQuery({ queryKey: ['alerts', limit, severity], queryFn: () => fetchAlerts(limit, severity), refetchInterval: 60_000, staleTime: 20_000, retry: 1 })
