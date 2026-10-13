/*
 * Diario: snapshot del contesto, confronto allora/ora, editor delle note, card della timeline.
 * Lo snapshot arriva come codici + numeri: le etichette sono tradotte qui (IT/EN).
 */
import { useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Bold, ChevronDown, Eye, Italic, List, NotebookPen, Pencil, Tag as TagIcon, X } from 'lucide-react'
import { useJournalMutations, useSnapshotPreview, type Horizon, type Note, type NoteInput, type Snapshot, type ViewDir } from '../api/journal'
import { ApiError } from '../api/client'
import { Badge, Segmented, Skeleton, clsx } from '../components/ui'
import { cap, t, tfLabel } from '../i18n'
import { compact, date, dateTime, dayUnit, int, pct, pts, usd, PHASE_LABEL } from '../lib/format'
import { DeleteButton, Field, INPUT, Modal } from './forms'
import { ZONE_LABEL } from './alertRules'

// ------------------------------------------------------------------ labels
export const VIEW_META: Record<ViewDir, { label: string; icon: typeof ArrowUpRight; tone: 'bullish' | 'bearish' | 'neutral' }> = {
  up: { label: 'Rialzo', icon: ArrowUpRight, tone: 'bullish' },
  down: { label: 'Ribasso', icon: ArrowDownRight, tone: 'bearish' },
  neutral: { label: 'Neutrale', icon: ArrowRight, tone: 'neutral' },
}
const OUTCOME_LABEL: Record<string, string> = { up: 'Rialzo', down: 'Ribasso', flat: 'Laterale' }
export const outcomeLabel = (o: string) => t(OUTCOME_LABEL[o] ?? o)
export const STRUCT_STATE: Record<string, string> = {
  accepted_above: 'Accettazione sopra il range',
  retest_held_above: 'Retest del massimo tenuto',
  accepted_below: 'Accettazione sotto il range',
  retest_held_below: 'Retest del minimo perso',
  above_unconfirmed: 'Sopra il range, accettazione da confermare',
  below_unconfirmed: 'Sotto il range, accettazione da confermare',
  inside: 'Dentro il range',
  inside_after_sweep_low: 'Dentro il range dopo uno sweep del minimo',
  inside_after_sweep_high: 'Dentro il range dopo uno sweep del massimo',
  inside_after_failed_breakout: 'Rientrato nel range dopo una rottura fallita',
}
const EXPECTED: Record<string, string> = {
  rialzo: 'Rialzo', ribasso: 'Ribasso', inversione_rialzista: 'Inversione al rialzo', inversione_ribassista: 'Inversione al ribasso',
  inversione: 'Possibile inversione', volatilita: 'Volatilità',
}
const BIAS: Record<string, string> = { bullish: 'Rialzista', bearish: 'Ribassista', neutral: 'Neutrale' }
const fngLabel = (v: number) => t(v < 25 ? 'Paura estrema' : v < 45 ? 'Paura' : v <= 55 ? 'Neutrale' : v <= 75 ? 'Avidità' : 'Avidità estrema')
/** "Pivot settimanale R1" / "Zona di supporto (2 tocchi)" → translated source label of a key level */
export function levelSource(src: string): string {
  const m = /^(Zona di (?:supporto|resistenza)) \((\d+) tocchi\)$/.exec(src)
  if (m) return t('{z} ({n} tocchi)', { z: t(m[1]), n: m[2] })
  const p = /^(Pivot (?:settimanale|mensile))(?: (\w+))?$/.exec(src)
  if (p) return `${t(p[1])}${p[2] ? ` ${p[2]}` : ''}`
  return t(src)
}

// ------------------------------------------------------------------ snapshot viewer
type Row = { k: string; label: ReactNode; v: ReactNode; sub?: ReactNode }

