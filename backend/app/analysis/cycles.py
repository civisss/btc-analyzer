"""Analisi dei cicli di Bitcoin (pura computazione, nessun I/O).

- storico giornaliero robusto (unione daily lungo + CoinMetrics + Binance)
- rilevamento algoritmico di massimi/minimi di ciclo
- trend adattivo delle durate / rendimenti decrescenti -> proiezioni
- modelli: power law, rainbow, Pi Cycle, Mayer multiple, 2-year MA
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

GENESIS = pd.Timestamp("2009-01-03", tz="UTC")
HALVINGS = [  # (n, data, blocco)
    (1, pd.Timestamp("2012-11-28", tz="UTC"), 210_000),
    (2, pd.Timestamp("2016-07-09", tz="UTC"), 420_000),
    (3, pd.Timestamp("2020-05-11", tz="UTC"), 630_000),
    (4, pd.Timestamp("2024-04-20", tz="UTC"), 840_000),
]
NEXT_HALVING_BLOCK = 1_050_000
DAY = pd.Timedelta(days=1)


# ---------------------------------------------------------------- storico

def merged_daily(daily: pd.DataFrame | None, onchain: pd.DataFrame | None, k1d: pd.DataFrame | None) -> pd.DataFrame:
    """Serie giornaliera (index=data UTC normalizzata; close/high/low) dal 2010 a oggi.
    Priorità: Binance k_1d (2017→) > daily lungo (Bitstamp) > CoinMetrics PriceUSD (solo close)."""
    frames = []
    now = pd.Timestamp.now(tz="UTC")
    if onchain is not None and len(onchain):
        cm = onchain[["time", "PriceUSD"]].dropna()
        f = pd.DataFrame({"close": cm["PriceUSD"].values, "high": cm["PriceUSD"].values, "low": cm["PriceUSD"].values},
                         index=pd.DatetimeIndex(cm["time"]).normalize())
        frames.append((0, f))
    if daily is not None and len(daily):
        d = daily[["time", "high", "low", "close"]].dropna().copy()
        d["time"] = pd.DatetimeIndex(d["time"]).normalize()
        d = d.drop_duplicates("time", keep="last").set_index("time")
        # se il dataset è "fermo" nel passato l'ultima riga ha il close forzato al prezzo live: scartala
        if len(d) and d.index[-1] < now - pd.Timedelta(days=3):
            d = d.iloc[:-1]
        # scarta righe con salti assurdi rispetto ai vicini (errori di dati)
        r = d["close"] / d["close"].rolling(5, center=True, min_periods=1).median()
        d = d[(r < 3) & (r > 1 / 3)]
        d["high"] = d[["high", "close"]].max(axis=1)
        d["low"] = d[["low", "close"]].min(axis=1)
        frames.append((1, d[["close", "high", "low"]]))
    if k1d is not None and len(k1d):
        k = k1d[["time", "high", "low", "close"]].dropna().copy()
        k["time"] = pd.DatetimeIndex(k["time"]).normalize()
        frames.append((2, k.drop_duplicates("time", keep="last").set_index("time")[["close", "high", "low"]]))
    if not frames:
        raise ValueError("nessun dato giornaliero disponibile")
    out = None
    for _, f in sorted(frames, key=lambda x: x[0]):
        out = f if out is None else pd.concat([out[~out.index.isin(f.index)], f])
    out = out.sort_index()
    out = out[out["close"] > 0]
    out = out[~out.index.duplicated(keep="last")]
    return out


# ------------------------------------------------------- massimi / minimi

def detect_tops(df: pd.DataFrame, window_days: int = 365) -> list[pd.Timestamp]:
    """Massimo di ciclo = nuovo massimo storico che è anche il massimo in ±window giorni."""
    h = df["high"]
    ath = h.cummax()
    tops = []
    for t in h.index[h >= ath]:
        lo, hi = t - pd.Timedelta(days=window_days), t + pd.Timedelta(days=window_days)
        if h.loc[lo:hi].max() <= h.loc[t]:
            tops.append(t)
    # de-duplica (giorni consecutivi uguali)
    out: list[pd.Timestamp] = []
    for t in tops:
        if out and (t - out[-1]).days < window_days:
            if h.loc[t] > h.loc[out[-1]]:
                out[-1] = t
            continue
        out.append(t)
    return out


def detect_bottoms(df: pd.DataFrame, tops: list[pd.Timestamp]) -> list[pd.Timestamp]:
    """Minimo di ciclo = minimo assoluto tra due massimi di ciclo consecutivi."""
    lo = df["low"]
    return [lo.loc[a:b].idxmin() for a, b in zip(tops[:-1], tops[1:])]


# ---------------------------------------------------------- regressioni

def wlinfit(x, y, w):
    x, y, w = (np.asarray(v, float) for v in (x, y, w))
    if len(x) == 1:
        return 0.0, float(y[0])
    W = w / w.sum()
    xm, ym = (W * x).sum(), (W * y).sum()
    var = (W * (x - xm) ** 2).sum()
    b = 0.0 if var == 0 else (W * (x - xm) * (y - ym)).sum() / var
    return float(b), float(ym - b * xm)


def adaptive_projection(ns: list[int], ys: list[float], n_next: int, decay: float = 1.7,
                        max_points: int = 3, lo_clip: float = 0.6, hi_clip: float = 1.25) -> tuple[float, float]:
    """Proiezione adattiva: regressione lineare pesata (cicli recenti pesano di più, ultimi
    `max_points`), mescolata con l'ultimo valore osservato. Restituisce (stima, incertezza)."""
    ns, ys = list(ns)[-max_points:], list(ys)[-max_points:]
    if not ys:
        return float("nan"), float("nan")
    w = [decay ** i for i in range(len(ns))]
    b, a = wlinfit(ns, ys, w)
    fit = a + b * n_next
    est = 0.65 * fit + 0.35 * ys[-1]
    lo, hi = min(ys) * lo_clip, max(ys) * hi_clip
    est = float(min(max(est, lo), hi))
    resid = np.array(ys) - (a + b * np.array(ns))
    unc = float(max(np.sqrt(np.average(resid ** 2, weights=w)) if len(ys) > 2 else 0, np.std(ys) * 0.5, abs(est) * 0.05))
    return est, unc


