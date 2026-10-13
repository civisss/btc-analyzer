"""Ricerca di frattali / analoghi storici (pattern matching) su 1h/4h/1d/1w.

Algoritmo:
  1. finestra corrente = ultime `window` chiusure (log-prezzo z-normalizzato);
  2. correlazione di Pearson vettoriale (np.correlate + somme cumulative) su TUTTE le finestre storiche
     che terminano (con il loro orizzonte) prima dell'inizio della finestra corrente;
  3. pre-filtro dei migliori ~120 candidati (con soppressione dei vicini), poi DTW con banda Sakoe-Chiba;
  4. similarità 0..100 = 60% correlazione + 40% score DTW; top-K non sovrapposti;
  5. percorsi e futuri riscalati al prezzo corrente; proiezione = quantili pesati p10/p50/p90 degli analoghi.
"""
from __future__ import annotations

import logging
import math

import numpy as np
import pandas as pd

from .. import util
from ..data import store

log = logging.getLogger("fractals")

TF_SOURCE = {"1h": "k_1h", "4h": "k_4h", "1d": "k_1d", "1w": "k_1w"}
TF_STEP = {"1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}
DEFAULTS = {"1h": (72, 36), "4h": (60, 30), "1d": (60, 30), "1w": (26, 12)}
MESI = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"]
N_PREFILTER = 120
MIN_PROJ = 10


def _secs(s: pd.Series) -> np.ndarray:
    s = pd.to_datetime(pd.Series(s), utc=True).astype("datetime64[ns, UTC]")
    return ((s - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(dtype=np.int64)


# ------------------------------------------------------------------ dati

def _prehistory_daily(before: pd.Timestamp) -> pd.DataFrame:
    """Storico giornaliero precedente a Binance (dataset `daily` se contiguo, altrimenti CoinMetrics PriceUSD)."""
    try:
        d = store.get("daily")
        d = d[(d["time"] < before)].sort_values("time")
        if not d.empty and d["time"].iloc[-1] >= before - pd.Timedelta(days=3):
            d = d[(d["close"] > 0) & (d["close"] / d["open"].where(d["open"] > 0, d["close"])).between(0.5, 2)]
            return d[["time", "open", "high", "low", "close"]]
    except Exception:  # noqa: BLE001
        pass
    try:
        oc = store.get("onchain")[["time", "PriceUSD"]].dropna()
        oc = oc[(oc["time"] < before) & (oc["PriceUSD"] > 0)]
        p = oc["PriceUSD"].astype(float)
        return pd.DataFrame({"time": oc["time"], "open": p, "high": p, "low": p, "close": p})
    except Exception:  # noqa: BLE001
        return pd.DataFrame(columns=["time", "open", "high", "low", "close"])


@util.ttl_cache(30)
def load(tf: str) -> dict:
    df = store.get(TF_SOURCE[tf])[["time", "open", "high", "low", "close"]].sort_values("time")
    if tf == "1d":
        pre = _prehistory_daily(df["time"].iloc[0])
        df = pd.concat([pre, df]).sort_values("time")
    elif tf == "1w":
        pre = _prehistory_daily(df["time"].iloc[0])
        if not pre.empty:
            pre = pre.copy()
            pre["wk"] = pre["time"].dt.normalize() - pd.to_timedelta(pre["time"].dt.weekday, unit="D")
            g = pre.groupby("wk")
            wk = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(), "close": g["close"].last()})
            wk = wk[wk.index < df["time"].iloc[0]].reset_index().rename(columns={"wk": "time"})
            df = pd.concat([wk, df]).sort_values("time")
    df = df.drop_duplicates("time").dropna(subset=["close"])
    df = df[df["close"] > 0].reset_index(drop=True)
    return {
        "time": _secs(df["time"]),
        "close": df["close"].to_numpy(float),
        "high": df["high"].to_numpy(float),
        "low": df["low"].to_numpy(float),
    }


# ------------------------------------------------------------------ core

def _rolling_corr(x: np.ndarray, qz: np.ndarray, m: int) -> np.ndarray:
    """Pearson tra qz (z-score, len n) e x[s:s+n] per s in [0, m)."""
    n = len(qz)
    xc = x[: m + n - 1] - x[: m + n - 1].mean()
    cs = np.r_[0.0, np.cumsum(xc)]
    cs2 = np.r_[0.0, np.cumsum(xc * xc)]
    s1 = cs[n:n + m] - cs[:m]
    s2 = cs2[n:n + m] - cs2[:m]
    var = np.maximum(s2 / n - (s1 / n) ** 2, 0)
    std = np.sqrt(var)
    dot = np.correlate(xc, qz, mode="valid")[:m]
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = dot / (n * std)
    corr[~np.isfinite(corr) | (std < 1e-9)] = 0.0
    return np.clip(corr, -1, 1)


def dtw_banded(q: np.ndarray, cands: np.ndarray, band: int) -> np.ndarray:
    """DTW (costo |a-b|) con banda Sakoe-Chiba, vettoriale sui candidati. Ritorna distanza media per passo."""
    c, n = cands.shape
    inf = np.inf
    prev = np.full((c, n + 1), inf)
    prev[:, 0] = 0.0
    for i in range(1, n + 1):
        cur = np.full((c, n + 1), inf)
        lo, hi = max(1, i - band), min(n, i + band)
        cost = np.abs(cands[:, lo - 1:hi] - q[i - 1])  # (c, hi-lo+1)
        for k, j in enumerate(range(lo, hi + 1)):
            best = np.minimum(np.minimum(prev[:, j], cur[:, j - 1]), prev[:, j - 1])
            cur[:, j] = cost[:, k] + best
        prev = cur
    return prev[:, n] / n


def _z(a: np.ndarray) -> np.ndarray:
    sd = a.std(axis=-1, keepdims=True)
    sd = np.where(sd < 1e-12, 1.0, sd)
    return (a - a.mean(axis=-1, keepdims=True)) / sd


def _wquantile(values: np.ndarray, weights: np.ndarray, q: float) -> float:
    o = np.argsort(values)
    v, w = values[o], weights[o]
    cw = np.cumsum(w) - 0.5 * w
    cw /= w.sum()
    return float(np.interp(q, cw, v))


def _label(t: int, tf: str) -> str:
    d = pd.Timestamp(t, unit="s", tz="UTC")
    base = f"{MESI[d.month - 1]} {d.year} ({tf})"
    return f"{d.day} {base}" if tf == "1h" else base


def _fmt(p: float) -> str:
    return f"{p / 1000:.1f}k" if p >= 10000 else f"{p:,.0f}"


def search(tf: str, window: int, horizon: int, top: int) -> dict:
    data = load(tf)
    close, high, low, times = data["close"], data["high"], data["low"], data["time"]
    n_all = len(close)
    x = np.log(close)
    m = n_all - 2 * window - horizon + 1  # start s valido: s + window + horizon <= n_all - window
    if m < max(20, top * 2):
        raise ValueError(f"storico insufficiente per tf={tf}, window={window}, horizon={horizon}")

    q = x[-window:]
    qz = _z(q)
    corr = _rolling_corr(x, qz, m)

    # pre-filtro: migliori per correlazione con soppressione dei vicini (window/2)
    order = np.argsort(-corr)
    blocked = np.zeros(m, bool)
    half = max(1, window // 2)
    picks = []
    for s in order:
        if corr[s] <= 0 or len(picks) >= N_PREFILTER:
            break
        if blocked[s]:
            continue
        picks.append(s)
        blocked[max(0, s - half):s + half + 1] = True
    if not picks:
        picks = list(order[:N_PREFILTER])
    picks = np.array(picks)

    idx = picks[:, None] + np.arange(window)[None, :]
    cands = _z(x[idx])
    band = max(2, window // 10)
    dtw = dtw_banded(qz, cands, band)
    c = corr[picks]
    sim = 100 * (0.6 * np.clip(c, 0, 1) + 0.4 * np.exp(-dtw / 0.35))

    # top non sovrapposti
    chosen: list[int] = []
    for k in np.argsort(-sim):
        s = picks[k]
        if all(abs(s - picks[j]) >= window for j in chosen):
            chosen.append(k)
        if len(chosen) >= max(top, MIN_PROJ):
            break

    cur_close = float(close[-1])
    analogs = []
    for rank, k in enumerate(chosen, 1):
        s = int(picks[k])
        e = s + window - 1
        f = cur_close / close[e]
        fut_sl = slice(e + 1, e + 1 + horizon)
        analogs.append({
            "rank": rank, "s": s, "e": e, "start": int(times[s]), "end": int(times[e]),
            "similarity": float(sim[k]), "correlation": float(c[k]), "dtw": float(dtw[k]),
            "label": _label(int(times[s]), tf),
            "path": close[s:e + 1] * f, "future": close[fut_sl] * f,
            "fut_high": high[fut_sl] * f, "fut_low": low[fut_sl] * f,
            "outcome": float((close[e + horizon] / close[e] - 1) * 100),
        })

    # proiezione: quantili pesati
    fut = np.array([a["future"] for a in analogs])
    w = np.array([(a["similarity"] / 100) ** 2 for a in analogs])
    p10 = [_wquantile(fut[:, h], w, 0.10) for h in range(horizon)]
    p50 = [_wquantile(fut[:, h], w, 0.50) for h in range(horizon)]
    p90 = [_wquantile(fut[:, h], w, 0.90) for h in range(horizon)]
    outs = np.array([a["outcome"] for a in analogs])
    up_prob = float((w * (outs > 0)).sum() / w.sum() * 100)
    med_end = p50[-1] / cur_close - 1
    if up_prob >= 60 and med_end > 0:
        bias = "bullish"
    elif up_prob <= 40 and med_end < 0:
        bias = "bearish"
    else:
        bias = "neutral"
    step = TF_STEP[tf]
    last_t = int(times[-1])
    proj_times = [last_t + step * (h + 1) for h in range(horizon)]

    shown = analogs[:top]
    retests = _retests(data, window, shown, step)

    return {
        "tf": tf, "window": window, "horizon": horizon,
        "current": [{"time": int(t), "close": float(v)} for t, v in zip(times[-window:], close[-window:])],
        "matches": [
            {"rank": a["rank"], "start": a["start"], "end": a["end"], "similarity": round(a["similarity"], 2),
             "correlation": round(a["correlation"], 4), "dtw": round(a["dtw"], 4), "label": a["label"],
             "path": np.round(a["path"], 2), "future": np.round(a["future"], 2), "outcome": round(a["outcome"], 2)}
            for a in shown
        ],
        "projection": {"times": proj_times, "p10": np.round(p10, 2), "p50": np.round(p50, 2), "p90": np.round(p90, 2),
                       "bias": bias, "up_prob": round(up_prob, 1)},
        "retests": retests,
    }


# ------------------------------------------------------------------ retest

def _levels(c: np.ndarray, h: np.ndarray, l: np.ndarray) -> dict:
    """Livelli strutturali della finestra: chiave -> (prezzo, kind, descrizione)."""
    n = len(c)
    e = c[-1]
    out = {}
    hi, lo = float(h.max()), float(l.min())
    if hi > e * 1.003:
        out["max"] = (hi, "liquidity", "sweep del massimo della finestra")
    if lo < e * 0.997:
        out["min"] = (lo, "liquidity", "sweep del minimo della finestra")
    pre = max(3, int(n * 0.75))
    rh, rl = float(h[:pre].max()), float(l[:pre].min())
    if e > rh * 1.003:
        out["breakout"] = (rh, "support", "retest del livello di breakout")
    if e < rl * 0.997:
        out["breakdown"] = (rl, "resistance", "retest del livello di breakdown")
    k = 3
    sh = sl = None
    for i in range(n - 1 - k, k - 1, -1):
        seg_h, seg_l = h[i - k:i + k + 1], l[i - k:i + k + 1]
        if sh is None and h[i] == seg_h.max() and h[i] > e * 1.003 and h[i] < hi:
            sh = float(h[i])
        if sl is None and l[i] == seg_l.min() and l[i] < e * 0.997 and l[i] > lo:
            sl = float(l[i])
        if sh is not None and sl is not None:
            break
    if sh is not None:
        out["swing_high"] = (sh, "resistance", "ritorno all'ultimo swing high")
    if sl is not None:
        out["swing_low"] = (sl, "support", "ritorno all'ultimo swing low")
    mid = (hi + lo) / 2
    if abs(mid / e - 1) > 0.003:
        out["mid"] = (mid, "support" if mid < e else "resistance", "ritorno al 50% del range")
    return out


def _retests(data: dict, window: int, analogs: list[dict], step: int) -> list[dict]:
    close, high, low, times = data["close"], data["high"], data["low"], data["time"]
    cur_lv = _levels(close[-window:], high[-window:], low[-window:])
    if not cur_lv or not analogs:
        return []
    stats: dict[str, list] = {k: [0, 0, []] for k in cur_lv}
    for a in analogs:
        s, e = a["s"], a["e"]
        lv = _levels(close[s:e + 1], high[s:e + 1], low[s:e + 1])
        ec = close[e]
        f = 1.0 / (close[-1] / ec)  # riporta i futuri riscalati alla scala dell'analogo
        fh, fl = a["fut_high"] * f, a["fut_low"] * f
        for key in cur_lv:
            if key not in lv:
                continue
            stats[key][1] += 1
            price = lv[key][0]
            hit = np.where(fh >= price)[0] if price > ec else np.where(fl <= price)[0]
            if hit.size:
                stats[key][0] += 1
                stats[key][2].append(int(hit[0]) + 1)
    out = []
    n_an = len(analogs)
    for key, (hits, den, when) in stats.items():
        if den == 0 or hits < 2 or hits < math.ceil(den / 2):
            continue
        price, kind, desc = cur_lv[key]
        med = int(np.median(when))
        out.append({
            "price": round(float(price), 2),
            "time": int(times[-1]) + med * step,
            "kind": kind,
            "note": f"{hits} {'analogo' if hits == 1 else 'analoghi'} su {n_an} {'ritesta' if hits == 1 else 'ritestano'} {_fmt(price)} ({desc}) entro ~{med} candele",
            "_score": hits / n_an,
        })
    out.sort(key=lambda r: -r["_score"])
    for r in out:
        r.pop("_score")
    return out


# ------------------------------------------------------------------ entry

@util.ttl_cache(30)
def cached_search(tf: str, window: int, horizon: int, top: int) -> dict:
    return search(tf, window, horizon, top)


@util.ttl_cache(60)
def multi_tf() -> list[dict]:
    out = []
    for tf, (w, h) in DEFAULTS.items():
        try:
            r = cached_search(tf, w, h, 5)
            sims = [mm["similarity"] for mm in r["matches"]]
            out.append({"tf": tf, "similarity": round(float(np.mean(sims)), 1) if sims else None,
                        "bias": r["projection"]["bias"], "up_prob": r["projection"]["up_prob"]})
        except Exception as e:  # noqa: BLE001
            log.warning("multi_tf %s fallito: %s", tf, e)
    return out


def compute(tf: str = "4h", window: int = 60, horizon: int = 30, top: int = 5) -> dict:
    r = dict(cached_search(tf, window, horizon, top))
    r["multi_tf"] = multi_tf()
    return r
