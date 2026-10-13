"""Analoghi spiegabili: "l'intervallo che si sta formando somiglia a queste candele del passato, perché…".

Pipeline:
  1. candidati: stessa ricerca dei frattali (correlazione di Pearson vettoriale sul log-prezzo z-normalizzato
     + DTW con banda Sakoe-Chiba sui migliori candidati), riusando gli helper di `fractals`;
  2. per i migliori ~40 candidati si calcolano ~17 feature interpretabili sia sulla finestra attuale sia
     sull'analoga (variazione, drawdown, range, volatilità, trend, RSI, EMA, volumi, struttura di mercato,
     retest, distanza dall'ATH, ciclo dell'halving, USDT dominance, funding);
  3. ogni feature ha una similarità 0..100 (distanza normalizzata, scala = soglia assoluta + quota relativa);
     punteggio finale = 55% forma (corr + DTW) + 45% media pesata delle feature;
  4. per ogni analogo: mappatura dei punti strutturali (swing high/low, retest, breakout) tramite il
     cammino DTW, narrativa deterministica in italiano (opzionalmente rifinita dall'LLM locale in background,
     con verifica che non compaiano numeri inventati), candele, esito e proiezione riscalata.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time

import numpy as np
import pandas as pd

from .. import util
from ..data import store
from . import analogs_visual as vis
from . import fractals as fr
from .cycles import GENESIS, HALVINGS

log = logging.getLogger("analogs")

TFS = ("1h", "4h", "1d", "1w")
TF_STEP = fr.TF_STEP
TF_LABEL = {"1h": "1h", "4h": "4h", "1d": "1G", "1w": "1S"}
ANN = {"1h": 24 * 365, "4h": 6 * 365, "1d": 365, "1w": 52}
DEFAULT_WINDOW = {"1h": 72, "4h": 60, "1d": 60, "1w": 26}
MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
N_PREFILTER = 150
N_RERANK = 80
W_VISUAL = 0.70  # peso della somiglianza grafica nel punteggio finale (resto = indicatori)
CYCLE_DAYS = 1458


# ================================================================== dati

def _secs(s: pd.Series) -> np.ndarray:
    return ((s - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(dtype=np.int64)


def _raw(tf: str) -> pd.DataFrame:
    """Come fractals.load ma con open e volume (volume NaN dove non disponibile)."""
    df = store.get(fr.TF_SOURCE[tf])[["time", "open", "high", "low", "close", "volume"]].sort_values("time")
    if tf in ("1d", "1w"):
        try:
            d = store.get("daily")
            d = d[d["time"] < df["time"].iloc[0]].sort_values("time")
            d = d[(d["close"] > 0) & (d["close"] / d["open"].where(d["open"] > 0, d["close"])).between(0.5, 2)]
            pre = d[["time", "open", "high", "low", "close", "volume"]].copy()
        except Exception:  # noqa: BLE001
            pre = pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])
        if pre.empty or pre["time"].iloc[-1] < df["time"].iloc[0] - pd.Timedelta(days=3):
            p = fr._prehistory_daily(df["time"].iloc[0]).copy()
            p["volume"] = np.nan
            pre = p
        if tf == "1w" and not pre.empty:
            pre = pre.copy()
            pre["wk"] = pre["time"].dt.normalize() - pd.to_timedelta(pre["time"].dt.weekday, unit="D")
            g = pre.groupby("wk")
            pre = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                                "close": g["close"].last(), "volume": g["volume"].sum(min_count=1)})
            pre = pre[pre.index < df["time"].iloc[0]].reset_index().rename(columns={"wk": "time"})
        df = pd.concat([pre, df]).sort_values("time")
    df = df.drop_duplicates("time").dropna(subset=["close"])
    df = df[df["close"] > 0].reset_index(drop=True)
    for col in ("open", "high", "low"):
        df[col] = df[col].fillna(df["close"])
    df["volume"] = df["volume"].where(df["volume"] > 0)
    return df


@util.ttl_cache(600)
def _ath_daily() -> tuple[np.ndarray, np.ndarray]:
    d = fr.load("1d")
    return d["time"], np.maximum.accumulate(d["high"])


@util.ttl_cache(600)
def _usdt_daily() -> tuple[np.ndarray, np.ndarray] | None:
    try:
        from .usdt import _frame
        d, _, _ = _frame()
        return _secs(d["time"]), d["usdt_d"].to_numpy(float)
    except Exception as e:  # noqa: BLE001
        log.warning("USDT.D non disponibile: %s", e)
        return None


@util.ttl_cache(600)
def _funding() -> tuple[np.ndarray, np.ndarray] | None:
    try:
        f = store.get("funding").sort_values("time")
        t = _secs(f["time"])
        r = f["rate"].astype(float).to_numpy() * 100  # percento / 8h
        return t, np.r_[0.0, np.cumsum(np.nan_to_num(r))]
    except Exception as e:  # noqa: BLE001
        log.warning("funding non disponibile: %s", e)
        return None


@util.ttl_cache(60)
def load(tf: str) -> dict:
    df = _raw(tf)
    c = df["close"].astype(float)
    delta = c.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    dn = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    rsi = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    t = _secs(df["time"])
    # ATH: massimo storico giornaliero (giorno precedente completo) unito al massimo progressivo del tf
    dt, dath = _ath_daily()
    k = np.searchsorted(dt, t - 86400, side="right") - 1
    ath_d = np.where(k >= 0, dath[np.clip(k, 0, None)], 0.0)
    ath = np.maximum(ath_d, np.maximum.accumulate(df["high"].to_numpy(float)))
    return {
        "time": t, "open": df["open"].to_numpy(float), "high": df["high"].to_numpy(float),
        "low": df["low"].to_numpy(float), "close": c.to_numpy(), "volume": df["volume"].to_numpy(float),
        "rsi": rsi.to_numpy(float),
        "ema50": c.ewm(span=50, adjust=False).mean().to_numpy(), "ema200": c.ewm(span=200, adjust=False).mean().to_numpy(),
        "ath": ath,
    }


# ================================================================== testo / formattazione

def _sgn(v: float, d: int = 1, suffix: str = "%") -> str:
    if v is None or not math.isfinite(v):
        return "n/d"
    s = "+" if v > 0 else ("−" if v < 0 else "")
    return f"{s}{abs(v):.{d}f}{suffix}"


def _usd(p: float) -> str:
    return f"${p:,.0f}" if p >= 100 else f"${p:,.2f}"


def period_label(t0: int, t1: int, tf: str) -> str:
    a = pd.Timestamp(t0, unit="s", tz="UTC")
    b = pd.Timestamp(t1, unit="s", tz="UTC")
    if (t1 - t0) < 45 * 86400:
        if a.year == b.year and a.month == b.month:
            core = f"{a.day}–{b.day} {MESI[a.month - 1]} {a.year}" if a.day != b.day else f"{a.day} {MESI[a.month - 1]} {a.year}"
        elif a.year == b.year:
            core = f"{a.day} {MESI[a.month - 1]} – {b.day} {MESI[b.month - 1]} {a.year}"
        else:
            core = f"{a.day} {MESI[a.month - 1]} {a.year} – {b.day} {MESI[b.month - 1]} {b.year}"
    elif a.year == b.year:
        core = f"{MESI[a.month - 1]}–{MESI[b.month - 1]} {a.year}" if a.month != b.month else f"{MESI[a.month - 1]} {a.year}"
    else:
        core = f"{MESI[a.month - 1]} {a.year} – {MESI[b.month - 1]} {b.year}"
    return f"{core} ({TF_LABEL[tf]})"


def _when(t0: int, t1: int) -> str:
    """Riferimento breve al periodo analogo: 'nel 2023' oppure 'nel 2022-23'."""
    a = pd.Timestamp(t0, unit="s", tz="UTC").year
    b = pd.Timestamp(t1, unit="s", tz="UTC").year
    return f"nel {a}" if a == b else f"nel {a}-{str(b)[-2:]}"


def _qual(sim: float, fem: bool = False) -> str:
    e = "a" if fem else "o"
    if sim >= 85:
        return f"quasi identic{e}"
    if sim >= 65:
        return "simile"
    if sim >= 40:
        return f"parzialmente divers{e}"
    return f"divers{e}"


def _lc(s: str) -> str:
    return s if len(s) > 1 and s[1].isupper() else s[:1].lower() + s[1:]


# ================================================================== feature

def _swings(h: np.ndarray, l: np.ndarray, k: int) -> list[tuple[int, str, float]]:
    """Zigzag di pivot (indice, 'high'|'low', prezzo) alternati, esclusi i bordi."""
    n = len(h)
    pts: list[tuple[int, str, float]] = []
    for i in range(k, n - k):
        if h[i] == h[i - k:i + k + 1].max():
            pts.append((i, "high", float(h[i])))
        if l[i] == l[i - k:i + k + 1].min():
            pts.append((i, "low", float(l[i])))
    zz: list[tuple[int, str, float]] = []
    for p in pts:
        if zz and zz[-1][1] == p[1]:
            if (p[1] == "high" and p[2] >= zz[-1][2]) or (p[1] == "low" and p[2] <= zz[-1][2]):
                zz[-1] = p
        elif zz and zz[-1][0] == p[0]:
            continue
        else:
            zz.append(p)
    return zz


def _structure(zz: list[tuple[int, str, float]]) -> dict:
    hs = [p[2] for p in zz if p[1] == "high"]
    ls = [p[2] for p in zz if p[1] == "low"]
    hh = sum(1 for a, b in zip(hs, hs[1:]) if b > a)
    lh = sum(1 for a, b in zip(hs, hs[1:]) if b <= a)
    hl = sum(1 for a, b in zip(ls, ls[1:]) if b > a)
    ll = sum(1 for a, b in zip(ls, ls[1:]) if b <= a)
    tot = hh + lh + hl + ll
    score = (hh + hl - lh - ll) / tot if tot else 0.0
    return {"hh": hh, "hl": hl, "lh": lh, "ll": ll, "score": score}


def _touches(series_hit: np.ndarray) -> int:
    """Numero di gruppi distinti di candele che toccano il livello (separati da >= 2 candele)."""
    idx = np.where(series_hit)[0]
    if not idx.size:
        return 0
    return int(1 + np.sum(np.diff(idx) > 2))


def _retests(h, l, c) -> dict:
    sup, res = float(l.min()), float(h.max())
    rng = np.mean((h - l) / c)
    tol = max(0.6 * rng, 0.004)
    ts_ = _touches(l <= sup * (1 + tol))
    tr_ = _touches(h >= res * (1 - tol))
    if ts_ >= tr_:
        return {"count": max(ts_ - 1, 0), "kind": "supporto", "price": sup, "tol": tol}
    return {"count": max(tr_ - 1, 0), "kind": "resistenza", "price": res, "tol": tol}


PHASE_IT = {"accumulation": "accumulo", "bull": "bull market", "distribution": "distribuzione", "bear": "bear market"}


def _current_phase() -> str | None:
    try:
        from ..routers import cycles as cyc
        return PHASE_IT.get(cyc.build()["current"]["phase"])
    except Exception:  # noqa: BLE001
        return None


def _halving_ctx(t: int) -> tuple[int, str, int]:
    ts_ = pd.Timestamp(t, unit="s", tz="UTC")
    if (pd.Timestamp.now(tz="UTC") - ts_).days <= 3:  # finestra attuale: fase coerente con la pagina Cicli
        ph_now = _current_phase()
    else:
        ph_now = None
    prev = [hv for hv in HALVINGS if hv[1] <= ts_]
    ref = prev[-1][1] if prev else GENESIS
    n = prev[-1][0] if prev else 0
    d = int((ts_ - ref).days)
    if d < 180:
        ph = "post-halving"
    elif d < 560:
        ph = "espansione/top di ciclo"
    elif d < 950:
        ph = "bear market"
    else:
        ph = "accumulo pre-halving"
    return d, ph_now or ph, n


def _features_raw(D: dict, s: int, e: int, tf: str, k_sw: int) -> dict:
    """Valori grezzi delle feature per la finestra [s, e] (inclusi)."""
    o, h, l, c, v = D["open"][s:e + 1], D["high"][s:e + 1], D["low"][s:e + 1], D["close"][s:e + 1], D["volume"][s:e + 1]
    n = len(c)
    lr = np.diff(np.log(c))
    out: dict = {}
    out["change"] = (c[-1] / D["close"][max(s - 1, 0)] - 1) * 100 if s > 0 else (c[-1] / o[0] - 1) * 100
    peak = np.maximum.accumulate(h)
    out["max_dd"] = float(np.min(l / peak - 1) * 100)
    out["range"] = (h.max() / l.min() - 1) * 100
    out["vol"] = float(np.std(lr) * math.sqrt(ANN[tf]) * 100) if lr.size > 2 else None
    x = np.arange(n)
    y = np.log(c)
    sl, ic = np.polyfit(x, y, 1)
    yhat = sl * x + ic
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    out["slope"] = (math.exp(sl * (n - 1)) - 1) * 100
    out["r2"] = 1 - float(np.sum((y - yhat) ** 2)) / ss_tot if ss_tot > 0 else 0.0
    hi, lo = h.max(), l.min()
    out["position"] = (c[-1] - lo) / (hi - lo) * 100 if hi > lo else 50.0
    out["rsi"] = float(D["rsi"][e]) if e >= 30 else None
    out["ema50"] = (c[-1] / D["ema50"][e] - 1) * 100 if e >= 60 else None
    out["ema200"] = (c[-1] / D["ema200"][e] - 1) * 100 if e >= 220 else None
    half = n // 2
    v1, v2 = v[:half], v[half:]
    if np.isfinite(v1).sum() >= half * 0.8 and np.isfinite(v2).sum() >= (n - half) * 0.8 and np.nanmean(v1) > 0:
        out["volume"] = (np.nanmean(v2) / np.nanmean(v1) - 1) * 100
    else:
        out["volume"] = None
    zz = _swings(h, l, k_sw)
    st = _structure(zz)
    out["structure"] = st["score"]
    out["_structure"] = st
    rt = _retests(h, l, c)
    out["retests"] = float(rt["count"])
    out["_retests"] = rt
    out["ath_dd"] = (c[-1] / D["ath"][e] - 1) * 100 if D["ath"][e] > 0 else None
    t0, t1 = int(D["time"][s]), int(D["time"][e])
    d, ph, nh = _halving_ctx(t1)
    out["cycle"] = float(d)
    out["_cycle"] = {"days": d, "phase": ph, "n": nh}
    u = _usdt_daily()
    out["usdt"] = None
    if u is not None:
        ut, ud = u
        i0 = np.searchsorted(ut, t0, side="right") - 1
        i1 = np.searchsorted(ut, t1, side="right") - 1
        if i0 >= 0 and i1 > i0 and t0 - ut[i0] < 3 * 86400:
            out["usdt"] = (ud[i1] / ud[i0] - 1) * 100
            out["_usdt"] = (float(ud[i0]), float(ud[i1]))
    fu = _funding()
    out["funding"] = None
    if fu is not None:
        ft, fcs = fu
        if t0 >= ft[0]:
            a = np.searchsorted(ft, t0, side="left")
            b = np.searchsorted(ft, t1 + TF_STEP[tf], side="left")
            if b - a >= max(2, (t1 - t0) // (8 * 3600) // 2):
                out["funding"] = (fcs[b] - fcs[a]) / (b - a)
    out["_zz"] = zz
    return out


# key, label, peso, scala assoluta (funzione di sigma finestra), quota relativa
def _specs(sig: float) -> list[tuple[str, str, float, float, float]]:
    return [
        ("change", "Variazione nella finestra", 1.2, max(0.5 * sig, 1.0), 0.25),
        ("max_dd", "Massimo ritracciamento interno", 1.0, max(0.4 * sig, 1.0), 0.25),
        ("range", "Ampiezza del range (max−min)", 0.8, max(0.5 * sig, 1.0), 0.25),
        ("vol", "Volatilità realizzata (annua)", 0.8, 10.0, 0.25),
        ("slope", "Pendenza del trend (regressione log)", 1.0, max(0.5 * sig, 1.0), 0.25),
        ("r2", "Linearità del trend (R²)", 0.6, 0.2, 0.0),
        ("position", "Chiusura nel range della finestra", 1.0, 20.0, 0.0),
        ("rsi", "RSI 14 a fine finestra", 1.0, 10.0, 0.0),
        ("ema50", "Distanza dalla EMA 50", 0.8, max(0.4 * sig, 1.5), 0.3),
        ("ema200", "Distanza dalla EMA 200", 1.0, max(0.6 * sig, 5.0), 0.3),
        ("volume", "Trend dei volumi (2ª metà vs 1ª)", 0.5, 20.0, 0.3),
        ("structure", "Struttura di mercato (HH/HL vs LH/LL)", 1.0, 0.5, 0.0),
        ("retests", "Retest del livello chiave", 0.6, 1.5, 0.0),
        ("ath_dd", "Distanza dal massimo storico di allora", 1.0, 8.0, 0.2),
        ("cycle", "Fase del ciclo dell'halving", 0.8, 150.0, 0.0),
        ("usdt", "Variazione USDT dominance", 0.5, max(0.4 * sig, 2.0), 0.3),
        ("funding", "Funding medio (perpetual)", 0.4, 0.008, 0.3),
    ]


def _sim(key: str, a, b, absc: float, rel: float) -> float | None:
    if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
        return None
    d = abs(a - b)
    if key == "cycle":
        d = min(d % CYCLE_DAYS, CYCLE_DAYS - d % CYCLE_DAYS)
    scale = absc + rel * max(abs(a), abs(b))
    return 100.0 * 2 ** (-(d / scale) ** 2)


def _feature_score(fc: dict, fa: dict, specs) -> float:
    num = den = 0.0
    for key, _lab, w, absc, rel in specs:
        s = _sim(key, fc.get(key), fa.get(key), absc, rel)
        if s is None:
            continue
        num += w * s
        den += w
    return num / den if den else 0.0


def _display(key: str, v: float | None, raw: dict) -> str:
    if v is None:
        return "n/d"
    if key in ("change", "max_dd", "slope", "ema50", "ema200", "volume", "ath_dd", "usdt"):
        return _sgn(v, 1)
    if key in ("range", "vol"):
        return f"{v:.1f}%"
    if key == "r2":
        return f"{v:.2f}"
    if key in ("position",):
        return f"{v:.0f}%"
    if key == "rsi":
        return f"{v:.0f}"
    if key == "structure":
        st = raw["_structure"]
        return f"{st['hh']} HH · {st['hl']} HL · {st['lh']} LH · {st['ll']} LL"
    if key == "retests":
        rt = raw["_retests"]
        return f"{int(v)}× {rt['kind']}"
    if key == "cycle":
        cy = raw["_cycle"]
        return f"{cy['days']} g dall'halving · {cy['phase']}"
    if key == "funding":
        return f"{_sgn(v, 4)}/8h"
    return f"{v:.2f}"


UNITS = {"change": "%", "max_dd": "%", "range": "%", "vol": "%", "slope": "%", "r2": "", "position": "%", "rsi": "",
         "ema50": "%", "ema200": "%", "volume": "%", "structure": "score", "retests": "n", "ath_dd": "%", "cycle": "giorni",
         "usdt": "%", "funding": "%/8h"}


def _explain(key: str, a: float, b: float, sim: float, fc: dict, fa: dict, when: str) -> str:
    q = _qual(sim)
    qf = _qual(sim, True)
    da, db = _display(key, a, fc), _display(key, b, fa)
    if key == "change":
        return f"Nella finestra attuale il prezzo è variato del {da}, {when} del {db}: movimento netto {q}."
    if key == "max_dd":
        return f"Il ritracciamento massimo dentro la finestra è {da} oggi, {when} era {db}: struttura di ritracciamento {qf}."
    if key == "range":
        return f"Il range tra massimo e minimo copre il {da} contro il {db} {when}: ampiezza {qf}."
    if key == "vol":
        return f"Volatilità annualizzata {da} oggi vs {db} {when}: regime di volatilità {q}."
    if key == "slope":
        trend = "rialzista" if a > 0 else "ribassista"
        return f"La regressione log-lineare implica un trend {trend} di {da} sulla finestra, {when} {db}: inclinazione {qf}."
    if key == "r2":
        return f"R² {da} oggi vs {db} {when}: " + ("entrambi movimenti direzionali puliti." if min(a, b) > 0.6 else
                                                  "entrambe fasi laterali/irregolari." if max(a, b) < 0.35 else f"linearità {qf}.")
    if key == "position":
        return f"L'ultima chiusura si trova al {da} del range della finestra, {when} al {db}: posizionamento {q}."
    if key == "rsi":
        zone = lambda r: "ipercomprato" if r >= 70 else "ipervenduto" if r <= 30 else "zona neutra"
        return f"RSI a {da} ({zone(a)}) contro {db} ({zone(b)}) {when}: momentum {q}."
    if key == "ema50":
        return f"Prezzo {da} rispetto alla EMA 50 oggi, {when} {db}: " + ("stesso lato della media." if a * b > 0 else "lato opposto della media.")
    if key == "ema200":
        return f"Prezzo {da} rispetto alla EMA 200 oggi, {when} {db}: " + ("stesso lato del trend di lungo periodo." if a * b > 0 else "posizione opposta rispetto al trend di lungo periodo.")
    if key == "volume":
        return f"Volumi della seconda metà {da} rispetto alla prima, {when} {db}: dinamica dei volumi {qf}."
    if key == "structure":
        return f"Struttura a swing: oggi {da}, {when} {db}: sequenza di massimi/minimi {qf}."
    if key == "retests":
        return f"Livello chiave ritestato {da} oggi, {when} {db}: comportamento sui livelli {q}."
    if key == "ath_dd":
        return f"Il prezzo è {da} dal massimo storico, {when} era {db} dal massimo di allora: contesto {q}."
    if key == "cycle":
        return f"Oggi siamo a {fc['_cycle']['days']} giorni dall'halving ({fc['_cycle']['phase']}), {when} a {fa['_cycle']['days']} ({fa['_cycle']['phase']}): fase di ciclo {qf}."
    if key == "usdt":
        return f"USDT dominance {da} nella finestra, {when} {db}: " + ("liquidità stablecoin nella stessa direzione." if a * b > 0 else "flussi di stablecoin in direzione opposta.")
    if key == "funding":
        return f"Funding medio {da} oggi, {when} {db}: posizionamento dei derivati {q}."
    return f"{da} vs {db}: {q}."


def _feature_list(fc: dict, fa: dict, specs, when: str) -> list[dict]:
    out = []
    for key, lab, w, absc, rel in specs:
        a, b = fc.get(key), fa.get(key)
        s = _sim(key, a, b, absc, rel)
        out.append({
            "key": key, "label": lab, "current": a, "analog": b,
            "display_current": _display(key, a, fc), "display_analog": _display(key, b, fa),
            "unit": UNITS[key], "similarity": round(s, 1) if s is not None else None, "weight": w,
            "explanation": _explain(key, a, b, s, fc, fa, when) if s is not None else
            ("Dato non disponibile per il periodo analogo." if a is not None else "Dato non disponibile per la finestra attuale."),
        })
    return out


# ================================================================== mappatura strutturale

def _dtw_path(q: np.ndarray, r: np.ndarray, band: int) -> list[tuple[int, int]]:
    n = len(q)
    D = np.full((n + 1, n + 1), np.inf)
    D[0, 0] = 0.0
    for i in range(1, n + 1):
        lo, hi = max(1, i - band), min(n, i + band)
        cost = np.abs(r[lo - 1:hi] - q[i - 1])
        for k, j in enumerate(range(lo, hi + 1)):
            D[i, j] = cost[k] + min(D[i - 1, j], D[i, j - 1], D[i - 1, j - 1])
    i, j = n, n
    path = [(n - 1, n - 1)]
    while i > 1 or j > 1:
        cands = [(D[i - 1, j - 1], i - 1, j - 1), (D[i - 1, j], i - 1, j), (D[i, j - 1], i, j - 1)]
        _, i, j = min(cands, key=lambda x: x[0])
        i, j = max(i, 1), max(j, 1)
        path.append((i - 1, j - 1))
    return path[::-1]


def _key_points(zz, c, h, l, max_pts: int) -> list[tuple[int, str, float]]:
    """Sceglie i pivot più significativi (per ampiezza del movimento) mantenendo l'ordine."""
    if len(zz) <= max_pts:
        return zz
    prom = []
    prev = c[0]
    for p in zz:
        prom.append(abs(p[2] / prev - 1))
        prev = p[2]
    hi_i, lo_i = int(np.argmax(h)), int(np.argmin(l))
    keep = set(np.argsort(prom)[::-1][:max_pts])
    for m, p in enumerate(zz):  # tieni sempre max e min assoluti
        if p[0] in (hi_i, lo_i):
            keep.add(m)
    keep_sorted = sorted(keep)
    while len(keep_sorted) > max_pts + 1:
        worst = min((m for m in keep_sorted if zz[m][0] not in (hi_i, lo_i)), key=lambda m: prom[m])
        keep_sorted.remove(worst)
    return [zz[m] for m in keep_sorted]


