import React, { type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import '@fontsource-variable/geist'
import './index.css'
import App from './App'
import { AppStateProvider } from './lib/store'
import { installFetchLang, useLang } from './i18n'
import { installRealtime } from './api/realtime'

installFetchLang()

const queryClient = new QueryClient({
  defaultOptions: {
    // analytics fall back to polling every 30–60 s; the WS "invalidate" push refreshes them as soon as the backend recalculates
    queries: { refetchOnWindowFocus: true, staleTime: 30_000, retry: 1 },
  },
})
installRealtime(queryClient)

/** Remounts the UI when the language changes so every memoised label / chart option is rebuilt in the new language. */
function LangRoot({ children }: { children: ReactNode }) {
  const lang = useLang()
  return <React.Fragment key={lang}>{children}</React.Fragment>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppStateProvider>
          <LangRoot>
            <App />
          </LangRoot>
        </AppStateProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
