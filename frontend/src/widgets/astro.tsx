import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AstroEventKey, AstroResponse, AstroUpcoming, EclipseKind, Hypothesis, HypId, HypUnit, MoonPhaseKey, Verdict } from '../api/astro'
import EChart from '../components/charts/EChart'
import { C, FONT, axisLabel, hexA, legendBase, timeAxis, tooltipBase, usdAxis, valueAxis } from '../components/charts/theme'
import { Badge, EmptyState, clsx } from '../components/ui'
import { date, dateTime, monthYear, pct } from '../lib/format'
import { months, t, tr, weekdays } from '../i18n'

type Num = number | null | undefined
export const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
export const signCls = (v: Num) => (!fin(v) || v === 0 ? 'text-slate-400' : v > 0 ? 'text-up' : 'text-down')
const minus = (s: string) => s.replace(/^-/, '−')

// ------------------------------------------------------------------ labels (Italian source strings, translated at render)
const HYP_LABEL: Record<HypId, string> = {
  moon_full: 'Luna piena', moon_new: 'Luna nuova', moon_halves: 'Metà nuova vs metà piena del ciclo',
  supermoon: 'Superlune', lunar_eclipse_total: 'Eclissi lunari totali (luna rossa)', lunar_eclipse_all: 'Tutte le eclissi lunari',
  solar_eclipse: 'Eclissi solari', mercury_retro: 'Mercurio retrogrado', seasons: 'Equinozi e solstizi', friday13: 'Venerdì 13',
  geomag_storm: 'Tempeste geomagnetiche', solar_cycle: 'Ciclo solare (macchie solari)',
  round_major: 'Livelli tondi principali', round_minor: 'Livelli tondi secondari', gann_sq9: 'Quadrato del 9 di Gann',
  fib_price: 'Ritracciamenti di Fibonacci', fib_time: 'Fibonacci nel tempo',
}
const HYP_DESC: Record<HypId, string> = {
  moon_full: 'Rendimento di BTC nei 7 giorni centrati sulla luna piena (da −3 a +3) contro 7 giorni qualsiasi.',
  moon_new: 'Rendimento di BTC nei 7 giorni centrati sulla luna nuova (da −3 a +3) contro 7 giorni qualsiasi.',
  moon_halves: 'Rendimento medio giornaliero nella metà del ciclo vicina alla luna nuova meno quello della metà vicina alla luna piena (Dichev e Janes 2003).',
  supermoon: 'Lune piene a meno di 360,000 km dalla Terra: rendimento nei 7 giorni centrati contro 7 giorni qualsiasi.',
  lunar_eclipse_total: 'Rendimento nei 7 giorni centrati sulle eclissi lunari totali (la luna «rossa») contro 7 giorni qualsiasi.',
  lunar_eclipse_all: 'Rendimento nei 7 giorni centrati su ogni eclissi lunare (penombrale, parziale o totale).',
  solar_eclipse: 'Rendimento nei 7 giorni centrati su ogni eclissi solare (parziale, anulare, totale o ibrida).',
  mercury_retro: 'Rendimento medio giornaliero nei giorni di Mercurio retrogrado meno quello degli altri giorni.',
  seasons: 'Rendimento nei 7 giorni centrati su equinozi e solstizi contro 7 giorni qualsiasi.',
  friday13: 'Rendimento di BTC nel venerdì 13 contro un giorno qualsiasi; il placebo sposta le date di settimane intere.',
  geomag_storm: 'Rendimento nei 6 giorni dopo l’inizio di una tempesta (Kp ≥ 5, almeno 7 giorni di quiete prima) contro 6 giorni qualsiasi (Krivelyova e Robotti 2003).',
  solar_cycle: 'Correlazione tra macchie solari (media a 13 mesi) e rendimento di BTC sui 12 mesi precedenti.',
  round_major: 'Quota di tocchi respinti ai livelli tondi principali (passo 500, 5K, 50K) contro griglie identiche spostate a caso.',
  round_minor: 'Quota di tocchi respinti ai livelli tondi secondari (passo 100, 1K, 10K) contro griglie identiche spostate a caso.',
  gann_sq9: 'Quota di tocchi respinti ai livelli del quadrato del 9 (radice del prezzo multipla di 2, un giro completo) contro griglie spostate a caso.',
  fib_price: 'Quota di ritracciamenti che terminano entro ±2.5 punti da 23.6, 38.2, 50, 61.8 o 78.6% contro insiemi di 5 rapporti casuali.',
  fib_time: 'Quota di gambe la cui durata sta entro ±8% di 0.382, 0.618, 1, 1.618 o 2.618 volte la gamba precedente contro insiemi casuali.',
}
export const hypLabel = (id: HypId | null | undefined) => (id ? t(HYP_LABEL[id]) : '—')
export const hypDesc = (id: HypId) => t(HYP_DESC[id])

