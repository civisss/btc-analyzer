/*
 * i18n — Italian is the source language. UI strings are written in Italian in the code and wrapped in t():
 *     t('Grafico prezzo')                       → "Price chart" when EN
 *     t('Tra {n} giorni', { n: 3 })             → "In 3 days"
 * English translations live in src/i18n/en/*.ts (one file per area, merged automatically): { 'Italiano': 'English' }.
 * A missing key falls back to the Italian text (and is collected in window.__i18nMissing in dev).
 *
 * The current language is a module-level value so t() works everywhere (components, helpers, chart options).
 * Switching language remounts the app (see <LangRoot>), so every memoised option/label is rebuilt.
 * NEVER call t() at module top level: wrap at render time (t(item.label)).
 */
import { useSyncExternalStore } from 'react'

export type Lang = 'it' | 'en'
export const LANGS: Lang[] = ['it', 'en']

const modules = import.meta.glob<{ default: Record<string, string> }>('./en/*.ts', { eager: true })
const EN: Record<string, string> = {}
for (const m of Object.values(modules)) Object.assign(EN, m.default)

function readLang(): Lang {
  try {
    const v = localStorage.getItem('lang')
    return v === 'en' ? 'en' : 'it'
  } catch {
    return 'it'
  }
}

let current: Lang = readLang()
const listeners = new Set<() => void>()
if (typeof document !== 'undefined') document.documentElement.lang = current

export const getLang = () => current
export function setLang(l: Lang) {
  if (l === current) return
  current = l
  try { localStorage.setItem('lang', l) } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.lang = l
  listeners.forEach((fn) => fn())
}
export function onLangChange(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang, getLang)
}

const missing = new Set<string>()
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __i18nMissing: Set<string> }).__i18nMissing = missing

function fill(s: string, vars?: Record<string, string | number | null | undefined>) {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m))
}

/** Translate an Italian UI string (optionally with {placeholders}). */
export function t(it: string, vars?: Record<string, string | number | null | undefined>): string {
  if (current === 'it' || !it) return fill(it, vars)
  const en = EN[it]
  if (en == null) {
    if (import.meta.env.DEV && !missing.has(it)) missing.add(it)
    return fill(it, vars)
  }
  return fill(en, vars)
}

/** True when the string has an English translation (useful for optional texts). */
export const hasEn = (it: string) => it in EN

/** Pick between two literal variants: tr('mesi', 'months'). For one-off strings that don't deserve a dictionary key. */
export const tr = (it: string, en: string) => (current === 'en' ? en : it)

/** Short month names for the current language. */
export const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']
export const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTHS_LONG_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']
export const MONTHS_LONG_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const months = () => (current === 'en' ? MONTHS_EN : MONTHS_IT)
export const monthsLong = () => (current === 'en' ? MONTHS_LONG_EN : MONTHS_LONG_IT)
export const WEEKDAYS_IT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab']
export const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const weekdays = () => (current === 'en' ? WEEKDAYS_EN : WEEKDAYS_IT)
/** BCP-47 locale for Intl date APIs (numbers stay en-US in both languages). */
export const dateLocale = () => (current === 'en' ? 'en-GB' : 'it-IT')

/** Capitalise the first letter (sentence case), leaving units/tickers that must stay lowercase alone. */
export function cap(s: string | null | undefined): string {
  if (!s) return s ?? ''
  if (/^(\d|[a-z]{0,2}\d|×|pt\b|g\b)/.test(s)) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ------------------------------------------------------------------ network: every /api request carries the language
/** Appends lang=en to an /api URL when EN is active. */
export function withLang(url: string): string {
  if (current !== 'en' || !url.startsWith('/api') || url.startsWith('/api/ws')) return url
  if (/[?&]lang=/.test(url)) return url
  return url + (url.includes('?') ? '&' : '?') + 'lang=en'
}

let patched = false
/** Patch window.fetch once so every module (including ones with their own fetch helpers) sends ?lang=en + X-Lang. */
export function installFetchLang() {
  if (patched || typeof window === 'undefined') return
  patched = true
  const orig = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (current === 'en' && typeof input === 'string' && input.startsWith('/api')) {
      const headers = new Headers(init?.headers)
      headers.set('X-Lang', 'en')
      return orig(withLang(input), { ...init, headers })
    }
    return orig(input, init)
  }
}

// ------------------------------------------------------------------ timeframes
/**
 * One locale-aware timeframe label: IT `15m 1h 4h 1G 1S 1M`, EN `15m 1h 4h 1D 1W 1M`.
 * Accepts API ids (1h, 4h, 1d, 1w), upper-case variants (1H, 4H, 1D, 1W, 1M) and Italian ones (1G, 1S).
 */
export function tfLabel(tf: string | null | undefined): string {
  if (!tf) return ''
  const m = /^(\d+)\s*([a-zA-Z]+)$/.exec(tf.trim())
  if (!m) return tf
  const n = m[1]
  const u = m[2]
  if (u === 'M' || /^mo/i.test(u)) return `${n}M`
  const l = u.toLowerCase()
  if (l === 'm' || l === 'min') return `${n}m`
  if (l === 'h') return `${n}h`
  if (l === 'd' || l === 'g') return `${n}${current === 'en' ? 'D' : 'G'}`
  if (l === 'w' || l === 's') return `${n}${current === 'en' ? 'W' : 'S'}`
  return tf
}
/** Replace timeframe tokens inside a sentence/label ("RANGE 1D", "(1D)", "Analogo 1d") with tfLabel(). */
export const tfIn = (s: string) => s.replace(/\b(\d+)(h|H|d|D|g|G|w|W|s|S)\b/g, (x) => tfLabel(x))
