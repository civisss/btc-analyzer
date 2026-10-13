"""GET /api/macro — liquidità, dollaro e tassi, correlazioni cross-asset, rotazione BTC→altcoin, contesto macro."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..analysis import macro as an

router = APIRouter()


def build(**_params) -> dict:
    return an.build()


@router.get("/macro")
def get_macro():
    try:
        return build()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"analisi macro non disponibile: {e}") from e