const EVENT_LABEL: Record<AstroEventKey, string> = {
  full: 'Luna piena', new: 'Luna nuova', supermoon: 'Superluna', lunar_eclipse_total: 'Eclissi lunare totale', lunar_eclipse: 'Eclissi lunare',
  solar_eclipse: 'Eclissi solare', mercury_retro_start: 'Mercurio diventa retrogrado', mercury_retro_end: 'Mercurio torna diretto',
  mar_equinox: 'Equinozio di marzo', jun_solstice: 'Solstizio di giugno', sep_equinox: 'Equinozio di settembre', dec_solstice: 'Solstizio di dicembre',
  friday13: 'Venerdì 13', geomag_storm: 'Tempesta geomagnetica prevista',
}
export const eventLabel = (k: AstroEventKey) => t(EVENT_LABEL[k])

const PHASE_LABEL: Record<MoonPhaseKey, string> = {
  new: 'Luna nuova', waxing_crescent: 'Luna crescente', first_quarter: 'Primo quarto', waxing_gibbous: 'Gibbosa crescente',
  full: 'Luna piena', waning_gibbous: 'Gibbosa calante', last_quarter: 'Ultimo quarto', waning_crescent: 'Luna calante',
}
export const phaseLabel = (k: MoonPhaseKey | 'new' | 'first_quarter' | 'full' | 'last_quarter') => t(PHASE_LABEL[k])

const ECLIPSE_KIND: Record<EclipseKind, string> = { penumbral: 'Penombrale', partial: 'Parziale', annular: 'Anulare', total: 'Totale', hybrid: 'Ibrida' }
export const eclipseKind = (k: EclipseKind | undefined) => (k ? t(ECLIPSE_KIND[k]) : '—')

const VERDICT: Record<Verdict, string> = {
  none: 'Nessun effetto distinguibile dal caso', strong: 'Effetto significativo e stabile', anecdotal: 'Troppo pochi casi: aneddotico', weak: 'Effetto debole e instabile',
}
export function verdictLabel(v: Verdict | null | undefined, stable?: boolean): string {
  if (!v) return '—'
  if (v === 'weak' && stable) return t('Effetto debole: non regge alla correzione per test multipli')
  return t(VERDICT[v])
}

export function VerdictBadge({ v, stable, short }: { v: Verdict | null | undefined; stable?: boolean; short?: boolean }) {
  if (!v) return null
  const cls = v === 'strong' ? 'bg-accent-blue/10 text-white ring-accent-blue/30' : v === 'weak' ? 'bg-amber-400/10 text-amber-200 ring-amber-400/25'
    : 'bg-white/[0.04] text-slate-300 ring-white/10'
  const dot = v === 'strong' ? 'bg-accent-blue' : v === 'weak' ? 'bg-amber-300' : v === 'anecdotal' ? 'bg-slate-500' : 'bg-slate-400'
  const shortTxt = { none: t('Caso'), weak: t('Debole'), strong: t('Significativo'), anecdotal: t('Aneddotico') }[v]
  return (
    <span className={clsx('inline-flex h-5 max-w-full items-center gap-1.5 rounded-full px-2 text-2xs font-medium ring-1 ring-inset', cls)} title={verdictLabel(v, stable)}>
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <span className="truncate">{short ? shortTxt : verdictLabel(v, stable)}</span>
    </span>
  )
}

