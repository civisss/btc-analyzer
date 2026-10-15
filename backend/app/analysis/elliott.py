"""Onde di Elliott: conteggio automatico con regole rigide, linee guida a punteggio e backtest walk-forward.

Pipeline (tutto causale, nessun dato futuro):
  1. swing = pivot confermati dello ZigZag su ATR(14) (`structure.zigzag_confirmed`, indice di conferma `ci`) a tre soglie
     per timeframe = tre gradi (es. 1D: Primary 5×, Intermediate 3×, Minor 2× ATR). Le sotto-onde di ogni gamba sono contate
     con uno ZigZag più fine (0.45× la soglia) vincolato alla gamba stessa;
  2. a ogni istante T si generano i conteggi candidati che finiscono sull'ultimo pivot confermato m: impulso 1-2-3-4-5
     (onda 2…5 in corso o completo), diagonale contraente/espansiva (onda 4, 5 in corso o completa), zigzag e flat
     (B, C in corso o completi), triangolo contraente/barriera/espansivo (C, D, E in corso o completo), doppio zigzag e
     doppia three W-X-Y (X…Y in corso o completa). L'onda in corso è la gamba dal pivot m all'estremo raggiunto finora;
  3. REGOLE = vincoli rigidi: un candidato che ne viola una (anche con l'estremo in corso) è scartato;
     LINEE GUIDA = punteggio pesato dichiarato (Fibonacci con tolleranze, alternanza, estensione, canale, tempi,
     sottostruttura, volume, divergenza RSI, inizio su un estremo, copertura del pattern, coerenza col grado superiore);
  4. per ogni candidato: invalidazione (prezzo oltre il quale l'etichettatura è falsa), obiettivo dell'onda in corso e di
     quella successiva (livelli di Fibonacci, zona = intervallo dei rapporti tipici, centro = media dei rapporti principali);
  5. backtest walk-forward: a ogni conferma di un pivot si rifà tutto con i soli dati noti e si verifica la direzione a
     un orizzonte pari alla durata mediana degli swing, l'obiettivo toccato prima dell'invalidazione, l'errore sul pivot
     reale, contro due baseline (alternanza con ampiezza mediana; conteggio valido scelto a caso). La probabilità mostrata
     per il rango r = frequenza storica con cui il conteggio di rango r è stato quello "giusto a posteriori"
     (fine reale dell'onda dentro la zona obiettivo, nessuna invalidazione prima, errore minimo tra i confermati).
     Un ranker a regressione logistica addestrato solo sugli esiti già noti viene confrontato fuori campione col punteggio
     a regole e adottato solo se migliore.

Lunghezze e rapporti in scala logaritmica (variazioni percentuali): EWI esprime «l'onda 3 non è mai la più corta» in termini
percentuali e Frost & Prechter raccomandano la scala semilog per i movimenti ampi; le regole di livello (2 oltre l'inizio di 1,
4 nel territorio di 1) non dipendono dalla scala. I testi li compone il frontend (chiavi + numeri).
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
import warnings

import numpy as np
import pandas as pd

from .. import util
from ..data import store
from . import analogs as an
from .structure import zigzag_confirmed
from .structure_analogs import causal_atr

log = logging.getLogger("elliott")

TFS = ("4h", "1d", "1w")
STEP = {"4h": 14400, "1d": 86400, "1w": 604800}
START = pd.Timestamp("2011-01-01", tz="UTC")
DEGREES = ["supercycle", "cycle", "primary", "intermediate", "minor", "minute", "minuette", "subminuette"]
# gradi per timeframe (dal più alto al più basso): soglia ZigZag in multipli di ATR(14)
TF_DEGREES: dict[str, tuple[tuple[str, float], ...]] = {
    "4h": (("intermediate", 6.0), ("minor", 4.0), ("minute", 2.5)),
    "1d": (("primary", 5.0), ("intermediate", 3.0), ("minor", 2.0)),
    "1w": (("cycle", 4.0), ("primary", 2.5), ("intermediate", 1.5)),
}
DEFAULT_DEGREE = {"4h": "minor", "1d": "intermediate", "1w": "primary"}
SUB_FACTOR = 0.45            # soglia delle sotto-onde = 0.45 × soglia del grado
START_WIN = 6                # pivot precedenti per «inizio su un estremo»
N_RANDOM = 400               # estrazioni della baseline «conteggio valido casuale»
TOP_OUT = 5                  # preferito + 4 alternativi
ML_MIN_TRAIN = 80            # istanti con esito noto prima di addestrare il ranker
ML_EVERY = 20                # riaddestramento ogni N istanti
TOL_RET = 0.07               # tolleranza (in rapporto) per i ritracciamenti di Fibonacci
TOL_EXT = 0.12               # tolleranza (log-rapporto) per le estensioni
TOL_TIME = 0.30              # tolleranza (log-rapporto) per i rapporti di tempo
BT_FILE = store.DATA_DIR / "elliott_bt.json"

# pesi dichiarati delle linee guida (punteggio = 100 × Σ peso·g / Σ peso sulle linee guida applicabili)
WEIGHTS = {
    "w2_fib": 1.0, "w3_fib": 1.0, "w4_fib": 1.0, "w5_fib": 1.0, "alternation": 1.0, "extension": 0.75, "channel_w4": 0.5,
    "channel_w5": 0.5, "time": 0.5, "substructure": 1.0, "volume": 0.5, "divergence": 0.5, "start_extreme": 1.0,
    "coverage": 1.0, "coherence": 0.75, "truncation": 0.5, "overlap": 1.0, "diag_ratios": 1.0, "b_fib": 1.0, "c_fib": 1.0,
    "depth": 0.5, "tri_legs": 1.0, "barrier": 0.25, "x_fib": 1.0, "y_eq_w": 1.0, "flat_b": 1.0,
}

PATTERNS = ("impulse", "diagonal", "zigzag", "flat", "triangle", "double_zigzag", "double_three")
LABELS = {
    "impulse": ["1", "2", "3", "4", "5"], "diagonal": ["1", "2", "3", "4", "5"], "zigzag": ["A", "B", "C"], "flat": ["A", "B", "C"],
    "triangle": ["A", "B", "C", "D", "E"], "double_zigzag": ["a", "b", "W", "X", "a", "b", "Y"],
    "double_three": ["a", "b", "W", "X", "a", "b", "Y"],
}
# onda in corso per i doppi (gamba k+1): la gamba 1 è la "a" di W, ecc.
DOUBLE_WAVE = ["a", "b", "c", "X", "a", "b", "c"]
MOTIVE_LEGS = {"impulse": {1, 3, 5}, "diagonal": set(), "zigzag": {1, 3}, "flat": {3}, "triangle": set(),
               "double_zigzag": {1, 3, 5, 7}, "double_three": set()}


# ================================================================== dati

def _secs(s) -> np.ndarray:
    s = pd.to_datetime(pd.Series(s), utc=True).astype("datetime64[ns, UTC]")
    return ((s - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(dtype=np.int64)


def load(tf: str) -> dict:
    """Serie BTC dal 2011 (tempo in secondi UTC, OHLCV, RSI14, ATR14 causale). Ultima candela = in formazione se non chiusa."""
    if tf not in TFS:
        raise ValueError(f"tf non valido: {tf} (ammessi: {', '.join(TFS)})")
    D = an.load(tf)
    t = np.asarray(D["time"], dtype=np.int64)
    keep = t >= int(START.timestamp())
    S = {k: np.asarray(D[k], dtype=float)[keep] for k in ("open", "high", "low", "close", "volume", "rsi")}
    S["time"] = t[keep]
    S["n"] = len(S["time"])
    S["step"] = STEP[tf]
    S["forming"] = bool(int(S["time"][-1]) + STEP[tf] > time.time())
    S["atr"] = causal_atr(S["high"], S["low"], S["close"])
    return S


def cut(S: dict, T: int) -> dict:
    """Serie troncata all'indice T incluso (il «presente» è T)."""
    out = {k: (v[: T + 1] if isinstance(v, np.ndarray) else v) for k, v in S.items()}
    out["n"] = T + 1
    out["forming"] = False
    return out


def pivots(S: dict, mult: float, upto: int | None = None) -> dict:
    """Pivot confermati (array) dello ZigZag mult×ATR sulle candele 0..upto."""
    u = S["n"] - 1 if upto is None else upto
    piv = zigzag_confirmed(S["high"][: u + 1], S["low"][: u + 1], S["atr"][: u + 1], mult)
    conf = [p for p in piv if p["ci"] is not None]
    return {"i": np.array([p["i"] for p in conf], dtype=np.int64), "ci": np.array([p["ci"] for p in conf], dtype=np.int64),
            "k": np.array([1 if p["kind"] == "high" else -1 for p in conf], dtype=np.int64),
            "p": np.array([p["price"] for p in conf], dtype=float)}


def pend_state(S: dict, P: dict, m: int, T: int) -> tuple[int, float]:
    """Estremo raggiunto all'istante T dalla gamba partita dal pivot m (onda in corso)."""
    a = int(P["ci"][m])
    if P["k"][m] == 1:
        seg = S["low"][a:T + 1]
        k = len(seg) - 1 - int(np.argmin(seg[::-1]))
    else:
        seg = S["high"][a:T + 1]
        k = len(seg) - 1 - int(np.argmax(seg[::-1]))
    return a + k, float(seg[k])


def sub_count(S: dict, ia: int, ib: int, up: bool, mult: float) -> int:
    """Numero di sotto-onde (dispari) della gamba [ia, ib]: ZigZag fine vincolato alla gamba, partendo dal suo estremo."""
    if ib - ia < 2:
        return 1
    h, l, a = S["high"], S["low"], S["atr"]
    legs = 1
    trend = 1 if up else -1
    ext = h[ia] if up else l[ia]
    for i in range(ia + 1, ib + 1):
        thr = mult * a[i]
        if not np.isfinite(thr):
            continue
        if trend == 1:
            if h[i] >= ext:
                ext = h[i]
            elif ext - l[i] > thr:
                legs += 1
                trend, ext = -1, l[i]
        else:
            if l[i] <= ext:
                ext = l[i]
            elif h[i] - ext > thr:
                legs += 1
                trend, ext = 1, h[i]
    if legs % 2 == 0:
        legs -= 1
    return max(1, legs)


# ================================================================== punteggi elementari

def near_ret(r: float, ideals, tol: float = TOL_RET) -> float:
    """Vicinanza di un ritracciamento ai valori ideali (gaussiana, tolleranza in unità di rapporto)."""
    if r is None or not math.isfinite(r):
        return 0.0
    return float(max(math.exp(-0.5 * ((r - x) / tol) ** 2) for x in ideals))


def near_ext(r: float, ideals, tol: float = TOL_EXT) -> float:
    """Vicinanza di un rapporto di estensione ai valori ideali (in log-rapporto)."""
    if r is None or not math.isfinite(r) or r <= 0:
        return 0.0
    return float(max(math.exp(-0.5 * (math.log(r / x) / tol) ** 2) for x in ideals))


def _g(key: str, score: float, value=None, ideal=None) -> dict:
    return {"key": key, "score": float(max(0.0, min(1.0, score))), "weight": WEIGHTS[key], "value": value, "ideal": ideal}


def _r(key: str, value=None, limit=None) -> dict:
    return {"key": key, "value": value, "limit": limit}


