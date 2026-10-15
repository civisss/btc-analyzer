/*
 * Avvisi personalizzati: etichette, riassunto delle condizioni, editor delle regole (modale) e apertura rapida da altre pagine.
 * Tutte le etichette sono stringhe italiane tradotte con t(); i valori arrivano dall'API come codici + numeri.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity, BellPlus, CalendarClock, CandlestickChart, CheckCircle2, CircleDashed, Flame, Gauge, Magnet, Orbit, RectangleHorizontal, TrendingUp,
} from 'lucide-react'
import {
  rulesApi, useRuleMetrics, useRuleMutations,
  type AlertRule, type AnyParams, type LevelId, type MetricKey, type RuleInput, type RulePreview, type RuleType, type RuleStatus,
} from '../api/alertRules'
import type { AlertSeverity } from '../api/alerts'
import { Segmented, clsx } from '../components/ui'
import { ApiError } from '../api/client'
import { cap, t, tfLabel } from '../i18n'
import { compact, date, dayUnit, int, pct, pts, usd } from '../lib/format'
import { Field, INPUT, INPUT_ERR, Modal, NumInput, Select } from './forms'

// ------------------------------------------------------------------ labels
export const TYPE_META: Record<RuleType, { label: string; desc: string; icon: typeof TrendingUp }> = {
  price_cross: { label: 'Prezzo oltre una soglia', desc: 'Il prezzo supera o perde un valore', icon: TrendingUp },
  pct_move: { label: 'Variazione rapida', desc: 'Movimento % in una finestra di tempo', icon: Activity },
  zone: { label: 'Zona di prezzo', desc: 'Il prezzo entra o esce da un intervallo', icon: RectangleHorizontal },
  level_distance: { label: 'Vicinanza a un livello', desc: 'Distanza da un livello chiave', icon: Magnet },
  indicator: { label: 'Indicatore', desc: 'RSI, funding, open interest, sentiment…', icon: Gauge },
  cycle_zone: { label: 'Zona del Cycle Score', desc: 'Cambio di zona dello score di ciclo', icon: Orbit },
  timepivot: { label: 'Finestra pivot temporale', desc: 'Finestra di inversione in arrivo', icon: CalendarClock },
  candle_close: { label: 'Chiusura di candela', desc: 'Chiusura giornaliera o settimanale', icon: CandlestickChart },
  liq_burst: { label: 'Ondata di liquidazioni', desc: 'Liquidazioni reali in pochi minuti', icon: Flame },
}
export const RULE_TYPES = Object.keys(TYPE_META) as RuleType[]

export const LEVEL_LABEL: Record<LevelId, { label: string; group: string }> = {
  key_r1: { label: 'R1 chiave (resistenza più vicina)', group: 'Livelli chiave' },
  key_r2: { label: 'R2 chiave', group: 'Livelli chiave' },
  key_r3: { label: 'R3 chiave', group: 'Livelli chiave' },
  key_s1: { label: 'S1 chiave (supporto più vicino)', group: 'Livelli chiave' },
  key_s2: { label: 'S2 chiave', group: 'Livelli chiave' },
  key_s3: { label: 'S3 chiave', group: 'Livelli chiave' },
  weekly_open: { label: 'Apertura settimanale', group: 'Aperture e massimi/minimi' },
  monthly_open: { label: 'Apertura mensile', group: 'Aperture e massimi/minimi' },
  quarterly_open: { label: 'Apertura trimestrale', group: 'Aperture e massimi/minimi' },
  yearly_open: { label: 'Apertura annuale', group: 'Aperture e massimi/minimi' },
  prev_week_high: { label: 'Massimo settimana precedente', group: 'Aperture e massimi/minimi' },
  prev_week_low: { label: 'Minimo settimana precedente', group: 'Aperture e massimi/minimi' },
  prev_month_high: { label: 'Massimo mese precedente', group: 'Aperture e massimi/minimi' },
  prev_month_low: { label: 'Minimo mese precedente', group: 'Aperture e massimi/minimi' },
  monday_high: { label: 'Massimo del lunedì', group: 'Aperture e massimi/minimi' },
  monday_low: { label: 'Minimo del lunedì', group: 'Aperture e massimi/minimi' },
  monday_mid: { label: 'Metà del lunedì', group: 'Aperture e massimi/minimi' },
  range_high: { label: 'Massimo del range', group: 'Range e massimo storico' },
  range_mid: { label: 'Metà range', group: 'Range e massimo storico' },
  range_low: { label: 'Minimo del range', group: 'Range e massimo storico' },
  ath: { label: 'Massimo storico (ATH)', group: 'Range e massimo storico' },
  piv_d_P: { label: 'Pivot giornaliero P', group: 'Pivot classici' },
  piv_d_R1: { label: 'Pivot giornaliero R1', group: 'Pivot classici' },
  piv_d_S1: { label: 'Pivot giornaliero S1', group: 'Pivot classici' },
  piv_w_P: { label: 'Pivot settimanale P', group: 'Pivot classici' },
  piv_w_R1: { label: 'Pivot settimanale R1', group: 'Pivot classici' },
  piv_w_R2: { label: 'Pivot settimanale R2', group: 'Pivot classici' },
  piv_w_S1: { label: 'Pivot settimanale S1', group: 'Pivot classici' },
  piv_w_S2: { label: 'Pivot settimanale S2', group: 'Pivot classici' },
  piv_m_P: { label: 'Pivot mensile P', group: 'Pivot classici' },
  piv_m_R1: { label: 'Pivot mensile R1', group: 'Pivot classici' },
  piv_m_S1: { label: 'Pivot mensile S1', group: 'Pivot classici' },
  vwap_w: { label: 'VWAP settimanale', group: 'VWAP ancorati' },
  vwap_w_up1: { label: 'VWAP settimanale +1σ', group: 'VWAP ancorati' },
  vwap_w_dn1: { label: 'VWAP settimanale −1σ', group: 'VWAP ancorati' },
  vwap_m: { label: 'VWAP mensile', group: 'VWAP ancorati' },
  vwap_m_up1: { label: 'VWAP mensile +1σ', group: 'VWAP ancorati' },
  vwap_m_dn1: { label: 'VWAP mensile −1σ', group: 'VWAP ancorati' },
  vwap_q: { label: 'VWAP trimestrale', group: 'VWAP ancorati' },
  vwap_q_up1: { label: 'VWAP trimestrale +1σ', group: 'VWAP ancorati' },
  vwap_q_dn1: { label: 'VWAP trimestrale −1σ', group: 'VWAP ancorati' },
  vwap_y: { label: 'VWAP annuale', group: 'VWAP ancorati' },
  vwap_y_up1: { label: 'VWAP annuale +1σ', group: 'VWAP ancorati' },
  vwap_y_dn1: { label: 'VWAP annuale −1σ', group: 'VWAP ancorati' },
  vwap_pw: { label: 'VWAP della settimana precedente', group: 'VWAP ancorati' },
  vwap_pm: { label: 'VWAP del mese precedente', group: 'VWAP ancorati' },
  vwap_pq: { label: 'VWAP del trimestre precedente', group: 'VWAP ancorati' },
  vwap_py: { label: 'VWAP dell’anno precedente', group: 'VWAP ancorati' },
  vp_pw_poc: { label: 'POC della settimana precedente', group: 'Profilo di volume' },
  vp_pw_vah: { label: 'VAH della settimana precedente (value area)', group: 'Profilo di volume' },
  vp_pw_val: { label: 'VAL della settimana precedente (value area)', group: 'Profilo di volume' },
  wy_1d_high: { label: 'Massimo del range Wyckoff 1G', group: 'Range Wyckoff' },
  wy_1d_low: { label: 'Minimo del range Wyckoff 1G', group: 'Range Wyckoff' },
  wy_4h_high: { label: 'Massimo del range Wyckoff 4h', group: 'Range Wyckoff' },
  wy_4h_low: { label: 'Minimo del range Wyckoff 4h', group: 'Range Wyckoff' },
}

export const METRIC_META: Record<MetricKey, { label: string; unit: string; step: number; hint: string }> = {
  rsi_1h: { label: 'RSI 14 · 1h', unit: '', step: 1, hint: 'Scala 0–100: sopra 70 ipercomprato, sotto 30 ipervenduto' },
  rsi_4h: { label: 'RSI 14 · 4h', unit: '', step: 1, hint: 'Scala 0–100: sopra 70 ipercomprato, sotto 30 ipervenduto' },
  rsi_1d: { label: 'RSI 14 · 1d', unit: '', step: 1, hint: 'Scala 0–100: sopra 70 ipercomprato, sotto 30 ipervenduto' },
  funding: { label: 'Funding rate', unit: '% / 8h', step: 0.001, hint: 'Binance perpetual, percentuale ogni 8 ore (neutro ≈ 0.01%)' },
  oi_change_1h: { label: 'Open interest · variazione 1h', unit: '%', step: 0.1, hint: 'Variazione % dell’open interest in USD' },
  oi_change_4h: { label: 'Open interest · variazione 4h', unit: '%', step: 0.1, hint: 'Variazione % dell’open interest in USD' },
  oi_change_24h: { label: 'Open interest · variazione 24h', unit: '%', step: 0.1, hint: 'Variazione % dell’open interest in USD' },
  fng: { label: 'Fear & Greed', unit: '/100', step: 1, hint: 'Indice giornaliero alternative.me (0 paura estrema, 100 avidità estrema)' },
  cycle_score: { label: 'Cycle Score', unit: '/100', step: 1, hint: 'Score di ciclo composito (0 minimo di ciclo, 100 massimo)' },
  usdt_d: { label: 'USDT dominance', unit: '%', step: 0.01, hint: 'Quota di USDT sulla capitalizzazione crypto' },
  usdt_d_change_7d: { label: 'USDT dominance · variazione 7g', unit: 'pt', step: 0.01, hint: 'Variazione in punti percentuali su 7 giorni' },
}
export const METRIC_KEYS = Object.keys(METRIC_META) as MetricKey[]
export const metricLabel = (m: MetricKey) => t(METRIC_META[m].label).replace('1d', tfLabel('1d'))

export const ZONE_LABEL: Record<string, string> = {
  bottom: 'Zona di minimo', accumulation: 'Accumulo', mid: 'Metà ciclo', euphoria: 'Euforia', top: 'Zona di massimo',
}
export const STATUS_META: Record<RuleStatus, { label: string; dot: string }> = {
  active: { label: 'Attiva', dot: 'bg-up' },
  paused: { label: 'In pausa', dot: 'bg-slate-500' },
  expired: { label: 'Scaduta', dot: 'bg-slate-600' },
  triggered: { label: 'Scattata', dot: 'bg-accent-blue' },
  error: { label: 'Errore', dot: 'bg-down' },
}
export const SEVERITY_META: Record<AlertSeverity, { label: string; hex: string }> = {
  info: { label: 'Info', hex: '#5B8DEF' },
  warning: { label: 'Attenzione', hex: '#E8B04B' },
  critical: { label: 'Critico', hex: '#EF5466' },
}
const REASON: Record<string, string> = {
  ready: 'Condizione vera ora: l’avviso partirà al primo controllo (entro 20 s).',
  not_met: 'Condizione non ancora soddisfatta: l’avviso partirà quando lo diventa.',
  pending_event: 'Regola a evento: in attesa del prossimo evento.',
  cooldown: 'Condizione vera, ma la regola è in cooldown.',
  already_fired: 'Condizione vera e già notificata: si riarma quando torna falsa.',
  disabled: 'Regola in pausa.',
  expired: 'Regola scaduta.',
  triggered: 'Regola una tantum già scattata.',
  no_data: 'Dato non disponibile in questo momento.',
}
export const reasonText = (r: string) => t(REASON[r] ?? r)

const MOVE_WINDOWS = [5, 15, 30, 60, 120, 240, 480, 720, 1440]
const LIQ_WINDOWS = [1, 5, 15, 30, 60, 240]
export const winLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`)

/** Value in the metric's unit, with the unit (every number carries its unit). */
export function fmtMetric(m: MetricKey, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  switch (m) {
    case 'funding': return `${pct(v, 4)} / 8h`
    case 'oi_change_1h': case 'oi_change_4h': case 'oi_change_24h': return pct(v, 2)
    case 'usdt_d': return pct(v, 2, false)
    case 'usdt_d_change_7d': return pts(v, 2)
    case 'fng': case 'cycle_score': return `${v.toFixed(0)}/100`
    default: return v.toFixed(1)
  }
}
const fmtThreshold = (m: MetricKey, v: number) => (m === 'funding' ? `${pct(v, 3)} / 8h` : fmtMetric(m, v))

