// Superchart widgets: indicator library (labels/colours/formatters), pane headers, layout & replay controls,
// anomalies cards with the backtest per type. Labels are Italian source strings translated with t() at render time.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check as CheckIcon, ChevronDown, ChevronLeft, ChevronRight, Layers, Link2, Pause, Play, Plus, Radar, Save, Search, Trash2, X,
} from 'lucide-react'
import type { AnRecent, AnTypeRow, AnVerdict, Anomalies, ScAnomaly, ScData, ScIndicator, ScLayout, ScPaneState, ScTf, ScUnit } from '../api/superchart'
import type { EngineCandles, EnginePane } from '../components/charts/SuperChart'
import { ANALOG_COLORS, C } from '../components/charts/theme'
import { Badge, CardHeader, Card, CardBody, Q, clsx } from '../components/ui'
import { compact, date, dateTime, pct, usd, usdCompact } from '../lib/format'
import { t } from '../i18n'
import type { UseQueryResult } from '@tanstack/react-query'

const DAY = 86400
const minus = (s: string) => s.replace(/^-/, '−')

// ===================================================================== formatters
function fmtUnit(unit: ScUnit, digits?: number): (v: number) => string {
  switch (unit) {
    case 'pct_8h': return (v) => minus(`${v.toFixed(digits ?? 4)}%`)
    case 'pct': return (v) => minus(`${v.toFixed(digits ?? 2)}%`)
    case 'btc': return (v) => compact(v, 2)
    case 'usd': return (v) => (Math.abs(v) >= 1000 ? minus(usd(v)) : minus(v.toFixed(digits ?? 1)))
    case 'musd': return (v) => usdCompact(v * 1e6, 1)
    case 'busd': return (v) => `$${v.toFixed(1)}B`
    case 'ratio': return (v) => minus(v.toFixed(digits ?? 3))
    case 'idx': return (v) => minus(Math.abs(v) >= 100 ? v.toFixed(digits ?? 1) : v.toFixed(digits ?? 2))
    default: return (v) => minus(String(+v.toPrecision(4)))
  }
}

// ===================================================================== indicator library
export type ColDef = { key: string; label: string; type: 'line' | 'hist'; color?: string; signed?: 'up-good' | 'down-good'; negate?: boolean; dashed?: boolean; width?: number }
export type IndDef = { label: string; cols: ColDef[]; fmt: (v: number) => string; levels?: number[]; volColors?: boolean }