def _zone(key: str, base: float, length: float, sign: int, main: tuple, rng: tuple, extra: list | None = None) -> dict:
    """Obiettivo: livelli base + sign·r·length (z = log prezzo × direzione); zona = rapporti tipici, centro = media dei principali."""
    levels = [{"key": key, "ratio": r, "z": base + sign * r * length} for r in sorted(set(main) | set(rng))]
    zs_main = [base + sign * r * length for r in main]
    zr = [base + sign * r * length for r in rng]
    if extra:
        levels += extra
        zs_main += [e["z"] for e in extra if e.get("main")]
        zr += [e["z"] for e in extra if e.get("in_range", True)]
    return {"levels": levels, "zc": float(np.mean(zs_main)), "zlo": float(min(zr)), "zhi": float(max(zr))}


# ================================================================== valutazione dei pattern
# z[j] = d·log(prezzo del pivot j): il pattern sale sempre in z (la prima gamba è «in su»). zpe = estremo dell'onda in corso.
# Ritorna None se una regola è violata, altrimenti il candidato (in z) con regole, linee guida, invalidazione e obiettivi.

class Inst:
    """Contesto point-in-time di un istante: serie, pivot fino a m, onda in corso, sottostrutture in cache."""

    def __init__(self, S: dict, P: dict, m: int, T: int, mult: float, sub_cache: dict, hi_dir: int | None = None):
        self.S, self.P, self.m, self.T, self.mult = S, P, m, T, mult
        self.sub_mult = mult * SUB_FACTOR
        self.sub_cache = sub_cache
        self.hi_dir = hi_dir
        self.pend_i, self.pend_p = pend_state(S, P, m, T)
        self.close = float(S["close"][T])

    def sub(self, j: int) -> int:
        """Sotto-onde della gamba tra i pivot j-1 e j (entrambi confermati)."""
        key = (int(self.P["i"][j - 1]), int(self.P["i"][j]))
        v = self.sub_cache.get(key)
        if v is None:
            v = sub_count(self.S, key[0], key[1], bool(self.P["k"][j] == 1), self.sub_mult)
            self.sub_cache[key] = v
        return v


def _subs_score(inst: Inst, s: int, k: int, motive: set, any_ok: bool = False) -> dict | None:
    """Sottostruttura: motrici 5 o 9 sotto-onde, correttive 3 o 7 (1 = non risolta, punteggio 0.5)."""
    if k < 1:
        return None
    sc = []
    counts = []
    for j in range(1, k + 1):
        n = inst.sub(s + j)
        counts.append(n)
        if n == 1:
            sc.append(0.5)
        elif any_ok:
            sc.append(1.0 if n % 4 == 3 else 0.6)   # diagonali/triangoli: gambe in 3
        elif j in motive:
            sc.append(1.0 if n % 4 == 1 else 0.0)
        else:
            sc.append(1.0 if n % 4 == 3 else 0.0)
    return _g("substructure", float(np.mean(sc)), counts)


def _start_extreme(inst: Inst, s: int, d: int) -> dict | None:
    """L'onda 1 / A parte da un estremo dei pivot precedenti dello stesso tipo (fine del movimento precedente)."""
    P = inst.P
    a0 = max(0, s - START_WIN)
    same = [j for j in range(a0, s) if P["k"][j] == P["k"][s]]
    if len(same) < 1:
        return None
    zs = d * math.log(P["p"][s])
    lower = sum(1 for j in same if d * math.log(P["p"][j]) < zs)
    return _g("start_extreme", 1.0 if lower == 0 else 0.4 if lower == 1 else 0.0, lower)


def _coherence(inst: Inst, exp_dir: int) -> dict | None:
    if inst.hi_dir is None or exp_dir == 0:
        return None
    return _g("coherence", 1.0 if exp_dir == inst.hi_dir else 0.0, int(inst.hi_dir))


def _time_ratio(inst: Inst, s: int, a: int, b: int, ideals=(0.618, 1.0, 1.618)) -> float | None:
    """Rapporto tra le durate delle gambe a e b (indici 1-based nel pattern)."""
    i = inst.P["i"]
    da = i[s + a] - i[s + a - 1]
    db = i[s + b] - i[s + b - 1]
    if da <= 0 or db <= 0:
        return None
    return float(da / db)


def _channel(inst: Inst, s: int, z: list, j_line: tuple, j_par: int, j_test: int, tol: float) -> tuple[float, float] | None:
    """Canale: retta per i pivot j_line, parallela per j_par; scarto del pivot j_test dalla parallela (÷ ampiezza dell'onda 3)."""
    i = inst.P["i"]
    a, b = j_line
    if i[s + b] == i[s + a]:
        return None
    slope = (z[b] - z[a]) / (i[s + b] - i[s + a])
    exp_z = z[j_par] + slope * (i[s + j_test] - i[s + j_par])
    a3 = abs(z[3] - z[2]) if len(z) > 3 else abs(z[1] - z[0])
    if a3 <= 0:
        return None
    dev = (z[j_test] - exp_z) / a3
    return float(dev), float(math.exp(-0.5 * (dev / tol) ** 2))


def eval_impulse(inst: Inst, s: int, z: list, k: int, zpe: float, d: int) -> dict | None:
    L = [None] + [abs(z[j] - z[j - 1]) for j in range(1, k + 1)]
    rules, guides = [], []
    # ---- regole sulle onde completate
    if k >= 2:
        if not z[2] > z[0]:
            return None
        rules.append(_r("w2_start", L[2] / L[1], 1.0))
    if k >= 3:
        if not z[3] > z[1]:
            return None
        rules.append(_r("w3_beyond_w1", L[3] / L[1], None))
    if k >= 4:
        if not z[4] > z[1]:
            return None
        rules.append(_r("w4_overlap", (z[4] - z[1]) / L[3], 0.0))
    if k >= 5:
        if L[3] < L[1] and L[3] < L[5]:
            return None
        rules.append(_r("w3_shortest", L[3] / max(min(L[1], L[5]), 1e-12), 1.0))
    # ---- onda in corso: vincoli già verificabili con l'estremo raggiunto
    inv_lo = inv_hi = None
    why_lo = why_hi = None
    if k == 1:
        if not zpe > z[0]:
            return None
        inv_lo, why_lo = z[0], "w2_start"
    elif k == 2:
        inv_lo, why_lo = z[2], "labeling"
    elif k == 3:
        if not zpe > z[1]:
            return None
        inv_lo, why_lo = z[1], "w4_overlap"
    elif k == 4:
        inv_lo, why_lo = z[4], "labeling"
        if L[3] < L[1]:
            cap = z[4] + L[3]
            if not zpe < cap:
                return None
            inv_hi, why_hi = cap, "w3_shortest"
    else:
        inv_hi, why_hi = z[5], "labeling"
    # ---- linee guida
    if k >= 2:
        r2 = L[2] / L[1]
        guides.append(_g("w2_fib", near_ret(r2, (0.5, 0.618)), r2, [0.5, 0.618]))
    if k >= 3:
        r3 = L[3] / L[1]
        guides.append(_g("w3_fib", near_ext(r3, (1.618, 2.618)), r3, [1.618, 2.618]))
    if k >= 4:
        r4 = L[4] / L[3]
        guides.append(_g("w4_fib", near_ret(r4, (0.236, 0.382)), r4, [0.236, 0.382]))
        deep2, deep4 = L[2] / L[1] >= 0.5, L[4] / L[3] >= 0.5
        tr = _time_ratio(inst, s, 4, 2)
        t_alt = tr is not None and (tr >= 1.618 or tr <= 0.618)
        n2, n4 = inst.sub(s + 2), inst.sub(s + 4)
        s_alt = n2 != n4 and not (n2 == 1 and n4 == 1)
        guides.append(_g("alternation", (float(deep2 != deep4) + float(t_alt) + float(s_alt)) / 3, [L[2] / L[1], L[4] / L[3], tr], None))
        ch = _channel(inst, s, z, (1, 3), 2, 4, 0.2)
        if ch:
            guides.append(_g("channel_w4", ch[1], ch[0], [0.0]))
        if tr is not None:
            guides.append(_g("time", near_ext(tr, (0.618, 1.0, 1.618, 2.618), TOL_TIME), tr, [0.618, 1.0, 1.618, 2.618]))
    if k >= 5:
        r51 = L[5] / L[1]
        r513 = L[5] / (z[3] - z[0])
        ext3 = L[3] >= 1.382 * max(L[1], L[5])
        sc = max(near_ext(r51, (1.0, 0.618)), near_ext(r513, (0.618,))) if ext3 or L[1] >= L[3] else max(near_ext(r51, (1.0, 0.618, 1.618)), near_ext(r513, (0.618, 1.0, 1.618)))
        guides.append(_g("w5_fib", sc, [r51, r513], [1.0, 0.618]))
        ls = sorted([L[1], L[3], L[5]], reverse=True)
        guides.append(_g("extension", 1.0 if ls[0] >= 1.382 * ls[1] else 0.3, ls[0] / ls[1], [1.382]))
        guides.append(_g("truncation", 1.0 if z[5] > z[3] else 0.0, (z[5] - z[3]) / L[3], None))
        ch = _channel(inst, s, z, (2, 4), 3, 5, 0.25)
        if ch:
            guides.append(_g("channel_w5", ch[1], ch[0], [0.0]))
        v = inst.S["volume"]
        i = inst.P["i"]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            v3 = np.nanmean(v[i[s + 2]:i[s + 3] + 1])
            v5 = np.nanmean(v[i[s + 4]:i[s + 5] + 1])
            v1 = np.nanmean(v[i[s]:i[s + 1] + 1])
        if np.isfinite(v3) and np.isfinite(v5) and v5 > 0 and np.isfinite(v1):
            guides.append(_g("volume", (float(v3 > v5) + float(v3 >= v1)) / 2, float(v3 / v5), [1.0]))
        rsi = inst.S["rsi"]
        r3_, r5_ = rsi[i[s + 3]], rsi[i[s + 5]]
        if np.isfinite(r3_) and np.isfinite(r5_):
            div = (r5_ < r3_) if d == 1 else (r5_ > r3_)
            guides.append(_g("divergence", 1.0 if div else 0.0, [float(r3_), float(r5_)], None))
    elif k == 4:
        ls = [L[1], L[3]]
        guides.append(_g("extension", 1.0 if max(ls) >= 1.382 * min(ls) else 0.5, max(ls) / min(ls), [1.382]))
    sb = _subs_score(inst, s, k, MOTIVE_LEGS["impulse"])
    if sb:
        guides.append(sb)
    se = _start_extreme(inst, s, d)
    if se:
        guides.append(se)
    guides.append(_g("coverage", k / 5, k, [5]))
    # ---- obiettivi (onda in corso) e onda successiva
    if k == 1:
        tg = _zone("ret_w1", z[1], L[1], -1, (0.5, 0.618), (0.382, 0.786))
        w_cur, w_next = "2", "3"
        nxt = lambda zc: _zone("ext_w1", zc, L[1], 1, (1.618,), (1.618,))  # noqa: E731
    elif k == 2:
        tg = _zone("ext_w1", z[2], L[1], 1, (1.618,), (1.272, 2.618))
        w_cur, w_next = "3", "4"
        nxt = lambda zc: _zone("ret_w3", zc, zc - z[2], -1, (0.382,), (0.382,))  # noqa: E731
    elif k == 3:
        tg = _zone("ret_w3", z[3], L[3], -1, (0.382,), (0.236, 0.5))
        tg["zlo"] = max(tg["zlo"], z[1])
        w_cur, w_next = "4", "5"
        nxt = lambda zc: _zone("ext_w1", zc, L[1], 1, (1.0,), (1.0,))  # noqa: E731
    elif k == 4:
        ext3 = L[3] >= 1.382 * L[1]
        extra = [{"key": "w5_eq_w1", "ratio": 1.0, "z": z[4] + L[1], "main": True},
                 {"key": "w5_618_w13", "ratio": 0.618, "z": z[4] + 0.618 * (z[3] - z[0]), "main": True},
                 {"key": "w5_618_w1", "ratio": 0.618, "z": z[4] + 0.618 * L[1], "main": False}]
        if not ext3:
            extra.append({"key": "w5_1618_w1", "ratio": 1.618, "z": z[4] + 1.618 * L[1], "main": False})
        tg = {"levels": extra, "zc": float(np.mean([e["z"] for e in extra if e["main"]])),
              "zlo": float(min(e["z"] for e in extra)), "zhi": float(max(e["z"] for e in extra))}
        if inv_hi is not None:
            tg["zhi"] = min(tg["zhi"], inv_hi)
            tg["zc"] = min(tg["zc"], inv_hi)
        w_cur, w_next = "5", "A"
        nxt = lambda zc: _zone("ret_imp", zc, zc - z[0], -1, (0.382,), (0.382,))  # noqa: E731
    else:
        tot = z[5] - z[0]
        tg = _zone("ret_imp", z[5], tot, -1, (0.382,), (0.236, 0.5),
                   extra=[{"key": "prev_w4", "ratio": None, "z": z[4], "main": False, "in_range": False}])
        w_cur, w_next = "A", "B"
        nxt = lambda zc: _zone("ret_a", zc, z[5] - zc, 1, (0.5,), (0.5,))  # noqa: E731
    return {"rules": rules, "guides": guides, "inv_lo": inv_lo, "inv_hi": inv_hi, "why_lo": why_lo, "why_hi": why_hi,
            "target": tg, "next_fn": nxt, "w_cur": w_cur, "w_next": w_next, "variant": None,
            "next_higher": k == 5, "cur_motive": k in (2, 4)}


