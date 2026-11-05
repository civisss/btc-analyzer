import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Bell, BellRing, FlaskConical, History, ListChecks, Pencil, Plus, Sparkles, Timer, Zap } from 'lucide-react'
import { rulesApi, useAlertRules, useCustomAlertHistory, useRuleMutations, type AlertRule, type RulePreview } from '../api/alertRules'
import { live } from '../api/live'
import { Card, CardBody, CardHeader, KpiCell, KpiStrip, MethodNote, PageTitle, Q, Skeleton, clsx } from '../components/ui'
import { usePrice } from '../widgets/hooks'
import { DeleteButton, IconBtn, Switch } from '../widgets/forms'
import {
  RuleEditorHost, SEVERITY_META, STATUS_META, TYPE_META, fmtRuleValue, openRuleEditor, priceRulePrefill, reasonText, ruleSummary,
} from '../widgets/alertRules'
import { agoSeconds, dateTime, dayUnit, usd } from '../lib/format'
import { cap, t } from '../i18n'

/** seconds until `ts` (≥ 0), live-updating once per second */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), ms); return () => clearInterval(id) }, [ms])
  return now
}
const relAgo = (ts: number | null, now: number) => (ts == null ? '—' : now - ts < 45 ? t('Adesso') : agoSeconds(now - ts))

function Templates({ price }: { price: number | null }) {
  const p = price ?? 0
  const items: { label: string; open: () => void; icon: typeof Bell }[] = [
    { label: t('Prezzo sopra +2%'), icon: TYPE_META.price_cross.icon, open: () => openRuleEditor(priceRulePrefill(p * 1.02, p)) },
    { label: t('Prezzo sotto −2%'), icon: TYPE_META.price_cross.icon, open: () => openRuleEditor(priceRulePrefill(p * 0.98, p)) },
    { label: t('Movimento ±3% in 1 h'), icon: TYPE_META.pct_move.icon, open: () => openRuleEditor({ type: 'pct_move', params: { direction: 'any', pct: 3, window_min: 60 } }) },
    { label: t('Vicino al massimo del lunedì'), icon: TYPE_META.level_distance.icon, open: () => openRuleEditor({ type: 'level_distance', params: { level: 'monday_high', pct: 0.3 } }) },
    { label: t('RSI 4h sopra 70'), icon: TYPE_META.indicator.icon, open: () => openRuleEditor({ type: 'indicator', params: { metric: 'rsi_4h', op: 'above', value: 70 } }) },
    { label: t('Funding sopra 0.05%'), icon: TYPE_META.indicator.icon, open: () => openRuleEditor({ type: 'indicator', params: { metric: 'funding', op: 'above', value: 0.05 } }) },
    { label: t('Cambio zona del Cycle Score'), icon: TYPE_META.cycle_zone.icon, open: () => openRuleEditor({ type: 'cycle_zone', params: { zone: 'any' }, severity: 'info' }) },
    { label: t('Finestra pivot forte'), icon: TYPE_META.timepivot.icon, open: () => openRuleEditor({ type: 'timepivot', params: { min_confluence: 70, lead_days: 1 }, severity: 'info' }) },
    { label: t('Chiusura settimanale'), icon: TYPE_META.candle_close.icon, open: () => openRuleEditor({ type: 'candle_close', params: { tf: '1w', direction: 'above', price: Math.round(p * 1.03) } }) },
    { label: t('Liquidazioni ≥ $20M in 5 min'), icon: TYPE_META.liq_burst.icon, open: () => openRuleEditor({ type: 'liq_burst', params: { usd: 20_000_000, window_min: 5, side: 'any' }, severity: 'critical' }) },
  ]
  return (
    <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 sm:flex-wrap">
      {items.map((it) => (
        <button key={it.label} onClick={it.open} disabled={!price} className="chip chip-off disabled:opacity-40">
          <it.icon size={13} className="text-fg-4" />{it.label}
        </button>
      ))}
    </div>
  )
}

/** seconds to the next engine tick (rolled forward from the last check, the list is refetched every 20 s) */
function nextIn(r: AlertRule, now: number, tick: number): string {
  const base = r.last_checked ?? (r.next_check != null ? r.next_check - tick : null)
  if (base == null) return '—'
  const due = base + Math.max(1, Math.ceil((now - base) / tick)) * tick
  return t('Tra {s} s', { s: Math.max(1, Math.ceil(due - now)) })
}

