import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { streamChat } from '../api/client'
import type { ChatMessage } from '../api/types'
import { clsx } from './ui'
import { t } from '../i18n'

/* Italian source strings (translated with t() at render time). */
/*
 * Command-panel style Q&A: the prompt sits on top, each exchange below it (newest first) as a muted "› question"
 * line followed by the answer as plain text. No avatars, bubbles or decorative icons.
 */

const SUGGESTIONS = [
  'In che fase del ciclo siamo?',
  'Quali sono i livelli chiave da monitorare?',
  'Dove sono i cluster di liquidazione più vicini?',
]

const STORE_KEY = 'chat-history'
function loadHistory(): ChatMessage[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

type Exchange = { q: string; a: string; pending: boolean }
function toExchanges(messages: ChatMessage[], busy: boolean): Exchange[] {
  const out: Exchange[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const next = messages[i + 1]
    const a = next && next.role === 'assistant' ? next.content : ''
    out.push({ q: m.content, a, pending: busy && i + 1 >= messages.length - 1 })
  }
  return out.reverse()
}

export default function ChatPanel({ className }: { className?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(messages)) } catch { /* ignore */ }
  }, [messages])

  async function send(text: string) {
    const q = text.trim()
    if (!q || busy) return
    setError(null)
    setInput('')
    const history: ChatMessage[] = [...messages, { role: 'user', content: q }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await streamChat(history, (delta) => {
        setMessages((m) => {
          const copy = m.slice()
          const last = copy[copy.length - 1]
          copy[copy.length - 1] = { ...last, content: last.content + delta }
          return copy
        })
      }, ac.signal)
    } catch (e) {
      if (!ac.signal.aborted) {
        setError(e instanceof Error && e.message ? t('Errore: {msg}', { msg: e.message }) : t('Impossibile ottenere una risposta.'))
        setMessages((m) => (m[m.length - 1]?.content === '' ? m.slice(0, -1) : m))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const exchanges = toExchanges(messages, busy)

  return (
    <div className={clsx('flex min-h-0 flex-col gap-3', className)}>
      <form className="flex items-start gap-2 rounded-md border border-line bg-bg px-3 py-1.5 focus-within:border-white/20"
        onSubmit={(e) => { e.preventDefault(); send(input) }}>
        <span aria-hidden className="select-none pt-1 font-mono text-sm text-slate-400">›</span>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
          rows={1}
          aria-label={t('Domanda')}
          placeholder={t('Fai una domanda sui dati…')}
          className="max-h-32 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-sm text-white placeholder:text-slate-400 focus:outline-none"
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()} className="btn-ghost h-8">{t('Interrompi')}</button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="btn-ghost h-8 disabled:opacity-40">{t('Invia')} ↵</button>
        )}
      </form>

      {error && <p className="text-xs text-amber-400">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {exchanges.length === 0 ? (
          <div className="flex flex-col items-start">
            {SUGGESTIONS.map((s) => t(s)).map((s) => (
              <button key={s} onClick={() => send(s)} className="flex min-h-8 items-center gap-2 text-left text-sm text-slate-400 hover:text-white">
                <span aria-hidden className="font-mono">›</span>{s}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {exchanges.map((x, i) => (
              <div key={exchanges.length - i} className="border-t border-line py-3 first:border-t-0 first:pt-0">
                <p className="flex gap-2 font-mono text-xs text-slate-400"><span aria-hidden>›</span><span className="whitespace-pre-wrap">{x.q}</span></p>
                <div className="mt-1.5 text-sm text-slate-200">
                  {x.a ? (
                    <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{x.a}</ReactMarkdown></div>
                  ) : x.pending ? <span className="text-slate-400">{t('Elaborazione…')}</span> : <span className="text-slate-400">{t('Nessuna risposta.')}</span>}
                </div>
              </div>
            ))}
            {!busy && (
              <button type="button" onClick={() => { setMessages([]); inputRef.current?.focus() }} className="link h-8 self-start">{t('Cancella conversazione')}</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