def _labels(points: list[tuple[int, str, float]], h, l, c, tol: float) -> list[str]:
    n = len(c)
    hi_i, lo_i = int(np.argmax(h)), int(np.argmin(l))
    labs = []
    last_h = last_l = None
    lows_seen: list[float] = []
    for idx, kind, price in points:
        if kind == "start":
            labs.append("Inizio finestra")
            continue
        if kind == "end":
            pre = max(3, int(n * 0.75))
            if c[-1] > h[:pre].max() * 1.003:
                labs.append("Breakout (ultima candela)")
            elif c[-1] < l[:pre].min() * 0.997:
                labs.append("Breakdown (ultima candela)")
            else:
                labs.append("Ultima candela")
            continue
        if kind == "high":
            if idx == hi_i:
                lab = "Massimo della finestra"
            elif last_h is None:
                lab = "Massimo locale"
            else:
                lab = "Higher high" if price > last_h else "Lower high"
            last_h = price
        else:
            if any(abs(price / x - 1) <= 2 * tol for x in lows_seen):
                lab = "Retest del minimo"
            elif idx == lo_i:
                lab = "Minimo della finestra"
            elif last_l is None:
                lab = "Minimo locale"
            else:
                lab = "Higher low" if price > last_l else "Lower low"
            last_l = price
            lows_seen.append(price)
        labs.append(lab)
    return labs


