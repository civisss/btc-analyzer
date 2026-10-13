"""Router STRUCTURE: /structure (+ /structure/pivots, /structure/ranges, /structure/scenarios).

Struttura di mercato in stile KillaXBT / LP_NXT: pivot di apertura (Monday range, aperture, chiusure settimanali),
range HTF con deviazioni/accettazione/retest, SFP, BOS/CHoCH con statistiche storiche, piano scenari condizionali.
"""
from __future__ import annotations

import logging
import time

import pandas as pd
from fastapi import APIRouter, HTTPException

from .. import util
from ..analysis import liquidations as liq_an
from ..analysis import scenarios as sc
from ..analysis import structure as st
from ..analysis.market import atr as _atr
from ..data import store
from . import analogs as analogs_router
from . import market as market_router
from . import timepivots as timepivots_router

log = logging.getLogger("structure")
router = APIRouter()

METHOD = {
    "pivots": (
        "Monday range: massimo e minimo del lunedì (00:00–23:59 UTC) dalle candele 1h Binance BTCUSDT dal 2018. "
        "Per ogni settimana completa si misura se il resto della settimana (mar–dom) rompe il massimo/minimo, quante ore dopo, "
        "l'estensione oltre il livello, il rientro nel range (chiusura 1h di nuovo dentro) e il movimento inverso misurato dal livello "
        "rotto (≥2% / ≥3% oltre il livello nella direzione opposta). Regime: ADX(14) giornaliero al lunedì (≥ 25 = in trend). "
        "Magnete delle aperture: dopo che il prezzo si è allontanato di almeno X% dall'apertura del periodo, si verifica se la tocca "
        "di nuovo prima della fine del periodo (settimanale da 1h dal 2018; mensile/trimestrale/annuale dal giornaliero dal 2012). "
        "Chiusure settimanali: settimane lun–dom ricostruite dal giornaliero dal 2012, rendimenti a 1/2/4 settimane dalla chiusura."
    ),
    "ranges": (
        "Range corrente: per ogni timeframe si provano come inizio i pivot di uno zigzag ATR recente; gli estremi sono i cluster di "
        "frattali (tolleranza 0.5 ATR) con almeno 2 tocchi, le chiusure devono restare per il 90% dentro il range. Si sceglie il range "
        "più recente con ≥2 tocchi per lato; quello più ampio che lo contiene è il «range ampio». Eventi: deviazione/sweep = wick oltre "
        "il bordo (≥0.1 ATR) e chiusura dentro; accettazione = 2 chiusure consecutive fuori (3 sul 4H); recupero/rottura fallita = chiusura "
        "fuori seguita da chiusura dentro; retest = ritorno sul bordo rotto dopo l'accettazione (tenuto se chiude dal lato della rottura). "
        "SFP = wick oltre un frattale non ancora violato (ultime 60 barre) e chiusura dal lato opposto. BOS/CHoCH = chiusura oltre l'ultimo "
        "swing confermato dello zigzag ATR, nella direzione della struttura (BOS) o contro (CHoCH). Statistiche storiche: definizioni causali "
        "(nessun dato futuro) su 1D dal 2012 e 4H dal 2018, con range = canale delle ultime 20 barre (1D) / 42 barre (4H) di ampiezza ≤7/8 ATR "
        "e ≥2 tocchi per lato; obiettivi e invalidazione verificati sulle 14 giornate successive (se toccati nella stessa barra conta l'invalidazione)."
    ),
    "scenarios": (
        "Gli scenari sono costruiti da regole fisse: lo stato del range giornaliero sceglie le condizioni (tenuta/perdita del bordo più vicino, "
        "rotazione interna), gli obiettivi sono i primi livelli in direzione che uniscono più fonti entro lo 0.6% (range, aperture, massimi/minimi "
        "precedenti, zone 1D, cluster di liquidazioni stimati, pool di liquidità), l'invalidazione è il livello che renderebbe falsa la condizione. "
        "La probabilità è la frequenza storica condizionata dell'evento corrispondente (vedi tab Range e struttura), non la probabilità dello scenario. "
        "I tempi del percorso sono indicativi (½ ATR giornaliero al giorno); le finestre temporali vengono dai pivot temporali."
    ),
}


