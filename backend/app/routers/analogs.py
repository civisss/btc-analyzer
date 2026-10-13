"""GET /api/analogs?tf=1d&window=60&top=5&horizon=30 — analoghi storici spiegabili feature per feature."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..analysis import analogs as an

router = APIRouter()


def build(tf: str = "1d", window: int | None = None, top: int = 5, horizon: int | None = None, **_params) -> dict:
    if tf not in an.TFS:
        raise ValueError(f"tf non valido: {tf} (ammessi: {', '.join(an.TFS)})")
    window = int(min(max(window or an.DEFAULT_WINDOW[tf], 20), 200))
    horizon = int(min(max(horizon or max(5, window // 2), 5), 100))
    top = int(min(max(top, 1), 8))
    return an.compute(tf, window, top, horizon)


@router.get("/analogs")
def get_analogs(
    tf: str = Query("1d"),
    window: int | None = Query(None, ge=20, le=200),
    top: int = Query(5, ge=1, le=8),
    horizon: int | None = Query(None, ge=5, le=100),
):
    if tf not in an.TFS:
        raise HTTPException(400, f"tf non valido: {tf} (ammessi: {', '.join(an.TFS)})")
    try:
        return JSONResponse(build(tf=tf, window=window, top=top, horizon=horizon))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"analoghi non disponibili: {e}") from e
