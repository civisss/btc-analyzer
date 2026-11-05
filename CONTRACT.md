# Bitcoin Analyzer — API contract (source of truth)

Backend: FastAPI in `backend/app`, all routes under `/api`, JSON only.
Frontend: React + Vite + TS in `frontend/`, dev proxy `/api` -> `http://localhost:8000`.
Production: one Docker image, FastAPI serves the built frontend from `frontend/dist`.

## Global conventions
- Every `time` is **UNIX seconds (number, UTC)**. Prices in USD. Percentages are **percent numbers** (e.g. `2.34` = 2.34%) unless the field name ends in `_ratio` / `_frac`.
- Numbers never NaN/Infinity: send `null` instead.
- Timeframes `tf`: `"15m" | "1h" | "4h" | "1d" | "1w"`.
- Errors: HTTP 4xx/5xx with `{ "detail": string }`.
- Data layer: `from app.data import store; store.get(name) -> pandas.DataFrame` (column `time` is tz-aware UTC Timestamp). Datasets:
  - `daily` (2010→, OHLCV USD, long history for cycles), `k_1w`,`k_1d`,`k_4h`,`k_1h` (Binance BTCUSDT spot 2017→, cols open high low close volume taker_buy),
  - `fut_15m` (Binance futures 15m, last 30 d), `funding` (time, rate — 8h, 2019→), `oi_15m` / `oi_1h` (time, oi [BTC], oi_usd; last ~30 d, accumulates over time),
  - `ls` (time, ls_accounts, long_pct, ls_top, taker_ratio; 1h, last 30 d), `onchain` (time, PriceUSD, CapMrktCurUSD, CapMVRVCur, HashRate, AdrActCnt, TxCnt, SplyCur, IssTotUSD),
  - `caps` (time, btc, eth, usdt, usdc, xrp, doge, ada — market caps USD, 2013→), `fng` (time, value, label).
  - `store.liquidations()` -> DataFrame(time, side['long'|'short' = side that got liquidated], price, qty, usd) collected live.
  - Live snapshot helpers in `app.data.sources`: `binance_ticker()`, `coingecko_global()`, `futures_premium()`, `futures_open_interest()`, `mempool_stats()`.
- Heavy computations must be cached in-process (e.g. `functools.lru_cache` keyed on dataset last time / a `ttl_cache` helper in `app/util.py`).
- Each backend area lives in its own router file `backend/app/routers/<area>.py` exposing `router = APIRouter()`; `main.py` mounts them all with prefix `/api`.

```ts
type T = number;              // unix seconds
type Pt = { time: T; value: number | null };
type Candle = { time: T; open: number; high: number; low: number; close: number; volume: number };

// ---------------------------------------------------------------- MARKET (router: market.py)
// GET /api/overview
interface Overview {
  price: number; change_24h: number; high_24h: number; low_24h: number;
  volume_24h_usd: number; volume_change: number | null;
  market_cap: number; market_cap_change_24h: number | null;
  btc_dominance: number; usdt_market_cap: number; usdt_dominance: number; usdt_mcap_change_7d: number | null;
  fear_greed: { value: number; label: string; change_1d: number | null };
  funding_rate: number | null;          // percent per 8h, e.g. 0.01
  open_interest_usd: number | null;
  ath: { price: number; time: T; drawdown: number };   // drawdown percent (negative)
  sparklines: { price: Pt[]; market_cap: Pt[]; volume: Pt[]; dominance: Pt[]; usdt: Pt[]; fng: Pt[] }; // ~60 daily points
  updated_at: T;
}
// GET /api/candles?tf=1d&limit=1000   -> Candle[]
// GET /api/indicators?tf=1d&limit=1000
interface Indicators {
  ema: { [period: string]: Pt[] };        // "21","50","200"
  sma: { [period: string]: Pt[] };        // "50","200"
  bb: { upper: Pt[]; mid: Pt[]; lower: Pt[] };
  rsi: Pt[]; macd: { macd: Pt[]; signal: Pt[]; hist: Pt[] };
  vwap?: Pt[]; atr: Pt[];
  summary: { name: string; value: string; signal: "bullish" | "bearish" | "neutral" }[]; // table of readings
}
// GET /api/levels?tf=1d
interface Levels {
  pivots: { [period in "daily" | "weekly" | "monthly"]: {
    classic: Record<"P"|"R1"|"R2"|"R3"|"S1"|"S2"|"S3", number>;
    fibonacci: Record<"P"|"R1"|"R2"|"R3"|"S1"|"S2"|"S3", number>;
    camarilla: Record<"H1"|"H2"|"H3"|"H4"|"L1"|"L2"|"L3"|"L4", number>; } };
  swings: { time: T; price: number; kind: "high" | "low"; strength: number }[];   // zigzag pivots on tf
  zones: { low: number; high: number; kind: "support" | "resistance"; touches: number; strength: number; last_touch: T }[];
  key_levels: { label: string; price: number; kind: "support" | "resistance"; distance: number }[]; // distance percent from price, sorted R3..S3
  fib_retracement: { from: { time: T; price: number }; to: { time: T; price: number }; levels: { ratio: number; price: number }[] };
}

// ---------------------------------------------------------------- CYCLES (router: cycles.py)
// GET /api/cycles
interface Cycles {
  halvings: { n: number; time: T; block: number; price: number }[];        // incl. next estimated halving (estimated: true)
  cycles: { n: number; bottom: { time: T; price: number }; top: { time: T; price: number } | null;
            next_bottom: { time: T; price: number } | null;
            days_bottom_to_top: number | null; days_top_to_bottom: number | null; days_halving_to_top: number | null;
            gain: number | null; drawdown: number | null; status: "complete" | "in_progress" }[];
  current: { phase: "accumulation" | "bull" | "distribution" | "bear"; phase_confidence: number;
             days_since_bottom: number; days_since_top: number | null; days_since_halving: number;
             progress: number;                         // percent of estimated full cycle
             est_next_bottom: { from: T; to: T; mid: T; price_low: number; price_high: number } | null;
             est_next_top: { from: T; to: T; mid: T; price_low: number; price_high: number } | null;
             notes: string[] };
  durations_trend: { metric: string; values: { n: number; days: number }[]; projected_next: number }[]; // adaptive: cycles shortening
  overlay: { anchor: "bottom" | "halving" | "top"; series: { name: string; points: { day: number; roi: number }[] }[] }[]; // roi = price/anchor price (x)
  models: {
    power_law: { fair: Pt[]; support: Pt[]; resistance: Pt[]; current_fair: number; deviation: number };
    rainbow: { bands: { name: string; color: string; series: Pt[] }[]; current_band: string };
    pi_cycle: { sma111: Pt[]; sma350x2: Pt[]; crosses: T[]; distance: number };
    mayer: { series: Pt[]; current: number };
    two_year_ma: { ma: Pt[]; ma_x5: Pt[] };
  };
  price_log: Pt[];   // daily close, full history (for the models chart)
}

// ---------------------------------------------------------------- ON-CHAIN (router: onchain.py)
// GET /api/onchain
interface OnChain {
  metrics: { key: string; label: string; value: number; display: string; change_30d: number | null;
             status: string; tone: "bullish" | "bearish" | "neutral"; spark: Pt[] }[]; // mvrv, mvrv_z, realized_price, hashrate, active_addresses, tx_count, supply, issuance_usd, puell, nupl
  series: { [key: string]: Pt[] };   // full daily series per metric key (+ "price")
  network: { block_height: number | null; fees: { fastest: number; hour: number; economy: number } | null;
             difficulty_change: number | null; next_retarget: T | null; halving_eta: T | null; blocks_to_halving: number | null };
}

// ---------------------------------------------------------------- DERIVATIVES (router: derivatives.py)
// GET /api/derivatives
interface Derivatives {
  funding: { current: number; annualized: number; series: Pt[]; avg_7d: number; avg_30d: number }; // percent per 8h
  open_interest: { current_usd: number; change_24h: number; series: Pt[] };   // usd
  long_short: { accounts: Pt[]; top_traders: Pt[]; taker: Pt[]; current_long_pct: number };
  basis: { mark: number; index: number; premium: number };                   // premium percent
  signals: { text: string; tone: "bullish" | "bearish" | "neutral" }[];
}
// GET /api/liquidations?range=7d   (range: 1d|3d|7d|30d)
interface Liquidations {
  heatmap: { times: T[]; prices: number[]; values: number[][];   // values[timeIdx][priceIdx] = est. liquidation USD
             max: number; candles: Candle[] };                    // candles over same range for overlay
  clusters: { price: number; usd: number; side: "long" | "short"; distance: number }[];  // top estimated liq clusters near price
  pools: { price: number; kind: "buy_side" | "sell_side"; source: string; strength: number }[]; // equal highs/lows, swing liquidity
  events: { time: T; side: "long" | "short"; price: number; usd: number }[];   // real liquidations collected live (most recent first, max 200)
  totals: { long_24h: number; short_24h: number; long_7d: number; short_7d: number; collecting_since: T | null };
  magnet: { price: number; side: "long" | "short"; usd: number } | null;     // nearest dominant cluster
}

// ---------------------------------------------------------------- FRACTALS (router: fractals.py)
// GET /api/fractals?tf=4h&window=60&horizon=30&top=5
interface Fractals {
  tf: string; window: number; horizon: number;
  current: { time: T; close: number }[];            // last `window` candles
  matches: { rank: number; start: T; end: T; similarity: number;   // 0..100
             correlation: number; dtw: number; label: string;      // e.g. "Mar 2020 (4h)"
             path: number[];      // matched window rescaled to current price scale (len = window)
             future: number[];    // following `horizon` candles rescaled (len = horizon)
             outcome: number }[]; // % change at end of horizon
  projection: { times: T[]; p10: number[]; p50: number[]; p90: number[]; bias: "bullish" | "bearish" | "neutral"; up_prob: number };
  retests: { price: number; time: T; kind: "support" | "resistance" | "liquidity"; note: string }[]; // zones the analogs revisited
  multi_tf: { tf: string; similarity: number; bias: string; up_prob: number }[];  // summary across 1h/4h/1d/1w
}
// GET /api/usdt
interface UsdtAnalysis {
  series: { time: T; btc: number; usdt_d: number | null; usdt_mcap: number; total_mcap_est: number }[]; // daily
  current: { usdt_d: number; usdt_d_change_7d: number; usdt_mcap: number; mint_30d: number };      // mint_30d = USDT supply change USD
  correlation: { r30: Pt[]; r90: Pt[]; current_30: number; current_90: number;
                 lead_lag: { lag: number; corr: number }[]; best_lag: number };  // lag in days, + = USDT.D leads
  levels: { price: number; kind: "support" | "resistance" }[];   // key USDT.D levels (rejection zones)
  fractal: { similarity: number; matches: { start: T; end: T; similarity: number; btc_outcome: number; usdt_outcome: number }[] }; // joint BTC+USDT.D pattern search
  divergences: { time: T; kind: "bullish" | "bearish"; note: string }[];
  note: string;   // methodology (USDT.D reconstructed from top-asset caps, calibrated to CoinGecko)
}

// ---------------------------------------------------------------- FORECAST + AI (routers: forecast.py, ai.py)
// GET /api/forecast?horizon=90   (horizon 7..365) — v2 additions documented in "## FORECAST" below
interface Forecast {
  horizon: number; generated_at: T; last_price: number;
  history: Pt[];                                                     // last ~365 daily closes
  bands: { time: T; p05: number; p25: number; p50: number; p75: number; p95: number }[];   // days 0..horizon
  targets: { days: number; low: number; high: number; median: number; up_prob: number }[]; // 7,30,60,90 (low/high = p05/p95)
  scenarios: { name: string; prob: number; target: number; description: string; path: Pt[] }[];  // bull/base/bear
  models: { name: string; weight: number; median_30d: number; note: string }[];   // ensemble members (+ v2 fields: ForecastMember)
  features: { name: string; importance: number }[];                  // (+ key, group)
  backtest: { horizon: number; hit_rate: number; mape: number; coverage_90: number; samples: number;
              points: { time: T; predicted: number; actual: number }[] };   // (+ coverage_50, mase; points + p05,p95,p25,p75,up_prob,price0)
  disclaimer: string;
}
// GET /api/insights           (cached ~15 min; ?refresh=1 to regenerate)
interface Insights {
  items: { title: string; text: string; category: "cycle"|"fractal"|"liquidity"|"usdt"|"onchain"|"derivatives"|"technical"; tone: "bullish"|"bearish"|"neutral"; confidence: number }[];
  summary: string; llm: { available: boolean; model: string | null }; generated_at: T;
}
// POST /api/chat  body { messages: {role:"user"|"assistant"; content:string}[] }
//   -> text/event-stream of `data: {"delta":"..."}\n\n` ... `data: [DONE]\n\n`
// GET /api/status -> { datasets: { name: string; rows: number; last: T | null; age_s: number | null }[]; llm: {available:boolean; model:string|null}; liquidation_stream: boolean }
```

## AGENTS (engine: app/agents/engine.py, nessun router)
Agenti di sfondo: ricalcolano i dati del proprio dominio con la loro cadenza, pubblicano finding per l'Analista e messaggi sul bus interno
(`kind: "alert"` passa al motore degli avvisi) e a ogni giro riuscito inviano `invalidate` sul WebSocket (mappa `INVALIDATES`, vedi
"REALTIME INVALIDATION"). I moduli affini stanno in un solo agente (`MultiAgent`, una cadenza per ogni parte; una parte in errore non ferma le altre).

| Agente | Moduli | Cadenza |
|---|---|---|
| analyst | consenso pesato con il track record (registrato in tracking) | 120 s |
| market | prezzo, range 24h | 5 s |
| levels | pivot, swing, zone, confluenze su richiesta | 30 s |
| vwap | VWAP ancorati, cross e tocchi | ogni minuto chiuso |
| liquidity | cluster e magneti di liquidazione | 30 s |
| analogs | analoghi grafici e di struttura, frattali, analoghi USDT.D | 120 / 60 / 300 s |
| usdt | USDT dominance, stablecoin | 60 / 600 s |
| cycles | fase di ciclo, orologio, miner, ciclo della leva | 300 s |
| onchain | MVRV, prezzo realizzato, hashrate | 300 s |
| derivatives | funding, OI, long/short, leva aggregata, basis, CME COT | 20 / 300 / 900 / 3600 s |
| flows | flussi spot/perp | 30 s |
| supply_demand | riserve exchange, ETF, attenzione | 1800 s |
| timepivots | pivot temporali | 600 s |
| macro | contesto macro, rotazione, eventi | 300 / 600 s |
| structure | range, pivot di apertura, scenari | 60 / 60 / 120 s |
| positioning | opzioni, sentiment, holder | 120 / 300 / 1800 s |
| anomalies | anomalie del Superchart | 1800 s |
| orderflow | book Binance, trade multi-exchange | 30 / 60 s |
| forecast | previsione a 12 mesi | 600 s |
| verifier | track record e pesi di affidabilità | 1800 s |
| alerts | storico notifiche, regole personali | 30 / 60 s |

`GET /api/status` espone `agents: { total, errors: [{ id, name, error }] }` per l'indicatore di stato della barra laterale.

## ANALOGS (router: analogs.py, engine: app/analysis/analogs.py + analogs_visual.py)
Explainable historical analogs, primarily VISUAL: "the chart forming now looks like these candles of 2023, because x matches x".
Candidates come from the fractal search (Pearson corr + banded DTW on z-normalised log price); the best 80 are re-ranked with
`similarity = 0.70·visual + 0.30·features`.
Visual score = weighted mean of components (0..100; a null component is excluded and the weights renormalised):
shape 30% (corr+DTW), candles 20% (multivariate DTW on [body, upper wick, lower wick]/ATR per candle + body/wick distribution),
legs 20% (ZigZag legs aligned with DTW, compared on move relative to the window range + duration), pattern 15% (deterministic
chart-pattern detectors + trendline geometry), volume 7.5% (volume-by-price profile + volume shape over time), volatility 7.5%
(rolling range/ATR envelope). Feature similarity = 100·2^(−(Δ/scale)²) per indicator.
Cached 60 s; warm < 50 ms, cold ≈ 0.1–0.5 s; payload ≈ 90–140 KB at defaults, ≈ 400 KB at max params.

```ts
// GET /api/analogs?tf=1d&window=60&top=5&horizon=30
//   tf: "1h"|"4h"|"1d"|"1w" (default "1d"); window 20..200 (default 1h:72, 4h:60, 1d:60, 1w:26);
//   top 1..8 (default 5); horizon 5..100 (default window/2). 400 on bad tf / insufficient history.
type AnalogCandle = { time: T; open: number; high: number; low: number; close: number; volume?: number | null }; // analog candles: no volume, integer prices above $1000
interface AnalogFeature {
  key: "change"|"max_dd"|"range"|"vol"|"slope"|"r2"|"position"|"rsi"|"ema50"|"ema200"|"volume"|"structure"|"retests"|"ath_dd"|"cycle"|"usdt"|"funding";
  label: string; current: number | null; analog: number | null;
  display_current: string; display_analog: string; unit: string;
  similarity: number | null;               // 0..100, null = not available for one of the two periods
  weight: number; explanation: string;     // Italian
}
interface VisualComponent { key: "shape"|"candles"|"legs"|"pattern"|"volume"|"volatility"; label: string; score: number | null; weight: number; explanation: string }
interface AnalogLeg {                      // one ZigZag leg (window-relative indices)
  n: number; label: string;                // current: "G1".."Gk"; analog: label of the current leg(s) it is paired with ("G2", "G2/3", "–")
  from_idx: number; to_idx: number; from_time: T; to_time: T; from_price: number; to_price: number;
  pct: number; candles: number;
}
interface AnalogLegPair { current: number; analog: number; similarity: number; text: string } // text "Gamba 2: −12.4% in 8 candele ↔ −11.1% in 9 candele"
interface PatternPoint { idx: number; time: T; price: number; label?: string }
interface ChartPattern {
  key: "double_top"|"double_bottom"|"head_shoulders"|"inv_head_shoulders"|"asc_triangle"|"desc_triangle"|"sym_triangle"|"broadening"
     |"rising_wedge"|"falling_wedge"|"bull_flag"|"bear_flag"|"bull_pennant"|"bear_pennant"|"channel_up"|"channel_down"|"range"
     |"v_bottom"|"v_top"|"cup_handle";
  name: string; family: string; tone: "bullish"|"bearish"|"neutral"; confidence: number;   // 0..95
  lines: { kind: "resistance"|"support"|"neckline"|"pole"|"leg"; points: PatternPoint[] }[]; // 2-point segments to draw
  points: PatternPoint[];                  // labelled key points (tops, head/shoulders, pole start/end, …)
}
interface AnalogMapping {                  // structural points = aligned ZigZag leg endpoints ("x corrisponde a x"), strictly increasing, min gap max(2, window/20) candles
  n: number; kind: "start"|"end"|"high"|"low";
  label: string; analog_label: string; same_role: boolean;
  current: { time: T; price: number; idx: number; pct: number };   // pct = % from the window's first close
  analog:  { time: T; price: number; idx: number; pct: number };
  note: string;
}
interface AnalogMatch {
  rank: number;
  period: { start: T; end: T; label: string; when: string };       // "mar–mag 2023 (1D)", "nel 2023"
  similarity: number;                      // 0.7·visual + 0.3·features
  visual_similarity: number; shape_similarity: number; feature_similarity: number;
  correlation: number; dtw: number; dtw_score: number;
  visual: { score: number; components: VisualComponent[] };
  patterns: { current: ChartPattern[]; analog: ChartPattern[]; common: string | null; common_name: string | null;
              text: string;                // e.g. "Entrambi formano un triangolo discendente."
              score: number };
  legs_current: AnalogLeg[]; legs_analog: AnalogLeg[]; leg_pairs: AnalogLegPair[];
  features: AnalogFeature[]; mapping: AnalogMapping[];
  narrative: string[];                     // deterministic Italian sentences (visual first, then indicators, outcome)
  narrative_llm: string | null;            // rank 1 only, local-LLM rewrite produced in background, numbers verified
  outcome: { candles: number; change: number | null; max_up: number | null; max_down: number | null; end_time: T | null };
  candles: AnalogCandle[];                 // analog window + following `horizon` candles
  projection: { times: T[]; close: number[] };  // analog future rescaled onto the current price
}
interface Analogs {
  tf: string; window: number; horizon: number; top: number; generated_at: T;
  current: { start: T; end: T; label: string; close: number; base_close: number; candles: AnalogCandle[] };
  summary: { count: number; up: number; down: number; agreement: number | null;
             median_outcome: number | null; weighted_outcome: number | null; best_similarity: number | null;
             bias: "bullish"|"bearish"|"neutral"; text: string };
  matches: AnalogMatch[];
  method: string;
}
```

## STRUCTURE ANALOGS (router: struct_analogs.py, engine: app/analysis/structure_analogs.py, agent: analogs, tests: backend/tests/test_structure_analogs.py)
Scheda "Analogia di struttura" della pagina Analoghi (`/analoghi?tab=struttura`): il movimento attuale confrontato con quelli passati per
SEQUENZA di massimi/minimi, con i prossimi pivot proiettati e un backtest walk-forward. Testi composti dal frontend (chiavi + numeri).
- Pivot: `structure.zigzag_confirmed` su ATR(14) di Wilder (prime 13 candele NaN, nessun riempimento con dati futuri), soglia `mult`×ATR,
  indice di conferma `ci`; etichette `structure.label_swings`; BOS/CHoCH `structure.zigzag_breaks` (prima CHIUSURA oltre l'ultimo
  swing confermato; la stessa funzione ora usata da `detect_events`). La candela in formazione non entra nelle rotture.
- Serie: btc = `analogs.load(tf)` dal 2011 (4h|1d|1w); usdtd = USDT.D calibrata (1d da `stablecoins.daily_frame`, 4h = stima
  `usdt_analogs.frame_4h`, 1w = ultima chiusura della settimana) dal 2018; ethbtc = `ethbtc_1d` (1d|1w) dal lug 2017. USDT.D ed ETH/BTC
  sono di sole chiusure → OHLC sintetico (open = chiusura precedente, high/low = max/min tra le due).
