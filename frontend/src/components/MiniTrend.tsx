import type { ReactNode } from 'react'
import Sparkline from './charts/Sparkline'
import { clsx } from './ui'
import type { Pt } from '../api/types'
import { T } from '../theme/tokens'

/**
 * Compact trend area for side cards: label row + a sparkline that grows to fill the card's free height
 * (flex-1, min `min` px). Used where a side card sits next to a taller chart, so the card ends level with it.
 */
export function MiniTrend({ data, label, right, color = T.fg3, min = 72, className }: {
  data: (Pt | number)[] | undefined; label: ReactNode; right?: ReactNode; color?: string; min?: number; className?: string
}) {
  if (!data || data.length < 2) return null
  return (
    <div className={clsx('flex flex-1 flex-col', className)} style={{ minHeight: min + 24 }}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        {right && <span className="tnum text-xs text-fg-3">{right}</span>}
      </div>
      <div className="relative flex-1 tile" style={{ minHeight: min }}>
        <Sparkline data={data} color={color} fill className="absolute inset-0 h-full" />
      </div>
    </div>
  )
}
