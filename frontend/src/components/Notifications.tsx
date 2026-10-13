/*
 * Live alerts: toasts (WS {"type":"toast", ...Alert}) + the top-bar bell with the history popover.
 *  toasts : top-right under the top bar, max 3 stacked (newest on top, the rest queue), auto-dismiss by severity
 *           (info 6 s · warning 10 s · critical stays), pause on hover, dedupe by id, muted categories skipped.
 *  bell   : GET /api/alerts?limit=50, unread badge (last-read id in localStorage), grouped by day, mark all read, mute settings.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUpRight, Bell, BellOff, Check, Info, Settings2, Siren, X } from 'lucide-react'
import { live } from '../api/live'
import { useAlerts, type Alert, type AlertSeverity } from '../api/alerts'
import { ALERT_CATEGORIES, isMuted, setLastRead, toggleMuted, useAlertPrefs } from '../lib/alertPrefs'
import { agoSeconds, date } from '../lib/format'
import { cap, t } from '../i18n'
import { clsx } from './ui'

const SEV: Record<AlertSeverity, { hex: string; icon: typeof Info; ms: number | null; label: string }> = {
  info: { hex: '#5B8DEF', icon: Info, ms: 6000, label: 'Info' },
  warning: { hex: '#E8B04B', icon: AlertTriangle, ms: 10000, label: 'Attenzione' },
  critical: { hex: '#EF5466', icon: Siren, ms: null, label: 'Critico' },
}
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
const relTime = (ts: number) => {
  const s = Math.max(0, Date.now() / 1000 - ts)
  return s < 45 ? t('Adesso') : agoSeconds(s)
}

// ------------------------------------------------------------------ toasts
/** While the bell popover is open the toast stack steps aside (the header is its own stacking context). */
let bellOpen = false
const bellListeners = new Set<() => void>()
const setBellOpen = (o: boolean) => { bellOpen = o; bellListeners.forEach((fn) => fn()) }
const useBellOpen = () => useSyncExternalStore((fn) => { bellListeners.add(fn); return () => { bellListeners.delete(fn) } }, () => bellOpen)

type ToastItem = { a: Alert; leaving: boolean }

function ToastCard({ it, onClose, onOpen }: { it: ToastItem; onClose: () => void; onOpen: () => void }) {
  const sev = SEV[it.a.severity] ?? SEV.info
  const Icon = sev.icon
  const [paused, setPaused] = useState(false)
  // auto-dismiss (paused while hovered)
  const left = useRef(sev.ms)
  useEffect(() => {
    if (left.current == null || paused || it.leaving) return
    const start = Date.now()
    const id = setTimeout(onClose, left.current)
    return () => { clearTimeout(id); if (left.current != null) left.current = Math.max(0, left.current - (Date.now() - start)) }
  }, [paused, it.leaving, onClose])
  return (
    <div role={it.a.severity === 'critical' ? 'alert' : 'status'} aria-live={it.a.severity === 'critical' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      className={clsx('toast pop pointer-events-auto relative w-full overflow-hidden rounded-2xl', it.leaving ? 'toast-out' : 'toast-in')}
      style={{ boxShadow: `0 18px 48px -14px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px ${rgba(sev.hex, 0.22)}` }}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: sev.hex, boxShadow: `0 0 14px 1px ${rgba(sev.hex, 0.6)}` }} />
      <span aria-hidden className="pointer-events-none absolute -left-10 -top-12 h-28 w-28 rounded-full blur-2xl" style={{ background: rgba(sev.hex, 0.16) }} />
      <div className="relative flex gap-3 p-3.5 pl-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px]"
          style={{ color: sev.hex, background: `linear-gradient(180deg, ${rgba(sev.hex, 0.22)}, ${rgba(sev.hex, 0.08)})`, boxShadow: `inset 0 0 0 1px ${rgba(sev.hex, 0.25)}` }}>
          <Icon size={16} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-2xs text-slate-400">
            <span className="font-medium uppercase tracking-[0.07em]" style={{ color: sev.hex }}>{cap(it.a.category_label || it.a.category)}</span>
            <span className="text-slate-600">·</span>
            <span className="tnum">{relTime(it.a.time)}</span>
          </div>
          <div className="mt-0.5 text-sm font-semibold leading-snug text-white">{cap(it.a.title)}</div>
          {it.a.text && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-300">{cap(it.a.text)}</p>}
          {it.a.link && (
            <button onClick={onOpen} className="mt-2 inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 text-xs font-medium text-white transition-colors hover:bg-white/[0.1]">
              {t('Apri')} <ArrowUpRight size={13} />
            </button>
          )}
        </div>
        <button onClick={onClose} aria-label={t('Chiudi')} className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-white">
          <X size={14} />
        </button>
      </div>
      {sev.ms != null && !it.leaving && (
        <span aria-hidden className="toast-timer absolute bottom-0 left-0 h-[2px]"
          style={{ background: rgba(sev.hex, 0.7), animationDuration: `${sev.ms}ms`, animationPlayState: paused ? 'paused' : 'running' }} />
      )}
    </div>
  )
}

