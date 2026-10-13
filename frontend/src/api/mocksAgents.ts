/* Agent mocks (mock mode only). */
import type { Agent, AgentEdge, AgentId, AgentMessage, AgentsResponse } from './types'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const NOW = Math.floor(Date.now() / 1000)

const AGENT_DEFS: [AgentId, string, string, string, string, number, string[], string[]][] = [
  ['analyst', 'Analista', 'Orchestratore: sintetizza i segnali di tutti gli agenti e produce la view complessiva.', 'BrainCircuit', '#a78bfa', 300, ['*'], ['analysis.summary', 'request.levels', 'request.forecast']],
  ['market', 'Mercato', 'Monitora prezzo, volumi e volatilità in tempo reale.', 'Activity', '#f7931a', 30, ['request.market'], ['market.move', 'market.volatility']],
  ['levels', 'Livelli', 'Calcola supporti, resistenze, pivot e confluenze.', 'Target', '#22c55e', 120, ['market.move', 'request.levels'], ['levels.confluence', 'levels.break']],
  ['liquidity', 'Liquidità', 'Stima cluster di liquidazioni e pool di liquidità.', 'Flame', '#f43f5e', 60, ['market.move', 'levels.confluence', 'derivatives.funding'], ['liquidity.cluster', 'liquidity.sweep']],
  ['patterns', 'Pattern', 'Cerca analogie frattali e retest su più timeframe.', 'Shapes', '#8b5cf6', 300, ['levels.confluence'], ['pattern.match', 'pattern.retest']],
  ['correlation', 'Correlazioni', 'Analizza USDT dominance e correlazioni cross-asset.', 'GitCompareArrows', '#14b8a6', 300, ['market.move'], ['usdt.signal', 'correlation.shift']],
  ['cycles', 'Cicli', 'Stima la fase del ciclo e le finestre di top/bottom.', 'Orbit', '#facc15', 3600, [], ['cycle.phase']],
  ['onchain', 'On-chain', 'Valuta MVRV, NUPL, hash rate e attività di rete.', 'Blocks', '#3b82f6', 1800, [], ['onchain.signal']],
  ['derivatives', 'Derivati', 'Funding, open interest, long/short e basis.', 'Layers', '#ec4899', 60, ['market.move'], ['derivatives.funding', 'derivatives.squeeze']],
  ['forecast', 'Previsioni', 'Ensemble di modelli per i target a 7/30/90 giorni.', 'Telescope', '#22d3ee', 900, ['cycle.phase', 'pattern.retest', 'onchain.signal', 'request.forecast'], ['forecast.update']],
]

type Tpl = [AgentId, AgentId | '*', string, AgentMessage['kind'], string, AgentMessage['tone']]
const MSG_TEMPLATES: Tpl[] = [
  ['market', '*', 'market.move', 'finding', 'Movimento di +0,8% in 15 minuti con volume sopra la media: momentum in aumento.', 'bullish'],
  ['market', '*', 'market.volatility', 'alert', 'Volatilità realizzata 1h ai massimi della settimana.', 'neutral'],
  ['levels', 'liquidity', 'levels.confluence', 'finding', 'Confluenza tra pivot settimanale R1 e zona di resistenza a $77.4K.', 'neutral'],
  ['levels', 'patterns', 'levels.confluence', 'finding', 'Supporto a $71.1K confermato da 6 tocchi: livello chiave per i retest.', 'bullish'],
  ['liquidity', 'analyst', 'liquidity.cluster', 'finding', 'Cluster di liquidazioni short stimato a $77.4K (~$410M): possibile magnete.', 'bullish'],
  ['liquidity', '*', 'liquidity.sweep', 'alert', 'Sweep dei minimi uguali a $72.0K completato, liquidazioni long per $18M.', 'bearish'],
  ['patterns', 'analyst', 'pattern.match', 'finding', 'Frattale 4h simile all’82% a marzo 2020: 4 analoghi su 5 rialzisti.', 'bullish'],
  ['patterns', 'forecast', 'pattern.retest', 'finding', 'Gli analoghi suggeriscono un retest di $71K prima della ripartenza.', 'neutral'],
  ['correlation', 'analyst', 'usdt.signal', 'finding', 'USDT.D respinta dalla resistenza 7.1%: segnale positivo per BTC (lag 2g).', 'bullish'],
  ['cycles', 'forecast', 'cycle.phase', 'finding', 'Fase bear avanzata (71%), finestra bottom stimata Q4 2026.', 'neutral'],
  ['onchain', 'forecast', 'onchain.signal', 'finding', 'MVRV a 1.31: zona storica di accumulo per gli holder di lungo periodo.', 'bullish'],
  ['derivatives', 'analyst', 'derivatives.squeeze', 'alert', 'OI +2.3% con funding positivo: rischio di long squeeze sotto $70K.', 'bearish'],
  ['derivatives', 'liquidity', 'derivatives.funding', 'finding', 'Funding 0.0064% per 8h: posizionamento long moderato.', 'neutral'],
  ['analyst', 'levels', 'request.levels', 'request', 'Richiedo aggiornamento livelli sul 4h dopo il movimento recente.', 'neutral'],
  ['levels', 'analyst', 'request.levels', 'reply', 'Livelli 4h aggiornati: R $76.9K / $78.2K, S $72.4K / $71.1K.', 'neutral'],
  ['analyst', 'forecast', 'request.forecast', 'request', 'Ricalcola i target a 30 giorni con i nuovi segnali on-chain.', 'neutral'],
  ['forecast', 'analyst', 'forecast.update', 'reply', 'Target 30g aggiornato: mediana $75.8K, probabilità di rialzo 54%.', 'bullish'],
  ['analyst', '*', 'analysis.summary', 'finding', 'Sintesi: quadro misto, bias leggermente rialzista nel breve sopra $71K.', 'bullish'],
]