def eval_diagonal(inst: Inst, s: int, z: list, k: int, zpe: float, d: int) -> dict | None:
    """Diagonale (contraente o espansiva): generata solo da onda 4 in poi (prima è indistinguibile dall'impulso)."""
    if k < 3:
        return None
    L = [None] + [abs(z[j] - z[j - 1]) for j in range(1, k + 1)]
    if not (z[2] > z[0] and z[3] > z[1]):
        return None
    contracting = L[3] < L[1]
    variant = "contracting" if contracting else "expanding"
    rules = [_r("w2_start", L[2] / L[1], 1.0), _r("w3_beyond_w1", L[3] / L[1], None)]
    inv_lo = inv_hi = None
    why_lo = why_hi = None
    # wave 4 effettiva (completa) o in corso
    z4 = z[4] if k >= 4 else zpe
    overlap = z4 < z[1]
    if k >= 4:
        if not z[4] > z[2]:
            return None
        L4 = L[4]
        if contracting and not L4 < L[2]:
            return None
        if not contracting and not L4 > L[2]:
            return None
        rules += [_r("diag_w4_w3start", (z[4] - z[2]) / L[3], 0.0), _r("diag_contract" if contracting else "diag_expand", L[3] / L[1], 1.0)]
    else:   # onda 4 in corso
        if not zpe > z[2]:
            return None
        if contracting:
            floor = max(z[2], z[3] - L[2])
            if not zpe > floor:
                return None
            inv_lo, why_lo = floor, "diag_contract"
        else:
            inv_lo, why_lo = z[2], "diag_w4_w3start"
        if not overlap:     # senza sovrapposizione l'onda 4 in corso è ancora un impulso: la diagonale non è distinguibile
            return None
    if k >= 5:
        if contracting and not L[5] < L[3]:
            return None
        if not contracting and not L[5] > L[3]:
            return None
        if L[3] < L[1] and L[3] < L[5]:
            return None
        rules.append(_r("w3_shortest", L[3] / max(min(L[1], L[5]), 1e-12), 1.0))
        inv_hi, why_hi = z[5], "labeling"
    elif k == 4:
        inv_lo, why_lo = z[4], "labeling"
        if contracting:
            cap = z[4] + L[3]
            if not zpe < cap:
                return None
            inv_hi, why_hi = cap, "diag_contract"
    # posizione: finale se il movimento precedente andava già nella stessa direzione (inizio non estremo), iniziale altrimenti
    se = _start_extreme(inst, s, d)
    position = "leading" if (se is None or se["score"] >= 1.0) else "ending"
    guides = [_g("overlap", 1.0 if overlap else 0.0, (z4 - z[1]) / L[1], [0.0])]
    ratios = [L[3] / L[1]] + ([L[5] / L[3]] if k >= 5 else [])
    ideal = (0.618, 0.786) if contracting else (1.236, 1.618)
    guides.append(_g("diag_ratios", float(np.mean([near_ext(r, ideal) for r in ratios])), ratios, list(ideal)))
    guides.append(_g("w2_fib", near_ret(L[2] / L[1], (0.618, 0.786)), L[2] / L[1], [0.618, 0.786]))
    if k >= 4:
        guides.append(_g("w4_fib", near_ret(L[4] / L[3], (0.618, 0.786)), L[4] / L[3], [0.618, 0.786]))
    if k >= 5:
        guides.append(_g("truncation", 1.0 if z[5] > z[3] else 0.0, (z[5] - z[3]) / L[3], None))
        rsi = inst.S["rsi"]
        i = inst.P["i"]
        r3_, r5_ = rsi[i[s + 3]], rsi[i[s + 5]]
        if np.isfinite(r3_) and np.isfinite(r5_):
            guides.append(_g("divergence", 1.0 if ((r5_ < r3_) if d == 1 else (r5_ > r3_)) else 0.0, [float(r3_), float(r5_)], None))
    sb = _subs_score(inst, s, k, set(), any_ok=True)
    if sb:
        guides.append(sb)
    guides.append(_g("coverage", k / 5, k, [5]))
    if k == 3:
        tg = _zone("ret_w3", z[3], L[3], -1, (0.618, 0.786), (0.5, 0.886))
        if contracting:
            tg["zlo"] = max(tg["zlo"], z[3] - L[2])
        tg["zlo"] = max(tg["zlo"], z[2])
        w_cur, w_next = "4", "5"
        nxt = lambda zc: _zone("ext_w3", zc, L[3], 1, (0.618 if contracting else 1.236,), (0.618 if contracting else 1.236,))  # noqa: E731
    elif k == 4:
        rr = (0.618, 0.786) if contracting else (1.236, 1.618)
        tg = _zone("ext_w3", z[4], L[3], 1, rr, (0.5, 0.95) if contracting else (1.05, 1.618))
        if inv_hi is not None:
            tg["zhi"] = min(tg["zhi"], inv_hi)
        w_cur, w_next = "5", "A" if position == "ending" else "2"
        nxt = lambda zc: _zone("ret_diag", zc, zc - z[0], -1, (1.0 if position == "ending" else 0.618,), (1.0,))  # noqa: E731
    else:
        tot = z[5] - z[0]
        if position == "ending":   # rapido ritracciamento almeno fino all'inizio della diagonale
            tg = _zone("ret_diag", z[5], tot, -1, (1.0,), (0.618, 1.0))
            w_cur, w_next = "A", "B"
        else:                      # diagonale iniziale: segue un'onda 2 profonda
            tg = _zone("ret_diag", z[5], tot, -1, (0.618, 0.786), (0.5, 0.886))
            w_cur, w_next = "2", "3"
        nxt = lambda zc: _zone("ret_a", zc, z[5] - zc, 1, (0.5,), (0.5,))  # noqa: E731
    return {"rules": rules, "guides": guides, "inv_lo": inv_lo, "inv_hi": inv_hi, "why_lo": why_lo, "why_hi": why_hi,
            "target": tg, "next_fn": nxt, "w_cur": w_cur, "w_next": w_next, "variant": f"{variant}_{position}",
            "next_higher": k == 5, "cur_motive": k == 4}


def _flat_variant(b: float, c_reach: float) -> str | None:
    """Variante del flat: b = B/A, c_reach = quanto C supera la fine di A (in unità di A; < 0 = non la raggiunge).
    Soglie EWI: B ≥ 90% di A; espanso B > 105% e C oltre la fine di A; running B > 100% e C non oltre A; regolare
    B 90–105% e C circa alla fine di A (tolleranza 5% di A)."""
    if b < 0.9:
        return None
    if b > 1.05:
        return "expanded" if c_reach > 0 else "running"
    if b > 1.0 and c_reach <= 0:
        return "running"
    return "regular" if c_reach >= -0.05 else None


