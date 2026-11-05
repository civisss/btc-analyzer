import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquareText, RefreshCw, Sparkles } from 'lucide-react'
import { api, useInsights } from '../api/client'
import { Card, CardBody, CardHeader, ICON, Q, Skeleton, clsx } from '../components/ui'
import { CATEGORY_LABEL, ago } from '../lib/format'
import { useApp } from '../lib/store'
import { getLang, t, tr } from '../i18n'
import { InsightHeadline } from './dashboard'

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])
  return <span className="tnum">{Math.floor((now - since) / 1000)}s</span>
}

/** House style for generated copy: Unicode minus, compact "$256M", disclaimer only once (in the page footer). */
function tidy(s: string): string {
  const out = s
    .replace(/\s*(Analisi automatica|Automated analysis|Automatic analysis)[^.]*\.\s*$/i, '')
    .replace(/(^|[\s(])-(?=\d)/g, '$1−')
    .replace(/\$?(\d[\d.,]*)\s*mln(\s*USD)?/g, '$$$1M')
    .replace(/\$?(\d[\d.,]*)\s*mld(\s*USD)?/g, '$$$1B')
    .replace(/\bup[- ]prob(?:ability)?\.?/gi, (_m: string, at: number, all: string) => {
      const w = getLang() === 'en' ? 'up probability' : 'probabilità di rialzo'
      // sentence start (or after "."/":"/"·") → capitalised
      return at === 0 || /[.:·]\s*$/.test(all.slice(0, at)) ? w[0].toUpperCase() + w.slice(1) : w
    })
  if (getLang() === 'en') return out.trim()
  return out
    .replace(/\b[Bb]ias bullish\b/g, 'Tendenza rialzista').replace(/\b[Bb]ias bearish\b/g, 'Tendenza ribassista')
    .replace(/\bbullish\b/g, 'rialzista').replace(/\bbearish\b/g, 'ribassista')
    .trim()
}

/** Dashboard: the signals of every analysis in one card, with the assistant one click away. */
export function SynthesisCard() {
  const q = useInsights()
  const qc = useQueryClient()
  const { setChatOpen } = useApp()
  const [cat, setCat] = useState('all')
  const [startedAt, setStartedAt] = useState(0)
  const regen = useMutation({
    mutationFn: () => api.insights(true),
    onMutate: () => setStartedAt(Date.now()),
    onSuccess: (data) => qc.setQueryData(['insights'], data),
  })
  const cats = useMemo(() => [...new Set((q.data?.items ?? []).map((i) => i.category))], [q.data])
  return (
    <Card>
      <CardHeader title={tr('In sintesi', 'At a glance')} icon={<Sparkles />} updatedAt={q.dataUpdatedAt}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {regen.isPending && <span className="text-xs text-fg-3">{t('Rigenerazione in corso')} · <Elapsed since={startedAt} /> ({t('circa un minuto')})</span>}
            {regen.isError && <span className="text-xs text-warn">{t('Rigenerazione non riuscita, riprova tra poco.')}</span>}
            {q.data && !regen.isPending && <span className="hidden text-xs text-fg-3 md:inline">{t('Generata {ago}', { ago: ago(q.data.generated_at) })}</span>}
            <button className="btn-ghost h-8" disabled={regen.isPending} onClick={() => regen.mutate()}>
              <RefreshCw size={ICON.chip} className={regen.isPending ? 'animate-spin' : ''} />{t('Rigenera')}
            </button>
            <button className="btn-ghost h-8" onClick={() => setChatOpen(true)}><MessageSquareText size={ICON.chip} />{t('Chiedi')}</button>
          </div>
        } />
      <CardBody>
        <Q q={q} loading={<div className="space-y-2"><Skeleton className="h-4" /><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>} compact>
          {(d) => (
            <div className="flex flex-col gap-3">
              <p className="max-w-[110ch] text-base text-fg">{d.summary ? tidy(d.summary) : t('Nessuna sintesi disponibile.')}</p>
              <div className="min-w-0">
                {d.items.length > 0 && (
                  <div className="mb-1 flex flex-wrap gap-1.5">
                    {['all', ...cats].map((c) => (
                      <button key={c} onClick={() => setCat(c)} className={clsx('chip h-7', cat === c ? 'chip-on' : 'chip-off')}>
                        {c === 'all' ? t('Tutti') : CATEGORY_LABEL[c] ?? c}
                      </button>
                    ))}
                  </div>
                )}
                <ul className="grid max-h-[248px] content-start gap-x-8 overflow-y-auto pr-1 [scrollbar-width:thin] md:grid-cols-2 min-[1800px]:grid-cols-3">
                  {d.items.filter((i) => cat === 'all' || i.category === cat).map((it, i) => <InsightHeadline key={i} it={{ ...it, title: tidy(it.title), text: tidy(it.text) }} full />)}
                </ul>
              </div>
            </div>
          )}
        </Q>
      </CardBody>
    </Card>
  )
}
