/**
 * Pagine a schede: ogni scheda risponde a una domanda e carica il proprio contenuto solo quando viene aperta.
 * Dove una scheda raccoglie più viste, il selettore sta in alto a destra (`?view=`, `?metodo=`).
 */
import { lazy } from 'react'
import { TabPage } from '../components/TabPage'
import { PageActions, Segmented } from '../components/ui'
import { useTab } from '../lib/useTab'
import { t } from '../i18n'

const Candles = lazy(() => import('./Charts'))
const Superchart = lazy(() => import('./SuperchartPage'))
const Vwap = lazy(() => import('./VwapPage'))
const Terminal = lazy(() => import('./TerminalPage'))
const OrderBook = lazy(() => import('./OrderBookPage'))
const FlowsSection = lazy(() => import('../widgets/flows').then((m) => ({ default: m.FlowsSection })))
const Flows30Section = lazy(() => import('../widgets/flows30').then((m) => ({ default: m.Flows30Section })))
const MovesSection = lazy(() => import('../widgets/moves').then((m) => ({ default: m.MovesSection })))
const EtfTab = lazy(() => import('./SupplyDemandPage').then((m) => ({ default: m.EtfTab })))
const AttentionTab = lazy(() => import('./SupplyDemandPage').then((m) => ({ default: m.AttentionTab })))
const ExchangeTab = lazy(() => import('./SupplyDemandPage').then((m) => ({ default: m.ExchangeTab })))
const UsdtOverview = lazy(() => import('./UsdtPage').then((m) => ({ default: m.OverviewTab })))
const Stables = lazy(() => import('./UsdtPage').then((m) => ({ default: m.StablesTab })))
const UsdtAnalogs = lazy(() => import('./UsdtPage').then((m) => ({ default: m.AnalogsTab })))
const Perpetuals = lazy(() => import('./DerivativesPage'))
const Aggregate = lazy(() => import('../widgets/derivPro').then((m) => ({ default: m.LeverageTab })))
const Basis = lazy(() => import('../widgets/derivPro').then((m) => ({ default: m.BasisTab })))
const Cme = lazy(() => import('../widgets/derivPro').then((m) => ({ default: m.CmeTab })))
const Options = lazy(() => import('./PositioningPage').then((m) => ({ default: m.OptionsTab })))
const Holders = lazy(() => import('./PositioningPage').then((m) => ({ default: m.HoldersTab })))
const Sentiment = lazy(() => import('./PositioningPage').then((m) => ({ default: m.SentimentTab })))
const Liquidations = lazy(() => import('./LiquidationsPage'))
const Macro = lazy(() => import('./MacroPage'))
const Events = lazy(() => import('./EventsPage'))
const LiveAnalogs = lazy(() => import('./AnalogsPage'))
const Fractals = lazy(() => import('./FractalsPage'))
const StructureAnalogs = lazy(() => import('../widgets/structAnalogs').then((m) => ({ default: m.StructureAnalogsTab })))
const ImagePattern = lazy(() => import('../widgets/imagePattern').then((m) => ({ default: m.ImagePatternTab })))
const TimePivots = lazy(() => import('./TimePivotsPage'))
const Path = lazy(() => import('./ForecastPage'))
const TrackRecord = lazy(() => import('./TrackRecordPage'))

export function ChartsHub() {
  return (
    <TabPage title="Grafici" tabs={[
      { value: 'candele', label: 'Candele', subtitle: 'Candele BTC/USDT con indicatori e livelli, aggiornate in tempo reale.', render: () => <Candles /> },
      { value: 'superchart', label: 'Superchart', subtitle: 'Prezzo, derivati, flussi e on-chain su un unico asse del tempo: pannelli sincronizzati, replay senza dati futuri e anomalie con il loro backtest.', render: () => <Superchart /> },
      { value: 'vwap', label: 'VWAP', subtitle: 'VWAP ancorati al calendario UTC (settimana, mese, trimestre, anno) con bande ±σ e livelli del periodo precedente estesi.', render: () => <Vwap /> },
    ]} />
  )
}

