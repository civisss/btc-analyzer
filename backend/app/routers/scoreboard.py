"""Tabellone Bull vs Bear e blocchi collegati.

  GET /api/scoreboard                  punti, conteggi, regole e soglie (CONTRACT.md § SCOREBOARD)
  GET /api/scoreboard/backtest         saldo bull − bear storico contro i rendimenti successivi
  GET /api/liquidations/leverage       mappa delle liquidazioni per leva, finestre 1 e 7 giorni
  GET /api/flows/30d                   pannelli giornalieri degli ultimi 30 giorni UTC chiusi
  GET /api/flows/moves                 movimenti forti recenti con le loro statistiche
  GET /api/flows/moves/{id}            serie a 5m di un movimento
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..analysis import flows30, liq_leverage, moves
from ..analysis import scoreboard as sb

router = APIRouter()
log = logging.getLogger("scoreboard")


def build(**_p) -> dict:
    return sb.build()


def leverage_map(**_p) -> dict:
    return liq_leverage.build()


def flows_30d(**_p) -> dict:
    return flows30.build()


def recent_moves(**_p) -> dict:
    return moves.build()


def _safe(fn, name: str, *a):
    try:
        return fn(*a)
    except Exception as e:  # noqa: BLE001
        log.exception(name)
        raise HTTPException(503, f"{name} non disponibile: {e}") from e


@router.get("/scoreboard")
def get_scoreboard():
    return _safe(sb.build, "tabellone")


@router.get("/scoreboard/backtest")
def get_backtest():
    return _safe(sb.backtest, "backtest del tabellone")


@router.get("/liquidations/leverage")
def get_leverage_map():
    return _safe(liq_leverage.build, "mappa per leva")


@router.get("/flows/30d")
def get_flows30():
    return _safe(flows30.build, "flussi a 30 giorni")


@router.get("/flows/moves")
def get_moves():
    return _safe(moves.build, "movimenti")


@router.get("/flows/moves/{eid}")
def get_move(eid: int):
    d = _safe(moves.event_detail, "movimento", eid)
    if d is None:
        raise HTTPException(404, "movimento non trovato")
    return d
