# ---------- 1) build frontend ----------
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- 2) runtime backend ----------
FROM python:3.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    LLM_BASE_URL=http://host.docker.internal:1234/v1
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# PyTorch solo CPU (Kronos): passo separato dall'indice CPU, così non arrivano le build CUDA (~2 GB).
# Strato a parte prima dei requirements: resta in cache finché non cambia la versione.
RUN pip install --no-cache-dir torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/app backend/app
# cache dati iniziale: inizializza il volume al primo avvio (avvio immediato)
COPY backend/data backend/data
# backtest Kronos calcolato in locale con la GPU: copia anche fuori dal volume dati (un volume già esistente non riceve i
# file nuovi dell'immagine); l'app lo legge da backend/seed se manca in DATA_DIR. Nessun errore se il file non c'è.
RUN mkdir -p backend/seed && (cp backend/data/kronos_bt.parquet backend/data/kronos_bt.json backend/seed/ 2>/dev/null || true)
COPY --from=web /web/dist frontend/dist
WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fs http://localhost:8000/api/status || exit 1
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
