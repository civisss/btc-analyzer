# Bitcoin Analyzer

Piattaforma di studio di Bitcoin in tempo reale, in 12 pagine:

- **Oggi:** Dashboard con la sintesi dei segnali, Terminale (order flow, heatmap del book, footprint), Grafici (candele, Superchart con replay e anomalie, VWAP).
- **Mercato:** Struttura (range, pivot di apertura, scenari), Flussi (spot vs futures, ETF, stablecoin, riserve exchange), Posizionamento (derivati, opzioni, holder e sentiment, liquidazioni).
- **Contesto:** Macro ed eventi, On-Chain, Cicli.
- **Studio:** Analoghi (grafici, frattali, USDT.D, di struttura, da immagine, pivot temporali), Previsioni con track record, Avvisi personali.

Interfaccia IT/EN, assistente AI locale, notifiche e aggiornamenti in tempo reale.

## Avvio e arresto

| | Windows | Mac |
|---|---|---|
| Avvio (Docker) | `scripts\windows\start.bat` | `./scripts/mac/start.sh` |
| Avvio senza rebuild | `scripts\windows\start.bat -NoBuild` | `./scripts/mac/start.sh --no-build` |
| Sviluppo (uvicorn + Vite) | `scripts\windows\start.bat -Dev` | `./scripts/mac/start.sh --dev` |
| Arresto | `scripts\windows\stop.bat` | `./scripts/mac/stop.sh` |

Lo script controlla Docker e LM Studio, ferma quello che occupa le porte 8010/5173, ricostruisce l'immagine (con la cache:
veloce se il codice non è cambiato), avvia il container e aspetta che risponda. A mano: `docker compose up -d --build`.

Apri **http://localhost:8010** (in sviluppo **http://localhost:5173**). I dati storici sono già inclusi nell'immagine e vengono aggiornati in automatico.
Lo storico resta salvato nel volume `btc-data`.

### LLM locale (LM Studio)
1. In LM Studio carica `openai/gpt-oss-20b` (consigliato).
2. Scheda **Developer** → avvia il **Local Server** (porta 1234).
   Per Docker abilita anche *Serve on Local Network*.
3. Il container lo raggiunge su `http://host.docker.internal:1234/v1`. Per cambiare modello imposta `LLM_MODEL` in `docker-compose.yml`.

Senza LM Studio l'app funziona lo stesso: gli insight passano alla versione a regole, la chat mostra le istruzioni e i testi in inglese restano in italiano finché il traduttore non riparte.

Opzionale: `FRED_API_KEY=...` nel file `.env` nella cartella del progetto (escluso da git) per i dati FRED della pagina Macro.

## Sviluppo locale

Il modo più semplice è `start.bat -Dev`. In sviluppo i dati stanno in `backend/data`, in Docker nel volume `btc-data`:
sono due copie separate.

```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8010   # niente --reload su Windows: lascia worker orfani
cd frontend && npm run dev        # http://localhost:5173 (proxy verso :8010)
cd frontend && npm run dev:mock   # UI con dati simulati, senza backend
```

## Architettura
- `backend/app/data`: fetch da Binance (spot e futures), Bitstamp, CoinMetrics, alternative.me, CoinGecko e mempool.space, con cache in parquet.
- `backend/app/routers`: API REST (`CONTRACT.md`) e WebSocket `/api/ws`, che inoltra in tempo reale ticker, candele, mark/funding, liquidazioni, notifiche e invalidazioni.
- `backend/app/agents`: 21 agenti di sfondo che ricalcolano i moduli, alimentano sintesi e avvisi, comunicano su un bus di messaggi e dicono al browser quali dati ricaricare; l'Analista pesa i pareri con il track record.
- `backend/app/i18n.py`: traduzione IT→EN dei testi generati (LLM locale + cache), `backend/app/alerts.py`: notifiche, `backend/app/tracking.py`: affidabilità.
  Un nuovo modulo si aggancia a un agente in `engine.py`, che aggiorna i dati e invia l'invalidazione.
- `frontend/`: React, Vite, Tailwind, lightweight-charts ed ECharts.

> Analisi statistiche a scopo di studio: non costituiscono consulenza finanziaria.
