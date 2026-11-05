/* Mappa delle liquidazioni per leva: stima dal modello interno, non ordini reali. */
import { useMemo, useState } from 'react'
import { Layers } from 'lucide-react'
import { useLevMap, type LevMap, type LevWindow } from '../api/scoreboard'
import EChart from '../components/charts/EChart'
import { C, axisLabel, hexA, tooltipBase, usdAxis } from '../components/charts/theme'
import { Card, CardBody, CardHeader, Legend, MethodNote, Q, Segmented, Skeleton } from '../components/ui'
import { dateTime, pct, usd, usdCompact } from '../lib/format'
import { t, tfLabel } from '../i18n'
import { T } from '../theme/tokens'

const COLORS = [T.steel, T.sand, T.accent]
const NAMES = () => ['5–25×', '50×', '100×']
const HEIGHT = 720

type Rect = { value: [number, number, number, number, number]; side: 'long' | 'short' }

/** One custom series per leverage group: rectangles x0→x1 over the band y→y+step. */
function rects(w: LevWindow, g: number): Rect[] {
  const out: Rect[] = []
  for (const b of w.bands) {
    for (const side of ['long', 'short'] as const) {
      const v = b[side]
      const x0 = v.slice(0, g).reduce((a, x) => a + x, 0)
      if (v[g] > 0) out.push({ value: [x0, x0 + v[g], b.p, b.p + w.step, v[g]], side })
    }
  }
  return out
}

function chartOption(w: LevWindow) {
  const max = Math.max(1, ...w.bands.flatMap((b) => [b.long.reduce((a, x) => a + x, 0), b.short.reduce((a, x) => a + x, 0)]))
  const renderItem = (_: unknown, api: { value: (i: number) => number; coord: (p: number[]) => number[]; style: () => object }) => {
    const a = api.coord([api.value(0), api.value(3)])
    const b = api.coord([api.value(1), api.value(2)])
    return { type: 'rect', shape: { x: a[0], y: a[1] + 0.5, width: Math.max(b[0] - a[0], 1), height: Math.max(b[1] - a[1] - 1, 1) }, style: api.style() }
  }
  const labels = [...w.clusters.short, ...w.clusters.long].map((c) => ({
    value: [max * 1.02, (c.lo + c.hi) / 2],
    label: { formatter: `${usdAxis(c.lo)}–${usdAxis(c.hi)} ~${usdCompact(c.usd, 0)}` },
  }))
  return {
    animation: false,
    grid: { left: 4, right: 58, top: 8, bottom: 26 },
    xAxis: { type: 'value', min: 0, max: max * 1.04, axisLabel: { ...axisLabel, showMaxLabel: false, formatter: (v: number) => (v ? usdCompact(v, 0) : '0') }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: true, lineStyle: { color: C.grid } } },
    yAxis: { type: 'value', position: 'right', min: w.from, max: w.to, interval: 2000, axisLabel: { ...axisLabel, formatter: usdAxis }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    tooltip: {
      ...tooltipBase, trigger: 'item', confine: true,
      formatter: (p: { seriesName: string; data: Rect }) => `${usdAxis(p.data.value[2])}–${usdAxis(p.data.value[3])}<br/>${p.data.side === 'long' ? t('Long') : t('Short')} ${p.seriesName}: <b>${usdCompact(p.data.value[4], 1)}</b>`,
    },
    series: [
      ...NAMES().map((n, g) => ({
        type: 'custom', name: n, renderItem, encode: { x: [0, 1], y: [2, 3] }, itemStyle: { color: COLORS[g] }, data: rects(w, g), clip: true,
        ...(g === 0 ? {
          markArea: { silent: true, data: [
            [{ yAxis: w.price, itemStyle: { color: hexA(T.up, 0.05) } }, { yAxis: w.to }],
            [{ yAxis: w.from, itemStyle: { color: hexA(T.down, 0.05) } }, { yAxis: w.price }],
          ] },
          markLine: { silent: true, symbol: 'none', lineStyle: { color: T.fg, type: 'dashed', width: 1 }, label: { position: 'insideStartTop', color: T.fg, fontSize: 11, formatter: `${t('Prezzo')} ${usd(w.price)}` }, data: [{ yAxis: w.price }] },
        } : {}),
      })),
      {
        type: 'scatter', name: '_clusters', silent: true, symbolSize: 0, data: labels, tooltip: { show: false }, z: 5,
        itemStyle: { opacity: 1 }, label: { show: true, position: 'left', color: T.onAccent, backgroundColor: T.accent, opacity: 1, fontWeight: 600, fontSize: 11, padding: [3, 6], borderRadius: 5 },
      },
    ],
  }
}

