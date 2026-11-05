/* Notification preferences (per browser): last-read alert id + muted categories. Muted categories don't toast but stay in history. */
import { useSyncExternalStore } from 'react'
import type { AlertCategory } from '../api/alerts'

/** Category → Italian source label (translate with t()). */
export const ALERT_CATEGORIES: { id: AlertCategory; label: string }[] = [
  { id: 'price', label: 'Prezzo' },
  { id: 'levels', label: 'Livelli' },
  { id: 'liquidity', label: 'Liquidità' },
  { id: 'derivatives', label: 'Derivati' },
  { id: 'time', label: 'Pivot temporali' },
  { id: 'cycle', label: 'Ciclo' },
  { id: 'onchain', label: 'On-chain' },
  { id: 'stablecoins', label: 'Stablecoin' },
  { id: 'macro', label: 'Macro' },
  { id: 'events', label: 'Eventi' },
  { id: 'agents', label: 'Segnali automatici' },
  { id: 'custom', label: 'Avvisi personali' },
]

type Prefs = { lastRead: number | null; muted: string[] }
const read = (): Prefs => {
  try {
    const lr = localStorage.getItem('alerts-last-read')
    const m = JSON.parse(localStorage.getItem('alerts-muted') ?? '[]')
    return { lastRead: lr != null && lr !== '' ? Number(lr) : null, muted: Array.isArray(m) ? m.filter((x) => typeof x === 'string') : [] }
  } catch {
    return { lastRead: null, muted: [] }
  }
}

let prefs: Prefs = read()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((fn) => fn())
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export const getAlertPrefs = () => prefs
export function useAlertPrefs(): Prefs {
  return useSyncExternalStore(subscribe, getAlertPrefs, getAlertPrefs)
}
export function setLastRead(id: number) {
  if (prefs.lastRead != null && id <= prefs.lastRead) return
  prefs = { ...prefs, lastRead: id }
  try { localStorage.setItem('alerts-last-read', String(id)) } catch { /* ignore */ }
  emit()
}
export function toggleMuted(cat: string) {
  const muted = prefs.muted.includes(cat) ? prefs.muted.filter((c) => c !== cat) : [...prefs.muted, cat]
  prefs = { ...prefs, muted }
  try { localStorage.setItem('alerts-muted', JSON.stringify(muted)) } catch { /* ignore */ }
  emit()
}
export const isMuted = (cat: string) => prefs.muted.includes(cat)
