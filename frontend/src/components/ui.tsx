import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, Info, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { ApiError } from '../api/client'
import { pct, pts, TONE_LABEL, updatedAgo } from '../lib/format'
import { t } from '../i18n'
import { ACCENT_HEX, GROUP_ACCENT, navFor, type Accent } from '../lib/nav'
import { useLocation } from 'react-router-dom'
import { hexA } from './charts/theme'

export { clsx }

/*
 * Shared UI kit — v3 "ink" system:
 *  deep navy surfaces with top-lit gradient cards, 1px gradient hairline borders, soft shadows · radius 16 card / 10 control / pill
 *  accent hues (btc / blue / violet / teal / amber) only in small tinted icon badges, kickers and sparklines; green/red = up/down only
 *  type: Geist Variable · 11 label (UPPERCASE) · 12 meta · 13 body · 15 card title · 24 page title · 28 hero KPI · tabular numbers
 */

// ------------------------------------------------------------------ tokens
/** Standard lucide icon sizes. */
export const ICON = { nav: 16, header: 16, kpi: 16, chip: 14, inline: 14, state: 16 } as const
export const COLORS = {
  text: '#E8ECF4', text2: '#B3BCD0', muted: '#8892A8', disabled: '#566079',
  up: '#2EBD85', down: '#EF5466', amber: '#E8B04B', blue: '#5B8DEF', btc: '#F7931A',
  bg: '#060912', surface: '#0E1424', raised: '#161E31', border: 'rgba(148,163,210,0.10)',
} as const
export type { Accent }
export { ACCENT_HEX }

function sized(icon: ReactNode, size: number, strokeWidth = 1.75): ReactNode {
  if (isValidElement(icon)) return cloneElement(icon as ReactElement<{ size?: number; strokeWidth?: number }>, { size, strokeWidth })
  return icon
}

/** Rounded icon tile with a muted tint of the accent hue (KPI cards, card headers, page titles, nav). */
export function IconBadge({ icon, accent = 'slate', size = 'md', className }: { icon: ReactNode; accent?: Accent; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const hex = ACCENT_HEX[accent]
  const dim = size === 'sm' ? 'h-6 w-6 rounded-md' : size === 'lg' ? 'h-10 w-10 rounded-xl' : 'h-8 w-8 rounded-[10px]'
  return (
    <span className={clsx('relative inline-grid shrink-0 place-items-center', dim, className)}
      style={{
        color: hex,
        background: `linear-gradient(180deg, ${hexA(hex, 0.2)}, ${hexA(hex, 0.08)})`,
        boxShadow: `inset 0 0 0 1px ${hexA(hex, 0.22)}, inset 0 1px 0 ${hexA('#ffffff', 0.08)}`,
      }}>
      {sized(icon, size === 'sm' ? 13 : size === 'lg' ? 19 : 16, 2)}
    </span>
  )
}

/** Legacy name: renders the icon as a tinted badge when an accent is given, otherwise as a plain muted icon. */
export function IconBox({ icon, className, accent }: { icon: ReactNode; color?: string; className?: string; size?: 'sm' | 'md'; accent?: Accent }) {
  if (accent) return <IconBadge icon={icon} accent={accent} size="sm" className={className} />
  return <span className={clsx('inline-flex shrink-0 items-center text-slate-400', className)}>{sized(icon, ICON.header)}</span>
}

// ------------------------------------------------------------------ Card
/** Top-lit gradient surface, 16px radius, 1px gradient hairline + soft shadow. `interactive` brightens the border on hover. */
export function Card({ children, className, interactive }: { children: ReactNode; className?: string; glow?: 'btc' | 'blue'; interactive?: boolean }) {
  return (
    <section className={clsx('card relative flex min-w-0 flex-col', interactive && 'card-hover', className)}>
      {children}
    </section>
  )
}

/** Small (i) affordance: long explanations live here instead of in subtitles. */
export function InfoTip({ text, className }: { text: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <span ref={ref} className={clsx('relative inline-flex', className)}>
      <button type="button" aria-label={t('Informazioni')} onClick={() => setOpen((o) => !o)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
        className="-m-1.5 grid h-8 w-8 place-items-center rounded text-slate-500 transition-colors hover:text-white">
        <Info size={14} strokeWidth={1.75} />
      </button>
      {open && (
        <span role="tooltip" className="pop pop-in absolute left-0 top-7 z-50 w-72 rounded-xl p-3 text-xs font-normal normal-case leading-relaxed tracking-normal text-slate-300">
          {text}
        </span>
      )}
    </span>
  )
}

/**
 * "Aggiornato 12s fa" — subtle freshness hint for primary data cards. "Aggiornato ora" under 5 s; turns amber when the data is
 * older than 2× the expected refresh `interval` (ms, default 60 s). Pass react-query's `dataUpdatedAt` (ms).
 */
export function Updated({ at, className, interval = 60_000 }: { at: number | null | undefined; className?: string; interval?: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 5000)
    return () => clearInterval(id)
  }, [])
  if (!at) return null
  const age = Date.now() - at
  const stale = age > 2 * interval
  return (
    <span className={clsx('tnum inline-flex items-center gap-1 whitespace-nowrap text-2xs font-normal', stale ? 'text-amber-400' : 'text-slate-500', className)}
      title={new Date(at).toLocaleString()}>
      <span className={clsx('h-1 w-1 rounded-full', stale ? 'bg-amber-400' : 'bg-slate-500')} />
      {age < 5000 ? t('Aggiornato ora') : updatedAgo(at)}
    </span>
  )
}