function Compare({ d }: { d: LevMap }) {
  const v = d.validation, c = d.side_check
  const share = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && a + b > 0 ? (a / (a + b)) * 100 : null)
  const cells = [
    { l: t('Correlazione oraria'), v: v?.spearman != null ? (v.spearman < 0 ? '−' : '') + Math.abs(v.spearman).toFixed(2) : '—', s: t('{h} ore · {n} eventi', { h: v?.hours ?? 0, n: v?.events ?? 0 }) },
    { l: t('Nelle zone dense'), v: pct(v?.price_hit_pct, 0, false), s: t('Per caso {e} · lift {l}', { e: pct(v?.price_expected_pct, 0, false), l: v?.price_lift != null ? `${v.price_lift.toFixed(2)}×` : '—' }) },
    { l: t('Quota long, modello'), v: pct(share(c?.model_long, c?.model_short), 0, false), s: usdCompact((c?.model_long ?? 0) + (c?.model_short ?? 0), 1) },
    { l: t('Quota long, reale'), v: pct(share(c?.real_long, c?.real_short), 0, false), s: t('{v} in {h} ore raccolte', { v: usdCompact((c?.real_long ?? 0) + (c?.real_short ?? 0), 1), h: c?.hours ?? 0 }) },
  ]
  return (
    <div className="dgrid grid-cols-2 lg:grid-cols-4">
      {cells.map((x) => (
        <div key={x.l} className="min-w-0 px-3 py-2.5">
          <div className="label truncate">{x.l}</div>
          <div className="tnum mt-1 truncate text-lg font-semibold text-white">{x.v}</div>
          <div className="tnum truncate text-xs text-fg-3">{x.s}</div>
        </div>
      ))}
    </div>
  )
}

function Body({ d, updatedAt }: { d: LevMap; updatedAt: number }) {
  const [win, setWin] = useState<'1d' | '7d'>('7d')
  const w = d.windows[win]
  const option = useMemo(() => chartOption(w), [w])
  return (
    <>
      <CardHeader icon={<Layers />} title={t('Mappa delle liquidazioni per leva')} updatedAt={updatedAt} subtitle={t('Stima, non ordini reali. Fasce da {s}, posizioni aperte nella finestra', { s: usdAxis(w.step) })}
        info={t('Stima del modello interno su OI Binance + Bybit + OKX e mix di leva dichiarato. CoinGlass vende una mappa simile, con dati e ipotesi proprie: i livelli possono differire.')}
        right={<Segmented value={win} onChange={setWin} options={[{ value: '1d', label: tfLabel('1d') }, { value: '7d', label: tfLabel('7d') }]} />} />
      <CardBody className="flex flex-col gap-3 pt-0">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <Legend items={NAMES().map((n, i) => ({ label: n, color: COLORS[i] })).reverse()} />
          <div className="tnum flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold">
            <span className="text-up">{t('Short sopra {v}', { v: usdCompact(w.short_above, 2) })}</span>
            <span className="text-down">{t('Long sotto {v}', { v: usdCompact(w.long_below, 2) })}</span>
          </div>
        </div>
        <EChart option={option} height={HEIGHT} />
        <div>
          <div className="label mb-1.5">{t('Modello contro liquidazioni reali raccolte')}</div>
          <Compare d={d} />
        </div>
      </CardBody>
    </>
  )
}

export function LeverageMapCard() {
  const q = useLevMap()
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <Q q={q} loading={<div className="p-5"><Skeleton className="h-[720px]" /></div>}>{(d) => <Body d={d} updatedAt={q.dataUpdatedAt} />}</Q>
      </Card>
      {q.data && (
        <MethodNote title={t('Come leggere la mappa')}>
          <p>{t('Ogni barra somma le liquidazioni stimate delle posizioni aperte nella finestra e ancora vive: quando l\'OI cresce, il nuovo nozionale è diviso tra long e short e distribuito sul mix di leva; un livello sparisce se il prezzo lo attraversa. Il prezzo è l\'ultima chiusura da 15 minuti del modello ({d}).', { d: dateTime(q.data.windows['7d'].time) })}</p>
          <p>{t('Mix di leva ipotizzato: {m}. Margine di mantenimento {r}. Il gruppo 5–25× somma 5×, 10×, 20× e 25×.', { m: q.data.weights.map((x) => `${x.lev}× ${x.pct.toFixed(0)}%`).join(', '), r: pct(q.data.mmr_pct, 1, false) })}</p>
          <p>{t('Il confronto con la realtà usa solo le ore con la raccolta accesa. Binance invia al massimo un evento al secondo, per cui gli importi reali sono sottostimati nei picchi: conta la quota tra i lati più della scala.')}</p>
        </MethodNote>
      )}
    </div>
  )
}
