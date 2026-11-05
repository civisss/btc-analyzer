import { lazy, Suspense, type ReactNode } from 'react'
import { Route, Routes, Link } from 'react-router-dom'
import Layout from './components/Layout'
import { Boundary, PageFallback } from './components/TabPage'
import Dashboard from './pages/Dashboard'
import { AnalogsHub, ChartsHub, FlowsHub, ForecastHub, MacroHub, PositioningHub, TerminalHub, SignalsHub } from './pages/Hubs'
import { OldUrl, REDIRECTS } from './lib/redirects'
import { t } from './i18n'

const CyclesPage = lazy(() => import('./pages/CyclesPage'))
const OnChainPage = lazy(() => import('./pages/OnChainPage'))
const StructurePage = lazy(() => import('./pages/StructurePage'))
const AlertsPage = lazy(() => import('./pages/AlertsPage'))

const page = (el: ReactNode) => (
  <Boundary>
    <Suspense fallback={<PageFallback />}>{el}</Suspense>
  </Boundary>
)

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={page(<Dashboard />)} />
        <Route path="terminale" element={page(<TerminalHub />)} />
        <Route path="grafici" element={page(<ChartsHub />)} />
        <Route path="segnali" element={page(<SignalsHub />)} />
        <Route path="struttura" element={page(<StructurePage />)} />
        <Route path="flussi" element={page(<FlowsHub />)} />
        <Route path="posizionamento" element={page(<PositioningHub />)} />
        <Route path="macro" element={page(<MacroHub />)} />
        <Route path="onchain" element={page(<OnChainPage />)} />
        <Route path="cicli" element={page(<CyclesPage />)} />
        <Route path="analoghi" element={page(<AnalogsHub />)} />
        <Route path="previsioni" element={page(<ForecastHub />)} />
        <Route path="avvisi" element={page(<AlertsPage />)} />
        {Object.keys(REDIRECTS).map((from) => <Route key={from} path={from} element={<OldUrl from={from} />} />)}
        <Route
          path="*"
          element={
            <div className="py-20 text-center">
              <h1 className="text-2xl font-bold text-white">{t('Pagina non trovata')}</h1>
              <Link to="/" className="mt-4 inline-block text-fg-2 hover:underline">{t('Torna alla dashboard')}</Link>
            </div>
          }
        />
      </Route>
    </Routes>
  )
}
