"""Analisi tecnica pura: indicatori, pivot, zigzag adattivo (ATR), zone S/R, fibonacci.

Tutte le funzioni lavorano su DataFrame OHLCV (colonne time, open, high, low, close, volume)
e non fanno I/O.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

# ----------------------------------------------------------------- indicatori


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(dn != 0, 100.0).where(up.notna())


def macd(close: pd.Series, fast: int = 12, slow: int = 26, sig: int = 9):
    m = ema(close, fast) - ema(close, slow)
    s = m.ewm(span=sig, adjust=False, min_periods=sig).mean()
    return m, s, m - s


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0):
    mid = sma(close, n)
    sd = close.rolling(n, min_periods=n).std(ddof=0)
    return mid + k * sd, mid, mid - k * sd


def true_range(df: pd.DataFrame) -> pd.Series:
    pc = df["close"].shift(1)
    return pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def vwap(df: pd.DataFrame, reset: str | None = None, anchor_idx: int | None = None) -> pd.Series:
    """VWAP sul prezzo tipico. reset='D'/'W' = VWAP di sessione; anchor_idx = VWAP ancorato."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    pv = tp * df["volume"]
    if reset:
        key = df["time"].dt.tz_localize(None).dt.to_period(reset).astype(str)
        num_ = pv.groupby(key).cumsum()
        den = df["volume"].groupby(key).cumsum()
        return num_ / den.replace(0, np.nan)
    start = anchor_idx or 0
    out = pd.Series(np.nan, index=df.index)
    sub_pv = pv.iloc[start:].cumsum()
    sub_v = df["volume"].iloc[start:].cumsum().replace(0, np.nan)
    out.iloc[start:] = (sub_pv / sub_v).values
    return out


# --------------------------------------------------------------------- pivots


def pivot_set(h: float, l: float, c: float) -> dict:
    p = (h + l + c) / 3
    r = h - l
    classic = {
        "P": p, "R1": 2 * p - l, "S1": 2 * p - h,
        "R2": p + r, "S2": p - r,
        "R3": h + 2 * (p - l), "S3": l - 2 * (h - p),
    }
    fib = {
        "P": p, "R1": p + 0.382 * r, "R2": p + 0.618 * r, "R3": p + r,
        "S1": p - 0.382 * r, "S2": p - 0.618 * r, "S3": p - r,
    }
    cam = {}
    for i, f in zip((1, 2, 3, 4), (12, 6, 4, 2)):
        cam[f"H{i}"] = c + r * 1.1 / f
        cam[f"L{i}"] = c - r * 1.1 / f
    return {"classic": classic, "fibonacci": fib, "camarilla": cam}


# --------------------------------------------------------------------- zigzag


def zigzag(df: pd.DataFrame, mult: float = 3.0, atr_n: int = 14, min_pct: float = 0.0) -> list[dict]:
    """Zigzag adattivo: inversione quando il prezzo si allontana dall'estremo di > mult*ATR
    (e almeno min_pct %). Restituisce pivot alternati {i, time, price, kind, move_atr}."""
    if len(df) < atr_n + 5:
        return []
    hi, lo = df["high"].to_numpy(float), df["low"].to_numpy(float)
    a = atr(df, atr_n).bfill().to_numpy(float)
    piv: list[dict] = []
    trend = 0  # 1 su, -1 giù
    ext_i = 0
    ext_hi, ext_lo = hi[0], lo[0]
    hi_i, lo_i = 0, 0
    for i in range(1, len(df)):
        thr = max(mult * a[i], min_pct / 100 * df["close"].iat[i])
        if trend == 0:
            if hi[i] > ext_hi:
                ext_hi, hi_i = hi[i], i
            if lo[i] < ext_lo:
                ext_lo, lo_i = lo[i], i
            if ext_hi - lo[i] > thr and hi_i < i:
                piv.append({"i": hi_i, "kind": "high"})
                trend, ext_i, ext_lo = -1, i, lo[i]
            elif hi[i] - ext_lo > thr and lo_i < i:
                piv.append({"i": lo_i, "kind": "low"})
                trend, ext_i, ext_hi = 1, i, hi[i]
            continue
        if trend == 1:
            if hi[i] >= ext_hi:
                ext_hi, ext_i = hi[i], i
            elif ext_hi - lo[i] > thr:
                piv.append({"i": ext_i, "kind": "high"})
                trend, ext_i, ext_lo = -1, i, lo[i]
        else:
            if lo[i] <= ext_lo:
                ext_lo, ext_i = lo[i], i
            elif hi[i] - ext_lo > thr:
                piv.append({"i": ext_i, "kind": "low"})
                trend, ext_i, ext_hi = 1, i, hi[i]
    # ultimo estremo in formazione (non confermato)
    if trend == 1:
        piv.append({"i": ext_i, "kind": "high", "open": True})
    elif trend == -1:
        piv.append({"i": ext_i, "kind": "low", "open": True})
    for p in piv:
        i = p["i"]
        p["time"] = df["time"].iat[i]
        p["price"] = hi[i] if p["kind"] == "high" else lo[i]
        p["atr"] = a[i]
    # dimensione dei movimenti adiacenti in multipli di ATR
    for k, p in enumerate(piv):
        legs = []
        if k > 0:
            legs.append(abs(p["price"] - piv[k - 1]["price"]))
        if k < len(piv) - 1:
            legs.append(abs(piv[k + 1]["price"] - p["price"]))
        p["move_atr"] = (max(legs) / p["atr"]) if legs and p["atr"] > 0 else 0.0
    return piv


