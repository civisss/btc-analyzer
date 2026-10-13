// Analoghi da immagine — tipi (vedi CONTRACT.md § IMAGE PATTERN) + mutation react-query (upload multipart).
import { useMutation } from '@tanstack/react-query'
import { ApiError } from './client'
import type { AnalogCandle, AnalogMatch, AnalogTf, Analogs } from './analogs'
import type { T } from './types'

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export type CropRect = { x: number; y: number; w: number; h: number } // pixel dell'immagine originale
export type ImageTheme = 'auto' | 'dark' | 'light'

/** One detected candle in image pixel coordinates (original image, crop offset included). */
export interface ImagePatternBox {
  i: number
  x: number; x0: number; x1: number
  y_open: number; y_close: number; y_high: number; y_low: number
  bull: boolean
  filled: boolean // false = candela non riconosciuta, ricostruita per interpolazione
}

export interface ImagePatternExtraction {
  kind: 'candles' | 'line'
  candles: number
  image: { width: number; height: number }
  crop: CropRect
  theme: 'dark' | 'light'
  colors: { up: string | null; down: string | null; background: string }
  pitch_px: number
  body_px: number
  spacing_score: number // 0..100
  confidence: number // 0..100
  volume_excluded: boolean
  inserted: number
  warnings: string[]
  boxes: ImagePatternBox[]
  series: { open: number[]; high: number[]; low: number[]; close: number[] } // 0 = minimo, 100 = massimo della figura
}

export interface ImagePatternMatch extends AnalogMatch {
  tf: AnalogTf
  window: number
  query_candles: AnalogCandle[] // figura calibrata sul tf e riportata al prezzo attuale (ultima candela = ora)
  scale_range: number // escursione % ipotizzata per la figura su questo tf
}

export interface ImagePatternTf {
  tf: AnalogTf
  available: boolean
  candidates: number
  best_similarity: number | null
  best_period: string | null
  note: string | null
}

export interface ImagePattern {
  generated_at: T
  tfs: AnalogTf[]
  window: number
  horizon: number
  top: number
  price_now: number
  extraction: ImagePatternExtraction
  per_tf: ImagePatternTf[]
  summary: Analogs['summary']
  projection: { steps: number; median: (number | null)[]; p25: (number | null)[]; p75: (number | null)[] }
  matches: ImagePatternMatch[]
  timings: { decode_ms: number; extract_ms: number; search_ms: number; total_ms: number }
  method: string
}

export type ImagePatternParams = { file: Blob; crop?: CropRect | null; tfs: AnalogTf[]; top?: number; horizon?: number; theme?: ImageTheme }

export async function analyzeImage(p: ImagePatternParams): Promise<ImagePattern> {
  const fd = new FormData()
  const name = p.file instanceof File ? p.file.name : 'screenshot.png'
  fd.append('image', p.file, name)
  if (p.crop) fd.append('crop', JSON.stringify({ x: Math.round(p.crop.x), y: Math.round(p.crop.y), w: Math.round(p.crop.w), h: Math.round(p.crop.h) }))
  if (p.tfs.length) fd.append('tfs', p.tfs.join(','))
  if (p.top) fd.append('top', String(p.top))
  if (p.horizon) fd.append('horizon', String(p.horizon))
  fd.append('theme', p.theme ?? 'auto')
  const res = await fetch('/api/analogs/image', { method: 'POST', body: fd, headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<ImagePattern>
}

export const useImagePattern = () => useMutation({ mutationFn: analyzeImage })
