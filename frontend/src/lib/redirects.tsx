import { Navigate, useLocation } from 'react-router-dom'

/** Old URL → new page. Keys of each entry are the `?tab=` values of the old page; `*` covers any other value (or none). */
export const REDIRECTS: Record<string, Record<string, string>> = {
  // pagine accorpate
  superchart: { '*': '/grafici?tab=superchart' },
  vwap: { panels: '/grafici?tab=vwap&view=panels', '*': '/grafici?tab=vwap' },
  orderbook: { footprint: '/terminale?tab=footprint', '*': '/terminale?tab=heatmap' },
  usdt: { analogs: '/analoghi?metodo=usdt', stables: '/flussi?tab=stablecoin&view=stablecoin', '*': '/flussi?tab=stablecoin' },
  'domanda-offerta': { etf: '/flussi?tab=etf', attenzione: '/flussi?tab=etf&view=attenzione', '*': '/flussi?tab=exchange' },
  derivati: { flows: '/flussi?view=spot', basis: '/posizionamento?view=basis', cme: '/posizionamento?view=cme', leverage: '/posizionamento?view=leva', '*': '/posizionamento' },
  liquidazioni: { '*': '/posizionamento?tab=liquidazioni' },
  eventi: { '*': '/macro?tab=eventi' },
  frattali: { '*': '/analoghi?metodo=frattali' },
  'pivot-temporali': { season: '/analoghi?tab=pivot&view=season', cycles: '/analoghi?tab=pivot&view=cycles', '*': '/analoghi?tab=pivot' },
  affidabilita: { '*': '/previsioni?tab=affidabilita' },
  insights: { '*': '/' },
  // pagine rimosse
  astronomia: { '*': '/' },
  timing: { '*': '/' },
  elliott: { '*': '/' },
  diario: { '*': '/' },
  agenti: { '*': '/' },
}

export function OldUrl({ from }: { from: string }) {
  const loc = useLocation()
  const sp = new URLSearchParams(loc.search)
  const map = REDIRECTS[from]
  const to = map[sp.get('tab') ?? ''] ?? map['*']
  if (from !== 'superchart') return <Navigate replace to={to} />
  // i link condivisi del Superchart portano nell'URL layout, replay e pannelli
  sp.delete('tab')
  const rest = sp.toString()
  return <Navigate replace to={rest ? `${to}&${rest}` : to} />
}
