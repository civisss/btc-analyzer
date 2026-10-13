import { useMemo, useState } from 'react'
import { CalendarClock, Compass, Gauge, GitCompareArrows, History, Layers, LineChart, ShieldCheck, Sigma, Spline, Target, TrendingUp, Waypoints } from 'lucide-react'
import { useForecastV2, type EvalModelKey, type ForecastMetrics, type ForecastV2 } from '../api/forecastV2'
import {
  Badge, Card, CardBody, CardHeader, Change, Fill, KpiCell, KpiStrip, MethodNote, PageTitle, ProgressBar, Q, Section, Segmented, Skeleton, Toggle, ToneBadge, clsx,
} from '../components/ui'
import { CalibrationChart, DriverBars, ForecastPathChart, MEMBER_COLOR, MEMBER_ORDER, MEMBER_SHORT, WeightsByHorizon, cycleColor } from '../widgets/forecast'
import { cap, t } from '../i18n'
import { date, dateTime, dayUnit, usd, usdCompact } from '../lib/format'

type Num = number | null | undefined
const fin = (v: Num): v is number => v != null && Number.isFinite(v)
const p0 = (v: Num, d = 0) => (fin(v) ? `${v.toFixed(d)}%` : '—')
const x2 = (v: Num) => (fin(v) ? v.toFixed(2) : '—')
/** $68.9K → $69K (short ranges for tiles) */
const k0 = (v: Num) => (fin(v) ? (v >= 1e6 ? usdCompact(v, 1) : `$${Math.round(v / 1000)}K`) : '—')
const VIEW_HORIZONS = [30, 90, 180, 365]
const EVAL_HORIZONS = [7, 30, 60, 90, 180, 365]
const TONE: Record<string, string> = { bull: 'bullish', bear: 'bearish', accumulation: 'neutral' }

/** MASE colour: below 0.95 clearly better than the random walk, around 1 = no edge. */
const maseCls = (v: Num) => (!fin(v) ? 'text-slate-400' : v <= 0.9 ? 'text-up' : v < 0.97 ? 'text-slate-100' : v > 1.03 ? 'text-down' : 'text-slate-300')

function ProbBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className="relative h-1 w-16 rounded-full bg-white/[0.08]" title={t('Tacca = 50%')}>
      <div className={clsx('h-full rounded-full', v >= 50 ? 'bg-up/80' : 'bg-down/80')} style={{ width: `${v}%` }} />
      <span className="absolute -top-1 left-1/2 h-3 w-px bg-slate-500" />
    </div>
  )
}

function Cell({ k, v, sub, className }: { k: React.ReactNode; v: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0 px-3 py-2.5', className)}>
      <div className="label truncate">{k}</div>
      <div className="tnum mt-1 truncate text-xl font-semibold text-white">{v}</div>
      <div className="tnum mt-0.5 truncate text-xs text-slate-400">{sub ?? <span className="text-slate-600">—</span>}</div>
    </div>
  )
}

// ------------------------------------------------------------------ posizione nel ciclo (backend texts arrive already translated)
function speedLine(d: ForecastV2): string | null {
  const ts = d.cycle_model.time_scale
  if (!ts || !ts.past.length) return null
  const avg = ts.past.reduce((s, x) => s + x.days, 0) / ts.past.length
  const diff = (1 - ts.current_days / avg) * 100
  if (Math.abs(diff) < 3) return t('Ciclo in linea con la velocità media dei cicli passati')
  return diff > 0 ? t('Ciclo più veloce del {p}% rispetto alla media', { p: diff.toFixed(0) }) : t('Ciclo più lento del {p}% rispetto alla media', { p: (-diff).toFixed(0) })
}

