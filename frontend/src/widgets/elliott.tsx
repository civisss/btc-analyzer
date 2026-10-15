/* Onde di Elliott: notazione per grado, nomi e testi (composti qui da chiavi + numeri dell'API) e grafico del conteggio. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EwCandle, EwCount, EwDegree, EwGuide, EwPattern, EwRule, EwTf, Elliott } from '../api/elliott'
import { useLive } from '../api/live'
import EChart from '../components/charts/EChart'
import { C, axisLabel, hexA, tooltipBase, valueAxis } from '../components/charts/theme'
import { clsx } from '../components/ui'
import { date, dateTime, pct, usd, usdCompact } from '../lib/format'
import { months, t, tfLabel } from '../i18n'
import { usePrice } from './hooks'

// ------------------------------------------------------------------ colori
export const EW = {
  wave: '#9B87F5',        // conteggio selezionato (accento del gruppo «Cicli e tempo»)
  label: '#E8ECF4',
  higher: '#3CC6B0',      // grado superiore
  target: '#9B87F5',
  inv: '#EF5466',
  channel: 'rgba(179,188,208,0.55)',
  sub: '#B3BCD0',
}

// ------------------------------------------------------------------ gradi e notazione (Frost & Prechter, tabella dei gradi)
export const DEGREE_ORDER: EwDegree[] = ['supercycle', 'cycle', 'primary', 'intermediate', 'minor', 'minute', 'minuette', 'subminuette']
export const degreeName = (d: EwDegree) => ({
  supercycle: 'Supercycle', cycle: 'Cycle', primary: 'Primary', intermediate: 'Intermediate', minor: 'Minor', minute: 'Minute', minuette: 'Minuette', subminuette: 'Subminuette',
}[d])
export const degreeUp = (d: EwDegree): EwDegree => DEGREE_ORDER[Math.max(0, DEGREE_ORDER.indexOf(d) - 1)]
export const degreeDown = (d: EwDegree): EwDegree => DEGREE_ORDER[Math.min(DEGREE_ORDER.length - 1, DEGREE_ORDER.indexOf(d) + 1)]

const ROMAN = ['I', 'II', 'III', 'IV', 'V']
export type Notation = { text: string; circle: boolean }

/** Etichetta di un'onda nella notazione del grado: Cycle I/A · Primary ①/Ⓐ · Intermediate (1)/(A) · Minor 1/A · Minute ⓘ/ⓐ · Minuette (i)/(a). */
export function notation(degree: EwDegree, key: string): Notation {
  const motive = /^[1-5]$/.test(key)
  const n = motive ? Number(key) : 0
  const L = key.toUpperCase()
  switch (degree) {
    case 'supercycle': return { text: motive ? `(${ROMAN[n - 1]})` : `(${L})`, circle: false }
    case 'cycle': return { text: motive ? ROMAN[n - 1] : L, circle: false }
    case 'primary': return { text: motive ? key : L, circle: true }
    case 'intermediate': return { text: motive ? `(${key})` : `(${L})`, circle: false }
    case 'minor': return { text: motive ? key : L, circle: false }
    case 'minute': return { text: motive ? ROMAN[n - 1].toLowerCase() : L.toLowerCase(), circle: true }
    case 'minuette': return { text: motive ? `(${ROMAN[n - 1].toLowerCase()})` : `(${L.toLowerCase()})`, circle: false }
    default: return { text: motive ? ROMAN[n - 1].toLowerCase() : L.toLowerCase(), circle: false }
  }
}

/** Onda reale da etichettare: le sotto-onde a/b/c dei doppi sono di un grado inferiore, l'onda dopo un pattern completo di uno superiore. */
export function waveNotation(c: Pick<EwCount, 'pattern' | 'degree' | 'next_higher' | 'k'>, key: string, sub: boolean): Notation | null {
  if (key === 'next' || key === 'next2' || key === 'thrust') return null
  if (sub || (c.pattern.startsWith('double') && /^[abc]$/.test(key))) return notation(degreeDown(c.degree), key)
  return notation(c.degree, key)
}
/** Onda in corso (o attesa): dopo un pattern completo appartiene al grado superiore. */
export function curNotation(c: EwCount, key: string, next = false): Notation | null {
  if (key === 'next' || key === 'next2' || key === 'thrust') return null
  const higher = c.next_higher && (!next ? true : key !== 'next')
  if (c.pattern.startsWith('double') && /^[abc]$/.test(key)) return notation(degreeDown(c.degree), key)
  if (higher && c.state === 'complete') return notation(degreeUp(c.degree), key)
  return notation(c.degree, key)
}

export function WaveTag({ n, className, tone = 'default' }: { n: Notation | null; className?: string; tone?: 'default' | 'muted' | 'accent' }) {
  if (!n) return null
  return (
    <span className={clsx('tnum inline-flex h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap text-xs font-semibold',
      n.circle ? 'rounded-full px-1.5 ring-1 ring-inset' : 'px-0.5',
      tone === 'accent' ? 'text-[#C4B5FD] ring-[#9B87F5]/50' : tone === 'muted' ? 'text-slate-400 ring-white/20' : 'text-white ring-white/40', className)}>
      {n.text}
    </span>
  )
}

