import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity, BookOpen, CalendarDays, CircleDot, Coins, FlaskConical, Hash, LineChart, ListChecks, Moon, MoonStar, Orbit, ShieldCheck, Sigma, Sun, Telescope,
} from 'lucide-react'
import { useAstro, type AstroResponse, type Hypothesis, type HypId } from '../api/astro'
import { useLivePrice } from '../api/live'
import ProChart, { type LineDef, type MarkerDef, type PaneDef, type PriceLineDef, type ZoneDef } from '../components/charts/ProChart'
import { C } from '../components/charts/theme'
import { Badge, Card, CardBody, CardHeader, Fill, KpiCell, KpiStrip, Legend, MethodNote, PageTitle, Q, Segmented, Skeleton, TabBar, clsx } from '../components/ui'
import { SectionTitle } from '../widgets/macro'
import {
  ControlHistChart, EventBars, FibHistChart, HypothesisCard, KpChart, LunarProfileChart, MercuryChart, MoonGlyph, MoonPathChart, SolarChart,
  UpcomingAstroList, VerdictBadge, countdown, eclipseKind, eventLabel, fin, fmtEffect, fmtP, hypDesc, hypLabel, phaseLabel, signCls,
  unitNote, useLiveMoon, useNow, verdictLabel,
} from '../widgets/astro'
import { date, dateTime, int, pct, usd } from '../lib/format'
import { useTab } from '../lib/useTab'
import { t, tr } from '../i18n'

type Tab = 'luna' | 'calendario' | 'eclissi' | 'pianeti' | 'sole' | 'numeri' | 'verdetti'
const TABS: { value: Tab; label: string }[] = [
  { value: 'luna', label: 'Luna' }, { value: 'calendario', label: 'Calendario' }, { value: 'eclissi', label: 'Eclissi e superlune' },
  { value: 'pianeti', label: 'Pianeti e stagioni' }, { value: 'sole', label: 'Sole e geomagnetismo' }, { value: 'numeri', label: 'Numeri' },
  { value: 'verdetti', label: 'Verdetti' },
]
const TILE = 'rounded-xl border border-white/[0.06] bg-white/[0.02]'
// stable empty props for ProChart (its effects depend on array identity)
const NO_LINES: LineDef[] = []
const NO_PL: PriceLineDef[] = []
const NO_ZONES: ZoneDef[] = []
const NO_PANES: PaneDef[] = []

function useHyp(d: AstroResponse) {
  return useMemo(() => {
    const m = new Map<HypId, Hypothesis>()
    d.hypotheses.forEach((h) => m.set(h.id, h))
    return (id: HypId) => m.get(id)
  }, [d])
}

function Tile({ label, value, foot, className, wrap }: { label: ReactNode; value: ReactNode; foot?: ReactNode; className?: string; wrap?: boolean }) {
  return (
    <div className={clsx('min-w-0 px-3 py-2.5', className)}>
      <div className="label truncate">{label}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold tracking-[-0.01em] text-white">{value}</div>
      {foot && <div className={clsx('mt-0.5 text-xs text-slate-400', wrap ? 'line-clamp-2' : 'truncate')}>{foot}</div>}
    </div>
  )
}

const kpLabel = (kp: number) => (kp >= 9 ? 'G5' : kp >= 8 ? 'G4' : kp >= 7 ? 'G3' : kp >= 6 ? 'G2' : kp >= 5 ? 'G1' : kp >= 4 ? tr('Attivo', 'Active') : tr('Calmo', 'Quiet'))

// ------------------------------------------------------------------ KPI
function Kpis({ d }: { d: AstroResponse }) {
  const moon = useLiveMoon(d)
  const now = moon.now
  const nextFull = d.moon.next.find((x) => x.key === 'full' && x.time * 1000 > now)
  const nextNew = d.moon.next.find((x) => x.key === 'new' && x.time * 1000 > now)
  const ecl = d.upcoming.find((u) => (u.key === 'lunar_eclipse' || u.key === 'lunar_eclipse_total' || u.key === 'solar_eclipse') && u.time * 1000 > now)
    ?? null
  const nextEclipse = ecl ?? [...d.eclipses.lunar.map((e) => ({ ...e, sol: false })), ...d.eclipses.solar.map((e) => ({ ...e, sol: true }))]
    .filter((e) => e.time * 1000 > now).sort((a, b) => a.time - b.time)[0]
  const mer = d.mercury.now
  const strong = d.hypotheses.filter((h) => h.verdict === 'strong').length
  const weak = d.hypotheses.filter((h) => h.verdict === 'weak').length
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
      <KpiCell icon={<Moon />} accent="violet" label={t('Luna adesso')} value={`${(moon.illum * 100).toFixed(1)}%`}
        foot={`${phaseLabel(moon.phase)} · ${t('{a} g', { a: moon.age.toFixed(1) })}`} title={t('Quota del disco illuminata')} />
      <KpiCell icon={<CircleDot />} accent="violet" label={nextFull?.supermoon ? t('Prossima superluna') : t('Prossima luna piena')}
        value={nextFull ? countdown(nextFull.time, now) : '—'} foot={nextFull ? dateTime(nextFull.time) : undefined} />
      <KpiCell icon={<MoonStar />} accent="violet" label={t('Prossima luna nuova')} value={nextNew ? countdown(nextNew.time, now) : '—'}
        foot={nextNew ? dateTime(nextNew.time) : undefined} />
      <KpiCell icon={<Sun />} accent="violet" label={t('Prossima eclissi')} value={nextEclipse ? date(nextEclipse.time) : '—'}
        foot={nextEclipse ? `${'key' in nextEclipse ? eventLabel(nextEclipse.key) : nextEclipse.sol ? t('Eclissi solare') : t('Eclissi lunare')} · ${eclipseKind(nextEclipse.kind)} · ${countdown(nextEclipse.time, now)}` : undefined} />
      <KpiCell icon={<Orbit />} accent="violet" label={t('Mercurio')} value={mer.retro ? t('Retrogrado') : t('Diretto')}
        foot={mer.retro && mer.end ? t('Diretto tra {c}', { c: countdown(mer.end, now) }) : mer.next_start ? t('Retrogrado dal {d}', { d: date(mer.next_start) }) : undefined} />
      <KpiCell icon={<Sigma />} accent="violet" label={t('Ipotesi significative')} value={`${strong} / ${d.hypotheses.length}`}
        foot={weak ? t('{w} deboli · dopo correzione BH', { w: weak }) : t('Dopo correzione per test multipli')} />
    </KpiStrip>
  )
}