/**
 * The one card header: optional tinted icon badge · 15px/600 title · optional ≤60-char subtitle · optional (i) popover ·
 * optional "Aggiornato Xs fa" (pass `updatedAt` = query.dataUpdatedAt) · actions right-aligned on the title line.
 * Use `icon` + `accent` sparingly (main cards of a page); plain text titles are the default.
 */
export function CardHeader({
  title, right, subtitle, info, className, icon, accent, updatedAt, kicker, interval, noIcon,
}: {
  title: ReactNode; icon?: ReactNode; right?: ReactNode; subtitle?: ReactNode; info?: ReactNode; className?: string
  accent?: Accent; updatedAt?: number | null; kicker?: ReactNode
  /** expected refresh interval (ms) for the stale hint */
  interval?: number
  /** only for headers nested inside another card's body */
  noIcon?: boolean
}) {
  const loc = useLocation()
  const nav = navFor(loc.pathname)
  const acc: Accent = accent ?? (nav ? GROUP_ACCENT[nav.group] : 'slate')
  const ic = icon ?? (nav ? <nav.icon /> : null)
  return (
    <header className={clsx('mb-3 flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5 sm:px-5', className)}>
      <div className="flex min-w-0 flex-[1_1_240px] items-center gap-3">
        {!noIcon && ic && <IconBadge icon={ic} accent={acc} />}
        <div className="min-w-0">
          {kicker && <div className="label mb-0.5" style={accent ? { color: ACCENT_HEX[accent] } : undefined}>{kicker}</div>}
          <h2 className="flex min-h-7 items-center gap-1.5 text-title font-semibold tracking-[-0.01em] text-white">
            <span className="min-w-0 max-sm:line-clamp-2 sm:truncate" title={typeof title === 'string' ? title : undefined}>{title}</span>
            {info && <InfoTip text={info} />}
          </h2>
          {(subtitle || updatedAt) ? (
            <p className="line-clamp-2 text-xs text-slate-400">
              {subtitle}
              {updatedAt ? <Updated at={updatedAt} interval={interval} className={clsx('align-middle', subtitle ? 'ml-2' : '')} /> : null}
            </p>
          ) : null}
        </div>
      </div>
      {right && <div className="flex min-h-7 min-w-0 max-w-full flex-wrap items-center gap-2">{right}</div>}
    </header>
  )
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('min-w-0 flex-1 px-4 pb-4 sm:px-5 sm:pb-5', className)}>{children}</div>
}

/** Flex-grow area for charts: fills the remaining card height (min `min` px). Render the chart with height="100%". */
export function Fill({ min, children, className }: { min: number; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('relative min-w-0 flex-1', className)} style={{ minHeight: min }}>
      <div className="absolute inset-0">{children}</div>
    </div>
  )
}

