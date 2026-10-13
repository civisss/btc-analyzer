"""GET /api/astro — studio "Astronomia e numeri": calendari astronomici verificati, ipotesi testate contro il caso,
prossimi eventi (90 giorni) con il comportamento storico di BTC. I testi sono composti dal frontend (chiavi + numeri)."""
from __future__ import annotations

import logging
import time

import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..analysis import astro as an
from ..analysis import astro_calendar as ac
from ..analysis.cycles import HALVINGS, NEXT_HALVING_BLOCK
from ..data import store

log = logging.getLogger("astro")
router = APIRouter()
DAY = pd.Timedelta(days=1)

# tipo di evento in calendario -> ipotesi che ne misura il comportamento storico
EVENT_HYP = {"full": "moon_full", "new": "moon_new", "supermoon": "supermoon", "lunar_eclipse_total": "lunar_eclipse_total",
             "lunar_eclipse": "lunar_eclipse_all", "solar_eclipse": "solar_eclipse", "mercury_retro_start": "mercury_retro",
             "mercury_retro_end": "mercury_retro", "mar_equinox": "seasons", "jun_solstice": "seasons", "sep_equinox": "seasons",
             "dec_solstice": "seasons", "friday13": "friday13", "geomag_storm": "geomag_storm"}


def _price() -> float | None:
    try:
        from .market import live_price
        return live_price()
    except Exception:  # noqa: BLE001
        return None


@util.ttl_cache(6 * 3600)
def _heavy(day_key: str) -> dict:
    from . import timepivots as tpr
    return util.clean(an.compute(tpr._grid()))


def _upcoming(now: pd.Timestamp, horizon: int, hyps: dict[str, dict], kp: dict) -> list[dict]:
    end = now + horizon * DAY
    y0, y1 = now.year, end.year
    out: list[dict] = []

    def add(key: str, t: pd.Timestamp, **extra):
        if not (now - 12 * 3600 * pd.Timedelta(seconds=1) <= t <= end):
            return
        h = hyps.get(EVENT_HYP.get(key, ""), {})
        out.append({"id": f"{key}:{t.strftime('%Y-%m-%dT%H:%M')}", "key": key, "time": util.ts(t), "hyp": EVENT_HYP.get(key),
                    "n": h.get("n_events") or h.get("n"), "observed": h.get("observed"), "baseline": h.get("baseline"),
                    "effect": h.get("effect"), "up_rate": h.get("up_rate"), "up_base": h.get("up_base"), "unit": h.get("unit"),
                    "p": h.get("p"), "p_bh": h.get("p_bh"), "verdict": h.get("verdict"), "window": h.get("window"), **extra})

    q = ac.moon_quarters(y0, y1)
    for r in q[q["key"].isin(["full", "new"])].itertuples():
        if r.key == "full" and r.supermoon:
            add("supermoon", r.time, distance_km=round(r.distance_km))
        else:
            add(r.key, r.time, distance_km=round(r.distance_km) if r.distance_km == r.distance_km else None)
    for e in ac.lunar_eclipses(y0, y1):
        add("lunar_eclipse_total" if e["kind"] == "total" else "lunar_eclipse", e["time"], kind=e["kind"])
    for e in ac.solar_eclipses(y0, y1):
        add("solar_eclipse", e["time"], kind=e["kind"])
    for s in ac.mercury_stations(y0, y1):
        add("mercury_retro_start" if s["kind"] == "retro" else "mercury_retro_end", s["time"])
    for s in ac.seasons(y0, y1):
        add(s["key"], s["time"])
    for d in ac.friday13(y0, y1):
        add("friday13", d)
    # tempeste geomagnetiche previste da NOAA (Kp ≥ 5 nei prossimi 3 giorni): una voce per giorno
    seen = set()
    for f in kp.get("forecast") or []:
        if (f.get("kp") or 0) >= 5:
            t = pd.Timestamp(f["time"], unit="s", tz="UTC")
            if t.normalize() not in seen:
                seen.add(t.normalize())
                add("geomag_storm", t, kp=f["kp"])
    out.sort(key=lambda x: x["time"])
    return out


