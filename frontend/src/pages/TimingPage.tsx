import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity, ArrowUpRight, CalendarClock, CalendarSearch, Compass, FlaskConical, GitBranch, Hourglass, Layers, ListChecks, Map as MapIcon, MoonStar,
  Route, Sigma, SlidersHorizontal, Target, Waves,
} from 'lucide-react'
import {
  useTiming, useTimingGann, useTimingRhythms, useTimingWyckoff, type BucketResponse, type GannDate, type GannResponse, type LevelGroup, type RhythmDef,
  type RhythmKind, type ThirdsResponse, type TimingOverview, type WyckoffResponse, type WyStat, type WySummary,
} from '../api/timing'
import ProChart, { type LineDef, type PaneDef, type PriceLineDef, type ZoneDef } from '../components/charts/ProChart'
import { Card, CardBody, CardHeader, Fill, KpiCell, KpiStrip, Legend, MethodNote, PageTitle, Q, Segmented, SkeletonBlock, TabBar, clsx } from '../components/ui'
import {
  BucketChart, BucketHeat, ForestChart, GannPriceChart, GannTypeChart, Mini, PATTERN_GLYPH, ScoreBinsChart, ScoreCalendarChart, ScoreDots, SourceChips,
  ThirdsYearChart, VerdictBadge, WyckoffChart, bucketLabel, daysTxt, fin, fmtP, gannDesc, gannLabel, levelSrc, numberedEvents, phaseDesc, pp,
  setWyHover, sideLabel, sign, signed, statusLabel, useWyHover, verdictText, wyName, wyRule, wyShort,
} from '../widgets/timing'
import { date, int, monthYear, usd } from '../lib/format'
import { useTab } from '../lib/useTab'
import { months, t, tfLabel, tr } from '../i18n'

type Tab = 'scenari' | 'gann' | 'wyckoff' | 'ritmi'
const TABS: { value: Tab; label: string }[] = [
  { value: 'scenari', label: 'Scenari' }, { value: 'gann', label: 'Date chiave Gann' }, { value: 'wyckoff', label: 'Fasi Wyckoff' }, { value: 'ritmi', label: 'Scopritore di ritmi' },
]
const TILE = 'rounded-xl border border-white/[0.06] bg-white/[0.02]'
const NO_LINES: LineDef[] = []
const NO_ZONES: ZoneDef[] = []
const NO_PANES: PaneDef[] = []

const phaseWord = (s: WySummary | undefined) => (s?.active ? `${sideLabel(s.active.side)} · ${usd(s.active.low)}–${usd(s.active.high)}` : t('Nessun range'))

// ================================================================== KPI
function Kpis({ o }: { o: TimingOverview }) {
  const n = o.gann.next
  const v = o.gann.verdicts
  const total = Object.values(v).reduce((a, b) => a + (b ?? 0), 0)
  const rc = o.rhythm.close
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
      <KpiCell icon={<CalendarClock />} accent="violet" label={t('Prossima data chiave')} value={n ? date(n.time, false) : '—'}
        foot={n ? `${t('Punteggio {s}', { s: n.score })} · ${daysTxt(n.days_away)}` : t('Nessuna confluenza ≥ 2 nei prossimi 90 giorni')} />
      <KpiCell icon={<Target />} accent="violet" label={t('Storico di quel punteggio')} value={n && fin(n.hist_hit_rate) ? pp(n.hist_hit_rate, 0) : '—'}
        foot={n ? t('Contro {b} di un giorno qualsiasi', { b: pp(n.hist_base_rate, 0) }) : undefined}
        title={t('Quota di date con questo punteggio seguite da un pivot a {n} giorni entro ±{w} g', { n: o.gann.params.pivot_n, w: o.gann.params.win })} />
      <KpiCell icon={<Sigma />} accent="violet" label={t('Conteggi di Gann significativi')} value={`${v.strong ?? 0} / ${total}`}
        foot={t('{w} deboli · dopo correzione per test multipli', { w: v.weak ?? 0 })} />
      <KpiCell icon={<Layers />} accent="violet" label={t('Wyckoff {tf}', { tf: tfLabel('1d') })} value={o.wyckoff['1d']?.active ? t('Fase {p}', { p: o.wyckoff['1d'].active.phase }) : '—'}
        foot={phaseWord(o.wyckoff['1d'])} />
      <KpiCell icon={<Layers />} accent="violet" label={t('Wyckoff {tf}', { tf: tfLabel('4h') })} value={o.wyckoff['4h']?.active ? t('Fase {p}', { p: o.wyckoff['4h'].active.phase }) : '—'}
        foot={phaseWord(o.wyckoff['4h'])} />
      <KpiCell icon={<Waves />} accent="violet" label={t('Pump · dump · pump')} value={pp(rc.full.rate)}
        foot={t('Dei mesi dal 2017 · caso {c}', { c: pp(rc.full.null) })} title={t('Mese in tre parti, chiusure di segmento')} />
    </KpiStrip>
  )
}

// ================================================================== SCENARI
function LevelRow({ g, price }: { g: LevelGroup; price: number }) {
  return (
    <li className="flex items-start justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <div className="min-w-0">
        <div className="tnum text-sm font-semibold text-white">{usd(g.price)}</div>
        <div className="mt-1"><SourceChips sources={g.sources} /></div>
      </div>
      <span className={clsx('tnum shrink-0 text-xs', sign(g.price - price))}>{signed(g.dist, 2)}</span>
    </li>
  )
}

function statLine(s: WyStat | null | undefined, tf: '1d' | '4h'): string | null {
  if (!s || !s.n) return null
  return t('Dopo un {e} ({tf}) BTC ha fatto in media {m} a {d} giorni, {x} rispetto a un giorno qualsiasi (n = {n}): {v}.', {
    e: wyShort(s.key), tf: tfLabel(tf), m: signed(s.mean), d: s.days, x: signed(s.excess), n: s.n, v: verdictText(s.verdict),
  })
}

function timingLine(n: GannDate | null, w: number, pivot: number): string {
  if (!n) return t('Nessuna data con almeno due conteggi di Gann in confluenza nei prossimi 90 giorni.')
  return t('Finestra di timing più vicina: {d} (±{w} g, punteggio {s}). Le date con questo punteggio sono state seguite da un pivot a {p} giorni nel {h} dei casi contro il {b} di un giorno qualsiasi: {v}.', {
    d: date(n.time), w, s: n.score, p: pivot, h: pp(n.hist_hit_rate, 0), b: pp(n.hist_base_rate, 0), v: verdictText(n.hist_verdict),
  })
}

