# Bitcoin Analyzer — Proposte di evoluzione (revisione del 13 ottobre 2026)

> Revisione **in sola lettura** del codice (`backend/app`, `frontend/src`, `CONTRACT.md`, `README.md`) e dell'istanza di sviluppo
> (`http://localhost:8000`). Nessun file del progetto è stato modificato.
>
> **Regola seguita (richiesta del proprietario):** in lista principale entrano solo funzioni con dati **scaricati e ispezionati davvero
> oggi**, confrontati con una seconda fonte o con un valore pubblico noto. Ciò che non supera questo filtro è nella sezione
> **"Da valutare"** con il motivo. Le stime (modelli, proxy) sono dichiarate come tali e vanno etichettate nell'interfaccia.

---

## 1. Cosa esiste oggi (mappa sintetica)

| Area | Contenuto | Fonti |
|---|---|---|
| Mercato / grafici | candele 15m–1w, indicatori, pivot, zigzag ATR, zone S/R, Fibonacci | Binance spot/futures, Bitstamp (daily dal 2011), CoinMetrics (prezzo dal 2010) |
| Cicli | massimi/minimi di ciclo, durate adattive, power law, rainbow, Pi Cycle, Mayer, 2y MA, overlay | CoinMetrics + daily lungo |
| Ciclo avanzato | Cycle Score 0–100 senza lookahead, Hash Ribbons, Puell, "stesso giorno del ciclo", sopravvivenza durate, ciclo della leva | CoinMetrics, Binance |
| Pivot temporali | stagionalità completa, date pivot ricorrenti con test binomiale, pivot di ciclo, Fibonacci time, calendario di confluenza | prezzi |
| Struttura (stile KillaXBT / LP_NXT) | Monday range, aperture W/M/Q/Y, range HTF, deviazioni/SFP, BOS/CHoCH, statistiche esiti, piano scenari condizionali | prezzi |
| Frattali / Analoghi / Pattern da immagine | Pearson + DTW, 17 feature spiegabili, somiglianza grafica a 6 componenti, estrazione candele da screenshot | prezzi |
| Liquidità | heatmap stimata delle liquidazioni (modello OI 15m), pool di liquidità, liquidazioni reali | Binance (OI, forceOrder WS) |
| Flussi | taker buy/sell spot vs perp, delta, CVD | Binance |
| Derivati / Posizionamento | funding, OI, long/short, premio perp; opzioni Deribit (OI per strike, max pain, skew 25Δ, term structure IV, DVOL, gamma); STH/LTH (costo medio, MVRV, SOPR); sentiment composito contrarian con backtest; Coinbase premium | Binance, Deribit, BGeometrics (ritardo 7 g), Coinbase, alternative.me |
| USDT / stablecoin | USDT.D ricostruita, analoghi visivi della USDT.D, SSR, mint/burn | CoinMetrics, CoinGecko, DefiLlama |
| Macro | DXY, SPX, NDX, oro, US10Y, VIX, ETH/BTC, correlazioni, FRED opzionale | Yahoo, Binance, FRED (chiave) |
| Eventi | FOMC/CPI/NFP/elezioni/scadenze opzioni/halving con reazione storica | calendari |
| Previsioni + affidabilità | ensemble LightGBM + Monte Carlo + analoghi di ciclo, calibrazione conforme, track record live/backtest | feature store point-in-time |
| Agenti / avvisi / AI | 28 agenti su bus di messaggi, motore avvisi a regole, insight e chat con LLM locale, traduzione IT→EN | — |

La copertura di "prezzo, tempo, struttura, cicli, frattali" è già molto ampia. **Le lacune vere sono sul lato domanda/offerta reale**
(ETF, riserve degli exchange, posizionamento istituzionale CME, leva aggregata su più exchange) e **sul lato "studio"**
(tornare indietro nel tempo, prendere appunti, ricevere un report).

---

## 2. Gap analysis rispetto ai migliori strumenti