def _safe(fn, *a, **k):
    try:
        return fn(*a, **k)
    except Exception as e:  # noqa: BLE001
        log.warning("structure: %s non disponibile: %s", getattr(fn, "__name__", fn), e)
        return None


def _price() -> float:
    p = market_router.live_price()
    if p:
        return float(p)
    return float(store.get("k_1h")["close"].iloc[-1])


# ------------------------------------------------------------------ cache pesanti (statistiche storiche)

@util.ttl_cache(1800)
def _event_stats(day_key: str) -> dict:
    d = store.get("daily")
    d = d[d["time"] >= "2012-01-01"][["time", "open", "high", "low", "close"]].dropna().reset_index(drop=True)
    h4 = store.get("k_4h")
    h4 = h4[h4["time"] >= "2018-01-01"][["time", "open", "high", "low", "close"]].dropna().reset_index(drop=True)
    # l'ultima candela è in formazione: esclusa dalle statistiche
    return {"1d": st.event_stats(d.iloc[:-1].reset_index(drop=True), "1d"), "4h": st.event_stats(h4.iloc[:-1].reset_index(drop=True), "4h")}


# ------------------------------------------------------------------ sezioni

@util.ttl_cache(30)
def build_pivots() -> dict:
    t0 = time.time()
    now = pd.Timestamp.now(tz="UTC")
    price = _price()
    h1, d1, w1, daily = store.get("k_1h"), store.get("k_1d"), store.get("k_1w"), store.get("daily")
    mon = st.monday_range(h1, d1, now, price)
    op = st.opens(h1, d1, daily, now, price)
    wc = st.weekly_close(daily, w1, now, price)
    # candele 1h per il grafico: settimana corrente + precedente
    wk0 = op["week_start"] - pd.Timedelta(days=7)
    c1 = h1[h1["time"] >= wk0]
    candles = [{"time": util.ts(r.time), "open": r.open, "high": r.high, "low": r.low, "close": r.close, "volume": r.volume}
               for r in c1.itertuples(index=False)]
    week_lines = []
    for row in mon["history"][:1]:
        week_lines.append({"week_start": row["week_start"], "high": row["high"], "low": row["low"]})
    out = {
        "generated_at": int(time.time()), "price": price,
        "monday": mon, "opens": op, "weekly_close": wc,
        "chart": {"candles": candles, "prev_monday": week_lines[0] if week_lines else None},
        "method": METHOD["pivots"],
    }
    log.info("structure/pivots in %.2fs", time.time() - t0)
    return util.clean(out)


@util.ttl_cache(30)
def _ranges_raw() -> dict:
    now = pd.Timestamp.now(tz="UTC")
    price = _price()
    out = {}
    for tf in ("4h", "1d", "1w"):
        df = market_router._frame(tf)
        out[tf] = st.range_state(df, tf, price)
    stats = _event_stats(now.strftime("%Y-%m-%d"))
    return {"price": price, "tf": out, "stats": stats}


def _range_public(r: dict) -> dict:
    return {k: v for k, v in r.items() if k not in ("atr", "last_close")} | {"atr": r.get("atr")}


@util.ttl_cache(30)
def build_ranges() -> dict:
    t0 = time.time()
    raw = _ranges_raw()
    tfs = raw["tf"]
    d1 = tfs["1d"]
    out = {
        "generated_at": int(time.time()), "price": raw["price"],
        "timeframes": {tf: _range_public(tfs[tf]) for tf in ("4h", "1d", "1w")},
        "stats": raw["stats"],
        "summary": d1.get("text", ""),
        "method": METHOD["ranges"],
    }
    log.info("structure/ranges in %.2fs", time.time() - t0)
    return util.clean(out)


