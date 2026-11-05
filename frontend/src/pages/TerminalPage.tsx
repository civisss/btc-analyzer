import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  ArrowDown, ArrowUp, Check, GripVertical, LayoutGrid, Layers, Maximize2, Minimize2, RotateCcw, Save, ScanLine, Trash2, X,
} from 'lucide-react'
import {
  fetchSnapshot, useObHeatmap, useTermEst, useTermLayoutMutations, useTermLayouts, useTermSeries, useTermStatus,
  type PaneId, type TermLayoutState, type TermTf, type TileId, type TileState,
} from '../api/terminal'
import { ErrorState, MethodNote, Segmented, Skeleton, Toggle, clsx, PageActions, SettingsPanel, SettingRow } from '../components/ui'
import { Popover } from '../widgets/superchart'
import { buildStore, type HmStore } from '../widgets/orderbookHeatmap'
import TerminalChart, { SyncBus } from '../widgets/terminalChart'
import TerminalPanes, { PANE_META } from '../widgets/terminalPanes'
import { TermLive } from '../widgets/terminalLive'
import { ConnPill, DomTile, FeedTile, FlowTile, IntegrityTile, LiqsTile, TickerBar } from '../widgets/terminalTiles'
import { dateTime } from '../lib/format'
import { t } from '../i18n'

// ------------------------------------------------------------------ layout
const TFS: TermTf[] = ['1m', '5m', '15m', '1h']
const ROW_H = 72
const GAP = 12
const TILE_TITLE: Record<TileId, string> = {
  dom: 'Order book', chart: 'Grafico', feed: 'Order feed', flow: 'Order flow', panes: 'Pannelli aggregati', liqs: 'Liquidazioni reali', integrity: 'Integrità dei dati',
}
const TILE_INFO: Record<TileId, string> = {
  dom: 'Book locale Binance (perpetual o spot) sincronizzato e verificato dal collector dell\'order book; Δ = variazione della quantità rispetto all\'aggiornamento precedente.',
  chart: 'Candele Binance USDⓈ-M BTCUSDT. Sotto: heatmap della liquidità del book Binance perp (raccolta da quando l\'app è accesa). Sopra: bolle delle liquidazioni reali di Binance, Bybit e OKX (area proporzionale ai dollari; rosso = long liquidati, verde = short) e livelli di liquidazione STIMATI dal modello (linee tratteggiate).',
  feed: 'Trade dei perpetual e dello spot di Binance, Bybit, OKX e Coinbase. Da $10K singoli; sotto, aggregati ogni 250 ms per mercato e lato (×n trade); gli aggregati sotto $100 non sono mostrati. Righe colorate = grandi trade (≥ $100K).',
  flow: 'Acquisti e vendite aggressivi (lato del taker) di tutti i 7 mercati nelle finestre mobili di 1, 5 e 15 minuti: controvalore, quota, delta, numero di trade e taglia media.',
  panes: 'Pannelli sincronizzati con il grafico (zoom, spostamento e crosshair condivisi).',
  liqs: 'Liquidazioni reali ricevute dai WebSocket di Binance, Bybit e OKX (Binance invia al massimo un evento al secondo per simbolo: sottostima nei picchi).',
  integrity: 'Volume per minuto di ogni stream confrontato con le kline 1m ufficiali dello stesso exchange (atteso < 1%); trade recuperati via REST dopo le disconnessioni; duplicati scartati.',
}
const DEFAULT: TermLayoutState = {
  tf: '5m',
  tiles: [
    { id: 'dom', w: 3, h: 8, hidden: false }, { id: 'chart', w: 6, h: 8, hidden: false }, { id: 'feed', w: 3, h: 5, hidden: false },
    { id: 'flow', w: 3, h: 3, hidden: false }, { id: 'panes', w: 12, h: 10, hidden: false }, { id: 'liqs', w: 4, h: 6, hidden: false },
    { id: 'integrity', w: 8, h: 6, hidden: false },
  ],
  panes: ['cvd_spot', 'cvd_all', 'oi', 'funding', 'premium'],
  opts: { heat: true, est: true, bubbles: true, vol: true },
}
/** sotto 1700 px il grafico cede una colonna a feed e order flow (prezzi leggibili) */
function defaultFor(w: number): TermLayoutState {
  if (w >= 1700) return DEFAULT
  return { ...DEFAULT, tiles: DEFAULT.tiles.map((x) => (x.id === 'chart' ? { ...x, w: 5 } : x.id === 'feed' || x.id === 'flow' ? { ...x, w: 4 } : x)) }
}
const PANES_ALL: PaneId[] = ['cvd_spot', 'cvd_perp', 'cvd_all', 'oi', 'funding', 'premium']
const LS_KEY = 'term.layout.v1'
const MOBILE_H: Record<TileId, number> = { dom: 560, chart: 440, feed: 460, flow: 300, panes: 0, liqs: 380, integrity: 560 }
const WIDTHS = [3, 4, 5, 6, 7, 8, 9, 12]

