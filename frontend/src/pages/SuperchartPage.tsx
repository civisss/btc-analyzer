import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, History, Layers, LayoutPanelTop, Radar, X } from 'lucide-react'
import {
  useAnomalies, useScCatalog, useScData, useScLayoutMutations, useScLayouts,
  type ScCatalog, type ScData, type ScIndicator, type ScPaneState, type ScState, type ScTf,
} from '../api/superchart'
import { live } from '../api/live'
import SuperChart, { type LiveBar } from '../components/charts/SuperChart'
import { Card, MethodNote, PageTitle, Segmented, Skeleton, Toggle, clsx } from '../components/ui'
import {
  AnomalyChip, BacktestCard, IndicatorLibrary, LayoutMenu, PRESET_LABEL, RecentAnomaliesCard, ReplayBar,
  anomalyIndex, buildPanes, decodePanes, encodePanes, engineCandles, paneColor, scDefs,
} from '../widgets/superchart'
import { date, dateTime, pct, usd } from '../lib/format'
import { t, tfLabel } from '../i18n'

const TFS: ScTf[] = ['15m', '1h', '4h', '1d', '1w']
const Z_OPTS = [2.5, 3, 3.5, 4]
const FWD_BARS = 2000

function useViewport() {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const on = () => setV({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return v
}

/** index of the last bar closed by time `T` (bars are [t, t+step)) */
function cursorIndex(ts: number[], step: number, T: number): number {
  let lo = 0, hi = ts.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] + step <= T) lo = m + 1; else hi = m }
  return lo - 1
}

export default function SuperchartPage() {
  const cat = useScCatalog()
  return (
    <div>
      <PageTitle title="Superchart" subtitle={t('Prezzo, derivati, flussi e on-chain su un unico asse del tempo: pannelli sincronizzati, replay senza dati futuri e anomalie con il loro backtest.')} />
      {cat.data ? <Workspace catalog={cat.data} /> : cat.isError ? <Card className="p-6 text-sm text-slate-400">{t('Catalogo degli indicatori non disponibile.')}</Card> : <Skeleton style={{ height: 640 }} />}
    </div>
  )
}

type LayoutSel = { kind: 'preset' | 'user' | 'custom'; id?: string }

