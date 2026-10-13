"""GET /api/usdt/analogs — analoghi visivi della USDT.D e cosa fece BTC dopo; GET /api/stablecoins — liquidità delle stablecoin."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..analysis import stablecoins as sc
from ..analysis import usdt_analogs as ua

router = APIRouter()


def build(tf: str = "1d", window: int | None = None, top: int = 5, horizon: int | None = None, **_params) -> dict:
    """Analoghi della USDT.D (tf 1d|4h, window 20..200, top 1..8, horizon 5..100)."""
    if tf not in ua.TFS:
        raise ValueError(f"tf non valido: {tf} (ammessi: {', '.join(ua.TFS)})")
    window = int(min(max(window or 60, 20), 200))
    horizon = int(min(max(horizon or 30, 5), 100))
    top = int(min(max(top, 1), 8))
    return ua.compute(tf, window, top, horizon)


def build_stablecoins(**_params) -> dict:
    """Supply, dominance, SSR, mint/burn delle stablecoin."""
    return sc.build_cached()


@router.get("/usdt/analogs")
def get_usdt_analogs(
    tf: str = Query("1d"),
    window: int | None = Query(None, ge=20, le=200),
    top: int = Query(5, ge=1, le=8),
    horizon: int | None = Query(None, ge=5, le=100),
):
    if tf not in ua.TFS:
        raise HTTPException(400, f"tf non valido: {tf} (ammessi: {', '.join(ua.TFS)})")
    try:
        return JSONResponse(build(tf=tf, window=window, top=top, horizon=horizon))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"analoghi USDT.D non disponibili: {e}") from e


@router.get("/stablecoins")
def get_stablecoins():
    try:
        return JSONResponse(build_stablecoins())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"dati stablecoin non disponibili: {e}") from e
