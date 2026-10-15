"""Router TIMING (Gann · Wyckoff · ritmi): /timing, /timing/gann, /timing/wyckoff, /timing/rhythms.

Replica gli strumenti di timing in stile «Gann + Wyckoff + time cycles» con il loro track record contro il caso:
- conteggi di Gann dai pivot maggiori, date chiave con punteggio di confluenza (app/analysis/timing_gann.py);
- fasi ed eventi di Wyckoff causali su 1D/4H (app/analysis/timing_wyckoff.py);
- scopritore di ritmi di calendario con correzione per test multipli (app/analysis/timing_rhythms.py);
- due scenari condizionali composti da regole fisse con livelli esistenti (struttura, VWAP, range Wyckoff).
I testi sono composti dal frontend (chiavi + numeri): l'API non contiene frasi da tradurre.
"""
from __future__ import annotations

import logging
import time

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..analysis import timing_gann as tg
from ..analysis import timing_rhythms as trh
from ..analysis import timing_wyckoff as tw
from ..data import store

log = logging.getLogger("timing")
router = APIRouter()
TF_SECONDS = {"1d": 86400, "4h": 14400}
TF_DATASET = {"1d": "k_1d", "4h": "k_4h"}
CHART_BARS = {"1d": 500, "4h": 700}
RHYTHM_START = {"2017": pd.Timestamp("2017-09-01", tz="UTC"), "2013": pd.Timestamp("2013-01-01", tz="UTC")}
LEVEL_CLUSTER_PCT = 0.6


def _now() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC")


def _price() -> float:
    try:
        from .market import live_price
        p = live_price()
        if p:
            return float(p)
    except Exception:  # noqa: BLE001
        pass
    return float(store.get("k_1h")["close"].iloc[-1])


def _grid():
    from . import timepivots as tpr
    return tpr._grid()


# ============================================================ GANN

@util.ttl_cache(6 * 3600)
def _gann_heavies(day_key: str) -> dict:
    """Backtest di tutte le definizioni consultabili (servono per la correzione globale tra definizioni)."""
    t0 = time.time()
    g = _grid()
    hv = {d: tg.heavy(g, *d) for d in tg.DEFS}
    tg.apply_global_correction(list(hv.values()))
    log.info("timing/gann: backtest di %d definizioni in %.1fs", len(hv), time.time() - t0)
    return hv


@util.ttl_cache(120)
def build_gann(horizon: int = 90, pivot: int = 10, win: int = 2, **_params) -> dict:
    now = _now()
    g = _grid()
    hv = _gann_heavies(now.strftime("%Y-%m-%d"))[(pivot, win)]
    price = _price()
    out = tg.compute(g, now.normalize(), price, horizon, pivot, win, hv=hv)
    k1d = store.get("k_1d")
    candles = [{"time": util.ts(r.time), "open": r.open, "high": r.high, "low": r.low, "close": r.close, "volume": r.volume}
               for r in k1d.iloc[-400:].itertuples(index=False)]
    out.update({"generated_at": int(time.time()), "today": now.normalize(), "price": price, "horizon": horizon, "candles": candles})
    return util.clean(out)


# ============================================================ WYCKOFF

def _closed(name: str, tf: str) -> pd.DataFrame:
    df = store.get(name)[["time", "open", "high", "low", "close", "volume"]].dropna()
    end = df["time"] + pd.Timedelta(seconds=TF_SECONDS[tf])
    return df[end <= _now()].reset_index(drop=True)


def _extra_1d() -> list[pd.DataFrame]:
    """Storico giornaliero precedente a Binance (dataset `daily`, 2012 → 16 ago 2017) come segmento indipendente del backtest."""
    try:
        d = store.get("daily")[["time", "open", "high", "low", "close", "volume"]].dropna()
    except Exception:  # noqa: BLE001
        return []
    d = d[(d["time"] >= "2012-06-01") & (d["time"] < "2017-08-17") & (d["volume"] > 0)]
    return [d.reset_index(drop=True)] if len(d) > 300 else []


@util.ttl_cache(300)
def _wyckoff_core(tf: str, last_key: str) -> dict:
    df = _closed(TF_DATASET[tf], tf)
    return tw.compute(df, tf, CHART_BARS[tf], extra=_extra_1d() if tf == "1d" else None)


def build_wyckoff(tf: str = "1d", **_params) -> dict:
    df = _closed(TF_DATASET[tf], tf)
    core = _wyckoff_core(tf, str(df["time"].iat[-1]))
    full = store.get(TF_DATASET[tf])
    candles = [{"time": util.ts(r.time), "open": r.open, "high": r.high, "low": r.low, "close": r.close, "volume": r.volume}
               for r in full.iloc[-(CHART_BARS[tf] + 1):].itertuples(index=False)]
    return util.clean({**core, "generated_at": int(time.time()), "price": _price(), "candles": candles})


# ============================================================ RITMI

