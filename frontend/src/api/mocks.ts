/* Realistic mock fixtures following CONTRACT.md.
 * Only loaded when VITE_USE_MOCKS === 'true' (npm run dev:mock). */
import { agentMessagesMock, agentsMock, runAgentMock, startMockAgents } from './mocksAgents'
import type {
  Candle, ChatMessage, Cycles, Derivatives, Forecast, Fractals, Indicators, Insights, Levels,
  Liquidations, OnChain, Overview, Pt, Status, T, UsdtAnalysis,
} from './types'

// ------------------------------------------------------------------ utils
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-9)
  const v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const DAY = 86400
const d = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 1000)
const NOW = Math.floor(Date.now() / 1000)
const TODAY = Math.floor(NOW / DAY) * DAY
const round = (x: number, n = 2) => Math.round(x * 10 ** n) / 10 ** n

const cache = new Map<string, unknown>()
function memo<R>(key: string, fn: () => R): R {
  if (!cache.has(key)) cache.set(key, fn())
  return cache.get(key) as R
}

// ------------------------------------------------------------------ daily history (2011 -> today)
const ANCHORS: [number, number][] = [
  [d('2011-01-01'), 0.3],
  [d('2011-06-08'), 29],
  [d('2011-11-18'), 2.0],
  [d('2012-11-28'), 12.3],
  [d('2013-04-10'), 230],
  [d('2013-07-05'), 68],
  [d('2013-12-04'), 1150],
  [d('2015-01-14'), 170],
  [d('2016-07-09'), 650],
  [d('2017-12-17'), 19700],
  [d('2018-12-15'), 3200],
  [d('2019-06-26'), 13000],
  [d('2020-03-13'), 4800],
  [d('2020-05-11'), 8600],
  [d('2021-04-14'), 64000],
  [d('2021-07-20'), 29800],
  [d('2021-11-10'), 69000],
  [d('2022-11-21'), 15600],
  [d('2023-10-15'), 27000],
  [d('2024-03-14'), 73000],
  [d('2024-04-20'), 64000],
  [d('2024-08-05'), 53000],
  [d('2024-12-17'), 108000],
  [d('2025-04-08'), 76000],
  [d('2025-10-06'), 126000],
  [d('2026-02-05'), 63000],
  [d('2026-06-20'), 82000],
  [d('2026-08-25'), 66500],
  [TODAY, 74280],
]

const daily = (): Candle[] =>
  memo('daily', () => {
    const r = rng(42)
    const out: Candle[] = []
    for (let a = 0; a < ANCHORS.length - 1; a++) {
      const [t0, p0] = ANCHORS[a]
      const [t1, p1] = ANCHORS[a + 1]
      const n = Math.round((t1 - t0) / DAY)
      const vol = t0 < d('2015-01-01') ? 0.055 : t0 < d('2020-01-01') ? 0.04 : 0.028
      const walk = [0]
      for (let i = 1; i <= n; i++) walk.push(walk[i - 1] + gauss(r) * vol)
      const l0 = Math.log(p0)
      const l1 = Math.log(p1)
      let prev = p0
      for (let i = 0; i < n; i++) {
        const f = i / n
        const bridge = walk[i] - f * walk[n]
        const close = Math.exp(l0 + (l1 - l0) * f + bridge * 0.9)
        const open = prev
        const hi = Math.max(open, close) * (1 + Math.abs(gauss(r)) * vol * 0.4)
        const lo = Math.min(open, close) * (1 - Math.abs(gauss(r)) * vol * 0.4)
        const volume = (close * 2e4 * (0.6 + r())) / Math.max(close / 30000, 0.2)
        out.push({ time: t0 + i * DAY, open, high: hi, low: lo, close, volume })
        prev = close
      }
    }
    const last = ANCHORS[ANCHORS.length - 1]
    const o = out[out.length - 1].close
    out.push({ time: last[0], open: o, high: Math.max(o, last[1]) * 1.006, low: Math.min(o, last[1]) * 0.992, close: last[1], volume: 2.4e4 })
    return out
  })

const PRICE = () => daily()[daily().length - 1].close

function intraday(tfSec: number, n: number, seed: number): Candle[] {
  return memo(`intra-${tfSec}-${n}`, () => {
    const r = rng(seed)
    const vol = 0.0042 * Math.sqrt(tfSec / 3600)
    const end = Math.floor(NOW / tfSec) * tfSec
    const closes: number[] = new Array(n)
    closes[n - 1] = PRICE()
    for (let i = n - 2; i >= 0; i--) {
      const drift = Math.sin(i / 37) * vol * 0.35
      closes[i] = closes[i + 1] / Math.exp(gauss(r) * vol + drift * 0.3)
    }
    return closes.map((c, i) => {
      const open = i === 0 ? c * (1 + gauss(r) * vol * 0.5) : closes[i - 1]
      const hi = Math.max(open, c) * (1 + Math.abs(gauss(r)) * vol * 0.5)
      const lo = Math.min(open, c) * (1 - Math.abs(gauss(r)) * vol * 0.5)
      const volume = (300 + r() * 900) * (tfSec / 3600) ** 0.8 * (1 + Math.abs(c - open) / (c * vol))
      return { time: end - (n - 1 - i) * tfSec, open, high: hi, low: lo, close: c, volume }
    })
  })
}

function weekly(): Candle[] {
  return memo('weekly', () => {
    const dd = daily().filter((c) => c.time >= d('2017-08-14'))
    const out: Candle[] = []
    for (let i = 0; i < dd.length; i += 7) {
      const ch = dd.slice(i, i + 7)
      out.push({
        time: ch[0].time,
        open: ch[0].open,
        close: ch[ch.length - 1].close,
        high: Math.max(...ch.map((c) => c.high)),
        low: Math.min(...ch.map((c) => c.low)),
        volume: ch.reduce((s, c) => s + c.volume, 0),
      })
    }
    return out
  })
}

function candlesFor(tf: string, limit = 1000): Candle[] {
  let all: Candle[]
  switch (tf) {
    case '15m': all = intraday(900, 1000, 7); break
    case '1h': all = intraday(3600, 1000, 8); break
    case '4h': all = intraday(14400, 1000, 9); break
    case '1w': all = weekly(); break
    default: all = daily().filter((c) => c.time >= d('2017-08-17'))
  }
  return all.slice(-limit)
}