// ------------------------------------------------------------------ nomi
export function patternName(p: EwPattern, variant: string | null): string {
  const base = {
    impulse: t('Impulso'), diagonal: t('Diagonale'), zigzag: t('Zigzag'), flat: t('Flat'), triangle: t('Triangolo'),
    double_zigzag: t('Doppio zigzag'), double_three: t('Doppia three'),
  }[p]
  if (!variant) return base
  const fem = p === 'diagonal'
  const v: Record<string, string> = {
    expanded: t('espanso'), regular: t('regolare'), running: t('running'), barrier: t('a barriera'),
    contracting: fem ? t('contraente') : t('contraente'), expanding: fem ? t('espansiva') : t('espansivo'),
    contracting_leading: t('contraente iniziale'), contracting_ending: t('contraente finale'),
    expanding_leading: t('espansiva iniziale'), expanding_ending: t('espansiva finale'),
  }
  return `${base} ${v[variant] ?? variant}`
}
export const countName = (c: EwCount) => `${patternName(c.pattern, c.variant)} ${c.direction === 'up' ? t('al rialzo') : t('al ribasso')}`
/** Etichetta breve per le onde senza notazione (dopo un pattern completo). */
export const waveShort = (key: string) => (key === 'next' ? t('Nuovo') : key === 'next2' ? t('Poi') : key === 'thrust' ? t('Spinta') : key)

/** "Onda (4) in corso" · "Nuovo movimento" · "Onda c di Y". */
export function waveText(c: EwCount, key: string, next = false): string {
  if (key === 'next') return next ? t('Nuovo movimento') : t('Nuovo movimento dopo la correzione')
  if (key === 'next2') return t('Movimento successivo')
  if (key === 'thrust') return t('Spinta dopo il triangolo')
  const n = curNotation(c, key, next)
  if (c.pattern.startsWith('double') && /^[abc]$/.test(key)) return t('Onda {w} di Y', { w: n?.text ?? key })
  return t('Onda {w}', { w: n?.text ?? key })
}

export const fmtPx = (v: number | null | undefined, short = false) => (v == null || !Number.isFinite(v) ? '—' : short ? usdCompact(v, 1) : usd(v))
const fx = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—')
const pc = (v: number, d = 1) => pct(v * 100, d, false)

// ------------------------------------------------------------------ regole (vincoli rigidi)
export function ruleTitle(key: string, c?: EwCount): string {
  const exp = c?.variant === 'expanding'
  const m: Record<string, string> = {
    w2_start: t("L'onda 2 non ritraccia oltre l'inizio dell'onda 1"),
    w3_beyond_w1: t("L'onda 3 supera la fine dell'onda 1"),
    w4_overlap: t("L'onda 4 non entra nel territorio dell'onda 1"),
    w3_shortest: t("L'onda 3 non è la più corta tra 1, 3 e 5"),
    diag_w4_w3start: t("Diagonale: l'onda 4 non va oltre l'inizio dell'onda 3"),
    diag_contract: t('Diagonale contraente: 3 < 1, 4 < 2, 5 < 3'),
    diag_expand: t('Diagonale espansiva: 3 > 1, 4 > 2, 5 > 3'),
    zz_b_start: t("B non va oltre l'inizio di A"),
    zz_b_lt_flat: t('B sotto il 90% di A (altrimenti è un flat)'),
    zz_c_beyond_a: t('C supera la fine di A'),
    flat_b_90: t('B ritraccia almeno il 90% di A'),
    flat_b_max: t('B entro il 138.2% di A (soglia convenzionale del flat)'),
    flat_regular: t('Flat regolare: B 90–105% di A, C circa alla fine di A'),
    flat_expanded: t('Flat espanso: B oltre il 105% di A, C oltre la fine di A'),
    flat_running: t("Flat running: B oltre l'inizio di A, C non raggiunge la fine di A"),
    tri_position: t('Triangolo solo in onda 4, B o X: segue un movimento più ampio di A'),
    tri_c: exp ? t('Triangolo espansivo: C oltre la fine di A') : t('C non va oltre la fine di A'),
    tri_d: exp ? t('Triangolo espansivo: D oltre la fine di B') : t('D non va oltre la fine di B'),
    tri_e: exp ? t('Triangolo espansivo: E oltre la fine di C') : t('E non va oltre la fine di C'),
    dz_w_valid: t('W è uno zigzag o un flat valido'),
    dz_x_start: t("X non va oltre l'inizio di W"),
    dz_y_valid: t('Y è uno zigzag o un flat valido'),
    dz_y_beyond_w: t('Doppio zigzag: Y supera la fine di W'),
    labeling: t("Etichettatura: l'onda precedente non si estende oltre il suo estremo"),
  }
  return m[key] ?? key
}