// ------------------------------------------------------------------ LUNA
function MoonNowCard({ d }: { d: AstroResponse }) {
  const m = useLiveMoon(d)
  return (
    <Card className="h-full">
      <CardHeader icon={<Moon />} title={t('La Luna adesso')} subtitle={t('Calcolo astronomico aggiornato ogni secondo')} />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-5">
          <MoonGlyph illum={m.illum} waxing={m.waxing} size={132} className="shrink-0" />
          <div className="min-w-[180px] flex-1">
            <div className="text-xl font-semibold tracking-[-0.01em] text-white">{phaseLabel(m.phase)}</div>
            <div className="tnum mt-1 text-sm text-slate-400">{t('Illuminata al {p}%', { p: (m.illum * 100).toFixed(2) })}</div>
            <div className={clsx(TILE, 'dgrid mt-3 grid-cols-2')}>
              <Tile label={t('Età')} value={t('{a} g', { a: m.age.toFixed(2) })} />
              <Tile label={t('Elongazione')} value={`${m.elong.toFixed(1)}°`} />
              <Tile label={t('Distanza')} value={`${int(d.moon.now.distance_km)} km`} foot={t('Al caricamento')} />
              <Tile label={t('Ciclo sinodico')} value={t('{a} g', { a: d.constants.synodic_days.toFixed(2) })} foot={t('Medio')} />
            </div>
          </div>
        </div>
        <div>
          <div className="label mb-1">{t('Prossime fasi')}</div>
          <ul>
            {d.moon.next.slice(0, 6).map((x) => (
              <li key={x.time} className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
                <span className="flex min-w-0 items-center gap-2.5">
                  <MoonGlyph illum={x.key === 'new' ? 0 : x.key === 'full' ? 1 : 0.5} waxing={x.key !== 'last_quarter'} size={18} className="shrink-0" />
                  <span className="truncate text-sm text-slate-200">{phaseLabel(x.key)}</span>
                  {x.supermoon && <Badge color="purple">{t('Superluna')}</Badge>}
                </span>
                <span className="tnum shrink-0 text-right text-xs text-slate-400">{dateTime(x.time)} <span className="ml-2 text-slate-200">{countdown(x.time, m.now)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </CardBody>
    </Card>
  )
}

function MoonPriceCard({ d }: { d: AstroResponse }) {
  const markers = useMemo(() => {
    const t0 = d.candles[0]?.time ?? 0
    const day = (s: number) => Math.floor(s / 86400) * 86400
    const out: MarkerDef[] = []
    d.moon.events.filter((e) => e.time >= t0).forEach((e) => out.push(e.key === 'full'
      ? { time: day(e.time), position: 'aboveBar', color: e.supermoon ? '#F4F1E8' : 'rgba(232,236,244,0.55)', shape: 'circle', size: e.supermoon ? 1.2 : 0.6 }
      : { time: day(e.time), position: 'belowBar', color: 'rgba(140,150,173,0.55)', shape: 'circle', size: 0.6 }))
    d.eclipses.lunar.filter((e) => e.time >= t0 && e.time <= d.today + 86400).forEach((e) => out.push({ time: day(e.time), position: 'aboveBar', color: C.purple, shape: 'square', text: e.kind === 'total' ? t('Eclissi totale') : t('Eclissi') }))
    d.eclipses.solar.filter((e) => e.time >= t0 && e.time <= d.today + 86400).forEach((e) => out.push({ time: day(e.time), position: 'belowBar', color: C.amber, shape: 'square', text: t('Eclissi solare') }))
    return out.sort((a, b) => a.time - b.time)
  }, [d])
  return (
    <Card className="h-full xl:col-span-2">
      <CardHeader icon={<LineChart />} title={t('BTC e fasi lunari')} subtitle={t('Candele giornaliere Binance · trascina per risalire fino a 3 anni')}
        right={<Legend items={[{ label: t('Luna piena'), color: '#E8ECF4' }, { label: t('Luna nuova'), color: '#8C96AD' }, { label: t('Eclissi lunare'), color: C.purple }, { label: t('Eclissi solare'), color: C.amber }]} />} />
      <CardBody className="flex flex-col">
        <Fill min={420}><ProChart candles={d.candles} markers={markers} lines={NO_LINES} priceLines={NO_PL} zones={NO_ZONES} panes={NO_PANES} height="100%" volume={false} logScale tfLabel={tr('1G', '1D')} fitKey="astro" /></Fill>
      </CardBody>
    </Card>
  )
}

function LunaTab({ d }: { d: AstroResponse }) {
  const h = useHyp(d)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-3">
        <MoonNowCard d={d} />
        <MoonPriceCard d={d} />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="h-full">
          <CardHeader icon={<Activity />} title={t('Rendimento medio per giorno del ciclo lunare')} subtitle={t('Media giornaliera di BTC per ognuno dei 30 giorni del ciclo · barre fuori dalla banda grigia = insolite')}
            info={t('Ogni giorno del campione è assegnato a una delle 30 classi di 12° di elongazione Luna−Sole (a mezzogiorno UTC). La banda grigia contiene il 90% delle medie ottenute spostando a caso la serie dei rendimenti rispetto al calendario lunare: con 30 classi è normale che 3 barre su 30 ne escano per puro caso.')} />
          <CardBody className="flex flex-col"><Fill min={300}><LunarProfileChart d={d} /></Fill></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<LineChart />} title={t('Percorso medio attorno a luna piena e nuova')} subtitle={t('Variazione cumulata da 7 giorni prima a 7 giorni dopo · banda = placebo')}
            info={t('Il percorso parte dalla chiusura dell’ottavo giorno prima della fase. La banda contiene il 90% dei percorsi medi ottenuti su date spostate a caso: un percorso dentro la banda non si distingue dal caso.')} />
          <CardBody className="flex flex-col"><Fill min={300}><MoonPathChart d={d} /></Fill></CardBody>
        </Card>
      </div>
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {/* 3 cards in 2 columns (md–xl): the third spans the row instead of leaving an empty half */}
        {(['moon_full', 'moon_new', 'moon_halves'] as HypId[]).map((id, i) => h(id) && <HypothesisCard key={id} h={h(id)!} className={i === 2 ? 'md:col-span-2 2xl:col-span-1' : undefined} />)}
      </div>
      <MethodNote title={t('Metodo e fonti · Luna')}>
        <p>{t('Fasi lunari calcolate con Astronomy Engine (teoria lunare troncata, accuratezza dichiarata ±1 minuto d’arco) e verificate contro le tabelle dell’US Naval Observatory: scarto medio {m} minuti su {n} fasi (la fonte arrotonda al minuto).', { m: (d.verification?.checks.find((c) => c.id === 'moon_phases')?.mean_abs_min ?? 0).toFixed(2), n: d.verification?.checks.find((c) => c.id === 'moon_phases')?.n ?? '—' })}</p>
        <p>{t('Rendimenti logaritmici giornalieri close-to-close (candele UTC) dal {s} a ieri. Effetto = rendimento medio delle finestre attorno agli eventi meno la media di tutte le finestre della stessa lunghezza. Il p-value viene da un placebo: le date degli eventi sono spostate rigidamente di ogni ampiezza possibile (almeno {k} giorni), così restano intatte sia la regolarità del calendario lunare sia i trend e la volatilità di BTC. IC 95% con {b} ricampionamenti bootstrap.', { s: date(d.sample.start), k: d.constants.min_shift, b: int(d.constants.n_boot) })}</p>
        <p>{t('Letteratura: Dichev e Janes (2003) e Yuan, Zheng e Zhu (2006) trovano rendimenti azionari più bassi attorno alla luna piena (3–5% annuo su 48 paesi), con effetti piccoli e instabili nei test successivi. L’illuminazione mostrata è calcolata nel browser con la serie di Meeus (cap. 48) ancorata al valore del server.')}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ CALENDARIO
function CalendarioTab({ d }: { d: AstroResponse }) {
  const now = useNow(1000)
  const h = useHyp(d)
  const ids: HypId[] = ['moon_full', 'moon_new', 'supermoon', 'lunar_eclipse_total', 'lunar_eclipse_all', 'solar_eclipse', 'mercury_retro', 'seasons', 'friday13', 'geomag_storm']
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader icon={<CalendarDays />} title={t('Prossimi 90 giorni')} subtitle={t('Eventi astronomici e date numeriche con il comportamento storico di BTC')}
          info={t('A destra il verdetto dello studio per quel tipo di evento e il rendimento medio di BTC nella finestra attorno agli eventi passati, confrontato con una finestra qualsiasi. Non è una previsione: serve a sapere se quell’evento ha mai fatto differenza.')} />
        <CardBody className="pt-0"><UpcomingAstroList items={d.upcoming} nowMs={now} /></CardBody>
      </Card>
      <Card>
        <CardHeader icon={<ListChecks />} title={t('Comportamento storico per tipo di evento')} subtitle={t('Finestra attorno all’evento contro una finestra qualsiasi della stessa durata')} />
        <CardBody className="pt-0">
          <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
            <table className="tbl min-w-[880px]">
              <thead><tr>
                <th className="pl-4 sm:pl-5">{t('Evento')}</th><th className="text-right">n</th><th className="text-right">{t('Finestra')}</th>
                <th className="text-right">{t('Media eventi')}</th><th className="text-right">{t('Normale')}</th><th className="text-right">{t('Rialzo eventi')}</th>
                <th className="text-right">{t('Rialzo normale')}</th><th className="text-right">p</th><th className="pr-4 sm:pr-5">{t('Verdetto')}</th>
              </tr></thead>
              <tbody>
                {ids.map((id) => h(id)).filter(Boolean).map((x) => {
                  const hh = x!
                  const w = hh.window ? (hh.window[0] === hh.window[1] ? t('Giorno stesso') : hh.window[0] < 0 ? t('±{k} g', { k: hh.window[1] }) : t('+{a}..+{b} g', { a: hh.window[0], b: hh.window[1] })) : t('Periodo')
                  return (
                    <tr key={hh.id}>
                      <td className="pl-4 font-medium text-slate-200 sm:pl-5">{hypLabel(hh.id)}</td>
                      <td className={clsx('text-right', (hh.n_events ?? hh.n) < 12 ? 'text-amber-300' : 'text-slate-300')}>{hh.n_events ?? hh.n}</td>
                      <td className="text-right text-slate-400">{w}</td>
                      <td className={clsx('text-right', signCls(hh.observed))}>{fmtEffect(hh.observed, hh.unit)}</td>
                      <td className="text-right text-slate-300">{fmtEffect(hh.baseline, hh.unit)}</td>
                      <td className="text-right text-slate-200">{fin(hh.up_rate) ? `${hh.up_rate.toFixed(0)}%` : '—'}</td>
                      <td className="text-right text-slate-400">{fin(hh.up_base) ? `${hh.up_base.toFixed(0)}%` : '—'}</td>
                      <td className="text-right text-slate-300">{fmtP(hh.p)}</td>
                      <td className="pr-4 sm:pr-5"><VerdictBadge v={hh.verdict} stable={hh.stable} short /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      <MethodNote title={t('Metodo e fonti · Calendario')}>
        <p>{t('Istanti in UTC. Fasi, eclissi, stazioni di Mercurio ed equinozi da Astronomy Engine, verificati contro USNO, catalogo NASA delle eclissi e JPL Horizons (vedi la scheda Verdetti). Le tempeste geomagnetiche compaiono solo se la previsione NOAA a 3 giorni indica Kp ≥ 5.')}</p>
        <p>{t('Superluna: luna piena a meno di {km} km dal centro della Terra (definizione dichiarata; altre fonti usano il 90% del perigeo e contano più superlune).', { km: int(d.constants.supermoon_km) })}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ ECLISSI
function EclipseTable({ rows, solar }: { rows: AstroResponse['eclipses']['lunar'] | AstroResponse['eclipses']['solar']; solar?: boolean }) {
  const list = [...rows].reverse()
  return (
    <div className="no-scrollbar -mx-4 max-h-[460px] overflow-auto sm:-mx-5">
      <table className="tbl min-w-[420px]">
        <thead className="sticky top-0 z-[1] bg-[#0E1424]"><tr>
          <th className="pl-4 sm:pl-5">{t('Data')}</th><th>{t('Tipo')}</th>
          {!solar && <th className="text-right">{t('Totalità')}</th>}
          <th className="text-right">±3 {tr('g', 'd')}</th><th className="pr-4 text-right sm:pr-5">+30 {tr('g', 'd')}</th>
        </tr></thead>
        <tbody>
          {list.map((e) => (
            <tr key={e.time}>
              <td className="pl-4 text-slate-200 sm:pl-5">{date(e.time)}</td>
              <td className={clsx(e.kind === 'total' ? 'text-white' : 'text-slate-400')}>{eclipseKind(e.kind)}</td>
              {!solar && <td className="text-right text-slate-400">{'total_min' in e && fin(e.total_min) && e.total_min > 0 ? `${e.total_min} min` : '—'}</td>}
              <td className={clsx('text-right', signCls(e.ret7))}>{fin(e.ret7) ? fmtEffect(e.ret7, '%') : <span className="text-slate-500">{e.time > Date.now() / 1000 ? t('Futura') : '—'}</span>}</td>
              <td className={clsx('pr-4 text-right sm:pr-5', signCls(e.ret30))}>{fmtEffect(e.ret30, '%')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EclissiTab({ d }: { d: AstroResponse }) {
  const h = useHyp(d)
  const tot = h('lunar_eclipse_total')
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
        {(['lunar_eclipse_total', 'lunar_eclipse_all', 'solar_eclipse', 'supermoon'] as HypId[]).map((id) => h(id) && <HypothesisCard key={id} h={h(id)!} />)}
      </div>
      {tot && (
        <Card>
          <CardHeader icon={<Moon />} title={t('Ogni luna rossa, una per una')} subtitle={t('Rendimento di BTC nei 7 giorni centrati su ogni eclissi lunare totale · linea = finestra normale')}
            info={t('Con {n} eclissi totali nel campione il risultato è aneddotico per definizione: basta un singolo evento estremo a spostare la media.', { n: tot.n })} />
          <CardBody className="flex flex-col"><Fill min={240}><EventBars h={tot} /></Fill></CardBody>
        </Card>
      )}
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full">
          <CardHeader icon={<Moon />} title={t('Eclissi lunari')} subtitle={t('{n} eclissi dal 2010, più recenti prima', { n: d.eclipses.lunar.length })} />
          <CardBody className="pt-0"><EclipseTable rows={d.eclipses.lunar} /></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Sun />} title={t('Eclissi solari')} subtitle={t('{n} eclissi dal 2010, più recenti prima', { n: d.eclipses.solar.length })} />
          <CardBody className="pt-0"><EclipseTable rows={d.eclipses.solar} solar /></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<CircleDot />} title={t('Superlune')} subtitle={t('Lune piene a meno di {km} km', { km: int(d.constants.supermoon_km) })} />
          <CardBody className="pt-0">
            <div className="no-scrollbar -mx-4 max-h-[460px] overflow-auto sm:-mx-5">
              <table className="tbl min-w-[340px]">
                <thead className="sticky top-0 z-[1] bg-[#0E1424]"><tr><th className="pl-4 sm:pl-5">{t('Data')}</th><th className="text-right">{t('Distanza')}</th><th className="text-right">±3 {tr('g', 'd')}</th><th className="pr-4 text-right sm:pr-5">+30 {tr('g', 'd')}</th></tr></thead>
                <tbody>
                  {[...d.supermoons].reverse().map((s) => (
                    <tr key={s.time}>
                      <td className="pl-4 text-slate-200 sm:pl-5">{date(s.time)}</td>
                      <td className="text-right text-slate-400">{int(s.distance_km)} km</td>
                      <td className={clsx('text-right', signCls(s.ret7))}>{fmtEffect(s.ret7, '%')}</td>
                      <td className={clsx('pr-4 text-right sm:pr-5', signCls(s.ret30))}>{fmtEffect(s.ret30, '%')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
      <MethodNote title={t('Metodo e fonti · Eclissi')}>
        <p>{t('Eclissi calcolate con Astronomy Engine e confrontate con il catalogo NASA GSFC (F. Espenak): tutte le {n} eclissi del 2010–2027 presenti, istante del massimo entro {m} minuti (la NASA usa il Tempo Dinamico, ~69 s avanti rispetto a UTC). Dove il tipo differisce (ibride 2013 e 2023, anulare non centrale del 29 apr 2014) si usa la classificazione NASA.', { n: (d.verification?.checks.find((c) => c.id === 'lunar_eclipses')?.n ?? 0) + (d.verification?.checks.find((c) => c.id === 'solar_eclipses')?.n ?? 0), m: Math.max(d.verification?.checks.find((c) => c.id === 'lunar_eclipses')?.max_abs_min ?? 0, d.verification?.checks.find((c) => c.id === 'solar_eclipses')?.max_abs_min ?? 0).toFixed(1) })}</p>
        <p>{t('±3 g = rendimento logaritmico dalla chiusura di 4 giorni prima alla chiusura di 3 giorni dopo; +30 g = i 30 giorni successivi. Le eclissi sono date globali: non dipendono da dove sono visibili.')}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ PIANETI
function PianetiTab({ d }: { d: AstroResponse }) {
  const h = useHyp(d)
  const now = useNow(1000)
  const mer = d.mercury.now
  const future = d.mercury.periods.filter((p) => p.end * 1000 > now).slice(0, 4)
  const past = d.mercury.periods.filter((p) => fin(p.ret)).slice(-14).reverse()
  const seasons = d.seasons.filter((s) => fin(s.ret7)).slice(-12).reverse()
  const SEASON: Record<string, string> = { mar_equinox: 'Equinozio di marzo', jun_solstice: 'Solstizio di giugno', sep_equinox: 'Equinozio di settembre', dec_solstice: 'Solstizio di dicembre' }
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<Orbit />} title={t('BTC e Mercurio retrogrado')} subtitle={t('Fasce viola = periodi in cui Mercurio sembra muoversi all’indietro visto dalla Terra')} />
          <CardBody className="flex flex-col"><Fill min={380}><MercuryChart d={d} /></Fill></CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Telescope />} title={t('Mercurio adesso')} subtitle={mer.retro ? t('Retrogrado fino al {d}', { d: date(mer.end) }) : t('Moto diretto')} />
          <CardBody className="flex flex-col gap-3">
            <div className={clsx(TILE, 'dgrid grid-cols-2')}>
              <Tile label={t('Stato')} value={mer.retro ? t('Retrogrado') : t('Diretto')} />
              <Tile label={mer.retro ? t('Torna diretto tra') : t('Retrogrado tra')} value={mer.retro && mer.end ? countdown(mer.end, now) : mer.next_start ? countdown(mer.next_start, now) : '—'} />
            </div>
            <div>
              <div className="label mb-1">{t('Prossimi periodi retrogradi')}</div>
              <ul>
                {future.map((p) => (
                  <li key={p.start} className="tnum flex items-center justify-between gap-3 border-t border-line py-2 text-sm first:border-t-0">
                    <span className="text-slate-200">{date(p.start)} → {date(p.end)}</span>
                    <span className="text-xs text-slate-400">{t('{n} giorni', { n: fin(p.days) ? p.days.toFixed(0) : '—' })}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-auto text-xs leading-relaxed text-slate-400">{t('Il moto retrogrado è un effetto prospettico: la Terra «sorpassa» Mercurio sull’orbita interna circa tre volte l’anno. Gli istanti di stazione sono verificati contro JPL Horizons (scarto medio {m} minuti su {n} stazioni).', { m: (d.verification?.checks.find((c) => c.id === 'mercury_stations')?.mean_abs_min ?? 0).toFixed(1), n: d.verification?.checks.find((c) => c.id === 'mercury_stations')?.n ?? '—' })}</p>
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {(['mercury_retro', 'seasons'] as HypId[]).map((id) => h(id) && <HypothesisCard key={id} h={h(id)!} />)}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="h-full">
          <CardHeader icon={<ListChecks />} title={t('Periodi retrogradi recenti')} subtitle={t('Variazione di BTC dall’inizio alla fine di ogni periodo')} />
          <CardBody className="pt-0">
            <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
              <table className="tbl min-w-[380px]">
                <thead><tr><th className="pl-4 sm:pl-5">{t('Periodo')}</th><th className="text-right">{t('Giorni')}</th><th className="pr-4 text-right sm:pr-5">BTC</th></tr></thead>
                <tbody>{past.map((p) => (
                  <tr key={p.start}><td className="pl-4 text-slate-200 sm:pl-5">{date(p.start)} → {date(p.end)}</td><td className="text-right text-slate-400">{fin(p.days) ? p.days.toFixed(0) : '—'}</td>
                    <td className={clsx('pr-4 text-right sm:pr-5', signCls(p.ret))}>{pct(p.ret, 1)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Sun />} title={t('Equinozi e solstizi recenti')} subtitle={t('Rendimento di BTC nei 7 giorni centrati e nei 30 successivi')} />
          <CardBody className="pt-0">
            <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
              <table className="tbl min-w-[380px]">
                <thead><tr><th className="pl-4 sm:pl-5">{t('Evento')}</th><th className="text-right">±3 {tr('g', 'd')}</th><th className="pr-4 text-right sm:pr-5">+30 {tr('g', 'd')}</th></tr></thead>
                <tbody>{seasons.map((s) => (
                  <tr key={s.time}><td className="pl-4 sm:pl-5"><span className="text-slate-200">{t(SEASON[s.key])}</span> <span className="ml-1 text-xs text-slate-500">{date(s.time)}</span></td>
                    <td className={clsx('text-right', signCls(s.ret7))}>{fmtEffect(s.ret7, '%')}</td><td className={clsx('pr-4 text-right sm:pr-5', signCls(s.ret30))}>{fmtEffect(s.ret30, '%')}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
      <MethodNote title={t('Metodo e fonti · Pianeti')}>
        <p>{t('Mercurio retrogrado = intervallo tra la stazione retrograda e la stazione diretta della longitudine eclittica apparente geocentrica (eclittica vera della data), calcolata con VSOP87 tramite Astronomy Engine e raffinata per bisezione. Il test confronta il rendimento medio giornaliero nei giorni retrogradi con quello degli altri giorni; il placebo trasla rigidamente l’intera maschera dei periodi.')}</p>
        <p>{t('Equinozi e solstizi verificati contro USNO: scarto massimo {m} minuti. Letteratura: uno studio su 48 paesi (1973–2019) riporta rendimenti azionari più bassi durante Mercurio retrogrado, altri studi trovano effetti opposti o solo sulla volatilità.', { m: (d.verification?.checks.find((c) => c.id === 'seasons')?.max_abs_min ?? 0).toFixed(1) })}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ SOLE
function SoleTab({ d }: { d: AstroResponse }) {
  const h = useHyp(d)
  const sc = h('solar_cycle')
  const gs = h('geomag_storm')
  const kp = d.geomag.now
  const ext = d.solar.solar_extrema ?? []
  const peaks = d.solar.btc_peaks ?? []
  const maxima = ext.filter((e) => e.kind === 'max')
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<Sun />} title={t('Ciclo solare e prezzo di BTC')} subtitle={t('Numero di macchie solari (SILSO via GFZ) e previsione NOAA, con BTC in scala logaritmica')}
            info={t('Picco BTC del ciclo = massima chiusura entro 600 giorni da ogni halving. Massimo solare = massimo della media mobile a 13 mesi delle macchie.')} />
          <CardBody className="flex flex-col gap-3">
            <Fill min={360}><SolarChart d={d} /></Fill>
          </CardBody>
        </Card>
        {sc ? (
          <HypothesisCard h={sc} className="h-full" extra={(<>
            <div className={clsx(TILE, 'dgrid grid-cols-2')}>
              {maxima.map((m) => <Tile key={m.time} label={t('Massimo solare')} value={date(m.time)} foot={t('Media 13 mesi {v}', { v: fin(m.ssn) ? m.ssn.toFixed(0) : '—' })} />)}
              {peaks.slice(-2).map((p) => <Tile key={p.time} label={t('Picco BTC del ciclo')} value={date(p.time)} foot={usd(p.price)} />)}
            </div>
            <p className="mt-auto border-t border-line pt-3 text-xs leading-relaxed text-slate-400">
              {t('Perché serve il placebo: il test classico dà p = {np}, ma le due serie sono lisce e il campione copre solo {c} cicli solari. Spostando una serie rispetto all’altra si ottengono correlazioni così grandi per puro caso nel {p}% dei casi.',
                { np: fmtP(sc.naive_p), c: fin(sc.solar_cycles_in_sample) ? sc.solar_cycles_in_sample.toFixed(1) : '—', p: fin(sc.p) ? (sc.p * 100).toFixed(0) : '—' })}
            </p></>)} />
        ) : <Card className="h-full"><CardBody><p className="text-sm text-slate-400">{t('Dati solari non disponibili')}</p></CardBody></Card>}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<Activity />} title={t('Indice geomagnetico Kp')} subtitle={t('Valori a 3 ore NOAA SWPC e previsione a 3 giorni · G1 = tempesta minore')}
            right={kp && fin(kp.kp) ? <Badge color={kp.kp >= 5 ? 'btc' : 'slate'}>{`Kp ${kp.kp.toFixed(2)} · ${kpLabel(kp.kp)}`}</Badge> : undefined} />
          <CardBody className="flex flex-col gap-3">
            <Fill min={260}><KpChart d={d} /></Fill>
            <div className={clsx(TILE, 'dgrid grid-cols-2 md:grid-cols-4')}>
              {d.geomag.storms_year.slice(-4).map((y) => <Tile key={y.year} label={String(y.year)} value={t('{n} giorni', { n: y.days_g1 })} foot={t('Kp ≥ 5 · {g} con Kp ≥ 7', { g: y.days_g3 })} />)}
            </div>
          </CardBody>
        </Card>
        {gs && <HypothesisCard h={gs} className="h-full" extra={(
          <div className="border-t border-line pt-3">
            <div className="label mb-1">{t('Ultime tempeste')}</div>
            <table className="tbl">
              <thead><tr><th className="pl-0">{t('Inizio')}</th><th className="text-right">Kp</th><th className="pr-0 text-right">{t('BTC nei 6 giorni dopo')}</th></tr></thead>
              <tbody>{[...d.geomag.storms].reverse().slice(0, 5).map((s) => (
                <tr key={s.time}><td className="pl-0 text-slate-200">{date(s.time)}</td><td className="text-right text-slate-300">{fin(s.kp) ? s.kp.toFixed(1) : '—'}</td>
                  <td className={clsx('pr-0 text-right', signCls(s.ret6))}>{fmtEffect(s.ret6, '%')}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )} />}
      </div>
      <MethodNote title={t('Metodo e fonti · Sole')}>
        <p>{t('Kp, Ap e numero di macchie solari giornaliero dall’archivio GFZ Potsdam (Kp_ap_Ap_SN_F107, licenza CC BY 4.0; SN © SILSO, Royal Observatory of Belgium). La media mensile ricavata da GFZ coincide con la serie mensile SILSO entro {d} macchie in media. Kp in tempo reale e previsioni da NOAA SWPC.', { d: (d.verification?.checks.find((c) => c.id === 'sunspots')?.mean_abs_ssn ?? 0).toFixed(2) })}</p>
        <p>{t('Tempesta = giorno con Kp massimo ≥ 5 (G1 o superiore) preceduto da 7 giorni senza tempeste; finestra dei 6 giorni successivi come in Krivelyova e Robotti (2003). Ciclo solare: correlazione mensile tra media a 13 mesi delle macchie e rendimento di BTC sui 12 mesi precedenti; con 1–2 cicli solari nel campione qualsiasi correlazione è fragile, per questo il p-value viene da un placebo a traslazione e non dal test classico.')}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ NUMERI
function BitcoinNumbers({ d }: { d: AstroResponse }) {
  const live = useLivePrice()
  const b = d.numbers.bitcoin
  const price = live ?? d.price
  const now = useNow(1000)
  const items: { label: string; value: ReactNode; foot: ReactNode }[] = [
    { label: t('Offerta massima'), value: '20,999,999.9769', foot: t('Non 21M esatti: ogni dimezzamento arrotonda al satoshi') },
    { label: t('Emessi finora (teorici)'), value: fin(b.issued) ? int(b.issued) : '—', foot: fin(b.issued_pct) ? t('{p}% del totale · blocco {h}', { p: b.issued_pct.toFixed(2), h: int(b.height) }) : '—' },
    { label: t('Ricompensa per blocco'), value: fin(b.subsidy) ? `${b.subsidy} BTC` : '—', foot: fin(b.epoch) ? t('Epoca {e} · dimezza ogni {n} blocchi', { e: b.epoch, n: int(b.halving_interval) }) : '—' },
    { label: t('Prossimo halving'), value: `#${int(b.next_halving_block)}`, foot: t('{d} (stima) · tra {c}', { d: date(b.next_halving_eta), c: countdown(b.next_halving_eta, now) }) },
    { label: t('Satoshi per 1 dollaro'), value: price ? int(1e8 / price) : '—', foot: t('1 BTC = 100,000,000 satoshi · prezzo live') },
    { label: t('Blocco e difficoltà'), value: t('{s} min', { s: b.block_target_s / 60 }), foot: t('Difficoltà ricalcolata ogni {n} blocchi (~2 settimane)', { n: int(b.retarget_blocks) }) },
    { label: t('Blocco genesi'), value: date(b.genesis), foot: t('Blocco 0 · ricompensa non spendibile') },
    { label: t('Pizza day'), value: price ? usd(b.pizza_btc * price) : '—', foot: t('{n} BTC per due pizze il {d}', { n: int(b.pizza_btc), d: date(b.pizza_day) }) },
  ]
  return (
    <Card className="h-full xl:col-span-2">
      <CardHeader icon={<Coins />} title={t('I numeri di Bitcoin')} subtitle={t('Costanti del protocollo e valori calcolati dall’altezza attuale dei blocchi')}
        info={t('Le costanti (offerta massima, 210,000 blocchi per halving, 10 minuti, 2016 blocchi) vengono dalle regole di consenso del codice di Bitcoin. L’emissione è quella programmata dal blocco corrente: non sottrae le monete perse o mai riscosse.')} />
      <CardBody>
        <div className={clsx(TILE, 'dgrid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4')}>
          {items.map((x) => <Tile key={x.label} label={x.label} value={x.value} foot={x.foot} className="py-3" wrap />)}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {b.halvings.map((hv) => (
            <div key={hv.n} className={clsx(TILE, 'px-3 py-2')}>
              <div className="label">{t('Halving {n}', { n: hv.n })}</div>
              <div className="tnum mt-0.5 text-sm text-white">{date(hv.time)} <span className="text-slate-400">· #{int(hv.block)}</span></div>
              <div className="tnum text-xs text-slate-400">{t('Ricompensa dopo: {r} BTC', { r: hv.subsidy_after })}</div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function NumeriTab({ d }: { d: AstroResponse }) {
  const h = useHyp(d)
  const [fib, setFib] = useState<'fib_price' | 'fib_time'>('fib_price')
  const fh = h(fib)
  const ms = d.numbers.milestones
  const reps = ms.repdigits.filter((r) => r.level >= 111)
  const reached = reps.filter((r) => r.time)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {(['round_major', 'round_minor', 'gann_sq9'] as HypId[]).map((id, i) => h(id) && (
          <HypothesisCard key={id} h={h(id)!} className={i === 2 ? 'md:col-span-2 2xl:col-span-1' : undefined} extra={(
            <div className="border-t border-line pt-3">
              <div className="label mb-1">{t('Livelli testati vs {n} griglie di controllo', { n: int(d.constants.n_ctrl) })}</div>
              <div className="h-[120px]"><ControlHistChart h={h(id)!} height="100%" /></div>
            </div>
          )} />
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full xl:col-span-2">
          <CardHeader icon={<Hash />} title={fib === 'fib_price' ? t('Profondità dei ritracciamenti') : t('Durata di una gamba rispetto alla precedente')}
            subtitle={fib === 'fib_price' ? t('Ritracciamento di ogni gamba del zigzag (3 ATR) · in viola le classi vicine ai livelli di Fibonacci') : t('Rapporto tra durate consecutive · in viola le classi vicine ai rapporti di Fibonacci')}
            right={<Segmented value={fib} onChange={setFib} options={[{ value: 'fib_price', label: t('Prezzo') }, { value: 'fib_time', label: tr('Tempo', 'Time') }]} />} />
          <CardBody className="flex flex-col"><Fill min={240}>{fh && <FibHistChart h={fh} />}</Fill></CardBody>
        </Card>
        {fh && <HypothesisCard h={fh} className="h-full" />}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <BitcoinNumbers d={d} />
        {h('friday13') && <HypothesisCard h={h('friday13')!} className="h-full" />}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="h-full">
          <CardHeader icon={<Hash />} title={t('Prime chiusure sopra le potenze di 10')} subtitle={t('Giorni impiegati per moltiplicare il prezzo per 10')} />
          <CardBody className="pt-0">
            <table className="tbl">
              <thead><tr><th className="pl-0">{t('Livello')}</th><th className="text-right">{t('Prima chiusura')}</th><th className="pr-0 text-right">{t('Giorni ×10')}</th></tr></thead>
              <tbody>{ms.powers.map((p) => (
                <tr key={p.level}><td className="pl-0 font-medium text-slate-200">{usd(p.level, 0)}</td>
                  <td className="text-right text-slate-300">{p.time ? date(p.time) : <span className="text-slate-500">{t('Non ancora')}</span>}</td>
                  <td className="pr-0 text-right text-slate-400">{fin(p.days_from_prev) ? int(p.days_from_prev) : '—'}</td></tr>
              ))}</tbody>
            </table>
          </CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<Hash />} title={t('Prezzi a cifre ripetute')} subtitle={t('Primo giorno in cui il massimo ha toccato il livello · {n} su {m} raggiunti', { n: reached.length, m: reps.length })} />
          <CardBody className="pt-0">
            <div className="grid grid-cols-2 gap-x-5 sm:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
              {reps.map((r) => (
                <div key={r.level} className="tnum flex items-baseline justify-between gap-2 border-t border-line py-1.5 text-xs">
                  <span className={r.time ? 'text-slate-200' : 'text-slate-500'}>{usd(r.level, 0)}</span>
                  <span className={r.time ? 'text-slate-400' : 'text-slate-600'}>{r.time ? new Date(r.time * 1000).getUTCFullYear() : '—'}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<CalendarDays />} title={t('Date palindrome')} subtitle={t('GGMMAAAA che si legge uguale al contrario · curiosità, nessuna statistica')} />
          <CardBody className="pt-0">
            <table className="tbl">
              <thead><tr><th className="pl-0">{t('Data')}</th><th className="text-right">BTC</th><th className="pr-0 text-right">+30 {tr('g', 'd')}</th></tr></thead>
              <tbody>{ms.palindromes.map((p) => (
                <tr key={p.time}><td className="pl-0 text-slate-200">{date(p.time)}</td>
                  <td className="text-right text-slate-300">{p.future ? <span className="text-slate-500">{t('Futura')}</span> : usd(p.price)}</td>
                  <td className={clsx('pr-0 text-right', signCls(p.ret30))}>{pct(p.ret30, 1)}</td></tr>
              ))}</tbody>
            </table>
          </CardBody>
        </Card>
      </div>
      <MethodNote title={t('Metodo e fonti · Numeri')}>
        <p>{t('Livelli tondi (ispirato a Osler 2003, che documenta ordini take-profit concentrati sui numeri tondi e stop-loss appena oltre): ogni giorno si considera il primo livello sopra e sotto la chiusura precedente; se il massimo (minimo) lo tocca ma la chiusura resta dal lato di partenza, il tocco è «respinto». Il passo cresce con l’ordine di grandezza del prezzo (principali: 500, 5K, 50K; secondari: 100, 1K, 10K). Il controllo usa {n} griglie con lo stesso passo spostate a caso: se i numeri tondi fossero speciali, respingerebbero più spesso delle griglie casuali.', { n: int(d.constants.n_ctrl) })}</p>
        <p>{t('Quadrato del 9: livelli in cui la radice quadrata del prezzo è un multiplo di 2 (un giro completo della spirale di Gann). Fibonacci: gambe del zigzag a 3 ATR su candele giornaliere; un ritracciamento è «Fibonacci» se cade entro ±2.5 punti da 23.6/38.2/50/61.8/78.6%; per il tempo, entro ±8% da 0.382/0.618/1/1.618/2.618. Controllo: {n} insiemi di 5 rapporti casuali con spaziatura simile. Urquhart (2017) trova che oltre il 10% dei prezzi di BTC termina in 00, ma senza effetti sui rendimenti successivi.', { n: int(d.constants.n_ctrl) })}</p>
        <p>{t('Venerdì 13: rendimento del giorno stesso; il placebo sposta le date di settimane intere per confrontare venerdì con venerdì.')}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ VERDETTI
const GROUP: Record<string, string> = { luna: 'Luna', eclissi: 'Eclissi', pianeti: 'Pianeti', sole: 'Sole', numeri: 'Numeri' }
const CHECK_LABEL: Record<string, string> = {
  moon_phases: 'Fasi lunari', seasons: 'Equinozi e solstizi', lunar_eclipses: 'Eclissi lunari', solar_eclipses: 'Eclissi solari',
  mercury_stations: 'Stazioni di Mercurio', supermoons: 'Distanza Luna (superlune)', sunspots: 'Macchie solari mensili',
}
const LIT: { ref: string; text: string; url?: string }[] = [
  { ref: 'Dichev e Janes (2003)', text: 'Rendimenti azionari nei 15 giorni attorno alla luna nuova circa doppi rispetto alla luna piena, su un secolo di dati USA e 24 paesi; nessun effetto su volatilità e volumi.' },
  { ref: 'Yuan, Zheng e Zhu (2006)', text: 'Su 48 paesi rendimenti più bassi di 3–5% annuo attorno alla luna piena, non spiegati da volatilità, volumi o annunci macro.', url: 'https://personal.lse.ac.uk/yuan/papers/lunar.pdf' },
  { ref: 'CXO Advisory (retest S&P 500 1990–2018)', text: 'Le finestre attorno alla luna nuova battono quelle attorno alla piena, ma l’effetto è piccolo rispetto alla volatilità e instabile tra sottoperiodi.', url: 'https://www.cxoadvisory.com/calendar-effects/lunar-cycle-and-stock-returns/' },
  { ref: 'Krivelyova e Robotti (2003)', text: 'Forte attività geomagnetica seguita da rendimenti più bassi nella settimana successiva su molti indici; il vantaggio sparisce con i costi di transazione.', url: 'https://ideas.repec.org/p/fip/fedawp/2003-5.html' },
  { ref: 'Osler (2003)', text: 'Nel mercato dei cambi gli ordini take-profit si concentrano sui numeri tondi e gli stop-loss appena oltre: spiegazione microstrutturale di supporti e resistenze.', url: 'https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr125.pdf' },
  { ref: 'Urquhart (2017)', text: 'Bitcoin mostra raggruppamento dei prezzi sui numeri tondi, ma nessun andamento particolare dei rendimenti dopo averli toccati.', url: 'https://ideas.repec.org/a/eee/ecolet/v159y2017icp145-148.html' },
  { ref: 'Studi su Mercurio retrogrado', text: 'Uno studio su 48 paesi (1973–2019) riporta rendimenti più bassi di circa 3% annuo; altri trovano effetti opposti o solo sulla volatilità.', url: 'https://www.aaii.com/journal/article/17803-mercury-retrograde-adversely-affects-stock-returns' },
  { ref: 'Ritracciamenti di Fibonacci', text: 'I ritracciamenti seguono una distribuzione continua senza picchi significativi sui rapporti di Fibonacci; zone Fibonacci e non-Fibonacci non differiscono.', url: 'https://arxiv.org/pdf/1605.03559' },
  { ref: 'Macchie solari e borsa', text: 'Su dati 1871–2018 nessuna relazione affidabile tra macchie solari e rendimenti dell’S&P 500, con l’avvertenza che 14 cicli sono pochi.', url: 'https://www.cxoadvisory.com/calendar-effects/sunspot-cycle-and-stock-returns/' },
]

function VerdettiTab({ d }: { d: AstroResponse }) {
  const v = d.verification
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader icon={<FlaskConical />} title={t('Tutte le ipotesi')} subtitle={t('{n} ipotesi testate sullo storico di BTC dal {s} · verdetto calcolato dai dati', { n: d.hypotheses.length, s: date(d.sample.start) })}
          info={t('Verdetto: con meno di {m} eventi «aneddotico»; p corretto (Benjamini-Hochberg) < 0.05 e stabile = significativo e stabile; p < 0.05 ma non dopo la correzione, o instabile = debole; altrimenti nessun effetto distinguibile dal caso.', { m: d.constants.min_n })} />
        <CardBody className="pt-0">
          <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
            <table className="tbl min-w-[1040px]">
              <thead><tr>
                <th className="pl-4 sm:pl-5">{t('Ipotesi')}</th><th>{t('Gruppo')}</th><th className="text-right">n</th><th className="text-right">{t('Effetto')}</th>
                <th className="text-right">{t('IC 95%')}</th><th className="text-right">p</th><th className="text-right">{t('p BH')}</th><th>{t('Stabile')}</th><th className="pr-4 sm:pr-5">{t('Verdetto')}</th>
              </tr></thead>
              <tbody>
                {d.hypotheses.map((h) => (
                  <tr key={h.id}>
                    <td className="pl-4 sm:pl-5"><div className="font-medium text-slate-200">{hypLabel(h.id)}</div><div className="max-w-[360px] truncate text-2xs text-slate-500" title={hypDesc(h.id)}>{unitNote(h.unit)}</div>
                      {/* phones: the verdict and effect sit under the name (their columns are off-screen in the scrollable table) */}
                      <div className="mt-1 flex items-center gap-2 md:hidden"><VerdictBadge v={h.verdict} stable={h.stable} /><span className="text-2xs text-slate-400">{fmtEffect(h.effect, h.unit)} · p {fmtP(h.p)}</span></div></td>
                    <td className="text-slate-400">{t(GROUP[h.group])}</td>
                    <td className={clsx('text-right', (h.n_events ?? h.n) < d.constants.min_n ? 'text-amber-300' : 'text-slate-300')}>{int(h.n_events ?? h.n)}</td>
                    <td className="text-right text-slate-100">{fmtEffect(h.effect, h.unit)}</td>
                    <td className="text-right text-slate-400">{fmtEffect(h.ci[0], h.unit)} … {fmtEffect(h.ci[1], h.unit)}</td>
                    <td className="text-right text-slate-300">{fmtP(h.p)}</td>
                    <td className={clsx('text-right', fin(h.p_bh) && h.p_bh < 0.05 ? 'font-medium text-white' : 'text-slate-300')}>{fmtP(h.p_bh)}</td>
                    <td className={h.stable ? 'text-slate-200' : 'text-slate-500'}>{h.stable ? tr('Sì', 'Yes') : 'No'}</td>
                    <td className="pr-4 sm:pr-5"><span title={verdictLabel(h.verdict, h.stable)}><VerdictBadge v={h.verdict} stable={h.stable} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="h-full">
          <CardHeader icon={<ShieldCheck />} title={t('Verifica dei calendari')} subtitle={t('Ogni calendario calcolato confrontato con una seconda fonte indipendente')} />
          <CardBody className="pt-0">
            {v ? (
              <div className="no-scrollbar -mx-4 overflow-x-auto sm:-mx-5">
                <table className="tbl min-w-[560px]">
                  <thead><tr><th className="pl-4 sm:pl-5">{t('Calendario')}</th><th>{t('Seconda fonte')}</th><th className="text-right">n</th><th className="text-right">{t('Scarto medio assoluto')}</th><th className="pr-4 text-right sm:pr-5">{t('Scarto massimo')}</th></tr></thead>
                  <tbody>{v.checks.map((c) => {
                    const unit = fin(c.mean_abs_min) ? 'min' : fin(c.mean_abs_km) ? 'km' : tr('macchie', 'spots')
                    const mean = c.mean_abs_min ?? c.mean_abs_km ?? c.mean_abs_ssn
                    const mx = c.max_abs_min ?? c.max_abs_km ?? c.max_abs_ssn
                    return (
                      <tr key={c.id} title={c.note ?? undefined}>
                        <td className="pl-4 sm:pl-5"><div className="font-medium text-slate-200">{t(CHECK_LABEL[c.id] ?? c.id)}</div><div className="text-2xs text-slate-500">{c.range}{fin(c.missing) ? ` · ${t('mancanti {n}', { n: c.missing })}` : ''}{fin(c.classification_flips) ? ` · ${t('classificazioni diverse {n}', { n: c.classification_flips })}` : ''}</div></td>
                        <td className="max-w-[220px] truncate text-slate-400"><a href={c.url} target="_blank" rel="noreferrer" className="hover:text-white">{t(c.source)}</a></td>
                        <td className="text-right text-slate-300">{c.n}</td>
                        <td className="text-right text-slate-100">{fin(mean) ? `${mean.toFixed(2)} ${unit}` : '—'}</td>
                        <td className="pr-4 text-right text-slate-300 sm:pr-5">{fin(mx) ? `${mx.toFixed(2)} ${unit}` : '—'}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            ) : <p className="text-sm text-slate-400">{t('Verifica non disponibile')}</p>}
            {v && (
              <ul className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-slate-400">
                {v.checks.filter((c) => c.note).map((c) => (
                  <li key={c.id} className="flex gap-2.5"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-500" /><span><span className="text-slate-300">{t(CHECK_LABEL[c.id] ?? c.id)}.</span> {c.note}</span></li>
                ))}
                <li className="flex gap-2.5"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-500" /><span>{t('Verifica eseguita il {d} con lo script di controllo del progetto; i calendari futuri usano lo stesso motore.', { d: date(v.generated_at) })}</span></li>
              </ul>
            )}
          </CardBody>
        </Card>
        <Card className="h-full">
          <CardHeader icon={<BookOpen />} title={t('Cosa dice la letteratura')} subtitle={t('Studi accademici e retest indipendenti')} />
          <CardBody className="pt-0">
            <ul className="flex flex-col">
              {LIT.map((l) => (
                <li key={l.ref} className="border-t border-line py-2.5 first:border-t-0 first:pt-0">
                  <div className="text-sm font-medium text-slate-200">{l.url ? <a href={l.url} target="_blank" rel="noreferrer" className="hover:text-white">{t(l.ref)}</a> : t(l.ref)}</div>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{t(l.text)}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
      <MethodNote title={t('Metodo generale')}>
        <p>{t('Campione: rendimenti giornalieri logaritmici di BTC dal {s} al {e} ({n} giorni; la candela di oggi è esclusa perché incompleta). Ogni ipotesi è stata fissata prima di guardare i risultati (finestre ±3 giorni per gli eventi, 6 giorni dopo le tempeste come in letteratura) per evitare di scegliere la finestra più favorevole.', { s: date(d.sample.start), e: date(d.sample.end), n: int(d.sample.days) })}</p>
        <p>{t('Placebo: le date degli eventi (o la maschera dei periodi) vengono traslate rigidamente di ogni ampiezza possibile; il p-value è la quota di traslazioni con un effetto almeno altrettanto grande in valore assoluto. Così si confronta l’evento con date «finte» che hanno la stessa struttura e lo stesso mercato. Con {n} ipotesi, circa una risulterebbe significativa al 5% per puro caso: per questo i p sono corretti con Benjamini-Hochberg.', { n: d.hypotheses.length })}</p>
        <p>{t('Stabilità: lo stesso segno nelle due metà del campione e in almeno il 75% dei cicli dell’halving con almeno 3 eventi. Fonti dati: Astronomy Engine (MIT), USNO, NASA GSFC, JPL Horizons, GFZ Potsdam, SILSO, NOAA SWPC; prezzi da Bitstamp e Binance.')}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ page
export default function AstroPage() {
  const q = useAstro(90)
  const [tab, setTab] = useTab<Tab>(TABS.map((x) => x.value), 'luna')
  return (
    <div>
      <PageTitle title={t('Astronomia e numeri')} subtitle={t('Luna, eclissi, pianeti, Sole e numeri «magici» messi alla prova sullo storico di BTC: uno studio statistico, non un segnale di trading.')} />
      <TabBar tabs={TABS.map((x) => ({ value: x.value, label: t(x.label) }))} value={tab} onChange={setTab} />
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[460px]" /><Skeleton className="h-[320px]" /></div>} isEmpty={(d) => !d.hypotheses?.length}>
        {(d) => (
          <div className="flex flex-col gap-3">
            <Kpis d={d} />
            {tab === 'luna' && <LunaTab d={d} />}
            {tab === 'calendario' && <CalendarioTab d={d} />}
            {tab === 'eclissi' && <EclissiTab d={d} />}
            {tab === 'pianeti' && <PianetiTab d={d} />}
            {tab === 'sole' && <SoleTab d={d} />}
            {tab === 'numeri' && <NumeriTab d={d} />}
            {tab === 'verdetti' && <VerdettiTab d={d} />}
            {tab !== 'verdetti' && <SectionTitle sub={t('Riepilogo: quante ipotesi superano la prova del caso')}>{t('In sintesi')}</SectionTitle>}
            {tab !== 'verdetti' && <Summary d={d} onOpen={() => setTab('verdetti')} />}
          </div>
        )}
      </Q>
    </div>
  )
}

function Summary({ d, onOpen }: { d: AstroResponse; onOpen: () => void }) {
  const by = (v: string) => d.hypotheses.filter((h) => h.verdict === v)
  const groups = [
    { v: 'strong', label: t('Effetto significativo e stabile') }, { v: 'weak', label: t('Effetto debole') },
    { v: 'none', label: t('Nessun effetto distinguibile dal caso') }, { v: 'anecdotal', label: t('Troppo pochi casi: aneddotico') },
  ]
  return (
    <Card>
      <CardBody className="grid gap-x-6 gap-y-3 pt-4 sm:pt-5 md:grid-cols-2 2xl:grid-cols-4">
        {groups.map((g) => (
          <div key={g.v} className="min-w-0">
            <div className="flex items-baseline gap-2"><span className="tnum text-2xl font-semibold text-white">{by(g.v).length}</span><span className="label truncate">{g.label}</span></div>
            <div className="mt-1 line-clamp-3 text-xs text-slate-400">{by(g.v).map((h) => hypLabel(h.id)).join(' · ') || '—'}</div>
          </div>
        ))}
        <button onClick={onOpen} className="justify-self-start text-xs font-medium text-accent-blue hover:text-white md:col-span-2 2xl:col-span-4">{t('Apri la tabella dei verdetti →')}</button>
      </CardBody>
    </Card>
  )
}

