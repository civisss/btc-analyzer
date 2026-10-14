"""GET /api/forecast — previsione probabilistica (posizione nel ciclo + ML, walk-forward, calibrazione conforme).
GET /api/forecast/oneday — previsione a 1 giorno fuori campione contro il naive (vedi CONTRACT.md § FORECAST 1 DAY)."""
from __future__ import annotations

import logging
import threading
import time

from fastapi import APIRouter, HTTPException, Query

from ..analysis import forecast as fc
from ..analysis import forecast_oneday as fod

log = logging.getLogger("forecast")
router = APIRouter()


@router.get("/forecast")
def get_forecast(horizon: int = Query(90, ge=7, le=365)):
    try:
        return fc.build(horizon)
    except RuntimeError as e:  # modello non ancora pronto (primo addestramento in corso)
        raise HTTPException(503, f"Previsione non disponibile: {e}") from e
    except Exception as e:  # noqa: BLE001
        log.exception("forecast fallito")
        raise HTTPException(503, f"Previsione non disponibile: {e}") from e


@router.get("/forecast/oneday")
def get_oneday():
    try:
        return fod.build()
    except RuntimeError as e:  # primo calcolo in corso
        raise HTTPException(503, f"Previsione a 1 giorno non disponibile: {e}") from e
    except Exception as e:  # noqa: BLE001
        log.exception("forecast 1g fallito")
        raise HTTPException(503, f"Previsione a 1 giorno non disponibile: {e}") from e


def _warm():
    time.sleep(8)  # lascia partire prima il resto dell'app
    fc.warm()      # carica il modello da disco / addestra in background, poi controlla ogni 10 min


def _warm_oneday():
    time.sleep(20)   # dopo il forecast v2: il calcolo a 1 giorno è leggero (≈ 1 min la prima volta, poi pochi secondi)
    fod.warm()


threading.Thread(target=_warm, daemon=True, name="forecast-warm").start()
threading.Thread(target=_warm_oneday, daemon=True, name="forecast-1d-warm").start()