// ------------------------------------------------------------------ number formatting by unit
export function fmtEffect(v: Num, unit: HypUnit | null | undefined, signed = true): string {
  if (!fin(v)) return '—'
  const s = signed && v > 0 ? '+' : v < 0 ? '−' : ''
  const a = Math.abs(v)
  if (unit === 'r') return `${s}${a.toFixed(2)}`
  if (unit === 'pp/g') return `${s}${a.toFixed(3)} ${tr('pp/g', 'pp/d')}`
  if (unit === 'pp') return `${s}${a.toFixed(1)} pp`
  return `${s}${a.toFixed(2)}%`
}
export const fmtValue = (v: Num, unit: HypUnit | null | undefined) => (unit === 'pp' ? (fin(v) ? `${v.toFixed(1)}%` : '—') : fmtEffect(v, unit, unit !== 'r'))
export const fmtP = (p: Num) => (!fin(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(p < 0.1 ? 3 : 2))
export const unitNote = (unit: HypUnit | null | undefined) =>
  unit === '%' ? t('rendimento cumulato della finestra') : unit === 'pp/g' ? t('punti percentuali al giorno') : unit === 'pp' ? t('punti percentuali di frequenza') : t('coefficiente di correlazione')

// ------------------------------------------------------------------ live moon (Meeus, eq. 48.4) anchored to the backend value
const RAD = Math.PI / 180
/** Illuminated fraction (0..1) and elongation (0..360°) — truncated Meeus series, accurate to ~0.2%. */
export function moonApprox(ms: number): { illum: number; elong: number } {
  const jd = ms / 86400000 + 2440587.5
  const T = (jd - 2451545) / 36525
  const D = (297.8501921 + 445267.1114034 * T) % 360
  const M = (357.5291092 + 35999.0502909 * T) % 360
  const Mp = (134.9633964 + 477198.8675055 * T) % 360
  const i = 180 - D - 6.289 * Math.sin(Mp * RAD) + 2.1 * Math.sin(M * RAD) - 1.274 * Math.sin((2 * D - Mp) * RAD)
    - 0.658 * Math.sin(2 * D * RAD) - 0.214 * Math.sin(2 * Mp * RAD) - 0.11 * Math.sin(D * RAD)
  const illum = (1 + Math.cos(i * RAD)) / 2
  const dn = ((D % 360) + 360) % 360
  const pa = ((i % 360) + 360) % 360
  const elong = dn < 180 ? 180 - Math.min(pa, 360 - pa) : 180 + Math.min(pa, 360 - pa)
  return { illum, elong: ((elong % 360) + 360) % 360 }
}

export function phaseFromElong(e: number): MoonPhaseKey {
  const x = ((e % 360) + 360) % 360
  for (const [c, k] of [[0, 'new'], [90, 'first_quarter'], [180, 'full'], [270, 'last_quarter'], [360, 'new']] as [number, MoonPhaseKey][]) {
    if (Math.abs(x - c) <= 6.1) return k
  }
  return x < 90 ? 'waxing_crescent' : x < 180 ? 'waxing_gibbous' : x < 270 ? 'waning_gibbous' : 'waning_crescent'
}

/** Ticking clock (ms). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Live moon state: backend value at load + client-side Meeus drift (offset anchored on the backend reading). */
export function useLiveMoon(d: AstroResponse) {
  const now = useNow(1000)
  const base = d.moon.now
  const anchor = useMemo(() => moonApprox(base.time * 1000), [base.time])
  const cur = moonApprox(now)
  const illum = Math.min(1, Math.max(0, cur.illum + (base.illum - anchor.illum)))
  const elong = (((cur.elong + (base.elongation - anchor.elong)) % 360) + 360) % 360
  const age = d.moon.prev_new ? (now / 1000 - d.moon.prev_new) / 86400 : base.age_days
  return { now, illum, elong, waxing: elong < 180, phase: phaseFromElong(elong), age }
}

export function countdown(targetS: number, nowMs: number, withSeconds = false): string {
  let s = Math.max(0, Math.round(targetS - nowMs / 1000))
  const dd = Math.floor(s / 86400); s -= dd * 86400
  const hh = Math.floor(s / 3600); s -= hh * 3600
  const mm = Math.floor(s / 60); s -= mm * 60
  const g = tr('g', 'd')
  if (dd > 0) return withSeconds ? `${dd} ${g} ${hh} h ${String(mm).padStart(2, '0')} m` : `${dd} ${g} ${hh} h`
  if (hh > 0) return `${hh} h ${String(mm).padStart(2, '0')} m`
  return `${mm} m ${String(s).padStart(2, '0')} s`
}

// ------------------------------------------------------------------ moon illustration
/** The moon as seen from the northern hemisphere: lit limb on the right while waxing, terminator as an ellipse. */
export function MoonGlyph({ illum, waxing, size = 160, className }: { illum: number; waxing: boolean; size?: number; className?: string }) {
  const R = 48
  const k = Math.min(1, Math.max(0, illum))
  const rx = Math.abs(1 - 2 * k) * R
  const crescent = k < 0.5
  // lit limb: semicircle on the lit side (top → bottom); terminator: ellipse arc back to the top
  const limbSweep = waxing ? 1 : 0
  const termSweep = waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0)
  const lit = `M 50 2 A ${R} ${R} 0 0 ${limbSweep} 50 98 A ${rx.toFixed(3)} ${R} 0 0 ${termSweep} 50 2 Z`
  const id = `mg${Math.round(k * 1000)}${waxing ? 'w' : 'n'}`
  const maria: [number, number, number][] = [[38, 34, 9], [57, 30, 7], [62, 47, 10], [44, 55, 8], [55, 66, 6], [33, 62, 5], [70, 62, 5], [48, 78, 4]]
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} role="img" aria-label={`${Math.round(k * 100)}%`}>
      <defs>
        <radialGradient id={`${id}-dark`} cx="45%" cy="40%" r="65%">
          <stop offset="0%" stopColor="#1C2539" /><stop offset="100%" stopColor="#0B101C" />
        </radialGradient>
        <radialGradient id={`${id}-lit`} cx="42%" cy="38%" r="70%">
          <stop offset="0%" stopColor="#F4F1E8" /><stop offset="70%" stopColor="#D9D6CC" /><stop offset="100%" stopColor="#A9A79F" />
        </radialGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="70%" stopColor="rgba(232,236,244,0.10)" /><stop offset="100%" stopColor="rgba(232,236,244,0)" />
        </radialGradient>
        <clipPath id={`${id}-clip`}><path d={lit} /></clipPath>
      </defs>
      <circle cx="50" cy="50" r="50" fill={`url(#${id}-glow)`} opacity={0.4 + 0.6 * k} />
      <circle cx="50" cy="50" r={R} fill={`url(#${id}-dark)`} stroke="rgba(148,163,210,0.18)" strokeWidth="0.6" />
      {maria.map(([x, y, r], i) => <circle key={`d${i}`} cx={x} cy={y} r={r} fill="rgba(148,163,210,0.022)" />)}
      {k > 0.002 && (
        <g clipPath={`url(#${id}-clip)`}>
          <rect x="0" y="0" width="100" height="100" fill={`url(#${id}-lit)`} />
          {maria.map(([x, y, r], i) => <circle key={`l${i}`} cx={x} cy={y} r={r} fill="rgba(90,92,100,0.16)" />)}
        </g>
      )}
    </svg>
  )
}

