import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, CheckCircle2, ClipboardList, Hourglass, NotebookPen, Plus, Search, Target } from 'lucide-react'
import { useNotes, useReviews, type Note, type ReviewsResponse } from '../api/journal'
import { live } from '../api/live'
import EChart from '../components/charts/EChart'
import { C, axisLabel, timeAxis, tooltipBase, valueAxis } from '../components/charts/theme'
import { Card, CardBody, CardHeader, KpiCell, KpiStrip, MethodNote, PageTitle, Q, Skeleton, TabBar, clsx } from '../components/ui'
import { INPUT } from '../widgets/forms'
import { NoteCard, NoteEditor, ViewBadge, outcomeLabel } from '../widgets/journal'
import { useTab } from '../lib/useTab'
import { date, dayUnit, monthYear, pct, usd } from '../lib/format'
import { cap, t } from '../i18n'

const OUTCOMES = [
  { value: '', label: 'Tutte' },
  { value: 'pending', label: 'In attesa' },
  { value: 'hit', label: 'Confermate' },
  { value: 'miss', label: 'Non confermate' },
  { value: 'none', label: 'Senza vista' },
] as const

function useDebounced<V>(v: V, ms: number): V {
  const [d, setD] = useState(v)
  useEffect(() => { const id = setTimeout(() => setD(v), ms); return () => clearTimeout(id) }, [v, ms])
  return d
}

function Timeline({ onEdit }: { onEdit: (n: Note) => void }) {
  const [sp, setSp] = useSearchParams()
  const [tag, setTag] = useState('')
  const [outcome, setOutcome] = useState('')
  const [search, setSearch] = useState('')
  const q = useNotes({ tag: tag || undefined, outcome: outcome || undefined, q: useDebounced(search.trim(), 300) || undefined })
  const focus = sp.get('note')
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []))
  useEffect(() => { if (focus) setOpen((s) => new Set([...s, focus])) }, [focus])
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: Note[] }[] = []
    for (const n of q.data?.items ?? []) {
      const k = monthYear(n.created_at)
      const g = out[out.length - 1]
      if (g && g.key === k) g.items.push(n)
      else out.push({ key: k, label: cap(k), items: [n] })
    }
    return out
  }, [q.data])
  const tags = q.data?.tags ?? []
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative w-full sm:w-64">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Cerca nelle note…')} aria-label={t('Cerca nelle note')} className={clsx(INPUT, 'pl-9')} />
        </span>
        <div className="no-scrollbar flex max-w-full gap-1.5 overflow-x-auto">
          {OUTCOMES.map((o) => (
            <button key={o.value} onClick={() => setOutcome(o.value)} className={clsx('chip', outcome === o.value ? 'chip-on' : 'chip-off')}>{t(o.label)}</button>
          ))}
        </div>
      </div>
      {tags.length > 0 && (
        <div className="no-scrollbar -mt-1 flex max-w-full gap-1.5 overflow-x-auto">
          {tags.map((x) => (
            <button key={x.tag} onClick={() => setTag(tag === x.tag ? '' : x.tag)} className={clsx('chip', tag === x.tag ? 'chip-on' : 'chip-off')}>
              #{x.tag}<span className="tnum text-slate-500">{x.count}</span>
            </button>
          ))}
        </div>
      )}
      <Q q={q} loading={<Skeleton className="h-64" />} isEmpty={() => false}>
        {(d) => d.items.length ? (
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <section key={g.key} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2.5 pt-1">
                  <span className="h-4 w-1 rounded-full bg-gradient-to-b from-accent-violet to-accent-violet/20" />
                  <h2 className="text-sm font-semibold text-white">{g.label}</h2>
                  <span className="tnum text-xs text-slate-500">{g.items.length === 1 ? t('1 nota') : t('{n} note', { n: g.items.length })}</span>
                </div>
                {g.items.map((n) => (
                  <NoteCard key={n.id} note={n} onEdit={() => onEdit(n)} open={open.has(n.id)} onToggle={() => toggle(n.id)}
                    highlight={focus === n.id} />
                ))}
              </section>
            ))}
          </div>
        ) : (
          <Card>
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <NotebookPen size={18} className="text-slate-500" />
              <p className="max-w-md text-sm text-slate-300">{d.total ? t('Nessuna nota con questi filtri.') : t('Il diario è vuoto. Scrivi la prima nota: il contesto di mercato verrà salvato automaticamente.')}</p>
              {(tag || outcome || search) && <button className="link" onClick={() => { setTag(''); setOutcome(''); setSearch(''); if (focus) { sp.delete('note'); setSp(sp, { replace: true }) } }}>{t('Azzera i filtri')}</button>}
            </div>
          </Card>
        )}
      </Q>
    </div>
  )
}

