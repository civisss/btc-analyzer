/*
 * Chart annotations for /grafici: toolbar (livello, trendline, marcatore tempo, nota, avviso al prezzo), pick flow on ProChart,
 * persisted per symbol/timeframe on the server (/api/journal/annotations), list/manage panel with inline editing.
 */
import { useEffect, useMemo, useState } from 'react'
import { BellPlus, Check, Minus, MoveDiagonal, PenLine, SeparatorVertical, StickyNote, X } from 'lucide-react'
import { useAnnotations, useJournalMutations, type AnnColor, type AnnKind, type Annotation } from '../api/journal'
import type { Tf } from '../api/types'
import type { ChartAnnotationDef, ChartPoint } from '../components/charts/ProChart'
import { ACCENT_HEX, Card, CardHeader, clsx } from '../components/ui'
import { dateTime, usd } from '../lib/format'
import { t, tfLabel } from '../i18n'
import { DeleteButton, Field, INPUT, Modal, NumInput, Switch } from './forms'
import { openRuleEditor, priceRulePrefill } from './alertRules'

export type Tool = AnnKind | 'alert'
const COLORS: AnnColor[] = ['amber', 'blue', 'violet', 'teal', 'btc', 'slate']
const KIND_META: Record<AnnKind, { label: string; icon: typeof Minus; hint: string }> = {
  hline: { label: 'Livello', icon: Minus, hint: 'Clicca sul grafico per fissare il livello di prezzo' },
  trendline: { label: 'Trendline', icon: MoveDiagonal, hint: 'Clicca il primo punto, poi il secondo' },
  vline: { label: 'Marcatore tempo', icon: SeparatorVertical, hint: 'Clicca sulla candela da marcare' },
  text: { label: 'Nota', icon: StickyNote, hint: 'Clicca sul punto (tempo e prezzo) a cui fissare la nota' },
}