// ------------------------------------------------------------------ effect vs placebo strip
/** Horizontal scale: grey band = 90% of placebo effects · line = 95% CI · dot = observed effect · tick = zero. */
export function EffectStrip({ h, className }: { h: Hypothesis; className?: string }) {
  const lo = h.null.q05 ?? 0, hi = h.null.q95 ?? 0
  const c0 = h.ci[0] ?? h.effect ?? 0, c1 = h.ci[1] ?? h.effect ?? 0
  const e = h.effect ?? 0
  const m = Math.max(Math.abs(lo), Math.abs(hi), Math.abs(c0), Math.abs(c1), Math.abs(e), 1e-9) * 1.12
  const x = (v: number) => 4 + ((v + m) / (2 * m)) * 192
  const col = h.verdict === 'strong' ? C.blue : h.verdict === 'weak' ? C.amber : '#B3BCD0'
  return (
    <svg viewBox="0 0 200 26" className={clsx('h-[26px] w-full', className)} preserveAspectRatio="none" role="img">
      <title>{t('Punto = effetto osservato · linea = IC 95% (bootstrap, eventi indipendenti) · fascia grigia = 90% degli effetti placebo · tratteggio = zero')}</title>
      <rect x={x(lo)} y={8} width={Math.max(1, x(hi) - x(lo))} height={10} rx={3} fill="rgba(148,163,210,0.14)" />
      <line x1={x(0)} x2={x(0)} y1={3} y2={23} stroke="rgba(232,236,244,0.35)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      <line x1={x(c0)} x2={x(c1)} y1={13} y2={13} stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <line x1={x(c0)} x2={x(c0)} y1={9} y2={17} stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <line x1={x(c1)} x2={x(c1)} y1={9} y2={17} stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={x(e)} cy={13} r={3.2} fill={col} stroke="#0E1424" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Mini({ label, value, cls, title }: { label: ReactNode; value: ReactNode; cls?: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="label truncate">{label}</div>
      <div className={clsx('tnum mt-0.5 truncate text-sm font-medium text-slate-100', cls)}>{value}</div>
    </div>
  )
}

/** Stability chips: two halves + one per halving cycle, coloured by the sign of the sub-sample effect. */
export function StabilityRow({ h }: { h: Hypothesis }) {
  const chip = (key: string, label: string, eff: Num, n: number) => {
    const ok = fin(eff) && n >= 3
    const same = ok && fin(h.effect) && Math.sign(eff) === Math.sign(h.effect)
    return (
      <span key={key} title={`${label}: ${fmtEffect(eff, h.unit)} · n=${n}`}
        className={clsx('tnum inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs ring-1 ring-inset',
          !ok ? 'text-slate-500 ring-white/5' : same ? 'bg-white/[0.05] text-slate-200 ring-white/10' : 'text-slate-400 ring-white/5 line-through decoration-slate-500/60')}>
        {label}
        <span className={clsx(ok ? signCls(eff) : 'text-slate-500')}>{ok ? (eff! > 0 ? '▲' : eff! < 0 ? '▼' : '·') : '·'}</span>
      </span>
    )
  }
  const halfLbl = [t('1ª metà'), t('2ª metà')]
  return (
    <div className="flex flex-wrap items-center gap-1">
      {h.halves.map((x, i) => chip(`h${i}`, halfLbl[i], x.effect, x.n))}
      {h.cycles.length > 0 && <span className="mx-0.5 h-3 w-px bg-white/10" />}
      {h.cycles.map((c) => chip(c.label, cycleLabel(c.label), c.effect, c.n))}
    </div>
  )
}
export const cycleLabel = (startYear: string) => {
  const y = Number(startYear)
  return y >= 2024 ? `${y}+` : `${String(y).slice(2)}–${String(y + 4).slice(2)}`
}

