"""Mappa delle liquidazioni per leva: barre per fascia di prezzo, impilate per gruppo di leva, finestre 1 e 7 giorni.

Riusa il modello di analysis/liquidations.py (OI aggregato Binance + Bybit + OKX, mix di leva dichiarato): è una stima di dove si
troverebbero le liquidazioni delle posizioni aperte nella finestra e ancora vive, non ordini reali. CoinGlass vende una mappa simile,
con dati e ipotesi propri: i livelli possono differire.

Conservazione: la somma delle barre più la parte fuori dall'intervallo mostrato è uguale all'importo vivo della finestra.
"""
from __future__ import annotations

import logging
import math
import time

import numpy as np
import pandas as pd

from .. import util
from ..data import store
from . import liquidations as lq

log = logging.getLogger("liq_leverage")

WINDOWS = {"1d": 1, "7d": 7}
SPAN = 0.12           # intervallo mostrato: ±12% dal prezzo
NEAR_USD = 2000.0     # "vicino al prezzo" per il tabellone
GROUPS = ("low", "mid", "high")        # ≤ 25×, 50×, 100×


def group_of(lev: np.ndarray) -> np.ndarray:
    """0: fino a 25× (5, 10, 20, 25) · 1: 50× · 2: 100×."""
    return np.where(lev >= 100, 2, np.where(lev >= 50, 1, 0))


def band_step(cur: float) -> float:
    """Fascia adattiva: 250 $ con il prezzo intorno a 80K (0.3% arrotondato a un passo rotondo)."""
    return float(lq._nice_step(cur * 0.003))


def bin_levels(liq: np.ndarray, usd: np.ndarray, is_long: np.ndarray, lev: np.ndarray, cur: float, step: float, span: float = SPAN) -> dict:
    """Istogramma per fascia, lato e gruppo di leva. Funzione pura: la conservazione è verificata nei test."""
    lo = math.floor(cur * (1 - span) / step) * step
    hi = math.ceil(cur * (1 + span) / step) * step
    nb = int(round((hi - lo) / step))
    idx = np.floor((liq - lo) / step).astype(int)
    inside = (idx >= 0) & (idx < nb)
    g = group_of(lev)
    bars = np.zeros((2, 3, nb))  # lato (0 long, 1 short), gruppo, fascia
    for s, m in ((0, is_long), (1, ~is_long)):
        for k in range(3):
            sel = inside & m & (g == k)
            bars[s, k] = np.bincount(idx[sel], weights=usd[sel], minlength=nb)
    return {"lo": lo, "hi": hi, "step": step, "bars": bars, "outside": float(usd[~inside].sum()), "total": float(usd.sum())}


def top_clusters(total: np.ndarray, edges_lo: float, step: float, n: int = 3, width: int = 3, gap: int = 4) -> list[dict]:
    """Migliori `n` finestre di `width` fasce adiacenti, distanti almeno `gap` fasce: ogni etichetta indica una zona diversa."""
    v = total.astype(float).copy()
    if len(v) < width:
        return []
    out = []
    used = np.zeros(len(v), bool)
    for _ in range(n):
        sums = np.convolve(np.where(used, 0.0, v), np.ones(width), "valid")
        for i in range(len(sums)):
            if used[i:i + width].any():
                sums[i] = 0
        i = int(np.argmax(sums))
        if sums[i] <= 0:
            break
        used[max(i - gap, 0):i + width + gap] = True
        out.append({"lo": edges_lo + i * step, "hi": edges_lo + (i + width) * step, "usd": float(sums[i])})
    return out


def _window_levels(m: dict, days: float, t: int | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float, pd.Timestamp]:
    df = m["df"]
    t = len(df) - 1 if t is None else t
    mask, amt = lq._active_at(m, t)
    birth = m["birth"][mask]
    t_end = df["time"].iloc[t]
    keep = (df["time"] > t_end - pd.Timedelta(days=days)).to_numpy()[birth]
    return m["liq"][mask][keep], amt[keep], m["is_long"][mask][keep], m["lev"][mask][keep], float(df["close"].iloc[t]), t_end