// ------------------------------------------------------------------ TA helpers
const pts = (c: Candle[], vals: (number | null)[]): Pt[] => c.map((k, i) => ({ time: k.time, value: vals[i] == null ? null : round(vals[i] as number) }))
function ema(v: number[], p: number) {
  const k = 2 / (p + 1)
  const out: (number | null)[] = []
  let e = v[0]
  v.forEach((x, i) => {
    e = i === 0 ? x : x * k + e * (1 - k)
    out.push(i < p - 1 ? null : e)
  })
  return out
}
function sma(v: number[], p: number) {
  const out: (number | null)[] = []
  let s = 0
  v.forEach((x, i) => {
    s += x
    if (i >= p) s -= v[i - p]
    out.push(i >= p - 1 ? s / p : null)
  })
  return out
}
function std(v: number[], p: number) {
  return v.map((_, i) => {
    if (i < p - 1) return null
    const w = v.slice(i - p + 1, i + 1)
    const m = w.reduce((a, b) => a + b, 0) / p
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / p)
  })
}
function rsi(v: number[], p = 14) {
  const out: (number | null)[] = [null]
  let g = 0, l = 0
  for (let i = 1; i < v.length; i++) {
    const ch = v[i] - v[i - 1]
    const up = Math.max(ch, 0), dn = Math.max(-ch, 0)
    if (i <= p) { g += up / p; l += dn / p } else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p }
    out.push(i < p ? null : 100 - 100 / (1 + g / (l || 1e-9)))
  }
  return out
}

// ------------------------------------------------------------------ endpoints
function overview(): Overview {
  const dd = daily()
  const r = rng(Math.floor(NOW / 30))
  const price = PRICE() * (1 + gauss(r) * 0.0008)
  const last60 = dd.slice(-60)
  const prev = dd[dd.length - 2].close
  const ath = dd.reduce((a, c) => (c.high > a.high ? c : a), dd[0])
  const spark = (f: (c: Candle, i: number) => number): Pt[] => last60.map((c, i) => ({ time: c.time, value: round(f(c, i)) }))
  const mcap = price * 19.94e6
  return {
    price: round(price),
    change_24h: round(((price - prev) / prev) * 100),
    high_24h: round(price * 1.018),
    low_24h: round(price * 0.976),
    volume_24h_usd: 31.4e9,
    volume_change: -8.7,
    market_cap: mcap,
    market_cap_change_24h: round(((price - prev) / prev) * 100),
    btc_dominance: 58.4,
    usdt_market_cap: 182.6e9,
    usdt_dominance: 6.84,
    usdt_mcap_change_7d: 1.12,
    fear_greed: { value: 38, label: 'Fear', change_1d: -4 },
    funding_rate: 0.0064,
    open_interest_usd: 58.2e9,
    ath: { price: round(ath.high), time: ath.time, drawdown: round(((price - ath.high) / ath.high) * 100) },
    sparklines: {
      price: spark((c) => c.close),
      market_cap: spark((c) => c.close * 19.94e6),
      volume: spark((c, i) => 25e9 + Math.sin(i / 3) * 6e9 + (c.volume % 1) * 4e9),
      dominance: spark((_, i) => 57.2 + Math.sin(i / 9) * 0.9 + i * 0.015),
      usdt: spark((c) => 6 + (90000 - c.close) / 25000),
      fng: spark((c, i) => Math.max(5, Math.min(95, 30 + (c.close - 66000) / 600 + Math.sin(i) * 4))),
    },
    updated_at: NOW,
  }
}

function indicators(tf: string, limit: number): Indicators {
  const c = candlesFor(tf, limit)
  const cl = c.map((k) => k.close)
  const mid = sma(cl, 20)
  const sd = std(cl, 20)
  const e12 = ema(cl, 12), e26 = ema(cl, 26)
  const macd = cl.map((_, i) => (e12[i] != null && e26[i] != null ? (e12[i] as number) - (e26[i] as number) : null))
  const macdVals = macd.map((x) => x ?? 0)
  const sig = ema(macdVals, 9).map((x, i) => (macd[i] == null ? null : x))
  const hist = macd.map((m, i) => (m != null && sig[i] != null ? m - (sig[i] as number) : null))
  let pv = 0, vv = 0
  const vwap = c.map((k, i) => {
    if (i % 30 === 0) { pv = 0; vv = 0 }
    pv += ((k.high + k.low + k.close) / 3) * k.volume
    vv += k.volume
    return pv / vv
  })
  const atr = c.map((k, i) => (i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close))))
  const r = rsi(cl)
  const lastRsi = r[r.length - 1] ?? 50
  const e50 = ema(cl, 50), e200 = ema(cl, 200)
  const last = cl[cl.length - 1]
  const lastE50 = e50[e50.length - 1] ?? last, lastE200 = e200[e200.length - 1] ?? last
  return {
    ema: { '21': pts(c, ema(cl, 21)), '50': pts(c, e50), '200': pts(c, e200) },
    sma: { '50': pts(c, sma(cl, 50)), '200': pts(c, sma(cl, 200)) },
    bb: {
      upper: pts(c, mid.map((m, i) => (m == null ? null : m + 2 * (sd[i] as number)))),
      mid: pts(c, mid),
      lower: pts(c, mid.map((m, i) => (m == null ? null : m - 2 * (sd[i] as number)))),
    },
    rsi: pts(c, r),
    macd: { macd: pts(c, macd), signal: pts(c, sig), hist: pts(c, hist) },
    vwap: pts(c, vwap),
    atr: pts(c, sma(atr, 14)),
    summary: [
      { name: 'RSI (14)', value: lastRsi.toFixed(1), signal: lastRsi > 60 ? 'bullish' : lastRsi < 40 ? 'bearish' : 'neutral' },
      { name: 'MACD (12,26,9)', value: (hist[hist.length - 1] ?? 0) > 0 ? 'Sopra segnale' : 'Sotto segnale', signal: (hist[hist.length - 1] ?? 0) > 0 ? 'bullish' : 'bearish' },
      { name: 'EMA 50', value: `$${Math.round(lastE50).toLocaleString('en-US')}`, signal: last > lastE50 ? 'bullish' : 'bearish' },
      { name: 'EMA 200', value: `$${Math.round(lastE200).toLocaleString('en-US')}`, signal: last > lastE200 ? 'bullish' : 'bearish' },
      { name: 'Bollinger %B', value: '0.46', signal: 'neutral' },
      { name: 'ATR (14)', value: `$${Math.round(atr[atr.length - 1]).toLocaleString('en-US')}`, signal: 'neutral' },
      { name: 'Stoch RSI', value: '72.4', signal: 'bullish' },
      { name: 'Trend (ADX)', value: '18.2 — debole', signal: 'neutral' },
    ],
  }
}

