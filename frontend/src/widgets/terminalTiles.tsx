/*
 * Riquadri del Terminale: barra prezzi, book a scala (DOM), order feed, order flow 1/5/15 min, liquidazioni reali, integrità.
 * Ogni riquadro si abbona solo alla propria fetta dello stato live (≤ 1 render per frame, in pratica ≤ 4/s).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { FeedItem, StreamKey, TermDom, TermStatus } from '../api/terminal'
import { Segmented, Skeleton, clsx } from '../components/ui'
import { C, hexA } from '../components/charts/theme'
import { agoSeconds, compact, dateTime, pct, usd, usdCompact } from '../lib/format'
import { t } from '../i18n'
import { EX_LABEL } from './terminalChart'
import { useSlice, type TermLive } from './terminalLive'

type N = number | null | undefined

export const STREAM_LABEL: Record<StreamKey, string> = {
  binance_perp: 'Binance perp', bybit_perp: 'Bybit perp', okx_perp: 'OKX perp', binance_spot: 'Binance spot', coinbase_spot: 'Coinbase',
  bybit_spot: 'Bybit spot', okx_spot: 'OKX spot',
}
/** monogramma + tinta per exchange (palette dell'app, non i colori dei marchi) */
const EX_TAG: Record<string, { s: string; c: string }> = {
  binance: { s: 'BN', c: '#E8B04B' }, bybit: { s: 'BY', c: '#9B87F5' }, okx: { s: 'OK', c: '#B3BCD0' }, coinbase: { s: 'CB', c: '#5B8DEF' },
}
export function ExTag({ ex, className }: { ex: string; className?: string }) {
  const x = EX_TAG[ex] ?? { s: ex.slice(0, 2).toUpperCase(), c: '#8C96AD' }
  return (
    <span title={EX_LABEL[ex] ?? ex} className={clsx('inline-grid h-4 w-[22px] shrink-0 place-items-center rounded text-[9px] font-semibold tracking-wide', className)}
      style={{ color: x.c, background: hexA(x.c, 0.14), boxShadow: `inset 0 0 0 1px ${hexA(x.c, 0.25)}` }}>{x.s}</span>
  )
}
const exOf = (s: StreamKey) => s.split('_')[0]
/** controvalore di un trade: $0.42 · $73 · $15.2K · $1.2M */
export const tradeUsd = (u: number) => (u < 1 ? `$${u.toFixed(2)}` : u < 1000 ? `$${Math.round(u)}` : usdCompact(u, 1))
const signed = (v: N, f: (x: number) => string) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`)

// ------------------------------------------------------------------ barra superiore
function Countdown({ to }: { to: N }) {
  const [, force] = useState(0)
  useEffect(() => { const id = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(id) }, [])
  if (!to) return <>—</>
  const s = Math.max(0, Math.round(to - Date.now() / 1000))
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60
  return <>{`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`}</>
}

function Stat({ label, children, sub, className }: { label: string; children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="label truncate">{label}</div>
      <div className="tnum mt-0.5 truncate text-sm font-semibold text-white">{children}</div>
      {sub !== undefined && <div className="tnum truncate text-2xs text-slate-500">{sub}</div>}
    </div>
  )
}

export function TickerBar({ live, right }: { live: TermLive; right?: ReactNode }) {
  useSlice(live, 'ticker')
  useSlice(live, 'px')
  const tk = live.ticker
  const prev = useRef<number | null>(null)
  const [dir, setDir] = useState<'up' | 'down' | null>(null)
  const px = live.px ?? tk?.last ?? null
  useEffect(() => {
    if (px != null && prev.current != null && px !== prev.current) setDir(px > prev.current ? 'up' : 'down')
    prev.current = px
  }, [px])
  return (
    <div className="card flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-5" data-testid="term-ticker">
      <div className="min-w-0">
        <div className="label">BTCUSDT · {t('Binance perp')}</div>
        <div className="flex items-baseline gap-2">
          <span className={clsx('tnum text-[26px] font-semibold leading-tight tracking-[-0.02em] transition-colors duration-300', dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-white')} data-testid="term-price">
            {px != null ? usd(px, 1) : '—'}
          </span>
          <span className={clsx('tnum text-sm font-medium', (tk?.change_24h ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(tk?.change_24h ?? null, 2)}</span>
        </div>
      </div>
      <div className="grid min-w-0 flex-1 basis-full gap-x-5 gap-y-3 lg:basis-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))' }}>
        <Stat label={t('Mark')} sub={`${t('Indice')} ${usd(tk?.index ?? null, 1)}`}>{usd(tk?.mark ?? null, 1)}</Stat>
        <Stat label={t('Max 24h')}>{usd(tk?.high_24h ?? null, 1)}</Stat>
        <Stat label={t('Min 24h')}>{usd(tk?.low_24h ?? null, 1)}</Stat>
        <Stat label={t('Volume 24h')} sub={`${compact(tk?.vol_24h_btc ?? null, 1)} BTC`}>{usdCompact(tk?.vol_24h_usd ?? null, 2)}</Stat>
        <Stat label={t('Funding Binance')} sub={<><Countdown to={tk?.next_funding} /> {t('al prossimo')}</>}>
          <span className={(tk?.funding_rate ?? 0) >= 0 ? 'text-accent-blue' : 'text-amber-400'}>{tk?.funding_rate != null ? `${tk.funding_rate.toFixed(4)}%` : '—'}</span>
        </Stat>
        <Stat label={t('Funding medio')} sub={t('Ponderato OI · 8 h')}>
          <span className={(tk?.f8 ?? 0) >= 0 ? 'text-accent-blue' : 'text-amber-400'}>{tk?.f8 != null ? `${tk.f8.toFixed(4)}%` : '—'}</span>
        </Stat>
        <Stat label={t('Open interest')} sub={tk?.oi_chg_1h != null ? `${pct(tk.oi_chg_1h, 2)} 1h · ${usdCompact(tk?.oi_usd ?? null, 1)}` : usdCompact(tk?.oi_usd ?? null, 1)}>
          {tk?.oi_btc != null ? `${compact(tk.oi_btc, 1)} BTC` : '—'}
        </Stat>
        <Stat label={t('Premio Coinbase')} sub={tk?.cb != null && tk?.bn != null ? `${usd(tk.cb - tk.bn, 1)}` : undefined}>
          <span className={(tk?.premium ?? 0) >= 0 ? 'text-accent-blue' : 'text-amber-400'}>{tk?.premium != null ? pct(tk.premium, 3) : '—'}</span>
        </Stat>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

export function ConnPill({ live }: { live: TermLive }) {
  useSlice(live, 'conn')
  useSlice(live, 'perf')
  const c = live.conn
  const p = live.perf
  const txt = c === 'live' ? t('Live') : c === 'polling' ? t('Polling 5 s') : c === 'connecting' ? t('Connessione') : t('Offline')
  const n = live.streams ? Object.values(live.streams).filter((s) => s.c).length : null
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset',
        c === 'live' ? 'bg-up/10 text-up ring-up/20' : c === 'polling' ? 'bg-amber-400/10 text-amber-400 ring-amber-400/20' : 'bg-white/[0.04] text-slate-400 ring-white/10')}
        data-testid="term-conn" title={t('Stream connessi')}>
        <span className={clsx('h-1.5 w-1.5 rounded-full', c === 'live' ? 'animate-pulse bg-up' : c === 'polling' ? 'bg-amber-400' : 'bg-slate-500')} />
        {txt}{n != null && <span className="tnum font-normal opacity-80">· {n}/7</span>}
      </span>
      <span className="tnum hidden text-2xs text-slate-500 lg:inline" title={t('Frame al secondo · latenza server → schermo (mediana) · messaggi al secondo')}>
        {p.fps ?? '—'} fps · {p.latMs != null ? `${Math.round(p.latMs)} ms` : '—'} · {p.msgsPerS}/s
      </span>
    </span>
  )
}

// ------------------------------------------------------------------ DOM
const STEPS = [0.1, 1, 5, 10, 25, 50, 100]
export function DomTile({ live, height, compactUi }: { live: TermLive; height: number; compactUi?: boolean }) {
  useSlice(live, 'dom')
  const d: TermDom | null = live.dom
  const [step, setStep] = useState(live.ctl.ds)
  const [mkt, setMkt] = useState(live.ctl.dm)
  const ROW = 19
  const n = Math.max(6, Math.min(40, Math.floor((height - 128) / ROW / 2)))
  useEffect(() => { live.setCtl({ ds: step, dm: mkt, dn: n }) }, [step, mkt, n, live])
  const prevQ = useRef(new Map<number, number>())
  const deltas = useRef(new Map<number, number>())
  const view = useMemo(() => {
    if (!d?.synced || !d.bids || !d.asks || d.step !== step || d.market !== mkt) return null
    const bids = d.bids.slice(0, n), asks = d.asks.slice(0, n)
    const cum = (rows: [number, number][]) => { let s = 0; return rows.map(([p, q]) => { s += q; return { p, q, cum: s } }) }
    const B = cum(bids), A = cum(asks)
    const sb = B.length ? B[B.length - 1].cum : 0, sa = A.length ? A[A.length - 1].cum : 0
    const mx = Math.max(1e-9, sb, sa)
    const pm = prevQ.current, dm = deltas.current
    const next = new Map<number, number>()
    for (const r of [...B, ...A]) {
      const prev = pm.get(r.p)
      if (prev != null && Math.abs(r.q - prev) > 1e-6) dm.set(r.p, r.q - prev)
      next.set(r.p, r.q)
    }
    prevQ.current = next
    return { B, A: A.reverse(), mx, share: sb + sa > 0 ? sb / (sb + sa) : 0.5, bb: d.bb!, ba: d.ba! }
  }, [d, step, mkt, n])
  const dec = step < 1 ? 1 : 0
  const Row = ({ p, q, cum, side }: { p: number; q: number; cum: number; side: 'b' | 'a' }) => {
    const dv = deltas.current.get(p)
    return (
      <div className="relative grid h-[19px] grid-cols-[1fr_0.8fr_0.7fr_0.9fr] items-center gap-1 px-2 text-[11px] leading-none">
        <span className="absolute inset-y-px right-0" style={{ width: `${(cum / (view?.mx || 1)) * 100}%`, background: side === 'b' ? 'rgba(46,189,133,0.10)' : 'rgba(239,84,102,0.10)' }} />
        <span className="absolute inset-y-[5px] right-0" style={{ width: `${Math.min(100, (q / (view?.mx || 1)) * 300)}%`, background: side === 'b' ? 'rgba(46,189,133,0.28)' : 'rgba(239,84,102,0.28)' }} />
        <span className={clsx('tnum relative font-medium', side === 'b' ? 'text-up' : 'text-down')}>{p.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}</span>
        <span className={clsx('tnum relative text-right', dv == null ? 'text-slate-600' : dv > 0 ? 'text-up/80' : 'text-down/80')}>{dv == null ? '' : signed(dv, (x) => x.toFixed(x < 10 ? 2 : 1))}</span>
        <span className="tnum relative text-right text-slate-200">{q.toFixed(q < 10 ? 3 : 1)}</span>
        <span className="tnum relative text-right text-slate-400">{cum.toFixed(cum < 100 ? 2 : 0)}</span>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="term-dom">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2">
        <Segmented size="sm" value={mkt} onChange={(v) => setMkt(v)} options={[{ value: 'futures', label: t('Perp') }, { value: 'spot', label: t('Spot') }]} />
        <Segmented size="sm" value={step} onChange={setStep} options={STEPS.filter((s) => !compactUi || s >= 1).map((s) => ({ value: s, label: s < 1 ? '0.1' : String(s) }))} />
      </div>
      <div className="grid grid-cols-[1fr_0.8fr_0.7fr_0.9fr] gap-1 border-b border-white/[0.05] px-2 pb-1 text-[10px] uppercase tracking-wider text-slate-500">
        <span>{t('Prezzo')}</span><span className="text-right">Δ</span><span className="text-right">{t('BTC')}</span><span className="text-right">{t('Cumulato')}</span>
      </div>
      {!view ? <div className="flex-1 p-3"><Skeleton className="h-full w-full" /><p className="mt-2 text-center text-xs text-slate-500">{d && !d.synced ? t('Book in sincronizzazione') : ''}</p></div> : (
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
          <div>{view.A.map((r) => <Row key={`a${r.p}`} {...r} side="a" />)}</div>
          <div className="my-1 border-y border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="tnum text-base font-semibold text-white">{usd((view.bb + view.ba) / 2, 1)}</span>
              <span className="tnum text-2xs text-slate-400">{t('Spread')} {usd(view.ba - view.bb, 1)} ({((view.ba / view.bb - 1) * 100).toFixed(4)}%)</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-2xs">
              <span className="tnum text-up">{t('Bid')} {pct(view.share * 100, 1, false)}</span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-down/50"><span className="block h-full bg-up/80" style={{ width: `${view.share * 100}%` }} /></span>
              <span className="tnum text-down">{pct((1 - view.share) * 100, 1, false)} {t('Ask')}</span>
            </div>
          </div>
          <div>{view.B.map((r) => <Row key={`b${r.p}`} {...r} side="b" />)}</div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ order feed
const MINS = [0, 10_000, 50_000, 100_000, 1_000_000]
function FeedCol({ items, title, live, mkt }: { items: FeedItem[]; title: string; live: TermLive; mkt: 'perp' | 'spot' }) {
  const f = live.flow?.w5
  const vol = mkt === 'perp' ? f?.perp_usd : f?.spot_usd
  const dl = mkt === 'perp' ? f?.perp_delta_usd : f?.spot_delta_usd
  const now = Date.now()
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-2 pb-1">
        <span className="label">{title} · 5m</span>
        <span className="tnum text-2xs text-slate-400">{usdCompact(vol ?? null, 1)} <span className={(dl ?? 0) >= 0 ? 'text-up' : 'text-down'}>{signed(dl, (x) => usdCompact(x, 1).replace('$', '$'))}</span></span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {items.length === 0 ? <p className="px-2 py-4 text-center text-2xs text-slate-500">{t('In attesa di trade')}</p> : items.map((x) => {
          const big = x.u >= 100_000
          const age = Math.max(0, Math.round((now - x.t) / 1000))
          return (
            <div key={x.k} className="relative grid h-[19px] grid-cols-[22px_minmax(0,1fr)_auto_20px] items-center gap-1 px-1.5 text-[11px] leading-none"
              style={big ? { background: hexA(x.b ? C.up : C.down, Math.min(0.32, 0.1 + Math.log10(x.u / 100_000 + 1) * 0.18)) } : undefined}>
              <ExTag ex={exOf(x.s)} />
              <span className={clsx('tnum truncate', x.b ? 'text-up' : 'text-down')}>{x.b ? '▲' : '▼'} {x.p != null ? x.p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}</span>
              <span className={clsx('tnum text-right', big ? 'font-semibold text-white' : 'text-slate-300')}>{tradeUsd(x.u)}{x.a ? <span className="ml-0.5 text-slate-500">×{x.n}</span> : null}</span>
              <span className="tnum text-right text-slate-500">{age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function FeedTile({ live }: { live: TermLive }) {
  useSlice(live, 'feed')
  useSlice(live, 'flow')
  const [min, setMin] = useState(0)
  const [, tick] = useState(0)
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 2000); return () => clearInterval(id) }, [])
  const filt = (mkt: 'perp' | 'spot') => live.feed.filter((x) => x.s.endsWith(mkt) && x.u >= Math.max(min, 100) && (min === 0 || !x.a)).slice(0, 60)
  const f = live.flow?.w5
  const share = f?.buy_share ?? null
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="term-feed">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2">
        <Segmented size="sm" value={min} onChange={setMin} options={MINS.map((m) => ({ value: m, label: m === 0 ? t('Tutti') : `≥${compact(m, 0)}` }))} />
      </div>
      {share != null && (
        <div className="flex items-center gap-2 px-3 pb-2 text-2xs">
          <span className="tnum text-up">{pct(share * 100, 0, false)}</span>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-down/50"><span className="block h-full bg-up/80" style={{ width: `${share * 100}%` }} /></span>
          <span className="tnum text-down">{pct((1 - share) * 100, 0, false)}</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-1">
        <FeedCol items={filt('perp')} title={t('Perp')} live={live} mkt="perp" />
        <div className="w-px bg-white/[0.05]" />
        <FeedCol items={filt('spot')} title={t('Spot')} live={live} mkt="spot" />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ order flow
export function FlowTile({ live }: { live: TermLive }) {
  useSlice(live, 'flow')
  const fl = live.flow
  if (!fl) return <div className="p-3"><Skeleton className="h-40" /></div>
  const rows = [['1m', fl.w1], ['5m', fl.w5], ['15m', fl.w15]] as const
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-2 px-3 pb-1" data-testid="term-flow">
      <div className="flex justify-between text-2xs font-medium"><span className="text-up">▲ {t('Acquirenti')}</span><span className="text-down">{t('Venditori')} ▼</span></div>
      {rows.map(([k, w]) => {
        const share = w.buy_share ?? 0.5
        return (
          <div key={k} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-2xs text-slate-400">
              <span className="text-xs font-semibold text-white">{k}{w.cov_s != null && w.cov_s < w.win_s - 5 && <span className="ml-1.5 font-normal text-amber-400" title={t('Raccolta avviata da meno della durata della finestra')}>{t('{m} min raccolti', { m: Math.max(1, Math.round(w.cov_s / 60)) })}</span>}</span>
              <span className="tnum truncate">{t('Trade')} {(w.n_buy + w.n_sell).toLocaleString('en-US')} · {t('taglia media')} {usdCompact(w.avg_usd, 1)}</span>
            </div>
            <div className="relative mt-1 flex h-2 overflow-hidden rounded-full bg-white/[0.04]">
              <span className="h-full bg-up/80" style={{ width: `${share * 100}%` }} />
              <span className="h-full flex-1 bg-down/70" />
            </div>
            <div className="tnum mt-1 flex items-baseline justify-between gap-2 text-2xs">
              <span className="text-up">{usdCompact(w.buy_usd, 1)} · {pct(share * 100, 0, false)} · ▲{w.large_buy}</span>
              <span className={clsx('font-semibold', w.delta_usd >= 0 ? 'text-up' : 'text-down')}>{signed(w.delta_usd, (x) => usdCompact(x, 2))}</span>
              <span className="text-down">▼{w.large_sell} · {pct((1 - share) * 100, 0, false)} · {usdCompact(w.sell_usd, 1)}</span>
            </div>
          </div>
        )
      })}
      <div className="tnum flex justify-between border-t border-white/[0.05] pt-1.5 text-2xs text-slate-500">
        <span>{t('Exchange attivi')} {fl.w5.exchanges}</span>
        <span>▲▼ {t('grandi')} ≥ $100K</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ liquidazioni reali
export function LiqsTile({ live }: { live: TermLive }) {
  useSlice(live, 'liqs')
  const now = Date.now() / 1000
  const h1 = live.liqs.filter((l) => l.t >= now - 3600)
  const lu = h1.filter((l) => l.side === 'long').reduce((a, b) => a + b.usd, 0)
  const su = h1.filter((l) => l.side === 'short').reduce((a, b) => a + b.usd, 0)
  return (
    <div className="flex h-full min-h-0 flex-col px-3" data-testid="term-liqs">
      <div className="grid grid-cols-2 gap-2 pb-2">
        <div className="rounded-lg border border-line bg-white/[0.02] px-2.5 py-1.5"><div className="label">{t('Long 1h')}</div><div className="tnum text-sm font-semibold text-down">{usdCompact(lu, 2)}</div></div>
        <div className="rounded-lg border border-line bg-white/[0.02] px-2.5 py-1.5"><div className="label">{t('Short 1h')}</div><div className="tnum text-sm font-semibold text-up">{usdCompact(su, 2)}</div></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        {live.liqs.length === 0 ? <p className="py-4 text-center text-xs text-slate-500">{t('Nessuna liquidazione nelle ultime 24 ore')}</p> : live.liqs.slice(0, 80).map((l, i) => (
          <div key={`${l.t}-${l.price}-${i}`} className="tnum grid h-6 grid-cols-[22px_auto_1fr_auto] items-center gap-2 border-b border-white/[0.03] text-[11px]">
            <ExTag ex={l.ex} />
            <span className={l.side === 'long' ? 'text-down' : 'text-up'}>{l.side === 'long' ? t('Long') : t('Short')}</span>
            <span className="truncate text-slate-300">{usd(l.price, 0)} <span className="text-slate-500">· {new Date(l.t * 1000).toLocaleTimeString('en-GB')}</span></span>
            <span className={clsx('text-right font-medium', l.usd >= 1e6 ? 'text-white' : 'text-slate-300')}>{tradeUsd(l.usd)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ integrità
function Row({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] py-1 last:border-0">
      <span className="min-w-0 text-slate-400">{k}</span>
      <span className={clsx('tnum shrink-0 text-right font-medium', tone === 'ok' ? 'text-up' : tone === 'warn' ? 'text-amber-400' : 'text-white')}>{v}</span>
    </div>
  )
}
export function IntegrityTile({ st }: { st: TermStatus | undefined }) {
  if (!st) return <div className="p-3"><Skeleton className="h-48" /></div>
  const keys = Object.keys(st.streams) as StreamKey[]
  const allKc = keys.flatMap((k) => (st.streams[k].kline_check.n ? [st.streams[k].kline_check] : []))
  const okAll = allKc.length > 0 && allKc.every((k) => (k.median_abs ?? 9) < 1)
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-3 pb-2 text-xs [scrollbar-width:thin]" data-testid="term-integrity">
      <div className="-mx-1 overflow-x-auto">
        <table className="tbl w-full text-[11px]">
          <thead>
            <tr>
              <th className="text-left">{t('Stream')}</th><th className="text-right">{t('Trade')}</th><th className="text-right">{t('Ultimo')}</th>
              <th className="text-right" title={t('Volume per minuto vs kline 1m ufficiali: scarto mediano · massimo')}>{t('Vs kline')}</th>
              <th className="hidden text-right sm:table-cell">{t('Minuti')}</th><th className="hidden text-right sm:table-cell">{t('Recuperi')}</th><th className="hidden text-right sm:table-cell">{t('Riconn.')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const s = st.streams[k]
              const kc = s.kline_check
              return (
                <tr key={k} className="border-t border-white/[0.04]">
                  <td className="px-2 py-1"><span className="inline-flex items-center gap-1.5"><span className={clsx('h-1.5 w-1.5 rounded-full', s.connected ? 'bg-up' : 'bg-down')} /><ExTag ex={s.ex} />{s.mkt === 'perp' ? t('Perp') : t('Spot')}</span></td>
                  <td className="tnum px-2 py-1 text-right text-slate-300">{s.trades.toLocaleString('en-US')}</td>
                  <td className="tnum px-2 py-1 text-right text-slate-400">{s.last_age_s != null ? agoSeconds(s.last_age_s).replace(/ (fa|ago)$/, '') : '—'}</td>
                  <td className={clsx('tnum px-2 py-1 text-right', !kc.n ? 'text-slate-500' : (kc.median_abs ?? 9) < 1 ? 'text-up' : 'text-amber-400')}>
                    {kc.n ? `${(kc.median_abs ?? 0).toFixed(2)}% · ${(kc.max_abs ?? 0).toFixed(2)}%` : t('In attesa')}
                  </td>
                  <td className="tnum hidden px-2 py-1 text-right text-slate-400 sm:table-cell">{kc.n || '—'}</td>
                  <td className="tnum hidden px-2 py-1 text-right text-slate-400 sm:table-cell">{s.recoveries.n ? `${s.recoveries.ok}/${s.recoveries.n}` : '0'}</td>
                  <td className="tnum hidden px-2 py-1 text-right text-slate-400 sm:table-cell">{s.reconnects}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="grid gap-x-6 gap-y-0 md:grid-cols-2">
        <div>
          <div className="label mb-1 mt-1 flex items-center gap-1.5">{okAll ? <CheckCircle2 size={12} className="text-up" /> : <AlertTriangle size={12} className="text-amber-400" />}{t('Verifiche')}</div>
          <Row k={t('Contratto OKX (ctVal ufficiale)')} v={st.okx_ct ? `${st.okx_ct.ct_val} ${st.okx_ct.ccy}` : '—'} tone={st.okx_ct?.ok ? 'ok' : 'warn'} />
          <Row k={t('Premio live vs serie oraria')} v={st.premium_check?.n ? `${(st.premium_check.median_abs_pp ?? 0).toFixed(3)} pp · n ${st.premium_check.n}` : t('In attesa')} />
          <Row k={t('Taker buy Binance vs kline')} v={st.streams.binance_perp.kline_check.buy?.n ? `${(st.streams.binance_perp.kline_check.buy.median_abs ?? 0).toFixed(3)}%` : '—'} />
          <Row k={t('Trade duplicati scartati')} v={keys.reduce((a, k) => a + st.streams[k].dupes, 0).toLocaleString('en-US')} />
          <Row k={t('Minuti incompleti (esclusi)')} v={keys.reduce((a, k) => a + st.streams[k].incomplete_minutes, 0)} />
        </div>
        <div>
          <div className="label mb-1 mt-1">{t('Risorse')}</div>
          <Row k={t('Su disco · retention')} v={`${st.storage.total_mb.toFixed(1)} MB · ${st.storage.retention_days} ${t('giorni')}`} />
          <Row k={t('Crescita stimata')} v={st.storage.mb_per_day != null ? `${st.storage.mb_per_day.toFixed(1)} MB/${t('giorno')}` : t('In misura')} />
          <Row k={t('CPU collector · scrittura')} v={`${st.cpu.collector_pct.toFixed(1)}% · ${st.cpu.flush_pct.toFixed(2)}%`} />
          <Row k={t('RAM processo')} v={st.rss_mb != null ? `${st.rss_mb.toFixed(0)} MB` : '—'} />
          <Row k={t('Raccolta multi-exchange dal')} v={(() => { const v = Object.values(st.collection_start); return v.length ? dateTime(Math.max(...(v as number[]))) : '—' })()} />
        </div>
      </div>
    </div>
  )
}
