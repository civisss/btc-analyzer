import { useTab } from '../lib/useTab'
import { useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3, Clock, Gauge, Layers, Percent, Scale, Signal, Tag, Users } from 'lucide-react'
import { useCandles, useDerivatives } from '../api/client'
import { useLive } from '../api/live'
import type { Derivatives } from '../api/types'
import { C } from '../components/charts/theme'
import { Card, CardBody, CardHeader, Change, Fill, KpiCell, KpiStrip, PageTitle, Q, Segmented, Skeleton, TabBar } from '../components/ui'
import { TimeLinesChart, candlesToPts } from '../widgets/charts'
import { FlowsSection, SignalList } from '../widgets/flows'
import { BasisTab, CmeTab, LeverageTab } from '../widgets/derivPro'
import { dayUnit, pct, usd, usdCompact } from '../lib/format'
import { t } from '../i18n'

function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor(to - now / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return <span className="tnum">{String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(ss).padStart(2, '0')}</span>
}

function LiveStats({ d }: { d: Derivatives }) {
  const mark = useLive((s) => s.mark)
  const fr = mark?.funding_rate ?? d.funding.current
  const premium = mark ? ((mark.mark - mark.index) / mark.index) * 100 : d.basis.premium
  const longPct = d.long_short.current_long_pct // percent (0..100) per CONTRACT
  return (
    <KpiStrip>
      <KpiCell icon={<Percent />} label={t('Funding attuale')} value={pct(fr, 4)} foot={t('Per 8h · annuo {v}', { v: pct(fr * 3 * 365, 1) })} />
      <KpiCell icon={<Clock />} label={t('Prossimo funding')} value={mark?.next_funding ? <Countdown to={mark.next_funding} /> : '—'} foot={t('Media {n} {v}', { n: `7${dayUnit()}`, v: pct(d.funding.avg_7d, 4) })} />
      <KpiCell icon={<Layers />} label="Open interest" value={usdCompact(d.open_interest.current_usd)} delta={<Change value={d.open_interest.change_24h} suffix="24h" />} />
      <KpiCell icon={<Users />} label={t('Long (account)')} value={`${longPct.toFixed(1)}%`} foot={`Short ${(100 - longPct).toFixed(1)}%`} />
      <KpiCell icon={<Tag />} label="Mark price" value={usd(mark?.mark ?? d.basis.mark)} foot={`Index ${usd(mark?.index ?? d.basis.index)}`} />
      <KpiCell icon={<Gauge />} label="Premium / basis" value={pct(premium, 3)} foot={t('Media {n} {v}', { n: `30${dayUnit()}`, v: pct(d.funding.avg_30d, 4) })} />
    </KpiStrip>
  )
}

const fundFmt = (v: number) => `${v.toFixed(3)}%`
const oiFmt = (v: number) => usdCompact(v, 1)
const ratioFmt = (v: number) => v.toFixed(2)
const ONE_LINE = [{ y: 1, color: 'rgba(148,163,184,0.6)' }]