/** One hypothesis: verdict, effect with CI vs placebo, p values, stability. */
export function HypothesisCard({ h, extra, className }: { h: Hypothesis; extra?: ReactNode; className?: string }) {
  const nShown = h.n_events ?? h.n
  const nTitle = h.metric === 'daily_diff' ? t('{e} episodi · {d} giorni', { e: h.n_events ?? '—', d: h.n }) : h.metric === 'reject_rate' ? t('Tocchi dei livelli') : h.metric === 'corr' ? t('Mesi') : t('Eventi')
  return (
    <div className={clsx('card flex min-w-0 flex-col gap-3 px-4 py-3.5 sm:px-5', className)}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white" title={hypLabel(h.id)}>{hypLabel(h.id)}</h3>
          <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-slate-400">{hypDesc(h.id)}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2"><VerdictBadge v={h.verdict} stable={h.stable} /></div>
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="label">{t('Effetto vs controllo')}</div>
            <div className={clsx('tnum text-2xl font-semibold tracking-[-0.02em]', h.verdict === 'strong' ? signCls(h.effect) : 'text-white')}>{fmtEffect(h.effect, h.unit)}</div>
          </div>
          <div className="tnum text-right text-xs text-slate-400">
            <div>{t('IC 95%')} <span className="text-slate-200">{fmtEffect(h.ci[0], h.unit)} … {fmtEffect(h.ci[1], h.unit)}</span></div>
            <div>{t('Placebo 90%')} <span className="text-slate-300">{fmtEffect(h.null.q05, h.unit)} … {fmtEffect(h.null.q95, h.unit)}</span></div>
          </div>
        </div>
        <EffectStrip h={h} className="mt-2" />
      </div>
      <div className="grid grid-cols-4 gap-3 border-t border-line pt-3">
        <Mini label="n" value={nShown} title={nTitle} cls={nShown < 12 ? 'text-amber-300' : undefined} />
        <Mini label="p" value={fmtP(h.p)} title={t('p-value del placebo (bilaterale)')} />
        <Mini label={t('p BH')} value={fmtP(h.p_bh)} title={t('p corretto per test multipli (Benjamini-Hochberg)')} cls={fin(h.p_bh) && h.p_bh < 0.05 ? 'text-white' : undefined} />
        {h.unit === '%' || h.unit === 'pp/g'
          ? <Mini label={t('Rialzo')} value={fin(h.up_rate) ? `${h.up_rate.toFixed(0)}%` : '—'} title={t('Quota in rialzo vs normale {b}%', { b: fin(h.up_base) ? h.up_base.toFixed(0) : '—' })} />
          : <Mini label={h.unit === 'r' ? t('p ingenuo') : t('Osservato')} value={h.unit === 'r' ? fmtP(h.naive_p) : fmtValue(h.observed, h.unit)}
              title={h.unit === 'r' ? t('p del test t classico, che ignora l’autocorrelazione delle serie') : t('Controllo {b}', { b: fmtValue(h.baseline, h.unit) })} />}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="label">{t('Stabilità: metà del campione e cicli dell’halving')}</div>
        <StabilityRow h={h} />
      </div>
      {extra}
    </div>
  )
}

// ------------------------------------------------------------------ upcoming list
export function UpcomingAstroList({ items, nowMs, max, compact }: { items: AstroUpcoming[]; nowMs: number; max?: number; compact?: boolean }) {
  const list = max ? items.slice(0, max) : items
  const dow = weekdays()
  const mon = months()
  if (!list.length) return <EmptyState compact text={t('Nessun evento nei prossimi giorni')} />
  return (
    <ul className={clsx('grid gap-x-8', !compact && 'xl:grid-cols-2')}>
      {list.map((u) => {
        const dateOnly = u.key === 'friday13'
        const d = new Date(u.time * 1000)
        const day = dateOnly ? d.getUTCDate() : d.getDate(), mo = dateOnly ? d.getUTCMonth() : d.getMonth(), wd = dateOnly ? d.getUTCDay() : d.getDay()
        const past = u.time * 1000 < nowMs
        const detail = u.kind ? eclipseKind(u.kind) : u.key === 'supermoon' && fin(u.distance_km) ? t('{km} km dalla Terra', { km: u.distance_km.toLocaleString('en-US') })
          : u.key === 'geomag_storm' && fin(u.kp) ? `Kp ${u.kp.toFixed(1)} · NOAA` : null
        const win = u.window ? (u.window[0] === u.window[1] ? t('nel giorno') : u.window[0] < 0 ? t('±{k} g', { k: u.window[1] }) : t('+{a}..+{b} g', { a: u.window[0], b: u.window[1] })) : t('periodo')
        return (
          <li key={u.id} className={clsx('grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2.5 first:border-t-0', !compact && 'xl:[&:nth-child(2)]:border-t-0')}>
            <div className="flex flex-col items-center border-r border-line py-1 pr-2 leading-tight">
              <span className="tnum text-base font-semibold text-white">{day}</span>
              <span className="text-2xs uppercase text-slate-400">{mon[mo]}</span>
              <span className="text-2xs capitalize text-slate-500">{dow[wd]}</span>
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium text-white">{eventLabel(u.key)}</span>
                {detail && <Badge>{detail}</Badge>}
              </div>
              <div className="tnum mt-0.5 truncate text-xs text-slate-400">
                {past ? t('In corso') : t('Tra {c}', { c: countdown(u.time, nowMs) })} · {dateOnly ? date(u.time) : dateTime(u.time)}
              </div>
            </div>
            <div className="w-32 text-right sm:w-56">
              <VerdictBadge v={u.verdict} short />
              <div className="tnum mt-1 truncate text-2xs text-slate-400" title={u.hyp ? hypDesc(u.hyp) : undefined}>
                {u.unit === '%' && fin(u.observed)
                  ? t('{w}: {o} vs {b} · n={n}', { w: win, o: fmtEffect(u.observed, '%'), b: fmtEffect(u.baseline, '%'), n: u.n ?? '—' })
                  : u.unit === 'pp/g' && fin(u.effect) ? t('{w}: {e} vs normale · n={n}', { w: win, e: fmtEffect(u.effect, 'pp/g'), n: u.n ?? '—' })
                    : t('Nessuno storico')}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ------------------------------------------------------------------ charts
const pctAxis = (d = 1) => (v: number) => `${minus(v.toFixed(d))}%`

/** Mean daily return by synodic day (12° bins) with 95% CI and the placebo 5–95% band. */
export function LunarProfileChart({ d, height = '100%' }: { d: AstroResponse; height?: number | string }) {
  const option = useMemo(() => {
    const p = d.moon.profile
    const cats = p.map((x) => x.day)
    const sMean = t('Media giornaliera')
    const sBand = t('Banda placebo 90%')
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sMean, sBand] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { dataIndex: number }[]) => {
          const x = p[ps[0]?.dataIndex ?? 0]
          if (!x) return ''
          return `<div style="color:${C.muted};margin-bottom:4px">${t('Giorno {d} del ciclo · elongazione {e}°', { d: x.day, e: x.deg })}</div>` +
            `<div style="display:flex;justify-content:space-between;gap:16px"><span>${sMean}</span><b>${fmtEffect(x.mean, '%')}</b></div>` +
            `<div style="display:flex;justify-content:space-between;gap:16px"><span>${t('IC 95%')}</span><span>${fmtEffect(x.lo, '%')} … ${fmtEffect(x.hi, '%')}</span></div>` +
            `<div style="display:flex;justify-content:space-between;gap:16px"><span>${sBand}</span><span>${fmtEffect(x.placebo_lo, '%')} … ${fmtEffect(x.placebo_hi, '%')}</span></div>` +
            `<div style="color:${C.muted};margin-top:4px">n = ${x.n} ${tr('giorni', 'days')}</div>`
        },
      },
      xAxis: {
        type: 'category', data: cats, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: { ...axisLabel, interval: 0, formatter: (v: string) => ({ 0: t('Nuova'), 7: t('Primo quarto'), 15: t('Piena'), 22: t('Ultimo quarto') } as Record<string, string>)[v] ?? '' },
      },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: pctAxis(2) } }),
      series: [
        { name: '_lo', type: 'line', data: p.map((x) => x.placebo_lo), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, silent: true },
        { name: sBand, type: 'line', data: p.map((x) => (fin(x.placebo_hi) && fin(x.placebo_lo) ? x.placebo_hi - x.placebo_lo : null)), stack: 'band', symbol: 'none',
          lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(148,163,210,0.16)' }, itemStyle: { color: 'rgba(148,163,210,0.5)' }, silent: true },
        { name: sMean, type: 'bar', data: p.map((x) => x.mean), barMaxWidth: 12,
          itemStyle: { borderRadius: 2, color: (q: { value: number }) => (q.value >= 0 ? hexA(C.up, 0.7) : hexA(C.down, 0.7)) } },
      ],
    }
  }, [d])
  return <EChart option={option} height={height} />
}