/** Small uppercase label used inside cards. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('label mb-2', className)}>{children}</div>
}

/** Section header for long pages: groups several cards under one heading (short accent bar). */
export function Section({ title, subtitle, right, children, className }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={clsx('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 pb-1 pt-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-1 h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-btc to-btc/20" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-white">{title}</h2>
            {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
          </div>
        </div>
        {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  )
}

/** Methodology / reference text: collapsed "Metodo" footer, 12px muted. */
export function MethodNote({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <details className={clsx('card group px-4 py-2.5 text-xs text-slate-400 sm:px-5', className)}>
      <summary className="flex items-center gap-2 font-medium text-slate-300 hover:text-white">
        <ChevronDown size={14} className="transition-transform group-open:rotate-180" />{title ?? t('Metodo')}
      </summary>
      <div className="mt-2 space-y-2 leading-relaxed">{children}</div>
    </details>
  )
}

// ------------------------------------------------------------------ KPI cards
/** Row of KPI cards (separate lifted tiles with a 12px gap), responsive columns. */
export function KpiStrip({ children, className, cols = 'grid-cols-2 md:grid-cols-3 min-[1700px]:grid-cols-6' }: { children: ReactNode; className?: string; cols?: string }) {
  return <div className={clsx('grid gap-3', cols, className)}>{children}</div>
}

/**
 * One KPI tile everywhere: [icon badge] UPPERCASE label · 28px value · ALWAYS one 12px sub-line ("—" when empty) · optional
 * sparkline or a vertically-centred aside (gauge/ring). `delta` and `foot` share the single sub-line. Non-numeric states:
 * a short word as value + the detail in `foot`. Give every tile of a strip an `icon` (same policy per strip).
 */
export function KpiCell({ label, value, delta, foot, spark, aside, title, className, accent, icon }: {
  label: ReactNode; value: ReactNode; delta?: ReactNode; foot?: ReactNode; spark?: ReactNode; aside?: ReactNode; title?: string; className?: string
  /** @deprecated all tiles use the 28px value */
  size?: 'md' | 'lg'
  accent?: boolean | Accent
  icon?: ReactNode
}) {
  const acc: Accent | undefined = accent === true ? 'btc' : accent || undefined
  const hasDelta = delta != null && delta !== false && delta !== ''
  const hasFoot = foot != null && foot !== false && foot !== ''
  return (
    <div className={clsx('card kpi relative flex min-w-0 flex-col px-4 py-3.5 sm:px-5', className)} title={title}>
      <div className="kpi-row flex min-w-0 items-center gap-2.5">
        {icon && <IconBadge icon={icon} accent={acc ?? 'slate'} size="sm" className="kpi-icon" />}
        <div className="kpi-label label min-w-0 truncate" title={typeof label === 'string' ? label : undefined}>{label}</div>
      </div>
      <div className={clsx('kpi-row mt-2 flex items-center gap-3', aside && '-my-1.5')}>
        <div className="kpi-value tnum min-w-0 flex-1 truncate text-3xl font-semibold tracking-[-0.02em] text-white [&_*]:!text-white">{value}</div>
        {aside && <div className="grid h-[72px] w-[72px] shrink-0 place-items-center">{aside}</div>}
      </div>
      <div className="kpi-row tnum mt-1 flex min-w-0 items-baseline gap-1.5 truncate text-xs text-slate-400">
        {hasDelta && <span className="shrink-0">{delta}</span>}
        {hasDelta && hasFoot && <span className="text-slate-600">·</span>}
        {hasFoot && <span className="kpi-foot-text min-w-0 truncate text-slate-400" title={typeof foot === 'string' ? foot : undefined}>{foot}</span>}
        {!hasDelta && !hasFoot && <span className="text-slate-600">—</span>}
      </div>
      {spark && <div className="pointer-events-none mt-2 h-9">{spark}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ States
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div data-skeleton className={clsx('relative overflow-hidden rounded-lg bg-white/[0.04]', className)} style={style}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" />
    </div>
  )
}

export function SkeletonBlock({ rows = 4, chart = false, className }: { rows?: number; chart?: boolean; className?: string }) {
  return (
    <div className={clsx('flex flex-col gap-3', className)}>
      {chart && <Skeleton className="h-48 w-full" />}
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-4" />
      ))}
    </div>
  )
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return t('Questa sezione non è ancora disponibile sul server.')
    if (err.status === 503) return t('Dati in fase di sincronizzazione, riprova tra poco.')
    if (err.status >= 500) return t('Il server ha avuto un problema nel calcolo dei dati.')
    return err.message
  }
  if (err instanceof TypeError) return t('Impossibile contattare il server. Verifica la connessione.')
  return t('Si è verificato un errore imprevisto.')
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-2 text-center', compact ? 'py-4' : 'py-10')}>
      <IconBadge icon={<AlertTriangle />} accent="amber" />
      <div>
        <p className="text-sm font-medium text-slate-200">{t('Dati non disponibili')}</p>
        <p className="mt-0.5 max-w-xs text-xs text-slate-400">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="btn-ghost">
          <RefreshCw size={ICON.chip} /> {t('Riprova')}
        </button>
      )}
    </div>
  )
}