/** One-line condition summary, e.g. "Prezzo sopra $90,000". */
export function ruleSummary(r: { type: RuleType; params: AnyParams }): string {
  const q = r.params as Record<string, never>
  const n = (k: string) => Number(q[k])
  switch (r.type) {
    case 'price_cross': return t(q.direction === 'above' ? 'Prezzo sopra {p}' : 'Prezzo sotto {p}', { p: usd(n('price')) })
    case 'pct_move': return t(q.direction === 'up' ? 'Rialzo ≥ {x} in {w}' : q.direction === 'down' ? 'Ribasso ≥ {x} in {w}' : 'Movimento ±{x} in {w}', { x: pct(n('pct'), 1, false), w: winLabel(n('window_min')) })
    case 'zone': return t(q.mode === 'enter' ? 'Entra nella zona {a}–{b}' : 'Esce dalla zona {a}–{b}', { a: usd(n('low')), b: usd(n('high')) })
    case 'level_distance': return t('Entro {x} da {l}', { x: pct(n('pct'), 2, false), l: t(LEVEL_LABEL[q.level as LevelId]?.label ?? String(q.level)).split(' (')[0] })
    case 'indicator': return t(q.op === 'above' ? '{m} sopra {v}' : '{m} sotto {v}', { m: metricLabel(q.metric as MetricKey), v: fmtThreshold(q.metric as MetricKey, n('value')) })
    case 'cycle_zone': return q.zone === 'any' ? t('Cambio di zona del Cycle Score') : t('Cycle Score entra in: {z}', { z: t(ZONE_LABEL[q.zone] ?? String(q.zone)).toLowerCase() })
    case 'timepivot': return n('lead_days') === 0
      ? t('Finestra pivot attiva, confluenza ≥ {c}/100', { c: int(n('min_confluence')) })
      : t(n('lead_days') === 1 ? 'Finestra pivot entro 1 giorno, confluenza ≥ {c}/100' : 'Finestra pivot entro {d} giorni, confluenza ≥ {c}/100', { d: n('lead_days'), c: int(n('min_confluence')) })
    case 'candle_close': return t(q.direction === 'above' ? 'Chiusura {tf} sopra {p}' : 'Chiusura {tf} sotto {p}', { tf: tfLabel(String(q.tf)), p: usd(n('price')) })
    case 'liq_burst': return t(q.side === 'long' ? 'Liquidazioni long ≥ {u} in {w}' : q.side === 'short' ? 'Liquidazioni short ≥ {u} in {w}' : 'Liquidazioni ≥ {u} in {w}', { u: `$${compact(n('usd'), 1)}`, w: winLabel(n('window_min')) })
  }
}

