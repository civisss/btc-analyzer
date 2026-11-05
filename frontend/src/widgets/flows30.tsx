/* Flussi a 30 giorni: candele, ETF, stablecoin, BTC sugli exchange, CVD e open interest sugli stessi giorni UTC chiusi. */
import { useMemo } from 'react'
import { CalendarRange } from 'lucide-react'
import { useFlows30, type Flows30 } from '../api/scoreboard'
import { C, lineSeries, usdAxis } from '../components/charts/theme'
import { Card, CardBody, CardHeader, Legend, MethodNote, Q, Skeleton } from '../components/ui'
import { date, usdCompact } from '../lib/format'
import { t } from '../i18n'
import { T } from '../theme/tokens'
import { Stack, candleStyle, flowAxis, tipRow, type Panel } from './stack'

const su = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${usdCompact(Math.abs(v), d)}`)
const signBars = (data: (number | null)[]) => data.map((v) => ({ value: v, itemStyle: { color: (v ?? 0) >= 0 ? T.up : T.down } }))
const kBtc = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) / 1000).toFixed(1)}K`)

function buildPanels(d: Flows30): Panel[] {
  const s = d.summary
  const candles = d.days.map((_, i) => [d.candles.open[i], d.candles.close[i], d.candles.low[i], d.candles.high[i]])
  return [
    { label: t('BTC perp Binance, giornaliero'), height: 200, yFormat: usdAxis,
      chip: t('Da {a} a {b} ({c})', { a: usdAxis(s.price_from), b: usdAxis(s.price_to), c: `${s.price_pct > 0 ? '+' : '−'}${Math.abs(s.price_pct).toFixed(1)}%` }),
      series: [{ type: 'candlestick', name: 'BTC', data: candles, itemStyle: candleStyle, barMaxWidth: 10 }] },
    { label: t('Flusso netto ETF'), height: 104, yFormat: flowAxis, yExtra: { scale: false }, chip: t('ETF {a} in 30 giorni, {b} in 7', { a: su(s.etf_30d), b: su(s.etf_7d) }),
      series: [{ type: 'bar', name: 'ETF', data: signBars(d.etf), barMaxWidth: 12 }] },
    { label: t('Variazione supply stablecoin'), height: 104, yFormat: flowAxis, yExtra: { scale: false }, chip: t('USDT {a}, USDC {b}', { a: su(s.usdt_30d, 1), b: su(s.usdc_30d, 1) }),
      series: [{ type: 'bar', name: 'USDT', data: d.usdt, itemStyle: { color: T.sand }, barMaxWidth: 7, barGap: '10%' }, { type: 'bar', name: 'USDC', data: d.usdc, itemStyle: { color: T.steel }, barMaxWidth: 7 }] },
    { label: t('BTC sugli exchange'), height: 92, yFormat: (v) => `${(v / 1e6).toFixed(3)}M`, chip: t('Exchange {a} BTC', { a: kBtc(s.exchange_change) }),
      series: [lineSeries('BTC', d.exchange, T.mauve, { connectNulls: true })] },
    { label: t('CVD cumulato, Binance'), height: 104, yFormat: flowAxis, chip: t('Perp {a}, spot {b}', { a: su(s.cvd_perp, 1), b: su(s.cvd_spot, 1) }),
      series: [lineSeries('Perp', d.cvd_perp, T.steel), lineSeries('Spot', d.cvd_spot, C.accent)] },
    { label: t('Open interest, Binance + Bybit + OKX'), height: 92, yFormat: (v) => flowAxis(v).replace('+', ''), chip: t('OI da {a} a {b}', { a: usdCompact(s.oi_from, 1), b: usdCompact(s.oi_to, 1) }),
      series: [lineSeries('OI', d.oi_usd, T.wheat, { connectNulls: true })] },
  ]
}

function tip(d: Flows30, i: number): string {
  const ex = d.exchange[i]
  const cl = d.candles.close[i]
  return `<div style="min-width:190px"><div style="margin-bottom:4px">${date(d.days[i])}</div>`
    + tipRow(t('Chiusura'), cl != null ? usdAxis(cl) : '—') + tipRow('ETF', su(d.etf[i])) + tipRow('USDT', su(d.usdt[i])) + tipRow('USDC', su(d.usdc[i]))
    + tipRow(t('BTC sugli exchange'), ex != null ? `${(ex / 1e6).toFixed(3)}M` : '—')
    + tipRow('CVD perp', su(d.cvd_perp[i], 1)) + tipRow('CVD spot', su(d.cvd_spot[i], 1)) + tipRow('OI', usdCompact(d.oi_usd[i], 1)) + '</div>'
}

function Body({ d, updatedAt }: { d: Flows30; updatedAt: number }) {
  const panels = useMemo(() => buildPanels(d), [d])
  const cats = useMemo(() => d.days.map(String), [d])
  const s = d.summary
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader icon={<CalendarRange />} accent="btc" title={t('Flussi, ultimi 30 giorni')} updatedAt={updatedAt}
          subtitle={t('Dal {a} al {b}, giorni UTC chiusi', { a: date(d.from, false), b: date(d.to, false) })}
          right={<Legend items={[{ label: 'USDT', color: T.sand }, { label: 'USDC', color: T.steel }, { label: 'CVD perp', color: T.steel }, { label: 'CVD spot', color: C.accent }]} />} />
        <CardBody className="pt-0">
          <Stack panels={panels} categories={cats} xLabel={(v) => date(Number(v), false)} tooltip={(i) => tip(d, i)} />
        </CardBody>
      </Card>
      <MethodNote>
        <p>{t('Oggi è escluso: si contano solo giorni UTC chiusi. L\'ultima seduta ETF ({d}) è provvisoria e può essere rivista.', { d: s.etf_last ? date(s.etf_last, false) : '—' })}</p>
        <p>{t('ETF: Farside, sedute USA ({n} nel periodo). USDT e USDC: circolante DefiLlama, variazione giorno su giorno. BTC sugli exchange: Coin Metrics, dati preliminari che possono essere rivisti.', { n: s.etf_days })}</p>
        {s.exchange_dropped && <p>{t('L\'ultimo punto preliminare di Coin Metrics è stato scartato: saltava di oltre l\'1% in un giorno.')}</p>}
        <p>{t('CVD: acquisti meno vendite aggressive su Binance spot e perpetual, in USD, azzerato all\'inizio del periodo. Il CVD multi-exchange esiste solo dove la raccolta del Terminale era accesa, per cui qui resta Binance su tutti i giorni: i livelli sono più bassi di quelli dei servizi che sommano più mercati.')}</p>
        <p>{t('Open interest: Binance, Bybit e OKX, tutti i perpetui BTC, convertito alla chiusura Binance.')}</p>
        <p>{t('Liquidazioni raccolte nei 30 giorni: long {l}, short {s}, ma la raccolta ha coperto per intero solo {n} giorni su 30.', { l: usdCompact(s.liq_long, 1), s: usdCompact(s.liq_short, 1), n: s.liq_days })}</p>
      </MethodNote>
    </div>
  )
}

export function Flows30Section() {
  const q = useFlows30()
  return (
    <Q q={q} loading={<Skeleton className="h-[900px]" />} isEmpty={(d) => !d.days.length} empty={t('Flussi non disponibili')}>
      {(d) => <Body d={d} updatedAt={q.dataUpdatedAt} />}
    </Q>
  )
}
