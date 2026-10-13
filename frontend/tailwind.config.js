/*
 * Design system v3 — "ink": deep navy surfaces, top-lit gradient cards, gradient hairlines, muted accent tints.
 *  Surfaces : bg #060912 · surface #0E1424 · raised #161E31 · side #070B16 · line rgba(148,163,210,.10)
 *  Text     : #E8ECF4 primary · #B3BCD0 secondary · #8892A8 muted · #566079 disabled
 *  Accents  : BTC #F7931A · blue #5B8DEF · violet #9B87F5 · teal #3CC6B0 · amber #E8B04B (badges/kickers/sparklines only)
 *  Semantic : up #2EBD85 · down #EF5466 (signed changes, long/short only)
 * Default Tailwind families (sky/emerald/rose/violet/…) are folded into these hues so legacy classes can't add colour sprawl.
 */
const ramp = (c) => ({ 50: c, 100: c, 200: c, 300: c, 400: c, 500: c, 600: c, 700: c, 800: c, 900: c, 950: c })
const NEUTRAL = {
  50: '#E8ECF4', 100: '#E8ECF4', 200: '#E8ECF4', 300: '#B3BCD0', 400: '#8892A8', 500: '#6B7590',
  600: '#566079', 700: '#343D55', 800: '#1A2236', 900: '#0E1424', 950: '#060912',
}
const UP = '#2EBD85'
const DOWN = '#EF5466'
const BLUE = '#5B8DEF'
const AMBER = '#E8B04B'
const VIOLET = '#9B87F5'
const TEAL = '#3CC6B0'

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
        white: '#E8ECF4',
        bg: '#060912',
        surface: '#0E1424',
        raised: '#161E31',
        side: '#070B16',
        line: 'rgba(148,163,210,0.10)',
        // legacy "ink" names mapped onto the three surfaces
        ink: { 950: '#060912', 900: '#060912', 850: '#0E1424', 800: '#0E1424', 700: '#161E31', 600: '#1A2236', 500: '#2A3450' },
        btc: { DEFAULT: '#F7931A', 400: '#F7931A', 600: '#D97F12' },
        up: UP,
        down: DOWN,
        amber: ramp(AMBER),
        accent: { purple: VIOLET, blue: BLUE, cyan: TEAL, teal: TEAL, violet: VIOLET, amber: AMBER },
        // neutral text ramp (slate/gray/zinc all resolve to the same 4 neutrals)
        slate: NEUTRAL,
        gray: NEUTRAL,
        zinc: NEUTRAL,
        // decorative families folded into the semantic hues
        emerald: ramp(UP), green: ramp(UP), lime: ramp(UP), teal: ramp(TEAL),
        rose: ramp(DOWN), red: ramp(DOWN), pink: ramp(DOWN),
        sky: ramp(BLUE), blue: ramp(BLUE), cyan: ramp(TEAL), indigo: ramp(BLUE),
        violet: ramp(VIOLET), purple: ramp(VIOLET), fuchsia: ramp(VIOLET),
        yellow: ramp(AMBER), orange: ramp('#F7931A'),
      },
      // radius: cards 16 · controls 8–10 · pills full
      borderRadius: { sm: '4px', DEFAULT: '6px', md: '8px', lg: '10px', xl: '12px', '2xl': '16px', '3xl': '20px' },
      boxShadow: {
        card: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.4), 0 18px 40px -22px rgba(0,0,0,0.85)',
        glow: '0 0 0 1px rgba(247,147,26,0.25), 0 8px 24px -8px rgba(247,147,26,0.35)', glowbtc: '0 0 0 1px rgba(247,147,26,0.25), 0 8px 24px -8px rgba(247,147,26,0.35)',
        pop: '0 1px 2px rgba(0,0,0,0.5), 0 18px 48px -12px rgba(0,0,0,0.75)',
      },
      keyframes: { shimmer: { '100%': { transform: 'translateX(100%)' } } },
      animation: { shimmer: 'shimmer 1.6s infinite' },
    },
  },
  plugins: [],
}
