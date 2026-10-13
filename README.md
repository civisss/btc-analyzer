# Bitcoin Analyzer

Piattaforma di studio di Bitcoin in tempo reale: cicli (orologio del ciclo, miner, leva), pivot temporali e stagionalità,
struttura e scenari, pivot e livelli, liquidazioni multi-exchange, frattali, analoghi grafici (anche da screenshot),
derivati (basis, CME COT, leva aggregata), posizionamento (opzioni, holder, sentiment), domanda e offerta, USDT e
stablecoin, macro, eventi, previsioni con track record, avvisi personali, diario di studio e un team di 35 agenti
che collaborano tra loro. Interfaccia IT/EN, notifiche e aggiornamenti in tempo reale.

## Avvio e arresto

| | Windows | Mac |
|---|---|---|
| Avvio (Docker) | `scripts\windows\start.bat` | `./scripts/mac/start.sh` |
| Avvio senza rebuild | `scripts\windows\start.bat -NoBuild` | `./scripts/mac/start.sh --no-build` |
| Sviluppo (uvicorn + Vite) | `scripts\windows\start.bat -Dev` | `./scripts/mac/start.sh --dev` |
| Arresto | `scripts\windows\stop.bat` | `./scripts/mac/stop.sh` |

Lo script controlla Docker e LM Studio, ferma quello che occupa le porte 8000/5173, ricostruisce l'immagine (con la cache:
veloce se il codice non è cambiato), avvia il container e aspetta che risponda. A mano: `docker compose up -d --build`.

Apri **http://localhost:8000** (in sviluppo **http://localhost:5173**). I dati storici sono già inclusi nell'immagine e vengono aggiornati in automatico.
Lo storico resta salvato nel volume `btc-data`.

### LLM locale (LM Studio)
1. In LM Studio carica `openai/gpt-oss-20b` (consigliato).
2. Scheda **Developer** → avvia il **Local Server** (porta 1234).
   Per Docker abilita anche *Serve on Local Network*.
3. Il container lo raggiunge su `http://host.docker.internal:1234/v1`. Per cambiare modello imposta `LLM_MODEL` in `docker-compose.yml`.

Senza LM Studio l'app funziona lo stesso: gli insight passano alla versione a regole, la chat mostra le istruzioni e i testi in inglese restano in italiano finché il traduttore non riparte.

Opzionale: `FRED_API_KEY` in `docker-compose.yml` per M2 e bilancio Fed (pagina Macro).

## Sviluppo locale

Il modo più semplice è `start.bat -Dev`. In sviluppo i dati stanno in `backend/data`, in Docker nel volume `btc-data`:
sono due copie separate.

```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000   # niente --reload su Windows: lascia worker orfani
cd frontend && npm run dev        # http://localhost:5173 (proxy verso :8000)
cd frontend && npm run dev:mock   # UI con dati simulati, senza backend
```

## Architettura
- `backend/app/data`: fetch da Binance (spot e futures), Bitstamp, CoinMetrics, alternative.me, CoinGecko e mempool.space, con cache in parquet.
- `backend/app/routers`: API REST (`CONTRACT.md`) e WebSocket `/api/ws`, che inoltra in tempo reale ticker, candele, mark/funding, liquidazioni e messaggi degli agenti.
- `backend/app/agents`: 35 agenti autonomi, uno per modulo (mercato, livelli, liquidazioni, frattali, analoghi, USDT, stablecoin, cicli, orologio del ciclo, miner, leva, on-chain, derivati, flussi, struttura, pivot di apertura, scenari, pivot temporali, eventi, opzioni, holder, sentiment, macro, domanda e offerta, basis futures, CME COT, leva aggregata, ricerca da immagine, previsioni, verifica, avvisi, avvisi personali, diario e Analista AI) che comunicano su un bus di messaggi; l'Analista pesa i pareri con il track record.
- `backend/app/i18n.py`: traduzione IT→EN dei testi generati (LLM locale + cache), `backend/app/alerts.py`: notifiche, `backend/app/tracking.py`: affidabilità.
  Ogni nuovo modulo deve avere il proprio agente in `engine.py`.
- `frontend/`: React, Vite, Tailwind, lightweight-charts ed ECharts.

> Analisi statistiche a scopo di studio: non costituiscono consulenza finanziaria.
