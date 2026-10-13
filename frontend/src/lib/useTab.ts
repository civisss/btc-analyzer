import { useSearchParams } from 'react-router-dom'

/**
 * Page-level tab state persisted in the URL as `?tab=<id>` (the same convention on every page).
 * The default tab is omitted from the URL; unknown values fall back to the default.
 */
export function useTab<T extends string>(ids: readonly T[], fallback: T): [T, (t: T) => void] {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get('tab') as T | null
  const tab = raw && ids.includes(raw) ? raw : fallback
  const setTab = (t: T) => {
    const next = new URLSearchParams(sp)
    if (t === fallback) next.delete('tab')
    else next.set('tab', t)
    setSp(next, { replace: true })
  }
  return [tab, setTab]
}
