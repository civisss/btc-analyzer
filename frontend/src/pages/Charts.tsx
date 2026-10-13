import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BellPlus, Check as CheckIcon, ChevronDown, CandlestickChart, Layers3, Ruler } from 'lucide-react'
import { useCandles, useIndicators, useLevels } from '../api/client'
import type { PivotPeriod, Tf } from '../api/types'
import type { LiveTf } from '../api/live'
import ProChart, { type LineDef, type PaneDef, type PriceLineDef } from '../components/charts/ProChart'
import { C } from '../components/charts/theme'
import { Card, CardBody, CardHeader, PageTitle, Q, Segmented, Skeleton, Toggle, clsx } from '../components/ui'
import { IndicatorSummary, useLevelOverlays } from '../widgets/dashboard'
import { usePrice } from '../widgets/hooks'
import { pct, usd } from '../lib/format'
import { cap, t, tfLabel } from '../i18n'
import { RuleEditorHost, openRuleEditor, priceRulePrefill } from '../widgets/alertRules'
import { useChartAnnotations } from '../widgets/annotations'

const TFS: Tf[] = ['15m', '1h', '4h', '1d', '1w']

/** Key levels with their source (the part of the backend label after " · "). */
function LevelsCard({ tf }: { tf: '1d' | '4h' | '1w' }) {
  const q = useLevels(tf)
  const price = usePrice()
  return (
    <Card>
      <CardHeader title={t('Livelli chiave')} icon={<Layers3 />} subtitle={`Timeframe ${tfLabel(tf)}`}
        right={price ? <span className="tnum text-xs text-slate-400">{t('Prezzo')} <span className="text-white">{usd(price)}</span></span> : null} />
      <CardBody className="px-1 pb-2">
        <Q q={q} compact isEmpty={(d) => !d.key_levels.length}>
          {(d) => (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>{t('Livello')}</th><th>{t('Fonte')}</th><th className="text-right">{t('Prezzo')}</th><th className="text-right">{t('Distanza')}</th><th className="w-8 pl-0"><span className="sr-only">{t('Crea avviso')}</span></th></tr></thead>
                <tbody>
                  {[...d.key_levels].sort((a, b) => b.price - a.price).map((k) => {
                    const dist = price ? ((k.price - price) / price) * 100 : k.distance
                    const [head, ...rest] = k.label.split(' · ')
                    const src = rest.join(' · ')
                    return (
                      <tr key={k.label + k.price}>
                        <td className="whitespace-nowrap text-white"><span className="mr-1 text-2xs text-slate-400">{k.kind === 'resistance' ? '▲' : '▼'}</span>{head}</td>
                        <td className="w-full max-w-0 truncate text-xs text-slate-400" title={src || undefined}>{src ? cap(src) : '—'}</td>
                        <td className="text-right text-white">{usd(k.price)}</td>
                        <td className="text-right text-slate-300">{pct(dist, 1)}</td>
                        <td className="w-8 pl-0 pr-2">
                          <button type="button" onClick={() => openRuleEditor(priceRulePrefill(k.price, price, `BTC ${k.price >= (price ?? 0) ? t('sopra') : t('sotto')} ${head} (${usd(k.price)})`))}
                            title={t('Crea avviso')} aria-label={t('Crea avviso su {l}', { l: head })}
                            className="grid h-7 w-7 place-items-center rounded-md text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-amber-300"><BellPlus size={14} /></button>
                        </td>
                      </tr>
                    )
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

/** chart fills the viewport: calc(100vh − 200px), at least 520px */
const CHART_H = 'max(520px, calc(100vh - 200px))'

/** Dropdown of checkboxes; on phones it opens as a bottom sheet. */
function Menu({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={clsx('btn-ghost', open && 'bg-raised text-white')}>
        {label}{count > 0 && <span className="tnum text-slate-400">{count}</span>}<ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50 sm:hidden" onClick={() => setOpen(false)} />
          <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border border-line bg-raised p-2 pb-6 shadow-pop sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-9 sm:w-64 sm:rounded-md sm:pb-2">
            <div className="label px-2 pb-1 pt-1 sm:hidden">{label}</div>
            {children}
          </div>
        </>
      )}
    </div>
  )
}

function Check({ on, onClick, color, children }: { on: boolean; onClick: () => void; color?: string; children: ReactNode }) {
  return (
    <button onClick={onClick} role="menuitemcheckbox" aria-checked={on} className="flex h-9 w-full items-center gap-2.5 rounded px-2 text-left text-sm text-slate-300 hover:bg-white/[0.04] hover:text-white sm:h-8">
      <span className={clsx('grid h-4 w-4 place-items-center rounded-sm border', on ? 'border-accent-blue bg-accent-blue text-bg' : 'border-slate-600')}>{on && <CheckIcon size={12} strokeWidth={3} />}</span>
      <span className="flex-1">{children}</span>
      {color && <span className="h-2 w-2 rounded-sm" style={{ background: color }} />}
    </button>
  )
}

type Toggles = { ema: boolean; sma: boolean; bb: boolean; vwap: boolean; pivots: boolean; zones: boolean; swings: boolean; fib: boolean; rsi: boolean; macd: boolean; volume: boolean; log: boolean; key: boolean }

export default function Charts() {
  const [tf, setTf] = useState<Tf>(() => {
    try { return (localStorage.getItem('charts-tf') as Tf) || '4h' } catch { return '4h' }
  })
  useEffect(() => { try { localStorage.setItem('charts-tf', tf) } catch { /* ignore */ } }, [tf])
  const [tg, setT] = useState<Toggles>({ ema: true, sma: false, bb: false, vwap: false, pivots: false, zones: true, swings: true, fib: false, rsi: true, macd: true, volume: true, log: false, key: true })
  const [pivType, setPivType] = useState<'classic' | 'fibonacci' | 'camarilla'>('classic')
  const [pivPeriod, setPivPeriod] = useState<PivotPeriod>('daily')
  const flip = (k: keyof Toggles) => setT((s) => ({ ...s, [k]: !s[k] }))

  const cq = useCandles(tf, 1000)
  const iq = useIndicators(tf, 1000)
  const lq = useLevels(tf)
  const livePrice = usePrice()
  const ann = useChartAnnotations(tf, livePrice)

  const lines = useMemo<LineDef[]>(() => {
    const d = iq.data
    if (!d) return []
    const out: LineDef[] = []
    const emaCol: Record<string, string> = { '21': C.blue, '50': C.purple, '200': C.primary }
    if (tg.ema) Object.entries(d.ema).forEach(([p, s]) => out.push({ id: `ema${p}`, data: s, color: emaCol[p] ?? C.blue }))
    if (tg.sma) Object.entries(d.sma).forEach(([p, s]) => out.push({ id: `sma${p}`, data: s, color: p === '200' ? C.grey : C.grey2, dashed: true }))
    if (tg.bb) {
      out.push({ id: 'bbu', data: d.bb.upper, color: 'rgba(148,163,184,0.7)', width: 1 })
      out.push({ id: 'bbm', data: d.bb.mid, color: 'rgba(148,163,184,0.45)', width: 1, dashed: true })
      out.push({ id: 'bbl', data: d.bb.lower, color: 'rgba(148,163,184,0.7)', width: 1 })
    }
    if (tg.vwap && d.vwap) out.push({ id: 'vwap', data: d.vwap, color: C.teal, width: 2 })
    return out
  }, [iq.data, tg.ema, tg.sma, tg.bb, tg.vwap])

  const lvl = useLevelOverlays(lq.data, { keyLevels: tg.key, swings: tg.swings, zones: tg.zones })
  const priceLines = useMemo<PriceLineDef[]>(() => {
    const out = [...lvl.priceLines]
    const L = lq.data
    if (!L) return out
    if (tg.pivots) {
      const set = L.pivots[pivPeriod]?.[pivType] as Record<string, number> | undefined
      if (set) Object.entries(set).forEach(([k, v]) => out.push({ price: v, color: '', title: `${k} ${pivPeriod[0].toUpperCase()}` }))
    }
    if (tg.fib) L.fib_retracement.levels.forEach((f) => out.push({ price: f.price, color: '', title: `Fib ${f.ratio}`, dashed: false }))
    return out
  }, [lvl.priceLines, lq.data, tg.pivots, tg.fib, pivType, pivPeriod])

  const panes = useMemo<PaneDef[]>(() => {
    const d = iq.data
    if (!d) return []
    const out: PaneDef[] = []
    if (tg.rsi) out.push({ id: 'rsi', title: 'RSI 14', height: 90, series: [{ id: 'rsi', type: 'line', data: d.rsi, color: C.blue }], levels: [{ value: 70, color: '' }, { value: 30, color: '' }] })
    if (tg.macd) out.push({
      id: 'macd', title: 'MACD 12·26·9', height: 90, series: [
        { id: 'hist', type: 'histogram', data: d.macd.hist, color: C.up, colorFn: (v) => (v >= 0 ? 'rgba(46,189,133,0.6)' : 'rgba(239,84,102,0.6)') },
        { id: 'macd', type: 'line', data: d.macd.macd, color: C.blue },
        { id: 'sig', type: 'line', data: d.macd.signal, color: C.grey },
      ],
    })
    return out
  }, [iq.data, tg.rsi, tg.macd])


  const tfOpts = TFS.map((v) => ({ value: v, label: tfLabel(v) }))
  const tfName = tfLabel(tf)
  const fib = lq.data?.fib_retracement
  const indCount = [tg.ema, tg.sma, tg.bb, tg.vwap, tg.volume, tg.rsi, tg.macd].filter(Boolean).length
  const lvlCount = [tg.key, tg.zones, tg.swings, tg.fib, tg.pivots].filter(Boolean).length

  return (
    <div>
      <PageTitle title={t('Grafici')} subtitle={t('Candele BTC/USDT con indicatori e livelli, aggiornate in tempo reale.')} />
      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_400px] min-[2200px]:grid-cols-[minmax(0,1fr)_460px]">
        <Card className="h-full">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <Segmented value={tf} onChange={setTf} options={tfOpts} />
            <Menu label={t('Indicatori')} count={indCount}>
              <Check on={tg.ema} onClick={() => flip('ema')} color={C.blue}>EMA 21 / 50 / 200</Check>
              <Check on={tg.sma} onClick={() => flip('sma')} color={C.grey}>SMA 50 / 200</Check>
              <Check on={tg.bb} onClick={() => flip('bb')} color={C.grey}>{t('Bande di Bollinger')}</Check>
              <Check on={tg.vwap} onClick={() => flip('vwap')} color={C.teal}>VWAP</Check>
              <Check on={tg.volume} onClick={() => flip('volume')}>Volume</Check>
              <div className="my-1 border-t border-line" />
              <Check on={tg.rsi} onClick={() => flip('rsi')}>RSI 14</Check>
              <Check on={tg.macd} onClick={() => flip('macd')}>MACD 12·26·9</Check>
            </Menu>
            <Menu label={t('Livelli')} count={lvlCount}>
              <Check on={tg.key} onClick={() => flip('key')}>{t('Livelli chiave')}</Check>
              <Check on={tg.zones} onClick={() => flip('zones')}>{t('Zone di supporto e resistenza')}</Check>
              <Check on={tg.swings} onClick={() => flip('swings')}>{t('Massimi e minimi (swing)')}</Check>
              <Check on={tg.fib} onClick={() => flip('fib')}>{t('Ritracciamento di Fibonacci')}</Check>
              <Check on={tg.pivots} onClick={() => flip('pivots')}>Pivot</Check>
              {tg.pivots && (
                <div className="flex flex-col gap-2 px-2 pb-1 pt-2">
                  <Segmented value={pivType} onChange={setPivType} options={[{ value: 'classic', label: t('Classici') }, { value: 'fibonacci', label: 'Fibonacci' }, { value: 'camarilla', label: 'Camarilla' }]} />
                  <Segmented value={pivPeriod} onChange={setPivPeriod} options={[{ value: 'daily', label: t('Giorno') }, { value: 'weekly', label: t('Settimana') }, { value: 'monthly', label: t('Mese') }]} />
                </div>
              )}
            </Menu>
            <Toggle on={tg.log} onClick={() => flip('log')}>Log</Toggle>
            <div className="ml-auto">{ann.toolbar}</div>
          </div>
          <CardBody className="pt-3">
            {ann.banner}
            <Q q={cq} loading={<Skeleton style={{ height: CHART_H }} />} isEmpty={(d) => !d.length}>
              {(candles) => (
                <ProChart candles={candles} liveTf={tf as LiveTf} height={CHART_H} lines={lines} priceLines={priceLines} markers={lvl.markers} zones={lvl.zones}
                  panes={panes} volume={tg.volume} logScale={tg.log} tfLabel={tfName} fitKey={tf}
                  annotations={ann.defs} onPick={ann.onPick} pickDraft={ann.pickDraft} onAnnotationClick={ann.onAnnotationClick} />
              )}
            </Q>
            {(iq.isError || lq.isError) && <p className="mt-2 text-xs text-amber-400">{t('Alcuni overlay non sono disponibili ({x}).', { x: [iq.isError && t('indicatori'), lq.isError && t('livelli')].filter(Boolean).join(', ') })}</p>}
          </CardBody>
        </Card>
        {/* ≥2xl side rail: exactly as tall as the chart card, its cards scroll inside it */}
        <div className="flex flex-col gap-3 2xl:h-0 2xl:min-h-full 2xl:overflow-y-auto 2xl:pr-1 [scrollbar-width:thin] [&>*]:shrink-0">
          {ann.panel}
          <Card>
            <CardHeader title={t('Indicatori')} subtitle={`Timeframe ${tfName}`} updatedAt={iq.dataUpdatedAt} icon={<CandlestickChart />} />
            <CardBody className="px-1 pb-2"><Q q={iq} compact isEmpty={(d) => !d.summary.length}>{(d) => <IndicatorSummary items={d.summary} />}</Q></CardBody>
          </Card>
          <LevelsCard tf={tf === '1w' ? '1w' : tf === '4h' || tf === '1h' || tf === '15m' ? '4h' : '1d'} />
          {fib && (
            <Card>
              <CardHeader title="Fibonacci" icon={<Ruler />} subtitle={`${usd(fib.from.price)} → ${usd(fib.to.price)}`} />
              <CardBody className="pt-0">
                <div className="dgrid grid-cols-2">
                  {fib.levels.map((l) => (
                    <div key={l.ratio} className="flex items-baseline justify-between gap-2 px-3 py-2 text-sm">
                      <span className="tnum text-slate-400">{(l.ratio * 100).toFixed(1)}%</span>
                      <span className="tnum text-white">{usd(l.price)}</span>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
      <RuleEditorHost />
      {ann.textModal}
    </div>
  )
}
