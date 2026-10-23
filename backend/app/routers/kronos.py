"""Kronos (foundation model per candele, arXiv:2508.02739) — vedi CONTRACT.md § KRONOS.

GET /api/forecast/kronos?tf=1h&h=24&samples=100   previsione corrente (ready=false finché il thread di lavoro calcola)
GET /api/forecast/kronos/backtest                 backtest walk-forward fuori campione (pre/post pre-addestramento)
GET /api/forecast/kronos/track                    registro live delle previsioni emesse e verificate
GET /api/forecast/kronos/status                   dispositivo, pesi, tempi, coda di lavoro
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from ..analysis import kronos_forecast as kf
from ..util import clean

log = logging.getLogger("kronos")
router = APIRouter()


@router.get("/forecast/kronos")
def get_kronos(tf: str = Query("1h", pattern="^(1h|4h|1d)$"), h: int = Query(kf.DEFAULT_H, ge=1, le=96),
               samples: int = Query(kf.DEFAULT_SAMPLES, ge=1, le=200)):
    try:
        return kf.build(tf, h, samples)
    except Exception as e:  # noqa: BLE001
        log.exception("previsione Kronos fallita")
        raise HTTPException(503, f"Kronos non disponibile: {e}") from e


@router.get("/forecast/kronos/backtest")
def get_backtest():
    try:
        return kf.backtest_report()
    except Exception as e:  # noqa: BLE001
        log.exception("backtest Kronos illeggibile")
        raise HTTPException(503, f"Backtest Kronos non disponibile: {e}") from e


@router.get("/forecast/kronos/track")
def get_track():
    try:
        return clean(kf.track_record())
    except Exception as e:  # noqa: BLE001
        log.exception("registro live Kronos illeggibile")
        raise HTTPException(503, f"Registro Kronos non disponibile: {e}") from e


@router.get("/forecast/kronos/status")
def get_status():
    return kf.status()


kf.start_live()   # thread in background (dopo 45 s): pesi al primo uso, una previsione per ogni candela chiusa 1h/4h/1d
