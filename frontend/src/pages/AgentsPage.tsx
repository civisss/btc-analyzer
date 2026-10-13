import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Clock, Gauge, MessagesSquare, Network, Play, Timer, TriangleAlert, Users } from 'lucide-react'
import { api } from '../api/client'
import type { Agent, AgentId } from '../api/types'
import { Card, CardBody, CardHeader, ErrorState, ICON, KpiCell, KpiStrip, PageTitle, Segmented, Skeleton, Toggle } from '../components/ui'
import {
  AgentNetwork, Blueprint, LogLine, Terminal, clock, fmtAgo, fmtMs, statusColor, statusLabel, useAgentFeed, useAgentsLive, useLastAlert, useNow,
} from '../widgets/agents'
import { dayUnit, int } from '../lib/format'
import { t, tr } from '../i18n'

function fmtInterval(s: number) {
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(s % 3600 ? 1 : 0)} h`
}

/** "2 min", "3 h 05", "4 g" / "4 d" */
function since(s: number) {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
  return `${Math.floor(s / 86400)} ${dayUnit()}`
}

function StatusDot({ status }: { status: Agent['status'] }) {
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: statusColor(status) }} />
}

function Meta({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label">{k}</dt>
      <dd className="tnum mt-0.5 truncate text-sm text-white">{v}</dd>
    </div>
  )
}

const toneWord = (tone: string) => (tone === 'bullish' ? tr('Rialzo', 'Up') : tone === 'bearish' ? tr('Ribasso', 'Down') : tr('Neutro', 'Neutral'))

function DetailPanel({ sel, now, onRun, running, runError, tech }: { sel: Agent; now: number; onRun: () => void; running: boolean; runError: boolean; tech: boolean }) {
  const busy = running || sel.status === 'running'
  const [all, setAll] = useState(false)
  const findings = all ? sel.findings : sel.findings.slice(0, 3)
  return (
    <>
      <CardHeader icon={<Bot />} title={sel.name} subtitle={sel.role}
        right={<span className="inline-flex items-center gap-1.5 text-xs text-slate-300"><StatusDot status={sel.status} />{statusLabel(sel.status)}</span>} />
      <CardBody className="flex min-h-0 flex-col gap-4">
        {sel.error && <p className="rounded-md border border-down/30 px-3 py-2 text-xs text-down">{sel.error}</p>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
          <Meta k={t('Ciclo')} v={t('Ogni {n}', { n: fmtInterval(sel.interval_s) })} />
          <Meta k={t('Esecuzioni')} v={int(sel.runs)} />
          <Meta k={t('Durata')} v={fmtMs(sel.last_duration_ms)} />
          <Meta k={t('Ultima')} v={sel.last_run ? t('{t} fa', { t: fmtAgo(now / 1000 - sel.last_run) }) : '—'} />
          <Meta k={t('Prossima')} v={sel.next_run ? (sel.next_run * 1000 > now ? t('Tra {t}', { t: fmtAgo(sel.next_run - now / 1000) }) : t('A breve')) : '—'} />
          <Meta k={t('Messaggi')} v={t('{r} ricevuti · {s} inviati', { r: int(sel.stats.messages_received), s: int(sel.stats.messages_sent) })} />
        </dl>
        {tech && (
          <div className="flex flex-col gap-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-1.5"><span className="label w-16">{t('Ascolta')}</span>
              {sel.subscribes.length ? sel.subscribes.map((tp) => <span key={tp} className="rounded border border-line px-1.5 font-mono text-slate-300">{tp}</span>) : <span className="text-slate-400">{t('Nessun topic (sorgente dati)')}</span>}
            </div>
            <div className="flex flex-wrap items-baseline gap-1.5"><span className="label w-16">{t('Pubblica')}</span>
              {sel.publishes.map((tp) => <span key={tp} className="rounded border border-line px-1.5 font-mono text-slate-300">{tp}</span>)}
            </div>
          </div>
        )}
        <button onClick={onRun} disabled={busy} className={busy ? 'btn-ghost h-8 self-start cursor-not-allowed text-slate-400' : 'btn-primary self-start'}>
          {busy ? <Timer size={ICON.chip} className="animate-spin" /> : <Play size={ICON.chip} />}
          {sel.status === 'running' ? t('In esecuzione…') : t('Esegui ora')}
        </button>
        {runError && <p className="text-xs text-down">{t("Impossibile avviare l'agente, riprova.")}</p>}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="label mb-1">{t('Eventi recenti')}</div>
          {sel.findings.length === 0 && <p className="py-2 text-sm text-slate-400">{t('Nessun evento')}</p>}
          <div className="flex flex-col divide-y divide-line">
            {findings.map((f, i) => (
              <div key={i} className="py-2.5">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="tnum">{clock(f.time)}</span>
                  <span className={f.tone === 'bullish' ? 'text-up' : f.tone === 'bearish' ? 'text-down' : 'text-slate-400'}>{toneWord(f.tone)}</span>
                  <span className="tnum ml-auto">{t('Confidenza {n}%', { n: f.confidence.toFixed(0) })}</span>
                </div>
                <div className="mt-0.5 text-sm font-medium text-white">{f.title}</div>
                <p className="mt-0.5 text-sm text-slate-400">{f.text}</p>
              </div>
            ))}
          </div>
          {sel.findings.length > 3 && <button className="link self-start" onClick={() => setAll(!all)}>{all ? t('Mostra meno') : t('Mostra tutti ({n})', { n: sel.findings.length })}</button>}
        </div>
      </CardBody>
    </>
  )
}

export default function AgentsPage() {
  const { q, agents, edges } = useAgentsLive()
  const { messages } = useAgentFeed(200)
  const { alert: lastAlert, loading: alertLoading } = useLastAlert()
  const [selected, setSelected] = useState<AgentId | null>('analyst')
  const [filter, setFilter] = useState<string>('all')
  const [tech, setTech] = useState(false)
  const [links, setLinks] = useState<'active' | 'all'>('active')
  const now = useNow()
  const byId = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents])
  const sel = selected ? byId.get(selected) : undefined
  const qc = useQueryClient()
  const run = useMutation({
    mutationFn: (id: string) => api.runAgent(id),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['agents'] }), 1200),
  })

  const perMin = messages.filter((m) => now / 1000 - m.time <= 60).length
  const active = (agents ?? []).filter((a) => a.status !== 'error').length
  const running = (agents ?? []).filter((a) => a.status === 'running').length
  const errors = (agents ?? []).filter((a) => a.status === 'error').length
  const startedAt = q.data?.started_at

  // log: oldest -> newest, autoscroll unless hovered
  const feed = useMemo(() => messages.filter((m) => filter === 'all' || m.from === filter || m.to === filter).slice(0, 150).reverse(), [messages, filter])
  const feedRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (!paused && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [feed, paused])

  return (
    <div className="flex flex-col gap-3">
      <PageTitle title={t('Agenti')} subtitle={t('Moduli autonomi: ognuno analizza un aspetto del mercato e condivide i risultati con gli altri.')}
        right={<Toggle on={tech} onClick={() => setTech(!tech)}>{t('Dettagli tecnici')}</Toggle>} />
      <KpiStrip cols="grid-cols-2 xl:grid-cols-4">
        <KpiCell icon={<Users />} label={t('Agenti attivi')} value={agents ? `${active} / ${agents.length}` : '—'} foot={agents ? t('{r} in esecuzione · {e} in errore', { r: running, e: errors }) : undefined} />
        <KpiCell icon={<Gauge />} label={t('Messaggi/min')} value={perMin} foot={t('{n} recenti', { n: int(messages.length) })} />
        <KpiCell icon={<TriangleAlert />} label={t('Ultimo avviso')}
          value={lastAlert ? byId.get(lastAlert.from)?.name ?? lastAlert.from : alertLoading ? '…' : t('Nessuno')}
          foot={lastAlert ? <span title={lastAlert.text}>{t('{t} fa', { t: fmtAgo(now / 1000 - lastAlert.time) })} · {lastAlert.text}</span> : t('Nessun avviso in cronologia')} />
        <KpiCell icon={<Clock />} label={t('Uptime')} value={startedAt ? since(now / 1000 - startedAt) : '—'} foot={t('{n} collegamenti', { n: edges.length })} />
      </KpiStrip>

      <Card>
        <CardHeader title={t('Rete')} icon={<Network />} updatedAt={q.dataUpdatedAt}
          info={t("Linee verso l'Analista: sempre visibili. Collegamenti tra agenti: solo quelli con traffico nell'ultimo minuto, salvo «Tutti». Passa sopra un agente per evidenziarne i collegamenti.")}
          right={<Segmented value={links} onChange={setLinks} options={[{ value: 'active', label: t('Solo attivi') }, { value: 'all', label: t('Tutti i collegamenti') }]} />} />
        <CardBody>
          {q.isPending ? <Skeleton className="h-[50vh] w-full" /> : q.isError && !agents ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
            <Blueprint>
              <div className="p-2 sm:p-3">
                <AgentNetwork agents={agents ?? []} edges={edges} selected={selected} onSelect={setSelected} showAll={links === 'all'} />
              </div>
            </Blueprint>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="inline-block w-5 bg-[#2A3140]" style={{ height: 1 }} />{t('Collegamento')}</span>
            <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="inline-block w-5 bg-[#3A4458]" style={{ height: 1.25 }} />{t('Traffico ultimo minuto')}</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 bg-accent-blue" style={{ height: 1.5 }} />{t('Attivo ora')}</span>
            <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-accent-blue" />{t('Analisi')}</span>
            <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />{t('Avviso')}</span>
            <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-accent-cyan" />{t('Richiesta / risposta')}</span>
            <span className="inline-flex items-center gap-1.5"><StatusDot status="running" />{t('In esecuzione')}</span>
            <span className="inline-flex items-center gap-1.5"><StatusDot status="error" />{t('Errore')}</span>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-3 xl:grid-cols-12">
        {/* xl: h-0 + min-h-full -> the panel follows the log height instead of driving the row height */}
        <Card className="overflow-hidden xl:col-span-4 xl:h-0 xl:min-h-full">
          {!sel ? (
            <CardBody className="pt-4">{q.isPending ? <Skeleton className="h-96" /> : <p className="py-10 text-center text-sm text-slate-400">{t('Nessun agente selezionato')}</p>}</CardBody>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <DetailPanel sel={sel} now={now} onRun={() => run.mutate(sel.id)} running={run.isPending} runError={run.isError} tech={tech} />
            </div>
          )}
        </Card>
        <Card className="xl:col-span-8">
          <CardHeader title={t('Messaggi')} icon={<MessagesSquare />} subtitle={paused ? t('Scorrimento in pausa') : t('In tempo reale')}
            right={
              <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('Filtra per agente')}
                className="h-8 max-w-[11rem] rounded-md border border-line bg-bg px-2 text-xs sm:h-7 text-slate-300 focus:border-accent-blue/60 focus:outline-none">
                <option value="all">{t('Tutti gli agenti')}</option>
                {(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            } />
          <CardBody>
            <Terminal className="h-[440px]">
              <div ref={feedRef} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} className="absolute inset-0 overflow-y-auto py-1">
                {feed.length === 0 && <p className="px-3 py-2 text-sm text-slate-400">{t('In attesa dei primi messaggi…')}</p>}
                {feed.map((m) => <div key={m.id} className="flash-in"><LogLine m={m} byId={byId} showTopic={tech} /></div>)}
              </div>
            </Terminal>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