const VW = ['#5B8DEF', '#B49CFF', '#3CC6B0', '#E8C25B']
export function scDefs(): Record<string, IndDef> {
  const line = (key: string, label: string, extra: Partial<ColDef> = {}): ColDef => ({ key, label, type: 'line', ...extra })
  const hist = (key: string, label: string, extra: Partial<ColDef> = {}): ColDef => ({ key, label, type: 'hist', ...extra })
  return {
    vwap: { label: t('VWAP ancorati W · M · Q · Y'), cols: [line('w', 'W', { color: VW[0] }), line('m', 'M', { color: VW[1] }), line('q', 'Q', { color: VW[2] }), line('y', 'Y', { color: VW[3] })], fmt: (v) => usd(v) },
    volume: { label: t('Volume spot'), cols: [hist('v', t('Volume'))], fmt: fmtUnit('btc'), volColors: true },
    rsi: { label: 'RSI 14', cols: [line('rsi', 'RSI')], fmt: (v) => v.toFixed(1), levels: [70, 30] },
    macd: { label: 'MACD 12 · 26 · 9', cols: [hist('hist', t('Istogramma'), { signed: 'up-good' }), line('macd', 'MACD', { color: C.blue }), line('signal', 'Signal', { color: C.grey })], fmt: fmtUnit('usd'), levels: [0] },
    funding_binance: { label: t('Funding Binance'), cols: [line('f', t('Funding %/8h'))], fmt: fmtUnit('pct_8h'), levels: [0, 0.01] },
    funding_agg: { label: t('Funding aggregato (ponderato per OI)'), cols: [line('f', t('Funding %/8h'))], fmt: fmtUnit('pct_8h'), levels: [0, 0.01] },
    oi_binance: { label: t('Open interest Binance'), cols: [line('oi', t('OI (BTC)'))], fmt: fmtUnit('btc') },
    oi_agg: { label: t('Open interest Binance + Bybit + OKX'), cols: [line('oi', t('OI (BTC)'))], fmt: fmtUnit('btc') },
    ls_ratio: { label: t('Long/short ratio (account)'), cols: [line('r', t('Rapporto'))], fmt: fmtUnit('ratio', 2), levels: [1] },
    liquidations: { label: t('Liquidazioni reali'), cols: [hist('short', t('Short liquidati'), { color: 'rgba(46,189,133,0.75)' }), hist('long', t('Long liquidati'), { color: 'rgba(239,84,102,0.75)', negate: true })], fmt: (v) => usdCompact(Math.abs(v), 1), levels: [0] },
    cvd_spot: { label: t('CVD spot (taker buy − sell)'), cols: [line('d', 'CVD')], fmt: fmtUnit('btc') },
    cvd_perp: { label: t('CVD perpetual (taker buy − sell)'), cols: [line('d', 'CVD')], fmt: fmtUnit('btc') },
    cb_premium: { label: t('Premio Coinbase'), cols: [line('p', t('Premio'))], fmt: fmtUnit('pct', 3), levels: [0] },
    basis: { label: t('Basis futures annualizzato (90 g)'), cols: [line('b', 'Basis')], fmt: fmtUnit('pct', 2), levels: [0] },
    etf_flows: { label: t('Flussi ETF spot'), cols: [hist('f', t('Flusso netto'), { signed: 'up-good' })], fmt: fmtUnit('musd'), levels: [0] },
    exch_reserve: { label: t('Riserve sugli exchange'), cols: [line('r', t('Riserve (BTC)'))], fmt: fmtUnit('btc') },
    exch_netflow: { label: t('Flusso netto verso gli exchange'), cols: [hist('n', t('Flusso netto (BTC)'), { signed: 'down-good' })], fmt: fmtUnit('btc'), levels: [0] },
    mvrv: { label: 'MVRV', cols: [line('mvrv', 'MVRV')], fmt: fmtUnit('ratio', 2), levels: [1] },
    nupl: { label: 'NUPL', cols: [line('nupl', 'NUPL')], fmt: fmtUnit('ratio', 3), levels: [0] },
    sopr_sth: { label: 'SOPR STH', cols: [line('sopr', 'SOPR')], fmt: fmtUnit('ratio', 3), levels: [1] },
    mvrv_holders: { label: 'MVRV STH · LTH', cols: [line('sth', 'STH'), line('lth', 'LTH', { dashed: true })], fmt: fmtUnit('ratio', 2), levels: [1] },
    fng: { label: 'Fear & Greed', cols: [line('v', t('Indice'))], fmt: (v) => v.toFixed(0), levels: [25, 75] },
    usdt_dom: { label: t('USDT dominance'), cols: [line('d', 'USDT.D')], fmt: fmtUnit('pct', 2) },
    stables: { label: t('Supply stablecoin'), cols: [line('s', t('Supply'))], fmt: fmtUnit('busd') },
    dxy: { label: t('DXY (dollaro)'), cols: [line('c', 'DXY')], fmt: fmtUnit('idx', 2) },
    spx: { label: 'S&P 500', cols: [line('c', 'S&P 500')], fmt: fmtUnit('idx', 0) },
    gold: { label: t('Oro'), cols: [line('c', t('Oro'))], fmt: (v) => usd(v) },
  }
}

export const GROUPS: { id: ScIndicator['group']; label: string }[] = [
  { id: 'price', label: 'Prezzo' }, { id: 'derivatives', label: 'Derivati' }, { id: 'flows', label: 'Flussi' },
  { id: 'onchain', label: 'On-chain' }, { id: 'macro', label: 'Sentiment e macro' },
]
const SOURCE: Record<string, string> = {
  binance_spot: 'Binance spot BTCUSDT', binance: 'Binance USDⓈ-M', binance_usdm: 'Binance USDⓈ-M', agg3: 'Binance + Bybit + OKX',
  agg3_live: 'Binance + Bybit + OKX (raccolta live)', coinbase: 'Coinbase vs Binance', farside: 'Farside', coinmetrics: 'CoinMetrics',
  bgeometrics: 'BGeometrics', alternative: 'alternative.me', coinmetrics_cg: 'CoinMetrics + CoinGecko', defillama: 'DefiLlama', yahoo: 'Yahoo Finance',
}
export const sourceLabel = (s: string) => t(SOURCE[s] ?? s)
export function resLabel(i: ScIndicator): string {
  if (i.id === 'liquidations') return t('eventi')
  if (!i.res) return t('candele del grafico')
  if (i.res < 3600) return t('{n} min', { n: i.res / 60 })
  if (i.res < DAY) return t('{n} h', { n: i.res / 3600 })
  return t('giornaliera')
}
export function lagLabel(i: ScIndicator): string | null {
  if (!i.lag) return null
  const d = i.lag / DAY
  return d >= 1 ? t('pubblicata con {n} g di ritardo', { n: +d.toFixed(1) }) : t('pubblicata con {n} h di ritardo', { n: Math.round(i.lag / 3600) })
}