function PositionCard({ d }: { d: ForecastV2 }) {
  const cm = d.cycle_model
  const ts = cm.time_scale
  const avg = ts && ts.past.length ? ts.past.reduce((s, x) => s + x.days, 0) / ts.past.length : null
  const speed = speedLine(d)
  return (
    <Card>
      <CardHeader title={t('Posizione nel ciclo')} icon={<Compass />} subtitle={cap(t(cap(cm.position.phase_label)))}
        right={<ToneBadge tone={TONE[d.regime.key] ?? 'neutral'} label={t(d.regime.label)} />} />
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="label mb-1.5">{t('Àncore del modello')}</div>
          {cm.anchors.map((a) => (
            <div key={a.key} className="border-t border-line py-2 first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-slate-200">{t(cap(a.label))}</span>
                <span className="tnum font-semibold text-white">{a.days} {dayUnit()}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <ProgressBar value={a.weight} color={C_ANCHOR[a.key]} className="h-1 min-w-[48px] flex-1" />
                <span className="tnum shrink-0 whitespace-nowrap text-right text-2xs text-slate-400">{t('peso {p}% · {d}', { p: a.weight.toFixed(0), d: date(a.event_time) })}</span>
              </div>
            </div>
          ))}
        </div>
        {ts && avg != null && (
          <div className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="label">{t('Velocità del ciclo')} · {t(ts.segment)}</div>
            <div className="mt-1 text-sm font-semibold text-white">{speed}</div>
            <div className="tnum mt-0.5 text-xs text-slate-400">{t('{a} giorni oggi contro {b} in media ({n} cicli)', { a: ts.current_days, b: Math.round(avg), n: ts.past.length })}</div>
            <div className="tnum mt-1 text-2xs text-slate-500">{t('Riscalatura con esponente')} {ts.gammas.map((g) => `${g.gamma === 0.5 ? '½' : g.gamma} (${(g.weight * 100).toFixed(0)}%)`).join(' · ')}</div>
          </div>
        )}
        <div className="dgrid -mx-1 grid-cols-2">
          <Cell k={t('Giorni dall\'halving')} v={fin(cm.position.days_since_halving) ? `${cm.position.days_since_halving} ${dayUnit()}` : '—'} sub={t('Prossimo ≈ {d}', { d: date(cm.position.next_halving_est) })} />
          <Cell k={t('Multiplo di Mayer')} v={x2(d.regime.indicators.mayer)} sub={fin(d.regime.indicators.dd_ath) ? t('{p} dal massimo storico', { p: `${(d.regime.indicators.dd_ath * 100).toFixed(0)}%` }) : undefined} />
        </div>
      </CardBody>
    </Card>
  )
}
const C_ANCHOR = { top: '#EF5466', bottom: '#2EBD85', halving: '#E8B04B' } as const