/** Current value of the rule's quantity, formatted with its unit. */
export function fmtRuleValue(type: RuleType, params: AnyParams, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  switch (type) {
    case 'price_cross': case 'zone': case 'candle_close': return usd(v)
    case 'pct_move': return pct(v, 2)
    case 'level_distance': return pct(v, 2, false)
    case 'indicator': return fmtMetric(params.metric as MetricKey, v)
    case 'cycle_zone': return `${v.toFixed(0)}/100`
    case 'timepivot': return t('{n} finestre', { n: v })
    case 'liq_burst': return `$${compact(v, 1)}`
  }
}

// ------------------------------------------------------------------ quick-create (open the editor from any page)
type Prefill = Partial<RuleInput> & { id?: string }
let pending: Prefill | null = null
const subs = new Set<() => void>()
export function openRuleEditor(p: Prefill) { pending = p; subs.forEach((f) => f()) }
const closeEditor = () => { pending = null; subs.forEach((f) => f()) }
const useEditorState = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => pending)

/** Mount once on a page that offers quick-create actions; opens the editor when openRuleEditor() is called. */
export function RuleEditorHost({ onSaved }: { onSaved?: (r: AlertRule) => void }) {
  const p = useEditorState()
  if (!p) return null
  return <RuleEditor key={JSON.stringify(p)} initial={p} onClose={closeEditor} onSaved={onSaved} />
}