/** Average cumulative path −7..+7 days around full and new moons vs the placebo band. */
export function MoonPathChart({ d, height = '100%' }: { d: AstroResponse; height?: number | string }) {
  const option = useMemo(() => {
    const full = d.moon.paths.full ?? []
    const nw = d.moon.paths.new ?? []
    const days = full.map((x) => x.day)
    const sFull = t('Luna piena')
    const sNew = t('Luna nuova')
    const sBand = t('Banda placebo 90%')
    const sMid = t('Mediana placebo')
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sFull, sNew, sMid, sBand] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: number; axisValue: string }[]) => {
          const day = Number(ps[0]?.axisValue)
          const head = day === 0 ? tr("Giorno dell'evento", 'Event day') : `${tr('Giorno', 'Day')} ${day > 0 ? '+' : '−'}${Math.abs(day)}`
          return `<div style="color:${C.muted};margin-bottom:4px">${head}</div>` +
            ps.filter((p) => !p.seriesName.startsWith('_') && p.seriesName !== sBand)
              .map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.seriesName}</span><b>${pct(p.value, 2)}</b></div>`).join('')
        },
      },
      xAxis: { type: 'category', data: days, boundaryGap: false, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: { ...axisLabel, formatter: (v: string) => (Number(v) === 0 ? tr('Evento', 'Event') : `${Number(v) > 0 ? '+' : ''}${minus(v)}`) } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: pctAxis(1) } }),
      series: [
        { name: '_lo', type: 'line', data: full.map((x) => x.placebo_lo), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, silent: true },
        { name: sBand, type: 'line', data: full.map((x) => (fin(x.placebo_hi) && fin(x.placebo_lo) ? x.placebo_hi - x.placebo_lo : null)), stack: 'band', symbol: 'none',
          lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(148,163,210,0.14)' }, itemStyle: { color: 'rgba(148,163,210,0.5)' }, silent: true },
        { name: sMid, type: 'line', data: full.map((x) => x.placebo_mid), symbol: 'none', lineStyle: { width: 1, type: 'dashed', color: C.grey2 }, itemStyle: { color: C.grey2 } },
        { name: sFull, type: 'line', data: full.map((x) => x.mean), symbol: 'none', lineStyle: { width: 2, color: C.primary }, itemStyle: { color: C.primary },
          markLine: { symbol: 'none', silent: true, data: [{ xAxis: '0' }], lineStyle: { color: hexA(C.primary, 0.3), type: 'dashed' }, label: { show: false } } },
        { name: sNew, type: 'line', data: nw.map((x) => x.mean), symbol: 'none', lineStyle: { width: 2, color: C.purple }, itemStyle: { color: C.purple } },
      ],
    }
  }, [d])
  return <EChart option={option} height={height} />
}

/** BTC (log) with Mercury retrograde periods shaded. */
export function MercuryChart({ d, height = '100%' }: { d: AstroResponse; height?: number | string }) {
  const option = useMemo(() => {
    const candles = d.candles
    const line = candles.map((c) => [c.time * 1000, c.close])
    const t0 = candles[0]?.time ?? 0
    const areas = d.mercury.periods.filter((p) => p.end >= t0).map((p) => [{ xAxis: p.start * 1000 }, { xAxis: p.end * 1000 }])
    const sBtc = 'BTC'
    const sRet = t('Mercurio retrogrado')
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sBtc, sRet] },
      tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v: number) => usdAxis(v) },
      xAxis: timeAxis(),
      yAxis: valueAxis({ type: 'log', axisLabel: { ...axisLabel, formatter: (v: number) => usdAxis(v) } }),
      series: [
        { name: sBtc, type: 'line', data: line, symbol: 'none', lineStyle: { width: 1.5, color: C.btc }, itemStyle: { color: C.btc },
          markArea: { silent: true, itemStyle: { color: 'rgba(155,135,245,0.13)' }, data: areas } },
        { name: sRet, type: 'line', data: [], itemStyle: { color: 'rgba(155,135,245,0.6)' } },
      ],
    }
  }, [d])
  return <EChart option={option} height={height} />
}

/** Monthly sunspot number (raw + 13-month smoothed + NOAA forecast) vs BTC price (log, right axis). */
export function SolarChart({ d, height = '100%' }: { d: AstroResponse; height?: number | string }) {
  const option = useMemo(() => {
    const m = d.solar.monthly
    const pr = d.solar.predicted.filter((x) => !m.length || x.time > m[m.length - 1].time - 86400 * 40)
    const sRaw = t('Macchie solari (mensile)')
    const sSm = t('Media a 13 mesi')
    const sPr = t('Previsione NOAA')
    const sBtc = t('BTC (scala log)')
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sRaw, sSm, sPr, sBtc] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: { seriesName: string; value: [number, number]; axisValue: number }[]) => {
          const head = date(Math.round(Number(ps[0]?.axisValue) / 1000))
          return `<div style="color:${C.muted};margin-bottom:4px">${head}</div>` + ps.filter((p) => !p.seriesName.startsWith('_') && fin(p.value?.[1]))
            .map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.seriesName}</span><b>${p.seriesName === sBtc ? usdAxis(p.value[1]) : p.value[1].toFixed(0)}</b></div>`).join('')
        },
      },
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ min: 0, axisLabel: { ...axisLabel } }),
        valueAxis({ type: 'log', position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => usdAxis(v) } }),
      ],
      series: [
        { name: sRaw, type: 'bar', data: m.map((x) => [x.time * 1000, x.ssn]), barMaxWidth: 4, itemStyle: { color: hexA(C.amber, 0.35) } },
        { name: sSm, type: 'line', data: m.map((x) => [x.time * 1000, x.smooth]), symbol: 'none', lineStyle: { width: 2, color: C.amber }, itemStyle: { color: C.amber } },
        { name: '_lo', type: 'line', data: pr.map((x) => [x.time * 1000, x.lo]), stack: 'pr', symbol: 'none', lineStyle: { opacity: 0 }, silent: true },
        { name: '_band', type: 'line', data: pr.map((x) => [x.time * 1000, fin(x.hi) && fin(x.lo) ? x.hi - x.lo : null]), stack: 'pr', symbol: 'none',
          lineStyle: { opacity: 0 }, areaStyle: { color: hexA(C.amber, 0.1) }, silent: true },
        { name: sPr, type: 'line', data: pr.map((x) => [x.time * 1000, x.ssn]), symbol: 'none', lineStyle: { width: 1.5, type: 'dashed', color: C.amber }, itemStyle: { color: C.amber } },
        { name: sBtc, type: 'line', yAxisIndex: 1, data: m.map((x) => [x.time * 1000, x.close]), symbol: 'none', lineStyle: { width: 1.5, color: C.btc }, itemStyle: { color: C.btc } },
      ],
    }
  }, [d])
  return <EChart option={option} height={height} />
}

