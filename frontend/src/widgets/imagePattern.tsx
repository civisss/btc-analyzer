/* Scheda "Da immagine" della pagina Analoghi: upload (file, trascina, Ctrl+V) di uno screenshot, selezione dell'area,
 * estrazione delle candele con anteprima sovrapposta all'immagine e ricerca degli analoghi su più timeframe,
 * con gli stessi widget della scheda "Grafico attuale" (confronto affiancato, gambe, figure, punti, esiti). */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import {
  ClipboardPaste, Crop, Eye, EyeOff, GitCompareArrows, ImagePlus, Layers, ListChecks, MessageSquareText, RotateCcw, ScanEye,
  ScanSearch, Spline, Target, Timer, TriangleAlert, Upload, X, Crosshair, Gauge, Trophy,
} from 'lucide-react'
import type { AnalogTf } from '../api/analogs'
import { ApiError } from '../api/client'
import {
  IMAGE_MAX_BYTES, IMAGE_TYPES, useImagePattern, type CropRect, type ImagePattern, type ImagePatternExtraction, type ImagePatternMatch, type ImageTheme,
} from '../api/imagePattern'
import Sparkline from '../components/charts/Sparkline'
import { C } from '../components/charts/theme'
import { Badge, Card, CardBody, CardHeader, Change, ICON, KpiCell, KpiStrip, Legend, MethodNote, ProgressBar, Segmented, Skeleton, Toggle, ToneBadge, clsx } from '../components/ui'
import { date, pct, usd } from '../lib/format'
import { t, tfLabel } from '../i18n'
import {
  AnalogCandles, DCell, LEG_COLOR, LINE_STYLE, LegBars, LegTable, MATCH_GRID, MappingList, balancedCols, PatternBadges, VisualBreakdown, buildFuture, pctRangeWithFuture, plabel, whenYear, type ChartLayers,
} from './analogs'
import { T, alpha } from '../theme/tokens'

const ALL_TFS: AnalogTf[] = ['1h', '4h', '1d', '1w']
const OVERLAY = T.accent

// ------------------------------------------------------------------ helpers
type Img = { file: Blob; url: string; name: string; w: number; h: number }

function validate(f: Blob): string | null {
  if (f.type && !IMAGE_TYPES.includes(f.type)) return t('Formato non supportato: usa un\'immagine PNG, JPG o WEBP.')
  if (f.size > IMAGE_MAX_BYTES) return t('Immagine troppo grande: il limite è 8 MB.')
  return null
}

function loadImage(file: Blob, name: string): Promise<Img> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => resolve({ file, url, name, w: im.naturalWidth, h: im.naturalHeight })
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('Immagine non leggibile.'))) }
    im.src = url
  })
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status >= 500) return t('Il server non è riuscito ad analizzare l\'immagine. Riprova tra poco.')
    return e.message
  }
  if (e instanceof TypeError) return t('Impossibile contattare il server. Verifica la connessione.')
  return e instanceof Error ? e.message : t('Si è verificato un errore imprevisto.')
}

function confTone(c: number): { color: 'btc' | 'slate' | 'warn'; label: string } {
  if (c >= 75) return { color: 'btc', label: t('Affidabilità alta') }
  if (c >= 50) return { color: 'slate', label: t('Affidabilità media') }
  return { color: 'warn', label: t('Affidabilità bassa') }
}