export function useChartAnnotations(tf: Tf, price: number | null) {
  const q = useAnnotations(tf)
  const m = useJournalMutations()
  const [tool, setTool] = useState<Tool | null>(null)
  const [draft, setDraft] = useState<ChartPoint | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [textAt, setTextAt] = useState<ChartPoint | null>(null)
  const [hidden, setHidden] = useState(false)
  useEffect(() => { setTool(null); setDraft(null); setSelected(null) }, [tf])
  useEffect(() => {
    if (!tool) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setTool(null); setDraft(null) } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [tool])

  const items = useMemo(() => q.data?.items ?? [], [q.data])
  const defs = useMemo<ChartAnnotationDef[]>(() => (hidden ? [] : items.map((a) => ({
    id: a.id, kind: a.kind, points: a.points, color: ACCENT_HEX[a.color], text: a.text, extend: a.extend, selected: a.id === selected,
  }))), [items, selected, hidden])

  const create = async (kind: AnnKind, points: ChartPoint[], text = '') => {
    const a = await m.createAnn.mutateAsync({
      kind, tf, color: 'amber', text, extend: false,
      points: kind === 'hline' ? [{ time: null, price: Math.round(points[0].price) }] : kind === 'vline' ? [{ time: points[0].time, price: null }]
        : points.map((p) => ({ time: p.time, price: Math.round(p.price * 100) / 100 })),
    })
    setSelected(a.id)
    setHidden(false)
  }
  const onPick = tool ? (p: ChartPoint) => {
    if (tool === 'alert') { openRuleEditor(priceRulePrefill(p.price, price)); setTool(null); return }
    if (tool === 'text') { setTextAt(p); setTool(null); return }
    if (tool === 'trendline') {
      if (!draft) { setDraft(p); return }
      if (p.time === draft.time && Math.abs(p.price - draft.price) < 1e-9) return
      void create('trendline', [draft, p]); setDraft(null); setTool(null); return
    }
    void create(tool, [p]); setTool(null)
  } : undefined

  const pick = (tl: Tool) => { setDraft(null); setTool((cur) => (cur === tl ? null : tl)) }
  const hint = tool === 'alert' ? t('Clicca sul grafico: l’avviso usa il prezzo sotto il cursore') : tool ? t(tool === 'trendline' && draft ? 'Ora clicca il secondo punto' : KIND_META[tool].hint) : null

  const toolbar = (
    <div className="flex items-center gap-1" role="toolbar" aria-label={t('Strumenti di disegno')}>
      {(Object.keys(KIND_META) as AnnKind[]).map((k) => {
        const M = KIND_META[k]
        return (
          <button key={k} type="button" onClick={() => pick(k)} aria-pressed={tool === k} title={t(M.label)} aria-label={t(M.label)}
            className={clsx('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors sm:h-7',
              tool === k ? 'border-accent-blue/45 bg-accent-blue/[0.12] text-white' : 'border-line bg-white/[0.03] text-slate-400 hover:border-white/15 hover:text-white')}>
            <M.icon size={14} /><span className="hidden 2xl:inline">{t(M.label)}</span>
          </button>
        )
      })}
      <span className="mx-0.5 h-5 w-px bg-white/[0.08]" />
      <button type="button" onClick={() => pick('alert')} aria-pressed={tool === 'alert'} title={t('Crea avviso al prezzo')} aria-label={t('Crea avviso al prezzo')}
        className={clsx('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors sm:h-7',
          tool === 'alert' ? 'border-amber-400/45 bg-amber-400/[0.12] text-white' : 'border-line bg-white/[0.03] text-slate-400 hover:border-white/15 hover:text-white')}>
        <BellPlus size={14} /><span className="hidden 2xl:inline">{t('Avviso')}</span>
      </button>
    </div>
  )

  const banner = hint ? (
    <div className="mb-2 flex items-center gap-2 rounded-xl bg-accent-blue/[0.08] px-3 py-2 text-xs text-slate-200 ring-1 ring-inset ring-accent-blue/25">
      <PenLine size={13} className="text-accent-blue" />
      <span className="min-w-0 flex-1">{hint}</span>
      <button className="link h-6" onClick={() => { setTool(null); setDraft(null) }}>{t('Annulla')} <kbd className="ml-1 rounded border border-white/10 px-1 text-2xs text-slate-400">Esc</kbd></button>
    </div>
  ) : null

  const textModal = textAt ? <TextNoteModal at={textAt} onClose={() => setTextAt(null)} onSave={async (txt) => { await create('text', [textAt], txt); setTextAt(null) }} /> : null

  const panel = (
    <AnnotationsPanel tf={tf} items={items} selected={selected} onSelect={setSelected} hidden={hidden} onHidden={setHidden} loading={q.isPending} />
  )
  return { defs, onPick, pickDraft: draft, onAnnotationClick: (id: string) => setSelected((s) => (s === id ? null : id)), toolbar, banner, panel, textModal }
}

function TextNoteModal({ at, onClose, onSave }: { at: ChartPoint; onClose: () => void; onSave: (t: string) => Promise<void> }) {
  const [txt, setTxt] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = txt.trim().length > 0
  return (
    <Modal title={t('Nota sul grafico')} icon={<StickyNote />} accent="violet" onClose={onClose} subtitle={`${dateTime(at.time)} · ${usd(at.price)}`}
      footer={<>
        <button className="btn-ghost" onClick={onClose}>{t('Annulla')}</button>
        <button className="btn-primary" disabled={!ok || busy} onClick={async () => { setBusy(true); try { await onSave(txt.trim()) } finally { setBusy(false) } }}>{t('Aggiungi nota')}</button>
      </>}>
      <Field label={t('Testo')} hint={t('Massimo 280 caratteri')}>
        <textarea autoFocus value={txt} maxLength={280} rows={3} onChange={(e) => setTxt(e.target.value)} className={clsx(INPUT, 'h-auto resize-y py-2 leading-relaxed')}
          placeholder={t('Es. sweep del minimo e rientro')} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ok) void onSave(txt.trim()) }} />
      </Field>
    </Modal>
  )
}

function annValue(a: Annotation): string {
  const p = a.points
  if (a.kind === 'hline') return usd(p[0]?.price ?? null)
  if (a.kind === 'vline') return dateTime(p[0]?.time ?? null)
  if (a.kind === 'text') return `${dateTime(p[0]?.time ?? null)} · ${usd(p[0]?.price ?? null)}`
  return `${usd(p[0]?.price ?? null)} → ${usd(p[1]?.price ?? null)}`
}