function snapshotRows(s: Snapshot): Row[] {
  const r: Row[] = []
  r.push({ k: 'price', label: t('Prezzo'), v: usd(s.price) })
  if (s.cycle) {
    r.push({ k: 'phase', label: t('Fase del ciclo'), v: s.cycle.phase ? PHASE_LABEL[s.cycle.phase] ?? s.cycle.phase : '—', sub: s.cycle.phase_confidence != null ? t('affidabilità {x}', { x: pct(s.cycle.phase_confidence, 0, false) }) : undefined })
    r.push({ k: 'score', label: 'Cycle Score', v: s.cycle.score != null ? `${s.cycle.score.toFixed(0)}/100` : '—', sub: s.cycle.zone ? t(ZONE_LABEL[s.cycle.zone] ?? s.cycle.zone) : undefined })
  }
  if (s.structure) {
    r.push({ k: 'structure', label: t('Struttura {tf}', { tf: tfLabel('1d') }), v: s.structure.state ? cap(t(STRUCT_STATE[s.structure.state] ?? s.structure.state)) : t('Nessun range'),
      sub: s.structure.range_low != null ? `${t('Range')} ${usd(s.structure.range_low)} – ${usd(s.structure.range_high)}` : undefined })
  }
  const r1 = s.levels?.find((l) => l.tag === 'R1'), s1 = s.levels?.find((l) => l.tag === 'S1')
  if (r1 || s1) r.push({ k: 'levels', label: t('Livelli chiave'), v: <span>{r1 ? `R1 ${usd(r1.price)}` : ''}{r1 && s1 ? ' · ' : ''}{s1 ? `S1 ${usd(s1.price)}` : ''}</span>, sub: r1 ? levelSource(r1.source) : undefined })
  if (s.analogs) r.push({ k: 'analogs', label: t('Analoghi storici'), v: s.analogs.bias ? t(BIAS[s.analogs.bias] ?? s.analogs.bias) : '—',
    sub: s.analogs.median_outcome != null ? t('mediana {x} a {h}', { x: pct(s.analogs.median_outcome, 1), h: `${s.analogs.horizon ?? '—'} ${dayUnit()}` }) : undefined })
  if (s.fractals) r.push({ k: 'fractals', label: t('Frattali'), v: s.fractals.bias ? t(BIAS[s.fractals.bias] ?? s.fractals.bias) : '—',
    sub: s.fractals.up_prob != null ? t('prob. rialzo {x}', { x: pct(s.fractals.up_prob, 0, false) }) : undefined })
  r.push({ k: 'forecast', label: t('Previsione mediana a 30 giorni'), v: s.forecast?.median_30d != null ? usd(s.forecast.median_30d) : '—',
    sub: s.forecast?.median_30d != null && s.price ? pct((s.forecast.median_30d / s.price - 1) * 100, 1) : s.forecast ? undefined : t('modello non pronto') })
  if (s.derivatives) r.push({ k: 'funding', label: 'Funding', v: s.derivatives.funding != null ? `${pct(s.derivatives.funding, 4)} / 8h` : '—',
    sub: s.derivatives.oi_usd != null ? `OI $${compact(s.derivatives.oi_usd, 2)}` : undefined })
  if (s.sentiment) r.push({ k: 'fng', label: 'Fear & Greed', v: `${s.sentiment.value.toFixed(0)}/100`, sub: fngLabel(s.sentiment.value) })
  if (s.usdt) r.push({ k: 'usdt', label: 'USDT dominance', v: s.usdt.usdt_d != null ? pct(s.usdt.usdt_d, 2, false) : '—', sub: s.usdt.change_7d != null ? t('{x} in 7 giorni', { x: pts(s.usdt.change_7d, 2) }) : undefined })
  const tp = s.timepivots ?? []
  r.push({ k: 'tp', label: t('Pivot temporali'), v: tp.length ? t('{n} finestre', { n: tp.length }) : t('Nessuna'),
    sub: tp[0] ? `${t(EXPECTED[tp[0].expected ?? ''] ?? tp[0].expected ?? '')} · ${date(tp[0].start, false)}–${date(tp[0].end, false)} · ${int(tp[0].confluence)}/100` : undefined })
  return r
}

