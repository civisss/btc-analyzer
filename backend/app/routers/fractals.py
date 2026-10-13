"""GET /api/fractals?tf=4h&window=60&horizon=30&top=5 — analoghi storici e proiezione."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..analysis import fractals as an

router = APIRouter()
TFS = ("1h", "4h", "1d", "1w")


def build(tf: str = "4h", window: int = 60, horizon: int = 30, top: int = 5, **_params) -> dict:
    if tf not in TFS:
        raise ValueError(f"tf non valido: {tf} (ammessi: {', '.join(TFS)})")
    window = int(min(max(window, 10), 300))
    horizon = int(min(max(horizon, 5), 200))
    top = int(min(max(top, 1), 20))
    return util.clean(an.compute(tf, window, horizon, top))


@router.get("/fractals")
def get_fractals(
    tf: str = Query("4h"),
    window: int = Query(60, ge=10, le=300),
    horizon: int = Query(30, ge=5, le=200),
    top: int = Query(5, ge=1, le=20),
):
    if tf not in TFS:
        raise HTTPException(400, f"tf non valido: {tf} (ammessi: {', '.join(TFS)})")
    try:
        return build(tf=tf, window=window, horizon=horizon, top=top)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"frattali non disponibili: {e}") from e
