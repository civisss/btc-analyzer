/* Domanda e offerta: grafici e formattatori (riserve exchange, flussi ETF per emittente, assorbimento, attenzione). */
import { useMemo } from 'react'
import type { Pt } from '../api/types'
import type { AbsorptionRow, EtfData } from '../api/supplyDemand'
import type { AnomalyMark } from '../api/superchart'
import { anomalyMarkPoint, anomalyTipRow } from './charts'
import EChart from '../components/charts/EChart'
import {
  C, FONT, areaGradient, axisLabel, axisNum, dataZoomInside, dataZoomSlider, dateFmt, hexA, legendBase, lineSeries, timeAxis, toXY, tooltipBase,
  usdAxis, valueAxis,
} from '../components/charts/theme'
import { t } from '../i18n'
import { DASH, compact, date, monthYear, usdCompact } from '../lib/format'
import { T, alpha } from '../theme/tokens'

type Num = number | null | undefined
export const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '')

/** BTC amount: "2.675M BTC" · "−89.6K BTC" (signed=true adds "+"). */
export function btcAmt(v: Num, signed = false, unit = true): string {
  if (!fin(v)) return DASH
  const a = Math.abs(v)
  const s = signed ? sign(v) : v < 0 ? '−' : ''
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(3)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0)
  return `${s}${body}${unit ? ' BTC' : ''}`
}
/** Flow in millions of USD -> "+$655.3M" / "−$1.1B". */
export function usdM(v: Num, signed = true): string {
  if (!fin(v)) return DASH
  const s = usdCompact(v * 1e6, 1)
  return signed && v > 0 ? `+${s}` : s
}
/** Axis label for values in millions of USD: $600M · $1.2B · $60B · $0. */
export function usdMAxis(v: number): string {
  if (!v) return '$0'
  const a = Math.abs(v), s = v < 0 ? '−' : ''
  return a >= 1000 ? `${s}$${+(a / 1000).toFixed(1)}B` : `${s}$${+a.toFixed(0)}M`
}
/** Issuer names (only tickers whose sponsor is certain). */
export const ISSUER_NAME: Record<string, string> = {
  IBIT: 'BlackRock', FBTC: 'Fidelity', GBTC: 'Grayscale', BTC: 'Grayscale Mini', BITB: 'Bitwise', ARKB: 'ARK 21Shares', BTCO: 'Invesco Galaxy',
  EZBC: 'Franklin', BRRR: 'Valkyrie / CoinShares', HODL: 'VanEck', BTCW: 'WisdomTree',
}
/** Integer with grouping and Unicode minus. */
export function intg(v: Num, signed = false): string {
  if (!fin(v)) return DASH
  const r = Math.round(v)
  return (signed ? sign(r) : r < 0 ? '−' : '') + Math.abs(r).toLocaleString('en-US')
}
/** Signed fixed decimals: "+1.83" / "−0.08". */
export const sfx = (v: Num, d = 2) => (fin(v) ? sign(v) + Math.abs(v).toFixed(d) : DASH)
export const mult = (v: Num, d = 2) => (fin(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}×` : DASH)

type TipP = { seriesName: string; value: unknown; color: string; axisValue?: number; data?: unknown }
const tipHead = (s: string) => `<div style="color:${C.muted};font-size:11px;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid ${alpha(T.fg, 0.06)}">${s}</div>`
const tipRow = (color: string, name: string, val: string) =>
  `<div style="display:flex;justify-content:space-between;gap:18px;align-items:center;line-height:20px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`
const vline = (ms: number, label: string, color = hexA(C.grey, 0.6)) => ({
  xAxis: ms, lineStyle: { color, type: 'dashed', width: 1 },
  label: { formatter: label, color: C.text, fontSize: 10, fontFamily: FONT, position: 'insideEndTop' },
})

// ------------------------------------------------------------------ riserve exchange vs prezzo
export function ReservesChart({ reserve, price, mode, logPrice, height = 380 }: {
  reserve: Pt[]; price: Pt[]; mode: 'btc' | 'pct'; logPrice: boolean; height?: number | string
}) {
  const option = useMemo(() => {
    const name = mode === 'btc' ? t('Riserve exchange') : t("Riserve in % dell'offerta")
    const fmt = (v: number) => (mode === 'btc' ? btcAmt(v) : `${v.toFixed(2)}%`)
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: [name, t('Prezzo BTC')] },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => tipHead(dateFmt(Number((ps[0]?.value as number[])[0]))) + ps.map((p) => {
          const v = (p.value as number[])[1]
          return tipRow(p.color, p.seriesName, p.seriesName === name ? fmt(v) : usdAxis(v))
        }).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ position: 'left', axisLabel: { ...axisLabel, formatter: (v: number) => (mode === 'btc' ? (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : axisNum(v)) : `${v.toFixed(1)}%`) } }),
        valueAxis({ type: logPrice ? 'log' : 'value', position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: usdAxis } }),
      ],
      series: [
        lineSeries(name, toXY(reserve), C.accent, { lineStyle: { width: 1.8, color: C.accent }, areaStyle: { color: areaGradient(C.accent, 0.2) } }),
        lineSeries(t('Prezzo BTC'), toXY(price), C.price, { yAxisIndex: 1, lineStyle: { width: 1.2, color: C.price } }),
      ],
    }
  }, [reserve, price, mode, logPrice])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ flusso netto (barre: entrate rosse, uscite verdi)
export function NetflowBars({ data, height = 300, zoom = false, unitLabel, anomalies }: { data: Pt[]; height?: number | string; zoom?: boolean; unitLabel: string; anomalies?: AnomalyMark[] }) {
  const option = useMemo(() => ({
    grid: { left: 8, right: 8, top: 12, bottom: zoom ? 36 : 8, containLabel: true },
    tooltip: {
      ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps: TipP[]) => {
        const [ms, v] = ps[0].value as number[]
        return tipHead(`${dateFmt(ms)} · ${unitLabel}`) + tipRow(v > 0 ? C.down : C.up, v > 0 ? t('Entrate nette') : t('Uscite nette'), btcAmt(v, true)) + anomalyTipRow(anomalies, ms)
      },
    },
    dataZoom: zoom ? [dataZoomInside, dataZoomSlider] : undefined,
    xAxis: timeAxis(),
    yAxis: valueAxis({ position: 'right', scale: false, axisLabel: { ...axisLabel, formatter: axisNum } }),
    series: [{
      name: t('Flusso netto'), type: 'bar', data: toXY(data), barMaxWidth: 6, large: data.length > 600,
      itemStyle: { color: (p: { value: [number, number] }) => (p.value[1] > 0 ? C.down : C.up) },
      markPoint: anomalyMarkPoint(anomalies, toXY(data) as [number, number | null][]),
    }],
  }), [data, zoom, unitLabel, anomalies])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ flussi ETF giornalieri per emittente + cumulato
export const ISSUER_COLORS: Record<string, string> = { IBIT: C.accent, FBTC: C.steel, GBTC: C.sand, ARKB: T.fg3, BITB: T.fg4 }
const OTHERS = T.fgOff
export function EtfFlowsChart({ d, start, unit, height = 400, anomalies }: { d: EtfData['daily']; start: number; unit: 'usd' | 'btc'; height?: number | string; anomalies?: AnomalyMark[] }) {
  const option = useMemo(() => {
    const i0 = Math.max(0, d.dates.findIndex((x) => x >= start))
    const ms = d.dates.slice(i0).map((x) => x * 1000)
    const main = Object.keys(ISSUER_COLORS).filter((k) => d.issuers[k])
    const others = Object.keys(d.issuers).filter((k) => !main.includes(k))
    const conv = (arr: (number | null)[], j: number) => {
      const v = arr[j]
      if (!fin(v)) return null
      return unit === 'usd' ? v : (fin(d.price[j]) && d.price[j] ? (v * 1e6) / (d.price[j] as number) : null)
    }
    const col = (k: string) => ms.map((m, j) => [m, conv(d.issuers[k], j + i0)])
    const oth = ms.map((m, j) => [m, others.reduce((a, k) => a + (conv(d.issuers[k], j + i0) ?? 0), 0)])
    const cum = (unit === 'usd' ? d.cum_usd : d.cum_btc).slice(i0)
    const lblOthers = t('Altri')
    const lblCum = unit === 'usd' ? t('Cumulato dal lancio') : t('Cumulato dal lancio (stima)')
    const fmt = (v: number) => (unit === 'usd' ? usdM(v) : btcAmt(v, true))
    const fmtCum = (v: number) => (unit === 'usd' ? usdM(v, false) : btcAmt(v))
    const stack = (name: string, data: unknown[], color: string) => ({ name, type: 'bar', stack: 'f', data, itemStyle: { color }, barMaxWidth: 10, emphasis: { disabled: true } })
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: [...main, lblOthers, lblCum] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (ps: TipP[]) => {
          const m = Number((ps[0]?.value as number[])[0])
          const j = ms.indexOf(m)
          const tot = j >= 0 ? (unit === 'usd' ? d.total[j + i0] : d.btc[j + i0]) : null
          return tipHead(`${dateFmt(m)} · ${t('Totale')} <b style="color:${T.fg}">${fin(tot) ? fmt(tot) : DASH}</b>`) +
            ps.filter((p) => fin((p.value as number[])[1]) && ((p.value as number[])[1] !== 0 || p.seriesName === lblCum))
              .map((p) => tipRow(p.color, p.seriesName, p.seriesName === lblCum ? fmtCum((p.value as number[])[1]) : fmt((p.value as number[])[1]))).join('')
            + anomalyTipRow(anomalies, m)
        },
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ position: 'left', scale: false, axisLabel: { ...axisLabel, formatter: (v: number) => (unit === 'usd' ? usdMAxis(v) : axisNum(v)) } }),
        valueAxis({ position: 'right', scale: false, splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: (v: number) => (unit === 'usd' ? usdMAxis(v) : axisNum(v)) } }),
      ],
      series: [
        // anomaly dots sit on the day's total (first stack series → left axis)
        ...main.map((k, i) => ({ ...stack(k, col(k), ISSUER_COLORS[k]),
          ...(i === 0 ? { markPoint: anomalyMarkPoint(anomalies, ms.map((m, j) => {
            // top of the visible stack on the side of the day's net flow
            const parts = Object.keys(d.issuers).map((k) => conv(d.issuers[k], j + i0) ?? 0)
            const net = parts.reduce((a, x) => a + x, 0)
            return [m, parts.filter((x) => (net >= 0 ? x > 0 : x < 0)).reduce((a, x) => a + x, 0)] as [number, number | null]
          })) } : {}) })),
        stack(lblOthers, oth, OTHERS),
        lineSeries(lblCum, ms.map((m, j) => [m, cum[j]]), C.primary, { yAxisIndex: 1, lineStyle: { width: 1.6, color: C.primary } }),
      ],
    }
  }, [d, start, unit, anomalies])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ assorbimento: rapporto 30 giorni
export function RatioChart({ data, height = 300 }: { data: Pt[]; height?: number | string }) {
  const option = useMemo(() => {
    const halving = Date.UTC(2024, 3, 20)
    return {
      grid: { left: 8, right: 8, top: 16, bottom: 36, containLabel: true },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => tipHead(dateFmt(Number((ps[0]?.value as number[])[0]))) + tipRow(C.accent, t('ETF ÷ emissione (30 giorni)'), mult((ps[0].value as number[])[1])),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: valueAxis({ position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => `${v.toFixed(0).replace('-', '−')}×` } }),
      series: [lineSeries(t('ETF ÷ emissione (30 giorni)'), toXY(data), C.accent, {
        lineStyle: { width: 1.8, color: C.accent }, areaStyle: { color: areaGradient(C.accent, 0.16), origin: 0 },
        markLine: { symbol: 'none', silent: true, data: [
          { yAxis: 1, lineStyle: { color: hexA(C.grey, 0.7), type: 'dashed' }, label: { formatter: t("1× = tutta l'emissione"), color: C.text, fontSize: 10, position: 'insideEndTop' } },
          { yAxis: 0, lineStyle: { color: hexA(C.grey, 0.4), type: 'solid' }, label: { show: false } },
          vline(halving, t('Halving')),
        ] },
      })],
    }
  }, [data])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ assorbimento mensile: BTC ETF vs BTC emessi
export function MonthlyAbsorptionChart({ rows, height = 300 }: { rows: AbsorptionRow[]; height?: number | string }) {
  const option = useMemo(() => {
    const cat = rows.map((r) => monthYear(r.time))
    const e = t('BTC netti ETF (stima)'), i = t('BTC emessi dai miner')
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 8, containLabel: true },
      legend: { ...legendBase, data: [e, i] },
      tooltip: {
        ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (ps: TipP[]) => {
          const r = rows[(ps[0] as unknown as { dataIndex: number }).dataIndex]
          return tipHead(`${cat[(ps[0] as unknown as { dataIndex: number }).dataIndex]}${r && !r.complete ? ` · ${t('in corso')}` : ''}`) +
            ps.map((p) => tipRow(p.color, p.seriesName, btcAmt(p.value as number, p.seriesName === e))).join('') +
            (r ? tipRow('transparent', t('Rapporto'), mult(r.ratio)) : '')
        },
      },
      xAxis: { type: 'category', data: cat, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, axisLabel: { ...axisLabel, hideOverlap: true } },
      yAxis: valueAxis({ position: 'right', scale: false, axisLabel: { ...axisLabel, formatter: axisNum } }),
      series: [
        { name: e, type: 'bar', data: rows.map((r) => r.etf_btc), barMaxWidth: 14, itemStyle: { color: (p: { value: number }) => (p.value >= 0 ? C.accent : hexA(C.down, 0.85)) }, emphasis: { disabled: true } },
        { name: i, type: 'bar', data: rows.map((r) => r.issued_btc), barMaxWidth: 14, itemStyle: { color: T.fg4 }, emphasis: { disabled: true } },
      ],
    }
  }, [rows])
  return <EChart option={option} height={height} />
}

// ------------------------------------------------------------------ attenzione (log) vs prezzo (log)
export function AttentionChart({ views, it, price, showIt, height = 380 }: { views: Pt[]; it: Pt[]; price: Pt[]; showIt: boolean; height?: number | string }) {
  const option = useMemo(() => {
    const en = t('Visite en.wikipedia (media 30 giorni)')
    const itn = t('Visite it.wikipedia (media 30 giorni)')
    const names = [en, ...(showIt ? [itn] : []), t('Prezzo BTC')]
    return {
      grid: { left: 8, right: 8, top: 34, bottom: 36, containLabel: true },
      legend: { ...legendBase, data: names },
      tooltip: {
        ...tooltipBase, trigger: 'axis',
        formatter: (ps: TipP[]) => tipHead(dateFmt(Number((ps[0]?.value as number[])[0]))) + ps.map((p) => {
          const v = (p.value as number[])[1]
          return tipRow(p.color, p.seriesName, p.seriesName === t('Prezzo BTC') ? usdAxis(v) : intg(v))
        }).join(''),
      },
      dataZoom: [dataZoomInside, dataZoomSlider],
      xAxis: timeAxis(),
      yAxis: [
        valueAxis({ type: 'log', position: 'left', axisLabel: { ...axisLabel, formatter: (v: number) => compact(v, 0) } }),
        valueAxis({ type: 'log', position: 'right', splitLine: { show: false }, axisLabel: { ...axisLabel, formatter: usdAxis } }),
      ],
      series: [
        lineSeries(en, toXY(views), C.accent, { lineStyle: { width: 1.8, color: C.accent }, areaStyle: { color: areaGradient(C.accent, 0.18) } }),
        ...(showIt ? [lineSeries(itn, toXY(it), C.steel, { lineStyle: { width: 1.3, color: C.steel } })] : []),
        lineSeries(t('Prezzo BTC'), toXY(price), C.price, { yAxisIndex: 1, lineStyle: { width: 1.2, color: C.price } }),
      ],
    }
  }, [views, it, price, showIt])
  return <EChart option={option} height={height} />
}

/** "dal 12 ott 2026" style helper for tables. */
export const d = (x: Num) => date(x)