function levels(tf: string): Levels {
  const c = candlesFor(tf, 400)
  const prevBar = (n: number) => {
    const s = c.slice(-n - 1, -1)
    return { h: Math.max(...s.map((k) => k.high)), l: Math.min(...s.map((k) => k.low)), c: s[s.length - 1].close }
  }
  const mk = ({ h, l, c: cl }: { h: number; l: number; c: number }) => {
    const P = (h + l + cl) / 3, R = h - l
    return {
      classic: { P, R1: 2 * P - l, S1: 2 * P - h, R2: P + R, S2: P - R, R3: h + 2 * (P - l), S3: l - 2 * (h - P) },
      fibonacci: { P, R1: P + 0.382 * R, R2: P + 0.618 * R, R3: P + R, S1: P - 0.382 * R, S2: P - 0.618 * R, S3: P - R },
      camarilla: {
        H1: cl + (R * 1.1) / 12, H2: cl + (R * 1.1) / 6, H3: cl + (R * 1.1) / 4, H4: cl + (R * 1.1) / 2,
        L1: cl - (R * 1.1) / 12, L2: cl - (R * 1.1) / 6, L3: cl - (R * 1.1) / 4, L4: cl - (R * 1.1) / 2,
      },
    }
  }
  const swings: Levels['swings'] = []
  const W = 8
  for (let i = W; i < c.length - W; i++) {
    const win = c.slice(i - W, i + W + 1)
    if (c[i].high === Math.max(...win.map((k) => k.high))) swings.push({ time: c[i].time, price: round(c[i].high), kind: 'high', strength: 2 + (i % 3) })
    if (c[i].low === Math.min(...win.map((k) => k.low))) swings.push({ time: c[i].time, price: round(c[i].low), kind: 'low', strength: 2 + (i % 3) })
  }
  const p = c[c.length - 1].close
  const zones: Levels['zones'] = swings.slice(-10).map((s) => ({
    low: round(s.price * 0.992), high: round(s.price * 1.008), kind: s.price > p ? 'resistance' : 'support',
    touches: 2 + (Math.round(s.price) % 4), strength: 0.4 + (Math.round(s.price) % 50) / 100, last_touch: s.time,
  }))
  const kl: Levels['key_levels'] = [
    ['Resistenza 3', 1.12], ['Resistenza 2', 1.075], ['Resistenza 1', 1.031], ['Supporto 1', 0.968], ['Supporto 2', 0.93], ['Supporto 3', 0.885],
  ].map(([label, f]) => ({ label: label as string, price: round(p * (f as number), 0), kind: (f as number) > 1 ? 'resistance' : 'support', distance: round(((f as number) - 1) * 100) }))
  const hi = c.slice(-200).reduce((a, k) => (k.high > a.high ? k : a))
  const lo = c.slice(-200).reduce((a, k) => (k.low < a.low ? k : a))
  const [from, to] = hi.time < lo.time ? [{ time: hi.time, price: hi.high }, { time: lo.time, price: lo.low }] : [{ time: lo.time, price: lo.low }, { time: hi.time, price: hi.high }]
  return {
    pivots: { daily: mk(prevBar(1)), weekly: mk(prevBar(7)), monthly: mk(prevBar(30)) },
    swings,
    zones,
    key_levels: kl,
    fib_retracement: { from, to, levels: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((ratio) => ({ ratio, price: round(to.price + (from.price - to.price) * ratio) })) },
  }
}