def swing_strength(piv: list[dict]) -> None:
    """Forza 0..100: rango percentile dell'ampiezza dei movimenti adiacenti."""
    if not piv:
        return
    moves = np.array([p["move_atr"] for p in piv])
    for p in piv:
        p["strength"] = round(float((moves <= p["move_atr"]).mean() * 100), 1)


# ---------------------------------------------------------------------- zones


def cluster_zones(piv: list[dict], price: float, atr_now: float, end_time: pd.Timestamp,
                  halflife_bars: float, bar_seconds: float, max_zones: int = 14) -> list[dict]:
    """Raggruppa i pivot vicini (tolleranza ~0.6 ATR o 0.8%) in zone S/R pesate per
    tocchi, forza dello swing e recenza."""
    if not piv:
        return []
    tol = max(0.6 * atr_now, price * 0.008)
    pts = sorted(piv, key=lambda p: p["price"])
    clusters: list[list[dict]] = [[pts[0]]]
    for p in pts[1:]:
        cur = clusters[-1]
        mean = float(np.mean([q["price"] for q in cur]))
        if p["price"] - mean <= tol and p["price"] - cur[0]["price"] <= 2.5 * tol:
            cur.append(p)
        else:
            clusters.append([p])
    zones = []
    for c in clusters:
        prices = [q["price"] for q in c]
        lo_, hi_ = min(prices), max(prices)
        pad = 0.15 * tol
        if hi_ - lo_ < 0.3 * tol:
            mid = (hi_ + lo_) / 2
            lo_, hi_ = mid - 0.25 * tol, mid + 0.25 * tol
        else:
            lo_, hi_ = lo_ - pad, hi_ + pad
        last = max(q["time"] for q in c)
        score = 0.0
        for q in c:
            age_bars = max(0.0, (end_time - q["time"]).total_seconds() / bar_seconds)
            rec = 0.5 ** (age_bars / halflife_bars)
            score += (0.4 + q.get("strength", 50) / 100) * (0.35 + 0.65 * rec)
        mid = (lo_ + hi_) / 2
        zones.append({
            "low": lo_, "high": hi_, "mid": mid,
            "kind": "support" if mid < price else "resistance",
            "touches": len(c), "score": score, "last_touch": last,
        })
    # se il prezzo è dentro la zona: tipo in base al lato del centro (già fatto)
    mx = max(z["score"] for z in zones) or 1
    for z in zones:
        z["strength"] = round(100 * z["score"] / mx, 1)
    zones = [z for z in zones if z["touches"] >= 2 or z["strength"] >= 35]
    zones.sort(key=lambda z: -z["score"])
    zones = zones[:max_zones]
    zones.sort(key=lambda z: -z["mid"])
    return zones


FIB_RATIOS = [0.0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1.0, 1.272, 1.618]


def fib_levels(p_from: float, p_to: float) -> list[dict]:
    """Ritracciamento del movimento from->to: ratio 0 = to (estremo recente), 1 = from."""
    return [{"ratio": r, "price": p_to + (p_from - p_to) * r} for r in FIB_RATIOS]


def fmt_usd(x: float | None) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/d"
    if abs(x) >= 1e12:
        return f"${x / 1e12:.2f}T"
    if abs(x) >= 1e9:
        return f"${x / 1e9:.2f}B"
    if abs(x) >= 1e6:
        return f"${x / 1e6:.2f}M"
    if abs(x) >= 1e4:
        return f"${x / 1e3:.1f}k"
    if abs(x) >= 100:
        return f"${x:,.0f}"
    return f"${x:,.2f}"