export function EmptyState({ text, compact }: { text?: string; compact?: boolean }) {
  return <p className={clsx('text-center text-sm text-slate-400', compact ? 'py-4' : 'py-10')}>{text ?? t('Nessun dato disponibile')}</p>
}

/** Renders loading / error / empty / data states for a react-query result. */
export function Q<D>({
  q, children, loading, isEmpty, empty, compact,
}: {
  q: UseQueryResult<D>
  children: (data: D) => ReactNode
  loading?: ReactNode
  isEmpty?: (d: D) => boolean
  empty?: string
  compact?: boolean
}) {
  if (q.isPending) return <>{loading ?? <SkeletonBlock rows={4} />}</>
  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact={compact} />
  const data = q.data as D
  if (data == null || (isEmpty && isEmpty(data))) return <EmptyState text={empty} compact={compact} />
  return <>{children(data)}</>
}

// ------------------------------------------------------------------ Bits
export function Change({ value, className, digits = 2, suffix }: { value: number | null | undefined; className?: string; digits?: number; suffix?: string }) {
  const tone = value == null ? 'flat' : value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  return (
    <span className={clsx('tnum font-medium', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'flat' && 'text-slate-400', className)}>
      {pct(value, digits)}
      {suffix && <span className="ml-1 font-normal text-slate-500">{suffix}</span>}
    </span>
  )
}

/** Signed change in percentage POINTS (e.g. dominance): "+0.27 pt", coloured like <Change>. */
export function PointsChange({ value, className, digits = 2, suffix }: { value: number | null | undefined; className?: string; digits?: number; suffix?: string }) {
  const tone = value == null ? 'flat' : value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  return (
    <span className={clsx('tnum font-medium', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'flat' && 'text-slate-400', className)}>
      {pts(value, digits)}
      {suffix && <span className="ml-1 font-normal text-slate-500">{suffix}</span>}
    </span>
  )
}

const toneText = { bullish: 'text-up bg-up/10 ring-up/20', bearish: 'text-down bg-down/10 ring-down/20', neutral: 'text-slate-300 bg-white/[0.05] ring-white/10' }
const toneDot = { bullish: 'bg-up', bearish: 'bg-down', neutral: 'bg-slate-400' }
/** Direction as a soft tinted pill with a 6px dot. */
export function ToneBadge({ tone, label, className }: { tone: string; label?: string; className?: string }) {
  const tn = (tone in toneText ? tone : 'neutral') as keyof typeof toneText
  return (
    <span className={clsx('inline-flex h-5 w-fit items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-2xs font-medium ring-1 ring-inset', toneText[tn], className)}>
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', toneDot[tn])} />
      {label ?? TONE_LABEL[tn] ?? tone}
    </span>
  )
}

/** Small tag. Colour only where it carries meaning (up/down) or as a muted accent tint. */
export function Badge({ children, color = 'slate', className }: { children: ReactNode; color?: 'slate' | 'btc' | 'purple' | 'blue' | 'up' | 'down'; className?: string }) {
  const cls = {
    slate: 'bg-white/[0.05] text-slate-300 ring-white/10',
    btc: 'bg-btc/10 text-btc ring-btc/20',
    purple: 'bg-accent-purple/10 text-accent-purple ring-accent-purple/20',
    blue: 'bg-accent-blue/10 text-accent-blue ring-accent-blue/25',
    up: 'bg-up/10 text-up ring-up/20',
    down: 'bg-down/10 text-down ring-down/20',
  }[color]
  return <span className={clsx('inline-flex h-5 w-fit items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-2xs font-medium ring-1 ring-inset', cls, className)}>{children}</span>
}

