import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ListFilter, MessageSquareText, RefreshCw, Sparkles } from 'lucide-react'
import { api, useInsights } from '../api/client'
import { Card, CardBody, CardHeader, ICON, PageTitle, Q, Skeleton, clsx } from '../components/ui'
import ChatPanel from '../components/ChatPanel'
import { InsightHeadline } from '../widgets/dashboard'
import { CATEGORY_LABEL, ago } from '../lib/format'
import { getLang, t, tr } from '../i18n'

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

export default function InsightsPage() {
  const q = useInsights()
  const qc = useQueryClient()
  const [cat, setCat] = useState<string>('all')
  const [startedAt, setStartedAt] = useState(0)
  const regen = useMutation({
    mutationFn: () => api.insights(true),
    onMutate: () => setStartedAt(Date.now()),
    onSuccess: (data) => qc.setQueryData(['insights'], data),
  })
  const cats = useMemo(() => [...new Set((q.data?.items ?? []).map((i) => i.category))], [q.data])
  return (
    <div>
      <PageTitle title={t('Sintesi')} subtitle={t('Segnali di tutte le analisi e domande sui dati.')}
        right={
          <>
            {regen.isPending && <span className="text-xs text-slate-400">{t('Rigenerazione in corso')} · <Elapsed since={startedAt} /> ({t('circa un minuto')})</span>}
            {regen.isError && <span className="text-xs text-amber-400">{t('Rigenerazione non riuscita, riprova tra poco.')}</span>}
            <button className="btn-ghost h-8" disabled={regen.isPending} onClick={() => regen.mutate()}>
              <RefreshCw size={ICON.chip} className={regen.isPending ? 'animate-spin' : ''} />
              {t('Rigenera')}
            </button>
          </>
        } />
      <div className="grid gap-3 xl:grid-cols-12">
        <div className="flex flex-col gap-3 xl:col-span-7">
          <Card>
            <CardHeader title={tr('In sintesi', 'At a glance')} icon={<Sparkles />} updatedAt={q.dataUpdatedAt}
              right={q.data && <span className="text-xs text-slate-400">{t('Generata {ago}', { ago: ago(q.data.generated_at) })}</span>} />
            <CardBody>
              <Q q={q} loading={<div className="space-y-2"><Skeleton className="h-4" /><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>} compact>
                {(d) => <p className="text-lg text-slate-200">{d.summary ? tidy(d.summary) : t('Nessuna sintesi disponibile.')}</p>}
              </Q>
            </CardBody>
          </Card>
          <Card>
            <CardHeader icon={<ListFilter />} title={t('Segnali')} right={
              <div className="flex flex-wrap gap-1.5">
                {['all', ...cats].map((c) => (
                  <button key={c} onClick={() => setCat(c)} className={clsx('chip h-8', cat === c ? 'chip-on' : 'chip-off')}>
                    {c === 'all' ? t('Tutti') : CATEGORY_LABEL[c] ?? c}
                  </button>
                ))}
              </div>
            } />
            <CardBody>
              <Q q={q} loading={<div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>} isEmpty={(d) => !d.items.length} empty={t('Nessun segnale disponibile')}>
                {(d) => <ul className="flex flex-col">{d.items.filter((i) => cat === 'all' || i.category === cat).map((it, i) => <InsightHeadline key={i} it={{ ...it, title: tidy(it.title), text: tidy(it.text) }} full showMeta />)}</ul>}
              </Q>
            </CardBody>
          </Card>
        </div>
        {/* chat column: as tall as the signals column, the card itself sticks and fills the viewport */}
        <div className="xl:col-span-5 xl:h-0 xl:min-h-full">
          <Card className="xl:sticky xl:top-20 xl:h-full xl:max-h-[calc(100vh-6rem)]">
            <CardHeader title={t('Chiedi')} icon={<MessageSquareText />} subtitle={t('Prezzo, cicli, pattern, livelli e liquidità')} />
            <CardBody className="flex min-h-0 flex-col"><ChatPanel className="flex-1" /></CardBody>
          </Card>
        </div>
      </div>
      <p className="mt-6 text-xs text-slate-400">{t('Stime statistiche su dati storici. Non è consulenza finanziaria.')}</p>
    </div>
  )
}
