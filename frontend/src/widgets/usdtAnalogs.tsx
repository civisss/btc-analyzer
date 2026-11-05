/* Widget della scheda "Analoghi USDT" e "Stablecoin" della pagina USDT: curva della USDT.D con gambe, figure e punti numerati,
 * percorsi di BTC dopo gli analoghi (mediana + banda), tabella delle gambe in punti percentuali, specchio BTC↔USDT.D,
 * tecnica sulla USDT.D (EMA, RSI, zone), grafici di supply/dominance/SSR/mint-burn delle stablecoin. */
import { useMemo } from 'react'
import type { UsdtAnalogMatch, UsdtAnalogs, UsdtLeg, UsdtMapping, UsdtMirror, UsdtPattern, UsdtTechnicals, UsdtTf, Stablecoins } from '../api/usdtAnalogs'
import type { AnalogLegPair } from '../api/analogs'
import EChart from '../components/charts/EChart'
import type { UsdtAnalysis } from '../api/types'
import { C, axisLabel, dataZoomInside, dataZoomSlider, dateFmt, hexA, legendBase, lineSeries, timeAxis, tooltipBase, usdAxisFmt, valueAxis } from '../components/charts/theme'
import { clsx } from '../components/ui'
import { date, dateTime, pct, pts, usd, usdCompact } from '../lib/format'
import { plabel, tickLabel } from './analogs'
import { cap, t, tfLabel, tr } from '../i18n'