export function ruleValue(r: EwRule): string {
  const v = r.value
  if (v == null || !Number.isFinite(v)) return '—'
  switch (r.key) {
    case 'w2_start': case 'zz_b_start': case 'zz_b_lt_flat': case 'flat_b_90': return t('{x} di {w}', { x: pc(v), w: r.key === 'w2_start' ? t('onda 1') : 'A' })
    case 'w3_beyond_w1': case 'diag_contract': case 'diag_expand': return t('Onda 3 = {x}× onda 1', { x: fx(v) })
    case 'w4_overlap': case 'diag_w4_w3start': return t('Margine {x} dell\'onda 3', { x: pc(v) })
    case 'w3_shortest': return t('{x}× la più corta tra 1 e 5', { x: fx(v) })
    case 'zz_c_beyond_a': case 'flat_regular': case 'flat_expanded': case 'flat_running': return v >= 0 ? t('C oltre A di {x} di A', { x: pc(v) }) : t('C prima della fine di A di {x} di A', { x: pc(-v) })
    case 'tri_position': return t('Movimento precedente = {x}× A', { x: fx(v) })
    case 'tri_c': case 'tri_d': case 'tri_e': return t('Margine {x} di A', { x: pc(Math.abs(v)) })
    case 'dz_x_start': return t('X = {x} di W', { x: pc(v) })
    case 'dz_y_beyond_w': return t('Oltre di {x} di W', { x: pc(v) })
    case 'dz_w_valid': case 'dz_y_valid': return t('B = {x} di A', { x: pc(v) })
    default: return fx(v)
  }
}

// ------------------------------------------------------------------ linee guida (punteggio)
export function guideTitle(key: string, c?: EwCount): string {
  const diag = c?.pattern === 'diagonal'
  const m: Record<string, string> = {
    w2_fib: diag ? t("Onda 2 ritraccia 61.8–78.6% dell'onda 1 (diagonale)") : t("Onda 2 ritraccia 50–61.8% dell'onda 1"),
    w3_fib: t("Onda 3 ≈ 1.618 o 2.618 volte l'onda 1"),
    w4_fib: diag ? t("Onda 4 ritraccia 61.8–78.6% dell'onda 3 (diagonale)") : t("Onda 4 ritraccia 23.6–38.2% dell'onda 3"),
    w5_fib: t("Onda 5 ≈ onda 1 o 0.618 × (inizio 1 → fine 3)"),
    alternation: t('Alternanza tra onda 2 e onda 4 (profondità, durata, struttura)'),
    extension: t('Una sola onda motrice estesa (≥ 1.382 volte la seconda)'),
    channel_w4: t("Onda 4 sulla parallela per la 2 della linea 1–3"),
    channel_w5: t("Onda 5 sulla parallela per la 3 della linea 2–4"),
    time: t('Rapporti di tempo di Fibonacci tra onde simili'),
    substructure: t('Sottostruttura: motrici in 5, correttive in 3'),
    volume: t("Volume dell'onda 3 sopra quello delle onde 5 e 1"),
    divergence: t('Divergenza RSI tra il massimo della 3 e quello della 5'),
    start_extreme: t('Il conteggio parte da un estremo dei pivot precedenti'),
    coverage: t('Copertura: onde già completate sul totale del pattern'),
    coherence: t('Coerenza con il conteggio di grado superiore'),
    truncation: t("Onda 5 oltre la fine dell'onda 3 (niente troncamento)"),
    overlap: t("Diagonale: onda 4 sovrapposta all'onda 1"),
    diag_ratios: t('Diagonale: rapporti tra le onde a cuneo'),
    b_fib: t('B ritraccia 50–61.8% di A'),
    c_fib: t('C ≈ A (oppure 0.618 o 1.618 × A)'),
    depth: t('Profondità tipica: 38.2–61.8% del movimento precedente'),
    tri_legs: t('Ogni gamba del triangolo ≈ 0.618–0.786 della precedente'),
    barrier: t('Linea B–D piatta (triangolo a barriera)'),
    x_fib: t('X ritraccia 50–61.8% di W'),
    y_eq_w: t('Y ≈ W (oppure 0.618 o 1.618 × W)'),
    flat_b: t('B del flat ≈ 100% di A (espanso 123.6–138.2%)'),
  }
  return m[key] ?? key
}