/** Prefill for a price level (key levels table, chart click): crossing in the direction of the level. */
export function priceRulePrefill(price: number, current: number | null, name?: string): Prefill {
  const above = current == null ? true : price >= current
  const p = Math.round(price)
  return {
    type: 'price_cross', params: { direction: above ? 'above' : 'below', price: p },
    name: name ?? t(above ? 'BTC sopra {p}' : 'BTC sotto {p}', { p: usd(p) }),
  }
}

// ------------------------------------------------------------------ editor
const DEFAULTS: Record<RuleType, (price: number) => AnyParams> = {
  price_cross: (p) => ({ direction: 'above', price: Math.round(p * 1.02) }),
  pct_move: () => ({ direction: 'any', pct: 3, window_min: 60 }),
  zone: (p) => ({ low: Math.round(p * 0.98), high: Math.round(p * 0.99), mode: 'enter' }),
  level_distance: () => ({ level: 'key_r1', pct: 0.5 }),
  indicator: () => ({ metric: 'rsi_4h', op: 'above', value: 70 }),
  cycle_zone: () => ({ zone: 'any' }),
  timepivot: () => ({ min_confluence: 60, lead_days: 1 }),
  candle_close: (p) => ({ tf: '1w', direction: 'above', price: Math.round(p * 1.03) }),
  liq_burst: () => ({ usd: 10_000_000, window_min: 5, side: 'any' }),
}
const COOLDOWNS = [5, 15, 60, 240, 720, 1440, 10080]
const cdLabel = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : m === 1440 ? `24 h` : `7 ${dayUnit()}`)

function defaultName(type: RuleType, params: AnyParams) { return cap(ruleSummary({ type, params })).slice(0, 80) }

/** Client-side validation (mirrors the backend): field -> message. */
function validate(d: RuleInput): Record<string, string> {
  const e: Record<string, string> = {}
  const q = d.params
  const num = (k: string) => typeof q[k] === 'number' && Number.isFinite(q[k] as number)
  if (!d.name.trim()) e.name = t('Inserisci un nome')
  const need = (k: string, lo: number, hi: number, msg?: string) => {
    if (!num(k)) e[k] = t('Valore obbligatorio')
    else if ((q[k] as number) < lo || (q[k] as number) > hi) e[k] = msg ?? t('Valore fuori intervallo ({a}–{b})', { a: lo, b: hi })
  }
  if (d.type === 'price_cross' || d.type === 'candle_close') need('price', 1, 10_000_000)
  if (d.type === 'pct_move') need('pct', 0.1, 50)
  if (d.type === 'zone') { need('low', 1, 10_000_000); need('high', 1, 10_000_000); if (!e.low && !e.high && (q.high as number) <= (q.low as number)) e.high = t('Deve essere maggiore del limite inferiore') }
  if (d.type === 'level_distance') need('pct', 0.05, 20)
  if (d.type === 'indicator') {
    const m = q.metric as MetricKey
    const lim = m === 'funding' ? [-1, 1] : m.startsWith('oi_') ? [-100, 100] : m === 'usdt_d_change_7d' ? [-20, 20] : m === 'usdt_d' ? [0, 50] : [0, 100]
    need('value', lim[0], lim[1])
  }
  if (d.type === 'timepivot') need('min_confluence', 0, 100)
  if (d.type === 'liq_burst') need('usd', 100_000, 10_000_000_000, t('Minimo $100K'))
  if (d.expires_at != null && d.expires_at * 1000 <= Date.now()) e.expires_at = t('La scadenza deve essere nel futuro')
  return e
}