def _bitcoin_numbers(price: float | None, g_last_close: float) -> dict:
    from .cycles import _next_halving
    eta, height, left = _next_halving()
    p = price or g_last_close
    out = {
        "max_supply": 20_999_999.9769, "halving_interval": 210_000, "block_target_s": 600, "retarget_blocks": 2016,
        "sats_per_btc": 100_000_000, "genesis": util.ts(pd.Timestamp("2009-01-03 18:15:05", tz="UTC")),
        "pizza_day": util.ts(pd.Timestamp("2010-05-22", tz="UTC")), "pizza_btc": 10_000,
        "halvings": [{"n": n, "time": util.ts(t), "block": b, "subsidy_after": 50 / 2 ** n} for n, t, b in HALVINGS],
        "next_halving_block": NEXT_HALVING_BLOCK, "next_halving_eta": util.ts(eta), "height": height, "blocks_left": left,
        "sats_per_usd": round(1e8 / p) if p else None, "pizza_usd": round(10_000 * p) if p else None,
    }
    if height:
        sup = an.issued_supply(height)
        out.update({"issued": round(sup, 2), "issued_pct": round(sup / 20_999_999.9769 * 100, 3),
                    "subsidy": 50 / 2 ** (height // 210_000), "epoch": height // 210_000})
    return out


def build(horizon: int = 90, **_params) -> dict:
    now = pd.Timestamp.now(tz="UTC")
    heavy = _heavy(now.strftime("%Y-%m-%d"))
    hyps = {h["id"]: h for h in heavy["hypotheses"]}
    kp = an.noaa_kp()
    price = _price()
    from . import timepivots as tpr
    g = tpr._grid()
    y = now.year
    q = ac.moon_quarters(y - 1, y + 1)
    nxt = q[q["time"] > now].head(8)
    prev_new = q[(q["key"] == "new") & (q["time"] <= now)].tail(1)
    moon_now = ac.moon_now(now)
    merc = ac.mercury_periods(y - 1, y + 1)
    cur_retro = next((p for p in merc if p["start"] <= now <= p["end"]), None)
    next_retro = next((p for p in merc if p["start"] > now), None)
    # Kp attuale: ultimo valore osservato NOAA; altrimenti dall'archivio GFZ
    kp_now = (kp.get("recent") or [None])[-1]
    k1d = store.get("k_1d")
    candles = [{"time": util.ts(r.time), "open": r.open, "high": r.high, "low": r.low, "close": r.close, "volume": r.volume}
               for r in k1d.iloc[-1100:].itertuples(index=False)]
    out = {
        "generated_at": int(time.time()), "today": util.ts(now.normalize()), "price": price or float(g.close[-1]), "horizon": horizon,
        **{k: v for k, v in heavy.items() if k not in ("hypotheses",)},
        "hypotheses": heavy["hypotheses"],
        "moon": {**heavy["moon"], "now": moon_now,
                 "prev_new": util.ts(prev_new["time"].iloc[0]) if len(prev_new) else None,
                 "next": [{"key": r.key, "time": util.ts(r.time), "supermoon": bool(r.supermoon),
                           "distance_km": round(r.distance_km) if r.distance_km == r.distance_km else None} for r in nxt.itertuples()]},
        "mercury": {**heavy["mercury"], "now": {"retro": cur_retro is not None,
                                                "start": util.ts(cur_retro["start"]) if cur_retro else None,
                                                "end": util.ts(cur_retro["end"]) if cur_retro else None,
                                                "next_start": util.ts(next_retro["start"]) if next_retro else None,
                                                "next_end": util.ts(next_retro["end"]) if next_retro else None}},
        "geomag": {**heavy["geomag"], "now": kp_now, "recent": kp.get("recent") or [], "forecast": kp.get("forecast") or []},
        "upcoming": _upcoming(now, horizon, hyps, kp),
        "numbers": {**heavy["numbers"], "bitcoin": _bitcoin_numbers(price, float(g.close[-1]))},
        "candles": candles,
        "verification": an.load_verification(),
        "constants": {"supermoon_km": ac.SUPERMOON_KM, "synodic_days": ac.SYNODIC, "alpha": an.ALPHA, "min_n": an.MIN_N,
                      "min_shift": an.MIN_SHIFT, "n_boot": an.N_BOOT, "n_ctrl": an.N_CTRL},
    }
    return util.clean(out)


@router.get("/astro")
def astro_route(horizon: int = Query(90, ge=14, le=365)):
    try:
        return build(horizon)
    except Exception as e:  # noqa: BLE001
        log.exception("astro fallito")
        raise HTTPException(503, f"Studio astronomico non disponibile: {e}") from e