let msgId = 1000
const agentState = new Map<AgentId, Agent>()
const recent: AgentMessage[] = [] // newest first

function makeMsg(t: number, r: () => number): AgentMessage {
  const tpl = MSG_TEMPLATES[Math.floor(r() * MSG_TEMPLATES.length)]
  return { id: msgId++, time: t, from: tpl[0], to: tpl[1], topic: tpl[2], kind: tpl[3], text: tpl[4], tone: tpl[5] }
}

function init() {
  if (agentState.size) return
  const r = rng(99)
  for (const [id, name, role, icon, color, interval_s, subscribes, publishes] of AGENT_DEFS) {
    const findings = MSG_TEMPLATES.filter((m) => m[0] === id).slice(0, 3).map((m, i) => ({
      title: m[2].split('.')[1].replace(/^\w/, (c) => c.toUpperCase()),
      text: m[4], tone: m[5], confidence: Math.round(55 + r() * 35), time: NOW - i * interval_s - Math.floor(r() * 60),
    }))
    agentState.set(id, {
      id, name, role, icon, color, status: 'idle', error: null, interval_s,
      runs: Math.floor(200 + r() * 3000), last_run: NOW - Math.floor(r() * interval_s), next_run: NOW + Math.floor(r() * interval_s),
      last_duration_ms: Math.round(80 + r() * 2400), findings, subscribes, publishes,
      stats: { messages_sent: Math.floor(100 + r() * 900), messages_received: Math.floor(100 + r() * 900) },
    })
  }
  for (let i = 1; i <= 60; i++) recent.push(makeMsg(NOW - i * 20, r))
}

export function agentsMock(): AgentsResponse {
  init()
  const edges = new Map<string, AgentEdge>()
  for (const [id, , , , , , subs] of AGENT_DEFS) {
    for (const [pid, , , , , , , pubs] of AGENT_DEFS) {
      if (pid === id) continue
      const topics = subs.includes('*') ? pubs.filter((t) => !t.startsWith('request.')) : pubs.filter((t) => subs.includes(t))
      if (topics.length) edges.set(`${pid}>${id}`, { from: pid, to: id, topics, count: 0, last: null })
    }
  }
  for (const m of recent) {
    const to = m.to === '*' ? 'analyst' : m.to
    if (to === m.from) continue
    const k = `${m.from}>${to}`
    const e = edges.get(k) ?? { from: m.from, to, topics: [m.topic], count: 0, last: null }
    e.count++
    e.last = Math.max(e.last ?? 0, m.time)
    if (!e.topics.includes(m.topic)) e.topics.push(m.topic)
    edges.set(k, e)
  }
  return { agents: [...agentState.values()].map((a) => ({ ...a })), edges: [...edges.values()], started_at: NOW - 3 * 3600 }
}

export function agentMessagesMock(limit: number, agent?: string): AgentMessage[] {
  init()
  return recent.filter((m) => !agent || m.from === agent || m.to === agent).slice(0, limit)
}

export function runAgentMock(id: string, emit?: (m: unknown) => void) {
  init()
  const a = agentState.get(id as AgentId)
  if (!a) throw new Error('Agente sconosciuto')
  a.status = 'running'
  emitRef?.({ type: 'agent_status', id: a.id, status: 'running', last_run: a.last_run, next_run: a.next_run, last_duration_ms: a.last_duration_ms })
  setTimeout(() => {
    a.status = 'idle'
    a.runs++
    a.last_run = Math.floor(Date.now() / 1000)
    a.next_run = a.last_run + a.interval_s
    emitRef?.({ type: 'agent_status', id: a.id, status: 'idle', last_run: a.last_run, next_run: a.next_run, last_duration_ms: a.last_duration_ms })
  }, 1500)
  void emit
  return { ok: true }
}

let emitRef: ((m: unknown) => void) | null = null
export function startMockAgents(emit: (m: unknown) => void) {
  if (emitRef) return
  emitRef = emit
  init()
  const r = rng(Date.now() % 9999)
  const loop = () => {
    const now = Math.floor(Date.now() / 1000)
    const msg = makeMsg(now, r)
    recent.unshift(msg)
    recent.length = Math.min(recent.length, 300)
    const a = agentState.get(msg.from)
    if (a) {
      a.status = 'running'
      a.stats.messages_sent++
      emit({ type: 'agent_status', id: a.id, status: 'running', last_run: a.last_run, next_run: a.next_run, last_duration_ms: a.last_duration_ms })
      setTimeout(() => {
        a.status = 'idle'
        a.runs++
        a.last_run = Math.floor(Date.now() / 1000)
        a.next_run = a.last_run + a.interval_s
        a.last_duration_ms = Math.round(80 + r() * 2000)
        a.findings = [{ title: msg.topic.split('.')[1].replace(/^\w/, (c) => c.toUpperCase()), text: msg.text, tone: msg.tone, confidence: Math.round(55 + r() * 35), time: now }, ...a.findings].slice(0, 6)
        emit({ type: 'agent_status', id: a.id, status: 'idle', last_run: a.last_run, next_run: a.next_run, last_duration_ms: a.last_duration_ms })
      }, 700 + r() * 900)
    }
    setTimeout(() => emit({ type: 'agent_message', ...msg }), 350)
    setTimeout(loop, 1000 + r() * 2000)
  }
  setTimeout(loop, 800)
}