export function SnapshotGrid({ s, cols = 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4' }: { s: Snapshot; cols?: string }) {
  return (
    <div className={clsx('dgrid rounded-xl', cols)}>
      {snapshotRows(s).map((row) => (
        <div key={row.k} className="min-w-0 px-3 py-2.5">
          <div className="label truncate">{row.label}</div>
          <div className="tnum mt-0.5 truncate text-sm font-medium text-white" title={typeof row.v === 'string' ? row.v : undefined}>{row.v}</div>
          <div className="tnum truncate text-2xs text-slate-400" title={typeof row.sub === 'string' ? row.sub : undefined}>{row.sub ?? '—'}</div>
        </div>
      ))}
    </div>
  )
}

/** "Allora vs ora": the context saved with the note next to the one recorded at review time. */
export function ContextCompare({ then, now }: { then: Snapshot; now: Snapshot }) {
  const a = snapshotRows(then), b = new Map(snapshotRows(now).map((r) => [r.k, r]))
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead><tr><th className="pl-0">{t('Contesto')}</th><th>{t('Alla creazione')}</th><th>{t('Alla revisione')}</th></tr></thead>
        <tbody>
          {a.filter((r) => r.k !== 'forecast').map((r) => {
            const n = b.get(r.k)
            return (
              <tr key={r.k}>
                <td className="pl-0 text-slate-400">{r.label}</td>
                <td className="text-white">{r.v}{r.sub && <span className="ml-1.5 text-2xs text-slate-500">{r.sub}</span>}</td>
                <td className="text-white">{n?.v ?? '—'}{n?.sub && <span className="ml-1.5 text-2xs text-slate-500">{n.sub}</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ markdown-light
export function NoteBody({ text, clamp }: { text: string; clamp?: boolean }) {
  return (
    <div className={clsx('md text-sm text-slate-300 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', clamp && 'line-clamp-4')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>, img: () => null }}>{text}</ReactMarkdown>
    </div>
  )
}

// ------------------------------------------------------------------ editor
export function NoteEditor({ note, onClose, onSaved }: { note?: Note | null; onClose: () => void; onSaved?: (n: Note) => void }) {
  const editing = !!note
  const { create, update } = useJournalMutations()
  const [d, setD] = useState<NoteInput>(() => ({
    title: note?.title ?? '', body: note?.body ?? '', tags: note?.tags ?? [], direction: note?.direction ?? null, horizon: note?.horizon ?? null,
  }))
  const [tagText, setTagText] = useState('')
  const [preview, setPreview] = useState(false)
  const [tried, setTried] = useState(false)
  const snap = useSnapshotPreview(!editing)
  const viewLocked = editing && !note!.view_editable
  const empty = !d.title.trim() && !d.body.trim()
  const viewErr = (d.direction == null) !== (d.horizon == null)
  const addTag = (raw: string) => {
    const parts = raw.split(/[,\s]+/).map((x) => x.trim().replace(/^#/, '').toLowerCase().slice(0, 24)).filter(Boolean)
    if (parts.length) setD((x) => ({ ...x, tags: [...new Set([...x.tags, ...parts])].slice(0, 12) }))
    setTagText('')
  }
  const wrap = (before: string, after = before) => {
    const el = document.getElementById('note-body') as HTMLTextAreaElement | null
    if (!el) return
    const { selectionStart: a, selectionEnd: b, value } = el
    const sel = value.slice(a, b) || t('testo')
    const next = value.slice(0, a) + before + sel + after + value.slice(b)
    setD((x) => ({ ...x, body: next }))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + before.length, a + before.length + sel.length) })
  }
  const listify = () => {
    const el = document.getElementById('note-body') as HTMLTextAreaElement | null
    const v = d.body
    const a = el?.selectionStart ?? v.length
    const lineStart = v.lastIndexOf('\n', a - 1) + 1
    setD((x) => ({ ...x, body: v.slice(0, lineStart) + '- ' + v.slice(lineStart) }))
  }
  const save = async () => {
    setTried(true)
    const pendingTag = tagText.trim()
    const body = { ...d, tags: pendingTag ? [...new Set([...d.tags, ...pendingTag.split(/[,\s]+/).map((x) => x.replace(/^#/, '').toLowerCase()).filter(Boolean)])] : d.tags }
    if (empty || viewErr) return
    try {
      const n = editing ? await update.mutateAsync({ id: note!.id, n: body }) : await create.mutateAsync(body)
      onSaved?.(n)
      onClose()
    } catch { /* shown below */ }
  }
  const err = (create.error ?? update.error) as ApiError | null
  return (
    <Modal title={editing ? t('Modifica nota') : t('Nuova nota')} icon={<NotebookPen />} accent="violet" wide onClose={onClose}
      subtitle={editing ? t('Creata il {d}', { d: dateTime(note!.created_at) }) : t('Il contesto di mercato viene salvato automaticamente con la nota')}
      footer={
        <>
          {err && <span className="mr-auto max-w-full truncate text-xs text-down" title={err.message}>{t('Salvataggio non riuscito: {e}', { e: err.message })}</span>}
          {tried && empty && !err && <span className="mr-auto text-xs text-down">{t('Scrivi almeno un titolo o un testo')}</span>}
          <button className="btn-ghost" onClick={onClose}>{t('Annulla')}</button>
          <button className="btn-primary" onClick={save} disabled={create.isPending || update.isPending}>
            {create.isPending ? t('Salvataggio del contesto…') : editing ? t('Salva modifiche') : t('Salva nota')}
          </button>
        </>
      }>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label={t('Titolo')} hint={t('Facoltativo')}>
            <input value={d.title} maxLength={120} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} className={INPUT} placeholder={t('Es. Tesi: rientro nel range dopo lo sweep')} />
          </Field>
          <Field label={t('Nota')} group aside={t('Markdown: **grassetto**, *corsivo*, elenchi')}>
            <div className={clsx('overflow-hidden rounded-[10px] border bg-white/[0.03] transition-colors focus-within:border-accent-blue/60', tried && empty ? 'border-down/60' : 'border-white/[0.08]')}>
              <div className="flex items-center gap-1 border-b border-white/[0.06] px-1.5 py-1">
                <ToolBtn label={t('Grassetto')} onClick={() => wrap('**')} disabled={preview}><Bold size={13} /></ToolBtn>
                <ToolBtn label={t('Corsivo')} onClick={() => wrap('*')} disabled={preview}><Italic size={13} /></ToolBtn>
                <ToolBtn label={t('Elenco')} onClick={listify} disabled={preview}><List size={13} /></ToolBtn>
                <span className="ml-auto" />
                <ToolBtn label={preview ? t('Modifica') : t('Anteprima')} onClick={() => setPreview((p) => !p)} active={preview}>{preview ? <Pencil size={13} /> : <Eye size={13} />}</ToolBtn>
              </div>
              {preview
                ? <div className="min-h-[180px] px-3 py-2.5">{d.body.trim() ? <NoteBody text={d.body} /> : <p className="text-sm text-slate-500">{t('Niente da mostrare.')}</p>}</div>
                : <textarea id="note-body" value={d.body} maxLength={20000} onChange={(e) => setD((x) => ({ ...x, body: e.target.value }))} rows={8}
                    className="block min-h-[180px] w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed text-white placeholder:text-slate-500 focus:outline-none"
                    placeholder={t('Cosa osservi? Quali livelli contano? Cosa invaliderebbe l’idea?')} />}
            </div>
          </Field>
          <Field label={t('Tag')} group hint={t('Invio o virgola per aggiungere')}>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-2 py-1 focus-within:border-accent-blue/60">
              {d.tags.map((tg) => (
                <span key={tg} className="inline-flex h-6 items-center gap-1 rounded-md bg-white/[0.06] pl-2 pr-1 text-xs text-slate-200">
                  #{tg}
                  <button type="button" aria-label={t('Rimuovi tag {t}', { t: tg })} onClick={() => setD((x) => ({ ...x, tags: x.tags.filter((z) => z !== tg) }))} className="grid h-4 w-4 place-items-center rounded text-slate-400 hover:text-white"><X size={11} /></button>
                </span>
              ))}
              <input value={tagText} onChange={(e) => { const v = e.target.value; if (/[,\n]/.test(v)) addTag(v); else setTagText(v) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagText) } else if (e.key === 'Backspace' && !tagText && d.tags.length) setD((x) => ({ ...x, tags: x.tags.slice(0, -1) })) }}
                onBlur={() => tagText && addTag(tagText)} aria-label={t('Nuovo tag')}
                className="h-7 min-w-[100px] flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none" placeholder={d.tags.length ? '' : t('es. struttura, ciclo')} />
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('La tua vista')} group error={tried && viewErr ? t('Indica vista e orizzonte insieme') : null}
              hint={viewLocked ? t('Bloccata 15 minuti dopo la creazione') : t('Facoltativa: verrà verificata alla scadenza')}>
              <Segmented value={d.direction ?? 'none'} onChange={(v) => !viewLocked && setD((x) => ({ ...x, direction: v === 'none' ? null : (v as ViewDir), horizon: v === 'none' ? null : x.horizon ?? 30 }))}
                options={[{ value: 'none', label: t('Nessuna') }, ...(['up', 'down', 'neutral'] as ViewDir[]).map((v) => ({ value: v, label: t(VIEW_META[v].label) }))]} />
            </Field>
            <Field label={t('Orizzonte')} group>
              <Segmented value={d.horizon ?? 0} onChange={(v) => !viewLocked && d.direction && setD((x) => ({ ...x, horizon: v as Horizon }))}
                options={([7, 30, 90] as Horizon[]).map((h) => ({ value: h, label: `${h} ${t('giorni')}` }))} className={clsx(!d.direction && 'opacity-40')} />
            </Field>
          </div>
        </div>
        <aside className="flex min-w-0 flex-col gap-2.5 lg:border-l lg:border-white/[0.06] lg:pl-5">
          <div className="label">{editing ? t('Contesto salvato') : t('Contesto che verrà salvato')}</div>
          {editing
            ? <SnapshotGrid s={note!.snapshot} cols="grid-cols-2" />
            : snap.data ? <SnapshotGrid s={snap.data} cols="grid-cols-2" /> : snap.isError ? <p className="text-xs text-slate-400">{t('Anteprima non disponibile: il contesto verrà comunque calcolato al salvataggio.')}</p> : <Skeleton className="h-[360px]" />}
          {d.direction && <p className="text-xs leading-relaxed text-slate-400">{t('Alla scadenza il diario confronta il prezzo con quello di oggi: banda neutra ±2% a 7 giorni, ±4% a 30, ±8% a 90.')}</p>}
        </aside>
      </div>
    </Modal>
  )
}

function ToolBtn({ label, onClick, children, active, disabled }: { label: string; onClick: () => void; children: ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} disabled={disabled} aria-pressed={active}
      className={clsx('grid h-7 w-7 place-items-center rounded-md transition-colors disabled:opacity-30', active ? 'bg-white/[0.08] text-white' : 'text-slate-400 hover:bg-white/[0.05] hover:text-white')}>
      {children}
    </button>
  )
}

// ------------------------------------------------------------------ timeline card
export function ViewBadge({ dir, horizon }: { dir: ViewDir; horizon: number | null }) {
  const M = VIEW_META[dir]
  const cls = M.tone === 'bullish' ? 'text-up bg-up/10 ring-up/20' : M.tone === 'bearish' ? 'text-down bg-down/10 ring-down/20' : 'text-slate-300 bg-white/[0.05] ring-white/10'
  return (
    <span className={clsx('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-2xs font-medium ring-1 ring-inset', cls)}>
      <M.icon size={12} />{t(M.label)}{horizon ? ` · ${horizon} ${dayUnit()}` : ''}
    </span>
  )
}

export function OutcomeBadge({ note }: { note: Note }) {
  if (!note.direction) return null
  if (!note.review) return <Badge>{t('In attesa')}{note.due_at ? ` · ${date(note.due_at, false)}` : ''}</Badge>
  return note.review.hit ? <Badge color="up">{t('Vista confermata')}</Badge> : <Badge color="down">{t('Vista non confermata')}</Badge>
}

export function NoteCard({ note, onEdit, open, onToggle, highlight }: { note: Note; onEdit: () => void; open: boolean; onToggle: () => void; highlight?: boolean }) {
  const { remove } = useJournalMutations()
  const rv = note.review
  const s = note.snapshot
  const [expanded, setExpanded] = useState(false)
  const long = note.body.length > 380 || note.body.split('\n').length > 5
  useEffect(() => { if (highlight) document.getElementById(`note-${note.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [highlight, note.id])
  return (
    <article id={`note-${note.id}`} className={clsx('card relative min-w-0 px-4 py-3.5 sm:px-5', highlight && 'ring-1 ring-accent-blue/40')}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <div className="tnum flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-slate-500">
            <span>{dateTime(note.created_at)}</span>
            {note.price != null && <><span>·</span><span>BTC {usd(note.price)}</span></>}
            {note.updated_at - note.created_at > 60 && <><span>·</span><span>{t('modificata')}</span></>}
          </div>
          <h3 className="mt-0.5 text-[15px] font-semibold leading-snug text-white">{note.title || t('Nota del {d}', { d: date(note.created_at) })}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {note.direction && <ViewBadge dir={note.direction} horizon={note.horizon} />}
          <OutcomeBadge note={note} />
        </div>
      </div>
      {note.body && (
        <div className="mt-2">
          <NoteBody text={note.body} clamp={long && !expanded} />
          {long && <button className="link mt-1" onClick={() => setExpanded((e) => !e)}>{expanded ? t('Mostra meno') : t('Mostra tutto')}</button>}
        </div>
      )}
      {rv && (
        <div className="tnum mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-white/[0.025] px-3 py-2 text-xs ring-1 ring-inset ring-white/[0.06]">
          <span className="text-slate-400">{t('Esito a {h} giorni', { h: note.horizon })}</span>
          <span className="text-slate-300">{usd(rv.price_start)} → <b className="font-medium text-white">{usd(rv.price_end)}</b></span>
          <span className={rv.change_pct >= 0 ? 'font-medium text-up' : 'font-medium text-down'}>{pct(rv.change_pct, 1)}</span>
          <span className="text-slate-400">{t('Esito')}: <span className="text-slate-200">{outcomeLabel(rv.outcome)}</span> <span className="text-slate-500">(±{rv.band_pct}%)</span></span>
          {rv.max_up_pct != null && <span className="text-slate-400">{t('Escursione massima')} <span className="text-up">{pct(rv.max_up_pct, 1)}</span> / <span className="text-down">{pct(rv.max_down_pct, 1)}</span></span>}
          {rv.forecast_check && <span className="text-slate-400">{t('Previsione mediana')} {usd(rv.forecast_check.median)} · {rv.forecast_check.inside ? t('prezzo dentro la banda') : t('prezzo fuori dalla banda')}</span>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {note.tags.map((tg) => <span key={tg} className="inline-flex h-6 items-center gap-1 rounded-md bg-white/[0.04] px-2 text-xs text-slate-400 ring-1 ring-inset ring-white/[0.06]"><TagIcon size={11} />{tg}</span>)}
        <span className="ml-auto flex items-center gap-1.5">
          <button className="btn-ghost" onClick={onToggle} aria-expanded={open}>
            {t('Contesto')}<ChevronDown size={13} className={clsx('transition-transform', open && 'rotate-180')} />
          </button>
          <button className="btn-ghost" onClick={onEdit}><Pencil size={13} />{t('Modifica')}</button>
          <DeleteButton compact onConfirm={() => remove.mutate(note.id)} busy={remove.isPending} />
        </span>
      </div>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {rv?.context_now ? <ContextCompare then={s} now={rv.context_now} /> : <SnapshotGrid s={s} />}
          {s.missing?.length > 0 && <p className="text-2xs text-slate-500">{t('Moduli non disponibili alla creazione: {m}', { m: s.missing.join(', ') })}</p>}
        </div>
      )}
    </article>
  )
}