const arr = (v: EwGuide['value']): (number | null)[] => (Array.isArray(v) ? v : [v])
export function guideValue(g: EwGuide): string {
  const v = g.value
  const n = typeof v === 'number' ? v : null
  switch (g.key) {
    case 'w2_fib': case 'w4_fib': case 'b_fib': case 'x_fib': case 'flat_b': case 'depth': return n != null ? pc(n) : '—'
    case 'w3_fib': case 'c_fib': case 'y_eq_w': case 'time': case 'extension': return n != null ? `${fx(n)}×` : '—'
    case 'w5_fib': { const [a, b] = arr(v); return a != null && b != null ? t('{a}× onda 1 · {b}× (1→3)', { a: fx(a), b: fx(b) }) : '—' }
    case 'alternation': { const [a, b] = arr(v); return a != null && b != null ? t('Onda 2 {a} · onda 4 {b}', { a: pc(a, 0), b: pc(b, 0) }) : '—' }
    case 'channel_w4': case 'channel_w5': return n != null ? t('Scarto {x} dell\'onda 3', { x: pct(n * 100, 0) }) : '—'
    case 'substructure': return Array.isArray(v) ? v.join('-') : '—'
    case 'volume': return n != null ? t('Onda 3 / onda 5 {x}×', { x: fx(n) }) : '—'
    case 'divergence': { const [a, b] = arr(v); return a != null && b != null ? `RSI ${fx(a, 1)} → ${fx(b, 1)}` : '—' }
    case 'start_extreme': return n === 0 ? t('Estremo') : t('{n} pivot oltre', { n: n ?? 0 })
    case 'coverage': return n != null ? `${n}/${g.ideal?.[0] ?? n}` : '—'
    case 'coherence': return n == null ? '—' : n > 0 ? t('Grado superiore al rialzo') : t('Grado superiore al ribasso')
    case 'truncation': return n != null ? (n >= 0 ? t('Oltre di {x} della 3', { x: pc(n) }) : t('Troncata di {x}', { x: pc(-n) })) : '—'
    case 'overlap': return n != null ? (n < 0 ? t('Sovrapposta') : t('Nessuna sovrapposizione')) : '—'
    case 'diag_ratios': case 'tri_legs': return Array.isArray(v) ? v.map((x) => (x == null ? '—' : fx(x))).join(' · ') : '—'
    case 'barrier': return n != null ? t('Scarto {x} di A', { x: pc(n) }) : '—'
    default: return n != null ? fx(n) : '—'
  }
}
export const idealText = (g: EwGuide) => (g.ideal && g.ideal.length && !['coverage', 'channel_w4', 'channel_w5', 'barrier', 'overlap'].includes(g.key) ? g.ideal.map((x) => fx(x, 3).replace(/0+$/, '').replace(/\.$/, '')).join(' · ') : '')

export function levelName(key: string, ratio: number | null): string {
  const r = ratio == null ? '' : `${+(ratio * 100).toFixed(1)}%`
  const x = ratio == null ? '' : `${+ratio.toFixed(3)}×`
  const m: Record<string, string> = {
    ret_w1: t("Ritracciamento {r} dell'onda 1", { r }), ext_w1: t("{x} l'onda 1 dalla fine della 2", { x }),
    ret_w3: t("Ritracciamento {r} dell'onda 3", { r }), ret_imp: t("Ritracciamento {r} dell'impulso", { r }),
    w5_eq_w1: t('Onda 5 = onda 1'), w5_618_w13: t('Onda 5 = 0.618 × (1→3)'), w5_618_w1: t('Onda 5 = 0.618 × onda 1'), w5_1618_w1: t('Onda 5 = 1.618 × onda 1'),
    prev_w4: t("Fine dell'onda 4 precedente"), ret_a: t('Ritracciamento {r} di A', { r }), ext_a: t('C = {x} A', { x }),
    ret_corr: t('{r} della correzione', { r }), ret_diag: t('Ritracciamento {r} della diagonale', { r }), ext_w3: t("{x} l'onda 3", { x }),
    tri_leg: t('{x} la gamba precedente', { x }), tri_thrust: t('Spinta = {x} la base del triangolo', { x }), ret_w: t('Ritracciamento {r} di W', { r }),
    ext_wa: t('a di Y = {x} a di W', { x }), y_eq_w: t('Y = W'),
  }
  return m[key] ?? key
}

export function invRuleText(key: string | null | undefined): string {
  if (!key) return ''
  if (key === 'labeling') return t("l'onda precedente si estenderebbe: etichette da rifare")
  return ruleTitle(key).replace(/^./, (s) => s.toLowerCase())
}

// ------------------------------------------------------------------ live: ultima candela e prezzo
export function useLiveCandles(d: { tf: EwTf; candles: EwCandle[] } | undefined, refetch: () => void) {
  const kline = useLive((s) => (d ? s.klines[d.tf] ?? null : null))
  const price = usePrice()
  const lastT = d?.candles[d.candles.length - 1]?.time ?? 0
  const asked = useRef(0)
  useEffect(() => {
    if (kline && lastT && kline.time > lastT && asked.current !== kline.time) {
      asked.current = kline.time
      const id = setTimeout(refetch, 5000)   // nuova candela: il backend ricalcola il conteggio alla chiusura
      return () => clearTimeout(id)
    }
  }, [kline, lastT, refetch])
  return useMemo(() => {
    if (!d || !d.candles.length) return { candles: d?.candles ?? [], price: null as number | null, live: false }
    const cs = d.candles
    const last = cs[cs.length - 1]
    let upd: EwCandle | null = null
    if (kline && kline.time === last.time) upd = { ...last, high: Math.max(last.high, kline.high), low: Math.min(last.low, kline.low), close: kline.close }
    else if (price && price > 0 && Math.abs(price / last.close - 1) < 0.2) upd = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }
    if (!upd) return { candles: cs, price: last.close, live: false }
    return { candles: [...cs.slice(0, -1), upd], price: upd.close, live: true }
  }, [d, kline, price])
}

/** Il prezzo live ha superato l'invalidazione del conteggio? ('below' | 'above' | null) */
export function brokenSide(c: EwCount | undefined, price: number | null): 'below' | 'above' | null {
  if (!c || price == null) return null
  if (c.invalidation.below != null && price < c.invalidation.below) return 'below'
  if (c.invalidation.above != null && price > c.invalidation.above) return 'above'
  return null
}

