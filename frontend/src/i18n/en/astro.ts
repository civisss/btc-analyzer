// Astronomy & numbers page (pages/AstroPage.tsx + widgets/astro.tsx).
const en: Record<string, string> = {
  // page + tabs
  'Astronomia e numeri': 'Astronomy & numbers',
  'Luna, eclissi, pianeti, Sole e numeri «magici» messi alla prova sullo storico di BTC: uno studio statistico, non un segnale di trading.':
    'Moon, eclipses, planets, the Sun and “magic” numbers put to the test on BTC’s history: a statistical study, not a trading signal.',
  'Luna': 'Moon', 'Calendario': 'Calendar', 'Eclissi e superlune': 'Eclipses & supermoons', 'Pianeti e stagioni': 'Planets & seasons',
  'Sole e geomagnetismo': 'Sun & geomagnetism', 'Numeri': 'Numbers', 'Verdetti': 'Verdicts', 'Pianeti': 'Planets', 'Sole': 'Sun', 'Eclissi': 'Eclipses',
  'Riepilogo: quante ipotesi superano la prova del caso': 'Summary: how many hypotheses beat chance',
  'Apri la tabella dei verdetti →': 'Open the verdicts table →',

  // KPIs
  'Attivo': 'Active', 'Calmo': 'Quiet',
  'Luna adesso': 'Moon now', 'Illuminata {p}% · {a} giorni': '{p}% illuminated · {a} days old',
  'Prossima superluna': 'Next supermoon', 'Prossima luna piena': 'Next full moon', 'Prossima luna nuova': 'Next new moon',
  'Prossima eclissi': 'Next eclipse', 'Eclissi solare': 'Solar eclipse', 'Eclissi lunare': 'Lunar eclipse',
  'Mercurio': 'Mercury', 'Retrogrado': 'Retrograde', 'Diretto': 'Direct', 'Diretto tra {c}': 'Direct in {c}', 'Retrogrado dal {d}': 'Retrograde from {d}',
  'Ipotesi significative': 'Significant hypotheses', '{w} deboli · dopo correzione BH': '{w} weak · after BH correction',
  'Dopo correzione per test multipli': 'After multiple-testing correction',

  // moon tab
  'La Luna adesso': 'The Moon now', 'Calcolo astronomico aggiornato ogni secondo': 'Astronomical calculation updated every second',
  'Illuminata al {p}%': '{p}% illuminated', 'Età': 'Age', '{a} g': '{a} d', 'Elongazione': 'Elongation', 'Distanza': 'Distance',
  'Al caricamento': 'At load time', 'Ciclo sinodico': 'Synodic cycle', 'Medio': 'Mean', 'Prossime fasi': 'Next phases',
  'Superluna': 'Supermoon', 'Eclissi totale': 'Total eclipse',
  'BTC e fasi lunari': 'BTC and lunar phases', 'Candele giornaliere Binance · ultimi 3 anni': 'Binance daily candles · last 3 years',
  'Luna piena': 'Full moon', 'Luna nuova': 'New moon',
  'Rendimento medio per giorno del ciclo lunare': 'Average return by day of the lunar cycle',
  'Media giornaliera di BTC per ognuno dei 30 giorni del ciclo · barre fuori dalla banda grigia = insolite':
    'BTC daily average for each of the 30 days of the cycle · bars outside the grey band = unusual',
  'Ogni giorno del campione è assegnato a una delle 30 classi di 12° di elongazione Luna−Sole (a mezzogiorno UTC). La banda grigia contiene il 90% delle medie ottenute spostando a caso la serie dei rendimenti rispetto al calendario lunare: con 30 classi è normale che 3 barre su 30 ne escano per puro caso.':
    'Each day of the sample is assigned to one of 30 bins of 12° of Moon−Sun elongation (at 12:00 UTC). The grey band holds 90% of the averages obtained by randomly shifting the return series against the lunar calendar: with 30 bins it is normal for 3 bars out of 30 to fall outside it by pure chance.',
  'Percorso medio attorno a luna piena e nuova': 'Average path around full and new moons',
  'Variazione cumulata da 7 giorni prima a 7 giorni dopo · banda = placebo': 'Cumulative change from 7 days before to 7 days after · band = placebo',
  'Il percorso parte dalla chiusura dell’ottavo giorno prima della fase. La banda contiene il 90% dei percorsi medi ottenuti su date spostate a caso: un percorso dentro la banda non si distingue dal caso.':
    'The path starts from the close eight days before the phase. The band holds 90% of the average paths obtained on randomly shifted dates: a path inside the band cannot be told apart from chance.',
  'Metodo e fonti · Luna': 'Method & sources · Moon',
  'Fasi lunari calcolate con Astronomy Engine (teoria lunare troncata, accuratezza dichiarata ±1 minuto d’arco) e verificate contro le tabelle dell’US Naval Observatory: scarto medio {m} minuti su {n} fasi (la fonte arrotonda al minuto).':
    'Lunar phases computed with Astronomy Engine (truncated lunar theory, stated accuracy ±1 arcminute) and checked against the US Naval Observatory tables: mean difference {m} minutes over {n} phases (the source rounds to the minute).',
  'Rendimenti logaritmici giornalieri close-to-close (candele UTC) dal {s} a ieri. Effetto = rendimento medio delle finestre attorno agli eventi meno la media di tutte le finestre della stessa lunghezza. Il p-value viene da un placebo: le date degli eventi sono spostate rigidamente di ogni ampiezza possibile (almeno {k} giorni), così restano intatte sia la regolarità del calendario lunare sia i trend e la volatilità di BTC. IC 95% con {b} ricampionamenti bootstrap.':
    'Daily close-to-close log returns (UTC candles) from {s} to yesterday. Effect = average return of the windows around the events minus the average of all windows of the same length. The p-value comes from a placebo: event dates are rigidly shifted by every possible offset (at least {k} days), so both the regularity of the lunar calendar and BTC’s trends and volatility stay intact. 95% CI from {b} bootstrap resamples.',
  'Letteratura: Dichev e Janes (2003) e Yuan, Zheng e Zhu (2006) trovano rendimenti azionari più bassi attorno alla luna piena (3–5% annuo su 48 paesi), con effetti piccoli e instabili nei test successivi. L’illuminazione mostrata è calcolata nel browser con la serie di Meeus (cap. 48) ancorata al valore del server.':
    'Literature: Dichev & Janes (2003) and Yuan, Zheng & Zhu (2006) find lower stock returns around the full moon (3–5% a year across 48 countries), with small and unstable effects in later tests. The illumination shown is computed in the browser with the Meeus series (ch. 48) anchored to the server value.',

  // calendar tab
  'Eventi astronomici e date numeriche con il comportamento storico di BTC': 'Astronomical events and numeric dates with BTC’s historical behaviour',
  'A destra il verdetto dello studio per quel tipo di evento e il rendimento medio di BTC nella finestra attorno agli eventi passati, confrontato con una finestra qualsiasi. Non è una previsione: serve a sapere se quell’evento ha mai fatto differenza.':
    'On the right, the study’s verdict for that event type and BTC’s average return in the window around past events, compared with any window. It is not a forecast: it tells you whether that event has ever made a difference.',
  'Comportamento storico per tipo di evento': 'Historical behaviour by event type',
  'Finestra attorno all’evento contro una finestra qualsiasi della stessa durata': 'Window around the event vs any window of the same length',
  'Finestra': 'Window', 'Media eventi': 'Event mean', 'Normale': 'Normal', 'Rialzo eventi': 'Up (events)', 'Rialzo normale': 'Up (normal)',
  'Verdetto': 'Verdict', 'Giorno stesso': 'Same day', '±{k} g': '±{k} d', '+{a}..+{b} g': '+{a}..+{b} d',
  'Metodo e fonti · Calendario': 'Method & sources · Calendar',
  'Istanti in UTC. Fasi, eclissi, stazioni di Mercurio ed equinozi da Astronomy Engine, verificati contro USNO, catalogo NASA delle eclissi e JPL Horizons (vedi la scheda Verdetti). Le tempeste geomagnetiche compaiono solo se la previsione NOAA a 3 giorni indica Kp ≥ 5.':
    'Times in UTC. Phases, eclipses, Mercury stations and equinoxes from Astronomy Engine, checked against USNO, the NASA eclipse catalogue and JPL Horizons (see the Verdicts tab). Geomagnetic storms appear only when NOAA’s 3-day forecast shows Kp ≥ 5.',
  'Superluna: luna piena a meno di {km} km dal centro della Terra (definizione dichiarata; altre fonti usano il 90% del perigeo e contano più superlune).':
    'Supermoon: a full moon closer than {km} km to the Earth’s centre (stated definition; other sources use 90% of perigee and count more supermoons).',
  'Tra {c}': 'In {c}', '{km} km dalla Terra': '{km} km from Earth', 'nel giorno': 'on the day', 'durante il periodo': 'during the period',
  '{w}: {o} vs {b} · n={n}': '{w}: {o} vs {b} · n={n}', '{w}: {e} vs altri giorni · n={n}': '{w}: {e} vs other days · n={n}',

  // eclipses tab
  'Tipo': 'Type', 'Totalità': 'Totality', 'Futura': 'Upcoming',
  'Ogni luna rossa, una per una': 'Every blood moon, one by one',
  'Rendimento di BTC nei 7 giorni centrati su ogni eclissi lunare totale · linea = finestra normale': 'BTC return over the 7 days centred on each total lunar eclipse · line = normal window',
  'Con {n} eclissi totali nel campione il risultato è aneddotico per definizione: basta un singolo evento estremo a spostare la media.':
    'With {n} total eclipses in the sample the result is anecdotal by definition: a single extreme event is enough to move the average.',
  'Eclissi lunari': 'Lunar eclipses', '{n} eclissi dal 2010, più recenti prima': '{n} eclipses since 2010, most recent first', 'Eclissi solari': 'Solar eclipses',
  'Superlune': 'Supermoons', 'Lune piene a meno di {km} km': 'Full moons closer than {km} km',
  'Metodo e fonti · Eclissi': 'Method & sources · Eclipses',
  'Eclissi calcolate con Astronomy Engine e confrontate con il catalogo NASA GSFC (F. Espenak): tutte le {n} eclissi del 2010–2027 presenti, istante del massimo entro {m} minuti (la NASA usa il Tempo Dinamico, ~69 s avanti rispetto a UTC). Dove il tipo differisce (ibride 2013 e 2023, anulare non centrale del 29 apr 2014) si usa la classificazione NASA.':
    'Eclipses computed with Astronomy Engine and compared with the NASA GSFC catalogue (F. Espenak): all {n} eclipses of 2010–2027 present, time of greatest eclipse within {m} minutes (NASA uses Dynamical Time, ~69 s ahead of UTC). Where the type differs (the 2013 and 2023 hybrids, the non-central annular of 29 Apr 2014) the NASA classification is used.',
  '±3 g = rendimento logaritmico dalla chiusura di 4 giorni prima alla chiusura di 3 giorni dopo; +30 g = i 30 giorni successivi. Le eclissi sono date globali: non dipendono da dove sono visibili.':
    '±3 d = log return from the close 4 days before to the close 3 days after; +30 d = the following 30 days. Eclipses are global dates: they do not depend on where they are visible.',

  // planets tab
  'BTC e Mercurio retrogrado': 'BTC and Mercury retrograde',
  'Fasce viola = periodi in cui Mercurio sembra muoversi all’indietro visto dalla Terra': 'Violet bands = periods when Mercury appears to move backwards as seen from Earth',
  'Mercurio adesso': 'Mercury now', 'Retrogrado fino al {d}': 'Retrograde until {d}', 'Moto diretto': 'Direct motion', 'Stato': 'Status',
  'Torna diretto tra': 'Turns direct in', 'Retrogrado tra': 'Retrograde in', 'Prossimi periodi retrogradi': 'Next retrograde periods',
  'Il moto retrogrado è un effetto prospettico: la Terra «sorpassa» Mercurio sull’orbita interna circa tre volte l’anno. Gli istanti di stazione sono verificati contro JPL Horizons (scarto medio {m} minuti su {n} stazioni).':
    'Retrograde motion is a perspective effect: Earth and the inner-orbit Mercury “overtake” each other about three times a year. Station times are checked against JPL Horizons (mean difference {m} minutes over {n} stations).',
  'Periodi retrogradi recenti': 'Recent retrograde periods', 'Variazione di BTC dall’inizio alla fine di ogni periodo': 'BTC change from the start to the end of each period',
  'Periodo': 'Period', 'Giorni': 'Days',
  'Equinozi e solstizi recenti': 'Recent equinoxes and solstices', 'Rendimento di BTC nei 7 giorni centrati e nei 30 successivi': 'BTC return over the 7 centred days and the next 30',
  'Metodo e fonti · Pianeti': 'Method & sources · Planets',
  'Mercurio retrogrado = intervallo tra la stazione retrograda e la stazione diretta della longitudine eclittica apparente geocentrica (eclittica vera della data), calcolata con VSOP87 tramite Astronomy Engine e raffinata per bisezione. Il test confronta il rendimento medio giornaliero nei giorni retrogradi con quello degli altri giorni; il placebo trasla rigidamente l’intera maschera dei periodi.':
    'Mercury retrograde = the interval between the retrograde and the direct station of the apparent geocentric ecliptic longitude (true ecliptic of date), computed with VSOP87 through Astronomy Engine and refined by bisection. The test compares the average daily return on retrograde days with that of the other days; the placebo rigidly shifts the whole mask of periods.',
  'Equinozi e solstizi verificati contro USNO: scarto massimo {m} minuti. Letteratura: uno studio su 48 paesi (1973–2019) riporta rendimenti azionari più bassi durante Mercurio retrogrado, altri studi trovano effetti opposti o solo sulla volatilità.':
    'Equinoxes and solstices checked against USNO: maximum difference {m} minutes. Literature: a 48-country study (1973–2019) reports lower stock returns during Mercury retrograde; other studies find opposite effects or effects on volatility only.',

  // sun tab
  'Ciclo solare e prezzo di BTC': 'Solar cycle and BTC price',
  'Numero di macchie solari (SILSO via GFZ) e previsione NOAA, con BTC in scala logaritmica': 'Sunspot number (SILSO via GFZ) and NOAA forecast, with BTC on a log scale',
  'Massimo solare': 'Solar maximum', 'Media 13 mesi {v}': '13-month mean {v}', 'Picco BTC del ciclo': 'BTC cycle peak',
  'Perché serve il placebo: il test classico dà p = {np}, ma le due serie sono lisce e il campione copre solo {c} cicli solari. Spostando una serie rispetto all’altra si ottengono correlazioni così grandi per puro caso nel {p}% dei casi.':
    'Why the placebo matters: the classic test gives p = {np}, but both series are smooth and the sample covers only {c} solar cycles. Shifting one series against the other produces correlations this large by pure chance in {p}% of cases.',
  'Dati solari non disponibili': 'Solar data unavailable',
  'Indice geomagnetico Kp': 'Geomagnetic Kp index',
  'Valori a 3 ore NOAA SWPC e previsione a 3 giorni · G1 = tempesta minore': 'NOAA SWPC 3-hour values and 3-day forecast · G1 = minor storm',
  '{n} giorni': '{n} days', 'Kp ≥ 5 · {g} con Kp ≥ 7': 'Kp ≥ 5 · {g} with Kp ≥ 7',
  'Metodo e fonti · Sole': 'Method & sources · Sun',
  'Kp, Ap e numero di macchie solari giornaliero dall’archivio GFZ Potsdam (Kp_ap_Ap_SN_F107, licenza CC BY 4.0; SN © SILSO, Royal Observatory of Belgium). La media mensile ricavata da GFZ coincide con la serie mensile SILSO entro {d} macchie in media. Kp in tempo reale e previsioni da NOAA SWPC.':
    'Kp, Ap and daily sunspot number from the GFZ Potsdam archive (Kp_ap_Ap_SN_F107, CC BY 4.0 licence; SN © SILSO, Royal Observatory of Belgium). The monthly mean derived from GFZ matches the SILSO monthly series within {d} spots on average. Real-time Kp and forecasts from NOAA SWPC.',
  'Tempesta = giorno con Kp massimo ≥ 5 (G1 o superiore) preceduto da 7 giorni senza tempeste; finestra dei 6 giorni successivi come in Krivelyova e Robotti (2003). Ciclo solare: correlazione mensile tra media a 13 mesi delle macchie e rendimento di BTC sui 12 mesi precedenti; con 1–2 cicli solari nel campione qualsiasi correlazione è fragile, per questo il p-value viene da un placebo a traslazione e non dal test classico.':
    'Storm = a day with maximum Kp ≥ 5 (G1 or higher) preceded by 7 storm-free days; window of the following 6 days as in Krivelyova & Robotti (2003). Solar cycle: monthly correlation between the 13-month sunspot mean and BTC’s return over the previous 12 months; with 1–2 solar cycles in the sample any correlation is fragile, which is why the p-value comes from a shift placebo rather than the classic test.',

  // numbers tab
  'Offerta massima': 'Maximum supply', 'Non 21M esatti: ogni dimezzamento arrotonda al satoshi': 'Not exactly 21M: every halving rounds down to the satoshi',
  'Emessi finora (teorici)': 'Issued so far (scheduled)', '{p}% del totale · blocco {h}': '{p}% of the total · block {h}',
  'Ricompensa per blocco': 'Block subsidy', 'Epoca {e} · dimezza ogni {n} blocchi': 'Epoch {e} · halves every {n} blocks',
  'Prossimo halving': 'Next halving', '{d} (stima) · tra {c}': '{d} (estimate) · in {c}',
  'Satoshi per 1 dollaro': 'Satoshis per dollar', '1 BTC = 100,000,000 satoshi · prezzo live': '1 BTC = 100,000,000 satoshis · live price',
  'Blocco e difficoltà': 'Blocks & difficulty', '{s} min': '{s} min', 'Difficoltà ricalcolata ogni {n} blocchi (~2 settimane)': 'Difficulty retargeted every {n} blocks (~2 weeks)',
  'Blocco genesi': 'Genesis block', 'Blocco 0 · ricompensa non spendibile': 'Block 0 · unspendable reward',
  'Pizza day': 'Pizza day', '{n} BTC per due pizze il {d}': '{n} BTC for two pizzas on {d}',
  'I numeri di Bitcoin': 'Bitcoin’s numbers', 'Costanti del protocollo e valori calcolati dall’altezza attuale dei blocchi': 'Protocol constants and values computed from the current block height',
  'Le costanti (offerta massima, 210,000 blocchi per halving, 10 minuti, 2016 blocchi) vengono dalle regole di consenso del codice di Bitcoin. L’emissione è quella programmata dal blocco corrente: non sottrae le monete perse o mai riscosse.':
    'The constants (maximum supply, 210,000 blocks per halving, 10 minutes, 2016 blocks) come from the consensus rules in Bitcoin’s code. Issuance is the scheduled amount up to the current block: lost or never-claimed coins are not subtracted.',
  'Halving {n}': 'Halving {n}', 'Ricompensa dopo: {r} BTC': 'Subsidy after: {r} BTC',
  'Livelli testati vs {n} griglie di controllo': 'Tested levels vs {n} control grids',
  'Profondità dei ritracciamenti': 'Retracement depth', 'Durata di una gamba rispetto alla precedente': 'Leg duration relative to the previous one',
  'Ritracciamento di ogni gamba del zigzag (3 ATR) · in viola le classi vicine ai livelli di Fibonacci': 'Retracement of each zigzag leg (3 ATR) · violet = bins near the Fibonacci levels',
  'Rapporto tra durate consecutive · in viola le classi vicine ai rapporti di Fibonacci': 'Ratio of consecutive durations · violet = bins near the Fibonacci ratios',
  'Prezzo': 'Price', 'Tempo': 'Time',
  'Prime chiusure sopra le potenze di 10': 'First closes above powers of 10', 'Giorni impiegati per moltiplicare il prezzo per 10': 'Days it took to multiply the price by 10',
  'Livello': 'Level', 'Prima chiusura': 'First close', 'Giorni ×10': 'Days ×10', 'Non ancora': 'Not yet',
  'Prezzi a cifre ripetute': 'Repeated-digit prices', 'Primo giorno in cui il massimo ha toccato il livello · {n} su {m} raggiunti': 'First day the high touched the level · {n} of {m} reached',
  'Date palindrome': 'Palindromic dates', 'GGMMAAAA che si legge uguale al contrario · curiosità, nessuna statistica': 'DDMMYYYY that reads the same backwards · trivia, no statistics',
  'Metodo e fonti · Numeri': 'Method & sources · Numbers',
  'Livelli tondi (ispirato a Osler 2003, che documenta ordini take-profit concentrati sui numeri tondi e stop-loss appena oltre): ogni giorno si considera il primo livello sopra e sotto la chiusura precedente; se il massimo (minimo) lo tocca ma la chiusura resta dal lato di partenza, il tocco è «respinto». Il passo cresce con l’ordine di grandezza del prezzo (principali: 500, 5K, 50K; secondari: 100, 1K, 10K). Il controllo usa {n} griglie con lo stesso passo spostate a caso: se i numeri tondi fossero speciali, respingerebbero più spesso delle griglie casuali.':
    'Round levels (inspired by Osler 2003, who documents take-profit orders clustering at round numbers and stop-losses just beyond them): each day we take the first level above and below the previous close; if the high (low) touches it but the close stays on the starting side, the touch is “rejected”. The step grows with the price’s order of magnitude (major: 500, 5K, 50K; minor: 100, 1K, 10K). The control uses {n} grids with the same step shifted at random: if round numbers were special, they would reject more often than random grids.',
  'Quadrato del 9: livelli in cui la radice quadrata del prezzo è un multiplo di 2 (un giro completo della spirale di Gann). Fibonacci: gambe del zigzag a 3 ATR su candele giornaliere; un ritracciamento è «Fibonacci» se cade entro ±2.5 punti da 23.6/38.2/50/61.8/78.6%; per il tempo, entro ±8% da 0.382/0.618/1/1.618/2.618. Controllo: {n} insiemi di 5 rapporti casuali con spaziatura simile. Urquhart (2017) trova che oltre il 10% dei prezzi di BTC termina in 00, ma senza effetti sui rendimenti successivi.':
    'Square of 9: levels where the square root of the price is a multiple of 2 (one full turn of Gann’s spiral). Fibonacci: legs of a 3-ATR zigzag on daily candles; a retracement is “Fibonacci” if it ends within ±2.5 points of 23.6/38.2/50/61.8/78.6%; for time, within ±8% of 0.382/0.618/1/1.618/2.618. Control: {n} sets of 5 random ratios with similar spacing. Urquhart (2017) finds that over 10% of BTC prices end in 00, but with no effect on subsequent returns.',
  'Venerdì 13: rendimento del giorno stesso; il placebo sposta le date di settimane intere per confrontare venerdì con venerdì.':
    'Friday the 13th: return on the day itself; the placebo shifts dates by whole weeks so Fridays are compared with Fridays.',

  // verdicts tab
  'Tutte le ipotesi': 'All hypotheses', '{n} ipotesi testate sullo storico di BTC dal {s} · verdetto calcolato dai dati': '{n} hypotheses tested on BTC’s history since {s} · verdict computed from the data',
  'Verdetto: con meno di {m} eventi «aneddotico»; p corretto (Benjamini-Hochberg) < 0.05 e stabile = significativo e stabile; p < 0.05 ma non dopo la correzione, o instabile = debole; altrimenti nessun effetto distinguibile dal caso.':
    'Verdict: fewer than {m} events = “anecdotal”; corrected p (Benjamini-Hochberg) < 0.05 and stable = significant and stable; p < 0.05 but not after correction, or unstable = weak; otherwise no effect distinguishable from chance.',
  'Ipotesi': 'Hypothesis', 'Gruppo': 'Group', 'Effetto': 'Effect', 'IC 95%': '95% CI', 'p BH': 'BH p', 'Stabile': 'Stable',
  'Verifica dei calendari': 'Calendar verification', 'Ogni calendario calcolato confrontato con una seconda fonte indipendente': 'Each computed calendar compared with an independent second source',
  'Seconda fonte': 'Second source', 'Scarto medio assoluto': 'Mean absolute difference', 'Scarto massimo': 'Max difference',
  'mancanti {n}': 'missing {n}', 'classificazioni diverse {n}': 'different classifications {n}', 'Verifica non disponibile': 'Verification unavailable',
  'Le eclissi NASA sono in Tempo Dinamico (circa 69 secondi avanti rispetto a UTC): lo scarto di circa un minuto è quasi tutto questa differenza di scala dei tempi. USNO arrotonda al minuto.':
    'NASA eclipse times are in Dynamical Time (about 69 seconds ahead of UTC): the difference of about one minute is almost entirely this time-scale offset. USNO rounds to the minute.',
  'Cosa dice la letteratura': 'What the literature says', 'Studi accademici e retest indipendenti': 'Academic studies and independent retests',
  'Metodo generale': 'General method',
  'Campione: rendimenti giornalieri logaritmici di BTC dal {s} al {e} ({n} giorni; la candela di oggi è esclusa perché incompleta). Ogni ipotesi è stata fissata prima di guardare i risultati (finestre ±3 giorni per gli eventi, 6 giorni dopo le tempeste come in letteratura) per evitare di scegliere la finestra più favorevole.':
    'Sample: BTC daily log returns from {s} to {e} ({n} days; today’s candle is excluded because it is incomplete). Every hypothesis was fixed before looking at the results (±3-day windows for events, 6 days after storms as in the literature) to avoid picking the most favourable window.',
  'Placebo: le date degli eventi (o la maschera dei periodi) vengono traslate rigidamente di ogni ampiezza possibile; il p-value è la quota di traslazioni con un effetto almeno altrettanto grande in valore assoluto. Così si confronta l’evento con date «finte» che hanno la stessa struttura e lo stesso mercato. Con {n} ipotesi, circa una risulterebbe significativa al 5% per puro caso: per questo i p sono corretti con Benjamini-Hochberg.':
    'Placebo: event dates (or the period mask) are rigidly shifted by every possible offset; the p-value is the share of shifts with an effect at least as large in absolute value. This compares the event with “fake” dates that have the same structure and the same market. With {n} hypotheses, about one would be significant at 5% by pure chance: that is why p-values are corrected with Benjamini-Hochberg.',
  'Stabilità: lo stesso segno nelle due metà del campione e in almeno il 75% dei cicli dell’halving con almeno 3 eventi. Fonti dati: Astronomy Engine (MIT), USNO, NASA GSFC, JPL Horizons, GFZ Potsdam, SILSO, NOAA SWPC; prezzi da Bitstamp e Binance.':
    'Stability: the same sign in both halves of the sample and in at least 75% of the halving cycles with at least 3 events. Data sources: Astronomy Engine (MIT), USNO, NASA GSFC, JPL Horizons, GFZ Potsdam, SILSO, NOAA SWPC; prices from Bitstamp and Binance.',
  'Fasi lunari': 'Lunar phases', 'Stazioni di Mercurio': 'Mercury stations', 'Distanza Luna (superlune)': 'Moon distance (supermoons)', 'Macchie solari mensili': 'Monthly sunspots',
  'USNO Astronomical Applications API': 'USNO Astronomical Applications API',
  'NASA GSFC Eclipse Web Site (F. Espenak)': 'NASA GSFC Eclipse Web Site (F. Espenak)',
  'NASA JPL Horizons (DE441), longitudine eclittica apparente geocentrica': 'NASA JPL Horizons (DE441), apparent geocentric ecliptic longitude',
  'NASA JPL Horizons, distanza geocentrica della Luna agli istanti di luna piena': 'NASA JPL Horizons, geocentric Moon distance at full-moon times',
  'SILSO (Royal Observatory of Belgium), numero di macchie solari mensile': 'SILSO (Royal Observatory of Belgium), monthly sunspot number',
  'USNO pubblica gli istanti arrotondati al minuto: scarti ≤ 1 minuto sono pari alla risoluzione della fonte.': 'USNO publishes times rounded to the minute: differences ≤ 1 minute equal the source’s resolution.',
  "NASA riporta l'istante del massimo in TD (Tempo Dinamico); la differenza TD−UT (~69 s) è inclusa nello scarto.": 'NASA gives the time of greatest eclipse in TD (Dynamical Time); the TD−UT offset (~69 s) is included in the difference.',
  "NASA riporta l'istante del massimo in TD (Tempo Dinamico); la differenza TD−UT (~69 s) è inclusa nello scarto. Un solo tipo diverso: 29 apr 2014, anulare non centrale per NASA, parziale per il calcolo; l'app usa la classificazione NASA (anche per le ibride del 3 nov 2013 e del 20 apr 2023).":
    'NASA gives the time of greatest eclipse in TD (Dynamical Time); the TD−UT offset (~69 s) is included in the difference. Only one type differs: 29 Apr 2014, a non-central annular for NASA, partial in the calculation; the app uses the NASA classification (also for the hybrids of 3 Nov 2013 and 20 Apr 2023).',
  "Istante di stazione su Horizons ricavato con passo di 10 minuti (risoluzione ±5 minuti). Vicino alla stazione il moto apparente è quasi nullo, per cui l'istante è molto sensibile a piccole differenze di posizione.":
    'Station time on Horizons derived with a 10-minute step (±5-minute resolution). Near a station the apparent motion is almost zero, so the time is very sensitive to tiny position differences.',
  'GFZ ridistribuisce il SN giornaliero SILSO: gli scarti residui sono dovuti ai valori provvisori più recenti.': 'GFZ redistributes the SILSO daily SN: the residual differences come from the latest provisional values.',

  // literature
  'Dichev e Janes (2003)': 'Dichev & Janes (2003)',
  'Rendimenti azionari nei 15 giorni attorno alla luna nuova circa doppi rispetto alla luna piena, su un secolo di dati USA e 24 paesi; nessun effetto su volatilità e volumi.':
    'Stock returns in the 15 days around new moons roughly double those around full moons, over a century of US data and 24 countries; no effect on volatility or volume.',
  'Yuan, Zheng e Zhu (2006)': 'Yuan, Zheng & Zhu (2006)',
  'Su 48 paesi rendimenti più bassi di 3–5% annuo attorno alla luna piena, non spiegati da volatilità, volumi o annunci macro.':
    'Across 48 countries, returns 3–5% a year lower around the full moon, not explained by volatility, volume or macro announcements.',
  'CXO Advisory (retest S&P 500 1990–2018)': 'CXO Advisory (S&P 500 retest 1990–2018)',
  'Le finestre attorno alla luna nuova battono quelle attorno alla piena, ma l’effetto è piccolo rispetto alla volatilità e instabile tra sottoperiodi.':
    'Windows around new moons beat those around full moons, but the effect is small relative to volatility and unstable across subperiods.',
  'Krivelyova e Robotti (2003)': 'Krivelyova & Robotti (2003)',
  'Forte attività geomagnetica seguita da rendimenti più bassi nella settimana successiva su molti indici; il vantaggio sparisce con i costi di transazione.':
    'Strong geomagnetic activity followed by lower returns in the next week on many indices; the edge disappears after transaction costs.',
  'Osler (2003)': 'Osler (2003)',
  'Nel mercato dei cambi gli ordini take-profit si concentrano sui numeri tondi e gli stop-loss appena oltre: spiegazione microstrutturale di supporti e resistenze.':
    'In FX, take-profit orders cluster at round numbers and stop-losses just beyond them: a microstructure explanation of support and resistance.',
  'Urquhart (2017)': 'Urquhart (2017)',
  'Bitcoin mostra raggruppamento dei prezzi sui numeri tondi, ma nessun andamento particolare dei rendimenti dopo averli toccati.':
    'Bitcoin shows price clustering at round numbers, but no particular return pattern after touching them.',
  'Studi su Mercurio retrogrado': 'Mercury retrograde studies',
  'Uno studio su 48 paesi (1973–2019) riporta rendimenti più bassi di circa 3% annuo; altri trovano effetti opposti o solo sulla volatilità.':
    'A 48-country study (1973–2019) reports returns about 3% a year lower; others find opposite effects or effects on volatility only.',
  'Ritracciamenti di Fibonacci': 'Fibonacci retracements',
  'I ritracciamenti seguono una distribuzione continua senza picchi significativi sui rapporti di Fibonacci; zone Fibonacci e non-Fibonacci non differiscono.':
    'Retracements follow a continuous distribution with no significant peaks at Fibonacci ratios; Fibonacci and non-Fibonacci zones do not differ.',
  'Macchie solari e borsa': 'Sunspots and stocks',
  'Su dati 1871–2018 nessuna relazione affidabile tra macchie solari e rendimenti dell’S&P 500, con l’avvertenza che 14 cicli sono pochi.':
    'On 1871–2018 data, no reliable relationship between sunspots and S&P 500 returns, with the caveat that 14 cycles are few.',

  // verdicts & units
  'Effetto significativo e stabile': 'Significant and stable effect', 'Effetto debole': 'Weak effect',
  'Effetto debole e instabile': 'Weak and unstable effect',
  'Nessun effetto distinguibile dal caso': 'No effect distinguishable from chance', 'Troppo pochi casi: aneddotico': 'Too few cases: anecdotal',
  'Effetto debole: non regge alla correzione per test multipli': 'Weak effect: does not survive multiple-testing correction',
  'Caso': 'Chance', 'Debole': 'Weak', 'Significativo': 'Significant', 'Aneddotico': 'Anecdotal',
  'rendimento cumulato della finestra': 'cumulative window return', 'punti percentuali al giorno': 'percentage points per day',
  'punti percentuali di frequenza': 'percentage points of frequency', 'coefficiente di correlazione': 'correlation coefficient',
  '1ª metà': '1st half', '2ª metà': '2nd half', '{e} episodi · {d} giorni': '{e} episodes · {d} days', 'Tocchi dei livelli': 'Level touches',
  'Mesi': 'Months', 'Eventi': 'Events', 'Effetto vs controllo': 'Effect vs control', 'Placebo 90%': 'Placebo 90%',
  'p-value del placebo (bilaterale)': 'Placebo p-value (two-sided)', 'p corretto per test multipli (Benjamini-Hochberg)': 'p corrected for multiple tests (Benjamini-Hochberg)',
  'Rialzo': 'Up', 'Quota in rialzo vs normale {b}%': 'Share up vs normal {b}%', 'p ingenuo': 'Naive p', 'Osservato': 'Observed',
  'p del test t classico, che ignora l’autocorrelazione delle serie': 'p of the classic t-test, which ignores the series’ autocorrelation',
  'Controllo {b}': 'Control {b}', 'Stabilità: metà del campione e cicli dell’halving': 'Stability: sample halves and halving cycles',

  // charts
  'Media giornaliera': 'Daily mean', 'Banda placebo 90%': '90% placebo band', 'Giorno {d} del ciclo · elongazione {e}°': 'Cycle day {d} · elongation {e}°',
  'Nuova': 'New', 'Primo quarto': 'First quarter', 'Piena': 'Full', 'Ultimo quarto': 'Last quarter', 'Mediana placebo': 'Placebo median',
  'Mercurio retrogrado': 'Mercury retrograde', 'Macchie solari (mensile)': 'Sunspots (monthly)', 'Media a 13 mesi': '13-month mean',
  'Previsione NOAA': 'NOAA forecast', 'BTC (scala log)': 'BTC (log scale)', 'Kp osservato': 'Observed Kp', 'Livelli testati': 'Tested levels',

  // hypotheses
  'Metà nuova vs metà piena del ciclo': 'New half vs full half of the cycle', 'Eclissi lunari totali (luna rossa)': 'Total lunar eclipses (blood moon)',
  'Tutte le eclissi lunari': 'All lunar eclipses', 'Equinozi e solstizi': 'Equinoxes and solstices', 'Venerdì 13': 'Friday the 13th',
  'Tempeste geomagnetiche': 'Geomagnetic storms', 'Ciclo solare (macchie solari)': 'Solar cycle (sunspots)', 'Livelli tondi principali': 'Major round levels',
  'Livelli tondi secondari': 'Minor round levels', 'Quadrato del 9 di Gann': 'Gann’s Square of 9', 'Fibonacci nel tempo': 'Fibonacci in time',
  'Rendimento di BTC nei 7 giorni centrati sulla luna piena (da −3 a +3) contro 7 giorni qualsiasi.': 'BTC return over the 7 days centred on the full moon (−3 to +3) vs any 7 days.',
  'Rendimento di BTC nei 7 giorni centrati sulla luna nuova (da −3 a +3) contro 7 giorni qualsiasi.': 'BTC return over the 7 days centred on the new moon (−3 to +3) vs any 7 days.',
  'Rendimento medio giornaliero nella metà del ciclo vicina alla luna nuova meno quello della metà vicina alla luna piena (Dichev e Janes 2003).':
    'Average daily return in the half of the cycle nearest the new moon minus that of the half nearest the full moon (Dichev & Janes 2003).',
  'Lune piene a meno di 360,000 km dalla Terra: rendimento nei 7 giorni centrati contro 7 giorni qualsiasi.': 'Full moons closer than 360,000 km to Earth: return over the 7 centred days vs any 7 days.',
  'Rendimento nei 7 giorni centrati sulle eclissi lunari totali (la luna «rossa») contro 7 giorni qualsiasi.': 'Return over the 7 days centred on total lunar eclipses (the “blood” moon) vs any 7 days.',
  'Rendimento nei 7 giorni centrati su ogni eclissi lunare (penombrale, parziale o totale).': 'Return over the 7 days centred on every lunar eclipse (penumbral, partial or total).',
  'Rendimento nei 7 giorni centrati su ogni eclissi solare (parziale, anulare, totale o ibrida).': 'Return over the 7 days centred on every solar eclipse (partial, annular, total or hybrid).',
  'Rendimento medio giornaliero nei giorni di Mercurio retrogrado meno quello degli altri giorni.': 'Average daily return on Mercury-retrograde days minus that of the other days.',
  'Rendimento nei 7 giorni centrati su equinozi e solstizi contro 7 giorni qualsiasi.': 'Return over the 7 days centred on equinoxes and solstices vs any 7 days.',
  'Rendimento di BTC nel venerdì 13 contro un giorno qualsiasi; il placebo sposta le date di settimane intere.': 'BTC return on Friday the 13th vs any day; the placebo shifts dates by whole weeks.',
  'Rendimento nei 6 giorni dopo l’inizio di una tempesta (Kp ≥ 5, almeno 7 giorni di quiete prima) contro 6 giorni qualsiasi (Krivelyova e Robotti 2003).':
    'Return over the 6 days after a storm begins (Kp ≥ 5, at least 7 quiet days before) vs any 6 days (Krivelyova & Robotti 2003).',
  'Correlazione tra macchie solari (media a 13 mesi) e rendimento di BTC sui 12 mesi precedenti.': 'Correlation between sunspots (13-month mean) and BTC’s return over the previous 12 months.',
  'Quota di tocchi respinti ai livelli tondi principali (passo 500, 5K, 50K) contro griglie identiche spostate a caso.': 'Share of rejected touches at major round levels (step 500, 5K, 50K) vs identical grids shifted at random.',
  'Quota di tocchi respinti ai livelli tondi secondari (passo 100, 1K, 10K) contro griglie identiche spostate a caso.': 'Share of rejected touches at minor round levels (step 100, 1K, 10K) vs identical grids shifted at random.',
  'Quota di tocchi respinti ai livelli del quadrato del 9 (radice del prezzo multipla di 2, un giro completo) contro griglie spostate a caso.':
    'Share of rejected touches at Square-of-9 levels (square root of price a multiple of 2, one full turn) vs grids shifted at random.',
  'Quota di ritracciamenti che terminano entro ±2.5 punti da 23.6, 38.2, 50, 61.8 o 78.6% contro insiemi di 5 rapporti casuali.': 'Share of retracements ending within ±2.5 points of 23.6, 38.2, 50, 61.8 or 78.6% vs sets of 5 random ratios.',
  'Quota di gambe la cui durata sta entro ±8% di 0.382, 0.618, 1, 1.618 o 2.618 volte la gamba precedente contro insiemi casuali.': 'Share of legs lasting within ±8% of 0.382, 0.618, 1, 1.618 or 2.618 times the previous leg vs random sets.',

  // event labels
  'Eclissi lunare totale': 'Total lunar eclipse', 'Mercurio diventa retrogrado': 'Mercury turns retrograde', 'Mercurio torna diretto': 'Mercury turns direct',
  'Equinozio di marzo': 'March equinox', 'Solstizio di giugno': 'June solstice', 'Equinozio di settembre': 'September equinox', 'Solstizio di dicembre': 'December solstice',
  'Tempesta geomagnetica prevista': 'Forecast geomagnetic storm',
  'Luna crescente': 'Waxing crescent', 'Gibbosa crescente': 'Waxing gibbous', 'Gibbosa calante': 'Waning gibbous', 'Luna calante': 'Waning crescent',
  'Penombrale': 'Penumbral', 'Parziale': 'Partial', 'Anulare': 'Annular', 'Totale': 'Total', 'Ibrida': 'Hybrid',
  'Punto = effetto osservato · linea = IC 95% (bootstrap, eventi indipendenti) · fascia grigia = 90% degli effetti placebo · tratteggio = zero':
    'Dot = observed effect · line = 95% CI (bootstrap, independent events) · grey band = 90% of placebo effects · dashed = zero',
  'periodo': 'period', '{w}: {e} vs normale · n={n}': '{w}: {e} vs normal · n={n}',
  'Candele giornaliere Binance · trascina per risalire fino a 3 anni': 'Binance daily candles · drag to go back up to 3 years',
  'Verifica eseguita il {d} con lo script di controllo del progetto; i calendari futuri usano lo stesso motore.': 'Check run on {d} with the project’s verification script; future calendars use the same engine.',
  'Ultime tempeste': 'Latest storms', 'Inizio': 'Start', 'BTC nei 6 giorni dopo': 'BTC over the next 6 days',
  'Picco BTC del ciclo = massima chiusura entro 600 giorni da ogni halving. Massimo solare = massimo della media mobile a 13 mesi delle macchie.':
    'BTC cycle peak = highest close within 600 days of each halving. Solar maximum = peak of the 13-month moving average of sunspots.',
  'Quota del disco illuminata': 'Illuminated share of the disc',
}
export default en
