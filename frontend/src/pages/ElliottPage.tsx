/* Onde di Elliott (/elliott): conteggio automatico con regole rigide e linee guida a punteggio, alternativi, checklist
 * spiegata e backtest walk-forward. I testi sono composti qui (chiavi + numeri dell'API). */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle, BookOpenCheck, Check, ChevronLeft, ChevronRight, CircleSlash, Compass, FlaskConical, GitBranch, History, ListChecks, Radio, Ruler,
  ShieldAlert, Target, Waves,
} from 'lucide-react'
import { useElliott, useElliottAt, useElliottBacktest, type Elliott, type EwBacktest, type EwCount, type EwDegree, type EwExample, type EwTf } from '../api/elliott'
import {
  Badge, Card, CardBody, CardHeader, KpiCell, KpiStrip, Legend, MethodNote, PageTitle, ProgressBar, Q, Segmented, Skeleton, SkeletonBlock, TabBar, Toggle, clsx,
} from '../components/ui'
import { date, dateTime, pct } from '../lib/format'
import { useTab } from '../lib/useTab'
import { t, tfLabel } from '../i18n'
import { VerdictBadge, fmtP } from '../widgets/astro'
import {
  EW, ElliottChart, WaveTag, brokenSide, countName, curNotation, degreeName, fmtPx, guideTitle, guideValue, idealText, invRuleText, levelName,
  patternName, ruleTitle, ruleValue, useLiveCandles, waveNotation, waveText, type ChartScale,
} from '../widgets/elliott'

type Tab = 'conteggio' | 'alternativi' | 'regole' | 'backtest'
const TAB_IDS: Tab[] = ['conteggio', 'alternativi', 'regole', 'backtest']
const TFS: EwTf[] = ['4h', '1d', '1w']
const DEFAULT_DEGREE: Record<EwTf, EwDegree> = { '4h': 'minor', '1d': 'intermediate', '1w': 'primary' }
const TILE = 'rounded-xl border border-white/[0.06] bg-white/[0.02]'

function useNarrow(px = 640) {
  const [n, setN] = useState(() => typeof window !== 'undefined' && window.innerWidth < px)
  useEffect(() => {
    const on = () => setN(window.innerWidth < px)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [px])
  return n
}

const nearestInv = (c: EwCount, price: number | null) => {
  const xs = [c.invalidation.below, c.invalidation.above].filter((v): v is number => v != null)
  if (!xs.length) return null
  if (price == null) return xs[0]
  return xs.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a))
}
const satisfied = (c: EwCount) => c.guidelines.filter((g) => g.score >= 0.5).length
const probText = (c: EwCount) => (c.prob ? pct(c.prob.p, 0, false) : '—')

function DirBadge({ c }: { c: EwCount }) {
  return <Badge color="slate">{c.direction === 'up' ? t('Pattern al rialzo') : t('Pattern al ribasso')}</Badge>
}