// ------------------------------------------------------------------ grafico
type RichLabel = { formatter: string; rich: Record<string, unknown> }
function richLabel(n: Notation, color: string, size = 12, extra = ''): RichLabel {
  const style = n.circle
    ? { color, fontSize: size, fontWeight: 700, borderColor: color, borderWidth: 1.2, borderRadius: 9, padding: [2, 5, 1, 5], backgroundColor: 'rgba(14,20,36,0.85)' }
    : { color, fontSize: size, fontWeight: 700, padding: [2, 3, 1, 3], backgroundColor: 'rgba(14,20,36,0.7)', borderRadius: 4 }
  return { formatter: `{w|${n.text}}${extra ? `{x|${extra}}` : ''}`, rich: { w: style, x: { color: '#B3BCD0', fontSize: 10, padding: [0, 0, 0, 4] } } }
}

const p2 = (n: number) => String(n).padStart(2, '0')
export function tickLabel(ts: number, tf: EwTf) {
  const M = months()
  const d = new Date(ts * 1000)
  if (tf === '4h') return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${p2(d.getUTCHours())}h`
  if (tf === '1w') return `${M[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]}`
}
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`

/** Punti di una retta in scala log (campionati: dritta sia in scala log sia lineare a meno della curvatura reale). */
function logLine(a: { time: number; price: number }, b: { time: number; price: number }, n = 24): [number, number][] {
  const out: [number, number][] = []
  const la = Math.log(a.price), lb = Math.log(b.price)
  for (let i = 0; i <= n; i++) {
    const f = i / n
    out.push([(a.time + (b.time - a.time) * f) * 1000, Math.exp(la + (lb - la) * f)])
  }
  return out
}

export type ChartScale = 'log' | 'lin'
/**
 * Candele con il conteggio: linea delle onde e etichette nella notazione del grado (sotto-onde più piccole), onda in corso
 * tratteggiata con etichetta provvisoria, zona obiettivo (prezzo × tempo), proiezione tratteggiata dell'onda successiva,
 * livello di invalidazione, canale di Elliott e (opzionale) il conteggio di grado superiore.
 */
export function ElliottChart({
  candles: allCandles, after, count, higher, tf, scale, showChannel, showHigher, height, compact, livePrice,
}: {
  candles: EwCandle[]; after?: EwCandle[]; count: EwCount | undefined; higher?: EwCount | null; tf: EwTf; scale: ChartScale
  showChannel: boolean; showHigher: boolean; height: number | string; compact: boolean; livePrice?: number | null
}) {
  // real plot size (40 px steps) for the label-collision boxes; axes take ~64 px on the right and ~30 px at top/bottom
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth / 40) * 40, h = Math.round(el.clientHeight / 40) * 40
      setSize((o) => (o && o.w === w && o.h === h ? o : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const option = useMemo(() => {
    // inquadratura: dal conteggio selezionato (o dal grado superiore se visibile) con un margine del 35% dell'ampiezza
    const endT = allCandles[allCandles.length - 1]?.time ?? 0
    const starts = [count?.points[0]?.time, showHigher && higher ? higher.points[0]?.time : undefined].filter((v): v is number => v != null)
    const focus = starts.length ? Math.min(...starts) : allCandles[0]?.time ?? 0
    const from = Math.max(allCandles[0]?.time ?? 0, focus - Math.max((endT - focus) * 0.35, 0))
    const candles = allCandles.filter((c) => c.time >= from)
    const step = candles.length > 1 ? candles[1].time - candles[0].time : 86400
    const lastC = candles[candles.length - 1]
    const xMin = candles[0]?.time ?? 0
    const projMax = count?.projection.length ? Math.max(...count.projection.map((q) => q.t_hi)) : 0
    const afterMax = after?.length ? after[after.length - 1].time : 0
    const xMax = Math.max(lastC?.time ?? 0, projMax, afterMax) + step * 2
    const series: unknown[] = []
    const ohlc = (c: EwCandle) => [c.time * 1000, c.open, c.close, c.low, c.high]
    const extent: number[] = []
    const markLines: unknown[] = []
    // ---- candele
    series.push({ type: 'candlestick', id: 'px', name: t('Prezzo'), data: candles.map(ohlc), barMaxWidth: 8, z: 2,
      itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down },
      markLine: { symbol: ['none', 'none'], silent: true, animation: false, data: markLines } })
    if (after?.length) {
      series.push({ type: 'candlestick', id: 'after', name: t('Dopo'), data: after.map(ohlc), barMaxWidth: 8, z: 2,
        itemStyle: { color: hexA(C.up, 0.32), color0: hexA(C.down, 0.32), borderColor: hexA(C.up, 0.45), borderColor0: hexA(C.down, 0.45) } })
      markLines.push({ xAxis: (lastC?.time ?? 0) * 1000, lineStyle: { color: 'rgba(148,163,184,0.5)', type: 'dashed', width: 1 },
        label: { show: true, position: 'end', formatter: t('Data del conteggio'), color: '#B3BCD0', fontSize: 11 } })
    }
    // approximate plot geometry (px) used to keep the text labels apart: waves, wave in progress, targets, invalidation
    const plotW = size ? Math.max(120, size.w - 76) : compact ? 260 : 900
    const plotH = size ? Math.max(80, size.h - 60) : compact ? 190 : 520
    const xpx = (ts: number) => ((ts - xMin) / Math.max(1, xMax - xMin)) * plotW
    const yVals = [...candles.map((c) => c.low), ...candles.map((c) => c.high), ...(after ?? []).flatMap((c) => [c.low, c.high]),
      ...(showHigher && higher ? higher.points.filter((p) => p.time >= xMin).map((p) => p.price) : []),
      ...(count ? [...count.projection.flatMap((q) => [q.lo, q.hi]),
      ...(['below', 'above'] as const).map((k) => count.invalidation[k]).filter((v): v is number => v != null)] : [])]
    const yLoV = Math.min(...yVals), yHiV = Math.max(...yVals)
    const tr = (v: number) => (scale === 'log' ? Math.log(Math.max(v, 1e-9)) : v)
    const yA = tr(yLoV) - (tr(yHiV) - tr(yLoV)) * 0.06, yB = tr(yHiV) + (tr(yHiV) - tr(yLoV)) * 0.06
    const ypx = (v: number) => ((yB - tr(v)) / Math.max(1e-9, yB - yA)) * plotH
    type Box = { x0: number; x1: number; y0: number; y1: number }
    const boxes: Box[] = []
    // a place is taken if it touches another label or leaves the plot (it would cover the price axis)
    const hits = (b: Box) => b.x0 < 0 || b.x1 > plotW || b.y0 < 0 || b.y1 > plotH || boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)
    const textW = (str: string, size = 11) => str.length * size * 0.62 + 10
    type Side = 'top' | 'bottom' | 'left' | 'right'
    /** box of a point label placed on `side` of the point at `dist` px (true = top, false = bottom) */
    const ptBox = (ts: number, v: number, w: number, h: number, side: Side | boolean, dist: number): Box => {
      const x = xpx(ts), y = ypx(v)
      const sd: Side = side === true ? 'top' : side === false ? 'bottom' : side
      if (sd === 'left') return { x0: x - dist - w, x1: x - dist, y0: y - h / 2, y1: y + h / 2 }
      if (sd === 'right') return { x0: x + dist, x1: x + dist + w, y0: y - h / 2, y1: y + h / 2 }
      return { x0: x - w / 2, x1: x + w / 2, y0: sd === 'top' ? y - dist - h : y + dist, y1: sd === 'top' ? y - dist : y + dist + h }
    }
    /** how much a box overlaps the others or sticks out of the plot (0 = free) */
    const clashArea = (b: Box) => {
      const out = Math.max(0, -b.x0) + Math.max(0, b.x1 - plotW) + Math.max(0, -b.y0) + Math.max(0, b.y1 - plotH)
      return out * 20 + boxes.reduce((a, o) => a + Math.max(0, Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0)) * Math.max(0, Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0)), 0)
    }
    // ---- grado superiore
    if (showHigher && higher) {
      const pts = higher.points.filter((p) => p.time >= xMin)
      series.push({ type: 'line', id: 'hi', name: t('Grado superiore'), silent: true, z: 3, symbol: 'none',
        data: pts.map((p) => [p.time * 1000, p.price]), lineStyle: { color: hexA(EW.higher, 0.55), width: 1.25, type: 'dashed' } })
      series.push({ type: 'scatter', id: 'hilab', name: '_hilab', symbolSize: 1, silent: true, z: 5, tooltip: { show: false }, itemStyle: { color: 'transparent' },
        data: pts.filter((p) => p.label).map((p) => {
          const n = waveNotation(higher, p.label!, p.sub)
          return n ? { value: [p.time * 1000, p.price], label: { show: true, position: p.kind === 'high' ? 'top' : 'bottom', distance: compact ? 26 : 30, ...richLabel(n, EW.higher, compact ? 10 : 11) } } : null
        }).filter(Boolean) })
    }
    if (count) {
      const pts = count.points
      // ---- canale
      if (showChannel && count.channel) {
        const yLo = Math.min(...candles.map((c) => c.low), ...count.projection.map((q) => q.lo)) * 0.97
        const yHi = Math.max(...candles.map((c) => c.high), ...count.projection.map((q) => q.hi)) * 1.03
        count.channel.forEach((ln, i) => {
          if (ln.length < 2) return
          const pts = logLine(ln[0], ln[1]).filter(([x, y]) => y >= yLo && y <= yHi && x >= (candles[0]?.time ?? 0) * 1000)
          if (pts.length < 2) return
          series.push({ type: 'line', id: `ch${i}`, name: i === 0 ? t('Canale') : '_ch', silent: true, z: 2, symbol: 'none', data: pts,
            lineStyle: { color: EW.channel, width: 1, type: [4, 4] } })
        })
      }
      // ---- onde completate + onda in corso
      series.push({ type: 'line', id: 'wave', name: t('Conteggio'), silent: true, z: 4, symbol: 'none',
        data: pts.map((p) => [p.time * 1000, p.price]), lineStyle: { color: EW.wave, width: 1.6 } })
      const pend = count.pending
      series.push({ type: 'line', id: 'pendl', name: '_pend', silent: true, z: 4, symbol: 'none',
        data: [[pts[pts.length - 1].time * 1000, pts[pts.length - 1].price], [pend.time * 1000, pend.price]], lineStyle: { color: EW.wave, width: 1.4, type: 'dashed', opacity: 0.8 } })
      // etichette (mai sovrapposte: massimi sopra, minimi sotto; le sotto-onde più piccole)
      pts.forEach((p) => {
        const n = p.label ? waveNotation(count, p.label, p.sub) : null
        if (n) boxes.push(ptBox(p.time, p.price, textW(n.text, p.sub ? 10 : 12) + 4, 18, p.kind === 'high', 8))
      })
      series.push({ type: 'scatter', id: 'lab', name: t('Onde'), symbol: 'circle', symbolSize: 6, z: 6,
        itemStyle: { color: EW.wave, borderColor: '#0E1424', borderWidth: 1 },
        data: pts.map((p) => {
          const n = p.label ? waveNotation(count, p.label, p.sub) : null
          return { value: [p.time * 1000, p.price], ref: p,
            label: n ? { show: true, position: p.kind === 'high' ? 'top' : 'bottom', distance: 8, ...richLabel(n, p.sub ? EW.sub : EW.label, p.sub ? (compact ? 10 : 11) : compact ? 11 : 13) } : { show: false } }
        }) })
      const pn = curNotation(count, pend.label)
      const pendKind = count.cur_dir === 'up' ? 'high' : 'low'
      boxes.push(ptBox(pend.time, pend.price, textW((pn?.text ?? waveShort(pend.label)) + ' ?', 12) + 4, 18, pendKind === 'high', 8))
      series.push({ type: 'scatter', id: 'pend', name: t('Onda in corso'), symbol: 'circle', symbolSize: 9, z: 6,
        itemStyle: { color: 'rgba(155,135,245,0.15)', borderColor: EW.wave, borderType: 'dashed', borderWidth: 1.4 },
        data: [{ value: [pend.time * 1000, pend.price], ref: pend,
          label: { show: true, position: pendKind === 'high' ? 'top' : 'bottom', distance: 8,
            ...(pn ? richLabel(pn, '#C4B5FD', compact ? 11 : 12, '?') : { formatter: `{x|${waveShort(pend.label)}?}`, rich: { x: { color: '#C4B5FD', fontSize: 11, backgroundColor: 'rgba(14,20,36,0.7)', padding: [2, 3], borderRadius: 3 } } }) } }] })
      // ---- obiettivi e proiezione
      const proj = count.projection
      if (proj.length && lastC) {
        const startPx = livePrice ?? lastC.close
        series.push({ type: 'line', id: 'ppath', name: t('Proiezione'), silent: true, z: 4, symbol: 'circle', symbolSize: 5,
          data: [[lastC.time * 1000, startPx], ...proj.map((q) => [q.time * 1000, q.price])],
          itemStyle: { color: EW.target }, lineStyle: { color: EW.target, type: 'dashed', width: 1.2, opacity: 0.8 },
          markArea: { silent: true, data: proj.map((q, i) => [
            { coord: [(i === 0 ? lastC.time : proj[i - 1].time) * 1000, q.lo], itemStyle: { color: hexA(EW.target, i === 0 ? 0.11 : 0.05), borderColor: hexA(EW.target, i === 0 ? 0.45 : 0.25), borderWidth: 1, borderType: 'dashed' } },
            { coord: [Math.max(q.t_hi, (i === 0 ? lastC.time : proj[i - 1].time) + step) * 1000, q.hi] },
          ]) } })
        series.push({ type: 'scatter', id: 'projlab', name: '_plab', symbolSize: 1, silent: true, z: 7, tooltip: { show: false }, itemStyle: { color: 'transparent' },
          data: proj.map((q, i) => {
            const up = i === 0 ? q.price >= startPx : q.price >= proj[i - 1].price
            const n = curNotation(count, q.wave, true)
            const name = n ? n.text : waveShort(q.wave)
            const two = !(compact || Math.abs(q.hi - q.lo) < 1e-6 * q.price)
            const w = textW(`${name} ~${fmtPx(q.price, true)}`, 11) + 4, h = two ? 34 : 20
            // preferred side first, pushed further out, then the other side: the first place that touches no other label
            const pref: Side = up ? 'top' : 'bottom', alt: Side = up ? 'bottom' : 'top'
            const tries: [Side, number][] = [[pref, 10], [pref, 32], [pref, 54], [alt, 10], [alt, 32], ['left', 10], ['right', 10]]
            // the first free place; if none is free, the one that overlaps least
            const pick = tries.find(([sd, dd]) => !hits(ptBox(q.time, q.price, w, h, sd, dd)))
              ?? tries.reduce((bst, cur) => (clashArea(ptBox(q.time, q.price, w, h, cur[0], cur[1])) < clashArea(ptBox(q.time, q.price, w, h, bst[0], bst[1])) ? cur : bst))
            boxes.push(ptBox(q.time, q.price, w, h, pick[0], pick[1]))
            return { value: [q.time * 1000, q.price], label: { show: true, position: pick[0], distance: pick[1], lineHeight: 14,
              formatter: !two ? `{a|${name} ~${fmtPx(q.price, true)}}` : `{a|${name} ~${fmtPx(q.price, true)}}\n{b|${fmtPx(q.lo, true)}–${fmtPx(q.hi, true)}}`,
              rich: { a: { color: '#E8ECF4', fontSize: 11, fontWeight: 600 }, b: { color: '#B3BCD0', fontSize: 10 } },
              backgroundColor: 'rgba(14,20,36,0.85)', padding: [3, 5], borderRadius: 4, borderColor: hexA(EW.target, 0.35), borderWidth: 1 } }
          }) })
        proj.forEach((q) => extent.push(q.lo, q.hi))
      }
      // ---- invalidazione
      for (const side of ['below', 'above'] as const) {
        const v = count.invalidation[side]
        if (v == null) continue
        extent.push(v)
        const txt = `${t('Invalidazione')} ${fmtPx(v, compact)}`
        const lw = textW(txt, 11), yv = ypx(v)
        const spots = side === 'below'
          ? ['insideStartBottom', 'insideStartTop', 'insideEndBottom', 'insideEndTop', 'insideMiddleBottom', 'insideMiddleTop']
          : ['insideStartTop', 'insideStartBottom', 'insideEndTop', 'insideEndBottom', 'insideMiddleTop', 'insideMiddleBottom']
        const boxAt = (pos: string): Box => {
          const x0 = pos.includes('Start') ? 0 : pos.includes('End') ? plotW - lw : (plotW - lw) / 2
          return { x0, x1: x0 + lw, y0: pos.endsWith('Top') ? yv - 20 : yv, y1: pos.endsWith('Top') ? yv : yv + 20 }
        }
        const pos = spots.find((sp) => !hits(boxAt(sp))) ?? spots[0]
        boxes.push(boxAt(pos))
        markLines.push({ yAxis: v, lineStyle: { color: EW.inv, type: 'dashed', width: 1.2, opacity: 0.9 },
          label: { show: true, position: pos, formatter: txt, color: '#F08A97', fontSize: 11,
            backgroundColor: 'rgba(14,20,36,0.8)', padding: [2, 4], borderRadius: 3 } })
      }
    }
    if (extent.length) {
      series.push({ type: 'scatter', id: 'ext', name: '_ext', symbolSize: 0, silent: true, tooltip: { show: false }, itemStyle: { color: 'transparent' },
        data: extent.map((v) => [(lastC?.time ?? 0) * 1000, v]) })
    }
    const byTime = new Map([...candles, ...(after ?? [])].map((c) => [c.time * 1000, c]))
    const fmtAx = (v: number) => fmtPx(v, true)
    return {
      grid: { left: 6, right: 6, top: 30, bottom: 6, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'axis', confine: true, axisPointer: { type: 'line', lineStyle: { color: 'rgba(148,163,184,0.35)' } },
        formatter: (raw: unknown) => {
          const ps = (Array.isArray(raw) ? raw : [raw]) as { seriesId?: string; axisValue?: number; data?: { ref?: unknown; value?: [number, number] } }[]
          const ms = Number(ps[0]?.axisValue ?? ps[0]?.data?.value?.[0])
          const c = byTime.get(ms)
          let h = `<div style="color:#94a3b8;margin-bottom:4px">${tf === '4h' ? dateTime(ms / 1000) : date(ms / 1000)}</div>`
          if (c) h += tipRow(c.close >= c.open ? C.up : C.down, t('Chiusura'), usd(c.close)) + tipRow('#8B94A7', t('Massimo'), usd(c.high)) + tipRow('#8B94A7', t('Minimo'), usd(c.low))
          for (const p of ps) {
            if (p.seriesId === 'lab' && count) {
              const r = p.data?.ref as EwCount['points'][number] | undefined
              if (r?.label) h += tipRow(EW.wave, `${t('Fine onda')} ${waveNotation(count, r.label, r.sub)?.text ?? r.label}`, usd(r.price))
              else if (r) h += tipRow(EW.wave, t('Inizio del conteggio'), usd(r.price))
            } else if (p.seriesId === 'pend' && count) {
              h += tipRow('#C4B5FD', `${waveText(count, count.pending.label)} · ${t('estremo finora')}`, usd(count.pending.price))
            }
          }
          return h
        },
      },
      xAxis: {
        type: 'time', min: xMin * 1000, max: xMax * 1000, splitNumber: compact ? 3 : 6,   // small cards: fewer ticks, no "31 Jul31 Aug"
        axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: number) => tickLabel(v / 1000, tf) },
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
      },
      // explicit extent (same as the label-collision geometry above); the odd min/max values get no tick label
      yAxis: scale === 'log'
        ? valueAxis({ type: 'log', logBase: 10, position: 'right', scale: true, min: Math.exp(yA), max: Math.exp(yB), axisLabel: { ...axisLabel, formatter: fmtAx, showMinLabel: false, showMaxLabel: false } })
        : valueAxis({ position: 'right', scale: true, min: yA, max: yB, axisLabel: { ...axisLabel, formatter: fmtAx, showMinLabel: false, showMaxLabel: false } }),
      dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'shift', moveOnMouseMove: true }],
      series,
    }
  }, [allCandles, after, count, higher, tf, scale, showChannel, showHigher, compact, livePrice, size])
  return <div ref={wrap} style={{ height }}><EChart option={option} height="100%" /></div>
}

export const tfName = (tf: EwTf) => tfLabel(tf)
export type { Elliott }
