"""GET /api/forecast — previsione probabilistica (posizione nel ciclo + ML, walk-forward, calibrazione conforme)."""
from __future__ import annotations

import logging
import threading
import time

from fastapi import APIRouter, HTTPException, Query

from ..analysis import forecast as fc

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


def _warm():
    time.sleep(8)  # lascia partire prima il resto dell'app
    fc.warm()      # carica il modello da disco / addestra in background, poi controlla ogni 10 min


threading.Thread(target=_warm, daemon=True, name="forecast-warm").start()
