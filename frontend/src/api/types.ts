// Types copied from CONTRACT.md (source of truth). Keep in sync with backend.

export type T = number // unix seconds
export type Pt = { time: T; value: number | null }
export type Candle = { time: T; open: number; high: number; low: number; close: number; volume: number; /** base volume bought by takers (WS klines) */ taker_buy?: number }
export type Tf = '15m' | '1h' | '4h' | '1d' | '1w'
export type Tone = 'bullish' | 'bearish' | 'neutral'

// ---------------------------------------------------------------- MARKET
export interface Overview {
  price: number
  change_24h: number
  high_24h: number
  low_24h: number
  volume_24h_usd: number
  volume_change: number | null
  market_cap: number
  market_cap_change_24h: number | null
  btc_dominance: number
  /** 24h change in percentage POINTS (optional until backend rebuild) */
  btc_dominance_change_24h?: number | null
  usdt_market_cap: number
  usdt_dominance: number
  usdt_mcap_change_7d: number | null
  fear_greed: { value: number; label: string; change_1d: number | null }
  funding_rate: number | null
  open_interest_usd: number | null
  ath: { price: number; time: T; drawdown: number }
  sparklines: { price: Pt[]; market_cap: Pt[]; volume: Pt[]; dominance: Pt[]; usdt: Pt[]; fng: Pt[] }
  updated_at: T
}

export interface Indicators {
  ema: { [period: string]: Pt[] }
  sma: { [period: string]: Pt[] }
  bb: { upper: Pt[]; mid: Pt[]; lower: Pt[] }
  rsi: Pt[]
  macd: { macd: Pt[]; signal: Pt[]; hist: Pt[] }
  vwap?: Pt[]
  atr: Pt[]
  summary: { name: string; value: string; signal: Tone }[]
}

export type PivotKey = 'P' | 'R1' | 'R2' | 'R3' | 'S1' | 'S2' | 'S3'
export type CamKey = 'H1' | 'H2' | 'H3' | 'H4' | 'L1' | 'L2' | 'L3' | 'L4'
export type PivotPeriod = 'daily' | 'weekly' | 'monthly'
export interface PivotSet {
  classic: Record<PivotKey, number>
  fibonacci: Record<PivotKey, number>
  camarilla: Record<CamKey, number>
}
export interface Levels {
  pivots: { [period in PivotPeriod]: PivotSet }
  swings: { time: T; price: number; kind: 'high' | 'low'; strength: number }[]
  zones: { low: number; high: number; kind: 'support' | 'resistance'; touches: number; strength: number; last_touch: T }[]
  key_levels: { label: string; price: number; kind: 'support' | 'resistance'; distance: number }[]
  fib_retracement: { from: { time: T; price: number }; to: { time: T; price: number }; levels: { ratio: number; price: number }[] }
}

// ---------------------------------------------------------------- CYCLES
export type TimePrice = { time: T; price: number }
export type EstWindow = { from: T; to: T; mid: T; price_low: number; price_high: number }
export interface Cycles {
  halvings: { n: number; time: T; block: number; price: number | null; estimated?: boolean }[]
  cycles: {
    n: number
    bottom: TimePrice
    top: TimePrice | null
    next_bottom: TimePrice | null
    days_bottom_to_top: number | null
    days_top_to_bottom: number | null
    days_halving_to_top: number | null
    gain: number | null
    drawdown: number | null
    status: 'complete' | 'in_progress'
  }[]
  current: {
    phase: 'accumulation' | 'bull' | 'distribution' | 'bear'
    phase_confidence: number // 0-100
    phase_probabilities?: Partial<Record<'accumulation' | 'bull' | 'distribution' | 'bear', number>>
    days_since_bottom: number
    days_since_top: number | null
    days_since_halving: number
    progress: number
    est_next_bottom: EstWindow | null
    est_next_top: EstWindow | null
    notes: string[]
    probable_bottom?: { time: T; price: number; rebound: number; days_after_top: number } | null
    days_since_confirmed_bottom?: number
    bottom_window_kind?: 'retest' | 'next_bottom'
  }
  durations_trend: { metric: string; values: { n: number; days: number }[]; projected_next: number }[]
  overlay: { anchor: 'bottom' | 'halving' | 'top'; series: { name: string; points: { day: number; roi: number }[] }[] }[]
  models: {
    power_law: { fair: Pt[]; support: Pt[]; resistance: Pt[]; current_fair: number; deviation: number; slope?: number; intercept?: number }
    /** bands[i].series = UPPER edge of band i, ordered bottom->top; floor = lower edge of band 0 */
    rainbow: { bands: { name: string; color: string; series: Pt[] }[]; current_band: string; floor?: Pt[] }
    pi_cycle: { sma111: Pt[]; sma350x2: Pt[]; crosses: T[]; distance: number }
    mayer: { series: Pt[]; current: number }
    two_year_ma: { ma: Pt[]; ma_x5: Pt[] }
  }
  price_log: Pt[]
}

