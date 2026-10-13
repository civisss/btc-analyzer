import { useId, useMemo } from 'react'
import type { Pt } from '../../api/types'

/** Tiny SVG sparkline: line in the series colour, optional soft gradient area (`fill`). */
export default function Sparkline({
  data, color = '#8B94A7', width = 120, height = 40, className, fill = false, strokeWidth = 1.25,
}: { data: (Pt | number)[] | undefined; color?: string; width?: number; height?: number; className?: string; fill?: boolean; strokeWidth?: number }) {
  const id = useId().replace(/:/g, '')
  const path = useMemo(() => {
    const vals = (data ?? []).map((p) => (typeof p === 'number' ? p : p.value)).filter((v): v is number => v != null && Number.isFinite(v))
    if (vals.length < 2) return null
    const min = Math.min(...vals), max = Math.max(...vals)
    const span = max - min || 1
    const pad = strokeWidth + 2
    const xy = vals.map((v, i) => [(i / (vals.length - 1)) * width, pad + (1 - (v - min) / span) * (height - 2 * pad)])
    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    return { line, area: `${line} L${width},${height} L0,${height} Z` }
  }, [data, width, height, strokeWidth])
  if (!path) return <svg width="100%" height={height} className={className} />
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={className} width="100%" height={height} aria-hidden>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30" />
          <stop offset="60%" stopColor={color} stopOpacity="0.08" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={path.area} fill={`url(#g${id})`} />}
      <path d={path.line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
