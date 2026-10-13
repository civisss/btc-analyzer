"""Router ON-CHAIN: /onchain — metriche CoinMetrics derivate + stato rete (mempool.space)."""
from __future__ import annotations

import logging
import time

import numpy as np
import pandas as pd
from fastapi import APIRouter

from .. import util
from ..analysis import onchain as oc
from ..analysis.cycles import NEXT_HALVING_BLOCK, round_sig
from ..data import sources as src
from ..data import store

log = logging.getLogger("onchain")
router = APIRouter()

KEYS = ["mvrv", "mvrv_z", "realized_price", "hashrate", "active_addresses", "tx_count",
        "supply", "issuance_usd", "puell", "nupl"]
NOISY_KEYS = {"active_addresses", "tx_count", "issuance_usd"}  # variazione 30g su media mobile 7g
LIVE_KEYS = {"mvrv", "mvrv_z", "nupl"}  # ricalcolate col prezzo live


@util.ttl_cache(120)
def mempool_snapshot() -> dict:
    try:
        return src.mempool_stats() or {}
    except Exception as e:  # noqa: BLE001
        log.warning("mempool non disponibile: %s", e)
        return {}


def _network() -> dict:
    mp = mempool_snapshot()
    height = mp.get("height")
    height = int(height) if isinstance(height, (int, float)) else None
    fees = mp.get("fees")
    fees_out = None
    if isinstance(fees, dict) and fees:
        fees_out = {"fastest": fees.get("fastestFee"), "hour": fees.get("hourFee"), "economy": fees.get("economyFee")}
    diff = mp.get("difficulty") if isinstance(mp.get("difficulty"), dict) else {}
    nr = diff.get("estimatedRetargetDate")
    next_retarget = int(nr / 1000) if isinstance(nr, (int, float)) else None
    blocks_left = halving_eta = None
    if height:
        blocks_left = NEXT_HALVING_BLOCK - height
        avg = diff.get("timeAvg")
        avg_s = avg / 1000 if isinstance(avg, (int, float)) and 300_000 < avg < 900_000 else 600.0
        avg_s = 0.5 * avg_s + 0.5 * 600
        halving_eta = int(time.time() + blocks_left * avg_s)
    return {"block_height": height, "fees": fees_out, "difficulty_change": diff.get("difficultyChange"),
            "next_retarget": next_retarget, "halving_eta": halving_eta, "blocks_to_halving": blocks_left}


def _hist_series(s: pd.Series, sig: int = 5) -> list[dict]:
    """Settimanale per lo storico, giornaliero nell'ultimo anno."""
    s = s.dropna()
    if s.empty:
        return []
    cut = s.index[-1] - pd.Timedelta(days=365)
    old, new = s[s.index < cut], s[s.index >= cut]
    if len(old):
        old = old.iloc[np.arange(len(old) - 1, -1, -7)[::-1]]
    s = pd.concat([old, new])
    return [{"time": util.ts(t), "value": round_sig(float(v), sig)} for t, v in s.items()]


@util.ttl_cache(300)
def _heavy() -> dict:
    d = oc.derive(store.get("onchain"))
    series = {k: _hist_series(d[k]) for k in KEYS + ["price"]}
    return {"d": d, "series": series}


def _live_price() -> float | None:
    try:
        from .market import live_price
        return live_price()
    except Exception:  # noqa: BLE001
        return None


@util.ttl_cache(20)
def build() -> dict:
    h = _heavy()
    d: pd.DataFrame = h["d"]
    lp = _live_price()
    last = d.dropna(subset=["mvrv"]).iloc[-1]
    live = {}
    if lp and np.isfinite(last["realized_cap"]) and last["supply"] > 0:
        mcap_live = lp * last["supply"]
        std = d["price"].mul(d["supply"]).dropna().std()
        live["mvrv"] = mcap_live / last["realized_cap"]
        live["nupl"] = 1 - 1 / live["mvrv"]
        live["mvrv_z"] = (mcap_live - last["realized_cap"]) / std
    dd = d.copy()
    if lp:
        dd.loc[dd.index[-1], "price"] = lp  # per il confronto con il prezzo realizzato
    metrics = []
    for k in KEYS:
        s = d[k].dropna()
        if s.empty:
            continue
        v = float(live.get(k, s.iloc[-1]))
        prev_t = s.index[-1] - pd.Timedelta(days=30)
        ch = None
        if k in NOISY_KEYS:  # attività giornaliera rumorosa: confronto tra medie 7 giorni
            sm = s.rolling(7, min_periods=4).mean()
            prev = sm[sm.index <= prev_t]
            if len(prev) and prev.iloc[-1]:
                ch = (float(sm.iloc[-1]) - prev.iloc[-1]) / abs(prev.iloc[-1]) * 100
        else:
            prev = s[s.index <= prev_t]
            if len(prev) and prev.iloc[-1] != 0:
                ch = (v - prev.iloc[-1]) / abs(prev.iloc[-1]) * 100
        status, tone = oc.status_for(k, v, dd)
        spark = [{"time": util.ts(t), "value": round_sig(float(x), 5)} for t, x in s.tail(90).items()]
        metrics.append({"key": k, "label": oc.LABELS[k], "value": v, "display": oc.display_for(k, v),
                        "change_30d": ch, "status": status, "tone": tone, "spark": spark})
    return util.clean({"metrics": metrics, "series": h["series"], "network": _network()})


@router.get("/onchain")
def onchain_route():
    return build()