function ScenarioCard({ o, kind }: { o: TimingOverview; kind: 'hold' | 'lose' }) {
  const sc = o.scenarios!
  const s = sc[kind]
  const lv = s.level
  const hold = kind === 'hold'
  const nx = s.next
  const srcTxt = lv.sources.map(levelSrc).join(' · ')
  return (
    <Card className="h-full">
      <CardHeader icon={<Route />} accent={hold ? 'teal' : 'amber'} kicker={hold ? t('Scenario A') : t('Scenario B')}
        title={hold ? t('Se tiene {p}', { p: usd(lv.price) }) : t('Se perde {p}', { p: usd(lv.price) })}
        subtitle={srcTxt} />
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-slate-300">
          {hold
            ? (nx.length ? t('Finché le chiusure giornaliere restano sopra {p}, i riferimenti successivi sopra il prezzo sono {a}{b}.', {
              p: usd(lv.price), a: usd(nx[0].price), b: nx[1] ? ` ${t('e poi')} ${usd(nx[1].price)}` : '' })
              : t('Finché le chiusure giornaliere restano sopra {p}, non ci sono livelli noti sopra il prezzo entro il ±50%.', { p: usd(lv.price) }))
            : (nx.length ? t('Con una chiusura giornaliera sotto {p}, i riferimenti successivi sotto sono {a}{b}.', {
              p: usd(lv.price), a: usd(nx[0].price), b: nx[1] ? ` ${t('e poi')} ${usd(nx[1].price)}` : '' })
              : t('Con una chiusura giornaliera sotto {p}, non ci sono livelli noti più in basso entro il ±50%.', { p: usd(lv.price) }))}
        </p>
        <div>
          <div className="label mb-1">{hold ? t('Riferimenti sopra') : t('Riferimenti sotto')}</div>
          {nx.length ? <ul>{nx.map((g) => <LevelRow key={g.price} g={g} price={o.price} />)}</ul> : <p className="text-xs text-slate-500">—</p>}
        </div>
        <div className={clsx(TILE, 'mt-auto px-3 py-2.5')}>
          <div className="label">{t('Finestra di timing')}</div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-200">
            <span>{o.gann.next ? `${date(o.gann.next.time)} · ±${o.gann.params.win} ${tr('g', 'd')} · ${t('Punteggio {s}', { s: o.gann.next.score })}` : '—'}</span>
            {o.gann.next && <span className="tnum text-xs text-slate-400">{t('Storico {h} contro {b}', { h: pp(o.gann.next.hist_hit_rate, 0), b: pp(o.gann.next.hist_base_rate, 0) })}</span>}
          </div>
        </div>
        <div className={clsx(TILE, 'px-3 py-2.5')}>
          <div className="label">{t('Lo scenario decade se')}</div>
          <div className="mt-1 text-sm text-slate-200">
            {hold ? t('Chiusura giornaliera sotto {p}', { p: usd(s.invalid.price) }) : t('Ritorno con chiusura giornaliera sopra {p}', { p: usd(s.invalid.price) })}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

function IngredientRow({ icon, title, v, children }: { icon: ReactNode; title: string; v: string | null | undefined; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-t border-line py-3 first:border-t-0 first:pt-0">
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-200">{title}</span>
          {v !== undefined && <VerdictBadge v={(v ?? 'none') as 'none'} short />}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">{children}</p>
      </div>
    </li>
  )
}

function Ingredients({ o }: { o: TimingOverview }) {
  const w1 = o.wyckoff['1d'], w4 = o.wyckoff['4h']
  const rc = o.rhythm.close
  const cur = rc.current
  const done = (cur.partial ?? []).filter((x) => x !== null).length
  return (
    <Card className="h-full">
      <CardHeader icon={<ListChecks />} title={t('Ingredienti e track record')} subtitle={t('Ogni ingrediente con il suo verdetto storico')} />
      <CardBody>
        <ul>
          <IngredientRow icon={<CalendarClock size={16} />} title={t('Date chiave di Gann')} v={o.gann.next?.hist_verdict ?? 'none'}>
            {timingLine(o.gann.next, o.gann.params.win, o.gann.params.pivot_n)}
          </IngredientRow>
          <IngredientRow icon={<Layers size={16} />} title={t('Wyckoff {tf}', { tf: tfLabel('1d') })} v={w1?.stat?.verdict ?? (w1?.active ? 'anecdotal' : null)}>
            {w1?.active ? `${t('{s} in fase {p} ({a}), range {l}–{h}.', { s: sideLabel(w1.active.side), p: w1.active.phase, a: phaseDesc(w1.active.phase), l: usd(w1.active.low), h: usd(w1.active.high) })} ${statLine(w1.stat, '1d') ?? ''}`
              : t('Nessun range di Wyckoff attivo su questo timeframe.')}
          </IngredientRow>
          <IngredientRow icon={<Layers size={16} />} title={t('Wyckoff {tf}', { tf: tfLabel('4h') })} v={w4?.stat?.verdict ?? (w4?.active ? 'anecdotal' : null)}>
            {w4?.active ? `${t('{s} in fase {p} ({a}), range {l}–{h}.', { s: sideLabel(w4.active.side), p: w4.active.phase, a: phaseDesc(w4.active.phase), l: usd(w4.active.low), h: usd(w4.active.high) })} ${statLine(w4.stat, '4h') ?? ''}`
              : t('Nessun range di Wyckoff attivo su questo timeframe.')}
          </IngredientRow>
          <IngredientRow icon={<Waves size={16} />} title={t('Pump inizio · dump metà · pump fine')} v={rc.verdict}>
            {t('Dal 2017 lo schema compare nel {r} dei mesi contro il {n} atteso per caso; nei mesi da agosto 2026: {k} su {m}.', {
              r: pp(rc.full.rate), n: pp(rc.full.null), k: rc.recent.k, m: rc.recent.n })}{' '}
            {done === 1 ? t('Mese in corso: 1 parte conclusa su 3.') : done ? t('Mese in corso: {d} parti concluse su 3.', { d: done }) : t('Mese in corso: nessuna parte ancora conclusa.')}
          </IngredientRow>
          <IngredientRow icon={<MapIcon size={16} />} title={t('Livelli')} v={undefined}>
            {t('Range di Wyckoff, range giornaliero della sezione Struttura e VWAP ancorati: sono livelli esistenti, raggruppati entro lo 0.6%, non previsioni.')}
          </IngredientRow>
        </ul>
      </CardBody>
    </Card>
  )
}

function LevelsMapCard({ o, candles }: { o: TimingOverview; candles: WyckoffResponse['candles'] }) {
  const priceLines = useMemo<PriceLineDef[]>(() => o.levels.filter((l) => Math.abs(l.dist) < 15).map((l) => ({
    price: l.price, color: l.sources.some((s) => s.startsWith('wy_')) ? 'rgba(155,135,245,0.75)' : l.sources.some((s) => s.startsWith('vwap')) ? 'rgba(60,198,176,0.7)' : 'rgba(148,163,184,0.6)',
    title: l.sources.length > 1 ? `×${l.sources.length}` : '', dashed: !l.sources.some((s) => s.startsWith('wy_')),
  })), [o])
  return (
    <Card className="h-full xl:col-span-2">
      <CardHeader icon={<MapIcon />} title={t('Mappa dei livelli')} subtitle={t('Candele giornaliere · livelli usati dagli scenari (entro il ±15%)')} />
      <CardBody className="flex flex-col">
        <Fill min={380}>
          <ProChart candles={candles} liveTf="1d" lines={NO_LINES} priceLines={priceLines} zones={NO_ZONES} panes={NO_PANES} height="100%" volume={false}
            tfLabel={tfLabel('1d')} fitKey="timing-levels" wheel={false} />
        </Fill>
        <div className="mt-2"><Legend items={[
          { label: t('Range di Wyckoff'), color: 'rgba(155,135,245,0.9)' },
          { label: t('VWAP ancorati'), color: 'rgba(60,198,176,0.9)', dashed: true },
          { label: t('Range di struttura'), color: 'rgba(148,163,184,0.8)', dashed: true },
          { label: t('×n = livelli raggruppati'), color: '#8B94A7' },
        ]} /></div>
      </CardBody>
    </Card>
  )
}

function UpcomingList({ items, win, max }: { items: GannDate[]; win: number; max?: number }) {
  const list = (max ? items.slice(0, max) : items)
  if (!list.length) return <p className="py-6 text-center text-sm text-slate-400">{t('Nessuna data con almeno due conteggi in confluenza')}</p>
  return (
    <ul>
      {list.map((u) => (
        <li key={u.time} className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2.5 first:border-t-0">
          <div className="text-center">
            <div className="tnum text-lg font-semibold leading-none text-white">{new Date(u.time * 1000).getUTCDate()}</div>
            <div className="mt-0.5 text-2xs uppercase tracking-wide text-slate-400">{months()[new Date(u.time * 1000).getUTCMonth()]}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><ScoreDots score={u.score} /><span className="text-xs text-slate-400">{daysTxt(u.days_away)} · ±{win} {tr('g', 'd')}</span></div>
            <div className="mt-1 truncate text-xs text-slate-300" title={u.types.map(gannLabel).join(' · ')}>{u.types.map(gannLabel).join(' · ')}</div>
          </div>
          <div className="text-right">
            <div className="tnum text-xs text-slate-200">{pp(u.hist_hit_rate, 0)} <span className="text-slate-500">/ {pp(u.hist_base_rate, 0)}</span></div>
            <div className="mt-1"><VerdictBadge v={u.hist_verdict ?? 'none'} short /></div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function ScenariTab({ o }: { o: TimingOverview }) {
  const w1 = useTimingWyckoff('1d')
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {o.scenarios ? (
          <>
            <ScenarioCard o={o} kind="hold" />
            <ScenarioCard o={o} kind="lose" />
          </>
        ) : (
          <Card className="h-full lg:col-span-2"><CardBody className="py-10 text-center text-sm text-slate-400">{t('Nessun supporto noto sotto il prezzo: scenari non disponibili.')}</CardBody></Card>
        )}
        <Card className="h-full lg:col-span-2 xl:col-span-1">
          <CardHeader icon={<CalendarSearch />} title={t('Prossime date chiave')} subtitle={t('Conteggi di Gann in confluenza · storico del punteggio')} />
          <CardBody className="pt-0"><UpcomingList items={o.gann.upcoming} win={o.gann.params.win} max={6} /></CardBody>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        {w1.data ? <LevelsMapCard o={o} candles={w1.data.candles} /> : <Card className="xl:col-span-2"><CardBody><SkeletonBlock chart rows={2} /></CardBody></Card>}
        <Ingredients o={o} />
      </div>
      <MethodNote title={t('Metodo · scenari')}>
        <p>{t('Gli scenari sono composti da regole fisse, senza modelli linguistici: il livello di riferimento è il gruppo di livelli esistenti più vicino sotto il prezzo (range di Wyckoff 1G e 4h, range giornaliero della sezione Struttura, VWAP ancorati settimanale, mensile, trimestrale, annuale e dei periodi precedenti), raggruppati quando distano meno dello 0.6%. Lo scenario A elenca i due gruppi successivi sopra il prezzo, lo scenario B i due sotto il livello.')}</p>
        <p>{t('Accanto a ogni ingrediente c’è il suo verdetto storico. Gli scenari descrivono livelli e condizioni, non indicano operazioni: nessun ingrediente ha mostrato finora un vantaggio significativo e stabile rispetto al caso, salvo dove il verdetto dice il contrario.')}</p>
      </MethodNote>
    </div>
  )
}

// ================================================================== GANN
function GannTab() {
  const [pivot, setPivot] = useState(10)
  const [win, setWin] = useState(2)
  const [horizon, setHorizon] = useState(90)
  const q = useTimingGann({ horizon, pivot, win })
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented value={pivot} onChange={setPivot} options={[{ value: 10, label: t('Pivot 10 g') }, { value: 20, label: t('Pivot 20 g') }]} />
      <Segmented value={win} onChange={setWin} options={[1, 2, 3].map((w) => ({ value: w, label: `±${w} ${tr('g', 'd')}` }))} />
      <Segmented value={horizon} onChange={setHorizon} options={[30, 60, 90, 180].map((h) => ({ value: h, label: `${h} ${tr('g', 'd')}` }))} />
    </div>
  )
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader icon={<SlidersHorizontal />} title={t('Definizione del test')} subtitle={t('Pivot bersaglio, finestra attorno alla data e orizzonte delle prossime date')} right={controls}
          info={t('Pivot a N giorni = massimo (o minimo) più estremo delle 2N+1 candele giornaliere centrate. Una data proiettata «colpisce» se c’è almeno un pivot entro ±W giorni. Le 6 combinazioni consultabili sono corrette insieme per test multipli.')} />
      </Card>
      <Q q={q} loading={<SkeletonBlock chart rows={6} />}>{(g) => <GannBody g={g} />}</Q>
    </div>
  )
}

function GannBody({ g }: { g: GannResponse }) {
  const keyDates = g.upcoming.filter((u) => u.score >= 2)
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<CalendarClock />} title={t('Calendario di confluenza')} subtitle={t('Quanti tipi di conteggio cadono su ogni giorno (±1 g) · prossimi {h} giorni', { h: g.horizon })}
            info={t('Ogni barra conta i tipi di conteggio di Gann distinti che proiettano una data entro ±1 giorno, solo da pivot maggiori già confermati oggi. Le barre piene sono le date da osservare (massimi locali con punteggio ≥ 2).')} />
          <CardBody className="flex flex-col"><Fill min={300}><ScoreCalendarChart g={g} /></Fill></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<CalendarSearch />} title={t('Date da osservare')} subtitle={t('Hit rate storico del punteggio / giorno qualsiasi')} />
          <CardBody className="pt-0"><UpcomingList items={keyDates} win={g.params.win} max={8} /></CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader icon={<FlaskConical />} title={t('Track record per tipo di conteggio')}
          subtitle={t('{d} giorni dal {s} · {a} pivot maggiori · {b} pivot bersaglio', { d: int(g.sample.days), s: date(g.sample.start), a: g.sample.anchors, b: g.sample.targets })}
          info={t('Hit rate = quota di date proiettate con un pivot entro la finestra. Caso = stessa quota con le date traslate a caso (stessa densità e stessi grappoli). Conteggi vicini = stesse ancore con conteggi spostati del 5–20% (non di Gann). p corretto: Benjamini-Hochberg su tutti i tipi e su tutte le 6 definizioni.')} />
        <CardBody className="pt-0">
          <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
            <table className="tbl min-w-[980px]">
              <thead><tr>
                <th className="pl-4 sm:pl-5">{t('Conteggio')}</th><th className="text-right">n</th><th className="text-right">{t('Hit rate')}</th><th className="text-right">{t('Caso')}</th>
                <th className="text-right">{t('Rapporto')}</th><th className="text-right">{t('Conteggi vicini')}</th><th className="text-right">p</th><th className="text-right">{t('p corretto')}</th>
                <th className="text-right">{t('Metà 1 · 2')}</th><th className="pr-4 sm:pr-5">{t('Verdetto')}</th>
              </tr></thead>
              <tbody>
                {g.types.map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-[260px] pl-4 sm:pl-5"><div className="truncate font-medium text-slate-200" title={gannDesc(r.id)}>{gannLabel(r.id)}</div></td>
                    <td className={clsx('text-right', r.n < g.params.min_n ? 'text-amber-300' : 'text-slate-300')}>{int(r.n)}</td>
                    <td className="text-right text-white">{pp(r.hit_rate)}</td>
                    <td className="text-right text-slate-400">{pp(r.base_rate)}</td>
                    <td className={clsx('text-right', fin(r.lift) && r.lift > 1 ? 'text-slate-100' : 'text-slate-400')}>{fin(r.lift) ? `×${r.lift.toFixed(2)}` : '—'}</td>
                    <td className="text-right text-slate-400">{pp(r.ctrl_rate)}</td>
                    <td className="text-right text-slate-300">{fmtP(r.p_shift)}</td>
                    <td className="text-right text-slate-300">{fmtP(r.p_bh_all ?? r.p_bh)}</td>
                    <td className="text-right text-slate-400">{(r.halves ?? []).map((h) => (fin(h.lift) ? `×${h.lift.toFixed(2)}` : '—')).join(' · ')}</td>
                    <td className="pr-4 sm:pr-5"><VerdictBadge v={r.verdict} short /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="h-full">
          <CardHeader icon={<Activity />} title={t('Hit rate contro la banda del caso')} subtitle={t('Un punto fuori dalla banda grigia è insolito; dentro non si distingue dal caso')} />
          <CardBody className="flex flex-col"><Fill min={420}><GannTypeChart g={g} /></Fill></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Target />} title={t('Il punteggio di confluenza funziona?')} subtitle={t('Giorni del passato per punteggio, calcolato solo con pivot già confermati')}
            info={t('Per ogni giorno dal 2012 si conta quanti tipi di conteggio cadevano su quel giorno usando solo pivot confermati prima della finestra. La barra è la quota di quei giorni con un pivot entro ±W giorni; la linea tratteggiata è un giorno qualsiasi; il trattino ambra è il 95° percentile del caso.')} />
          <CardBody className="flex flex-col"><Fill min={420}><ScoreBinsChart bins={g.score_bins} /></Fill></CardBody>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<GitBranch />} title={t('Pivot maggiori e pivot bersaglio')} subtitle={t('Candele giornaliere Binance · zigzag {m}× ATR', { m: g.params.anchor_mult })} />
          <CardBody className="flex flex-col"><Fill min={420}><GannPriceChart g={g} /></Fill></CardBody>
        </Card>
        <GannLevelsCard g={g} />
      </div>
      <MethodNote title={t('Metodo · conteggi di Gann')}>
        <p>{t('Ancore: pivot maggiori dello zigzag {m}× ATR(14) sulla serie giornaliera dal 2012, ciascuno con la data in cui diventa noto (conferma). Una data proiettata vale solo se la sua finestra inizia dopo la conferma dell’ancora: nessun dato futuro. Bersaglio: pivot a {n} giorni (massimo o minimo più estremo delle {k} candele centrate), finestra ±{w} giorni.', { m: g.params.anchor_mult, n: g.params.pivot_n, k: 2 * g.params.pivot_n + 1, w: g.params.win })}</p>
        <p>{t('Conteggi: 30, 45, 60, 90, 120, 144, 180, 270, 360 giorni; multipli lunghi 540, 720, 1080; quadrato del 9 nel tempo (numeri sulle croci cardinale e diagonale, da 21 a 400 giorni); divisioni dell’anno 1/8, 1/6, 1/4, 1/3; anniversari 1–4 anni; date stagionali fisse (equinozi, solstizi, 4 feb, 6 mag, 8 ago, 8 nov).')}</p>
        <p>{t('Test: placebo a traslazione circolare delle date proiettate (ogni spostamento ≥ {s} giorni, stessa densità e stessi grappoli) e placebo dei conteggi (stesse ancore, conteggio moltiplicato per un fattore casuale tra 0.8 e 1.2, {c} estrazioni). Correzione di Benjamini-Hochberg sui {a} test di tutte le definizioni consultabili. Verdetto: n < {mn} aneddotico; significativo e stabile solo se regge alla correzione, batte anche i conteggi vicini e vale in entrambe le metà del campione.', { s: g.params.min_shift, c: g.params.n_ctrl, a: g.params.tests_all, mn: g.params.min_n })}</p>
        <p>{t('Collegamenti: il quadrato del 9 sui prezzi e Fibonacci nel tempo sono testati nella sezione Astronomia e numeri; stagionalità, Fibonacci time zones e tempi di ciclo nella sezione Pivot temporali.')}</p>
      </MethodNote>
    </>
  )
}

