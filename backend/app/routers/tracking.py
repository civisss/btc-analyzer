"""GET /api/tracking — track record / affidabilità delle previsioni di agenti e moduli."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query

from .. import tracking as tr

log = logging.getLogger("tracking")
router = APIRouter()


def build(mode: str = "all", **_params) -> dict:
    return tr.summary(mode)


@router.get("/tracking")
async def tracking_route(mode: str = Query("all")):
    if mode not in ("all", "live", "backtest"):
        raise HTTPException(400, "mode non valido (all | live | backtest)")
    tr.start()  # fallback: avvia il ciclo se main.py non l'ha ancora fatto (idempotente)
    try:
        return await asyncio.to_thread(tr.summary, mode)
    except Exception as e:  # noqa: BLE001
        log.exception("tracking fallito")
        raise HTTPException(503, f"Track record non disponibile: {e}") from e


@router.get("/tracking/weights")
def weights_route():
    """Pesi di affidabilità per agente (0..1, 0.5 = neutro) da usare nell'Analista."""
    return tr.reliability_weights()
