import { useMemo, useState, type ReactNode } from 'react'
import { Activity, ArrowLeftRight, Coins, Compass, DollarSign, Gauge, Grid3x3, Landmark, LineChart, Percent, PieChart, Repeat, Scale, Shuffle, Table2, Timer, Waves } from 'lucide-react'
import { cap, t, tr } from '../i18n'
import { useMacro, type Macro } from '../api/macro'
import { C, hexA } from '../components/charts/theme'
import { Card, CardBody, CardHeader, Change, EmptyState, Fill, KpiCell, KpiStrip, MethodNote, PageTitle, PointsChange, ProgressBar, Q, Segmented, Skeleton, ToneBadge, Toggle, clsx } from '../components/ui'
import { TimeLinesChart } from '../widgets/charts'
import { MiniTrend } from '../components/MiniTrend'
import {
  ALT_BANDS, AltseasonGauge, CorrHeatmap, DxyBtcChart, LagBarsChart, LiquidityOverlayChart, RegimeTable, RiskMeter, ScoreBar, ScoreTag, SectionTitle, SeriesWithMaChart,
} from '../widgets/macro'
import { date, dayUnit, pct, pts, usdCompact } from '../lib/format'

type Num = number | null | undefined
const fin = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)
const f = (v: Num, d = 2) => (fin(v) ? v.toFixed(d) : '—')
/** Neutral signed % (for DXY / VIX / yields: a rise is risk-off, so green/red would mislead). */
const nPct = (v: Num, d = 2) => <span className="tnum text-slate-300">{pct(v, d)}</span>
const nPts = (v: Num, d = 2) => <span className="tnum text-slate-300">{pts(v, d)}</span>
const GRID0 = hexA(C.grey, 0.5)
/** '30g' (IT) / '30d' (EN) */
const dd = (n: number) => `${n}${dayUnit()}`

function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-t border-line py-1 text-sm first:border-t-0">
      <span className="min-w-0 text-slate-400">{k}</span>
      <span className="tnum whitespace-nowrap text-right font-medium text-white">{children}</span>
    </div>
  )
}
const ethFmt = (v: number) => v.toFixed(4)
const domFmt = (v: number) => `${v.toFixed(1)}%`
const altFmt = (v: number) => v.toFixed(0)

function Kpis({ d }: { d: Macro }) {
  const k = d.kpi
  // 7 tiles: one row only from 1700px (narrower tiles truncated the labels); below, 4 + 3 with the last tile spanning 2
  return (
    <KpiStrip cols="grid-cols-2 md:grid-cols-4 min-[1700px]:grid-cols-7">
      <KpiCell icon={<DollarSign />} label="DXY" value={f(k.dxy.value)} delta={<>{nPct(k.dxy.change_1d)} <span className="text-slate-400">{dd(1)}</span></>} title={`${dd(30)} ${pct(k.dxy.change_30d)}`} />
      <KpiCell icon={<Percent />} label="US10Y" value={`${f(k.us10y.value)}%`} delta={<>{nPts(k.us10y.change_30d)} <span className="text-slate-400">{dd(30)}</span></>} />
      <KpiCell icon={<Activity />} label="VIX" value={f(k.vix.value)} delta={<>{nPct(k.vix.change_1d)} <span className="text-slate-400">{dd(1)}</span></>} />
      <KpiCell icon={<Coins />} label={t('Supply stablecoin')} value={usdCompact(k.stables.value, 1)} delta={<Change value={k.stables.growth_90d} suffix={dd(90)} />} />
      <KpiCell icon={<ArrowLeftRight />} label="ETH/BTC" value={f(k.ethbtc.value, 5)} delta={<Change value={k.ethbtc.change_30d} suffix={dd(30)} />} />
      <KpiCell icon={<PieChart />} label={t('Dominance BTC')} value={`${f(k.dominance.value)}%`} delta={<PointsChange value={k.dominance.change_30d} suffix={dd(30)} />} />
      <KpiCell icon={<Shuffle />} label={t('Indice altseason')} value={<>{f(k.altseason.value, 0)}<span className="ml-1 text-sm font-normal text-slate-400">/ 100</span></>} foot={cap(k.altseason.phase_label)} className="col-span-2 min-[1700px]:col-span-1" />
    </KpiStrip>
  )
}