def eval_zigzag(inst: Inst, s: int, z: list, k: int, zpe: float, d: int, flat: bool) -> dict | None:
    L = [None] + [abs(z[j] - z[j - 1]) for j in range(1, k + 1)]
    rules, guides = [], []
    inv_lo = inv_hi = None
    why_lo = why_hi = None
    variant = None
    if k == 1:       # B in corso
        if not flat:
            if not zpe > z[0]:
                return None
            inv_lo, why_lo = z[0], "zz_b_start"
        else:        # flat: B può superare l'inizio di A (espanso); oltre 1.382×A il pattern non è più un flat tipico
            floor = z[1] - 1.382 * L[1]
            if not zpe > floor:
                return None
            inv_lo, why_lo = floor, "flat_b_max"
    if k >= 2:
        b = L[2] / L[1]
        if not flat:
            if not (z[2] > z[0] and b < 0.9):
                return None
            rules += [_r("zz_b_start", b, 1.0), _r("zz_b_lt_flat", b, 0.9)]
        else:
            if not (b >= 0.9 and b <= 1.382):
                return None
            rules.append(_r("flat_b_90", b, 0.9))
    if k == 2:       # C in corso
        inv_lo, why_lo = z[2], "labeling"
    if k >= 3:
        c_reach = (z[3] - z[1]) / L[1]
        if not flat:
            if not z[3] > z[1]:
                return None
            rules.append(_r("zz_c_beyond_a", c_reach, 0.0))
        else:
            variant = _flat_variant(L[2] / L[1], c_reach)
            if variant is None:
                return None
            rules.append(_r(f"flat_{variant}", c_reach, None))
        inv_hi, why_hi = z[3], "labeling"
    if k >= 2:
        b = L[2] / L[1]
        if not flat:
            guides.append(_g("b_fib", near_ret(b, (0.5, 0.618)), b, [0.5, 0.618]))
        else:
            ideal = (1.0,) if b <= 1.05 else (1.236, 1.382)
            guides.append(_g("flat_b", near_ret(b, ideal, 0.08), b, list(ideal)))
    if k >= 3:
        ca = L[3] / L[1]
        ideal = (1.0, 0.618, 1.618) if not flat else ((1.0, 1.236) if variant == "regular" else (1.618, 1.236) if variant == "expanded" else (0.618, 0.786))
        guides.append(_g("c_fib", near_ext(ca, ideal), ca, list(ideal)))
        tr = _time_ratio(inst, s, 3, 1)
        if tr is not None:
            guides.append(_g("time", near_ext(tr, (0.618, 1.0, 1.618), TOL_TIME), tr, [0.618, 1.0, 1.618]))
        if s >= 1:
            prior = abs(math.log(inst.P["p"][s]) - math.log(inst.P["p"][s - 1]))
            if prior > 0:
                dep = (z[3] - z[0]) / prior
                guides.append(_g("depth", near_ret(dep, (0.382, 0.5, 0.618), 0.1), dep, [0.382, 0.5, 0.618]))
    sb = _subs_score(inst, s, k, MOTIVE_LEGS["flat" if flat else "zigzag"])
    if sb:
        guides.append(sb)
    se = _start_extreme(inst, s, d)
    if se:
        guides.append(se)
    guides.append(_g("coverage", k / 3, k, [3]))
    if k == 1:
        if not flat:
            tg = _zone("ret_a", z[1], L[1], -1, (0.5, 0.618), (0.382, 0.786))
        else:
            tg = _zone("ret_a", z[1], L[1], -1, (1.0, 1.236), (0.9, 1.382))
        w_cur, w_next = "B", "C"
        nxt = lambda zc: _zone("ext_a", zc, L[1], 1, (1.0,) if not flat else (1.236,), (1.0,))  # noqa: E731
    elif k == 2:
        if not flat:
            tg = _zone("ext_a", z[2], L[1], 1, (1.0,), (0.618, 1.618))
            tg["zlo"] = max(tg["zlo"], z[1])
        else:
            b = L[2] / L[1]
            if b > 1.05:
                tg = _zone("ext_a", z[2], L[1], 1, (1.618,), (1.236, 2.0))
                tg["zlo"] = max(tg["zlo"], z[1])
            else:
                tg = _zone("ext_a", z[2], L[1], 1, (1.0,), (0.95, 1.236))
        w_cur, w_next = "C", "next"
        nxt = lambda zc: _zone("ret_corr", zc, zc - z[0], -1, (1.0,), (1.0,))  # noqa: E731
    else:
        tot = z[3] - z[0]
        tg = _zone("ret_corr", z[3], tot, -1, (1.0,), (0.618, 1.382))
        w_cur, w_next = "next", "next2"
        nxt = lambda zc: _zone("ret_corr", zc, z[3] - zc, 1, (0.5,), (0.5,))  # noqa: E731
    return {"rules": rules, "guides": guides, "inv_lo": inv_lo, "inv_hi": inv_hi, "why_lo": why_lo, "why_hi": why_hi,
            "target": tg, "next_fn": nxt, "w_cur": w_cur, "w_next": w_next, "variant": variant,
            "next_higher": k == 3, "cur_motive": k == 2 or k == 3}


def eval_triangle(inst: Inst, s: int, z: list, k: int, zpe: float, d: int, expanding: bool) -> dict | None:
    """Triangolo A-B-C-D-E: solo in posizione 4/B/X → deve seguire un movimento più ampio dell'onda A."""
    if k < 2 or s < 1:
        return None
    P = inst.P
    L = [None] + [abs(z[j] - z[j - 1]) for j in range(1, k + 1)]
    prior = abs(math.log(P["p"][s]) - math.log(P["p"][s - 1]))
    if not prior > L[1]:
        return None
    rules = [_r("tri_position", prior / L[1], 1.0)]
    # z: A su, B giù, C su, D giù, E su
    pairs = [(3, 1), (4, 2), (5, 3)]   # C vs fine A, D vs fine B, E vs fine C
    for (j, ref) in pairs:
        if j > k:
            break
        up = j % 2 == 1
        if not expanding:
            ok = (z[j] < z[ref]) if up else (z[j] > z[ref])
        else:
            ok = (z[j] > z[ref]) if up else (z[j] < z[ref])
        if not ok:
            return None
        rules.append(_r(f"tri_{'cde'[j - 3]}", (z[j] - z[ref]) / L[1], 0.0))
    if not expanding and not z[2] > z[1] - 1.5 * L[1]:
        return None
    # onda in corso: tetto della contrazione e rottura dell'etichettatura
    inv_lo = inv_hi = None
    why_lo = why_hi = None
    j = k + 1
    if k < 5:
        up = j % 2 == 1
        ref = j - 2
        if not expanding and ref >= 1:
            if up:
                if not zpe < z[ref]:
                    return None
                inv_hi, why_hi = z[ref], f"tri_{'cde'[j - 3]}"
            else:
                if not zpe > z[ref]:
                    return None
                inv_lo, why_lo = z[ref], f"tri_{'cde'[j - 3]}"
        if up:
            inv_lo, why_lo = z[k], "labeling"
        else:
            inv_hi, why_hi = z[k], "labeling"
    else:   # triangolo completo: la spinta va contro A; se il prezzo torna oltre la fine di E il triangolo non era finito
        inv_hi, why_hi = z[5], "labeling"
    ratios = [L[j_] / L[j_ - 1] for j_ in range(2, k + 1)]
    ideal = (0.618, 0.786) if not expanding else (1.236, 1.618)
    guides = [_g("tri_legs", float(np.mean([near_ext(r, ideal) for r in ratios])), ratios, list(ideal))]
    variant = "expanding" if expanding else "contracting"
    if not expanding and k >= 4:
        flat_bd = abs(z[4] - z[2]) / L[1]
        if flat_bd <= 0.05:
            variant = "barrier"
        guides.append(_g("barrier", 1.0 if flat_bd <= 0.05 else 0.5, flat_bd, [0.0]))
    sb = _subs_score(inst, s, k, set(), any_ok=True)
    if sb:
        guides.append(sb)
    guides.append(_g("coverage", k / 5, k, [5]))
    if k < 5:
        up = j % 2 == 1
        sign = 1 if up else -1
        ideal_r = (0.618, 0.786) if not expanding else (1.236,)
        rng = (0.5, 0.95) if not expanding else (1.05, 1.618)
        tg = _zone("tri_leg", z[k], L[k], sign, ideal_r, rng)
        if inv_hi is not None and up:
            tg["zhi"] = min(tg["zhi"], inv_hi)
        if inv_lo is not None and not up:
            tg["zlo"] = max(tg["zlo"], inv_lo)
        w_cur = "ABCDE"[j - 1]
        w_next = "ABCDE"[j] if j < 5 else "thrust"
        nxt = lambda zc: _zone("tri_leg", zc, abs(zc - z[k]), -sign, ideal_r, ideal_r)  # noqa: E731
    else:
        width = L[1] if not expanding else L[5]
        tg = _zone("tri_thrust", z[5], width, -1, (1.0,), (0.75, 1.25))
        w_cur, w_next = "thrust", "next2"
        nxt = lambda zc: _zone("ret_corr", zc, z[5] - zc, 1, (0.382,), (0.382,))  # noqa: E731
    return {"rules": rules, "guides": guides, "inv_lo": inv_lo, "inv_hi": inv_hi, "why_lo": why_lo, "why_hi": why_hi,
            "target": tg, "next_fn": nxt, "w_cur": w_cur, "w_next": w_next, "variant": variant,
            "next_higher": k == 5, "cur_motive": k == 5}


def _abc_type(z0: float, z1: float, z2: float, z3: float | None) -> str | None:
    """Tipo di una correzione in 3 gambe (in z, prima gamba su): zigzag, flat o None (non valida)."""
    a = z1 - z0
    if a <= 0:
        return None
    b = (z1 - z2) / a
    if z3 is None:
        return "zigzag" if b < 0.9 and z2 > z0 else "flat" if 0.9 <= b <= 1.382 else None
    reach = (z3 - z1) / a
    if b < 0.9:
        return "zigzag" if (z2 > z0 and z3 > z1) else None
    return "flat" if _flat_variant(b, reach) else None


def eval_double(inst: Inst, s: int, z: list, k: int, zpe: float, d: int, zz: bool) -> dict | None:
    """Doppio zigzag (W, Y zigzag; Y oltre la fine di W) o doppia three (al più uno zigzag, almeno un flat). X < 100% di W."""
    if k < 3:
        return None
    L = [None] + [abs(z[j] - z[j - 1]) for j in range(1, k + 1)]
    tw = _abc_type(z[0], z[1], z[2], z[3])
    if tw is None:
        return None
    if zz and tw != "zigzag":
        return None
    rules = [_r("dz_w_valid", L[2] / L[1], None)]
    inv_lo = inv_hi = None
    why_lo = why_hi = None
    W = z[3] - z[0]
    if k >= 4:
        if not z[4] > z[0]:
            return None
        rules.append(_r("dz_x_start", (z[3] - z[4]) / W, 1.0))
    else:
        if not zpe > z[0]:
            return None
        inv_lo, why_lo = z[0], "dz_x_start"
    if k == 4:
        inv_lo, why_lo = z[4], "labeling"
    if k == 5:
        if not zpe > z[4]:
            return None
        inv_lo, why_lo = z[4], "zz_b_start"
    if k >= 6:
        if not z[6] > z[4]:
            return None
        if k == 6:
            inv_lo, why_lo = z[6], "labeling"
    if k >= 7:
        ty = _abc_type(z[4], z[5], z[6], z[7])
        if ty is None:
            return None
        if zz and (ty != "zigzag" or not z[7] > z[3]):
            return None
        if not zz and tw == "zigzag" and ty == "zigzag":
            return None
        rules.append(_r("dz_y_valid", L[6] / L[5], None))
        if zz:
            rules.append(_r("dz_y_beyond_w", (z[7] - z[3]) / W, 0.0))
        inv_hi, why_hi = z[7], "labeling"
    elif zz and k == 6:
        ty = _abc_type(z[4], z[5], z[6], None)
        if ty != "zigzag":
            return None
    guides = []
    if k >= 4:
        x = (z[3] - z[4]) / W
        guides.append(_g("x_fib", near_ret(x, (0.5, 0.618), 0.1), x, [0.5, 0.618]))
    if k >= 7:
        yw = (z[7] - z[4]) / W
        guides.append(_g("y_eq_w", near_ext(yw, (1.0, 0.618, 1.618)), yw, [1.0, 0.618, 1.618]))
    sb = _subs_score(inst, s, k, MOTIVE_LEGS["double_zigzag"] if zz else set(), any_ok=not zz)
    if sb:
        guides.append(sb)
    se = _start_extreme(inst, s, d)
    if se:
        guides.append(se)
    guides.append(_g("coverage", k / 7, k, [7]))
    labels = DOUBLE_WAVE
    if k == 3:
        tg = _zone("ret_w", z[3], W, -1, (0.5, 0.618), (0.382, 0.786))
        tg["zlo"] = max(tg["zlo"], z[0])
        nxt = lambda zc: _zone("ext_wa", zc, L[1], 1, (1.0,), (1.0,))  # noqa: E731
    elif k == 4:
        tg = _zone("ext_wa", z[4], L[1], 1, (1.0,), (0.618, 1.618))
        nxt = lambda zc: _zone("ret_a", zc, zc - z[4], -1, (0.5,), (0.5,))  # noqa: E731
    elif k == 5:
        tg = _zone("ret_a", z[5], L[5], -1, (0.5, 0.618), (0.382, 0.786))
        tg["zlo"] = max(tg["zlo"], z[4])
        nxt = lambda zc: _zone("ext_a", zc, L[5], 1, (1.0,), (1.0,))  # noqa: E731
    elif k == 6:
        extra = [{"key": "y_eq_w", "ratio": 1.0, "z": z[4] + W, "main": True}]
        tg = _zone("ext_a", z[6], L[5], 1, (1.0,), (0.618, 1.618), extra=extra)
        if zz:
            tg["zlo"] = max(tg["zlo"], z[5])
        nxt = lambda zc: _zone("ret_corr", zc, zc - z[0], -1, (1.0,), (1.0,))  # noqa: E731
    else:
        tot = z[7] - z[0]
        tg = _zone("ret_corr", z[7], tot, -1, (1.0,), (0.618, 1.382))
        nxt = lambda zc: _zone("ret_corr", zc, z[7] - zc, 1, (0.5,), (0.5,))  # noqa: E731
    w_cur = labels[k] if k < 7 else "next"
    w_next = labels[k + 1] if k < 6 else "next" if k == 6 else "next2"
    return {"rules": rules, "guides": guides, "inv_lo": inv_lo, "inv_hi": inv_hi, "why_lo": why_lo, "why_hi": why_hi,
            "target": tg, "next_fn": nxt, "w_cur": w_cur, "w_next": w_next, "variant": None,
            "next_higher": k == 7, "cur_motive": k in (4, 6, 7)}


