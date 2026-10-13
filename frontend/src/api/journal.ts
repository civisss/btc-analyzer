// Diario di studio — tipi (CONTRACT.md § JOURNAL) + hook react-query.
// Note e annotazioni contengono testo dell'utente: richieste via rawJson (niente ?lang=en → nessuna traduzione automatica).
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { rawJson } from './alertRules'
import type { Tf, T } from './types'

export type ViewDir = 'up' | 'down' | 'neutral'
export type Horizon = 7 | 30 | 90
export type Outcome = 'hit' | 'miss' | 'pending'

export interface Snapshot {
  time: T; price: number | null
  cycle: { phase: string | null; phase_confidence: number | null; days_since_halving: number | null; score: number | null; zone: string | null; score_change_30d: number | null } | null
  levels: { tag: string; price: number; kind: 'support' | 'resistance'; source: string }[] | null
  structure: { state: string | null; range_high: number | null; range_low: number | null; range_mid: number | null } | null
  analogs: { bias: string | null; median_outcome: number | null; up: number | null; down: number | null; count: number | null; horizon: number | null } | null
  fractals: { bias: string | null; up_prob: number | null; tf: string | null; horizon: number | null } | null
  forecast: { targets: { days: number; low: number; high: number; median: number; up_prob: number }[]; median_7d: number | null; median_30d: number | null; median_90d: number | null; delayed_s?: number } | null
  derivatives: { funding: number | null; oi_usd: number | null; oi_change_24h: number | null } | null
  sentiment: { value: number; time: T } | null
  usdt: { usdt_d: number | null; change_7d: number | null } | null
  timepivots: { id: string; start: T; end: T; confluence: number | null; expected: string | null; probability: number | null; active: boolean }[] | null
  missing: string[]
}
export interface Review {
  due_at: T; reviewed_at: T; price_start: number; price_end: number; change_pct: number
  max_up_pct: number | null; max_down_pct: number | null; band_pct: number
  outcome: 'up' | 'down' | 'flat'; view: ViewDir; hit: boolean
  forecast_check: { median: number; low: number | null; high: number | null; up_prob: number | null; inside: boolean; median_error_pct: number } | null
  context_now?: Snapshot | null
  notified?: T
}
export interface NoteInput { title: string; body: string; tags: string[]; direction: ViewDir | null; horizon: Horizon | null }
export interface Note extends NoteInput {
  id: string; created_at: T; updated_at: T; price: number | null
  snapshot: Snapshot; review: Review | null
  due_at: T | null; outcome: Outcome | null; view_editable: boolean
}
export interface NotesResponse { items: Note[]; tags: { tag: string; count: number }[]; total: number }
export interface ReviewsResponse {
  items: { note_id: string; title: string; tags: string[]; direction: ViewDir; horizon: Horizon; created_at: T; review: Review }[]
  upcoming: { note_id: string; title: string; direction: ViewDir; horizon: Horizon; created_at: T; due_at: T; price: number | null; overdue: boolean }[]
  stats: {
    total: number; hits: number; hit_rate: number | null; pending: number
    by_horizon: { horizon: Horizon; total: number; hits: number; hit_rate: number | null }[]
    by_direction: { direction: ViewDir; total: number; hits: number; hit_rate: number | null; avg_change: number | null }[]
    series: { time: T; value: number; hit: boolean }[]
  }
  bands: Record<string, number>
}

export type AnnKind = 'hline' | 'trendline' | 'vline' | 'text'
export type AnnColor = 'slate' | 'blue' | 'violet' | 'teal' | 'amber' | 'btc'
export interface AnnotationInput {
  kind: AnnKind; symbol?: string; tf: Tf | null   // null = visible on every timeframe
  points: { time: T | null; price: number | null }[]   // hline: [{price}] · vline: [{time}] · text: [{time, price}] · trendline: 2 points
  text: string; color: AnnColor; extend?: boolean
}
export interface Annotation extends AnnotationInput { id: string; symbol: string; created_at: T; updated_at: T }

export const journalApi = {
  notes: (p: { tag?: string; outcome?: string; q?: string }) => {
    const s = new URLSearchParams()
    if (p.tag) s.set('tag', p.tag)
    if (p.outcome) s.set('outcome', p.outcome)
    if (p.q) s.set('q', p.q)
    const qs = s.toString()
    return rawJson<NotesResponse>('GET', `/journal/notes${qs ? `?${qs}` : ''}`)
  },
  snapshot: () => rawJson<Snapshot>('GET', '/journal/snapshot'),
  create: (n: NoteInput) => rawJson<Note>('POST', '/journal/notes', n),
  update: (id: string, n: Partial<NoteInput>) => rawJson<Note>('PUT', `/journal/notes/${encodeURIComponent(id)}`, n),
  remove: (id: string) => rawJson<{ ok: boolean }>('DELETE', `/journal/notes/${encodeURIComponent(id)}`),
  reviews: () => rawJson<ReviewsResponse>('GET', '/journal/reviews'),
  annotations: (tf: Tf, symbol = 'BTCUSDT') => rawJson<{ items: Annotation[] }>('GET', `/journal/annotations?symbol=${symbol}&tf=${tf}`),
  createAnn: (a: AnnotationInput) => rawJson<Annotation>('POST', '/journal/annotations', a),
  updateAnn: (id: string, a: Partial<AnnotationInput>) => rawJson<Annotation>('PUT', `/journal/annotations/${encodeURIComponent(id)}`, a),
  removeAnn: (id: string) => rawJson<{ ok: boolean }>('DELETE', `/journal/annotations/${encodeURIComponent(id)}`),
}

export const useNotes = (p: { tag?: string; outcome?: string; q?: string }) =>
  useQuery({ queryKey: ['journal', 'notes', p], queryFn: () => journalApi.notes(p), refetchInterval: 60_000, placeholderData: keepPreviousData, retry: 1 })
export const useReviews = () =>
  useQuery({ queryKey: ['journal', 'reviews'], queryFn: journalApi.reviews, refetchInterval: 60_000, placeholderData: keepPreviousData, retry: 1 })
export const useSnapshotPreview = (enabled: boolean) =>
  useQuery({ queryKey: ['journal', 'snapshot'], queryFn: journalApi.snapshot, enabled, staleTime: 30_000, refetchInterval: enabled ? 60_000 : false, retry: 1 })
export const useAnnotations = (tf: Tf) =>
  useQuery({ queryKey: ['journal', 'annotations', tf], queryFn: () => journalApi.annotations(tf), placeholderData: keepPreviousData, retry: 1 })

export function useJournalMutations() {
  const qc = useQueryClient()
  const done = () => { qc.invalidateQueries({ queryKey: ['journal'] }) }
  return {
    create: useMutation({ mutationFn: journalApi.create, onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, n }: { id: string; n: Partial<NoteInput> }) => journalApi.update(id, n), onSuccess: done }),
    remove: useMutation({ mutationFn: journalApi.remove, onSuccess: done }),
    createAnn: useMutation({ mutationFn: journalApi.createAnn, onSuccess: done }),
    updateAnn: useMutation({ mutationFn: ({ id, a }: { id: string; a: Partial<AnnotationInput> }) => journalApi.updateAnn(id, a), onSuccess: done }),
    removeAnn: useMutation({ mutationFn: journalApi.removeAnn, onSuccess: done }),
  }
}
