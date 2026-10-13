// Analoghi spiegabili — tipi (vedi CONTRACT.md § ANALOGS) + hook react-query.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'
import type { T, Tone } from './types'

export type AnalogTf = '1h' | '4h' | '1d' | '1w'

export type AnalogCandle = { time: T; open: number; high: number; low: number; close: number; volume?: number | null }

export interface AnalogFeature {
  key: string
  label: string
  current: number | null
  analog: number | null
  display_current: string
  display_analog: string
  unit: string
  similarity: number | null // 0..100, null = non disponibile
  weight: number
  explanation: string
}

export interface AnalogPoint { time: T; price: number; idx: number; pct: number }
export interface AnalogMapping {
  n: number
  kind: 'start' | 'end' | 'high' | 'low'
  label: string
  analog_label: string
  same_role: boolean
  current: AnalogPoint
  analog: AnalogPoint
  note: string
}

export interface AnalogLeg {
  n: number
  label: string // 'G1'… (analogo: numero della gamba attuale abbinata, '–' se nessuna)
  from_idx: number; to_idx: number; from_time: T; to_time: T
  from_price: number; to_price: number; pct: number; candles: number
}
export interface AnalogLegPair { current: number; analog: number; similarity: number; text: string }

export interface PatternPoint { idx: number; time: T; price: number; label?: string }
export interface ChartPattern {
  key: string
  name: string // italiano
  family: string
  tone: Tone
  confidence: number // 0..100
  lines: { kind: 'resistance' | 'support' | 'neckline' | 'pole' | 'leg'; points: PatternPoint[] }[]
  points: PatternPoint[]
}

export interface VisualComponent { key: 'shape' | 'candles' | 'legs' | 'pattern' | 'volume' | 'volatility'; label: string; score: number | null; weight: number; explanation: string }

export interface AnalogMatch {
  rank: number
  period: { start: T; end: T; label: string; when: string }
  similarity: number
  visual_similarity: number
  shape_similarity: number
  feature_similarity: number
  correlation: number
  dtw: number
  dtw_score: number
  visual: { score: number; components: VisualComponent[] }
  patterns: { current: ChartPattern[]; analog: ChartPattern[]; common: string | null; common_name: string | null; text: string; score: number }
  legs_current: AnalogLeg[]
  legs_analog: AnalogLeg[]
  leg_pairs: AnalogLegPair[]
  features: AnalogFeature[]
  mapping: AnalogMapping[]
  narrative: string[]
  narrative_llm: string | null
  outcome: { candles: number; change: number | null; max_up: number | null; max_down: number | null; end_time: T | null }
  candles: AnalogCandle[] // finestra analoga + `horizon` candele successive
  projection: { times: T[]; close: number[] } // futuro dell'analogo riscalato al prezzo attuale
}

export interface Analogs {
  tf: AnalogTf
  window: number
  horizon: number
  top: number
  generated_at: T
  current: { start: T; end: T; label: string; close: number; base_close: number; candles: AnalogCandle[] }
  summary: {
    count: number; up: number; down: number; agreement: number | null
    median_outcome: number | null; weighted_outcome: number | null; best_similarity: number | null
    bias: Tone; text: string
  }
  matches: AnalogMatch[]
  method: string
}

export type AnalogParams = { tf: AnalogTf; window: number; top: number; horizon?: number }

export async function fetchAnalogs(p: AnalogParams): Promise<Analogs> {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v !== undefined) s.set(k, String(v))
  const res = await fetch(`/api/analogs?${s}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<Analogs>
}

export const useAnalogs = (p: AnalogParams) =>
  useQuery({
    queryKey: ['analogs', p],
    queryFn: () => fetchAnalogs(p),
    refetchInterval: p.tf === '1h' ? 30_000 : 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })
