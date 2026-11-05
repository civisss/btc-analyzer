/* Pannelli impilati in un solo grafico ECharts (asse del tempo e cursore condivisi), con l'etichetta di ogni pannello sopra il riquadro. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import EChart from '../components/charts/EChart'
import { C, axisLabel, tooltipBase, usdAxis } from '../components/charts/theme'
import { T } from '../theme/tokens'

type O = Record<string, unknown>
export interface Panel {
  /** micro-label of the panel */
  label: string
  /** summary chip, computed from the data */
  chip?: ReactNode
  height: number
  /** series without axis indexes: the stack assigns them */
  series: O[]
  yFormat: (v: number) => string
  yExtra?: O
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="tnum inline-block max-w-full truncate rounded-md bg-accent px-2 py-0.5 text-xs font-semibold" style={{ color: T.onAccent }}>{children}</span>
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(1000)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export function Stack({ panels, categories, xLabel, tooltip }: { panels: Panel[]; categories: string[]; xLabel: (v: string) => string; tooltip: (i: number) => string }) {
  const [ref, width] = useWidth()
  const narrow = width < 560
  const strip = narrow ? 50 : 30
  const gap = 8
  const bottom = 26
  const tops: number[] = []
  let y = 0
  for (const p of panels) { tops.push(y); y += strip + p.height + gap }
  const total = y - gap + bottom
  const option = useMemo(() => {
    const series: O[] = []
    panels.forEach((p, i) => p.series.forEach((s) => series.push({ ...s, xAxisIndex: i, yAxisIndex: i })))
    return {
      animation: false,
      grid: panels.map((p, i) => ({ left: 4, right: narrow ? 60 : 66, top: tops[i] + strip, height: p.height })),
      xAxis: panels.map((_, i) => ({
        type: 'category', gridIndex: i, data: categories, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: { ...axisLabel, show: i === panels.length - 1, hideOverlap: true, formatter: xLabel, alignMinLabel: 'left', alignMaxLabel: 'right' },
        axisPointer: { type: 'line', lineStyle: { color: T.fg4, type: 'dashed' }, label: { show: false } },
      })),
      yAxis: panels.map((p, i) => ({
        type: 'value', gridIndex: i, position: 'right', scale: true, splitNumber: 3, axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: C.grid } }, axisLabel: { ...axisLabel, formatter: p.yFormat }, axisPointer: { show: false }, ...(p.yExtra ?? {}),
      })),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: { ...tooltipBase, trigger: 'axis', confine: true, formatter: (ps: { dataIndex: number }[]) => (ps.length ? tooltip(ps[0].dataIndex) : '') },
      series,
    }
    // tops, xLabel and tooltip derive from the listed values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels, categories, narrow, strip])
  return (
    <div ref={ref} className="relative" style={{ height: total }}>
      {/* remount when the height changes: the canvas does not follow a taller container */}
      <EChart key={total} option={option} height={total} />
      {panels.map((p, i) => (
        <div key={p.label} className={'pointer-events-none absolute inset-x-0 flex gap-x-3 ' + (narrow ? 'flex-col gap-y-1' : 'items-center')} style={{ top: tops[i], height: strip }}>
          <span className="label shrink-0">{p.label}</span>
          {p.chip && <span className="min-w-0"><Chip>{p.chip}</Chip></span>}
        </div>
      ))}
    </div>
  )
}

/** USD axis for flows: $0 · +$300M · −$1.5B (usdAxis stops at millions). */
export function flowAxis(v: number): string {
  if (!v) return '$0'
  const a = Math.abs(v)
  const s = v < 0 ? '−' : '+'
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(1).replace(/\.0$/, '')}B` : `${s}${usdAxis(a)}`
}

/** Hours and minutes in local time, the same on every axis and list. */
export function hhmm(t: number): string {
  const d = new Date(t * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Candlestick colours of the app. */
export const candleStyle = { color: T.up, color0: T.down, borderColor: T.up, borderColor0: T.down }

/** Tooltip row (plain HTML string for ECharts). */
export const tipRow = (l: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${l}</span><b>${v}</b></div>`