function cycles(): Cycles {
  return memo('cycles', () => {
    const dd = daily()
    const priceAt = (t: number) => (dd.find((c) => c.time >= t) ?? dd[dd.length - 1]).close
    const halvings = [
      { n: 1, time: d('2012-11-28'), block: 210000 },
      { n: 2, time: d('2016-07-09'), block: 420000 },
      { n: 3, time: d('2020-05-11'), block: 630000 },
      { n: 4, time: d('2024-04-20'), block: 840000 },
      { n: 5, time: d('2028-04-11'), block: 1050000, estimated: true },
    ].map((h) => ({ ...h, price: h.time > NOW ? null : round(priceAt(h.time)) }))
    const bt = [
      ['2011-11-18', '2013-12-04', '2015-01-14'],
      ['2015-01-14', '2017-12-17', '2018-12-15'],
      ['2018-12-15', '2021-11-10', '2022-11-21'],
      ['2022-11-21', '2025-10-06', null],
    ] as const
    const cyc: Cycles['cycles'] = bt.map(([b, t, nb], i) => {
      const bp = ANCHORS.find((a) => a[0] === d(b))![1]
      const tp = ANCHORS.find((a) => a[0] === d(t))![1]
      const nbp = nb ? ANCHORS.find((a) => a[0] === d(nb))![1] : null
      const h = halvings[i]
      return {
        n: i + 1,
        bottom: { time: d(b), price: bp },
        top: { time: d(t), price: tp },
        next_bottom: nb ? { time: d(nb), price: nbp! } : null,
        days_bottom_to_top: Math.round((d(t) - d(b)) / DAY),
        days_top_to_bottom: nb ? Math.round((d(nb) - d(t)) / DAY) : null,
        days_halving_to_top: Math.round((d(t) - h.time) / DAY),
        gain: round((tp / bp - 1) * 100, 0),
        drawdown: nbp ? round((nbp / tp - 1) * 100, 1) : round((PRICE() / tp - 1) * 100, 1),
        status: nb ? 'complete' : 'in_progress',
      }
    })
    const anchorsSets: Record<'bottom' | 'halving' | 'top', [string, number][]> = {
      bottom: cyc.map((c) => [`Ciclo ${c.n}`, c.bottom.time]),
      halving: halvings.filter((h) => !h.estimated).map((h) => [`Halving ${h.n}`, h.time]),
      top: cyc.map((c) => [`Top ${c.n}`, c.top!.time]),
    }
    const overlay: Cycles['overlay'] = (Object.keys(anchorsSets) as ('bottom' | 'halving' | 'top')[]).map((anchor) => ({
      anchor,
      series: anchorsSets[anchor].map(([name, t0]) => {
        const p0 = priceAt(t0)
        const points: { day: number; roi: number }[] = []
        for (const c of dd) {
          if (c.time < t0) continue
          const day = Math.round((c.time - t0) / DAY)
          if (day > 1500) break
          if (day % 3 === 0) points.push({ day, roi: round(c.close / p0, 4) })
        }
        return { name, points }
      }),
    }))
    const GEN = d('2009-01-03')
    const plaw = (t: number) => 10 ** -17.01 * ((t - GEN) / DAY) ** 5.82
    const weeklyPts = dd.filter((_, i) => i % 3 === 0)
    const cl = dd.map((c) => c.close)
    const s111 = sma(cl, 111), s350 = sma(cl, 350), s730 = sma(cl, 730), s200 = sma(cl, 200)
    const sub = <X,>(arr: X[]) => arr.filter((_, i) => i % 3 === 0)
    const ptsOf = (vals: (number | null)[]) => sub(dd.map((c, i) => ({ time: c.time, value: vals[i] == null ? null : round(vals[i] as number) })))
    const bandsDef = [
      ['Bolla massima', '#c0392b', 3.2], ['Vendi. Seriamente', '#e74c3c', 2.4], ['FOMO', '#e67e22', 1.8], ['Bolla?', '#f1c40f', 1.35],
      ['HODL', '#a3d65c', 1.0], ['Ancora economico', '#2ecc71', 0.72], ['Accumula', '#1abc9c', 0.52], ['Compra', '#3498db', 0.38], ['Svendita', '#6c5ce7', 0.27],
    ] as const
    const cur = PRICE()
    const fairNow = plaw(NOW)
    const ratio = cur / fairNow
    const current_band = [...bandsDef].reverse().find((b) => ratio <= b[2])?.[0] ?? 'HODL'
    const piCross = [d('2013-04-06'), d('2013-12-03'), d('2017-12-16'), d('2021-04-12')]
    return {
      halvings,
      cycles: cyc,
      current: {
        phase: 'bear',
        phase_confidence: 71,
        phase_probabilities: { accumulation: 22, bull: 4, distribution: 3, bear: 71 },
        days_since_bottom: Math.round((NOW - d('2026-02-05')) / DAY),
        days_since_confirmed_bottom: Math.round((NOW - d('2022-11-21')) / DAY),
        probable_bottom: { time: d('2026-02-05'), price: 63000, rebound: 17.9, days_after_top: 122 },
        bottom_window_kind: 'retest',
        days_since_top: Math.round((NOW - d('2025-10-06')) / DAY),
        days_since_halving: Math.round((NOW - d('2024-04-20')) / DAY),
        progress: 7,
        est_next_bottom: { from: d('2026-09-20'), to: d('2027-02-15'), mid: d('2026-12-01'), price_low: 52000, price_high: 64000 },
        est_next_top: { from: d('2029-06-01'), to: d('2029-12-31'), mid: d('2029-09-15'), price_low: 190000, price_high: 280000 },
        notes: [
          'La durata bottom→top si è allungata di ~10% a ciclo; la fase bear tende a durare 360–390 giorni.',
          'Il drawdown dal top è inferiore ai cicli precedenti: i cicli si stanno smorzando.',
          'Il prezzo è vicino alla media mobile a 2 anni, zona storica di accumulo.',
        ],
      },
      durations_trend: [
        { metric: 'Bottom → Top', values: cyc.map((c) => ({ n: c.n, days: c.days_bottom_to_top! })), projected_next: 1120 },
        { metric: 'Top → Bottom', values: cyc.filter((c) => c.days_top_to_bottom).map((c) => ({ n: c.n, days: c.days_top_to_bottom! })), projected_next: 395 },
        { metric: 'Halving → Top', values: cyc.map((c) => ({ n: c.n, days: c.days_halving_to_top! })), projected_next: 520 },
      ],
      overlay,
      models: {
        power_law: {
          fair: sub(dd.map((c) => ({ time: c.time, value: round(plaw(c.time)) }))),
          support: sub(dd.map((c) => ({ time: c.time, value: round(plaw(c.time) * 0.42) }))),
          resistance: sub(dd.map((c) => ({ time: c.time, value: round(plaw(c.time) * 3.1) }))),
          current_fair: round(fairNow, 0),
          deviation: round((ratio - 1) * 100, 1),
        },
        rainbow: {
          bands: [...bandsDef].reverse().map(([name, color, k]) => ({ name, color, series: sub(dd.map((c) => ({ time: c.time, value: round(plaw(c.time) * k) }))) })),
          floor: sub(dd.map((c) => ({ time: c.time, value: round(plaw(c.time) * 0.19) }))),
          current_band,
        },
        pi_cycle: {
          sma111: ptsOf(s111),
          sma350x2: ptsOf(s350.map((x) => (x == null ? null : x * 2))),
          crosses: piCross,
          distance: round((((s350[s350.length - 1] ?? 1) * 2) / (s111[s111.length - 1] ?? 1) - 1) * 100, 1),
        },
        mayer: { series: ptsOf(cl.map((x, i) => (s200[i] == null ? null : x / (s200[i] as number)))), current: round(cur / (s200[s200.length - 1] ?? cur), 2) },
        two_year_ma: { ma: ptsOf(s730), ma_x5: ptsOf(s730.map((x) => (x == null ? null : x * 5))) },
      },
      price_log: weeklyPts.map((c) => ({ time: c.time, value: round(c.close) })),
    }
  })
}

function onchain(): OnChain {
  return memo('onchain', () => {
    const dd = daily().filter((c) => c.time >= d('2017-01-01'))
    const r = rng(11)
    const mk = (f: (c: Candle, i: number) => number) => dd.map((c, i) => ({ time: c.time, value: round(f(c, i), 4) }))
    const realized = (c: Candle, i: number) => 4000 + (i / dd.length) ** 1.6 * 52000 + Math.sin(i / 200) * 1500 + c.close * 0
    const series: Record<string, Pt[]> = {
      price: mk((c) => c.close),
      realized_price: mk(realized),
      mvrv: mk((c, i) => c.close / realized(c, i)),
      mvrv_z: mk((c, i) => (c.close / realized(c, i) - 1) * 2.1),
      hashrate: mk((_, i) => 7e5 * Math.exp(i / 520) * (1 + gauss(r) * 0.04)),
      active_addresses: mk((c, i) => 650000 + Math.sin(i / 90) * 120000 + c.close / 3 + gauss(r) * 30000),
      tx_count: mk((_, i) => 280000 + i * 60 + gauss(r) * 25000),
      supply: mk((_, i) => 16.0e6 + i * 1.03e3),
      issuance_usd: mk((c, i) => c.close * (i < 1250 ? 1800 : i < 2700 ? 900 : 450)),
      puell: mk((c, i) => (c.close / (dd[Math.max(0, i - 365)].close || 1)) * 0.85),
      nupl: mk((c, i) => 1 - realized(c, i) / c.close),
    }
    const meta: [string, string, (v: number) => string, (v: number) => [string, 'bullish' | 'bearish' | 'neutral']][] = [
      ['mvrv', 'MVRV', (v) => v.toFixed(2), (v) => (v < 1.2 ? ['Sottovalutato', 'bullish'] : v > 3 ? ['Surriscaldato', 'bearish'] : ['Neutrale', 'neutral'])],
      ['mvrv_z', 'MVRV Z-Score', (v) => v.toFixed(2), (v) => (v < 0.5 ? ['Zona di accumulo', 'bullish'] : v > 6 ? ['Zona di top', 'bearish'] : ['Neutrale', 'neutral'])],
      ['realized_price', 'Realized Price', (v) => `$${Math.round(v).toLocaleString('en-US')}`, () => ['Supporto storico', 'neutral']],
      ['hashrate', 'Hash Rate', (v) => `${(v / 1e6).toFixed(0)} EH/s`, () => ['Massimi storici', 'bullish']],
      ['active_addresses', 'Indirizzi attivi', (v) => `${(v / 1000).toFixed(0)}K`, () => ['Stabile', 'neutral']],
      ['tx_count', 'Transazioni/giorno', (v) => `${(v / 1000).toFixed(0)}K`, () => ['In crescita', 'bullish']],
      ['supply', 'Offerta circolante', (v) => `${(v / 1e6).toFixed(2)}M BTC`, () => ['95% emesso', 'neutral']],
      ['issuance_usd', 'Emissione (USD)', (v) => `$${(v / 1e6).toFixed(1)}M`, () => ['Post-halving', 'neutral']],
      ['puell', 'Puell Multiple', (v) => v.toFixed(2), (v) => (v < 0.6 ? ['Capitolazione miner', 'bullish'] : v > 3 ? ['Euforia', 'bearish'] : ['Neutrale', 'neutral'])],
      ['nupl', 'NUPL', (v) => v.toFixed(2), (v) => (v < 0 ? ['Capitolazione', 'bullish'] : v < 0.25 ? ['Speranza / Paura', 'neutral'] : v < 0.5 ? ['Ottimismo', 'neutral'] : ['Euforia', 'bearish'])],
    ]
    const metrics = meta.map(([key, label, fmt, st]) => {
      const s = series[key]
      const v = s[s.length - 1].value as number
      const v30 = s[s.length - 31].value as number
      const [status, tone] = st(v)
      return { key, label, value: v, display: fmt(v), change_30d: round(((v - v30) / Math.abs(v30)) * 100), status, tone, spark: s.slice(-60) }
    })
    return {
      metrics,
      series,
      network: {
        block_height: 968_412,
        fees: { fastest: 6, hour: 4, economy: 2 },
        difficulty_change: 2.84,
        next_retarget: NOW + 6.2 * DAY,
        halving_eta: d('2028-04-11'),
        blocks_to_halving: 1_050_000 - 968_412,
      },
    }
  })
}