| Strumento di riferimento | Cosa offre che qui manca | Colmabile gratis? |
|---|---|---|
| Glassnode / CryptoQuant / Checkonchain | riserve e flussi exchange, URPD, HODL waves, flussi miner, whale | **Riserve/flussi exchange sì** (CoinMetrics community). URPD, HODL waves, flussi miner/whale **no** (servono dati UTXO a pagamento) |
| LookIntoBitcoin / Bitcoin Magazine Pro | grafici di ciclo, Pi Cycle, Puell, golden ratio, flussi ETF | quasi tutto già presente; **flussi ETF sì** (Farside) |
| Coinglass / Hyblock | OI, funding e liquidazioni **aggregati** su più exchange, heatmap order book | **sì per OI/funding/liquidazioni** (API pubbliche Bybit e OKX); heatmap order book solo in avanti e parziale |
| Velo / Laevitas / Amberdata | basis annualizzato e struttura a termine dei futures, COT CME, opzioni | **basis/term structure sì** (Deribit + Binance trimestrali); **COT CME sì** (CFTC); opzioni già presenti |
| Kaiko / The Block / Messari | premi regionali (Kimchi, Coinbase), liquidità per exchange | **Kimchi sì** (Upbit/Bithumb + KRW=X); Coinbase premium già presente |
| TradingView | annotazioni, disegni, alert personalizzati, replay | **sì**, è lavoro interno all'app (nessuna fonte esterna) |
| KillaXBT / LP_NXT | cicli temporali, pivot, frattali, struttura, liquidità, "time travel" sui cicli passati | già forte; mancano **replay storico**, **overlay con time-warp**, **mappa di confluenza prezzo×tempo** |

---

## 3. Fonti verificate oggi (13 ott 2026)

Tutte le chiamate sono GET pubbliche **senza chiave**. Valori reali osservati e controlli incrociati:

