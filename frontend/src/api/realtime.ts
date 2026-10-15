/*
 * Real-time invalidation: the WS pushes {"type":"invalidate","keys":["/forecast", "/cycle/advanced", ...]} after every
 * backend recalculation. Each API path prefix maps onto the react-query key roots that read from it.
 * Also: language switch → refetch everything (and again a bit later, while the backend translator fills its cache).
 */
import type { QueryClient, Query } from '@tanstack/react-query'
import { getLang, onLangChange } from '../i18n'
import { live } from './live'

/** API path prefix → query-key roots (first element of the queryKey). */
const PATH_KEYS: [string, string[]][] = [
  ['/overview', ['overview']],
  ['/candles', ['candles']],
  ['/indicators', ['indicators']],
  ['/levels', ['levels']],
  ['/liquidations', ['liquidations']],
  ['/fractals', ['fractals']],
  ['/usdt/analogs', ['usdtAnalogs']],
  ['/usdt', ['usdt', 'usdtAnalogs']],
  ['/cycles', ['cycles']],
  ['/cycle/advanced', ['cycle-adv']],
  ['/onchain', ['onchain']],
  ['/derivatives/basis', ['deriv-basis']],
  ['/derivatives/cme', ['deriv-cme']],
  ['/derivatives/aggregate', ['deriv-agg']],
  ['/derivatives', ['derivatives']],
  ['/flows', ['flows']],
  ['/analogs/structure', ['structAnalogs']],
  ['/analogs', ['analogs', 'structAnalogs']],
  ['/timepivots', ['timepivots']],
  ['/macro', ['macro']],
  ['/stablecoins', ['stablecoins']],
  ['/forecast', ['forecast']],
  ['/insights', ['insights']],
  ['/agents/messages', ['agentMessages']],
  ['/agents', ['agents', 'agentMessages']],
  ['/structure', ['structure']],
  ['/positioning', ['positioning']],
  ['/supply-demand', ['supplyDemand']],
  ['/events', ['events']],
  ['/astro', ['astro']],
  ['/tracking', ['tracking']],
  ['/alerts/rules', ['alertRules']],
  ['/journal', ['journal']],
  ['/alerts', ['alerts']],
  ['/status', ['status']],
  ['/vwap', ['vwap']],
  ['/timing', ['timing']],
  ['/superchart', ['superchart']],
  ['/anomalies', ['anomalies']],
  ['/orderbook', ['orderbook']],   // solo stato/segnali: heatmap e footprint ('ob-heatmap', 'ob-footprint') si aggiornano dal WS dedicato
]

/** Query-key roots touched by a list of API path prefixes (unknown paths fall back to their first segment). */
export function rootsFor(keys: string[]): Set<string> {
  const out = new Set<string>()
  for (const k of keys) {
    const p = k.startsWith('/') ? k : `/${k}`
    let hit = false
    for (const [prefix, roots] of PATH_KEYS) {
      // "/cycle/advanced" invalidates "/cycle/advanced/clock" and vice-versa ("/usdt" covers "/usdt/analogs")
      if (p.startsWith(prefix) || prefix.startsWith(p)) { roots.forEach((r) => out.add(r)); hit = true }
    }
    if (!hit) out.add(p.split('/')[1] ?? p)
  }
  return out
}

const lastUpdate = new Map<string, number>()
const updListeners = new Set<() => void>()
/** ms timestamp of the last server-side recalculation for a query-key root (from WS invalidate). */
export const lastRecalc = (root: string) => lastUpdate.get(root) ?? null
export function onRecalc(fn: () => void) { updListeners.add(fn); return () => { updListeners.delete(fn) } }

export function installRealtime(qc: QueryClient) {
  const invalidateRoots = (roots: Set<string>) =>
    qc.invalidateQueries({ predicate: (q: Query) => roots.has(String(q.queryKey[0])), refetchType: 'active' })

  live.onInvalidate((keys) => {
    const roots = rootsFor(keys)
    const now = Date.now()
    roots.forEach((r) => lastUpdate.set(r, now))
    updListeners.forEach((fn) => fn())
    invalidateRoots(roots)
    // EN: freshly generated sentences may still be Italian until the translator caches them — fetch once more
    if (getLang() === 'en') setTimeout(() => invalidateRoots(roots), 9000)
  })

  const timers: number[] = []
  onLangChange(() => {
    timers.splice(0).forEach((id) => clearTimeout(id))
    live.setLang(getLang())
    qc.invalidateQueries({ refetchType: 'active' })
    if (getLang() === 'en') {
      // background translation: re-ask a couple of times so the remaining Italian sentences get replaced
      for (const ms of [6000, 18000, 45000]) timers.push(window.setTimeout(() => qc.invalidateQueries({ refetchType: 'active' }), ms))
    }
  })
}