type TipP = { dataIndex: number; seriesName: string; value: unknown; color: string; axisValue?: string | number }
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`
const fullTime = (t: number, tf: UsdtTf) => (tf === '4h' ? dateTime(t) : date(t))
/** USDT.D is always the blue series; the analog curve is violet; BTC (price) keeps the orange. */
export const USDT_COLOR = C.accent
export const ANALOG_COLOR = C.steel
/** Overlay styles (palette only: levels neutral, figures violet/teal; colour never encodes "good/bad"). */
export const LEG_COLOR = C.accent
export const LINE_STYLE: Record<string, { color: string; type: 'solid' | 'dashed' | 'dotted'; width: number }> = {
  resistance: { color: C.grey, type: 'dashed', width: 1.4 },
  support: { color: C.grey2, type: 'dashed', width: 1.4 },
  neckline: { color: C.sand, type: 'dashed', width: 1.6 },
  pole: { color: C.sand, type: 'solid', width: 1.6 },
  leg: { color: C.steel, type: 'dotted', width: 1.4 },
}
/** Numbered structural points: neutral markers (the number carries the identity). */
export const pointColor = (_n: number) => C.text
const MUTED_DIV = `<div style="color:${C.muted};margin-bottom:4px">`
const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** "nel 2023" / "in 2023" → "2023" (backend `period.when`). */
export const stripWhen = (w: string) => w.replace(/^(nel|in) /i, '')

/** Linear-interpolated quantile of a sorted array. */
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}
/** Median + P25/P75 of the BTC outcomes (% after the window) across all analogs. */
export function analogMedian(matches: UsdtAnalogMatch[]): { n: number; p25: number | null; p50: number | null; p75: number | null } {
  const xs = matches.map((m) => m.outcome.change).filter(ok).sort((a, b) => a - b)
  return { n: xs.length, p25: quantile(xs, 0.25), p50: quantile(xs, 0.5), p75: quantile(xs, 0.75) }
}

/** Same span (in pt) for side-by-side USDT.D charts, each centred on its own level. */
export function usdtRanges(a: number[], b: number[]): [[number, number], [number, number]] {
  const r = (x: number[]) => [Math.min(...x), Math.max(...x)] as const
  const [a0, a1] = r(a)
  const [b0, b1] = r(b)
  const span = Math.max(a1 - a0, b1 - b0) * 1.18 || 0.2
  const fit = (lo: number, hi: number): [number, number] => {
    const mid = (lo + hi) / 2
    return [+(mid - span / 2).toFixed(3), +(mid + span / 2).toFixed(3)]
  }
  return [fit(a0, a1), fit(b0, b1)]
}

// ------------------------------------------------------------------ curva USDT.D con gambe, figure e punti
export function UsdtCurve({
  times, values, btc, windowLen, side, mapping, legs, patterns, tf, yMin, yMax, height = 360, active, accent, showBtc = true, layers,
}: {
  times: number[]; values: number[]; btc?: number[]; windowLen: number; side: 'current' | 'analog'; mapping: UsdtMapping[]
  legs: UsdtLeg[]; patterns: UsdtPattern[]; tf: UsdtTf; yMin: number; yMax: number; height?: number; active?: number | null
  accent: string; showBtc?: boolean; layers: { points: boolean; legs: boolean; patterns: boolean }
}) {
  const option = useMemo(() => {
    const n = times.length
    const win = values.slice(0, windowLen)
    const after = values.length > windowLen ? [...new Array(windowLen - 1).fill(null), values[windowLen - 1], ...values.slice(windowLen)] : []
    const zz: (number | null)[] = new Array(n).fill(null)
    if (layers.legs) legs.forEach((g) => { zz[g.from_idx] = g.from_price; zz[g.to_idx] = g.to_price })
    const legLabels = layers.legs ? [...legs].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 4).map((g) => ({
      coord: [Math.round((g.from_idx + g.to_idx) / 2), (g.from_price + g.to_price) / 2], value: g.label, symbol: 'roundRect', symbolSize: [1, 1],
      label: { show: true, formatter: `${g.label} ${pts(g.pts, 2)}`, color: C.text, fontSize: 11, fontWeight: 500, backgroundColor: C.raised, borderColor: hexA(LEG_COLOR, 0.5), borderWidth: 1, padding: [2, 4], borderRadius: 4 },
    })) : []
    const mp = layers.points ? mapping.map((m) => {
      const pt = m[side]
      const big = active === m.n
      return {
        coord: [pt.idx, pt.price], value: m.n, symbol: 'circle', symbolSize: big ? 24 : 18,
        symbolOffset: [0, m.kind === 'high' ? -15 : m.kind === 'low' ? 15 : 0],
        itemStyle: { color: big ? C.accent : pointColor(m.n), borderColor: C.bg, borderWidth: 2 },
        label: { show: true, formatter: String(m.n), color: C.bg, fontWeight: 600, fontSize: big ? 12 : 10 },
      }
    }) : []
    const patLines: unknown[] = []
    if (layers.patterns) patterns.slice(0, 2).forEach((p, pi) => p.lines.forEach((ln, li) => {
      const st = LINE_STYLE[ln.kind] ?? LINE_STYLE.leg
      const [a, b] = ln.points
      patLines.push([
        { coord: [a.idx, a.price], lineStyle: { color: st.color, type: st.type, width: st.width, opacity: pi === 0 ? 0.95 : 0.55 } },
        { coord: [b.idx, b.price], label: li === 0 ? { show: true, formatter: p.name, color: st.color, fontSize: 11, fontWeight: 500, position: 'insideEndTop', backgroundColor: hexA(C.bg, 0.85), padding: [2, 4], borderRadius: 4 } : { show: false } },
      ])
    }))
    const series: unknown[] = [
      lineSeries('USDT.D', [...win, ...new Array(n - win.length).fill(null)], accent, {
        z: 5, lineStyle: { width: 1.75, color: accent },
        markLine: { symbol: 'none', silent: true, animation: false, data: patLines },
        markPoint: { data: [...legLabels, ...mp], animation: false },
      }),
    ]
    if (after.length) series.push(lineSeries(t('USDT.D dopo'), [...after, ...new Array(Math.max(0, n - after.length)).fill(null)], accent, {
      lineStyle: { width: 1.5, color: accent, type: 'dashed', opacity: 0.75 },
      markLine: { symbol: 'none', silent: true, lineStyle: { color: hexA(C.primary, 0.3), type: 'dashed' }, label: { color: C.muted, formatter: t('Fine finestra'), fontSize: 10 }, data: [{ xAxis: windowLen - 1 }] },
    }))
    if (layers.legs && legs.length) series.push({ type: 'line', name: t('Gambe'), data: zz, connectNulls: true, showSymbol: true, symbol: 'circle', symbolSize: 4, z: 4, silent: true, lineStyle: { color: LEG_COLOR, width: 1.25, opacity: 0.85 }, itemStyle: { color: LEG_COLOR } })
    if (showBtc && btc?.length) series.push(lineSeries('BTC', btc, hexA(C.price, 0.55), { yAxisIndex: 1, z: 2, lineStyle: { width: 1.25, color: hexA(C.price, 0.55) } }))
    return {
      grid: { left: 6, right: 6, top: 26, bottom: 6, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => {
          const i = ps[0]?.dataIndex ?? 0
          const v = values[i]
          const hit = mapping.filter((m) => m[side].idx === i)
          const leg = legs.find((g) => i >= g.from_idx && i <= g.to_idx)
          return `${MUTED_DIV}${i < windowLen ? t('Candela {n}', { n: i + 1 }) : t('+{n} dopo', { n: i - windowLen + 1 })} · ${fullTime(times[i], tf)}</div>` +
            tipRow(accent, 'USDT.D', `${v?.toFixed(3)}% (${pts(v - values[0], 2)})`) +
            (btc?.[i] ? tipRow(C.price, 'BTC', usd(btc[i])) : '') +
            (leg && i < windowLen ? tipRow(LEG_COLOR, t('Gamba {l} · {n} candele', { l: leg.label, n: leg.candles }), pts(leg.pts, 2)) : '') +
            hit.map((m) => tipRow(pointColor(m.n), `${m.n}. ${side === 'current' ? m.label : m.analog_label}`, '')).join('')
        },
      },
      xAxis: { type: 'category', data: times.map(String), boundaryGap: false, axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: string) => tickLabel(Number(v), tf) }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: [
        valueAxis({ position: 'right', scale: false, min: yMin, max: yMax, axisLabel: { ...axisLabel, formatter: (v: number) => `${v.toFixed(2)}%` } }),
        valueAxis({ position: 'left', show: showBtc && !!btc?.length, inverse: true, name: t('BTC ↓ invertito'), nameLocation: 'start', nameGap: 8, nameTextStyle: { color: C.muted, fontSize: 11, align: 'left' }, splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => usdCompact(v, 0) } }),
      ],
      series,
    }
  }, [times, values, btc, windowLen, side, mapping, legs, patterns, tf, yMin, yMax, active, accent, showBtc, layers])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ percorsi BTC (o USDT.D) dopo gli analoghi
export function AfterPathsChart({ d, mode, sel, height = 360 }: { d: UsdtAnalogs; mode: 'btc' | 'usdt'; sel: number; height?: number | string }) {
  const option = useMemo(() => {
    const hz = Math.max(...d.matches.map((m) => m.projection.close.length), 0)
    const xs = Array.from({ length: hz + 1 }, (_, i) => i)
    const base = mode === 'btc' ? d.current.btc : d.current.usdt_d
    const fmt = (v: number) => (mode === 'btc' ? usd(v) : `${v.toFixed(3)}%`)
    const BAND = t('Banda 25–75%')
    const MED = t('Mediana analoghi')
    const selName = `#${d.matches[sel]?.rank} ${plabel(d.matches[sel]?.period.label)}`
    const series: unknown[] = []
    const band = d.summary.band
    if (mode === 'btc' && band) {
      series.push(lineSeries('_p25', [base, ...band.p25], 'transparent', { stack: 'b', lineStyle: { width: 0 }, tooltip: { show: false } }))
      series.push(lineSeries(BAND, [0, ...band.p75.map((v, i) => v - band.p25[i])], 'transparent', { stack: 'b', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.accent, 0.1) } }))
    }
    d.matches.forEach((m, i) => {
      const vals = mode === 'btc' ? m.projection.close : m.usdt_projection.value
      const isSel = i === sel
      const col = isSel ? C.accent : C.grey
      // selected analog = secondary reference: dashed, labelled with its period (legend); the median is the headline
      series.push(lineSeries(`#${m.rank} ${plabel(m.period.label)}`, [base, ...vals], col, {
        z: isSel ? 8 : 3, lineStyle: { width: isSel ? 1.75 : 1.1, color: col, opacity: isSel ? 0.95 : 0.4, type: isSel ? 'dashed' : 'solid' },
      }))
    })
    if (band) {
      const med = mode === 'btc' ? band.p50 : band.usdt_p50
      series.push(lineSeries(MED, [base, ...med], C.primary, {
        z: 10, lineStyle: { width: 2.25, color: C.primary },
        markLine: { symbol: 'none', silent: true, lineStyle: { color: hexA(C.primary, 0.35), type: 'dotted' }, label: { color: C.muted, fontSize: 11, position: 'insideStartTop', formatter: `${t('Oggi')} ${fmt(base)}` }, data: [{ yAxis: base }] },
      }))
    }
    return {
      grid: { left: 6, right: 6, top: 36, bottom: 6, containLabel: true },
      legend: { ...legendBase, data: [MED, ...(mode === 'btc' && band ? [BAND] : []), selName] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => {
          const x = ps[0]?.dataIndex ?? 0
          return `${MUTED_DIV}${x === 0 ? t('Oggi') : `+${x} ${d.tf === '1d' ? t('giorni') : t('candele {tf}', { tf: tfLabel('4h') })}`}</div>` +
            ps.filter((p) => ok(p.value) && !p.seriesName.startsWith('_') && p.seriesName !== BAND).map((p) => {
              const v = p.value as number
              const chg = mode === 'btc' ? pct((v / base - 1) * 100, 1) : pts(v - base, 2)
              return tipRow(p.color, p.seriesName, `${fmt(v)} · ${chg}`)
            }).join('')
        },
      },
      xAxis: { type: 'category', data: xs.map(String), boundaryGap: false, axisLabel: { ...axisLabel, formatter: (v: string) => (v === '0' ? t('Oggi') : `+${v}`) }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
      yAxis: valueAxis({ position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => (mode === 'btc' ? usdCompact(v, 0) : `${v.toFixed(2)}%`) } }),
      series,
    }
  }, [d, mode, sel])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ gambe in punti percentuali
