import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Anchor, BarChartHorizontal, BellPlus, CandlestickChart, Combine, Maximize2, RefreshCw, ScanLine, ShieldCheck, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { live } from '../api/live'
import {
  useVwap, useVwapOverview, useVwapPanel,
  type VwapCalc, type VwapOverviewTf, type VwapPanel, type VwapPeriod, type VwapProfileMode, type VwapProfileSession, type VwapSource, type VwapSummary,
} from '../api/vwap'
import VwapChart, { fmt2, type VwapHover } from '../components/charts/VwapChart'
import VwapOverviewChart, { type OverviewHover, type OverviewOpts } from '../components/charts/VwapOverviewChart'
import { usdP } from '../components/charts/vwapAxis'
import { hexA } from '../components/charts/theme'
import { Card, CardBody, CardHeader, ErrorState, IconBadge, KpiCell, KpiStrip, MethodNote, ProgressBar, Segmented, Skeleton, Toggle, Updated, clsx, PageActions, SettingsPanel, SettingRow } from '../components/ui'
import { date, pct } from '../lib/format'
import { useTab } from '../lib/useTab'
import { t } from '../i18n'
import { RuleEditorHost, openRuleEditor } from '../widgets/alertRules'
import type { LevelId } from '../api/alertRules'
import { T } from '../theme/tokens'

// ------------------------------------------------------------------ constants
const PERIODS: VwapPeriod[] = ['w', 'm', 'q', 'y']
const TAG: Record<VwapPeriod, string> = { w: 'W', m: 'M', q: 'Q', y: 'Y' }
const COLOR: Record<VwapPeriod, string> = { w: T.steel, m: T.accent, q: T.mauve, y: T.sand }
const TITLE: Record<VwapPeriod, string> = { w: 'VWAP settimanale', m: 'VWAP mensile', q: 'VWAP trimestrale', y: 'VWAP annuale' }
const TF_LABEL: Record<number, string> = { 300: '5 min', 1800: '30 min', 3600: '1h', 14400: '4h' }
const SRC: Record<VwapSource, { label: string; venue: string; quote: string }> = {
  kraken: { label: 'Kraken perp', venue: 'Kraken Futures PF_XBTUSD', quote: 'USD' },
  binance: { label: 'Binance perp', venue: 'Binance USDⓈ-M BTCUSDT', quote: 'USDT' },
}
const LVL: Record<string, string> = { vwap: 'VWAP', up1: '+1σ', dn1: '−1σ' }
/** 'pm_up1' → 'pM +1σ' */
const memberName = (m: string) => {
  const [per, lvl] = m.split('_')
  const prev = per.startsWith('p')
  const p = (prev ? per.slice(1) : per) as VwapPeriod
  return `${prev ? 'p' : ''}${TAG[p]} ${LVL[lvl] ?? lvl}`
}
const memberColor = (m: string) => (m.startsWith('p') ? T.fg2 : COLOR[m.split('_')[0] as VwapPeriod] ?? T.fg2)
const bp = (v: number | null | undefined, d = 1) => {
  if (v == null) return '—'
  const r = Number(v.toFixed(d))
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(d)} bp`
}
const sig = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}σ`)

/** Live price of the selected market: Kraken trades (vwap_tick) or Binance perp 1m kline. */
function useMarketPrice(source: VwapSource): number | null {
  const [p, setP] = useState<number | null>(null)
  useEffect(() => {
    setP(null)
    if (source === 'kraken') return live.onVwapTick((m) => setP(m.price))
    return live.onPerpKline((m) => setP(m.candle.close))
  }, [source])
  return p
}

function usePersist<V extends string>(key: string, def: V, allowed: readonly V[]): [V, (v: V) => void] {
  const [v, setV] = useState<V>(() => {
    try { const s = localStorage.getItem(key) as V | null; return s && allowed.includes(s) ? s : def } catch { return def }
  })
  const set = useCallback((x: V) => { setV(x); try { localStorage.setItem(key, x) } catch { /* ignore */ } }, [key])
  return [v, set]
}