// ------------------------------------------------------------------ timeframe chips (multi-select)
export function TfChips({ value, onChange }: { value: AnalogTf[]; onChange: (v: AnalogTf[]) => void }) {
  const toggle = (tf: AnalogTf) => {
    const on = value.includes(tf)
    if (on && value.length === 1) return // almeno un timeframe
    onChange(on ? value.filter((x) => x !== tf) : ALL_TFS.filter((x) => x === tf || value.includes(x)))
  }
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Timeframe')}>
      {ALL_TFS.map((tf) => (
        <button key={tf} type="button" aria-pressed={value.includes(tf)} onClick={() => toggle(tf)}
          className={clsx('chip min-w-[44px] justify-center', value.includes(tf) ? 'chip-on' : 'chip-off')}>
          {tfLabel(tf)}
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ dropzone
function Dropzone({ onFile, error, compact, className }: { onFile: (f: Blob, name: string) => void; error?: string | null; compact?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      role="button" tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f) onFile(f, f.name)
      }}
      className={clsx('group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed text-center outline-none transition-colors focus-visible:border-accent/60',
        compact ? 'px-4 py-5' : 'px-6 py-14 sm:py-20', className,
        over ? 'border-accent/70 bg-accent/[0.06]' : 'border-line-strong bg-white/[0.015] hover:border-white/25 hover:bg-white/[0.03]')}
    >
      <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f, f.name); e.target.value = '' }} />
      <span className={clsx('grid place-items-center rounded-2xl border border-line bg-white/[0.04] text-fg transition-transform group-hover:-translate-y-0.5', compact ? 'h-10 w-10' : 'h-14 w-14')}>
        <ImagePlus size={compact ? 18 : 24} strokeWidth={1.6} />
      </span>
      <div>
        <p className={clsx('font-semibold tracking-tight text-white', compact ? 'text-sm' : 'text-lg')}>
          {t('Trascina qui uno screenshot di TradingView, oppure incollalo con Ctrl+V')}
        </p>
        {!compact && <p className="mx-auto mt-1.5 max-w-xl text-sm text-fg-3">
          {t('Inquadra solo il tratto di grafico che ti interessa: candele verdi/rosse su sfondo scuro o chiaro. L\'immagine viene elaborata in memoria e non viene salvata.')}
        </p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-fg-3">
        <span className="btn-ghost pointer-events-none"><Upload size={ICON.chip} /> {t('Scegli file')}</span>
        <span className="inline-flex items-center gap-1.5"><ClipboardPaste size={ICON.chip} /> {t('Ctrl+V per incollare')}</span>
        <span className="text-fg-off">·</span>
        <span>{t('PNG, JPG o WEBP fino a 8 MB')}</span>
      </div>
      {error && <p className="inline-flex items-center gap-1.5 text-sm text-warn"><TriangleAlert size={ICON.inline} /> {error}</p>}
    </div>
  )
}

// ------------------------------------------------------------------ crop
type DragMode = 'new' | 'move' | 'nw' | 'ne' | 'sw' | 'se'

