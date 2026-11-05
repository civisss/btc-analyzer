/* Dopo il movimento: movimenti forti recenti, con prezzo, CVD, open interest e liquidazioni nella finestra. Solo descrizione. */
import { useMemo, useState } from 'react'
import { Zap } from 'lucide-react'
import { useMove, useMoves, type Move, type MoveDetail, type MoveTag, type Moves } from '../api/scoreboard'
import { C, axisNum, hexA, lineSeries, usdAxis } from '../components/charts/theme'
import { Badge, Card, CardBody, CardHeader, EmptyState, MethodNote, Q, Skeleton, clsx } from '../components/ui'
import { date, dateTime, usd, usdCompact } from '../lib/format'
import { t } from '../i18n'
import { T } from '../theme/tokens'
import { Stack, candleStyle, flowAxis, hhmm, tipRow, type Panel } from './stack'

const su = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${usdCompact(Math.abs(v), d)}`)
const sp = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`
const sk = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) / 1000).toFixed(1)}K`)

const TAG: Record<MoveTag, string> = {
  short_squeeze: 'Squeeze di short: OI in calo con prezzo su', new_longs: 'Leva nuova: OI su con prezzo su', long_flush: 'Long in uscita: OI in calo con prezzo giù',
  new_shorts: 'Short nuovi: OI su con prezzo giù', spot_buying: 'Acquisti spot', spot_selling: 'Vendite spot', perp_led: 'Guidato dai perpetui', spot_against: 'Spot in direzione opposta',
  liq_shorts: 'Liquidati soprattutto short', liq_longs: 'Liquidati soprattutto long', no_reading: 'Nessuna lettura netta',
}

function liqChip(m: Move): string {
  const s = m.stats
  if (!s || s.liq_status === 'none') return t('Liquidazioni non raccolte in questa finestra')
  const v = t('Long {l}, short {s} liquidati', { l: usdCompact(s.liq_long, 1), s: usdCompact(s.liq_short, 1) })
  return s.liq_status === 'partial' ? `${v} (${t('raccolta parziale')})` : v
}

function panels(d: MoveDetail): Panel[] {
  const s = d.series
  const st = d.stats
  const i0 = s.t.findIndex((x) => x >= d.from)
  const i1 = s.t.reduce((a, x, i) => (x < d.to ? i : a), i0)
  const area = { silent: true, itemStyle: { color: hexA(T.accent, 0.08) }, data: [[{ xAxis: String(s.t[i0]) }, { xAxis: String(s.t[i1]) }]] }
  const candles = s.t.map((_, i) => [s.o[i], s.c[i], s.l[i], s.h[i]])
  const scope = st?.cvd_scope === 'multi' ? t('multi-exchange') : 'Binance'
  const extreme = d.dir > 0 ? st?.high : st?.low
  return [
    { label: t('BTC perp Binance, 5m'), height: 190, yFormat: usdAxis, chip: t('{r} in {m} minuti, {w} {p}', { r: sp(d.ret_pct), m: d.minutes, w: t(d.dir > 0 ? 'massimo' : 'minimo'), p: extreme != null ? usd(extreme) : '—' }),
      series: [{ type: 'candlestick', name: 'BTC', data: candles, itemStyle: candleStyle, barMaxWidth: 6, markArea: area }] },
    { label: t('CVD spot, {s}', { s: scope }), height: 88, yFormat: flowAxis, chip: t('Spot {v} nel movimento', { v: su(st?.spot_usd) }), series: [lineSeries('Spot', s.spot, C.accent, { markArea: area })] },
    { label: t('Open interest, BTC'), height: 88, yFormat: axisNum, chip: t('OI {v} BTC ({p})', { v: sk(st?.oi_btc), p: st?.oi_pct != null ? sp(st.oi_pct) : '—' }), series: [lineSeries('OI', s.oi, T.wheat, { connectNulls: true, markArea: area })] },
    { label: t('CVD futures, {s}', { s: scope }), height: 88, yFormat: flowAxis, chip: t('Perp {v} nel movimento', { v: su(st?.perp_usd) }), series: [lineSeries('Perp', s.perp, T.steel, { markArea: area })] },
    { label: t('Liquidazioni raccolte'), height: 72, yFormat: (v) => flowAxis(v).replace('+', ''), yExtra: { scale: false }, chip: liqChip(d),
      series: [{ type: 'bar', name: 'Short', stack: 'l', data: s.liq_short, itemStyle: { color: T.up }, markArea: area }, { type: 'bar', name: 'Long', stack: 'l', data: s.liq_long, itemStyle: { color: T.down } }] },
  ]
}

function tip(d: MoveDetail, i: number): string {
  const s = d.series
  const oi = s.oi[i]
  return `<div style="min-width:170px"><div style="margin-bottom:4px">${dateTime(s.t[i])}</div>`
    + tipRow(t('Chiusura'), usd(s.c[i])) + tipRow('CVD spot', su(s.spot[i])) + tipRow('CVD perp', su(s.perp[i]))
    + tipRow('OI', oi != null ? `${Math.round(oi).toLocaleString('en-US')} BTC` : '—')
    + tipRow(t('Liquidati long'), usdCompact(s.liq_long[i], 1)) + tipRow(t('Liquidati short'), usdCompact(s.liq_short[i], 1)) + '</div>'
}

function Detail({ d }: { d: MoveDetail }) {
  const ps = useMemo(() => panels(d), [d])
  const cats = useMemo(() => d.series.t.map(String), [d])
  const a = d.stats?.after
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {d.tags.map((x) => <Badge key={x} color="btc">{t(TAG[x])}</Badge>)}
      </div>
      <Stack panels={ps} categories={cats} xLabel={(v) => hhmm(Number(v))} tooltip={(i) => tip(d, i)} />
      {a && <p className="tnum text-xs text-fg-3">{t('Nelle {h} ore successive mostrate: prezzo {r}, OI {o} BTC. È la cronaca di quanto accaduto, non una previsione.', { h: a.hours.toFixed(1), r: sp(a.ret_pct, 2), o: sk(a.oi_btc) })}</p>}
    </div>
  )
}

function List({ m, sel, onSel }: { m: Moves; sel: number; onSel: (id: number) => void }) {
  return (
    <ul className="flex min-w-0 flex-col gap-1 max-lg:max-h-72 max-lg:overflow-y-auto lg:max-h-[720px] lg:overflow-y-auto">
      {m.events.map((e) => (
        <li key={e.id}>
          <button type="button" onClick={() => onSel(e.id)} aria-pressed={e.id === sel}
            className={clsx('w-full rounded-lg border px-3 py-2 text-left transition-colors', e.id === sel ? 'border-accent/35 bg-accent/10' : 'border-line bg-white/[0.02] hover:border-line-strong')}>
            <span className="flex items-baseline justify-between gap-3">
              <span className={clsx('tnum text-sm font-semibold', e.dir > 0 ? 'text-up' : 'text-down')}>{sp(e.ret_pct)}</span>
              <span className="tnum text-xs text-fg-3">{date(e.from, false)} {hhmm(e.from)}</span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-fg-3" title={t(TAG[e.tags[0] ?? 'no_reading'])}>{t(TAG[e.tags[0] ?? 'no_reading'])}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Body({ m, updatedAt }: { m: Moves; updatedAt: number }) {
  const [sel, setSel] = useState<number | null>(null)
  const id = sel != null && m.events.some((e) => e.id === sel) ? sel : m.events[0]?.id ?? null
  const q = useMove(id)
  const r = m.rule
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader icon={<Zap />} accent="btc" title={t('Dopo il movimento')} updatedAt={updatedAt} subtitle={t('Ultimi 14 giorni: cosa ha accompagnato i movimenti forti, senza previsioni')}
          info={t('Movimento: variazione di chiusura in 1 ora di almeno {k} volte il range tipico delle 24 ore precedenti, e almeno {p}%.', { k: r.k, p: r.min_pct })} />
        <CardBody className="pt-0">
          {!m.events.length ? <EmptyState text={t('Nessun movimento oltre la soglia negli ultimi 14 giorni')} /> : (
            <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <List m={m} sel={id ?? 0} onSel={setSel} />
              <Q q={q} compact loading={<Skeleton className="h-[640px]" />}>{(d) => <Detail d={d} />}</Q>
            </div>
          )}
        </CardBody>
      </Card>
      <MethodNote>
        <p>{t('Rilevamento su candele da {b} minuti Binance perp: variazione di chiusura su {n} candele divisa per la mediana del true range delle {w} candele precedenti × √{n}. Un movimento richiede almeno {k} e {p}%. Le candele vicine dello stesso segno si uniscono; inizio e fine stanno sugli estremi di prezzo.', { b: r.bar_min, n: r.ret_bars, w: r.base_bars, k: r.k, p: r.min_pct })}</p>
        <p>{t('Letture: OI oltre ±{o}% durante il movimento distingue squeeze o uscite da leva nuova. Lo spot è protagonista se il suo delta ha il segno del movimento ed è almeno il {s}% di quello dei perpetui. Liquidazioni: un lato almeno doppio dell\'altro, solo con raccolta completa.', { o: r.oi_move_pct, s: r.spot_share * 100 })}</p>
        <p>{t('Copertura: CVD dalle kline ufficiali Binance; diventa multi-exchange solo se la raccolta del Terminale copriva tutti gli stream. OI aggregato Binance + Bybit + OKX: campioni da 30 secondi, altrimenti fotografie da 5 minuti o stima da 15 minuti. Liquidazioni solo dalla raccolta: se l\'app era spenta il totale è parziale o assente.')}</p>
      </MethodNote>
    </div>
  )
}

export function MovesSection() {
  const q = useMoves()
  return <Q q={q} loading={<Skeleton className="h-[720px]" />}>{(m) => <Body m={m} updatedAt={q.dataUpdatedAt} />}</Q>
}