function derivatives(): Derivatives {
  return memo('deriv', () => {
    const r = rng(5)
    const n8 = 90
    const t8 = Math.floor(NOW / 28800) * 28800
    const funding = Array.from({ length: n8 }, (_, i) => ({ time: t8 - (n8 - 1 - i) * 28800, value: round(0.006 + Math.sin(i / 7) * 0.006 + gauss(r) * 0.003, 4) }))
    const th = Math.floor(NOW / 3600) * 3600
    const hours = 24 * 14
    const oi = Array.from({ length: hours }, (_, i) => ({ time: th - (hours - 1 - i) * 3600, value: round(54e9 + Math.sin(i / 40) * 3e9 + i * 1.2e7 + gauss(r) * 3e8, 0) }))
    const acc = Array.from({ length: hours }, (_, i) => ({ time: th - (hours - 1 - i) * 3600, value: round(1.6 + Math.sin(i / 30) * 0.35 + gauss(r) * 0.05, 3) }))
    const top = acc.map((p, i) => ({ time: p.time, value: round(1.2 + Math.sin(i / 22) * 0.25 + gauss(r) * 0.04, 3) }))
    const taker = acc.map((p) => ({ time: p.time, value: round(1 + gauss(r) * 0.08, 3) }))
    const cur = funding[funding.length - 1].value as number
    return {
      funding: { current: cur, annualized: round(cur * 3 * 365, 2), series: funding, avg_7d: 0.0071, avg_30d: 0.0058 },
      open_interest: { current_usd: oi[oi.length - 1].value as number, change_24h: 2.35, series: oi },
      long_short: { accounts: acc, top_traders: top, taker, current_long_pct: 62.4 },
      basis: { mark: round(PRICE() * 1.0004), index: round(PRICE()), premium: 0.042 },
      signals: [
        { text: 'Funding moderatamente positivo: i long pagano, ma senza eccessi.', tone: 'neutral' },
        { text: 'Open Interest +2.3% in 24h con prezzo laterale: rischio di squeeze.', tone: 'bearish' },
        { text: 'Il 62% degli account retail è long: posizionamento contrarian ribassista.', tone: 'bearish' },
        { text: 'Top trader in riduzione dell\'esposizione long.', tone: 'neutral' },
        { text: 'Basis annualizzato basso: nessuna euforia sui futures.', tone: 'bullish' },
      ],
    }
  })
}

function liquidations(range: string): Liquidations {
  return memo(`liq-${range}`, () => {
    const days = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 }[range] ?? 7
    const step = days <= 1 ? 900 : days <= 3 ? 3600 : days <= 7 ? 7200 : 21600
    const n = Math.round((days * DAY) / step)
    const src = step === 900 ? intraday(900, 1000, 7) : step === 3600 ? intraday(3600, 1000, 8) : intraday(14400, 1000, 9)
    let candles: Candle[]
    if (step <= 3600) candles = src.slice(-n)
    else {
      const per = step / 14400
      const base = src.slice(-Math.ceil(n * per))
      candles = []
      for (let i = 0; i < base.length; i += Math.max(1, Math.round(per))) {
        const ch = base.slice(i, i + Math.max(1, Math.round(per)))
        if (per < 1) { candles.push(...ch); continue }
        candles.push({ time: ch[0].time, open: ch[0].open, close: ch[ch.length - 1].close, high: Math.max(...ch.map((c) => c.high)), low: Math.min(...ch.map((c) => c.low)), volume: ch.reduce((s, c) => s + c.volume, 0) })
      }
    }
    const lo = Math.min(...candles.map((c) => c.low)) * 0.94
    const hi = Math.max(...candles.map((c) => c.high)) * 1.06
    const NP = 90
    const prices = Array.from({ length: NP }, (_, i) => round(lo + ((hi - lo) * i) / (NP - 1), 0))
    const levs = [10, 25, 50, 100]
    const values: number[][] = candles.map(() => new Array(NP).fill(0))
    const r = rng(77)
    const bw = (hi - lo) / NP
    candles.forEach((c, i) => {
      for (const L of levs) {
        const w = c.volume * (L === 25 ? 1.4 : L === 50 ? 1.1 : 0.8) * (0.5 + r()) * 3e3
        const longLiq = c.close * (1 - 1 / L)
        const shortLiq = c.close * (1 + 1 / L)
        for (const [lp, side] of [[longLiq, 'long'], [shortLiq, 'short']] as const) {
          let alive = true
          for (let j = i; j < candles.length && alive; j++) {
            if (side === 'long' ? candles[j].low <= lp : candles[j].high >= lp) alive = false
            if (!alive) break
            const k = Math.round((lp - lo) / bw)
            for (let q = -1; q <= 1; q++) if (k + q >= 0 && k + q < NP) values[j][k + q] += w * (q === 0 ? 1 : 0.35)
          }
        }
      }
    })
    const max = Math.max(...values.flat())
    const price = candles[candles.length - 1].close
    const lastCol = values[values.length - 1]
    const clusters = lastCol
      .map((usd, k) => ({ price: prices[k], usd: round(usd, 0), side: (prices[k] < price ? 'long' : 'short') as 'long' | 'short', distance: round(((prices[k] - price) / price) * 100) }))
      .filter((c) => c.usd > 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 12)
      .sort((a, b) => b.price - a.price)
    const near = [...clusters].sort((a, b) => b.usd / (1 + Math.abs(b.distance)) - a.usd / (1 + Math.abs(a.distance)))[0]
    const events: Liquidations['events'] = Array.from({ length: 60 }, (_, i) => {
      const side = r() > 0.55 ? 'long' : 'short'
      return { time: NOW - i * (60 + Math.floor(r() * 400)), side, price: round(price * (1 + gauss(r) * 0.004)), usd: round(2000 + r() ** 3 * 900000, 0) }
    })
    return {
      heatmap: { times: candles.map((c) => c.time), prices, values: values.map((row) => row.map((v) => round(v, 0))), max, candles },
      clusters,
      pools: [
        { price: round(price * 1.042, 0), kind: 'buy_side', source: 'Massimi uguali (4h)', strength: 0.82 },
        { price: round(price * 1.085, 0), kind: 'buy_side', source: 'Swing high settimanale', strength: 0.64 },
        { price: round(price * 0.963, 0), kind: 'sell_side', source: 'Minimi uguali (1d)', strength: 0.77 },
        { price: round(price * 0.918, 0), kind: 'sell_side', source: 'Swing low + gap volume', strength: 0.55 },
      ],
      events,
      totals: { long_24h: 142.6e6, short_24h: 88.1e6, long_7d: 812.4e6, short_7d: 655.9e6, collecting_since: NOW - 9 * DAY },
      magnet: near ? { price: near.price, side: near.side, usd: near.usd } : null,
    }
  })
}