function DerivCharts({ d, updatedAt }: { d: Derivatives; updatedAt: number }) {
  const [lsKind, setLsKind] = useState<'accounts' | 'top_traders' | 'taker'>('accounts')
  const fundLines = useMemo(() => [{ name: 'Funding', data: d.funding.series, color: C.blue, type: 'bar' as const }], [d.funding.series])
  const oiLines = useMemo(() => [{ name: 'Open Interest', data: d.open_interest.series, color: C.blue, area: true }], [d.open_interest.series])
  const lsLines = useMemo(() => [{ name: 'Long/Short', data: d.long_short[lsKind], color: C.blue, area: true }], [d.long_short, lsKind])
  const cq = useCandles('1h', 1000)
  const oiS = d.open_interest.series
  const oiPxLines = useMemo(() => {
    const from = oiS[0]?.time ?? 0
    return [
      { name: 'Open interest', data: oiS, color: C.blue, area: true },
      { name: t('Prezzo BTC'), data: candlesToPts((cq.data ?? []).filter((c) => c.time >= from)), color: C.btc, axis: 1 as const, width: 1.4, dashed: true },
    ]
  }, [oiS, cq.data])
  const span = oiS.length > 1 ? Math.round((oiS[oiS.length - 1].time - oiS[0].time) / 86400) : 0
  const oiVals = oiS.map((p) => p.value).filter((v): v is number => v != null)
  const oiFirst = oiS.find((p) => p.value != null)?.value, oiLast = [...oiS].reverse().find((p) => p.value != null)?.value
  const oiMax = oiVals.length ? Math.max(...oiVals) : null
  const oiMin = oiVals.length ? Math.min(...oiVals) : null
  const oiChg = oiFirst && oiLast ? (oiLast / oiFirst - 1) * 100 : null
  const last = (a: { value: number | null }[]) => [...a].reverse().find((p) => p.value != null)?.value ?? null
  const lsTop = last(d.long_short.top_traders), lsTaker = last(d.long_short.taker), lsAcc = last(d.long_short.accounts)
  const stats = [
    { k: t('OI massimo'), v: oiMax != null ? usdCompact(oiMax, 2) : '—', f: oiMax != null && d.open_interest.current_usd ? t('Attuale {p} dal massimo', { p: pct((d.open_interest.current_usd / oiMax - 1) * 100, 1) }) : '—' },
    { k: t('OI minimo'), v: oiMin != null ? usdCompact(oiMin, 2) : '—', f: oiMin != null && d.open_interest.current_usd ? t('Attuale {p} dal minimo', { p: pct((d.open_interest.current_usd / oiMin - 1) * 100, 1) }) : '—' },
    { k: t('Variazione OI'), v: oiChg != null ? pct(oiChg, 1) : '—', f: t('Su {n}', { n: `${span}${dayUnit()}` }) },
    { k: t('Funding annuo'), v: pct(d.funding.annualized, 1), f: t('Media {n} {v}', { n: `7${dayUnit()}`, v: pct(d.funding.avg_7d, 4) }) },
    { k: t('L/S account'), v: lsAcc != null ? ratioFmt(lsAcc) : '—', f: t('Long/short per numero di account') },
    { k: t('L/S top trader'), v: lsTop != null ? ratioFmt(lsTop) : '—', f: t('Posizioni dei top trader') },
    { k: t('Acquisti/vendite taker'), v: lsTaker != null ? ratioFmt(lsTaker) : '—', f: lsTaker != null ? (lsTaker >= 1 ? t('Prevalgono gli acquisti') : t('Prevalgono le vendite')) : '—' },
    { k: t('Basis'), v: pct(d.basis.premium, 3), f: `Mark ${usd(d.basis.mark)}` },
  ]
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Funding rate" subtitle={t('Percentuale per 8 ore')} icon={<Activity />} updatedAt={updatedAt} />
          <CardBody><TimeLinesChart height={300} legend={false} lines={fundLines} yFmt={fundFmt} zoom compactTip /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Open interest" subtitle={t('Valore nozionale in USD')} icon={<Layers />} />
          <CardBody><TimeLinesChart height={300} legend={false} lines={oiLines} yFmt={oiFmt} zoom compactTip /></CardBody>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="h-full xl:col-span-8">
          <CardHeader title={t('Rapporto long/short')} icon={<Scale />}
            right={<Segmented value={lsKind} onChange={setLsKind} options={[{ value: 'accounts', label: t('Account') }, { value: 'top_traders', label: t('Top trader') }, { value: 'taker', label: t('Acquisti/vendite taker') }]} />} />
          <CardBody className="flex flex-col"><Fill min={300}><TimeLinesChart height="100%" legend={false} lines={lsLines} yFmt={ratioFmt} markLines={ONE_LINE} compactTip /></Fill></CardBody>
        </Card>
        <Card className="h-full xl:col-span-4">
          <CardHeader title={t('Segnali')} icon={<Signal />} />
          <CardBody className="pt-0"><SignalList signals={d.signals} /></CardBody>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="h-full xl:col-span-8">
          <CardHeader title={t('Open interest vs prezzo')} subtitle={t("Candele 1h · prezzo sull'asse destro")} icon={<BarChart3 />} />
          <CardBody className="flex flex-col"><Fill min={300}><TimeLinesChart height="100%" lines={oiPxLines} yFmt={oiFmt} y2Fmt={(v) => usdCompact(v, 0)} compactTip /></Fill></CardBody>
        </Card>
        <Card className="h-full xl:col-span-4">
          <CardHeader title={t('Statistiche del periodo')} subtitle={t('Ultimi {n} dei dati derivati', { n: `${span}${dayUnit()}` })} icon={<Gauge />} />
          <CardBody className="pt-0">
            <div className="dgrid grid-cols-2">
              {stats.map((x) => (
                <div key={x.k} className="px-3 py-2.5">
                  <div className="label">{x.k}</div>
                  <div className="tnum mt-1 text-lg font-semibold text-white">{x.v}</div>
                  <div className="tnum truncate text-xs text-slate-400">{x.f}</div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  )
}

type Tab = 'deriv' | 'flows' | 'basis' | 'cme' | 'leverage'
const TABS: Tab[] = ['deriv', 'flows', 'basis', 'cme', 'leverage']
const SUBTITLE: Record<Tab, string> = {
  deriv: 'Funding rate, open interest, rapporti long/short e basis dei futures perpetui.',
  flows: 'Flussi taker su Binance: spot e futures perpetui a confronto.',
  basis: 'Basis annualizzato dei futures a scadenza: curva Deribit e Binance, storico trimestrale dal 2020.',
  cme: 'Posizionamento istituzionale sui futures Bitcoin CME (CFTC Commitments of Traders) dal 2018.',
  leverage: 'Open interest e funding aggregati di Binance, Bybit e OKX, con storico e verifica incrociata.',
}
export default function DerivativesPage() {
  const [tab, changeTab] = useTab<Tab>(TABS, 'deriv')
  return (
    <div>
      <PageTitle title={t('Derivati')} subtitle={t(SUBTITLE[tab])} />
      <TabBar value={tab} onChange={changeTab} tabs={[
        { value: 'deriv', label: t('Futures perpetui') }, { value: 'flows', label: t('Spot vs Futures') },
        { value: 'basis', label: t('Basis e curva') }, { value: 'cme', label: 'CME' }, { value: 'leverage', label: t('Leva aggregata') },
      ]} />
      {tab === 'deriv' ? <DerivativesTab /> : tab === 'flows' ? <FlowsSection /> : tab === 'basis' ? <BasisTab /> : tab === 'cme' ? <CmeTab /> : <LeverageTab />}
    </div>
  )
}

function DerivativesTab() {
  const q = useDerivatives()
  return (
    <>
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-80" /></div>}>
        {(d) => (
          <div className="flex flex-col gap-3">
            <LiveStats d={d} />
            <DerivCharts d={d} updatedAt={q.dataUpdatedAt} />
          </div>
        )}
      </Q>
    </>
  )
}
