import { useSearchParams } from 'react-router-dom'

/**
 * Tab state persisted in the URL (the same convention on every page): `?tab=<id>` for the page tabs, `?view=<id>` (or another
 * key) for the secondary view inside a tab. The default is omitted from the URL; unknown values fall back to the default.
 * Changing the page tab drops every other parameter, which belongs to the tab being left.
 */
export function useTab<T extends string>(ids: readonly T[], fallback: T, param = 'tab'): [T, (t: T) => void] {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get(param) as T | null
  const tab = raw && ids.includes(raw) ? raw : fallback
  const setTab = (t: T) => {
    const next = new URLSearchParams(param === 'tab' ? '' : sp)
    if (t === fallback) next.delete(param)
    else next.set(param, t)
    setSp(next, { replace: true })
  }
  return [tab, setTab]
}