def _liq_ctx() -> dict | None:
    m = liq_an.model()
    cur = float(m["df"]["close"].iloc[-1])
    cl, magnet = liq_an.clusters(m)
    return {"clusters": cl, "pools": liq_an.pools(cur), "magnet": magnet}


def _analog_ctx() -> dict | None:
    a = analogs_router.build(tf="1d")
    s = a["summary"]
    best = a["matches"][0] if a.get("matches") else None
    return {"bias": s.get("bias"), "median_outcome": s.get("median_outcome"), "up": s.get("up"), "down": s.get("down"),
            "count": s.get("count"), "text": s.get("text"), "horizon": a.get("horizon"),
            "best": ({"label": best["period"]["label"], "similarity": best["similarity"], "change": best["outcome"]["change"],
                      "max_up": best["outcome"]["max_up"], "max_down": best["outcome"]["max_down"]} if best else None)}


def _timepivot_ctx() -> list[dict]:
    tp = timepivots_router.build(90)
    return [c for c in tp.get("calendar", []) if c.get("days_away") is not None and -3 <= c["days_away"] <= 21]


@util.ttl_cache(45)
def build_scenarios() -> dict:
    t0 = time.time()
    now = pd.Timestamp.now(tz="UTC")
    raw = _ranges_raw()
    piv = build_pivots()
    price = raw["price"]
    d1 = market_router._frame("1d")
    atr_d = float(_atr(d1).iloc[-1])
    lv = _safe(market_router.build_levels, "1d") or {}
    wmag = next((m for m in piv["opens"]["weekly"]["magnet"] if m["threshold"] == 1.0), None)
    ctx = {
        "price": price, "now": now, "atr_d": atr_d,
        "r1d": raw["tf"]["1d"], "r4h": raw["tf"]["4h"], "r1w": raw["tf"]["1w"],
        "stats1d": raw["stats"]["1d"], "stats4h": raw["stats"]["4h"],
        "monday": piv["monday"]["current"], "open_levels": piv["opens"]["levels"],
        "weekly_open": piv["opens"]["weekly"]["open"],
        "weekly_magnet": wmag["revisit_pct"] if wmag else None, "weekly_magnet_n": wmag["n"] if wmag else None,
        "weekly": piv["weekly_close"]["current"],
        "key_levels": lv.get("key_levels", []),
        "liq": _safe(_liq_ctx), "analogs": _safe(_analog_ctx), "timepivots": _safe(_timepivot_ctx) or [],
    }
    res = sc.build(ctx)
    r = raw["tf"]["1d"].get("range")
    out = {
        "generated_at": int(time.time()), "price": price, "atr_d": atr_d,
        "state": raw["tf"]["1d"].get("state"), "state_label": raw["tf"]["1d"].get("state_label"),
        "range": ({k: r[k] for k in ("high", "low", "mid", "start")} if r else None),
        **res,
        "sources": {"liquidity": ctx["liq"] is not None, "analogs": ctx["analogs"] is not None, "timepivots": bool(ctx["timepivots"]),
                    "levels": bool(ctx["key_levels"])},
        "method": METHOD["scenarios"],
    }
    log.info("structure/scenarios in %.2fs", time.time() - t0)
    return util.clean(out)


def build() -> dict:
    return {"pivots": build_pivots(), "ranges": build_ranges(), "scenarios": build_scenarios()}


def _run(fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        log.exception("structure fallito")
        raise HTTPException(503, f"struttura non disponibile: {e}") from e


@router.get("/structure")
def structure_all():
    return _run(build)


@router.get("/structure/pivots")
def structure_pivots():
    return _run(build_pivots)


@router.get("/structure/ranges")
def structure_ranges():
    return _run(build_ranges)


@router.get("/structure/scenarios")
def structure_scenarios():
    return _run(build_scenarios)