@util.ttl_cache(1800)
def _rhythms(kind: str, how: str, pattern: str, theta: float, start: str, recent: str, day_key: str) -> dict:
    g = _grid()
    now = _now()
    st = RHYTHM_START[start]
    rf = pd.Timestamp(recent, tz="UTC")
    if kind == "thirds":
        return trh.thirds(g, now, st, rf, pattern, how, theta)
    k1h = store.get("k_1h") if kind == "hour" else None
    return trh.buckets(kind, g, k1h, now, st, rf)


def build_rhythms(kind: str = "thirds", how: str = "close", pattern: str = "+-+", theta: float = 3.0, start: str = "2017",
                  recent: str = "2026-08-01", **_params) -> dict:
    now = _now()
    key = now.strftime("%Y-%m-%d") if kind != "hour" else now.strftime("%Y-%m-%dT%H")
    out = _rhythms(kind, how, pattern, float(theta), start, recent, key)
    return util.clean({**out, "generated_at": int(time.time()), "start": RHYTHM_START[start], "start_key": start,
                       "thetas": trh.THETAS, "patterns": trh.PATTERNS, "combos": trh.COMBOS})


# ============================================================ SCENARI

def _levels(price: float, wy: dict[str, dict]) -> list[dict]:
    """Livelli esistenti (range Wyckoff 1D/4H, range di struttura 1D, VWAP ancorati) con la loro fonte."""
    lv: list[dict] = []
    for tf, w in wy.items():
        a = w.get("active")
        if a and a.get("high") and a.get("low"):
            lv.append({"price": a["high"], "src": f"wy_{tf}_high"})
            lv.append({"price": a["low"], "src": f"wy_{tf}_low"})
    try:
        from . import structure as srt
        r1 = (srt._ranges_raw().get("tf") or {}).get("1d") or {}
        rg = r1.get("range")
        if rg:
            lv += [{"price": rg["high"], "src": "st_1d_high"}, {"price": rg["low"], "src": "st_1d_low"}, {"price": rg["mid"], "src": "st_1d_mid"}]
    except Exception as e:  # noqa: BLE001
        log.info("timing: range di struttura non disponibile: %s", e)
    try:
        from . import vwap as vwr
        v = vwr.build()
        if not v.get("periods_data"):          # Kraken ancora in sincronizzazione: stessi livelli da Binance USDⓈ-M
            v = vwr.build("binance")
        pdict = v.get("periods_data") or {}
        for p in ("w", "m", "q", "y"):
            L = pdict.get(p) or {}
            if L.get("vwap"):
                lv.append({"price": L["vwap"], "src": f"vwap_{p}"})
            if (L.get("prev") or {}).get("vwap") and p in ("w", "m"):
                lv.append({"price": L["prev"]["vwap"], "src": f"vwap_p{p}"})
    except Exception as e:  # noqa: BLE001
        log.info("timing: VWAP non disponibili: %s", e)
    out = [x for x in lv if x["price"] and np.isfinite(x["price"]) and 0.5 * price < x["price"] < 1.5 * price]
    return sorted(out, key=lambda x: x["price"])


def _cluster(levels: list[dict], price: float) -> list[dict]:
    groups: list[list[dict]] = []
    for x in levels:
        if groups and (x["price"] / groups[-1][0]["price"] - 1) * 100 <= LEVEL_CLUSTER_PCT:
            groups[-1].append(x)
        else:
            groups.append([x])
    out = []
    for gr in groups:
        p = float(np.mean([x["price"] for x in gr]))
        out.append({"price": p, "low": min(x["price"] for x in gr), "high": max(x["price"] for x in gr),
                    "sources": sorted({x["src"] for x in gr}), "dist": (p / price - 1) * 100})
    return out


def _stat(wy: dict, key: str, days: int = 10) -> dict | None:
    for row in (wy.get("backtest") or {}).get("rows") or []:
        if row["key"] == key:
            h = next((x for x in row["horizons"] if x["days"] == days), None)
            if h:
                return {"key": key, "days": days, "n": h.get("n"), "mean": h.get("mean"), "excess": h.get("excess"), "hit": h.get("hit"),
                        "base_hit": h.get("base_hit"), "p": h.get("p"), "p_bh": h.get("p_bh"), "verdict": h.get("verdict"),
                        "direction": row["direction"], "agrees": h.get("agrees")}
    return None


def _wy_summary(w: dict) -> dict:
    a = w.get("active")
    last_ev = None
    stat = None
    if a:
        evs = [e for e in a["events"] if e["key"] in tw.BACKTEST_KEYS]
        if evs:
            last_ev = evs[-1]
            stat = _stat(w, last_ev["key"])
    lr = w.get("last_range")
    return {"tf": w["tf"], "active": ({k: a[k] for k in ("side", "phase", "high", "low", "start", "confirmed", "bars", "width_pct")}
                                      | {"last_event": a["events"][-1] if a["events"] else None}) if a else None,
            "last_key_event": last_ev, "stat": stat,
            "last_closed": ({k: lr[k] for k in ("side", "status", "phase", "high", "low", "start", "end")} if lr and lr["status"] != "active" else None),
            "key_stats": [s for s in (_stat(w, k) for k in tw.KEY_EVENTS) if s]}


