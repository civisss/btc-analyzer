"""GET /api/usdt — USDT dominance ricostruita, correlazioni, livelli, divergenze, frattale congiunto."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..analysis import usdt as an

router = APIRouter()


def build(**_params) -> dict:
    return an.build_cached()


@router.get("/usdt")
def get_usdt():
    try:
        return build()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"analisi USDT non disponibile: {e}") from e