function fractals(tf: string, window: number, horizon: number, top: number): Fractals {
  return memo(`frac-${tf}-${window}-${horizon}-${top}`, () => {
    const tfSec = { '1h': 3600, '4h': 14400, '1d': DAY, '1w': 7 * DAY }[tf] ?? 14400
    const c = candlesFor(tf, 1000).slice(-window)
    const cur = c.map((k) => ({ time: k.time, close: round(k.close) }))
    const r = rng(window * 31 + horizon + tfSec)
    const last = cur[cur.length - 1].close
    const labels = ['Mar 2020', 'Set 2019', 'Giu 2022', 'Gen 2015', 'Ago 2018', 'Mag 2021', 'Nov 2018', 'Lug 2023', 'Dic 2014', 'Apr 2024']
    const matches = Array.from({ length: top }, (_, i) => {
      const sim = round(91 - i * 4.3 - r() * 2, 1)
      const noise = 0.006 + i * 0.003
      const path = cur.map((k) => round(k.close * (1 + gauss(r) * noise)))
      const drift = (r() - 0.45) * 0.0035
      const fut: number[] = []
      let p = last
      for (let h = 0; h < horizon; h++) { p *= Math.exp(drift + gauss(r) * 0.012); fut.push(round(p)) }
      const start = d('2015-01-01') + Math.floor(r() * 3000) * DAY
      return {
        rank: i + 1, start, end: start + window * tfSec, similarity: sim, correlation: round(0.95 - i * 0.04, 3), dtw: round(0.08 + i * 0.03, 3),
        label: `${labels[i % labels.length]} (${tf})`, path, future: fut, outcome: round((fut[fut.length - 1] / last - 1) * 100),
      }
    })
    const times = Array.from({ length: horizon }, (_, h) => cur[cur.length - 1].time + (h + 1) * tfSec)
    const q = (h: number, qq: number) => {
      const vals = matches.map((m) => m.future[h]).sort((a, b) => a - b)
      const idx = (vals.length - 1) * qq
      const lo = Math.floor(idx), hi = Math.ceil(idx)
      return round(vals[lo] + (vals[hi] - vals[lo]) * (idx - lo))
    }
    const p50 = times.map((_, h) => q(h, 0.5))
    const up = matches.filter((m) => m.outcome > 0).length / matches.length
    return {
      tf, window, horizon, current: cur, matches,
      projection: { times, p10: times.map((_, h) => q(h, 0.1)), p50, p90: times.map((_, h) => q(h, 0.9)), bias: up > 0.6 ? 'bullish' : up < 0.4 ? 'bearish' : 'neutral', up_prob: round(up * 100, 0) },
      retests: [
        { price: round(last * 0.958, 0), time: NOW + 4 * DAY, kind: 'support', note: '4 analoghi su 5 hanno ritestato questo supporto prima di ripartire.' },
        { price: round(last * 1.047, 0), time: NOW + 9 * DAY, kind: 'resistance', note: 'Resistenza respinta in 3 analoghi su 5.' },
        { price: round(last * 0.931, 0), time: NOW + 6 * DAY, kind: 'liquidity', note: 'Sweep di liquidità sotto i minimi uguali (cluster long).' },
      ],
      multi_tf: [
        { tf: '1h', similarity: 84.2, bias: 'neutral', up_prob: 52 },
        { tf: '4h', similarity: 81.7, bias: 'bullish', up_prob: 64 },
        { tf: '1d', similarity: 78.3, bias: 'bullish', up_prob: 60 },
        { tf: '1w', similarity: 72.9, bias: 'bearish', up_prob: 41 },
      ],
    }
  })
}

