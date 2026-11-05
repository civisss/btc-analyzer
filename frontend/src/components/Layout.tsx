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
import { NAV, NAV_GROUPS, navFor, type NavItem } from '../lib/nav'
import { dateLocale, setLang, t, useLang, type Lang } from '../i18n'
import ChatPanel from './ChatPanel'
import { NotificationsBell, Toasts } from './Notifications'
import { ICON, IconBadge, clsx } from './ui'

export { NAV, NAV_GROUPS }
export type { NavItem }

// ------------------------------------------------------------------ sidebar
function Brand({ rail }: { rail: boolean }) {
  const st = useStatus()
  return (
    <div className={clsx('flex min-w-0 items-center gap-3', rail && 'lg:justify-center')}>
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-on-accent">
        <Bitcoin size={18} strokeWidth={2.4} />
      </div>
      <div className={clsx('min-w-0 leading-tight', rail && 'lg:hidden')}>
        <div className="truncate text-[14px] font-semibold tracking-[-0.01em] text-white">Bitcoin Analyzer</div>
        <div className="truncate text-2xs text-fg-4">{st.data ? t('{n} dataset', { n: st.data.datasets.length }) : t('Analisi di mercato')}</div>
      </div>
    </div>
  )
}

type Level = 'ok' | 'warn' | 'bad'
/** Lit = accent, half = warn, off = grey: green and red stay reserved for market direction. */
const LEVEL_DOT: Record<Level, string> = { ok: 'bg-accent', warn: 'bg-warn', bad: 'bg-fg-off' }

/** System status: data freshness, live stream and local LLM, one light each. Details in the tooltip. */
function SystemStatus({ rail }: { rail: boolean }) {
  const q = useStatus()
  const conn = useLive((s) => s.conn)
  const fresh = useMemo(() => {
    if (!q.data) return null
    const ages = q.data.datasets.map((d) => d.age_s).filter((a): a is number => a != null)
    return { ok: ages.length > 0 && Math.max(...ages) < 6 * 3600, minAge: ages.length ? Math.min(...ages) : null, n: q.data.datasets.length }
  }, [q.data])
  const llm = q.data?.llm
  const failed = q.data?.agents?.errors ?? []
  const data: Level = q.isError ? 'bad' : !fresh ? 'warn' : !fresh.ok || failed.length ? 'warn' : 'ok'
  const stream: Level = conn === 'open' ? 'ok' : conn === 'offline' ? 'bad' : 'warn'
  const model: Level = llm?.available ? 'ok' : 'warn'
  const dataTip = q.isError ? t('Server non raggiungibile') : q.isPending ? t('Verifica dati…')
    : `${fresh?.ok ? t('Sincronizzato') : t('Sincronizzazione…')}${fresh?.minAge != null ? ` · ${agoSeconds(fresh.minAge)}` : ''} · ${t('{n} dataset', { n: fresh?.n ?? 0 })}`
    + (failed.length ? ` · ${t('Moduli in errore')}: ${failed.map((a) => a.name).join(', ')}` : '')
  const streamTip = conn === 'open' ? t('Stream connesso') : conn === 'offline' ? t('Stream offline') : t('Stream in riconnessione')
  const llmTip = llm?.available ? `LLM: ${llm.model ?? t('attivo')}` : t('LLM locale non attivo: sintesi a regole')
  const items: { label: string; level: Level; tip: string }[] = [
    { label: t('Dati'), level: data, tip: dataTip }, { label: 'Stream', level: stream, tip: streamTip }, { label: 'LLM', level: model, tip: llmTip },
  ]
  if (rail)
    return (
      <div className="hidden flex-col items-center gap-1.5 py-1 lg:flex" role="status" title={items.map((i) => i.tip).join('\n')}>
        {items.map((i) => <span key={i.label} className={clsx('h-1.5 w-1.5 rounded-full', LEVEL_DOT[i.level])} />)}
      </div>
    )
  return (
    <div className="flex items-center justify-between gap-2 tile px-3 py-2" role="status" aria-label={t('Stato del sistema')}>
      {items.map((i) => (
        <span key={i.label} title={i.tip} className="flex min-w-0 items-center gap-1.5 text-2xs font-medium text-fg-2">
          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', LEVEL_DOT[i.level], i.level === 'ok' && i.label === 'Stream' && 'live-dot')} />
          <span className="truncate">{i.label}</span>
        </span>
      ))}
    </div>
  )
}

/** "Assistente AI" shortcut card (opens the chat drawer). */
function AssistantCard({ rail, onOpen }: { rail: boolean; onOpen: () => void }) {
  if (rail)
    return (
      <button onClick={onOpen} title={t('Assistente AI')} aria-label={t('Assistente AI')} className="mx-auto hidden lg:grid">
        <IconBadge icon={<Sparkles />} />
      </button>
    )
  return (
    <button onClick={onOpen}
      className="group relative flex w-full items-center gap-2.5 rounded-lg border border-line bg-white/[0.03] p-2.5 text-left transition-colors hover:border-accent/40 active:translate-y-px">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/[0.12] text-accent"><Sparkles size={14} strokeWidth={1.9} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-white">{t('Assistente AI')}</span>
        <span className="block truncate text-2xs text-fg-4 [@media(max-height:860px)]:hidden">{t('Fai domande su Bitcoin, cicli, pattern e livelli.')}</span>
      </span>
      <ArrowUpRight size={14} className="shrink-0 text-fg-4 transition-colors group-hover:text-accent" />
    </button>
  )
}

