import { useEffect, useMemo, useRef, useState } from 'react'
import { useCandles, useOverview } from '../api/client'
import { live, useLive } from '../api/live'
import type { Candle } from '../api/types'
import { tfMap, toMonthly, type GlobalTf } from '../lib/store'

/** Live price from the WS ticker, falling back to REST overview. */
export function usePrice(): number | null {
  const p = useLive((s) => s.ticker?.price ?? null)
  const ov = useOverview()
  return p ?? ov.data?.price ?? null
}

/** Live price sampled every `ms` — for heavy charts that only need an approximate current-price marker. */
export function useThrottledPrice(ms = 5000): number | null {
  const ov = useOverview()
  const [p, setP] = useState<number | null>(() => live.getSnapshot().ticker?.price ?? null)
  const ref = useRef(p)
  useEffect(() => {
    const tick = () => {
      const v = live.getSnapshot().ticker?.price ?? null
      if (v !== ref.current) { ref.current = v; setP(v) }
    }
    tick()
    const id = setInterval(tick, ms)
    return () => clearInterval(id)
  }, [ms])
  return p ?? ov.data?.price ?? null
}

/** Candles for a top-bar timeframe (1M is aggregated client-side from weekly). */
export function useTfCandles(gtf: GlobalTf) {
  const m = tfMap[gtf]
  const q = useCandles(m.api, 1000)
  const candles = useMemo<Candle[] | undefined>(() => (q.data ? (m.monthly ? toMonthly(q.data) : q.data) : undefined), [q.data, m.monthly])
  return { q, candles, liveTf: m.live, monthly: m.monthly, apiTf: m.api, label: m.label }
}
