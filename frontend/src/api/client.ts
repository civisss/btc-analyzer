import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type {
  Candle, ChatMessage, Cycles, Derivatives, Forecast, Fractals, Indicators, Insights, Levels,
  LiqRange, Liquidations, OnChain, Overview, Status, Tf, UsdtAnalysis,
} from './types'

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Params = Record<string, string | number | boolean | undefined>

function qs(params?: Params) {
  if (!params) return ''
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

async function getJson<R>(path: string, params?: Params): Promise<R> {
  if (USE_MOCKS) {
    const { mockGet } = await import('./mocks')
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 400))
    return mockGet(path, params ?? {}) as R
  }
  const res = await fetch(`/api${path}${qs(params)}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

const S = 1000
const M = 60 * S

export const api = {
  overview: () => getJson<Overview>('/overview'),
  candles: (tf: Tf, limit = 1000) => getJson<Candle[]>('/candles', { tf, limit }),
  indicators: (tf: Tf, limit = 1000) => getJson<Indicators>('/indicators', { tf, limit }),
  levels: (tf: Tf) => getJson<Levels>('/levels', { tf }),
  cycles: () => getJson<Cycles>('/cycles'),
  onchain: () => getJson<OnChain>('/onchain'),
  derivatives: () => getJson<Derivatives>('/derivatives'),
  liquidations: (range: LiqRange) => getJson<Liquidations>('/liquidations', { range }),
  fractals: (p: { tf: string; window: number; horizon: number; top: number }) => getJson<Fractals>('/fractals', p),
  usdt: () => getJson<UsdtAnalysis>('/usdt'),
  forecast: (horizon = 90) => getJson<Forecast>('/forecast', { horizon }),
  insights: (refresh = false) => getJson<Insights>('/insights', refresh ? { refresh: 1 } : undefined),
  status: () => getJson<Status>('/status'),
}

// ------------------------------------------------------------------ hooks
const common = { retry: 1, placeholderData: keepPreviousData } as const

export const useOverview = () =>
  useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 30 * S, ...common })
export const useCandles = (tf: Tf, limit = 1000) =>
  useQuery({ queryKey: ['candles', tf, limit], queryFn: () => api.candles(tf, limit), refetchInterval: tf === '15m' || tf === '1h' ? 30 * S : 60 * S, ...common })
export const useIndicators = (tf: Tf, limit = 1000) =>
  useQuery({ queryKey: ['indicators', tf, limit], queryFn: () => api.indicators(tf, limit), refetchInterval: 60 * S, ...common })
export const useLevels = (tf: Tf) =>
  useQuery({ queryKey: ['levels', tf], queryFn: () => api.levels(tf), refetchInterval: 60 * S, ...common })
export const useCycles = () =>
  useQuery({ queryKey: ['cycles'], queryFn: api.cycles, refetchInterval: 60 * S, ...common })
export const useOnChain = () =>
  useQuery({ queryKey: ['onchain'], queryFn: api.onchain, refetchInterval: 60 * S, ...common })
export const useDerivatives = () =>
  useQuery({ queryKey: ['derivatives'], queryFn: api.derivatives, refetchInterval: 60 * S, ...common })
export const useLiquidations = (range: LiqRange, fast = false) =>
  useQuery({ queryKey: ['liquidations', range], queryFn: () => api.liquidations(range), refetchInterval: fast ? 10 * S : 60 * S, ...common })
export const useFractals = (p: { tf: string; window: number; horizon: number; top: number }) =>
  useQuery({ queryKey: ['fractals', p], queryFn: () => api.fractals(p), refetchInterval: 60 * S, ...common })
export const useUsdt = () =>
  useQuery({ queryKey: ['usdt'], queryFn: api.usdt, refetchInterval: 60 * S, ...common })
export const useForecast = (horizon = 90) =>
  useQuery({ queryKey: ['forecast', horizon], queryFn: () => api.forecast(horizon), refetchInterval: 60 * S, ...common })
export const useInsights = () =>
  useQuery({ queryKey: ['insights'], queryFn: () => api.insights(false), refetchInterval: 2 * M, staleTime: 60 * S, ...common })
export const useStatus = () =>
  useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 30 * S, retry: 0 })


// ------------------------------------------------------------------ chat (SSE over fetch)
export async function streamChat(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (USE_MOCKS) {
    const { mockChatReply } = await import('./mocks')
    const reply = mockChatReply(messages)
    const tokens = reply.match(/\S+\s*/g) ?? [reply]
    for (const t of tokens) {
      if (signal?.aborted) return
      await new Promise((r) => setTimeout(r, 25))
      onDelta(t)
    }
    return
  }
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = res.statusText
    try {
      const b = await res.json()
      if (b?.detail) detail = String(b.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const ev of events) {
      for (const line of ev.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try {
          const obj = JSON.parse(data)
          if (typeof obj.delta === 'string') onDelta(obj.delta)
          else if (typeof obj.error === 'string') throw new ApiError(500, obj.error)
        } catch (e) {
          if (e instanceof ApiError) throw e
          onDelta(data)
        }
      }
    }
  }
}