// ===================================================================== engine panes
export const PANE_COLORS = ['#5B8DEF', '#B49CFF', '#3CC6B0', '#E8C25B', '#F28CC0', '#7DD3FC', '#D8B4FE', '#6EE7C8', '#F9A8D4', '#A7B4D0']
const UP_A = 'rgba(46,189,133,0.6)'
const DN_A = 'rgba(239,84,102,0.6)'

export function paneColor(i: number) { return PANE_COLORS[i % PANE_COLORS.length] }

/** UTC anchor period of a bar (anchored VWAPs restart there). */
const anchorKey = (t: number, col: string) => {
  const d = new Date(t * 1000)
  if (col === 'w') return Math.floor((t / 86400 + 3) / 7)            // weeks start on Monday 00:00 UTC
  if (col === 'm') return d.getUTCFullYear() * 12 + d.getUTCMonth()
  if (col === 'q') return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3)
  if (col === 'y') return d.getUTCFullYear()
  return 0
}
/**
 * Anchored VWAP: the segment that joins the last bar of a period to the first bar of the next one is drawn transparent
 * (lightweight-charts 4 joins line points across whitespace, so a null would not break the line).
 */
function anchorColors(values: (number | null)[], t: number[], col: string, color: string): string[] | null {
  if (!['w', 'm', 'q', 'y'].includes(col)) return null
  // lightweight-charts colours a segment with the colour of the point it starts from: the last bar of each period
  return values.map((_, i) => (i + 1 < t.length && anchorKey(t[i + 1], col) !== anchorKey(t[i], col) ? 'transparent' : color))
}

export function buildPanes(data: ScData, panes: ScPaneState[], defs: Record<string, IndDef>, catalog: Record<string, ScIndicator>): EnginePane[] {
  const out: EnginePane[] = []
  const cd = data.candles
  panes.forEach((p, idx) => {
    const ser = data.series[p.id]
    const def = defs[p.id]
    if (!ser || !def) return
    const base = paneColor(idx)
    const series = def.cols.map((c, k) => {
      const raw = ser.cols[c.key] ?? []
      const values = c.negate ? raw.map((v) => (v == null ? null : -v)) : raw
      let colors: string[] | null = null
      if (c.type === 'hist' && def.volColors && cd) colors = cd.c.map((x, i) => (x >= cd.o[i] ? 'rgba(46,189,133,0.42)' : 'rgba(239,84,102,0.42)'))
      else if (c.type === 'hist' && c.signed) colors = values.map((v) => ((v ?? 0) >= 0) === (c.signed === 'up-good') ? UP_A : DN_A)
      const color = c.color ?? (k === 0 ? base : ANALOG_COLORS[(idx + k + 3) % ANALOG_COLORS.length])
      if (p.id === 'vwap' && c.type === 'line') colors = anchorColors(values, data.t, c.key, color)
      return { key: c.key, type: c.type, color, values, colors, width: c.width, dashed: c.dashed }
    })
    const meta = catalog[p.id]
    out.push({
      key: p.id, ov: p.ov || meta?.place === 'overlay', priceScale: meta?.unit === 'usd' && p.id === 'vwap' ? 'right' : 'own', h: p.h,
      series, levels: def.levels, fmt: def.fmt, markers: p.an ? ser.anomalies.map((a) => ({ i: a[0], z: a[1] })) : [],
    })
  })
  return out
}

export function engineCandles(d: ScData): EngineCandles {
  return d.candles ?? { o: [], h: [], l: [], c: [], v: [] }
}

// ===================================================================== popover (bottom sheet on phones)
export function Popover({ label, icon, children, count, className, align = 'left', wide }: { label: ReactNode; icon?: ReactNode; children: (close: () => void) => ReactNode; count?: number; className?: string; align?: 'left' | 'right'; wide?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [open])
  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={clsx('btn-ghost h-8 sm:h-7', open && 'bg-raised text-white')}>
        {icon}{label}{count != null && count > 0 && <span className="tnum text-slate-400">{count}</span>}<ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50 sm:hidden" onClick={() => setOpen(false)} />
          <div className={clsx('fixed inset-x-0 bottom-0 z-50 max-h-[78vh] overflow-y-auto rounded-t-2xl border border-line bg-raised p-2 pb-6 shadow-pop sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-9 sm:max-h-[70vh] sm:rounded-md sm:pb-2',
            align === 'right' ? 'sm:right-0' : 'sm:left-0', wide ? 'sm:w-[420px]' : 'sm:w-72')}>
            <div className="label px-2 pb-1 pt-1 sm:hidden">{label}</div>
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  )
}