def _mapping(zc, za, pairs, hc, lc, cc, ha, la, ca, tc, ta, fc: dict, fa: dict, when: str) -> list[dict]:
    """Punti strutturali corrispondenti dalle gambe ZigZag allineate (estremi di gamba ↔ estremi di gamba),
    con ordine temporale crescente e distanza minima tra punti su entrambi i grafici."""
    w = len(cc)
    gap = max(2, w // 20)
    cand: dict[int, int] = {0: 0}
    for i, j in pairs:  # estremo finale della gamba i ↔ estremo finale della gamba j
        cand[i + 1] = j + 1
    cand[len(zc) - 1] = len(za) - 1
    chosen: list[tuple[int, int]] = []
    for ci in sorted(cand):
        ai = cand[ci]
        pc, pa = zc[ci], za[ai]
        is_end = ci == len(zc) - 1
        if chosen:
            pci, pai = chosen[-1]
            if pa[0] <= za[pai][0] or (zc[ci][0] - zc[pci][0] < gap) or (pa[0] - za[pai][0] < gap):
                if not is_end:
                    continue
                if len(chosen) > 1:
                    chosen.pop()  # fai posto all'ultima candela
        chosen.append((ci, ai))
    # preferisci estremi dello stesso tipo: se una coppia ha ruoli opposti e ce n'è uno vicino coerente, sostituiscilo
    pts_c = [zc[ci] for ci, _ in chosen]
    pts_a = [za[ai] for _, ai in chosen]
    tol_c = fc["_retests"]["tol"]
    tol_a = fa["_retests"]["tol"]
    lab_c = _labels(pts_c, hc, lc, cc, tol_c)
    lab_a = _labels(pts_a, ha, la, ca, tol_a)
    out = []
    for n, (pc, pa, lc_, la_) in enumerate(zip(pts_c, pts_a, lab_c, lab_a), 1):
        pcc = (pc[2] / cc[0] - 1) * 100
        pca = (pa[2] / ca[0] - 1) * 100
        same = lc_ == la_ or (pc[1] == pa[1] and pc[1] in ("high", "low") and lc_.split()[0] == la_.split()[0])
        note = (f"{lc_}: oggi {_sgn(pcc)} dall'inizio della finestra (candela {pc[0] + 1}), "
                f"{when} {_sgn(pca)} (candela {pa[0] + 1})")
        note += "." if same else f" — {when} era un «{la_.lower()}»."
        out.append({
            "n": n, "kind": pc[1], "label": lc_, "analog_label": la_, "same_role": bool(same),
            "current": {"time": int(tc[pc[0]]), "price": round(pc[2], 2), "idx": int(pc[0]), "pct": round(pcc, 2)},
            "analog": {"time": int(ta[pa[0]]), "price": round(pa[2], 2), "idx": int(pa[0]), "pct": round(pca, 2)},
            "note": note,
        })
    return out


def _legs_out(legs: list[dict], t, labels: list[str]) -> list[dict]:
    return [{"n": k + 1, "label": labels[k], "from_idx": int(g["i0"]), "to_idx": int(g["i1"]),
             "from_time": int(t[g["i0"]]), "to_time": int(t[g["i1"]]),
             "from_price": round(g["p0"], 2), "to_price": round(g["p1"], 2),
             "pct": round(g["pct"], 2), "candles": int(g["dur"])} for k, g in enumerate(legs)]


def _pats_out(pats: list[dict], t) -> list[dict]:
    out = []
    for p in pats:
        q = dict(p)
        q["lines"] = [{"kind": ln["kind"], "points": [dict(pt, time=int(t[pt["idx"]]), price=round(pt["price"], 2)) for pt in ln["points"]]}
                      for ln in p["lines"]]
        q["points"] = [dict(pt, time=int(t[pt["idx"]]), price=round(pt["price"], 2)) for pt in p["points"]]
        out.append(q)
    return out


# ================================================================== narrativa

def _narrative(m: dict, tf: str, w: int, horizon: int, when: str) -> list[str]:
    feats = [f for f in m["features"] if f["similarity"] is not None]
    best = sorted(feats, key=lambda f: -f["similarity"] * f["weight"])[:3]
    worst = sorted(feats, key=lambda f: f["similarity"])[:2]
    vc = {c["key"]: c for c in m["visual"]["components"]}
    s = [f"Graficamente l'intervallo attuale ({w} candele {TF_LABEL[tf]}) somiglia a {m['period']['label']}: somiglianza "
         f"grafica {m['visual']['score']:.0f}% (forma {vc['shape']['score']:.0f}%, candele {vc['candles']['score']:.0f}%, "
         f"gambe {vc['legs']['score']:.0f}%, figure {vc['pattern']['score']:.0f}%) e indicatori {m['feature_similarity']:.0f}%, "
         f"similarità complessiva {m['similarity']:.0f}%."]
    s.append(m["patterns"]["text"])
    good = sorted([p for p in m["leg_pairs"] if p["similarity"] >= 70], key=lambda p: -p["similarity"])
    if m["leg_pairs"]:
        s.append(f"In proporzione all'ampiezza delle due finestre, le gambe del movimento si corrispondono in {len(good)} "
                 f"casi su {len(m['leg_pairs'])}" + (f", ad esempio {_lc(good[0]['text'])}." if good else "."))
    s.append("Tra gli indicatori coincidono soprattutto " + "; ".join(
        f"{_lc(f['label'])} ({f['display_current']} oggi vs {f['display_analog']} {when})" for f in best[:2]) + ".")
    diffs = [f for f in worst if f["similarity"] < 60]
    if diffs:
        s.append("Le differenze principali: " + "; ".join(
            f"{_lc(f['label'])} ({f['display_current']} oggi vs {f['display_analog']} {when})" for f in diffs) + ".")
    o = m["outcome"]
    if o["change"] is not None:
        s.append(f"Dopo quella finestra il prezzo si mosse del {_sgn(o['change'])} nelle {o['candles']} candele successive "
                 f"(escursione massima {_sgn(o['max_up'])} / {_sgn(o['max_down'])}): un precedente, non una previsione.")
    return s


_NUM_RE = re.compile(r"[-+−]?\d+(?:[.,]\d+)?")


def _nums(text: str) -> set[float]:
    out = set()
    for x in _NUM_RE.findall(text):
        try:
            out.add(round(abs(float(x.replace("−", "-").replace(",", "."))), 1))
        except ValueError:
            pass
    return out


_llm_cache: dict[tuple, tuple[float, str | None]] = {}
_llm_busy: set[tuple] = set()
_llm_lock = threading.Lock()


def _llm_refine(key: tuple, base: list[str]) -> None:
    try:
        from .. import llm
        if not llm.available():
            res = None
        else:
            src = " ".join(base)
            txt = llm.complete([
                {"role": "system", "content": "Sei un analista di mercato. Riscrivi in italiano scorrevole, in 3-5 frasi, "
                                              "il testo fornito. Non aggiungere nessun numero, data o fatto che non sia già presente. "
                                              "Niente elenchi, niente markdown."},
                {"role": "user", "content": src},
            ], temperature=0.2, max_tokens=500, reasoning="low")
            allowed = _nums(src)
            got = _nums(txt)
            ok = bool(txt) and 120 < len(txt) < 1400 and got <= allowed
            res = txt.strip() if ok else None
            if not ok:
                log.info("narrativa LLM scartata (numeri non verificati: %s)", sorted(got - allowed)[:5])
    except Exception as e:  # noqa: BLE001
        log.debug("LLM narrativa non disponibile: %s", e)
        res = None
    with _llm_lock:
        _llm_cache[key] = (time.time(), res)
        _llm_busy.discard(key)


def _llm_narrative(key: tuple, base: list[str]) -> str | None:
    """Ritorna la versione LLM se già pronta; altrimenti la avvia in background (mai bloccante)."""
    with _llm_lock:
        hit = _llm_cache.get(key)
        if hit and time.time() - hit[0] < 1800:
            return hit[1]
        if key in _llm_busy or len(_llm_busy) >= 1:
            return None
        _llm_busy.add(key)
    threading.Thread(target=_llm_refine, args=(key, base), daemon=True, name="analogs-llm").start()
    return None


# ================================================================== core

def _r(p: float) -> float:
    """Arrotondamento compatto (payload): 1 decimale sopra $1000, 2 sotto."""
    p = float(p)
    return round(p, 1) if p >= 1000 else round(p, 2)


def _r0(p: float) -> float | int:
    """Arrotondamento compatto per le candele storiche: intero sopra $1000."""
    p = float(p)
    return int(round(p)) if p >= 1000 else round(p, 2)


def _candles(D: dict, a: int, b: int, volume: bool = True) -> list[dict]:
    t, o, h, l, c, v = D["time"], D["open"], D["high"], D["low"], D["close"], D["volume"]
    rr = _r if volume else _r0
    out = []
    for i in range(a, b):
        k = {"time": int(t[i]), "open": rr(o[i]), "high": rr(h[i]), "low": rr(l[i]), "close": rr(c[i])}
        if volume:
            k["volume"] = round(float(v[i]), 1) if np.isfinite(v[i]) else None
        out.append(k)
    return out


def search(tf: str, window: int, top: int, horizon: int) -> dict:
    D = load(tf)
    close = D["close"]
    n_all = len(close)
    x = np.log(close)
    m = n_all - 2 * window - horizon + 1
    if m < max(20, top * 2):
        raise ValueError(f"storico insufficiente per tf={tf}, window={window}, horizon={horizon}")
    cs, ce = n_all - window, n_all - 1

    # 1) candidati per forma (stessa logica di fractals.search)
    qz = fr._z(x[-window:])
    corr = fr._rolling_corr(x, qz, m)
    order = np.argsort(-corr)
    blocked = np.zeros(m, bool)
    half = max(1, window // 3)
    picks = []
    for s in order:
        if corr[s] <= 0 or len(picks) >= N_PREFILTER:
            break
        if blocked[s]:
            continue
        picks.append(int(s))
        blocked[max(0, s - half):s + half + 1] = True
    if not picks:
        picks = [int(s) for s in order[:N_PREFILTER]]
    picks_a = np.array(picks)
    cands = fr._z(x[picks_a[:, None] + np.arange(window)[None, :]])
    dtw = fr.dtw_banded(qz, cands, max(2, window // 10))
    c = corr[picks_a]
    shape = 100 * (0.6 * np.clip(c, 0, 1) + 0.4 * np.exp(-dtw / 0.35))

    # 2) re-rank: somiglianza grafica (forma, candele, gambe, figure, volumi, volatilità) + indicatori
    O, Hh, Ll, V = D["open"], D["high"], D["low"], D["volume"]
    k_sw = max(2, window // 15)
    lr = np.diff(x[-window:])
    sig = float(np.std(lr) * math.sqrt(window) * 100)
    specs = _specs(sig)
    fc = _features_raw(D, cs, ce, tf, k_sw)
    cur = slice(cs, ce + 1)
    oc, hc, lc, cc, vcol = O[cur], Hh[cur], Ll[cur], close[cur], V[cur]
    vq = vis.candle_vectors(oc, hc, lc, cc)
    zc = vis.zigzag(hc, lc, cc, vis.zz_threshold(hc, lc, cc))
    legs_c = vis.legs_of(zc)
    rng_c = (hc.max() / lc.min() - 1) * 100
    pats_c = vis.detect_patterns(oc, hc, lc, cc)
    geo_c = vis.trend_geometry(vis.zigzag(hc, lc, cc, vis.zz_threshold(hc, lc, cc) * 0.7), hc, lc)
    stats_c = vis.candle_stats(vq)

    pool = [int(k) for k in np.argsort(-shape)[:N_RERANK]]
    starts = np.array([int(picks_a[k]) for k in pool])
    idx = starts[:, None] + np.arange(window)[None, :]
    cv = np.stack([vis.candle_vectors(O[r], Hh[r], Ll[r], close[r]) for r in idx])
    cdist = vis.dtw_multi(vq, cv, max(2, window // 10))
    scored = []
    for n_k, k in enumerate(pool):
        s = int(picks_a[k])
        e = s + window - 1
        ws = slice(s, e + 1)
        oa, ha, la, ca, va = O[ws], Hh[ws], Ll[ws], close[ws], V[ws]
        fa = _features_raw(D, s, e, tf, k_sw)
        fs = _feature_score(fc, fa, specs)
        s_candles = 0.65 * vis.candle_seq_score(float(cdist[n_k])) + 0.35 * vis.candle_dist_score(vq, cv[n_k])
        za = vis.zigzag(ha, la, ca, vis.zz_threshold(ha, la, ca))
        legs_a = vis.legs_of(za)
        rng_a = (ha.max() / la.min() - 1) * 100
        s_legs, pairs = vis.legs_align(legs_c, legs_a, window, rng_c, rng_a)
        pats_a = vis.detect_patterns(oa, ha, la, ca)
        geo_a = vis.trend_geometry(vis.zigzag(ha, la, ca, vis.zz_threshold(ha, la, ca) * 0.7), ha, la)
        s_pat, common, pat_text = vis.pattern_score(pats_c, pats_a, geo_c, geo_a)
        s_vol = vis.volume_score(hc, lc, cc, vcol, ha, la, ca, va)
        s_vty = vis.volatility_score(hc, lc, cc, ha, la, ca)
        comps = {"shape": float(shape[k]), "candles": s_candles, "legs": s_legs, "pattern": s_pat,
                 "volume": s_vol, "volatility": s_vty}
        vscore = vis.combine(comps)
        total = W_VISUAL * vscore + (1 - W_VISUAL) * fs
        scored.append({"score": total, "k": k, "s": s, "fa": fa, "fs": fs, "vscore": vscore, "comps": comps,
                       "za": za, "legs_a": legs_a, "pairs": pairs, "pats_a": pats_a, "common": common,
                       "pat_text": pat_text, "cdist": float(cdist[n_k]), "stats_a": vis.candle_stats(cv[n_k]), "rng_a": rng_a})
    scored.sort(key=lambda r: -r["score"])
    chosen = []
    for row in scored:
        if all(abs(row["s"] - r["s"]) >= window for r in chosen):
            chosen.append(row)
        if len(chosen) >= top:
            break

    # 3) output per analogo
    t = D["time"]
    tc = t[cur]
    cur_close = float(close[-1])
    step = TF_STEP[tf]
    leg_labels_c = [f"G{i + 1}" for i in range(len(legs_c))]
    legs_c_out = _legs_out(legs_c, tc, leg_labels_c)
    pats_c_out = _pats_out(pats_c, tc)
    atr_c = float(np.mean((hc - lc) / cc) * 100)
    matches = []
    for rank, row in enumerate(chosen, 1):
        k, s, fa, fs = row["k"], row["s"], row["fa"], row["fs"]
        e = s + window - 1
        ws = slice(s, e + 1)
        ha, la, ca = Hh[ws], Ll[ws], close[ws]
        ta = t[ws]
        when = _when(int(t[s]), int(t[e]))
        fut = slice(e + 1, e + 1 + horizon)
        ec = float(close[e])
        fh, fl, fcl = D["high"][fut], D["low"][fut], close[fut]
        f = cur_close / ec
        comps = row["comps"]
        # etichette delle gambe analoghe = numero della gamba attuale a cui sono abbinate
        lab_a: list[str] = []
        for j in range(len(row["legs_a"])):
            ii = [i for i, jj in row["pairs"] if jj == j]
            lab_a.append("G" + "/".join(str(i + 1) for i in ii[:2]) if ii else "–")
        legs_a_out = _legs_out(row["legs_a"], ta, lab_a)
        leg_pairs = []
        for i, j in row["pairs"]:
            gc, ga = legs_c[i], row["legs_a"][j]
            mx = gc["pct"] / max(rng_c, 1e-6)
            my = ga["pct"] / max(row["rng_a"], 1e-6)
            cost = abs(mx - my) + 0.8 * abs(gc["dur"] - ga["dur"]) / window + (0.6 if (gc["pct"] > 0) != (ga["pct"] > 0) else 0)
            sim = 100 * math.exp(-cost / 0.35)
            leg_pairs.append({
                "current": i + 1, "analog": j + 1, "similarity": round(sim, 1),
                "text": f"Gamba {i + 1}: {_sgn(gc['pct'])} in {gc['dur']} candele ↔ {_sgn(ga['pct'])} in {ga['dur']} candele",
            })
        good = sum(1 for p in leg_pairs if p["similarity"] >= 70)
        sc, sa = stats_c, row["stats_a"]
        atr_a = float(np.mean((ha - la) / ca) * 100)
        expl = {
            "shape": f"Correlazione {c[k]:.2f} e distanza DTW {dtw[k]:.2f} sul log-prezzo normalizzato: i due grafici "
                     f"disegnano un percorso {_qual(comps['shape'])}.",
            "candles": f"Candele verdi {sc['green']:.0f}% oggi vs {sa['green']:.0f}% {when}; corpo mediano "
                       f"{sc['body']:.2f}×ATR vs {sa['body']:.2f}×ATR, ombre {sc['wick']:.2f}×ATR vs {sa['wick']:.2f}×ATR: "
                       f"sequenza di candele {_qual(comps['candles'], True)}.",
            "legs": f"{len(legs_c)} gambe oggi contro {len(row['legs_a'])} {when}; {good} coppie su {len(leg_pairs)} con "
                    f"ampiezza e durata simili (≥70%).",
            "pattern": row["pat_text"],
            "volume": ("Volumi non disponibili per il periodo analogo." if comps["volume"] is None else
                       f"Distribuzione dei volumi per livello di prezzo e andamento nel tempo: {_qual(comps['volume'], True)}."),
            "volatility": f"Range medio per candela {atr_c:.2f}% oggi vs {atr_a:.2f}% {when}; andamento della "
                          f"volatilità {_qual(comps['volatility'], True)}.",
        }
        visual = {
            "score": round(row["vscore"], 1),
            "components": [{"key": key, "label": vis.VIS_LABELS[key], "score": round(comps[key], 1) if comps[key] is not None else None,
                            "weight": wgt, "explanation": expl[key]} for key, wgt in vis.VIS_WEIGHTS.items()],
        }
        mt = {
            "rank": rank,
            "period": {"start": int(t[s]), "end": int(t[e]), "label": period_label(int(t[s]), int(t[e]), tf), "when": when},
            "similarity": round(float(row["score"]), 1),
            "visual_similarity": round(float(row["vscore"]), 1),
            "shape_similarity": round(float(shape[k]), 1),
            "feature_similarity": round(float(fs), 1),
            "correlation": round(float(c[k]), 4),
            "dtw": round(float(dtw[k]), 4),
            "dtw_score": round(float(100 * np.exp(-dtw[k] / 0.35)), 1),
            "visual": visual,
            "patterns": {"current": pats_c_out, "analog": _pats_out(row["pats_a"], ta), "common": row["common"],
                         "common_name": vis.NAMES.get(row["common"]) if row["common"] else None,
                         "text": row["pat_text"], "score": round(comps["pattern"], 1)},
            "legs_current": legs_c_out,
            "legs_analog": legs_a_out,
            "leg_pairs": leg_pairs,
            "features": _feature_list(fc, fa, specs, when),
            "outcome": {
                "candles": int(len(fcl)),
                "change": round(float((fcl[-1] / ec - 1) * 100), 2) if len(fcl) else None,
                "max_up": round(float((fh.max() / ec - 1) * 100), 2) if len(fh) else None,
                "max_down": round(float((fl.min() / ec - 1) * 100), 2) if len(fl) else None,
                "end_time": int(t[e + len(fcl)]) if len(fcl) else None,
            },
            "candles": _candles(D, s, min(n_all, e + 1 + horizon), volume=False),
            "projection": {
                "times": [int(t[-1]) + step * (i + 1) for i in range(len(fcl))],
                "close": [_r0(v) for v in fcl * f],
            },
        }
        mt["mapping"] = _mapping(zc, row["za"], row["pairs"], hc, lc, cc, ha, la, ca, tc, ta, fc, fa, when)
        mt["narrative"] = _narrative(mt, tf, window, horizon, when)
        mt["narrative_llm"] = None
        matches.append(mt)

    # 4) riepilogo
    outs = np.array([mm["outcome"]["change"] for mm in matches if mm["outcome"]["change"] is not None])
    sims = np.array([mm["similarity"] for mm in matches if mm["outcome"]["change"] is not None])
    up = int((outs > 0).sum())
    n_m = len(outs)
    med = float(np.median(outs)) if n_m else None
    wavg = float((outs * sims).sum() / sims.sum()) if n_m and sims.sum() > 0 else None
    agree = max(up, n_m - up) / n_m * 100 if n_m else None
    bias = "neutral"
    if n_m and up / n_m >= 0.65 and (med or 0) > 0:
        bias = "bullish"
    elif n_m and up / n_m <= 0.35 and (med or 0) < 0:
        bias = "bearish"
    dir_txt = {"bullish": "al rialzo", "bearish": "al ribasso", "neutral": "senza una direzione prevalente"}[bias]
    summary_text = (f"{up} {'analogo' if up == 1 else 'analoghi'} su {n_m} {'è salito' if up == 1 else 'sono saliti'} nelle {horizon} candele successive (mediana {_sgn(med)}): "
                    f"i precedenti si sono risolti {dir_txt}.") if n_m else "Nessun esito disponibile."
    first_cur = D["close"][cs - 1] if cs > 0 else D["open"][cs]
    return {
        "tf": tf, "window": window, "horizon": horizon, "top": top,
        "generated_at": int(time.time()),
        "current": {
            "start": int(t[cs]), "end": int(t[ce]), "label": period_label(int(t[cs]), int(t[ce]), tf),
            "close": cur_close, "base_close": float(first_cur),
            "candles": _candles(D, cs, n_all),
        },
        "summary": {
            "count": n_m, "up": up, "down": n_m - up, "agreement": round(agree, 1) if agree is not None else None,
            "median_outcome": round(med, 2) if med is not None else None,
            "weighted_outcome": round(wavg, 2) if wavg is not None else None,
            "best_similarity": matches[0]["similarity"] if matches else None,
            "bias": bias, "text": summary_text,
        },
        "matches": matches,
        "method": ("Candidati selezionati per forma (correlazione di Pearson + DTW sul log-prezzo normalizzato, come nella "
                   f"pagina Frattali); i migliori {N_RERANK} sono riordinati con un punteggio spiegabile: 70% somiglianza "
                   "grafica (forma 30%, geometria delle candele 20% con DTW su corpo/ombre normalizzati per ATR, gambe ZigZag "
                   "allineate 20%, figure grafiche e trendline 15%, profilo volumi 7.5%, inviluppo di volatilità 7.5%) e 30% "
                   f"media pesata di {len(specs)} indicatori di contesto. Ogni indicatore ha una similarità 0–100 = 2^(−(Δ/scala)²), dove la "
                   "scala combina una soglia assoluta (legata alla volatilità della finestra) e una quota relativa al valore."),
    }


@util.ttl_cache(60)
def cached(tf: str, window: int, top: int, horizon: int) -> dict:
    return util.clean(search(tf, window, top, horizon))


def compute(tf: str, window: int, top: int, horizon: int) -> dict:
    r = cached(tf, window, top, horizon)
    if r["matches"]:
        best = r["matches"][0]
        key = (tf, window, horizon, best["period"]["start"])
        txt = _llm_narrative(key, best["narrative"])
        if txt:
            r = dict(r)
            r["matches"] = [dict(best, narrative_llm=txt)] + r["matches"][1:]
    return r