export function UsdtLegTable({ pairs, cur, ana, when }: { pairs: AnalogLegPair[]; cur: UsdtLeg[]; ana: UsdtLeg[]; when: string }) {
  if (!pairs.length) return <p className="px-3 text-sm text-fg-3">{t('Nessuna gamba abbinata.')}</p>
  // per la USDT.D una gamba in salita è sfavorevole a BTC: colore invertito
  const col = (v: number) => (v > 0 ? 'text-down' : v < 0 ? 'text-up' : 'text-fg-2')
  return (
    <div className="no-scrollbar overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>{t('Gamba')}</th><th className="text-right">{t('Oggi')}</th><th className="text-right">{stripWhen(when)}</th><th className="min-w-[120px]">{t('Somiglianza')}</th></tr></thead>
        <tbody>
          {pairs.map((p, i) => {
            const a = cur[p.current - 1]
            const b = ana[p.analog - 1]
            if (!a || !b) return null
            return (
              <tr key={i}>
                <td className="font-medium text-fg">G{p.current}{b.n !== p.current ? <span className="ml-1 text-xs font-normal text-fg-4">↔ {tr(`${b.n}ª`, `#${b.n}`)}</span> : null}</td>
                <td className="text-right"><span className={clsx('font-medium', col(a.pts))}>{pts(a.pts, 2)}</span> <span className="text-xs text-fg-3">{pct(a.pct, 1)} · {a.candles} {t('cand.')}</span></td>
                <td className="text-right"><span className={clsx('font-medium', col(b.pts))}>{pts(b.pts, 2)}</span> <span className="text-xs text-fg-3">{pct(b.pct, 1)} · {b.candles} {t('cand.')}</span></td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-accent" style={{ width: `${p.similarity}%` }} /></div>
                    <span className="tnum text-xs">{Math.round(p.similarity)}%</span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ punti strutturali
export function UsdtMappingList({ mapping, tf, when, active, onHover, twoCol }: { mapping: UsdtMapping[]; tf: UsdtTf; when: string; active: number | null; onHover: (n: number | null) => void; /** full-width card: two columns from xl */ twoCol?: boolean }) {
  return (
    <div className={clsx('grid content-start', twoCol && 'xl:grid-cols-2 xl:gap-x-8 xl:[&>*:nth-child(2)]:border-t-0')}>
      {mapping.map((m) => (
        <div key={m.n} onMouseEnter={() => onHover(m.n)} onMouseLeave={() => onHover(null)}
          className={clsx('grid grid-cols-[auto_1fr] gap-3 border-t border-line px-1 py-2.5 transition-colors first:border-t-0 sm:grid-cols-[auto_1fr_1fr_1fr]', active === m.n && 'bg-white/[0.03]')}>
          <span className={clsx('grid h-6 w-6 shrink-0 place-items-center rounded-full text-2xs font-semibold text-bg', active === m.n ? 'bg-accent' : 'bg-fg-2')}>{m.n}</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white">{cap(m.label)}{m.same_role && <span className="ml-1.5 text-xs font-normal text-fg-3">· {t('stesso ruolo')}</span>}</div>
            {!m.same_role && <div className="text-xs text-fg-3">{cap(when)}: {m.analog_label.toLowerCase()}</div>}
          </div>
          {(['current', 'analog'] as const).map((k) => (
            <div key={k} className={clsx('min-w-0 text-xs', k === 'current' ? 'col-start-2 sm:col-start-auto' : 'col-start-2 sm:col-start-auto')}>
              <div className="text-fg-3">{k === 'current' ? t('Oggi') : t('Analogo')} · {t('candela {n}', { n: m[k].idx + 1 })}</div>
              <div className="tnum font-medium text-fg">{m[k].price.toFixed(2)}% <span className="font-normal text-fg-3">{pts(m[k].pts, 2)}</span></div>
              <div className="text-fg-3">{fullTime(m[k].time, tf)} · BTC {usd(m[k].btc)}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ specchio
export function MirrorChart({ m, height = 240 }: { m: UsdtMirror; height?: number | string }) {
  const option = useMemo(() => ({
    grid: { left: 6, right: 6, top: 16, bottom: 6, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v: number) => (ok(v) ? v.toFixed(3) : '—') },
    xAxis: timeAxis(),
    yAxis: valueAxis({ position: 'right', max: 1, axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(2) } }),
    series: [lineSeries(t('Specchio'), m.series.map((p) => [p.time * 1000, p.value]), USDT_COLOR, {
      markLine: { symbol: 'none', silent: true, data: [
        { yAxis: m.p50, lineStyle: { color: hexA(C.grey, 0.5), type: 'dashed' }, label: { color: C.muted, fontSize: 11, formatter: t('Mediana storica'), position: 'insideStartTop' } },
        { yAxis: m.p10, lineStyle: { color: hexA(C.warn, 0.6), type: 'dashed' }, label: { color: C.warn, fontSize: 11, formatter: t('10° percentile'), position: 'insideStartBottom' } },
      ] },
    })],
  }), [m])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ tecnica USDT.D
export function UsdtTechChart({ t: tk, height = 380 }: { t: UsdtTechnicals; height?: number | string }) {
  const option = useMemo(() => {
    const xs = tk.series.map((p) => p.time * 1000)
    const z = (k: 'value' | 'ema50' | 'ema200') => tk.series.map((p, i) => [xs[i], p[k]])
    return {
      grid: [{ left: 6, right: 6 + GUTTER, top: 30, height: '58%', containLabel: true }, { left: 6, right: 6 + GUTTER, top: '74%', bottom: 6, containLabel: true }],
      legend: { ...legendBase, data: ['USDT.D', 'EMA 50', 'EMA 200', 'RSI 14'] },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { link: [{ xAxisIndex: 'all' }] }, valueFormatter: (v: number) => (ok(v) ? v.toFixed(2) : '—') },
      xAxis: [timeAxis({ gridIndex: 0, axisLabel: { show: false } }), timeAxis({ gridIndex: 1 })],
      yAxis: [
        valueAxis({ gridIndex: 0, position: 'right', offset: GUTTER, axisLabel: { ...axisLabel, formatter: (v: number) => `${v.toFixed(1)}%` } }),
        valueAxis({ gridIndex: 1, position: 'right', offset: GUTTER, min: 0, max: 100, interval: 50, axisLabel: { ...axisLabel, formatter: (v: number) => String(v) } }),
      ],
      dataZoom: [{ ...dataZoomInside, xAxisIndex: [0, 1] }],
      series: [
        lineSeries('USDT.D', z('value'), USDT_COLOR, {
          lineStyle: { width: 1.75, color: USDT_COLOR },
          markArea: { silent: true, data: tk.zones.map((zn) => [
            { yAxis: zn.low, itemStyle: { color: hexA(C.grey, zn.kind === 'resistance' ? 0.1 : 0.06), borderColor: hexA(C.grey, 0.3), borderWidth: 1 }, label: { show: true, position: 'right', distance: 6, color: C.muted, fontSize: 11, formatter: zn.kind === 'resistance' ? 'R' : 'S' } },
            { yAxis: zn.high },
          ]) },
        }),
        lineSeries('EMA 50', z('ema50'), C.steel, { lineStyle: { width: 1.25, color: C.steel } }),
        lineSeries('EMA 200', z('ema200'), C.sand, { lineStyle: { width: 1.25, color: C.sand } }),
        lineSeries('RSI 14', tk.series.map((p, i) => [xs[i], p.rsi]), C.grey, {
          xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1.25, color: C.grey },
          markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: hexA(C.grey, 0.35), type: 'dashed' }, data: [{ yAxis: 70 }, { yAxis: 30 }] },
        }),
      ],
    }
  }, [tk])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ stablecoin
export function SupplyChart({ s, height = 320 }: { s: Stablecoins; height?: number }) {
  const option = useMemo(() => ({
    grid: { left: 6, right: 6, top: 30, bottom: 6, containLabel: true },
    legend: { ...legendBase, data: [t('Supply stablecoin'), t('Dominance stablecoin')] },
    tooltip: {
      ...tooltipBase, trigger: 'axis',
      formatter: (ps: TipP[]) => {
        const r = s.series[ps[0]?.dataIndex ?? 0]
        if (!r) return ''
        return `${MUTED_DIV}${date(r.time)}</div>` + tipRow(C.accent, 'Supply', usdCompact(r.supply, 1)) +
          tipRow(C.steel, 'Dominance', `${r.dominance.toFixed(2)}%`) + (ok(r.chg30) ? tipRow(C.grey2, t('Variazione {n}', { n: `30${tr('g', 'd')}` }), pct(r.chg30, 2)) : '')
      },
    },
    xAxis: timeAxis(),
    yAxis: [
      valueAxis({ position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => usdCompact(v, 0) } }),
      valueAxis({ position: 'left', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => `${v.toFixed(0)}%` } }),
    ],
    dataZoom: [dataZoomInside],
    series: [
      lineSeries(t('Supply stablecoin'), s.series.map((r) => [r.time * 1000, r.supply]), C.accent, { areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: hexA(C.accent, 0.14) }, { offset: 1, color: hexA(C.accent, 0) }] } } }),
      lineSeries(t('Dominance stablecoin'), s.series.map((r) => [r.time * 1000, r.dominance]), C.steel, { yAxisIndex: 1, lineStyle: { width: 1.25, color: C.steel } }),
    ],
  }), [s])
  return <EChart option={option} height={height} />
}

export function SsrChart({ s, height = 320 }: { s: Stablecoins; height?: number }) {
  const option = useMemo(() => {
    const rows = s.series.filter((r) => ok(r.ssr_mid) && ok(r.ssr_sd))
    const at = (k: number) => rows.map((r) => [r.time * 1000, +((r.ssr_mid as number) + k * (r.ssr_sd as number)).toFixed(3)])
    const diff = (k1: number, k2: number) => rows.map((r) => [r.time * 1000, +((k2 - k1) * (r.ssr_sd as number)).toFixed(3)])
    return {
      grid: { left: 6, right: 6, top: 30, bottom: 6, containLabel: true },
      legend: { ...legendBase, data: ['SSR', t('Media {n}', { n: `365${tr('g', 'd')}` }), '±1σ', '±2σ'] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => {
          const r = rows[ps[0]?.dataIndex ?? 0]
          if (!r) return ''
          const z = (r.ssr - (r.ssr_mid as number)) / (r.ssr_sd as number)
          return `${MUTED_DIV}${date(r.time)}</div>` + tipRow(C.primary, 'SSR', r.ssr.toFixed(2)) +
            tipRow(C.grey, t('Media {n}', { n: `365${tr('g', 'd')}` }), (r.ssr_mid as number).toFixed(2)) + tipRow(C.grey2, 'Z-score', `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(2)}`)
        },
      },
      xAxis: timeAxis(),
      yAxis: valueAxis({ position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(0) } }),
      // primi anni (supply minima) fuori scala: vista iniziale sugli ultimi 3 anni, trascinabile
      dataZoom: [{ ...dataZoomInside, filterMode: 'filter', startValue: (rows[rows.length - 1]?.time ?? 0) * 1000 - 3 * 365 * 86400e3 }],
      series: [
        lineSeries('_m2', at(-2), 'transparent', { stack: 'o', lineStyle: { width: 0 }, tooltip: { show: false } }),
        lineSeries('±2σ', diff(-2, -1), 'transparent', { stack: 'o', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.accent, 0.06) }, itemStyle: { color: hexA(C.accent, 0.4) } }),
        lineSeries('±1σ', diff(-1, 1), 'transparent', { stack: 'o', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.accent, 0.14) }, itemStyle: { color: hexA(C.accent, 0.7) } }),
        lineSeries('_p2', diff(1, 2), 'transparent', { stack: 'o', lineStyle: { width: 0 }, areaStyle: { color: hexA(C.accent, 0.06) }, tooltip: { show: false } }),
        lineSeries(t('Media {n}', { n: `365${tr('g', 'd')}` }), at(0), C.grey, { lineStyle: { width: 1.25, type: 'dashed', color: C.grey } }),
        lineSeries('SSR', rows.map((r) => [r.time * 1000, r.ssr]), C.primary, { z: 5, lineStyle: { width: 1.75, color: C.primary } }),
      ],
    }
  }, [s])
  return <EChart option={option} height={height} />
}

