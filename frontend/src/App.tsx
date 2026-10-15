import { Component, lazy, Suspense, type ReactNode } from 'react'
import { Route, Routes, Link } from 'react-router-dom'
import Layout from './components/Layout'
import { Skeleton } from './components/ui'
import Dashboard from './pages/Dashboard'
import { t } from './i18n'

const Charts = lazy(() => import('./pages/Charts'))
const CyclesPage = lazy(() => import('./pages/CyclesPage'))
const TimePivotsPage = lazy(() => import('./pages/TimePivotsPage'))
const FractalsPage = lazy(() => import('./pages/FractalsPage'))
const AnalogsPage = lazy(() => import('./pages/AnalogsPage'))
const LiquidationsPage = lazy(() => import('./pages/LiquidationsPage'))
const DerivativesPage = lazy(() => import('./pages/DerivativesPage'))
const OnChainPage = lazy(() => import('./pages/OnChainPage'))
const UsdtPage = lazy(() => import('./pages/UsdtPage'))
const MacroPage = lazy(() => import('./pages/MacroPage'))
const ForecastPage = lazy(() => import('./pages/ForecastPage'))
const InsightsPage = lazy(() => import('./pages/InsightsPage'))
const AgentsPage = lazy(() => import('./pages/AgentsPage'))
const StructurePage = lazy(() => import('./pages/StructurePage'))
const EventsPage = lazy(() => import('./pages/EventsPage'))
const AstroPage = lazy(() => import('./pages/AstroPage'))
const TrackRecordPage = lazy(() => import('./pages/TrackRecordPage'))
const PositioningPage = lazy(() => import('./pages/PositioningPage'))
const AlertsPage = lazy(() => import('./pages/AlertsPage'))
const JournalPage = lazy(() => import('./pages/JournalPage'))
const SupplyDemandPage = lazy(() => import('./pages/SupplyDemandPage'))
const VwapPage = lazy(() => import('./pages/VwapPage'))
const TimingPage = lazy(() => import('./pages/TimingPage'))
const SuperchartPage = lazy(() => import('./pages/SuperchartPage'))
const OrderBookPage = lazy(() => import('./pages/OrderBookPage'))
const ElliottPage = lazy(() => import('./pages/ElliottPage'))

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) {
    return { err }
  }
  render() {
    if (this.state.err)
      return (
        <div className="card p-6">
          <h2 className="font-semibold text-white">{t('Si è verificato un errore in questa pagina')}</h2>
          <p className="mt-1 text-sm text-slate-400">{this.state.err.message}</p>
          <button className="btn-ghost mt-3" onClick={() => this.setState({ err: null })}>{t('Riprova')}</button>
        </div>
      )
    return this.props.children
  }
}

const Fallback = () => (
  <div className="grid gap-4">
    <Skeleton className="h-10 w-64" />
    <Skeleton className="h-[420px]" />
  </div>
)

const page = (el: ReactNode) => (
  <Boundary>
    <Suspense fallback={<Fallback />}>{el}</Suspense>
  </Boundary>
)

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={page(<Dashboard />)} />
        <Route path="agenti" element={page(<AgentsPage />)} />
        <Route path="grafici" element={page(<Charts />)} />
        <Route path="cicli" element={page(<CyclesPage />)} />
        <Route path="pivot-temporali" element={page(<TimePivotsPage />)} />
        <Route path="frattali" element={page(<FractalsPage />)} />
        <Route path="analoghi" element={page(<AnalogsPage />)} />
        <Route path="liquidazioni" element={page(<LiquidationsPage />)} />
        <Route path="derivati" element={page(<DerivativesPage />)} />
        <Route path="onchain" element={page(<OnChainPage />)} />
        <Route path="usdt" element={page(<UsdtPage />)} />
        <Route path="macro" element={page(<MacroPage />)} />
        <Route path="previsioni" element={page(<ForecastPage />)} />
        <Route path="insights" element={page(<InsightsPage />)} />
        <Route path="vwap" element={page(<VwapPage />)} />
        <Route path="struttura" element={page(<StructurePage />)} />
        <Route path="eventi" element={page(<EventsPage />)} />
        <Route path="astronomia" element={page(<AstroPage />)} />
        <Route path="timing" element={page(<TimingPage />)} />
        <Route path="elliott" element={page(<ElliottPage />)} />
        <Route path="superchart" element={page(<SuperchartPage />)} />
        <Route path="orderbook" element={page(<OrderBookPage />)} />
        <Route path="affidabilita" element={page(<TrackRecordPage />)} />
        <Route path="posizionamento" element={page(<PositioningPage />)} />
        <Route path="avvisi" element={page(<AlertsPage />)} />
        <Route path="diario" element={page(<JournalPage />)} />
        <Route path="domanda-offerta" element={page(<SupplyDemandPage />)} />
        <Route
          path="*"
          element={
            <div className="py-20 text-center">
              <h1 className="text-2xl font-bold text-white">{t('Pagina non trovata')}</h1>
              <Link to="/" className="mt-4 inline-block text-sky-300 hover:underline">{t('Torna alla dashboard')}</Link>
            </div>
          }
        />
      </Route>
    </Routes>
  )
}