function loadLocal(): TermLayoutState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null') as TermLayoutState | null
    if (v && Array.isArray(v.tiles) && TFS.includes(v.tf)) {
      const ids = new Set(v.tiles.map((x) => x.id))
      return { ...DEFAULT, ...v, tiles: [...v.tiles.filter((x) => x.id in TILE_TITLE), ...DEFAULT.tiles.filter((x) => !ids.has(x.id))], opts: { ...DEFAULT.opts, ...v.opts } }
    }
  } catch { /* ignore */ }
  return defaultFor(window.innerWidth)
}
function useMedia(q: string) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const h = () => setM(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [q])
  return m
}
const px = (h: number) => h * ROW_H + (h - 1) * GAP

// ------------------------------------------------------------------ tile frame
function Tile({ tile, title, info, right, maximized, onMax, onClose, drag, children, mode, style }: {
  tile: TileState; title: string; info?: string; right?: ReactNode; maximized: boolean; onMax: () => void; onClose: () => void
  drag: { onDragStart: (e: DragEvent) => void; onDragEnd: () => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; over: boolean } | null
  children: (bodyH: number) => ReactNode; mode: 'desk' | 'mid' | 'mob'; style?: React.CSSProperties
}) {
  const HEADER = 40
  const [vh, setVh] = useState(() => window.innerHeight)
  useEffect(() => { const h = () => setVh(window.innerHeight); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h) }, [])
  const total = maximized ? vh - 24 : mode === 'mob' ? MOBILE_H[tile.id] : px(tile.h)
  return (
    <section data-tile={tile.id} style={maximized ? undefined : mode === 'mob' && tile.id !== 'panes' ? { height: total } : style} onDragOver={drag?.onDragOver} onDrop={drag?.onDrop}
      className={clsx('card flex min-w-0 flex-col overflow-hidden', maximized ? 'fixed inset-3 z-[60] shadow-pop' : 'relative', drag?.over && 'ring-1 ring-accent/50')}>
      <header className="flex h-10 shrink-0 items-center gap-2 px-3">
        {drag && !maximized && (
          <span draggable onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} className="-ml-1 grid h-7 w-5 cursor-grab place-items-center text-fg-off hover:text-fg-2 active:cursor-grabbing" title={t('Trascina per riordinare')}>
            <GripVertical size={14} />
          </span>
        )}
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-[-0.01em] text-white" title={info}>{title}</h2>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {right}
          <button type="button" onClick={onMax} className="grid h-7 w-7 place-items-center rounded-md text-fg-4 hover:bg-white/[0.05] hover:text-white" aria-label={maximized ? t('Riduci') : t('Ingrandisci')} title={maximized ? t('Riduci') : t('Ingrandisci')}>
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          {!maximized && (
            <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-fg-4 hover:bg-white/[0.05] hover:text-white" aria-label={t('Chiudi riquadro')} title={t('Chiudi riquadro')}>
              <X size={14} />
            </button>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 pb-2" style={{ height: mode === 'mob' && !maximized && tile.id === 'panes' ? undefined : total - HEADER }}>
        {children(total - HEADER - 8)}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ page
export default function TerminalPage() {
  const [layout, setLayout] = useState<TermLayoutState>(loadLocal)
  const [selId, setSelId] = useState<string | null>(null)
  const [maxId, setMaxId] = useState<TileId | null>(null)
  const [dragId, setDragIdState] = useState<TileId | null>(null)
  const dragRef = useRef<TileId | null>(null)
  const setDragId = (v: TileId | null) => { dragRef.current = v; setDragIdState(v) }
  const [overId, setOverId] = useState<TileId | null>(null)
  const desk = useMedia('(min-width: 1280px)')
  const mob = useMedia('(max-width: 767px)')
  const mode: 'desk' | 'mid' | 'mob' = desk ? 'desk' : mob ? 'mob' : 'mid'
  const tf = layout.tf
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(layout)) } catch { /* ignore */ } }, [layout])
  useEffect(() => {
    if (!maxId) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaxId(null) }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [maxId])

  // stato live (un WebSocket per pagina)
  const live = useMemo(() => new TermLive({ tf: layout.tf, dm: 'futures', ds: 10, dn: 30, hm: layout.opts.heat, hb: 10, hr: 1.5 }), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    live.start()
    if (import.meta.env.DEV) (window as unknown as { __termLive?: TermLive }).__termLive = live
    fetchSnapshot(live.ctl.tf, live.ctl.dm, live.ctl.ds).then((s) => live.applySnapshot(s)).catch(() => { /* il WS arriverà */ })
    return () => live.stop()
  }, [live])
  useEffect(() => { live.setCtl({ tf, hm: layout.opts.heat }) }, [tf, layout.opts.heat, live])
  const sync = useMemo(() => new SyncBus(), [])

  const series = useTermSeries(tf)
  const status = useTermStatus()
  const est = useTermEst()
  const sd = series.data
  // heatmap della liquidità: stessa finestra del grafico (al massimo 7 giorni, limite dell'order book)
  const hmSpan = sd ? Math.min(7 * 86400, sd.to - sd.from) : 0
  const hq = useObHeatmap({ market: 'futures', span: Math.round(hmSpan / 600) * 600, bucket: 10, range: 1.5, cols: Math.min(3000, (sd?.t.length ?? 300) * 2) },
    !!sd && layout.opts.heat)
  const heat = useMemo<HmStore | null>(() => (hq.data ? buildStore(hq.data) : null), [hq.data])
  useEffect(() => { if (heat) live.setCtl({ hb: heat.bucket }) }, [heat, live])
  const chartApi = useRef<{ reset: () => void } | null>(null)

  // layout salvati
  const layoutsQ = useTermLayouts()
  const muts = useTermLayoutMutations()
  const saved = layoutsQ.data?.layouts ?? []
  const sel = saved.find((l) => l.id === selId)
  const dirty = sel ? JSON.stringify(sel.state) !== JSON.stringify(layout) : false

  const patchTile = useCallback((id: TileId, p: Partial<TileState>) => setLayout((L) => ({ ...L, tiles: L.tiles.map((x) => (x.id === id ? { ...x, ...p } : x)) })), [])
  const move = (id: TileId, dir: -1 | 1) => setLayout((L) => {
    const arr = [...L.tiles]
    const i = arr.findIndex((x) => x.id === id)
    const j = i + dir
    if (j < 0 || j >= arr.length) return L
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    return { ...L, tiles: arr }
  })
  const dropOn = (target: TileId) => {
    const src = dragRef.current
    setLayout((L) => {
    if (!src || src === target) return L
    // dropped on a tile further down: it goes after it (before it would leave a drop on the next tile unchanged)
    const down = L.tiles.findIndex((x) => x.id === src) < L.tiles.findIndex((x) => x.id === target)
    const arr = L.tiles.filter((x) => x.id !== src)
    const i = arr.findIndex((x) => x.id === target) + (down ? 1 : 0)
    arr.splice(i, 0, L.tiles.find((x) => x.id === src)!)
    return { ...L, tiles: arr }
    })
  }
  const togglePane = (p: PaneId) => setLayout((L) => ({ ...L, panes: L.panes.includes(p) ? L.panes.filter((x) => x !== p) : PANES_ALL.filter((x) => x === p || L.panes.includes(x)) }))
  const setOpt = (k: keyof TermLayoutState['opts']) => setLayout((L) => ({ ...L, opts: { ...L.opts, [k]: !L.opts[k] } }))

  // mobile: versione semplificata in colonna, grafico e order flow per primi
  const MOB_ORDER: TileId[] = ['chart', 'flow', 'feed', 'dom', 'panes', 'liqs', 'integrity']
  const visible = layout.tiles.filter((x) => !x.hidden).sort((a, b) => (mode === 'mob' ? MOB_ORDER.indexOf(a.id) - MOB_ORDER.indexOf(b.id) : 0))
  const hidden = layout.tiles.filter((x) => x.hidden)
  const span = (x: TileState) => (mode === 'desk' ? x.w : mode === 'mid' ? (x.w >= 6 || x.id === 'chart' ? 6 : 3) : 1)
  const panesH = (h: number) => (mode === 'mob' && !maxId ? layout.panes.length * 150 + 26 : h)

  const body = (id: TileId, h: number): ReactNode => {
    switch (id) {
      case 'chart':
        return series.isError && !sd ? <ErrorState error={series.error} onRetry={() => series.refetch()} /> : !sd ? <div className="h-full px-3"><Skeleton className="h-full w-full" /></div> : (
          <div className="h-full px-1"><TerminalChart data={sd} tf={tf} heat={layout.opts.heat ? heat : null} est={est.data ?? []} opts={layout.opts} live={live} sync={sync}
            onReady={(a) => { chartApi.current = a }} /></div>
        )
      case 'panes':
        return !sd ? <div className="h-full px-3"><Skeleton className="h-full w-full" /></div> : layout.panes.length === 0
          ? <p className="py-8 text-center text-sm text-fg-3">{t('Nessun pannello attivo: aggiungili dal menu Pannelli.')}</p>
          : <div className="px-1" style={{ height: panesH(h) }}><TerminalPanes data={sd} tf={tf} panes={layout.panes} live={live} sync={sync} height={panesH(h)} /></div>
      case 'dom': return <DomTile live={live} height={h} compactUi={mode === 'mob'} />
      case 'feed': return <FeedTile live={live} />
      case 'flow': return <FlowTile live={live} />
      case 'liqs': return <LiqsTile live={live} />
      case 'integrity': return <IntegrityTile st={status.data} />
    }
  }
  const tileRight = (id: TileId): ReactNode => {
    if (id === 'chart') return (
      <div className="flex items-center gap-1.5">
        <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-fg-4 hover:bg-white/[0.05] hover:text-white" title={t('Adatta')} aria-label={t('Adatta')} onClick={() => chartApi.current?.reset()}><ScanLine size={14} /></button>
      </div>
    )
    if (id === 'panes') return (
      <Popover label={t('Pannelli')} icon={<Layers size={14} />} count={layout.panes.length} align="right">
        {() => (
          <div>
            {PANES_ALL.map((p) => (
              <MenuCheck key={p} on={layout.panes.includes(p)} onClick={() => togglePane(p)} sub={t(PANE_META[p].info).slice(0, 70) + '…'}>{t(PANE_META[p].label)}</MenuCheck>
            ))}
          </div>
        )}
      </Popover>
    )
    return null
  }

  const st = status.data
  return (
    <div>
      <div className="flex flex-col gap-3">
        <PageActions>
          <Segmented value={tf} onChange={(v) => setLayout((L) => ({ ...L, tf: v }))} options={TFS.map((x) => ({ value: x, label: x }))} />
          <SettingsPanel>
            <SettingRow label={t('Grafico')}>
              <Toggle on={layout.opts.heat} onClick={() => setOpt('heat')}>{t('Heatmap')}</Toggle>
              <Toggle on={layout.opts.bubbles} onClick={() => setOpt('bubbles')}>{t('Liquidazioni')}</Toggle>
              <Toggle on={layout.opts.est} onClick={() => setOpt('est')}>{t('Livelli stimati')}</Toggle>
              <Toggle on={layout.opts.vol} onClick={() => setOpt('vol')}>{t('Volume')}</Toggle>
            </SettingRow>
          </SettingsPanel>
            <Popover label={t('Riquadri')} icon={<LayoutGrid size={14} />} count={hidden.length || undefined} align="right" wide>
              {() => (
                <div className="flex flex-col">
                  {layout.tiles.map((x, i) => (
                    <div key={x.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-white/[0.03]">
                      <button type="button" onClick={() => patchTile(x.id, { hidden: !x.hidden })} role="menuitemcheckbox" aria-checked={!x.hidden}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-fg-2 hover:text-white">
                        <span className={clsx('grid h-4 w-4 shrink-0 place-items-center rounded-sm border', !x.hidden ? 'border-accent bg-accent text-bg' : 'border-fg-off')}>{!x.hidden && <Check size={12} strokeWidth={3} />}</span>
                        <span className="truncate">{t(TILE_TITLE[x.id])}</span>
                      </button>
                      <select aria-label={t('Larghezza')} value={x.w} onChange={(e) => patchTile(x.id, { w: Number(e.target.value) })}
                        className="h-7 rounded-md border border-line bg-white/[0.03] px-1 text-xs text-fg-2">{WIDTHS.map((w) => <option key={w} value={w}>{w}/12</option>)}</select>
                      <select aria-label={t('Altezza')} value={x.h} onChange={(e) => patchTile(x.id, { h: Number(e.target.value) })}
                        className="h-7 rounded-md border border-line bg-white/[0.03] px-1 text-xs text-fg-2">{Array.from({ length: 11 }, (_, k) => k + 2).map((h) => <option key={h} value={h}>{px(h)} px</option>)}</select>
                      <button type="button" disabled={i === 0} onClick={() => move(x.id, -1)} className="grid h-7 w-6 place-items-center text-fg-4 hover:text-white disabled:opacity-30" aria-label={t('Sposta prima')}><ArrowUp size={13} /></button>
                      <button type="button" disabled={i === layout.tiles.length - 1} onClick={() => move(x.id, 1)} className="grid h-7 w-6 place-items-center text-fg-4 hover:text-white disabled:opacity-30" aria-label={t('Sposta dopo')}><ArrowDown size={13} /></button>
                    </div>
                  ))}
                  <p className="px-2 pt-1.5 text-2xs text-fg-4">{t('Trascina l\'impugnatura di un riquadro per riordinarlo; larghezza su 12 colonne (schermi ≥ 1280 px).')}</p>
                </div>
              )}
            </Popover>
            <LayoutMenu name={sel?.name ?? t('Layout corrente')} dirty={dirty} layouts={saved} selId={selId} busy={muts.create.isPending || muts.update.isPending || muts.remove.isPending}
              onPick={(id) => { const l = saved.find((x) => x.id === id); if (l) { setLayout(l.state); setSelId(id) } }}
              onSaveNew={(name) => muts.create.mutate({ name, state: layout }, { onSuccess: (l) => setSelId(l.id) })}
              onUpdate={() => selId && muts.update.mutate({ id: selId, state: layout })}
              onDelete={() => selId && muts.remove.mutate(selId, { onSuccess: () => setSelId(null) })} />
            <button type="button" className="btn-ghost h-8 sm:h-7" onClick={() => { setLayout(defaultFor(window.innerWidth)); setSelId(null); setMaxId(null) }}><RotateCcw size={14} />{t('Predefinito')}</button>
        </PageActions>

        <TickerBar live={live} right={<ConnPill live={live} />} />

        {maxId && <div className="fixed inset-0 z-[55] bg-black/60" onClick={() => setMaxId(null)} />}
        <div className={clsx('grid gap-3', mode === 'desk' ? 'grid-cols-12' : mode === 'mid' ? 'grid-cols-6' : 'grid-cols-1')}
          style={mode !== 'mob' ? { gridAutoRows: `${ROW_H}px`, gridAutoFlow: 'row dense' } : undefined}>
          {visible.map((x) => (
            <Tile key={x.id} tile={x} title={t(TILE_TITLE[x.id])} info={t(TILE_INFO[x.id])} right={tileRight(x.id)} mode={mode}
              maximized={maxId === x.id} onMax={() => setMaxId(maxId === x.id ? null : x.id)} onClose={() => patchTile(x.id, { hidden: true })}
              style={mode === 'mob' ? undefined : { gridColumn: `span ${span(x)} / span ${span(x)}`, gridRow: `span ${x.h} / span ${x.h}` }}
              drag={mode === 'mob' ? null : {
                over: overId === x.id && dragId !== x.id,
                onDragStart: (e) => { setDragId(x.id); e.dataTransfer.setDragImage((e.currentTarget as HTMLElement).closest('section') ?? (e.currentTarget as HTMLElement), 20, 20); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', x.id) },
                // drop outside any tile / Esc: clear the drag state (otherwise the accent ring stayed on the last tile)
                onDragEnd: () => { setDragId(null); setOverId(null) },
                onDragOver: (e) => { if (dragRef.current) { e.preventDefault(); if (overId !== x.id) setOverId(x.id) } },
                onDrop: (e) => { e.preventDefault(); dropOn(x.id); setDragId(null); setOverId(null) },
              }}>
              {(h) => body(x.id, h)}
            </Tile>
          ))}
        </div>
        {hidden.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
            <span>{t('Riquadri chiusi')}:</span>
            {hidden.map((x) => <button key={x.id} type="button" className="btn-ghost h-7" onClick={() => patchTile(x.id, { hidden: false })}>+ {t(TILE_TITLE[x.id])}</button>)}
          </div>
        )}

        <MethodNote title={t('Metodo, fonti e limiti')}>
          <p><b className="text-fg-2">{t('Fonti')}.</b> {t('WebSocket pubblici dei trade: Binance USDⓈ-M e spot (aggTrade), Bybit linear e spot (publicTrade), OKX swap e spot (trades-all), Coinbase BTC-USD (matches). Lato aggressore: campo del taker per Binance, Bybit e OKX; su Coinbase il campo side indica il maker e viene invertito. I contratti OKX BTC-USDT-SWAP sono convertiti in BTC con il valore ufficiale del contratto (0.01 BTC, riletto all\'avvio).')}</p>
          <p><b className="text-fg-2">{t('Cosa è reale')}.</b> {t('Prezzo, trade, order flow, CVD, book, liquidazioni (eventi inviati dagli exchange), open interest e funding (API ufficiali ogni 30 s), premio Coinbase (ultimi prezzi di Coinbase BTC-USD e Binance BTCUSDT, media al secondo). Il CVD è in BTC, cumulato dall\'inizio della finestra visibile; le candele mostrano apertura, massimo, minimo e chiusura del cumulato in ogni barra.')}</p>
          <p><b className="text-fg-2">{t('Cosa è stimato')}.</b> {t('I livelli di liquidazione sono una STIMA del modello della pagina Liquidazioni (open interest aggregato e distribuzione ipotetica della leva), non ordini reali. Lo storico dell\'open interest prima della raccolta usa fotografie a 5 minuti e, prima ancora, una stima a 15 minuti (contratti USDT × fattore di scala); il funding storico è quello liquidato ogni 8 ore.')}</p>
          <p><b className="text-fg-2">{t('Verifiche')}.</b> {t('Ogni 5 minuti il volume raccolto per minuto di ciascuno stream è confrontato con le kline 1m ufficiali dello stesso exchange (scarto atteso < 1%); per Binance anche il volume degli acquisti aggressivi. Dopo una disconnessione i trade mancanti vengono recuperati via REST (per id continui) e ogni trade già contato viene scartato: nessun doppio conteggio. Il premio live è confrontato con la serie oraria esistente.')}</p>
          <p><b className="text-fg-2">{t('Limiti')}.</b> {t('Lo storico multi-exchange esiste solo da quando l\'app è accesa (linea ambra «Raccolta multi-exchange»): prima il CVD usa solo Binance spot e perp dalle kline ufficiali (7 giorni). La heatmap riguarda il solo book Binance perpetual. Binance invia al massimo una liquidazione al secondo per simbolo. Nessun indicatore è un segnale operativo.')}</p>
          {st && <p className="text-fg-4">{t('Raccolta dal')} {(() => { const v = Object.values(st.collection_start) as number[]; return v.length ? dateTime(Math.min(...v)) : '—' })()} · {sd ? `${t('Serie calcolate in')} ${sd.ms} ms` : ''}</p>}
        </MethodNote>
      </div>
    </div>
  )
}