export function MintBurnChart({ data, height = 260 }: { data: { time: number; value: number | null }[]; height?: number }) {
  const option = useMemo(() => ({
    grid: { left: 6, right: 6, top: 16, bottom: 6, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: TipP[]) => {
      const p = data[ps[0]?.dataIndex ?? 0]
      return p ? `${MUTED_DIV}${t('Settimana dal {d}', { d: date(p.time) })}</div>` + tipRow((p.value ?? 0) >= 0 ? C.up : C.down, (p.value ?? 0) >= 0 ? t('Mint netto') : t('Burn netto'), usdCompact(p.value, 2)) : ''
    } },
    xAxis: { type: 'category', data: data.map((p) => String(p.time)), axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: string) => date(Number(v), false) }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
    yAxis: valueAxis({ position: 'right', scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => usdCompact(v, 0) } }),
    series: [{ type: 'bar', barMaxWidth: 10, data: data.map((p) => ({ value: p.value, itemStyle: { color: (p.value ?? 0) >= 0 ? hexA(C.up, 0.8) : hexA(C.down, 0.8), borderRadius: (p.value ?? 0) >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })) }],
  }), [data])
  return <EChart option={option} height={height} />
}

export function LeadLagBars({ data, best, unit, height = 240 }: { data: { lag: number; corr: number | null }[]; best: number; unit: string; height?: number }) {
  const option = useMemo(() => ({
    grid: { left: 6, right: 6, top: 16, bottom: 6, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: { name: string; value: number }[]) => `Lag ${ps[0].name} ${unit}<br/><b>ρ ${ok(ps[0].value) ? ps[0].value.toFixed(3) : '—'}</b>` },
    xAxis: { type: 'category', data: data.map((l) => String(l.lag)), axisLabel: { ...axisLabel, formatter: (v: string) => `${v}` }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
    yAxis: valueAxis({ scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => v.toFixed(1) } }),
    series: [{ type: 'bar', barMaxWidth: 18, data: data.map((l) => ({ value: l.corr, itemStyle: { color: l.lag === best ? C.accent : hexA(C.grey, 0.45), borderRadius: (l.corr ?? 0) < 0 ? [0, 0, 2, 2] : [2, 2, 0, 0] } })) }],
  }), [data, best, unit])
  return <EChart option={option} height={height} />
}