// ------------------------------------------------------------------ toolbar
function Toolbar({ tab, setTab, source, setSource, calc, setCalc, bands, setBands, two, setTwo, prev, setPrev, onFit, onRefresh, refreshing, updatedAt }: {
  tab: Tab; setTab: (t: Tab) => void
  source: VwapSource; setSource: (s: VwapSource) => void; calc: VwapCalc; setCalc: (c: VwapCalc) => void
  bands: boolean; setBands: (b: boolean) => void; two: boolean; setTwo: (b: boolean) => void; prev: boolean; setPrev: (b: boolean) => void
  onFit: () => void; onRefresh: () => void; refreshing: boolean; updatedAt: number
}) {
  return (
    <>
      <PageActions>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'chart', label: t('Grafico unico') }, { value: 'panels', label: t('Pannelli') }]} />
        <Segmented value={source} onChange={setSource} options={[{ value: 'kraken', label: SRC.kraken.label }, { value: 'binance', label: SRC.binance.label }]} />
        <SettingsPanel>
          <SettingRow label={t('Calcolo')}>
            <Segmented value={calc} onChange={setCalc} options={[{ value: 'fine', label: t('Candele 1 min') }, { value: 'chart', label: t('Timeframe del grafico') }]} />
          </SettingRow>
          {tab === 'panels' && (
            <SettingRow label={t('Pannelli')}>
              <Toggle on={bands} onClick={() => setBands(!bands)}>{t('Bande ±1σ')}</Toggle>
              <Toggle on={two} onClick={() => setTwo(!two)}>{t('Bande ±2σ')}</Toggle>
              <Toggle on={prev} onClick={() => setPrev(!prev)}>{t('Periodo precedente')}</Toggle>
            </SettingRow>
          )}
        </SettingsPanel>
        <button className="btn-ghost" onClick={onFit}><ScanLine size={14} />{t(tab === 'panels' ? 'Adatta grafici' : 'Adatta grafico')}</button>
        <button className="btn-ghost" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} className={clsx(refreshing && 'animate-spin')} />{t('Aggiorna')}</button>
      </PageActions>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-fg-3">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="tnum font-semibold tracking-wide text-fg">W / M / Q / Y</span>
          <span>{t('Ancore di calendario · UTC')}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3">
          <span className="label" style={{ color: T.fg3 }}>{SRC[source].venue} · {t('Candele chiuse')}</span>
          <Updated at={updatedAt} />
        </span>
      </div>
    </>
  )
}

function Kpis({ s, price }: { s: VwapSummary; price: number | null }) {
  const P = s.periods_data!
  const px = price ?? s.price ?? null
  const near = (s.confluence ?? [])[0]
  return (
    <KpiStrip>
      <KpiCell icon={<Anchor />} accent="teal" label={t('Prezzo')} value={usdP(px)}
        foot={`${SRC[s.source].label} · ${price != null ? t('live') : t('ultima candela chiusa')}`} />
      {PERIODS.map((p) => {
        const d = P[p]
        const dist = px != null && d.vwap ? (px / d.vwap - 1) * 100 : d.dist_pct
        const z = px != null && d.vwap && d.sd ? (px - d.vwap) / d.sd : d.z
        return (
          <KpiCell key={p} label={t(TITLE[p])}
            icon={<span className="text-[11px] font-bold">{TAG[p]}</span>} accent={p === 'w' ? 'teal' : p === 'm' ? 'blue' : p === 'q' ? 'violet' : 'amber'}
            value={<span className="tnum">{pct(dist, 2)}</span>}
            foot={`${sig(z)} · VWAP ${usdP(d.vwap)}`} />
        )
      })}
      <KpiCell icon={<Combine />} accent="slate" label={t('Confluenza più vicina')}
        value={near ? usdP(near.mid) : t('Nessuna')}
        foot={near ? `${pct(px ? (near.mid / px - 1) * 100 : near.distance_pct, 2)} · ${near.members.map(memberName).join(' · ')}` : t('Nessun gruppo entro lo {p}%', { p: '0.5' })} />
    </KpiStrip>
  )
}

// ------------------------------------------------------------------ panel
function LetterBadge({ p }: { p: VwapPeriod }) {
  const c = COLOR[p]
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-semibold"
      style={{ color: c, background: `linear-gradient(180deg, ${hexA(c, 0.2)}, ${hexA(c, 0.08)})`, boxShadow: `inset 0 0 0 1px ${hexA(c, 0.25)}` }}>
      {TAG[p]}
    </span>
  )
}

function ValueCell({ label, value, color, dashed, title, className }: { label: ReactNode; value: ReactNode; color?: string; dashed?: boolean; title?: string; className?: string }) {
  return (
    <div className={clsx('min-w-0', className)} title={title}>
      <div className="flex items-center gap-1.5 whitespace-nowrap text-2xs font-medium tracking-[0.04em] text-fg-3">
        {dashed != null && <span className={clsx('inline-block w-3', dashed ? 'border-t-2 border-dashed' : 'h-0.5 rounded-full')} style={dashed ? { borderColor: T.fg2 } : { background: color }} />}
        {label}
      </div>
      <div className="tnum mt-0.5 truncate text-[15px] font-semibold" style={{ color: color ?? T.fg }}>{value}</div>
    </div>
  )
}