function NavRow({ item, rail }: { item: NavItem; rail: boolean }) {
  const label = t(item.label)
  return (
    <NavLink to={item.to} end={item.to === '/'} title={rail ? label : undefined}
      className={({ isActive }) => clsx(
        'group relative flex h-9 shrink-0 items-center gap-2.5 rounded-lg text-[13px] font-medium transition-colors duration-150 [@media(max-height:1100px)]:h-[32px]',
        rail ? 'px-2.5 lg:justify-center lg:px-0' : 'px-2.5',
        isActive ? 'bg-white/[0.06] text-white' : 'text-fg-3 hover:bg-white/[0.035] hover:text-fg',
      )}>
      {({ isActive }) => (
        <>
          {isActive && <span aria-hidden className="absolute -left-3 inset-y-1.5 w-0.5 rounded-r-full bg-accent" />}
          <item.icon size={16} strokeWidth={isActive ? 2 : 1.75} className={clsx('shrink-0 transition-colors', isActive ? 'text-accent' : 'text-fg-4 group-hover:text-fg-2')} />
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
  // on short screens the nav scrolls (no scrollbar): fade the edge that hides more items
  const navRef = useRef<HTMLElement>(null)
  const [fade, setFade] = useState({ top: false, bottom: false })
  useEffect(() => {
    const el = navRef.current
    if (!el) return
    const upd = () => setFade((f) => {
      const top = el.scrollTop > 4, bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 4
      return f.top === top && f.bottom === bottom ? f : { top, bottom }
    })
    upd()
    el.addEventListener('scroll', upd, { passive: true })
    const ro = new ResizeObserver(upd)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', upd); ro.disconnect() }
  }, [])
  const mask = fade.top || fade.bottom
    ? `linear-gradient(180deg, ${fade.top ? 'transparent 0, black 28px' : 'black 0'}, ${fade.bottom ? 'black calc(100% - 40px), transparent 100%' : 'black 100%'})`
    : undefined
  return (
    <>
      <div className={clsx('fixed inset-0 z-30 bg-black/60 transition-opacity lg:hidden', sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0')}
        onClick={() => setSidebarOpen(false)} />
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-r border-line-subtle bg-side py-4 transition-[transform,width] duration-200 lg:translate-x-0',
          rail ? 'w-[264px] px-3 lg:w-[76px] lg:px-3' : 'w-[264px] px-3',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className={clsx('relative flex h-11 items-center justify-between gap-2', rail ? 'px-1.5 lg:justify-center lg:px-0' : 'px-1.5')}>
          <Brand rail={rail} />
          <button className="grid h-8 w-8 place-items-center rounded-lg text-fg-3 hover:bg-white/5 hover:text-white lg:hidden" onClick={() => setSidebarOpen(false)} aria-label={t('Chiudi menu')}><X size={ICON.nav} /></button>
          {!rail && (
            <button onClick={onToggle} title={t('Riduci menu (Ctrl/⌘ B)')} aria-label={t('Riduci menu (Ctrl/⌘ B)')}
              className="hidden h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-4 transition-colors hover:bg-white/[0.05] hover:text-white lg:grid">
              <PanelLeftClose size={ICON.chip} />
            </button>
          )}
        </div>
        <nav ref={navRef} className="no-scrollbar relative mt-4 flex flex-1 flex-col overflow-y-auto pl-3 -ml-3 pr-0.5"
          style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}>
          {groups.map((g) => (
            <div key={g.name} className="pt-4 first:pt-0 [@media(max-height:1100px)]:pt-2.5">
              {rail
                ? <div className="mx-auto mb-2 hidden h-px w-7 bg-white/[0.07] lg:block" />
                : null}
              <div className={clsx('px-2.5 pb-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-4', rail && 'lg:hidden')}>
                {t(g.name)}
              </div>
              <div className="flex flex-col gap-0.5">
                {g.items.map((item) => <NavRow key={item.to} item={item} rail={rail} />)}
              </div>
            </div>
          ))}
        </nav>
        <div className="relative mt-3 flex flex-col gap-2.5 pt-3">
          <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-line" />
          <SystemStatus rail={rail} />
          <AssistantCard rail={rail} onOpen={() => setChatOpen(true)} />
          {rail && (
            <button onClick={onToggle} title={t('Espandi menu (Ctrl/⌘ B)')} aria-label={t('Espandi menu (Ctrl/⌘ B)')}
              className="mx-auto hidden h-8 w-8 place-items-center rounded-lg text-fg-4 transition-colors hover:bg-white/[0.05] hover:text-white lg:grid">
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
      <Search size={ICON.header} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-4" />
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
        className="h-9 w-full rounded-lg border border-line bg-white/[0.03] pl-10 pr-14 text-sm text-white transition-colors placeholder:text-fg-4 hover:border-line-strong focus:border-accent/60 focus:bg-white/[0.045] focus:outline-none"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line bg-white/[0.04] px-1.5 py-px text-2xs text-fg-4">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      {open && results.length > 0 && (
        <div className="pop pop-in absolute left-0 right-0 top-12 z-50 overflow-hidden rounded-xl p-1.5">
          {results.map((r, i) => (
            <button key={r.to} onMouseDown={() => go(r.to)} onMouseEnter={() => setIdx(i)}
              className={clsx('flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-sm', i === idx ? 'bg-white/[0.06] text-white' : 'text-fg-2')}>
              <IconBadge icon={<r.icon />} size="sm" />
              <span className="font-medium">{t(r.label)}</span>
              <span className="ml-auto text-xs text-fg-4">{t(r.group)}</span>
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
  const color = ok ? 'bg-accent' : conn === 'offline' ? 'bg-fg-off' : 'bg-warn'
  const label = ok ? 'Live' : conn === 'offline' ? 'Offline' : conn === 'connecting' ? t('Connessione') : t('Riconnessione')
  return (
    <div className="tnum flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-white/[0.03] px-3 text-xs text-fg-3"
      title={last ? t('Ultimo aggiornamento {ago}', { ago: agoSeconds((Date.now() - last) / 1000) }) : undefined}>
      <span className={clsx('h-2 w-2 rounded-full', color, ok && 'live-dot')} />
      {/* phones: dot only, so the page name in the top bar is not truncated */}
      <span className="sr-only font-medium text-fg min-[420px]:not-sr-only">{label}</span>
      <span className="hidden text-fg-3 md:inline">{ok || last == null ? <Clock /> : agoSeconds((Date.now() - last) / 1000)}</span>
    </div>
  )
}

/** IT | EN switch (persisted; refetches every API call in the new language). */
function LangSwitch() {
  const lang = useLang()
  const opts: Lang[] = ['it', 'en']
  return (
    <div className="seg flex h-9 shrink-0 items-center rounded-lg p-1" role="group" aria-label={t('Lingua')}>
      {opts.map((l) => (
        <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
          className={clsx('h-7 rounded-md px-2.5 text-xs font-semibold uppercase tracking-[0.04em] transition-colors', lang === l ? 'seg-pill text-accent-hi' : 'text-fg-4 hover:text-white')}>
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
    <header className="sticky top-0 z-20 -mx-4 mb-5 border-b border-line-subtle bg-bg px-4 md:-mx-6 md:px-6 2xl:-mx-8 2xl:px-8">
      {/* left: menu + page (mobile) / breadcrumb · centre: search · right: language, bell, Chiedi, live */}
      <div className="grid h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_minmax(0,600px)_minmax(max-content,1fr)]">
        <div className="flex min-w-0 items-center gap-3">
          <button className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.03] text-fg-2 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label={t('Apri menu')}>
            <Menu size={ICON.nav} />
          </button>
          {page && (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden truncate text-fg-4 2xl:inline">{t(page.group)}</span>
              <span className="hidden text-fg-off 2xl:inline">/</span>
              <span className="truncate font-semibold text-white md:hidden 2xl:inline">{t(page.label)}</span>
            </div>
          )}
        </div>
        <div className="hidden min-w-0 justify-center md:flex"><SearchBox inputRef={searchRef} /></div>
        <div className="flex items-center justify-end gap-2">
          <button className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-white/[0.03] text-fg-2 md:hidden" onClick={() => setMSearch(!mSearch)} aria-label={t('Cerca')}>
            <Search size={ICON.chip} />
          </button>
          <LangSwitch />
          <NotificationsBell />
          <button onClick={() => setChatOpen(true)} title={t('Fai una domanda sui dati')}
            className="hidden h-9 items-center gap-2 rounded-lg border border-line bg-white/[0.03] px-3 text-xs font-medium text-fg transition-colors hover:border-line-strong hover:text-white sm:inline-flex">
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
      <div className={clsx('fixed inset-0 z-40 bg-black/50 transition-opacity', chatOpen ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={() => setChatOpen(false)} />
      <div className={clsx('fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-line bg-side p-4 shadow-pop transition-transform', chatOpen ? 'translate-x-0' : 'translate-x-full')}>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <IconBadge icon={<Sparkles />} accent="btc" />
            <span className="text-lg font-semibold text-white">{t('Assistente AI')}</span>
          </div>
          <button onClick={() => setChatOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-fg-3 hover:bg-white/5 hover:text-white" aria-label={t('Chiudi')}><X size={ICON.nav} /></button>
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
          {/* keyed by page: an error boundary tripped on one page does not stay up after navigating to another */}
          <Outlet key={loc.pathname} />
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
