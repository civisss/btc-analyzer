"""GET /api/liquidations?range=7d — heatmap stimata, cluster, pool di liquidità, eventi reali."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..analysis import liquidations as an

router = APIRouter()
RANGES = ("1d", "3d", "7d", "30d")


def build(range: str = "7d", **_params) -> dict:  # noqa: A002
    if range not in RANGES:
        raise ValueError(f"range non valido: {range} (ammessi: {', '.join(RANGES)})")
    return util.clean(an.compute(range))


@router.get("/liquidations")
def get_liquidations(range: str = Query("7d")):  # noqa: A002
    if range not in RANGES:
        raise HTTPException(400, f"range non valido: {range} (ammessi: {', '.join(RANGES)})")
    try:
        return build(range=range)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"liquidazioni non disponibili: {e}") from e