function SummaryCard({ d, updatedAt }: { d: Macro; updatedAt: number }) {
  const s = d.summary
  const fr = d.fred
  const n = fr.available ? fr.net_liquidity : null
  return (
    <Card>
      <CardHeader title={t('Contesto macro')} subtitle={t('Punteggio composito risk-on / risk-off')} right={<ToneBadge tone={s.tone} label={s.label} />}
        icon={<Gauge />} updatedAt={updatedAt}
        info={t('Combina le componenti elencate sotto: sopra 50 il contesto favorisce gli asset rischiosi, sotto 50 li penalizza.')} />
      <CardBody className={clsx('grid gap-x-8 gap-y-4', n && 'xl:grid-cols-3')}>
        <div className={clsx('flex flex-col gap-4', n && 'xl:col-span-2')}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="tnum text-3xl font-semibold text-white">{s.score.toFixed(0)}<span className="ml-1 text-sm font-normal text-slate-400">/ 100</span></div>
            <div className="min-w-[200px] flex-1"><RiskMeter value={s.score} /></div>
          </div>
          <p className="line-clamp-2 text-sm text-slate-300">{s.bullets.slice(0, 2).join(' ')}</p>
          <div className="grid gap-x-6 md:grid-cols-2">
            {s.components.map((c) => (
              <div key={c.key} className="flex flex-col gap-1.5 border-t border-line py-2.5" title={c.text}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-slate-200">{c.label}</span>
                  <span className="flex shrink-0 items-center gap-2"><span className="tnum text-xs text-slate-400">{c.value}</span><ScoreTag score={c.score} /></span>
                </div>
                <ScoreBar score={c.score} />
              </div>
            ))}
          </div>
        </div>
        {n ? (
          <div className="flex flex-col">
            <div className="label mb-1">{t('Liquidità Fed')}</div>
            <>
              <KV k={t('Liquidità netta USA')}>{usdCompact(n.value, 2)} <span className="ml-1 text-xs font-normal"><Change value={n.change_13w} suffix={tr('13 sett.', '13w')} /></span></KV>
              <KV k={t('Bilancio Fed (WALCL)')}>{usdCompact(n.walcl, 2)}</KV>
              <KV k="Reverse repo (RRP)">{usdCompact(n.rrp, 0)}</KV>
              <KV k={t('Conto del Tesoro (TGA)')}>{usdCompact(n.tga, 0)}</KV>
              <KV k={t('M2 su base annua')}>{pct(fr.m2_yoy, 2)}</KV>
              <p className="mt-1 text-xs text-slate-400">{t('Aggiornato al {d}', { d: date(n.as_of) })}</p>
            </>
          </div>
        ) : <p className="text-xs text-slate-400">{t('Dati Fed non disponibili')}</p>}
      </CardBody>
    </Card>
  )
}

