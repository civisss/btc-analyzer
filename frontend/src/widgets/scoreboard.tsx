/* Tabellone Bull vs Bear: punti calcolati da regole dichiarate, la lunghezza della barra è la confidenza e non una previsione. */
import { useState } from 'react'
import { ChevronDown, Scale } from 'lucide-react'
import { useSbBacktest, useScoreboard, type Cat, type SbBacktest, type SbHorizon, type SbPoint, type Scoreboard } from '../api/scoreboard'
import { Card, CardBody, CardHeader, EmptyState, MethodNote, Q, Skeleton, clsx } from '../components/ui'
import { date, dateTime, pct } from '../lib/format'
import { t } from '../i18n'
import { T } from '../theme/tokens'
import { hhmm } from './stack'

const CAT_LABEL: Record<Cat, string> = { macro: 'Macro', politica: 'Politica', struttura: 'Struttura', flussi: 'Flussi', posizionamento: 'Posizionamento', altro: 'Altro' }
const CONF: Record<number, { label: string; w: string }> = { 1: { label: 'Bassa', w: 'w-12' }, 2: { label: 'Media', w: 'w-[72px]' }, 3: { label: 'Alta', w: 'w-24' } }
const COLLAPSED_PER_SIDE = 3

const Text = ({ p }: { p: SbPoint }) => <>{t(p.tpl, p.vars)}</>

function Bar({ p }: { p: SbPoint }) {
  const c = CONF[p.conf]
  return (
    <span className={clsx('inline-flex h-5 shrink-0 items-center justify-center rounded-sm text-2xs font-semibold uppercase tracking-[0.05em]', c.w, p.side === 'bull' ? 'bg-up' : 'bg-down')} style={{ color: T.bg }}>
      {t(c.label)}
    </span>
  )
}

/** Daily data carry a midnight stamp: the date alone, an hour would be invented. */
const stamp = (s: number) => (s % 86400 === 0 ? date(s, false) : dateTime(s))
const Meta = ({ p }: { p: SbPoint }) => <span className="block text-2xs text-fg-4">{p.source}{p.time ? ` · ${stamp(p.time)}` : ''}</span>

/** One point: the bar grows out of the central axis. On phones the row keeps its side and the text wraps under the bar. */
function Row({ p }: { p: SbPoint }) {
  const bull = p.side === 'bull'
  const copy = <div className={clsx('min-w-0 text-sm leading-snug text-fg-2', !bull && 'text-right')}><Text p={p} /><Meta p={p} /></div>
  return (
    <li className="sm:grid sm:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)]">
      {bull ? <div className="max-sm:hidden" /> : (
        <div className="flex min-w-0 items-end gap-1 max-sm:flex-col sm:items-center sm:justify-end sm:gap-3">
          <div className="sm:order-2"><Bar p={p} /></div>
          {copy}
        </div>
      )}
      <div className="hidden bg-line sm:block" />
      {bull ? (
        <div className="flex min-w-0 items-start gap-1 max-sm:flex-col sm:items-center sm:gap-3">
          <Bar p={p} />
          {copy}
        </div>
      ) : <div className="max-sm:hidden" />}
    </li>
  )
}

function Category({ cat, points, count, note }: { cat: Cat; points: SbPoint[]; count: { bull: number; bear: number }; note?: string }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-center gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <span className="tnum hidden text-right text-xs text-down sm:block">{count.bear || ''}</span>
        <h3 className="label">{t(CAT_LABEL[cat])}</h3>
        <span className="tnum hidden text-xs text-up sm:block">{count.bull || ''}</span>
      </div>
      {points.length
        ? <ul className="flex flex-col gap-2.5 sm:gap-2">{points.map((p) => <Row key={p.id} p={p} />)}</ul>
        : <p className="text-center text-xs text-fg-3">{note ?? t('Nessun punto oltre le soglie')}</p>}
    </section>
  )
}