function useDebounced<V>(v: V, ms: number): V {
  const [d, setD] = useState(v)
  useEffect(() => { const id = setTimeout(() => setD(v), ms); return () => clearTimeout(id) }, [v, ms])
  return d
}

const EXPIRY = [
  { value: 'never', label: 'Mai', s: null },
  { value: '1d', label: '24 h', s: 86400 },
  { value: '7d', label: '7 g', s: 7 * 86400 },
  { value: '30d', label: '30 g', s: 30 * 86400 },
] as const

export function RuleEditor({ initial, onClose, onSaved }: { initial: Prefill; onClose: () => void; onSaved?: (r: AlertRule) => void }) {
  const mq = useRuleMetrics()
  const m = mq.data
  const price = m?.price ?? null
  const { create, update } = useRuleMutations()
  const editing = !!initial.id
  const startType: RuleType = initial.type ?? 'price_cross'
  const [d, setD] = useState<RuleInput>(() => {
    const params = initial.params ?? DEFAULTS[startType](price ?? 80000)
    return {
      name: initial.name ?? '', type: startType, params, enabled: initial.enabled ?? true, severity: initial.severity ?? 'warning',
      cooldown_min: initial.cooldown_min ?? 60, repeat: initial.repeat ?? true, expires_at: initial.expires_at ?? null, note: initial.note ?? '',
    }
  })
  const [nameTouched, setNameTouched] = useState(!!initial.name)
  const [tried, setTried] = useState(false)
  // first live price: re-seed the default thresholds if the user hasn't typed yet
  const [seeded, setSeeded] = useState(!!initial.params)
  useEffect(() => {
    if (!seeded && price) { setSeeded(true); setD((x) => ({ ...x, params: DEFAULTS[x.type](price) })) }
  }, [price, seeded])
  const set = (k: string, v: string | number | null) => setD((x) => ({ ...x, params: { ...x.params, [k]: v as never } }))
  const setType = (tp: RuleType) => setD((x) => ({ ...x, type: tp, params: DEFAULTS[tp](price ?? 80000) }))
  const name = nameTouched ? d.name : defaultName(d.type, d.params)
  const draft: RuleInput = { ...d, name }
  const errors = validate(draft)
  const valid = Object.keys(errors).length === 0
  const show = (k: string) => (tried || k !== 'name' ? errors[k] ?? null : null)

  const key = useDebounced(JSON.stringify({ type: d.type, params: d.params }), 350)
  const pq = useQuery({
    queryKey: ['alertRules', 'preview', key], enabled: valid || Object.keys(errors).every((k) => k === 'name' || k === 'expires_at'),
    queryFn: () => rulesApi.preview(JSON.parse(key)), refetchInterval: 15_000, retry: 0, staleTime: 5_000,
  })

  const save = async () => {
    setTried(true)
    if (!valid) return
    try {
      const r = editing ? await update.mutateAsync({ id: initial.id!, r: draft }) : await create.mutateAsync(draft)
      onSaved?.(r)
      onClose()
    } catch { /* message below */ }
  }
  const err = (create.error ?? update.error) as ApiError | null
  const q = d.params as Record<string, never>
  const expiryKey = d.expires_at == null ? 'never' : 'custom'
  const levelOpts = (Object.keys(LEVEL_LABEL) as LevelId[]).map((id) => {
    const lv = m?.levels?.[id]
    return { value: id, label: `${t(LEVEL_LABEL[id].label)}${lv ? ` · ${usd(lv.price)}` : ` · ${t('non disponibile')}`}`, group: t(LEVEL_LABEL[id].group) }
  })

  return (
    <Modal title={editing ? t('Modifica avviso') : t('Nuovo avviso')} icon={<BellPlus />} accent="amber" wide onClose={onClose}
      subtitle={price ? t('Prezzo live {p} · le regole sono valutate ogni 20 secondi', { p: usd(price) }) : t('Le regole sono valutate ogni 20 secondi')}
      footer={
        <>
          {err && <span className="mr-auto max-w-full truncate text-xs text-down" title={err.message}>{t('Salvataggio non riuscito: {e}', { e: err.message })}</span>}
          {tried && !valid && !err && <span className="mr-auto text-xs text-down">{t('Controlla i campi evidenziati')}</span>}
          <button className="btn-ghost" onClick={onClose}>{t('Annulla')}</button>
          <button className="btn-primary" onClick={save} disabled={create.isPending || update.isPending}>
            {editing ? t('Salva modifiche') : t('Crea avviso')}
          </button>
        </>
      }>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label={t('Tipo di regola')} group>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {RULE_TYPES.map((tp) => {
                const M = TYPE_META[tp]
                const on = tp === d.type
                return (
                  <button key={tp} type="button" onClick={() => setType(tp)} aria-pressed={on}
                    className={clsx('flex min-w-0 items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left transition-colors',
                      on ? 'border-accent-blue/45 bg-accent-blue/[0.10] text-white' : 'border-white/[0.07] bg-white/[0.02] text-slate-300 hover:border-white/[0.14] hover:text-white')}>
                    <M.icon size={14} className={on ? 'text-accent-blue' : 'text-slate-500'} />
                    <span className="min-w-0 truncate text-xs font-medium">{t(M.label)}</span>
                  </button>
                )
              })}
            </div>
          </Field>

          {/* type-specific fields */}
          <div className="grid gap-3 sm:grid-cols-2">
            {d.type === 'price_cross' && <>
              <Field label={t('Direzione')} group><Segmented value={q.direction as string} onChange={(v) => set('direction', v)} options={[{ value: 'above', label: t('Sopra') }, { value: 'below', label: t('Sotto') }]} /></Field>
              <Field label={t('Prezzo')} error={show('price')} aside={price && typeof q.price === 'number' ? t('{d} dal prezzo', { d: pct((q.price / price - 1) * 100, 2) }) : null}>
                <NumInput value={q.price ?? null} onChange={(v) => set('price', v)} prefix="$" step={1} invalid={!!show('price')} />
              </Field>
            </>}
            {d.type === 'pct_move' && <>
              <Field label={t('Direzione')} group><Segmented value={q.direction as string} onChange={(v) => set('direction', v)} options={[{ value: 'any', label: t('Entrambe') }, { value: 'up', label: t('Rialzo') }, { value: 'down', label: t('Ribasso') }]} /></Field>
              <Field label={t('Variazione minima')} error={show('pct')}><NumInput value={q.pct ?? null} onChange={(v) => set('pct', v)} unit="%" step={0.1} invalid={!!show('pct')} /></Field>
              <Field label={t('Finestra')}><Select value={q.window_min as number} onChange={(v) => set('window_min', v)} options={MOVE_WINDOWS.map((w) => ({ value: w, label: winLabel(w) }))} /></Field>
            </>}
            {d.type === 'zone' && <>
              <Field label={t('Limite inferiore')} error={show('low')}><NumInput value={q.low ?? null} onChange={(v) => set('low', v)} prefix="$" step={1} invalid={!!show('low')} /></Field>
              <Field label={t('Limite superiore')} error={show('high')}><NumInput value={q.high ?? null} onChange={(v) => set('high', v)} prefix="$" step={1} invalid={!!show('high')} /></Field>
              <Field label={t('Quando')} group><Segmented value={q.mode as string} onChange={(v) => set('mode', v)} options={[{ value: 'enter', label: t('Entra nella zona') }, { value: 'exit', label: t('Esce dalla zona') }]} /></Field>
            </>}
            {d.type === 'level_distance' && <>
              <Field label={t('Livello')} className="sm:col-span-2" hint={m?.levels?.[q.level as LevelId]?.source ? t('Fonte attuale: {s}', { s: t(String(m.levels[q.level as LevelId]!.source)) }) : t('I livelli chiave R/S seguono il prezzo: R1 è sempre la resistenza più vicina.')}>
                <Select value={q.level as string} onChange={(v) => set('level', v)} options={levelOpts} />
              </Field>
              <Field label={t('Distanza massima')} error={show('pct')}><NumInput value={q.pct ?? null} onChange={(v) => set('pct', v)} unit="%" step={0.05} invalid={!!show('pct')} /></Field>
            </>}
            {d.type === 'indicator' && <>
              <Field label={t('Indicatore')} className="sm:col-span-2" hint={t(METRIC_META[q.metric as MetricKey].hint)}>
                <Select value={q.metric as string} onChange={(v) => setD((x) => ({ ...x, params: { ...x.params, metric: v, value: v === 'funding' ? 0.05 : v.startsWith('oi_') ? 5 : v === 'usdt_d' ? 6 : v === 'usdt_d_change_7d' ? 0.3 : v === 'fng' ? 75 : v === 'cycle_score' ? 80 : 70 } }))}
                  options={METRIC_KEYS.map((k) => ({ value: k, label: metricLabel(k) }))} />
              </Field>
              <Field label={t('Condizione')} group><Segmented value={q.op as string} onChange={(v) => set('op', v)} options={[{ value: 'above', label: t('Sopra') }, { value: 'below', label: t('Sotto') }]} /></Field>
              <Field label={t('Soglia')} error={show('value')}><NumInput value={q.value ?? null} onChange={(v) => set('value', v)} unit={METRIC_META[q.metric as MetricKey].unit} step={METRIC_META[q.metric as MetricKey].step} invalid={!!show('value')} /></Field>
            </>}
            {d.type === 'cycle_zone' && (
              <Field label={t('Zona')} className="sm:col-span-2" hint={t('Scatta al cambio di zona successivo al salvataggio.')}>
                <Select value={q.zone as string} onChange={(v) => set('zone', v)} options={[{ value: 'any', label: t('Qualsiasi cambio di zona') }, ...Object.keys(ZONE_LABEL).map((z) => ({ value: z, label: t(ZONE_LABEL[z]) }))]} />
              </Field>
            )}
            {d.type === 'timepivot' && <>
              <Field label={t('Confluenza minima')} error={show('min_confluence')}><NumInput value={q.min_confluence ?? null} onChange={(v) => set('min_confluence', v)} unit="/100" step={5} invalid={!!show('min_confluence')} /></Field>
              <Field label={t('Anticipo')}><Select value={q.lead_days as number} onChange={(v) => set('lead_days', v)} options={[{ value: 0, label: t('Quando inizia') }, { value: 1, label: t('1 giorno prima') }, { value: 3, label: t('3 giorni prima') }, { value: 7, label: t('7 giorni prima') }]} /></Field>
            </>}
            {d.type === 'candle_close' && <>
              <Field label={t('Candela')} group><Segmented value={q.tf as string} onChange={(v) => set('tf', v)} options={[{ value: '1d', label: t('Giornaliera') }, { value: '1w', label: t('Settimanale') }]} /></Field>
              <Field label={t('Direzione')} group><Segmented value={q.direction as string} onChange={(v) => set('direction', v)} options={[{ value: 'above', label: t('Sopra') }, { value: 'below', label: t('Sotto') }]} /></Field>
              <Field label={t('Prezzo di chiusura')} error={show('price')}><NumInput value={q.price ?? null} onChange={(v) => set('price', v)} prefix="$" step={1} invalid={!!show('price')} /></Field>
            </>}
            {d.type === 'liq_burst' && <>
              <Field label={t('Lato liquidato')} group><Segmented value={q.side as string} onChange={(v) => set('side', v)} options={[{ value: 'any', label: t('Entrambi') }, { value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} /></Field>
              <Field label={t('Soglia')} error={show('usd')} aside={typeof q.usd === 'number' ? `$${compact(q.usd, 1)}` : null}><NumInput value={q.usd ?? null} onChange={(v) => set('usd', v)} prefix="$" step={1_000_000} invalid={!!show('usd')} /></Field>
              <Field label={t('Finestra')}><Select value={q.window_min as number} onChange={(v) => set('window_min', v)} options={LIQ_WINDOWS.map((w) => ({ value: w, label: winLabel(w) }))} /></Field>
            </>}
          </div>

          <Field label={t('Nome')} error={tried ? errors.name : null}>
            <input value={name} maxLength={80} onChange={(e) => { setNameTouched(true); setD((x) => ({ ...x, name: e.target.value })) }} className={clsx(INPUT, tried && errors.name && INPUT_ERR)} placeholder={t('Es. BTC sopra il massimo del range')} />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Gravità')} group>
              <Segmented value={d.severity} onChange={(v) => setD((x) => ({ ...x, severity: v }))}
                options={(Object.keys(SEVERITY_META) as AlertSeverity[]).map((s) => ({ value: s, label: <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: SEVERITY_META[s].hex }} />{t(SEVERITY_META[s].label)}</span> }))} />
            </Field>
            <Field label={t('Ripetizione')} group>
              <Segmented value={d.repeat ? 'r' : 'o'} onChange={(v) => setD((x) => ({ ...x, repeat: v === 'r' }))} options={[{ value: 'r', label: t('Ripetibile') }, { value: 'o', label: t('Una volta') }]} />
            </Field>
            <Field label={t('Cooldown')} hint={t('Intervallo minimo tra due avvisi della regola')}>
              <Select value={d.cooldown_min} onChange={(v) => setD((x) => ({ ...x, cooldown_min: v }))} options={COOLDOWNS.map((c) => ({ value: c, label: cdLabel(c) }))} />
            </Field>
            <Field label={t('Scadenza')} error={show('expires_at')} hint={d.expires_at ? t('Fino al {d}', { d: date(d.expires_at) }) : t('Nessuna scadenza')}>
              <Select value={expiryKey === 'never' ? 'never' : 'custom'} onChange={(v) => {
                const opt = EXPIRY.find((e) => e.value === v)
                setD((x) => ({ ...x, expires_at: opt && opt.s ? Math.floor(Date.now() / 1000) + opt.s : null }))
              }} options={[...EXPIRY.map((e) => ({ value: e.value as string, label: t(e.label) })), ...(expiryKey === 'custom' ? [{ value: 'custom', label: d.expires_at ? date(d.expires_at) : '—' }] : [])]} />
            </Field>
          </div>

          <Field label={t('Nota')} hint={t('Facoltativa: perché questo avviso è importante (max 500 caratteri)')}>
            <textarea value={d.note} maxLength={500} rows={2} onChange={(e) => setD((x) => ({ ...x, note: e.target.value }))}
              className={clsx(INPUT, 'h-auto min-h-[64px] resize-y py-2 leading-relaxed')} placeholder={t('Es. conferma la rottura del range settimanale')} />
          </Field>
        </div>

        {/* live check */}
        <aside className="flex min-w-0 flex-col gap-3 lg:border-l lg:border-white/[0.06] lg:pl-5">
          <div className="label">{t('Controllo live')}</div>
          <LivePreview type={d.type} params={d.params} pv={pq.data} loading={pq.isFetching && !pq.data} error={pq.isError} />
          <ContextValues type={d.type} params={d.params} m={m} />
        </aside>
      </div>
    </Modal>
  )
}