function LiquiditySection({ d }: { d: Macro }) {
  const lags = d.liquidity.lags
  const [key, setKey] = useState<string>(lags[0]?.key ?? 'stables')
  const [mode, setMode] = useState<'shift' | 'level'>('shift')
  const lag = lags.find((l) => l.key === key) ?? lags[0]
  const st = d.liquidity.stables
  if (!lag) return <Card><CardBody className="pt-5"><EmptyState text={t('Dati di liquidità non disponibili')} /></CardBody></Card>
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={t('Liquidità vs BTC')} icon={<Waves />}
            subtitle={mode === 'shift' ? t('Variazione {p} · liquidità traslata di +{n}', { p: dd(90), n: dd(lag.best_lag) }) : t('Livelli assoluti (scala logaritmica)')}
            right={<>
              {lags.length > 1 && <span className="flex items-center gap-2"><span className="label">{t('Serie')}</span><Segmented options={lags.map((l) => ({ value: l.key, label: l.key === 'stables' ? 'Stablecoin' : l.key === 'm2' ? 'M2' : t('Liquidità netta') }))} value={lag.key} onChange={setKey} /></span>}
              <span className="flex items-center gap-2"><span className="label">{t('Vista')}</span><Segmented options={[{ value: 'shift', label: t('Var. {p}', { p: dd(90) }) }, { value: 'level', label: t('Livelli') }]} value={mode} onChange={setMode} /></span>
            </>}
          />
          <CardBody className="flex flex-col"><Fill min={360}><LiquidityOverlayChart lag={lag} btcPrice={d.liquidity.btc_price} mode={mode} height="100%" /></Fill></CardBody>
        </Card>
        <Card>
          <CardHeader title={t('Ritardo liquidità → BTC')} icon={<Timer />} subtitle={t('Correlazione per ritardo in giorni · blu = migliore')} />
          <CardBody className="flex flex-col gap-3">
            <LagBarsChart lag={lag} height={220} />
            <div className="dgrid grid-cols-2">
              <div className="px-3 py-2.5">
                <div className="label">{t('Ritardo migliore')}</div>
                <div className="tnum mt-1 text-2xl font-semibold text-white">{lag.best_lag} {dayUnit()}</div>
                <div className="text-xs text-slate-400">{lag.best_lag >= 14 ? t('≈ {n} settimane', { n: Math.round(lag.best_lag / 7) }) : lag.best_lag === 0 ? t('Nessun ritardo') : t('Meno di 2 settimane')}</div>
              </div>
              <div className="px-3 py-2.5">
                <div className="label">{t('Correlazione')} <span className="normal-case">(ρ)</span></div>
                <div className="tnum mt-1 text-2xl font-semibold text-white">{f(lag.best_corr)}</div>
                <div className="tnum text-xs text-slate-400">{t('Ritardo 0: {v}', { v: f(lag.corr_lag0) })}</div>
              </div>
            </div>
            <p className="line-clamp-3 text-sm text-slate-300" title={lag.text}>{lag.text}</p>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title={t('Supply stablecoin')} icon={<Coins />} subtitle={t('Proxy della liquidità on-chain · DefiLlama')}
          right={<span className="text-xs text-slate-400">{dd(30)} <Change value={st.change_30d} /> · {dd(90)} <Change value={st.growth_90d} /></span>} />
        <CardBody className="flex flex-col">
          <TimeLinesChart height={260} yFmt={(v) => usdCompact(v, 0)} y2Fmt={(v) => `${v.toFixed(0)}%`} zoom
            lines={[{ name: t('Supply totale (USD)'), data: st.series, color: C.blue, area: true }, { name: t('Crescita {p} (%)', { p: dd(90) }), data: st.growth_series, color: C.purple, axis: 1, width: 1.25 }]} />
        </CardBody>
      </Card>
    </>
  )
}

