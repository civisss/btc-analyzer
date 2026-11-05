import { Component, Suspense, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useTab } from '../lib/useTab'
import { t } from '../i18n'
import { PageTitle, Skeleton, TabBar } from './ui'

export class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) {
    return { err }
  }
  render() {
    if (this.state.err)
      return (
        <div className="card p-6">
          <h2 className="font-semibold text-white">{t('Si è verificato un errore in questa pagina')}</h2>
          <p className="mt-1 text-sm text-fg-3">{this.state.err.message}</p>
          <button className="btn-ghost mt-3" onClick={() => this.setState({ err: null })}>{t('Riprova')}</button>
        </div>
      )
    return this.props.children
  }
}

export const PageFallback = () => (
  <div className="grid gap-4">
    <Skeleton className="h-10 w-64" />
    <Skeleton className="h-[420px]" />
  </div>
)

export type PageTab = { value: string; label: string; subtitle: string; render: () => ReactNode }

/** A page made of tabs: title, subtitle of the open tab, actions slot on the right, tab bar. Labels are Italian source strings.
 *  `aliases` keeps old `?tab=` values working on the pages that merged two tabs. */
export function TabPage({ title, tabs, aliases }: { title: string; tabs: PageTab[]; aliases?: Record<string, string> }) {
  const loc = useLocation()
  const [ids] = useState(() => tabs.map((x) => x.value))
  const [tab, setTab] = useTab<string>(ids, ids[0])
  const cur = tabs.find((x) => x.value === tab) ?? tabs[0]
  const raw = new URLSearchParams(loc.search).get('tab')
  if (raw && aliases?.[raw]) {
    const sp = new URLSearchParams(loc.search)
    sp.set('tab', aliases[raw])
    return <Navigate replace to={{ pathname: loc.pathname, search: `?${sp}` }} />
  }
  return (
    <div>
      <PageTitle title={t(title)} subtitle={t(cur.subtitle)} />
      {tabs.length > 1 && <TabBar tabs={tabs.map((x) => ({ value: x.value, label: t(x.label) }))} value={tab} onChange={setTab} />}
      <Boundary key={tab}>
        <Suspense fallback={<PageFallback />}>{cur.render()}</Suspense>
      </Boundary>
    </div>
  )
}
