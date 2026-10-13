import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Candle, Pt, Tf } from '../api/types'
import type { LiveTf } from '../api/live'

// ------------------------------------------------------------------ global timeframe (top bar pills)
export type GlobalTf = '4H' | '1D' | '1W' | '1M'
export const GLOBAL_TFS: GlobalTf[] = ['4H', '1D', '1W', '1M']
export const tfMap: Record<GlobalTf, { api: Tf; live: LiveTf; monthly: boolean; label: string }> = {
  '4H': { api: '4h', live: '4h', monthly: false, label: '4H' },
  '1D': { api: '1d', live: '1d', monthly: false, label: '1G' },
  '1W': { api: '1w', live: '1w', monthly: false, label: '1S' },
  '1M': { api: '1w', live: '1d', monthly: true, label: '1M' },
}

interface AppState {
  tf: GlobalTf
  setTf: (t: GlobalTf) => void
  chatOpen: boolean
  setChatOpen: (o: boolean) => void
  sidebarOpen: boolean
  setSidebarOpen: (o: boolean) => void
}
const Ctx = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [tf, setTfState] = useState<GlobalTf>(() => {
    try {
      const v = localStorage.getItem('tf') as GlobalTf | null
      return v && GLOBAL_TFS.includes(v) ? v : '1D'
    } catch {
      return '1D'
    }
  })
  const [chatOpen, setChatOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const value = useMemo(
    () => ({
      tf,
      setTf: (t: GlobalTf) => {
        setTfState(t)
        try { localStorage.setItem('tf', t) } catch { /* ignore */ }
      },
      chatOpen, setChatOpen, sidebarOpen, setSidebarOpen,
    }),
    [tf, chatOpen, sidebarOpen],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp() {
  const v = useContext(Ctx)
  if (!v) throw new Error('AppStateProvider missing')
  return v
}

// ------------------------------------------------------------------ small TA helpers (client side)
export function toMonthly(c: Candle[]): Candle[] {
  const out: Candle[] = []
  for (const k of c) {
    const d = new Date(k.time * 1000)
    const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
    const last = out[out.length - 1]
    if (last && last.time === ms) {
      last.high = Math.max(last.high, k.high)
      last.low = Math.min(last.low, k.low)
      last.close = k.close
      last.volume += k.volume
    } else out.push({ time: ms, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })
  }
  return out
}

export function emaPts(c: Candle[], p: number): Pt[] {
  const k = 2 / (p + 1)
  let e = 0
  return c.map((x, i) => {
    e = i === 0 ? x.close : x.close * k + e * (1 - k)
    return { time: x.time, value: i < p - 1 ? null : e }
  })
}