# (pattern, variante-flag, gambe totali, stati k ammessi)
TEMPLATES = [
    ("impulse", None, 5, (1, 2, 3, 4, 5)),
    ("diagonal", None, 5, (3, 4, 5)),
    ("zigzag", False, 3, (1, 2, 3)),
    ("flat", True, 3, (1, 2, 3)),
    ("triangle", False, 5, (2, 3, 4, 5)),
    ("triangle", True, 5, (2, 3, 4, 5)),
    ("double_zigzag", True, 7, (3, 4, 5, 6, 7)),
    ("double_three", False, 7, (3, 4, 5, 6, 7)),
]


def _evaluate(inst: Inst, pattern: str, flag, s: int, z: list, k: int, zpe: float, d: int) -> dict | None:
    if pattern == "impulse":
        return eval_impulse(inst, s, z, k, zpe, d)
    if pattern == "diagonal":
        return eval_diagonal(inst, s, z, k, zpe, d)
    if pattern in ("zigzag", "flat"):
        return eval_zigzag(inst, s, z, k, zpe, d, flat=bool(flag))
    if pattern == "triangle":
        return eval_triangle(inst, s, z, k, zpe, d, expanding=bool(flag))
    return eval_double(inst, s, z, k, zpe, d, zz=bool(flag))


def score_of(guides: list[dict]) -> float:
    w = sum(g["weight"] for g in guides)
    return float(100 * sum(g["weight"] * g["score"] for g in guides) / w) if w > 0 else 0.0


def candidates(inst: Inst) -> list[dict]:
    """Tutti i conteggi validi (regole rispettate) che terminano sull'ultimo pivot confermato m, ordinati per punteggio."""
    P, m = inst.P, inst.m
    lp = np.log(P["p"])
    out: list[dict] = []
    for pattern, flag, L, ks in TEMPLATES:
        for k in ks:
            s = m - k
            if s < 0:
                continue
            d = 1 if P["p"][s + 1] > P["p"][s] else -1
            z = [d * lp[s + j] for j in range(k + 1)]
            zpe = d * math.log(inst.pend_p)
            ev = _evaluate(inst, pattern, flag, s, z, k, zpe, d)
            if ev is None:
                continue
            # direzione attesa dell'onda in corso (in prezzo) e stato dell'obiettivo rispetto all'estremo raggiunto
            dirp = d * (1 if (k + 1) % 2 == 1 else -1)
            tg = ev["target"]
            sgn = 1 if (k + 1) % 2 == 1 else -1                     # verso della gamba in corso in z
            zlo, zhi = float(tg["zlo"]), float(tg["zhi"])
            if zlo > zhi:
                zhi = zlo
            zc = min(max(float(tg["zc"]), zlo), zhi)
            reached = False
            if sgn == 1:
                if zpe >= zhi:
                    zlo = zhi = zc = zpe
                    reached = True
                else:
                    zlo, zc = max(zlo, zpe), max(zc, zpe)
            else:
                if zpe <= zlo:
                    zlo = zhi = zc = zpe
                    reached = True
                else:
                    zhi, zc = min(zhi, zpe), min(zc, zpe)
            exp_dir = int(np.sign(d * (zc - d * math.log(inst.close)))) if not reached else 0
            coh = _coherence(inst, exp_dir if exp_dir else dirp)
            guides = ev["guides"] + ([coh] if coh else [])
            cand = {
                "pattern": pattern, "variant": ev["variant"], "k": k, "L": L, "s": s, "d": d, "dirp": dirp,
                "state": "complete" if k == L else "progress", "rules": ev["rules"], "guides": guides,
                "score": score_of(guides), "w_cur": ev["w_cur"], "w_next": ev["w_next"], "next_higher": ev["next_higher"],
                "cur_motive": ev["cur_motive"],
                "tz": {"zc": zc, "zlo": zlo, "zhi": zhi, "levels": tg["levels"], "reached": bool(reached)},
                "inv_z": (ev["inv_lo"], ev["why_lo"], ev["inv_hi"], ev["why_hi"]),
                "next_fn": ev["next_fn"], "z": z, "zpe": zpe,
            }
            out.append(cand)
    out.sort(key=lambda c: -c["score"])
    return out


# ------------------------------------------------------------------ prezzi
def zp(c: dict, zv: float | None) -> float | None:
    """Da z (= d·log prezzo) a prezzo."""
    return None if zv is None else float(math.exp(c["d"] * zv))


def price_view(c: dict) -> dict:
    """Obiettivo e invalidazione in prezzo (sotto/sopra)."""
    lo_z, why_lo, hi_z, why_hi = c["inv_z"]
    inv = {"below": None, "below_rule": None, "above": None, "above_rule": None}
    # z basso = prezzo basso se d=+1, prezzo alto se d=-1
    for zv, why, low_side in ((lo_z, why_lo, True), (hi_z, why_hi, False)):
        if zv is None:
            continue
        side = ("below" if low_side else "above") if c["d"] == 1 else ("above" if low_side else "below")
        inv[side] = zp(c, zv)
        inv[f"{side}_rule"] = why
    t = c["tz"]
    a, b = zp(c, t["zlo"]), zp(c, t["zhi"])
    return {"inv": inv, "target": {"price": zp(c, t["zc"]), "lo": min(a, b), "hi": max(a, b), "reached": t["reached"]}}


# ================================================================== istante → candidati con prezzi

def evaluate_instant(S: dict, P: dict, m: int, T: int, mult: float, sub_cache: dict, hi_dir: int | None) -> tuple[Inst, list[dict]]:
    inst = Inst(S, P, m, T, mult, sub_cache, hi_dir)
    cs = candidates(inst)
    for c in cs:
        c.update(price_view(c))
    return inst, cs


def preferred_dir(cs: list[dict], close: float) -> int | None:
    """Direzione attesa del conteggio preferito (verso il centro dell'obiettivo dell'onda in corso)."""
    if not cs:
        return None
    c = cs[0]
    tp = c["target"]["price"]
    if tp is None or abs(tp / close - 1) < 1e-9:
        return int(c["dirp"])
    return 1 if tp > close else -1


# ================================================================== percorso proiettato

