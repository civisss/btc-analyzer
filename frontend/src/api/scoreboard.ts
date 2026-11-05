// Tabellone Bull vs Bear, mappa per leva, flussi a 30 giorni, movimenti: tipi (CONTRACT.md § SCOREBOARD) e hook react-query.
// fetch con un oggetto URL: la patch globale non aggiunge ?lang=en, così `tpl` resta la chiave italiana di t() e i numeri stanno in `vars`.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError } from './client'

export type Side = 'bull' | 'bear'
export type Cat = 'macro' | 'politica' | 'struttura' | 'flussi' | 'posizionamento' | 'altro'

export interface SbPoint { id: string; cat: Cat; side: Side; conf: 1 | 2 | 3; tpl: string; vars: Record<string, string>; source: string; time: number | null }
export interface SbRule { id: string; cat: Cat; label: string; thr: string; source: string; hist: boolean }
export interface SbInactive { id: string; cat: Cat; label: string; reason?: 'fred' | 'data' | 'coverage' }
export interface Scoreboard {
  time: number; bull: number; bear: number; by_cat: Record<Cat, { bull: number; bear: number }>; cats: Cat[]
  points: SbPoint[]; quiet: SbInactive[]; unavailable: SbInactive[]; rules: SbRule[]
  polymarket: { question: string; p: number; volume: number; slug: string; point: boolean }[]
  data_from: number | null; data_to: number | null
}
export interface SbGroup { group: 'low' | 'mid' | 'high'; days: number; balance_min: number; balance_max: number; mean: number; median: number; up_pct: number }
export interface SbHorizon { horizon: number; days: number; independent: number; ic: number; ic_lo: number; ic_hi: number; base_mean: number; base_up_pct: number; groups: SbGroup[]; significant: boolean }
export interface SbBacktest {
  status: 'ok' | 'insufficient' | 'unavailable'; from?: number; to?: number; days?: number; rules: string[]; rules_live_only?: string[]
  rules_min?: number; rules_max?: number; horizons: SbHorizon[]; current?: number; any_significant?: boolean
}

export interface LevBand { p: number; long: [number, number, number]; short: [number, number, number] }
export interface LevCluster { lo: number; hi: number; usd: number }
export interface LevWindow {
  window: '1d' | '7d'; time: number; price: number; step: number; from: number; to: number; bands: LevBand[]
  short_above: number; long_below: number; total: number; outside: number
  by_group: { long: number[]; short: number[] }; clusters: { long: LevCluster[]; short: LevCluster[] }
  near: { span: number; long: number; short: number }
}
export interface LevMap {
  windows: Record<'1d' | '7d', LevWindow>
  validation: { status: 'ok' | 'preliminary' | 'insufficient'; hours: number; events: number; spearman: number | null; peak_hit_pct: number | null; baseline_pct: number; price_hit_pct: number | null; price_expected_pct: number | null; price_lift: number | null } | null
  side_check: { hours: number; days: number; model_long: number | null; model_short: number | null; real_long: number | null; real_short: number | null } | null
  weights: { lev: number; pct: number }[]; mmr_pct: number
}

type NumArr = (number | null)[]
export interface Flows30 {
  days: number[]; from: number; to: number; today_excluded: number
  candles: { open: NumArr; high: NumArr; low: NumArr; close: NumArr }
  etf: NumArr; usdt: NumArr; usdc: NumArr; exchange: NumArr; cvd_perp: NumArr; cvd_spot: NumArr; oi_usd: NumArr; oi_btc: NumArr; liq_long: NumArr; liq_short: NumArr
  summary: {
    price_from: number; price_to: number; price_pct: number; etf_30d: number; etf_7d: number; etf_days: number; etf_last: number | null
    usdt_30d: number; usdc_30d: number; exchange_change: number | null; exchange_last: number | null; exchange_dropped: boolean
    cvd_perp: number; cvd_spot: number; oi_from: number | null; oi_to: number | null; oi_btc_from: number | null; oi_btc_to: number | null
    liq_long: number; liq_short: number; liq_days: number
  }
}

export type MoveTag = 'short_squeeze' | 'new_longs' | 'long_flush' | 'new_shorts' | 'spot_buying' | 'spot_selling' | 'perp_led' | 'spot_against' | 'liq_shorts' | 'liq_longs' | 'no_reading'
export interface MoveStats {
  spot_usd: number | null; perp_usd: number | null; oi_btc: number | null; oi_pct: number | null; liq_long: number; liq_short: number
  liq_status: 'full' | 'partial' | 'none'; liq_cov: number; cvd_scope: 'binance' | 'multi'; oi_res: number; high: number | null; low: number | null
  after: { ret_pct: number; hours: number; oi_btc: number | null } | null
}
export interface Move { id: number; from: number; to: number; dir: 1 | -1; p0: number; p1: number; ret_pct: number; z: number; minutes: number; stats: MoveStats | null; tags: MoveTag[] }
export interface Moves {
  events: Move[]; time: number; scanned_from: number | null; scanned_to: number | null
  rule: { k: number; min_pct: number; base_bars: number; ret_bars: number; bar_min: number; oi_move_pct: number; spot_share: number }
}
export interface MoveDetail extends Move {
  series: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; spot: number[]; perp: number[]; oi: NumArr; liq_long: number[]; liq_short: number[] }
}

async function get<R>(path: string): Promise<R> {
  const res = await fetch(new URL(`/api${path}`, location.origin), { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); if (typeof b?.detail === 'string') detail = b.detail } catch { /* ignore */ }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<R>
}

const live = { refetchInterval: 60_000, retry: 1, placeholderData: keepPreviousData } as const
export const useScoreboard = () => useQuery({ queryKey: ['scoreboard'], queryFn: () => get<Scoreboard>('/scoreboard'), ...live })
export const useSbBacktest = (enabled: boolean) => useQuery({ queryKey: ['scoreboard', 'backtest'], queryFn: () => get<SbBacktest>('/scoreboard/backtest'), enabled, staleTime: 3_600_000, retry: 1 })
export const useLevMap = () => useQuery({ queryKey: ['liquidations', 'leverage'], queryFn: () => get<LevMap>('/liquidations/leverage'), ...live })
export const useFlows30 = () => useQuery({ queryKey: ['flows', '30d'], queryFn: () => get<Flows30>('/flows/30d'), ...live })
export const useMoves = () => useQuery({ queryKey: ['flows', 'moves'], queryFn: () => get<Moves>('/flows/moves'), ...live })
export const useMove = (id: number | null) => useQuery({ queryKey: ['flows', 'moves', id], queryFn: () => get<MoveDetail>(`/flows/moves/${id}`), enabled: id != null, retry: 1, placeholderData: keepPreviousData })