// ---------------------------------------------------------------- ON-CHAIN
export interface OnChainMetric {
  key: string
  label: string
  value: number
  display: string
  change_30d: number | null
  status: string
  tone: Tone
  spark: Pt[]
}
export interface OnChain {
  metrics: OnChainMetric[]
  series: { [key: string]: Pt[] }
  network: {
    block_height: number | null
    fees: { fastest: number; hour: number; economy: number } | null
    difficulty_change: number | null
    next_retarget: T | null
    halving_eta: T | null
    blocks_to_halving: number | null
  }
}

// ---------------------------------------------------------------- DERIVATIVES
export interface Derivatives {
  funding: { current: number; annualized: number; series: Pt[]; avg_7d: number; avg_30d: number }
  open_interest: { current_usd: number; change_24h: number; series: Pt[] }
  long_short: { accounts: Pt[]; top_traders: Pt[]; taker: Pt[]; current_long_pct: number }
  basis: { mark: number; index: number; premium: number }
  signals: { text: string; tone: Tone }[]
}

export type LiqRange = '1d' | '3d' | '7d' | '30d'
export interface Liquidations {
  heatmap: { times: T[]; prices: number[]; values: number[][]; max: number; candles: Candle[] }
  clusters: { price: number; usd: number; side: 'long' | 'short'; distance: number }[]
  pools: { price: number; kind: 'buy_side' | 'sell_side'; source: string; strength: number }[]
  /** real liquidations collected live (most recent first, max 300); exchange/symbol/qty added in DERIVATIVES PRO */
  events: { time: T; side: 'long' | 'short'; price: number; usd: number; qty?: number; exchange?: LiqExchange; symbol?: string }[]
  totals: {
    long_24h: number; short_24h: number; long_7d: number; short_7d: number; collecting_since: T | null
    all_since?: T | null
    by_exchange?: Partial<Record<LiqExchange, LiqExchangeTotals>>
  }
  magnet: { price: number; side: 'long' | 'short'; usd: number } | null
  coverage?: LiqCoverage | null
  validation?: LiqValidation | null
}
export type LiqExchange = 'binance' | 'bybit' | 'okx'
export interface LiqExchangeTotals {
  name: string; long_24h: number; short_24h: number; long_7d: number; short_7d: number; count_24h: number
  symbols: string[]; note: string; connected: boolean; last_event: T | null; collecting_since: T | null
}
export interface LiqCoverage {
  exchanges: { id: LiqExchange; name: string; included: boolean; oi_usd: number | null; oi_btc: number | null; share_pct: number | null; factor: number | null; series_since: T | null; resolution: '15m' | '1h→15m' }[]
  included_oi_usd: number | null; share_of_three_pct: number | null; previous_binance_usdt_share_pct: number | null; share_of_global_pct: number | null
  assumptions: { leverage: { lev: number; weight: number }[]; mmr_pct: number; long_share: string }
}
export interface LiqValidation {
  status: 'ok' | 'preliminary' | 'insufficient'; hours: number; events: number; from: T | null; to: T | null; exchanges: LiqExchange[]
  spearman: number | null; peak_hit_pct: number | null; peak_hours: number; baseline_pct: number
  price_hit_pct: number | null; price_expected_pct: number | null; price_lift: number | null; price_events: number
}

