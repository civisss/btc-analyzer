"""Router TIME PIVOTS: /timepivots — stagionalità, finestre ricorrenti di inversione, pivot di ciclo,
proiezioni temporali, eventi ricorrenti e calendario dei pivot con confluenza."""
from __future__ import annotations

import logging
import time

import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..analysis import timepivots as tp
from ..data import store
from . import cycles as cycles_router

log = logging.getLogger("timepivots")
router = APIRouter()


def _safe(name: str):
    try:
        return store.get(name)
    except Exception as e:  # noqa: BLE001
        log.warning("dataset %s non disponibile: %s", name, e)
        return None


@util.ttl_cache(1800)
def _grid() -> tp.DailyGrid:
    return tp.DailyGrid(cycles_router.load_daily())


@util.ttl_cache(1800)
def _seasonality(day_key: str) -> dict:
    g = _grid()
    close = pd.Series(g.close, index=g.idx)
    return tp.seasonality(close, _safe("k_1d"), _safe("k_1h"), pd.Timestamp.now(tz="UTC"))


@util.ttl_cache(600)
def _build(horizon: int, day_key: str) -> dict:
    t0 = time.time()
    now = pd.Timestamp.now(tz="UTC")
    g = _grid()
    seas = _seasonality(day_key)
    windows = tp.recurring_windows(g, now, horizon)
    cyc_heavy = cycles_router._build_heavy()
    cyc = tp.cycle_pivots(g, cyc_heavy, now, horizon)
    proj = tp.time_projections(g, _safe("k_4h"), now, horizon)
    ev = tp.events(g, _safe("k_1h"), now, horizon)
    cal = tp.calendar(windows, cyc, proj, ev, now, horizon)
    today = tp.today_block(seas, windows, cal, now)

    # ---- grafico: ultime 180 candele daily (Binance) + prezzo
    k1d = _safe("k_1d")
    candles = []
    if k1d is not None and len(k1d):
        for r in k1d.iloc[-180:].itertuples(index=False):
            candles.append({"time": util.ts(r.time), "open": r.open, "high": r.high, "low": r.low, "close": r.close})
    price = float(g.close[-1])

    # ---- KPI
    hi_conf = [c for c in cal if (c["confluence"] or 0) >= 55]
    nxt = hi_conf[0] if hi_conf else (max(cal, key=lambda c: c["confluence"] or 0) if cal else None)
    m = seas["monthly"]
    cur_m = m["stats"][now.month - 1]
    hc = seas["halving_cycle"]
    hc_row = hc["rows"][hc["current"]["idx"]]
    hc_cell = hc_row["months"][now.month - 1]
    wd = [x for x in seas["weekday"]["stats"] if x["avg"] is not None]
    hr = [x for x in seas["hourly"]["stats"] if x["avg"] is not None]
    kpi = {
        "next_pivot": nxt and {k: nxt[k] for k in ("id", "time", "start", "end", "label", "confluence", "expected", "probability", "title", "days_away")},
        "current_month": {"month": now.month, "label": tp.MESI[now.month - 1], "avg": cur_m["avg"], "median": cur_m["median"],
                          "win_rate": cur_m["win_rate"], "n": cur_m["n"], "mtd": m["current"]["value"]},
        "cycle_position": {"idx": hc["current"]["idx"], "label": hc_row["label"], "short": hc_row["short"], "month": now.month,
                           "avg": hc_cell["avg"], "win_rate": hc_cell["win_rate"], "n": hc_cell["n"],
                           "annual_avg": hc_row["annual"]["median"], "days_since_halving": cyc["days_since_halving"]},
        "best_day": max(wd, key=lambda x: x["avg"]) if wd else None,
        "worst_day": min(wd, key=lambda x: x["avg"]) if wd else None,
        "best_hour": max(hr, key=lambda x: x["avg"]) if hr else None,
        "worst_hour": min(hr, key=lambda x: x["avg"]) if hr else None,
    }
    out = {
        "generated_at": int(time.time()), "today": util.ts(now.normalize()), "horizon": horizon, "price": price,
        "kpi": kpi, "today_info": today, "calendar": cal,
        "seasonality": seas, "windows": windows, "cycle_pivots": cyc, "projections": proj, "events": ev,
        "chart": {"candles": candles},
        "method": ("Pivot temporali = date in cui BTC ha mostrato comportamenti ricorrenti. Ogni fonte (stagionalità, "
                   "tempi di ciclo, proiezioni Fibonacci/gambe, eventi) è calcolata solo dai dati storici; la confluenza "
                   "0–100 cresce quando più fonti indipendenti cadono negli stessi giorni. Statistiche, non certezze."),
    }
    log.info("timepivots calcolato in %.2fs", time.time() - t0)
    return util.clean(out)


def build(horizon: int = 90) -> dict:
    now = pd.Timestamp.now(tz="UTC")
    return _build(int(horizon), now.strftime("%Y-%m-%d"))


@router.get("/timepivots")
def timepivots_route(horizon: int = Query(90, ge=30, le=180)):
    try:
        return build(horizon)
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
