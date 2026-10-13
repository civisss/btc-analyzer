"""GET /api/events — calendario eventi macro/politici con la reazione storica di BTC e il ciclo politico USA."""
from __future__ import annotations

import logging

import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..analysis import events as ev

log = logging.getLogger("events")
router = APIRouter()


def _price() -> float | None:
    try:
        from .market import live_price
        return live_price()
    except Exception:  # noqa: BLE001
        return None


def _weekend() -> dict | None:
    """Studio del gap CME del weekend: riusato dal modulo Pivot temporali (nessun ricalcolo)."""
    try:
        from . import timepivots as tpr
        return tpr.build(90)["events"].get("weekend")
    except Exception as e:  # noqa: BLE001
        log.warning("gap CME non disponibile: %s", e)
        return None


@util.ttl_cache(1800)
def _build(horizon: int, day_key: str) -> dict:
    from . import timepivots as tpr
    g = tpr._grid()
    return ev.build(g, pd.Timestamp.now(tz="UTC"), None, horizon, _weekend())


def build(horizon: int = 90, **_params) -> dict:
    """Builder per agenti/avvisi: risultato in cache 30 min per giorno, prezzo/attese ricalcolati sul live."""
    now = pd.Timestamp.now(tz="UTC")
    out = dict(_build(int(horizon), now.strftime("%Y-%m-%d")))
    p = _price()
    if p:
        out["price"] = p
        out["upcoming"] = [dict(u, expected_usd_1d=round(p * u["expected_abs_1d"] / 100) if u.get("expected_abs_1d") else None)
                           for u in out["upcoming"]]
    # giorni mancanti sempre aggiornati
    today = now.normalize()
    out["upcoming"] = [dict(u, days_away=int((pd.Timestamp(u["date"], unit="s", tz="UTC") - today).days))
                       for u in out["upcoming"] if u["time"] >= int(now.timestamp()) - 6 * 3600]
    return util.clean(out)


@router.get("/events")
def events_route(horizon: int = Query(90, ge=14, le=365)):
    try:
        return build(horizon)
    except Exception as e:  # noqa: BLE001
        log.exception("events fallito")
        raise HTTPException(503, f"Calendario eventi non disponibile: {e}") from e