def path_lp(points: list[tuple[float, float]], x: float) -> float:
    """Log-prezzo del percorso spezzato [(bar, log prezzo)…] alla candela x (piatto dopo l'ultimo punto)."""
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points[:-1], points[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / max(1e-9, x1 - x0)
    return points[-1][1]


def cand_path(inst: "Inst", c: dict) -> list[tuple[float, float]]:
    """Percorso del conteggio: ora → fine dell'onda in corso (centro obiettivo, durata stimata) → fine dell'onda successiva."""
    dur = _dur_est(inst, c)
    i_m = float(inst.P["i"][inst.m])
    t1 = max(i_m + dur, inst.T + 1.0)
    zc = c["tz"]["zc"]
    nx = c["next_fn"](zc)
    zn = nx["zc"] if nx is not None else zc
    return [(float(inst.T), math.log(inst.close)), (t1, c["d"] * zc), (t1 + dur, c["d"] * zn)]


# ================================================================== backtest walk-forward

FEATS = ["score", "k_frac", "complete", "reached", "n_guides"] + [f"g_{k}" for k in WEIGHTS] + [f"p_{p}" for p in PATTERNS]


def _features(c: dict) -> np.ndarray:
    g = {x["key"]: x["score"] for x in c["guides"]}
    v = [c["score"] / 100, c["k"] / c["L"], float(c["state"] == "complete"), float(c["tz"]["reached"]), len(c["guides"]) / 10]
    v += [g.get(k, 0.5) for k in WEIGHTS]
    v += [float(c["pattern"] == p) for p in PATTERNS]
    return np.array(v, dtype=float)


def _hi_dirs(S: dict, tf: str, degree: str) -> tuple[np.ndarray, np.ndarray] | None:
    """Direzione attesa del conteggio preferito di grado superiore a ogni sua conferma di pivot (point-in-time)."""
    degs = [g for g, _ in TF_DEGREES[tf]]
    j = degs.index(degree)
    if j == 0:
        return None
    mult_hi = TF_DEGREES[tf][j - 1][1]
    Ph = pivots(S, mult_hi)
    times, dirs = [], []
    cache: dict = {}
    for m in range(2, len(Ph["p"])):
        T = int(Ph["ci"][m])
        _, cs = evaluate_instant(S, Ph, m, T, mult_hi, cache, None)
        dd = preferred_dir(cs, float(S["close"][T]))
        if dd is not None:
            times.append(T)
            dirs.append(dd)
    return np.array(times, dtype=np.int64), np.array(dirs, dtype=np.int64)


def _hi_at(hd, T: int) -> int | None:
    if hd is None or not len(hd[0]):
        return None
    k = np.searchsorted(hd[0], T, side="right") - 1
    return int(hd[1][k]) if k >= 0 else None


def _first_touch(S: dict, T: int, end: int, c: dict) -> str:
    """Dal bar T+1 a end: «target» se la zona obiettivo è toccata prima dell'invalidazione, «invalid» viceversa, «none»."""
    h, l = S["high"][T + 1:end + 1], S["low"][T + 1:end + 1]
    tgt = c["target"]
    up = c["dirp"] == 1
    if c["tz"]["reached"]:
        return "reached"
    hit_t = np.nonzero(h >= tgt["lo"])[0] if up else np.nonzero(l <= tgt["hi"])[0]
    inv = c["inv"]
    hits = []
    if inv["below"] is not None:
        hits.append(np.nonzero(l < inv["below"])[0])
    if inv["above"] is not None:
        hits.append(np.nonzero(h > inv["above"])[0])
    t_t = int(hit_t[0]) if len(hit_t) else 10 ** 9
    t_i = min([int(x[0]) for x in hits if len(x)] or [10 ** 9])
    if t_t == t_i == 10 ** 9:
        return "none"
    if t_t == t_i:       # stessa candela: ordine ignoto → conservativo
        return "invalid"
    return "target" if t_t < t_i else "invalid"


def _crossed(S: dict, T: int, end: int, c: dict) -> bool:
    inv = c["inv"]
    if end <= T:
        return False
    h, l = S["high"][T + 1:end + 1], S["low"][T + 1:end + 1]
    if inv["below"] is not None and np.any(l < inv["below"]):
        return True
    if inv["above"] is not None and np.any(h > inv["above"]):
        return True
    return False


def _wilson(k: int, n: int, z: float = 1.96) -> tuple[float | None, float | None]:
    if n <= 0:
        return None, None
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return 100 * max(0.0, c - h), 100 * min(1.0, c + h)


def _sign_p(better: np.ndarray, worse: np.ndarray) -> float | None:
    """Test del segno unilaterale (McNemar esatto): P(≥ b successi su b+w discordanti | p=½)."""
    b, w = int(np.sum(better & ~worse)), int(np.sum(worse & ~better))
    n = b + w
    if n < 5:
        return None
    from math import comb
    return float(sum(comb(n, i) for i in range(b, n + 1)) / 2 ** n)


def _boot_ci(x: np.ndarray, rng, B: int = 1000) -> tuple[float, float] | None:
    if len(x) < 10:
        return None
    idx = rng.integers(0, len(x), size=(B, len(x)))
    m = x[idx].mean(axis=1)
    return float(np.quantile(m, 0.025) * 100), float(np.quantile(m, 0.975) * 100)


def backtest(S: dict, tf: str, degree: str, rows_out: list | None = None, seed: int = 11) -> dict:
    """A ogni conferma di un pivot m (istante T = ci[m]) si contano le onde con i soli dati noti e si confronta con l'esito."""
    mult = dict(TF_DEGREES[tf])[degree]
    P = pivots(S, mult)
    hd = _hi_dirs(S, tf, degree)
    mp = len(P["p"])
    rng = np.random.default_rng(seed)
    cache: dict = {}
    inst_rows = []       # per istante: candidati (features, esiti) + baseline
    for m in range(4, mp - 2):
        T = int(P["ci"][m])
        inst, cs = evaluate_instant(S, P, m, T, mult, cache, _hi_at(hd, T))
        if not cs:
            continue
        lp = np.log(P["p"][:m + 1])
        amps = np.abs(np.diff(lp))
        durs = np.diff(P["i"][:m + 1]).astype(float)
        hz = int(max(1, round(float(np.median(durs)))))
        end_h = min(S["n"] - 1, T + hz)
        if T + hz > S["n"] - 1:
            continue
        nxt_p = float(P["p"][m + 1])
        i_end = int(P["i"][m + 1])
        end_w = int(P["ci"][m + 2])         # finestra per «obiettivo prima dell'invalidazione»
        close_T = float(S["close"][T])
        act_dir = int(np.sign(S["close"][end_h] - close_T))
        rec = []
        x_h = float(T + hz)
        lp0 = math.log(close_T)
        for c in cs:
            tg = c["target"]
            dl = path_lp(cand_path(inst, c), x_h) - lp0
            pd_ = 1 if dl > 0 else -1 if dl < 0 else int(c["dirp"])
            inside = tg["lo"] <= nxt_p <= tg["hi"]
            crossed = _crossed(S, T, i_end, c)
            rec.append({
                "f": _features(c), "score": c["score"], "dir": pd_, "err": abs(math.log(nxt_p / tg["price"])),
                "conf": bool(inside and not crossed), "touch": _first_touch(S, T, end_w, c), "inside": bool(inside),
                "pattern": c["pattern"], "w_cur": c["w_cur"], "k": c["k"], "variant": c["variant"],
                "target": tg, "inv": c["inv"], "dirp": c["dirp"],
            })
        conf_idx = [j for j, r in enumerate(rec) if r["conf"]]
        best = min(conf_idx, key=lambda j: (rec[j]["err"], j)) if conf_idx else None
        # baseline 1: alternanza con ampiezza mediana dalla fine del pivot m (vincolata all'estremo già raggiunto)
        kind_next = -int(P["k"][m])
        med = float(np.median(amps))
        b_tp = float(P["p"][m] * math.exp(kind_next * med))
        if (kind_next == 1 and inst.pend_p > b_tp) or (kind_next == -1 and inst.pend_p < b_tp):
            b_tp = inst.pend_p
        md = float(np.median(durs))
        t1 = max(float(P["i"][m]) + md, T + 1.0)
        b_path = [(float(T), lp0), (t1, math.log(b_tp)), (t1 + md, math.log(b_tp) - kind_next * med)]
        dl = path_lp(b_path, x_h) - lp0
        b_dir = 1 if dl > 0 else -1 if dl < 0 else kind_next
        inst_rows.append({"m": m, "T": T, "rec": rec, "best": best, "act_dir": act_dir, "b_dir": b_dir,
                          "b_err": abs(math.log(nxt_p / b_tp)), "close": close_T, "nxt": nxt_p, "i_next": i_end,
                          "known": int(P["ci"][m + 1]), "time": int(S["time"][T]), "hz": hz})
    out = _bt_summary(inst_rows, rng, S, tf)
    if rows_out is not None:
        rows_out.extend(inst_rows)
    return out


def _rank_rule(rec: list[dict]) -> list[int]:
    return list(range(len(rec)))       # già ordinati per punteggio


def _ml_walkforward(rows: list[dict]) -> tuple[list[list[int] | None], dict | None]:
    """Ranker a regressione logistica: a ogni istante addestrato SOLO sugli istanti con esito già noto (ci[m+1] ≤ T)."""
    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.preprocessing import StandardScaler
    except Exception:  # noqa: BLE001
        return [None] * len(rows), None
    orders: list[list[int] | None] = [None] * len(rows)
    model = scaler = None
    last_fit = -10 ** 9
    for j, r in enumerate(rows):
        T = r["T"]
        if model is None or j - last_fit >= ML_EVERY:
            tr = [q for q in rows[:j] if q["known"] <= T]
            if len(tr) >= ML_MIN_TRAIN:
                X = np.vstack([x["f"] for q in tr for x in q["rec"]])
                y = np.array([int(q["best"] == i) for q in tr for i in range(len(q["rec"]))])
                if 0 < y.sum() < len(y):
                    scaler = StandardScaler().fit(X)
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        model = LogisticRegression(C=0.5, max_iter=400).fit(scaler.transform(X), y)
                    last_fit = j
        if model is not None:
            pr = model.predict_proba(scaler.transform(np.vstack([x["f"] for x in r["rec"]])))[:, 1]
            orders[j] = list(np.argsort(-pr, kind="stable"))
    final = None
    tr = [q for q in rows]
    if len(tr) >= ML_MIN_TRAIN:
        X = np.vstack([x["f"] for q in tr for x in q["rec"]])
        y = np.array([int(q["best"] == i) for q in tr for i in range(len(q["rec"]))])
        if 0 < y.sum() < len(y):
            sc = StandardScaler().fit(X)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                mdl = LogisticRegression(C=0.5, max_iter=400).fit(sc.transform(X), y)
            final = {"mean": sc.mean_.tolist(), "scale": sc.scale_.tolist(), "coef": mdl.coef_[0].tolist(), "intercept": float(mdl.intercept_[0])}
    return orders, final


def _rank_stats(rows: list[dict], orders: list[list[int]]) -> dict:
    """Per rango 1..4: frequenza «giusto a posteriori» (esclusiva) e «confermato» (zona obiettivo, nessuna invalidazione)."""
    out = []
    n = len(rows)
    for r in range(4):
        best = sum(1 for q, o in zip(rows, orders) if len(o) > r and q["best"] == o[r])
        conf = [q["rec"][o[r]]["conf"] for q, o in zip(rows, orders) if len(o) > r]
        lo, hi = _wilson(best, n)
        out.append({"rank": r + 1, "p_best": 100 * best / n if n else None, "lo": lo, "hi": hi, "n": n,
                    "p_conf": 100 * float(np.mean(conf)) if conf else None, "n_conf": len(conf)})
    none = sum(1 for q in rows if q["best"] is None)
    return {"ranks": out, "none": 100 * none / n if n else None}


def _bt_summary(rows: list[dict], rng, S: dict, tf: str) -> dict:
    n = len(rows)
    if n == 0:
        return {"n": 0, "verdict": "anecdotal"}
    orders_rule = [_rank_rule(q["rec"]) for q in rows]
    orders_ml, ml_final = _ml_walkforward(rows)
    # ---- confronto fuori campione ML vs regole (stessi istanti)
    oos = [j for j, o in enumerate(orders_ml) if o is not None]
    ml = None
    adopted = False
    if len(oos) >= 30:
        rb = np.array([rows[j]["best"] == orders_rule[j][0] for j in oos])
        mb = np.array([rows[j]["best"] == orders_ml[j][0] for j in oos])
        re_ = np.array([rows[j]["rec"][orders_rule[j][0]]["err"] for j in oos])
        me_ = np.array([rows[j]["rec"][orders_ml[j][0]]["err"] for j in oos])
        p = _sign_p(mb, rb)
        adopted = bool(mb.mean() > rb.mean() and p is not None and p < 0.10 and np.median(me_) <= np.median(re_))
        ml = {"n_oos": len(oos), "rule_best": float(rb.mean() * 100), "ml_best": float(mb.mean() * 100),
              "rule_err_med": float(np.expm1(np.median(re_)) * 100), "ml_err_med": float(np.expm1(np.median(me_)) * 100),
              "p": p, "adopted": adopted, "from": rows[oos[0]]["time"]}
    if adopted:
        use = oos
        orders = [orders_ml[j] for j in oos]
    else:
        use = list(range(n))
        orders = orders_rule
    R = [rows[j] for j in use]
    nn = len(R)
    top = [q["rec"][o[0]] for q, o in zip(R, orders)]
    act = np.array([q["act_dir"] for q in R])
    hit = np.array([t["dir"] == a for t, a in zip(top, act)])
    b_hit = np.array([q["b_dir"] == q["act_dir"] for q in R])
    err = np.array([t["err"] for t in top])
    b_err = np.array([q["b_err"] for q in R])
    cov = np.array([t["inside"] for t in top])
    touch = [t["touch"] for t in top]
    t_hit = np.array([x in ("target", "reached") for x in touch])
    t_inv = np.array([x == "invalid" for x in touch])
    # baseline casuale: conteggio valido scelto a caso (N_RANDOM estrazioni)
    sizes = np.array([len(q["rec"]) for q in R])
    pick = (rng.random((N_RANDOM, nn)) * sizes[None, :]).astype(int)
    r_hit = np.zeros(N_RANDOM)
    r_err = np.zeros(N_RANDOM)
    r_th = np.zeros(N_RANDOM)
    r_best = np.zeros(N_RANDOM)
    for b in range(N_RANDOM):
        hs, es, ts, bs = [], [], [], []
        for q, j in zip(R, pick[b]):
            x = q["rec"][j]
            hs.append(x["dir"] == q["act_dir"])
            es.append(x["err"])
            ts.append(x["touch"] in ("target", "reached"))
            bs.append(q["best"] == j)
        r_hit[b], r_err[b], r_th[b], r_best[b] = np.mean(hs), np.mean(es), np.mean(ts), np.mean(bs)
    p_hit_rand = float((1 + np.sum(r_hit >= hit.mean())) / (1 + N_RANDOM))
    p_err_rand = float((1 + np.sum(r_err <= err.mean())) / (1 + N_RANDOM))
    p_th_rand = float((1 + np.sum(r_th >= t_hit.mean())) / (1 + N_RANDOM))
    p_best_rand = float((1 + np.sum(r_best >= np.mean([q["best"] == o[0] for q, o in zip(R, orders)]))) / (1 + N_RANDOM))
    p_hit_alt = _sign_p(hit, b_hit)
    p_err_alt = _sign_p(err < b_err, err > b_err)
    pct = lambda x: float(np.expm1(x) * 100)  # noqa: E731
    mase = float(err.mean() / b_err.mean()) if b_err.mean() > 0 else None
    mase_r = float(err.mean() / r_err.mean()) if r_err.mean() > 0 else None
    halves = []
    for sl in (slice(0, nn // 2), slice(nn // 2, nn)):
        if sl.stop - sl.start < 5:
            continue
        halves.append({"from": R[sl.start]["time"], "to": R[sl.stop - 1]["time"], "n": sl.stop - sl.start,
                       "hit": float(hit[sl].mean() * 100), "base_hit": float(b_hit[sl].mean() * 100),
                       "mase": float(err[sl].mean() / b_err[sl].mean()) if b_err[sl].mean() > 0 else None})
    if nn < 30:
        verdict = "anecdotal"
    else:
        better = hit.mean() > max(b_hit.mean(), r_hit.mean()) and (mase is not None and mase < 1) and (mase_r is not None and mase_r < 1)
        sig = p_hit_rand < 0.05 and (p_hit_alt is not None and p_hit_alt < 0.05)
        stable = all(h["hit"] > h["base_hit"] for h in halves) if halves else False
        if better and sig and stable:
            verdict = "strong"
        elif (hit.mean() > max(b_hit.mean(), r_hit.mean()) or (mase is not None and mase < 1 and mase_r is not None and mase_r < 1)) and \
                (p_hit_rand < 0.10 or (p_hit_alt is not None and p_hit_alt < 0.10) or p_err_rand < 0.10):
            verdict = "weak"
        else:
            verdict = "none"
    ranks = _rank_stats(R, orders)
    best1 = np.array([q["best"] == o[0] for q, o in zip(R, orders)])
    rb_halves = [float(best1[sl].mean() * 100) for sl in (slice(0, nn // 2), slice(nn // 2, nn)) if sl.stop - sl.start >= 5]
    if nn < 30:
        rank_verdict = "anecdotal"
    elif p_best_rand < 0.05 and all(x > r_best.mean() * 100 for x in rb_halves):
        rank_verdict = "strong"
    elif best1.mean() > r_best.mean() and p_best_rand < 0.10:
        rank_verdict = "weak"
    else:
        rank_verdict = "none"
    rnd_best = float(r_best.mean() * 100)
    # per pattern dell'onda in corso del preferito
    by_pat: dict[str, dict] = {}
    for t, h_, e_ in zip(top, hit, err):
        x = by_pat.setdefault(t["pattern"], {"n": 0, "hit": 0, "err": []})
        x["n"] += 1
        x["hit"] += int(h_)
        x["err"].append(e_)
    by_pattern = [{"pattern": k, "n": v["n"], "hit": 100 * v["hit"] / v["n"], "err_med": pct(float(np.median(v["err"])))}
                  for k, v in sorted(by_pat.items(), key=lambda kv: -kv[1]["n"])]
    examples = []
    for q, o in list(zip(R, orders))[-40:]:
        t = q["rec"][o[0]]
        examples.append({"time": q["time"], "pattern": t["pattern"], "variant": t["variant"], "wave": t["w_cur"], "k": t["k"],
                         "dir": t["dir"], "target": t["target"]["price"], "lo": t["target"]["lo"], "hi": t["target"]["hi"],
                         "inv_below": t["inv"]["below"], "inv_above": t["inv"]["above"], "outcome": t["touch"],
                         "inside": t["inside"], "actual": q["nxt"], "actual_time": int(S["time"][q["i_next"]]),
                         "hit": bool(t["dir"] == q["act_dir"]), "best": bool(q["best"] == o[0]), "err": pct(t["err"]),
                         "n_cand": len(q["rec"])})
    rng2 = np.random.default_rng(5)
    return {
        "n": nn, "from": R[0]["time"], "to": R[-1]["time"], "ranker": "ml" if adopted else "rule",
        "model": {"hit": float(hit.mean() * 100), "hit_ci": _boot_ci(hit.astype(float), rng2), "err_med": pct(float(np.median(err))),
                  "cov": float(cov.mean() * 100), "target_first": float(t_hit.mean() * 100), "invalid_first": float(t_inv.mean() * 100),
                  "best": float(np.mean([q["best"] == o[0] for q, o in zip(R, orders)]) * 100)},
        "base_alt": {"hit": float(b_hit.mean() * 100), "err_med": pct(float(np.median(b_err)))},
        "base_random": {"hit": float(r_hit.mean() * 100), "err_med": pct(float(np.median(r_err))), "target_first": float(r_th.mean() * 100),
                        "best": rnd_best, "hit_q95": float(np.quantile(r_hit, 0.95) * 100)},
        "mase": mase, "mase_random": mase_r, "p_hit_random": p_hit_rand, "p_hit_alt": p_hit_alt, "p_err_random": p_err_rand,
        "p_err_alt": p_err_alt, "p_target_random": p_th_rand, "p_best_random": p_best_rand,
        "candidates_med": float(np.median(sizes)), "horizon_def": "median_swing",
        "calibration": ranks, "rank_verdict": rank_verdict, "rank_halves": rb_halves, "horizon_med": float(np.median([q["hz"] for q in R])), "ml": ml, "ml_model": ml_final if adopted else None, "halves": halves, "verdict": verdict,
        "by_pattern": by_pattern, "examples": examples,
    }


# ================================================================== cache del backtest (memoria + disco)

_bt_lock = threading.Lock()
_bt_mem: dict[tuple, tuple[tuple, dict]] = {}


def _stamp(S: dict, P: dict) -> list:
    return [int(len(P["p"])), int(P["ci"][-1]) if len(P["ci"]) else 0, int(S["time"][0])]


def bt_cached(S: dict, tf: str, degree: str) -> dict:
    """Il backtest cambia solo quando si conferma un nuovo pivot: chiave = (tf, grado) + numero di pivot confermati."""
    mult = dict(TF_DEGREES[tf])[degree]
    P = pivots(S, mult)
    stamp = _stamp(S, P)
    key = (tf, degree)
    with _bt_lock:
        hit = _bt_mem.get(key)
        if hit and hit[0] == tuple(stamp):
            return hit[1]
        disk = {}
        try:
            if BT_FILE.exists():
                disk = json.loads(BT_FILE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            disk = {}
        dk = f"{tf}|{degree}"
        if dk in disk and disk[dk].get("stamp") == stamp and disk[dk].get("v") == BT_VERSION:
            res = disk[dk]["res"]
        else:
            t0 = time.perf_counter()
            res = util.clean(backtest(S, tf, degree))
            res["ms"] = int((time.perf_counter() - t0) * 1000)
            disk[dk] = {"stamp": stamp, "v": BT_VERSION, "res": res}
            try:
                store.write_text(BT_FILE, json.dumps(disk))
            except Exception as e:  # noqa: BLE001
                log.warning("salvataggio backtest elliott fallito: %s", e)
            log.info("elliott: backtest %s %s in %d ms (%s casi)", tf, degree, res["ms"], res.get("n"))
        _bt_mem[key] = (tuple(stamp), res)
        return res


BT_VERSION = 4


# ================================================================== risposta

def _rp(v: float | None) -> float | None:
    if v is None or not math.isfinite(v):
        return None
    return int(round(v)) if v >= 1000 else round(float(v), 2)


def _ml_rank(cs: list[dict], mdl: dict | None) -> list[dict]:
    if not mdl or not cs:
        return cs
    mu, sc, w, b = (np.array(mdl[k]) if k != "intercept" else mdl[k] for k in ("mean", "scale", "coef", "intercept"))
    sc = np.where(sc > 0, sc, 1.0)
    for c in cs:
        x = (_features(c) - mu) / sc
        c["ml_p"] = float(1 / (1 + math.exp(-(float(x @ w) + b))))
    return sorted(cs, key=lambda c: -c["ml_p"])


def _bar_time(S: dict, bar: float) -> int:
    n = S["n"]
    b = int(round(bar))
    if b < n:
        return int(S["time"][max(0, b)])
    return int(S["time"][-1] + (b - (n - 1)) * S["step"])


def _dur_est(inst: Inst, c: dict) -> float:
    """Durata attesa (candele) dell'onda in corso: mediana delle gambe completate dello stesso tipo (motrice/correttiva)."""
    i = inst.P["i"]
    s, k = c["s"], c["k"]
    durs = [float(i[s + j] - i[s + j - 1]) for j in range(1, k + 1)]
    mot = MOTIVE_LEGS.get(c["pattern"], set())
    same = [dd for j, dd in enumerate(durs, 1) if (j in mot) == bool(c["cur_motive"])]
    base = float(np.median(same or durs))
    elapsed = float(inst.T - i[inst.m])
    if elapsed >= base:          # già più lunga del tipico: si stima ancora almeno il 38.2% della durata tipica
        base = elapsed + max(1.0, 0.382 * base)
    return base


def _out_candidate(inst: Inst, c: dict, degree: str, rank: int, calib: dict | None, ranker: str) -> dict:
    S, P = inst.S, inst.P
    s, k = c["s"], c["k"]
    labels = LABELS[c["pattern"]]
    pts = [{"pos": 0, "time": int(S["time"][P["i"][s]]), "price": _rp(P["p"][s]), "label": None, "sub": False, "kind": "high" if P["k"][s] == 1 else "low"}]
    waves = []
    for j in range(1, k + 1):
        lab = labels[j - 1]
        sub = c["pattern"] in ("double_zigzag", "double_three") and lab in ("a", "b")
        q = s + j
        pts.append({"pos": j, "time": int(S["time"][P["i"][q]]), "price": _rp(P["p"][q]), "label": lab, "sub": sub,
                    "kind": "high" if P["k"][q] == 1 else "low"})
        a, b = P["p"][q - 1], P["p"][q]
        waves.append({"label": DOUBLE_WAVE[j - 1] if c["pattern"].startswith("double") else lab, "n_sub": inst.sub(q),
                      "change": float((b / a - 1) * 100), "bars": int(P["i"][q] - P["i"][q - 1]),
                      "from": int(S["time"][P["i"][q - 1]]), "to": int(S["time"][P["i"][q]])})
    # onda in corso
    cur_lab = c["w_cur"]
    pending = {"time": int(S["time"][inst.pend_i]), "price": _rp(inst.pend_p), "label": cur_lab,
               "change": float((inst.pend_p / P["p"][inst.m] - 1) * 100), "bars": int(inst.T - P["i"][inst.m])}
    # proiezione: fine dell'onda in corso (centro obiettivo) e dell'onda successiva
    dur = _dur_est(inst, c)
    t_end = P["i"][inst.m] + dur
    tz = c["tz"]
    nx = c["next_fn"](tz["zc"])
    proj = [{"wave": cur_lab, "time": _bar_time(S, t_end), "t_lo": _bar_time(S, max(inst.T + 1, P["i"][inst.m] + dur * 0.618)),
             "t_hi": _bar_time(S, P["i"][inst.m] + dur * 1.618), "price": _rp(zp(c, tz["zc"])), "lo": _rp(c["target"]["lo"]),
             "hi": _rp(c["target"]["hi"]), "reached": bool(tz["reached"]),
             "levels": [{"key": lv["key"], "ratio": lv.get("ratio"), "price": _rp(zp(c, lv["z"]))} for lv in tz["levels"]]}]
    if nx is not None:
        a_, b_ = zp(c, nx["zlo"]), zp(c, nx["zhi"])
        proj.append({"wave": c["w_next"], "time": _bar_time(S, t_end + dur), "t_lo": _bar_time(S, t_end + dur * 0.618), "t_hi": _bar_time(S, t_end + dur * 1.618),
                     "price": _rp(zp(c, nx["zc"])), "lo": _rp(min(a_, b_)), "hi": _rp(max(a_, b_)), "reached": False, "levels": []})
    # canale (impulso / diagonale): 0-2 ∥ 1 (k=2), 1-3 ∥ 2 (k=3), 2-4 ∥ 3 (k≥4); estremi estesi fino alla fine proiettata
    channel = None
    if c["pattern"] in ("impulse", "diagonal") and k >= 2:
        a, b, par = (0, 2, 1) if k == 2 else (1, 3, 2) if k == 3 else (2, 4, 3)
        ia, ib, ipar = int(P["i"][s + a]), int(P["i"][s + b]), int(P["i"][s + par])
        z = c["z"]
        slope = (z[b] - z[a]) / max(1, ib - ia)
        x_end = float(max(t_end + 1, inst.T + 1))
        if c["pattern"] == "diagonal":   # diagonale: linee 1-3 e 2-4 (cuneo)
            i1, i2, i3 = int(P["i"][s + 1]), int(P["i"][s + 2]), int(P["i"][s + 3])
            s13 = (z[3] - z[1]) / max(1, i3 - i1)
            lines = [[(i1, z[1]), (x_end, z[1] + s13 * (x_end - i1))]]
            if k >= 4:
                i4 = int(P["i"][s + 4])
                s24 = (z[4] - z[2]) / max(1, i4 - i2)
                lines.append([(i2, z[2]), (x_end, z[2] + s24 * (x_end - i2))])
        else:
            lines = [[(ia, z[a]), (x_end, z[a] + slope * (x_end - ia))], [(ipar, z[par]), (x_end, z[par] + slope * (x_end - ipar))]]
        channel = [[{"time": _bar_time(S, xx), "price": _rp(zp(c, zz_))} for xx, zz_ in ln] for ln in lines]
    pv = c["inv"]
    rk = None
    if calib and calib.get("ranks") and rank <= len(calib["ranks"]):
        rr = calib["ranks"][rank - 1]
        if rr.get("n", 0) >= 30 and rr.get("p_best") is not None:
            rk = {"p": rr["p_best"], "lo": rr["lo"], "hi": rr["hi"], "n": rr["n"], "p_conf": rr["p_conf"], "ranker": ranker}
    return {
        "rank": rank, "id": f"{c['pattern']}:{c['variant'] or ''}:{s}:{k}", "pattern": c["pattern"], "variant": c["variant"],
        "direction": "up" if c["d"] == 1 else "down", "state": c["state"], "k": k, "legs": c["L"], "degree": degree,
        "wave": cur_lab, "next_wave": c["w_next"], "next_higher": bool(c["next_higher"]),
        "cur_dir": "up" if c["dirp"] == 1 else "down",
        "score": round(c["score"], 1), "ml_p": c.get("ml_p"), "prob": rk,
        "points": pts, "waves": waves, "pending": pending,
        "invalidation": {"below": _rp(pv["below"]), "above": _rp(pv["above"]), "below_rule": pv["below_rule"], "above_rule": pv["above_rule"]},
        "projection": proj, "channel": channel,
        "rules": c["rules"], "guidelines": c["guides"],
    }


def _dedupe(cs: list[dict]) -> list[dict]:
    out, seen = [], set()
    for c in cs:
        key = (c["pattern"], c["variant"], c["s"], c["k"])
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def _candles(S: dict, a: int, b: int) -> list[dict]:
    return [{"time": int(S["time"][i]), "open": _rp(S["open"][i]), "high": _rp(S["high"][i]), "low": _rp(S["low"][i]),
             "close": _rp(S["close"][i])} for i in range(a, b)]


def count_at(S: dict, tf: str, degree: str, T: int, ranker_model: dict | None, calib: dict | None, ranker: str,
             with_hi: bool = True) -> dict:
    """Conteggio all'istante T (solo candele 0..T chiuse): preferito + alternativi, contesto di grado superiore."""
    degs = [g for g, _ in TF_DEGREES[tf]]
    mult = dict(TF_DEGREES[tf])[degree]
    Sc = cut(S, T)
    P = pivots(Sc, mult)
    if len(P["p"]) < 8:
        raise ValueError("pivot insufficienti per contare le onde a questo grado")
    m = len(P["p"]) - 1
    j = degs.index(degree)
    hi = None
    hi_dir = None
    if j > 0 and with_hi:
        g_hi, mult_hi = TF_DEGREES[tf][j - 1]
        Ph = pivots(Sc, mult_hi)
        if len(Ph["p"]) >= 6:
            inst_h, cs_h = evaluate_instant(Sc, Ph, len(Ph["p"]) - 1, T, mult_hi, {}, None)
            cs_h = _dedupe(cs_h)
            if cs_h:
                hi_dir = preferred_dir(cs_h, float(Sc["close"][T]))
                hi = _out_candidate(inst_h, cs_h[0], g_hi, 1, None, "rule")
    inst, cs = evaluate_instant(Sc, P, m, T, mult, {}, hi_dir)
    cs = _dedupe(cs)
    if ranker == "ml":
        cs = _ml_rank(cs, ranker_model)
    top = cs[:TOP_OUT]
    outs = [_out_candidate(inst, c, degree, r, calib, ranker) for r, c in enumerate(top, 1)]
    return {"counts": outs, "n_valid": len(cs), "higher": hi, "inst": inst,
            "pivots": [{"time": int(Sc["time"][P["i"][q]]), "price": _rp(P["p"][q]), "kind": "high" if P["k"][q] == 1 else "low"}
                       for q in range(max(0, m - 14), m + 1)]}


def analyze(tf: str, degree: str) -> dict:
    S = load(tf)
    last_closed = S["n"] - 2 if S["forming"] else S["n"] - 1
    Sc = cut(S, last_closed)
    bt = bt_cached(Sc, tf, degree)
    ranker = bt.get("ranker", "rule")
    res = count_at(S, tf, degree, last_closed, bt.get("ml_model"), bt.get("calibration"), ranker)
    counts = res["counts"]
    first_t = min([p["time"] for c in counts for p in c["points"]] + ([p["time"] for p in res["higher"]["points"]] if res["higher"] else []) or [int(S["time"][-200])])
    a = int(np.searchsorted(S["time"], first_t))
    span = S["n"] - a
    a = max(0, a - max(8, int(span * 0.12)))
    a = min(a, max(0, S["n"] - 60))
    return {
        "tf": tf, "degree": degree, "degrees": [{"key": g, "mult": mlt} for g, mlt in TF_DEGREES[tf]], "mult": dict(TF_DEGREES[tf])[degree],
        "generated_at": int(time.time()), "scale": "log",
        "last": {"time": int(S["time"][-1]), "price": _rp(S["close"][-1]), "forming": bool(S["forming"]), "closed_time": int(S["time"][last_closed])},
        "candles": _candles(S, a, S["n"]),
        "counts": counts, "n_valid": res["n_valid"], "higher": res["higher"], "swings": res["pivots"],
        "weights": WEIGHTS, "ranker": ranker,
        "backtest": {k: v for k, v in bt.items() if k not in ("examples", "ml_model")},
    }


@util.ttl_cache(60)
def _cached(tf: str, degree: str, closed_key: int) -> dict:
    return util.clean(analyze(tf, degree))


def _closed_key(tf: str) -> int:
    """Chiave = ultima candela chiusa attesa: il conteggio si ricalcola alla chiusura della candela."""
    now = int(time.time())
    return now - now % STEP[tf] if tf != "1w" else (now - 345600) - (now - 345600) % STEP["1w"]


def compute(tf: str = "1d", degree: str | None = None) -> dict:
    if tf not in TFS:
        raise ValueError(f"tf non valido: {tf} (ammessi: {', '.join(TFS)})")
    degree = degree or DEFAULT_DEGREE[tf]
    if degree not in dict(TF_DEGREES[tf]):
        raise ValueError(f"grado non valido per {tf}: {degree} (ammessi: {', '.join(g for g, _ in TF_DEGREES[tf])})")
    return _cached(tf, degree, _closed_key(tf))


def backtest_all(degree_mode: str = "default") -> dict:
    """Backtest per timeframe (grado predefinito, o tutti i gradi con degree_mode='all')."""
    out = []
    for tf in TFS:
        S = load(tf)
        last_closed = S["n"] - 2 if S["forming"] else S["n"] - 1
        Sc = cut(S, last_closed)
        degs = [DEFAULT_DEGREE[tf]] if degree_mode == "default" else [g for g, _ in TF_DEGREES[tf]]
        for g in degs:
            try:
                bt = bt_cached(Sc, tf, g)
            except Exception as e:  # noqa: BLE001
                log.warning("backtest elliott %s %s: %s", tf, g, e)
                continue
            out.append({"tf": tf, "degree": g, "mult": dict(TF_DEGREES[tf])[g], **bt})
    return {"generated_at": int(time.time()), "items": out}


def at_time(tf: str, degree: str, t: int) -> dict:
    """Conteggio storico all'istante t (solo dati fino a t) + candele successive per vedere com'è andata."""
    S = load(tf)
    last_closed = S["n"] - 2 if S["forming"] else S["n"] - 1
    T = int(np.searchsorted(S["time"], t, side="right") - 1)
    if T < 300 or T > last_closed:
        raise ValueError("istante fuori dallo storico disponibile")
    Sc = cut(S, last_closed)
    bt = bt_cached(Sc, tf, degree)
    ranker = bt.get("ranker", "rule")
    res = count_at(S, tf, degree, T, bt.get("ml_model"), bt.get("calibration"), ranker)
    counts = res["counts"]
    first_t = min([p["time"] for c in counts for p in c["points"]] or [int(S["time"][T - 100])])
    a = int(np.searchsorted(S["time"], first_t))
    a = max(0, a - max(6, int((T - a) * 0.1)))
    after = max(30, int((T - a) * 0.6))
    b = min(S["n"], T + 1 + after)
    return util.clean({"tf": tf, "degree": degree, "t": int(S["time"][T]), "candles": _candles(S, a, T + 1), "after": _candles(S, T + 1, b),
                       "counts": counts, "n_valid": res["n_valid"], "higher": res["higher"], "ranker": ranker})