function CheckRow({ on, onClick, children, sub, color }: { on: boolean; onClick: () => void; children: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <button type="button" onClick={onClick} role="menuitemcheckbox" aria-checked={on}
      className="flex w-full items-start gap-2.5 rounded px-2 py-1.5 text-left text-sm text-slate-300 hover:bg-white/[0.04] hover:text-white">
      <span className={clsx('mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-sm border', on ? 'border-accent-blue bg-accent-blue text-bg' : 'border-slate-600')}>{on && <CheckIcon size={12} strokeWidth={3} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {sub && <span className="block truncate text-2xs text-slate-500">{sub}</span>}
      </span>
      {color && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />}
    </button>
  )
}

// ===================================================================== indicator library menu
export function IndicatorLibrary({ catalog, panes, tf, onToggle, defs }: { catalog: ScIndicator[]; panes: ScPaneState[]; tf: ScTf; onToggle: (id: string) => void; defs: Record<string, IndDef> }) {
  const [q, setQ] = useState('')
  const on = new Set(panes.map((p) => p.id))
  const norm = (s: string) => s.toLowerCase()
  return (
    <Popover label={t('Indicatori')} icon={<Plus size={14} />} count={panes.length} wide>
      {() => (
        <div>
          <label className="relative mb-1 flex items-center px-1">
            <Search size={14} className="pointer-events-none absolute left-3 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca indicatore')} aria-label={t('Cerca indicatore')}
              className="h-8 w-full rounded-md border border-line bg-white/[0.03] pl-8 pr-2 text-sm text-white placeholder:text-slate-500 focus:border-accent-blue/40 focus:outline-none" />
          </label>
          {GROUPS.map((g) => {
            const items = catalog.filter((i) => i.group === g.id && (!q || norm(defs[i.id]?.label ?? i.id).includes(norm(q)) || norm(sourceLabel(i.source)).includes(norm(q))))
            if (!items.length) return null
            return (
              <div key={g.id} className="py-1">
                <div className="label px-2 pb-0.5 pt-1.5">{t(g.label)}</div>
                {items.map((i) => {
                  const na = i.na_tf.includes(tf)
                  const lag = lagLabel(i)
                  return (
                    <CheckRow key={i.id} on={on.has(i.id)} onClick={() => onToggle(i.id)}
                      sub={na ? t('Non disponibile su questo timeframe') : [sourceLabel(i.source), resLabel(i), lag].filter(Boolean).join(' · ')}>
                      {defs[i.id]?.label ?? i.id}{i.place === 'overlay' && <span className="ml-1.5 text-2xs text-slate-500">{t('sul prezzo')}</span>}
                    </CheckRow>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </Popover>
  )
}

// ===================================================================== layouts
export const PRESET_LABEL: Record<string, string> = { essential: 'Essenziale', derivatives: 'Derivati', onchain: 'On-chain', macro: 'Macro' }

export function LayoutMenu({ current, layouts, onPick, onSaveNew, onUpdate, onDelete, onShare, busy, dirty }: {
  current: { kind: 'preset' | 'user' | 'custom'; id?: string; name: string }
  layouts: ScLayout[]
  onPick: (kind: 'preset' | 'user', id: string) => void
  onSaveNew: (name: string) => void
  onUpdate: () => void
  onDelete: () => void
  onShare: () => void
  busy?: boolean
  dirty: boolean
}) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  return (
    <Popover label={<span className="max-w-[9rem] truncate sm:max-w-[14rem]">{current.name}{dirty && current.kind !== 'custom' ? ' *' : ''}</span>} icon={<Layers size={14} />} align="right">
      {(close) => (
        <div>
          <div className="label px-2 pb-0.5 pt-1.5">{t('Predefiniti')}</div>
          {Object.keys(PRESET_LABEL).map((id) => (
            <CheckRow key={id} on={current.kind === 'preset' && current.id === id} onClick={() => { onPick('preset', id); close() }}>{t(PRESET_LABEL[id])}</CheckRow>
          ))}
          <div className="label px-2 pb-0.5 pt-2.5">{t('I miei layout')}</div>
          {layouts.length === 0 && <p className="px-2 py-1 text-xs text-slate-500">{t('Nessun layout salvato.')}</p>}
          {layouts.map((l) => (
            <CheckRow key={l.id} on={current.kind === 'user' && current.id === l.id} onClick={() => { onPick('user', l.id); close() }}
              sub={dateTime(l.updated_at)}>{l.name}</CheckRow>
          ))}
          <div className="my-1.5 border-t border-line" />
          {naming ? (
            <form className="flex items-center gap-1.5 px-1 py-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onSaveNew(name.trim()); setNaming(false); setName(''); close() } }}>
              <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('Nome del layout')} aria-label={t('Nome del layout')}
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-white/[0.03] px-2 text-sm text-white placeholder:text-slate-500 focus:border-accent-blue/40 focus:outline-none" />
              <button type="submit" disabled={!name.trim() || busy} className="btn-ghost h-8 disabled:opacity-40">{t('Salva')}</button>
            </form>
          ) : (
            <button type="button" onClick={() => setNaming(true)} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-300 hover:bg-white/[0.04] hover:text-white">
              <Save size={14} />{t('Salva come nuovo layout…')}
            </button>
          )}
          {current.kind === 'user' && (
            <>
              <button type="button" disabled={!dirty || busy} onClick={() => { onUpdate(); close() }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-300 hover:bg-white/[0.04] hover:text-white disabled:opacity-40">
                <CheckIcon size={14} />{t('Aggiorna «{n}»', { n: current.name })}
              </button>
              <button type="button" disabled={busy} onClick={() => { onDelete(); close() }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-300 hover:bg-white/[0.04] hover:text-down">
                <Trash2 size={14} />{t('Elimina «{n}»', { n: current.name })}
              </button>
            </>
          )}
          <button type="button" onClick={() => { onShare(); close() }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-300 hover:bg-white/[0.04] hover:text-white">
            <Link2 size={14} />{t('Copia link condivisibile')}
          </button>
        </div>
      )}
    </Popover>
  )
}

// ===================================================================== replay bar
export const SPEEDS = [1, 2, 5, 10, 25]
export function ReplayBar({ cursorT, playing, speed, atEnd, onPlay, onStep, onSpeed, onDate, onExit, minDate }: {
  cursorT: number; playing: boolean; speed: number; atEnd: boolean; minDate: number | null
  onPlay: () => void; onStep: (d: number) => void; onSpeed: (s: number) => void; onDate: (t: number) => void; onExit: () => void
}) {
  const iso = new Date(cursorT * 1000).toISOString().slice(0, 10)
  const minIso = minDate ? new Date(minDate * 1000).toISOString().slice(0, 10) : undefined
  const maxIso = new Date().toISOString().slice(0, 10)
  const btn = 'grid h-8 w-8 place-items-center rounded-lg border border-line bg-white/[0.02] text-slate-300 transition-colors hover:text-white disabled:opacity-40 sm:h-7 sm:w-7'
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 sm:px-4" data-replay-bar>
      <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-amber-400/15 px-2 text-2xs font-semibold uppercase tracking-[0.08em] text-amber-300 ring-1 ring-inset ring-amber-400/30">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />Replay
      </span>
      <span className="tnum text-xs text-slate-300" title={t('Ultima candela chiusa mostrata')}>{dateTime(cursorT)}</span>
      <input type="date" value={iso} min={minIso} max={maxIso} aria-label={t('Data del replay')}
        onChange={(e) => { const v = Date.parse(e.target.value + 'T00:00:00Z'); if (Number.isFinite(v)) onDate(v / 1000) }}
        className="h-8 rounded-md border border-line bg-white/[0.03] px-2 text-xs text-white [color-scheme:dark] sm:h-7" />
      <div className="flex items-center gap-1">
        <button type="button" className={btn} onClick={() => onStep(-1)} aria-label={t('Candela precedente')} title={t('Candela precedente')}><ChevronLeft size={15} /></button>
        <button type="button" className={clsx(btn, 'w-9 text-white sm:w-8')} onClick={onPlay} disabled={atEnd && !playing} aria-label={playing ? t('Pausa') : t('Avvia')} title={playing ? t('Pausa') : t('Avvia')}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button type="button" className={btn} onClick={() => onStep(1)} disabled={atEnd} aria-label={t('Candela successiva')} title={t('Candela successiva')}><ChevronRight size={15} /></button>
      </div>
      <div className="seg inline-flex items-center rounded-[10px] p-0.5" role="group" aria-label={t('Velocità')}>
        {SPEEDS.map((s) => (
          <button key={s} type="button" onClick={() => onSpeed(s)} aria-pressed={speed === s}
            className={clsx('tnum h-8 rounded-lg px-2 text-xs font-medium sm:h-6', speed === s ? 'seg-pill text-white' : 'text-slate-400 hover:text-white')}>{s}×</button>
        ))}
      </div>
      {atEnd && <span className="text-xs text-slate-400">{t('Fine dei dati disponibili.')}</span>}
      <button type="button" onClick={onExit} className="btn-ghost ml-auto h-8 sm:h-7"><X size={14} />{t('Torna al live')}</button>
    </div>
  )
}

// ===================================================================== pane header (values at the hovered bar)
export function anomalyIndex(a: ScAnomaly[] | undefined): Map<number, ScAnomaly> {
  const m = new Map<number, ScAnomaly>()
  a?.forEach((x) => m.set(x[0], x))
  return m
}
export function AnomalyChip({ a, how, fmt }: { a: ScAnomaly; how: string | null; fmt: (v: number) => string }) {
  const [, z, raw, x, med] = a
  let ctx: string | null = null
  if (x != null && med != null) {
    if (how === 'pct') ctx = t('variazione {x} (mediana {m})', { x: pct(x, 2), m: pct(med, 2) })
    else if (how === 'log' || how === 'log1p') ctx = t('{k}× la mediana', { k: Math.exp(x - med).toFixed(1) })
    else if (how === 'level') ctx = t('mediana {m}', { m: fmt(med) })
    else if (how === 'diff') ctx = t('variazione {x}', { x: fmt(x) })
  }
  return (
    <span className="tnum inline-flex max-w-full items-center gap-1.5 truncate rounded-md bg-amber-400/[0.12] px-1.5 py-0.5 text-2xs text-amber-200 ring-1 ring-inset ring-amber-400/25">
      <Radar size={11} className="shrink-0" />{t('Anomalia')} z {minus(z >= 0 ? `+${z.toFixed(1)}` : z.toFixed(1))}
      {raw != null && how !== 'pct' && <span className="text-amber-100/80">· {fmt(raw)}</span>}
      {ctx && <span className="truncate text-amber-100/70">· {ctx}</span>}
    </span>
  )
}

// ===================================================================== anomalies: labels and plain-language verdicts
const TYPE_LABEL: Record<string, string> = {
  funding: 'Funding Binance', oi: 'Open interest Bybit', liq_long: 'Liquidazioni long', liq_short: 'Liquidazioni short',
  volume: 'Volume spot', etf: 'Flussi ETF spot', exchange: 'Flusso netto verso gli exchange',
}
const SIGN_LABEL: Record<string, Record<string, string>> = {
  funding: { '1': 'molto alto', '-1': 'molto basso' }, oi: { '1': 'aumento anomalo', '-1': 'calo anomalo' },
  liq_long: { '1': 'picco' }, liq_short: { '1': 'picco' }, volume: { '1': 'picco' },
  etf: { '1': 'afflussi anomali', '-1': 'deflussi anomali' }, exchange: { '1': 'afflussi anomali', '-1': 'deflussi anomali' },
}
export const anomalyName = (type: string, sign: number) => `${t(TYPE_LABEL[type] ?? type)} · ${t(SIGN_LABEL[type]?.[String(sign)] ?? '')}`
const VERDICT_LABEL: Record<AnVerdict, string> = { strong: 'Significativo', weak: 'Debole', none: 'Nessun effetto', anecdotal: 'Pochi casi' }
export function VerdictBadge({ v }: { v: AnVerdict }) {
  const color = v === 'strong' ? 'blue' : v === 'weak' ? 'purple' : 'slate'
  return <Badge color={color as 'blue'}>{t(VERDICT_LABEL[v])}</Badge>
}

const pf = (v: number | null | undefined, d = 1) => pct(v ?? null, d)
export function verdictSentence(row: AnTypeRow, minN: number): string {
  if (!row.available) return t('Dati non disponibili.')
  if (row.n === 0) return t('Nessun caso nello storico disponibile (serie ancora troppo breve).')
  if (row.n < minN) return t('Solo {n} casi: troppo pochi per un giudizio.', { n: row.n })
  const h7 = row.horizons.find((c) => c.h === 7) ?? row.horizons[row.horizons.length - 1]
  const r = h7.ret
  const parts = [t('A {h} giorni BTC ha fatto in media {m} (IC 95% {lo} … {hi}) contro {b} di un giorno qualsiasi.', {
    h: h7.h, m: pf(r.mean), lo: pf(r.ci[0]), hi: pf(r.ci[1]), b: pf(r.base),
  })]
  parts.push(r.verdict === 'strong' ? t('Differenza significativa anche dopo la correzione per test multipli.')
    : r.verdict === 'weak' ? t('La differenza non regge alla correzione per test multipli.') : t('Nessuna differenza distinguibile dal caso.'))
  // volatility: the strongest horizon
  const vv = [...row.horizons].filter((c) => c.vol.verdict === 'strong' || c.vol.verdict === 'weak').sort((a, b) => (a.vol.p ?? 1) - (b.vol.p ?? 1))[0]
  if (vv) {
    const wider = (vv.vol.mean ?? 0) > (vv.vol.base ?? 0)
    parts.push(t(wider ? 'Il movimento assoluto a {h} g è più ampio del normale ({m} contro {b}; {v}).' : 'Il movimento assoluto a {h} g è più contenuto del normale ({m} contro {b}; {v}).', {
      h: vv.h, m: pct(vv.vol.mean, 1, false), b: pct(vv.vol.base, 1, false),
      v: vv.vol.verdict === 'strong' ? t('significativo dopo la correzione') : t('non regge alla correzione'),
    }))
  }
  return parts.join(' ')
}

export function recentValue(r: AnRecent): string {
  switch (r.type) {
    case 'funding': return minus(`${r.value.toFixed(4)}%/8h`)
    case 'oi': return t('{v} in un giorno', { v: pct(r.x, 1) })
    case 'liq_long': case 'liq_short': return usdCompact(r.value, 1)
    case 'volume': return `${compact(r.value, 1)} BTC`
    case 'etf': return usdCompact(r.value * 1e6, 0)
    case 'exchange': return `${r.value > 0 ? '+' : ''}${compact(r.value, 1)} BTC`
    default: return String(r.value)
  }
}

// ===================================================================== anomalies cards
export function RecentAnomaliesCard({ q, onPick }: { q: UseQueryResult<Anomalies>; onPick?: (r: AnRecent) => void }) {
  return (
    <Card>
      <CardHeader title={t('Anomalie recenti')} icon={<Radar />} accent="amber" updatedAt={q.dataUpdatedAt} interval={600_000}
        subtitle={q.data ? t('Ultimi {d} giorni · |z| ≥ {z} · giorni completi', { d: q.data.params.recent_days, z: q.data.params.thr }) : undefined} />
      <CardBody className="px-1 pb-2 sm:px-2">
        <Q q={q} compact isEmpty={(d) => !d.recent.length} empty={t('Nessuna anomalia negli ultimi 30 giorni con questa soglia.')}>
          {(d) => {
            const rows = new Map(d.types.map((x) => [x.id, x]))
            return (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>{t('Data')}</th><th>{t('Anomalia')}</th><th className="hidden text-right sm:table-cell">{t('Valore')}</th><th className="text-right">z</th>
                    <th className="hidden text-right md:table-cell">{t('Dopo, in media (7 g)')}</th><th className="text-right">{t('Storico')}</th></tr></thead>
                  <tbody>
                    {d.recent.map((r) => {
                      const row = rows.get(r.id)
                      const h7 = row?.horizons.find((c) => c.h === 7)
                      return (
                        <tr key={`${r.id}-${r.time}`} className={onPick ? 'cursor-pointer hover:bg-white/[0.03]' : undefined} onClick={() => onPick?.(r)}>
                          <td className="tnum whitespace-nowrap text-slate-300">{date(r.time, false)}</td>
                          <td className="min-w-[8rem] !whitespace-normal py-1.5 text-white">{anomalyName(r.type, r.sign)}<span className="block text-2xs text-slate-400 sm:hidden">{recentValue(r)}</span></td>
                          <td className="tnum hidden whitespace-nowrap text-right text-slate-200 sm:table-cell">{recentValue(r)}</td>
                          <td className="tnum text-right text-amber-200">{minus(r.z >= 0 ? `+${r.z.toFixed(1)}` : r.z.toFixed(1))}</td>
                          <td className="tnum hidden whitespace-nowrap text-right text-slate-300 md:table-cell">
                            {h7 && h7.n ? <>{pf(h7.ret.mean)} <span className="text-slate-500">{t('vs')} {pf(h7.ret.base)}</span> <span className="text-slate-500">· n {h7.n}</span></> : '—'}
                          </td>
                          <td className="text-right">{row ? <VerdictBadge v={row.verdict} /> : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          }}
        </Q>
      </CardBody>
    </Card>
  )
}

function RetCell({ m, n }: { m: AnTypeRow['horizons'][number]['ret']; n: number }) {
  if (!n) return <span className="text-slate-600">—</span>
  return (
    <span className="tnum inline-flex flex-col items-end leading-tight">
      <span className={clsx(m.verdict === 'strong' ? 'text-white' : 'text-slate-200')}>{pf(m.mean)} <span className="text-slate-500">{t('vs')} {pf(m.base)}</span></span>
      <span className="text-2xs text-slate-500">p {m.p != null ? m.p.toFixed(3) : '—'} · BH {m.p_bh != null ? m.p_bh.toFixed(2) : '—'}</span>
    </span>
  )
}

export function BacktestCard({ q }: { q: UseQueryResult<Anomalies> }) {
  return (
    <Card>
      <CardHeader title={t('Cosa è successo dopo: backtest per tipo')} icon={<Radar />} accent="amber"
        subtitle={q.data ? t('Rendimento medio di BTC dopo l’anomalia contro giorni casuali · {n} test con correzione BH', { n: q.data.params.tests }) : undefined}
        info={t('Ingresso alla chiusura del primo giorno in cui il dato era pubblicato. p = Monte Carlo contro {n} estrazioni di giorni casuali dello stesso periodo; BH = p corretto Benjamini-Hochberg su tutti i test della tabella. IC 95% bootstrap.', { n: q.data?.params.n_mc ?? 4000 })} />
      <CardBody className="px-1 pb-2 sm:px-2">
        <Q q={q} compact isEmpty={(d) => !d.types.length}>
          {(d) => (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>{t('Anomalia')}</th><th className="text-right">n</th>
                  {d.params.horizons.map((h) => <th key={h} className={clsx('text-right', h !== 7 && 'hidden md:table-cell')}>{t('{h} g', { h })}</th>)}
                  <th className="hidden text-right sm:table-cell">{t('Mov. assoluto 7 g')}</th><th className="hidden text-right sm:table-cell">{t('Verdetto')}</th></tr></thead>
                <tbody>
                  {d.types.map((row) => {
                    const v7 = row.horizons.find((c) => c.h === 7)
                    return [
                      <tr key={row.id} className="border-b-0 align-top [&>td]:border-b-0">
                        <td className="min-w-[8rem] !whitespace-normal pb-0 pt-2.5 font-medium text-white">{anomalyName(row.type, row.sign)}</td>
                        <td className="tnum pb-0 pt-2.5 text-right text-slate-300">{row.n}</td>
                        {d.params.horizons.map((h) => {
                          const c = row.horizons.find((x) => x.h === h)
                          return <td key={h} className={clsx('whitespace-nowrap pb-0 pt-2.5 text-right', h !== 7 && 'hidden md:table-cell')}>{c ? <RetCell m={c.ret} n={c.n} /> : '—'}</td>
                        })}
                        <td className="hidden whitespace-nowrap pb-0 pt-2.5 text-right sm:table-cell">{v7 && v7.n ? (
                          <span className="tnum inline-flex flex-col items-end leading-tight">
                            <span className="text-slate-200">{pct(v7.vol.mean, 1, false)} <span className="text-slate-500">{t('vs')} {pct(v7.vol.base, 1, false)}</span></span>
                            <span className="text-2xs text-slate-500">BH {v7.vol.p_bh != null ? v7.vol.p_bh.toFixed(2) : '—'}</span>
                          </span>) : <span className="text-slate-600">—</span>}</td>
                        <td className="hidden pb-0 pt-2.5 text-right sm:table-cell"><VerdictBadge v={row.verdict} /></td>
                      </tr>,
                      <tr key={row.id + '-s'}>
                        <td colSpan={d.params.horizons.length + 4} className="!whitespace-normal !border-t-0 pb-2.5 pt-1 text-xs leading-snug text-slate-400"><span className="mr-1.5 inline-block align-middle sm:hidden"><VerdictBadge v={row.verdict} /></span>{verdictSentence(row, d.params.min_n)}</td>
                      </tr>,
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Q>
      </CardBody>
    </Card>
  )
}

// ===================================================================== URL state
export function encodePanes(panes: ScPaneState[]): string {
  return panes.map((p) => [p.id, p.ov ? 'o' : String(p.h), p.an ? 'a' : ''].filter(Boolean).join('~')).join(',')
}
export function decodePanes(s: string | null, known: Set<string>): ScPaneState[] | null {
  if (!s) return null
  const out: ScPaneState[] = []
  for (const part of s.split(',')) {
    const [id, h, a] = part.split('~')
    if (!known.has(id) || out.some((x) => x.id === id)) continue
    const ov = h === 'o'
    out.push({ id, ov, h: ov ? 0 : Math.max(60, Math.min(600, Number(h) || 110)), an: a === 'a' })
  }
  return out
}