function PanelBody({ p, panel, opts, fit, expanded, onExpand, updatedAt, extra }: {
  p: VwapPeriod; panel: VwapPanel; opts: { bands: boolean; two: boolean; prev: boolean }; fit: number; expanded?: boolean
  onExpand?: () => void; updatedAt?: number; extra?: ReactNode
}) {
  const [hover, setHover] = useState<VwapHover | null>(null)
  const [narrow, setNarrow] = useState(false)
  const L = panel.levels
  const tag = TAG[p]
  const c = COLOR[p]
  const v = hover ?? { vwap: L.vwap, pvwap: L.prev.vwap, up1: L.up1, dn1: L.dn1, pup1: L.prev.up1, pdn1: L.prev.dn1 }
  const end = panel.last_closed_end
  const quote = SRC[panel.source].quote
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 520))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col">
      <header className="flex items-start justify-between gap-3 px-4 pt-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <LetterBadge p={p} />
          <div className="min-w-0">
            <h2 className="truncate text-title font-semibold tracking-[-0.01em] text-white">{t(TITLE[p])}</h2>
            <p className="tnum truncate text-xs text-fg-3">BTC · {date(panel.anchor)} → {date(end - 1)}{updatedAt ? <Updated at={updatedAt} className="ml-2 align-middle" /> : null}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {L.vwap != null && (
            <button type="button" title={t('Crea avviso')} aria-label={t('Crea avviso su {l}', { l: `VWAP ${tag}` })}
              onClick={() => openRuleEditor({ type: 'level_distance', params: { level: `vwap_${p}` as LevelId, pct: 0.2 }, name: t('BTC vicino al {l}', { l: t(TITLE[p]) }) })}
              className="grid h-8 w-8 place-items-center rounded-lg text-fg-4 transition-colors hover:bg-white/[0.06] hover:text-warn"><BellPlus size={15} /></button>
          )}
          {onExpand && (
            <button type="button" onClick={onExpand} title={t('Espandi')} aria-label={t('Espandi')}
              className="grid h-8 w-8 place-items-center rounded-lg text-fg-4 transition-colors hover:bg-white/[0.06] hover:text-white"><Maximize2 size={15} /></button>
          )}
          {extra}
        </div>
      </header>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 pb-2 pt-2.5 sm:flex sm:flex-wrap sm:gap-x-7 sm:px-5">
        <ValueCell label={`VWAP ${tag}`} value={fmt2(v.vwap)} color={c} dashed={false} />
        {opts.prev && <ValueCell label={`VWAP p${tag}`} value={fmt2(v.pvwap)} dashed />}
        {opts.bands && <ValueCell className="col-span-2 sm:col-span-1" label="+1σ / −1σ" value={<>{fmt2(v.up1)}<span className="text-fg-4"> / </span>{fmt2(v.dn1)}</>} />}
        {hover && (
          <div className="col-span-2 min-w-0 sm:col-span-1 sm:ml-auto sm:text-right">
            <div className="label">{(() => { const d = new Date(hover.time * 1000); return `${date(hover.time)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` })()}</div>
            <div className="tnum mt-0.5 truncate text-xs text-fg-2">
              O {usdP(hover.open)} · H {usdP(hover.high)} · L {usdP(hover.low)} · C <span className={hover.close >= hover.open ? 'text-up' : 'text-down'}>{usdP(hover.close)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <VwapChart panel={panel} color={c} tag={tag} showBands={opts.bands} show2={opts.two} showPrev={opts.prev} fitSignal={fit}
          source={panel.source} wheel={!!expanded} compact={narrow} onHover={setHover} />
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-line-subtle px-4 py-2 text-2xs text-fg-4 sm:px-5">
        <span className="tnum min-w-0 truncate">p{tag}: {date(panel.prev_anchor)} → {date(panel.prev_end)} · {t('livelli estesi')}</span>
        <span className="tnum shrink-0">{TF_LABEL[panel.tf] ?? panel.tf} · {quote}</span>
      </footer>
    </div>
  )
}

function Panel({ p, source, calc, opts, fit, onExpand }: {
  p: VwapPeriod; source: VwapSource; calc: VwapCalc; opts: { bands: boolean; two: boolean; prev: boolean }; fit: number; onExpand: () => void
}) {
  const q = useVwapPanel(p, source, calc)
  const d = q.data
  return (
    <Card className="h-[460px] overflow-hidden sm:h-[520px] 2xl:h-[600px]">
      {q.isPending ? (
        <div className="flex h-full flex-col gap-3 p-5"><Skeleton className="h-10 w-56" /><Skeleton className="w-full flex-1" /></div>
      ) : q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d && d.candles ? (
        <PanelBody p={p} panel={d} opts={opts} fit={fit} onExpand={onExpand} updatedAt={q.dataUpdatedAt} />
      ) : (
        <div className="grid h-full place-items-center text-sm text-fg-3">{t('Dati in fase di sincronizzazione, riprova tra poco.')}</div>
      )}
    </Card>
  )
}

function Expanded({ p, source, calc, opts, onClose }: { p: VwapPeriod; source: VwapSource; calc: VwapCalc; opts: { bands: boolean; two: boolean; prev: boolean }; onClose: () => void }) {
  const q = useVwapPanel(p, source, calc)
  const [fit, setFit] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  // focus moves into the dialog on open and back to the "Espandi" button on close (keyboard / screen readers)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    box.current?.focus()
    return () => prev?.focus?.()
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    const prevOv = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prevOv }
  }, [onClose])
  return createPortal(
    <div ref={box} tabIndex={-1} className="fixed inset-0 z-[80] outline-none" role="dialog" aria-modal="true" aria-label={t(TITLE[p])}>
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="card pop-in absolute inset-2 flex flex-col overflow-hidden sm:inset-5">
        {q.data?.candles ? (
          <PanelBody p={p} panel={q.data} opts={opts} fit={fit} expanded extra={<>
            <button className="btn-ghost ml-1" onClick={() => setFit((x) => x + 1)}><ScanLine size={14} /><span className="hidden sm:inline">{t('Adatta grafico')}</span></button>
            <button onClick={onClose} aria-label={t('Chiudi')} className="grid h-8 w-8 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-white/[0.06] hover:text-white"><X size={16} /></button>
          </>} />
        ) : <Skeleton className="m-5 flex-1" />}
      </div>
    </div>,
    document.body,
  )
}