function DollarSection({ d }: { d: Macro }) {
  const [inv, setInv] = useState(true)
  const [reg, setReg] = useState<'dxy' | 'us10y' | 'vix'>('dxy')
  const dr = d.dollar_rates
  const r = dr[reg]
  const rc = d.correlations.rolling.dxy
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="DXY vs BTC" subtitle={inv ? t('Asse DXY ↓ invertito: salgono insieme se il dollaro scende') : t('DXY a sinistra, BTC a destra (log)')}
            icon={<Landmark />}
            right={<Toggle on={inv} onClick={() => setInv(!inv)}>{t('DXY invertito')}</Toggle>} />
          <CardBody className="flex flex-col"><Fill min={320}><DxyBtcChart d={dr.dxy} inverted={inv} height="100%" /></Fill></CardBody>
        </Card>
        <Card>
          <CardHeader title={t('Regime dollaro')} icon={<Scale />} subtitle={t('Media {p} e variazione a 6 mesi', { p: dd(200) })} right={<span className="text-sm font-medium text-white">{cap(dr.dxy.regime_label)}</span>} />
          <CardBody className="flex flex-col gap-3">
            <div>
              <KV k="DXY">{f(dr.dxy.value)} <span className="ml-1 text-xs font-normal">{nPct(dr.dxy.change_1d)} <span className="text-slate-400">{dd(1)}</span></span></KV>
              <KV k={t('Media 200 giorni')}>{f(dr.dxy.ma200)} <span className="ml-1 text-xs font-normal text-slate-400">{dr.dxy.above_ma200 ? t('Sopra') : t('Sotto')}</span></KV>
              <KV k={t('Variazione 6 mesi')}>{nPct(dr.dxy.change_6m)}</KV>
              <KV k={t('Correlazione BTC {p}', { p: dd(90) })}>{f(d.correlations.betas.find((b) => b.asset === 'dxy')?.corr_90d)}</KV>
            </div>
            <p className="line-clamp-3 text-sm text-slate-300" title={dr.dxy.text}>{dr.dxy.text}</p>
            <MiniTrend data={dr.dxy.series.slice(-365)} label={t('DXY · ultimi 12 mesi')} right={nPct(dr.dxy.change_6m)} color={C.blue} />
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('Correlazione mobile BTC–DXY')} icon={<Activity />} subtitle={t('Rendimenti giornalieri · sotto zero = direzioni opposte')} />
          <CardBody className="flex flex-col">
            <Fill min={260}><TimeLinesChart height="100%" yFmt={(v) => v.toFixed(2)} zoom markLines={[{ y: 0, color: GRID0 }]}
              lines={[{ name: t('{n} giorni', { n: 30 }), data: rc.r30, color: C.grey, width: 1 }, { name: t('{n} giorni', { n: 90 }), data: rc.r90, color: C.blue }, { name: t('{n} giorni', { n: 180 }), data: rc.r180, color: C.purple }]} /></Fill>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('BTC per regime macro')} icon={<Table2 />} subtitle={t('Rendimenti storici di BTC dal 2013 per regime')}
            right={<Segmented options={[{ value: 'dxy', label: t('Dollaro') }, { value: 'us10y', label: t('Tassi 10A') }, { value: 'vix', label: 'VIX' }]} value={reg} onChange={setReg} />} />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-400">{t('Ora:')}</span>
              <span className="font-semibold text-white">{cap(r.regime_label)}</span>
              <span className="tnum text-slate-400">
                {reg === 'dxy' && <>· DXY {f(dr.dxy.value)}</>}
                {reg === 'us10y' && <>· {f(dr.us10y.value)}% · 6m {nPts(dr.us10y.change_6m)}</>}
                {reg === 'vix' && <>· VIX {f(dr.vix.value)}</>}
              </span>
            </div>
            <RegimeTable stats={r.stats} current={r.regime} fwd={reg === 'vix' ? 30 : 90} />
            <p className="line-clamp-2 text-sm text-slate-300" title={r.text}>{r.text}</p>
          </CardBody>
        </Card>
      </div>
    </>
  )
}