/** Per-category balance of the collapsed card: red to the left, green to the right. */
function Strip({ d }: { d: Scoreboard }) {
  const max = Math.max(1, ...d.cats.map((c) => Math.max(d.by_cat[c].bull, d.by_cat[c].bear)))
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 lg:grid-cols-3 2xl:grid-cols-6">
      {d.cats.map((c) => {
        const v = d.by_cat[c]
        return (
          <div key={c} className="min-w-0">
            <div className="label mb-1 truncate">{t(CAT_LABEL[c])}</div>
            <div className="flex items-center gap-1.5">
              <span className="tnum w-4 text-right text-xs text-down">{v.bear}</span>
              <div className="flex h-1.5 min-w-0 flex-1">
                <div className="flex flex-1 justify-end rounded-l-full bg-white/[0.05]"><div className="rounded-l-full bg-down" style={{ width: `${(v.bear / max) * 100}%` }} /></div>
                <div className="w-px bg-fg-4" />
                <div className="flex-1 rounded-r-full bg-white/[0.05]"><div className="h-full rounded-r-full bg-up" style={{ width: `${(v.bull / max) * 100}%` }} /></div>
              </div>
              <span className="tnum w-4 text-xs text-up">{v.bull}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const sign2 = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}`

function HorizonRow({ h }: { h: SbHorizon }) {
  return (
    <tr>
      <td>{t('{n} giorni', { n: h.horizon })}</td>
      <td className="text-right">{sign2(h.ic)}</td>
      <td className="text-right">{sign2(h.ic_lo)} / {sign2(h.ic_hi)}</td>
      {h.groups.map((g) => <td key={g.group} className="text-right">{pct(g.mean, 1)}</td>)}
      <td className="text-right">{pct(h.base_mean, 1)}</td>
      <td className="text-right">{h.independent}</td>
    </tr>
  )
}

function Backtest({ b }: { b: SbBacktest }) {
  if (b.status !== 'ok') return <p className="text-xs text-fg-3">{t('Backtest non calcolabile: storico insufficiente.')}</p>
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-fg-2">
        {b.any_significant
          ? t('Il saldo mostra una relazione con i rendimenti successivi su almeno un orizzonte. Il campione è piccolo e le soglie non sono state validate fuori campione: non è un segnale.')
          : t('Nessun orizzonte mostra una relazione distinguibile da zero: il saldo descrive il presente, non ha anticipato i rendimenti.')}
      </p>
      <div className="overflow-x-auto">
        <table className="tbl tnum min-w-[560px]">
          <thead><tr><th>{t('Orizzonte')}</th><th className="text-right">IC</th><th className="text-right">{t('IC al 95%')}</th><th className="text-right">{t('Saldo basso')}</th><th className="text-right">{t('Saldo medio')}</th><th className="text-right">{t('Saldo alto')}</th><th className="text-right">{t('Tutti i giorni')}</th><th className="text-right">{t('Periodi indipendenti')}</th></tr></thead>
          <tbody>{b.horizons.map((h) => <HorizonRow key={h.horizon} h={h} />)}</tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-fg-3">
        {t('Periodo {a} → {b}, {n} giorni, da {x} a {y} regole valutabili su {r} con storico. Saldo = (bull − bear) / regole valutabili, ogni dato preso solo dal giorno in cui era pubblicato; rendimento dal giorno dopo. IC = correlazione di rango, intervallo da bootstrap a blocchi. Regole escluse perché senza storico: {o}. Le colonne Saldo sono i rendimenti medi per terzile.', {
          a: date(b.from), b: date(b.to), n: b.days, x: b.rules_min, y: b.rules_max, r: b.rules.length, o: (b.rules_live_only ?? []).length,
        })}
      </p>
    </div>
  )
}

function Method({ d }: { d: Scoreboard }) {
  const bt = useSbBacktest(true)
  const reason = { fred: 'Chiave FRED assente', data: 'Dato non disponibile', coverage: 'Raccolta insufficiente' } as const
  return (
    <div className="grid items-start gap-3 xl:grid-cols-2">
      <MethodNote title={t('Regole e soglie')}>
        <p>{t('Ogni punto nasce da una regola fissa. La confidenza dice quanto il dato supera la soglia, non quanto è probabile un movimento. I punti si contano e basta: nessuna ponderazione, nessuna previsione.')}</p>
        {d.cats.map((c) => (
          <div key={c}>
            <div className="label mb-1 mt-2">{t(CAT_LABEL[c])}</div>
            <ul className="flex flex-col gap-1">
              {d.rules.filter((r) => r.cat === c).map((r) => <li key={r.id}><span className="text-fg-2">{t(r.label)}</span> · {t(r.thr)} <span className="text-fg-4">{r.source}</span></li>)}
            </ul>
          </div>
        ))}
        {d.quiet.length > 0 && <p><span className="text-fg-2">{t('Entro le soglie, nessun punto')}:</span> {d.quiet.map((q) => t(q.label)).join(', ')}.</p>}
        {d.unavailable.length > 0 && <p><span className="text-fg-2">{t('Non valutate')}:</span> {d.unavailable.map((q) => `${t(q.label)} (${t(reason[q.reason ?? 'data'])})`).join(', ')}.</p>}
      </MethodNote>
      <MethodNote title={t('Backtest del saldo')}>
        <Q q={bt} compact loading={<Skeleton className="h-24" />}>{(b) => <Backtest b={b} />}</Q>
      </MethodNote>
    </div>
  )
}

export function ScoreboardCard() {
  const q = useScoreboard()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <Q q={q} loading={<div className="p-5"><Skeleton className="h-32" /></div>} isEmpty={(d) => !d.points.length} empty={t('Tabellone non disponibile')}>
          {(d) => {
            const top = (side: 'bull' | 'bear') => d.points.filter((p) => p.side === side).sort((a, b) => b.conf - a.conf).slice(0, COLLAPSED_PER_SIDE)
            const polyNote = d.polymarket.length ? t('Nessun mercato oltre le soglie') : t('Nessuna fonte verificabile al momento: solo probabilità pubbliche di Polymarket, niente notizie.')
            return (
              <>
                <CardHeader icon={<Scale />} accent="btc" title={t('Bull vs Bear')} subtitle={t('Aggiornato alle {t}. La lunghezza è la confidenza, non una previsione', { t: hhmm(d.time) })}
                  info={t('Punti calcolati da regole fisse sui dati macro, di struttura, di flusso e di posizionamento. Il conteggio descrive il quadro di oggi: non è un segnale operativo.')}
                  right={<div className="tnum flex items-baseline gap-4 text-xl font-semibold"><span className="text-up">Bull {d.bull}</span><span className="text-down">Bear {d.bear}</span></div>} />
                <CardBody className="flex flex-col gap-4 pt-0">
                  <Strip d={d} />
                  {open ? (
                    <div className="flex flex-col gap-4 border-t border-line pt-4">
                      {d.cats.map((c) => <Category key={c} cat={c} points={d.points.filter((p) => p.cat === c)} count={d.by_cat[c]} note={c === 'politica' ? polyNote : undefined} />)}
                    </div>
                  ) : (
                    <div className="grid gap-x-6 gap-y-2 border-t border-line pt-3 lg:grid-cols-2">
                      {(['bull', 'bear'] as const).map((s) => (
                        <ul key={s} className="flex min-w-0 flex-col gap-2">
                          {top(s).map((p) => (
                            <li key={p.id} className="flex min-w-0 items-center gap-2.5"><Bar p={p} /><span className="min-w-0 truncate text-sm text-fg-2" title={t(p.tpl, p.vars)}><Text p={p} /></span></li>
                          ))}
                          {!top(s).length && <EmptyState compact text={t('Nessun punto oltre le soglie')} />}
                        </ul>
                      ))}
                    </div>
                  )}
                  <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="link self-center">
                    <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
                    {open ? t('Mostra meno') : t('Mostra tutti i {n} punti', { n: d.points.length })}
                  </button>
                </CardBody>
              </>
            )
          }}
        </Q>
      </Card>
      {open && q.data && <Method d={q.data} />}
    </div>
  )
}