function Workspace({ catalog }: { catalog: ScCatalog }) {
  const [sp, setSp] = useSearchParams()
  const catMap = useMemo(() => Object.fromEntries(catalog.indicators.map((i) => [i.id, i])) as Record<string, ScIndicator>, [catalog])
  const known = useMemo(() => new Set(catalog.indicators.map((i) => i.id)), [catalog])
  const defs = useMemo(() => scDefs(), [])
  const presets = catalog.presets

  // ---------- state (URL → initial)
  const init = useMemo(() => {
    const fromUrl = decodePanes(sp.get('p'), known)
    const pr = presets.find((p) => p.id === (sp.get('preset') ?? 'essential')) ?? presets[0]
    const tf0 = (TFS as string[]).includes(sp.get('tf') ?? '') ? (sp.get('tf') as ScTf) : pr.tf
    return {
      tf: tf0, log: sp.has('log') ? sp.get('log') === '1' : pr.log, panes: fromUrl ?? pr.panes.map((p) => ({ ...p })),
      sel: (sp.get('layout') ? { kind: 'user', id: sp.get('layout')! } : fromUrl ? { kind: 'custom' } : { kind: 'preset', id: pr.id }) as LayoutSel,
      z: Z_OPTS.includes(Number(sp.get('z'))) ? Number(sp.get('z')) : 3,
      r: Number(sp.get('r')) || null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [tf, setTf] = useState<ScTf>(init.tf)
  const [log, setLog] = useState(init.log)
  const [panes, setPanes] = useState<ScPaneState[]>(init.panes)
  const [sel, setSel] = useState<LayoutSel>(init.sel)
  const [z, setZ] = useState(init.z)
  const [replay, setReplay] = useState<{ cursorT: number; playing: boolean; speed: number } | null>(init.r ? { cursorT: init.r, playing: false, speed: 5 } : null)
  const [anchorTo, setAnchorTo] = useState<number | null>(init.r ? init.r + FWD_BARS * 3600 : null)
  const [hover, setHover] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const state: ScState = useMemo(() => ({ tf, log, panes }), [tf, log, panes])

  const layoutsQ = useScLayouts()
  const muts = useScLayoutMutations()
  const userLayouts = layoutsQ.data?.layouts ?? []
  const selState: ScState | null = sel.kind === 'preset' ? (presets.find((p) => p.id === sel.id) ?? null)
    : sel.kind === 'user' ? (userLayouts.find((l) => l.id === sel.id)?.state ?? null) : null
  const norm = (s: ScState) => JSON.stringify({ tf: s.tf, log: s.log, panes: s.panes.map((p) => ({ id: p.id, h: p.ov ? 0 : p.h, an: !!p.an, ov: !!p.ov })) })
  const dirty = selState ? norm(selState) !== norm(state) : true
  const selName = sel.kind === 'preset' ? t(PRESET_LABEL[sel.id ?? ''] ?? '') : sel.kind === 'user' ? (userLayouts.find((l) => l.id === sel.id)?.name ?? t('Layout')) : t('Personalizzato')

  const applyState = (s: ScState) => {
    setTf(s.tf); setLog(s.log); setPanes(s.panes.map((p) => ({ ...p })))
  }

  // ---------- data
  const ids = useMemo(() => panes.map((p) => p.id), [panes])
  const bars = Number(sp.get('bars')) || undefined   // ?bars=N: finestra più lunga (max 120000)
  const q = useScData({ tf, ids, to: replay ? anchorTo : null, z, live: !replay, bars })
  const data: ScData | undefined = q.data && q.data.tf === tf ? q.data : undefined
  const anQ = useAnomalies(z)

  // ---------- URL sync (not while playing)
  useEffect(() => {
    if (replay?.playing) return
    const p = new URLSearchParams()
    p.set('tf', tf)
    if (log) p.set('log', '1')
    p.set('p', encodePanes(panes))
    if (sel.kind === 'preset' && sel.id) p.set('preset', sel.id)
    if (sel.kind === 'user' && sel.id) p.set('layout', sel.id)
    if (z !== 3) p.set('z', String(z))
    if (replay) p.set('r', String(replay.cursorT))
    if (bars) p.set('bars', String(bars))
    if (p.toString() !== sp.toString()) setSp(p, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, log, panes, sel, z, replay?.cursorT, replay?.playing, replay != null])

  // ---------- replay cursor
  const ts = data?.t ?? []
  const step = data?.step ?? 3600
  const lastIdx = ts.length - 1
  const atLatest = !!data && data.window.i1 >= data.window.total
  const end = replay && data ? Math.max(0, Math.min(lastIdx, cursorIndex(ts, step, replay.cursorT))) : lastIdx
  const atEnd = !!replay && end >= lastIdx && atLatest

  // extend the loaded window while the cursor approaches its end
  useEffect(() => {
    if (!replay || !data || atLatest) return
    if (end >= lastIdx - 30 && (anchorTo ?? 0) <= replay.cursorT + step * 50) setAnchorTo(Math.min(Math.floor(Date.now() / 1000), replay.cursorT + FWD_BARS * step))
  }, [replay, data, end, lastIdx, atLatest, anchorTo, step])

  const lastStep = useRef(0)
  const stepBy = useCallback((d: number) => {
    setReplay((r) => {
      if (!r || !data) return r
      const i = cursorIndex(data.t, data.step, r.cursorT)
      const j = Math.max(0, Math.min(data.t.length - 1, i + d))
      if (j === i && d > 0) return { ...r, playing: false }
      return { ...r, cursorT: data.t[j] + data.step }
    })
  }, [data])

  useEffect(() => {
    if (!replay?.playing) return
    if (atEnd) { setReplay((r) => (r ? { ...r, playing: false } : r)); return }
    if (end >= lastIdx) return          // waiting for the next window
    // keep the requested pace: the render time of the previous step is subtracted from the wait
    const wait = Math.max(0, 1000 / replay.speed - (performance.now() - lastStep.current))
    const id = window.setTimeout(() => {
      const now = performance.now()
      // if rendering can't keep up with the speed, advance several bars at once (each still appended one by one)
      const due = lastStep.current ? Math.max(1, Math.min(10, Math.round(((now - lastStep.current) * replay.speed) / 1000))) : 1
      lastStep.current = now
      stepBy(due)
    }, wait)
    return () => window.clearTimeout(id)
  }, [replay, end, lastIdx, atEnd, stepBy])

  const startReplay = () => {
    if (!data) return
    const i = Math.max(0, lastIdx - 300)
    const cur = data.t[i] + step
    setAnchorTo(Math.min(Math.floor(Date.now() / 1000), cur + FWD_BARS * step))
    setReplay({ cursorT: cur, playing: false, speed: 5 })
  }
  const replayDate = (T: number) => {
    setAnchorTo(Math.min(Math.floor(Date.now() / 1000), T + FWD_BARS * step))
    setReplay((r) => ({ cursorT: T, playing: false, speed: r?.speed ?? 5 }))
  }
  const exitReplay = () => { setReplay(null); setAnchorTo(null) }

  // ---------- live candle (spot klines; 15m = perpetual 1m klines merged into the 15m bar)
  const [liveBar, setLiveBar] = useState<LiveBar | null>(null)
  useEffect(() => {
    setLiveBar(null)
    if (tf === '15m') {
      return live.onPerpKline((m) => {
        if (m.tf !== '1m') return
        const b = Math.floor(m.candle.time / 900) * 900
        setLiveBar((prev) => (prev && prev.time === b
          ? { ...prev, high: Math.max(prev.high, m.candle.high), low: Math.min(prev.low, m.candle.low), close: m.candle.close }
          : { time: b, open: m.candle.open, high: m.candle.high, low: m.candle.low, close: m.candle.close }))
      })
    }
    return live.onKline((m) => {
      if (m.tf !== tf) return
      setLiveBar({ time: m.candle.time, open: m.candle.open, high: m.candle.high, low: m.candle.low, close: m.candle.close })
    })
  }, [tf])
  // merge the forming 15m bar with the loaded one (the 1m stream only knows the minutes seen since the page opened)
  const liveMerged = useMemo<LiveBar | null>(() => {
    if (!liveBar || !data?.candles || replay) return null
    const i = data.t.length - 1
    if (data.t[i] !== liveBar.time) return null
    return tf === '15m' ? { time: liveBar.time, open: data.candles.o[i], high: Math.max(data.candles.h[i], liveBar.high), low: Math.min(data.candles.l[i], liveBar.low), close: liveBar.close } : liveBar
  }, [liveBar, data, replay, tf])
  // a new bar opened: refetch so every pane gets it on the same grid
  const lastT = data?.t[data.t.length - 1]
  useEffect(() => {
    if (!replay && liveBar && lastT != null && liveBar.time > lastT) {
      const id = window.setTimeout(() => q.refetch(), 1500)
      return () => window.clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBar?.time, lastT, replay])

  // ---------- panes
  const enginePanes = useMemo(() => (data ? buildPanes(data, panes, defs, catMap) : []), [data, panes, defs, catMap])
  const candles = useMemo(() => (data ? engineCandles(data) : null), [data])
  const anoms = useMemo(() => Object.fromEntries(Object.entries(data?.series ?? {}).map(([k, s]) => [k, anomalyIndex(s.anomalies)])), [data])
  const vp = useViewport()
  const mobile = vp.w < 640
  const mainH = mobile ? 300 : Math.round(Math.max(360, Math.min(vp.w >= 2200 ? 680 : 600, vp.h * 0.5)))
  const shownPanes = useMemo(() => (mobile ? enginePanes.map((p) => ({ ...p, h: Math.min(p.h, 120) })) : enginePanes), [enginePanes, mobile])

  const toggleInd = (id: string) => {
    setPanes((ps) => {
      if (ps.some((p) => p.id === id)) return ps.filter((p) => p.id !== id)
      if (ps.length >= 12) return ps
      const meta = catMap[id]
      return [...ps, { id, h: meta?.place === 'overlay' ? 0 : 110, an: false, ov: meta?.place === 'overlay' }]
    })
  }
  const patch = (id: string, f: (p: ScPaneState) => ScPaneState) => setPanes((ps) => ps.map((p) => (p.id === id ? f(p) : p)))
  const move = (id: string, d: number) => setPanes((ps) => {
    const vis = ps.filter((p) => !p.ov)
    const i = vis.findIndex((p) => p.id === id)
    const j = i + d
    if (i < 0 || j < 0 || j >= vis.length) return ps
    const other = vis[j].id
    const a = ps.findIndex((p) => p.id === id), b = ps.findIndex((p) => p.id === other)
    const out = [...ps]; [out[a], out[b]] = [out[b], out[a]]
    return out
  })
  const onResize = useCallback((key: string, h: number) => patch(key, (p) => ({ ...p, h })), [])

  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); window.setTimeout(() => setCopied(false), 2200) } catch { /* ignore */ }
  }

  // ---------- headers
  const idx = hover ?? end
  const iconBtn = 'pointer-events-auto grid h-7 w-7 place-items-center rounded-md text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-white sm:h-6 sm:w-6'
  const paneControls = (p: ScPaneState, i: number, n: number) => {
    const meta = catMap[p.id]
    return (
      <span className="pointer-events-auto ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-surface/80 backdrop-blur-sm">
        {meta?.anom && (
          <button type="button" className={clsx(iconBtn, p.an && 'text-amber-300 hover:text-amber-200')} aria-pressed={p.an}
            title={p.an ? t('Nascondi anomalie') : t('Mostra anomalie')} aria-label={p.an ? t('Nascondi anomalie') : t('Mostra anomalie')} onClick={() => patch(p.id, (x) => ({ ...x, an: !x.an }))}><Radar size={13} /></button>
        )}
        {meta?.place !== 'overlay' && (
          <button type="button" className={clsx(iconBtn, p.ov && 'text-accent-blue')} aria-pressed={p.ov}
            title={p.ov ? t('Sposta in un pannello separato') : t('Sovrapponi al prezzo')} aria-label={p.ov ? t('Sposta in un pannello separato') : t('Sovrapponi al prezzo')}
            onClick={() => patch(p.id, (x) => ({ ...x, ov: !x.ov, h: x.ov ? (x.h || 110) : x.h }))}>{p.ov ? <LayoutPanelTop size={13} /> : <Layers size={13} />}</button>
        )}
        {!p.ov && !mobile && <button type="button" className={iconBtn} disabled={i === 0} title={t('Sposta su')} aria-label={t('Sposta su')} onClick={() => move(p.id, -1)}><ArrowUp size={13} /></button>}
        {!p.ov && !mobile && <button type="button" className={iconBtn} disabled={i === n - 1} title={t('Sposta giù')} aria-label={t('Sposta giù')} onClick={() => move(p.id, 1)}><ArrowDown size={13} /></button>}
        <button type="button" className={iconBtn} title={t('Rimuovi')} aria-label={t('Rimuovi')} onClick={() => toggleInd(p.id)}><X size={13} /></button>
      </span>
    )
  }
  const valuesAt = (p: ScPaneState, compactMode = false) => {
    const ser = data?.series[p.id]
    const def = defs[p.id]
    if (!ser || !def || idx < 0) return null
    const ep = enginePanes.find((e) => e.key === p.id)
    const o = ser.obs?.[idx]
    const lagged = o != null && data && o < data.t[idx] - (data.step > 86400 ? data.step : 0) - 3600
    const a = p.an ? anoms[p.id]?.get(idx) : undefined
    return (
      <>
        {def.cols.map((c, k) => {
          const v = ser.cols[c.key]?.[idx]
          if (compactMode && k > 0 && def.cols.length > 2) return null
          return (
            <span key={c.key} className="tnum whitespace-nowrap text-slate-400">
              {def.cols.length > 1 && <span style={{ color: ep?.series[k]?.color }}>{c.label} </span>}
              <b className="font-medium text-slate-100">{v == null ? '—' : def.fmt(v)}</b>
            </span>
          )
        })}
        {lagged && <span className="hidden whitespace-nowrap text-slate-500 sm:inline">{t('dato del {d}', { d: date(o, new Date(o! * 1000).getUTCFullYear() !== new Date(data!.t[idx] * 1000).getUTCFullYear()) })}</span>}
        {a && <AnomalyChip a={a} how={catMap[p.id]?.anom_how ?? null} fmt={def.fmt} />}
      </>
    )
  }
  const sepPanes = panes.filter((p) => !p.ov && !(catMap[p.id]?.place === 'overlay'))
  const ovPanes = panes.filter((p) => p.ov || catMap[p.id]?.place === 'overlay')
  const paneHeader = (key: string) => {
    const i = sepPanes.findIndex((p) => p.id === key)
    const p = sepPanes[i]
    if (!p) return null
    const meta = catMap[p.id]
    const err = data?.errors[p.id]
    const na = meta?.na_tf.includes(tf)
    const color = paneColor(panes.findIndex((x) => x.id === key))
    return (
      <div className="flex min-w-0 items-start gap-2 px-1.5 pt-1 text-2xs sm:text-xs">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md bg-surface/70 px-1 backdrop-blur-[2px]">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium text-slate-200">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} /><span className="truncate">{defs[p.id]?.label ?? p.id}</span>
          </span>
          {na ? <span className="text-slate-500">{t('Non disponibile su questo timeframe')}</span>
            : err ? <span className="text-amber-400">{t('Dati non disponibili')}</span> : valuesAt(p, mobile)}
        </span>
        {paneControls(p, i, sepPanes.length)}
      </div>
    )
  }
  const mainHeader = (() => {
    const cd = data?.candles
    const ok = cd && idx >= 0 && idx < cd.c.length
    const prevC = ok && idx > 0 ? cd!.c[idx - 1] : null
    const chg = ok && prevC ? ((cd!.c[idx] - prevC) / prevC) * 100 : null
    return (
      <div className="flex min-w-0 flex-col gap-1 px-1.5 pt-1 text-xs">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-surface/70 px-1 backdrop-blur-[2px]">
          <span className="font-semibold text-white">BTC · {tfLabel(tf)}</span>
          {ok && (
            <span className="tnum flex flex-wrap gap-x-2.5 text-slate-400">
              {!mobile && <span>{t('A')} <b className="font-medium text-slate-200">{usd(cd!.o[idx])}</b></span>}
              {!mobile && <span>{t('Max')} <b className="font-medium text-slate-200">{usd(cd!.h[idx])}</b></span>}
              {!mobile && <span>{t('Min')} <b className="font-medium text-slate-200">{usd(cd!.l[idx])}</b></span>}
              <span>{t('C')} <b className="font-medium text-slate-200">{usd(cd!.c[idx])}</b></span>
              {chg != null && <b className={chg >= 0 ? 'font-medium text-up' : 'font-medium text-down'}>{pct(chg)}</b>}
            </span>
          )}
          {ok && <span className="tnum hidden text-slate-500 md:inline">{dateTime(data!.t[idx])}</span>}
        </span>
        {ovPanes.map((p) => (
          <span key={p.id} className="flex min-w-0 items-start gap-2">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md bg-surface/70 px-1 backdrop-blur-[2px]">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-300">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: paneColor(panes.findIndex((x) => x.id === p.id)) }} />
                {/* phones: one short line, so the overlay legend covers less of the 300 px price chart */}
                <span className={mobile ? 'max-w-[6.5rem] truncate' : undefined} title={defs[p.id]?.label ?? p.id}>{defs[p.id]?.label ?? p.id}</span>
              </span>
              {valuesAt(p, mobile)}
            </span>
            {paneControls(p, 0, 1)}
          </span>
        ))}
      </div>
    )
  })()

  // ---------- debug / test probe (no look-ahead check, timings)
  useEffect(() => {
    const w = window as unknown as { __superchart?: unknown }
    w.__superchart = { tf, end, cursorT: replay?.cursorT ?? null, n: ts.length, lastShown: ts[end] ?? null, step, serverMs: data?.ms, panes: panes.map((p) => p.id) }
  }, [tf, end, replay?.cursorT, ts, step, data?.ms, panes])

  const windowInfo = data ? t('{n} candele · {p} pannelli · dal {d}', { n: data.t.length.toLocaleString('en-US'), p: panes.length, d: date(data.t[0]) }) : ''

  return (
    <div className="flex flex-col gap-3">
      <Card className="overflow-visible">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
          <Segmented value={tf} onChange={(v) => { setTf(v); if (replay) setAnchorTo(Math.min(Math.floor(Date.now() / 1000), replay.cursorT + FWD_BARS * ({ '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 } as const)[v])) }} options={TFS.map((v) => ({ value: v, label: tfLabel(v) }))} />
          <IndicatorLibrary catalog={catalog.indicators} panes={panes} tf={tf} onToggle={toggleInd} defs={defs} />
          <Toggle on={log} onClick={() => setLog(!log)}>Log</Toggle>
          <span className="inline-flex items-center gap-1.5">
            <span className="label hidden sm:inline">{t('Anomalie')} |z| ≥</span>
            <span className="label sm:hidden">|z| ≥</span>
            <Segmented value={z} onChange={setZ} options={Z_OPTS.map((v) => ({ value: v, label: String(v) }))} />
          </span>
          <div className="ml-auto flex items-center gap-2">
            {copied && <span className="text-xs text-slate-400" role="status">{t('Link copiato')}</span>}
            {!replay && <button type="button" onClick={startReplay} disabled={!data} className="btn-ghost h-8 sm:h-7"><History size={14} />Replay</button>}
            <LayoutMenu current={{ ...sel, name: selName }} layouts={userLayouts} dirty={dirty} busy={muts.create.isPending || muts.update.isPending || muts.remove.isPending}
              onPick={(kind, id) => {
                const s = kind === 'preset' ? presets.find((p) => p.id === id) : userLayouts.find((l) => l.id === id)?.state
                if (s) { applyState(s); setSel({ kind, id }) }
              }}
              onSaveNew={(name) => muts.create.mutate({ name, state }, { onSuccess: (l) => setSel({ kind: 'user', id: l.id }) })}
              onUpdate={() => sel.kind === 'user' && sel.id && muts.update.mutate({ id: sel.id, state })}
              onDelete={() => sel.kind === 'user' && sel.id && muts.remove.mutate(sel.id, { onSuccess: () => setSel({ kind: 'custom' }) })}
              onShare={share} />
          </div>
        </div>
        {replay && (
          <ReplayBar cursorT={replay.cursorT} playing={replay.playing} speed={replay.speed} atEnd={atEnd} minDate={data?.window.first ?? null}
            onPlay={() => { lastStep.current = 0; setReplay((r) => (r ? { ...r, playing: !r.playing } : r)) }} onStep={(d) => { setReplay((r) => (r ? { ...r, playing: false } : r)); stepBy(d) }}
            onSpeed={(s) => setReplay((r) => (r ? { ...r, speed: s } : r))} onDate={replayDate} onExit={exitReplay} />
        )}
        <div className={clsx('px-1 pb-2 pt-2 sm:px-2', replay && 'ring-1 ring-inset ring-amber-400/15')}>
          {data && candles && ts.length ? (
            <SuperChart t={data.t} candles={candles} end={end} panes={shownPanes} log={log} mainH={mainH}
              fitKey={`${tf}|${replay ? 'r' + Math.floor(replay.cursorT / 1e5) : 'live'}|${data.window.i1 - data.window.i0}`}
              onHover={setHover} onResize={mobile ? undefined : onResize} header={mainHeader} paneHeader={paneHeader} liveBar={liveMerged} />
          ) : q.isError ? (
            <p className="py-20 text-center text-sm text-slate-400">{t('Dati del grafico non disponibili. Riprova tra poco.')}</p>
          ) : (
            <Skeleton style={{ height: mainH + panes.filter((p) => !p.ov).reduce((s, p) => s + p.h, 0) }} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1.5 pt-2 text-2xs text-slate-500">
            <span className="tnum">{windowInfo}{q.isFetching && <span className="ml-2 text-slate-600">{t('aggiornamento…')}</span>}</span>
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="hover:text-slate-400">{t('Grafico: TradingView Lightweight Charts™')}</a>
          </div>
        </div>
      </Card>

      <div className="grid gap-3">
        <RecentAnomaliesCard q={anQ} onPick={(r) => {
          const map: Record<string, string> = { funding: 'funding_binance', oi: 'oi_agg', liq_long: 'liquidations', liq_short: 'liquidations', volume: 'volume', etf: 'etf_flows', exchange: 'exch_netflow' }
          const id = map[r.type]
          if (id && !panes.some((p) => p.id === id)) setPanes((ps) => [...ps, { id, h: 110, an: true, ov: false }])
          else if (id) patch(id, (p) => ({ ...p, an: true }))
        }} />
        <BacktestCard q={anQ} />
      </div>

      <MethodNote title={t('Metodo, fonti e limiti')}>
        <p>{t('Allineamento: ogni serie ha un tempo di osservazione e un istante di disponibilità (fine del periodo osservato + ritardo di pubblicazione). Sulla candela si mostra il valore già noto alla sua chiusura: i livelli (open interest, MVRV, riserve, DXY…) restano uguali finché non arriva il dato successivo, i tassi (funding, premio) sono mediati dentro la candela, i flussi (liquidazioni, ETF, netflow, delta) sono sommati nella candela in cui diventano disponibili e mai ripetuti. Nessuna interpolazione: nel riquadro di ogni pannello compare la data del dato quando è più vecchio della candela.')}</p>
        <p>{t('Replay: il grafico riceve solo le candele chiuse fino alla data scelta e, per ogni pannello, solo i valori pubblicati entro quella chiusura; avanzando si aggiunge una candela alla volta. Ritardi usati: on-chain CoinMetrics (riserve, flussi, MVRV, NUPL) disponibili a fine del giorno successivo; ETF (Farside) a metà del giorno successivo; STH/LTH BGeometrics 7 giorni (piano gratuito); macro (DXY, S&P 500, oro) e stablecoin a fine giornata; Fear & Greed alle 00:00 UTC del giorno. Sono stime prudenti dove la data esatta di pubblicazione non è nota.')}</p>
        <p>{t('Anomalie: z robusto = (valore − mediana) / scala, con mediana e scala (max tra IQR/1.349 e mezza deviazione standard) calcolate solo sui valori precedenti (90 giorni per le serie giornaliere, 30 giorni per quelle intraday): nessun dato futuro. Si usa il livello per tassi e flussi, la variazione percentuale per open interest, riserve e macro, il logaritmo per volumi e liquidazioni, lo sbilanciamento taker (delta / volume) per il CVD. Gli episodi dello stesso segno a distanza ravvicinata contano una volta sola. Con code spesse |z| ≥ 3 capita in pochi punti percentuali dei giorni: la soglia è regolabile.')}</p>
        <p>{t('Backtest: per sette tipi giornalieri (funding, open interest Bybit, liquidazioni long e short, volume spot, flussi ETF, flusso netto exchange) si misura il rendimento di BTC e il movimento assoluto a 1, 3 e 7 giorni dalla chiusura del primo giorno in cui il dato era pubblicato, con IC 95% bootstrap e p-value contro giorni casuali dello stesso periodo, corretti con Benjamini-Hochberg su tutti i test. Il verdetto è descrittivo: non è un segnale operativo.')}</p>
        <p>{t('Limiti: open interest Binance/aggregato, long/short e funding aggregato coprono solo le ultime settimane (lo storico cresce col tempo); le liquidazioni reali sono raccolte live (massimo 60 giorni), quindi il loro backtest è aneddotico; i 15 minuti sono candele Binance USDⓈ-M (storico dal 1° gennaio dell’anno precedente), gli altri timeframe Binance spot; CVD spot non esiste a 15 minuti; la USDT dominance usa un fattore di calibrazione attuale su CoinGecko applicato a tutto lo storico (approssimazione dichiarata); il premio Coinbase orario copre gli ultimi 6 mesi, prima è giornaliero; i VWAP sono calcolati su candele orarie (la pagina VWAP usa candele da 1 minuto: scarti di pochi punti base).')}</p>
      </MethodNote>
    </div>
  )
}

