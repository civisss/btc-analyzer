#!/bin/bash

# Ferma sia il container Docker sia l'eventuale ambiente di sviluppo (--dev). I dati restano nel volume.
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PID_FILE="$SCRIPT_DIR/.btc.pids"
BACKEND_PORT=8000
FRONTEND_PORT=5173

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   btc-analyzer — Arresto servizi                     ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════╝${NC}"
echo ""

force_kill() {
  local pid=$1
  local label=$2
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for i in 1 2 3; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo -e "${GREEN}  $label (PID $pid) fermato${NC}"
  fi
}

if [ -f "$PID_FILE" ]; then
  echo -e "${YELLOW}Arresto processi dal PID file...${NC}"
  while read -r pid; do
    [ -z "$pid" ] && continue
    CHILDREN=$(pgrep -P "$pid" 2>/dev/null || true)
    force_kill "$pid" "Processo"
    for child in $CHILDREN; do
      force_kill "$child" "  Figlio"
    done
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

echo -e "${YELLOW}Arresto container...${NC}"
COMPOSE_CMD=""
if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
fi
if [ -n "$COMPOSE_CMD" ]; then
  cd "$SCRIPT_DIR"
  $COMPOSE_CMD down --remove-orphans 2>/dev/null || true
  echo -e "${GREEN}  Container fermato (i dati restano nel volume)${NC}"
else
  echo -e "${YELLOW}  Nessun runtime Docker trovato${NC}"
fi

echo -e "${YELLOW}Verifica porte $BACKEND_PORT e $FRONTEND_PORT...${NC}"
for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  PIDS=$(lsof -ti:$PORT 2>/dev/null || true)
  for pid in $PIDS; do
    force_kill "$pid" "Porta $PORT"
  done
done

rm -f "$SCRIPT_DIR/logs/backend.log" "$SCRIPT_DIR/logs/frontend.log"

echo ""
BE_LISTENING=$(lsof -ti:$BACKEND_PORT 2>/dev/null | head -1 || true)
FE_LISTENING=$(lsof -ti:$FRONTEND_PORT 2>/dev/null | head -1 || true)

if [ -z "$BE_LISTENING" ] && [ -z "$FE_LISTENING" ]; then
  echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║   Tutti i servizi sono stati fermati                ║${NC}"
  echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
else
  echo -e "${RED}╔════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║   Alcuni processi potrebbero essere ancora attivi   ║${NC}"
  [ -n "$BE_LISTENING" ] && echo -e "${RED}║   Porta $BACKEND_PORT: PID $BE_LISTENING ancora in ascolto${NC}"
  [ -n "$FE_LISTENING" ] && echo -e "${RED}║   Porta $FRONTEND_PORT: PID $FE_LISTENING ancora in ascolto${NC}"
  echo -e "${RED}╚════════════════════════════════════════════════════╝${NC}"
fi
echo ""