function RuleRow({ r, now, onTest, test, testing, tick }: { r: AlertRule; now: number; onTest: () => void; test?: RulePreview | null; testing: boolean; tick: number }) {
  const { update, remove } = useRuleMutations()
  const M = TYPE_META[r.type]
  const st = STATUS_META[r.status]
  const sev = SEVERITY_META[r.severity]
  const toggle = (on: boolean) => update.mutate({ id: r.id, r: { enabled: on } })
  const next = r.status === 'active'
    ? (r.cooldown_until && r.cooldown_until > now ? t('Cooldown fino alle {h}', { h: dateTime(r.cooldown_until).split(' ').pop() }) : nextIn(r, now, tick))
    : r.status === 'expired' ? t('Scaduta il {d}', { d: dateTime(r.expires_at) }) : '—'
  return (
    <div className={clsx('border-t border-line-subtle px-4 py-3 first:border-t-0 sm:px-5', r.status !== 'active' && 'opacity-[0.78]')}>
      <div className="grid grid-cols-1 items-center gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto]">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-3 ring-1 ring-inset ring-line-subtle"><M.icon size={15} /></span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-white" title={r.name}>{r.name}</span>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: sev.hex }} title={t(sev.label)} />
            </div>
            <div className="truncate text-xs text-fg-3" title={ruleSummary(r)}>{cap(ruleSummary(r))}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-4">
              <span className="inline-flex items-center gap-1.5"><span className={clsx('h-1.5 w-1.5 rounded-full', st.dot, r.status === 'active' && 'live-dot')} />{t(st.label)}</span>
              <span>·</span><span>{r.repeat ? t('Ripetibile') : t('Una volta')}</span>
              <span>·</span><span>{t('Cooldown {c}', { c: r.cooldown_min < 60 ? `${r.cooldown_min} min` : r.cooldown_min < 1440 ? `${r.cooldown_min / 60} h` : `${r.cooldown_min / 1440} ${dayUnit()}` })}</span>
              {r.note && <><span>·</span><span className="max-w-[260px] truncate" title={r.note}>{r.note}</span></>}
            </div>
          </div>
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="label">{t('Valore attuale')}</div>
          <div className="tnum truncate text-sm text-fg">
            {fmtRuleValue(r.type, r.params, r.current.value)}
            {r.current.condition != null && <span className={clsx('ml-1.5 text-2xs', r.current.condition ? 'text-warn' : 'text-fg-4')}>{r.current.condition ? t('vera') : t('falsa')}</span>}
          </div>
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="label">{t('Ultimo avviso')}</div>
          <div className="tnum truncate text-sm text-fg" title={r.last_fired ? dateTime(r.last_fired) : undefined}>
            {r.last_fired ? relAgo(r.last_fired, now) : t('Mai')}{r.fire_count > 0 && <span className="ml-1.5 text-2xs text-fg-4">×{r.fire_count}</span>}
          </div>
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="label">{t('Prossimo controllo')}</div>
          <div className="tnum truncate text-sm text-fg-2">{next}</div>
        </div>
        <div className="flex items-center justify-start gap-1.5 sm:justify-end">
          <IconBtn icon={<FlaskConical size={14} />} label={t('Verifica ora')} onClick={onTest} active={!!test} disabled={testing} />
          <IconBtn icon={<Pencil size={14} />} label={t('Modifica')} onClick={() => openRuleEditor({ ...r })} />
          <DeleteButton compact onConfirm={() => remove.mutate(r.id)} busy={remove.isPending} />
          <Switch on={r.enabled && r.status !== 'expired'} onChange={toggle} label={r.enabled ? t('Metti in pausa') : t('Attiva')} disabled={update.isPending} />
        </div>
        {/* compact meta on phones / tablets */}
        <div className="tnum flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3 sm:col-span-2 lg:hidden">
          <span>{t('Valore')} <b className="font-medium text-fg">{fmtRuleValue(r.type, r.params, r.current.value)}</b></span>
          <span>{t('Ultimo avviso')} <b className="font-medium text-fg">{r.last_fired ? relAgo(r.last_fired, now) : t('Mai')}</b></span>
          <span>{next}</span>
        </div>
      </div>
      {test && (
        <div className={clsx('mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-3 py-2 text-xs ring-1 ring-inset', test.would_fire ? 'bg-warn/[0.07] ring-warn/20' : 'bg-white/[0.025] ring-line-subtle')}>
          <span className="tnum text-fg-2">{t('Valore')} <b className="font-medium text-white">{fmtRuleValue(r.type, r.params, test.value)}</b></span>
          {test.threshold != null && <span className="tnum text-fg-2">{t('Soglia')} <b className="font-medium text-white">{fmtRuleValue(r.type, r.params, test.threshold)}</b></span>}
          <span className={test.would_fire ? 'font-medium text-warn' : 'text-fg-3'}>{test.would_fire ? t('Scatterebbe ora') : t('Non scatterebbe ora')}</span>
          <span className="min-w-0 text-fg-3">{reasonText(test.reason)}</span>
        </div>
      )}
    </div>
  )
}

