"""GET /api/positioning — posizionamento: opzioni (Deribit), holder STH/LTH (BGeometrics), sentiment contrarian.

Sotto-endpoint per tab: /api/positioning/options · /holders · /sentiment (ognuno 503 se la fonte non è disponibile).
L'endpoint aggregato restituisce null per le sezioni non disponibili e il motivo in `errors`.
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException

from ..analysis import holders, options, sentiment
from .market import live_price

router = APIRouter()
log = logging.getLogger("positioning")


def build_options() -> dict:
    return options.build()


def build_holders() -> dict:
    px = live_price()
    return holders.build(px)


def build_sentiment() -> dict:
    return sentiment.build()


PARTS = {"options": build_options, "holders": build_holders, "sentiment": build_sentiment}


def build(**_params) -> dict:
    out: dict = {"errors": {}}
    for k, fn in PARTS.items():
        try:
            out[k] = fn()
        except Exception as e:  # noqa: BLE001
            log.warning("posizionamento/%s non disponibile: %s", k, e)
            out[k] = None
            out["errors"][k] = str(e)
    out["generated_at"] = int(time.time())
    return out


def _one(name: str) -> dict:
    try:
        return PARTS[name]()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"posizionamento/{name} non disponibile: {e}") from e


@router.get("/positioning")
def get_positioning():
    return build()


@router.get("/positioning/options")
def get_options():
    return _one("options")


@router.get("/positioning/holders")
def get_holders():
    return _one("holders")


@router.get("/positioning/sentiment")
def get_sentiment():
    return _one("sentiment")