function usdt(): UsdtAnalysis {
  return memo('usdt', () => {
    const dd = daily().filter((c) => c.time >= TODAY - 730 * DAY)
    const r = rng(3)
    let u = 0
    const series = dd.map((c, i) => {
      u = u * 0.92 + gauss(r) * 0.04
      const usdt_mcap = 95e9 + i * 1.2e8
      const total = c.close * 19.7e6 / 0.57
      const usdt_d = round((usdt_mcap / total) * 100 + u, 3)
      return { time: c.time, btc: round(c.close), usdt_d, usdt_mcap: round(usdt_mcap, 0), total_mcap_est: round(total, 0) }
    })
    const r30 = series.map((s, i) => ({ time: s.time, value: i < 30 ? null : round(-0.72 + Math.sin(i / 40) * 0.18 + gauss(r) * 0.04, 3) }))
    const r90 = series.map((s, i) => ({ time: s.time, value: i < 90 ? null : round(-0.8 + Math.sin(i / 90) * 0.1, 3) }))
    const lc = series[series.length - 1]
    return {
      series,
      current: { usdt_d: lc.usdt_d!, usdt_d_change_7d: 3.4, usdt_mcap: lc.usdt_mcap, mint_30d: 2.84e9 },
      correlation: {
        r30, r90, current_30: r30[r30.length - 1].value!, current_90: r90[r90.length - 1].value!,
        lead_lag: Array.from({ length: 21 }, (_, i) => ({ lag: i - 10, corr: round(-0.82 + Math.abs(i - 12) * 0.035 + gauss(r) * 0.01, 3) })),
        best_lag: 2,
      },
      levels: [
        { price: 7.6, kind: 'resistance' }, { price: 7.1, kind: 'resistance' }, { price: 6.2, kind: 'support' }, { price: 5.4, kind: 'support' },
      ],
      fractal: {
        similarity: 79.4,
        matches: [
          { start: d('2019-08-01'), end: d('2019-11-01'), similarity: 79.4, btc_outcome: 18.2, usdt_outcome: -11.5 },
          { start: d('2022-06-10'), end: d('2022-09-10'), similarity: 74.1, btc_outcome: -9.8, usdt_outcome: 6.2 },
          { start: d('2015-03-01'), end: d('2015-06-01'), similarity: 70.6, btc_outcome: 12.4, usdt_outcome: -7.9 },
        ],
      },
      divergences: [
        { time: TODAY - 12 * DAY, kind: 'bullish', note: 'USDT.D ha fatto un massimo più basso mentre BTC ritestava il minimo.' },
        { time: TODAY - 48 * DAY, kind: 'bearish', note: 'USDT.D in salita nonostante il rimbalzo di BTC: rimbalzo debole.' },
        { time: TODAY - 120 * DAY, kind: 'bullish', note: 'Rifiuto di USDT.D dalla resistenza 7.6%.' },
      ],
      note: 'La dominance USDT è ricostruita dalle capitalizzazioni dei principali asset (BTC, ETH, USDT, USDC, XRP, DOGE, ADA) e calibrata sul dato globale CoinGecko. Le correlazioni sono calcolate sui rendimenti logaritmici giornalieri; un lag positivo indica che USDT.D anticipa BTC.',
    }
  })
}

function forecast(horizon: number): Forecast {
  return memo(`fc-${horizon}`, () => {
    const dd = daily().slice(-365)
    const last = dd[dd.length - 1].close
    const vol = 0.028
    const drift = 0.0006
    const bands = Array.from({ length: horizon }, (_, i) => {
      const h = i + 1
      const m = last * Math.exp(drift * h)
      const s = vol * Math.sqrt(h)
      return { time: TODAY + h * DAY, p05: round(m * Math.exp(-1.645 * s)), p25: round(m * Math.exp(-0.674 * s)), p50: round(m), p75: round(m * Math.exp(0.674 * s)), p95: round(m * Math.exp(1.645 * s)) }
    })
    const r = rng(9)
    const scen = (name: string, prob: number, k: number, description: string) => {
      let p = last
      const path = Array.from({ length: horizon }, (_, i) => { p *= Math.exp(k / horizon + gauss(r) * 0.01); return { time: TODAY + (i + 1) * DAY, value: round(p) } })
      return { name, prob, target: round(path[path.length - 1].value!, 0), description, path }
    }
    const bt = daily().slice(-300, -30)
    return {
      horizon, generated_at: NOW, last_price: round(last),
      history: dd.map((c) => ({ time: c.time, value: round(c.close) })),
      bands,
      targets: [7, 30, 60, 90].filter((x) => x <= horizon).map((days) => {
        const b = bands[days - 1]
        return { days, low: b.p05, high: b.p95, median: b.p50, up_prob: round(0.52 + days * 0.0006, 3) }
      }),
      scenarios: [
        scen('Rialzista', 0.28, 0.32, 'Recupero sopra $82K, short squeeze e ritorno verso i massimi di giugno, sostenuto da afflussi ETF.'),
        scen('Base', 0.47, 0.06, 'Accumulo laterale tra $66K e $82K in linea con la fase finale del bear market storico.'),
        scen('Ribassista', 0.25, -0.24, 'Perdita del supporto a $66K e capitolazione verso il bottom di ciclo stimato ($52–64K).'),
      ],
      models: [
        { name: 'Gradient Boosting', weight: 0.34, median_30d: round(last * 1.021, 0), note: 'Feature tecniche + on-chain' },
        { name: 'Analogie frattali', weight: 0.24, median_30d: round(last * 1.038, 0), note: 'Media pesata dei top-10 match' },
        { name: 'Modello di ciclo', weight: 0.2, median_30d: round(last * 0.986, 0), note: 'Fase del ciclo vs storico' },
        { name: 'GARCH / random walk', weight: 0.14, median_30d: round(last * 1.004, 0), note: 'Baseline di volatilità' },
        { name: 'Power Law', weight: 0.08, median_30d: round(last * 1.06, 0), note: 'Reversione al fair value' },
      ],
      features: [
        ['Momentum 30g', 0.18], ['Fase del ciclo', 0.15], ['MVRV Z-Score', 0.12], ['Funding rate', 0.1], ['USDT dominance Δ7g', 0.09],
        ['Distanza EMA 200', 0.08], ['Volatilità realizzata', 0.08], ['Open Interest Δ', 0.07], ['Fear & Greed', 0.06], ['Hash rate', 0.04], ['Volume', 0.03],
      ].map(([name, importance]) => ({ name: name as string, importance: importance as number })),
      backtest: {
        horizon: 30, hit_rate: 61.4, mape: 9.8, coverage_90: 87.2, samples: 1240,
        points: bt.filter((_, i) => i % 3 === 0).map((c, i) => { const pr = c.close * (1 + Math.sin(i / 5) * 0.04 + gauss(r) * 0.03); return { time: c.time, actual: round(c.close), predicted: round(pr), p05: round(pr * 0.84), p95: round(pr * 1.18) } }),
      },
      disclaimer: 'Le previsioni sono stime statistiche basate su dati storici e non costituiscono consulenza finanziaria. I mercati delle criptovalute sono altamente volatili: non investire più di quanto puoi permetterti di perdere.',
    }
  })
}