/** Right gutter (px) between the plot and the right axis labels, where level tags sit (axis pushed out by `offset`). */
const GUTTER = 22
const GUTTER_LG = 64

// ------------------------------------------------------------------ BTC vs USDT.D (panoramica) with non-overlapping level tags
/**
 * Like the shared BTC/USDT.D chart, but the historical levels are neutral dashed lines and only the nearest level above
 * and below the current dominance carry a tag; the others show theirs on hover (no stacked labels at the right edge).
 */
export function UsdtDominanceChart({ data, height = 460 }: { data: UsdtAnalysis; height?: number }) {
  const option = useMemo(() => {
    const btc = data.series.map((s) => [s.time * 1000, s.btc])
    const ud = data.series.map((s) => [s.time * 1000, s.usdt_d])
    const cur = data.current.usdt_d
    const above = data.levels.filter((l) => l.price >= cur).sort((a, b) => a.price - b.price)[0]
    const below = data.levels.filter((l) => l.price < cur).sort((a, b) => b.price - a.price)[0]
    const tagged = new Set([above, below].filter(Boolean))
    const name = t('USDT.D (asse ↓ invertito)')
    const btcName = t('Prezzo BTC')
    return {
      grid: { left: 8, right: 8 + GUTTER_LG, top: 40, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: [btcName, name] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => `${MUTED_DIV}${dateFmt(Number((ps[0]?.value as number[])?.[0]))}</div>` +
          ps.map((p) => tipRow(p.color, p.seriesName === name ? 'USDT.D' : p.seriesName, p.seriesName === name ? `${((p.value as number[])[1]).toFixed(2)}%` : usd((p.value as number[])[1]))).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ position: 'left', axisLabel: { ...axisLabel, formatter: usdAxisFmt } }),
        valueAxis({ position: 'right', offset: GUTTER_LG, inverse: true, name: t('↓ invertito'), nameLocation: 'start', nameGap: 10, nameTextStyle: { color: C.muted, fontSize: 11, align: 'right' }, splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => `${v.toFixed(1)}%` } }),
      ],
      series: [
        lineSeries(btcName, btc, C.price, { lineStyle: { width: 1.75, color: C.price } }),
        lineSeries(name, ud, C.accent, {
          yAxisIndex: 1, lineStyle: { width: 1.5, color: C.accent },
          markLine: {
            symbol: 'none', silent: false,
            data: data.levels.map((l) => {
              const tag = { color: C.text, fontSize: 11, position: 'end', distance: 6, formatter: `${l.kind === 'resistance' ? 'R' : 'S'} ${l.price.toFixed(2)}%` }
              return {
                yAxis: l.price,
                lineStyle: { color: hexA(C.grey, tagged.has(l) ? 0.6 : 0.3), type: 'dashed', width: 1 },
                label: { ...tag, show: tagged.has(l) },
                emphasis: { label: { ...tag, show: true }, lineStyle: { color: hexA(C.grey, 0.8), width: 1 } },
              }
            }),
          },
        }),
      ],
    }
  }, [data])
  return <EChart option={option} height={height} />
}