/** Toast stack, mounted once in the Layout. */
export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([])
  const seen = useRef(new Set<number>())
  const nav = useNavigate()
  const qc = useQueryClient()
  useEffect(() => live.onToast((a) => {
    if (seen.current.has(a.id)) return
    seen.current.add(a.id)
    qc.invalidateQueries({ queryKey: ['alerts'] })
    if (isMuted(a.category)) return
    setItems((cur) => [{ a, leaving: false }, ...cur])
  }), [qc])
  const close = (id: number) => {
    setItems((cur) => cur.map((x) => (x.a.id === id ? { ...x, leaving: true } : x)))
    setTimeout(() => setItems((cur) => cur.filter((x) => x.a.id !== id)), 220)
  }
  const hidden = useBellOpen()
  const visible = items.slice(0, 3)
  if (!visible.length) return null
  return (
    <div className={clsx('pointer-events-none fixed right-3 top-[72px] z-[60] flex w-[min(380px,calc(100vw-24px))] flex-col gap-2.5 transition-opacity duration-150 sm:right-5', hidden && 'invisible opacity-0')}>
      {visible.map((it) => (
        <ToastCard key={it.a.id} it={it} onClose={() => close(it.a.id)} onOpen={() => { setLastRead(it.a.id); nav(it.a.link); close(it.a.id) }} />
      ))}
      {items.length > 3 && <div className="pointer-events-none self-end text-2xs text-slate-500">{t('+{n} in coda', { n: items.length - 3 })}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ bell
function dayKey(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
function dayLabel(ts: number) {
  const d = new Date(ts * 1000)
  const today = new Date()
  const y = new Date(); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return t('Oggi')
  if (d.toDateString() === y.toDateString()) return t('Ieri')
  return date(ts - d.getTimezoneOffset() * 60)
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  const q = useAlerts(50)
  const prefs = useAlertPrefs()
  const items = useMemo(() => (q.data?.items ?? []).filter((a) => a.category !== 'test'), [q.data])
  const maxId = items.reduce((m, a) => Math.max(m, a.id), 0)
  // first visit: start from "everything read" instead of a 50-item badge
  useEffect(() => { if (prefs.lastRead == null && q.data) setLastRead(maxId) }, [prefs.lastRead, q.data, maxId])
  useEffect(() => { setBellOpen(open); return () => setBellOpen(false) }, [open])
  const unread = prefs.lastRead == null ? 0 : items.filter((a) => a.id > prefs.lastRead!).length
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', h)
    window.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k) }
  }, [open])
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: Alert[] }[] = []
    for (const a of items) {
      const k = dayKey(a.time)
      const g = out[out.length - 1]
      if (g && g.key === k) g.items.push(a)
      else out.push({ key: k, label: dayLabel(a.time), items: [a] })
    }
    return out
  }, [items])
  const go = (a: Alert) => { setOpen(false); if (a.link) nav(a.link) }
  return (
    <div ref={ref} className="relative">
      <button onClick={() => { setOpen((o) => !o); setSettings(false) }} aria-label={t('Notifiche')} title={t('Notifiche')} aria-expanded={open}
        className={clsx('relative grid h-9 w-9 place-items-center rounded-xl border bg-white/[0.03] text-slate-300 transition-colors hover:border-white/[0.12] hover:text-white',
          open ? 'border-white/[0.14] text-white' : 'border-white/[0.07]')}>
        <Bell size={15} />
        {unread > 0 && (
          <span className="tnum absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-btc px-1 text-[10px] font-semibold leading-none text-[#1A0F02] shadow-[0_0_0_2px_#060912,0_4px_10px_-2px_rgba(247,147,26,0.6)]">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="pop pop-in fixed left-3 right-3 top-[68px] z-[70] overflow-hidden rounded-2xl sm:absolute sm:left-auto sm:right-0 sm:top-11 sm:w-[400px]" style={{ transformOrigin: 'top right' }}>
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">{settings ? t('Impostazioni notifiche') : t('Notifiche')}</span>
              {!settings && unread > 0 && <span className="tnum rounded-full bg-btc/15 px-1.5 text-2xs font-semibold text-btc">{t('{n} nuove', { n: unread })}</span>}
            </div>
            <div className="flex items-center gap-1">
              {!settings && (
                <button onClick={() => setLastRead(maxId)} disabled={!unread}
                  className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent">
                  <Check size={13} /> {t('Segna tutte come lette')}
                </button>
              )}
              <button onClick={() => setSettings((s) => !s)} aria-label={t('Impostazioni notifiche')} title={t('Impostazioni notifiche')}
                className={clsx('grid h-7 w-7 place-items-center rounded-lg transition-colors hover:bg-white/[0.06] hover:text-white', settings ? 'bg-white/[0.06] text-white' : 'text-slate-400')}>
                <Settings2 size={14} />
              </button>
            </div>
          </div>
          {settings ? (
            <div className="max-h-[min(520px,calc(100vh-140px))] overflow-y-auto p-2">
              <p className="px-2 pb-2 pt-1 text-xs leading-relaxed text-slate-400">{t('Le categorie silenziate non mostrano avvisi a comparsa ma restano nello storico.')}</p>
              {ALERT_CATEGORIES.map((c) => {
                const muted = prefs.muted.includes(c.id)
                return (
                  <button key={c.id} onClick={() => toggleMuted(c.id)} role="switch" aria-checked={!muted}
                    className="flex h-10 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.04]">
                    <span className="flex items-center gap-2.5">
                      {muted ? <BellOff size={14} className="text-slate-500" /> : <Bell size={14} className="text-slate-400" />}
                      <span className={muted ? 'text-slate-500' : ''}>{t(c.label)}</span>
                    </span>
                    <span className={clsx('relative h-5 w-9 rounded-full transition-colors', muted ? 'bg-white/10' : 'bg-accent-blue/80')}>
                      <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', muted ? 'translate-x-0.5' : 'translate-x-[18px]')} />
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="no-scrollbar max-h-[min(520px,calc(100vh-140px))] overflow-y-auto">
              {q.isPending && <p className="px-4 py-8 text-center text-xs text-slate-400">{t('Caricamento…')}</p>}
              {q.isError && !q.data && <p className="px-4 py-8 text-center text-xs text-slate-400">{t('Storico avvisi non disponibile.')}</p>}
              {q.data && !items.length && (
                <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                  <Bell size={18} className="text-slate-500" />
                  <p className="text-xs leading-relaxed text-slate-400">{t('Nessuna notifica. Gli avvisi su livelli, cicli e liquidazioni arriveranno qui.')}</p>
                </div>
              )}
              {groups.map((g) => (
                <div key={g.key}>
                  <div className="label sticky top-0 z-10 bg-[rgba(22,30,50,0.96)] px-4 py-1.5 backdrop-blur">{g.label}</div>
                  {g.items.map((a) => {
                    const sev = SEV[a.severity] ?? SEV.info
                    const isNew = prefs.lastRead != null && a.id > prefs.lastRead
                    return (
                      <button key={a.id} onClick={() => go(a)}
                        className={clsx('group flex w-full gap-3 border-t border-white/[0.04] px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04]', isNew && 'bg-white/[0.025]')}>
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: sev.hex, boxShadow: `0 0 8px ${rgba(sev.hex, 0.6)}` }} title={t(sev.label)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className={clsx('min-w-0 truncate text-sm', isNew ? 'font-semibold text-white' : 'font-medium text-slate-200')}>{cap(a.title)}</span>
                            <span className="tnum shrink-0 text-2xs text-slate-500">{relTime(a.time)}</span>
                          </span>
                          {a.text && <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-slate-400">{cap(a.text)}</span>}
                          <span className="mt-1 flex items-center gap-1.5 text-2xs text-slate-500">
                            <span>{cap(a.category_label || a.category)}</span>
                            {a.silent && <span className="text-slate-600">· {t('Solo storico')}</span>}
                            {isMuted(a.category) && <span className="text-slate-600">· {t('Silenziata')}</span>}
                          </span>
                        </span>
                        {isNew && <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-btc" aria-label={t('Non letta')} />}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