function CorrelationSection({ d }: { d: Macro }) {
  const [win, setWin] = useState(0)
  const c = d.correlations
  const m = c.matrices[win] ?? c.matrices[0]
  const rolling = useMemo(() => [
    { name: 'S&P 500', data: c.rolling.spx.r90, color: C.blue },
    { name: 'Nasdaq', data: c.rolling.ndx.r90, color: C.purple },
    { name: t('Oro'), data: c.rolling.gold.r90, color: C.teal },
    { name: 'DXY', data: c.rolling.dxy.r90, color: C.grey, width: 1.25 },
  ], [c])
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader title={t('Matrice di correlazione')} icon={<Grid3x3 />} subtitle={t('Rendimenti giornalieri · verde positiva, rosso negativa')}
          right={<Segmented options={c.matrices.map((x, i) => ({ value: i, label: x.window }))} value={win} onChange={setWin} />} />
        <CardBody><CorrHeatmap assets={c.assets} values={m.values} height={380} /></CardBody>
      </Card>
      <Card>
        <CardHeader title={t('BTC vs mercati tradizionali')} icon={<LineChart />} subtitle={t('Correlazione mobile 90 giorni e beta di BTC')}
          info={t("Beta = variazione media di BTC per ogni 1% di variazione dell'asset (es. beta 1.5 sull'S&P 500: +1% S&P → +1.5% BTC in media).")} />
        <CardBody className="flex flex-col gap-3">
          <TimeLinesChart height={230} yFmt={(v) => v.toFixed(2)} markLines={[{ y: 0, color: GRID0 }]} lines={rolling} />
          <div className="-mx-4 overflow-x-auto">
            <table className="tbl min-w-[380px]">
              <thead>
                <tr>
                  <th className="pl-4">Asset</th>
                  <th className="text-right">ρ {dd(90)}</th>
                  <th className="text-right">Beta {dd(90)}</th>
                  <th className="text-right">{t('ρ 1 anno')}</th>
                  <th className="pr-4 text-right">{t('Beta 1 anno')}</th>
                </tr>
              </thead>
              <tbody>
                {c.betas.map((b) => (
                  <tr key={b.asset}>
                    <td className="pl-4 text-slate-200">{b.label}</td>
                    <td className="text-right">{f(b.corr_90d)}</td>
                    <td className="text-right text-slate-300">{f(b.beta_90d)}</td>
                    <td className="text-right">{f(b.corr_1y)}</td>
                    <td className="pr-4 text-right text-slate-300">{f(b.beta_1y)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function RotationSection({ d }: { d: Macro }) {
  const r = d.rotation
  const a = r.altseason
  const [chart, setChart] = useState<'dominance' | 'altseason'>('dominance')
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="ETH/BTC" icon={<Repeat />} subtitle={t('Verticali: Top e Bottom di ciclo BTC, halving (H)')}
            right={<span className="text-xs text-slate-400">{dd(30)} <Change value={r.ethbtc.change_30d} /> · {dd(90)} <Change value={r.ethbtc.change_90d} /></span>} />
          <CardBody className="flex flex-col"><Fill min={320}><SeriesWithMaChart series={r.ethbtc.series} ma={r.ethbtc.ma200_series} name="ETH/BTC" color={C.purple} marks={r.cycle_marks} fmt={ethFmt} height="100%" /></Fill></CardBody>
        </Card>
        <Card>
          <CardHeader title={t('Indice altseason')} icon={<Shuffle />} subtitle={t('0 = BTC season · 100 = rotazione verso altcoin')} info={a.explanation} />
          <CardBody className="flex flex-col items-center gap-3">
            <AltseasonGauge value={a.value ?? 50} size={210} />
            <div className="-mt-2 text-center">
              <div className="tnum text-3xl font-semibold text-white">{f(a.value, 0)}<span className="ml-1 text-sm font-normal text-slate-400">/ 100</span></div>
              <div className="text-sm text-slate-300">{cap(a.phase_label)}</div>
            </div>
            <div className="flex w-full flex-col gap-1.5">
              {a.components.map((c) => (
                <div key={c.key} className="flex items-center gap-2 text-xs">
                  <span className="w-44 shrink-0 truncate text-slate-400" title={c.label}>{c.label}</span>
                  <ProgressBar value={c.value ?? 0} className="flex-1" />
                  <span className="tnum w-8 text-right text-slate-300">{f(c.value, 0)}</span>
                </div>
              ))}
            </div>
            <MiniTrend className="w-full" data={a.series.slice(-365)} label={t('Indice altseason · ultimi 12 mesi')} color={C.purple} />
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader icon={<PieChart />} title={chart === 'dominance' ? t('Dominance BTC') : t('Storico indice altseason')}
            subtitle={chart === 'dominance' ? t('Quota di BTC sulla cap crypto totale (stima)') : t('Fasce: < 35 BTC season · > 65 rotazione altcoin')}
            right={<>
              {chart === 'dominance' && <span className="text-xs text-slate-400">{dd(30)} <PointsChange value={r.dominance.change_30d} /> · {dd(90)} <PointsChange value={r.dominance.change_90d} /></span>}
              <Segmented options={[{ value: 'dominance', label: 'Dominance' }, { value: 'altseason', label: 'Altseason' }]} value={chart} onChange={setChart} />
            </>} />
          <CardBody className="flex flex-col">
            <Fill min={340}>
              {chart === 'dominance'
                ? <SeriesWithMaChart series={r.dominance.series} ma={r.dominance.ma200_series} name={t('Dominance BTC')} color={C.blue} marks={r.cycle_marks} fmt={domFmt} height="100%" />
                : <SeriesWithMaChart series={a.series} name={t('Indice altseason')} color={C.purple} marks={r.cycle_marks} fmt={altFmt} height="100%" bands={ALT_BANDS} />}
            </Fill>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('Dove siamo nel ciclo')} icon={<Compass />} subtitle={t("Cicli precedenti a {n} dall'halving", { n: `${r.days_since_halving} ${dayUnit()}` })} />
          <CardBody className="flex flex-col pt-0">
            {r.compare.map((c) => {
              const cur = c.cycle.startsWith('Attuale')
              return (
                <div key={c.cycle} className="border-t border-line py-2.5 first:border-t-0">
                  <div className="flex items-center justify-between text-sm"><span className={clsx('font-medium', cur ? 'text-white' : 'text-slate-200')}>{c.cycle}</span><span className="text-xs text-slate-400">{date(c.time)}</span></div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs">
                    <div><div className="text-slate-400">ETH/BTC</div><div className="tnum text-slate-200">{f(c.ethbtc, 4)}</div></div>
                    <div><div className="text-slate-400">Dominance</div><div className="tnum text-slate-200">{fin(c.dominance) ? `${c.dominance.toFixed(1)}%` : '—'}</div></div>
                    <div><div className="text-slate-400">Altseason</div><div className="tnum text-slate-200">{f(c.altseason, 0)}</div></div>
                  </div>
                  {!cur && (
                    <div className="mt-1.5 text-xs text-slate-400">
                      {t('{n} dopo', { n: dd(180) })}: ETH/BTC <Change value={c.ethbtc_next_180d} digits={1} /> · Dominance <PointsChange value={c.dominance_next_180d} digits={1} />
                    </div>
                  )}
                  {cur && fin(c.ethbtc_since_halving) && <div className="mt-1.5 text-xs text-slate-400">{t("ETH/BTC dall'halving")} <Change value={c.ethbtc_since_halving} digits={1} /></div>}
                </div>
              )
            })}
            <ul className="mt-2 flex list-disc flex-col gap-1 border-t border-line pl-4 pt-2.5 text-sm text-slate-300">
              {r.bullets.slice(0, 2).map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  )
}

export default function MacroPage() {
  const q = useMacro()
  return (
    <div>
      <PageTitle title={t('Macro e rotazione')} subtitle={t('Liquidità, dollaro e tassi, correlazioni con i mercati tradizionali e rotazione verso le altcoin.')} />
      <Q q={q} loading={<div className="grid gap-3"><Skeleton className="h-24" /><Skeleton className="h-[320px]" /><Skeleton className="h-[420px]" /></div>} isEmpty={(d) => !d.dollar_rates?.dxy?.series?.length}>
        {(d) => (
          <div className="flex flex-col gap-3">
            <Kpis d={d} />
            <SummaryCard d={d} updatedAt={q.dataUpdatedAt} />
            <SectionTitle sub={t('La liquidità in espansione tende a sostenere gli asset rischiosi')}>{t('Liquidità')}</SectionTitle>
            <LiquiditySection d={d} />
            <SectionTitle sub={t('Dollaro forte e tassi in salita drenano liquidità dal rischio')}>{t('Dollaro e tassi')}</SectionTitle>
            <DollarSection d={d} />
            <SectionTitle sub={t('Quanto BTC si muove insieme ad azionario, oro e dollaro')}>{t('Correlazioni cross-asset')}</SectionTitle>
            <CorrelationSection d={d} />
            <SectionTitle sub={t('Il capitale passa da Bitcoin alle altcoin nelle fasi avanzate del ciclo')}>{t('Rotazione BTC → altcoin')}</SectionTitle>
            <RotationSection d={d} />
            <MethodNote title={t('Fonti e metodo')}><p>{d.note}</p></MethodNote>
          </div>
        )}
      </Q>
    </div>
  )
}
