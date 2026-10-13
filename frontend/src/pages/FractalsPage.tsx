import { useEffect, useState, type CSSProperties } from 'react'
import { Layers3, Magnet, Settings2, Target, Waypoints } from 'lucide-react'
import { useFractals } from '../api/client'
import type { FractalMatch } from '../api/types'
import Sparkline from '../components/charts/Sparkline'
import { Card, CardBody, CardHeader, Change, EmptyState, Fill, PageTitle, ProgressBar, Q, Segmented, Skeleton, ToneBadge, clsx } from '../components/ui'
import { FractalChart } from '../widgets/charts'
import { TONE_LABEL, date, dateTime, toPct, usd } from '../lib/format'
import { usePrice } from '../widgets/hooks'
import { plabel, quant } from '../widgets/analogs'
import { t, tfLabel } from '../i18n'

function useDebounced<V>(v: V, ms = 400) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms)
    return () => clearTimeout(id)
  }, [v, ms])
  return d
}

function Slider({ label, value, min, max, step = 1, onChange, suffix }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <label className="flex min-w-[180px] flex-1 flex-col gap-2">
      <span className="flex items-baseline justify-between"><span className="label">{label}</span><span className="tnum text-sm text-white">{value}{suffix}</span></span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function MatchCard({ m, i }: { m: FractalMatch; i: number }) {
  void i
  return (
    <div className="flex h-full flex-col bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="tnum text-xs text-slate-400">#{m.rank}</span>
          <span className="truncate text-sm text-white">{plabel(m.label)}</span>
        </div>
        <Change value={m.outcome} digits={1} className="text-sm" />
      </div>
      <div className="mt-1 text-xs text-slate-400">{date(m.start)} → {date(m.end)}</div>
      <div className="mt-2 h-10"><Sparkline data={[...m.path, ...m.future]} height={40} /></div>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between text-xs"><span className="text-slate-400">{t('Similarità')}</span><span className="tnum text-white">{m.similarity.toFixed(1)}%</span></div>
        <ProgressBar value={m.similarity} color="#5B8DEF" className="h-1" />
        <div className="flex justify-between text-xs text-slate-400"><span>{t('Correlazione')} <b className="tnum text-slate-200">{m.correlation.toFixed(2)}</b></span><span>DTW <b className="tnum text-slate-200">{m.dtw.toFixed(3)}</b></span></div>
      </div>
    </div>
  )
}

export default function FractalsPage() {
  const [tf, setTf] = useState<'1h' | '4h' | '1d' | '1w'>('4h')
  const [win, setWin] = useState(60)
  const [hor, setHor] = useState(30)
  const [top, setTop] = useState(5)
  const params = useDebounced({ tf, window: win, horizon: hor, top })
  const q = useFractals(params)
  const price = usePrice()
  return (
    <div>
      <PageTitle title={t('Frattali')} subtitle={t('Pattern storici simili alla struttura attuale e cosa successe dopo.')} />
      <Card className="mb-3">
        <CardHeader title={t('Parametri')} icon={<Settings2 />} right={q.isFetching ? <span className="text-xs text-slate-400">{t('Calcolo in corso…')}</span> : null} />
        <CardBody className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="flex flex-col gap-2">
            <span className="label">{t('Timeframe')}</span>
            <Segmented value={tf} onChange={setTf} size="md" options={(['1h', '4h', '1d', '1w'] as const).map((v) => ({ value: v, label: tfLabel(v) }))} />
          </div>
          <Slider label={t('Finestra (candele)')} value={win} min={20} max={200} step={5} onChange={setWin} />
          <Slider label={t('Orizzonte (candele)')} value={hor} min={5} max={120} step={5} onChange={setHor} />
          <Slider label={t('Numero di analoghi')} value={top} min={1} max={10} onChange={setTop} />
        </CardBody>
      </Card>
      <Q q={q} loading={<Skeleton className="h-[520px]" />} isEmpty={(d) => !d.current.length}>
        {(d) => {
          const lastClose = d.current[d.current.length - 1]?.close
          const p = d.projection
          const end = (arr: number[]) => arr[arr.length - 1]
          // Headline = median across ALL matches' outcomes (P25–P75 range), applied to the last close; single matches are secondary.
          const outs = d.matches.map((m) => m.outcome).filter((x) => Number.isFinite(x))
          const med = outs.length ? quant(outs, 0.5) : null
          const q25 = outs.length > 1 ? quant(outs, 0.25) : null
          const q75 = outs.length > 1 ? quant(outs, 0.75) : null
          const at = (c: number | null) => (c != null && lastClose ? lastClose * (1 + c / 100) : null)
          return (
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 xl:grid-cols-12">
                <Card className="h-full xl:col-span-9">
                  <CardHeader title={t('Attuale vs analoghi')} icon={<Waypoints />} updatedAt={q.dataUpdatedAt} subtitle={t('Percorsi riscalati al prezzo attuale')} info={t('Ogni analogo è riscalato al prezzo attuale. La banda azzurra copre i percentili 10–90 degli esiti; la linea tratteggiata è la mediana (P50). Passa sopra un analogo per evidenziarlo.')} />
                  <CardBody className="flex flex-col"><Fill min={480}><FractalChart data={d} height="100%" maxMatches={top} /></Fill></CardBody>
                </Card>
                <Card className="xl:col-span-3">
                  <CardHeader title={t('Proiezione')} icon={<Target />} subtitle={t('Orizzonte {n} candele', { n: d.horizon })} />
                  <CardBody className="flex flex-col gap-3">
                    <div className="flex h-8 items-center justify-between">
                      <ToneBadge tone={p.bias} />
                      <span className="text-sm text-slate-400">{t('Prob. rialzo')} <b className="tnum text-lg font-semibold text-white">{toPct(p.up_prob)?.toFixed(0)}%</b></span>
                    </div>
                    <div className="rounded-xl border border-line bg-white/[0.02] p-3">
                      <div className="label">{t('Mediana analoghi ({n})', { n: outs.length })}</div>
                      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="tnum text-2xl font-semibold text-white">{usd(at(med))}</span>
                        <Change value={med} digits={1} />
                      </div>
                      {q25 != null && q75 != null && (
                        <div className="mt-1 text-xs text-slate-400">
                          {t('Range {a}–{b} (P25–P75)', { a: usd(at(q25)), b: usd(at(q75)) })}
                        </div>
                      )}
                    </div>
                    {[[t('P90 · ottimistico'), end(p.p90)], [t('P10 · pessimistico'), end(p.p10)]].map(([l, v]) => (
                      <div key={l as string} className="border-t border-line pt-2">
                        <div className="label">{l as string}</div>
                        <div className="flex items-baseline justify-between">
                          <span className="tnum text-base font-semibold text-white">{usd(v as number)}</span>
                          <Change value={lastClose ? ((v as number) / lastClose - 1) * 100 : null} digits={1} />
                        </div>
                      </div>
                    ))}
                    {d.matches.length > 0 && (
                      <div className="border-t border-line pt-2">
                        <div className="label mb-1.5">{t('Esito dei singoli analoghi')}</div>
                        {(() => {
                          const mx = Math.max(1, ...d.matches.map((m) => Math.abs(m.outcome || 0)))
                          return d.matches.map((m) => (
                            <div key={m.rank} className="grid grid-cols-[auto_minmax(0,1fr)_56px] items-center gap-2 py-1 text-xs" title={plabel(m.label)}>
                              <span className="tnum w-5 text-slate-500">#{m.rank}</span>
                              <div className="relative h-1.5 rounded-full bg-white/[0.05]">
                                <span className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
                                <span className={clsx('absolute inset-y-0 rounded-full', m.outcome >= 0 ? 'left-1/2 bg-up' : 'right-1/2 bg-down')} style={{ width: `${(Math.abs(m.outcome || 0) / mx) * 50}%` }} />
                              </div>
                              <Change value={m.outcome} digits={1} className="text-right text-xs" />
                            </div>
                          ))
                        })()}
                      </div>
                    )}
                    {p.times.length > 0 && <p className="text-xs text-slate-400">{t('Fine orizzonte: {d}', { d: dateTime(p.times[p.times.length - 1]) })}</p>}
                    <p className="text-xs text-slate-500">{t('Mediana e range sugli esiti di tutti gli analoghi; P10/P90 dalla banda del grafico. I singoli analoghi sono sotto.')}</p>
                  </CardBody>
                </Card>
              </div>

              <div>
                <h2 className="mb-2 text-lg font-semibold text-white">{t('Analoghi trovati')}</h2>
                {/* one row when the analogs fit (≤5), otherwise two balanced rows: no empty cells */}
                <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(var(--c),minmax(0,1fr))]"
                  style={{ '--c': d.matches.length <= 5 ? d.matches.length : Math.ceil(d.matches.length / 2) } as CSSProperties}>
                  {d.matches.map((m, i) => <MatchCard key={m.rank} m={m} i={i} />)}
                </div>
              </div>

              <div className="grid items-start gap-3 lg:grid-cols-2">
                <Card>
                  <CardHeader title={t('Retest attesi')} icon={<Magnet />} subtitle={t('Zone rivisitate dagli analoghi')} />
                  <CardBody className="flex flex-col">
                    {d.retests.length === 0 && <EmptyState text={t('Nessun retest rilevante')} compact />}
                    {d.retests.map((r, i) => {
                      const dist = price ? (r.price / price - 1) * 100 : null
                      return (
                        <div key={i} className="flex items-start justify-between gap-3 border-t border-line py-2 first:border-t-0">
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="tnum text-white">{usd(r.price)}</span>
                              <span className="text-xs text-slate-400">{r.kind === 'support' ? t('Supporto') : r.kind === 'resistance' ? t('Resistenza') : t('Liquidità')}</span>
                              {dist != null && <Change value={dist} digits={1} className="text-xs" />}
                            </div>
                            <p className="mt-1 text-sm text-slate-300">{r.note}</p>
                          </div>
                          <span className="shrink-0 text-xs text-slate-400">{date(r.time, false)}</span>
                        </div>
                      )
                    })}
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader title={t('Altri timeframe')} icon={<Layers3 />} />
                  <CardBody className="overflow-x-auto px-2">
                    <table className="tbl">
                      <thead><tr><th>TF</th><th>{t('Similarità media')}</th><th>{t('Bias')}</th><th className="text-right">{t('Prob. rialzo')}</th></tr></thead>
                      <tbody>
                        {d.multi_tf.map((m) => (
                          <tr key={m.tf} className={clsx(m.tf === d.tf && 'bg-white/[0.03]')}>
                            <td className="text-white">{tfLabel(m.tf)}</td>
                            <td><div className="flex items-center gap-2"><ProgressBar value={m.similarity} color="#5B8DEF" className="h-1 w-24" /><span>{m.similarity.toFixed(1)}%</span></div></td>
                            <td><ToneBadge tone={m.bias} label={TONE_LABEL[m.bias] ?? m.bias} /></td>
                            <td className="text-right">{toPct(m.up_prob)?.toFixed(0)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardBody>
                </Card>
              </div>
            </div>
          )
        }}
      </Q>
    </div>
  )
}