// ------------------------------------------------------------------ single chart ("Grafico unico")
const OV_TFS: VwapOverviewTf[] = ['30m', '1h', '2h', '4h']
const OV_TF_LABEL: Record<VwapOverviewTf, string> = { '30m': '30 min', '1h': '1h', '2h': '2h', '4h': '4h' }

function OverviewCard({ source, calc, fit, tf, setTf, prof, setProf }: {
  source: VwapSource; calc: VwapCalc; fit: number; tf: VwapOverviewTf; setTf: (v: VwapOverviewTf) => void; prof: VwapProfileMode; setProf: (v: VwapProfileMode) => void
}) {
  const [periods, setPeriods] = useState<Record<VwapPeriod, boolean>>({ w: true, m: true, q: true, y: true })
  const [cur, setCur] = useState(true)
  const [curBands, setCurBands] = useState(true)
  const [prevLv, setPrevLv] = useState(true)
  const [prevBands, setPrevBands] = useState(true)
  const [hover, setHover] = useState<OverviewHover | null>(null)
  const [narrow, setNarrow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const q = useVwapOverview(source, calc, tf, prof)
  const d = q.data
  const opts = useMemo<OverviewOpts>(() => ({ periods, cur, curBands, prev: prevLv, prevBands }), [periods, cur, curBands, prevLv, prevBands])
  const sess = d?.profile.sessions ?? []
  const binTxt = sess.length ? usdP(sess[sess.length - 1].bin) : '—'
  const last = d?.levels
  return (
    <Card className="h-[700px] overflow-hidden sm:h-[max(680px,calc(100vh-250px))]">
      <div ref={ref} className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge icon={<CandlestickChart />} accent="teal" />
            <div className="min-w-0">
              <h2 className="truncate text-title font-semibold tracking-[-0.01em] text-white">{t('Grafico unico')}</h2>
              <p className="tnum truncate text-xs text-fg-3">
                BTC · {OV_TF_LABEL[tf]} · {d ? `${date(d.from)} → ${date(d.last_closed_end - 1)}` : '—'} · UTC
                {q.dataUpdatedAt ? <Updated at={q.dataUpdatedAt} className="ml-2 align-middle" /> : null}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">{t('Profilo')}</span>
            <Segmented value={prof} onChange={setProf} options={[{ value: 'week', label: t('Settimana') }, { value: 'month', label: t('Mese') }, { value: 'off', label: 'Off' }]} />
            <Segmented value={tf} onChange={setTf} options={OV_TFS.map((x) => ({ value: x, label: OV_TF_LABEL[x] }))} />
          </div>
        </header>
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 pt-2.5 sm:px-5 sm:pb-0">
          {PERIODS.map((p) => (
            <Toggle key={p} on={periods[p]} onClick={() => setPeriods((x) => ({ ...x, [p]: !x[p] }))}>
              <span className="font-semibold" style={{ color: periods[p] ? COLOR[p] : undefined }}>{TAG[p]}</span>
            </Toggle>
          ))}
          <span className="mx-1 hidden h-4 w-px bg-white/10 sm:inline-block" />
          <Toggle on={cur} onClick={() => setCur(!cur)}>{t('VWAP correnti')}</Toggle>
          <Toggle on={curBands} onClick={() => setCurBands(!curBands)}>{t('VAH/VAL correnti')}</Toggle>
          <Toggle on={prevLv} onClick={() => setPrevLv(!prevLv)}>{t('VWAP precedenti')}</Toggle>
          <Toggle on={prevBands} onClick={() => setPrevBands(!prevBands)}>{t('VAH/VAL precedenti')}</Toggle>
        </div>
        <div className="hidden min-h-[38px] flex-wrap items-center gap-x-5 gap-y-1 px-4 pb-1.5 pt-2 text-xs sm:flex sm:px-5">
          {hover ? (
            <>
              <span className="label tnum">{(() => { const x = new Date(hover.time * 1000); return `${date(hover.time)} ${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')} UTC` })()}</span>
              <span className="tnum text-fg-2">O {usdP(hover.open)} · H {usdP(hover.high)} · L {usdP(hover.low)} · C <span className={hover.close >= hover.open ? 'text-up' : 'text-down'}>{usdP(hover.close)}</span></span>
              {PERIODS.filter((p) => periods[p] && hover.vwap[p] != null).map((p) => (
                <span key={p} className="tnum" style={{ color: COLOR[p] }}>{TAG[p]} {usdP(hover.vwap[p])}</span>
              ))}
            </>
          ) : last ? (
            PERIODS.filter((p) => periods[p]).map((p) => (
              <span key={p} className="tnum text-fg-3">
                <span className="mr-1 inline-block h-0.5 w-3 rounded-full align-middle" style={{ background: COLOR[p] }} />
                <span style={{ color: COLOR[p] }}>{TAG[p]}</span> {usdP(last[p]?.vwap)}
                <span className="text-fg-off"> · </span>p{TAG[p]} {usdP(last[p]?.prev.vwap)}
              </span>
            ))
          ) : null}
        </div>
        <div className="relative min-h-0 flex-1">
          {q.isPending ? <Skeleton className="absolute inset-3" /> : q.isError && !d ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
            : d?.candles ? <VwapOverviewChart data={d} opts={opts} showProfile={prof !== 'off'} fitSignal={fit} source={source} compact={narrow} onHover={setHover} />
            : <div className="grid h-full place-items-center text-sm text-fg-3">{t('Dati in fase di sincronizzazione, riprova tra poco.')}</div>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line-subtle px-4 py-2 text-2xs text-fg-4 sm:px-5">
          <span className="min-w-0" title={t('VAH = VWAP +1σ, VAL = VWAP −1σ')}>
            <span className="text-fg-2">{t('Livelli VWAP (a destra)')}</span>: VAH = VWAP +1σ · VAL = VWAP −1σ · p = {t('periodo precedente')}
          </span>
          {prof !== 'off' && (
            <span className="min-w-0">
              <span className="text-fg-2">{t('Profilo volume (grigio)')}</span>: POC · VAH/VAL = {t('value area {p}%', { p: 70 })} · bin {binTxt}
            </span>
          )}
        </footer>
      </div>
    </Card>
  )
}

function ProfileCard({ source, calc, tf, prof }: { source: VwapSource; calc: VwapCalc; tf: VwapOverviewTf; prof: VwapProfileMode }) {
  const mode: VwapProfileMode = prof === 'off' ? 'week' : prof
  const q = useVwapOverview(source, calc, tf, mode)
  const rows = [...(q.data?.profile.sessions ?? [])].reverse()
  const rob = (r: VwapProfileSession) => Math.max(r.robust_bp.poc, r.robust_bp.vah, r.robust_bp.val)
  return (
    <Card className="h-full">
      <CardHeader title={t('Volume profile per sessione')} icon={<BarChartHorizontal />} accent="teal"
        subtitle={t('POC e value area {p}% · sessioni {m} UTC', { p: 70, m: mode === 'week' ? t('settimanali') : t('mensili') })}
        info={t('Il volume di ogni candela da 1 minuto è distribuito in modo uniforme tra minimo e massimo su bin di prezzo (settimana ≈ 0,06% del prezzo, $50 a 83K; mese ≈ 0,12%, $100). POC = bin con più volume. Value area: dal POC si aggiunge ogni volta il bin adiacente con più volume finché si raggiunge il 70% del volume. Robustezza = scarto massimo di POC, VAH e VAL ricalcolando con bin dimezzati e raddoppiati.')} />
      <CardBody className="px-1 pb-2 pt-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('Sessione')}</th><th className="text-right">VAH</th><th className="text-right">POC</th><th className="text-right">VAL</th>
                <th className="text-right">{t('Volume')} (BTC)</th><th className="text-right">{t('Robustezza')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.start}>
                  <td className="tnum whitespace-nowrap text-white">{date(r.start, false)} → {date(Math.min(r.end, q.data?.last_closed_end ?? r.end) - 1, false)}{!r.complete && <div className="text-2xs font-normal text-fg-4">{t('in corso')}</div>}</td>
                  <td className="tnum text-right text-fg-2">{usdP(r.vah)}</td>
                  <td className="tnum text-right font-medium text-white">{usdP(r.poc)}</td>
                  <td className="tnum text-right text-fg-2">{usdP(r.val)}</td>
                  <td className="tnum text-right text-fg-3">{Math.round(r.volume).toLocaleString('en-US')}</td>
                  <td className={clsx('tnum text-right', rob(r) > 25 ? 'text-warn' : 'text-fg-3')} title={`POC ${r.robust_bp.poc} · VAH ${r.robust_bp.vah} · VAL ${r.robust_bp.val} bp`}>±{rob(r).toFixed(0)} bp</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 pt-2 text-xs leading-relaxed text-fg-3">{t('Robustezza oltre 25 bp: profilo con due zone di volume quasi uguali, il POC può saltare tra le due. Il profilo è un concetto diverso dalle bande VWAP: qui VAH/VAL delimitano il 70% del volume scambiato.')}</p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ confluence + verification
function ConfluenceCard({ s, price }: { s: VwapSummary; price: number | null }) {
  const px = price ?? s.price ?? null
  const items = s.confluence ?? []
  return (
    <Card className="h-full">
      <CardHeader title={t('Confluenze VWAP')} icon={<Combine />} accent="teal"
        subtitle={t('Livelli di periodi diversi entro lo {p}%', { p: String(s.confluence_pct ?? 0.5) })} />
      <CardBody className="flex flex-col px-1 pb-2 pt-0">
        {items.length ? (
          // rows stretch to the height of the session table next to it
          <div className="flex flex-1 flex-col overflow-x-auto">
            <table className="tbl flex-1">
              <thead><tr><th>{t('Zona')}</th><th>{t('Livelli')}</th><th className="text-right">{t('Ampiezza')}</th><th className="text-right">{t('Distanza')}</th></tr></thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.members.join()}>
                    <td className="tnum whitespace-nowrap text-white">{usdP(c.low)} – {usdP(c.high)}</td>
                    <td className="min-w-[180px]">
                      <div className="flex flex-wrap gap-1">
                        {c.members.map((m) => (
                          <span key={m} className="tnum inline-flex h-5 items-center rounded-md px-1.5 text-2xs font-medium"
                            style={{ color: memberColor(m), background: hexA(memberColor(m), 0.1), boxShadow: `inset 0 0 0 1px ${hexA(memberColor(m), 0.22)}` }}>{memberName(m)}</span>
                        ))}
                      </div>
                    </td>
                    <td className="tnum text-right text-fg-2">{pct(c.width_pct, 2, false)}</td>
                    <td className="tnum text-right text-fg-2">{pct(px ? (c.mid / px - 1) * 100 : c.distance_pct, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="px-4 py-6 text-center text-sm text-fg-3">{t('Nessun gruppo di livelli entro lo {p}%.', { p: '0.5' })}</p>}
      </CardBody>
    </Card>
  )
}

function VerifyCard({ s }: { s: VwapSummary }) {
  const cc = s.crosscheck
  const rc = s.resolution_check
  const other = cc ? SRC[cc.other] : SRC[s.source === 'kraken' ? 'binance' : 'kraken']
  const maxAbs = (a: (number | null)[]) => {
    const v = a.filter((x): x is number => x != null).map(Math.abs)
    return v.length ? Math.max(...v) : null
  }
  return (
    <Card className="h-full">
      <CardHeader title={t('Verifiche incrociate')} icon={<ShieldCheck />} accent="teal"
        subtitle={cc ? t('Scarto rispetto a {o} e alla risoluzione alternativa', { o: other.label }) : t('Seconda fonte in sincronizzazione ({p}%)', { p: Math.round((s.sources[s.source === 'kraken' ? 'binance' : 'kraken']?.progress ?? 0) * 100) })} />
      <CardBody className="px-1 pb-2 pt-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('Periodo')}</th>
                <th className="text-right">Δ VWAP</th>
                <th className="text-right">Δ pVWAP</th>
                <th className="text-right">{t('Δ bande max')}</th>
                <th className="text-right">{s.calc === 'fine' ? t('Δ vs TF grafico') : t('Δ vs 1 min')}</th>
              </tr>
            </thead>
            <tbody>
              {PERIODS.map((p) => {
                const d = cc?.periods[p]?.diff_bp
                return (
                  <tr key={p}>
                    <td className="whitespace-nowrap text-white"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: COLOR[p] }} />{t(TITLE[p])}</td>
                    <td className="tnum text-right text-fg-2">{d ? bp(d[0]) : '—'}</td>
                    <td className="tnum text-right text-fg-2">{d ? bp(d[3]) : '—'}</td>
                    <td className="tnum text-right text-fg-2">{d ? bp(maxAbs([d[1], d[2], d[4], d[5]]), 1).replace('+', '') : '—'}</td>
                    <td className="tnum text-right text-fg-2">{rc ? bp(maxAbs(rc[p].diff_bp), 2).replace('+', '') : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="px-4 pt-2 text-xs leading-relaxed text-fg-3">
          {cc
            ? t('Δ in punti base di {o} rispetto a {s}. Differenza mediana dei prezzi nelle ultime 24 ore: {b}. Le differenze maggiori sui VWAP lunghi dipendono da come si distribuiscono i volumi nel tempo sulle due piattaforme, non da errori di calcolo.', { o: other.label, s: SRC[s.source].label, b: bp(cc.price_basis_bp_24h) })
            : t('Il confronto con la seconda fonte comparirà al termine del download dello storico.')}
        </p>
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ page
type Tab = 'chart' | 'panels'
const TABS: Tab[] = ['chart', 'panels']

export default function VwapPage() {
  const [tab, setTab] = useTab<Tab>(TABS, 'chart', 'view')
  const [tf, setTf] = usePersist<VwapOverviewTf>('vwap.ov.tf', '2h', OV_TFS)
  const [prof, setProf] = usePersist<VwapProfileMode>('vwap.ov.profile', 'week', ['week', 'month', 'off'])
  const [source, setSource] = usePersist<VwapSource>('vwap.source', 'kraken', ['kraken', 'binance'])
  const [calc, setCalc] = usePersist<VwapCalc>('vwap.calc', 'fine', ['fine', 'chart'])
  const [bands, setBands] = useState(true)
  const [two, setTwo] = useState(false)
  const [prev, setPrev] = useState(true)
  const [fit, setFit] = useState(0)
  const [expanded, setExpanded] = useState<VwapPeriod | null>(null)
  const qc = useQueryClient()
  const q = useVwap(source, calc)
  const s = q.data
  const price = useMarketPrice(source)
  const opts = useMemo(() => ({ bands, two, prev }), [bands, two, prev])
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try { await qc.refetchQueries({ queryKey: ['vwap'], type: 'active' }) } finally { setRefreshing(false) }
  }
  const ready = !!s?.status.ready && !!s.periods_data

  return (
    <div className="flex flex-col gap-3">
      <Toolbar tab={tab} setTab={setTab} source={source} setSource={setSource} calc={calc} setCalc={setCalc} bands={bands} setBands={setBands} two={two} setTwo={setTwo}
        prev={prev} setPrev={setPrev} onFit={() => setFit((x) => x + 1)} onRefresh={refresh} refreshing={refreshing} updatedAt={q.dataUpdatedAt} />
      {q.isPending ? (
        <div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[520px]" /></div>
      ) : q.isError && !s ? (
        <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>
      ) : !ready ? (
        <Card>
          <CardHeader title={t('Sincronizzazione dello storico')} icon={<Anchor />} accent="teal"
            subtitle={t('Candele 1 minuto {v} dal 1° gennaio dell’anno precedente', { v: SRC[source].venue })} />
          <CardBody>
            <div className="flex items-center gap-3">
              <ProgressBar value={(s?.status.progress ?? 0) * 100} color={T.accent} className="flex-1" />
              <span className="tnum text-sm text-white">{Math.round((s?.status.progress ?? 0) * 100)}%</span>
            </div>
            <p className="mt-2 text-xs text-fg-3">{t('Il download avviene una sola volta; poi si aggiorna solo l’ultimo minuto. La pagina si aggiorna da sola.')}</p>
          </CardBody>
        </Card>
      ) : (
        <>
          <Kpis s={s!} price={price} />
          {tab === 'chart' ? (
            <>
              <OverviewCard source={source} calc={calc} fit={fit} tf={tf} setTf={setTf} prof={prof} setProf={setProf} />
              <div className="grid gap-3 xl:grid-cols-2">
                <ProfileCard source={source} calc={calc} tf={tf} prof={prof} />
                <ConfluenceCard s={s!} price={price} />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-3 xl:grid-cols-2">
                {PERIODS.map((p) => <Panel key={p} p={p} source={source} calc={calc} opts={opts} fit={fit} onExpand={() => setExpanded(p)} />)}
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                <ConfluenceCard s={s!} price={price} />
                <VerifyCard s={s!} />
              </div>
            </>
          )}
        </>
      )}
      <MethodNote>
        <p>{t('Ancore UTC: settimana da lunedì 00:00, mese dal giorno 1, trimestre da gennaio/aprile/luglio/ottobre, anno dal 1° gennaio. Si usano solo candele chiuse; la candela in formazione e il prezzo si aggiornano in tempo reale, i VWAP si ricalcolano a ogni minuto chiuso.')}</p>
        <p>{t('Formula: prezzo tipico tp = (massimo + minimo + chiusura) / 3; VWAP = Σ(tp·volume) / Σvolume dall’ancora; σ = deviazione standard pesata per volume = √(Σ(volume·tp²)/Σvolume − VWAP²); bande = VWAP ± 1σ e ± 2σ. I livelli p (pW, pM, pQ, pY) sono i valori finali del periodo completo precedente, estesi nel periodo corrente.')}</p>
        <p>{t('Verifica della formula: con candele Kraken PF_XBTUSD del timeframe di ogni grafico (5 min, 30 min, 1h, 4h) fino alle 15:40 UTC del 13 ott 2026 si riproducono al centesimo tutti i 24 valori di riferimento (VWAP, ±1σ e livelli precedenti di W, M, Q e Y). Le varianti con prezzo di chiusura, (H+L)/2 o σ non pesata si scostano di più.')}</p>
        <p>{t('Risoluzione: “Candele 1 min” è la stima più fine disponibile; “Timeframe del grafico” replica le piattaforme che calcolano sulle candele del grafico. Lo scarto tra le due è misurato a ogni ricalcolo (colonna Δ della tabella di verifica): tipicamente sotto 1,5 bp per W, 2,5 bp per M, 2 bp per Q e 4,5 bp per Y, quasi tutto sulle bande σ.')}</p>
        <p>{t('Fonti: Kraken Futures PF_XBTUSD (quotato in USD, la stessa fonte dei valori di riferimento) e Binance USDⓈ-M BTCUSDT (quotato in USDT). Le due fonti hanno prezzi quasi identici ma volumi distribuiti diversamente nel tempo: i VWAP di periodi lunghi possono differire di decine di punti base, ed entrambi sono corretti per il proprio mercato.')}</p>
        <p>{t('Grafico unico: VAH = VWAP +1σ e VAL = VWAP −1σ del periodo (W, M, Q, Y), con p per il periodo precedente; i livelli sono estesi fino al bordo destro. Il profilo del volume in grigio è un concetto diverso: per ogni sessione (settimana o mese UTC) POC è il prezzo con più volume e VAH/VAL delimitano la value area del 70%.')}</p>
        <p>{t('Profilo del volume: il volume di ogni candela da 1 minuto è distribuito in modo uniforme tra minimo e massimo su bin di prezzo (settimana ≈ 0,06% del prezzo, $50 a 83K; mese ≈ 0,12%, $100). La value area parte dal POC e aggiunge ogni volta il bin adiacente con più volume fino al 70%. Algoritmo verificato su casi noti (distribuzione normale: ±1,04σ come atteso; conservazione del volume esatta); la robustezza di ogni sessione è nella tabella.')}</p>
        <p>{t('Le distanze dal VWAP e le confluenze sono descrittive, non sono consigli di trading.')}</p>
      </MethodNote>
      {expanded && <Expanded p={expanded} source={source} calc={calc} opts={opts} onClose={() => setExpanded(null)} />}
      <RuleEditorHost />
    </div>
  )
}
