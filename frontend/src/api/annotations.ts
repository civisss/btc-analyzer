// Annotazioni del grafico: contengono testo dell'utente, richieste via rawJson (niente ?lang=en → nessuna traduzione automatica).
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { rawJson } from './alertRules'
import type { Tf, T } from './types'

export type AnnKind = 'hline' | 'trendline' | 'vline' | 'text'
export type AnnColor = 'slate' | 'blue' | 'violet' | 'teal' | 'amber' | 'btc'
export interface AnnotationInput {
  kind: AnnKind; symbol?: string; tf: Tf | null   // null = visible on every timeframe
  points: { time: T | null; price: number | null }[]   // hline: [{price}] · vline: [{time}] · text: [{time, price}] · trendline: 2 points
  text: string; color: AnnColor; extend?: boolean
}
export interface Annotation extends AnnotationInput { id: string; symbol: string; created_at: T; updated_at: T }

export const annotationsApi = {
  list: (tf: Tf, symbol = 'BTCUSDT') => rawJson<{ items: Annotation[] }>('GET', `/annotations?symbol=${symbol}&tf=${tf}`),
  create: (a: AnnotationInput) => rawJson<Annotation>('POST', '/annotations', a),
  update: (id: string, a: Partial<AnnotationInput>) => rawJson<Annotation>('PUT', `/annotations/${encodeURIComponent(id)}`, a),
  remove: (id: string) => rawJson<{ ok: boolean }>('DELETE', `/annotations/${encodeURIComponent(id)}`),
}

export const useAnnotations = (tf: Tf) =>
  useQuery({ queryKey: ['annotations', tf], queryFn: () => annotationsApi.list(tf), placeholderData: keepPreviousData, retry: 1 })

export function useAnnotationMutations() {
  const qc = useQueryClient()
  const done = () => { qc.invalidateQueries({ queryKey: ['annotations'] }) }
  return {
    createAnn: useMutation({ mutationFn: annotationsApi.create, onSuccess: done }),
    updateAnn: useMutation({ mutationFn: ({ id, a }: { id: string; a: Partial<AnnotationInput> }) => annotationsApi.update(id, a), onSuccess: done }),
    removeAnn: useMutation({ mutationFn: annotationsApi.remove, onSuccess: done }),
  }
}
