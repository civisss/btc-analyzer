import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Search, Menu, X, MessageSquare, Bitcoin, RefreshCw, PanelLeftClose, PanelLeftOpen, Sparkles, ArrowUpRight,
} from 'lucide-react'
import { useOverview, useStatus } from '../api/client'
import { live, useLive } from '../api/live'
import { startLiveFlow } from '../api/flows'
import { useApp } from '../lib/store'
import { agoSeconds, usd } from '../lib/format'
import { ACCENT_HEX, GROUP_ACCENT, NAV, NAV_GROUPS, navFor, type NavItem } from '../lib/nav'
import { dateLocale, setLang, t, useLang, type Lang } from '../i18n'
import ChatPanel from './ChatPanel'
import { NotificationsBell, Toasts } from './Notifications'
import { ICON, IconBadge, clsx } from './ui'
import { hexA } from './charts/theme'

export { NAV, NAV_GROUPS }
export type { NavItem }

// ------------------------------------------------------------------ sidebar
function Brand({ rail }: { rail: boolean }) {
  const st = useStatus()
  return (
    <div className={clsx('flex min-w-0 items-center gap-3', rail && 'lg:justify-center')}>
      <div className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-[#1A0F02]"
        style={{ background: 'radial-gradient(circle at 30% 25%, #FFC067, #F7931A 55%, #D9780A)', boxShadow: '0 0 0 1px rgba(255,190,110,0.35), 0 6px 20px -6px rgba(247,147,26,0.65)' }}>
        <Bitcoin size={19} strokeWidth={2.4} />
      </div>
      <div className={clsx('min-w-0 leading-tight', rail && 'lg:hidden')}>
        <div className="truncate text-[15px] font-semibold tracking-[-0.01em] text-white">Bitcoin Analyzer</div>
        <div className="truncate text-2xs text-slate-500">{st.data ? t('{n} dataset', { n: st.data.datasets.length }) : t('Analisi di mercato')}</div>
      </div>
    </div>
  )
}

/** Data freshness card: "● Sincronizzato · 21s fa" + stream state. */
function SyncCard({ rail }: { rail: boolean }) {
  const q = useStatus()
  const conn = useLive((s) => s.conn)
  const fresh = useMemo(() => {
    if (!q.data) return null
    const ages = q.data.datasets.map((d) => d.age_s).filter((a): a is number => a != null)
    const maxAge = ages.length ? Math.max(...ages) : null
    const minAge = ages.length ? Math.min(...ages) : null
    return { ok: maxAge != null && maxAge < 6 * 3600, minAge, n: q.data.datasets.length }
  }, [q.data])
  const state = q.isPending ? 'pending' : q.isError ? 'error' : fresh?.ok ? 'ok' : 'stale'
  const dot = state === 'ok' ? 'bg-up' : state === 'error' ? 'bg-down' : 'bg-amber-400'
  const label = state === 'pending' ? t('Verifica dati…') : state === 'error' ? t('Server non raggiungibile') : state === 'ok' ? t('Sincronizzato') : t('Sincronizzazione…')
  const stream = conn === 'open' ? t('Stream connesso') : conn === 'offline' ? t('Stream offline') : t('Stream in riconnessione')
  const tip = `${label}${fresh?.minAge != null ? ` · ${agoSeconds(fresh.minAge)}` : ''}${q.data ? ` · ${fresh?.n} dataset · ${stream}` : ''}`
  if (rail)
    return (
      <div className="hidden h-9 items-center justify-center lg:flex" title={tip}>
        <span className={clsx('h-2 w-2 rounded-full', dot, state === 'ok' && 'live-dot')} />
      </div>
    )
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2" title={tip}>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-400"><RefreshCw size={13} className={state === 'pending' ? 'animate-spin' : ''} /></span>
      <div className="min-w-0 leading-tight">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
          <span className="truncate">{label}</span>
          {fresh?.minAge != null && <span className="tnum truncate font-normal text-slate-500">· {agoSeconds(fresh.minAge)}</span>}
        </div>
        <div className="truncate text-2xs text-slate-500 [@media(max-height:860px)]:hidden">{q.data ? `${fresh?.n} dataset · ${stream}` : 'Binance · Bybit · OKX'}</div>
      </div>
    </div>
  )
}