function CyclesCard({ d, n }: { d: ForecastV2; n: number }) {
  const cycles = d.cycle_model.cycles.slice(0, n)
  const maxW = Math.max(...cycles.map((c) => c.weight), 1)
  return (
    <Card className="flex-1">
      <CardHeader title={t('Cicli passati allineati')} icon={<Waypoints />} subtitle={t('Riscalati sul prezzo di oggi · peso e similarità di stato')} />
      <CardBody className="flex flex-col">
        {cycles.map((c, i) => (
          <div key={c.key} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5 border-t border-line py-2 first:border-t-0 first:pt-0" title={t('Velocità ×{a} · ampiezza ×{b}', { a: c.time_scale.toFixed(2), b: c.amplitude_scale.toFixed(2) })}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: cycleColor(i, c.weight, maxW) }} />
            <div className="min-w-0">
              <div className="truncate text-sm text-slate-200">{c.label}</div>
              <div className="tnum text-2xs text-slate-500">{t('Similarità {n}/100', { n: c.similarity.toFixed(0) })} · {t('dopo 1 anno')} <Change value={c.return_365} digits={0} className="text-2xs" /></div>
            </div>
            <span className="tnum text-sm font-semibold text-white">{c.weight.toFixed(0)}%</span>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ orizzonti
function HorizonsTable({ d }: { d: ForecastV2 }) {
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[980px]">
        <thead><tr>
          <th className="pl-4 sm:pl-5">{t('Orizzonte')}</th><th>{t('Data')}</th><th className="text-right">{t('Mediana')}</th><th className="text-right">{t('Variazione')}</th>
          <th className="text-right">{t('Range 50%')}</th><th className="text-right">{t('Range 90%')}</th><th>{t('Prob. rialzo')}</th><th>{t('Pesi dei modelli')}</th>
          <th className="text-right">{t('Direzione')}</th><th className="text-right" title={t('MASE < 1 = batte il random walk')}>MASE</th><th className="pr-4 text-right sm:pr-5">{t('Copertura 90%')}</th>
        </tr></thead>
        <tbody>
          {d.horizons.map((h) => (
            <tr key={h.days}>
              <td className="pl-4 font-medium text-white sm:pl-5">{t('{n} giorni', { n: h.days })}</td>
              <td className="text-slate-300">{date(h.time)}</td>
              <td className="text-right font-medium text-white">{usd(h.median)}</td>
              <td className="text-right"><Change value={h.change_pct} digits={1} /></td>
              <td className="text-right text-slate-300">{usdCompact(h.p25, 1)} – {usdCompact(h.p75, 1)}</td>
              <td className="text-right text-slate-300">{usdCompact(h.p05, 1)} – {usdCompact(h.p95, 1)}</td>
              <td><div className="flex items-center gap-2"><ProbBar value={h.up_prob} /><span className="tnum text-white">{h.up_prob.toFixed(0)}%</span></div></td>
              <td>
                <div className="flex h-2 w-32 overflow-hidden rounded-full bg-white/[0.05]" title={MEMBER_ORDER.map((k) => `${t(MEMBER_SHORT[k])} ${(h.weights[k] ?? 0).toFixed(0)}%`).join(' · ')}>
                  {MEMBER_ORDER.map((k) => <span key={k} style={{ width: `${h.weights[k] ?? 0}%`, background: MEMBER_COLOR[k] }} />)}
                </div>
              </td>
              <td className="text-right text-slate-300">{p0(h.backtest.hit_rate)}</td>
              <td className={clsx('text-right font-medium', maseCls(h.backtest.mase))}>{x2(h.backtest.mase)}</td>
              <td className="pr-4 text-right text-slate-300 sm:pr-5">{p0(h.backtest.coverage_90)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ valutazione
function verdict(d: ForecastV2) {
  const m = (h: number) => d.evaluation.horizons.find((x) => x.horizon === h)?.models.find((x) => x.key === 'ensemble')?.test
  const shortM = [7, 30, 60].map((h) => m(h)?.mase).filter(fin)
  const lo = shortM.length ? Math.min(...shortM) : null
  const hi = shortM.length ? Math.max(...shortM) : null
  const a = m(180), b = m(365)
  return {
    short: t('Da 7 a 60 giorni la previsione non ha un vero vantaggio direzionale: l\'errore della mediana è in linea con il random walk (MASE {a}–{b}) e la probabilità di rialzo non batte la frequenza storica. Usala come intervallo di prezzo plausibile, non come segnale.', { a: x2(lo), b: x2(hi) }),
    long: t('A 180 e 365 giorni la posizione nel ciclo batte le baseline ingenue (MASE {a} e {b}, direzione corretta {c} e {d}), ma poggia su circa 3 cicli con finestre sovrapposte: i casi davvero indipendenti sono pochi.', { a: x2(a?.mase), b: x2(b?.mase), c: p0(a?.hit_rate), d: p0(b?.hit_rate) }),
  }
}

const MODEL_NAME: Record<EvalModelKey, string> = {
  ensemble: 'Insieme v2 calibrato', cycle: 'Posizione nel ciclo', lgb: 'LightGBM a quantili', mc: 'Monte Carlo per regimi', rw0: 'Random walk (deriva zero)',
  rw_drift: 'Random walk con deriva storica', previous: 'Versione precedente (v1)',
}

function EvalTable({ rows, sel }: { rows: { key: EvalModelKey; kind: string; m: ForecastMetrics }[]; sel?: EvalModelKey }) {
  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
      <table className="tbl min-w-[640px]">
        <thead><tr>
          <th className="pl-4 sm:pl-5">{t('Modello')}</th><th className="text-right">n</th><th className="text-right">{t('Direzione')}</th>
          <th className="text-right" title={t('MASE < 1 = batte il random walk')}>MASE</th><th className="text-right">{t('Errore mediana')}</th>
          <th className="text-right">{t('Copertura 50%')}</th><th className="text-right">{t('Copertura 90%')}</th><th className="pr-4 text-right sm:pr-5" title={t('Miglioramento del Brier di P(rialzo) rispetto alla frequenza storica')}>{t('Brier skill')}</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={clsx(r.key === sel && '[&>td]:bg-white/[0.035]')}>
              <td className="pl-4 sm:pl-5">
                <span className={clsx(r.key === 'ensemble' ? 'font-semibold text-white' : 'text-slate-200')}>{t(MODEL_NAME[r.key] ?? r.key)}</span>
                {r.kind === 'baseline' && <span className="ml-1.5 text-2xs text-slate-500">{t('baseline')}</span>}
              </td>
              <td className="text-right text-slate-400">{r.m.n}</td>
              <td className="text-right text-slate-300">{p0(r.m.hit_rate)}</td>
              <td className={clsx('text-right font-medium', maseCls(r.m.mase))}>{x2(r.m.mase)}</td>
              <td className="text-right text-slate-300">{p0(r.m.mape, 1)}</td>
              <td className="text-right text-slate-300">{p0(r.m.coverage_50)}</td>
              <td className="text-right text-slate-300">{p0(r.m.coverage_90)}</td>
              <td className={clsx('pr-4 text-right sm:pr-5', fin(r.m.brier_skill) && r.m.brier_skill > 2 ? 'text-up' : fin(r.m.brier_skill) && r.m.brier_skill < -2 ? 'text-down' : 'text-slate-300')}>
                {fin(r.m.brier_skill) ? `${r.m.brier_skill > 0 ? '+' : ''}${r.m.brier_skill.toFixed(1)}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReliabilitySection({ d }: { d: ForecastV2 }) {
  const [h, setH] = useState(90)
  const [win, setWin] = useState<'test' | 'last12'>('test')
  const ev = d.evaluation.horizons.find((x) => x.horizon === h) ?? d.evaluation.horizons[0]
  const cal = d.calibration.horizons.find((x) => x.horizon === h)
  const v = verdict(d)
  const hOpts = EVAL_HORIZONS.filter((x) => d.evaluation.horizons.some((e) => e.horizon === x)).map((x) => ({ value: x, label: `${x}${dayUnit()}` }))
  const rows = ev.models.map((m) => ({ key: m.key, kind: m.kind, m: win === 'test' ? m.test : m.last12 }))
  const cbc = d.evaluation.cycle_by_cycle
  return (
    <Section title={t('Quanto è affidabile')} subtitle={t('Valutazione fuori campione dal {d} · confronto onesto con le baseline', { d: date(d.evaluation.test_from) })}>
      <Card>
        <CardHeader title={t('In breve')} icon={<ShieldCheck />} subtitle={t('MASE = errore della mediana diviso quello del random walk: sotto 1 la previsione batte il caso')} />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-x-8 gap-y-2 text-sm leading-relaxed text-slate-300 lg:grid-cols-2">
            <p className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />{v.short}</p>
            <p className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-up" />{v.long}</p>
          </div>
          <div className="dgrid -mx-1 grid-cols-2 sm:grid-cols-3 2xl:grid-cols-6">
            {d.evaluation.horizons.map((e) => {
              const m = e.models.find((x) => x.key === 'ensemble')?.test
              const beats = fin(m?.mase) && m!.mase! <= 0.9
              return (
                <button key={e.horizon} type="button" onClick={() => setH(e.horizon)}
                  className={clsx('min-w-0 px-3 py-2.5 text-left transition-colors', e.horizon === h ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="label">{t('{n} giorni', { n: e.horizon })}</span>
                    <Badge color={beats ? 'up' : 'slate'}>{beats ? t('Batte le baseline') : t('≈ random walk')}</Badge>
                  </div>
                  <div className={clsx('tnum mt-1 text-xl font-semibold', maseCls(m?.mase))}>MASE {x2(m?.mase)}</div>
                  <div className="tnum mt-0.5 truncate text-xs text-slate-400">{t('Direzione {a} · copertura 90% {b}', { a: p0(m?.hit_rate), b: p0(m?.coverage_90) })}</div>
                </button>
              )
            })}
          </div>
        </CardBody>
      </Card>

      {/* side by side only from 2xl: the 8-column comparison table needs the width */}
      <div className="grid gap-3 2xl:grid-cols-12">
        <Card className="2xl:col-span-7">
          <CardHeader title={t('Confronto con le baseline')} icon={<GitCompareArrows />} subtitle={ev.summary}
            right={<>
              <Segmented value={win} onChange={setWin} options={[{ value: 'test', label: t('4 anni') }, { value: 'last12', label: t('Ultimi 12 mesi') }]} />
              <Segmented value={h} onChange={setH} options={hOpts} />
            </>} />
          <CardBody className="flex flex-col gap-4">
            <EvalTable rows={rows} sel="ensemble" />
            {win === 'last12' && <p className="text-xs text-slate-400">{t('Ultimi 12 mesi: pochi casi indipendenti, soprattutto oltre i 90 giorni — numeri molto rumorosi.')}</p>}
            <div>
              <div className="label mb-1">{t('Per regime di mercato')} · MASE</div>
              <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
                <table className="tbl min-w-[480px]">
                  <thead><tr><th className="pl-4 sm:pl-5">{t('Regime')}</th><th className="text-right">n</th><th className="text-right">{t('Insieme')}</th><th className="text-right">{t('Ciclo')}</th><th className="text-right">{t('Random walk')}</th><th className="pr-4 text-right sm:pr-5">{t('Direzione')}</th></tr></thead>
                  <tbody>
                    {ev.by_regime.map((r) => (
                      <tr key={r.regime} className={clsx(r.regime === d.regime.key && '[&>td]:bg-white/[0.035]')}>
                        <td className="pl-4 text-slate-200 sm:pl-5">{cap(t(r.label))}{r.regime === d.regime.key && <span className="ml-1.5 text-2xs text-slate-400">{t('oggi')}</span>}</td>
                        <td className="text-right text-slate-400">{r.ensemble.n}</td>
                        <td className={clsx('text-right font-medium', maseCls(r.ensemble.mase))}>{x2(r.ensemble.mase)}</td>
                        <td className={clsx('text-right', maseCls(r.cycle.mase))}>{x2(r.cycle.mase)}</td>
                        <td className="text-right text-slate-400">{x2(r.rw0.mase)}</td>
                        <td className="pr-4 text-right text-slate-300 sm:pr-5">{p0(r.ensemble.hit_rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="2xl:col-span-5">
          <CardHeader title={t('Calibrazione di P(rialzo)')} icon={<Target />} subtitle={t('Orizzonte {n} giorni · punti sulla diagonale = probabilità affidabili', { n: h })} info={d.calibration.method} />
          <CardBody className="flex flex-col gap-3">
            <Fill min={260}>{cal ? <CalibrationChart buckets={cal.buckets} /> : null}</Fill>
            <div className="dgrid -mx-1 grid-cols-3">
              <Cell k="ECE" v={fin(cal?.ece) ? `${cal!.ece!.toFixed(1)} pt` : '—'} sub={t('Scarto medio')} />
              <Cell k="Brier" v={fin(cal?.brier) ? cal!.brier!.toFixed(3) : '—'} sub={t('Storico {v}', { v: fin(cal?.brier_clim) ? cal!.brier_clim!.toFixed(3) : '—' })} />
              <Cell k={t('Brier skill')} v={fin(cal?.brier_skill) ? `${cal!.brier_skill! > 0 ? '+' : ''}${cal!.brier_skill!.toFixed(1)}%` : '—'} sub={t('vs frequenza storica')} />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title={t('Ciclo per ciclo')} icon={<History />} subtitle={t('Ogni ciclo previsto usando solo i cicli precedenti · MASE (random walk = 1.00)')} />
        <CardBody className="flex flex-col gap-3">
          <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
            <table className="tbl min-w-[720px]">
              <thead><tr>
                <th className="pl-4 sm:pl-5">{t('Orizzonte')}</th><th>{t('Ciclo')}</th><th className="text-right">n</th>
                <th className="text-right">{t('Posizione nel ciclo')}</th><th className="text-right">{t('Insieme')}</th><th className="text-right">{t('Random walk con deriva')}</th>
                <th className="text-right">{t('Direzione (insieme)')}</th><th className="pr-4 text-right sm:pr-5">{t('Copertura 90%')}</th>
              </tr></thead>
              <tbody>
                {cbc.map((r, i) => (
                  <tr key={`${r.horizon}-${r.label}`} className={clsx(i > 0 && cbc[i - 1].horizon !== r.horizon && '[&>td]:border-t [&>td]:border-white/10')}>
                    <td className="pl-4 text-slate-200 sm:pl-5">{i === 0 || cbc[i - 1].horizon !== r.horizon ? t('{n} giorni', { n: r.horizon }) : ''}</td>
                    <td className="text-slate-300">{r.label}</td>
                    <td className="text-right text-slate-400">{r.ensemble.n}</td>
                    <td className={clsx('text-right', maseCls(r.cycle.mase))}>{x2(r.cycle.mase)}</td>
                    <td className={clsx('text-right font-medium', maseCls(r.ensemble.mase))}>{x2(r.ensemble.mase)}</td>
                    <td className={clsx('text-right', maseCls(r.rw_drift.mase))}>{x2(r.rw_drift.mase)}</td>
                    <td className="text-right text-slate-300">{p0(r.ensemble.hit_rate)}</td>
                    <td className="pr-4 text-right text-slate-300 sm:pr-5">{p0(r.ensemble.coverage_90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">{t('I risultati a 180 e 365 giorni poggiano su circa 3 cicli passati con finestre sovrapposte: i campioni effettivi sono molti meno di n.')}</p>
        </CardBody>
      </Card>
    </Section>
  )
}

// ------------------------------------------------------------------ come nasce
function HowSection({ d }: { d: ForecastV2 }) {
  const keys = (['7', '30', '60', '90'] as const).filter((k) => d.drivers[k])
  const [dh, setDh] = useState<(typeof keys)[number]>(keys.includes('30') ? '30' : keys[0])
  const dr = d.drivers[dh]
  const groups = dr ? [...dr.groups].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 6) : []
  return (
    <Section title={t('Come nasce la previsione')} subtitle={t('Quattro modelli combinati con pesi diversi per orizzonte, poi bande calibrate sugli errori passati')}>
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-5">
          <CardHeader title={t('Pesi dei modelli per orizzonte')} icon={<Layers />} subtitle={t('Pesi scelti sugli errori fuori campione degli ultimi 4 anni')} />
          <CardBody className="flex flex-col gap-4">
            <WeightsByHorizon d={d} className="flex-1" />
            <div className="flex flex-col">
              {MEMBER_ORDER.map((k) => {
                const m = d.models.find((x) => x.key === k)
                if (!m) return null
                return (
                  <div key={k} className="flex gap-2.5 border-t border-line py-2">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-sm" style={{ background: MEMBER_COLOR[k] }} />
                    <div className="min-w-0">
                      <div className="text-sm text-slate-200">{t(m.name)}</div>
                      <p className="line-clamp-2 text-xs text-slate-400" title={m.note}>{m.note}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardBody>
        </Card>
        <Card className="xl:col-span-7">
          <CardHeader title={t('Cosa muove il modello ML')} icon={<Sigma />}
            subtitle={dr ? t('Contributi alla mediana LightGBM a {n} giorni · peso nell\'insieme {w}%', { n: dr.horizon, w: dr.lgb_weight.toFixed(0) }) : undefined}
            right={<Segmented value={dh} onChange={setDh} options={keys.map((k) => ({ value: k, label: `${k}${dayUnit()}` }))} />} />
          {dr && (
            <CardBody className="flex flex-col gap-4">
              <div className="dgrid -mx-1 grid-cols-3">
                <Cell k={t('Rendimento di base')} v={<Change value={dr.baseline} digits={1} />} sub={t('Media storica del modello')} />
                <Cell k={t('Mediana LightGBM')} v={<Change value={dr.lgb_median} digits={1} />} sub={t('Base + contributi')} />
                <Cell k={t('Peso nell\'insieme')} v={`${dr.lgb_weight.toFixed(0)}%`} sub={t('A {n} giorni', { n: dr.horizon })} />
              </div>
              <DriverBars top={dr.top} />
              <div className="flex flex-wrap gap-1.5">
                {groups.map((g) => (
                  <span key={g.group} className="inline-flex h-7 items-center gap-1.5 rounded border border-line px-2 text-xs text-slate-300">
                    {cap(t(g.group))}<b className={clsx('tnum font-medium', g.contribution >= 0 ? 'text-up' : 'text-down')}>{g.contribution >= 0 ? '+' : '−'}{Math.abs(g.contribution).toFixed(1)}%</b>
                  </span>
                ))}
              </div>
            </CardBody>
          )}
        </Card>
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ pagina
function Body({ d, updatedAt }: { d: ForecastV2; updatedAt: number }) {
  const [h, setH] = useState(365)
  const [showCycles, setShowCycles] = useState(true)
  const N_CYCLES = 6
  const cycles = useMemo(() => (showCycles ? d.cycle_model.cycles.slice(0, N_CYCLES) : []), [d, showCycles])
  const hz = (n: number) => d.horizons.find((x) => x.days === n)
  const sel = hz(h)
  const k = (n: number) => {
    const x = hz(n)
    return x ? { value: usd(x.median), delta: <Change value={x.change_pct} digits={1} />, foot: t('90%: {a}–{b}', { a: k0(x.p05), b: k0(x.p95) }) } : { value: '—' }
  }
  const h365 = hz(365)
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <KpiCell accent icon={<TrendingUp />} label={t('Prezzo attuale')} value={usd(d.last_price)} foot={t('Regime {r}', { r: t(d.regime.label).toLowerCase() })} />
        <KpiCell icon={<CalendarClock />} label={t('Mediana a {n} giorni', { n: 30 })} {...k(30)} />
        <KpiCell icon={<CalendarClock />} label={t('Mediana a {n} giorni', { n: 90 })} {...k(90)} />
        <KpiCell icon={<CalendarClock />} label={t('Mediana a {n} giorni', { n: 180 })} {...k(180)} />
        <KpiCell icon={<CalendarClock />} label={t('Mediana a {n} giorni', { n: 365 })} {...k(365)} />
        <KpiCell icon={<Gauge />} label={t('Prob. rialzo a 1 anno')} value={h365 ? `${h365.up_prob.toFixed(0)}%` : '—'} foot={cap(t(cap(d.cycle_model.position.phase_label)))} />
      </KpiStrip>

      {/* hero: the path chart grows to the height of the cycle column */}
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-8 2xl:col-span-9">
          <CardHeader title={t('Percorso previsto')} icon={<LineChart />} updatedAt={updatedAt}
            subtitle={t('Mediana con bande 50% e 90% · tratteggio = cicli passati riscalati sul prezzo di oggi')}
            right={<>
              <Toggle on={showCycles} onClick={() => setShowCycles(!showCycles)} color={C_BLUE}>{t('Cicli passati')}</Toggle>
              <Segmented value={h} onChange={setH} options={VIEW_HORIZONS.map((n) => ({ value: n, label: `${n}${dayUnit()}` }))} />
            </>} />
          <CardBody className="flex flex-col gap-3">
            <Fill min={420}><ForecastPathChart d={d} horizon={h} cycles={cycles} /></Fill>
            {sel && (
              <div className="dgrid -mx-1 grid-cols-2 md:grid-cols-4">
                <Cell k={t('Mediana a {n} giorni', { n: h })} v={usd(sel.median)} sub={<Change value={sel.change_pct} digits={1} suffix={t('al {d}', { d: date(sel.time) })} />} />
                <Cell k={t('Range 50%')} v={`${k0(sel.p25)}–${k0(sel.p75)}`} sub={t('Metà dei casi')} />
                <Cell k={t('Range 90%')} v={`${k0(sel.p05)}–${k0(sel.p95)}`} sub={t('9 casi su 10')} />
                <Cell k={t('Prob. rialzo')} v={`${sel.up_prob.toFixed(0)}%`} sub={t('Prezzo sopra quello di oggi')} />
              </div>
            )}
            <p className="text-sm leading-relaxed text-slate-300">{d.cycle_model.position.text}</p>
          </CardBody>
        </Card>
        <div className="flex flex-col gap-3 xl:col-span-4 2xl:col-span-3">
          <PositionCard d={d} />
          <CyclesCard d={d} n={N_CYCLES} />
        </div>
      </div>

      <Card>
        <CardHeader title={t('Orizzonti')} icon={<Spline />} subtitle={t('Da 7 giorni a 1 anno · ultime tre colonne: risultati fuori campione dello stesso orizzonte')} />
        <CardBody className="pt-0"><HorizonsTable d={d} /></CardBody>
      </Card>

      <HowSection d={d} />
      <ReliabilitySection d={d} />

      <p className="text-xs text-slate-400">{t('Stime statistiche su dati storici. Non è consulenza finanziaria.')}</p>
      <MethodNote>
        <p>{d.cycle_model.method}</p>
        <p>{d.evaluation.note}</p>
        <p>{d.calibration.method}</p>
        <p>{d.disclaimer}</p>
        <p>{t('Addestramento: {n} variabili ({a} disponibili oggi), dati fino al {d}, durata {s} s.', { n: d.training.features.n_features, a: d.training.features.available_now, d: d.training.data_day, s: Math.round(d.training.seconds.total ?? 0) })}</p>
      </MethodNote>
    </div>
  )
}
const C_BLUE = '#5B8DEF'

function TrainingChip({ d }: { d: ForecastV2 }) {
  const tr = d.training
  const color = tr.status === 'ready' ? 'bg-up' : tr.status === 'training' ? 'bg-amber-400 animate-pulse' : 'bg-down'
  const label = tr.status === 'ready' ? t('Modello addestrato {d}', { d: dateTime(tr.trained_at) })
    : tr.status === 'training' ? t('Addestramento in corso{p}', { p: tr.progress ? ` · ${tr.progress}` : '' })
      : t('Errore di addestramento: {e}', { e: tr.error ?? '—' })
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-3 text-xs text-slate-300" title={t('Dati fino al {d}', { d: tr.data_day })}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', color)} />{label}
    </span>
  )
}

export default function ForecastPage() {
  const q = useForecastV2()
  return (
    <div>
      <PageTitle title={t('Previsioni')} subtitle={t('Percorso di prezzo a 12 mesi dalla posizione nel ciclo attuale e da come si sono mossi i cicli passati.')}
        right={q.data?.training ? <TrainingChip d={q.data} /> : undefined} />
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[560px]" /><Skeleton className="h-60" /></div>} isEmpty={(d) => !d.path?.length}>
        {(d) => <Body d={d} updatedAt={q.dataUpdatedAt} />}
      </Q>
    </div>
  )
}
