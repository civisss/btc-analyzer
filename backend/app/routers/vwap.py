"""GET /api/vwap        — VWAP ancorati W/M/Q/Y (UTC): livelli, ±σ, periodo precedente, posizione del prezzo, confluenze, verifiche.
GET /api/vwap/panel  — dati di un pannello (candele del timeframe + linee VWAP/±σ correnti e del periodo precedente).

Parametri: source = kraken (Kraken Futures PF_XBTUSD, default) | binance (Binance USDⓈ-M BTCUSDT);
           calc = fine (candele 1m, default) | chart (candele del timeframe del grafico).
Motore: app/analysis/vwap.py. Ricalcolo a ogni minuto chiuso dall'agente "vwap" (WS invalidate "/vwap").
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..analysis import vwap as vw

router = APIRouter()


def build(source: str = vw.DEFAULT_SOURCE, calc: str = "fine", **_params) -> dict:
    return vw.build(source, calc)


def build_panel(p: str, source: str = vw.DEFAULT_SOURCE, calc: str = "fine", **_params) -> dict:
    return vw.panel(p, source, calc)


@router.get("/vwap")
def get_vwap(source: str = Query(vw.DEFAULT_SOURCE, pattern="^(kraken|binance)$"), calc: str = Query("fine", pattern="^(fine|chart)$")):
    try:
        return build(source, calc)
    except ValueError as e:
        raise HTTPException(400, f"parametro non valido: {e}") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"VWAP non disponibile: {e}") from e


@router.get("/vwap/panel")
def get_vwap_panel(p: str = Query(..., pattern="^(w|m|q|y)$"), source: str = Query(vw.DEFAULT_SOURCE, pattern="^(kraken|binance)$"),
                   calc: str = Query("fine", pattern="^(fine|chart)$")):
    try:
        return build_panel(p, source, calc)
    except ValueError as e:
        raise HTTPException(400, f"parametro non valido: {e}") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"VWAP non disponibile: {e}") from e


def build_overview(source: str = vw.DEFAULT_SOURCE, calc: str = "fine", tf: str = "2h", profile: str = "week", **_params) -> dict:
    return vw.overview(source, calc, tf, profile)


@router.get("/vwap/overview")
def get_vwap_overview(source: str = Query(vw.DEFAULT_SOURCE, pattern="^(kraken|binance)$"), calc: str = Query("fine", pattern="^(fine|chart)$"),
                      tf: str = Query("2h", pattern="^(30m|1h|2h|4h)$"), profile: str = Query("week", pattern="^(week|month|off)$")):
    try:
        return build_overview(source, calc, tf, profile)
    except ValueError as e:
        raise HTTPException(400, f"parametro non valido: {e}") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"VWAP non disponibile: {e}") from e