export function TerminalHub() {
  return (
    <TabPage title="Terminale" tabs={[
      { value: 'live', label: 'Live', subtitle: 'Prezzo, order flow, CVD, open interest, funding e liquidazioni in tempo reale da Binance, Bybit, OKX e Coinbase.', render: () => <Terminal /> },
      { value: 'heatmap', label: 'Heatmap', subtitle: 'Dove sta la liquidità: book Binance nel tempo, muri e ritiri raccolti in tempo reale.', render: () => <OrderBook tab="heatmap" /> },
      { value: 'footprint', label: 'Footprint', subtitle: 'Chi ha colpito il book: trade aggressivi per candela e livello di prezzo.', render: () => <OrderBook tab="footprint" /> },
    ]} />
  )
}

function DemandTab() {
  const [view, setView] = useTab(['etf', 'attenzione'] as const, 'etf', 'view')
  return (
    <>
      <PageActions><Segmented value={view} onChange={setView} options={[{ value: 'etf', label: t('ETF spot') }, { value: 'attenzione', label: t('Attenzione') }]} /></PageActions>
      {view === 'etf' ? <EtfTab /> : <AttentionTab />}
    </>
  )
}

function LiquidityTab() {
  const [view, setView] = useTab(['usdt', 'stablecoin'] as const, 'usdt', 'view')
  return (
    <>
      <PageActions><Segmented value={view} onChange={setView} options={[{ value: 'usdt', label: 'USDT' }, { value: 'stablecoin', label: 'Stablecoin' }]} /></PageActions>
      {view === 'usdt' ? <UsdtOverview /> : <Stables />}
    </>
  )
}

function FlowsOverviewTab() {
  const [view, setView] = useTab(['trenta', 'spot', 'movimenti'] as const, 'trenta', 'view')
  return (
    <>
      <PageActions><Segmented value={view} onChange={setView} options={[{ value: 'trenta', label: t('30 giorni') }, { value: 'spot', label: t('Spot vs futures') }, { value: 'movimenti', label: t('Dopo il movimento') }]} /></PageActions>
      {view === 'trenta' ? <Flows30Section /> : view === 'spot' ? <FlowsSection /> : <MovesSection />}
    </>
  )
}

export function FlowsHub() {
  return (
    <TabPage title="Flussi" tabs={[
      { value: 'spot', label: 'Panoramica', subtitle: 'Chi sta spingendo il prezzo: gli ultimi 30 giorni, spot contro futures e cosa ha accompagnato i movimenti forti.', render: () => <FlowsOverviewTab /> },
      { value: 'etf', label: 'ETF e attenzione', subtitle: 'Da dove arriva la domanda: ETF spot USA, assorbimento dei BTC emessi e attenzione retail.', render: () => <DemandTab /> },
      { value: 'stablecoin', label: 'Stablecoin', subtitle: 'Quanta liquidità è pronta a entrare: dominance di Tether, supply delle stablecoin e SSR.', render: () => <LiquidityTab /> },
      { value: 'exchange', label: 'Riserve exchange', subtitle: 'Quanta offerta è sugli exchange: riserve di BTC, afflussi e deflussi, regimi di flusso e rendimenti successivi.', render: () => <ExchangeTab /> },
    ]} />
  )
}

function DerivativesTab() {
  const [view, setView] = useTab(['perp', 'leva', 'basis', 'cme'] as const, 'perp', 'view')
  return (
    <>
      <PageActions>
        <Segmented value={view} onChange={setView} options={[{ value: 'perp', label: t('Perpetui') }, { value: 'leva', label: t('Leva aggregata') }, { value: 'basis', label: 'Basis' }, { value: 'cme', label: 'CME' }]} />
      </PageActions>
      {view === 'perp' ? <Perpetuals /> : view === 'leva' ? <Aggregate /> : view === 'basis' ? <Basis /> : <Cme />}
    </>
  )
}