/** "Assistente AI" shortcut card (opens the chat drawer). */
function AssistantCard({ rail, onOpen }: { rail: boolean; onOpen: () => void }) {
  if (rail)
    return (
      <button onClick={onOpen} title={t('Assistente AI')} aria-label={t('Assistente AI')} className="mx-auto hidden lg:grid">
        <IconBadge icon={<Sparkles />} accent="violet" />
      </button>
    )
  return (
    <button onClick={onOpen}
      className="group relative w-full overflow-hidden rounded-2xl p-3.5 text-left [@media(max-height:860px)]:p-2.5 transition-transform active:translate-y-px"
      style={{
        background: 'linear-gradient(140deg, rgba(155,135,245,0.22), rgba(91,141,239,0.10) 55%, rgba(14,20,36,0.4))',
        boxShadow: 'inset 0 0 0 1px rgba(170,150,255,0.22), inset 0 1px 0 rgba(255,255,255,0.08)',
      }}>
      <span aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-accent-violet/25 blur-2xl transition-opacity group-hover:opacity-80" />
      <div className="relative flex items-center gap-2.5">
        <IconBadge icon={<Sparkles />} accent="violet" />
        <span className="text-sm font-semibold text-white">{t('Assistente AI')}</span>
      </div>
      <p className="relative mt-2 pr-8 text-xs leading-relaxed text-slate-300 [@media(max-height:860px)]:hidden">{t('Fai domande su Bitcoin, cicli, pattern e livelli.')}</p>
      <span className="absolute bottom-3 right-3 grid h-7 w-7 place-items-center rounded-full bg-white/10 text-white transition-colors group-hover:bg-white/20">
        <ArrowUpRight size={14} />
      </span>
    </button>
  )
}