export default function AlertsPage() {
  const q = useAlertRules()
  const hq = useCustomAlertHistory()
  const price = usePrice()
  const now = useNow()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [tests, setTests] = useState<Record<string, RulePreview | null>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all')
  // a custom toast means a rule changed state (last fired / one-shot): refresh right away
  useEffect(() => live.onToast((a) => { if (a.category === 'custom') { qc.invalidateQueries({ queryKey: ['alertRules'] }); qc.invalidateQueries({ queryKey: ['alerts', 'custom'] }) } }), [qc])

  const items = q.data?.items ?? []
  const shown = items.filter((r) => filter === 'all' || (filter === 'active' ? r.status === 'active' : r.status !== 'active'))
  const active = items.filter((r) => r.status === 'active').length
  const hist = useMemo(() => (hq.data?.items ?? []).filter((a) => a.category === 'custom'), [hq.data])
  const today = hist.filter((a) => now - a.time < 86400).length
  const last = hist[0]
  const lastEval = q.data?.last_eval ?? null
  const runTest = async (id: string) => {
    if (tests[id]) { setTests((x) => ({ ...x, [id]: null })); return }
    setTesting(id)
    try { const r = await rulesApi.test(id); setTests((x) => ({ ...x, [id]: r })) } finally { setTesting(null) }
  }

  return (
    <div>
      <PageTitle title={t('Avvisi')} subtitle={t('Regole personali su prezzo, livelli e indicatori, controllate ogni 20 secondi. Strumento di analisi: nessun segnale operativo.')}
        right={<button className="btn-primary" onClick={() => openRuleEditor({})} disabled={!price}><Plus size={15} />{t('Nuovo avviso')}</button>} />
      <RuleEditorHost />

      <KpiStrip cols="grid-cols-2 xl:grid-cols-4">
        <KpiCell icon={<ListChecks />} accent="amber" label={t('Regole attive')} value={q.data ? `${active}` : '—'} foot={q.data ? t('{n} in totale', { n: items.length }) : null} />
        <KpiCell icon={<BellRing />} accent="amber" label={t('Avvisi nelle 24 h')} value={hq.data ? `${today}` : '—'} foot={hq.data ? t('{n} nello storico', { n: hist.length }) : null} />
        <KpiCell icon={<History />} accent="amber" label={t('Ultimo avviso')} value={last ? relAgo(last.time, now) : t('Nessuno')} foot={last ? last.title : t('Nessun avviso personale finora')} />
        <KpiCell icon={<Timer />} accent="amber" label={t('Motore avvisi')} value={lastEval ? (now - lastEval < 90 ? t('Attivo') : t('In ritardo')) : '—'}
          foot={lastEval ? t('Ultimo controllo {a}', { a: now - lastEval < 45 ? t('adesso') : agoSeconds(now - lastEval) }) : null} />
      </KpiStrip>

      <div className="mt-3 grid gap-3 2xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card>
            <CardHeader title={t('Crea rapidamente')} icon={<Sparkles />} accent="amber" subtitle={price ? t('Modelli precompilati sul prezzo live {p}', { p: usd(price) }) : t('In attesa del prezzo live…')} />
            <CardBody className="pt-0"><Templates price={price} /></CardBody>
          </Card>
          <Card>
            <CardHeader title={t('Le tue regole')} icon={<Bell />} accent="amber" updatedAt={q.dataUpdatedAt} interval={20_000}
              right={
                <div className="seg flex rounded-lg p-0.5">
                  {(['all', 'active', 'inactive'] as const).map((f) => (
                    <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                      className={clsx('h-8 rounded-lg px-2.5 text-xs font-medium sm:h-6', filter === f ? 'seg-pill text-white' : 'text-fg-3 hover:text-white')}>
                      {f === 'all' ? t('Tutte') : f === 'active' ? t('Attive') : t('Non attive')}
                    </button>
                  ))}
                </div>
              } />
            <div className="pb-2">
              <Q q={q} loading={<div className="px-5 pb-4"><Skeleton className="h-40" /></div>} isEmpty={() => false}>
                {() => shown.length ? (
                  <div>{shown.map((r) => <RuleRow key={r.id} r={r} now={now} tick={q.data?.tick_s ?? 20} onTest={() => runTest(r.id)} test={tests[r.id]} testing={testing === r.id} />)}</div>
                ) : (
                  <div className="mx-4 mb-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-10 text-center sm:mx-5">
                    <Bell size={18} className="text-fg-4" />
                    <p className="max-w-sm text-sm text-fg-2">{items.length ? t('Nessuna regola in questo filtro.') : t('Nessun avviso personale. Creane uno da un modello qui sopra, dal grafico o dalla tabella dei livelli.')}</p>
                  </div>
                )}
              </Q>
            </div>
          </Card>
        </div>
        <Card className="2xl:max-h-[calc(100vh-160px)]">
          <CardHeader title={t('Storico')} icon={<Zap />} accent="amber" subtitle={t('Avvisi personali e revisioni del diario')} updatedAt={hq.dataUpdatedAt} interval={30_000} />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
            <Q q={hq} loading={<div className="px-5 pb-4"><Skeleton className="h-60" /></div>} isEmpty={() => false}>
              {() => !hist.length ? (
                // dashed "empty well" filling the card: same treatment as the empty rules list, no blank band around a floating line
                <div className="mx-4 mb-2 flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-10 text-center sm:mx-5">
                  <History size={18} className="text-fg-4" />
                  <p className="max-w-xs text-sm text-fg-2">{t('Ancora nessun avviso personale.')}</p>
                  <p className="max-w-xs text-xs text-fg-4">{t('Qui compaiono gli avvisi scattati e le revisioni del diario, dal più recente.')}</p>
                </div>
              ) : (
                <div>
                  {hist.map((a) => {
                    const sev = SEVERITY_META[a.severity] ?? SEVERITY_META.info
                    return (
                      <button key={a.id} onClick={() => a.link && nav(a.link)} className="flex w-full gap-3 border-t border-line-subtle px-4 py-2.5 text-left transition-colors first:border-t-0 hover:bg-white/[0.03] sm:px-5">
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: sev.hex, boxShadow: `0 0 8px ${sev.hex}99` }} title={t(sev.label)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate text-sm font-medium text-fg">{a.title}</span>
                            <span className="tnum shrink-0 text-2xs text-fg-4" title={dateTime(a.time)}>{relAgo(a.time, now)}</span>
                          </span>
                          {a.text && <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-3">{cap(a.text)}</span>}
                          <span className="mt-1 flex items-center gap-1.5 text-2xs text-fg-4">
                            <span>{t('Avvisi personali')}</span>
                            {a.silent && <span className="text-fg-off">· {t('Solo storico')}</span>}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </Q>
          </div>
        </Card>
      </div>

      <MethodNote className="mt-3">
        <p>{t('Ogni regola descrive una condizione. L’avviso scatta quando la condizione diventa vera; se è già vera al salvataggio, scatta al primo controllo. Una regola ripetibile si riarma solo dopo che la condizione è tornata falsa e il cooldown è trascorso; una regola “una volta” si disattiva dopo il primo avviso.')}</p>
        <p>{t('Le regole a evento (cambio di zona del Cycle Score, finestra pivot, chiusura di candela) considerano solo gli eventi successivi al salvataggio. I valori arrivano dagli stessi moduli delle altre pagine: prezzo Binance live, RSI 14 sulle candele spot, funding e open interest Binance, Fear & Greed alternative.me, liquidazioni raccolte in tempo reale.')}</p>
        <p>{t('Gli avvisi compaiono come notifiche e nella campanella (categoria “Avvisi personali”, silenziabile). Oltre 6 notifiche non critiche in 10 minuti finiscono solo nello storico. Le regole sono salvate sul server e sopravvivono ai riavvii.')}</p>
      </MethodNote>
    </div>
  )
}
