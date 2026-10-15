import type { ComponentType } from 'react'
import {
  LayoutDashboard, CandlestickChart, Orbit, CalendarClock, Shapes, Flame, Layers, Blocks, CircleDollarSign, Telescope, Sparkles,
  Network, ScanSearch, Globe2, Waypoints, CalendarDays, ShieldCheck, Target, Scale, type LucideProps,
  BellRing, NotebookPen, Anchor,
  MoonStar, Hourglass,
  ChartNoAxesCombined,
  Grid3x3,
} from 'lucide-react'

/** Accent hues (muted, used sparingly: icon badges, section kickers, sparklines). Never for up/down. */
export type Accent = 'btc' | 'blue' | 'violet' | 'teal' | 'amber' | 'slate'
export const ACCENT_HEX: Record<Accent, string> = {
  btc: '#F7931A', blue: '#5B8DEF', violet: '#9B87F5', teal: '#3CC6B0', amber: '#E8B04B', slate: '#8C96AD',
}

/** Labels are Italian source strings: translate at render time with t(). */
export type NavItem = { to: string; label: string; icon: ComponentType<LucideProps>; keywords: string; group: NavGroup }
export type NavGroup = 'Mercato' | 'Cicli e tempo' | 'Flussi e derivati' | 'On-chain e macro' | 'Modelli' | 'Strumenti'
export const NAV_GROUPS: NavGroup[] = ['Mercato', 'Cicli e tempo', 'Flussi e derivati', 'On-chain e macro', 'Modelli', 'Strumenti']
export const GROUP_ACCENT: Record<NavGroup, Accent> = {
  Mercato: 'btc', 'Cicli e tempo': 'violet', 'Flussi e derivati': 'blue', 'On-chain e macro': 'teal', Modelli: 'amber', Strumenti: 'slate',
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, group: 'Mercato', keywords: 'panoramica kpi prezzo market cap overview price' },
  { to: '/grafici', label: 'Grafici', icon: CandlestickChart, group: 'Mercato', keywords: 'candele ema sma bollinger vwap pivot rsi macd fibonacci charts candles' },
  { to: '/superchart', label: 'Superchart', icon: ChartNoAxesCombined, group: 'Mercato', keywords: 'superchart pannelli sincronizzati replay anomalie funding open interest liquidazioni cvd premio coinbase basis etf riserve mvrv nupl sopr fear greed usdt dominance stablecoin dxy s&p oro layout synchronized panes anomalies liquidations reserves gold' },
  { to: '/vwap', label: 'VWAP', icon: Anchor, group: 'Mercato', keywords: 'vwap ancorato settimanale mensile trimestrale annuale bande deviazione standard sigma periodo precedente livelli kraken binance anchored weekly monthly quarterly yearly bands previous period' },
  { to: '/struttura', label: 'Struttura', icon: Waypoints, group: 'Mercato', keywords: 'struttura range lunedì pivot settimanali scenari swing trend structure monday range weekly pivots scenarios' },
  { to: '/insights', label: 'Sintesi', icon: Sparkles, group: 'Mercato', keywords: 'sintesi segnali chat assistente domande insights signals summary' },
  { to: '/cicli', label: 'Cicli', icon: Orbit, group: 'Cicli e tempo', keywords: 'halving bottom top power law rainbow pi cycle mayer cycles clock' },
  { to: '/pivot-temporali', label: 'Pivot temporali', icon: CalendarClock, group: 'Cicli e tempo', keywords: 'pivot date stagionalità mesi inversioni calendario fomc fibonacci tempo seasonality calendar time' },
  { to: '/eventi', label: 'Eventi', icon: CalendarDays, group: 'Cicli e tempo', keywords: 'eventi fomc cpi nfp scadenze opzioni macro calendario events expiries calendar' },
  { to: '/astronomia', label: 'Astronomia e numeri', icon: MoonStar, group: 'Cicli e tempo', keywords: 'astronomia luna piena nuova eclissi luna rossa superluna mercurio retrogrado equinozio solstizio sole macchie solari tempesta geomagnetica kp numeri tondi fibonacci gann quadrato del 9 venerdì 13 numerologia astronomy moon full new eclipse blood moon supermoon mercury retrograde equinox solstice sunspots geomagnetic storm round numbers numerology friday 13th' },
  { to: '/timing', label: 'Timing Gann · Wyckoff', icon: Hourglass, group: 'Cicli e tempo', keywords: 'timing gann wyckoff date chiave conteggi giorni quadrato del 9 angoli 1x1 anniversari accumulazione distribuzione spring utad sos sow lps fasi ritmi pattern pump dump inizio metà fine mese giorno settimana ora scenari key dates day counts square of nine angles anniversaries accumulation distribution phases rhythms seasonality start middle end of month weekday hour scenarios time cycles' },
  { to: '/frattali', label: 'Frattali', icon: Shapes, group: 'Cicli e tempo', keywords: 'pattern analoghi similarità proiezione fractals similarity projection' },
  { to: '/analoghi', label: 'Analoghi', icon: ScanSearch, group: 'Cicli e tempo', keywords: 'analoghi storici confronto perché somiglia periodo spiegazione analogs historical' },
  { to: '/liquidazioni', label: 'Liquidazioni', icon: Flame, group: 'Flussi e derivati', keywords: 'heatmap cluster liquidità magnete liquidations liquidity magnet' },
  { to: '/orderbook', label: 'Order book', icon: Grid3x3, group: 'Flussi e derivati', keywords: 'order book heatmap bookmap liquidità muri bid ask footprint delta cvd poc imbalance trade aggressivi spoofing ritiro liquidity walls aggressive trades depth' },
  { to: '/derivati', label: 'Derivati', icon: Layers, group: 'Flussi e derivati', keywords: 'funding open interest long short basis spot futures flussi derivatives flows' },
  { to: '/posizionamento', label: 'Posizionamento', icon: Target, group: 'Flussi e derivati', keywords: 'posizionamento opzioni max pain put call skew gamma holder balene sentiment funding positioning options whales' },
  { to: '/usdt', label: 'USDT', icon: CircleDollarSign, group: 'Flussi e derivati', keywords: 'dominance stablecoin correlazione correlation' },
  { to: '/onchain', label: 'On-Chain', icon: Blocks, group: 'On-chain e macro', keywords: 'mvrv nupl hashrate indirizzi puell addresses' },
  { to: '/domanda-offerta', label: 'Domanda e offerta', icon: Scale, group: 'On-chain e macro', keywords: 'domanda offerta riserve exchange flussi afflussi deflussi etf spot ibit gbtc farside assorbimento emissione miner wikipedia attenzione retail supply demand reserves inflows outflows absorption attention' },
  { to: '/macro', label: 'Macro e rotazione', icon: Globe2, group: 'On-chain e macro', keywords: 'macro dxy dollaro tassi vix liquidità fed m2 correlazioni s&p nasdaq oro eth/btc dominance altseason rotazione altcoin dollar rates gold rotation' },
  { to: '/previsioni', label: 'Previsioni', icon: Telescope, group: 'Modelli', keywords: 'forecast scenari target backtest scenarios' },
  { to: '/affidabilita', label: 'Affidabilità', icon: ShieldCheck, group: 'Modelli', keywords: 'affidabilità track record accuratezza previsioni verificate backtest hit rate reliability accuracy' },
  { to: '/agenti', label: 'Agenti', icon: Network, group: 'Modelli', keywords: 'agenti autonomi rete messaggi orchestratore agents network messages' },
  { to: '/avvisi', label: 'Avvisi', icon: BellRing, group: 'Strumenti', keywords: 'avvisi personalizzati regole soglie notifiche prezzo rsi funding alert rules thresholds notifications' },
  { to: '/diario', label: 'Diario', icon: NotebookPen, group: 'Strumenti', keywords: 'diario note tesi annotazioni revisione hit rate journal notes thesis annotations review' },
]

export function navFor(pathname: string): NavItem | undefined {
  return NAV.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)))
}