function AnnotationsPanel({ tf, items, selected, onSelect, hidden, onHidden, loading }: {
  tf: Tf; items: Annotation[]; selected: string | null; onSelect: (id: string | null) => void; hidden: boolean; onHidden: (h: boolean) => void; loading: boolean
}) {
  return (
    <Card>
      <CardHeader title={t('Annotazioni')} icon={<PenLine />} subtitle={t('Timeframe {tf} · salvate sul server', { tf: tfLabel(tf) })}
        right={items.length ? <button className="btn-ghost" onClick={() => onHidden(!hidden)} aria-pressed={hidden}>{hidden ? t('Mostra') : t('Nascondi')}</button> : null} />
      <div className="pb-2">
        {loading ? <p className="px-5 pb-3 text-xs text-slate-400">{t('Caricamento…')}</p> : items.length ? items.map((a) => (
          <AnnRow key={a.id} a={a} tf={tf} open={a.id === selected} onToggle={() => onSelect(a.id === selected ? null : a.id)} />
        )) : <p className="px-4 pb-3 text-xs leading-relaxed text-slate-400 sm:px-5">{t('Nessuna annotazione su questo timeframe. Usa gli strumenti sopra il grafico per disegnare livelli, trendline, marcatori di tempo e note.')}</p>}
      </div>
    </Card>
  )
}

function AnnRow({ a, tf, open, onToggle }: { a: Annotation; tf: Tf; open: boolean; onToggle: () => void }) {
  const { updateAnn, removeAnn } = useJournalMutations()
  const M = KIND_META[a.kind]
  const [text, setText] = useState(a.text)
  useEffect(() => setText(a.text), [a.text])
  const save = (patch: Partial<Annotation>) => updateAnn.mutate({ id: a.id, a: patch })
  return (
    <div className={clsx('border-t border-white/[0.05] first:border-t-0', open && 'bg-white/[0.02]')}>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.03] sm:px-5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset ring-white/[0.06]" style={{ color: ACCENT_HEX[a.color], background: `${ACCENT_HEX[a.color]}1A` }}><M.icon size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-white">{a.text || t(M.label)}</span>
          <span className="tnum block truncate text-2xs text-slate-500">{annValue(a)}{a.tf == null ? ` · ${t('tutti i timeframe')}` : ''}</span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-4 pb-3 sm:px-5">
          <Field label={t('Etichetta')}>
            <span className="flex gap-1.5">
              <input value={text} maxLength={280} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (text.trim() || a.kind !== 'text')) save({ text: text.trim() }) }}
                className={INPUT} placeholder={a.kind === 'text' ? t('Testo della nota') : t('Facoltativa')} />
              <button className="btn-ghost h-9 sm:h-9" disabled={text === a.text || (a.kind === 'text' && !text.trim())} onClick={() => save({ text: text.trim() })} aria-label={t('Salva etichetta')}><Check size={14} /></button>
            </span>
          </Field>
          {a.kind === 'hline' && (
            <Field label={t('Prezzo')}>
              <NumInput value={a.points[0]?.price ?? null} prefix="$" step={1} onChange={(v) => { if (v && v > 0) save({ points: [{ time: null, price: v }] }) }} />
            </Field>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t('Colore')}>
              {COLORS.map((c) => (
                <button key={c} role="radio" aria-checked={a.color === c} aria-label={c} onClick={() => save({ color: c })}
                  className={clsx('grid h-6 w-6 place-items-center rounded-full ring-2 ring-offset-2 ring-offset-[#0E1424] transition', a.color === c ? 'ring-white/70' : 'ring-transparent hover:ring-white/20')}
                  style={{ background: ACCENT_HEX[c] }} />
              ))}
            </div>
            <DeleteButton compact onConfirm={() => removeAnn.mutate(a.id)} busy={removeAnn.isPending} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
            <span className="inline-flex items-center gap-1">
              <Switch on={a.tf == null} onChange={(v) => save({ tf: v ? null : tf })} label={t('Tutti i timeframe')} />{t('Tutti i timeframe')}
            </span>
            {a.kind === 'trendline' && (
              <span className="inline-flex items-center gap-1">
                <Switch on={!!a.extend} onChange={(v) => save({ extend: v })} label={t('Estendi a destra')} />{t('Estendi a destra')}
              </span>
            )}
          </div>
          {updateAnn.isError && <p className="flex items-center gap-1 text-xs text-down"><X size={12} />{(updateAnn.error as Error).message}</p>}
        </div>
      )}
    </div>
  )
}
