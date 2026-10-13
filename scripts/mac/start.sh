#!/bin/bash
set -e

# Uso:
#   scripts/mac/start.sh             app completa in Docker su http://localhost:8000
#                                    (ricostruisce l'immagine solo se il codice è cambiato)
#   scripts/mac/start.sh --no-build  come sopra, senza ricostruire l'immagine
#   scripts/mac/start.sh --dev       sviluppo: backend uvicorn su :8000 + Vite su :5173,
#                                    senza Docker (dati in backend/data, non nel volume Docker)
DEV=false
NOBUILD=false
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=true ;;
    --no-build) NOBUILD=true ;;
    *) echo "Opzione sconosciuta: $arg (valide: --dev, --no-build)"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND_PORT=8000
FRONTEND_PORT=5173
PID_FILE="$SCRIPT_DIR/.btc.pids"
PYTHON="$SCRIPT_DIR/backend/.venv/bin/python"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════╗${NC}"
if $DEV; then
echo -e "${CYAN}║   btc-analyzer — Avvio ambiente di sviluppo          ║${NC}"
else
echo -e "${CYAN}║   btc-analyzer — Avvio in Docker                     ║${NC}"
fi
echo -e "${CYAN}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Verifica dipendenze ──
echo -e "${BOLD}[1/5] Verifica dipendenze...${NC}"
COMPOSE_CMD=""
if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
fi

if $DEV; then
  if [ ! -x "$PYTHON" ]; then
    echo -e "${RED}  Ambiente Python non trovato (backend/.venv). Crealo con:${NC}"
    echo -e "${RED}    cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt${NC}"
    exit 1
  fi
  echo -e "${GREEN}  $($PYTHON --version)${NC}"
  if ! command -v node &>/dev/null; then
    echo -e "${RED}  Node.js non trovato. Installalo prima di continuare.${NC}"
    exit 1
  fi
  echo -e "${GREEN}  Node:    $(node --version)${NC}"
else
  if [ -z "$COMPOSE_CMD" ]; then
    echo -e "${RED}  Docker non trovato. Installa Docker Desktop prima di continuare.${NC}"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    echo -e "${RED}  Docker Desktop non è in esecuzione. Avvialo e riprova.${NC}"
    exit 1
  fi
  echo -e "${GREEN}  Runtime: $COMPOSE_CMD${NC}"
fi

# LM Studio serve per traduzioni EN, sintesi dell'analista e chat: senza, l'app funziona ma in solo italiano e senza AI.
if curl -sf --max-time 3 http://localhost:1234/v1/models > /dev/null 2>&1; then
  LLM="attivo"; echo -e "${GREEN}  LM Studio raggiungibile (porta 1234)${NC}"
else
  LLM="spento (solo italiano, niente sintesi AI)"
  echo -e "${YELLOW}  LM Studio non risponde sulla porta 1234: traduzioni EN e sintesi AI restano ferme finché non lo avvii${NC}"
fi
echo ""

# ── Ferma eventuali servizi già in esecuzione ──
echo -e "${BOLD}[2/5] Arresto servizi esistenti...${NC}"
if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi
cd "$SCRIPT_DIR"
[ -n "$COMPOSE_CMD" ] && $COMPOSE_CMD down --remove-orphans > /dev/null 2>&1 || true
lsof -ti:$BACKEND_PORT 2>/dev/null | xargs -r kill 2>/dev/null || true
lsof -ti:$FRONTEND_PORT 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 1
echo -e "${GREEN}  Servizi fermati${NC}"
echo ""