def build_window(m: dict, window: str, t: int | None = None) -> dict:
    liq, amt, il, lev, cur, t_end = _window_levels(m, WINDOWS[window], t)
    step = band_step(cur)
    b = bin_levels(liq, amt, il, lev, cur, step)
    bars = b["bars"]
    nb = bars.shape[2]
    prices = b["lo"] + step * np.arange(nb)
    long_t, short_t = bars[0].sum(axis=0), bars[1].sum(axis=0)
    rows = []
    for i in range(nb):
        if long_t[i] <= 0 and short_t[i] <= 0:
            continue
        rows.append({"p": float(prices[i]), "long": [float(bars[0, k, i]) for k in range(3)], "short": [float(bars[1, k, i]) for k in range(3)]})
    near_l = float(amt[il & (liq >= cur - NEAR_USD)].sum())
    near_s = float(amt[~il & (liq <= cur + NEAR_USD)].sum())
    return {
        "window": window, "time": util.ts(t_end), "price": cur, "step": step, "from": b["lo"], "to": b["hi"], "bands": rows,
        "short_above": float(short_t.sum()), "long_below": float(long_t.sum()), "total": b["total"], "outside": b["outside"],
        "by_group": {"long": [float(x) for x in bars[0].sum(axis=1)], "short": [float(x) for x in bars[1].sum(axis=1)]},
        "clusters": {"long": top_clusters(long_t, b["lo"], step), "short": top_clusters(short_t, b["lo"], step)},
        "near": {"span": NEAR_USD, "long": near_l, "short": near_s},
    }


def _hours_cover(t0: float, t1: float) -> np.ndarray:
    """Ore (inizio, s) con la raccolta accesa: sessione attiva ≥ 90% dell'ora, oppure eventi da almeno due exchange (prima che le
    sessioni venissero registrate, o per le ore tagliate da una riconnessione)."""
    from . import moves
    hs = np.arange(math.ceil(t0 / 3600) * 3600, t1 - 3600, 3600)
    ok = {int(h) for h in hs if moves.collection_share(h, h + 3600) >= 0.9}
    ev = store.liquidations()
    if ev is not None and len(ev):
        th = (pd.to_datetime(ev["time"], utc=True).map(lambda x: x.timestamp()).to_numpy() // 3600 * 3600).astype(np.int64)
        n = pd.Series(ev["exchange"].to_numpy()).groupby(th).nunique()
        ok |= {int(h) for h in n[n >= 2].index if t0 <= h < t1 - 3600}
    return np.array(sorted(ok), dtype=np.int64)


def side_check(m: dict, days: int = 30) -> dict:
    """Modello e realtà sulle sole ore con raccolta attiva: importi per lato. La scala non deve coincidere (Binance limita a 1 evento al
    secondo e il modello copre i soli livelli nati dopo l'inizio della simulazione): si confronta soprattutto la quota dei long."""
    out = {"hours": 0, "model_long": None, "model_short": None, "real_long": None, "real_short": None, "days": days}
    df = m["df"]
    now = time.time()
    hrs = _hours_cover(now - days * 86400, now)
    if not len(hrs):
        return out
    n = len(df)
    d = m["death"]
    a0, ls = m["amount0"], m["log_scale"]
    alive = (d < n) & (a0.sum(axis=0) > 0)
    di, bi, il = d[alive], m["birth"][alive], m["is_long"][alive]
    amt = np.zeros(int(alive.sum()))
    for i in range(a0.shape[0]):
        amt += a0[i, alive] * np.exp(ls[i, np.maximum(di - 1, 0)] - ls[i, bi])
    bar_h = (df["time"].map(lambda x: x.timestamp()).to_numpy() // 3600 * 3600).astype(np.int64)
    hs = set(hrs.tolist())
    sel = np.array([h in hs for h in bar_h])[di]
    ev = store.liquidations()
    real = {"long": 0.0, "short": 0.0}
    if ev is not None and len(ev):
        th = (pd.to_datetime(ev["time"], utc=True).map(lambda x: x.timestamp()).to_numpy() // 3600 * 3600).astype(np.int64)
        e = ev[np.array([h in hs for h in th])]
        for s in real:
            real[s] = float(e.loc[e["side"] == s, "usd"].sum())
    out.update({"hours": len(hrs), "model_long": float(amt[sel & il].sum()), "model_short": float(amt[sel & ~il].sum()),
                "real_long": real["long"], "real_short": real["short"]})
    return out


@util.ttl_cache(30)
def build() -> dict:
    m = lq.model()
    wins = {w: build_window(m, w) for w in WINDOWS}
    try:
        val = lq.validate()
    except Exception as e:  # noqa: BLE001
        log.warning("validazione non calcolabile: %s", e)
        val = None
    try:
        chk = side_check(m)
    except Exception as e:  # noqa: BLE001
        log.warning("confronto per lato non calcolabile: %s", e)
        chk = None
    cov = None
    try:
        cov = lq.coverage(m)
    except Exception as e:  # noqa: BLE001
        log.info("copertura non calcolabile: %s", e)
    return util.clean({
        "windows": wins, "validation": val, "side_check": chk, "coverage": cov,
        "groups": [{"id": "low", "leverage": [5, 10, 20, 25]}, {"id": "mid", "leverage": [50]}, {"id": "high", "leverage": [100]}],
        "weights": [{"lev": float(a), "pct": float(b) * 100} for a, b in zip(lq.LEVERAGE, lq.LEV_W)], "mmr_pct": lq.MMR * 100,
    })


def summary(window: str = "7d") -> dict:
    return build()["windows"][window]
