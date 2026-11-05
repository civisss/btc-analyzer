/** Semi-circular Fear & Greed gauge (0..100): thin gradient arc (red → grey → green), value marker with a soft halo. */
import { useId } from 'react'
import { t } from '../../i18n'
import { T, alpha } from '../../theme/tokens'

export function fngColor(v: number) {
  // diverging red ↔ grey ↔ green (no rainbow)
  if (v < 25) return T.down
  if (v < 45) return alpha(T.down, 0.7)
  if (v < 55) return T.fg3
  if (v < 75) return alpha(T.up, 0.7)
  return T.up
}
export function fngLabel(v: number) {
  if (v < 25) return t('Paura estrema')
  if (v < 45) return t('Paura')
  if (v < 55) return t('Neutrale')
  if (v < 75) return t('Avidità')
  return t('Avidità estrema')
}

export default function FearGreedGauge({ value, size = 120 }: { value: number; size?: number }) {
  const id = useId().replace(/:/g, '')
  const v = Math.max(0, Math.min(100, value))
  const r = 44, cx = 60, cy = 56
  const pt = (f: number) => [cx + r * Math.cos(Math.PI * (1 - f)), cy - r * Math.sin(Math.PI * (1 - f))] as const
  const arc = (a0: number, a1: number) => {
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1)
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`
  }
  const [mx, my] = pt(v / 100)
  const col = fngColor(v)
  return (
    <svg viewBox="0 0 120 64" width={size} height={(size * 64) / 120} aria-label={`Fear & Greed ${v}`}>
      <defs>
        <linearGradient id={`fg${id}`} x1="16" y1="0" x2="104" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={T.down} />
          <stop offset="45%" stopColor={T.fg3} />
          <stop offset="100%" stopColor={T.up} />
        </linearGradient>
      </defs>
      <path d={arc(0, 1)} stroke={alpha(T.fg, 0.07)} strokeWidth="8" fill="none" strokeLinecap="round" />
      <path d={arc(0, 1)} stroke={`url(#fg${id})`} strokeOpacity="0.28" strokeWidth="8" fill="none" strokeLinecap="round" />
      <path d={arc(0, Math.max(0.001, v / 100))} stroke={`url(#fg${id})`} strokeWidth="8" fill="none" strokeLinecap="round" />
      <circle cx={mx} cy={my} r="8" fill={col} opacity="0.25" />
      <circle cx={mx} cy={my} r="4.5" fill={T.fg} stroke={col} strokeWidth="2" />
    </svg>
  )
}