/** Planetary Kp: recent 3-hour values + NOAA 3-day forecast, G-scale thresholds. */
export function KpChart({ d, height = '100%' }: { d: AstroResponse; height?: number | string }) {
  const option = useMemo(() => {
    const obs = d.geomag.recent
    const fc = d.geomag.forecast
    const sObs = t('Kp osservato')
    const sFc = t('Previsione NOAA')
    const col = (v: number) => (v >= 7 ? C.down : v >= 5 ? C.amber : hexA(C.blue, 0.75))
    return {
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [sObs, sFc] },
      tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v: number) => (fin(v) ? v.toFixed(2) : '—') },
      xAxis: timeAxis(),
      yAxis: valueAxis({ min: 0, max: 9, interval: 3, axisLabel: { ...axisLabel } }),
      series: [
        { name: sObs, type: 'bar', data: obs.map((x) => ({ value: [x.time * 1000, x.kp], itemStyle: { color: col(x.kp ?? 0) } })), barMaxWidth: 6,
          markLine: { symbol: 'none', silent: true, data: [{ yAxis: 5 }], lineStyle: { color: hexA(C.amber, 0.5), type: 'dashed' },
            label: { color: C.muted, fontFamily: FONT, fontSize: 10, formatter: 'G1', position: 'insideEndTop' } } },
        { name: sFc, type: 'bar', data: fc.map((x) => ({ value: [x.time * 1000, x.kp], itemStyle: { color: hexA(col(x.kp ?? 0), 0.35), borderColor: col(x.kp ?? 0), borderWidth: 1 } })), barMaxWidth: 6,
          itemStyle: { color: hexA(C.blue, 0.3) } },
      ],
    }
  }, [d])
  return <EChart option={option} height={height} />
}

