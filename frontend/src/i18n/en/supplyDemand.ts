// Supply & demand page (SupplyDemandPage, widgets/supplyDemand): exchange reserves/flows, spot ETF flows, retail attention.
const en: Record<string, string> = {
  // ---------------------------------------------------------------- page / tabs / labels
  'Domanda e offerta': 'Supply & demand',
  Exchange: 'Exchanges',
  'ETF spot': 'Spot ETFs',
  Attenzione: 'Attention',
  'Riserve di BTC sugli exchange, afflussi e deflussi giornalieri, regimi di flusso e rendimenti successivi.':
    'BTC reserves on exchanges, daily inflows and outflows, flow regimes and forward returns.',
  'Flussi giornalieri degli ETF spot USA per emittente e assorbimento dei BTC emessi dai miner.':
    'Daily flows of US spot ETFs by issuer and absorption of the BTC issued by miners.',
  'Deflussi forti': 'Strong outflows',
  Deflussi: 'Outflows',
  Neutro: 'Neutral',
  Afflussi: 'Inflows',
  'Afflussi forti': 'Strong inflows',
  Bassa: 'Low',
  'Sotto la media': 'Below average',
  'Sopra la media': 'Above average',
  Alta: 'High',
  Estrema: 'Extreme',
  'Fonti, metodo e verifiche': 'Sources, method and checks',

  // ---------------------------------------------------------------- exchange: KPIs
  'Riserve sugli exchange': 'Exchange reserves',
  "{p}% dell'offerta in circolazione": '{p}% of circulating supply',
  'Variazione 1 anno': '1-year change',
  "{p} · {s} pt dell'offerta": '{p} · {s} pt of supply',
  'Flusso netto {d}': 'Net flow {d}',
  'Entrate {a} · uscite {b}': 'In {a} · out {b}',
  'Flusso netto 30 giorni': '30-day net flow',
  'Flusso netto 90 giorni': '90-day net flow',
  'Z-score flusso 30 giorni': '30-day flow z-score',
  'Regime: {r}': 'Regime: {r}',
  'Riserve ai minimi dal': 'Reserves lowest since',
  'Massimo {v} · {d}': 'High {v} · {d}',

  // ---------------------------------------------------------------- exchange: reading
  "Negli ultimi 30 giorni sono usciti dagli exchange {v} netti (z {z}): regime «{r}». Le monete ritirate di solito vanno in custodia propria o presso custodi non coperti dai dati, e riducono l'offerta pronta alla vendita.":
    'Over the last 30 days a net {v} left exchanges (z {z}): “{r}” regime. Withdrawn coins usually move to self-custody or to custodians not covered by the data, reducing the supply ready to be sold.',
  'Negli ultimi 30 giorni sono entrati negli exchange {v} netti (z {z}): regime «{r}». Afflussi elevati spesso precedono vendite, ma possono essere anche collaterale per derivati.':
    'Over the last 30 days a net {v} moved onto exchanges (z {z}): “{r}” regime. Large inflows often precede selling, but can also be collateral for derivatives.',
  'Dal {s}, nei giorni nello stesso regime BTC ha reso in mediana {a} a 90 giorni (positivi {h}%), contro {b} di tutti i giorni. Sono {e} episodi indipendenti su {n} giorni sovrapposti: indicazione, non previsione.':
    'Since {s}, on days in the same regime BTC returned a median {a} over 90 days ({h}% positive), versus {b} for all days. That is {e} independent episodes over {n} overlapping days: a hint, not a forecast.',
  "Le riserve sono {r} ({p}% dell'offerta), ai minimi dal {d}; in un anno {c} ({cp}). Il massimo resta {m} del {md}.":
    'Reserves stand at {r} ({p}% of supply), the lowest since {d}; {c} over one year ({cp}). The high remains {m} on {md}.',
  'Fase di ciclo in corso: {k} dal {s} ({n} giorni). Flusso medio {a} al giorno, uscite nel {o}% dei giorni; media delle fasi di {k} precedenti {b} al giorno.':
    'Current cycle phase: {k} since {s} ({n} days). Average flow {a} per day, outflows on {o}% of days; previous {k} phases averaged {b} per day.',
  'Cosa dicono riserve e flussi oggi': 'What reserves and flows say today',

  // ---------------------------------------------------------------- exchange: cards
  'Riserve degli exchange vs prezzo': 'Exchange reserves vs price',
  'BTC sugli indirizzi exchange coperti da CoinMetrics · dal 2012': 'BTC on exchange addresses covered by CoinMetrics · since 2012',
  'Saldo dei BTC sugli indirizzi attribuiti agli exchange. Il livello dipende dalla copertura degli indirizzi di CoinMetrics: Glassnode e CryptoQuant usano cluster diversi e mostrano livelli diversi, ma la direzione è confrontabile.':
    'Balance of BTC on addresses attributed to exchanges. The level depends on CoinMetrics’ address coverage: Glassnode and CryptoQuant use different clusters and show different levels, but the direction is comparable.',
  '% offerta': '% of supply',
  'Riserve exchange': 'Exchange reserves',
  "Riserve in % dell'offerta": 'Reserves as % of supply',
  'Flusso netto verso gli exchange': 'Net flow into exchanges',
  'Giornaliero, ultimi 12 mesi · entrate − uscite (BTC)': 'Daily, last 12 months · inflows − outflows (BTC)',
  'Somma settimanale dal 2015 (BTC)': 'Weekly sum since 2015 (BTC)',
  'Somme mobili a 30 e 90 giorni (BTC)': '30- and 90-day rolling sums (BTC)',
  'Positivo (rosso) = più BTC entrati che usciti: potenziale offerta in vendita. Negativo (verde) = più BTC ritirati: accumulo o spostamento in custodia.':
    'Positive (red) = more BTC deposited than withdrawn: potential supply for sale. Negative (green) = more BTC withdrawn: accumulation or a move into custody.',
  'Somme mobili': 'Rolling sums',
  'Uscite nette (verde)': 'Net outflows (green)',
  'Entrate nette (rosso)': 'Net inflows (red)',
  'Entrate nette': 'Net inflows',
  'Uscite nette': 'Net outflows',
  'Flusso netto': 'Net flow',
  'Rendimenti dopo i regimi di flusso': 'Returns after flow regimes',
  'Z-score del flusso netto a 30 giorni · dal {d}': '30-day net flow z-score · since {d}',
  'Ogni giorno è classificato con lo z-score del flusso netto a 30 giorni rispetto ai 2 anni precedenti (solo dati passati). Le colonne riportano il rendimento mediano di BTC a 30/90/180 giorni e la quota di casi positivi. I giorni consecutivi si sovrappongono: il campione indipendente è il numero di episodi.':
    'Each day is classified by the z-score of the 30-day net flow versus the previous 2 years (past data only). Columns show the median BTC return over 30/90/180 days and the share of positive cases. Consecutive days overlap: the independent sample is the number of episodes.',
  'Singoli giorni estremi (|z| ≥ 2)': 'Single extreme days (|z| ≥ 2)',
  'Grandi uscite · {n} giorni': 'Large outflows · {n} days',
  'Grandi entrate · {n} giorni': 'Large inflows · {n} days',
  'Mediana a 30 giorni · positivi': '30-day median · positive',
  'Giorni di flusso estremo': 'Extreme flow days',
  'Primi 10 per z-score giornaliero dal 2015 (episodi distinti)': 'Top 10 by daily z-score since 2015 (distinct episodes)',
  'Z-score = flusso netto del giorno rispetto a media e deviazione standard dei 365 giorni precedenti. Alcuni picchi isolati possono essere spostamenti interni tra wallet dello stesso exchange, non distinguibili nei dati.':
    'Z-score = the day’s net flow versus the mean and standard deviation of the previous 365 days. Some isolated spikes may be internal moves between wallets of the same exchange, which the data cannot distinguish.',
  'Riserve per fase di ciclo': 'Reserves by cycle phase',
  'Gambe minimo → massimo (rialzo) e massimo → minimo (ribasso) dal 2015': 'Low → high legs (uptrend) and high → low legs (downtrend) since 2015',
  "Massimi e minimi di ciclo dello stesso modulo Cicli. Variazione delle riserve tra inizio e fine della fase e flusso netto medio giornaliero. Nel 2015–2018 la crescita delle riserve riflette anche l'aumento della copertura degli indirizzi.":
    'Cycle highs and lows from the Cycles module. Change in reserves between the start and end of each phase and the average daily net flow. In 2015–2018 the growth in reserves also reflects expanding address coverage.',
  Riserve: 'Reserves',
  "Quota dell'offerta": 'Share of supply',
  'Flusso medio/giorno': 'Avg flow/day',
  'Giorni in uscita': 'Outflow days',
  'Ultimi 30 giorni': 'Last 30 days',
  'Entrate, uscite e saldo giornaliero · valori «flash» rivedibili': 'Daily inflows, outflows and balance · “flash” values may be revised',
  Entrate: 'Inflows',
  Uscite: 'Outflows',
  'CoinMetrics community, 1 giorno di ritardo · ultimo dato {d} · tutti i valori sono «flash» (preliminari, rivedibili) e vengono ricaricati per intero a ogni aggiornamento':
    'CoinMetrics community, 1-day delay · latest data {d} · all values are “flash” (preliminary, may be revised) and are fully reloaded at every refresh',

  // ---------------------------------------------------------------- exchange: method
  'Fonte: CoinMetrics Community API, metriche SplyExNtv (saldo exchange), FlowInExNtv e FlowOutExNtv (afflussi e deflussi giornalieri, BTC), SplyCur (offerta) e IssTotNtv (emissione). Gratuite, nessuna chiave. Statistiche dal {s}: prima la copertura degli indirizzi exchange era incompleta.':
    'Source: CoinMetrics Community API, metrics SplyExNtv (exchange balance), FlowInExNtv and FlowOutExNtv (daily inflows and outflows, BTC), SplyCur (supply) and IssTotNtv (issuance). Free, no key. Statistics since {s}: before that, exchange address coverage was incomplete.',
  'Z-score giornaliero sui 365 giorni precedenti; z-score del flusso a 30 giorni sui 2 anni precedenti. Rendimenti successivi calcolati sulla chiusura giornaliera di BTC.':
    'Daily z-score over the previous 365 days; 30-day flow z-score over the previous 2 years. Forward returns computed on the BTC daily close.',
  'Black Thursday {d}: afflussi {v} (valore pubblico noto ≈ 191K BTC).': 'Black Thursday {d}: inflows {v} (known public value ≈ 191K BTC).',
  'Crollo di FTX {d}: flusso netto {v} (deflusso netto ≈ −34.8K BTC).': 'FTX collapse {d}: net flow {v} (net outflow ≈ −34.8K BTC).',
  'Coerenza interna: nel {p}% dei {n} giorni la variazione delle riserve coincide con entrate − uscite (±1 BTC). {a} giorni con scarti > 1,000 BTC (totale {b}) sono rettifiche di copertura degli indirizzi, non flussi.':
    'Internal consistency: on {p}% of {n} days the change in reserves equals inflows − outflows (±1 BTC). {a} days with gaps > 1,000 BTC (total {b}) are address-coverage adjustments, not flows.',
  'Emissione media 30 giorni {v} BTC/giorno (3.125 BTC × ~144 blocchi = 450 dopo il halving di aprile 2024).':
    '30-day average issuance {v} BTC/day (3.125 BTC × ~144 blocks = 450 after the April 2024 halving).',
  'Limiti: il livello delle riserve dipende da quali indirizzi CoinMetrics attribuisce agli exchange; gli ETF e molti custodi non sono inclusi, quindi i deflussi verso di loro risultano come uscite. Analisi a scopo di studio, non consulenza finanziaria.':
    'Limits: the reserve level depends on which addresses CoinMetrics attributes to exchanges; ETFs and many custodians are not included, so flows to them show up as outflows. For study purposes, not financial advice.',

  // ---------------------------------------------------------------- ETF: KPIs and reading
  'Seduta {d}': 'Session {d}',
  '{b} stimati · provvisorio': '{b} estimated · provisional',
  'Ultime 5 sedute': 'Last 5 sessions',
  '{b} stimati': '{b} estimated',
  'Ultime 20 sedute': 'Last 20 sessions',
  'Flusso netto dal lancio': 'Net flow since launch',
  '≈ {b} stimati · {n} sedute': '≈ {b} estimated · {n} sessions',
  'Assorbimento 30 giorni': '30-day absorption',
  "dell'emissione": 'of issuance',
  'ETF {a} · miner {b}': 'ETFs {a} · miners {b}',
  'Serie di deflussi': 'Outflow streak',
  'Serie di afflussi': 'Inflow streak',
  'Record {n} sedute · {v}': 'Record {n} sessions · {v}',
  'Seduta del {d} (provvisoria): {u}, circa {b}. Nelle ultime 5 sedute {u5}, nelle ultime 20 {u20}.':
    'Session of {d} (provisional): {u}, about {b}. Last 5 sessions {u5}, last 20 {u20}.',
  "Negli ultimi 30 giorni gli ETF hanno comprato in netto {a} contro {b} emessi dai miner: {r} dell'emissione. Sopra 1× la domanda degli ETF da sola supera la nuova offerta.":
    'Over the last 30 days ETFs bought a net {a} versus {b} issued by miners: {r} of issuance. Above 1×, ETF demand alone exceeds new supply.',
  'Negli ultimi 30 giorni gli ETF hanno venduto in netto {a} mentre i miner ne emettevano {b}: gli ETF aggiungono offerta invece di assorbirla.':
    'Over the last 30 days ETFs sold a net {a} while miners issued {b}: ETFs are adding supply instead of absorbing it.',
  'Dal halving del {d} gli ETF hanno assorbito {a} contro {b} emessi ({r}).': 'Since the {d} halving ETFs have absorbed {a} versus {b} issued ({r}).',
  'Ultima seduta in afflusso ({u}) dopo una seduta di segno opposto o nulla.': 'Latest session was an inflow ({u}) after a session of the opposite sign or flat.',
  'Ultima seduta in deflusso ({u}) dopo una seduta di segno opposto o nulla.': 'Latest session was an outflow ({u}) after a session of the opposite sign or flat.',
  'Serie di deflussi in corso': 'Current outflow streak',
  'Serie di afflussi in corso': 'Current inflow streak',
  'Serie in corso: {n} sedute consecutive di afflussi ({u}).': 'Current streak: {n} consecutive inflow sessions ({u}).',
  'Serie in corso: {n} sedute consecutive di deflussi ({u}).': 'Current streak: {n} consecutive outflow sessions ({u}).',
  'Dopo sedute con afflussi ≥ $500M ({n}) il rendimento mediano a 30 giorni è stato {a}, dopo deflussi ≤ −$500M ({m}) {b}, contro {c} di tutte le sedute: i grandi flussi tendono a seguire il prezzo più che anticiparlo. Campione piccolo.':
    'After sessions with inflows ≥ $500M ({n}) the median 30-day return was {a}, after outflows ≤ −$500M ({m}) {b}, versus {c} for all sessions: large flows tend to follow price rather than lead it. Small sample.',
  'Domanda istituzionale tramite ETF spot USA': 'Institutional demand through US spot ETFs',

  // ---------------------------------------------------------------- ETF: cards
  'Flussi giornalieri per emittente': 'Daily flows by issuer',
  'Milioni di USD per seduta · linea = cumulato dal lancio (asse destro)': 'USD millions per session · line = cumulative since launch (right axis)',
  'BTC stimati per seduta (flusso ÷ prezzo alle 16:00 di New York)': 'Estimated BTC per session (flow ÷ price at 4 pm New York)',
  "Creazioni e rimborsi netti di quote comunicati dagli emittenti (fonte Farside). L'ultima seduta è provvisoria: alcuni emittenti pubblicano il dato in ritardo e Farside può correggerlo.":
    'Net share creations and redemptions reported by issuers (source Farside). The latest session is provisional: some issuers publish late and Farside may correct the figure.',
  "Assorbimento dell'offerta": 'Supply absorption',
  'BTC netti degli ETF ÷ BTC emessi dai miner · finestra mobile 30 giorni': 'ETF net BTC ÷ BTC issued by miners · rolling 30 days',
  'BTC netti degli ETF vs BTC emessi, per mese': 'ETF net BTC vs BTC issued, by month',
  "Rapporto tra i BTC comprati (o venduti) in netto dagli ETF e i BTC nuovi creati dai miner nello stesso periodo (CoinMetrics IssTotNtv, ~450 BTC al giorno dopo il halving dell'aprile 2024). 2× = gli ETF hanno assorbito il doppio della nuova offerta; negativo = vendite nette.":
    'Ratio between the BTC bought (or sold) net by ETFs and the new BTC created by miners over the same period (CoinMetrics IssTotNtv, ~450 BTC per day after the April 2024 halving). 2× = ETFs absorbed twice the new supply; negative = net selling.',
  'Rapporto 30 giorni': '30-day ratio',
  'Dal lancio': 'Since launch',
  '{a} vs {b}': '{a} vs {b}',
  'Dal halving 2024': 'Since the 2024 halving',
  'Sedute con afflussi': 'Inflow sessions',
  'Su {n} sedute': 'Out of {n} sessions',
  Emittenti: 'Issuers',
  'Flussi netti cumulati e recenti (M$) · BTC stimati': 'Cumulative and recent net flows ($M) · estimated BTC',
  "GBTC è nato dalla conversione del trust Grayscale (circa 619K BTC già detenuti l'11 gennaio 2024): i suoi deflussi sono rimborsi di quote esistenti. Il controvalore in BTC è la somma di ogni flusso giornaliero diviso per il prezzo delle 16:00 di New York: non sono le detenzioni ufficiali.":
    'GBTC came from the conversion of the Grayscale trust (about 619K BTC already held on 11 January 2024): its outflows are redemptions of existing shares. The BTC equivalent is the sum of each daily flow divided by the 4 pm New York price: these are not the official holdings.',
  Cumulato: 'Cumulative',
  'BTC stimati': 'Estimated BTC',
  'Ultima seduta': 'Last session',
  '5 sedute': '5 sessions',
  '20 sedute': '20 sessions',
  'Massimo afflusso': 'Largest inflow',
  'Massimo deflusso': 'Largest outflow',
  '{a} – {b} · {u} · {c}': '{a} – {b} · {u} · {c}',
  'Serie e reazione del prezzo': 'Streaks and price reaction',
  'Sedute consecutive dello stesso segno · rendimenti dopo i grandi flussi': 'Consecutive sessions of the same sign · returns after large flows',
  'Serie in corso': 'Current streak',
  'Serie record di afflussi': 'Record inflow streak',
  'Serie record di deflussi': 'Record outflow streak',
  'Dopo sedute con': 'After sessions with',
  'Afflussi ≥ $500M': 'Inflows ≥ $500M',
  'Deflussi ≤ −$500M': 'Outflows ≤ −$500M',
  'Tutte le sedute': 'All sessions',
  'Mediana del rendimento di BTC (giorni di calendario) e quota di casi positivi. Giorni vicini si sovrappongono: campione piccolo, solo indicativo.':
    'Median BTC return (calendar days) and share of positive cases. Nearby days overlap: small sample, indicative only.',
  'Milioni di USD per emittente · totale in BTC stimato': 'USD millions by issuer · total in estimated BTC',
  Altri: 'Others',
  'Prezzo 16:00 NY': 'Price 4 pm NY',
  'Seduta del {d} provvisoria: gli emittenti comunicano i flussi nella serata USA e Farside può correggerli. Gli importi in BTC sono stime.':
    'Session of {d} is provisional: issuers report flows in the US evening and Farside may correct them. BTC amounts are estimates.',
  'In attesa: {l}.': 'Pending: {l}.',
  'Storico completo Farside non raggiungibile: storico dalla cache locale + ultime settimane dalla pagina recente.':
    'Full Farside history unreachable: history from the local cache + the last weeks from the recent page.',
  'Farside non raggiungibile: dati dalla cache locale (ultimo scaricamento {d}).': 'Farside unreachable: data from the local cache (last download {d}).',

  // ---------------------------------------------------------------- ETF: method
  "Fonte: Farside Investors (farside.co.uk), tabella completa dei flussi giornalieri per emittente dall'11 gennaio 2024, in milioni di USD; numeri tra parentesi = deflussi. Se la pagina completa non è raggiungibile si usa la cache locale più la pagina delle ultime settimane.":
    'Source: Farside Investors (farside.co.uk), full table of daily flows by issuer since 11 January 2024, in USD millions; numbers in brackets = outflows. If the full page cannot be reached, the local cache plus the recent-weeks page are used.',
  "BTC stimati = flusso in USD ÷ prezzo BTC alle 16:00 di New York (chiusura della candela oraria Binance), lo stesso orario del NAV; lo scarto rispetto al prezzo di riferimento degli emittenti è normalmente sotto l'1–2%. Emissione dei miner: CoinMetrics IssTotNtv.":
    'Estimated BTC = USD flow ÷ BTC price at 4 pm New York (close of the Binance hourly candle), the same time as the NAV; the gap to the issuers’ reference price is normally below 1–2%. Miner issuance: CoinMetrics IssTotNtv.',
  'Primo giorno 11 gen 2024: {v} (dato pubblicato +$655.3M).': 'First day 11 Jan 2024: {v} (published figure +$655.3M).',
  "{c} del {d}: {v} (valore riportato all'epoca {e}).": '{c} on {d}: {v} (value reported at the time {e}).',
  'Somma degli emittenti = colonna Total di Farside in {n} sedute su {m}; totale cumulato {s} vs riga Total {f}.':
    'Sum of issuers = Farside Total column in {n} of {m} sessions; cumulative total {s} vs Total row {f}.',
  'Stima in BTC verificata su IBIT (nessuna dotazione iniziale): {v} al {d}, contro circa 552K BTC detenuti secondo BlackRock.':
    'BTC estimate checked on IBIT (no seed holdings): {v} at {d}, versus about 552K BTC held according to BlackRock.',
  'Limiti: le detenzioni totali degli ETF non sono mostrate perché GBTC e il Mini Trust (BTC) sono nati da monete già esistenti e pagano commissioni in BTC; la fonte è uno scraping HTML (rischio di cambio layout, controllato a ogni download). Analisi a scopo di studio, non consulenza finanziaria.':
    'Limits: total ETF holdings are not shown because GBTC and the Mini Trust (BTC) started from existing coins and pay fees in BTC; the source is HTML scraping (layout-change risk, checked at every download). For study purposes, not financial advice.',

  // ---------------------------------------------------------------- ETF charts
  'Cumulato dal lancio': 'Cumulative since launch',
  'Cumulato dal lancio (stima)': 'Cumulative since launch (estimate)',
  'ETF ÷ emissione (30 giorni)': 'ETFs ÷ issuance (30 days)',
  "1× = tutta l'emissione": '1× = all issuance',
  Halving: 'Halving',
  'BTC netti ETF (stima)': 'ETF net BTC (estimate)',
  'BTC emessi dai miner': 'BTC issued by miners',
  'in corso': 'in progress',
  Rapporto: 'Ratio',

  // ---------------------------------------------------------------- attention
  'Visite {d}': 'Views {d}',
  'Pagina «Bitcoin» · en.wikipedia': '“Bitcoin” page · en.wikipedia',
  'Media 30 giorni': '30-day average',
  'Media 7 giorni {v}': '7-day average {v}',
  'Percentile storico': 'Historical percentile',
  'Media 30 giorni vs un anno fa': '30-day average vs one year ago',
  'Rispetto al picco': 'Versus peak',
  'Picco {v} · {d}': 'Peak {v} · {d}',
  'it.wikipedia · media 30 giorni': 'it.wikipedia · 30-day average',
  'Media degli ultimi 30 giorni {v} visite al giorno: {p} percentile dal 2015, zona «{z}», minimo dal {d}.':
    'Last 30-day average {v} views per day: {p} percentile since 2015, “{z}” zone, the lowest since {d}.',
  'È il {p}% del picco di attenzione del {d} ({v} al giorno in media; record giornaliero {r} il {rd}).':
    'That is {p}% of the attention peak of {d} ({v} per day on average; daily record {r} on {rd}).',
  '{y}: {n} giorni dopo': '{y}: {n} days after',
  '{y}: {n} giorni prima': '{y}: {n} days before',
  'Picco della media a 30 giorni rispetto al massimo di ciclo del prezzo — {l}.': 'Peak of the 30-day average relative to the price cycle high — {l}.',
  'In {n} cicli su {m} il picco di attenzione è arrivato più di 2 mesi prima del massimo del prezzo.': 'In {n} of {m} cycles the attention peak came more than 2 months before the price high.',
  'Storicamente, con attenzione in zona «{z}» il rendimento mediano di BTC a 90 giorni è stato {a} (positivi {h}%) contro {b} di tutti i giorni ({e} episodi).':
    'Historically, with attention in the “{z}” zone the median 90-day BTC return was {a} ({h}% positive) versus {b} for all days ({e} episodes).',
  'Misura quante persone leggono di Bitcoin, non se comprano o vendono: è un indicatore di attenzione, non di sentiment.':
    'It measures how many people read about Bitcoin, not whether they buy or sell: an attention indicator, not a sentiment one.',
  'Proxy di attenzione retail, non di sentiment · visite umane (agent=user) alla pagina «Bitcoin» di Wikipedia · ultimo dato {d}':
    'Retail attention proxy, not sentiment · human visits (agent=user) to the Wikipedia “Bitcoin” page · latest data {d}',
  'Attenzione vs prezzo': 'Attention vs price',
  'Visite giornaliere, media 30 giorni (scala log) · prezzo BTC (scala log)': 'Daily views, 30-day average (log scale) · BTC price (log scale)',
  'Interesse del pubblico per Bitcoin': 'Public interest in Bitcoin',
  'Picchi di attenzione e massimi di ciclo': 'Attention peaks and cycle highs',
  'Finestra da 365 giorni prima a 180 giorni dopo il massimo': 'Window from 365 days before to 180 days after the high',
  "Massimi di ciclo del prezzo dal modulo Cicli. Ritardo = giorni tra il massimo del prezzo e il picco dell'attenzione (negativo = l'attenzione ha raggiunto il picco prima).":
    'Price cycle highs from the Cycles module. Lag = days between the price high and the attention peak (negative = attention peaked first).',
  'Massimo di ciclo': 'Cycle high',
  'Picco media 30 giorni': '30-day average peak',
  Ritardo: 'Lag',
  'Picco giornaliero': 'Daily peak',
  'Rendimenti per zona di attenzione': 'Returns by attention zone',
  'Percentile della media 30 giorni senza lookahead · dal {d}': 'Percentile of the 30-day average without lookahead · since {d}',
  'Percentile calcolato ogni giorno solo sui dati disponibili fino a quel giorno (almeno un anno di storia). Rendimento mediano di BTC a 30/90/180 giorni e quota di casi positivi; il campione indipendente è il numero di episodi.':
    'Percentile computed each day only on the data available up to that day (at least one year of history). Median BTC return over 30/90/180 days and share of positive cases; the independent sample is the number of episodes.',
  'Giorni di massima attenzione': 'Peak attention days',
  'Primi 10 giorni per visite (episodi distanti almeno 30 giorni) e rendimento successivo di BTC': 'Top 10 days by views (episodes at least 30 days apart) and BTC forward return',
  Visite: 'Views',
  'Visite en.wikipedia (media 30 giorni)': 'en.wikipedia views (30-day average)',
  'Visite it.wikipedia (media 30 giorni)': 'it.wikipedia views (30-day average)',
  'Fonte: Wikimedia REST API (pageviews per articolo, accesso desktop + mobile, solo utenti umani), pagina «Bitcoin» di en.wikipedia e it.wikipedia, giornaliera dal 1 luglio 2015, con User-Agent descrittivo come richiesto da Wikimedia.':
    'Source: Wikimedia REST API (per-article pageviews, desktop + mobile access, human users only), “Bitcoin” page on en.wikipedia and it.wikipedia, daily since 1 July 2015, with a descriptive User-Agent as required by Wikimedia.',
  'Record giornaliero {d}: {v} visite, il noto picco di attenzione retail del dicembre 2017 (7–8 dic, ≈ 344K).':
    'Daily record {d}: {v} views, the well-known retail attention peak of December 2017 (7–8 Dec, ≈ 344K).',
  'Seconda fonte indipendente: il record di it.wikipedia cade il {d}, nello stesso episodio.': 'Independent second source: the it.wikipedia record falls on {d}, in the same episode.',
  'Limiti: il traffico di Wikipedia è in calo strutturale (motori di ricerca e assistenti AI rispondono direttamente), quindi i livelli recenti sono sottostimati rispetto al 2017; i percentili sono quindi bassi per costruzione negli ultimi anni. Indicatore di attenzione, non di sentiment né di flussi. Analisi a scopo di studio, non consulenza finanziaria.':
    'Limits: Wikipedia traffic is in structural decline (search engines and AI assistants answer directly), so recent levels are understated versus 2017 and percentiles are low by construction in recent years. An attention indicator, not sentiment or flows. For study purposes, not financial advice.',
}
export default en
