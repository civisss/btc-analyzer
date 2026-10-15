"""Router SUPERCHART: serie esistenti allineate alle candele (point-in-time), layout salvati, anomalie con backtest.

GET    /api/superchart/catalog
GET    /api/superchart/series?tf=1h&ids=funding_binance,oi_agg&bars=20000&to=&asof=&z=3&candles=1
GET    /api/superchart/layouts · POST /api/superchart/layouts · PUT/DELETE /api/superchart/layouts/{id}
GET    /api/anomalies?z=3
"""
from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response

from .. import superchart_layouts as layouts
from .. import util
from ..analysis import anomalies as an
from ..analysis import superchart as sc

log = logging.getLogger("superchart")
router = APIRouter()


def _json(obj) -> Response:
    return Response(content=json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False), media_type="application/json")


@router.get("/superchart/catalog")
def get_catalog():
    return util.clean(sc.catalog())


def build_series(tf: str = "1h", ids: str = "", bars: int | None = None, to: int | None = None, asof: int | None = None,
                 z: float = 3.0, candles: bool = True) -> dict:
    """Candele della finestra + serie richieste allineate (array colonnari: indice i ↔ t[i])."""
    if tf not in sc.TF_S:
        raise HTTPException(400, f"tf non valido: {tf} (usa {', '.join(sc.TF_S)})")
    want = [x for x in dict.fromkeys(s.strip() for s in (ids or "").split(",")) if x]
    bad = [x for x in want if x not in sc.IND]
    if bad:
        raise HTTPException(400, f"indicatori sconosciuti: {', '.join(bad)}")
    if len(want) > 16:
        raise HTTPException(400, "al massimo 16 indicatori per richiesta")
    thr = float(min(6.0, max(2.0, z)))
    t0 = time.perf_counter()
    try:
        g = sc.grid(tf, asof)
    except Exception as e:  # noqa: BLE001
        log.warning("griglia %s non disponibile: %s", tf, e)
        raise HTTPException(503, "candele non disponibili") from e
    i0, i1 = sc.window(g, bars, to)
    out: dict = {"tf": tf, "step": g.step, "source": g.source, "asof": asof, "now": int(time.time()), "thr": thr,
                 "window": {"i0": i0, "i1": i1, "total": int(len(g.t)), "first": int(g.t[0]) if len(g.t) else None,
                            "last": int(g.t[-1]) if len(g.t) else None},
                 "t": g.t[i0:i1].tolist(), "close_t": g.close[i0:i1][-1:].tolist(), "series": {}, "errors": {}}
    if candles:
        out["candles"] = sc.candles_payload(g, i0, i1)
    for sid in want:
        try:
            gg, comp = sc.compute(sid, tf, asof, thr) if asof is not None else sc.compute_cached(sid, tf, thr)
            if gg is not g and (len(gg.t) != len(g.t) or (len(g.t) and gg.t[-1] != g.t[-1])):
                gg, comp = sc.compute(sid, tf, asof, thr)      # griglia cambiata tra le due letture: ricalcolo coerente
            out["series"][sid] = sc.series_payload(sc.IND[sid], comp, i0, i1)
        except Exception as e:  # noqa: BLE001
            log.warning("superchart %s/%s: %s", sid, tf, e)
            out["errors"][sid] = "unavailable"
    out["ms"] = int((time.perf_counter() - t0) * 1000)
    return out


@router.get("/superchart/series")
def get_series(tf: str = Query("1h"), ids: str = Query(""), bars: int | None = Query(None), to: int | None = Query(None),
               asof: int | None = Query(None), z: float = Query(3.0), candles: bool = Query(True)):
    return _json(build_series(tf, ids, bars, to, asof, z, candles))


# ------------------------------------------------------------------ layout utente

@router.get("/superchart/layouts")
def get_layouts():
    return util.clean({"layouts": layouts.list_layouts()})


@router.post("/superchart/layouts")
def post_layout(body: dict = Body(...)):
    try:
        return util.clean(layouts.create(body.get("name"), body.get("state")))
    except layouts.LayoutError as e:
        raise HTTPException(400, str(e)) from e


@router.put("/superchart/layouts/{lid}")
def put_layout(lid: str, body: dict = Body(...)):
    try:
        return util.clean(layouts.update(lid, body.get("name"), body.get("state")))
    except layouts.LayoutError as e:
        raise HTTPException(400, str(e)) from e
    except KeyError as e:
        raise HTTPException(404, "layout non trovato") from e


@router.delete("/superchart/layouts/{lid}")
def delete_layout(lid: str):
    try:
        layouts.delete(lid)
    except KeyError as e:
        raise HTTPException(404, "layout non trovato") from e
    return {"ok": True}


# ------------------------------------------------------------------ anomalie

def build_anomalies(z: float = an.DEFAULT_THR, **_params) -> dict:
    return an.build(z)


@router.get("/anomalies")
def get_anomalies(z: float = Query(an.DEFAULT_THR)):
    try:
        return build_anomalies(z)
    except Exception as e:  # noqa: BLE001
        log.warning("anomalie non disponibili: %s", e)
        raise HTTPException(503, "anomalie non disponibili") from e