function NavRow({ item, rail }: { item: NavItem; rail: boolean }) {
  const hex = ACCENT_HEX[GROUP_ACCENT[item.group]]
  const label = t(item.label)
  return (
    <NavLink to={item.to} end={item.to === '/'} title={rail ? label : undefined}
      className={({ isActive }) => clsx(
        'group relative flex h-10 shrink-0 items-center gap-3 rounded-xl text-[13.5px] font-medium transition-colors duration-150 [@media(max-height:1100px)]:h-[34px]',
        rail ? 'px-[7px] lg:justify-center lg:px-0' : 'px-[7px]',
        isActive ? 'text-white' : 'text-slate-400 hover:bg-white/[0.035] hover:text-slate-100',
      )}
      style={({ isActive }) => (isActive ? {
        background: `linear-gradient(90deg, ${hexA(hex, 0.16)}, ${hexA(hex, 0.05)} 55%, rgba(255,255,255,0.015))`,
        boxShadow: `inset 0 0 0 1px ${hexA(hex, 0.18)}, inset 0 1px 0 rgba(255,255,255,0.05)`,
      } : undefined)}>
      {({ isActive }) => (
        <>
          {isActive && <span aria-hidden className="absolute -left-3 top-2.5 h-5 w-[3px] rounded-r-full" style={{ background: hex, boxShadow: `0 0 12px 1px ${hexA(hex, 0.7)}` }} />}
          <span className={clsx('grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg transition-colors',
            !isActive && 'bg-white/[0.03] text-slate-400 ring-1 ring-inset ring-white/[0.05] group-hover:bg-white/[0.06] group-hover:text-slate-200')}
            style={isActive ? { color: hex, background: hexA(hex, 0.16), boxShadow: `inset 0 0 0 1px ${hexA(hex, 0.3)}` } : undefined}>
            <item.icon size={15} strokeWidth={isActive ? 2.1 : 1.8} />
          </span>
          <span className={clsx('truncate', rail && 'lg:hidden')}>{label}</span>
        </>
      )}
    </NavLink>
  )
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { sidebarOpen, setSidebarOpen, setChatOpen } = useApp()
  const loc = useLocation()
  useEffect(() => setSidebarOpen(false), [loc.pathname, setSidebarOpen])
  // the rail mode applies to the desktop sidebar only; the mobile drawer is always expanded
  const rail = collapsed && !sidebarOpen
  const groups = useMemo(() => NAV_GROUPS.map((g) => ({ name: g, items: NAV.filter((n) => n.group === g) })).filter((g) => g.items.length), [])
  return (
    <>
      <div className={clsx('fixed inset-0 z-30 bg-black/60 backdrop-blur-[2px] transition-opacity lg:hidden', sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0')}
        onClick={() => setSidebarOpen(false)} />
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex flex-col overflow-hidden py-4 transition-[transform,width] duration-200 lg:translate-x-0',
          rail ? 'w-[264px] px-3 lg:w-[76px] lg:px-3' : 'w-[264px] px-3',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{
          background: 'linear-gradient(180deg, rgba(13,19,35,0.98) 0%, rgba(8,12,23,0.98) 45%, rgba(7,10,20,0.99) 100%)',
          boxShadow: 'inset -1px 0 0 rgba(150,165,210,0.09), 12px 0 40px -30px rgba(0,0,0,0.9)',
        }}
      >
        {/* soft brand glow */}
        <span aria-hidden className="pointer-events-none absolute -left-16 -top-24 h-56 w-56 rounded-full bg-btc/[0.10] blur-3xl" />
        <div className={clsx('relative flex h-11 items-center justify-between gap-2', rail ? 'px-1.5 lg:justify-center lg:px-0' : 'px-1.5')}>
          <Brand rail={rail} />
          <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white lg:hidden" onClick={() => setSidebarOpen(false)} aria-label={t('Chiudi menu')}><X size={ICON.nav} /></button>
          {!rail && (
            <button onClick={onToggle} title={t('Riduci menu (Ctrl/⌘ B)')} aria-label={t('Riduci menu (Ctrl/⌘ B)')}
              className="hidden h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/[0.05] hover:text-white lg:grid">
              <PanelLeftClose size={ICON.chip} />
            </button>
          )}
        </div>
        <nav className="no-scrollbar relative mt-4 flex flex-1 flex-col overflow-y-auto pl-3 -ml-3 pr-0.5">
          {groups.map((g) => (
            <div key={g.name} className="pt-4 first:pt-0 [@media(max-height:1100px)]:pt-2.5">
              {rail
                ? <div className="mx-auto mb-2 hidden h-px w-7 bg-white/[0.07] lg:block" />
                : null}
              <div className={clsx('flex items-center gap-2 px-2.5 pb-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-slate-500', rail && 'lg:hidden')}>
                <span className="h-1 w-1 rounded-full" style={{ background: ACCENT_HEX[GROUP_ACCENT[g.name]] }} />
                {t(g.name)}
              </div>
              <div className="flex flex-col gap-0.5">
                {g.items.map((item) => <NavRow key={item.to} item={item} rail={rail} />)}
              </div>
            </div>
          ))}
        </nav>
        <div className="relative mt-3 flex flex-col gap-2.5 pt-3">
          <span aria-hidden className="absolute inset-x-1 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          <SyncCard rail={rail} />
          <AssistantCard rail={rail} onOpen={() => setChatOpen(true)} />
          {rail && (
            <button onClick={onToggle} title={t('Espandi menu (Ctrl/⌘ B)')} aria-label={t('Espandi menu (Ctrl/⌘ B)')}
              className="mx-auto hidden h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/[0.05] hover:text-white lg:grid">
              <PanelLeftOpen size={ICON.chip} />
            </button>
          )}
        </div>
      </aside>
    </>
  )
}

// ------------------------------------------------------------------ top bar
function SearchBox({ inputRef }: { inputRef: React.RefObject<HTMLInputElement> }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [idx, setIdx] = useState(0)
  const nav = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return NAV
    return NAV.filter((n) => (n.label + ' ' + t(n.label) + ' ' + n.keywords).toLowerCase().includes(s))
  }, [q])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const go = (to: string) => { nav(to); setQ(''); setOpen(false); inputRef.current?.blur() }
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    <div ref={ref} className="relative w-full max-w-[600px]">
      <Search size={ICON.header} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setIdx(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)) }
          if (e.key === 'Enter' && results[idx]) go(results[idx].to)
          if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
        }}
        placeholder={t('Cerca pagine, metriche, cicli, pattern…')}
        className="h-10 w-full rounded-xl border border-white/[0.07] bg-white/[0.03] pl-10 pr-14 text-sm text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors placeholder:text-slate-500 hover:border-white/[0.12] focus:border-accent-blue/50 focus:bg-white/[0.045] focus:outline-none"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-px text-2xs text-slate-400">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      {open && results.length > 0 && (
        <div className="pop pop-in absolute left-0 right-0 top-12 z-50 overflow-hidden rounded-xl p-1.5">
          {results.map((r, i) => (
            <button key={r.to} onMouseDown={() => go(r.to)} onMouseEnter={() => setIdx(i)}
              className={clsx('flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-sm', i === idx ? 'bg-white/[0.06] text-white' : 'text-slate-300')}>
              <IconBadge icon={<r.icon />} accent={GROUP_ACCENT[r.group]} size="sm" />
              <span className="font-medium">{t(r.label)}</span>
              <span className="ml-auto text-xs text-slate-500">{t(r.group)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return <>{now.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</>
}

/** "● Live · 21:04:32" pill — compact connection state. */
function LiveStatus() {
  const conn = useLive((s) => s.conn)
  const last = useLive((s) => s.lastMessageAt)
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const stale = last != null && Date.now() - last > 15000
  const ok = conn === 'open' && !stale
  const color = ok ? 'bg-up' : conn === 'offline' ? 'bg-down' : 'bg-amber-400'
  const label = ok ? 'Live' : conn === 'offline' ? 'Offline' : conn === 'connecting' ? t('Connessione') : t('Riconnessione')
  return (
    <div className="tnum flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 text-xs text-slate-400"
      title={last ? t('Ultimo aggiornamento {ago}', { ago: agoSeconds((Date.now() - last) / 1000) }) : undefined}>
      <span className={clsx('h-2 w-2 rounded-full', color, ok && 'live-dot')} />
      <span className="font-medium text-slate-100">{label}</span>
      <span className="hidden text-slate-400 md:inline">{ok || last == null ? <Clock /> : agoSeconds((Date.now() - last) / 1000)}</span>
    </div>
  )
}

/** IT | EN switch (persisted; refetches every API call in the new language). */
function LangSwitch() {
  const lang = useLang()
  const opts: Lang[] = ['it', 'en']
  return (
    <div className="seg flex h-9 shrink-0 items-center rounded-xl p-1" role="group" aria-label={t('Lingua')}>
      {opts.map((l) => (
        <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
          className={clsx('h-7 rounded-lg px-2.5 text-xs font-semibold uppercase tracking-[0.04em] transition-colors', lang === l ? 'seg-pill text-white' : 'text-slate-500 hover:text-white')}>
          {l}
        </button>
      ))}
    </div>
  )
}

function TopBar() {
  const { setSidebarOpen, setChatOpen } = useApp()
  const loc = useLocation()
  const searchRef = useRef<HTMLInputElement>(null)
  const [mSearch, setMSearch] = useState(false)
  const page = navFor(loc.pathname)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  return (
    <header className="sticky top-0 z-20 -mx-4 mb-5 border-b border-white/[0.05] bg-[rgba(6,9,18,0.66)] px-4 backdrop-blur-xl md:-mx-6 md:px-6 2xl:-mx-8 2xl:px-8">
      {/* left: menu + page (mobile) / breadcrumb · centre: search · right: language, bell, Chiedi, live */}
      <div className="grid h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_minmax(0,600px)_minmax(max-content,1fr)]">
        <div className="flex min-w-0 items-center gap-3">
          <button className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.03] text-slate-300 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label={t('Apri menu')}>
            <Menu size={ICON.nav} />
          </button>
          {page && (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden truncate text-slate-500 2xl:inline">{t(page.group)}</span>
              <span className="hidden text-slate-600 2xl:inline">/</span>
              <span className="truncate font-semibold text-white md:hidden 2xl:inline">{t(page.label)}</span>
            </div>
          )}
        </div>
        <div className="hidden min-w-0 justify-center md:flex"><SearchBox inputRef={searchRef} /></div>
        <div className="flex items-center justify-end gap-2">
          <button className="grid h-9 w-9 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.03] text-slate-300 md:hidden" onClick={() => setMSearch(!mSearch)} aria-label={t('Cerca')}>
            <Search size={ICON.chip} />
          </button>
          <LangSwitch />
          <NotificationsBell />
          <button onClick={() => setChatOpen(true)} title={t('Fai una domanda sui dati')}
            className="hidden h-9 items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 text-xs font-medium text-slate-200 transition-colors hover:border-white/[0.12] hover:text-white sm:inline-flex">
            <MessageSquare size={ICON.chip} /> {t('Chiedi')}
          </button>
          <LiveStatus />
        </div>
      </div>
      {mSearch && <div className="pb-3 md:hidden"><SearchBox inputRef={searchRef} /></div>}
    </header>
  )
}

function ChatDrawer() {
  const { chatOpen, setChatOpen } = useApp()
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setChatOpen(false)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [setChatOpen])
  return (
    <>
      <div className={clsx('fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] transition-opacity', chatOpen ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={() => setChatOpen(false)} />
      <div className={clsx('fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col p-4 transition-transform', chatOpen ? 'translate-x-0' : 'translate-x-full')}
        style={{ background: 'linear-gradient(180deg, #111A2E, #0A1020)', boxShadow: 'inset 1px 0 0 rgba(150,165,210,0.12), -24px 0 60px -20px rgba(0,0,0,0.8)' }}>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <IconBadge icon={<Sparkles />} accent="violet" />
            <span className="text-lg font-semibold text-white">{t('Assistente AI')}</span>
          </div>
          <button onClick={() => setChatOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white" aria-label={t('Chiudi')}><X size={ICON.nav} /></button>
        </div>
        {chatOpen && <ChatPanel className="flex-1" />}
      </div>
    </>
  )
}

/** Starts the WS store and keeps the tab title in sync with the live price. */
function LiveBridge() {
  const price = useLive((s) => s.ticker?.price ?? null)
  const ov = useOverview()
  useEffect(() => { live.start(); startLiveFlow() }, [])
  useEffect(() => {
    const p = price ?? ov.data?.price
    document.title = p ? `${usd(p)} · Bitcoin Analyzer` : 'Bitcoin Analyzer'
  }, [price, ov.data?.price])
  return null
}

export default function Layout() {
  const loc = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('sidebar-rail') === '1' } catch { return false } })
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('sidebar-rail', n ? '1' : '0') } catch { /* ignore */ } return n })
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggle() } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  return (
    <div className="min-h-screen">
      <LiveBridge />
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className={clsx('transition-[padding] duration-200', collapsed ? 'lg:pl-[76px]' : 'lg:pl-[264px]')}>
        <main className="w-full px-4 pb-10 md:px-6 2xl:px-8">
          <TopBar />
          <Outlet />
        </main>
      </div>
      <ChatDrawer />
      <Toasts />
    </div>
  )
}

export function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning?: boolean }) {
  return (
    <button onClick={onClick} className="btn-ghost" disabled={spinning}>
      <RefreshCw size={ICON.chip} className={spinning ? 'animate-spin' : ''} /> {t('Rigenera')}
    </button>
  )
}