// ---------------------------------------------------------------- FRACTALS
export interface FractalMatch {
  rank: number
  start: T
  end: T
  similarity: number
  correlation: number
  dtw: number
  label: string
  path: number[]
  future: number[]
  outcome: number
}
export interface Fractals {
  tf: string
  window: number
  horizon: number
  current: { time: T; close: number }[]
  matches: FractalMatch[]
  projection: { times: T[]; p10: number[]; p50: number[]; p90: number[]; bias: Tone; up_prob: number }
  retests: { price: number; time: T; kind: 'support' | 'resistance' | 'liquidity'; note: string }[]
  multi_tf: { tf: string; similarity: number; bias: string; up_prob: number }[]
}

export interface UsdtAnalysis {
  series: { time: T; btc: number; usdt_d: number | null; usdt_mcap: number; total_mcap_est: number }[]
  current: { usdt_d: number; usdt_d_change_7d: number; usdt_mcap: number; mint_30d: number }
  correlation: {
    r30: Pt[]
    r90: Pt[]
    current_30: number
    current_90: number
    lead_lag: { lag: number; corr: number }[]
    best_lag: number
  }
  levels: { price: number; kind: 'support' | 'resistance' }[]
  fractal: {
    similarity: number
    matches: { start: T; end: T; similarity: number; btc_outcome: number; usdt_outcome: number }[]
  }
  divergences: { time: T; kind: 'bullish' | 'bearish'; note: string }[]
  note: string
}

// ---------------------------------------------------------------- FORECAST + AI
export interface Forecast {
  horizon: number
  generated_at: T
  model_trained_at?: T | null
  last_price: number
  history: Pt[]
  bands: { time: T; p05: number; p25: number; p50: number; p75: number; p95: number }[]
  targets: { days: number; low: number; high: number; median: number; up_prob: number }[]
  scenarios: { name: string; prob: number; target: number; description: string; path: Pt[] }[]
  models: { name: string; weight: number; median_30d: number; note: string }[]
  features: { name: string; importance: number }[]
  backtest: {
    horizon: number
    hit_rate: number
    mape: number
    coverage_90: number
    samples: number
    points: { time: T; predicted: number; actual: number; p05?: number; p95?: number }[]
  }
  disclaimer: string
}

export type InsightCategory = 'cycle' | 'fractal' | 'liquidity' | 'usdt' | 'onchain' | 'derivatives' | 'technical'
export interface Insights {
  items: { title: string; text: string; category: InsightCategory; tone: Tone; confidence: number }[]
  summary: string
  llm: { available: boolean; model: string | null }
  generated_at: T
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export interface Status {
  datasets: { name: string; rows: number; last: T | null; age_s: number | null }[]
  llm: { available: boolean; model: string | null }
  liquidation_stream: boolean
  stream?: { clients: number; connected: { spot: boolean; futures: boolean }; last_price: number | null }
}

// ---------------------------------------------------------------- AGENTS
export type KnownAgentId =
  | 'market' | 'levels' | 'liquidity' | 'patterns' | 'correlation' | 'cycles' | 'onchain' | 'derivatives' | 'forecast' | 'analyst'
  | 'flows' | 'analogs' | 'timepivots' | 'macro' | 'clock' | 'miners' | 'leverage' | 'usdt_analogs' | 'stablecoins'
/** Known ids get autocompletion, but any string returned by the backend is accepted (agent team is data-driven). */
export type AgentId = KnownAgentId | (string & {})
export type AgentStatusKind = 'idle' | 'running' | 'error'
export interface Agent {
  id: AgentId
  name: string
  role: string
  icon: string
  color: string
  status: AgentStatusKind
  error: string | null
  interval_s: number
  runs: number
  last_run: T | null
  next_run: T | null
  last_duration_ms: number | null
  findings: { title: string; text: string; tone: Tone; confidence: number; time: T }[]
  subscribes: string[]
  publishes: string[]
  stats: { messages_sent: number; messages_received: number }
}
export interface AgentMessage {
  id: number
  time: T
  from: AgentId
  to: AgentId | '*'
  topic: string
  kind: 'finding' | 'request' | 'reply' | 'alert'
  text: string
  tone: Tone
  data?: Record<string, unknown>
}
export interface AgentEdge { from: AgentId; to: AgentId; topics: string[]; count: number; last: T | null }
export interface AgentsResponse { agents: Agent[]; edges: AgentEdge[]; started_at: T }
export interface AgentStatusMsg { id: AgentId; status: AgentStatusKind; last_run: T | null; next_run: T | null; last_duration_ms: number | null }