function HitRateChart({ series }: { series: ReviewsResponse['stats']['series'] }) {
  const option = useMemo(() => ({
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v: number) => pct(v, 0, false) },
    xAxis: timeAxis(),
    yAxis: valueAxis({ scale: false, min: 0, max: 100, interval: 25, axisLabel: { ...axisLabel, formatter: (v: number) => `${v}%` } }),
    series: [
      { name: t('Hit rate cumulato'), type: 'line', step: 'end', data: series.map((p) => [p.time * 1000, p.value]), showSymbol: true, symbolSize: 6,
        lineStyle: { width: 1.75, color: C.blue }, itemStyle: { color: C.blue },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: 'rgba(148,163,184,0.35)', type: 'dashed' }, data: [{ yAxis: 50 }] } },
    ],
  }), [series])
  return <EChart option={option} height={240} />
}

function Reviews() {
  const q = useReviews()
  return (
    <Q q={q} loading={<Skeleton className="h-96" />}>
      {(d) => (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-w-0 flex-col gap-3">
            <Card>
              <CardHeader title={t('Hit rate delle tue viste')} icon={<Target />} accent="violet" subtitle={t('Cumulato, nell’ordine delle scadenze')} />
              <CardBody>
                {d.stats.series.length >= 1 ? <HitRateChart series={d.stats.series} /> : <p className="py-10 text-center text-sm text-slate-400">{t('Il grafico apparirà dopo la prima revisione.')}</p>}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title={t('Revisioni')} icon={<CheckCircle2 />} accent="violet" subtitle={t('{n} viste verificate', { n: d.stats.total })} updatedAt={q.dataUpdatedAt} />
              <div className="overflow-x-auto pb-2">
                {d.items.length ? (
                  <table className="tbl">
                    <thead><tr><th className="pl-4 sm:pl-5">{t('Nota')}</th><th>{t('Vista')}</th><th className="text-right">{t('Prezzo iniziale')}</th><th className="text-right">{t('Prezzo finale')}</th><th className="text-right">{t('Variazione')}</th><th>{t('Esito')}</th><th className="pr-4 sm:pr-5">{t('Verifica')}</th></tr></thead>
                    <tbody>
                      {d.items.map((r) => (
                        <tr key={r.note_id}>
                          <td className="max-w-[260px] truncate pl-4 text-white sm:pl-5" title={r.title || undefined}>
                            <Link className="hover:underline" to={`/diario?note=${r.note_id}`}>{r.title || t('Nota del {d}', { d: date(r.created_at) })}</Link>
                            <span className="ml-2 text-2xs text-slate-500">{date(r.review.due_at)}</span>
                          </td>
                          <td><ViewBadge dir={r.direction} horizon={r.horizon} /></td>
                          <td className="text-right text-slate-300">{usd(r.review.price_start)}</td>
                          <td className="text-right text-white">{usd(r.review.price_end)}</td>
                          <td className={clsx('text-right font-medium', r.review.change_pct >= 0 ? 'text-up' : 'text-down')}>{pct(r.review.change_pct, 1)}</td>
                          <td className="text-slate-300">{outcomeLabel(r.review.outcome)} <span className="text-2xs text-slate-500">±{r.review.band_pct}%</span></td>
                          <td className="pr-4 sm:pr-5">{r.review.hit ? <span className="font-medium text-up">{t('Confermata')}</span> : <span className="font-medium text-down">{t('Non confermata')}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="px-5 py-8 text-center text-sm text-slate-400">{t('Nessuna vista ancora verificata. Le note con una vista vengono riviste automaticamente alla scadenza.')}</p>}
              </div>
            </Card>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <Card>
              <CardHeader title={t('Per orizzonte e direzione')} icon={<ClipboardList />} accent="violet" />
              <CardBody className="pt-0">
                <div className="dgrid grid-cols-3 rounded-xl">
                  {d.stats.by_horizon.map((h) => (
                    <div key={h.horizon} className="px-3 py-2.5">
                      <div className="label">{h.horizon} {t('giorni')}</div>
                      <div className="tnum mt-0.5 text-lg font-semibold text-white">{h.hit_rate == null ? '—' : pct(h.hit_rate, 0, false)}</div>
                      <div className="tnum text-2xs text-slate-400">{t('{h} su {n}', { h: h.hits, n: h.total })}</div>
                    </div>
                  ))}
                  {d.stats.by_direction.map((x) => (
                    <div key={x.direction} className="px-3 py-2.5">
                      <div className="label">{t({ up: 'Viste rialziste', down: 'Viste ribassiste', neutral: 'Viste neutrali' }[x.direction])}</div>
                      <div className="tnum mt-0.5 text-lg font-semibold text-white">{x.hit_rate == null ? '—' : pct(x.hit_rate, 0, false)}</div>
                      <div className="tnum truncate text-2xs text-slate-400">{t('{h} su {n}', { h: x.hits, n: x.total })}{x.avg_change != null && <> · {t('media {x}', { x: pct(x.avg_change, 1) })}</>}</div>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title={t('Prossime revisioni')} icon={<Hourglass />} accent="violet" subtitle={t('{n} in attesa', { n: d.upcoming.length })} />
              <div className="pb-2">
                {d.upcoming.length ? d.upcoming.slice(0, 12).map((u) => {
                  const left = Math.max(0, Math.ceil((u.due_at - Date.now() / 1000) / 86400))
                  return (
                    <Link key={u.note_id} to={`/diario?note=${u.note_id}`} className="flex items-center gap-3 border-t border-white/[0.05] px-4 py-2.5 first:border-t-0 hover:bg-white/[0.03] sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-white">{u.title || t('Nota del {d}', { d: date(u.created_at) })}</span>
                        <span className="tnum text-2xs text-slate-500">{t('Revisione il {d}', { d: date(u.due_at) })} · {u.price != null ? usd(u.price) : '—'}</span>
                      </span>
                      <ViewBadge dir={u.direction} horizon={u.horizon} />
                      <span className="tnum w-14 shrink-0 text-right text-xs text-slate-300">{u.overdue ? t('ora') : `${left} ${dayUnit()}`}</span>
                    </Link>
                  )
                }) : <p className="px-5 py-6 text-center text-sm text-slate-400">{t('Nessuna revisione in attesa.')}</p>}
              </div>
            </Card>
          </div>
        </div>
      )}
    </Q>
  )
}

export default function JournalPage() {
  const [tab, setTab] = useTab(['note', 'revisioni'] as const, 'note')
  const [editing, setEditing] = useState<Note | null | undefined>(undefined)   // undefined = closed, null = new
  const rq = useReviews()
  const nq = useNotes({})
  const qc = useQueryClient()
  useEffect(() => live.onToast((a) => { if (a.category === 'journal') qc.invalidateQueries({ queryKey: ['journal'] }) }), [qc])
  const st = rq.data?.stats
  const next = rq.data?.upcoming?.[0]
  const nextDays = next ? Math.max(0, Math.ceil((next.due_at - Date.now() / 1000) / 86400)) : null
  return (
    <div>
      <PageTitle title={t('Diario')} subtitle={t('Note di studio con il contesto di mercato salvato in automatico e la verifica delle tue viste alla scadenza.')}
        right={<button className="btn-primary" onClick={() => setEditing(null)}><Plus size={15} />{t('Nuova nota')}</button>} />
      <KpiStrip cols="grid-cols-2 xl:grid-cols-4" className="mb-4">
        <KpiCell icon={<NotebookPen />} accent="violet" label={t('Note')} value={nq.data ? `${nq.data.total}` : '—'} foot={nq.data ? t('{n} tag', { n: nq.data.tags.length }) : null} />
        <KpiCell icon={<CheckCircle2 />} accent="violet" label={t('Viste verificate')} value={st ? `${st.total}` : '—'} foot={st ? t('{n} in attesa', { n: st.pending }) : null} />
        <KpiCell icon={<Target />} accent="violet" label={t('Hit rate')} value={st?.hit_rate != null ? pct(st.hit_rate, 0, false) : '—'} foot={st ? (st.total ? t('{h} su {n} viste', { h: st.hits, n: st.total }) : t('Nessuna vista verificata')) : null} />
        <KpiCell icon={<CalendarCheck />} accent="violet" label={t('Prossima revisione')} value={next ? (next.overdue ? t('Ora') : `${nextDays} ${dayUnit()}`) : '—'} foot={next ? `${date(next.due_at)} · ${next.title || t('Nota del {d}', { d: date(next.created_at) })}` : t('Nessuna in attesa')} />
      </KpiStrip>
      <TabBar value={tab} onChange={setTab} tabs={[{ value: 'note', label: t('Note') }, { value: 'revisioni', label: t('Revisioni') }]} />
      {tab === 'note' ? <Timeline onEdit={(n) => setEditing(n)} /> : <Reviews />}
      <MethodNote className="mt-3">
        <p>{t('Alla creazione di una nota il diario salva uno snapshot del contesto dagli stessi moduli dell’app: prezzo, fase e Cycle Score, livelli chiave, stato della struttura, bias di analoghi e frattali, mediana della previsione, funding, Fear & Greed, USDT dominance e pivot temporali attivi.')}</p>
        <p>{t('Se indichi una vista (rialzo, ribasso, neutrale) e un orizzonte, alla scadenza la nota viene rivista in automatico: prezzo alla scadenza (chiusura della candela 1h Binance), variazione ed escursione massima, esito classificato con una banda neutra di ±2% a 7 giorni, ±4% a 30 e ±8% a 90, e confronto tra il contesto di allora e quello di oggi. La vista diventa non modificabile 15 minuti dopo la creazione.')}</p>
        <p>{t('Il diario è uno strumento di studio per misurare le proprie letture del mercato: non contiene segnali operativi.')}</p>
      </MethodNote>
      {editing !== undefined && <NoteEditor note={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}