@util.ttl_cache(60)
def build_overview(**_params) -> dict:
    t0 = time.time()
    now = _now()
    price = _price()
    gann = build_gann(90, 10, 2)
    wy = {tf: build_wyckoff(tf) for tf in ("1d", "4h")}
    rh_close = build_rhythms("thirds", "close", "+-+", 3.0, "2017", "2026-08-01")
    rh_ext = build_rhythms("thirds", "extremes", "+-+", 3.0, "2017", "2026-08-01")
    ups = [u for u in gann["upcoming"] if u["score"] >= 2]
    soon = [u for u in ups if u["days_away"] <= 30]
    nxt = max(soon, key=lambda u: (u["score"], -u["days_away"])) if soon else (ups[0] if ups else None)
    verdicts = {}
    for r in gann["types"]:
        verdicts[r.get("verdict") or "none"] = verdicts.get(r.get("verdict") or "none", 0) + 1
    best_bin = max((b for b in gann["score_bins"] if b.get("n")), key=lambda b: b.get("lift") or 0, default=None)
    # ------------------------------------------------ scenari
    levels = _cluster(_levels(price, wy), price)
    sup = [x for x in levels if x["price"] < price * (1 - 0.0005)]
    res = [x for x in levels if x["price"] > price * (1 + 0.0005)]
    pivot = sup[-1] if sup else None
    scen = None
    if pivot:
        below = [x for x in sup if x["price"] < pivot["low"]]
        scen = {
            "pivot": pivot,
            "hold": {"level": pivot, "next": res[:2], "invalid": pivot},
            "lose": {"level": pivot, "next": below[::-1][:2], "invalid": pivot},
            "resistance": res[0] if res else None,
        }
    out = {
        "generated_at": int(time.time()), "today": now.normalize(), "price": price,
        "gann": {"next": nxt, "upcoming": ups[:8], "verdicts": verdicts, "score_bins": gann["score_bins"], "best_bin": best_bin,
                 "params": gann["params"], "sample": gann["sample"],
                 "types": [{k: r.get(k) for k in ("id", "n", "hit_rate", "base_rate", "lift", "p_shift", "p_bh", "p_bh_all", "verdict")} for r in gann["types"]]},
        "wyckoff": {tf: _wy_summary(w) for tf, w in wy.items()},
        "rhythm": {"close": {k: rh_close[k] for k in ("full", "recent", "verdict", "p_sidak", "combos")} | {"current": rh_close["months"][0]},
                   "extremes": {k: rh_ext[k] for k in ("full", "recent", "verdict", "p_sidak", "theta")} | {"current": rh_ext["months"][0]}},
        "levels": levels,
        "scenarios": scen,
    }
    log.info("timing overview in %.2fs", time.time() - t0)
    return util.clean(out)


# ============================================================ route

def _run(fn, *a, **k):
    try:
        return fn(*a, **k)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, f"parametro non valido: {e}") from e
    except Exception as e:  # noqa: BLE001
        log.exception("timing fallito")
        raise HTTPException(503, f"Timing non disponibile: {e}") from e


@router.get("/timing")
def timing_route():
    return _run(build_overview)


@router.get("/timing/gann")
def timing_gann_route(horizon: int = Query(90, ge=14, le=365), pivot: int = Query(10), win: int = Query(2)):
    if (pivot, win) not in tg.DEFS:
        raise HTTPException(400, "definizione non valida: pivot 10|20, win 1|2|3")
    return _run(build_gann, horizon, pivot, win)


@router.get("/timing/wyckoff")
def timing_wyckoff_route(tf: str = Query("1d", pattern="^(1d|4h)$")):
    return _run(build_wyckoff, tf)


@router.get("/timing/rhythms")
def timing_rhythms_route(kind: str = Query("thirds", pattern="^(thirds|weekday|monthweek|monthday|hour)$"),
                         how: str = Query("close", pattern="^(close|extremes)$"), pattern: str = Query("+-+", pattern=r"^[+\-.]{3}$"),
                         theta: float = Query(3.0), start: str = Query("2017", pattern="^(2017|2013)$"),
                         recent: str = Query("2026-08-01", pattern=r"^\d{4}-\d{2}-\d{2}$")):
    if pattern == "...":
        raise HTTPException(400, "schema vuoto")
    if theta not in trh.THETAS:
        raise HTTPException(400, "soglia non valida: 2|3|5")
    try:
        rf = pd.Timestamp(recent, tz="UTC")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, "data non valida") from e
    if not (pd.Timestamp("2014-01-01", tz="UTC") <= rf <= _now()):
        raise HTTPException(400, "periodo recente fuori dallo storico")
    return _run(build_rhythms, kind, how, pattern, theta, start, recent)
