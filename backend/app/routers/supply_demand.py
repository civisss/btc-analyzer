"""GET /api/supply-demand — domanda e offerta: riserve/flussi exchange, flussi ETF spot + assorbimento, attenzione retail.

Sotto-endpoint per scheda: /api/supply-demand/exchanges · /etf · /attention (503 se la fonte non è disponibile).
L'endpoint aggregato restituisce null per le sezioni non disponibili e il motivo in `errors`.
I testi dell'interfaccia sono composti nel frontend (IT/EN): qui solo numeri, date e chiavi.
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException

from .. import util
from ..analysis import supply_demand as sd

router = APIRouter()
log = logging.getLogger("supply_demand")


@util.ttl_cache(6 * 3600)
def build_exchanges() -> dict:
    return sd.build_exchanges()


@util.ttl_cache(3600)
def build_etf() -> dict:
    return sd.build_etf()


@util.ttl_cache(6 * 3600)
def build_attention() -> dict:
    return sd.build_attention()


PARTS = {"exchanges": build_exchanges, "etf": build_etf, "attention": build_attention}


def build(**_params) -> dict:
    out: dict = {"errors": {}}
    for k, fn in PARTS.items():
        try:
            out[k] = fn()
        except Exception as e:  # noqa: BLE001
            log.warning("domanda-offerta/%s non disponibile: %s", k, e)
            out[k] = None
            out["errors"][k] = str(e)
    out["generated_at"] = int(time.time())
    return out


def _one(name: str) -> dict:
    try:
        return PARTS[name]()
    except Exception as e:  # noqa: BLE001
        log.exception("domanda-offerta/%s", name)
        raise HTTPException(503, f"domanda-offerta/{name} non disponibile: {e}") from e


@router.get("/supply-demand")
def get_supply_demand():
    return build()


@router.get("/supply-demand/exchanges")
def get_exchanges():
    return _one("exchanges")


@router.get("/supply-demand/etf")
def get_etf():
    return _one("etf")


@router.get("/supply-demand/attention")
def get_attention():
    return _one("attention")