function CropView({ img, crop, onCrop, disabled }: { img: Img; crop: CropRect | null; onCrop: (c: CropRect | null) => void; disabled?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: DragMode; x0: number; y0: number; start: CropRect | null } | null>(null)
  const toImg = (e: RPointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    const sx = img.w / r.width, sy = img.h / r.height
    return { x: Math.max(0, Math.min(img.w, (e.clientX - r.left) * sx)), y: Math.max(0, Math.min(img.h, (e.clientY - r.top) * sy)), sx, sy }
  }
  const norm = (ax: number, ay: number, bx: number, by: number): CropRect => ({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) })
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    const p = toImg(e)
    let mode: DragMode = 'new'
    if (crop) {
      const hx = 14 * p.sx, hy = 14 * p.sy
      const near = (cx: number, cy: number) => Math.abs(p.x - cx) <= hx && Math.abs(p.y - cy) <= hy
      if (near(crop.x, crop.y)) mode = 'nw'
      else if (near(crop.x + crop.w, crop.y)) mode = 'ne'
      else if (near(crop.x, crop.y + crop.h)) mode = 'sw'
      else if (near(crop.x + crop.w, crop.y + crop.h)) mode = 'se'
      else if (p.x > crop.x && p.x < crop.x + crop.w && p.y > crop.y && p.y < crop.y + crop.h) mode = 'move'
    }
    drag.current = { mode, x0: p.x, y0: p.y, start: crop }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const p = toImg(e)
    const s = d.start
    if (d.mode === 'new' || !s) { onCrop(norm(d.x0, d.y0, p.x, p.y)); return }
    if (d.mode === 'move') {
      const nx = Math.max(0, Math.min(img.w - s.w, s.x + p.x - d.x0))
      const ny = Math.max(0, Math.min(img.h - s.h, s.y + p.y - d.y0))
      onCrop({ ...s, x: nx, y: ny })
      return
    }
    const fx = d.mode === 'nw' || d.mode === 'sw' ? s.x + s.w : s.x
    const fy = d.mode === 'nw' || d.mode === 'ne' ? s.y + s.h : s.y
    onCrop(norm(fx, fy, p.x, p.y))
  }
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    const r = box.current!.getBoundingClientRect()
    if (crop && (crop.w < (16 * img.w) / r.width || crop.h < (16 * img.h) / r.height)) onCrop(null)
    e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const pc = (v: number, tot: number) => `${(v / tot) * 100}%`
  return (
    <div className="relative mx-auto w-fit max-w-full select-none">
      <img src={img.url} alt={t('Screenshot caricato')} draggable={false} className="block max-h-[min(62vh,580px)] max-w-full rounded-xl" />
      <div ref={box} className={clsx('absolute inset-0 touch-none overflow-hidden rounded-xl', disabled ? 'cursor-default' : 'cursor-crosshair')}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {crop && (
          <div className="absolute cursor-move border border-accent shadow-[0_0_0_9999px_rgb(var(--c-bg)/0.58)]"
            style={{ left: pc(crop.x, img.w), top: pc(crop.y, img.h), width: pc(crop.w, img.w), height: pc(crop.h, img.h) }}>
            {(['nw', 'ne', 'sw', 'se'] as const).map((k) => (
              <span key={k} className={clsx('absolute h-2.5 w-2.5 rounded-[3px] border border-accent bg-surface',
                k[0] === 'n' ? '-top-[5px]' : '-bottom-[5px]', k[1] === 'w' ? '-left-[5px]' : '-right-[5px]',
                k === 'nw' || k === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize')} />
            ))}
            <span className="tnum absolute left-1 top-1 rounded bg-surface/85 px-1.5 py-0.5 text-2xs text-fg">
              {Math.round(crop.w)} × {Math.round(crop.h)} px
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ overlay delle candele rilevate
function ExtractionView({ img, ex, show }: { img: Img; ex: ImagePatternExtraction; show: boolean }) {
  const W = ex.image.width, H = ex.image.height
  return (
    <div className="relative mx-auto w-fit max-w-full">
      <img src={img.url} alt={t('Screenshot analizzato')} draggable={false}
        className={clsx('block max-h-[min(62vh,580px)] max-w-full rounded-xl transition-opacity', show ? 'opacity-50' : 'opacity-100')} />
      {show && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
          {(ex.crop.w < W || ex.crop.h < H) && (
            <rect x={ex.crop.x} y={ex.crop.y} width={ex.crop.w} height={ex.crop.h} fill="none" stroke={T.accent} strokeDasharray="6 4" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          )}
          {ex.boxes.map((b) => {
            const top = Math.min(b.y_open, b.y_close)
            const hgt = Math.max(1, Math.abs(b.y_open - b.y_close))
            const col = b.filled ? OVERLAY : T.fg2
            return (
              <g key={b.i}>
                <line x1={b.x} x2={b.x} y1={b.y_high} y2={b.y_low} stroke={col} strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeDasharray={b.filled ? undefined : '3 3'} />
                <rect x={b.x0} y={top} width={Math.max(1, b.x1 - b.x0)} height={hgt} fill={b.bull ? alpha(T.up, 0.25) : alpha(T.down, 0.25)}
                  stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={b.filled ? undefined : '3 3'} />
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

function Swatch({ color, label }: { color: string | null; label: string }) {
  if (!color) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
      <span className="h-3 w-3 rounded-[4px] ring-1 ring-inset ring-white/15" style={{ background: color }} />{label}
      <span className="tnum text-fg-4">{color.toUpperCase()}</span>
    </span>
  )
}

function ExtractionCard({ img, ex, timings }: { img: Img; ex: ImagePatternExtraction; timings: ImagePattern['timings'] }) {
  const [show, setShow] = useState(true)
  const ct = confTone(ex.confidence)
  return (
    <Card>
      <CardHeader title={t('Candele rilevate')} icon={<ScanEye />}
        subtitle={t('Verifica che i riquadri coincidano con le candele dello screenshot')}
        right={<>
          <Badge color={ct.color}>{ct.label} · {Math.round(ex.confidence)}%</Badge>
          <Toggle on={show} onClick={() => setShow(!show)}>{show ? <Eye size={ICON.chip} /> : <EyeOff size={ICON.chip} />} {t('Sovrapposizione')}</Toggle>
        </>} />
      <CardBody>
        <div className="grid gap-5 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-8"><ExtractionView img={img} ex={ex} show={show} /></div>
          <div className="flex min-w-0 flex-col gap-4 xl:col-span-4">
            <div className="dgrid grid-cols-2">
              <DCell label={t('Candele')} value={ex.candles} foot={ex.kind === 'line' ? t('Da grafico a linee') : ex.inserted ? t('{n} ricostruite', { n: ex.inserted }) : t('Tutte riconosciute')} />
              <DCell label={t('Qualità')} value={`${Math.round(ex.confidence)}%`} foot={ct.label} />
              <DCell label={t('Spaziatura regolare')} value={`${Math.round(ex.spacing_score)}%`} foot={t('Passo {p} px · corpo {b} px', { p: ex.pitch_px.toFixed(1), b: ex.body_px.toFixed(0) })} />
              <DCell label={t('Tema')} value={ex.theme === 'dark' ? t('Scuro') : t('Chiaro')} foot={ex.volume_excluded ? t('Volumi esclusi') : t('Nessun volume rilevato')} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <Swatch color={ex.colors.up} label={ex.kind === 'line' ? t('Linea') : t('Rialzo')} />
              <Swatch color={ex.colors.down} label={t('Ribasso')} />
              <Swatch color={ex.colors.background} label={t('Sfondo')} />
            </div>
            <div>
              <div className="label mb-1.5">{t('Figura estratta')}</div>
              <div className="h-14 tile px-2 py-1.5">
                <Sparkline data={ex.series.close} color={C.price} height={42} />
              </div>
            </div>
            {ex.warnings.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {ex.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-2 text-xs leading-relaxed text-fg-2">
                    <TriangleAlert size={ICON.inline} className="mt-0.5 shrink-0 text-warn" />{w}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-auto inline-flex items-center gap-1.5 text-xs text-fg-4">
              <Timer size={ICON.inline} /> {t('Estrazione {a} ms · ricerca {b} ms', { a: timings.extract_ms, b: timings.search_ms })}
            </p>
          </div>
        </div>
        {show && <div className="mt-3"><Legend items={[{ label: t('Candela rilevata (corpo e ombre)'), color: OVERLAY }, { label: t('Ricostruita per interpolazione'), color: T.fg2, dashed: true }]} /></div>}
      </CardBody>
    </Card>
  )
}

// ------------------------------------------------------------------ elenco analoghi
function MatchCard({ m, selected, onClick }: { m: ImagePatternMatch; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={clsx('flex h-full flex-col rounded-2xl border bg-surface p-4 text-left transition-colors', selected ? 'border-accent/60' : 'border-line hover:border-line-strong')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="tnum text-xs text-fg-3">#{m.rank}</span>
          <Badge color="slate">{tfLabel(m.tf)}</Badge>
        </div>
        <Change value={m.outcome.change} digits={1} className="text-sm" />
      </div>
      <div className="mt-1.5 truncate text-sm text-white">{plabel(m.period.label).replace(/ \(\w+\)$/, '')}</div>
      <div className="relative mt-2 min-h-10 flex-1"><Sparkline className="absolute inset-0 h-full" data={m.candles.map((c) => c.close)} color={selected ? C.accent : T.fg3} height={40} /></div>
      <div className="mt-2 flex items-center justify-between text-xs"><span className="text-fg-3">{t('Similarità')}</span><span className="tnum text-white">{m.similarity.toFixed(0)}%</span></div>
      <ProgressBar value={m.similarity} color={T.accent} className="mt-1 h-1" />
      <div className="mt-1.5 flex justify-between text-2xs text-fg-3"><span>{t('Grafica {n}%', { n: m.visual_similarity.toFixed(0) })}</span><span>{t('Struttura {n}%', { n: m.feature_similarity.toFixed(0) })}</span></div>
    </button>
  )
}

function OutcomeTable({ d, sel, onSelect }: { d: ImagePattern; sel: number; onSelect: (i: number) => void }) {
  const end = d.projection.median[d.projection.median.length - 1]
  const medChg = end != null && d.price_now ? (end / d.price_now - 1) * 100 : d.summary.median_outcome
  return (
    <div className="no-scrollbar overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>#</th><th>{t('Timeframe')}</th><th>{t('Periodo')}</th><th className="text-right">{t('Similarità')}</th>
            <th className="text-right">{t('Esito')}</th><th className="text-right">{t('Max rialzo')}</th><th className="text-right">{t('Max ribasso')}</th>
            <th className="text-right">{t('Se succedesse oggi')}</th>
          </tr>
        </thead>
        <tbody>
          {d.matches.map((m, i) => {
            const target = m.outcome.change != null ? d.price_now * (1 + m.outcome.change / 100) : null
            return (
              <tr key={`${m.tf}-${m.period.start}`} onClick={() => onSelect(i)} className={clsx('cursor-pointer', i === sel && '[&>td]:bg-accent/[0.06]')}>
                <td className="text-fg-3">{m.rank}</td>
                <td>{tfLabel(m.tf)}</td>
                <td className="text-white">{plabel(m.period.label).replace(/ \(\w+\)$/, '')}</td>
                <td className="text-right">{m.similarity.toFixed(0)}%</td>
                <td className="text-right"><Change value={m.outcome.change} digits={1} /></td>
                <td className="text-right"><Change value={m.outcome.max_up} digits={1} /></td>
                <td className="text-right"><Change value={m.outcome.max_down} digits={1} /></td>
                <td className="text-right text-fg">{target ? usd(target) : '—'}</td>
              </tr>
            )
          })}
          <tr>
            <td /><td className="text-fg-3" colSpan={2}>{t('Mediana di {n} analoghi', { n: d.summary.count })}</td><td />
            <td className="text-right font-semibold"><Change value={medChg} digits={1} /></td><td /><td />
            <td className="text-right font-semibold text-white">{end != null ? usd(end) : '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ risultati
function Results({ d, img }: { d: ImagePattern; img: Img }) {
  const [sel, setSel] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [layers, setLayers] = useState<ChartLayers>({ points: true, legs: true, patterns: true })
  useEffect(() => setSel(0), [d])
  const m = d.matches[Math.min(sel, d.matches.length - 1)]
  const w = m.window
  const cur = m.query_candles
  const anaWin = m.candles.slice(0, w)
  const anaAfter = m.candles.slice(w)
  // stesso timeframe dell'analogo selezionato (se almeno 2): percorsi di timeframe diversi hanno volatilità per candela diverse
  const future = useMemo(() => {
    const same = d.matches.filter((x) => x.tf === m.tf)
    const pool = same.length >= 2 ? same : d.matches
    return buildFuture(m, [m, ...pool.filter((x) => x !== m)], w, cur)
  }, [m, d.matches, w, cur])
  const [yMin, yMax] = pctRangeWithFuture(cur, [...anaWin, ...anaAfter], future)
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640
  const chartH = narrow ? 340 : 420
  const pl = plabel(m.period.label)
  const yr = whenYear(m.period.when)
  const target = m.outcome.change != null ? d.price_now * (1 + m.outcome.change / 100) : null
  const medEnd = d.projection.median[d.projection.median.length - 1]
  const medChg = medEnd != null && d.price_now ? (medEnd / d.price_now - 1) * 100 : null
  const best = d.matches[0]
  const imgLabel = t('Immagine')
  const pick = (i: number) => { setSel(i); document.getElementById('img-hero')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  return (
    <div className="flex flex-col gap-3">
      <ExtractionCard img={img} ex={d.extraction} timings={d.timings} />

      {/* ---------------- hero */}
      <Card>
        <CardBody className="scroll-mt-20 pt-4 sm:pt-5">
          <div id="img-hero" className="flex items-start gap-4 sm:gap-6">
            <div className="shrink-0">
              <div className="tnum text-3xl font-semibold text-white">{Math.round(m.similarity)}%</div>
              <div className="label">{t('Similarità')}</div>
            </div>
            <div className="min-w-0 max-w-[900px] flex-1">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <Badge>{t('Analogo #{n}', { n: m.rank })}</Badge>
                <Badge color="blue">{t('Timeframe {tf}', { tf: tfLabel(m.tf) })}</Badge>
                {m === best && <Badge color="btc"><Trophy size={12} /> {t('Migliore')}</Badge>}
              </div>
              <h2 className="text-lg font-semibold leading-snug tracking-tight text-white">
                {t('La figura dell\'immagine ({w} candele) somiglia a', { w })}{' '}
                <span className="text-white">{pl.replace(/ \(\w+\)$/, '')}</span>
                <span className="text-fg-3"> · {t('somiglianza grafica {n}%', { n: Math.round(m.visual_similarity) })}</span>
              </h2>
              <p className="mt-1.5 text-sm text-fg-2">{m.patterns.text}</p>
              <p className="mt-1 text-sm text-fg-3">
                {t('Complessiva')} <b className="text-fg">{m.similarity.toFixed(0)}%</b> {t('= 85% grafica + 15% struttura')}
                {' '}· {date(m.period.start)} → {date(m.period.end)}
              </p>
            </div>
          </div>
        </CardBody>
      </Card>
      <KpiStrip cols="grid-cols-2 lg:grid-cols-4">
        <KpiCell icon={<Target />} label={t('Mediana analoghi ({n})', { n: d.summary.count })} value={medChg != null ? pct(medChg, 1) : '—'}
          delta={medEnd != null ? <span className="text-fg">{usd(medEnd)}</span> : null} foot={t('Tra {n} candele', { n: d.horizon })}
          title={t('Mediana dei percorsi successivi di tutti gli analoghi, riportata al prezzo attuale di BTC.')} />
        <KpiCell icon={<Trophy />} label={t('Più simile')} value={`${Math.round(best.similarity)}%`} foot={`${tfLabel(best.tf)} · ${plabel(best.period.label).replace(/ \(\w+\)$/, '')}`} />
        <KpiCell icon={<Crosshair />} label={t('Analogo #{r} · dopo {n} candele', { r: m.rank, n: m.outcome.candles })} value={<Change value={m.outcome.change} digits={1} />}
          foot={target ? t('Se succedesse oggi: {p}', { p: usd(target) }) : t('Esito analogo')} />
        <KpiCell icon={<Gauge />} label={t('Estrazione')} value={`${Math.round(d.extraction.confidence)}%`} foot={t('{n} candele · {tf} timeframe', { n: d.extraction.candles, tf: d.tfs.length })} />
      </KpiStrip>

      {/* ---------------- confronto grafico */}
      <Card>
        <CardHeader title={t('Confronto grafico')} icon={<GitCompareArrows />}
          subtitle={t('Figura dell\'immagine riportata al prezzo attuale vs periodo storico · stessa scala in %')}
          right={<>
            <Toggle on={layers.legs} onClick={() => setLayers({ ...layers, legs: !layers.legs })}>{t('Gambe')}</Toggle>
            <Toggle on={layers.patterns} onClick={() => setLayers({ ...layers, patterns: !layers.patterns })}>{t('Figure')}</Toggle>
            <Toggle on={layers.points} onClick={() => setLayers({ ...layers, points: !layers.points })}>{t('Punti')}</Toggle>
          </>} />
        <CardBody>
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium text-white"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-accent" />{t('Figura dall\'immagine')} · {tfLabel(m.tf)}</span>
                <span className="tnum text-fg-2">{usd(d.price_now)}</span>
              </div>
              <PatternBadges patterns={m.patterns.current} />
              <AnalogCandles candles={cur} future={future} points={m.mapping} side="current" tf={m.tf} yMin={yMin} yMax={yMax} active={hover} accent={C.accent}
                height={chartH} legs={m.legs_current} patterns={m.patterns.current} layers={layers} compact={narrow} />
            </div>
            <div className="min-w-0">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium text-white"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-fg-3" />{t('Analogo')} · {pl}</span>
                <span className="tnum text-fg-2">{usd(anaWin[anaWin.length - 1]?.close)}</span>
              </div>
              <PatternBadges patterns={m.patterns.analog} />
              <AnalogCandles candles={anaWin} after={anaAfter} outcome={m.outcome.change} points={m.mapping} side="analog" tf={m.tf} yMin={yMin} yMax={yMax} active={hover} accent={C.accent}
                height={chartH} legs={m.legs_analog} patterns={m.patterns.analog} layers={layers} compact={narrow} />
            </div>
          </div>
          <div className="mt-4">
            <div className="label mb-1.5">{t('Cosa è successo dopo')} · {pl}</div>
            <div className="dgrid grid-cols-2 md:grid-cols-4">
              <DCell label={t('Esito a {n} candele', { n: m.outcome.candles })} value={<Change value={m.outcome.change} digits={1} />} foot={t('Dalla fine della figura')} />
              <DCell label={t('Massimo rialzo')} value={<Change value={m.outcome.max_up} digits={1} />} foot={t('Picco nella continuazione')} />
              <DCell label={t('Massimo ribasso')} value={<Change value={m.outcome.max_down} digits={1} />} foot={t('Minimo nella continuazione')} />
              <DCell label={t('Se succedesse oggi')} value={target ? usd(target) : '—'} foot={t('Da {p}', { p: usd(d.price_now) })} />
            </div>
          </div>
          <div className="mt-3">
            <Legend items={[
              ...(future ? [
                { label: t('Mediana analoghi ({n})', { n: future.n }), color: C.primary },
                ...(future.p25 ? [{ label: t('Banda P25–P75 analoghi'), color: alpha(T.accent, 0.55) }] : []),
                ...(future.sel ? [{ label: t('Analogo selezionato · {x}', { x: pl }), color: C.grey, dashed: true }] : []),
              ] : []),
              { label: t('Gambe ZigZag (G1, G2…)'), color: LEG_COLOR },
              { label: t('Resistenza'), color: LINE_STYLE.resistance.color, dashed: true },
              { label: t('Supporto'), color: LINE_STYLE.support.color, dashed: true },
            ]} />
          </div>
        </CardBody>
      </Card>

      {/* ---------------- somiglianza + gambe */}
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-5">
          <CardHeader title={t('Somiglianza grafica')} icon={<ScanSearch />} subtitle={t('Componenti visive e relativo peso (85% del punteggio)')}
            right={<span className="text-xs text-fg-3">{t('Totale')} <b className="tnum text-lg font-semibold text-white">{Math.round(m.visual_similarity)}%</b></span>} />
          <CardBody><VisualBreakdown components={m.visual.components} /></CardBody>
        </Card>
        <Card className="flex flex-col xl:col-span-7 xl:h-0 xl:min-h-full">
          <CardHeader title={t('Gamba per gamba')} icon={<Spline />} subtitle={t('Movimenti ZigZag allineati · immagine vs {y}', { y: yr })} />
          <CardBody className="flex min-h-0 flex-1 flex-col px-2">
            <div className="min-h-0 shrink overflow-y-auto"><LegTable pairs={m.leg_pairs} cur={m.legs_current} ana={m.legs_analog} when={m.period.when} curLabel={imgLabel} /></div>
            <p className="mt-2 px-3 text-xs text-fg-4">{t('Le variazioni della figura sono stimate: escursione calibrata a {r} sul timeframe {tf}.', { r: pct(m.scale_range, 1), tf: tfLabel(m.tf) })}</p>
            <LegBars className="mt-4 flex-1 px-3" pairs={m.leg_pairs} cur={m.legs_current} ana={m.legs_analog} when={m.period.when} curLabel={imgLabel} />
          </CardBody>
        </Card>
      </div>

      {/* < 2xl both span the width (points in two columns, narrative in two text columns); ≥ 2xl side by side */}
      <div className="grid gap-3 2xl:grid-cols-12">
        <Card className="2xl:col-span-8">
          <CardHeader title={t('Punti strutturali allineati')} icon={<ListChecks />} subtitle={t('{a} su {b} con lo stesso ruolo nei due grafici', { a: m.mapping.filter((p) => p.same_role).length, b: m.mapping.length })} />
          <CardBody><MappingList twoFrom="xl" mapping={m.mapping} tf={m.tf} when={m.period.when} active={hover} onHover={setHover} curLabel={imgLabel} /></CardBody>
        </Card>
        <Card className="2xl:col-span-4">
          <CardHeader title={t('Perché si somigliano')} icon={<MessageSquareText />} />
          <CardBody className="gap-x-8 text-sm leading-relaxed text-fg-2 lg:columns-2 2xl:columns-1">
            {m.narrative.map((s, i) => <p key={i} className="mb-2.5 break-inside-avoid last:mb-0">{s}</p>)}
          </CardBody>
        </Card>
      </div>

      {/* ---------------- esiti di tutti gli analoghi + timeframe */}
      <div className="grid gap-3 xl:grid-cols-12">
        <Card className="xl:col-span-9">
          <CardHeader title={t('Cosa è successo dopo')} icon={<Layers />} subtitle={t('Tutti gli analoghi, su ogni timeframe · {n} candele successive', { n: d.horizon })}
            right={<ToneBadge tone={d.summary.bias} />} />
          <CardBody className="px-2">
            <OutcomeTable d={d} sel={sel} onSelect={pick} />
            <p className="mt-3 px-3 text-sm text-fg-2">{d.summary.text}</p>
          </CardBody>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader title={t('Per timeframe')} icon={<Timer />} subtitle={t('Miglior somiglianza su ciascun timeframe')} />
          <CardBody className="flex flex-col justify-around">
            {d.per_tf.map((p) => {
              const idx = d.matches.findIndex((x) => x.tf === p.tf)
              return (
                <button key={p.tf} disabled={idx < 0} onClick={() => idx >= 0 && pick(idx)}
                  className="flex items-center justify-between gap-3 border-t border-line py-2.5 text-left first:border-t-0 first:pt-0 disabled:cursor-default">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">{tfLabel(p.tf)}</div>
                    <div className="truncate text-xs text-fg-3">{p.best_period ? plabel(p.best_period).replace(/ \(\w+\)$/, '') : p.note ?? t('Nessun risultato')}</div>
                  </div>
                  <span className="tnum text-lg font-semibold text-white">{p.best_similarity != null ? `${Math.round(p.best_similarity)}%` : '—'}</span>
                </button>
              )
            })}
          </CardBody>
        </Card>
      </div>

      {/* ---------------- altri analoghi */}
      <div>
        <h2 className="mb-3 text-lg font-semibold leading-7 tracking-tight text-white">{t('Tutti gli analoghi')} <span className="text-xs font-normal text-fg-3">· {t('clicca per confrontare')}</span></h2>
        <div className={MATCH_GRID} style={balancedCols(d.matches.length, 4, 8)}>
          {d.matches.map((mm, i) => <MatchCard key={`${mm.tf}-${mm.period.start}`} m={mm} selected={i === sel} onClick={() => pick(i)} />)}
        </div>
      </div>

      <MethodNote>
        <p>{d.method} {t('Gli analoghi descrivono precedenti storici, non garantiscono esiti futuri.')}</p>
        <p>{t('Proiezione = mediana dei percorsi successivi di tutti gli analoghi (ognuno normalizzato sulla fine della propria finestra) riportata al prezzo attuale di BTC: è lo scenario "se la figura si completasse oggi".')}</p>
      </MethodNote>
    </div>
  )
}

// ------------------------------------------------------------------ scheda
export function ImagePatternTab() {
  const [img, setImg] = useState<Img | null>(null)
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [tfs, setTfs] = useState<AnalogTf[]>(ALL_TFS)
  const [theme, setTheme] = useState<ImageTheme>('auto')
  const [top, setTop] = useState(5)
  const [fileErr, setFileErr] = useState<string | null>(null)
  const mut = useImagePattern()
  const reset = mut.reset
  const resultImg = useRef<Img | null>(null)

  const onFile = useCallback(async (f: Blob, name: string) => {
    const err = validate(f)
    if (err) { setFileErr(err); return }
    try {
      const im = await loadImage(f, name)
      setFileErr(null)
      setImg((prev) => { if (prev && prev !== resultImg.current) URL.revokeObjectURL(prev.url); return im })
      setCrop(null)
      reset()
    } catch (e) {
      setFileErr(e instanceof Error ? e.message : t('Immagine non leggibile.'))
    }
  }, [reset])

  // Ctrl+V: incolla uno screenshot dagli appunti
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of Array.from(items)) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) { e.preventDefault(); onFile(f, f.name || 'screenshot.png') }
          return
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [onFile])
  useEffect(() => () => { if (img) URL.revokeObjectURL(img.url) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const run = () => {
    if (!img) return
    resultImg.current = img
    mut.mutate({ file: img.file, crop, tfs, top, theme })
  }
  const clear = () => { if (img) URL.revokeObjectURL(img.url); setImg(null); setCrop(null); mut.reset() }
  const busy = mut.isPending
  const hasResult = !!mut.data && resultImg.current === img

  if (!img) {
    return (
      <Card>
        <CardHeader title={t('Cerca un pattern da immagine')} icon={<ImagePlus />} subtitle={t('Carica uno screenshot: le candele vengono riconosciute e confrontate con tutta la storia di BTC')} />
        <CardBody><Dropzone onFile={onFile} error={fileErr} /></CardBody>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title={t('Screenshot')} icon={<Crop />}
          subtitle={crop ? t('Area selezionata: {w} × {h} px · trascina per spostarla o ridimensionarla', { w: Math.round(crop.w), h: Math.round(crop.h) })
            : t('Trascina sull\'immagine per selezionare solo il tratto di grafico che ti interessa')}
          right={<>
            {crop && <button className="btn-ghost" onClick={() => setCrop(null)}><RotateCcw size={ICON.chip} /> {t('Tutta l\'immagine')}</button>}
            <button className="btn-ghost" onClick={clear}><X size={ICON.chip} /> {t('Rimuovi')}</button>
          </>} />
        <CardBody>
          <div className="grid gap-5 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-8">
              <CropView img={img} crop={crop} onCrop={setCrop} disabled={busy} />
              <p className="mt-2 truncate text-center text-xs text-fg-4">{img.name} · {img.w} × {img.h} px</p>
            </div>
            <div className="flex min-w-0 flex-col gap-5 xl:col-span-4">
              <div className="flex flex-col gap-2">
                <span className="label">{t('Timeframe da confrontare')}</span>
                <TfChips value={tfs} onChange={setTfs} />
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-4">
                <div className="flex flex-col gap-2">
                  <span className="label">{t('Sfondo')}</span>
                  <Segmented value={theme} onChange={setTheme} options={[{ value: 'auto', label: t('Auto') }, { value: 'dark', label: t('Scuro') }, { value: 'light', label: t('Chiaro') }]} />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="label">{t('Risultati')}</span>
                  <Segmented value={top} onChange={setTop} options={[3, 5, 8].map((v) => ({ value: v, label: String(v) }))} />
                </div>
              </div>
              <button className="btn-primary h-10 justify-center text-sm" onClick={run} disabled={busy}>
                <ScanSearch size={16} /> {busy ? t('Analisi in corso…') : hasResult ? t('Ripeti la ricerca') : t('Cerca pattern')}
              </button>
              <Dropzone onFile={onFile} error={fileErr} compact className="xl:flex-1" />
            </div>
          </div>
        </CardBody>
      </Card>

      {busy && (
        <div className="grid gap-3">
          <Card><CardBody className="flex items-center gap-3 pt-5 text-sm text-fg-2"><ScanEye size={16} className="animate-pulse text-accent" /> {t('Riconoscimento delle candele e ricerca nello storico di BTC su {n} timeframe…', { n: tfs.length })}</CardBody></Card>
          <Skeleton className="h-44" /><Skeleton className="h-[380px]" />
        </div>
      )}
      {!busy && mut.isError && (
        <Card>
          <CardBody className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-warn/10 text-warn"><TriangleAlert size={18} /></span>
            <p className="text-sm font-medium text-fg">{t('Pattern non estratto')}</p>
            <p className="max-w-md text-sm text-fg-3">{errText(mut.error)}</p>
            <button className="btn-ghost mt-1" onClick={run}><RotateCcw size={ICON.chip} /> {t('Riprova')}</button>
          </CardBody>
        </Card>
      )}
      {!busy && hasResult && mut.data && (mut.data.matches.length
        ? <Results d={mut.data} img={img} />
        : <Card><CardBody className="py-10 text-center text-sm text-fg-3">{t('Nessun periodo storico simile trovato: prova con un\'altra selezione.')}</CardBody></Card>)}
      {!busy && !mut.data && !mut.isError && (
        <p className="px-1 text-center text-sm text-fg-4">{t('Seleziona l\'area (facoltativo), scegli i timeframe e premi «Cerca pattern».')}</p>
      )}
    </div>
  )
}
