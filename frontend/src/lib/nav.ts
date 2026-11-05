import type { ComponentType } from 'react'
import {
  LayoutDashboard, CandlestickChart, Orbit, Blocks, Telescope, ScanSearch, Globe2, Waypoints, Target, type LucideProps,
  BellRing, ArrowLeftRight, MonitorDot,
} from 'lucide-react'
import { T } from '../theme/tokens'

/** Named colours of user drawings and tags. Icons do not use them: icons are monochrome, see IconBadge. */
export type Accent = 'btc' | 'blue' | 'violet' | 'teal' | 'amber' | 'slate'
export const ACCENT_HEX: Record<Accent, string> = {
  btc: T.accent, blue: T.steel, violet: T.mauve, teal: T.sand, amber: T.warn, slate: T.fg3,
}

/** Labels are Italian source strings: translate at render time with t(). */
export type NavItem = { to: string; label: string; icon: ComponentType<LucideProps>; keywords: string; group: NavGroup }
export type NavGroup = 'Oggi' | 'Mercato' | 'Contesto' | 'Studio'
export const NAV_GROUPS: NavGroup[] = ['Oggi', 'Mercato', 'Contesto', 'Studio']

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, group: 'Oggi', keywords: 'panoramica kpi prezzo market cap sintesi segnali chat assistente domande overview price insights signals summary' },
  { to: '/terminale', label: 'Terminale', icon: MonitorDot, group: 'Oggi', keywords: 'terminale terminal order flow cvd delta cumulato spot perp aggregato open interest funding premio coinbase liquidazioni bolle heatmap book a scala dom order feed trade grandi trade velo flowx tempo reale order book bookmap liquidità muri bid ask footprint poc imbalance trade aggressivi spoofing ritiro cumulative volume delta premium liquidations ladder real time liquidity walls aggressive trades depth' },
  { to: '/grafici', label: 'Grafici', icon: CandlestickChart, group: 'Oggi', keywords: 'candele ema sma bollinger pivot rsi macd fibonacci charts candles superchart pannelli sincronizzati replay anomalie funding open interest cvd premio coinbase basis etf riserve mvrv nupl sopr fear greed usdt dominance dxy s&p oro layout synchronized panes anomalies reserves gold vwap ancorato settimanale mensile trimestrale annuale bande deviazione standard sigma periodo precedente anchored weekly monthly quarterly yearly bands previous period' },
  { to: '/struttura', label: 'Struttura', icon: Waypoints, group: 'Mercato', keywords: 'struttura range lunedì pivot settimanali scenari swing trend structure monday range weekly pivots scenarios' },
  { to: '/flussi', label: 'Flussi', icon: ArrowLeftRight, group: 'Mercato', keywords: 'flussi spot futures taker etf ibit gbtc farside assorbimento emissione miner stablecoin usdt dominance tether ssr correlazione riserve exchange afflussi deflussi attenzione wikipedia retail domanda offerta flows supply demand reserves inflows outflows absorption attention correlation' },
  { to: '/posizionamento', label: 'Posizionamento', icon: Target, group: 'Mercato', keywords: 'posizionamento derivati funding open interest long short basis cme cot leva aggregata opzioni max pain put call skew gamma holder balene sentiment liquidazioni heatmap cluster liquidità magnete positioning derivatives leverage options whales liquidations liquidity magnet' },
  { to: '/macro', label: 'Macro', icon: Globe2, group: 'Contesto', keywords: 'macro dxy dollaro tassi vix liquidità fed m2 correlazioni s&p nasdaq oro eth/btc dominance altseason rotazione altcoin eventi fomc cpi nfp scadenze opzioni calendario dollar rates gold rotation events expiries calendar' },
  { to: '/onchain', label: 'On-Chain', icon: Blocks, group: 'Contesto', keywords: 'mvrv nupl hashrate indirizzi puell addresses' },
  { to: '/cicli', label: 'Cicli', icon: Orbit, group: 'Contesto', keywords: 'halving bottom top power law rainbow pi cycle mayer cycles clock orologio miner hash ribbons leva' },
  { to: '/analoghi', label: 'Analoghi', icon: ScanSearch, group: 'Studio', keywords: 'analoghi storici confronto perché somiglia periodo spiegazione analogs historical frattali pattern similarità proiezione fractals similarity projection struttura zigzag immagine screenshot usdt dominance pivot temporali date stagionalità mesi inversioni calendario tempo seasonality time' },
  { to: '/previsioni', label: 'Previsioni', icon: Telescope, group: 'Studio', keywords: 'forecast scenari target backtest scenarios percorso 12 mesi affidabilità track record accuratezza previsioni verificate hit rate reliability accuracy' },
  { to: '/avvisi', label: 'Avvisi', icon: BellRing, group: 'Studio', keywords: 'avvisi personalizzati regole soglie notifiche prezzo rsi funding alert rules thresholds notifications' },
]

export function navFor(pathname: string): NavItem | undefined {
  return NAV.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)))
}