# -------------------------------------------------------------- modelli

def days_since_genesis(idx: pd.DatetimeIndex) -> np.ndarray:
    return np.asarray((idx - GENESIS).days, float)


@dataclass
class PowerLaw:
    a: float
    b: float
    q_lo: float
    q_hi: float
    resid_q: np.ndarray  # quantili per bande

    def fair(self, idx: pd.DatetimeIndex) -> np.ndarray:
        return 10 ** (self.a + self.b * np.log10(days_since_genesis(idx)))


def fit_power_law(close: pd.Series) -> PowerLaw:
    s = close[close.index >= pd.Timestamp("2010-07-18", tz="UTC")].dropna()
    x = np.log10(days_since_genesis(s.index))
    y = np.log10(s.values)
    b, a = np.polyfit(x, y, 1)
    resid = y - (a + b * x)
    r2 = resid[s.index >= pd.Timestamp("2011-06-01", tz="UTC")]
    q = np.quantile(r2, np.linspace(0.005, 0.995, 10))
    return PowerLaw(a=float(a), b=float(b), q_lo=float(np.quantile(r2, 0.02)), q_hi=float(np.quantile(r2, 0.985)), resid_q=q)


RAINBOW = [
    ("Svendita totale", "#1f3c88"),
    ("COMPRA!", "#2f7ed8"),
    ("Accumula", "#2bb3a3"),
    ("Ancora economico", "#4caf50"),
    ("HODL!", "#b5cf3a"),
    ("È una bolla?", "#f2c94c"),
    ("FOMO in aumento", "#f2994a"),
    ("Vendi. Sul serio, VENDI!", "#e2572b"),
    ("Bolla massima", "#c0392b"),
]


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def pi_cycle_crosses(s111: pd.Series, s350x2: pd.Series) -> list[pd.Timestamp]:
    d = (s111 - s350x2).dropna()
    up = (d > 0) & (d.shift(1) <= 0)
    return list(d.index[up])


def round_sig(x: float | None, sig: int = 5):
    if x is None or not np.isfinite(x) or x == 0:
        return None if x is None or not np.isfinite(x) else 0.0
    return round(float(x), sig - 1 - int(math.floor(math.log10(abs(x)))))