// ================================================================== card «Conteggio attuale»
function CountCard({ d, c, price, className }: { d: Elliott; c: EwCount; price: number | null; className?: string }) {
  const p0 = c.projection[0]
  const hi = d.higher
  return (
    <Card className={clsx('flex flex-col', className)}>
      <CardHeader title={t('Conteggio attuale')} icon={<Compass />} subtitle={`${t('Rango {r}', { r: c.rank })} · ${t('grado {g}', { g: degreeName(c.degree) })}`}
        right={<DirBadge c={c} />} />
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="text-lg font-semibold text-white">{countName(c)}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-slate-400">
            <span>{c.state === 'complete' ? t('Pattern completo') : t('{k} onde su {n} completate', { k: c.k, n: c.legs })}</span>
            <span className="text-slate-600">·</span>
            <span className="inline-flex items-center gap-1.5">{t('In corso')}: <WaveTag n={curNotation(c, c.wave)} tone="accent" /> <span className="text-slate-300">{curNotation(c, c.wave) ? '' : waveText(c, c.wave)}</span></span>
          </div>
        </div>
        <div className={clsx(TILE, 'grid grid-cols-2 divide-x divide-white/[0.06]')}>
          <div className="px-3 py-2.5">
            <div className="label">{t('Probabilità calibrata')}</div>
            <div className="tnum mt-1 text-xl font-semibold text-white">{probText(c)}</div>
            <div className="tnum mt-0.5 truncate text-xs text-slate-400" title={t('Frequenza storica con cui il conteggio di questo rango è stato quello giusto a posteriori')}>
              {c.prob ? `${t('IC')} ${pct(c.prob.lo, 0, false)}–${pct(c.prob.hi, 0, false)} · n ${c.prob.n}` : t('Non calibrabile')}</div>
          </div>
          <div className="px-3 py-2.5">
            <div className="label">{t('Punteggio linee guida')}</div>
            <div className="tnum mt-1 text-xl font-semibold text-white">{c.score.toFixed(0)}<span className="text-sm font-normal text-slate-500">/100</span></div>
            <ProgressBar value={c.score} color={EW.wave} className="mt-1.5" />
          </div>
        </div>
        <div>
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[300px] text-sm">
              <thead><tr className="text-left">
                <th className="label px-1 pb-1.5 font-normal">{t('Onda')}</th>
                <th className="label px-1 pb-1.5 text-right font-normal">{t('Variazione')}</th>
                <th className="label px-1 pb-1.5 text-right font-normal">{t('Durata')}</th>
                <th className="label px-1 pb-1.5 text-right font-normal" title={t('Sotto-onde contate con uno ZigZag più fine')}>{t('Sotto-onde')}</th>
              </tr></thead>
              <tbody className="tnum">
                {c.waves.map((w, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-1 py-1.5"><WaveTag n={waveNotation(c, c.pattern.startsWith('double') ? (c.points[i + 1].label ?? w.label) : w.label, c.points[i + 1].sub || (c.pattern.startsWith('double') && /^[abc]$/.test(w.label)))} /></td>
                    <td className={clsx('px-1 py-1.5 text-right', w.change >= 0 ? 'text-up' : 'text-down')}>{pct(w.change, 1)}</td>
                    <td className="px-1 py-1.5 text-right text-slate-300">{barsTxt(w.bars, d.tf)}</td>
                    <td className="px-1 py-1.5 text-right text-slate-400">{w.n_sub}</td>
                  </tr>
                ))}
                <tr className="border-t border-line">
                  <td className="px-1 py-1.5"><span className="inline-flex items-center gap-1"><WaveTag n={curNotation(c, c.pending.label)} tone="accent" />{!curNotation(c, c.pending.label) && <span className="text-xs text-slate-300">{waveText(c, c.pending.label)}</span>}<span className="text-2xs text-slate-500">{t('in corso')}</span></span></td>
                  <td className={clsx('px-1 py-1.5 text-right', c.pending.change >= 0 ? 'text-up' : 'text-down')}>{pct(c.pending.change, 1)}</td>
                  <td className="px-1 py-1.5 text-right text-slate-300">{barsTxt(c.pending.bars, d.tf)}</td>
                  <td className="px-1 py-1.5 text-right text-slate-500">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        {p0 && (
          <div>
            <span className="label">{t('Livelli obiettivo · {w}', { w: waveText(c, p0.wave) })}</span>
            <div className="mt-1 flex flex-col">
              {p0.levels.map((l, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 text-sm first:border-0">
                  <span className="min-w-0 truncate text-slate-300">{levelName(l.key, l.ratio)}</span>
                  <span className="tnum shrink-0 text-white">{fmtPx(l.price)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mt-auto flex flex-col gap-2 border-t border-line pt-3 text-sm">
          {(['below', 'above'] as const).map((s) => c.invalidation[s] != null && (
            <div key={s} className="flex items-start gap-2">
              <ShieldAlert size={14} className="mt-0.5 shrink-0 text-down" />
              <span className="text-slate-300">{s === 'below' ? t('Falso sotto {p}', { p: fmtPx(c.invalidation[s]) }) : t('Falso sopra {p}', { p: fmtPx(c.invalidation[s]) })}
                <span className="text-slate-500"> · {invRuleText(c.invalidation[`${s}_rule`])}</span>
                {price != null && <span className="tnum text-slate-500"> · {pct((c.invalidation[s]! / price - 1) * 100, 1)}</span>}</span>
            </div>
          ))}
          {hi && (
            <div className="flex items-start gap-2">
              <GitBranch size={14} className="mt-0.5 shrink-0" style={{ color: EW.higher }} />
              <span className="text-slate-300">{t('Grado superiore ({g})', { g: degreeName(hi.degree) })}: {countName(hi)}, {waveText(hi, hi.wave).toLowerCase()}</span>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

const barsTxt = (n: number, tf: EwTf) => (tf === '4h' ? t('{n} candele', { n: Math.round(n) }) : tf === '1w' ? t('{n} sett.', { n: Math.round(n) }) : t('{n} g', { n: Math.round(n) }))

// ================================================================== scheda Conteggio
function CountTab({ d, sel, setSel, refetch, updatedAt }: { d: Elliott; sel: number; setSel: (i: number) => void; refetch: () => void; updatedAt: number }) {
  const narrow = useNarrow()
  const [scale, setScale] = useState<ChartScale>(d.tf === '1w' ? 'log' : 'lin')
  const [showChannel, setShowChannel] = useState(true)
  const [showHigher, setShowHigher] = useState(false)
  const lc = useLiveCandles(d, refetch)
  const c = d.counts[Math.min(sel, d.counts.length - 1)]
  const price = lc.price
  const broken = brokenSide(c, price)
  const p0 = c.projection[0], p1 = c.projection[1]
  const inv = nearestInv(c, price)
  return (
    <div className="flex flex-col gap-3">
      {broken && (
        <div className="card flex items-start gap-3 border border-down/30 px-4 py-3 text-sm sm:px-5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-down" />
          <span className="text-slate-200">
            {t('Il prezzo live ({p}) ha superato l\'invalidazione del conteggio selezionato ({v}): il conteggio non è più valido e verrà ricalcolato alla chiusura della candela.',
              { p: fmtPx(price), v: fmtPx(c.invalidation[broken]) })}
          </span>
        </div>
      )}
      <KpiStrip cols="grid-cols-1 min-[440px]:grid-cols-2 xl:grid-cols-4">
        <KpiCell icon={<Waves />} accent="violet" label={t('Onda in corso')} value={<span className="inline-flex items-center gap-2">{curNotation(c, c.wave)?.text ?? waveText(c, c.wave)}</span>}
          foot={`${countName(c)} · ${degreeName(curNotation(c, c.wave) && c.state === 'complete' && c.next_higher ? DEGREES_UP[c.degree] : c.degree)}`} />
        <KpiCell icon={<Target />} accent="violet" label={t('Obiettivo · {w}', { w: waveText(c, p0?.wave ?? c.wave) })} value={p0 ? `~${fmtPx(p0.price, true)}` : '—'}
          foot={p0 ? (p0.reached ? t('Zona già raggiunta') : `${fmtPx(p0.lo, true)}–${fmtPx(p0.hi, true)} · ${price ? pct((p0.price / price - 1) * 100, 1) : ''}`) : null} />
        <KpiCell icon={<Ruler />} accent="violet" label={t('Poi · {w}', { w: p1 ? waveText(c, p1.wave, true) : '—' })} value={p1 ? `~${fmtPx(p1.price, true)}` : '—'}
          foot={p1 ? t('Verso {d}', { d: date(p1.time, false) }) : null} />
        <KpiCell icon={<ShieldAlert />} label={t('Invalidazione')} value={inv != null ? fmtPx(inv, true) : '—'}
          foot={inv != null && price ? <span className={broken ? 'text-down' : undefined}>{broken ? t('Superata dal prezzo live') : t('{x} dal prezzo', { x: pct((inv / price - 1) * 100, 1) })}</span> : null} />
      </KpiStrip>

      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="flex flex-col xl:col-span-8">
          <CardHeader title={t('Conteggio {tf} · grado {g}', { tf: tfLabel(d.tf), g: degreeName(d.degree) })} icon={<Waves />} updatedAt={updatedAt} interval={d.tf === '4h' ? 60_000 : 180_000}
            subtitle={t('{n} conteggi validi · preferito e alternativi ordinati per {r}', { n: d.n_valid, r: d.ranker === 'ml' ? t('ranker statistico') : t('punteggio delle linee guida') })}
            right={
              <>
                <Segmented value={Math.min(sel, d.counts.length - 1)} onChange={setSel} options={d.counts.map((x, i) => ({ value: i, label: i === 0 ? t('Preferito') : `#${x.rank}` }))} />
                <Toggle on={showChannel} onClick={() => setShowChannel((v) => !v)}>{t('Canale')}</Toggle>
                {d.higher && <Toggle on={showHigher} onClick={() => setShowHigher((v) => !v)}>{t('Grado superiore')}</Toggle>}
                <Segmented value={scale} onChange={setScale} options={[{ value: 'lin', label: 'Lin' }, { value: 'log', label: 'Log' }]} />
              </>
            } />
          <CardBody className="flex flex-1 flex-col">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium text-white">{countName(c)}</span>
              <span className="tnum inline-flex items-center gap-2 text-slate-300">{lc.live && <Badge color="up"><Radio size={12} /> {t('Live')}</Badge>}{fmtPx(price)}</span>
            </div>
            <div className="min-h-[340px] flex-1">
              <ElliottChart candles={lc.candles} count={c} higher={d.higher} tf={d.tf} scale={scale} showChannel={showChannel} showHigher={showHigher}
                height={narrow ? 360 : '100%'} compact={narrow} livePrice={price} />
            </div>
            <div className="mt-3">
              <Legend items={[
                { label: t('Onde del conteggio'), color: EW.wave },
                { label: t('Onda in corso e proiezione'), color: EW.target, dashed: true },
                { label: t('Zona obiettivo (prezzo × tempo)'), color: 'rgba(155,135,245,0.5)' },
                { label: t('Invalidazione'), color: EW.inv, dashed: true },
                ...(showChannel && c.channel ? [{ label: t('Canale di Elliott'), color: '#B3BCD0', dashed: true }] : []),
                ...(showHigher && d.higher ? [{ label: t('Grado superiore ({g})', { g: degreeName(d.higher.degree) }), color: EW.higher, dashed: true }] : []),
              ]} />
            </div>
          </CardBody>
        </Card>
        <CountCard d={d} c={c} price={price} className="xl:col-span-4" />
      </div>
      <Method d={d} />
    </div>
  )
}
const DEGREES_UP: Record<EwDegree, EwDegree> = {
  supercycle: 'supercycle', cycle: 'supercycle', primary: 'cycle', intermediate: 'primary', minor: 'intermediate', minute: 'minor', minuette: 'minute', subminuette: 'minuette',
}

function Method({ d }: { d: Elliott }) {
  return (
    <MethodNote>
      <p>{t('Swing = pivot confermati dello ZigZag su ATR(14): un massimo o un minimo esiste solo quando il prezzo ha ritracciato della soglia (dato noto alla conferma, nessun dato futuro). Tre soglie per timeframe = tre gradi; questo grado usa {m}× ATR. Le sotto-onde di ogni onda sono contate con uno ZigZag più fine (0.45× la soglia) dentro l\'onda stessa. I nomi dei gradi sono convenzionali, assegnati per scala.', { m: d.mult })}</p>
      <p>{t('Regole (scartano il conteggio, fonte: Frost & Prechter, «Elliott Wave Principle», ed EWI Waveopedia): l\'onda 2 non ritraccia oltre l\'inizio dell\'onda 1; l\'onda 3 supera la fine dell\'onda 1 e non è la più corta tra 1, 3 e 5; l\'onda 4 non entra nel territorio dell\'onda 1 (eccetto nelle diagonali); zigzag con B entro il 100% di A e C oltre la fine di A; flat con B almeno al 90% di A (espanso oltre il 105%, running con C che non raggiunge la fine di A); triangolo contraente con C, D, E entro la fine di A, B, C ed espansivo al contrario, solo dopo un movimento più ampio (posizione 4, B o X); combinazioni W-X-Y con X entro l\'inizio di W e al più uno zigzag nella doppia three. Le lunghezze sono misurate in variazione percentuale (scala log), come indica EWI per la regola dell\'onda 3.')}</p>
      <p>{t('Linee guida (punteggio pesato 0–100, pesi dichiarati): rapporti di Fibonacci tipici con tolleranza (onda 2 50–61.8%, onda 3 1.618/2.618×, onda 4 23.6–38.2%, onda 5 = 1 o 0.618×(1→3), C = A, B 50–61.8%…), alternanza, estensione, canale di Elliott, rapporti di tempo, sottostruttura 5-3-5-3-5 / 5-3-5 / 3-3-5, volume e divergenza RSI, inizio su un estremo, copertura del pattern e coerenza con il grado superiore. Le soglie non verificate sulla fonte primaria (B dello zigzag, rapporti del flat espanso, rapporti delle diagonali) sono usate solo come linee guida.')}</p>
      <p>{t('Probabilità: non è stimata a priori. Nel backtest walk-forward, a ogni conferma di uno swing, si contano le onde con i soli dati noti e si definisce «giusto a posteriori» il conteggio valido la cui zona obiettivo contiene la vera fine dell\'onda in corso, senza invalidazione prima, con l\'errore più piccolo. La probabilità del rango r è la frequenza con cui il rango r è stato quello giusto (intervallo di Wilson al 95%); con meno di 30 casi si mostra solo il punteggio. Un ranker a regressione logistica addestrato solo sugli esiti già noti viene confrontato fuori campione: è usato solo se migliore.')}</p>
      <p>{t('Limiti: il conteggio di Elliott è soggettivo e quasi sempre esistono più conteggi validi; i risultati dipendono dalla soglia ZigZag (un\'altra soglia cambia gli swing e quindi le onde); sul 1W i casi sono pochi; gli studi accademici (es. Batchelor e Ramyar, «Magic numbers in the Dow», 2006) non trovano rapporti di Fibonacci più frequenti del caso. È uno strumento di studio, non un segnale di trading.')}</p>
    </MethodNote>
  )
}

// ================================================================== scheda Alternativi
const ALT_COLS: Record<number, string> = { 1: '2xl:grid-cols-1', 2: '2xl:grid-cols-2', 3: '2xl:grid-cols-3', 4: '2xl:grid-cols-4', 5: '2xl:grid-cols-5' }

function AltTab({ d, onShow }: { d: Elliott; onShow: (i: number) => void }) {
  const narrow = useNarrow()
  const lc = useLiveCandles(d, () => undefined)
  const n = d.counts.length
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title={t('Confronto dei conteggi')} icon={<GitBranch />}
          subtitle={t('{n} conteggi rispettano tutte le regole · mostrati i primi {k}', { n: d.n_valid, k: n })} />
        <CardBody>
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead><tr className="text-left">
                <th className="label px-1 pb-2 font-normal">#</th>
                <th className="label px-1 pb-2 font-normal">{t('Conteggio')}</th>
                <th className="label px-1 pb-2 font-normal">{t('Onda in corso')}</th>
                <th className="label px-1 pb-2 font-normal">{t('Punteggio')}</th>
                <th className="label px-1 pb-2 text-right font-normal" title={t('Frequenza storica con cui il conteggio di questo rango è stato quello giusto a posteriori')}>{t('Probabilità')}</th>
                <th className="label px-1 pb-2 text-right font-normal">{t('Regole')}</th>
                <th className="label px-1 pb-2 text-right font-normal">{t('Linee guida')}</th>
                <th className="label px-1 pb-2 text-right font-normal">{t('Obiettivo')}</th>
                <th className="label px-1 pb-2 text-right font-normal">{t('Invalidazione')}</th>
              </tr></thead>
              <tbody className="tnum">
                {d.counts.map((c, i) => {
                  const p0 = c.projection[0]
                  return (
                    <tr key={c.id} className="cursor-pointer border-t border-line hover:bg-white/[0.02]" onClick={() => onShow(i)}>
                      <td className="px-1 py-2 text-slate-400">{c.rank}</td>
                      <td className="px-1 py-2 text-white">{countName(c)}</td>
                      <td className="px-1 py-2"><span className="inline-flex items-center gap-1.5"><WaveTag n={curNotation(c, c.wave)} tone="accent" /><span className="text-slate-300">{curNotation(c, c.wave) ? '' : waveText(c, c.wave)}</span></span></td>
                      <td className="px-1 py-2"><div className="flex items-center gap-2"><ProgressBar value={c.score} color={EW.wave} className="h-1 w-20" /><span className="text-slate-300">{c.score.toFixed(0)}</span></div></td>
                      <td className="px-1 py-2 text-right text-white">{probText(c)}</td>
                      <td className="px-1 py-2 text-right text-slate-300"><span className="inline-flex items-center gap-1"><Check size={13} className="text-up" />{c.rules.length}</span></td>
                      <td className="px-1 py-2 text-right text-slate-300">{satisfied(c)}/{c.guidelines.length}</td>
                      <td className="px-1 py-2 text-right text-slate-200">{p0 ? `${fmtPx(p0.lo, true)}–${fmtPx(p0.hi, true)}` : '—'}</td>
                      <td className="px-1 py-2 text-right text-slate-200">{[c.invalidation.below, c.invalidation.above].filter((v) => v != null).map((v) => fmtPx(v, true)).join(' · ') || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-400">{t('Probabilità = frequenza con cui, nel backtest, il conteggio di quel rango è stato quello giusto a posteriori; le probabilità dei ranghi non sommano a 100% perché a volte nessun conteggio risulta giusto o lo è uno oltre il quinto.')}</p>
        </CardBody>
      </Card>
      <div className={clsx('grid gap-3 lg:grid-cols-2', ALT_COLS[n])}>
        {d.counts.map((c, i) => (
          <Card key={c.id} className={clsx('flex flex-col', n % 2 === 1 && i === 0 && 'lg:col-span-2 2xl:col-span-1')}>
            <CardHeader noIcon title={<span className="inline-flex items-center gap-2"><span className="tnum text-slate-500">#{c.rank}</span>{countName(c)}</span>}
              subtitle={`${waveText(c, c.wave)} · ${t('punteggio {s}', { s: c.score.toFixed(0) })}${c.prob ? ` · ${t('probabilità {p}', { p: probText(c) })}` : ''}`}
              right={<button className="btn-ghost h-7 text-xs" onClick={() => onShow(i)}>{t('Apri')}</button>} />
            <CardBody className="flex flex-1 flex-col gap-2">
              <ElliottChart candles={lc.candles} count={c} tf={d.tf} scale={d.tf === '1w' ? 'log' : 'lin'} showChannel={false} showHigher={false} height={narrow ? 240 : 260} compact livePrice={lc.price} />
              <div className="dgrid mt-auto grid-cols-2">
                <div className="px-3 py-2"><div className="label">{t('Obiettivo')}</div><div className="tnum mt-0.5 text-sm text-white">{c.projection[0] ? `~${fmtPx(c.projection[0].price, true)}` : '—'}</div></div>
                <div className="px-3 py-2"><div className="label">{t('Invalidazione')}</div><div className="tnum mt-0.5 text-sm text-white">{fmtPx(nearestInv(c, lc.price), true)}</div></div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ================================================================== scheda Regole e linee guida
function RulesTab({ d, sel, setSel }: { d: Elliott; sel: number; setSel: (i: number) => void }) {
  const c = d.counts[Math.min(sel, d.counts.length - 1)]
  const gs = [...c.guidelines].sort((a, b) => b.weight * b.score - a.weight * a.score)
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title={t('Perché il conteggio è valido')} icon={<BookOpenCheck />}
          subtitle={`${countName(c)} · ${t('grado {g}', { g: degreeName(c.degree) })}`}
          right={<Segmented value={Math.min(sel, d.counts.length - 1)} onChange={setSel} options={d.counts.map((x, i) => ({ value: i, label: i === 0 ? t('Preferito') : `#${x.rank}` }))} />} />
        <CardBody>
          <p className="text-sm leading-relaxed text-slate-300">
            {t('Rispetta tutte le {r} regole applicabili (un conteggio che ne viola anche una è scartato) e soddisfa {g} linee guida su {n}: punteggio {s}/100.', { r: c.rules.length, g: satisfied(c), n: c.guidelines.length, s: c.score.toFixed(0) })}
            {' '}{c.prob ? t('Storicamente il conteggio di rango {k} è stato quello giusto a posteriori nel {p} dei casi.', { k: c.rank, p: probText(c) }) : t('Probabilità non calibrabile: pochi casi nel backtest.')}
          </p>
        </CardBody>
      </Card>
      {/* 16 guidelines vs 4 rules: side by side only from 1700px, with the guidelines in two columns (no blank under the rules) */}
      <div className="grid gap-3 min-[1700px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="flex flex-col">
          <CardHeader title={t('Regole verificate')} icon={<ListChecks />} subtitle={t('Vincoli rigidi della teoria')} />
          <CardBody className="flex flex-1 flex-col gap-4">
            <div className="flex flex-col">
              {c.rules.map((r) => (
                <div key={r.key} className="grid grid-cols-[auto_1fr] gap-x-3 border-t border-line py-2 first:border-0">
                  <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-up/15 text-up"><Check size={12} /></span>
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200">{ruleTitle(r.key, c)}</div>
                    <div className="tnum text-xs text-slate-400">{ruleValue(r)}</div>
                  </div>
                </div>
              ))}
              {!c.rules.length && <p className="text-sm text-slate-400">{t('Solo la prima onda è completa: nessuna regola ancora verificabile oltre all\'onda in corso.')}</p>}
            </div>
            {c.projection[0] && (
              <div className="flex flex-col">
                <span className="label">{t('Obiettivo · {w}', { w: waveText(c, c.projection[0].wave) })}</span>
                <div className="mt-1 flex flex-col">
                  {c.projection[0].levels.map((l, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 text-sm first:border-0">
                      <span className="min-w-0 truncate text-slate-300">{levelName(l.key, l.ratio)}</span>
                      <span className="tnum shrink-0 text-white">{fmtPx(l.price)}</span>
                    </div>
                  ))}
                  <div className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 text-sm">
                    <span className="text-slate-400">{t('Zona obiettivo (rapporti tipici)')}</span>
                    <span className="tnum shrink-0 text-white">{fmtPx(c.projection[0].lo)} – {fmtPx(c.projection[0].hi)}</span>
                  </div>
                  {c.projection[1] && (
                    <div className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 text-sm">
                      <span className="text-slate-400">{t('Poi · {w}', { w: waveText(c, c.projection[1].wave, true) })}</span>
                      <span className="tnum shrink-0 text-white">~{fmtPx(c.projection[1].price)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
              <span className="label">{t('Cosa renderebbe falso il conteggio')}</span>
              {(['below', 'above'] as const).map((s) => c.invalidation[s] != null && (
                <div key={s} className="flex items-start gap-2 text-sm">
                  <CircleSlash size={14} className="mt-0.5 shrink-0 text-down" />
                  <span className="text-slate-300">{s === 'below' ? t('Prezzo sotto {p}', { p: fmtPx(c.invalidation[s]) }) : t('Prezzo sopra {p}', { p: fmtPx(c.invalidation[s]) })}: <span className="text-slate-400">{invRuleText(c.invalidation[`${s}_rule`])}</span></span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
        <Card className="flex flex-col">
          <CardHeader title={t('Linee guida')} icon={<Ruler />} subtitle={t('Punteggio pesato · rapporti misurati e valori tipici')} />
          <CardBody className="flex flex-col md:grid md:grid-cols-2 md:gap-x-8 md:[&>*:nth-child(2)]:border-0">
            {gs.map((g) => (
              <div key={g.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-t border-line py-2 first:border-0">
                <div className="min-w-0">
                  <div className="text-sm text-slate-200">{guideTitle(g.key, c)}</div>
                  <div className="tnum text-xs text-slate-400">{guideValue(g)}{idealText(g) ? ` · ${t('tipico {x}', { x: idealText(g) })}` : ''}</div>
                </div>
                <div className="flex w-28 flex-col items-end gap-1">
                  <span className="tnum text-xs text-slate-300">{Math.round(g.score * 100)} · {t('peso {w}', { w: g.weight })}</span>
                  <ProgressBar value={g.score * 100} color={g.score >= 0.5 ? EW.wave : '#626D88'} className="h-1" />
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

// ================================================================== scheda Backtest
function cmp(a: number | undefined, b: number | undefined, c?: number, lowerBetter = false) {
  if (a == null || b == null) return 'text-slate-200'
  const best = lowerBetter ? a <= Math.min(b, c ?? Infinity) : a >= Math.max(b, c ?? -Infinity)
  return best ? 'font-semibold text-white' : 'text-slate-300'
}

function BtTable({ items, sel, onSel }: { items: ({ tf: EwTf; degree: EwDegree } & EwBacktest)[]; sel: string; onSel: (k: string) => void }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[980px] text-sm">
        <thead>
          <tr className="text-left">
            <th className="label px-1 pb-2 font-normal">{t('Timeframe · grado')}</th>
            <th className="label px-1 pb-2 text-right font-normal">{t('Casi')}</th>
            <th className="label px-1 pb-2 font-normal">{t('Verdetto')}</th>
            <th className="label px-1 pb-2 text-right font-normal" title={t('Direzione del percorso proiettato a un orizzonte pari alla durata mediana di uno swing')}>{t('Direzione')}</th>
            <th className="label px-1 pb-2 text-right font-normal" title={t('Errore mediano tra il centro dell\'obiettivo e la vera fine dell\'onda')}>{t('Errore obiettivo')}</th>
            <th className="label px-1 pb-2 text-right font-normal" title={t('Zona obiettivo toccata prima del livello di invalidazione')}>{t('Obiettivo prima')}</th>
            <th className="label px-1 pb-2 text-right font-normal" title={t('Il conteggio di rango 1 è stato quello giusto a posteriori')}>{t('Rango 1 giusto')}</th>
            <th className="label px-1 pb-2 font-normal">{t('Ordinamento')}</th>
          </tr>
        </thead>
        <tbody className="tnum">
          {items.map((b) => {
            const k = `${b.tf}|${b.degree}`
            const m = b.model, a = b.base_alt, r = b.base_random
            return (
              <tr key={k} onClick={() => onSel(k)} className={clsx('cursor-pointer border-t border-line', sel === k ? 'bg-accent-blue/[0.06]' : 'hover:bg-white/[0.02]')}>
                <td className="whitespace-nowrap px-1 py-2 text-white">{tfLabel(b.tf)} · {degreeName(b.degree)}</td>
                <td className="px-1 py-2 text-right text-slate-300">{b.n}</td>
                <td className="px-1 py-2"><VerdictBadge v={b.verdict} short /></td>
                <td className="px-1 py-2 text-right">
                  <div className={cmp(m?.hit, a?.hit, r?.hit)}>{pct(m?.hit, 0, false)}</div>
                  <div className="text-xs text-slate-500">{t('Alt. {a} · caso {c}', { a: pct(a?.hit, 0, false), c: pct(r?.hit, 0, false) })}</div>
                </td>
                <td className="px-1 py-2 text-right">
                  <div className={cmp(m?.err_med, a?.err_med, r?.err_med, true)}>{pct(m?.err_med, 1, false)}</div>
                  <div className="text-xs text-slate-500">{t('Alt. {a} · caso {c}', { a: pct(a?.err_med, 1, false), c: pct(r?.err_med, 1, false) })}</div>
                </td>
                <td className="px-1 py-2 text-right">
                  <div className={cmp(m?.target_first, r?.target_first)}>{pct(m?.target_first, 0, false)}</div>
                  <div className="text-xs text-slate-500">{t('Caso {c}', { c: pct(r?.target_first, 0, false) })}</div>
                </td>
                <td className="px-1 py-2 text-right">
                  <div className={cmp(m?.best, r?.best)}>{pct(m?.best, 0, false)}</div>
                  <div className="text-xs text-slate-500">{t('Caso {c} · p {p}', { c: pct(r?.best, 0, false), p: fmtP(b.p_best_random) })}</div>
                </td>
                <td className="px-1 py-2"><VerdictBadge v={b.rank_verdict} short /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function verdictSentence(b: EwBacktest): string {
  const pv = b.verdict === 'strong' ? t('i conteggi hanno anticipato la direzione meglio di entrambe le baseline in modo significativo e stabile')
    : b.verdict === 'weak' ? t('vantaggio piccolo o non significativo sulle baseline')
      : b.verdict === 'anecdotal' ? t('casi troppo pochi per un giudizio')
        : t('nessun vantaggio predittivo dimostrato: la direzione non è anticipata meglio dell\'alternanza semplice o di un conteggio valido scelto a caso')
  const rv = b.rank_verdict === 'strong' ? t('l\'ordinamento per linee guida sceglie il conteggio giusto a posteriori più spesso del caso, in modo significativo e in entrambe le metà del campione')
    : b.rank_verdict === 'weak' ? t('l\'ordinamento per linee guida è debolmente migliore del caso')
      : b.rank_verdict === 'anecdotal' ? t('ordinamento non giudicabile')
        : t('l\'ordinamento per linee guida non è migliore di una scelta a caso')
  return `${t('Valore predittivo')}: ${pv}. ${t('Ordinamento')}: ${rv}.`
}

function CalibCard({ b, className }: { b: { tf: EwTf; degree: EwDegree } & EwBacktest; className?: string }) {
  const ranks = b.calibration?.ranks ?? []
  const max = Math.max(1, ...ranks.map((r) => r.hi ?? r.p_best ?? 0))
  return (
    <Card className={clsx('flex flex-col', className)}>
      <CardHeader title={t('Probabilità per rango')} icon={<Target />} subtitle={`${tfLabel(b.tf)} · ${degreeName(b.degree)} · ${t('{n} istanti', { n: b.n })}`}
        right={<VerdictBadge v={b.rank_verdict} short />} />
      <CardBody className="flex flex-1 flex-col gap-3">
        <p className="text-sm leading-relaxed text-slate-300">{verdictSentence(b)}</p>
        <div className="flex flex-col gap-2.5">
          {ranks.map((r) => (
            <div key={r.rank} className="grid grid-cols-[64px_1fr_auto] items-center gap-3 text-sm">
              <span className="text-slate-300">{t('Rango {r}', { r: r.rank })}</span>
              <div className="relative h-2 rounded-full bg-white/[0.05]">
                {r.lo != null && r.hi != null && <span className="absolute inset-y-0 rounded-full" style={{ left: `${(r.lo / max) * 100}%`, width: `${((r.hi - r.lo) / max) * 100}%`, background: 'rgba(155,135,245,0.25)' }} />}
                <span className="absolute -top-0.5 h-3 w-0.5 rounded bg-[#C4B5FD]" style={{ left: `${((r.p_best ?? 0) / max) * 100}%` }} />
              </div>
              <span className="tnum w-28 text-right text-white">{pct(r.p_best, 1, false)} <span className="text-xs text-slate-500">({pct(r.lo, 0, false)}–{pct(r.hi, 0, false)})</span></span>
            </div>
          ))}
          <div className="grid grid-cols-[64px_1fr_auto] items-center gap-3 text-sm">
            <span className="text-slate-400">{t('Caso')}</span>
            <div className="relative h-2 rounded-full bg-white/[0.05]"><span className="absolute -top-0.5 h-3 w-0.5 rounded bg-slate-400" style={{ left: `${((b.base_random?.best ?? 0) / max) * 100}%` }} /></div>
            <span className="tnum w-28 text-right text-slate-300">{pct(b.base_random?.best, 1, false)}</span>
          </div>
        </div>
        <div className="dgrid mt-auto grid-cols-2 sm:grid-cols-4">
          <div className="px-3 py-2.5"><div className="label">{t('Nessuno giusto')}</div><div className="tnum mt-1 text-lg font-semibold text-white">{pct(b.calibration?.none, 0, false)}</div></div>
          <div className="px-3 py-2.5"><div className="label">{t('Copertura zona')}</div><div className="tnum mt-1 text-lg font-semibold text-white">{pct(b.model?.cov, 0, false)}</div></div>
          <div className="px-3 py-2.5" title={t('Ranker a regressione logistica fuori campione contro il punteggio a regole')}><div className="label">{t('Ranker ML')}</div>
            <div className="tnum mt-1 text-lg font-semibold text-white">{b.ml ? pct(b.ml.ml_best, 0, false) : '—'}</div>
            <div className="tnum truncate text-xs text-slate-400">{b.ml ? `${t('Regole {x}', { x: pct(b.ml.rule_best, 0, false) })} · ${b.ml.adopted ? t('adottato') : t('scartato')}` : t('Pochi casi')}</div></div>
          <div className="px-3 py-2.5"><div className="label">{t('Candidati mediani')}</div><div className="tnum mt-1 text-lg font-semibold text-white">{b.candidates_med ?? '—'}</div></div>
        </div>
      </CardBody>
    </Card>
  )
}

const OUTCOME = (o: EwExample['outcome']) => ({ target: t('Toccato'), reached: t('Già raggiunto'), invalid: t('Invalidato'), none: t('Nessuno') }[o])

function ExamplesCard({ b, sel, onSel, className }: { b: { tf: EwTf } & EwBacktest; sel: number | null; onSel: (t: number) => void; className?: string }) {
  const rows = [...(b.examples ?? [])].reverse()
  return (
    <Card className={clsx('flex flex-col', className)}>
      <CardHeader title={t('Esempi storici')} icon={<History />} subtitle={t('Conteggio preferito alla conferma dello swing · clicca per vederlo')} />
      <CardBody className="flex min-h-0 flex-1 flex-col px-2 sm:px-3">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((r) => (
            <button key={r.time} onClick={() => onSel(r.time)}
              className={clsx('grid w-full grid-cols-[1fr_auto] items-center gap-x-3 rounded-lg border-b border-line px-2 py-2 text-left last:border-0',
                sel === r.time ? 'bg-accent-blue/[0.07]' : 'hover:bg-white/[0.02]')}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 text-sm text-slate-200">
                  <span className="tnum text-slate-400">{b.tf === '4h' ? dateTime(r.time) : date(r.time)}</span>
                  <span>{patternName(r.pattern, r.variant)}</span>
                </div>
                <div className="tnum truncate text-xs text-slate-400">
                  {t('Obiettivo {a}–{b} · fine reale {c}', { a: fmtPx(r.lo, true), b: fmtPx(r.hi, true), c: fmtPx(r.actual, true) })}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <span title={t('Zona obiettivo toccata prima dell\'invalidazione?')} className={clsx('hidden rounded px-1.5 text-2xs ring-1 ring-inset min-[420px]:inline', r.outcome === 'invalid' ? 'text-down ring-down/25' : r.outcome === 'none' ? 'text-slate-500 ring-white/10' : 'text-slate-200 ring-white/15')}>{OUTCOME(r.outcome)}</span>
                <span title={r.best ? t('Giusto a posteriori') : t('Non il migliore a posteriori')} className={clsx('rounded px-1.5 text-2xs ring-1 ring-inset', r.best ? 'bg-[#9B87F5]/15 text-[#C4B5FD] ring-[#9B87F5]/40' : 'text-slate-500 ring-white/5')}>{t('Giusto')}</span>
                <span title={r.hit ? t('Direzione corretta') : t('Direzione sbagliata')} className={clsx('grid h-5 w-5 place-items-center rounded-full', r.hit ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>{r.hit ? <Check size={12} /> : <CircleSlash size={11} />}</span>
              </div>
            </button>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function HistoricalCard({ tf, degree, at, list, onSel }: { tf: EwTf; degree: EwDegree; at: number; list: number[]; onSel: (t: number) => void }) {
  const narrow = useNarrow()
  const q = useElliottAt(tf, degree, at)
  const i = list.indexOf(at)
  return (
    <Card>
      <CardHeader title={t('Conteggio storico')} icon={<History />}
        subtitle={t('Solo i dati noti al {d} · le candele successive sono attenuate', { d: tf === '4h' ? dateTime(at) : date(at) })}
        right={
          <div className="flex items-center gap-1">
            <button className="btn-ghost h-7 px-2" disabled={i <= 0} onClick={() => onSel(list[i - 1])} aria-label={t('Precedente')}><ChevronLeft size={14} /></button>
            <span className="tnum text-xs text-slate-400">{i + 1}/{list.length}</span>
            <button className="btn-ghost h-7 px-2" disabled={i >= list.length - 1} onClick={() => onSel(list[i + 1])} aria-label={t('Successivo')}><ChevronRight size={14} /></button>
          </div>
        } />
      <CardBody>
        <Q q={q} loading={<Skeleton className="h-[380px]" />} isEmpty={(x) => !x.counts.length}>
          {(x) => {
            const c = x.counts[0]
            return (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium text-white">{countName(c)}</span>
                  <span className="text-slate-400">{waveText(c, c.wave)} · {t('obiettivo {a}–{b}', { a: fmtPx(c.projection[0]?.lo, true), b: fmtPx(c.projection[0]?.hi, true) })}</span>
                </div>
                <ElliottChart candles={x.candles} after={x.after} count={c} higher={x.higher} tf={tf} scale={tf === '1w' ? 'log' : 'lin'} showChannel={false} showHigher={false}
                  height={narrow ? 320 : 400} compact={narrow} />
              </div>
            )
          }}
        </Q>
      </CardBody>
    </Card>
  )
}

function BacktestTab({ tf, degree }: { tf: EwTf; degree: EwDegree }) {
  const [mode, setMode] = useState<'default' | 'all'>('default')
  const q = useElliottBacktest(mode)
  const [sel, setSel] = useState(`${tf}|${degree}`)
  const [at, setAt] = useState<number | null>(null)
  useEffect(() => { setAt(null) }, [sel, mode])
  return (
    <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-56" /><Skeleton className="h-96" /></div>} isEmpty={(x) => !x.items.length}>
      {(x) => {
        const b = x.items.find((it) => `${it.tf}|${it.degree}` === sel) ?? x.items.find((it) => it.tf === tf) ?? x.items[0]
        const list = [...(b.examples ?? [])].map((e) => e.time).reverse()
        const shown = at ?? list[0] ?? null
        return (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('Backtest walk-forward')} icon={<FlaskConical />}
                subtitle={t('A ogni conferma di swing: conteggio con i soli dati noti, confronto con l\'esito reale')}
                right={<Segmented value={mode} onChange={setMode} options={[{ value: 'default', label: t('Grado predefinito') }, { value: 'all', label: t('Tutti i gradi') }]} />} />
              <CardBody className="flex flex-col gap-3">
                <BtTable items={x.items} sel={`${b.tf}|${b.degree}`} onSel={setSel} />
                <p className="text-xs leading-relaxed text-slate-400">
                  {t('Direzione = segno del percorso proiettato (fine dell\'onda in corso, poi onda successiva) a un orizzonte pari alla durata mediana di uno swing. Baseline: «alternanza» = prossimo swing di ampiezza e durata mediane nella direzione alternata; «caso» = conteggio valido scelto a caso tra i candidati (400 estrazioni, da cui i p-value). In grassetto il migliore. Verdetto «significativo» solo con p < 0.05 contro entrambe le baseline e stabilità nelle due metà del campione.')}
                </p>
              </CardBody>
            </Card>
            <div className="grid gap-3 xl:grid-cols-12">
              <CalibCard b={b} className="xl:col-span-7" />
              <ExamplesCard b={b} sel={shown} onSel={setAt} className="xl:col-span-5 xl:h-0 xl:min-h-full" />
            </div>
            {shown != null ? <HistoricalCard tf={b.tf} degree={b.degree} at={shown} list={list} onSel={setAt} />
              : (
                <Card><CardBody className="flex items-center gap-3 py-5 text-sm text-slate-400"><History size={16} />{t('Scegli un esempio storico per vedere il conteggio di allora e cosa è successo dopo.')}</CardBody></Card>
              )}
          </div>
        )
      }}
    </Q>
  )
}

// ================================================================== pagina
export default function ElliottPage() {
  const [tab, setTab] = useTab<Tab>(TAB_IDS, 'conteggio')
  const [tf, setTf] = useState<EwTf>('1d')
  const [degree, setDegree] = useState<EwDegree>(DEFAULT_DEGREE['1d'])
  const [sel, setSel] = useState(0)
  const q = useElliott(tf, degree)
  useEffect(() => setSel(0), [tf, degree])
  const onTf = (v: EwTf) => { setTf(v); setDegree(DEFAULT_DEGREE[v]) }
  const degrees = q.data?.tf === tf ? q.data.degrees : null
  const refetch = q.refetch
  const tabs = useMemo(() => [
    { value: 'conteggio' as Tab, label: t('Conteggio') }, { value: 'alternativi' as Tab, label: t('Alternativi') },
    { value: 'regole' as Tab, label: t('Regole e linee guida') }, { value: 'backtest' as Tab, label: t('Backtest') },
  ], [])
  let body: ReactNode
  if (tab === 'backtest') body = <BacktestTab key={`${tf}|${degree}`} tf={tf} degree={degree} />
  else body = (
    <Q q={q} loading={<div className="grid gap-3"><div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-[560px]" /><SkeletonBlock rows={3} /></div>}
      isEmpty={(d) => !d.counts.length} empty={t('Nessun conteggio rispetta tutte le regole a questo grado: prova un altro grado o timeframe.')}>
      {(d) => tab === 'alternativi' ? <AltTab d={d} onShow={(i) => { setSel(i); setTab('conteggio') }} />
        : tab === 'regole' ? <RulesTab d={d} sel={sel} setSel={setSel} />
          : <CountTab d={d} sel={sel} setSel={setSel} refetch={() => { void refetch() }} updatedAt={q.dataUpdatedAt} />}
    </Q>
  )
  return (
    <div>
      <PageTitle title={t('Onde di Elliott')}
        subtitle={t('Conteggio automatico con le regole di Frost & Prechter come vincoli e le linee guida come punteggio, alternativi, invalidazione e verifica storica: uno studio, non un segnale.')}
        right={
          <>
            <Segmented size="md" value={tf} onChange={onTf} options={TFS.map((v) => ({ value: v, label: tfLabel(v) }))} />
            <Segmented size="md" value={degree} onChange={setDegree}
              options={(degrees ?? [{ key: degree, mult: 0 }]).map((g) => ({ value: g.key, label: degreeName(g.key) }))} />
          </>
        } />
      <TabBar tabs={tabs} value={tab} onChange={setTab} />
      {body}
    </div>
  )
}