function LivePreview({ type, params, pv, loading, error }: { type: RuleType; params: AnyParams; pv?: RulePreview; loading?: boolean; error?: boolean }) {
  if (loading) return <div className="h-[132px] animate-pulse rounded-xl bg-white/[0.03]" />
  if (error || !pv) return <p className="text-xs text-slate-400">{t('Anteprima non disponibile: completa i campi.')}</p>
  const cond = pv.condition
  return (
    <div className="flex flex-col gap-2.5">
      <div className="dgrid grid-cols-2 rounded-xl">
        <div className="px-3 py-2.5">
          <div className="label">{t('Valore attuale')}</div>
          <div className="tnum mt-0.5 truncate text-lg font-semibold text-white">{fmtRuleValue(type, params, pv.value)}</div>
        </div>
        <div className="px-3 py-2.5">
          <div className="label">{t('Soglia')}</div>
          <div className="tnum mt-0.5 truncate text-lg font-semibold text-slate-300">{pv.threshold == null ? '—' : fmtRuleValue(type, params, pv.threshold)}</div>
        </div>
      </div>
      <div className={clsx('flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-relaxed ring-1 ring-inset',
        pv.would_fire ? 'bg-amber-400/[0.08] text-slate-200 ring-amber-400/25' : 'bg-white/[0.03] text-slate-300 ring-white/[0.06]')}>
        {cond ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-amber-400" /> : <CircleDashed size={14} className="mt-0.5 shrink-0 text-slate-500" />}
        <span>
          <span className="font-medium text-white">{cond == null ? t('Condizione non valutabile') : cond ? (pv.event ? t('Evento presente') : t('Condizione vera')) : (pv.event ? t('Nessun evento ora') : t('Condizione falsa'))}</span>
          <span className="block text-slate-400">{reasonText(pv.reason)}</span>
        </span>
      </div>
    </div>
  )
}

/** Extra live numbers relevant to the chosen type (e.g. all named levels with their distance, open pivot windows). */
function ContextValues({ type, params, m }: { type: RuleType; params: AnyParams; m?: ReturnType<typeof useRuleMetrics>['data'] }) {
  const rows: [ReactNode, ReactNode][] = []
  if (!m) return null
  if (type === 'level_distance') {
    const lv = m.levels[params.level as LevelId]
    rows.push([t('Livello'), lv ? usd(lv.price) : '—'], [t('Distanza dal prezzo'), lv ? pct(lv.distance, 2) : '—'])
  } else if (type === 'pct_move') {
    for (const w of ['60', '240', '1440']) rows.push([t('Variazione {w}', { w: winLabel(Number(w)) }), pct(m.moves?.[w] ?? null, 2)])
  } else if (type === 'indicator') {
    for (const k of ['rsi_4h', 'funding', 'fng', 'cycle_score'] as MetricKey[]) rows.push([metricLabel(k), fmtMetric(k, m.metrics[k] as number)])
  } else if (type === 'cycle_zone') {
    rows.push([t('Cycle Score'), fmtMetric('cycle_score', m.metrics.cycle_score as number)], [t('Zona attuale'), t(ZONE_LABEL[String(m.metrics.cycle_zone)] ?? '—')])
  } else if (type === 'timepivot') {
    for (const w of m.timepivots.slice(0, 4)) rows.push([`${date(w.start, false)} – ${date(w.end, false)}`, `${int(w.confluence)}/100`])
  } else if (type === 'candle_close') {
    rows.push([t('Ultima chiusura {tf}', { tf: tfLabel('1d') }), usd(m.closes?.['1d']?.close ?? null)], [t('Ultima chiusura {tf}', { tf: tfLabel('1w') }), usd(m.closes?.['1w']?.close ?? null)])
  } else if (type === 'liq_burst') {
    rows.push([t('Liquidazioni ultimi 15 min'), m.liq_15m == null ? '—' : `$${compact(m.liq_15m, 1)}`])
  } else {
    rows.push([t('Prezzo'), usd(m.price)])
  }
  return (
    <div className="flex flex-col">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 border-t border-white/[0.05] py-1.5 text-xs first:border-t-0">
          <span className="min-w-0 truncate text-slate-400">{k}</span>
          <span className="tnum shrink-0 text-slate-200">{v}</span>
        </div>
      ))}
    </div>
  )
}