mkdir -p "$SCRIPT_DIR/logs"
if $DEV; then
  echo -e "${BOLD}[3/5] Verifica dipendenze frontend...${NC}"
  cd "$SCRIPT_DIR/frontend"
  if [ ! -d "node_modules" ]; then
    npm ci --silent
  fi
  echo -e "${GREEN}  Dipendenze frontend pronte${NC}"
  echo ""

  echo -e "${BOLD}[4/5] Avvio servizi...${NC}"
  > "$PID_FILE"
  cd "$SCRIPT_DIR/backend"
  "$PYTHON" -m uvicorn app.main:app --port $BACKEND_PORT > "$SCRIPT_DIR/logs/backend.log" 2>&1 &
  BACKEND_PID=$!
  echo "$BACKEND_PID" >> "$PID_FILE"
  echo "  Backend avviato (PID: $BACKEND_PID, porta $BACKEND_PORT)"

  cd "$SCRIPT_DIR/frontend"
  npm run dev -- --port $FRONTEND_PORT --strictPort > "$SCRIPT_DIR/logs/frontend.log" 2>&1 &
  FRONTEND_PID=$!
  echo "$FRONTEND_PID" >> "$PID_FILE"
  echo "  Frontend avviato (PID: $FRONTEND_PID, porta $FRONTEND_PORT)"
  echo ""
else
  cd "$SCRIPT_DIR"
  if $NOBUILD; then
    echo -e "${BOLD}[3/5] Immagine: uso quella esistente (--no-build)${NC}"
  else
    echo -e "${BOLD}[3/5] Build immagine (usa la cache se il codice non è cambiato)...${NC}"
    $COMPOSE_CMD build
  fi
  echo -e "${GREEN}  Immagine pronta${NC}"
  echo ""

  echo -e "${BOLD}[4/5] Avvio container...${NC}"
  $COMPOSE_CMD up -d
  echo -e "${GREEN}  Container avviato${NC}"
  echo ""
fi

# ── Health check ──
echo -e "${BOLD}[5/5] Verifica...${NC}"
MAX_RETRIES=90
RETRY=0
until curl -sf http://localhost:$BACKEND_PORT/api/status > /dev/null 2>&1 || [ $RETRY -ge $MAX_RETRIES ]; do
  if $DEV && ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo -e "${RED}  Backend crashato. Ultimi log:${NC}"
    tail -20 "$SCRIPT_DIR/logs/backend.log"
    exit 1
  fi
  RETRY=$((RETRY + 1))
  printf "\r  In attesa del backend... (%d/%d)" $RETRY $MAX_RETRIES
  sleep 2
done
echo ""
if [ $RETRY -lt $MAX_RETRIES ]; then
  echo -e "${GREEN}  Backend pronto${NC}"
elif $DEV; then
  echo -e "${YELLOW}  Backend non raggiungibile. Log: cat logs/backend.log${NC}"
else
  echo -e "${YELLOW}  Backend non raggiungibile. Log: docker compose logs btc-analyzer${NC}"
fi

APP_URL="http://localhost:$BACKEND_PORT"
if $DEV; then
  APP_URL="http://localhost:$FRONTEND_PORT"
  RETRY=0
  until curl -sf "$APP_URL" > /dev/null 2>&1 || [ $RETRY -ge 20 ]; do
    if ! kill -0 $FRONTEND_PID 2>/dev/null; then
      echo -e "${RED}  Frontend crashato. Ultimi log:${NC}"
      tail -20 "$SCRIPT_DIR/logs/frontend.log"
      exit 1
    fi
    RETRY=$((RETRY + 1))
    printf "\r  In attesa del frontend... (%d/%d)" $RETRY 20
    sleep 2
  done
  echo ""
  [ $RETRY -lt 20 ] && echo -e "${GREEN}  Frontend pronto${NC}" || echo -e "${YELLOW}  Frontend non raggiungibile. Log: cat logs/frontend.log${NC}"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   btc-analyzer avviato!                              ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo "   App:        $APP_URL"
echo "   API:        http://localhost:$BACKEND_PORT/api"
if $DEV; then
  echo "   Modalità:   sviluppo (dati in backend/data)"
  echo "   Log BE:     cat logs/backend.log"
  echo "   Log FE:     cat logs/frontend.log"
else
  echo "   Modalità:   Docker (dati nel volume btc-analyzer_btc-data)"
  echo "   Log:        docker compose logs -f btc-analyzer"
fi
echo "   LM Studio:  $LLM"
echo "   Stop:       ./scripts/mac/stop.sh"
echo ""