| Fonte | Endpoint verificato | Valore osservato | Controllo incrociato | Storico | Limiti |
|---|---|---|---|---|---|
| Farside (flussi ETF) | `farside.co.uk/bitcoin-etf-flow-all-data/` (tabella HTML, 710 righe) | 11 gen 2024 totale **+655.3 M$** (IBIT 111.7, FBTC 227.0, GBTC −95.1); 12 gen 2024 +203.0 M$ | Il primo giorno combacia con il dato pubblicato all'epoca (~655 M$) | dal 11 gen 2024, per emittente | HTML dietro Cloudflare (scraping, rischio blocco o cambio layout); **l'ultima riga è parziale** (12 ott 2026: solo IBIT compilato) |
| CoinMetrics community | `asset-metrics?metrics=SplyExNtv,FlowInExNtv,FlowOutExNtv` | riserve exchange **2.67 M BTC** (12 ott 2026) | eventi noti: 13 mar 2020 afflussi 191k BTC (Black Thursday); 10 nov 2022 deflusso netto −34.8k BTC (FTX). Ordine di grandezza coerente con CryptoQuant/Glassnode (che però usano cluster diversi) | dal 2011, giornaliero, +1 g | status "flash" (rivedibile); il livello assoluto dipende dalla copertura degli indirizzi di CoinMetrics |
| Bybit v5 | `market/open-interest` (1d), `funding/history`, `account-ratio` | OI 56 206 BTC; funding 0.0088% | Coerente con Binance 93 531 BTC e OKX 29 731 BTC (ordine tipico dei ranking pubblici) | **OI giornaliero dal 2020**, funding dal 2020 | 600 richieste/5 s per IP, ampie |
| OKX v5 | `public/funding-rate-history`, `rubik/stat/contracts/open-interest-volume`, `public/liquidation-orders`, WS `liquidation-orders` | OI swap 2.48 G$; liquidazioni reali ricevute via WS | — | funding ~3 mesi, rubik 180 giorni → **va accumulato** | 20 req/2 s |
| Bybit WS | `allLiquidation.BTCUSDT` | sottoscrizione confermata (nessuna liquidazione in 30 s di mercato calmo) | — | solo in avanti | — |
| Deribit | `get_book_summary_by_currency?kind=future` | basis annualizzato **5.4–5.5 %** su DIC26/MAR27/GIU27/SET27 | Binance `futures/data/basis` trimestrale: **5.11 %** annualizzato → coerente | live (+ snapshot da accumulare) | ampi |
| Binance futures trimestrali | `fapi/v1/continuousKlines` CURRENT_QUARTER, `dapi` COIN-M | candele giornaliere | — | COIN-M dal giu 2020, USD-M dal feb 2021 | peso basso |
| Upbit / Bithumb + Yahoo KRW=X | `v1/ticker?markets=KRW-BTC`, `public/ticker/BTC_KRW`, `chart/KRW=X` | Kimchi premium **+0.75 %** (Upbit) / **+0.84 %** (Bithumb) | Due exchange coreani concordano; 6 gen 2018 Upbit 26.9 M KRW ≈ 25k $ vs ~17k $ globale → premio ~45 %, in linea con il picco storico noto | Upbit giornaliero dal 25 set 2017 | Upbit 10 req/s |
| CFTC (COT, Traders in Financial Futures) | `publicreporting.cftc.gov/resource/gpe5-46if.json` (Socrata) | CME Bitcoin 6 ott 2026: OI 21 432 contratti (≈107k BTC); leveraged funds long 5 731 / short 12 583 | Ordine di grandezza dell'OI CME coerente con quanto pubblicato da CME; short netti dei leveraged funds = basis trade noto | settimanale **dal 10 apr 2018** (444 report) | dato del martedì pubblicato il venerdì; senza app token il throttling è basso ma sufficiente |
| Wikimedia pageviews | `metrics/pageviews/per-article/en.wikipedia/.../Bitcoin/daily` | 4 030 giorni | Massimo assoluto **7–8 dic 2017** (344k visite/giorno) = picco retail noto | dal 1 lug 2015 | richiede User-Agent descrittivo |
| Bitfinex | `stats1/pos.size:1m:tBTCUSD:long/hist` | long a margine **89 596 BTC** | 1 gen 2018: 18 969 BTC (plausibile per l'epoca) | dal 2018 a 1 minuto (10 000 punti per richiesta → backfill a pagine) | 90 req/min |
| DefiLlama per chain | `stablecoincharts/Tron?stablecoin=1`, `/Ethereum?stablecoin=1` | USDT su Tron 93.2 G$, su Ethereum 73.1 G$ | stessa fonte già usata per il totale | Tron dal 2019 | ampi |
| mempool.space | `mining/hashrate/3y`, `lightning/statistics/all`, `mining/blocks/fee-rates/all` | hashrate ~1 020 EH/s | CoinMetrics HashRate concorda ma **sfasato di un giorno** | 3 anni / tutto | `fee-rates/all` è lento (~10 s, 1 MB) |

Fonti provate e **scartate**: `fred.stlouisfed.org/graph/fredgraph.csv` (timeout ripetuti da questa macchina → resta la chiave API FRED),
GDELT (HTTP 429, limite 1 richiesta ogni 5 s), Bitfinex con timeframe `1D` (lista vuota).

---

## 4. Lista prioritaria (confidenza dati **Alta**)

Sforzo: **S** ≤ 1 giorno · **M** 2–4 giorni · **L** > 1 settimana. Rispettando la regola "un agente per modulo", i moduli nuovi hanno un agente
nuovo; le estensioni di un modulo esistente restano all'agente che lo possiede.

| # | Nome | Valore per lo studio | Dati | Verifica | Sforzo | Agente | Pagina |
|---|---|---|---|---|---|---|---|
| 1 | **Flussi ETF spot e assorbimento dell'offerta** | Domanda istituzionale giornaliera per emittente, flussi cumulati, giorni consecutivi di uscita, **BTC acquistati dagli ETF ÷ BTC emessi dai miner** (shock di offerta post-halving), reazione di prezzo dopo grandi flussi | Farside (HTML) + CoinMetrics `IssTotNtv` + prezzo di chiusura per convertire in BTC | Giorno 1 = +655.3 M$ come il dato pubblicato; aggiornamento serale USA; storico dal 11 gen 2024; ultima riga **parziale** finché tutti gli emittenti non compilano → mostrarla come "provvisoria"; rischio fonte: medio (scraping) → cache parquet completa, parser con test sullo schema delle colonne e avviso se cambia | M | nuovo `etf` | nuova pagina **Domanda e offerta** (o scheda in Posizionamento) |
| 2 | **Riserve e flussi degli exchange** | Saldo BTC sugli exchange, afflussi/deflussi netti, z-score dei picchi di afflusso (capitolazioni), confronto per fase di ciclo | CoinMetrics community `SplyExNtv`, `FlowInExNtv`, `FlowOutExNtv` (stesso client già usato) | Eventi noti riprodotti (mar 2020, FTX nov 2022); giornaliero +1 g, dal 2011; dati "flash" rivedibili → ricaricare gli ultimi 7 giorni a ogni aggiornamento; in UI: "copertura CoinMetrics, i livelli differiscono da Glassnode/CryptoQuant" | S | nuovo `exchange_flows` | On-chain (nuova scheda) |
| 3 | **Leva aggregata multi-exchange** | OI e funding Binance + Bybit + OKX, funding ponderato per OI, quota di ogni exchange, **OI giornaliero dal 2020** per il "ciclo della leva" (oggi Binance dà solo 30 giorni: `oi_1d` ha 30 righe) | Bybit v5 (OI/funding/long-short dal 2020), OKX v5 (funding, OI), Binance (già presente) | Totali coerenti tra loro e con i ranking pubblici; OKX ha storico corto → accumulo in parquet da subito; in UI: "esclusi CME, Deribit, Hyperliquid" | M | `derivatives` (estensione) + `leverage` | Derivati, Ciclo avanzato › Leva |
| 4 | **Liquidazioni reali multi-exchange** | Liquidazioni vere (non stimate) da 3 exchange, cascate, confronto con la heatmap stimata (validazione del modello) | WS Bybit `allLiquidation.BTCUSDT` + WS OKX `liquidation-orders` (filtrare `instFamily=BTC-USDT`) + Binance esistente | Sottoscrizioni testate; solo in avanti; in UI dichiarare che lo stream Binance `forceOrder` invia al massimo un evento al secondo (sottostima) | M | `liquidity` (estensione) | Liquidazioni |
| 5 | **Basis annualizzato e struttura a termine dei futures** | Carry (cash-and-carry) per scadenza, curva in contango/backwardation, storico del basis trimestrale per fase di ciclo (picchi di basis ≈ euforia) | Deribit `get_book_summary_by_currency` (curva live, snapshot giornaliero accumulato) + Binance `continuousKlines` CURRENT_QUARTER (storico dal 2020/21) vs spot | Deribit 5.4 % ≈ Binance 5.1 % oggi; la serie continua salta al rollover → calcolare i giorni alla scadenza per contratto (ultimo venerdì del trimestre, 08:00 UTC) e marcare i giorni di rollover | S–M | `derivatives` (estensione) | Derivati |
| 6 | **Posizionamento CME (COT)** | Asset manager vs leveraged funds vs dealer sul CME, net short dei fondi (basis trade), percentili storici dal 2018 | CFTC Socrata `gpe5-46if` (TFF) | OI ≈ 107k BTC coerente con l'OI CME pubblico; settimanale, ritardo 3 giorni (martedì → venerdì) da mostrare sempre | S | nuovo `cot` | Posizionamento (nuova scheda) |
| 7 | **Kimchi premium** | Premio coreano come termometro della frenesia retail asiatica (picchi a fine 2017 e nel 2021), affiancato al Coinbase premium già presente | Upbit giornaliero (dal 2017) + Bithumb live + Yahoo `KRW=X` + chiusura Binance | Due exchange coreani concordano (+0.75 % / +0.84 %); picco gen 2018 riprodotto; usare chiusure allo stesso orario UTC (Upbit candela UTC 00:00) | S | `sentiment` (estensione, nuova componente con backtest) | Posizionamento › Sentiment |
| 8 | **Attenzione retail (Wikipedia)** | Interesse del pubblico per BTC dal 2015: picchi di attenzione ai massimi di ciclo, confronto ciclo su ciclo, percentile senza lookahead | Wikimedia pageviews (en + it/de/es/ja sommabili) | Massimo 7–8 dic 2017 coerente; giornaliero +1 g; fonte istituzionale stabile; **in UI: "proxy di attenzione, non di sentiment"** | S | `sentiment` (estensione) | Posizionamento › Sentiment, Cicli (overlay) |
| 9 | **Macchina del tempo (replay)** | "Cosa diceva l'app il giorno X": Cycle Score, sentiment, modelli di ciclo, stagionalità, previsione point-in-time, piano scenari ricalcolati con dati fino a X; esito reale accanto | dati già presenti; i moduli point-in-time esistono (`forecast_features`, Cycle Score, sentiment) | Ammessi **solo** i moduli senza lookahead; quelli che dipendono da dati non ricostruibili (heatmap liquidazioni con OI a 30 g, opzioni, long/short) vanno esclusi e indicati come "non disponibile nel passato" | L | nuovo `replay` | nuova pagina **Macchina del tempo** + selettore data globale |
| 10 | **Diario di studio e annotazioni** | Note, tesi e livelli disegnati sul grafico, legati a data/prezzo; snapshot automatico del contesto (Cycle Score, scenari, sentiment) al momento della nota; revisione dopo 7/30/90 giorni con l'esito | interno (parquet/SQLite locale) | Nessun dato esterno; esiti calcolati dal prezzo già presente | M | nuovo `journal` (ricorda le note in scadenza, confronta tesi ed esito) | nuova pagina **Diario** + strumento nei Grafici |
| 11 | **Avvisi personalizzati** | Soglie scelte dall'utente: prezzo, chiusura settimanale oltre un livello, Cycle Score, funding aggregato, flusso ETF, riserve exchange, finestre di pivot temporale; silenziamento per categoria | motore esistente `alerts.py` | Le regole già esistenti sono testate; serve solo persistenza + UI; i valori arrivano dai moduli verificati | M | `alerts` (estensione) | Impostazioni avvisi (pannello notifiche) |
| 12 | **Report settimanale** | Ogni lunedì dopo la chiusura settimanale: struttura, cicli, pivot della settimana, flussi ETF/exchange, leva, scenari, track record — HTML stampabile/PDF in IT ed EN | dati esistenti + LLM locale per il testo (con il controllo "nessun numero inventato" già usato negli Analoghi) | Numeri presi solo dalle API; testo verificato contro i numeri | M | nuovo `report` | Insights › Report (archivio) |
| 13 | **Overlay dei cicli con time-warp** | Ciclo attuale sovrapposto ai precedenti con allineamento esplicito (halving, minimo, massimo) e fattore di allungamento stimato (DTW) — mostra quanto ogni ciclo è "più lento" | prezzi già presenti | Calcolo deterministico sui prezzi; il fattore è **una stima** e va mostrato con il suo errore di allineamento | M | `cycles` (estensione) | Cicli |
| 14 | **Mappa di confluenza prezzo × tempo** | Una sola vista con livelli di prezzo (S/R, aperture, Fibonacci, pool di liquidità, costo medio STH/LTH) incrociati con le finestre temporali (pivot, eventi, scadenze): le zone dove prezzo e tempo coincidono | output di `structure`, `levels`, `timepivots`, `events`, `holders` | Nessun nuovo dato; punteggio trasparente (elenco dei contributi) e statistica storica di reazione per ogni tipo di confluenza | M | nuovo `confluence` | Struttura (nuova scheda) |
| 15 | **Long/short a margine Bitfinex** | Long a margine BTC (storicamente "smart money" contrarian), variazioni a 7/30 giorni, divergenze col prezzo | Bitfinex `stats1 pos.size` long e short | Valori coerenti nel 2018 e oggi; backfill a pagine (≈ 420 richieste una tantum, entro 90/min), poi incrementale | S–M | `derivatives` (estensione) | Derivati |
| 16 | **Classificatore di regime** | Stato del mercato (trend rialzista / laterale / ribassista / alta volatilità) con probabilità, durata media dei regimi e rendimenti tipici nello stato | prezzi giornalieri (modello di Markov a stati nascosti su rendimento e volatilità) | **È un modello**: va etichettato come tale; stimato in walk-forward senza lookahead, con persistenza dei regimi verificata in backtest e registrata nel track record | M | nuovo `regime` | Dashboard (badge) + Macro/Correlazioni |
| 17 | **Stablecoin per chain** | USDT/USDC su Tron vs Ethereum vs altre: dove nasce la liquidità (Tron = flussi retail/OTC asiatici, Ethereum = DeFi/istituzionale) | DefiLlama `stablecoincharts/{chain}` | Stessa fonte già in uso; somma delle chain ≈ totale (controllo automatico ±1 %) | S | `stablecoins` (estensione) | USDT › Stablecoin |
| 18 | **App installabile (PWA)** | Uso da telefono con notifiche, layout mobile | — | Nessun dato | S | — (UI) | globale |

**Ordine consigliato di realizzazione:** 2 → 1 → 5 → 6 → 3 → 7 → 8 → 4 → 11 → 10 → 9 → 12 → 14 → 13 → 15 → 17 → 16 → 18.
(Le prime sei aggiungono la dimensione "domanda/offerta e leva istituzionale" che oggi manca del tutto e sono rapide perché riusano client esistenti.)

### Note di metodo per i punti principali
- **Assorbimento ETF (1):** BTC netti ETF del giorno = flusso USD ÷ prezzo di chiusura USA (stima: il NAV usa il riferimento CF delle 16:00 ET, la differenza è < 1–2 %). Mostrare "stima in BTC". Emissione = `IssTotNtv` (dal 20 apr 2024 ≈ 450 BTC/giorno).
- **Riserve (2):** z-score dei flussi netti su finestra mobile 365 g, solo dati passati; il livello è "secondo CoinMetrics".
- **Leva aggregata (3):** funding medio ponderato per OI in USD; per OKX convertire `oiCcy`; per Bybit `openInterest` è in BTC.
- **Basis (5):** `ann = (F/S)^(365/giorni) − 1`; escludere i contratti con meno di 7 giorni (rumore).
- **COT (6):** mostrare le posizioni nette per categoria e il percentile a 3 anni; il CME è in contratti da 5 BTC (i Micro sono un mercato separato nel dataset: verificare e sommarli solo se dichiarato).
- **Replay (9):** riusare `forecast_features.OFFLINE` e i ritardi di pubblicazione già codificati (CoinMetrics +1 g, BGeometrics +7 g).

---

## 5. Da valutare (confidenza Media/Bassa — non in lista principale)

| Proposta | Confidenza | Motivo |
|---|---|---|
| Heatmap della liquidità dell'order book | Media | Binance `depth?limit=5000` funziona (peso 250) ma copre solo ±1 % dal prezzo (82 632–84 380 $ oggi); nessuno storico, solo snapshot in avanti; ordini spoof non distinguibili. Utile solo come vista intraday con avvertenze |
| CVD spot multi-exchange | Media | OKX `taker-volume` solo 180 giorni giornalieri; le candele Coinbase non hanno il lato taker → servirebbe lo stream dei trade di ogni exchange, accumulato da zero |
| Volume di notizie (GDELT) | Media | HTTP 429 al primo test (max 1 richiesta / 5 s), serie rumorosa |
| Tesorerie aziendali (CoinGecko `public_treasury`) | Media | Solo fotografia attuale (1.30 M BTC), nessuno storico gratuito |
| Fee, mempool e Lightning | Media | Dati corretti (mempool.space) ma valore modesto per lo studio del prezzo; possibile scheda secondaria del modulo `miners` |
| Distribuzione del costo (URPD / HODL waves) | Bassa | Richiede dati UTXO non disponibili gratis; un proxy da volumi/prezzi non è metodologicamente solido e mostrerebbe dati fuorvianti |
| Flussi dei miner, attività whale | Bassa | Non presenti nelle metriche community di CoinMetrics; nessuna fonte gratuita affidabile |
| Google Trends | Bassa | Nessuna API ufficiale; le librerie non ufficiali ricevono 429 spesso. Wikipedia (punto 8) copre lo stesso bisogno con dati stabili |
| Rilevamento fasi di Wyckoff / conteggi di Elliott | Bassa | Interpretazioni soggettive e non falsificabili: alto rischio di output convincenti ma sbagliati. Se mai, solo come "etichette di studio" manuali nel Diario |
| GEX opzioni | — | Già presente (`options.gamma`): eventualmente migliorare la UI, non serve un modulo nuovo |

---

## 6. Debolezze e incongruenze trovate nell'app attuale

1. **Previsioni peggio della base statistica in backtest.** `/api/tracking`: hit rate 51.3 %, **Brier skill −12.3 %** rispetto alla climatologia, ECE 13.4 punti, copertura dell'intervallo al 90 % = 87.5 %. Le probabilità del Dashboard ("probabilità di rialzo 44 %") sono quindi meno affidabili di una frequenza storica. Va mostrato chiaramente e l'Analista dovrebbe ridurne il peso finché lo skill non è positivo.
2. **Liquidazioni reali sottostimate e parziali.** Solo Binance, e lo stream `forceOrder` invia al massimo un evento al secondo; la raccolta riparte da poco (`collecting_since` ≈ 19 ore fa) e quindi i totali **7 g e 24 h sono identici** (4.54 M$ long) senza indicarlo in UI. Anche la heatmap stimata usa solo l'OI di Binance (≈ 50 % dei tre principali exchange).
3. **Payload pesanti senza compressione.** Nessun `GZipMiddleware` in `main.py`: `/api/cycles` 1.03 MB, `/api/usdt` 640 KB, `/api/positioning` 550 KB, `/api/macro` 505 KB, `/api/onchain` 496 KB, riscaricati ogni 60 s più le invalidazioni WebSocket. Con gzip si scende a circa un decimo.
4. **Storici troppo corti per i percentili.** `oi_1d` 30 righe, `ls` 715 ore (30 giorni), `pos_opt_daily` 2 righe: la componente long/short del sentiment e il ciclo della leva usano campioni minimi. Bybit (dal 2020) risolve OI e long/short.
5. **Traduzione EN incompleta.** `/api/insights?lang=en` restituisce ancora quasi tutto in italiano (noto, ma visibile).
6. **Qualità del testo generato.** Insight: "ha già **rimbalzo** del 44.5 %" (errore grammaticale dal testo a regole/LLM): serve un controllo sui template.
7. **CONTRACT.md non aggiornato:** il tipo `AgentId` elenca 13 agenti, l'API ne restituisce 28.
8. **FRED:** l'endpoint CSV senza chiave non risponde da questa macchina; M2 e bilancio Fed restano vuoti senza `FRED_API_KEY` (chiave gratuita: va solo chiesta al proprietario).
9. **Allineamento delle date tra fonti:** l'hashrate di mempool.space è sfasato di un giorno rispetto a CoinMetrics; se si combinano fonti, allineare per convenzione di timestamp.
10. **Dati CoinMetrics "flash":** i valori recenti possono essere rivisti; oggi `onchain` viene sostituito per intero a ogni refresh (corretto), ma i moduli che salvano snapshot derivati devono ricalcolare gli ultimi giorni.

---

*Analisi a scopo di studio, non consulenza finanziaria.*