function HoldersSentimentTab() {
  const [view, setView] = useTab(['sentiment', 'holder'] as const, 'sentiment', 'view')
  return (
    <>
      <PageActions><Segmented value={view} onChange={setView} options={[{ value: 'sentiment', label: t('Sentiment') }, { value: 'holder', label: t('Holder') }]} /></PageActions>
      {view === 'sentiment' ? <Sentiment /> : <Holders />}
    </>
  )
}

export function PositioningHub() {
  return (
    <TabPage title="Posizionamento" aliases={{ sentiment: 'umore', holder: 'umore' }} tabs={[
      { value: 'derivati', label: 'Derivati', subtitle: 'Quanta leva c’è sul mercato: funding, open interest, leva aggregata, basis e CME.', render: () => <DerivativesTab /> },
      { value: 'opzioni', label: 'Opzioni', subtitle: 'Cosa prezzano le opzioni: open interest, max pain, put/call, skew e volatilità implicita su Deribit.', render: () => <Options /> },
      { value: 'umore', label: 'Holder e sentiment', subtitle: 'Chi è in profitto e con che umore: costo medio degli holder e indice contrarian di paura ed euforia.', render: () => <HoldersSentimentTab /> },
      { value: 'liquidazioni', label: 'Liquidazioni', subtitle: 'Dove si fa male la leva: livelli di liquidazione stimati, cluster vicini al prezzo e flusso in tempo reale.', render: () => <Liquidations /> },
    ]} />
  )
}

export function MacroHub() {
  return (
    <TabPage title="Macro" tabs={[
      { value: 'quadro', label: 'Quadro macro', subtitle: 'Liquidità, dollaro e tassi, correlazioni con i mercati tradizionali e rotazione verso le altcoin.', render: () => <Macro /> },
      { value: 'eventi', label: 'Eventi', subtitle: 'Calendario macro, scadenze dei derivati ed elezioni USA, con la reazione storica di BTC e la volatilità attesa.', render: () => <Events /> },
    ]} />
  )
}

function CurrentChartTab() {
  const [method, setMethod] = useTab(['analoghi', 'frattali', 'usdt'] as const, 'analoghi', 'metodo')
  return (
    <>
      <PageActions>
        <Segmented value={method} onChange={setMethod} options={[{ value: 'analoghi', label: t('Analoghi') }, { value: 'frattali', label: t('Frattali') }, { value: 'usdt', label: 'USDT.D' }]} />
      </PageActions>
      {method === 'analoghi' ? <LiveAnalogs /> : method === 'frattali' ? <Fractals /> : <UsdtAnalogs />}
    </>
  )
}

export function AnalogsHub() {
  return (
    <TabPage title="Analoghi" tabs={[
      { value: 'live', label: 'Grafico attuale', subtitle: 'Quando il mercato ha già avuto questa forma, e cosa è successo dopo.', render: () => <CurrentChartTab /> },
      { value: 'struttura', label: 'Analogia di struttura', subtitle: 'Il movimento attuale confrontato con quelli passati per sequenza di massimi e minimi, e i prossimi pivot attesi.', render: () => <StructureAnalogs /> },
      { value: 'image', label: 'Da immagine', subtitle: 'Carica uno screenshot di un grafico: troviamo i periodi di BTC con la stessa figura.', render: () => <ImagePattern /> },
      { value: 'pivot', label: 'Pivot temporali', subtitle: 'Date in cui BTC ha storicamente invertito o accelerato.', render: () => <TimePivots /> },
    ]} />
  )
}

export function ForecastHub() {
  return (
    <TabPage title="Previsioni" tabs={[
      { value: 'percorso', label: 'Percorso a 12 mesi', subtitle: 'Percorso di prezzo a 12 mesi dalla posizione nel ciclo attuale e da come si sono mossi i cicli passati.', render: () => <Path /> },
      { value: 'affidabilita', label: 'Affidabilità', subtitle: 'Quanto hanno avuto ragione i modelli: ogni previsione è registrata e verificata sul prezzo reale alla scadenza.', render: () => <TrackRecord /> },
    ]} />
  )
}
