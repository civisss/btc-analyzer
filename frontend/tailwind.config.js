/*
 * Design system v4: near-black warm neutrals + one orange accent. Every colour comes from src/theme/tokens.ts:
 * this file only maps the tokens to class names and emits them as CSS variables on :root.
 */
import plugin from 'tailwindcss/plugin'
import { T, alpha, cssVariables } from './src/theme/tokens.ts'

const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Geist Variable"', 'Geist', '"Inter Variable"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      // fixed type scale: 11 label · 12 meta · 13 body/table · 15 card title · 20 page title · 28 hero KPI
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '20px' }],
        base: ['13px', { lineHeight: '20px' }],
        lg: ['15px', { lineHeight: '22px' }],
        xl: ['20px', { lineHeight: '28px' }],
        '2xl': ['20px', { lineHeight: '28px' }],
        '3xl': ['28px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        '4xl': ['28px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        label: ['11px', { lineHeight: '16px', letterSpacing: '0.04em' }],
        meta: ['12px', { lineHeight: '16px' }],
        body: ['13px', { lineHeight: '20px' }],
        title: ['15px', { lineHeight: '22px' }],
        page: ['24px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        hero: ['28px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
      },
      // weights 400 / 500 / 600 only
      fontWeight: { bold: '600', extrabold: '600', black: '600' },
      colors: {
        // `white` is the warm primary text, so bg-white/[0.04] overlays stay warm too
        white: v('fg'),
        bg: v('bg'),
        side: v('side'),
        surface: { DEFAULT: v('surface'), hi: v('surfaceHi') },
        raised: v('raised'),
        overlay: v('overlay'),
        track: v('track'),
        line: { DEFAULT: 'var(--line-base)', subtle: 'var(--line-subtle)', strong: 'var(--line-strong)' },
        fg: { DEFAULT: v('fg'), 2: v('fg2'), 3: v('fg3'), 4: v('fg4'), off: v('fgOff') },
        accent: { DEFAULT: v('accent'), hi: v('accentHi'), lo: v('accentLo') },
        'on-accent': v('onAccent'),
        up: { DEFAULT: v('up'), hi: v('upHi') },
        down: { DEFAULT: v('down'), hi: v('downHi') },
        warn: v('warn'),
      },
      // radius: cards 12 · controls 8 · pills full
      borderRadius: { sm: '3px', DEFAULT: '5px', md: '6px', lg: '8px', xl: '10px', '2xl': '12px', '3xl': '16px' },
      boxShadow: {
        card: `inset 0 1px 0 ${alpha(T.fg, 0.03)}, 0 1px 2px ${alpha(T.black, 0.5)}`,
        pop: `0 1px 2px ${alpha(T.black, 0.6)}, 0 16px 40px -12px ${alpha(T.black, 0.8)}`,
      },
      keyframes: { shimmer: { '100%': { transform: 'translateX(100%)' } } },
      animation: { shimmer: 'shimmer 1.6s infinite' },
    },
  },
  plugins: [plugin(({ addBase }) => addBase({ ':root': cssVariables() }))],
}