function MenuCheck({ on, onClick, children, sub }: { on: boolean; onClick: () => void; children: ReactNode; sub?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} role="menuitemcheckbox" aria-checked={on}
      className="flex w-full items-start gap-2.5 rounded px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-white/[0.04] hover:text-white">
      <span className={clsx('mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-sm border', on ? 'border-accent bg-accent text-bg' : 'border-fg-off')}>{on && <Check size={12} strokeWidth={3} />}</span>
      <span className="min-w-0 flex-1"><span className="block truncate">{children}</span>{sub && <span className="block text-2xs leading-snug text-fg-4">{sub}</span>}</span>
    </button>
  )
}

function LayoutMenu({ name, dirty, layouts, selId, busy, onPick, onSaveNew, onUpdate, onDelete }: {
  name: string; dirty: boolean; layouts: { id: string; name: string; updated_at: number }[]; selId: string | null; busy: boolean
  onPick: (id: string) => void; onSaveNew: (name: string) => void; onUpdate: () => void; onDelete: () => void
}) {
  const [naming, setNaming] = useState(false)
  const [nm, setNm] = useState('')
  return (
    <Popover label={<span className="max-w-[9rem] truncate sm:max-w-[13rem]">{name}{dirty ? ' *' : ''}</span>} icon={<Layers size={14} />} align="right">
      {(close) => (
        <div>
          <div className="label px-2 pb-0.5 pt-1.5">{t('I miei layout')}</div>
          {layouts.length === 0 && <p className="px-2 py-1 text-xs text-fg-4">{t('Nessun layout salvato.')}</p>}
          {layouts.map((l) => <MenuCheck key={l.id} on={l.id === selId} onClick={() => { onPick(l.id); close() }} sub={dateTime(l.updated_at)}>{l.name}</MenuCheck>)}
          <div className="my-1.5 border-t border-line" />
          {naming ? (
            <form className="flex items-center gap-1.5 px-1 py-1" onSubmit={(e) => { e.preventDefault(); if (nm.trim()) { onSaveNew(nm.trim()); setNaming(false); setNm(''); close() } }}>
              <input autoFocus value={nm} maxLength={60} onChange={(e) => setNm(e.target.value)} placeholder={t('Nome del layout')} aria-label={t('Nome del layout')}
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-white/[0.03] px-2 text-sm text-white placeholder:text-fg-4 focus:border-accent/40 focus:outline-none" />
              <button type="submit" disabled={!nm.trim() || busy} className="btn-ghost h-8 disabled:opacity-40">{t('Salva')}</button>
            </form>
          ) : (
            <button type="button" onClick={() => setNaming(true)} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-fg-2 hover:bg-white/[0.04] hover:text-white">
              <Save size={14} />{t('Salva come nuovo layout…')}
            </button>
          )}
          {selId && (
            <>
              <button type="button" disabled={!dirty || busy} onClick={() => { onUpdate(); close() }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-fg-2 hover:bg-white/[0.04] hover:text-white disabled:opacity-40">
                <Check size={14} />{t('Aggiorna «{n}»', { n: name })}
              </button>
              <button type="button" disabled={busy} onClick={() => { onDelete(); close() }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-fg-2 hover:bg-white/[0.04] hover:text-warn">
                <Trash2 size={14} />{t('Elimina «{n}»', { n: name })}
              </button>
            </>
          )}
        </div>
      )}
    </Popover>
  )
}
