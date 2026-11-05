// Track record page (pages/TrackRecordPage.tsx + widgets/tracking.tsx).
const en: Record<string, string> = {
  'Quanto hanno avuto ragione agenti e modelli: ogni previsione è registrata e verificata sul prezzo reale alla scadenza.':
    'How often agents and models were right: every forecast is logged and checked against the actual price at expiry.',
  // KPIs
  'Direzione corretta': 'Correct direction',
  '{n} previsioni direzionali · 50% = moneta': '{n} directional forecasts · 50% = coin flip',
  'vs frequenza di base': 'vs base rate',
  'Calibrazione (ECE)': 'Calibration (ECE)',
  'Scarto medio probabilità ↔ esiti': 'Mean gap probability ↔ outcomes',
  'Errore della mediana': 'Median error',
  'MAE % sul prezzo a scadenza': 'MAE % on the price at expiry',
  'Copertura bande': 'Band coverage',
  'Esiti dentro la banda prevista': 'Outcomes inside the forecast band',
  'Previsioni verificate': 'Resolved forecasts',
  'Live {a} · In attesa: {b} · Backtest {c}': 'Live {a} · Pending: {b} · Backtest {c}',
  // sources
  'Affidabilità per fonte': 'Track record by source',
  'Seleziona una riga per vederne la calibrazione': 'Select a row to see its calibration',
  "Live = previsioni registrate dall'app al momento dell'emissione. Backtest = ricostruite su date passate senza usare dati futuri. Hit rate verde sopra il 55%, rosso sotto il 45% (con almeno 20 casi).":
    'Live = forecasts logged by the app when issued. Backtest = rebuilt on past dates without using future data. Hit rate green above 55%, red below 45% (with at least 20 cases).',
  'Backtest in calcolo': 'Backtest running',
  'Nessuna previsione registrata': 'No forecasts logged',
  '% di direzioni corrette (previsioni neutrali escluse)': '% of correct directions (neutral forecasts excluded)',
  'Errore quadratico della probabilità di rialzo: 0 perfetto, 0.25 = moneta': 'Squared error of the up probability: 0 perfect, 0.25 = coin flip',
  'Miglioramento rispetto alla frequenza di rialzo del campione': 'Improvement over the sample’s up frequency',
  'Scarto medio tra probabilità dichiarata e frequenza osservata': 'Mean gap between stated probability and observed frequency',
  'Errore % medio della mediana prevista': 'Mean % error of the forecast median',
  '% di esiti dentro la banda prevista (nominale tra parentesi)': '% of outcomes inside the forecast band (nominal in brackets)',
  'Ultimi 90 {g}': 'Last 90 {g}',
  'Agente {name}': 'Agent {name}',
  'In attesa: {n}': 'Pending: {n}',
  '{n} fonti live in attesa di esito': '{n} live sources awaiting outcome',
  Mostra: 'Show',
  Nascondi: 'Hide',
  // calibration
  'Calibrazione delle probabilità': 'Probability calibration',
  'Probabilità di rialzo dichiarata vs rialzi osservati · diagonale = perfetto': 'Stated up probability vs observed rises · diagonal = perfect',
  'Le previsioni sono raggruppate in fasce di 10 punti di probabilità; la dimensione del punto è proporzionale al numero di casi. Sopra la diagonale la fonte è troppo pessimista, sotto troppo ottimista.':
    'Forecasts are grouped in 10-point probability bins; dot size is proportional to the number of cases. Above the diagonal the source is too pessimistic, below it too optimistic.',
  'Tutte le fonti': 'All sources',
  'ECE {v} pt · n={n}': 'ECE {v} pt · n={n}',
  'Un pannello per fonte (arancione) con tutte le fonti in grigio. Le previsioni sono raggruppate in fasce di 10 punti di probabilità; la dimensione del punto è proporzionale al numero di casi. Sopra la diagonale la fonte è troppo pessimista, sotto troppo ottimista.':
    'One panel per source (orange) with all sources in grey. Forecasts are grouped in 10-point probability bins; dot size is proportional to the number of cases. Above the diagonal the source is too pessimistic, below it too optimistic.',
  'Nessuna probabilità verificata per questa fonte': 'No resolved probabilities for this source',
  'Probabilità media': 'Mean probability',
  'Rialzi osservati': 'Observed rises',
  'Probabilità di rialzo prevista': 'Forecast up probability',
  // weights
  "Pesi per l'Analista": 'Weights for the Analyst',
  '0.50 = neutro · più previsioni, più il peso si allontana': '0.50 = neutral · more forecasts let the weight move further',
  'Peso = 0.5 + skill (hit rate e Brier, live pesato 2× rispetto al backtest), ridotto verso 0.5 quando le previsioni verificate sono poche: w = 0.5 + (raw − 0.5)·n/(n+50).':
    'Weight = 0.5 + skill (hit rate and Brier, live weighted 2× vs backtest), shrunk toward 0.5 when few forecasts are resolved: w = 0.5 + (raw − 0.5)·n/(n+50).',
  'Previsioni ML': 'ML forecasts',
  'Frattali & Pattern': 'Fractals & patterns',
  'Analoghi grafici': 'Chart analogs',
  'Pivot temporali': 'Time pivots',
  Cicli: 'Cycles',
  'Flussi Spot/Futures': 'Spot/futures flows',
  'Analista AI': 'AI analyst',
  // predictions
  'Previsioni verificate di recente': 'Recently resolved forecasts',
  'Live prima, poi le ultime del backtest': 'Live first, then the latest backtest ones',
  'In attesa di verifica': 'Awaiting resolution',
  'Previsioni live non ancora scadute': 'Live forecasts not yet expired',
  'Nessuna previsione ancora verificata': 'No forecasts resolved yet',
  'Nessuna previsione live in attesa': 'No live forecasts pending',
  'Nessuna previsione': 'No forecasts',
  'Prezzo iniziale': 'Start price',
  'Prob. rialzo': 'Up prob.',
  'Err. {v}%': 'Err. {v}%',
}
export default en