/** Compact segmented control for in-card options (sliding pill; 32px tall on touch screens). */
export function Segmented<V extends string | number>({
  options, value, onChange, size = 'sm', className,
}: { options: { value: V; label: ReactNode }[]; value: V; onChange: (v: V) => void; size?: 'sm' | 'md'; className?: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
    if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth })
  }, [value, options.length, size])
  return (
    <div ref={wrap} className={clsx('seg relative inline-flex max-w-full items-center overflow-x-auto rounded-[10px] p-0.5 [scrollbar-width:none]', className)} role="tablist">
      {/* sliding active background */}
      {pill && <span aria-hidden className="seg-pill absolute bottom-0.5 top-0.5 rounded-lg transition-[transform,width] duration-200 ease-out" style={{ width: pill.w, transform: `translateX(${pill.x}px)`, left: 0 }} />}
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors duration-150',
            size === 'sm' ? 'h-8 px-2.5 text-xs sm:h-6' : 'h-8 px-3 text-sm',
            o.value === value ? 'text-white' : 'text-slate-400 hover:text-white',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Page-level tab bar: pill tabs in a soft track, on its own row under the page title. Pair with `useTab` (?tab=). */
export function TabBar<V extends string>({ tabs, value, onChange, className }: { tabs: { value: V; label: ReactNode }[]; value: V; onChange: (v: V) => void; className?: string }) {
  return (
    <div className={clsx('-mt-1 mb-4 flex', className)}>
      <div className="seg flex max-w-full gap-0.5 overflow-x-auto rounded-xl p-1 [scrollbar-width:none]" role="tablist">
        {tabs.map((tb) => (
          <button key={tb.value} role="tab" aria-selected={tb.value === value} onClick={() => onChange(tb.value)}
            className={clsx('relative flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition-colors duration-150',
              tb.value === value ? 'seg-pill text-white' : 'text-slate-400 hover:bg-white/[0.03] hover:text-white')}>
            {tb.label}
            {tb.value === value && <span aria-hidden className="absolute inset-x-3 -bottom-1 h-px bg-gradient-to-r from-transparent via-btc to-transparent" />}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode; /** ignored: toggles carry no coloured dots */ color?: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={clsx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition-colors sm:h-7',
        on ? 'border-accent-blue/30 bg-accent-blue/10 text-white' : 'border-line bg-white/[0.02] text-slate-400 hover:text-white',
      )}
    >
      {children}
    </button>
  )
}

/** Single KPI tile (legacy). Prefer <KpiStrip><KpiCell/></KpiStrip> for rows of KPIs. */
export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={clsx('card min-w-0 px-4 py-3', className)}>
      <div className="label truncate" title={typeof label === 'string' ? label : undefined}>{label}</div>
      <div className="tnum mt-1 truncate text-xl font-semibold text-white [&_*]:!text-white">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs">{sub}</div>}
    </div>
  )
}

/** Inline legend: short pill swatches (dashed = dashed stroke), matching the ECharts legend. */
export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={i.dashed ? 'inline-block h-0 w-3 border-t-2 border-dashed' : 'inline-block h-1 w-2.5 rounded-full'} style={i.dashed ? { borderColor: i.color } : { background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/** Thin bar. Neutral by default; pass a colour only when it carries meaning. */
export function ProgressBar({ value, color = '#B3BCD0', className }: { value: number; color?: string; className?: string }) {
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]', className)}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: `linear-gradient(90deg, ${hexA(color.startsWith('#') ? color : '#B3BCD0', 0.55)}, ${color})` }} />
    </div>
  )
}

/** Page header: tinted icon badge of the current section (from the nav) · 24px title · subtitle · actions. */
export function PageTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  const loc = useLocation()
  const nav = navFor(loc.pathname)
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3.5">
        {nav && <IconBadge icon={<nav.icon />} accent="slate" size="lg" className="hidden sm:inline-grid" />}
        <div className="min-w-0">
          <h1 className="text-page font-semibold tracking-[-0.02em] text-white">{title}</h1>
          {subtitle && <p className="mt-0.5 max-w-3xl text-sm text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{right}</div>}
    </div>
  )
}