function GannLevelsCard({ g }: { g: GannResponse }) {
  const sq = g.sq9
  const fan = g.fan
  return (
    <Card className="h-full">
      <CardHeader icon={<Compass />} title={t('Livelli prezzo-tempo (opzionali)')} subtitle={t('Strumenti grafici di Gann: la scala su BTC è arbitraria')}
        info={t('Il quadrato del 9 ruota la radice quadrata del prezzo: +45° = +0.25 sulla radice. Gli angoli 1×1, 2×1, 1×2 richiedono una scala prezzo/tempo: qui 1×1 = pendenza media della gamba maggiore precedente (dollari al giorno). Cambiando scala cambiano tutte le linee: non sono testati qui.')} />
      <CardBody className="flex flex-col gap-4 pt-0">
        {sq && (
          <div>
            <div className="label mb-1">{t('Quadrato del 9 dal pivot {p}', { p: usd(sq.anchor.price) })}</div>
            <ul>
              {sq.levels.map((l) => (
                <li key={l.deg} className="flex items-center justify-between gap-3 border-t border-line py-1.5 text-xs first:border-t-0">
                  <span className="tnum text-slate-400">{l.deg >= 0 ? '+' : '−'}{t('{g} giri', { g: Math.floor(Math.abs(l.deg) / 360) })} {Math.abs(l.deg) % 360}°</span>
                  <span className="tnum text-slate-200">{usd(l.price)}</span>
                  <span className={clsx('tnum w-16 text-right', sign(l.dist))}>{signed(l.dist, 2)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-2xs text-slate-500">{t('Passo di 45° vicino al prezzo: circa {u}', { u: usd(sq.step_usd) })}</p>
          </div>
        )}
        {fan && (
          <div>
            <div className="label mb-1">{t('Angoli dal pivot del {d}', { d: date(fan.anchor.time) })}</div>
            <ul>
              {fan.lines.map((l) => (
                <li key={l.key} className="flex items-center justify-between gap-3 border-t border-line py-1.5 text-xs first:border-t-0">
                  <span className="text-slate-400">{l.key.replace('x', '×')} · {usd(l.slope)}/{tr('g', 'd')}</span>
                  <span className="tnum text-slate-200">{usd(l.price)}</span>
                  <span className={clsx('tnum w-16 text-right', sign(l.dist))}>{signed(l.dist, 2)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Link to="/astronomia?tab=numeri" className="inline-flex items-center gap-1 text-xs text-sky-300 hover:underline">
          {t('Il quadrato del 9 sui prezzi è testato in Astronomia e numeri')} <ArrowUpRight size={12} />
        </Link>
      </CardBody>
    </Card>
  )
}

// ================================================================== WYCKOFF
const PHASES = ['A', 'B', 'C', 'D', 'E'] as const

function WyckoffTab() {
  const [tf, setTf] = useState<'1d' | '4h'>('1d')
  const [days, setDays] = useState(10)
  const q = useTimingWyckoff(tf)
  return (
    <div className="flex flex-col gap-3">
      <Q q={q} loading={<SkeletonBlock chart rows={6} />}>{(w) => <WyckoffBody w={w} tf={tf} setTf={setTf} days={days} setDays={setDays} />}</Q>
    </div>
  )
}

function PhaseStepper({ phase }: { phase: string }) {
  const i = PHASES.indexOf(phase as typeof PHASES[number])
  return (
    <div className="grid grid-cols-5 gap-1">
      {PHASES.map((p, k) => (
        <div key={p} className="min-w-0">
          <div className={clsx('h-1.5 rounded-full', k < i ? 'bg-accent-purple/50' : k === i ? 'bg-accent-purple' : 'bg-white/[0.08]')} />
          <div className={clsx('mt-1 text-center text-2xs font-medium', k === i ? 'text-white' : 'text-slate-500')}>{p}</div>
        </div>
      ))}
    </div>
  )
}

function WyckoffBody({ w, tf, setTf, days, setDays }: { w: WyckoffResponse; tf: '1d' | '4h'; setTf: (v: '1d' | '4h') => void; days: number; setDays: (v: number) => void }) {
  const a = w.active
  const evs = useMemo(() => numberedEvents(w), [w])
  const activeEvs = a ? evs.filter((e) => a.events.some((x) => x.key === e.key && x.time === e.time)) : []
  const hover = useWyHover()
  const tfSeg = <Segmented value={tf} onChange={setTf} options={[{ value: '1d', label: tfLabel('1d') }, { value: '4h', label: tfLabel('4h') }]} />
  const rows = w.backtest.rows
  const oc = w.outcomes
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<Layers />} title={t('Range ed eventi di Wyckoff')} subtitle={t('Candele {tf} Binance · eventi rilevati solo con candele chiuse', { tf: tfLabel(tf) })} right={tfSeg} />
          <CardBody className="flex flex-col"><Fill min={460}><WyckoffChart w={w} /></Fill></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Hourglass />} title={t('Range attuale')} subtitle={a ? `${sideLabel(a.side)} · ${t('dal {d}', { d: date(a.start) })}` : t('Nessun range attivo')} />
          <CardBody className="flex flex-col gap-4 pt-0">
            {a ? (
              <>
                <div>
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-xl font-semibold tracking-[-0.01em] text-white">{t('Fase {p}', { p: a.phase })}</div>
                    <span className="text-xs text-slate-400">{phaseDesc(a.phase)}</span>
                  </div>
                  <div className="mt-2"><PhaseStepper phase={a.phase} /></div>
                </div>
                <div className={clsx(TILE, 'dgrid grid-cols-3')}>
                  <div className="px-3 py-2.5"><Mini label={t('Massimo')} value={usd(a.high)} /></div>
                  <div className="px-3 py-2.5"><Mini label={t('Minimo')} value={usd(a.low)} /></div>
                  <div className="px-3 py-2.5"><Mini label={t('Ampiezza')} value={pp(a.width_pct)} /></div>
                </div>
                <div>
                  <div className="label mb-1">{t('Eventi del range')}</div>
                  <ul>
                    {activeEvs.map((e) => (
                      <li key={e.n} onMouseEnter={() => setWyHover(`${w.tf}:${e.n}`)} onMouseLeave={() => setWyHover(null)}
                        className={clsx('grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 border-t border-line py-1.5 first:border-t-0', hover === `${w.tf}:${e.n}` && 'bg-white/[0.03]')}>
                        <span className="tnum grid h-[18px] w-[18px] place-items-center rounded-full border border-white/[0.16] text-[10.5px] font-semibold text-white">{e.n}</span>
                        <span className="min-w-0 truncate text-sm text-slate-200" title={wyRule(e.key)}>{wyShort(e.key)} <span className="text-xs text-slate-500">· {wyName(e.key)}</span></span>
                        <span className="tnum text-right text-xs text-slate-400">{date(e.time, false)} · {usd(e.price)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-400">{w.last_range ? t('Ultimo range: {s}, {st} il {d}.', { s: sideLabel(w.last_range.side), st: statusLabel(w.last_range.status).toLowerCase(), d: date(w.last_range.end) }) : '—'}</p>
            )}
            {a && <LastEventStat w={w} a={a} />}
            <div className={clsx(TILE, 'mt-auto grid grid-cols-2 gap-3 px-3 py-2.5')}>
              <Mini label={t('Accumulazioni → rialzo')} value={`${oc.acc_up ?? 0} / ${(oc.acc_up ?? 0) + (oc.acc_failed ?? 0) + (oc.acc_expired ?? 0)}`} />
              <Mini label={t('Distribuzioni → ribasso')} value={`${oc.dist_down ?? 0} / ${(oc.dist_down ?? 0) + (oc.dist_failed ?? 0) + (oc.dist_expired ?? 0)}`} />
            </div>
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-3 2xl:grid-cols-3">
        <Card className="h-full 2xl:col-span-2">
          <CardHeader icon={<FlaskConical />} title={t('Track record degli eventi')}
            subtitle={t('Rendimento dalla chiusura della candela di conferma · {n} test corretti insieme', { n: w.backtest.tests })}
            right={<Segmented value={days} onChange={setDays} options={w.params.horizons.map((d) => ({ value: d, label: `${d} ${tr('g', 'd')}` }))} />}
            info={t('Normale = rendimento medio di tutte le candele del campione sullo stesso orizzonte. «Nella direzione» = quota di eventi seguiti da un movimento nella direzione prevista dallo schema (rialzo dopo Spring/SOS, ribasso dopo UTAD/SOW), contro la stessa quota di una candela qualsiasi. p da 2000 estrazioni casuali di candele; correzione di Benjamini-Hochberg su tutti gli eventi e orizzonti del timeframe.')} />
          <CardBody className="pt-0">
            <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
              <table className="tbl min-w-[880px]">
                <thead><tr>
                  <th className="pl-4 sm:pl-5">{t('Evento')}</th><th className="text-right">n</th><th className="text-right">{t('Media')}</th><th className="text-right">{t('Normale')}</th>
                  <th className="text-right">{t('Scarto')}</th><th className="text-right">{t('IC 95%')}</th><th className="text-right">{t('Nella direzione')}</th>
                  <th className="text-right">{t('p corretto')}</th><th className="pr-4 sm:pr-5">{t('Verdetto')}</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const h = r.horizons.find((x) => x.days === days)!
                    const key = ['SPRING', 'UTAD', 'SOS', 'SOW'].includes(r.key)
                    return (
                      <tr key={r.key}>
                        <td className="pl-4 sm:pl-5">
                          <span className={clsx('font-medium', key ? 'text-white' : 'text-slate-300')} title={wyRule(r.key)}>{wyShort(r.key)}</span>
                          <span className="ml-1.5 text-xs text-slate-500">{r.side === 'acc' ? t('accumulazione') : t('distribuzione')} · {r.direction === 'up' ? '▲' : '▼'}</span>
                        </td>
                        <td className={clsx('text-right', h.n < w.params.min_n ? 'text-amber-300' : 'text-slate-300')}>{h.n}</td>
                        <td className={clsx('text-right', sign(h.mean))}>{signed(h.mean)}</td>
                        <td className="text-right text-slate-400">{signed(h.base_mean)}</td>
                        <td className={clsx('text-right', sign(h.excess))}>{signed(h.excess)}</td>
                        <td className="text-right text-slate-400">{h.ci ? `${signed(h.ci[0], 1)} … ${signed(h.ci[1], 1)}` : '—'}</td>
                        <td className="text-right text-slate-200">{pp(h.hit, 0)} <span className="text-slate-500">/ {pp(h.base_hit, 0)}</span></td>
                        <td className="text-right text-slate-300">{fmtP(h.p_bh)}</td>
                        <td className="pr-4 sm:pr-5"><VerdictBadge v={h.verdict} short />{h.n >= w.params.min_n && h.agrees === false && fin(h.p) && h.p < 0.05 && <span className="ml-1.5 text-2xs text-amber-300">{t('opposto alla teoria')}</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Activity />} title={t('Scarto con intervallo di confidenza')} subtitle={t('Verde: nella direzione dello schema · ambra: contraria · grigio: n < {m}', { m: w.params.min_n })} />
          <CardBody className="flex flex-col"><Fill min={420}><ForestChart rows={rows} days={days} /></Fill></CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader icon={<Route />} title={t('Timeline dei range')} subtitle={t('Ultimi {n} range rilevati su {tf}, dal più recente', { n: w.timeline.length, tf: tfLabel(tf) })} />
        <CardBody className="pt-0">
          <div className="no-scrollbar -mx-4 max-h-[520px] overflow-auto sm:-mx-5">
            <table className="tbl min-w-[860px]">
              <thead className="sticky top-0 z-[1] bg-[#0E1424]"><tr>
                <th className="pl-4 sm:pl-5">{t('Inizio')}</th><th>{t('Tipo')}</th><th>{t('Esito')}</th><th>{t('Fase')}</th><th className="text-right">{t('Range')}</th>
                <th>{t('Eventi')}</th><th className="pr-4 text-right sm:pr-5">{t('Dopo 20 candele')}</th>
              </tr></thead>
              <tbody>
                {w.timeline.map((r) => (
                  <tr key={`${r.start}-${r.side}`}>
                    <td className="pl-4 text-slate-200 sm:pl-5">{date(r.start)}</td>
                    <td className={r.side === 'acc' ? 'text-[#3CC6B0]' : 'text-[#B49CFF]'}>{sideLabel(r.side)}</td>
                    <td className="text-slate-300">{statusLabel(r.status)}</td>
                    <td className="text-slate-300">{r.phase}</td>
                    <td className="text-right text-slate-300">{usd(r.low)}–{usd(r.high)}</td>
                    <td className="max-w-[320px]"><span className="block truncate text-xs text-slate-400" title={r.events.map((e) => wyShort(e.key)).join(' · ')}>{r.events.map((e) => wyShort(e.key)).join(' · ')}</span></td>
                    <td className={clsx('pr-4 text-right sm:pr-5', sign(r.after_20))}>{signed(r.after_20)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      <MethodNote title={t('Metodo · Wyckoff')}>
        <p>{t('Regole dichiarate, applicate candela per candela solo su candele chiuse (ogni evento ha la candela in cui si forma e quella in cui diventa noto). Volume relativo = volume ÷ mediana dei 50 precedenti; ATR(14) della candela precedente; campione {tf}: {s}.', { tf: tfLabel(tf), s: w.backtest.segments.map((s) => `${date(s.since)} → ${date(s.until)}`).join(' + ') })}</p>
        <p>{t('Accumulazione: SC = nuovo minimo di {lb} candele dopo un ribasso ≥ 5 ATR e ≥ {tp}%, con volume relativo ≥ 1.8 (o ≥ 1.4 e candela ≥ 1.6 ATR); AR = massimo frattale dopo lo SC (rimbalzo ≥ 2 ATR) che fissa il range; ST = ritorno nel 20% basso del range (fase B); Spring = minimo sotto il range e chiusura dentro entro 2 candele (fase C); SOS = chiusura sopra il range con volume relativo ≥ 1.2 o candela ≥ 1.2 ATR (fase D); LPS = primo minimo frattale dopo la rottura sopra metà range; fase E = nuovo massimo dopo l’LPS o range + 1 ampiezza. Distribuzione speculare (PSY, BC, AR, ST, UT ≤ 0.5 ATR, UTAD, SOW, LPSY). Due chiusure oltre il bordo opposto chiudono il range come fallito.', { lb: w.params.lb, tp: w.params.trend_pct })}</p>
        <p>{t('I parametri (durata minima {ma} candele, ampiezza minima {mw} ATR) sono stati scelti perché i range abbiano forma e durata plausibili, non guardando i rendimenti. I campioni sono piccoli: molti eventi restano aneddotici.', { ma: w.params.min_age, mw: w.params.min_w })}</p>
      </MethodNote>
    </>
  )
}

function LastEventStat({ w, a }: { w: WyckoffResponse; a: NonNullable<WyckoffResponse['active']> }) {
  const ev = [...a.events].reverse().find((e) => w.backtest.rows.some((r) => r.key === e.key))
  const row = ev ? w.backtest.rows.find((r) => r.key === ev.key) : undefined
  const h = row?.horizons.find((x) => x.days === 10)
  if (!ev || !row || !h) return null
  return (
    <div className={clsx(TILE, 'px-3 py-2.5')}>
      <div className="flex items-center justify-between gap-2">
        <span className="label">{t('Storico dopo un {e}', { e: wyShort(ev.key) })}</span>
        <VerdictBadge v={h.verdict} short />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-3">
        <Mini label={t('Media 10 g')} value={signed(h.mean)} cls={sign(h.mean)} />
        <Mini label={t('Normale')} value={signed(h.base_mean)} />
        <Mini label="n" value={h.n} cls={h.n < w.params.min_n ? 'text-amber-300' : undefined} />
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-slate-500">{t('Direzione attesa dallo schema: {d}. Nella direzione nel {h} dei casi contro {b} di una candela qualsiasi.', {
        d: row.direction === 'up' ? t('rialzo') : t('ribasso'), h: pp(h.hit, 0), b: pp(h.base_hit, 0) })}</p>
    </div>
  )
}

// ================================================================== RITMI
const KINDS: { value: RhythmKind; label: string }[] = [
  { value: 'thirds', label: 'Mese in tre parti' }, { value: 'weekday', label: 'Giorno della settimana' }, { value: 'monthweek', label: 'Settimana del mese' },
  { value: 'monthday', label: 'Giorno del mese' }, { value: 'hour', label: 'Ora UTC' },
]
const SEG_OPTS = [{ value: '+', label: '▲' }, { value: '-', label: '▼' }, { value: '.', label: '·' }] as const

function recentOptions(): { value: string; label: string }[] {
  const out = []
  const d = new Date()
  for (let k = 1; k <= 36; k++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1))
    out.push({ value: x.toISOString().slice(0, 10), label: monthYear(x.getTime() / 1000) })
  }
  return out
}

function RitmiTab() {
  const [kind, setKind] = useState<RhythmKind>('thirds')
  const [how, setHow] = useState<RhythmDef>('close')
  const [pattern, setPattern] = useState('+-+')
  const [theta, setTheta] = useState(3)
  const [start, setStart] = useState<'2017' | '2013'>('2017')
  const [recent, setRecent] = useState('2026-08-01')
  const q = useTimingRhythms({ kind, how, pattern, theta, start, recent })
  const recOpts = useMemo(recentOptions, [])
  const setSeg = (i: number, v: string) => {
    const p = pattern.split('')
    p[i] = v
    const np = p.join('')
    if (np !== '...') setPattern(np)
  }
  const preset = () => { setKind('thirds'); setPattern('+-+'); setRecent('2026-08-01') }
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader icon={<SlidersHorizontal />} title={t('Che cosa vuoi verificare?')} subtitle={t('Scegli il ritmo, la definizione e il periodo «recente»: il confronto con il caso è automatico')}
          right={<button type="button" className="btn-ghost" onClick={preset}>{t('Pump inizio · dump metà · pump fine')}</button>} />
        <CardBody className="flex flex-col gap-3 pt-0">
          <Segmented value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: t(k.label) }))} />
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
            {kind === 'thirds' && (
              <>
                {[t('Giorni 1–10'), t('Giorni 11–20'), t('Giorni 21–fine')].map((lab, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <span className="label">{lab}</span>
                    <Segmented value={pattern[i]} onChange={(v) => setSeg(i, v)} options={SEG_OPTS.map((o) => ({ value: o.value, label: o.label }))} />
                  </div>
                ))}
                <div className="flex flex-col gap-1">
                  <span className="label">{t('Definizione')}</span>
                  <Segmented value={how} onChange={setHow} options={[{ value: 'close', label: t('Chiusure di segmento') }, { value: 'extremes', label: t('Massimi e minimi') }]} />
                </div>
                {how === 'extremes' && (
                  <div className="flex flex-col gap-1">
                    <span className="label">{t('Soglia')}</span>
                    <Segmented value={theta} onChange={setTheta} options={[2, 3, 5].map((x) => ({ value: x, label: `${x}%` }))} />
                  </div>
                )}
              </>
            )}
            <div className="flex flex-col gap-1">
              <span className="label">{t('Storico')}</span>
              <Segmented value={start} onChange={setStart} options={[{ value: '2017', label: t('Dal 2017') }, { value: '2013', label: t('Dal 2013') }]} />
            </div>
            <label className="flex flex-col gap-1">
              <span className="label">{t('Periodo recente da')}</span>
              <select value={recent} onChange={(e) => setRecent(e.target.value)} aria-label={t('Periodo recente da')}
                className="h-8 rounded-lg border border-line bg-white/[0.03] px-2 text-xs text-slate-200 sm:h-7">
                {recOpts.map((o) => <option key={o.value} value={o.value} className="bg-[#0E1424]">{o.label}</option>)}
              </select>
            </label>
          </div>
        </CardBody>
      </Card>
      <Q q={q} loading={<SkeletonBlock chart rows={6} />}>
        {(r) => (r.kind === 'thirds' ? <ThirdsBody r={r as ThirdsResponse} /> : <BucketBody r={r as BucketResponse} />)}
      </Q>
    </div>
  )
}

function thirdsDefText(r: ThirdsResponse) {
  return r.def === 'close'
    ? t('▲/▼ = la parte chiude sopra/sotto la chiusura della parte precedente (la prima parte rispetto alla chiusura del mese prima).')
    : t('▲ = il massimo della parte supera di almeno {th}% il riferimento, ▼ = il minimo scende di almeno {th}% sotto il riferimento; il riferimento è la chiusura del mese prima e poi l’estremo della parte precedente.', { th: r.theta })
}

function ThirdsBody({ r }: { r: ThirdsResponse }) {
  const f = r.full
  const rec = r.recent
  const sentence = t('Lo schema {p} compare nel {r} dei mesi ({k} su {n}) contro il {c} atteso per caso. Nel periodo recente: {kr} mesi su {nr}. Guardando {m} combinazioni possibili, il p corretto è {ps}: {v}.', {
    p: PATTERN_GLYPH(r.pattern), r: pp(f.rate), k: f.k, n: f.n, c: pp(f.null), kr: rec.k, nr: rec.n, m: r.combos, ps: fmtP(r.p_sidak), v: verdictText(r.verdict),
  })
  return (
    <>
      <KpiStrip cols="grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
        <KpiCell icon={<CalendarClock />} accent="violet" label={t('Periodo recente')} value={`${rec.k} / ${rec.n}`} foot={t('Mesi completi da {d}', { d: monthYear(rec.from) })} />
        <KpiCell icon={<Waves />} accent="violet" label={t('Su tutto lo storico')} value={pp(f.rate)} foot={t('{k} mesi su {n}', { k: f.k, n: f.n })} />
        <KpiCell icon={<Sigma />} accent="violet" label={t('Atteso per caso')} value={pp(f.null)} foot={t('Su {n} finestre di 30 giorni', { n: int(r.null_windows) })} />
        <KpiCell icon={<Target />} accent="violet" label={t('Rapporto')} value={fin(f.lift) ? `×${f.lift.toFixed(2)}` : '—'} foot={r.def === 'close' ? t('Moneta: {c} · marginali: {m}', { c: pp(f.coin), m: pp(f.naive) }) : t('Mesi con lo schema ÷ caso')} />
        <KpiCell icon={<FlaskConical />} accent="violet" label={t('p corretto')} value={fmtP(r.p_sidak)} foot={t('p grezzo {p} · {m} combinazioni', { p: fmtP(f.p), m: r.combos })} />
        <KpiCell icon={<ListChecks />} accent="violet" label={t('Verdetto')} value={<VerdictBadge v={r.verdict} short />} foot={r.stable ? t('Sopra il caso in ≥ 2/3 degli anni') : t('Instabile negli anni')} />
      </KpiStrip>
      <Card>
        <CardBody className="pt-4 text-sm leading-relaxed text-slate-300">{sentence} <span className="text-slate-500">{thirdsDefText(r)}</span></CardBody>
      </Card>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="h-full">
          <CardHeader icon={<Activity />} title={t('Frequenza per anno')} subtitle={t('Quota dei mesi di ogni anno con lo schema · linea = caso')} />
          <CardBody className="flex flex-col"><Fill min={300}><ThirdsYearChart r={r} /></Fill></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<ListChecks />} title={t('Tutti gli schemi a confronto')} subtitle={t('Stessa definizione: quale schema è comune per caso e quale no')} />
          <CardBody className="pt-0">
            <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
              <table className="tbl min-w-[520px]">
                <thead><tr>
                  <th className="pl-4 sm:pl-5">{t('Schema')}</th><th className="text-right">{t('Mesi')}</th><th className="text-right">{t('Frequenza')}</th>
                  <th className="text-right">{t('Caso')}</th><th className="text-right">{t('Rapporto')}</th><th className="text-right">p</th><th className="pr-4 text-right sm:pr-5">{t('p BH')}</th>
                </tr></thead>
                <tbody>
                  {r.family.map((x) => (
                    <tr key={x.pattern} className={x.pattern === r.pattern ? 'bg-accent-purple/[0.06]' : undefined}>
                      <td className="pl-4 font-medium tracking-widest text-slate-200 sm:pl-5">{PATTERN_GLYPH(x.pattern)}</td>
                      <td className="text-right text-slate-300">{x.k} / {x.n}</td>
                      <td className="text-right text-white">{pp(x.rate)}</td>
                      <td className="text-right text-slate-400">{pp(x.null)}</td>
                      <td className="text-right text-slate-300">{fin(x.lift) ? `×${x.lift.toFixed(2)}` : '—'}</td>
                      <td className="text-right text-slate-300">{fmtP(x.p)}</td>
                      <td className="pr-4 text-right text-slate-300 sm:pr-5">{fmtP(x.p_bh)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<CalendarSearch />} title={t('Mese per mese')} subtitle={t('Rendimento di ogni parte (chiusura su chiusura) ed esito dello schema')} />
          <CardBody className="flex flex-col pt-0">
            <Fill min={240}><div className="no-scrollbar -mx-4 h-full overflow-auto sm:-mx-5">
              <table className="tbl min-w-[560px]">
                <thead className="sticky top-0 z-[1] bg-[#0E1424]"><tr>
                  <th className="pl-4 sm:pl-5">{t('Mese')}</th><th className="text-right">{t('1–10')}</th><th className="text-right">{t('11–20')}</th><th className="text-right">{t('21–fine')}</th>
                  <th className="pr-4 sm:pr-5">{t('Schema')}</th>
                </tr></thead>
                <tbody>
                  {r.months.slice(0, 36).map((m) => (
                    <tr key={m.month} className={m.month >= rec.from ? 'bg-white/[0.02]' : undefined}>
                      <td className="pl-4 text-slate-200 sm:pl-5">{monthYear(m.month)}</td>
                      {m.segs.map((s, i) => <td key={i} className={clsx('text-right', s ? sign(s.ret) : 'text-slate-600')}>{s ? signed(s.ret) : '…'}</td>)}
                      <td className="pr-4 sm:pr-5">
                        {m.match === null
                          ? <span className="text-xs text-slate-400">{t('In corso')} · {(m.partial ?? []).map((x) => (x === null ? '…' : x ? '✓' : '✗')).join(' ')}</span>
                          : m.match ? <span className="text-xs font-medium text-white">✓ {t('Sì')}</span> : <span className="text-xs text-slate-500">✗ {t('No')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></Fill>
          </CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Sigma />} title={t('Rendimento medio di ogni parte')} subtitle={t('Chiusure di segmento, contro le altre due parti')} />
          <CardBody className="flex flex-col gap-3 pt-0">
            {r.seg_means.map((s) => (
              <div key={s.seg} className={clsx(TILE, 'px-3 py-2.5')}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="label">{[t('Giorni 1–10'), t('Giorni 11–20'), t('Giorni 21–fine')][s.seg - 1]}</span>
                  <span className={clsx('tnum text-lg font-semibold', sign(s.mean))}>{signed(s.mean)}</span>
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-400">
                  <span>{t('Mediana {m}', { m: signed(s.median) })}</span><span>{t('In rialzo {u}', { u: pp(s.up, 0) })}</span>
                  <span>{t('Altre parti {o}', { o: signed(s.others_mean) })}</span><span>p {fmtP(s.p)}</span>
                </div>
              </div>
            ))}
            <p className="text-2xs text-slate-500">{t('Le medie sono trascinate da pochi mesi estremi: la mediana e la quota in rialzo sono più rappresentative.')}</p>
          </CardBody>
        </Card>
      </div>
      <RhythmMethod />
    </>
  )
}

function BucketBody({ r }: { r: BucketResponse }) {
  const strong = r.rows.filter((x) => x.verdict === 'strong')
  const best = [...r.rows].sort((a, b) => (a.p ?? 1) - (b.p ?? 1))[0]
  const d = r.kind === 'hour' ? 3 : 2
  const unit = r.kind === 'hour' ? tr('per ora', 'per hour') : tr('al giorno', 'per day')
  return (
    <>
      <KpiStrip cols="grid-cols-2 md:grid-cols-4">
        <KpiCell icon={<FlaskConical />} accent="violet" label={t('Test di famiglia')} value={fmtP(r.family.p)} foot={t('Massimo |t| contro {n} permutazioni', { n: r.family.n_perm })} />
        <KpiCell icon={<Sigma />} accent="violet" label={t('Caselle significative')} value={`${strong.length} / ${r.rows.length}`} foot={t('Dopo correzione e stabili negli anni')} />
        <KpiCell icon={<Target />} accent="violet" label={t('Casella più estrema')} value={best ? bucketLabel(r.kind, best.bucket) : '—'} foot={best ? `${signed(best.mean, d)} ${unit} · p ${fmtP(best.p)} · ${t('p BH')} ${fmtP(best.p_bh)}` : undefined} />
        <KpiCell icon={<CalendarClock />} accent="violet" label={t('Campione')} value={int(r.n)} foot={t('Dal {d} · recente {n}', { d: date(r.since), n: int(r.recent.n) })} />
      </KpiStrip>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="h-full">
          <CardHeader icon={<Activity />} title={t('Rendimento medio per casella')} subtitle={t('Barre: tutto lo storico (più piene se significative) · punti: periodo recente')} />
          <CardBody className="flex flex-col"><Fill min={320}><BucketChart r={r} /></Fill></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Layers />} title={t('Stabilità anno per anno')} subtitle={t('Rendimento medio di ogni casella per anno · verde sopra, rosso sotto')} />
          <CardBody className="flex flex-col"><Fill min={320}><BucketHeat r={r} /></Fill></CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader icon={<ListChecks />} title={t('Dettaglio delle caselle')} subtitle={t('{n} confronti: p corretto con Benjamini-Hochberg', { n: r.family.tests })} />
        <CardBody className="pt-0">
          <div className="no-scrollbar -mx-4 max-h-[520px] overflow-auto sm:-mx-5">
            <table className="tbl min-w-[860px]">
              <thead className="sticky top-0 z-[1] bg-[#0E1424]"><tr>
                <th className="pl-4 sm:pl-5">{t('Casella')}</th><th className="text-right">n</th><th className="text-right">{t('Media')}</th><th className="text-right">{t('In rialzo')}</th>
                <th className="text-right">{t('Scarto')}</th><th className="text-right">p</th><th className="text-right">{t('p BH')}</th><th className="text-right">{t('Anni concordi')}</th>
                <th className="text-right">{t('Recente')}</th><th className="pr-4 sm:pr-5">{t('Verdetto')}</th>
              </tr></thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={x.bucket}>
                    <td className="pl-4 font-medium text-slate-200 sm:pl-5">{bucketLabel(r.kind, x.bucket)}</td>
                    <td className="text-right text-slate-400">{int(x.n)}</td>
                    <td className={clsx('text-right', sign(x.mean))}>{signed(x.mean, d)}</td>
                    <td className="text-right text-slate-300">{pp(x.up)}</td>
                    <td className={clsx('text-right', sign(x.diff))}>{signed(x.diff, d)}</td>
                    <td className="text-right text-slate-300">{fmtP(x.p)}</td>
                    <td className="text-right text-slate-300">{fmtP(x.p_bh)}</td>
                    <td className="text-right text-slate-400">{fin(x.share_same_sign) ? `${x.share_same_sign.toFixed(0)}%` : '—'}</td>
                    <td className={clsx('text-right', sign(x.recent.mean))}>{signed(x.recent.mean, d)} <span className="text-slate-500">· {x.recent.n}</span></td>
                    <td className="pr-4 sm:pr-5"><VerdictBadge v={x.verdict} short /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      <RhythmMethod />
    </>
  )
}

function RhythmMethod() {
  return (
    <MethodNote title={t('Metodo · ritmi')}>
      <p>{t('Mese in tre parti: giorni 1–10, 11–20 e 21–fine mese su candele giornaliere UTC (Binance dal 2017, serie storica unita dal 2013). Atteso per caso = frequenza dello stesso schema su tutte le finestre di 30 giorni (10 + 10 + 10) che iniziano in un giorno qualsiasi dello stesso periodo: misura quanto lo schema è comune per la sola volatilità di BTC, senza calendario. p = binomiale sui mesi di calendario; correzione di Šidák per le 104 combinazioni che lo strumento permette di guardare (26 schemi × 4 definizioni).')}</p>
      <p>{t('Giorno della settimana, settimana del mese, giorno del mese e ora UTC: rendimento logaritmico medio di ogni casella contro tutte le altre (t di Welch), Benjamini-Hochberg tra le caselle e test di famiglia (massimo |t| osservato contro 500 permutazioni dei rendimenti). Significativo e stabile solo se regge alla correzione e lo scarto ha lo stesso segno in almeno 2 anni su 3.')}</p>
      <p>{t('Limite: scegliere il periodo recente dopo aver visto i dati (es. «da agosto») è già una forma di data snooping; con pochi mesi nessun risultato recente può essere significativo. Le stagionalità per mese, settimana e giorno dell’anno sono nella sezione Pivot temporali.')}</p>
    </MethodNote>
  )
}

// ================================================================== PAGE
export default function TimingPage() {
  const [tab, setTab] = useTab(TABS.map((x) => x.value), 'scenari')
  const q = useTiming()
  return (
    <div className="flex flex-col">
      <PageTitle title={t('Timing Gann · Wyckoff')}
        subtitle={t('Date chiave, fasi di Wyckoff e ritmi di calendario nello stile dei «timing tops & bottoms», ognuno con il suo track record contro il caso: uno studio, non un segnale.')}
        right={(
          <div className="flex flex-wrap gap-2">
            <Link to="/pivot-temporali" className="btn-ghost"><CalendarClock size={14} /> {t('Pivot temporali')}</Link>
            <Link to="/astronomia" className="btn-ghost"><MoonStar size={14} /> {t('Astronomia e numeri')}</Link>
          </div>
        )} />
      <div className="mb-3">
        <Q q={q} loading={<div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <SkeletonBlock key={i} rows={2} className="card p-4" />)}</div>}>
          {(o) => <Kpis o={o} />}
        </Q>
      </div>
      <TabBar tabs={TABS.map((x) => ({ value: x.value, label: t(x.label) }))} value={tab} onChange={setTab} />
      {tab === 'scenari' && <Q q={q} loading={<SkeletonBlock chart rows={6} />}>{(o) => <ScenariTab o={o} />}</Q>}
      {tab === 'gann' && <GannTab />}
      {tab === 'wyckoff' && <WyckoffTab />}
      {tab === 'ritmi' && <RitmiTab />}
    </div>
  )
}