- Abbinamento: ultimi K swing (K+1 pivot confermati) → ampiezze log ÷ media |ampiezza|, durate ÷ durata media, etichette. Candidati:
  stesso tipo di ultimo pivot, ≤ max(1, K//3) etichette diverse, analogo + 3 pivot successivi finiti prima dell'inizio del tratto attuale.
  D = mean|Δampiezze| + 0.5·mean|Δdurate| + 0.15·etichette diverse + 0.1·|log rapporto scale| + 0.5·max(0, già percorso dal pivot in
  formazione − swing successivo dell'analogo) (in unità di scala). similarity = 100·e^(−D). Top-N distanti ≥ K pivot tra loro.
- Proiezione: pivot j+1..j+3 dell'analogo riportati sul presente con i rapporti di scala (clip 1/3..3); il primo non può essere meno
  estremo del pivot in formazione (`reached` = già toccato, data = quella dell'estremo), date crescenti e future. Combinata = mediana
  top-N; intervalli = proiezione + quantili 25–75 dei residui del backtest (conformal walk-forward, contengono sempre la proiezione),
  altrimenti P25–P75 degli analoghi (`calibrated: false`).
- Traduzione in BTC (usdtd, ethbtc): β = regressione per l'origine di Δlog BTC su Δlog serie sugli ultimi 24 swing confermati;
  BTC = BTC_now·exp(β·Δlog serie da ora); semiampiezza log = √((β·(P75−P25)/2)² + (0.674·σ_res·√h)²). strength: R² ≥ .5 strong, ≥ .25
  moderate, altrimenti weak. Verificata nel backtest (`backtest.btc`) contro «BTC invariato».
- Backtest: a ogni conferma di un pivot m (T = ci[m]) tutto si ricalcola con i soli pivot confermati a T (test: troncare la serie a T
  lascia identiche tutte le righe). Esito = pivot m+1 (e m+2). Baseline: ampiezza/durata mediane storiche nella direzione alternata
  (pivot ≤ m) e "analogo casuale" (stessi candidati, 400 estrazioni con reinserimento). p_err_random = quota di estrazioni con errore
  medio ≤ modello; p_err_median = test del segno unilaterale sugli errori per istante. Verdetto: n<30 anecdotal · strong = errore medio <
  entrambe le baseline, p_err_random<.05, p_err_median<.05, migliore della mediana in entrambe le metà, hit ≥ baseline · weak = migliore
  di entrambe con almeno un p<.10 · altrimenti none. Cache: backtest per (asset, tf, mult, K, top) finché non si conferma un nuovo pivot
  (0.2–3 s a freddo; 4h USDT.D ≈ 8 s con la stima 4H); risposta 30 s. Payload ≈ 60–100 KB.
- Real time: il frontend aggiorna l'ultima candela e il pivot in formazione col prezzo live (solo BTC) e ricarica alla nuova candela;
  invalidazione WS: l'agente `analogs` (120 s) invalida "/analogs" → anche la query `structAnalogs`.
- Agente `analogs`: finding "Struttura BTC 1D" / "Struttura USDT.D 1D" + topic `analogs.structure.{btc|usdtd}` (prossimo pivot, P25–P75,
  finestra di date, verdetto); tono neutro se il verdetto non è strong/weak.

```ts
// GET /api/analogs/structure?asset=btc&tf=1d&mult=2.5&k=5&top=5
//   asset "btc"|"usdtd"|"ethbtc"; tf "4h"|"1d"|"1w" (ethbtc: 1d|1w); mult 1.5..6 passo 0.5 (default 4h 3 · 1d 2.5 · 1w 2);
//   k 3..8 (default 5); top 1..10 (default 5). 400 su combinazione non valida o pivot insufficienti.
type SaLabel = 'HH'|'LH'|'HL'|'LL'; type SaKind = 'high'|'low'
type SaCandle = { time: T; open: number; high: number; low: number; close: number }   // usd: intero sopra $1000; usdtd in %; ethbtc ratio
interface SaPivot { n: number; idx: number; time: T; price: number; kind: SaKind; label: SaLabel | null; confirmed: T; after: boolean }
interface SaBreak { kind: 'bos_up'|'bos_down'|'choch_up'|'choch_down'; from_idx: number; to_idx: number; level: number; from_time: T; time: T }
interface SaProjPivot { h: 1|2|3; kind: SaKind; label: SaLabel; agree: number | null /* % analoghi con la stessa etichetta */
  price: number; lo: number; hi: number; change: number /* % dall'ultimo prezzo */; time: T; t_lo: T; t_hi: T; bar: number; reached: boolean
  btc: { price: number; lo: number; hi: number } | null }
interface SaAnalog { rank: number; similarity: number; distance: number
  parts: { amp: number; dur: number; mismatch: number; scale: number; short: number }
  start: T; end: T; after_end: T; candles: SaCandle[]; pivots: SaPivot[] /* n 1..K+1 abbinati, K+2..K+4 after */; breaks: SaBreak[]; end_idx: number
  ratio: { amp: number; time: number }; scale: { amp: number /* % medio */; bars: number }; labels: (SaLabel | null)[]
  outcome: { h: number; label: SaLabel | null; kind: SaKind; change: number; bars: number }[]; projection: SaProjPivot[] }
interface StructAnalogs {
  asset: string; tf: string; mult: number; k: number; top: number; unit: 'usd'|'pct'|'ratio'; generated_at: T
  assets: Record<string, string[]>; synthetic: boolean
  current: { candles: SaCandle[]; pivots: SaPivot[]; breaks: SaBreak[]
    pending: { idx: number; time: T; price: number; kind: SaKind; label: SaLabel; move: number }   // pivot in formazione (estremo finora)
    last: { time: T; price: number; forming: boolean }; btc_price: number
    swings: { amp: number; bars: number }[]; scale: { amp: number; bars: number }; start: T; end: T }
  projection: { n: number; pivots: SaProjPivot[]; calibrated: boolean; few: boolean } | null
  analogs: SaAnalog[]
  translation: { method: 'leg_elasticity'; beta: number; r2: number; corr: number; n: number; resid_sd: number; strength: 'strong'|'moderate'|'weak'; legs: number } | null
  history: { pivots: number; candidates: number; first: T; max_mismatch: number }
  backtest: { n: number; from?: T; to?: T; ms?: number; verdict: 'none'|'weak'|'strong'|'anecdotal'
    model?: { hit; cov; cov_raw; err_med; err_mean; time_err_med; time_cov; agree_hit: { n; hit } | null }   // % (errori in % di prezzo, tempo in candele)
    base_median?: { hit; err_med; err_mean; time_err_med }; base_random?: { hit; err_med; err_mean; time_err_med; hit_q95; err_q05 }
    mase?: N; mase_random?: N; mase_time?: N; p_err_random?: number; p_hit_random?: number; p_err_median?: N
    next2?: { hit; base_hit; cov; err_med; base_err_med; mase }
    btc?: { n; err_med; base_err_med; mase; cov; p_sign; dir_hit } | null       // traduzione in BTC vs «BTC invariato»
    halves?: { from: T; to: T; n: number; hit: number; base_hit: number; mase: N }[]
    recent?: { time: T; kind: SaKind; pred_label: SaLabel; actual_label: SaLabel; hit: boolean; pred: number; lo: number; hi: number
               actual: number; actual_time: T; inside: boolean; err: number; base_err: number }[]
    calibration?: { n: number[]; lr: ([number, number] | null)[]; dt: ([number, number] | null)[] } }
}
```

## FLOWS — spot vs futures (router: flows.py)
```ts
// GET /api/flows?tf=1h|4h|1d&range=1d|3d|7d|30d|90d|1y|3y      (USD values; aggressive = taker orders)
interface Flows {
  tf: string; range: string;
  series: { time: T; price: number; spot_buy: number; spot_sell: number; spot_delta: number;
            perp_buy: number; perp_sell: number; perp_delta: number; spot_cvd: number; perp_cvd: number }[];
  windows: { label: "1h" | "4h" | "24h" | "7d" | "30d"; spot_delta: number; perp_delta: number;
             spot_buy_pct: number; perp_buy_pct: number; spot_volume: number; perp_volume: number;
             perp_spot_ratio: number; price_change: number }[];
  current: { dominant: "spot" | "perp"; bias: "bullish" | "bearish" | "neutral"; spot_buy_pct_24h: number; perp_buy_pct_24h: number };
  signals: { text: string; tone: "bullish" | "bearish" | "neutral" }[];   // Italian
  delta_correlation: number | null; note: string;
}
// WS /api/ws: kline candles now include `taker_buy` (base volume bought by takers).
// New WS message {"type":"perp_kline","tf":"1m","closed":bool,"candle":{time,open,high,low,close,volume,taker_buy}} (Binance USDⓈ-M perpetual).
// Live 1-minute deltas: spot = kline tf "1m" (2*taker_buy - volume)*close ; perp = perp_kline likewise.
```

## TIME PIVOTS (router: timepivots.py, engine: app/analysis/timepivots.py)
"Pivot temporali": dates where BTC historically reacted in a recurring way. All sources are computed from data only
(`daily` merged history via cycles.load_daily, `k_1d`, `k_4h`, `k_1h`) + cycles detection reused from routers/cycles.py.
Cache: daily grid/seasonality 30 min, full build 10 min per (horizon, day); cold ≈1.5 s, warm < 0.3 s; payload ≈220–270 KB.

```ts
// GET /api/timepivots?horizon=90      (horizon 30..180 days)
type Expected = "rialzo" | "ribasso" | "inversione_rialzista" | "inversione_ribassista" | "inversione" | "volatilita";
type SourceType = "stagionale" | "ciclo" | "fibonacci" | "gambe" | "spaziatura" | "evento";
type St = { avg: number|null; median: number|null; win_rate: number|null; n: number; std: number|null;
            best?: { year: number; value: number } | null; worst?: { year: number; value: number } | null };   // percent
interface PivotWindow {            // recurring calendar window ("date pivot")
  id: string; month: number; day: number; label: string;           // label "20–26 ottobre" (centre ±N)
  N: 3 | 5; K: 7 | 14;                                             // window ±N days, trend measured K days before/after
  pattern: "rev_up"|"rev_down"|"up"|"down"|"cont_up"|"cont_down"; expected: Expected; pattern_label: string;
  hits: number; n: number; consistency: number; base_rate: number; wilson_lb: number; p_value: number;  // binomial vs base rate
  confidence: "alta"|"media"|"bassa"; score: number;
  avg_pre: number; avg_post: number; median_post: number; avg_post_hits: number; avg_abs_post: number; threshold: number;
  pivots: { low: number; high: number; major: number; rate: number|null };   // years with a zigzag swing (2.5/4/6×ATR) within ±N
  recent_consistency: number|null; older_consistency: number|null;            // stability: recent half vs older half of years
  text: string; pivot_text: string|null;                                       // Italian sentences
  years: { year: number; pre: number; post: number; type: string; match: boolean;
           pivot: { kind: "minimo"|"massimo"; level: "minore"|"medio"|"forte"; time: T } | null }[];
  path: { days: number[]; mean: number[]; median: number[]; p25: number[]; p75: number[]; n: number } | null; // −14..+14 d, % vs day 0
  date?: T; start?: T; end?: T;                                                // only for upcoming/active occurrences
}
interface CalendarItem {           // unified "Calendario dei pivot" (merged sources, sorted by time)
  id: string; time: T; start: T; end: T; label: string; title: string;
  confluence: number;              // 0..100: 1 − Π(1 − strength per source type), × source-diversity factor
  expected: Expected; probability: number|null;   // historical probability (%) from the sources that carry one
  sources: { type: SourceType; label: string; title: string; text: string; expected: Expected; strength: number; probability: number|null; ref?: string|null }[];
  source_types: SourceType[]; summary: string; days_away: number;
}
interface TimePivots {
  generated_at: T; today: T; horizon: number; price: number;
  kpi: { next_pivot: Pick<CalendarItem,"id"|"time"|"start"|"end"|"label"|"confluence"|"expected"|"probability"|"title"|"days_away"> | null;
         current_month: { month: number; label: string; avg; median; win_rate; n; mtd };          // mtd = current month so far (%)
         cycle_position: { idx: 0|1|2|3; label; short; month; avg; win_rate; n; annual_avg /* median annual % */; days_since_halving };
         best_day; worst_day; best_hour; worst_hour };
  today_info: { date: T; lines: string[]; this_week: string[] /* calendar ids */; active_windows: string[] };
  calendar: CalendarItem[];
  seasonality: {
    monthly: { years: number[]; matrix: (number|null)[][] /* year×12 % */; stats: (St & { month; label })[];
               year_totals: { year; total; cycle_year }[]; current: { year; month; value; partial: true } };
    quarterly: { years; matrix /* year×4 */; stats: (St & { quarter; label })[]; current: { year; quarter } };
    weekly: { stats: (St & { week })[]; current_week };                      // ISO week of year (W-SUN closes)
    weekday: { stats: (St & { dow /*0=Mon*/; label; name; avg_range })[]; current_dow };   // k_1d open→close
    monthday: { stats: (St & { day })[]; current_day };
    hourly: { stats: (St & { hour; avg_range; vol_share })[]; current_hour; since: T|null };  // k_1h, UTC
    hour_dow: { avg: (number|null)[][] /* 7×24 */; range: (number|null)[][] };
    sessions: (St & { key: "asia"|"europa"|"usa"|"late"; label; hours; avg_range; recent_avg; recent_win_rate })[];
    halving_cycle: { rows: { idx; label; short; years: number[]; months: (St & { values: { year; value }[] })[];
                             annual: { avg; median; win_rate; values: { year; value }[] } }[];   // year idx = (year − 2012) mod 4
                     current: { idx; month; year; label } };
  };
  windows: { years: number[]; base_rates: Record<"3_7"|"5_14", Record<string, number>>;
             top: PivotWindow[];       // best windows of the whole year (p ≤ 0.1, ≥ 8 days apart)
             upcoming: PivotWindow[];  // occurrences in [today−N, today+horizon]
             active: PivotWindow[];    // windows covering today
             strip: [month, day, Expected, consistency, score][];  // best pattern for every calendar day (year map)
             method: string };
  cycle_pivots: { days_since_halving; last_halving: T; next_halving: T|null; phase: string|null;
    items: { key; label; kind: "top"|"bottom"; anchor; anchor_time: T|null; history: { n; days; time? }[];
             projected_days; uncertainty; mid: T; from: T; to: T; status: "futuro"|"in corso"|"passato"; days_away; text; note }[];
    clusters: { kind; kind_label; cycles; of; members: { halving; days; time: T; price }[]; mean_days; projected_days; uncertainty;
                mid: T; from: T; to: T; days_away; confirmed: { days; time: T } | null; status; text }[];   // major swings at similar days-from-halving
    method: string };
  projections: { swings; legs; fib: { ratio; anchor_from; anchor_to; leg_days; time; status; days_away; label }[];
                 equal_legs: { label; days; anchor; time; status; days_away }[];
                 spacing: { tf: "1d"|"4h"; median_days; iqr: [number, number]; count; last_pivot: { time; price; kind }; next: T[] }[];
                 next_kind: "top"|"bottom"|null; method: string };
  events: { stats: { key: "month_open"|"month_close"|"quarter_open"|"year_open"|"mid_month"|"opex_month"|"opex_quarter"|"fomc";
                     label; kind; description; n; post_avg; post_median; post_win_rate; pre_avg; pre_win_rate; day_avg; day_win_rate;
                     abs_post; vol_ratio /* median |3d move| ÷ baseline */; big_move_rate; recent: { time; pre; post; day }[] }[];
            weekend: { n; avg_gap; avg_abs_gap; up_rate; big_gap_rate; fill_rate; big_fill_rate; median_fill_hours; monday_avg; monday_win_rate; text } | null; // Fri 21:00 → Sun 23:00 UTC (CME)
            upcoming: { key; title; time: T; expected: Expected; probability; text }[];
            fomc: { dates: T[] /* hardcoded 2017–2026 */; next: T[]; stats; note }; baseline: { abs_1d; abs_3d; up_rate_1d } };
  chart: { candles: { time: T; open; high; low; close }[] };   // last 180 daily candles (Binance)
  method: string;
}
```

## CYCLE ADVANCED (router: cycle_advanced.py, engine: app/analysis/cycle_advanced.py)
Advanced cycle analysis: "Orologio del ciclo" (composite Cycle Score), miner cycle, same-day-of-cycle comparison with
survival analysis, leverage by cycle phase. Reuses `routers.cycles` (load_daily, _build_heavy: tops/bottoms/probable bottom)
and `analysis.onchain.derive`. Registers dataset `oi_1d` (Binance openInterestHist period=1d, 30 d per call, accumulates over time).
Cycle Score: 9 components (Pi Cycle distance, MVRV-Z, NUPL, Puell, Mayer, walk-forward power-law residual, 2y-MA multiplier,
drawdown from ATH, halving phase) → expanding-window percentile 0–100 (no lookahead, min 200 d history); weights walk-forward =
50% equal + 50% ∝ (separation tops−bottoms)² measured only on cycle events already confirmed at that date (top confirmed +365 d,
bottom when price doubled and ≥180 d passed); EMA(7). Zones: <20 "zona di minimo", 20–40 "accumulo", 40–60 "metà ciclo",
60–80 "euforia", ≥80 "zona di massimo". Live price recomputes today's price-dependent components (20 s cache).
Cache: core 10 min (cold ≈ 2–4 s incl. /api/cycles heavy), sections 20 s; warm < 50 ms.
Payloads: summary ≈ 18 KB, clock ≈ 430 KB, miner ≈ 400 KB, compare ≈ 140 KB, leverage ≈ 140 KB. Errors → 503 { detail }.

```ts
type N = number | null
type ZoneKey = 'bottom' | 'accumulation' | 'mid' | 'euphoria' | 'top'
type PhaseKey = 'accumulation' | 'bull' | 'distribution' | 'bear'
type CompKey = 'pi' | 'mvrv_z' | 'nupl' | 'puell' | 'mayer' | 'power_law' | 'ma2y' | 'drawdown' | 'halving'

interface Zone { from: number; to: number; key: ZoneKey; label: string; color: string }
interface ClockComponent {
  key: CompKey; label: string; description: string
  raw: N; display: string
  pct: N          // 0..100 (percentile storico senza lookahead; per "halving" valore di fase 0..100)
  weight: number  // peso attuale in %
}
interface ClockCurrent {
  time: T; score: N; score_equal: N; score_instant: N
  zone: ZoneKey | null; zone_label: string | null
  change_7d: N; change_30d: N; change_90d: N
  components: ClockComponent[]; text: string[]; live: boolean
}
interface BacktestEvent {
  kind: 'top' | 'bottom'; time: T; price: number
  score: N; extreme_30d: N             // score il giorno dell'evento / max (top) o min (bottom) entro ±30 g
  extreme_365: N; extreme_365_time: T | null   // max/min nei 365 g precedenti (+30 g dopo)
  lead_1: N; lead_2: N; thresholds: [number, number]   // giorni di anticipo del primo attraversamento di 80/90 (top) o 20/10 (bottom) entro 365 g prima
  probable: boolean                    // minimo probabile (non confermato)
}
interface SignalEpisode { start: T; end: T; days: number; extreme: number; status: 'vero' | 'falso' | 'in_corso'; event: T | null; lead: N }
interface SignalStats {
  threshold: number; direction: 'above' | 'below'
  episodes: number; true: number; false: number; pending: number; items: SignalEpisode[]
}
interface Backtest { events: BacktestEvent[]; signals: SignalStats[]; mean_at_tops: N; mean_at_bottoms: N }

// GET /api/cycle/advanced/clock
interface CycleClock {
  generated_at: T
  current: ClockCurrent
  zones: Zone[]
  history: Pt[]            // score walk-forward (settimanale, giornaliero ultimi 2 anni)
  history_equal: Pt[]      // variante a pesi uguali
  price: Pt[]
  components_history: Record<CompKey, Pt[]>   // settimanale
  backtest: Backtest
  backtest_equal: Omit<Backtest, 'signals'>
  weights: { current: Record<CompKey, number>; history: { from: T; events: number; weights: Record<CompKey, number>; separation: Record<CompKey, N> }[] }
  method: string
}

// GET /api/cycle/advanced/miner
interface ReturnsH { '30'?: N; '90'?: N; '180'?: N }
interface HashSignal {
  time: T; cap_start: T; cap_days: number; hr_drawdown: number; price: number; ret: ReturnsH
  momentum_time: T | null; momentum_ret: ReturnsH
}
interface HitRow { horizon: number; n: number; hit_rate: N; avg: N; median: N; base_hit_rate: N; base_median: N }
interface MinerCurrent {
  state: 'capitulation' | 'recovery' | 'healthy'; label: string; days_in_state: number
  hashrate: N; sma30: N; sma60: N; ribbon_gap: N          // EH/s; gap % SMA30 vs SMA60
  ribbon_compression: N; ribbon_compression_pct: N; ribbon_inverted: boolean
  hr_drawdown: N; puell: N; issuance_usd: N; issuance_change_90d: N
  last_signal: HashSignal | null; days_since_signal: N
}
interface CycleMiner {
  generated_at: T
  current: MinerCurrent; text: string[]
  series: { hashrate: Pt[]; sma30: Pt[]; sma60: Pt[]; ribbon_compression: Pt[]; hr_drawdown: Pt[]; puell: Pt[]; issuance_usd: Pt[]; price: Pt[] }
  ribbon: { periods: number[]; times: T[]; values: N[][] }   // ultimi 4 anni, 1 punto ogni 3 g, values[i][k] = SMA periods[k] (EH/s)
  capitulations: { from: T; to: T | null; days: number }[]
  signals: HashSignal[]     // più recenti per primi
  stats: { basic: HitRow[]; momentum: HitRow[] }
  method: string
}

// GET /api/cycle/advanced/compare
type AnchorKey = 'halving' | 'top' | 'bottom' | 'probable_bottom'
interface SameDayRow {
  label: string; anchor_time: T; anchor_price: N; time: T; price: number
  multiple: N; drawdown_ath: number; days_to_ath: N; mvrv: N; score: N
  fwd: { '90': N; '180': N; '365': N }; max_gain_365: N; max_dd_365: N; is_current: boolean
}
interface CompareAnchor {
  key: AnchorKey; label: string; anchor_time: T; days: number
  rows: SameDayRow[]                       // cicli precedenti + riga corrente (is_current)
  series: { name: string; current: boolean; points: [number, N, N][] }[]   // [giorno, prezzo/ancora (x), score]
  fwd_stats: Record<'90' | '180' | '365', { n: number; median: N; min: N; max: N; up: number }>
}
interface Survival {
  phase: 'bull' | 'bear'; label: string; elapsed: number; anchor_time: T; samples: number[]
  remaining_median: N; exceeded_all: boolean
  horizons: { days: number; km: N; lognormal: N }[]   // P(fase dura ancora ≥ X giorni | già durata `elapsed`) in %
  curve: { day: number; km: number; lognormal: number }[]   // S(t) non condizionata in %
  note: string
}
interface CycleCompare {
  generated_at: T
  anchors: CompareAnchor[]
  durations: { bull: { n: number; days: number; from: T; to: T }[]; bear: { n: number; days: number; from: T; to: T; probable?: boolean }[] }
  survival: Survival[]
  highlights: string[]; caveat: string
}

// GET /api/cycle/advanced/leverage
interface PhaseRow {
  cycle: number; phase: PhaseKey; label: string; from: T; to: T; days: number
  funding_avg: N; funding_median: N; funding_pos_pct: N; funding_p90: N; spec_avg: N; current: boolean
}
interface CycleLeverage {
  generated_at: T
  current: {
    phase: PhaseKey; phase_label: string; cycle: number; days_in_phase: number
    funding_7d: N; funding_30d: N; funding_pct_all: N; funding_pct_phase: N; funding_prev_cycle_phase_avg: N   // % annualizzato
    spec: N; spec_pct_all: N; spec_pct_phase: N; spec_prev_cycle_phase_avg: N                               // volume perp / spot (x)
    prev_cycle_same_day: { time: T; funding_30d: N; spec: N } | null
    oi_usd: N; leverage_ratio: N; leverage_pct_available: N; oi_days_available: number; oi_since: T | null   // leverage_ratio in % della market cap
  }
  text: string[]
  series: { funding: Pt[]; spec: Pt[]; price: Pt[]; oi_usd: Pt[]; leverage_ratio: Pt[] }   // funding = media 30 g, % annuo
  phases: { from: T; to: T; phase: PhaseKey }[]
  by_phase: PhaseRow[]
  by_phase_all: { phase: PhaseKey; label: string; days: number; funding_avg: N; funding_median: N; funding_pos_pct: N; spec_avg: N }[]
  limitations: string[]
  method: string
}

// GET /api/cycle/advanced  (riepilogo leggero, per widget e agenti)
interface CycleAdvancedSummary {
  generated_at: T; price: number
  clock: Pick<ClockCurrent, 'time' | 'score' | 'score_equal' | 'zone' | 'zone_label' | 'change_7d' | 'change_30d' | 'change_90d' | 'text' | 'live'> & {
    components: Pick<ClockComponent, 'key' | 'label' | 'pct' | 'display' | 'weight'>[]
    spark: Pt[]; zones: Zone[]; mean_at_tops: N; mean_at_bottoms: N
  }
  miner: Pick<MinerCurrent, 'state' | 'label' | 'days_in_state' | 'ribbon_gap' | 'ribbon_compression' | 'hr_drawdown' | 'puell' | 'last_signal' | 'days_since_signal'> & { hit_rate_90: N }
  compare: { highlights: string[]; survival: Pick<Survival, 'phase' | 'label' | 'elapsed' | 'horizons' | 'remaining_median'>[] }
  leverage: Pick<CycleLeverage['current'], 'phase' | 'phase_label' | 'funding_7d' | 'funding_pct_all' | 'spec' | 'spec_pct_all' | 'leverage_ratio'>
  sections: string[]
}

// Endpoints:
//   GET /api/cycle/advanced           -> CycleAdvancedSummary   (light; used by CycleClockMini / agents)
//   GET /api/cycle/advanced/clock     -> CycleClock
//   GET /api/cycle/advanced/miner     -> CycleMiner
//   GET /api/cycle/advanced/compare   -> CycleCompare
//   GET /api/cycle/advanced/leverage  -> CycleLeverage
// Frontend: src/api/cycleAdvanced.ts (types + hooks), src/widgets/cycleAdvanced.tsx exports
//   CycleClockMini (Dashboard KPI-sized widget, same geometry as KpiShell), CycleClockGauge, ClockTab, MinerTab, CompareTab, LeverageTab.
```

## USDT ANALOGS & STABLECOINS (router: usdt_analogs.py, engines: app/analysis/usdt_analogs.py + stablecoins.py)
Visual analogs ("frattali") of the USDT dominance curve and what BTC did afterwards, plus stablecoin liquidity.
USDT.D = `usdt._frame()` (CoinGecko-calibrated reconstruction); the last point is aligned to the live BTC ticker (`stream.hub`) when fresh.
Analog search: candidates by shape on log(USDT.D) z-normalised (Pearson + banded DTW, history from 2018); best 60 re-ranked with
`similarity = 0.80·visual + 0.20·context`. Visual = `analogs_visual.combine` of shape/legs/pattern/volatility computed on synthetic OHLC
(open = previous close, high/low = max/min of the two); `candles` and `volume` are null (not applicable) so the weights renormalise
(shape 41%, legs 28%, pattern 21%, volatility 10%). Context: USDT.D level, USDT.D window change, RSI(14) of USDT.D, BTC window change,
mirror strength. Units: USDT.D values are percent of total crypto cap; every `*_pts` field is in percentage POINTS (render as "pt");
BTC changes are percent (on closes). Patterns: `tone` refers to USDT.D itself, `btc_tone` is the inverted reading for BTC.
tf "4h" = ESTIMATE: USDT mcap linearly interpolated between daily closes; non-USDT cap = previous day-end value scaled by intraday
BTC (its share) and ETH (the rest) moves (datasets `k_4h` + new `eth_4h`). Mirror, technicals and joint configurations are always daily.
New datasets registered with `store.register` (from stablecoins.py): `stables_total` (DefiLlama totalCirculatingUSD.peggedUSD, daily, ttl 3h),
`eth_4h` (Binance ETHUSDT 4h, incremental, ttl 60 s).
Cache 60 s (ttl_cache); warm < 1 ms, cold ≈ 0.1–0.3 s (+ CoinGecko latency inside `_frame`); payload ≈ 145 KB at defaults, ≈ 320 KB at max params.
/api/stablecoins ≈ 330 KB, cold ≈ 0.5 s. Agent hooks: plain `build(**params)` and `build_stablecoins(**params)` in routers/usdt_analogs.py.

```ts
// GET /api/usdt/analogs?tf=1d|4h&window=60&top=5&horizon=30
//   window 20..200 (default 60), top 1..8 (default 5), horizon 5..100 (default 30). 400 on bad tf / insufficient history.
type UsdtLeg = AnalogLeg & { pts: number };     // from_price/to_price = USDT.D %, pct = relative %, pts = change in pt
type UsdtPattern = ChartPattern & { btc_tone: "bullish"|"bearish"|"neutral"; label: string }; // label "Doppio massimo sulla USDT.D"; prices = USDT.D %
interface UsdtMapPoint { time: T; price: number /* USDT.D % */; idx: number; pct: number; pts: number /* pt from window start */; btc: number }
interface UsdtMapping { n: number; kind: "start"|"end"|"high"|"low"; label: string; analog_label: string; same_role: boolean;
                        current: UsdtMapPoint; analog: UsdtMapPoint; note: string }
interface UsdtContextFeature { key: "level"|"change"|"rsi"|"btc"|"mirror"; label: string; current: number|null; analog: number|null;
                               display_current: string; display_analog: string; similarity: number|null; weight: number; explanation: string }
interface UsdtAnalogMatch {
  rank: number; period: { start: T; end: T; label: string; when: string };       // "giu–ago 2023 (1D)", "nel 2023"
  similarity: number; visual_similarity: number; shape_similarity: number; context_similarity: number; correlation: number; dtw: number;
  visual: { score: number; components: VisualComponent[] };                      // candles/volume: score null
  patterns: { current: UsdtPattern[]; analog: UsdtPattern[]; common: string|null; common_name: string|null; text: string; score: number };
  legs_current: UsdtLeg[]; legs_analog: UsdtLeg[]; leg_pairs: AnalogLegPair[];
  context: UsdtContextFeature[]; mapping: UsdtMapping[];
  usdt: { times: T[]; values: number[]; window_change_pts: number; window_change: number };  // analog window + following candles
  btc: { values: number[]; window_change: number };                                         // BTC closes aligned with usdt.times
  outcome: { candles: number; change: number|null; max_up: number|null; max_down: number|null;   // BTC % after the window
             usdt_change_pts: number|null; usdt_change: number|null; end_time: T|null };
  projection: { times: T[]; close: number[] };          // BTC path after, rescaled onto today's price
  usdt_projection: { times: T[]; value: number[] };     // USDT.D path after, shifted (in pt) onto today's level
  narrative: string[]; narrative_llm: string|null;      // Italian; LLM rewrite (rank 1) only when its numbers verify
}
interface MirrorBreak { kind: "both_up"|"both_down"; start: T; end: T; days: number; label: string; btc_change: number; usdt_change_pts: number;
                        btc_after_14: number|null; btc_after_30: number|null; ongoing: boolean; text: string }
interface UsdtMirror {
  window: number; current: number|null; avg_1y: number; percentile: number|null; p10: number; p50: number; // mirror = −corr(BTC, USDT.D daily log returns)
  state: "forte"|"moderato"|"rotto"|"n/d"; text: string; series: Pt[];                                    // last 2 years daily
  joint: { rank: number; start: T; end: T; label: string; similarity: number; btc_shape: number; usdt_shape: number;
           mirror_then: number|null; btc_outcome: number; btc_max_up: number; btc_max_down: number; usdt_outcome_pts: number }[];
  breaks: MirrorBreak[];          // newest first, max 14: both 7-day changes with the same sign beyond 0.15σ
  break_stats: { kind: "both_up"|"both_down"; label: string; n: number; median_after_30: number|null; up_rate_30: number|null }[];
  current_break: MirrorBreak | null;
}
interface UsdtTechnicals {
  usdt_d: number; rsi: number; rsi_zone: "ipercomprato"|"ipervenduto"|"neutra"; ema50: number; ema200: number;
  dist_ema50_pts: number; dist_ema200_pts: number; trend: "rialzista"|"ribassista"|"laterale";
  zones: { low: number; high: number; mid: number; kind: "support"|"resistance"; touches: number; reactions: number; last_touch: T;
           distance_pts: number; btc_after_14_median: number|null; btc_after_30_median: number|null; btc_up_rate_30: number|null; text: string }[];
  signals: { text: string; tone: "bullish"|"bearish"|"neutral" }[];        // tone from BTC's point of view
  series: { time: T; value: number; ema50: number; ema200: number; rsi: number|null }[];   // last ~400 days
}
interface UsdtAnalogs {
  tf: "1d"|"4h"; window: number; horizon: number; top: number; generated_at: T; estimated: boolean; live: boolean;
  current: { start: T; end: T; label: string; usdt_d: number; btc: number; change_pts: number; change: number; btc_change: number;
             times: T[]; usdt: number[]; btc_path: number[]; patterns: UsdtPattern[]; legs: UsdtLeg[]; rsi: number|null };
  summary: { count: number; up: number; down: number; agreement: number|null; median_outcome: number|null; weighted_outcome: number|null;
             usdt_median_pts: number|null; best_similarity: number|null; bias: "bullish"|"bearish"|"neutral"; text: string;
             band: { times: T[]; p25: number[]; p50: number[]; p75: number[]; usdt_p50: number[] } | null }; // BTC USD paths across matches
  matches: UsdtAnalogMatch[];
  mirror: UsdtMirror | null; technicals: UsdtTechnicals | null;
  intraday: { estimated: true; last: number; time: T; change_24h_pts: number|null; daily_last: number; series: Pt[]; note: string } | null; // 4H estimate, last 30 days
  method: string;
}

// GET /api/stablecoins
interface Stablecoins {
  generated_at: T; live: boolean;
  current: { supply: number; supply_ath: number; supply_ath_time: T; at_ath: boolean;
             net_7d: number|null; net_30d: number|null; net_90d: number|null; net_365d: number|null;    // USD net mint(+)/burn(−)
             pct_7d: number|null; pct_30d: number|null; pct_90d: number|null; pct_365d: number|null;    // %
             dominance: number; dominance_change_30d: number|null;                                      // % of total crypto cap / change in pt
             ssr: number; ssr_mid: number|null; ssr_sd: number|null; ssr_z: number|null; ssr_percentile: number|null; // SSR = BTC cap / stables
             usdt_share: number; btc_cap: number; total_cap: number; time: T };
  series: { time: T; supply: number; dominance: number; ssr: number; ssr_mid: number|null; ssr_sd: number|null; chg30: number|null }[]; // daily since 2020; bands = mid ± k·sd (365d rolling)
  weekly_net: Pt[];   // weekly net change USD, last 104 weeks (time = Monday)
  daily_net: Pt[];    // daily net change USD, last 90 days
  issuance: { lead_lag: { lag: number; corr: number|null }[]; best_lag: number; best_corr: number|null; corr_0: number|null; // weeks, + = issuance leads BTC (4-week changes, last 4y)
              regimes: { key: "strong"|"mid"|"weak"; label: string; n: number; median: number|null; up_rate: number|null }[]; // BTC 30d fwd return by 30d-issuance tercile (since 2020)
              current_regime: "strong"|"mid"|"weak"|null; current_chg30: number|null };
  interpretation: { key: "supply"|"ssr"|"dominance"|"issuance"|"leadlag"; title: string; tone: "bullish"|"bearish"|"neutral"; text: string }[];
  note: string;
}
```
Frontend: `src/api/usdtAnalogs.ts` (types + `useUsdtAnalogs`, `useStablecoins`), `src/widgets/usdtAnalogs.tsx`; the USDT page has tabs
"Panoramica | Analoghi USDT | Stablecoin" (`/analoghi?metodo=usdt`, `/flussi?tab=stablecoin`).

## MACRO (router: macro.py, engine: app/analysis/macro.py)
Macro & Rotazione: liquidity (stablecoin supply; FRED net liquidity/M2 when `FRED_API_KEY` is set), dollar & rates regimes,
cross-asset correlations, BTC→altcoin rotation and a risk-on/off composite. Cached 5 min in-process (`ttl_cache(300)`), ~0.3 s warm, ~500 KB.
Datasets registered from the module (store.register, parquet cache): `macro_dxy`, `macro_spx`, `macro_ndx`, `macro_gold`, `macro_us10y`, `macro_vix`
(Yahoo Finance chart API, daily close, ttl 1h; time = exchange-local date at 00:00 UTC), `ethbtc_1d` (Binance ETHBTC + ETHUSDT daily close: cols time, ethbtc, ethusdt; ttl 1h),
`macro_stables` (DefiLlama total stablecoin USD: cols time, total; registered only if `stables_total` is not; `stables_total` is preferred when present),
`macro_fred_walcl|rrp|tga|m2` (only when FRED_API_KEY is set; cols time, value in FRED units; ttl 6h).
Correlations use daily returns on US trading days (log returns; US10Y = change in points); windows 30/90/180 d ≈ 21/63/126 sessions, 1y = 252.
Lag analysis: corr(liquidity 90d log change at t, BTC 90d log change at t+lag), lag 0..120 d step 5, since 2020 (stables) / 2015 (FRED).
Altseason index (0..100) = 7d EMA of the mean historical percentile of: ETH/BTC 90d momentum, ETH/BTC vs 200d MA, −(dominance 90d change), −(dominance − 200d MA).
Phases: < 35 "btc_season", 35..65 "neutral", > 65 "alt_rotation". Summary score = 50 + 50·mean(component scores/100); ≥ 60 Risk-on, ≤ 40 Risk-off.

```ts
// GET /api/macro -> Macro   (503 { detail } if source data is unavailable)
type N = number | null;
interface RegimeStat { regime: string; label: string; days: number; share: N;       // share = % of days since 2013
  fwd_median: N; fwd_mean: N; win_rate: N; ann_return: N }                          // percent; fwd = BTC return 90d after (DXY, US10Y) or 30d (VIX)
interface LagAnalysis {
  key: "stables" | "net_liquidity" | "m2"; label: string; unit: "usd";
  lags: { lag: number; corr: N }[]; best_lag: number; best_corr: number; corr_lag0: N; text: string;   // Italian
  liq_level: Pt[];                 // USD, weekly
  liq_change_shifted: Pt[];        // liquidity 90d log change (%) shifted forward by best_lag days (extends past today)
  btc_change: Pt[];                // BTC 90d log change (%)
}
interface Macro {
  kpi: {
    dxy: { value: N; change_1d: N; change_30d: N };            // changes percent
    us10y: { value: N; change_30d: N };                         // value = yield percent; change in points
    vix: { value: N; change_1d: N };
    stables: { value: N; growth_90d: N };                       // USD; percent
    ethbtc: { value: N; change_30d: N };
    dominance: { value: N; change_30d: N };                     // percent; change in points
    altseason: { value: N; phase_label: string };               // 0..100
    spx: { value: N; change_1d: N }; gold: { value: N; change_1d: N };
  };
  liquidity: {
    stables: { supply: N; change_30d: N; growth_90d: N; source: string; series: Pt[]; growth_series: Pt[] };  // USD; growth_series = 90d growth %
    lags: LagAnalysis[];           // "stables" always (if data) + "net_liquidity", "m2" when FRED is configured
    btc_price: Pt[];               // weekly since 2015
  };
  fred: {
    available: boolean; message: string;                        // message explains how to set FRED_API_KEY when unavailable
    net_liquidity: { value: number; change_13w: N; walcl: N; rrp: N; tga: N; as_of: T } | null;   // USD (WALCL − RRP − TGA)
    m2_yoy: N;                                                  // percent
    series: { m2_yoy: Pt[] } | null;
  };
  dollar_rates: {
    dxy: { value: N; change_1d: N; change_30d: N; change_6m: N; ma200: N; above_ma200: boolean;
           regime: "strong" | "mixed" | "weak" | "na"; regime_label: string; text: string; stats: RegimeStat[];
           series: Pt[]; ma200_series: Pt[]; btc_series: Pt[] };          // weekly, daily for the last 180 d
    us10y: { value: N; change_1d: N; change_30d: N; change_6m: N;          // changes in points
             regime: "rising" | "stable" | "falling" | "na"; regime_label: string; text: string; stats: RegimeStat[]; series: Pt[] };
    vix: { value: N; change_1d: N; change_30d: N;
           regime: "calm" | "normal" | "tense" | "panic"; regime_label: string; text: string; stats: RegimeStat[]; series: Pt[] };
  };
  correlations: {
    assets: { key: string; label: string }[];                  // btc eth spx ndx gold dxy us10y vix (matrix order)
    matrices: { window: string; days: number; values: N[][] }[];   // "90g" (63 sessions), "1 anno" (252)
    rolling: { dxy: { r30: Pt[]; r90: Pt[]; r180: Pt[] }; spx: { r90: Pt[] }; ndx: { r90: Pt[] }; gold: { r90: Pt[] }; us10y: { r90: Pt[] } };
    betas: { asset: string; label: string; corr_90d: N; beta_90d: N; corr_1y: N; beta_1y: N }[];  // spx ndx gold dxy
  };
  rotation: {
    ethbtc: { value: N; change_30d: N; change_90d: N; ma200: N; above_ma200: boolean; series: Pt[]; ma200_series: Pt[] };
    dominance: { value: N; change_30d: N; change_90d: N; ma200: N; series: Pt[]; ma200_series: Pt[] };   // percent; changes in points
    altseason: { value: N; phase: "btc_season" | "neutral" | "alt_rotation"; phase_label: string;
                 components: { key: string; label: string; value: N }[];   // percentile 0..100
                 series: Pt[]; explanation: string };
    cycle_marks: { time: T; kind: "top" | "bottom" | "halving"; label: string }[];   // from /api/cycles
    cycle_phase: string | null; days_since_halving: number;
    compare: { cycle: string; halving: T; time: T; ethbtc: N; ethbtc_since_halving: N; dominance: N; altseason: N;
               ethbtc_next_180d: N; dominance_next_180d: N }[];   // previous cycles at the same days-since-halving; last = current
    bullets: string[];
  };
  summary: {
    score: number; label: "Risk-on" | "Neutrale" | "Risk-off"; tone: "bullish" | "bearish" | "neutral";
    components: { key: string; label: string; value: string; score: number; tone: "bullish" | "bearish" | "neutral"; text: string }[]; // score -100..100
    bullets: string[];
  };
  as_of: Record<string, T>;        // last bar per Yahoo series
  note: string; generated_at: T;
}
// Frontend: src/api/macro.ts (types + useMacro), src/widgets/macro.tsx, src/pages/MacroPage.tsx, route /macro, nav "Macro & Rotazione".
```

## POSITIONING (router: positioning.py, engines: app/analysis/options.py + holders.py + sentiment.py)
Posizionamento: opzioni Deribit, holder STH/LTH, sentiment contrarian. Italian texts, `util.clean`.
Endpoints: `GET /api/positioning/options` (ttl 45 s, ~0.1 s warm, ~120 KB), `GET /api/positioning/holders` (frame ttl 5 min, live price applied per request, ~210 KB; series daily for the last year, every 2nd day before),
`GET /api/positioning/sentiment` (history/backtest ttl 5 min, current ttl 30 s, ~260 KB) — each 503 `{detail}` if its source is unavailable;
`GET /api/positioning` -> `Positioning` (all three; a failing part is `null` with the reason in `errors`).
Datasets registered from the modules (store.register, parquet cache):
- `pos_dvol` (Deribit DVOL daily 2021→: time, open, high, low, close; ttl 1h)
- `pos_opt_daily` (daily snapshot from today on: time, index, pc_oi, pc_vol, oi_usd, skew_7d/30d/90d, atm_7d/30d/90d, dvol; ttl 1h, today's row replaced)
- `pos_maxpain_snap` (one row per (day, expiry ≤ 120 d): time, expiry [unix s], max_pain, spot, oi_btc, pc_oi; ttl 1h) — feeds `expiry_history`
  (settlement = Deribit `get_delivery_prices` btc_usd 08:00 UTC; history accumulates from the first run, Deribit has no historical OI)
- `pos_bgeo` (BGeometrics free tier, 7-day delay, rolling ~4y window that accumulates locally: time, sth_rp, lth_rp, sth_sopr; ttl 12h;
  3 requests per refresh, 10 req/h limit → on 429 all calls pause until X-RateLimit-Reset-Hour, plus 1h per-endpoint back-off; sth/lth-supply are 404 on the free tier so `supply` is null)
- `pos_cb_1d` (Coinbase BTC-USD daily 2017→: time, close, volume; ttl 30 min), `pos_cb_1h` (Coinbase hourly, last 180 d then accumulates; ttl 5 min)
Method: max pain = strike minimising Σ call OI·max(S−K,0) + Σ put OI·max(K−S,0); skew 25Δ = IV(put −25Δ) − IV(call +25Δ) per expiry
(Black-76 deltas from each strike's mark IV, forward = Deribit underlying), constant-maturity 7/30/90 d by linear interpolation in days;
gamma = Γ·OI·S²·1% gross per strike (dealer sign unknown). STH/LTH-MVRV = price / realized price (current value uses the live price).
Sentiment index (0 = max fear, 100 = euphoria) = 3-day mean of the average component score (≥ 3 components); component score = rolling 1460-d percentile
(min 365 d, no lookahead) of: F&G, funding 7d mean, perp taker-buy share 7d, Coinbase premium 7d mean, DVOL (inverted); plus `ls` (Binance % long accounts,
percentile over the short available history, min 14 d) and `skew` (fixed scale 50 − 4·skew30). Zones: <25 Paura estrema, 25–40 Paura, 40–60 Neutrale,
60–75 Avidità, ≥75 Euforia. Backtest = BTC daily-close forward returns 7/30/90 d; component extremes: score ≤ 10 / ≥ 90; episodes = signal days separated by > 7 d.

```ts
// All percent fields are percent numbers; IV / DVOL / skew in volatility points.
type N = number | null
export type Tone = 'bullish' | 'bearish' | 'neutral'
export type ExpiryKind = 'giornaliera' | 'settimanale' | 'mensile' | 'trimestrale'

// ------------------------------------------------------------------ Opzioni
export interface StrikeOi { strike: number; calls: number; puts: number; calls_usd: number; puts_usd: number }   // OI in BTC, *_usd notional
export interface ExpiryRow {
  expiry: T; days: number; kind: ExpiryKind
  max_pain: N; max_pain_dist: N                  // USD; percent vs index price
  oi_calls: number; oi_puts: number; oi_btc: number; notional_usd: number
  pc_oi: N; pc_vol: N; atm_iv: N; skew_25d: N    // IV in vol points; skew = IV put25Δ − IV call25Δ
}
export interface OptionsData {
  index_price: number; updated_at: T
  kpi: {
    oi_usd: number; oi_btc: number; pc_oi: N; pc_vol: N; volume_usd_24h: number
    next_expiry: T | null; next_max_pain: N; next_max_pain_dist: N; next_notional_usd: N
    skew_7d: N; skew_30d: N; skew_90d: N; atm_7d: N; atm_30d: N; atm_90d: N; dvol: N
  }
  expiries: ExpiryRow[]                          // next 6 + later monthly/quarterly (max 10)
  oi_by_strike: {
    all: StrikeOi[]                              // all expiries, strikes 50%..160% of index
    by_expiry: { expiry: T; kind: ExpiryKind; max_pain: N; strikes: StrikeOi[] }[]
  }
  gamma: {
    profile: { strike: number; calls: number; puts: number; total: number }[]   // USD of delta per 1% move (gross), strikes ±20%
    walls: { strike: number; calls: number; puts: number; total: number }[]     // top 5 by total
    oi_walls: StrikeOi[]                                                        // top 6 OI strikes within ±15%
  }
  term_structure: { expiry: T; days: number; atm_iv: N; skew_25d: N; iv_put25: N; iv_call25: N }[]
  smiles: { expiry: T; days: number; forward: number; atm_iv: N; points: { strike: number; moneyness: number; iv: number }[] }[]  // moneyness = K/F·100
  dvol: { current: N; series: Pt[]; pct_1y: N; pct_all: N; rv_30d: N; iv_rv_spread: N; min_1y: N; max_1y: N; change_7d: N }
  expiry_history: {
    since: T | null; n: number; converged_pct: N; median_abs_gap: N
    rows: { expiry: T; lead_days: number; max_pain: number; spot_before: number; settlement: number
            gap_before: number; gap_settle: number; converged: boolean; oi_btc: number }[]
  }
  signals: { text: string; tone: Tone }[]
  note: string
}

// ------------------------------------------------------------------ Holder
export interface HoldersData {
  price: number; as_of: T; delay_days: number
  kpi: {
    sth_realized_price: number; lth_realized_price: number; sth_mvrv: number; lth_mvrv: number; sth_mvrv_as_of: number
    dist_sth: number; dist_lth: number                      // percent price vs cost basis
    sth_sopr: N; sth_sopr_7d: N; lth_share: N               // percent of (STH+LTH) supply
    regime: 'above' | 'below'; regime_days: number | null; zone: string
  }
  series: { price: Pt[]; sth_rp: Pt[]; lth_rp: Pt[]; sth_mvrv: Pt[]; lth_mvrv: Pt[]; sth_sopr: Pt[] }   // daily, sth_sopr = 7d MA
  bands: { mean: number; sd1_low: number; sd1_high: number; sd2_low: number; sd2_high: number; levels: number[] }
  extremes: { min: number; min_time: T; max: number; max_time: T }
  buckets: { range: string; label: string; days: number; fwd30_median: N; fwd30_hit: N; fwd90_median: N; fwd90_hit: N }[]
  regimes: { start: T; end: T; above: boolean; days: number }[]
  tests_1y: number
  supply: { sth: number; lth: number; lth_share: number; lth_share_change_30d: N; series_lth_share: Pt[] } | null
  bullets: string[]
  note: string
}

// ------------------------------------------------------------------ Sentiment
export interface BacktestBlock {
  days: number; episodes: number; last: T | null
  r7_median: N; r7_mean: N; hit7: N; n7: number
  r30_median: N; r30_mean: N; hit30: N; n30: number
  r90_median: N; r90_mean: N; hit90: N; n90: number
}
export interface SentimentComponent {
  key: 'fng' | 'funding' | 'flows' | 'premium' | 'dvol' | 'ls' | 'skew'
  label: string; unit: string; score: N; raw: N; raw_display: string; as_of: T | null; history_days: number
  method: string; text: string; in_composite: boolean
}
export interface SentimentData {
  current: { value: number; zone: string; change_7d: N; percentile: number; as_of: T; n_components: number }
  components: SentimentComponent[]
  explanation: string[]
  history: { composite: Pt[]; price: Pt[] }
  backtest: {
    since: T; baseline: BacktestBlock
    zones: (BacktestBlock & { zone: string; lo: number; hi: number })[]
    components: { key: string; label: string; since: T | null; enough: boolean; fear: BacktestBlock | null; greed: BacktestBlock | null }[]
    thresholds: { composite_fear: number; composite_greed: number; component_fear: number; component_greed: number }
  }
  premium: {
    live: N; live_usd: N; coinbase: N; binance: N; avg_7d: N; percentile_4y: N; text: string | null
    daily: Pt[]                    // 7d average premium, percent, last 4 years
    hourly: Pt[]                   // hourly premium, percent, last 30 days
  }
  note: string
}

export interface Positioning {
  options: OptionsData | null; holders: HoldersData | null; sentiment: SentimentData | null
  errors: Record<string, string>; generated_at: T
}

// Frontend: src/api/positioning.ts (types + useOptions/useHolders/useSentiment), src/widgets/positioning.tsx, src/pages/PositioningPage.tsx (default export),
// tabs ?tab=opzioni|holder|sentiment; route /posizionamento + nav added by the lead.
```

## EVENTS (router: events.py, engine: app/analysis/events.py)
Calendario eventi + ciclo politico USA with BTC reaction stats. Daily grid reused from `routers.timepivots._grid()` (merged daily history);
FOMC list = `analysis.timepivots.FOMC_DATES`, last-Friday rule = `timepivots._last_friday`, CME weekend-gap study = `timepivots.build(90)["events"]["weekend"]` (reused, not recomputed).
Date quality: `esatta` (FOMC, elections, midterms, halvings, CPI 2022-01 → 2025-12 from the BLS schedule), `regola` (NFP = 3rd Friday after the
reference week containing the 12th, with the known 2025 shutdown exceptions; options expiry = last Friday, Deribit 08:00 UTC), `stimata`
(CPI outside the exact list: Tue–Thu between the 10th and 15th closest to the 12th — matches the known dates 64% exact, 96% within ±1 day).
Stats use only `esatta`/`regola` dates (CPI: only exact). Windows on UTC daily closes: ±1 g = close d−2 → close d+1; −7..+7 g = close d−8 → close d+7;
pre7 = d−8 → d−1; post7 = d−1 → d+7. vol_ratio = median |move| on events ÷ median |move| of all days in the same span (±30 d).
Expected move of an upcoming event = vol_ratio × median |move| of the last ~90 days. Cache 30 min per day (cold ≈ 2 s incl. timepivots, warm < 50 ms), payload ≈ 55 KB.
Agent/alert hook: plain `build(horizon=90)` in routers/events.py.

```ts
// GET /api/events?horizon=90      (horizon 14..365 days)
type N = number | null
type EventKey = 'fomc' | 'cpi' | 'nfp' | 'opex_month' | 'opex_quarter' | 'midterm' | 'election' | 'halving'
type EventCategory = 'politica' | 'macro' | 'derivati' | 'ciclo'
type DateQuality = 'esatta' | 'regola' | 'stimata'
interface WinStat { avg: N; median: N; abs_avg: N; abs_median: N; win_rate: N; n: number }       // percent
interface EventTypeStat {
  key: EventKey; label: string; category: EventCategory; quality: DateQuality; quality_label: string; description: string
  n: number; since: T
  d1: WinStat; d7: WinStat; pre7: WinStat; post7: WinStat
  range_1d: N; range_7d: N                       // median high/low excursion over the 3 / 15 candles (%)
  vol_ratio_1d: N; vol_ratio_7d: N; range_ratio_1d: N; range_ratio_7d: N   // × vs same-period baseline
  baseline: { abs_1d: number; abs_7d: number; range_1d: number; range_7d: number; up_1d: number }
  path: { day: number; median: N; mean: N }[]    // day −7..+7, % vs close of d−1
  recent: { time: T; label: string; d1: N; d7: N; post7: N; range_1d: N }[]   // last 10, newest first
  note: string                                   // Italian
}
interface UpcomingEvent {
  id: string /* "fomc:2026-10-28" */; key: EventKey; type_label: string; category: EventCategory
  title: string; time: T /* UTC time of the release */; date: T /* UTC day */; date_label: string /* "28 ott 2026" */; hour: string
  days_away: number; quality: DateQuality; quality_label: string; importance: 'alta' | 'media' | 'bassa'
  expected_abs_1d: N; expected_abs_7d: N; expected_usd_1d: N      // expected |move| % (and USD at live price)
  hist_abs_1d: N; vol_ratio_1d: N; vol_ratio_7d: N; up_rate_1d: N; up_rate_7d: N; n: number; text: string
}
interface PathSeries { name: string; time: T; current: boolean; points: [number, N][] }   // [days from vote, %]
interface EventsResponse {
  generated_at: T; today: T; price: number; horizon: number
  types: EventTypeStat[]                          // order: fomc, cpi, nfp, opex_month, opex_quarter, midterm, election, halving
  upcoming: UpcomingEvent[]                       // next `horizon` days, sorted by time
  later: { key: EventKey; title: string; time: T; date_label: string; days_away: number; quality: DateQuality; quality_label: string }[] // halving (est.), 2028 election
  political: {
    years: { year: number; type: 'presidential'|'post'|'midterm'|'pre'; label: string; return: N; partial: boolean; halving_year: boolean }[]
    year_types: { type: 'presidential'|'post'|'midterm'|'pre'; label: string; n: number; avg: N; median: N; win_rate: N; years: number[]; current: boolean }[]
    current_year_type: 'presidential'|'post'|'midterm'|'pre'
    midterm: { next: T; days_to: number; anchor_day: number; anchor_label: string
               paths: PathSeries[]               // 2014/2018/2022 + current (−180..+365 d, step 3), % vs close at `anchor_day` (= today's offset, so the current path ends at 0)
               mean: [number, N][]
               lows: { year: number; midterm: T; low_time: T; low_label: string; low_price: number; days_from_midterm: number
                       drawdown_from_ath: number; midterm_price: number; fwd_365: N; low_to_365: N }[]
               pre180: { avg: N; current: N }; fwd_365: { avg: N; up: number; n: number } }
    presidential: { next: T; paths: PathSeries[] }   // % vs close on election day
    text: string[]
  }
  cme_gap: { n: number; avg_gap: N; avg_abs_gap: N; up_rate: N; big_gap_rate: N; fill_rate: N; big_fill_rate: N
             median_fill_hours: N; monday_avg: N; monday_win_rate: N; text: string } | null   // from timepivots
  baseline_now: { abs_1d: number; abs_7d: number; range_1d: number; range_7d: number; up_1d: number }   // last ~90 days
  quality: { cpi_rule_accuracy: { n: number; exact: number; within_1: number; within_3: number }; notes: string[] }
  method: string
}
// Frontend: src/api/events.ts (types + useEvents), src/widgets/events.tsx, src/pages/EventsPage.tsx (default export). Route /macro?tab=eventi (lead).
```

## FORECAST (router: forecast.py, engines: app/analysis/forecast.py + forecast_features.py + forecast_models.py + forecast_cycle.py)
Probabilistic BTC price-path forecast **conditioned on the position in the current cycle**, refined by ML for 7–90 d.
Pipeline (all point-in-time, no lookahead):
- Feature store (`forecast_features.build()`, 88 daily features, publication delays respected: CoinMetrics +1 d, BGeometrics +7 d,
  DefiLlama +1 d, spot/perp volumes only closed days, macro US trading days carried ≤ 4 d): price/momentum, volatility, cycle
  (drawdown, days since ATH / cycle low, halving phase, walk-forward power-law residual), on-chain (MVRV, MVRV-Z, NUPL, Puell,
  hash ribbon, active addresses, tx, realized-cap growth), STH/LTH cost-basis distance (2022→), derivatives (funding level/z,
  perp/spot volume, taker ratios, Coinbase premium), stablecoins (USDT, total, SSR), macro (DXY, US10Y, VIX, SPX, NDX, gold,
  BTC–SPX correlation), DVOL (2021→), Fear & Greed, ETH/BTC, seasonality, classic technical indicators (Ichimoku, Aroon, Choppiness,
  StochRSI, KDJ, Williams %R, OBV slope, CMF, Donchian/Keltner position, ADX/DMI, Heikin-Ashi streak).
- Members: `cycle` (cycle-position model, 0–365 d), `lgb` (LightGBM quantile regression, vol-normalised target, Optuna-tuned on data
  < 2019, 7–90 d), `mc` (regime Monte Carlo), `rw0` (zero-drift random walk, kept as prudent anchor).
- Cycle model: point-in-time cycle events (top = record close with no higher close for 365 d and ≥ 30% drawdown, ≥ 60 d old; bottom =
  min between tops, current "probable" bottom when +30% rebound and ≥ 60 d); past cycles aligned on days since top / bottom / halving
  (equal anchor weights: learned weights tested, no out-of-sample gain with 3–4 cycles); time warping s = (past/current duration of the
  last completed segment)^γ, γ ∈ {0, ½, 1} with weights ¼/½/¼; amplitude scale = √(1-y vol ratio × last-segment amplitude ratio),
  clipped 0.2–1.3; jitter ±42 d; path weight = cycle recency × time kernel × state similarity (drawdown, days since low, rally from
  low, MVRV, 90 d vol, Mayer — standardised with statistics up to today only); weighted daily quantiles; median shrunk 50% toward 0.
- Walk-forward: grid every 3 days from 2014-01-01 (LightGBM from 2018-07, monthly refits on realized targets only); out-of-sample
  predictions cached in `backend/data/forecast_oos.pkl` (incremental; full recompute every 30 days or on VERSION change).
  Per horizon: convex weights minimising past pinball loss (4-y window, re-fitted monthly, L2 shrink to equal) → quantile averaging →
  split-conformal relative CQR on the last 3 y of realized OOS forecasts for the 90% and 50% bands (factor c ∈ [−0.45, 1]).
  Live ledger (/previsioni?tab=affidabilita): live `forecast_7d/30d` snapshots store each member's quantiles in `meta.members`; once resolved, member
  pinball on live rows tilts the 7/30 d weights: w ∝ w·exp(−(L/L_best − 1)/0.1 · n/(n+50)).
- Training runs in a background thread (first full run ≈ 3–4 min, daily incremental ≈ 20–30 s), retrains when a new UTC day of data is
  available (checked every 10 min and on requests), persists the model to `backend/data/forecast_model.pkl` (restart = instant) and
  never blocks requests (previous model served while retraining; HTTP 503 only before the very first model exists).
  Bands are re-anchored to the live price on every request (quantiles are log-returns). Payload ≈ 350 KB at horizon=365.
- Evaluation: last 4 years out-of-sample (realized), `last12` = forecasts due in the last 12 months, by PIT regime (bull = price > SMA200
  rising, bear = below & falling, accumulation = otherwise) and cycle by cycle (each cycle predicted only with earlier ones).
  Overlapping targets: effective samples ≪ n (especially 180–365 d, ~3 cycles) — say so in the UI.

```ts
type ForecastMemberKey = "cycle" | "lgb" | "mc" | "rw0"
interface ForecastMember {
  key: ForecastMemberKey; name: string; note: string            // Italian
  weight: number                                                // % weight at 30 d (legacy field)
  median_30d: number | null                                     // price (live-anchored)
  weights: Record<"7"|"30"|"60"|"90"|"180"|"365", number>       // % weight per horizon (0 = not used, e.g. lgb beyond 90 d)
  medians: Record<string, number>                               // member median price per horizon
  live: Partial<Record<"7"|"30", { pinball: number; n: number }>>  // live-ledger loss used for the weight tilt (empty until resolved)
}
interface ForecastMetrics {        // % except brier/mase/pinball; null when undefined (rw0 has no direction → hit_rate null)
  n: number; hit_rate: N; brier: N; brier_skill: N /* % vs climatology */; mape: N /* % error of median price */
  mase: N /* MAE of median log-return / MAE of naive random walk; < 1 beats naive */; pinball: N /* mean over q05..q95, log-ret */
  coverage_50: N; coverage_90: N; width_50: N; width_90: N /* band width % of price */
}
// GET /api/forecast?horizon=90   (7..365) → Forecast (legacy fields above) + the following v2 fields
interface ForecastV2 extends Forecast {
  version: number                      // 2
  model_trained_at: T
  path: { day: number; time: T; p05: number; p25: number; p50: number; p75: number; p95: number }[]   // daily 0..365 (always)
  horizons: { days: 7|30|60|90|180|365; time: T; median: number; p05: number; p25: number; p75: number; p95: number
              change_pct: number /* median vs live price */; up_prob: number
              weights: Partial<Record<ForecastMemberKey, number>>  // % ensemble weights used today
              conformal: { c90: N; c50: N }                        // band adjustment factors (fraction of raw band width)
              backtest: { n: number; hit_rate: N; mape: N; mase: N; coverage_50: N; coverage_90: N; brier_skill: N } }[]
  cycle_model: {
    position: { text: string /* Italian paragraph */; phase: "post_bottom" | "bear" | "bull"; phase_label: string
                days_since_top: N; days_since_bottom: N /* null if no bottom after the last top */; days_since_halving: N
                next_halving_est: T; probable_bottom: boolean; provisional_top: boolean }
    events: { kind: "top" | "bottom" | "halving"; time: T; price: number; probable: boolean }[]   // 2011→, PIT-detected
    anchors: { key: "top" | "bottom" | "halving"; label: string; event_time: T; days: number; weight: number /* % */ }[]
    time_scale: { segment: string /* "massimo → minimo" */; current_days: number
                  past: { from: T; to: T; days: number; ratio: number }[]; gammas: { gamma: number; weight: number }[] } | null
    cycles: { key: string; anchor: "top" | "bottom" | "halving"; anchor_label: string
              label: string                      // e.g. "2022 · dal minimo di ciclo (21 nov 2022)"
              anchor_time: T; anchor_price: number; aligned_time: T /* past date equivalent to today */
              time_scale: number; amplitude_scale: number; weight: number /* % */; similarity: number /* 0..100 */
              return_180: N; return_365: N /* % */
              path: { day: number; time: T; value: number }[] }[]   // rescaled past path from the live price, every 4 days (+ day 365); sorted by weight
    horizons: { days: number; median: number; p05: number; p25: number; p75: number; p95: number; up_prob: number }[]  // cycle model alone
    method: string
  }
  evaluation: {
    note: string; test_from: T
    horizons: { horizon: number; summary: string; skill_vs_naive: boolean
                models: { key: "ensemble" | ForecastMemberKey | "rw_drift" | "previous"; name: string
                          kind: "ensemble" | "member" | "baseline"; test: ForecastMetrics; last12: ForecastMetrics }[]
                by_regime: { regime: "bull" | "bear" | "accumulation"; label: string
                             ensemble: ForecastMetrics; rw0: ForecastMetrics; cycle: ForecastMetrics }[] }[]
    cycle_by_cycle: { horizon: 30|90|180|365; from: T; to: T; label: string /* "2017–2021" */
                      cycle: ForecastMetrics; ensemble: ForecastMetrics; rw0: ForecastMetrics; rw_drift: ForecastMetrics }[]
  }
  calibration: { method: string
                 horizons: { horizon: number; ece: N; brier: N; brier_clim: N; brier_skill: N
                             buckets: { bin: number; from: number; to: number; n: number; predicted: N; observed: N }[] }[] }
  drivers: Record<"7"|"30"|"60"|"90", {          // SHAP (LightGBM pred_contrib) of the median model, today
    horizon: number; lgb_weight: number /* % weight of lgb in the ensemble */; baseline: number; lgb_median: number   // % returns
    top: { key: string; name: string; group: string; value: N; contribution: number /* % return */ }[]   // 10 largest |contribution|
    groups: { group: string; contribution: number }[] }>
  regime: { key: "bull" | "bear" | "accumulation"; label: string; text: string; cycle_phase: string; cycle_phase_label: string
            indicators: { mayer: N; ma200_slope: N; dd_ath: N; days_low: N } }
  training: { status: "ready" | "training" | "error"; progress: string | null; error: string | null; trained_at: T
              data_day: string; seconds: Record<string, number>
              features: { n_features: number; available_now: number; first_valid: Record<string, T | null> } }
}
```
UI (Previsioni page) should show: fan chart from `path` (0–365 d, p05/p25/p50/p75/p95) with overlay of `cycle_model.cycles[].path`
(top 4–6 by weight, opacity ∝ weight, legend = label + weight + similarity) and markers of `cycle_model.events`; the cycle-position
paragraph `cycle_model.position.text` + anchors (days/weights) + time-scale box; horizon table from `horizons` (median, 50% and 90%
ranges, change %, P(up), weights, backtest hit/MASE/coverage); evaluation tables per horizon (`evaluation.horizons[].models`, highlight
`ensemble` vs `rw0`/`previous`, `summary`, `skill_vs_naive`), by regime and `cycle_by_cycle`; reliability diagram from `calibration`;
drivers bar chart (`drivers["30"].top`, with `lgb_weight`); regime badge; training status / `model_trained_at`. Always show the caveat
that 180/365-day results rest on ~3 past cycles with overlapping windows.

## TRACKING (module: app/tracking.py, router: tracking.py)
Persistent prediction ledger `backend/data/tracking_ledger.parquet` (one row per prediction). `record_snapshot()` (idempotent: id =
`source:mode:bucket`, bucket 1 d or 4 h; time pivots keyed by window id), `resolve()` (price at `due_at` = close of the last CLOSED Binance 1h
candle ≤ due_at; `price0` filled at `t0` when missing), `backfill()` (once, version-tagged), `summary(mode)`, `reliability_weights()`, `start()`
(after 45 s: backfill in a thread, then snapshot + resolve every 30 min). Backfill (mode "backtest", ≈ 90 s, run once; versioned per source
via `BT_VERSIONS`, forecast_30d = 2): forecast_30d = the forecast v2 ensemble walk-forward points (weekly, last 4 y; up_prob from the calibrated
distribution); live forecast rows also store `meta.members` (member quantiles, used to tilt the ensemble weights); fractals 1d/4h and analogs 1d/4h = the real search
re-run on a separate module instance whose `load()` is truncated at each past date (no lookahead), last 2 years, every 3 d (fractals 1d), 1 d
(fractals 4h), 5 d (analogs 1d), 3 d (analogs 4h). Live sources: forecast 7/30 d (targets), fractals 4h/1d (p50, p10–p90, up_prob at 30 candles),
analogs 4h/1d (summary median, up share), time pivots (calendar windows with a directional `expected` starting within 2 days; outcome 7 d after the
pivot date), cycle phase (90 d), flows bias (24 h), analyst consensus (7 d; reads `engine.bus.agents["analyst"].state["consensus"]`).
Metrics: hit = direction correct (neutral excluded); Brier on up_prob; brier_ref = p̄(1−p̄) of the sample's realised up rate; skill = 1 − Brier/ref;
reliability buckets of 10 pt; ECE; MAE of the median (%); band coverage (nominal 90 forecast, 80 fractals); last30/last90 by due date
(backtest: relative to its last due date). Weights per agent: skill = mean((hit−0.5)/0.5, 1 − Brier/0.25), live weighted 2×,
w = 0.5 + (clip(0.5+skill,0,1) − 0.5)·n/(n+50). Summary cached 60 s, payload ≈ 27 KB.

```ts
// GET /api/tracking?mode=all|live|backtest        GET /api/tracking/weights -> Record<AgentId, number>
type TrackSource = 'forecast_7d'|'forecast_30d'|'fractals_4h'|'fractals_1d'|'analogs_4h'|'analogs_1d'|'timepivots'|'cycle_phase'|'flows'|'analyst'
interface ReliabilityBucket { bin: number; from: number; to: number; n: number; predicted: N; observed: N }   // %
interface TrackMetrics {
  n_total: number; n_resolved: number; n_pending: number; n_dir: number
  hit_rate: N; brier: N; brier_ref: N; brier_skill: N /* % */; avg_up_prob: N; up_rate_actual: N
  mae_pct: N; coverage: N; band_nominal: N; ece: N /* pt */
  last30: { n: number; hit_rate: N }; last90: { n: number; hit_rate: N }
}
interface SourceStat extends TrackMetrics {
  source: TrackSource; agent: AgentId; agent_label: string; label: string; horizon: string
  mode: 'live' | 'backtest'; first: T | null; last: T | null; note: string
}
interface Prediction {
  id: string; source: TrackSource; label: string; agent: AgentId; mode: 'live' | 'backtest'
  made_at: T; due_at: T; price0: N; direction: 'up' | 'down' | 'neutral'
  up_prob: N; median: N; low: N; high: N; actual: N; change: N /* % realised */
  hit: boolean | null; err_pct: N; in_band: boolean | null; resolved: boolean; context: string | null
}
interface Tracking {
  generated_at: T; mode: 'all' | 'live' | 'backtest'
  overall: TrackMetrics                       // over the rows of `mode`
  split: Record<'live' | 'backtest', { n_total: number; n_resolved: number; n_pending: number; hit_rate: N }>
  sources: SourceStat[]                       // one row per source × mode present
  reliability: { overall: ReliabilityBucket[]; by_source: Record<string /* "source|mode" */, ReliabilityBucket[]> }
  recent: Prediction[]                        // resolved, live first then backtest, max 40
  pending: Prediction[]                       // live not yet due, soonest first, max 20
  weights: Record<AgentId, number>            // 0..1, 0.5 = neutral / no data (forecast, patterns, analogs, timepivots, cycles, flows, analyst)
  backfill: { status: 'idle'|'running'|'done'|'error'; done: string[]; started_at: T|null; finished_at: T|null; error: string|null; progress: string|null }
  method: string
}
// Frontend: src/api/tracking.ts (types + useTracking), src/widgets/tracking.tsx, src/pages/TrackRecordPage.tsx (default export). Route /previsioni?tab=affidabilita (lead).
```

## ALERTS (module: app/alerts.py, router: alerts.py)
Rules engine evaluated every 20 s in the FastAPI loop (`alerts.start()`); heavy rules run on their own interval (60 s / 10 min / 30 min) in threads.
Dedupe: per-rule key + cooldown, identical title+text suppressed for 10 min, transition rules primed silently on the first run.
Anti-spam budget: max 6 non-critical toasts per 10 min — extra alerts are stored with `silent: true` (history only). History: ring buffer (500)
+ `backend/data/alerts_history.parquet` (last 2000). Agent alerts: `engine.bus.messages` with kind=="alert" are polled every tick (or pushed with
`alerts.ingest(msg)`); topics already covered by rules (timepivot.alert, clock.zone, miners.signal, stablecoins.alert, macro.alert) are skipped;
one entry per (agent, topic) with 3 h cooldown; several in the same tick are aggregated into one toast.
Rules / thresholds: price_move |Δ| ≥ 3% in 60 min (critical ≥ 5%, cd 2 h) · level_cross: R1/S1 key levels, weekly open, previous-week high/low
(warning), Monday high/low (info), side confirmed 0.15% beyond, cd 6 h/level · liquidity_sweep: estimated clusters ≥ $100M within 6% + pools with
strength ≥ 60 touched by the live 1m candle (cd 6 h) · liq_burst: real liquidations ≥ $5M in 5 min per side (critical ≥ $20M, cd 30 min) ·
funding ≥ +0.05% / ≤ −0.02% per 8h on entering the zone (cd 12 h) · oi_spike ±5% in 1 h (cd 3 h) · daily close across R1/S1, weekly close
beyond previous-week high/low (once per candle) · timepivot window with confluence ≥ 60 starting today/tomorrow (warning ≥ 75) · event_24h:
FOMC/CPI/NFP/expiries/midterm within 24 h (warning if importance alta and date not estimated) · cycle clock zone change, new Hash Ribbons signal,
miners entering capitulation · macro regime label change · stablecoin net mint/burn ≥ $1B/day (info) or ≥ $3B/7 d (warning) · agent_alert (info).

```ts
// GET  /api/alerts?limit=50&since=<id>&severity=info|warning|critical   (severity = minimum)
// POST /api/alerts/test?severity=warning   (dev only: localhost or env ALERTS_TEST=1) -> Alert (also broadcast as toast)
type AlertSeverity = 'info' | 'warning' | 'critical'
type AlertCategory = 'price'|'levels'|'liquidity'|'derivatives'|'time'|'cycle'|'onchain'|'stablecoins'|'macro'|'agents'|'events'|'test'
interface Alert {
  id: number; time: T; severity: AlertSeverity
  category: AlertCategory; category_label: string    // Italian label
  title: string                                      // ≤ 60 chars, Italian
  text: string                                       // 1–2 lines, Italian
  link: string                                       // frontend route, e.g. "/posizionamento?tab=liquidazioni", "/cicli?tab=clock", "/macro?tab=eventi"
  data: Record<string, unknown>                      // rule-specific numbers (price, level, usd, change…)
  rule: string; key?: string
  silent: boolean                                    // true = history only (budget exceeded); never broadcast
}
interface AlertsResponse {
  items: Alert[]                                     // newest first
  running: boolean; started_at: T | null; last_eval: T | null; evals: number; errors: Record<string, string>
  rules: { rule: string; category: string; severity: string; threshold: string; cooldown: string }[]
  thresholds: Record<string, number>
}
// WS /api/ws additionally pushes: {"type":"toast", ...Alert}   (only silent=false)
// Frontend: src/api/alerts.ts (types incl. ToastMsg + useAlerts). Toast rendering in live.ts/Layout is owned by the lead / UI engineer.
```

## REALTIME INVALIDATION & LANGUAGE
```ts
// WS /api/ws pushes after every agent run (the module's data was recalculated):
//   {"type":"invalidate","source": AgentId, "keys": string[] /* API path prefixes, e.g. "/forecast", "/cycle/advanced" */, "time": T}
// Frontend: invalidate react-query queries whose request path starts with any key.
// Language: any /api request with ?lang=en (or header X-Lang: en) returns generated texts translated to English
// (numbers preserved exactly; untranslated sentences stay Italian until the background translator caches them — refetch later).
// WS: connect with ?lang=en or send {"lang":"en"|"it"} to receive toast texts translated.
```

## STRUCTURE (router: structure.py, engines: app/analysis/structure.py + scenarios.py)
"Struttura e livelli" in the style of KillaXBT / LP_NXT: opening-range pivots (Monday range, period opens, weekly closes), HTF ranges with
deviations/sweeps, acceptance, reclaim, retest ("integrità strutturale"), SFP, HH/HL/LH/LL with BOS/CHoCH, historical outcome stats per event,
and 2–3 deterministic CONDITIONAL scenarios (analytical, never trading advice; disclaimer in payload).
Plain build functions in routers/structure.py: `build_pivots()`, `build_ranges()`, `build_scenarios()`, `build()`.
Data: `k_1h` (Monday range + weekly-open magnet, since 2018), `k_4h`/`k_1d`/`k_1w` via `market._frame` (live last candle), `daily` 2012→
(monthly/quarterly/yearly-open magnet, first week of month, weekly closes, 1D event stats), `k_4h` 2018→ (4H event stats).
Scenarios also use `market.build_levels("1d")`, `analysis.liquidations` (model/clusters/pools), `analogs.build(tf="1d")`, `timepivots.build(90)`.
Cache: sections `ttl_cache(30)` (scenarios 45 s), event stats `ttl_cache(1800)` keyed by day. Warm ≈ 0.2 s; cold ≈ 1–3 s per section (scenarios
up to ~8 s on a fully cold process because analogs/timepivots compute first). Payload: pivots ≈ 40 KB, ranges ≈ 34 KB, scenarios ≈ 16 KB, all ≈ 90 KB.
Definitions: Monday = 00:00–23:59 UTC; regime = daily ADX(14) ≥ 25 "trending" else "ranging"; deviation/sweep = wick beyond a boundary (≥ 0.1 ATR live)
and close back inside; acceptance = 2 consecutive closes outside (3 on 4H); reclaim / failed break = one close outside then back inside; retest =
return to the broken boundary after acceptance (held if it closes on the breakout side); SFP = wick beyond an unswept fractal (≤ 60 bars) and close
back; BOS/CHoCH = close beyond the last confirmed ATR-zigzag swing with / against the prevailing structure. Historical stats use causal definitions
(range = 20-bar (1D) / 42-bar (4H) channel ≤ 7/8 ATR wide with ≥ 2 touches per side); targets/invalidation checked over the next 14 days
(same-bar hit of both = invalidation).

```ts
// GET /api/structure            -> { pivots: StructurePivots; ranges: StructureRanges; scenarios: StructureScenarios }
// GET /api/structure/pivots     -> StructurePivots
// GET /api/structure/ranges     -> StructureRanges
// GET /api/structure/scenarios  -> StructureScenarios          (503 { detail } on failure)
type N = number | null;
type Tone = "bullish" | "bearish" | "neutral";
interface DistStats { n: number; median: N; mean: N; p25: N; p75: N; p90: N }          // percent
interface FwdStats { n: number; median: N; mean: N; win_rate: N }                      // percent

// ---- A) pivot di apertura
interface MondaySide {
  weeks: number; broken: number; broken_pct: N; first_pct: N;
  back_inside_pct: N;            // % of breaks followed by a 1h close back inside the Monday range (same week)
  rev2_pct: N; rev3_pct: N;      // % of breaks with return inside AND a move ≥2% / ≥3% from the broken level in the opposite direction
  reversal: DistStats;           // move from the broken level in the opposite direction
  reach_opposite_pct: N; close_beyond_pct: N;   // opposite Monday extreme reached; weekly close beyond the broken level
  extension: DistStats;          // max extension beyond the broken level
  inverse: DistStats;            // max peak-to-trough after the break
  hours_to_break_median: N;      // hours after the end of Monday
}
interface MondayCurrent {
  week_start: T; monday_complete: boolean; high: number; low: number; mid: number; open: number;
  range_pct: N; range_rank: N;   // width percentile vs history
  price: number; position: "sopra" | "sotto" | "dentro"; dist_high: N; dist_low: N;
  broke_high: boolean; broke_low: boolean; first_break: "high" | "low" | null; ext_high: N; ext_low: N;
  regime: "ranging" | "trending" | null; adx: N; text: string;
}
interface MondayWeek { week_start: T; high: number; low: number; range_pct: N; broke_high: boolean; broke_low: boolean;
  first_break: "high" | "low" | null; ext_high: N; ext_low: N; reversal: N; back_inside: boolean | null;
  week_return: N /* Monday close → week close */; regime: "ranging" | "trending" | null }
interface MondayRange {
  current: MondayCurrent | null;
  previous: { week_start: T; high: number; low: number; close: number; broke_high: boolean; broke_low: boolean; first_break: "high" | "low" | null; text: string } | null;
  stats: { weeks: number; since: T | null; high: MondaySide; low: MondaySide; both_pct: N; none_pct: N; range_pct: DistStats;
           by_regime: { key: "ranging" | "trending"; label: string; weeks: number; high: MondaySide; low: MondaySide }[];
           by_year: { year: number; weeks: number; high_broken_pct: N; high_rev2_pct: N; high_rev3_pct: N; low_broken_pct: N; low_rev2_pct: N; low_rev3_pct: N }[] };
  history: MondayWeek[];         // last 26 completed weeks, newest first
}
interface Magnet { threshold: number /* % from the open */; periods: number; n: number /* periods reaching the threshold */; reached_pct: N;
  revisit_pct: N /* open touched again before period end */; median_hours: N }
interface Excursion { max_exc: N; revisited: boolean | null; side: "sopra" | "sotto" }
interface OpenBlock { open: N; excursion: Excursion | null; magnet: Magnet[]; since: string; text?: string }
interface OpenLevel { key: "weekly_open" | "monthly_open" | "quarterly_open" | "yearly_open" | "prev_week_high" | "prev_week_low" | "prev_month_high" | "prev_month_low";
  label: string; price: number; distance: N; group: "open" | "prev"; side: "sopra" | "sotto"; note: string | null }
interface FirstWeek {
  current: { days: number; fw_return: N; fw_high?: number; fw_low?: number; mtd?: N } | null;
  stats: { months: number; same_direction_pct: N; high_in_first_week_pct: N; low_in_first_week_pct: N; extreme_in_first_week_pct: N;
           after_up: FwdStats & { month_up_pct: N }; after_down: FwdStats & { month_up_pct: N }; first_week: FwdStats };  // after_*: rest-of-month returns
  text: string; since: string;
}
interface Opens { week_start: T; month_start: T; quarter_start: T; year_start: T;
  weekly: OpenBlock; monthly: OpenBlock; quarterly: OpenBlock; yearly: OpenBlock;
  prev_week: { high: N; low: N; close: N }; prev_month: { high: N; low: N; close: N };
  levels: OpenLevel[];           // sorted by price desc
  first_week: FirstWeek }
interface WeeklyEvent { key: "all" | "sweep_reclaim_low" | "close_above_prev_low" | "close_below_prev_low" | "sweep_reject_high" | "close_above_prev_high"
  | "close_above_range_4w" | "close_below_range_4w" | "inside_week"; label: string; description: string;
  n: number; freq_pct: N; w1: FwdStats; w2: FwdStats; w4: FwdStats; last: T | null }
interface WeeklyClose {
  events: WeeklyEvent[];         // weeks Mon–Sun from daily since 2012, forward returns from the weekly close
  current: { week_start: T; open: number; high: number; low: number; price: number; prev_high: number; prev_low: number;
             range4_high: number; range4_low: number; provisional_events: string[]; text: string;
             levels: { label: string; price: number; distance: N }[] } | null;
  last_closed: { week_start: T; open: number; high: number; low: number; close: number; prev_high: number; prev_low: number; events: string[] } | null;
  weeks: number; since: T | null;
}
interface StructurePivots { generated_at: T; price: number; monday: MondayRange; opens: Opens; weekly_close: WeeklyClose;
  chart: { candles: Candle[] /* 1h, previous + current week */; prev_monday: { week_start: T; high: number; low: number } | null };
  method: string }

// ---- B) range e struttura
type RangeStateKey = "inside" | "inside_after_sweep_low" | "inside_after_sweep_high" | "inside_after_failed_breakout"
  | "above_unconfirmed" | "accepted_above" | "retest_held_above" | "below_unconfirmed" | "accepted_below" | "retest_held_below";
type StructEventKey = "dev_high" | "dev_low" | "failed_break_high" | "reclaim_low" | "accept_high" | "accept_low"
  | "retest_hold_high" | "retest_fail_high" | "retest_hold_low" | "retest_fail_low" | "close_above" | "close_below"
  | "sfp_high" | "sfp_low" | "bos_up" | "bos_down" | "choch_up" | "choch_down";
interface MarketStructure { trend: Tone; trend_label: string;
  swings: { time: T; price: number; kind: "high" | "low"; label: "HH" | "HL" | "LH" | "LL" | null; confirmed: boolean }[];   // last 12 zigzag swings
  last_high_label: string | null; last_low_label: string | null; last_high: N; last_low: N; last_high_time: T | null; last_low_time: T | null;
  last_event: { key: StructEventKey; label: string; time: T; level: N } | null }   // last BOS/CHoCH (sets `trend`)
interface RangeBox { high: number; low: number; mid: number; start: T; end: T; bars: number; days: N; touches_high: number; touches_low: number;
  width_pct: N; width_atr: N; position: N /* 0 = low, 100 = high */; containment: N /* % closes inside */;
  touch_points: { time: T; price: number; kind: "high" | "low" }[] }
interface TfStructure { tf: "4h" | "1d" | "1w"; price: number; structure: MarketStructure;
  range: RangeBox | null;
  macro_range: { high: number; low: number; mid: number; start: T; bars: number; touches_high: number; touches_low: number; width_pct: N } | null;
  events: { n: number /* chronological marker number */; key: StructEventKey; label: string; time: T /* bar time on tf */; price: number; kind: "range" | "sfp" | "structure" }[];
  state: RangeStateKey | null; state_label: string; text: string;
  key_levels: { label: string; price: number; kind: "range_high" | "range_mid" | "range_low" | "sweep_low" | "sweep_high" | "target" | "swing_high" | "swing_low"; distance: N }[];
  atr?: N }
interface EventStat { key: StructEventKey; label: string; description: string; direction: "up" | "down"; n: number;
  fwd: Record<"d1" | "d3" | "d7" | "d14", FwdStats>; follow_pct: N /* 7d return in expected direction */;
  target1: string; target2: string; invalidation: string; p_target1: N; p_target2: N; p_invalid: N /* within 14 days */; n_outcome: number; last: T | null }
interface StructureRanges { generated_at: T; price: number; timeframes: Record<"4h" | "1d" | "1w", TfStructure>;
  stats: Record<"1d" | "4h", { tf: "1d" | "4h"; since: T; bars: number; events: EventStat[]; base: Record<"d1" | "d3" | "d7" | "d14", FwdStats> }>;
  summary: string; method: string }

// ---- C) scenari
interface ScenarioTarget { price: number; label: string; reasons: string[]; distance: N; confluence: number }
interface TimingItem { time: T; start: T; end: T; label: string; title: string; expected: string; confluence: N; days_away: number }   // from /api/timepivots calendar
interface Scenario { id: string; n: number; title: string; tone: Tone;
  trigger: { text: string; level: N; condition: "close_above" | "close_below" | "inside"; tf: string };
  targets: ScenarioTarget[]; invalidation: { price: N; text: string };
  probability: { value: N /* % first target hit within 14 d after similar historical events */; target2: N; invalid: N; n: N; tf: string; basis: string; text: string } | null;
  timing: TimingItem[]; supports: string[]; against: string[]; narrative: string;
  path: { time: T; price: number; label: string }[] }   // indicative sketch (½ daily ATR per day), first point = now
interface StructureScenarios { generated_at: T; price: number; atr_d: number; state: RangeStateKey | null; state_label: string;
  range: { high: number; low: number; mid: number; start: T } | null; scenarios: Scenario[]; summary: string;
  levels: { price: number; label: string; reasons: string[]; distance: N; weight: number; sources: string[] }[];   // merged confluence zones within ±12%
  disclaimer: string; timing: TimingItem[];
  analogs: { bias: string | null; median_outcome: N; up: N; down: N; count: N; text: string; horizon: N;
             best: { label: string; similarity: N; change: N; max_up: N; max_down: N } | null } | null;
  sources: { liquidity: boolean; analogs: boolean; timepivots: boolean; levels: boolean }; method: string }
// Frontend: src/api/structure.ts (types + useStructurePivots / useStructureRanges / useStructureScenarios), src/widgets/structure.tsx,
// src/pages/StructurePage.tsx (default export; tabs ?tab=range|pivot|scenari). Route /struttura + nav item added by the lead.
```

## IMAGE PATTERN (router: image_pattern.py, engine: app/analysis/image_pattern.py — reuses analogs.py + analogs_visual.py)
Historical analogs of a price pattern extracted from an uploaded screenshot (TradingView and similar). The image is processed
in memory only and never stored. Extraction is deterministic (numpy + Pillow + scipy.ndimage): background = most frequent colour;
HSV classes up (hue 75–200°) / down (330–22°) with saturation/chroma thresholds; per class the "solid" candle colour is the frequent
cluster farthest from the background (translucent volume, anti-aliasing, watermark rejected); thin horizontal lines (last-price line,
same-colour MAs), coloured text (legend glyphs), axis price tags (solid rectangles) and an opaque volume pane (bars on a common
baseline) are removed; candles cut by overlaid lines are re-joined (vertical closing ≤ 3 px); connected components → candles
(body = rows spanning ≥ 60% of the width, wicks = vertical extremes), regular pitch, gaps ≤ 6 candles interpolated; fallback
line chart → closes. y-pixel → relative price (y up = price up), treated as log scale for matching.
Search per timeframe: window = detected candles; candidates by Pearson corr + banded DTW on z-normalised log price (scale-free),
re-ranked with the visual engine (shape 30, candles 20, legs 20, pattern 15, volatility 7.5; volume excluded → weights renormalised)
after calibrating the pattern's log range on each candidate's own range (scale-free comparison).
`similarity = 0.85·visual + 0.15·structure` (R², position in range, HH/HL structure, retests). Only windows with a complete
continuation of `horizon` candles are candidates. Typical timings (1920×1080, 4 tfs): extraction 0.1–0.5 s, search 0.4–0.9 s.

```ts
// POST /api/analogs/image   multipart/form-data
//   image: File (png | jpeg | webp, ≤ 8 MB)                         required
//   crop?: string   JSON {"x","y","w","h"} in original image pixels (min 60×40)
//   tfs?: string    comma list subset of "1h,4h,1d,1w" (default all)
//   top?: number    1..8 (default 5) — best `top` across timeframes + always the best of each requested tf
//   horizon?: number 5..150 (default max(10, round(0.5·candles)))
//   theme?: "auto"|"dark"|"light" (default auto)
// Errors: 413 too large · 415 bad type · 422 { detail } Italian message (no candles found, image too small, too few candles
// (< 12), unreadable image, bad crop/params) · 500 unexpected. Candles are capped to the last 300.
interface ImagePatternBox {             // one detected candle, ORIGINAL image pixel coordinates (crop offset included)
  i: number; x: number; x0: number; x1: number;
  y_open: number; y_close: number; y_high: number; y_low: number;
  bull: boolean;
  filled: boolean;                      // false = not recognised, interpolated (flat candle)
}
interface ImagePatternExtraction {
  kind: "candles" | "line";
  candles: number;
  image: { width: number; height: number };
  crop: { x: number; y: number; w: number; h: number };
  theme: "dark" | "light";
  colors: { up: string | null; down: string | null; background: string };   // "#rrggbb" (line chart: line colour in `up`)
  pitch_px: number; body_px: number;
  spacing_score: number;                // 0..100 share of regular gaps
  confidence: number;                   // 0..100
  volume_excluded: boolean;
  inserted: number;                     // interpolated candles
  warnings: string[];                   // Italian, e.g. "Volume pane rilevato ed escluso.", "Poche candele: …", "Grafico a linee: …"
  boxes: ImagePatternBox[];
  series: { open: number[]; high: number[]; low: number[]; close: number[] };  // relative 0 = lowest low … 100 = highest high
}
interface ImagePatternMatch extends AnalogMatch {   // same shape as /api/analogs matches ("current" = the image pattern)
  tf: "1h"|"4h"|"1d"|"1w";
  window: number;                       // = extraction.candles
  query_candles: AnalogCandle[];        // the pattern calibrated on this analog's range and moved to the current BTC price, last candle = now
  scale_range: number;                  // % range assumed for the pattern (= the analog window's range)
  // features: only r2 | position | structure | retests (scale-free); visual.components.volume.score = null
  // projection: analog continuation rescaled to the current price ("se succedesse oggi"); narrative_llm always null
}
interface ImagePatternTf { tf: string; available: boolean; candidates: number; best_similarity: number | null; best_period: string | null; note: string | null }
interface ImagePattern {
  generated_at: T; tfs: string[]; window: number; horizon: number; top: number;
  price_now: number;                    // latest BTC close (1h)
  extraction: ImagePatternExtraction;
  per_tf: ImagePatternTf[];
  summary: Analogs["summary"];          // over the returned matches
  projection: { steps: number; median: (number | null)[]; p25: (number | null)[]; p75: (number | null)[] }; // USD, per candle step, all matches
  matches: ImagePatternMatch[];         // sorted by similarity, rank 1..n
  timings: { decode_ms: number; extract_ms: number; search_ms: number; total_ms: number };
  method: string;
}
```


## SUPPLY DEMAND (router: supply_demand.py, engines: app/analysis/supply_demand.py + etf_flows.py, agent: supply_demand)

Sources (all free, no key): CoinMetrics community `SplyExNtv, FlowInExNtv, FlowOutExNtv, IssTotNtv, SplyCur, PriceUSD` (daily, +1 day,
every value served with status "flash" = preliminary → full reload at each refresh, dataset `sd_exchange`, TTL 6 h);
Farside Investors HTML `bitcoin-etf-flow-all-data` (fallback `farside.co.uk/btc/` + parquet cache, dataset `sd_etf`, TTL 1 h,
schema checks: ticker header, Total column, first day 11 Jan 2024 = +655.3 M$); Wikimedia pageviews `en.wikipedia` / `it.wikipedia`
article "Bitcoin", agent=user, since 1 Jul 2015 (descriptive User-Agent, datasets `sd_wiki_en` / `sd_wiki_it`, TTL 6 h).
Builders: `build_exchanges()` (cache 6 h) · `build_etf()` (1 h) · `build_attention()` (6 h) · `build()` aggregate.
Rules: z-scores / percentiles use past data only; ETF BTC amounts are ESTIMATES (flow USD ÷ BTC price at 16:00 New York = close of the
Binance 1h candle ending 16:00 ET, fallback daily close); the latest ETF row is always provisional; absorption ratio = ETF net BTC ÷
BTC issued by miners (IssTotNtv) over the same calendar days where issuance is known. Payload: exchanges ≈ 285 KB, etf ≈ 150 KB,
attention ≈ 130 KB (aggregate < 600 KB). The frontend composes all texts (IT/EN) and calls these endpoints without `lang`.

```ts
// GET /api/supply-demand            -> SupplyDemand (null section + errors[k] if a source is unavailable)
// GET /api/supply-demand/exchanges  -> ExchangesData   (503 if unavailable)
// GET /api/supply-demand/etf        -> EtfData         (503 if unavailable)
// GET /api/supply-demand/attention  -> AttentionData   (503 if unavailable)
// BTC amounts in BTC, ETF USD amounts in MILLIONS of USD, percentages in percent, T = unix seconds (UTC day start).
// ------------------------------------------------------------------ Exchange (CoinMetrics community)
type FlowRegime = 'deflussi_forti' | 'deflussi' | 'neutro' | 'afflussi' | 'afflussi_forti'
interface FwdBlock {                       // forward BTC returns (median %, share positive %, sample size)
  days: number; episodes: number; last: T | null
  r7?: N; hit7?: N; n7?: number; r30: N; hit30: N; n30: number; r90: N; hit90: N; n90: number; r180?: N; hit180?: N; n180?: number
}
interface ExtremeDay { time: T; net: N; inflow: N; outflow: N; z: N; price: N; r30: N; r90: N }
interface CyclePhase {
  kind: 'rialzo' | 'ribasso'; start: T; end: T; ongoing: boolean; days: number; price_change: N
  reserve_start: N; reserve_end: N; reserve_change: N; reserve_change_pct: N; share_change_pt: N
  avg_daily_net: N; outflow_days_pct: N; start_partial: boolean
}
interface ExchangesData {
  as_of: T                                        // last CoinMetrics day (UTC, +1 day publication delay)
  flash_computed_at: T | null                     // when CoinMetrics computed the latest "flash" (preliminary) value
  kpi: {
    reserve: N; reserve_pct: N                    // BTC on exchanges; % of circulating supply
    reserve_change_30d: N; reserve_change_365d: N; reserve_change_365d_pct: N; share_change_365d_pt: N
    net_1d: N; z_1d: N; net_7d: N; net_30d: N; net_90d: N; z_30d: N; regime: FlowRegime | null
    lowest_since: T | null; reserve_ath: N; reserve_ath_time: T; inflow_1d: N; outflow_1d: N; price: N
  }
  series: {                                       // weekly samples, daily over the last 365 days
    reserve: Pt[]; reserve_pct: Pt[]; price: Pt[]; net30: Pt[]; net90: Pt[]; z30: Pt[]
    net_daily: Pt[]                               // daily net flow, last 365 days (BTC, + = into exchanges)
    net_weekly: Pt[]                              // weekly sums (Mon→Sun) since 2015
  }
  recent: { time: T; inflow: N; outflow: N; net: N; reserve: N; z: N; flash: boolean }[]   // last 30 days, newest first
  extremes: { inflows: ExtremeDay[]; outflows: ExtremeDay[] }                              // top 10 by daily z-score, ≥ 10 days apart
  regimes: { since: T; rows: (FwdBlock & { key: FlowRegime; lo: N; hi: N })[]; baseline: FwdBlock
             daily: { outflow: FwdBlock; inflow: FwdBlock; baseline: FwdBlock } }          // daily |z| ≥ 2, horizons 7/30/90
  phases: CyclePhase[]
  checks: {
    black_thursday: { date: T; expected_inflow: number; inflow: N; outflow: N; net: N }
    ftx: { date: T; expected_net: number; inflow: N; outflow: N; net: N }
    identity_days: number; identity_ok_pct: N     // % of days where Δreserve = inflow − outflow (±1 BTC)
    adjustments: number; adjustment_btc: N; adjustments_list: { time: T; btc: N }[]   // coverage changes > 1,000 BTC
    flash_rows_pct: N; issuance_30d_avg: N
  }
  stats_since: T
}

// ------------------------------------------------------------------ ETF spot (Farside)
interface Streak { sign: 1 | -1; start: T; end: T; days: number; usd: N; btc: N }
interface IssuerRow {
  ticker: string; first: T | null; cum_usd: N; cum_btc: N; last: N; d5: N; d30: N   // M$ (d30 = last 21 sessions); BTC estimate
  max_in: N; max_in_time: T | null; max_out: N; max_out_time: T | null
}
interface AbsorptionRow { time: T; etf_btc: N; issued_btc: N; etf_usd: N; ratio: N; complete: boolean }
interface EtfData {
  as_of: T; provisional: boolean; partial_issuers: string[]
  source: { name: string; url: string; mode: 'all' | 'recent' | 'cache'; fetched_at: T | null; error: string | null; age_s: N }
  kpi: {
    last_usd: N; last_btc: N; d5_usd: N; d5_btc: N; d20_usd: N; d20_btc: N; cum_usd: N; cum_btc: N   // USD in M$
    ratio_30d: N; ratio_30d_time: T | null; issued_30d: N; etf_30d_btc: N
    days: number; inflow_days_pct: N; price_last: N
  }
  streaks: { current: Streak | null; longest_in: Streak | null; longest_out: Streak | null }
  issuers: IssuerRow[]                            // sorted by cumulative flow
  daily: {                                        // trading days since 11 Jan 2024, arrays aligned with `dates`
    dates: T[]; issuers: Record<string, N[]>; total: N[]; btc: N[]; cum_usd: N[]; cum_btc: N[]; price: N[]   // price = BTC at 16:00 New York
  }
  recent: { time: T; total: N; btc: N; price: N; by: Record<string, N>; provisional: boolean }[]   // last 20 sessions, newest first
  absorption: {
    ratio30: Pt[]                                 // rolling 30 calendar days: ETF net BTC ÷ BTC issued by miners
    weekly: AbsorptionRow[]; monthly: AbsorptionRow[]
    since_launch: { etf_btc: N; issued_btc: N; ratio: N }
    post_halving: { since: T; etf_btc: N; issued_btc: N; ratio: N }
  }
  reaction: { big_in: FwdBlock; big_out: FwdBlock; all: FwdBlock }   // total ≥ +500 M$ / ≤ −500 M$, horizons 7/30/90
  checks: {
    day1_total: N; day1_expected: number; row_mismatches: number; rows: number; footer_total: N; sum_total: N
    known: { date: T; col: string; expected: number; observed: N; ok: boolean }[]
    ibit_2024: { date: T; estimate: N; published: number; ok: boolean }
  }
}

// ------------------------------------------------------------------ Attenzione (Wikipedia)
type AttentionZone = 'bassa' | 'sotto_media' | 'sopra_media' | 'alta' | 'estrema'
interface AttentionData {
  as_of: T
  kpi: {
    views_1d: N; avg_30d: N; avg_7d: N; change_365d: N; percentile: N; zone: AttentionZone | null
    ath_30d: N; ath_30d_time: T; vs_ath_pct: N; ath_day: N; ath_day_time: T
    it_avg_30d: N; it_ath_day_time: T | null; it_ath_day: N; lowest_since: T | null
  }
  series: { views30: Pt[]; it30: Pt[]; price: Pt[]; percentile: Pt[] }   // weekly samples, daily over the last 365 days (percentile weekly)
  peaks: { top: T; top_price: N; peak30: T; peak30_views: N; lag30_days: number; peak_day: T; peak_day_views: N; lag_day_days: number; complete: boolean }[]
  spikes: { time: T; views: N; price: N; r30: N; r90: N }[]
  backtest: { since: T; rows: (FwdBlock & { key: AttentionZone; lo: number; hi: number })[]; baseline: FwdBlock }
  checks: { en_peak_day: T; en_peak_views: N; it_peak_day: T | null; days: number; first: T }
}

interface SupplyDemand {
  exchanges: ExchangesData | null; etf: EtfData | null; attention: AttentionData | null
  errors: Record<string, string>; generated_at: T
}
```

## CUSTOM ALERTS (modules: app/alert_rules.py + alerts.rule_custom, router: alerts.py)
User-defined rules persisted in `backend/data/alert_rules.json` (atomic writes; the `USER_DATA_DIR` env var moves the user files, e.g. for a
test instance). Evaluated by the existing engine every 20 s (`RULES` entry `custom` → `alert_rules.evaluate(p)`), emitted with `emit()/push()`
as category `"custom"` (category_label "Avvisi personali", rule `"custom_rule"`, title = rule name, link `/avvisi`, data includes `rule_id`) →
same toasts / bell / history / anti-spam budget as the built-in rules. After a fire the engine broadcasts
`{"type":"invalidate","keys":["/alerts/rules"]}`.
Semantics: condition rules fire when the condition BECOMES true (already true at save → fires at the first check); a repeating rule re-arms
only after the condition went false again AND the cooldown elapsed; `repeat: false` disables the rule after the first alert (status
`triggered`); `expires_at` stops evaluation (status `expired`). Event rules (`cycle_zone`, `timepivot`, `candle_close`) are primed at save and
fire once per event (zone change / new window id / new closed candle). The condition state is persisted: a restart never re-fires an
already-notified condition.
Data: price = WS ticker → Binance REST; pct_move = Binance 1m klines (≤ 900 min) or k_1h; RSI 14 on the live `market._frame(tf)`;
funding = WS mark → `funding` dataset (% per 8h); OI change from `oi_15m`; Fear & Greed `fng`; Cycle Score/zone
`cycle_advanced.build_clock().current`; USDT.D `usdt.build().current`; named levels from `market.build_levels("1d")` (key R/S + classic pivots),
`structure.build_pivots()` (opens, previous week/month high/low, Monday range), `structure.build_scenarios().range`, ATH = max k_1d high;
liquidations `store.liquidations()`.
User text (name, note) is never machine-translated: the frontend calls these endpoints with a URL object (no `?lang=en`); besides user text
the responses contain only codes + numbers (labels are translated in the frontend).

```ts
// GET    /api/alerts/rules                 -> RulesResponse
// GET    /api/alerts/rules/metrics         -> RuleMetrics   (live values for the editor)
// POST   /api/alerts/rules/preview  body Pick<RuleInput,'type'|'params'|'cooldown_min'> -> RulePreview   (unsaved draft)
// POST   /api/alerts/rules          body RuleInput  -> AlertRule        (400 {detail:"field: message"} on validation errors)
// GET    /api/alerts/rules/{id}                     -> AlertRule
// PUT    /api/alerts/rules/{id}     body Partial<RuleInput> -> AlertRule (type/params change or re-enable resets the condition state)
// DELETE /api/alerts/rules/{id}                     -> { ok: true }
// POST   /api/alerts/rules/{id}/test                -> RulePreview      (evaluates now, no side effects)
// GET    /api/alerts?category=custom&limit=100   (history filtered by category, comma-separated)
type RuleType = 'price_cross'|'pct_move'|'zone'|'level_distance'|'indicator'|'cycle_zone'|'timepivot'|'candle_close'|'liq_burst'
type MetricKey = 'rsi_1h'|'rsi_4h'|'rsi_1d'|'funding'|'oi_change_1h'|'oi_change_4h'|'oi_change_24h'|'fng'|'cycle_score'|'usdt_d'|'usdt_d_change_7d'
type MetricUnit = 'idx'|'pct8h'|'pct'|'pt'
type CycleZone = 'bottom'|'accumulation'|'mid'|'euphoria'|'top'
type LevelId = 'key_r1'|'key_r2'|'key_r3'|'key_s1'|'key_s2'|'key_s3'
  |'piv_d_P'|'piv_d_R1'|'piv_d_S1'|'piv_w_P'|'piv_w_R1'|'piv_w_R2'|'piv_w_S1'|'piv_w_S2'|'piv_m_P'|'piv_m_R1'|'piv_m_S1'
  |'weekly_open'|'monthly_open'|'quarterly_open'|'yearly_open'|'prev_week_high'|'prev_week_low'|'prev_month_high'|'prev_month_low'
  |'monday_high'|'monday_low'|'monday_mid'|'range_high'|'range_mid'|'range_low'|'ath'
type RuleParams =                                                         // validated server-side (ranges in brackets)
  | { direction: 'above'|'below'; price: number }                         // price_cross  [1, 1e7]
  | { direction: 'up'|'down'|'any'; pct: number; window_min: 5|15|30|60|120|240|480|720|1440 }   // pct_move, pct [0.1, 50]
  | { low: number; high: number; mode: 'enter'|'exit' }                   // zone (high > low)
  | { level: LevelId; pct: number }                                       // level_distance, pct [0.05, 20]
  | { metric: MetricKey; op: 'above'|'below'; value: number }             // indicator
  | { zone: 'any'|CycleZone }                                             // cycle_zone
  | { min_confluence: number; lead_days: 0|1|3|7 }                        // timepivot (0 = only windows already started)
  | { tf: '1d'|'1w'; direction: 'above'|'below'; price: number }          // candle_close (closed candles only)
  | { usd: number; window_min: 1|5|15|30|60|240; side: 'any'|'long'|'short' }   // liq_burst, usd [1e5, 1e10]
interface RuleInput {
  name: string                  // 1..80 chars (user text)
  type: RuleType; params: RuleParams
  enabled: boolean; severity: 'info'|'warning'|'critical'
  cooldown_min: number          // 1..10080
  repeat: boolean               // false = one-shot
  expires_at: T | null; note: string   // note ≤ 500 chars (user text)
}
interface AlertRule extends RuleInput {
  id: string; created_at: T; updated_at: T; last_fired: T | null; fire_count: number
  status: 'active'|'paused'|'expired'|'triggered'|'error'
  last_checked: T | null; next_check: T | null; cooldown_until: T | null
  current: { value: number | null; condition: boolean | null; error: string | null }   // last engine evaluation
}
interface RulesResponse { items: AlertRule[]; types: RuleType[]; levels: LevelId[]; metrics: Record<MetricKey, MetricUnit>; tick_s: number; last_eval: T | null }
interface RulePreview {
  value: number | null; threshold: number | null; condition: boolean | null
  unit: 'usd'|'pct'|'idx'|'pct8h'|'pt'|'count'; event?: boolean; checked_at: T
  would_fire: boolean
  reason: 'ready'|'not_met'|'pending_event'|'cooldown'|'already_fired'|'disabled'|'expired'|'triggered'|'no_data'
  detail: Record<string, unknown>   // e.g. ref_price, level_price, signed_distance_pct, zone/last_zone, windows[], candle_time
}
interface RuleMetrics {
  price: number | null; time: T
  metrics: Partial<Record<MetricKey | 'cycle_zone', number | string | null>>
  levels: Partial<Record<LevelId, { price: number; source: string | null; distance: number | null }>>  // distance = level vs price, %
  timepivots: { id: string; start: T; end: T; confluence: number | null; expected: string | null; probability: number | null }[]
  liq_15m: number | null; moves: Record<'60'|'240'|'1440', number | null>
  closes: Record<'1d'|'1w', { time: T | null; close: number | null }>
}
// AlertCategory gains 'custom' (can be muted in the bell settings).
// Frontend: src/api/alertRules.ts, src/widgets/alertRules.tsx (editor + openRuleEditor() quick-create), src/pages/AlertsPage.tsx (/avvisi).
// Quick-create: bell button on each row of the /grafici key-levels table and the "Avviso" chart tool (price under the cursor).
```

## ANNOTATIONS (module: app/annotations.py, router: annotations.py)
Annotazioni del grafico di `/grafici`, persistite in `journal_annotations.json` nella cartella dati utente (`USER_DATA_DIR` per un'istanza di test): il nome del file resta quello storico, così quelle già salvate si leggono senza migrazione. Testo scritto dall'utente: mai tradotto.

```ts
interface AnnotationInput {
  kind: 'hline'|'trendline'|'vline'|'text'; symbol?: string /* default BTCUSDT */; tf: Tf|null /* null = every timeframe */
  points: { time: T|null; price: number|null }[]   // hline [{price}] · vline [{time}] · text [{time,price}] · trendline 2×{time,price}
  text: string /* ≤ 280, required for 'text' */; color: 'slate'|'blue'|'violet'|'teal'|'amber'|'btc'; extend?: boolean /* trendline ray */
}
interface Annotation extends AnnotationInput { id: string; symbol: string; created_at: T; updated_at: T }
// GET    /api/annotations?symbol=BTCUSDT&tf=4h              -> { items: Annotation[] }   (also returns tf=null items)
// POST   /api/annotations  body AnnotationInput             -> Annotation
// PUT    /api/annotations/{id} body Partial<AnnotationInput> -> Annotation
// DELETE /api/annotations/{id}                              -> { ok: true }
// Frontend: src/api/annotations.ts, src/widgets/annotations.tsx, ProChart props `annotations`, `onPick`, `pickDraft`, `onAnnotationClick`.
```

## DERIVATIVES PRO (router: derivatives.py, engines: app/analysis/basis.py + cme.py + aggregate.py, liquidations.py; collectors: app/live.py + app/liq_collectors.py)

Existing `GET /api/derivatives` is unchanged. New endpoints (all percent values are already ×100; `Pt`/`T` as in Global conventions):

```ts
type N = number | null
type Signal = { text: string; tone: 'bullish'|'bearish'|'neutral' }   // Italian prose (EN via ?lang=en)

// GET /api/derivatives/basis   (cache 30 s; Deribit + Binance live, Binance daily history)
type BasisVenue = 'deribit' | 'binance_usdm' | 'binance_coinm'
interface BasisRow { venue: BasisVenue; instrument: string; expiry: T; days: number; mark: number; index: number
                     basis_pct: number; annualized_pct: number /* (F/S−1)·365/days ·100 */; oi_usd: N /* Deribit only */; noisy: boolean /* < 7 days */ }
interface PerpPremium { mark: number; index: number; premium_pct: number; funding_8h: N /* %/8h */; oi_usd: N }
interface BasisData {
  time: T; index_price: N; curve: BasisRow[] /* sorted by expiry */; perpetual: Partial<Record<BasisVenue, PerpPremium>>
  shape: 'contango'|'backwardation'|'mixed'|null   // in PRICE terms (all Deribit futures ≥7 d above / below index)
  slope_pp: N                                      // annualized, longest − shortest Deribit expiry (points)
  stats: { current_pct: N /* 90-day constant maturity, Binance COIN-M, live */; percentile: N /* vs history since 2020 */; percentile_1y: N
           avg_30d: N; max: {value: number; time: T}|null; min: {value: number; time: T}|null; source: 'binance_coinm'; live: boolean; usdm_live_pct?: N }
  crosscheck: {
    pairs: { expiry: T; deribit_pct: number; binance_usdm_pct: N; binance_coinm_pct: N; diff_pp: number }[]   // same expiry on both venues
    binance_official: { time: T; binance_pct: number /* Binance /futures/data/basis annualizedBasisRate */; ours_pct: number; diff_pp: number; days: number } | null
    coinm_vs_usdm: { n: number; mean_abs_diff_pp: number; mean_abs_diff_1y_pp: number; corr: number } | null
    roll_check: { n_rolls: number; contract_roll_pp: number; contract_other_pp: number; cm90_roll_pp: number; cm90_other_pp: number } | null
  }
  history: { coinm: Pt[]; usdm: Pt[]                 // 90-day constant maturity (interpolated CURRENT/NEXT quarter) — no roll steps
             coinm_contract: Pt[]; usdm_contract: Pt[] // per-contract annualized basis of the quarterly in use (switch 14 d before expiry)
             rolls: { coinm: T[]; usdm: T[] }; start: { coinm: T|null /* 27 Jun 2020 */; usdm: T|null /* 3 Feb 2021 */ } }
  deribit_cm90: { since: T|null; series: Pt[] }      // daily Deribit snapshots collected by the app (dataset basis_deribit_snap)
  signals: Signal[]; params: { roll_days: 14; noisy_days: 7; cm_days: 90 }
}

// GET /api/derivatives/cme   (CFTC TFF futures-only, Socrata gpe5-46if, weekly; dataset cot_cme refreshed every 6 h)
type CotCat = 'lev'|'am'|'dealer'|'other'|'nr'
interface CotCategory { id: CotCat; label: string; long: number; short: number; spread: N; net: number /* contracts */; net_btc: number /* ×5 */
                        net_change: N; long_change: N; short_change: N; pct_oi_long: number; pct_oi_short: number; net_pctl_3y: N }
interface CmeData {
  report_date: T /* Tuesday */; published: T /* +3 d, Friday 15:30 ET */; next_report: T; next_publication: T
  contract_btc: 5; oi_contracts: number; oi_btc: number; oi_change: N; oi_change_btc: N; oi_pctl_3y: N
  micro: { oi_contracts: N; oi_btc: N /* ×0.1, same report week only */; since: T|null }
  traders: { total: N; lev_long: N; lev_short: N; am_long: N; am_short: N }
  categories: CotCategory[]
  history: { oi_btc: Pt[]; micro_oi_btc: Pt[]; lev_net: Pt[]; am_net: Pt[]; dealer_net: Pt[]; other_net: Pt[]; nr_net: Pt[] }  // *_net in contracts
  since: T; weeks: number
  verification: { report_date: T|null; same_week: boolean; match: boolean; diffs: Record<string, number>; source: string } | null  // vs CFTC text report financial_lf.htm
  signals: Signal[]
}

// GET /api/derivatives/aggregate   (cache 30 s; live snapshot of 8 perpetuals, daily history datasets)
type ExchangeId = 'binance'|'bybit'|'okx'
interface AggContract { symbol: string; kind: 'USDT'|'USDC'|'COIN-M'; oi_btc: number; oi_usd: number /* ONE side */; funding_8h: number /* % per 8h */
                        interval_h: number; mark: number; oi_usd_both_sides: N /* Bybit API openInterest (both sides) */ }
interface AggExchange { id: ExchangeId; name: string; ok: boolean; error: string|null; oi_btc: N; oi_usd: N; funding_8h: N /* OI-weighted */
                        share_pct: N; long_pct: N /* % accounts long */; long_pct_time: T|null; contracts: AggContract[] }
interface AggregateData {
  time: T; exchanges: AggExchange[]
  total: { oi_btc: N; oi_usd: N; funding_8h: N /* OI-weighted */; funding_annual: N; funding_simple_avg: N; exchanges_ok: number
           change_7d_pct: N; binance_usdt_share_pct: N }
  crosscheck: { rows: { exchange: ExchangeId; symbol: string; ours_usd: number; coingecko_usd: N; diff_pct: N /* Bybit vs both sides */; both_sides: boolean }[]
                global_perp_oi_usd: N /* CoinGecko BTC perps, Bybit corrected to one side */; coverage_pct: N; source_time: T|null; contracts_global: N }
  history: { oi_btc: Partial<Record<ExchangeId|'total', Pt[]>> /* daily BTC; total only on days with all 3 */
             starts: Partial<Record<ExchangeId|'total', T|null>>
             funding: Partial<Record<ExchangeId|'weighted', Pt[]>> /* daily mean %/8h */; long_pct: Partial<Record<ExchangeId, Pt[]>> }
  intraday: { since: T|null; total_oi_btc: Pt[]; funding_weighted: Pt[] }   // 5-min snapshots collected by the app (dataset lev_snap)
  signals: Signal[]; excluded: string[]
}
```

**Liquidations (backward compatible additions)** — `GET /api/liquidations?range=…` keeps every field and adds:
```ts
type LiqExchange = 'binance'|'bybit'|'okx'
events: { time: T; side: 'long'|'short'; price: number; usd: number; qty?: number /* BTC */; exchange?: LiqExchange; symbol?: string }[]  // max 300
totals: { …existing…, all_since?: T|null /* all 3 exchanges collecting */,
          by_exchange?: Partial<Record<LiqExchange, { name: string; long_24h: number; short_24h: number; long_7d: number; short_7d: number; count_24h: number
                                                     symbols: string[]; note: string; connected: boolean; last_event: T|null; collecting_since: T|null }>> }
coverage?: { exchanges: { id: LiqExchange; name: string; included: boolean; oi_usd: N; oi_btc: N; share_pct: N; factor: N /* all perps ÷ USDT contract */
                          series_since: T|null; resolution: '15m'|'1h→15m' }[]
             included_oi_usd: N; share_of_three_pct: N; previous_binance_usdt_share_pct: N; share_of_global_pct: N
             assumptions: { leverage: { lev: number; weight: number /* % */ }[]; mmr_pct: number; long_share: string } } | null
validation?: { status: 'ok'|'preliminary'|'insufficient'; hours: number; events: number; from: T|null; to: T|null; exchanges: LiqExchange[]
               spearman: N /* hourly model-predicted vs real liquidated USD */; peak_hit_pct: N; peak_hours: number; baseline_pct: 25
               price_hit_pct: N; price_expected_pct: N; price_lift: N; price_events: number } | null
```
Heatmap model: one allocation per exchange (Binance `oi_15m`, Bybit `oi15_bybit` one-sided 15 m, OKX `oi15_okx` 15 m / 1 h interpolated), ΔOI scaled by
`coverage.exchanges[].factor`; `model()` keeps the same keys (`df`, `birth`, `death`, `liq`, `is_long`, `lev`) but `amount0` is now (E, L) and `log_scale` (E, n).

**WebSocket** `{"type":"liquidation", time, side, price, qty, usd, exchange, symbol}` — `exchange`/`symbol` added (Binance BTCUSDT from the hub;
Binance BTCUSDC/BTCUSD_PERP, Bybit BTCUSDT/BTCPERP/BTCUSD, OKX BTC-USDT-SWAP/BTC-USD-SWAP from `app/liq_collectors.py`). `store.liquidations()`
returns `exchange`/`symbol` columns (old rows → binance/BTCUSDT) and de-duplicates identical events. `GET /api/status` adds
`liquidation_streams: Record<LiqExchange, {connected, events, last_event}> | null`.

New persistent datasets (store.register): `basis_coinm_1d`, `basis_usdm_1d`, `basis_deribit_snap`, `cot_cme`, `lev_bybit_1d`, `lev_okx_1d`,
`lev_binance_1d`, `lev_snap` (5 min), `oi15_bybit`, `oi15_okx`, `lev_cg`. `BTC_DATA_DIR` env overrides the data folder (isolated test instances).
Frontend: `src/api/derivPro.ts` (hooks `useBasis`/`useCme`/`useAggregate`), `src/widgets/derivPro.tsx` (`BasisTab`, `CmeTab`, `LeverageTab`,
`ExchangeBadge`), Posizionamento, scheda Derivati: `?view=basis|cme|leva`. Realtime keys: "/derivatives/basis" → ['deriv-basis'], "/derivatives/cme" → ['deriv-cme'],
"/derivatives/aggregate" → ['deriv-agg'] (also refreshed by "/derivatives").

## VWAP (router: vwap.py, engine: app/analysis/vwap.py, agent: vwap)

VWAP ancorati al calendario UTC. Formula (validata replicando al centesimo i 24 valori di uno screenshot Kraken PF_XBTUSD):
tp = (H+L+C)/3 su candele CHIUSE dall'ancora; VWAP = Σ(tp·v)/Σv; σ = sqrt(Σ(v·tp²)/Σv − VWAP²) (pesata per volume); bande VWAP ± kσ.
Ancore: lunedì 00:00 · giorno 1 del mese · 1 gen/apr/lug/ott · 1 gennaio. Livelli p* = valori finali del periodo completo precedente.
Dataset (candele 1m dal 1° gennaio dell'anno precedente, bootstrap a tranche da 25 s, poi incrementale):
`vwap_kraken_hist` / `vwap_binance_hist` (fino alle 00:00 UTC di oggi, TTL 1 h) + `vwap_kraken_live` / `vwap_binance_live` (da ieri 00:00, TTL 45 s).
Le richieste HTTP non scaricano mai: aggiorna l'agente `vwap` (4 s dopo ogni minuto chiuso → WS invalidate `"/vwap"`) e il refresher generale.
WS: `{"type":"vwap_tick","source":"kraken",time,price,high,low}` ≤2/s dai trade Kraken Futures (Binance: si usa `perp_kline` 1m).
Avvisi personali: livelli nominati `vwap_{w|m|q|y}`, `vwap_{w|m|q|y}_up1|_dn1`, `vwap_p{w|m|q|y}` (Kraken, calcolo 1m).

```ts
type N = number | null
type VwapSource = 'kraken' | 'binance'          // Kraken Futures PF_XBTUSD (USD, default) | Binance USDⓈ-M BTCUSDT (USDT)
type VwapCalc = 'fine' | 'chart'                // candele 1m (default) | candele del timeframe del grafico (W 5m · M 30m · Q 1h · Y 4h)
type VwapPeriod = 'w' | 'm' | 'q' | 'y'
interface VwapStatus { ready: boolean; progress: number /* 0..1 minuti presenti / attesi */; first: T|null; last: T|null /* inizio ultima 1m chiusa */
                       last_closed_end: T|null; rows: number; missing_min: number; big_gaps: number /* buchi > 30 min */; history_start: T }
interface VwapLevels { id: VwapPeriod; tf: number /* s */; anchor: T; prev_anchor: T; prev_end: T
                       vwap: N; sd: N; up1: N; dn1: N; up2: N; dn2: N; prev: { vwap: N; sd: N; up1: N; dn1: N }; rows: number; prev_rows: number }
type VwapSix = [N, N, N, N, N, N]               // [vwap, +1σ, −1σ, prev vwap, prev +1σ, prev −1σ]

// GET /api/vwap?source=kraken|binance&calc=fine|chart
interface VwapSummary {
  source: VwapSource; calc: VwapCalc; periods: VwapPeriod[]; tf: Record<VwapPeriod, number>
  sources: Record<VwapSource, { ready: boolean; progress: number }>
  status: VwapStatus
  periods_data: Record<VwapPeriod, VwapLevels & { dist_pct: N; z: N /* (prezzo−vwap)/σ */; prev_dist_pct: N }> | null   // null finché lo storico non è completo
  price?: number; price_time?: T; price_live?: boolean; close?: number; time?: T
  confluence?: { low: number; high: number; mid: number; width_pct: number; n: number; members: string[] /* 'w_vwap' | 'pm_up1' … */; distance_pct: N }[]
  confluence_pct?: number                        // 0.5: ampiezza massima di un gruppo; servono ≥2 serie diverse; ancore coincidenti (M=Q a ottobre) non contano
  resolution_check?: Record<VwapPeriod, { diff_bp: VwapSix; tf: number }>     // altra modalità di calcolo vs questa (punti base)
  crosscheck?: { other: VwapSource; price_basis_bp_24h: N; periods: Record<VwapPeriod, { other: VwapSix; diff_bp: VwapSix }> } | null
}

// GET /api/vwap/panel?p=w|m|q|y&source=…&calc=…   (array colonnari allineati a candles.t; null prima dell'ancora)
interface VwapPanel {
  id: VwapPeriod; source: VwapSource; calc: VwapCalc; tf: number; status: VwapStatus
  anchor: T; prev_anchor: T; prev_end: T; last_closed_end: T; forming: boolean   // ultima candela in formazione (solo minuti chiusi)
  candles: { t: T[]; o: number[]; h: number[]; l: number[]; c: number[] } | null  // dal prev_anchor a ora, timeframe del pannello
  lines: { vwap: N[]; up1: N[]; dn1: N[]          // periodo corrente, valore cumulativo a fine candela (±2σ derivate nel frontend)
           pvwap: N[]; pup1: N[]; pdn1: N[] }     // periodo precedente: crescente nel suo periodo, poi piatto (livello esteso)
  levels: VwapLevels
}
```

### VWAP — grafico unico e volume profile per sessione
Scheda `/grafici?tab=vwap`: `?view=` assente = "Grafico unico" (default), `?view=panels` = griglia 2×2.
Volume profile: il volume di ogni candela 1m è distribuito uniformemente tra low e high (calcolo esatto con somme cumulative);
bin = valore tondo più vicino a prezzo·0,06% (settimana, $50 a 83k) o prezzo·0,12% (mese, $100). POC = bin a volume massimo
(prezzo = centro del bin). Value area 70%: dal POC si aggiunge ogni volta il bin adiacente con più volume (a parità, quello sopra).
VAH/VAL del profilo ≠ VAH/VAL VWAP del grafico unico (= VWAP ±1σ). Robustezza = max |Δ| (bp) di POC/VAH/VAL con bin ×½ e ×2.
Avvisi personali: livelli `vp_pw_poc`, `vp_pw_vah`, `vp_pw_val` (settimana precedente completa, Kraken).

```ts
// GET /api/vwap/overview?source=kraken|binance&calc=fine|chart&tf=30m|1h|2h|4h&profile=week|month|off
type VwapOverviewTf = '30m' | '1h' | '2h' | '4h'
type VwapProfileMode = 'week' | 'month' | 'off'
interface VwapProfileSession {
  start: T; end: T; complete: boolean                 // sessione UTC (lunedì 00:00 / giorno 1)
  bin: number; lo: number; vols: number[]             // volume (BTC) per bin [lo + i·bin, lo + (i+1)·bin)
  volume: number; poc: number; vah: number; val: number
  va_bins: [number, number]; poc_bin: number
  robust_bp: { poc: number; vah: number; val: number }
}
interface VwapOverview {
  source: VwapSource; calc: VwapCalc; tf: VwapOverviewTf; step: number /* s */; status: VwapStatus
  from: T /* inizio del mese di (ora − 35 g) */; last_closed_end: T; forming: boolean
  candles: { t: T[]; o: number[]; h: number[]; l: number[]; c: number[] } | null
  lines: Record<VwapPeriod, { vwap: N[]; up1: N[]; dn1: N[] }>   // periodo corrente dall'ancora, allineate a candles.t
  levels: Record<VwapPeriod, VwapLevels>                        // livelli correnti e prev (estesi orizzontalmente nel frontend)
  profile: { mode: VwapProfileMode; va_pct: 70; sessions: VwapProfileSession[] }
}
```

## SUPERCHART (router: superchart.py, engines: app/analysis/superchart.py + anomalies.py, layouts: app/superchart_layouts.py, agent: anomalies, tests: backend/tests/test_superchart.py)

Vista sincronizzata di serie GIÀ presenti nell'app (nessuna fonte nuova). Griglia = candele del timeframe:
`15m` Binance USDⓈ-M (candele 1m del modulo VWAP dal 1° gennaio dell'anno precedente + `fut_15m`), `1h/4h/1d/1w` Binance spot `k_*` (candela in formazione col prezzo live).
Allineamento point-in-time, senza interpolazione: ogni osservazione nativa ha `avail = time + lag` (fine del periodo + ritardo di pubblicazione);
la candela i mostra il valore noto a `close_i = apertura + tf` (in formazione: adesso). `last` (livelli) = ultimo valore disponibile ripetuto entro `stale`;
`mean` (tassi) = media dei valori disponibili nella candela, oppure `last` se la serie è più lenta del timeframe; `sum` (flussi) = somma nella candela in cui
diventano disponibili, mai ripetuti. Ritardi: CoinMetrics (riserve, netflow, MVRV, NUPL) 2 g dall'inizio del giorno osservato; Farside ETF 1,5 g;
BGeometrics STH/LTH 8 g (piano gratuito: 7 g di ritardo); macro Yahoo, stablecoin DefiLlama, USDT.D, premio/basis giornalieri 1 g; Fear & Greed 0 (00:00 UTC);
OI/long-short = istantanea a fine periodo. Replay (`asof`): solo candele chiuse entro asof e solo osservazioni con avail ≤ asof → identico allo storico completo
troncato (test). Unica componente non causale dichiarata: il fattore di calibrazione CoinGecko della USDT dominance (costante applicata a tutto lo storico).

Anomalie: z robusto = (y − mediana) / max(IQR/1.349, ½σ), mediana e scala sui `window` valori PRECEDENTI (il punto corrente è escluso);
`window` = 90 osservazioni (giornaliere), 52 (settimanali), ~30 giorni (intraday, 30…1000). y = livello | variazione log % | differenza | log | log1p |
sbilanciamento taker delta/volume (CVD). Serie più fini del grafico: anomalie al timeframe del grafico; candela in formazione esclusa. Episodi dello stesso segno
entro 7 g (giornaliere; 3 osservazioni native / 6 candele sul grafico) = un solo evento.

```ts
type ScTf = '15m' | '1h' | '4h' | '1d' | '1w'
// GET /api/superchart/catalog
interface ScCatalog {
  indicators: { id: string; group: 'price'|'derivatives'|'flows'|'onchain'|'macro'; cols: string[]; place: 'pane'|'overlay'
                anom: boolean; anom_how: 'level'|'pct'|'diff'|'log'|'log1p'|null; unit: 'usd'|'btc'|'idx'|'pct'|'pct_8h'|'ratio'|'musd'|'busd'
                source: string /* codice: binance_spot, agg3, farside, coinmetrics… */; res: number /* s, 0 = candele/eventi */; lag: number /* s oltre la fine del periodo */
                na_tf: ScTf[]; cum: string[] /* colonne cumulate nella finestra (CVD) */ }[]
  presets: { id: 'essential'|'derivatives'|'onchain'|'macro'; tf: ScTf; log: boolean; panes: ScPaneState[] }[]
  tfs: ScTf[]; default_bars: Record<ScTf, number>; max_bars: number /* 120000 */
}
// id: vwap(w,m,q,y overlay) volume(v) rsi(rsi) macd(macd,signal,hist) funding_binance(f) funding_agg(f) oi_binance(oi) oi_agg(oi) ls_ratio(r)
//     liquidations(long,short) cvd_spot(d) cvd_perp(d) cb_premium(p) basis(b) etf_flows(f) exch_reserve(r) exch_netflow(n) mvrv(mvrv) nupl(nupl)
//     sopr_sth(sopr) mvrv_holders(sth,lth) fng(v) usdt_dom(d) stables(s, B$) dxy(c) spx(c) gold(c)

// GET /api/superchart/series?tf=1h&ids=a,b&bars=20000&to=<T>&asof=<T>&z=3&candles=1   (≤16 ids; risposta JSON compatta, gzip)
interface ScData {
  tf: ScTf; step: number; source: 'binance_spot'|'binance_usdm'; asof: T|null; now: T; thr: number
  window: { i0: number; i1: number; total: number; first: T|null; last: T|null }   // finestra = ultime `bars` candele con apertura ≤ to
  t: T[]; close_t: T[]                                                           // apertura delle candele · close dell'ultima
  candles?: { o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }
  series: Record<string, { cols: Record<string, (number|null)[]>                 // allineate a t (CVD cumulato da inizio finestra)
                           obs?: (T|null)[]                                      // tempo dell'osservazione mostrata su ogni candela (serie `last`/`mean` lente)
                           first: T|null; last: T|null                           // prima/ultima osservazione nativa
                           anomalies: [number /* indice in t */, number /* z */, number|null /* valore */, number|null /* y */, number|null /* mediana di y */, T /* osservazione */][]
                           ms: number }>
  errors: Record<string, 'unavailable'>; ms: number
}
// GET/POST /api/superchart/layouts · PUT/DELETE /api/superchart/layouts/{id}   (USER_DATA_DIR/superchart_layouts.json, store.write_text)
interface ScPaneState { id: string; h: number /* 60..600 px, 0 se sovrapposto */; an: boolean /* anomalie */; ov: boolean /* sul prezzo */ }
interface ScLayout { id: string; name: string /* 1..60 */; state: { tf: ScTf; log: boolean; panes: ScPaneState[] /* ≤12 */ }; created_at: T; updated_at: T }
// POST body {name, state} → ScLayout · PUT body {name?, state?} → ScLayout · DELETE → {ok:true} · 400 stato non valido · 404

// GET /api/anomalies?z=3   (cache 30 min per soglia; giorni completi e pubblicati)
type AnVerdict = 'strong' /* p BH < 0.05 */ | 'weak' /* p < 0.05 */ | 'none' | 'anecdotal' /* n < 8 */
interface AnMetric { mean: N; median: N; ci: [N, N] /* IC 95% bootstrap */; base: N /* media dei giorni casuali */; diff: N; p: N /* Monte Carlo 4000 */; p_bh: N; up: N; verdict: AnVerdict }
interface Anomalies {
  params: { thr: number; window: 90; gap_days: 7; horizons: [1, 3, 7]; min_n: 8; n_mc: 4000; n_boot: 2000; tests: number; recent_days: 30 }
  types: { id: string /* funding_up|funding_dn|oi_up|oi_dn|liq_long_up|liq_short_up|volume_up|etf_up|etf_dn|exchange_up|exchange_dn */
           type: 'funding'|'oi'|'liq_long'|'liq_short'|'volume'|'etf'|'exchange'; sign: 1|-1; unit: string; available: boolean; lag_s: number
           sample_from: T|null; sample_to: T|null; n_events: number; last_event: T|null; n: number
           horizons: { h: number; n: number; ret: AnMetric /* rendimento % */; vol: AnMetric /* |rendimento| % */ }[]
           verdict: AnVerdict; headline: { h: number; metric: 'ret'|'vol' } | null }[]
  recent: { type: string; sign: 1|-1; id: string; time: T; avail: T; value: number; x: number /* valore trasformato */; how: string; z: number; unit: string }[]
  generated_at: T; compute_ms: number
}
```
Tipi del backtest (serie giornaliere): funding Binance (media del giorno, livello), OI Bybit USDT (variazione %), liquidazioni long/short reali (log1p, raccolta live),
volume spot Binance (log), flussi ETF Farside (livello, ultima seduta provvisoria esclusa), netflow exchange CoinMetrics (livello, dal 2015). Ingresso alla chiusura
del primo giorno in cui il dato è pubblicato; base = tutti i giorni misurabili dello stesso periodo con lo stesso ritardo; BH su tipi × segni × orizzonti × metriche.
Agente `anomalies` (Radar, 30 min): `anomalies.<tipo>` per ogni anomalia nuova con il backtest a 7 g del suo tipo (al primo giro solo quelle pubblicate da < 2 g);
invalida `/anomalies` e `/superchart/series` → query `['anomalies', …]`, `['superchart', …]`. Tono sempre neutro (descrittivo).

## ORDER BOOK (router: orderbook.py, collector: app/ob_collector.py, logica: app/analysis/orderbook_core.py, agent: orderflow, tests: backend/tests/test_orderbook.py)

Collector in-process (thread `orderbook` con event loop proprio, avviato da `live.start()`), mercati da env `ORDERBOOK_MARKETS` (default `futures,spot`):
`futures` = Binance USDⓈ-M BTCUSDT (`wss://fstream.binance.com/public/ws/btcusdt@depth@100ms`, `/market/ws/btcusdt@aggTrade`, snapshot `fapi/v1/depth` limit 1000),
`spot` = Binance BTCUSDT (`stream.binance.com:9443/ws/...`, snapshot `api/v3/depth` limit 5000). Book locale secondo la procedura ufficiale
(futures: scarta u < lastUpdateId, primo evento U ≤ L ≤ u, poi `pu` = u precedente; spot: scarta u ≤ L, primo U ≤ L+1 ≤ u, poi U = u+1), risincronizzazione
automatica a ogni buco. Verifica: ogni 120 s (futures) / 300 s (spot) book "ombra" da nuovo snapshot portato allo STESSO update id e confrontato livello per
livello nella zona già coperta da snapshot (atteso 0) + zona nuova (ricostruita solo dal diff stream: livelli mai aggiornati mancanti, riparati dallo snapshot).
Footprint vs kline 1m REST ogni 300 s (minuti completi: |Δvolume| atteso < 0,5%). Buchi negli id aggTrade (disconnessioni, riavvii < 15 min) recuperati via REST.
Campioni: ogni 1 s bucket da $10 entro ±1,5% dal mid; medie al minuto; footprint 1m × bin $5. Storage `DATA_DIR/orderbook/<market>/`
(hs/hsm orari "solo variazioni" 7 g · hm medie al minuto 30 g · fp/fk/ev 30 g), sempre via `store.write_parquet` / `write_text`.
Muro = bucket ≥ 5× mediana dei bucket entro ±1% e ≥ 2 BTC (perp) / 1 BTC (spot) per ≥ 20 s; `pulled` = sceso < 30% del massimo con prezzo entro 0,15% senza
scambi corrispondenti; `consumed` = scambi ≥ 50% della liquidità sparita o prezzo sul livello. Imbalance footprint: buy[p] ≥ 3×sell[p−bin] (1), sell[p] ≥ 3×buy[p+bin] (2),
lato opposto 0 ammesso se ≥ 1% del volume candela; `stacked` ≥ 3 livelli consecutivi. Debug (solo `ORDERBOOK_DEBUG=1`): `POST /api/orderbook/debug/{gap|depth|trades|flush}`.

```ts
type N = number | null
type ObMarket = 'futures' | 'spot'
interface ObEvent { t: number; kind: 'pulled' | 'consumed' | 'appeared'; side: 'bid' | 'ask'; price: number /* bucket [price, price+10) */
                    qmax: number; q: number /* BTC */; age_s: number; dist_pct: number; executed?: N }
interface ObWall { price: number; side: 'bid' | 'ask'; q: number; qmax: number; age_s: number; dist_pct: number }

// GET /api/orderbook/heatmap?market&from&to&bucket=10|20|50|100|250&range=0.1..1.5&cols≤3000   (≤ 6 h: campioni 1 s, oltre: medie al minuto; max 7 g)
// q = base64 di uint16 LE, matrice cols × rows (tempo-maggiore, riga 0 = prezzo più basso): 0 = nessun dato, v = (code−1)·scale BTC.
// bucket alzato automaticamente se rows > 900; celle ≤ 2,4 M. Il frontend lo chiede senza ?lang (dati numerici).
interface ObHeatmap { market: ObMarket; from: number; to: number; tier: 's' | 'm'; dt: number; range_pct: number; bucket: number
  cols: number; rows: number; price_lo: N; q: string; scale: number; empty?: boolean; pct?: Record<'p50'|'p90'|'p95'|'p98'|'p99'|'p99.5', number>
  t: number[]; mid: N[]; last: N[]; hi: N[]; lo: N[]; vb: N[]; vs: N[] /* BTC aggressivi */; vwap: N[]; bb: N[]; ba: N[]
  imb: N[] /* quota bid entro ±0,5% */; tlo: N[]; thi: N[] /* zona coperta da snapshot */
  gaps: [number, number][]; events: ObEvent[]; walls: ObWall[]; collection_start: N
  wall_rule: { k: number; min_qty: number; min_age_s: number; near_pct: number; median: N; threshold: N } }

// GET /api/orderbook/footprint?market&tf=1m|5m|15m|1h&from&to&bin=5|10|25|50|100&limit≤300   (array colonnari; livelli candela i = off[i]..off[i]+cnt[i])
interface ObFootprint { market: ObMarket; tf: string; bin: number; from: number; to: number; ratio: 3; min_share: 0.01; collection_start: N; empty?: boolean
  candles: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; buy: number[]; sell: number[]; delta: number[]; cvd: number[]
             poc: N[]; n: number[] /* trade aggregati */; ok: boolean[] /* tutti i minuti raccolti completi */; off: number[]; cnt: number[] }
  levels: { p: number[]; buy: number[]; sell: number[]; imb: number[] /* bit 1 = buy, 2 = sell */ }
  stacked: { side: 'buy' | 'sell'; from: number; to: number; n: number; i: number }[] }

// GET /api/orderbook/signals?market   (anche per l'agente)
interface ObSignals { market: ObMarket; time: number; synced: boolean; mid: N; walls: ObWall[] /* entro ±1% */; events: ObEvent[] /* 30 min, pulled|consumed */
  wall_rule: { k: number; min_qty: number; median: N; threshold: N; window_pct: number }
  imbalance?: { mean: number; share_bid: number; share_ask: number; now: number; minutes: number; persistent: 'bid' | 'ask' | null }
  cvd?: { minutes: number; price_change_pct: number; cvd: number; volume: number; cvd_share: N; divergence: 'price_up_cvd_down' | 'price_down_cvd_up' | null } }

// GET /api/orderbook/status
interface ObStatus { time: number; enabled: ObMarket[]; cpu: { collector_pct: number; flush_pct: number; window_s: number }; rss_mb: N
  config: { range_pct; sample_s; base_bucket; fp_base_bin; buckets; fp_bins; retention_days: { hs; hm; fp }; imb_ratio; imb_min_share; debug }
  markets: Record<ObMarket, { depth_connected; trade_connected; synced: boolean; last_update_id: N; levels: { bids; asks }; best_bid; best_ask; mid; last_sample
    trusted: [N, N]; trusted_pct: [N, N]; msgs: { depth; trades }; snapshots; disconnects: { depth; trades }; book_gaps
    resyncs: { n; last: { t; reason: 'connect' | 'gap' }[] }
    verify: { n; ok; top_mismatch; range_mismatch; levels_compared; diff_only_levels; new_zone_levels; new_zone_mismatch; every_s; last }
    kline_check: { n; median_abs; p95_abs; max_abs; within_05 /* quota 0..1 */; buy: {…}; last: { t; ours; official; diff_pct; buy_diff_pct }[]; every_s }
    backfills: { t; from; to; n; ok; fetched }[]; incomplete_minutes; collection_start: N; sessions: [number, number][]; coverage: [number, number][]
    storage: { total_mb; mb_per_day: N; hs_mb_per_day: N; other_mb_per_day: N; hours_measured; files; by_kind_mb }; mem_est_mb; flush_ms_p50 }> }
```
WS dedicato `/api/ws/orderbook?market&bucket&range&tf&bin` (parametri modificabili inviando lo stesso JSON), ≤ 3 msg/s:
`{"type":"ob_live", market, time, status:{synced,depth,trades}, cols?:[{t, mid, bb, ba, last, hi, lo, vb, vs, vwap, imb, tlo, thi, plo, q:number[]}],
fp?:{t, tf, bin, o,h,l,c, buy, sell, delta, poc, n, ok, p[], lbuy[], lsell[], imb[], stacked[]} (≤ 2/s, candela in formazione), events?: ObEvent[]}`.
Agente `orderbook` (Grid3x3, 30 s, solo perp): `orderbook.walls` (muri più vicini cambiati), `orderbook.pulled` (ritiro ≥ 2× soglia), `orderbook.imbalance`
(squilibrio persistente), `orderbook.cvd` (divergenza); invalida `/orderbook/status`, `/orderbook/signals` → query `['orderbook', …]`
(heatmap `['ob-heatmap', …]` e footprint `['ob-footprint', …]` si aggiornano solo dal WS + ricarica ogni 5/2 min). Tono sempre neutro.

## TERMINAL (router: terminal.py, collector: app/terminal_collector.py, logica: app/analysis/terminal_core.py, layout: app/terminal_layouts.py, agent: flow, tests: backend/tests/test_terminal.py)

Collector in-process (thread `terminal`, event loop proprio, avviato da `live.start()`; env `TERMINAL_COLLECTOR=off` lo disattiva, `TERMINAL_DEBUG=1`
abilita `POST /api/terminal/debug/{close|flush}?stream=`). Trade pubblici di 7 mercati: `binance_perp` (fstream `/market/stream` aggTrade + ticker 24h +
markPrice@1s), `binance_spot` (aggTrade), `bybit_perp` / `bybit_spot` (v5 publicTrade.BTCUSDT, `S` = lato del taker, `v` in BTC), `okx_perp` / `okx_spot`
(`/ws/v5/business` trades-all, `side` = taker; SWAP `sz` in contratti × ctVal 0,01 BTC letto da `/public/instruments`), `coinbase_spot` (matches: `side` = MAKER
→ aggressore invertito). Trade normalizzato `(ts_ms, prezzo, qty_btc, buy_aggressore, id)`; ogni id già contato è scartato (nessun doppio conteggio).
Recupero: id continui (Binance `a`, OKX tradeId, Coinbase trade_id + heartbeat `last_trade_id`) → REST (aggTrades fromId, history-trades, /trades?after);
Bybit → recent-trade a ogni riconnessione; riavvio < 15 min → si riparte dagli ultimi id salvati insieme alle barre; minuti non recuperati = incompleti.
Barre 1m per stream (vb, vs BTC · qb, qs USD · nb, ns · grandi ≥ $100K lvb, lvs, lnb, lns · o h l c) + delta di gruppo spot/perp/all con estremi intra-minuto
(per le candele del CVD). Kline 1m ufficiali di ogni stream ogni 5 min → verifica volume (atteso < 1%); Binance: anche taker buy e backfill 7 g (CVD storico);
Coinbase: 3 g di candele 1m (premio storico). OI/funding aggregati ogni 30 s (`aggregate.live_snapshot`). Storage `DATA_DIR/terminal/` via `store.write_parquet`
/ `write_text`: tb/tg/tk/tp/to giornalieri (retention 30 g), meta.json, kline_checks.json. Liquidazioni live da `store.LIQ_TAPS` (tap di `add_liquidation`).

```ts
type N = number | null
type StreamKey = 'binance_perp' | 'bybit_perp' | 'okx_perp' | 'binance_spot' | 'coinbase_spot' | 'bybit_spot' | 'okx_spot'
type Group = 'spot' | 'perp' | 'all'
interface TermTicker { last: N; last_ts: N; mark: N; index: N; funding_rate: N /* % periodo Binance */; next_funding: N; high_24h: N; low_24h: N
  vol_24h_btc: N; vol_24h_usd: N; change_24h: N; oi_btc: N; oi_usd: N; oi_chg_1h?: N; f8: N /* % 8 h ponderato OI */; oi_t: N
  premium: N /* % Coinbase BTC-USD vs Binance BTCUSDT */; cb: N; bn: N }
interface FlowW { buy_usd; sell_usd; buy_btc; sell_btc; delta_usd; delta_btc: number; buy_share: N; n_buy; n_sell: number; avg_buy_usd: N; avg_sell_usd: N
  avg_usd: N; large_buy; large_sell; exchanges; perp_delta_usd; spot_delta_usd; perp_usd; spot_usd; win_s; cov_s: number }
interface FeedItem { k: number; s: StreamKey; t: number /* ms */; p: N; u: number; q: number; b: 0 | 1; n: number; a: 0 | 1 /* aggregato < $10K / 250 ms */ }
interface LiqItem { k: number; t: number; side: 'long' | 'short'; price: number; qty: number; usd: number; ex: string; sym?: string }
interface TermDom { market: 'futures' | 'spot'; synced: boolean; step?: number; bb?: number; ba?: number; bids?: [number, number][]; asks?: [number, number][]; t?: number }
interface TermBar { tf; t: number; cvd: Record<Group, [number, number, number]> /* delta, max, min relativi all'apertura */; v: N; vb; vs: number
  oi?: [o, h, l, c]; f8?: N; pm?: N }

// GET /api/terminal/snapshot?tf&dm=futures|spot&ds=0.1|1|5|10|25|50|100
interface TermSnapshot { time; ticker: TermTicker; flow: { w1: FlowW; w5: FlowW; w15: FlowW }; dom: TermDom | null; feed: FeedItem[]; feed_seq: number
  liqs: LiqItem[]; liq_seq: number; est: { price; usd; side; distance }[] /* livelli STIMATI (modello liquidazioni) */; bar: TermBar
  streams: Record<StreamKey, { c: boolean; age: N }>; cfg: { streams; large_usd; feed_min_usd; dom_steps; tfs; okx_ct_val; enabled } }

// GET /api/terminal/series?tf=1m|5m|15m|1h&from&to   (griglia = candele Binance perp REST, ≤ 1500 barre; array colonnari, senza ?lang)
interface TermSeries { tf; from; to: number; t: number[]; o; h; l; c; v: N[]; vb; vs: N[] /* taker aggregati BTC */
  cvd: Record<Group, { o; h; l; c: N[] }> /* cumulato in BTC dall'inizio della finestra */; oi: { o; h; l; c: N[] }; f8: N[]; pm: N[]
  liq: { t; p; u: number[]; s: (0 | 1)[] /* 1 = long */; x: string[] }; cov: Record<StreamKey, { ws_from: N; kline_from?: N }>; multi_from: N
  oi_info: { own_from; snap_from; est_from: N; f8_settled_fill?: boolean }; pm_info: { live_from; kline_from: N; hourly_fallback: boolean }
  collection_start: Partial<Record<StreamKey, number>>; ms: number }
// Fonti OI: campioni 30 s → lev_snap 5 min → stima 15 min (contratti USDT × fattore di scala); funding prima della raccolta = liquidato 8 h su [T−8h, T).
// Minuti Binance senza flusso live o incompleti → kline ufficiali (taker buy). Premio: campioni al secondo → chiusure 1m (tk) → serie oraria (tf 1h).

// GET /api/terminal/status → { time; enabled; cpu; rss_mb; storage: { total_mb; files; by_kind_mb; mb_per_day; retention_days }; flush_ms_p50
//   okx_ct: { ct_val; ccy; ok }; premium_check: { n; median_abs_pp; max_abs_pp; last }; backfill; collection_start
//   streams: Record<StreamKey, { ex; mkt; label; connected; msgs; trades; dupes; reconnects; last_age_s; last_price; latency_ms_p50; incomplete_minutes
//     id_check; recoveries: { n; ok; new; last }; kline_check: { n; median_abs; p95_abs; max_abs; within_1; buy: {…}; last }; first_start; sessions }> }
// GET /api/terminal/signals → { cvd?: { minutes; spot; perp; spot_vol; perp_vol; spot_share; perp_share; price_change_pct
//   divergence: 'spot_buy_perp_sell' | 'spot_sell_perp_buy' | null }; imbalance?: { minutes; buy_share; minutes_buy; persistent: 'buy'|'sell'|null; delta_usd }
//   large: { n; usd; buy_usd; max; threshold: 1e6 }; liq5: { long_usd; short_usd; n; burst: 'long'|'short'|null; threshold: 5e6; max }; streams_live }
// GET|POST /api/terminal/layouts · PUT|DELETE /api/terminal/layouts/{id}   body { name, state }
interface TermLayoutState { tf; tiles: { id: 'dom'|'chart'|'feed'|'flow'|'panes'|'liqs'|'integrity'; w: 3..12; h: 2..12; hidden: boolean }[]
  panes: ('cvd_spot'|'cvd_perp'|'cvd_all'|'oi'|'funding'|'premium')[]; opts: { heat; est; bubbles; vol: boolean } }
```
WS `/api/ws/terminal?tf&dm&ds&dn&hm&hb&hr` (parametri modificabili inviando lo stesso JSON), un messaggio ogni 250 ms (≤ 4/s):
`{"type":"term", time, px, trades?: FeedItem[] (nuovi, ≤ 80), liqs?: LiqItem[], dom?: TermDom (se cambiato), ticker?, flow?, bar?: TermBar, hm?: ObLiveCol[]
(1/s: colonne della heatmap dell'order book Binance perp), streams? (ogni 5 s)}`. Fallback del frontend: GET snapshot ogni 5 s se il socket non è aperto.
Agente `flow` (AudioWaveform, 60 s): `flow.divergence` (CVD spot vs perp di segno opposto, |Δ| ≥ 5% / 3% del volume, 60 min), `flow.imbalance` (15 min:
quota acquisti ≥ 58% o ≤ 42% con ≥ 73% dei minuti concordi), `flow.large` (≥ $1M in 5 min, max ogni 5 min), `flow.liquidations` (≥ $5M di un lato in 5 min),
`flow.context` (risposta a `orderbook.cvd`: contesto multi-exchange, nessun doppione con l'agente orderbook); invalida `/terminal/status`, `/terminal/signals`
→ query `['terminal', …]` (serie `['term-series', tf]` e live dal WS). Tono sempre neutro.


## SCOREBOARD (router: scoreboard.py, engines: app/analysis/scoreboard.py + liq_leverage.py + flows30.py + moves.py, agents: analyst, liquidity, flows, orderflow, tests: backend/tests/test_scoreboard.py)

Testi: `tpl` è un modello italiano con `{segnaposto}`, `vars` contiene numeri già formattati. Il frontend chiama `t(tpl, vars)` (EN in `src/i18n/en/scoreboard.ts`) senza `lang`: nessun numero passa dall'LLM. Query react-query: `['scoreboard']`, `['liquidations','leverage']`, `['flows','30d']`, `['flows','moves']`, `['flows','moves',id]`.

```ts
// GET /api/scoreboard (cache 60 s)
type Cat = 'macro'|'politica'|'struttura'|'flussi'|'posizionamento'|'altro'
type Point = { id: string; cat: Cat; side: 'bull'|'bear'; conf: 1|2|3; tpl: string; vars: Record<string,string>; source: string; time: T|null }
type Rule = { id: string; cat: Cat; label: string; thr: string; source: string; hist: boolean }   // label e thr: chiavi di t()
type Inactive = { id: string; cat: Cat; label: string; reason?: 'fred'|'data'|'coverage' }
type Scoreboard = { time: T; bull: number; bear: number; by_cat: Record<Cat,{bull:number;bear:number}>; cats: Cat[]; points: Point[]
  quiet: Inactive[]          // valutate, dato entro le soglie
  unavailable: Inactive[]    // non valutate, con il motivo
  polymarket: {question:string;p:number;volume:number;slug:string;point:boolean}[]; rules: Rule[]; data_from: T|null; data_to: T|null; errors: Record<string,string> }

// GET /api/scoreboard/backtest (cache 6 h): saldo = (bull − bear) / regole valutabili, solo regole con hist=true e dati con ritardo di pubblicazione
type Backtest = { status: 'ok'|'insufficient'|'unavailable'; from?: T; to?: T; days?: number; rules: string[]; rules_live_only?: string[]; rules_min?: number; rules_max?: number
  current?: number; any_significant?: boolean
  horizons: { horizon: 7|30; days: number; independent: number; ic: number; ic_lo: number; ic_hi: number; significant: boolean; base_mean: number; base_up_pct: number
    groups: {group:'low'|'mid'|'high'; days:number; balance_min:number; balance_max:number; mean:number; median:number; up_pct:number}[] }[] }

// GET /api/liquidations/leverage (cache 30 s). Vettori di 3: [5–25×, 50×, 100×]
type LevWindow = { window:'1d'|'7d'; time:T; price:number; step:number; from:number; to:number; bands:{p:number;long:number[];short:number[]}[]
  short_above:number; long_below:number; total:number; outside:number   // somma barre + outside = total
  by_group:{long:number[];short:number[]}; clusters:{long:Cluster[];short:Cluster[]}; near:{span:number;long:number;short:number} }
type Cluster = { lo:number; hi:number; usd:number }
type LevMap = { windows:{'1d':LevWindow;'7d':LevWindow}; validation: /* liquidations.validate() */ object|null
  side_check:{hours:number;days:number;model_long:number|null;model_short:number|null;real_long:number|null;real_short:number|null}|null
  coverage:object|null; groups:{id:string;leverage:number[]}[]; weights:{lev:number;pct:number}[]; mmr_pct:number }

// GET /api/flows/30d (cache 60 s): 30 giorni UTC chiusi, oggi escluso. Vettori allineati a `days`
type Flows30 = { days:T[]; from:T; to:T; today_excluded:T; candles:{open:N[];high:N[];low:N[];close:N[]}; etf:N[]; usdt:N[]; usdc:N[]; exchange:N[]
  cvd_perp:N[]; cvd_spot:N[]; oi_usd:N[]; oi_btc:N[]; liq_long:N[]; liq_short:N[]; summary: object; missing:{etf:number;exchange:number;oi:number} }   // N = number|null

// GET /api/flows/moves (cache 60 s), GET /api/flows/moves/{id} (aggiunge `series`, 404 se non più in lista)
type Move = { id:T; from:T; to:T; dir:1|-1; p0:number; p1:number; ret_pct:number; z:number; minutes:number; tags:string[]
  stats:{spot_usd:N;perp_usd:N;oi_btc:N;oi_pct:N;liq_long:number;liq_short:number;liq_status:'full'|'partial'|'none';liq_cov:number;cvd_scope:'binance'|'multi';oi_res:30|300|900|0;high:N;low:N
    after:{ret_pct:number;hours:number;oi_btc:N}|null}|null }
type Moves = { events:Move[]; time:T; scanned_from:T|null; scanned_to:T|null; rule:{k:number;min_pct:number;base_bars:number;ret_bars:number;bar_min:number;oi_move_pct:number;spot_share:number} }
// tags: short_squeeze new_longs long_flush new_shorts spot_buying spot_selling perp_led spot_against liq_shorts liq_longs no_reading
```

Dataset aggiunti: `fred_bamlh0a0hym2`, `fred_sofr`, `fred_iorb`, `fred_wresbal`, `fred_rrpontsyd`, `fred_wtregen`, `fred_dfii10`, `fred_dgs10`, `fred_effr` (solo con `FRED_API_KEY`), `sb_nq`, `sb_brent`, `sb_strc`, `usdc_supply`. Agenti: `analyst` (finding del tabellone, tono neutro, non pesa nel consenso), `liquidity` (mappa 7 giorni), `flows` (riepilogo 30 giorni), `orderflow` parte `moves` (topic `flow.move`, avviso informativo una volta per movimento finito da meno di 2 ore). `analyst` invalida anche `/scoreboard`.