function insights(): Insights {
  return {
    items: [
      { title: 'Fase bear avanzata', text: 'Sono passati ~370 giorni dal top di ottobre 2025: storicamente il bottom arriva dopo 365–410 giorni. La finestra stimata per il minimo di ciclo è Q4 2026.', category: 'cycle', tone: 'neutral', confidence: 72 },
      { title: 'Frattale 4h simile a marzo 2020', text: 'La struttura attuale ha una somiglianza del 81.7% con il pattern di marzo 2020; 4 analoghi su 5 mostrano un ritest di $71.1K prima di un rialzo.', category: 'fractal', tone: 'bullish', confidence: 64 },
      { title: 'Liquidità sopra $77K', text: 'Cluster di liquidazioni short stimato a $77.4K (≈$410M): possibile magnete per il prezzo nel breve.', category: 'liquidity', tone: 'bullish', confidence: 58 },
      { title: 'USDT dominance in rifiuto', text: 'USDT.D è stata respinta dalla resistenza al 7.1%: storicamente un segnale positivo per BTC con un anticipo di ~2 giorni.', category: 'usdt', tone: 'bullish', confidence: 61 },
      { title: 'MVRV vicino a 1.3', text: 'Il prezzo è vicino al realized price: zona di accumulo storica per gli investitori di lungo periodo.', category: 'onchain', tone: 'bullish', confidence: 69 },
      { title: 'Posizionamento retail troppo long', text: 'Il 62% degli account è long con OI in crescita: rischio di long squeeze sotto $70K.', category: 'derivatives', tone: 'bearish', confidence: 55 },
      { title: 'Sotto la EMA 200 giornaliera', text: 'Il trend di fondo resta ribassista finché il prezzo non chiude sopra la EMA 200 (~$84K).', category: 'technical', tone: 'bearish', confidence: 66 },
    ],
    summary: 'Quadro misto: ciclo in fase bear avanzata con segnali on-chain di accumulo, mentre derivati e trend tecnico suggeriscono prudenza nel breve. Livelli chiave: supporto $71K, resistenza $77–82K.',
    llm: { available: true, model: 'claude-mock' },
    generated_at: NOW - 240,
  }
}

function status(): Status {
  const ds = ['daily', 'k_1w', 'k_1d', 'k_4h', 'k_1h', 'fut_15m', 'funding', 'oi_15m', 'ls', 'onchain', 'caps', 'fng']
  return {
    datasets: ds.map((name, i) => ({ name, rows: 1000 + i * 1371, last: NOW - (i % 4) * 600, age_s: (i % 4) * 600 })),
    llm: { available: true, model: 'claude-mock' },
    liquidation_stream: true,
    stream: { clients: 1, connected: { spot: true, futures: true }, last_price: PRICE() },
  }
}

// ------------------------------------------------------------------ router
export function mockGet(path: string, p: Record<string, string | number | boolean | undefined>): unknown {
  const num = (k: string, def: number) => (p[k] === undefined ? def : Number(p[k]))
  switch (path) {
    case '/overview': return overview()
    case '/candles': return candlesFor(String(p.tf ?? '1d'), num('limit', 1000))
    case '/indicators': return indicators(String(p.tf ?? '1d'), num('limit', 1000))
    case '/levels': return levels(String(p.tf ?? '1d'))
    case '/cycles': return cycles()
    case '/onchain': return onchain()
    case '/derivatives': return derivatives()
    case '/liquidations': return liquidations(String(p.range ?? '7d'))
    case '/fractals': return fractals(String(p.tf ?? '4h'), num('window', 60), num('horizon', 30), num('top', 5))
    case '/usdt': return usdt()
    case '/forecast': return forecast(num('horizon', 90))
    case '/insights': return { ...insights(), generated_at: p.refresh ? NOW : NOW - 240 }
    case '/status': return status()
    case '/agents': return agentsMock()
    case '/agents/messages': return agentMessagesMock(num('limit', 100), p.agent as string | undefined)
    default: throw new Error(`Mock non disponibile per ${path}`)
  }
}

export function mockChatReply(messages: ChatMessage[]): string {
  const q = messages[messages.length - 1]?.content ?? ''
  return `**Risposta simulata (modalità mock)** alla domanda: _"${q.slice(0, 80)}"_\n\n` +
    `Ecco una sintesi del contesto attuale:\n\n` +
    `- **Ciclo**: fase *bear* avanzata, ~370 giorni dal top di ottobre 2025.\n` +
    `- **Livelli chiave**: supporto a **$71.1K**, resistenza a **$77.4K**.\n` +
    `- **Frattali**: somiglianza 81.7% con marzo 2020 (4h), bias moderatamente rialzista.\n\n` +
    `| Orizzonte | Mediana | Prob. rialzo |\n|---|---|---|\n| 30g | $75.8K | 54% |\n| 90g | $78.3K | 57% |\n\n` +
    `> Non è consulenza finanziaria.`
}

export type { T }

// ------------------------------------------------------------------ mock live emitter (WS replacement)
let liveStarted = false
export function startMockLive(emit: (m: unknown) => void) {
  if (liveStarted) return
  liveStarted = true
  const r = rng(Date.now() % 100000)
  const TF: Record<string, number> = { '1m': 60, '15m': 900, '1h': 3600, '4h': 14400, '1d': DAY, '1w': 7 * DAY }
  let price = PRICE()
  const cur: Record<string, Candle> = {}
  const lastOf = (tf: string): Candle | undefined => {
    const src = tf === '1m' ? undefined : candlesFor(tf, 2)
    return src?.[src.length - 1]
  }
  for (const tf of Object.keys(TF)) {
    const l = lastOf(tf)
    const t = Math.floor(Date.now() / 1000 / TF[tf]) * TF[tf]
    cur[tf] = l && l.time === t ? { ...l } : { time: t, open: price, high: price, low: price, close: price, volume: 0 }
  }
  const tick = () => {
    const now = Math.floor(Date.now() / 1000)
    price *= Math.exp(gauss(r) * 0.00035)
    const prev = PRICE() / (1 + 0.0123)
    emit({ type: 'ticker', time: now, price: round(price), change_24h: round(((price - prev) / prev) * 100), high_24h: round(PRICE() * 1.018), low_24h: round(PRICE() * 0.976), volume_24h_usd: 31.4e9 + r() * 2e8 })
    emit({ type: 'mark', time: now, mark: round(price * 1.0004), index: round(price), funding_rate: round(0.0064 + gauss(r) * 0.0004, 5), next_funding: Math.ceil(now / 28800) * 28800 })
    for (const tf of Object.keys(TF)) {
      const t = Math.floor(now / TF[tf]) * TF[tf]
      let c = cur[tf]
      let closed = false
      if (t > c.time) {
        emit({ type: 'kline', tf, closed: true, candle: c })
        c = cur[tf] = { time: t, open: c.close, high: c.close, low: c.close, close: c.close, volume: 0 }
        closed = false
      }
      c.close = round(price)
      c.high = Math.max(c.high, price)
      c.low = Math.min(c.low, price)
      c.volume += r() * 3
      emit({ type: 'kline', tf, closed, candle: { ...c } })
    }
    if (r() < 0.45) {
      const side = r() > 0.5 ? 'long' : 'short'
      const usd = round(1500 + r() ** 4 * 1.4e6, 0)
      emit({ type: 'liquidation', time: now, side, price: round(price * (1 + (side === 'long' ? -1 : 1) * r() * 0.001)), qty: round(usd / price, 4), usd })
    }
  }
  tick()
  setInterval(tick, 1000)
  startMockAgents(emit)
}

export function mockPost(path: string): unknown {
  const m = path.match(/^\/agents\/([^/]+)\/run$/)
  if (m) return runAgentMock(decodeURIComponent(m[1]))
  throw new Error(`Mock POST non disponibile per ${path}`)
}
