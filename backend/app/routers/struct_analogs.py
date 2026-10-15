"""GET /api/analogs/structure — analogia di struttura (sequenza di massimi/minimi ZigZag) con proiezione dei prossimi pivot
e backtest walk-forward. Motore: app/analysis/structure_analogs.py (vedi CONTRACT.md § STRUCTURE ANALOGS)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..analysis import structure_analogs as sa

router = APIRouter()


def build(asset: str = "btc", tf: str = "1d", mult: float | None = None, k: int = 5, top: int = 5, **_params) -> dict:
    """asset btc|usdtd|ethbtc · tf 4h|1d|1w (ethbtc: 1d|1w) · mult 1.5..6 (× ATR, passo 0.5) · k 3..8 swing · top 1..10."""
    return sa.compute(asset=asset, tf=tf, mult=mult, k=k, top=top)


@router.get("/analogs/structure")
def get_structure_analogs(
    asset: str = Query("btc"),
    tf: str = Query("1d"),
    mult: float | None = Query(None, ge=1.0, le=8.0),
    k: int = Query(5, ge=2, le=10),
    top: int = Query(5, ge=1, le=12),
):
    try:
        return JSONResponse(build(asset=asset, tf=tf, mult=mult, k=k, top=top))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"analogia di struttura non disponibile: {e}") from e
