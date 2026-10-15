// Superchart + anomalie — tipi (CONTRACT.md § SUPERCHART) e hook react-query.
// Query key roots: 'superchart' (realtime.ts: '/superchart'), 'anomalies' ('/anomalies').
// Fetch senza ?lang: le risposte contengono solo codici e numeri (le etichette sono tradotte dal frontend).
import { useMemo } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T } from './types'

type N = number | null
export type ScTf = '15m' | '1h' | '4h' | '1d' | '1w'
export type ScGroup = 'price' | 'derivatives' | 'flows' | 'onchain' | 'macro'
export type ScUnit = 'usd' | 'btc' | 'idx' | 'pct' | 'pct_8h' | 'ratio' | 'musd' | 'busd' | ''

export interface ScIndicator {
  id: string; group: ScGroup; cols: string[]; place: 'pane' | 'overlay'
  anom: boolean; anom_how: 'level' | 'pct' | 'diff' | 'log' | 'log1p' | null
  unit: ScUnit; source: string
  res: number          // native resolution (s); 0 = chart timeframe / events
  lag: number          // publication delay beyond the end of the observed period (s)
  na_tf: ScTf[]; cum: string[]
}
/** One pane of a layout: h = height px (0 for overlays), an = anomaly markers, ov = drawn on the price chart */
export interface ScPaneState { id: string; h: number; an: boolean; ov: boolean }
export interface ScState { tf: ScTf; log: boolean; panes: ScPaneState[] }
export interface ScPreset extends ScState { id: 'essential' | 'derivatives' | 'onchain' | 'macro' }
export interface ScCatalog { indicators: ScIndicator[]; presets: ScPreset[]; tfs: ScTf[]; default_bars: Record<ScTf, number>; max_bars: number }

/** [bar index in the window, z, raw value, transformed value, rolling median of the transformed value, observation time] */
export type ScAnomaly = [number, number, N, N, N, T]
export interface ScSeries {
  cols: Record<string, N[]>          // aligned with ScData.t
  obs?: (T | null)[]                 // observation time of the value shown on each bar (series repeated until the next value)
  first: T | null; last: T | null    // first / last native observation
  anomalies: ScAnomaly[]
  ms: number
}
export interface ScData {
  tf: ScTf; step: number; source: string; asof: T | null; now: T; thr: number
  window: { i0: number; i1: number; total: number; first: T | null; last: T | null }
  t: T[]; close_t: T[]
  candles?: { o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }
  series: Record<string, ScSeries>
  errors: Record<string, string>
  ms: number
}
export interface ScLayout { id: string; name: string; state: ScState; created_at: T; updated_at: T }

// ------------------------------------------------------------------ anomalies (GET /api/anomalies)
export type AnVerdict = 'strong' | 'weak' | 'none' | 'anecdotal'
export interface AnMetric { mean: N; median: N; ci: [N, N]; base: N; diff: N; p: N; p_bh: N; up: N; verdict: AnVerdict }
export interface AnTypeRow {
  id: string; type: AnType; sign: 1 | -1; unit?: string; available: boolean; lag_s?: number
  sample_from?: T | null; sample_to?: T | null; n_events?: number; last_event?: T | null; n: number
  horizons: { h: number; n: number; ret: AnMetric; vol: AnMetric }[]
  verdict: AnVerdict; headline: { h: number; metric: 'ret' | 'vol' } | null
}
export type AnType = 'funding' | 'oi' | 'liq_long' | 'liq_short' | 'volume' | 'etf' | 'exchange'
export interface AnRecent { type: AnType; sign: 1 | -1; id: string; time: T; avail: T; value: number; x: number; how: string; z: number; unit: string }
export interface Anomalies {
  params: { thr: number; window: number; gap_days: number; horizons: number[]; min_n: number; n_mc: number; n_boot: number; tests: number; recent_days: number }
  types: AnTypeRow[]; recent: AnRecent[]; generated_at: T; compute_ms: number
}

async function req<R>(path: string, init?: RequestInit): Promise<R> {
  const res = await fetch(`/api${path}`, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } })
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

export const useScCatalog = () =>
  useQuery({ queryKey: ['superchart', 'catalog'], queryFn: () => req<ScCatalog>('/superchart/catalog'), staleTime: 3_600_000 })

export interface ScQuery { tf: ScTf; ids: string[]; to: T | null; bars?: number; z: number; live: boolean }
export const scKey = (q: ScQuery) => ['superchart', 'series', q.tf, [...q.ids].sort().join(','), q.to, q.bars ?? null, q.z] as const
export const useScData = (q: ScQuery) =>
  useQuery({
    queryKey: scKey(q),
    queryFn: () => req<ScData>(`/superchart/series?tf=${q.tf}&ids=${encodeURIComponent([...q.ids].sort().join(','))}&z=${q.z}`
      + (q.to != null ? `&to=${q.to}` : '') + (q.bars ? `&bars=${q.bars}` : '')),
    placeholderData: keepPreviousData, retry: 1, staleTime: 20_000,
    refetchInterval: q.live ? 60_000 : false,
  })

/** Anomaly days of one indicator (daily bars, |z| ≥ z) for the "Anomalie" toggle on the classic charts; fetched only when `on`. */
export type AnomalyMark = { time: T; z: number }
export function useAnomalyMarks(id: string, on: boolean, z = 3): { marks: AnomalyMark[]; loading: boolean } {
  const q = useQuery({
    queryKey: ['superchart', 'series', '1d', id, null, 1500, z] as const,
    queryFn: () => req<ScData>(`/superchart/series?tf=1d&ids=${encodeURIComponent(id)}&z=${z}&bars=1500`),
    enabled: on, staleTime: 10 * 60_000, retry: 1,
  })
  const marks = useMemo(() => {
    const d = q.data
    if (!on || !d) return []
    return (d.series[id]?.anomalies ?? []).map((a) => ({ time: d.t[a[0]], z: a[1] })).filter((m) => m.time != null)
  }, [q.data, id, on])
  return { marks, loading: on && q.isFetching && !q.data }
}

export const useAnomalies = (z: number) =>
  useQuery({ queryKey: ['anomalies', z], queryFn: () => req<Anomalies>(`/anomalies?z=${z}`), staleTime: 60_000, refetchInterval: 10 * 60_000, retry: 1, placeholderData: keepPreviousData })

export const useScLayouts = () =>
  useQuery({ queryKey: ['superchart', 'layouts'], queryFn: () => req<{ layouts: ScLayout[] }>('/superchart/layouts'), staleTime: 60_000 })

export function useScLayoutMutations() {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['superchart', 'layouts'] })
  return {
    create: useMutation({ mutationFn: (b: { name: string; state: ScState }) => req<ScLayout>('/superchart/layouts', { method: 'POST', body: JSON.stringify(b) }), onSuccess: done }),
    update: useMutation({ mutationFn: (b: { id: string; name?: string; state?: ScState }) => req<ScLayout>(`/superchart/layouts/${b.id}`, { method: 'PUT', body: JSON.stringify({ name: b.name, state: b.state }) }), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => req<{ ok: boolean }>(`/superchart/layouts/${id}`, { method: 'DELETE' }), onSuccess: done }),
  }
}
