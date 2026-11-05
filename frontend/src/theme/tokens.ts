/*
 * Design tokens: the ONLY file of the app that holds colour values.
 *
 *   tokens.ts ──► tailwind.config.js  (classes: bg-surface, text-accent, border-line…, with /opacity)
 *             ├─► :root CSS variables (--c-*, emitted by the Tailwind plugin; used by index.css)
 *             └─► T / alpha()         (canvas, ECharts, lightweight-charts, inline SVG)
 *
 * Roles
 *   Orange is the only accent: action, active state, selection, focus, the key value of a view.
 *   Green and red mean up/down and long/short, nothing else.
 *   Warm white is the BTC price and the reference series; orange in a chart is the series in focus.
 *   The categorical tints (steel, sand, mauve…) exist only to tell chart series apart.
 *   `warn` is a desaturated sand for "attention" states, kept apart from the accent on purpose.
 */

export const T = {
  // surfaces: near-black, neutral with a hint of warmth (never blue)
  bg: '#0A0A09',
  side: '#0E0E0D',
  surface: '#141413',
  surfaceHi: '#181817',
  raised: '#1C1C1A',
  overlay: '#242422',
  track: '#2C2C29',

  // text: warm neutrals. fg…fg4 pass AA (4.5:1) on every surface; fgOff is for separators and disabled items only
  fg: '#F4F1EA',
  fg2: '#CFCAC1',
  fg3: '#ABA69D',
  fg4: '#9A958C',
  fgOff: '#5E5A54',

  // the one accent
  accent: '#F7931A',
  accentHi: '#FFB05A',
  accentLo: '#C8720F',
  onAccent: '#150C02',

  // direction only
  up: '#2FBF87',
  upHi: '#5FDDAC',
  down: '#F4656E',
  downHi: '#FF8D96',

  // attention states
  warn: '#E0BC6E',

  // chart-only tints, desaturated so that the accent stays the loudest colour on screen
  steel: '#7FA3BD',
  sand: '#CBB48C',
  mauve: '#B392A6',
  ice: '#B7CBD8',
  clay: '#B98A6C',
  plum: '#8E7A8C',
  dusk: '#6F8FA6',
  wheat: '#E0D2B0',

  // shadow and mask base
  black: '#000000',
} as const

export type TokenName = keyof typeof T

/** Hairlines: warm white at low opacity, so they read the same on every surface. */
export const LINE = {
  subtle: 'rgba(255,248,235,0.055)',
  base: 'rgba(255,248,235,0.09)',
  strong: 'rgba(255,248,235,0.16)',
} as const

/** Multi-series order: price, focus series, then tints and greys. */
export const SERIES = [T.fg, T.accent, T.steel, T.sand, T.mauve, T.fg3, T.fg4, T.dusk] as const
/** Overlaid analogs: never orange (the current path) and never green/red (gain/loss). */
export const ANALOGS = [T.steel, T.sand, T.mauve, T.ice, T.clay, T.wheat, T.plum, T.fg3, T.dusk, T.fg2] as const
/** Density scale for heatmaps: black → orange → white. Stops are even; the mid-range stays readable behind white price lines. */
export const HEAT = ['#0A0A09', '#1C0F07', '#3A1C08', '#66300A', '#9C4A0C', '#D5700F', '#F7931A', '#FFC07A', '#FFF1DC'] as const
/** Sequential single-hue ramp for ordered categories. */
export const SEQ = ['#141413', '#2C1C0E', '#54320F', '#8C5212', '#C47316', '#F7931A', '#FFC688'] as const
/** Diverging ramp: down ↔ neutral ↔ up. */
export const DIVERGING = ['#F4656E', '#A94950', '#5A3A3A', '#2C2C29', '#32503F', '#26845F', '#2FBF87'] as const

/** Correlation sign is not market direction, so it never uses green/red: steel ↔ neutral ↔ orange. */
export const CORR = ['#7FA3BD', '#5A7488', '#3C4A54', '#2C2C29', '#5A3E22', '#A8651A', '#F7931A'] as const
/** One tint per exchange, the same in badges, tables and charts. Peers, so never the accent. */
export const EXCHANGE = { binance: T.sand, bybit: T.mauve, okx: T.steel, coinbase: T.ice, deribit: T.fg } as const

/** Hex colour → rgba() string at opacity `a`. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** Hex colour → "r g b" channels for `rgb(var(--c-x) / <alpha-value>)`. */
export const channels = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/** The CSS variables emitted on :root by the Tailwind plugin. */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(T)) out[`--c-${k}`] = channels(v)
  for (const [k, v] of Object.entries(LINE)) out[`--line-${k}`] = v
  return out
}
