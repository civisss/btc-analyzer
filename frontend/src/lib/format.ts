// Number / date formatting helpers — ONE convention app-wide:
//   numbers en-US digits & grouping ($83,722 · +2.34% · $1.66T), Unicode minus "−" for negatives,
//   magnitudes K/M/B/T, multiplier "×", days "g" (IT) / "d" (EN); dates in the UI language: "12 ott 2026" / "12 Oct 2026".
import { dateLocale, getLang, months, t } from '../i18n'

type N = number | null | undefined
const ok = (v: N): v is number => typeof v === 'number' && Number.isFinite(v)

export const DASH = '—'

/** $83,120 / $0.42 / $1,234.56 */
export function usd(v: N, digits?: number): string {
  if (!ok(v)) return DASH
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4)
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** $1.66T / $28.4B / $412M / $83.1K */
export function usdCompact(v: N, digits = 2): string {
  if (!ok(v)) return DASH
  return (v < 0 ? '−$' : '$') + compact(Math.abs(v), digits)
}

export function compact(v: N, digits = 2): string {
  if (!ok(v)) return DASH
  const a = Math.abs(v)
  const s = v < 0 ? '−' : ''
  if (a >= 1e12) return s + (a / 1e12).toFixed(digits) + 'T'
  if (a >= 1e9) return s + (a / 1e9).toFixed(digits) + 'B'
  if (a >= 1e6) return s + (a / 1e6).toFixed(digits > 1 ? 1 : digits) + 'M'
  if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  if (a === 0) return '0'
  return s + a.toFixed(a < 10 ? 2 : 0)
}

/** +2.34% (signed); large values grouped: +52,287% */
export function pct(v: N, digits = 2, signed = true): string {
  if (!ok(v)) return DASH
  const s = v > 0 && signed ? '+' : v < 0 ? '−' : ''
  const a = Math.abs(v)
  const d = a >= 1000 ? 0 : digits
  return s + a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%'
}

/** Multiplier: 1.5× */
export function mult(v: N, digits = 1): string {
  if (!ok(v)) return DASH
  return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}×`
}

/** Day counts: "123 g" */
export function days(v: N): string {
  if (!ok(v)) return DASH
  return `${Math.round(v).toLocaleString('en-US')} ${getLang() === 'en' ? 'd' : 'g'}`
}

/**
 * Percent value as returned by the API. Every probability / confidence / weight / rate field in CONTRACT.md is
 * already expressed in PERCENT (0..100) — no fraction heuristic (a real 0.5% must stay 0.5%, not become 50%).
 */
export function toPct(v: N): number | null {
  return ok(v) ? v : null
}

/** Signed change in percentage POINTS: "+0.27 pt" (dominance, shares, rates). */
export function pts(v: N, digits = 2): string {
  if (!ok(v)) return DASH
  const s = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${s}${Math.abs(v).toFixed(digits)} pt`
}

/** Ordinal (percentiles, ranks): IT "38°" · EN "38th" / "21st" / "3rd". */
export function ordinal(v: N): string {
  if (!ok(v)) return DASH
  const n = Math.round(v)
  if (getLang() !== 'en') return `${n}°`
  const sfx = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${sfx}`
}

export function num(v: N, digits = 2): string {
  if (!ok(v)) return DASH
  return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function int(v: N): string {
  if (!ok(v)) return DASH
  const r = Math.round(v)
  return (r < 0 ? '−' : '') + Math.abs(r).toLocaleString('en-US')
}

export const toneOf = (v: N): 'up' | 'down' | 'flat' => (!ok(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down')

/** Unit suffix for day counts in the current language ("g" / "d"). */
export const dayUnit = () => (getLang() === 'en' ? 'd' : 'g')

export function date(t: N, withYear = true): string {
  if (!ok(t)) return DASH
  const d = new Date(t * 1000)
  return `${d.getUTCDate()} ${months()[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}`
}
export function monthYear(t: N): string {
  if (!ok(t)) return DASH
  const d = new Date(t * 1000)
  return `${months()[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
export function quarter(t: N): string {
  if (!ok(t)) return DASH
  const d = new Date(t * 1000)
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
}
/** "12 ott 21:04" (local time; adds the year when it is not the current one) */
export function dateTime(t: N): string {
  if (!ok(t)) return DASH
  const d = new Date(t * 1000)
  const y = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${d.getDate()} ${months()[d.getMonth()]}${y} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export function time(t: N): string {
  if (!ok(t)) return DASH
  return new Date(t * 1000).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
export function ago(t: N): string {
  if (!ok(t)) return DASH
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t))
  return agoSeconds(s)
}
export function agoSeconds(s: N): string {
  if (!ok(s)) return DASH
  const en = getLang() === 'en'
  if (s < 60) return en ? `${Math.round(s)}s ago` : `${Math.round(s)}s fa`
  if (s < 3600) return en ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 60)} min fa`
  if (s < 86400) return en ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 3600)} h fa`
  return en ? `${Math.floor(s / 86400)} d ago` : `${Math.floor(s / 86400)} g fa`
}
/** "Aggiornato 12s fa" / "Updated 12s ago" from a ms timestamp. */
export function updatedAgo(ms: N): string {
  if (!ok(ms)) return DASH
  return t('Aggiornato {ago}', { ago: agoSeconds(Math.max(0, (Date.now() - ms) / 1000)) })
}
export function daysUntil(t: N): number | null {
  if (!ok(t)) return null
  return Math.round((t - Date.now() / 1000) / 86400)
}

/** Label maps translate on read (keys stay the API enums, values are Italian source strings). */
function translated(m: Record<string, string>): Record<string, string> {
  return new Proxy(m, { get: (o, k: string) => (typeof o[k] === 'string' ? t(o[k]) : undefined) })
}
export const TONE_LABEL: Record<string, string> = translated({ bullish: 'Rialzista', bearish: 'Ribassista', neutral: 'Neutrale' })
/** Cycle-clock zones by API key (the API label is a lowercase Italian word the backend translator leaves as is). */
export const ZONE_LABEL: Record<string, string> = translated({
  bottom: 'Zona di minimo', accumulation: 'Accumulo', mid: 'Metà ciclo', euphoria: 'Euforia', top: 'Zona di massimo',
})
/** Zone name in the UI language from its key, falling back to the API label. */
export const zoneName = (key: string | null | undefined, fallback?: string | null): string =>
  (key && ZONE_LABEL[key]) || (fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : DASH)
export const PHASE_LABEL: Record<string, string> = translated({ accumulation: 'Accumulo', bull: 'Bull market', distribution: 'Distribuzione', bear: 'Bear market' })
export const CATEGORY_LABEL: Record<string, string> = translated({
  cycle: 'Ciclo', fractal: 'Frattali', liquidity: 'Liquidità', usdt: 'USDT', onchain: 'On-chain', derivatives: 'Derivati', technical: 'Tecnica',
})
