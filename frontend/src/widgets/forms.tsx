/*
 * Form primitives for the user tools (Avvisi, Diario, annotations): modal sheet, labelled fields, inputs, confirm button.
 * Same v3 look as the rest of the kit: 10px controls, hairline borders, blue focus ring, 13px text, tabular numbers.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, X } from 'lucide-react'
import { IconBadge, clsx, type Accent } from '../components/ui'
import { t } from '../i18n'

export const INPUT = 'h-9 w-full min-w-0 rounded-lg border border-line bg-white/[0.03] px-3 text-sm text-white  transition-colors placeholder:text-fg-4 hover:border-line-strong focus:border-accent/60 focus:bg-white/[0.045] focus:outline-none disabled:opacity-50'
export const INPUT_ERR = '!border-warn/60'

/** Centered dialog on desktop, bottom sheet on phones. Esc / backdrop close. Rendered in a portal (above the sticky top bar). */
export function Modal({ title, icon, accent = 'blue', subtitle, onClose, children, footer, wide }: {
  title: ReactNode; icon?: ReactNode; accent?: Accent; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev }
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={clsx('pop pop-in relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl sm:max-h-[min(860px,calc(100vh-48px))] sm:rounded-2xl', wide ? 'sm:max-w-[880px]' : 'sm:max-w-[620px]')}
        style={{ transformOrigin: 'center' }}>
        <header className="flex items-center gap-3 border-b border-line-subtle px-4 py-3.5 sm:px-5">
          {icon && <IconBadge icon={icon} accent={accent} />}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-title font-semibold text-white">{title}</h2>
            {subtitle && <p className="truncate text-xs text-fg-3">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label={t('Chiudi')} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-white/[0.06] hover:text-white">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line-subtle px-4 py-3 sm:px-5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

/** Label (UPPERCASE 11px) + control + optional hint / error line. */
export function Field({ label, hint, error, children, className, aside, group }: {
  label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; aside?: ReactNode
  /** wraps button groups (segmented controls): a <div role="group"> instead of a <label> */
  group?: boolean
}) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag role={group ? 'group' : undefined} className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        {aside && <span className="tnum truncate text-2xs text-fg-3">{aside}</span>}
      </span>
      {children}
      {error ? <span className="text-xs text-warn">{error}</span> : hint ? <span className="text-xs text-fg-4">{hint}</span> : null}
    </Tag>
  )
}

/** Number input with a unit suffix inside the field. Keeps the raw text while typing (no jumping caret). */
export function NumInput({ value, onChange, unit, step = 'any', placeholder, invalid, ariaLabel, prefix }: {
  value: number | null; onChange: (v: number | null) => void; unit?: string; prefix?: string; step?: number | 'any'; placeholder?: string; invalid?: boolean; ariaLabel?: string
}) {
  const [txt, setTxt] = useState(value == null ? '' : String(value))
  const last = useRef(value)
  useEffect(() => {
    if (value !== last.current) { last.current = value; setTxt(value == null ? '' : String(value)) }
  }, [value])
  return (
    <span className="relative flex min-w-0 items-center">
      {prefix && <span className="pointer-events-none absolute left-3 text-sm text-fg-4">{prefix}</span>}
      <input type="number" inputMode="decimal" step={step} value={txt} placeholder={placeholder} aria-label={ariaLabel}
        onChange={(e) => {
          setTxt(e.target.value)
          const v = e.target.value.trim() === '' ? null : Number(e.target.value)
          const nv = v != null && Number.isFinite(v) ? v : null
          last.current = nv
          onChange(nv)
        }}
        className={clsx(INPUT, 'tnum [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none', prefix && 'pl-7', unit && 'pr-14', invalid && INPUT_ERR)} />
      {unit && <span className="pointer-events-none absolute right-3 text-xs text-fg-4">{unit}</span>}
    </span>
  )
}

export function Select<V extends string | number>({ value, onChange, options, ariaLabel, className }: {
  value: V; onChange: (v: V) => void; options: { value: V; label: string; group?: string }[]; ariaLabel?: string; className?: string
}) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))]
  const render = (o: { value: V; label: string }) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
  return (
    <select value={String(value)} aria-label={ariaLabel}
      onChange={(e) => { const o = options.find((x) => String(x.value) === e.target.value); if (o) onChange(o.value) }}
      className={clsx(INPUT, 'cursor-pointer appearance-none bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-8', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238892A8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}>
      {groups.length > 1
        ? groups.map((g) => <optgroup key={g} label={g}>{options.filter((o) => (o.group ?? '') === g).map(render)}</optgroup>)
        : options.map(render)}
    </select>
  )
}

/** iOS-style switch (same look as the notification settings). */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!on)}
      className="grid h-8 w-11 shrink-0 place-items-center rounded-lg disabled:opacity-40">
      <span className={clsx('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-white/10')}>
        <span className={clsx('absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', on ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </span>
    </button>
  )
}

/** Delete with a second confirming click (no browser dialogs). */
export function DeleteButton({ onConfirm, label, compact, busy }: { onConfirm: () => void; label?: string; compact?: boolean; busy?: boolean }) {
  const [arm, setArm] = useState(false)
  useEffect(() => {
    if (!arm) return
    const id = setTimeout(() => setArm(false), 3500)
    return () => clearTimeout(id)
  }, [arm])
  const text = arm ? t('Conferma eliminazione') : label ?? t('Elimina')
  return (
    <button type="button" disabled={busy} onClick={() => (arm ? (setArm(false), onConfirm()) : setArm(true))} title={label ?? t('Elimina')} aria-label={text}
      className={clsx('inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-xs font-medium transition-colors disabled:opacity-40 sm:h-7',
        arm ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line bg-white/[0.03] text-fg-3 hover:border-warn/30 hover:text-warn')}>
      <Trash2 size={13} />{(!compact || arm) && <span>{text}</span>}
    </button>
  )
}

/** Small icon-only ghost button with a tooltip. */
export function IconBtn({ icon, label, onClick, active, disabled }: { icon: ReactNode; label: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} disabled={disabled} aria-pressed={active}
      className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition-colors disabled:opacity-40 sm:h-7 sm:w-7',
        active ? 'border-accent/40 bg-accent/10 text-white' : 'border-line bg-white/[0.03] text-fg-3 hover:border-line-strong hover:text-white')}>
      {icon}
    </button>
  )
}