/** Histogram of observed Fibonacci ratios with the Fibonacci levels marked. */
export function FibHistChart({ h, height = '100%' }: { h: Hypothesis; height?: number | string }) {
  const option = useMemo(() => {
    const hist = h.ratios_hist ?? []
    const isTime = h.id === 'fib_time'
    const fmt = (v: number) => (isTime ? `${v.toFixed(2)}×` : `${(v * 100).toFixed(0)}%`)
    const lv = h.levels ?? []
    const near = (x: number) => lv.some((f) => (isTime ? Math.abs(Math.log(x / f)) <= 0.077 : Math.abs(x - f) <= 0.025))
    return {
      grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { dataIndex: number }[]) => {
        const b = hist[ps[0]?.dataIndex ?? 0]
        return b ? `<div style="color:${C.muted}">${fmt(b.x ?? 0)}</div><b>${b.n}</b> ${isTime ? tr('gambe', 'legs') : tr('ritracciamenti', 'retracements')}` : ''
      } },
      xAxis: { type: 'category', data: hist.map((b) => b.x), axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: string) => fmt(Number(v)) } },
      yAxis: valueAxis({ minInterval: 1, axisLabel: { ...axisLabel } }),
      series: [{ type: 'bar', data: hist.map((b) => ({ value: b.n, itemStyle: { color: near(b.x ?? -1) ? hexA(C.purple, 0.85) : 'rgba(148,163,210,0.35)', borderRadius: 2 } })), barCategoryGap: '12%' }],
    }
  }, [h])
  return <EChart option={option} height={height} />
}

/** Distribution of the rejection rate on the random control grids vs the round/Gann grid (centred on the control mean). */
export function ControlHistChart({ h, height = '100%' }: { h: Hypothesis; height?: number | string }) {
  const option = useMemo(() => {
    const hist = h.control_hist ?? []
    const eff = h.effect ?? 0
    const xs = hist.map((b) => b.x ?? 0)
    const step = xs.length > 1 ? xs[1] - xs[0] : 1
    const lo = Math.min(...xs, eff) - step, hi = Math.max(...xs, eff) + step
    return {
      grid: { left: 8, right: 16, top: 22, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: (p: { value: [number, number] }) => `${fmtEffect(p.value[0], 'pp')}<br/><b>${p.value[1]}</b> ${tr('griglie', 'grids')}` },
      xAxis: { type: 'value', min: lo, max: hi, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { ...axisLabel, formatter: (v: number) => fmtEffect(v, 'pp') } },
      yAxis: valueAxis({ minInterval: 1, axisLabel: { ...axisLabel } }),
      series: [{
        type: 'bar', data: hist.map((b) => [b.x, b.n]), barWidth: '90%', itemStyle: { color: 'rgba(148,163,210,0.35)', borderRadius: 2 },
        markLine: { symbol: 'none', silent: true, data: [{ xAxis: eff }], lineStyle: { color: h.verdict === 'strong' ? C.blue : C.primary, width: 2 },
          label: { color: C.text, fontFamily: FONT, fontSize: 11, formatter: t('Livelli testati'), position: 'end' } },
      }],
    }
  }, [h])
  return <EChart option={option} height={height} />
}

/** Event-level returns (one bar per event) for small samples — anecdotal by construction. */
export function EventBars({ h, height = '100%' }: { h: Hypothesis; height?: number | string }) {
  const option = useMemo(() => {
    const v = h.values ?? []
    return {
      grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: 'axis', formatter: (ps: { dataIndex: number }[]) => {
        const x = v[ps[0]?.dataIndex ?? 0]
        return x ? `<div style="color:${C.muted}">${date(x.time)}</div><b>${fmtEffect(x.ret, '%')}</b>` : ''
      } },
      xAxis: { type: 'category', data: v.map((x) => x.time), axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: { ...axisLabel, hideOverlap: true, formatter: (s: string) => monthYear(Number(s)) } },
      yAxis: valueAxis({ axisLabel: { ...axisLabel, formatter: pctAxis(0) } }),
      series: [{ type: 'bar', data: v.map((x) => x.ret), barMaxWidth: 14,
        itemStyle: { borderRadius: 2, color: (q: { value: number }) => (q.value >= 0 ? hexA(C.up, 0.7) : hexA(C.down, 0.7)) },
        markLine: { symbol: 'none', silent: true, data: [{ yAxis: h.baseline ?? 0 }], lineStyle: { color: hexA(C.primary, 0.5), type: 'dashed' },
          label: { color: C.muted, fontFamily: FONT, fontSize: 10, formatter: t('Normale'), position: 'insideEndTop' } } }],
    }
  }, [h])
  return <EChart option={option} height={height} />
}
