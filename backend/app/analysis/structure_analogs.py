"""Analogia di STRUTTURA: il movimento attuale confrontato con quelli passati per sequenza di massimi e minimi.

Pipeline (tutto causale, nessun dato futuro):
  1. pivot confermati con lo ZigZag su ATR(14) (`structure.zigzag_confirmed`, soglia = mult × ATR, indice di conferma `ci`)
     ed etichette HH/LH/HL/LL (`structure.label_swings`); rotture di struttura BOS/CHoCH = prima CHIUSURA oltre l'ultimo
     massimo/minimo confermato (`structure.zigzag_breaks`, la stessa regola della sezione Struttura);
  2. gli ultimi K swing (K+1 pivot confermati) diventano un vettore: ampiezze log relative (÷ media |ampiezza|), durate
     relative (÷ durata media) e sequenza delle etichette;
  3. si cerca nello storico ogni sequenza con lo stesso tipo di ultimo pivot, etichette uguali (al massimo `max_mism`
     differenze) e nessuna sovrapposizione col presente (l'analogo + i suoi 3 pivot successivi finiscono prima dell'inizio
     del tratto attuale). Distanza = |Δ ampiezze| + 0.5·|Δ durate| + 0.15 per etichetta diversa + 0.1·|log rapporto di scala|
     + penalità se il prossimo swing dell'analogo è più corto di quanto il pivot in formazione abbia già percorso;
  4. per ogni analogo i 3 pivot successivi sono riportati sul presente riscalando ampiezze e tempi con il rapporto delle
     scale (media |ampiezza| e durata media del tratto abbinato); proiezione combinata = mediana dei top-N con P25–P75;
     il primo pivot non può essere meno estremo del pivot in formazione (se lo è, è "già raggiunto");
  5. USDT.D / ETH-BTC → BTC: elasticità a livello di swing (regressione per l'origine di Δlog BTC su Δlog serie sugli
     ultimi 24 swing confermati), con R², errore residuo e forza della relazione dichiarati;
  6. backtest walk-forward: a ogni conferma di un pivot si rifà tutto con i soli pivot già confermati e si confronta
     con l'esito vero (etichetta del prossimo pivot, prezzo entro P25–P75, errore di prezzo e di tempo) contro due baseline:
     ampiezza/durata mediana storica nella direzione alternata e "analogo casuale" con la stessa struttura (400 estrazioni).

I testi sono composti dal frontend (chiavi + numeri): la risposta non contiene frasi da tradurre.
"""
from __future__ import annotations

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
from .structure import label_swings, zigzag_breaks, zigzag_confirmed

log = logging.getLogger("structure_analogs")

ASSETS: dict[str, tuple[str, ...]] = {"btc": ("4h", "1d", "1w"), "usdtd": ("4h", "1d", "1w"), "ethbtc": ("1d", "1w")}
STEP = {"4h": 14400, "1d": 86400, "1w": 604800}
DEFAULT_MULT = {"4h": 3.0, "1d": 2.5, "1w": 2.0}
MULT_RANGE = (1.5, 6.0)
K_RANGE = (3, 8)
TOP_RANGE = (1, 10)
H = 3                     # pivot proiettati
N_RANDOM = 400            # estrazioni della baseline "analogo casuale"
ELAST_LEGS = 24           # swing usati per l'elasticità BTC ↔ serie
MIN_CANDIDATES = 8        # candidati minimi per proiettare (e per includere un istante nel backtest)
START = {"btc": pd.Timestamp("2011-01-01", tz="UTC"), "usdtd": pd.Timestamp("2018-01-01", tz="UTC"),
         "ethbtc": pd.Timestamp("2017-07-01", tz="UTC")}
LAB_CODE = {"HH": 0, "LH": 1, "HL": 2, "LL": 3}
LAB_NAME = {v: k for k, v in LAB_CODE.items()}
W_DUR, W_LAB, W_SCALE, W_PEND = 0.5, 0.15, 0.1, 0.5
SIM_SCALE = 1.0           # similarità = 100·exp(−D / SIM_SCALE)
CAL_MIN = 20              # residui passati minimi per calibrare gli intervalli (altrimenti dispersione degli analoghi)


# ================================================================== dati

def _secs(s) -> np.ndarray:
    s = pd.to_datetime(pd.Series(s), utc=True).astype("datetime64[ns, UTC]")
    return ((s - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(dtype=np.int64)


def _weekly(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Settimane lunedì → domenica: ultima chiusura di ogni colonna."""
    d = df.copy()
    d["wk"] = d["time"].dt.normalize() - pd.to_timedelta(d["time"].dt.weekday, unit="D")
    g = d.groupby("wk")[cols].last().reset_index().rename(columns={"wk": "time"})
    return g


def _closes_frame(t: np.ndarray, c: np.ndarray, btc: np.ndarray) -> dict:
    """Serie di sole chiusure → OHLC sintetico (open = chiusura precedente, high/low = max/min tra le due)."""
    o = np.r_[c[0], c[:-1]]
    return {"time": t, "open": o, "high": np.maximum(o, c), "low": np.minimum(o, c), "close": c, "btc": btc, "synthetic": True, "is_btc": False}


def load_series(asset: str, tf: str) -> dict:
    """Serie dell'asset (tempo in secondi UTC, OHLC, chiusura BTC allineata). Ultima candela = in formazione se non chiusa."""
    if asset not in ASSETS or tf not in ASSETS[asset]:
        raise ValueError(f"combinazione non valida: {asset} {tf}")
    if asset == "btc":
        D = an.load(tf)
        t = D["time"]
        keep = t >= int(START["btc"].timestamp())
        S = {k: np.asarray(D[k])[keep] for k in ("time", "open", "high", "low", "close")}
        S["btc"] = S["close"]
        S["synthetic"] = False
        S["is_btc"] = True
    elif asset == "usdtd":
        from . import stablecoins as sc
        from . import usdt_analogs as ua
        if tf == "4h":
            df = ua.frame_4h()
        else:
            df = sc.daily_frame()
            df = df[df["time"] >= START["usdtd"]][["time", "usdt_d", "btc"]].reset_index(drop=True)
            if tf == "1w":
                df = _weekly(df, ["usdt_d", "btc"])
        S = _closes_frame(_secs(df["time"]), df["usdt_d"].to_numpy(float), df["btc"].to_numpy(float))
    else:
        from . import macro  # noqa: F401  (registra il dataset ethbtc_1d)
        e = store.get("ethbtc_1d")[["time", "ethbtc"]].copy()
        e["time"] = pd.to_datetime(e["time"], utc=True).dt.normalize()
        D = an.load("1d")
        b = pd.DataFrame({"time": pd.to_datetime(D["time"], unit="s", utc=True), "btc": D["close"]})
        df = e.merge(b, on="time", how="inner").dropna()
        df = df[(df["time"] >= START["ethbtc"]) & (df["ethbtc"] > 0)].sort_values("time").reset_index(drop=True)
        if tf == "1w":
            df = _weekly(df, ["ethbtc", "btc"])
        S = _closes_frame(_secs(df["time"]), df["ethbtc"].to_numpy(float), df["btc"].to_numpy(float))
    n = len(S["time"])
    if n < 200:
        raise ValueError(f"storico insufficiente per {asset} {tf}")
    S["n"] = n
    S["step"] = STEP[tf]
    S["forming"] = bool(int(S["time"][-1]) + STEP[tf] > time.time())
    return S


def causal_atr(h: np.ndarray, l: np.ndarray, c: np.ndarray, n: int = 14) -> np.ndarray:
    """ATR di Wilder: le prime n−1 candele restano NaN (lo ZigZag le salta), nessun riempimento con dati futuri."""
    pc = np.r_[np.nan, c[:-1]]
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    return pd.Series(tr).ewm(alpha=1 / n, adjust=False, min_periods=n).mean().to_numpy(float)


# ================================================================== pivot e caratteristiche

def pivots(S: dict, mult: float) -> tuple[dict, dict | None, list[dict]]:
    """Pivot confermati (array), pivot in formazione e rotture di struttura su tutta la serie."""
    h, l, c = S["high"], S["low"], S["close"]
    a = causal_atr(h, l, c)
    piv = label_swings(zigzag_confirmed(h, l, a, mult))
    conf = [p for p in piv if p["ci"] is not None]
    pend = piv[-1] if piv and piv[-1]["ci"] is None else None
    P = {
        "i": np.array([p["i"] for p in conf], dtype=np.int64),
        "ci": np.array([p["ci"] for p in conf], dtype=np.int64),
        "k": np.array([1 if p["kind"] == "high" else -1 for p in conf], dtype=np.int64),
        "p": np.array([p["price"] for p in conf], dtype=float),
        "lab": np.array([LAB_CODE.get(p["label"], -1) for p in conf], dtype=np.int64),
    }
    last_closed = S["n"] - 2 if S["forming"] else S["n"] - 1
    brk = zigzag_breaks(conf, c[: last_closed + 1])
    return P, pend, brk


def features(P: dict, K: int) -> dict:
    """Per ogni pivot finale j ≥ K: ampiezze log (K), durate (K), etichette (K), scale. Righe con j < K = NaN."""
    m = len(P["p"])
    lp = np.log(P["p"])
    amp = np.full((m, K), np.nan)
    dur = np.full((m, K), np.nan)
    lab = np.full((m, K), -1, dtype=np.int64)
    for j in range(K, m):
        amp[j] = np.diff(lp[j - K:j + 1])
        dur[j] = np.diff(P["i"][j - K:j + 1]).astype(float)
        lab[j] = P["lab"][j - K + 1:j + 1]
    with warnings.catch_warnings(), np.errstate(invalid="ignore", divide="ignore"):
        warnings.simplefilter("ignore", RuntimeWarning)
        sa = np.nanmean(np.abs(amp), axis=1)
        st = np.nanmean(dur, axis=1)
        namp = amp / sa[:, None]
        ndur = dur / st[:, None]
    valid = np.all(lab >= 0, axis=1) & np.isfinite(sa) & (sa > 0)
    return {"amp": amp, "dur": dur, "lab": lab, "sa": sa, "st": st, "namp": namp, "ndur": ndur, "valid": valid}


def _max_mism(K: int) -> int:
    return max(1, K // 3)


def distances(F: dict, P: dict, m: int, cands: np.ndarray, pend_frac: float) -> dict:
    """Distanza del tratto che finisce al pivot m da ciascun candidato j (stesso tipo di pivot, etichette quasi uguali)."""
    d_amp = np.mean(np.abs(F["namp"][cands] - F["namp"][m]), axis=1)
    d_dur = np.mean(np.abs(F["ndur"][cands] - F["ndur"][m]), axis=1)
    mism = np.sum(F["lab"][cands] != F["lab"][m], axis=1)
    d_scale = np.abs(np.log(F["sa"][cands] / F["sa"][m]))
    nxt = np.abs(np.log(P["p"][cands + 1] / P["p"][cands])) / F["sa"][cands]
    short = np.maximum(0.0, pend_frac - nxt)
    D = d_amp + W_DUR * d_dur + W_LAB * mism + W_SCALE * d_scale + W_PEND * short
    return {"D": D, "amp": d_amp, "dur": d_dur, "mism": mism, "scale": d_scale, "short": short}


def candidates(F: dict, P: dict, m: int, K: int) -> np.ndarray:
    """Candidati per il pivot m: stesso tipo, etichette quasi uguali, analogo + 3 pivot successivi prima del tratto attuale."""
    jmax = m - K - H
    if jmax < K:
        return np.array([], dtype=np.int64)
    j = np.arange(K, jmax + 1)
    ok = F["valid"][j] & (P["k"][j] == P["k"][m])
    j = j[ok]
    if not len(j):
        return j
    mism = np.sum(F["lab"][j] != F["lab"][m], axis=1)
    return j[mism <= _max_mism(K)]


def pick_top(js: np.ndarray, D: np.ndarray, top: int, gap: int) -> list[int]:
    """Migliori `top` per distanza, con analoghi distanti almeno `gap` pivot fra loro (niente quasi-duplicati)."""
    out: list[int] = []
    pos: list[int] = []
    for k in np.argsort(D, kind="stable"):
        j = int(js[k])
        if all(abs(j - q) >= gap for q in pos):
            out.append(int(k))
            pos.append(j)
        if len(out) >= top:
            break
    return out


def project_one(P: dict, F: dict, m: int, j: int) -> tuple[np.ndarray, np.ndarray]:
    """Pivot j+1..j+H dell'analogo riportati sul pivot m: (log-variazioni rispetto a P[m], offset in candele da i[m])."""
    ra = float(np.clip(F["sa"][m] / F["sa"][j], 1 / 3, 3))
    rt = float(np.clip(F["st"][m] / F["st"][j], 1 / 3, 3))
    lr = np.log(P["p"][j + 1:j + 1 + H] / P["p"][j]) * ra
    dt = (P["i"][j + 1:j + 1 + H] - P["i"][j]).astype(float) * rt
    return lr, dt


def apply_pending(lr: np.ndarray, dt: np.ndarray, kind_next: int, ext_lr: float, ext_dt: float, now_dt: float) -> tuple[np.ndarray, np.ndarray, bool]:
    """Vincoli del pivot in formazione: il prossimo pivot è almeno estremo quanto il prezzo già toccato; date crescenti e future."""
    lr = lr.copy()
    dt = dt.copy()
    reached = bool(kind_next * lr[0] <= kind_next * ext_lr)
    if reached:
        lr[0], dt[0] = ext_lr, ext_dt
    else:
        dt[0] = max(dt[0], now_dt + 1)
    for h in range(1, len(dt)):
        dt[h] = max(dt[h], dt[h - 1] + 1)
    return lr, dt, reached


def pend_state(S: dict, P: dict, m: int, T: int) -> tuple[int, float]:
    """Estremo del pivot in formazione all'istante T (dopo la conferma del pivot m): indice e prezzo."""
    a = int(P["ci"][m])
    if P["k"][m] == 1:   # dopo un massimo si forma un minimo
        seg = S["low"][a:T + 1]
        k = len(seg) - 1 - int(np.argmin(seg[::-1]))
    else:
        seg = S["high"][a:T + 1]
        k = len(seg) - 1 - int(np.argmax(seg[::-1]))
    return a + k, float(seg[k])


def _q(x: np.ndarray, q: float) -> float:
    return float(np.quantile(x, q)) if len(x) else float("nan")


def combine(proj: list[tuple[np.ndarray, np.ndarray]]) -> dict:
    L = np.array([p[0] for p in proj])
    T_ = np.array([p[1] for p in proj])
    return {"lr": np.median(L, axis=0), "lr25": np.quantile(L, 0.25, axis=0), "lr75": np.quantile(L, 0.75, axis=0),
            "dt": np.median(T_, axis=0), "dt25": np.quantile(T_, 0.25, axis=0), "dt75": np.quantile(T_, 0.75, axis=0), "all": L}


def predicted_label(P: dict, m: int, h: int, price: float) -> int:
    """Etichetta del pivot m+h (h = 1 o 2) data la sua quota: confronto col pivot dello stesso tipo precedente."""
    kind = -P["k"][m] if h % 2 == 1 else P["k"][m]
    ref = P["p"][m - 1] if h == 1 else P["p"][m]
    if kind == 1:
        return LAB_CODE["HH"] if price > ref else LAB_CODE["LH"]
    return LAB_CODE["HL"] if price > ref else LAB_CODE["LL"]


# ================================================================== elasticità BTC ↔ serie (USDT.D, ETH/BTC)

def elasticity(S: dict, P: dict, upto: int, n_legs: int = ELAST_LEGS) -> dict | None:
    """Regressione per l'origine di Δlog BTC su Δlog serie, swing per swing, sugli ultimi n swing confermati (pivot ≤ upto)."""
    if S.get("btc") is None or upto < 4:
        return None
    a0 = max(0, upto - n_legs)
    ii = P["i"][a0:upto + 1]
    x = np.diff(np.log(P["p"][a0:upto + 1]))
    y = np.diff(np.log(S["btc"][ii]))
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 6 or float(np.sum(x * x)) <= 0:
        return None
    beta = float(np.sum(x * y) / np.sum(x * x))
    res = y - beta * x
    sd = float(np.sqrt(np.sum(res ** 2) / max(1, len(x) - 1)))
    r = float(np.corrcoef(x, y)[0, 1]) if np.std(x) > 0 and np.std(y) > 0 else 0.0
    r2 = r * r
    strength = "strong" if r2 >= 0.5 else "moderate" if r2 >= 0.25 else "weak"
    return {"beta": beta, "r2": r2, "corr": r, "n": int(len(x)), "resid_sd": sd, "strength": strength}


def translate(el: dict, base_btc: float, lr: float, lr25: float, lr75: float, h: int) -> dict:
    """Valore della serie → prezzo BTC: BTC_now·exp(β·Δlog serie), intervallo da P25–P75 e dall'errore residuo (√h swing)."""
    c = el["beta"] * lr
    half = math.sqrt((el["beta"] * (lr75 - lr25) / 2) ** 2 + (0.674 * el["resid_sd"] * math.sqrt(h)) ** 2)
    return {"price": base_btc * math.exp(c), "lo": base_btc * math.exp(c - half), "hi": base_btc * math.exp(c + half)}


# ================================================================== backtest walk-forward

def backtest(S: dict, P: dict, F: dict, K: int, top: int, seed: int = 7, rows_out: list | None = None) -> dict:
    """A ogni conferma di un pivot m (istante T = ci[m]) si proietta con i soli pivot già confermati e si confronta con m+1, m+2.

    `rows_out` (test): riceve le righe per istante, per verificare che troncare la serie a T non cambi nulla.
    """
    m_all = len(P["p"])
    rng = np.random.default_rng(seed)
    gap = max(2, K)
    rows: list[dict] = []
    rnd_err: list[np.ndarray] = []
    rnd_hit: list[np.ndarray] = []
    rnd_terr: list[np.ndarray] = []
    # residui (esito − proiezione) per h = 1..3 con l'istante in cui diventano noti (conferma del pivot vero)
    known = {h: [] for h in range(1, H + 1)}
    res = {h: [] for h in range(1, H + 1)}
    tres = {h: [] for h in range(1, H + 1)}
    for m in range(K + 1, m_all - 2):
        if not F["valid"][m]:
            continue
        T = int(P["ci"][m])
        js = candidates(F, P, m, K)
        if len(js) < max(MIN_CANDIDATES, top):
            continue
        ext_i, ext_p = pend_state(S, P, m, T)
        lp_m = math.log(P["p"][m])
        ext_lr = math.log(ext_p) - lp_m
        pend_frac = abs(ext_lr) / F["sa"][m]
        dd = distances(F, P, m, js, pend_frac)
        sel = pick_top(js, dd["D"], top, gap)
        kind_next = -int(P["k"][m])
        ext_dt = float(ext_i - P["i"][m])
        now_dt = float(T - P["i"][m])

        def proj(j):
            lr, dt = project_one(P, F, m, int(j))
            return apply_pending(lr, dt, kind_next, ext_lr, ext_dt, now_dt)[:2]

        cmb = combine([proj(js[k]) for k in sel])
        act_lr = np.log(P["p"][m + 1:m + 1 + H] / P["p"][m])
        act_dt = (P["i"][m + 1:m + 1 + H] - P["i"][m]).astype(float)
        # intervalli calibrati: quantili dei residui passati GIÀ NOTI a T (conformal walk-forward), altrimenti dispersione analoghi
        cal = {}
        for h in (1, 2):
            kn = np.array(known[h])
            ok = kn <= T if len(kn) else np.zeros(0, bool)
            if ok.sum() >= CAL_MIN:
                r_, t_ = np.array(res[h])[ok], np.array(tres[h])[ok]
                lr_, dt_ = cmb["lr"][h - 1], cmb["dt"][h - 1]     # l'intervallo contiene sempre la proiezione
                cal[h] = (lr_ + min(0.0, np.quantile(r_, 0.25)), lr_ + max(0.0, np.quantile(r_, 0.75)),
                          dt_ + min(0.0, np.quantile(t_, 0.25)), dt_ + max(0.0, np.quantile(t_, 0.75)))
            else:
                cal[h] = (cmb["lr25"][h - 1], cmb["lr75"][h - 1], cmb["dt25"][h - 1], cmb["dt75"][h - 1])
        for h in range(1, min(H, m_all - 1 - m) + 1):
            known[h].append(int(P["ci"][m + h]))
            res[h].append(float(act_lr[h - 1] - cmb["lr"][h - 1]))
            tres[h].append(float(act_dt[h - 1] - cmb["dt"][h - 1]))
        # baseline 1: ampiezza e durata mediane storiche (swing confermati fino al pivot m), direzione alternata
        amps = np.diff(np.log(P["p"][:m + 1]))
        durs = np.diff(P["i"][:m + 1]).astype(float)
        up = amps > 0
        a_up, a_dn = float(np.median(amps[up])), float(np.median(amps[~up]))
        d_up, d_dn = float(np.median(durs[up])), float(np.median(durs[~up]))
        if kind_next == 1:
            b_lr = np.array([a_up, a_up + a_dn])
            b_dt = np.array([d_up, d_up + d_dn])
        else:
            b_lr = np.array([a_dn, a_dn + a_up])
            b_dt = np.array([d_dn, d_dn + d_up])
        b_lr = np.r_[b_lr, b_lr[-1]]
        b_dt = np.r_[b_dt, b_dt[-1] + 1]
        b_lr, b_dt, _ = apply_pending(b_lr, b_dt, kind_next, ext_lr, ext_dt, now_dt)
        # baseline 2: N analoghi casuali con la stessa struttura (stesso tipo, etichette quasi uguali), R estrazioni
        PR = np.array([proj(j) for j in js])                      # (|C|, 2, H)
        idx = rng.integers(0, len(js), size=(N_RANDOM, len(sel)))
        r_lr = np.median(PR[idx, 0, 0], axis=1)
        r_dt = np.median(PR[idx, 1, 0], axis=1)
        act_lab = int(P["lab"][m + 1])
        r_lab = np.array([predicted_label(P, m, 1, P["p"][m] * math.exp(v)) for v in r_lr])
        rnd_err.append(np.abs(r_lr - act_lr[0]))
        rnd_hit.append((r_lab == act_lab).astype(float))
        rnd_terr.append(np.abs(r_dt - act_dt[0]))
        pred_lab = predicted_label(P, m, 1, P["p"][m] * math.exp(cmb["lr"][0]))
        b_lab = predicted_label(P, m, 1, P["p"][m] * math.exp(b_lr[0]))
        agree = float(np.mean([predicted_label(P, m, 1, P["p"][m] * math.exp(v)) == pred_lab for v in cmb["all"][:, 0]]))
        row = {
            "m": m, "T": T, "kind": kind_next, "pred_lab": pred_lab, "act_lab": act_lab, "b_lab": b_lab, "agree": agree,
            "lr": float(cmb["lr"][0]), "lr25": float(cal[1][0]), "lr75": float(cal[1][1]), "act_lr": float(act_lr[0]),
            "raw25": float(cmb["lr25"][0]), "raw75": float(cmb["lr75"][0]),
            "dt": float(cmb["dt"][0]), "dt25": float(cal[1][2]), "dt75": float(cal[1][3]), "act_dt": float(act_dt[0]),
            "b_lr": float(b_lr[0]), "b_dt": float(b_dt[0]),
            "lr2": float(cmb["lr"][1]), "lr2_25": float(cal[2][0]), "lr2_75": float(cal[2][1]), "act_lr2": float(act_lr[1]),
            "b_lr2": float(b_lr[1]),
            "pred_lab2": predicted_label(P, m, 2, P["p"][m] * math.exp(cmb["lr"][1])), "act_lab2": int(P["lab"][m + 2]),
            "b_lab2": predicted_label(P, m, 2, P["p"][m] * math.exp(b_lr[1])),
        }
        # traduzione in BTC (solo serie diverse da BTC): elasticità stimata coi pivot ≤ m
        if S.get("is_btc") is False:
            el = elasticity(S, P, m)
            if el:
                sh = math.log(S["close"][T]) - lp_m          # Δlog della serie dal pivot m a T
                tr = translate(el, float(S["btc"][T]), row["lr"] - sh, row["lr25"] - sh, row["lr75"] - sh, 1)
                row.update({"btc_pred": tr["price"], "btc_lo": tr["lo"], "btc_hi": tr["hi"],
                            "btc_act": float(S["btc"][int(P["i"][m + 1])]), "btc_now": float(S["btc"][T])})
        rows.append(row)
    if rows_out is not None:
        rows_out.extend(rows)
    out = _bt_summary(rows, np.array(rnd_err), np.array(rnd_hit), np.array(rnd_terr), S, P)
    out["calibration"] = {
        "n": [len(res[h]) for h in range(1, H + 1)],
        "lr": [[float(np.quantile(res[h], 0.25)), float(np.quantile(res[h], 0.75))] if len(res[h]) >= CAL_MIN else None for h in range(1, H + 1)],
        "dt": [[float(np.quantile(tres[h], 0.25)), float(np.quantile(tres[h], 0.75))] if len(tres[h]) >= CAL_MIN else None for h in range(1, H + 1)],
    }
    return out


def _sign_p(diff: np.ndarray) -> float | None:
    """Test del segno unilaterale: P(modello migliore della baseline in ≥ k casi su n) sotto H0 p=½."""
    d = diff[np.abs(diff) > 1e-12]
    n = len(d)
    if n < 5:
        return None
    k = int(np.sum(d < 0))
    from math import comb
    return float(sum(comb(n, i) for i in range(k, n + 1)) / 2 ** n)


def _bt_summary(rows: list[dict], rerr: np.ndarray, rhit: np.ndarray, rterr: np.ndarray, S: dict, P: dict) -> dict:
    n = len(rows)
    if n == 0:
        return {"n": 0, "verdict": "anecdotal"}
    g = lambda k: np.array([r[k] for r in rows], dtype=float)  # noqa: E731
    lr, a_lr, b_lr = g("lr"), g("act_lr"), g("b_lr")
    err, b_err = np.abs(lr - a_lr), np.abs(b_lr - a_lr)
    terr, b_terr = np.abs(g("dt") - g("act_dt")), np.abs(g("b_dt") - g("act_dt"))
    hit = (g("pred_lab") == g("act_lab"))
    b_hit = (g("b_lab") == g("act_lab"))
    cov = (a_lr >= g("lr25")) & (a_lr <= g("lr75"))
    cov_raw = (a_lr >= g("raw25")) & (a_lr <= g("raw75"))
    tcov = (g("act_dt") >= g("dt25")) & (g("act_dt") <= g("dt75"))
    err2, b_err2 = np.abs(g("lr2") - g("act_lr2")), np.abs(g("b_lr2") - g("act_lr2"))
    hit2, b_hit2 = (g("pred_lab2") == g("act_lab2")), (g("b_lab2") == g("act_lab2"))
    cov2 = (g("act_lr2") >= g("lr2_25")) & (g("act_lr2") <= g("lr2_75"))
    # baseline casuale: per ogni estrazione r, media sugli istanti
    r_err_runs = rerr.mean(axis=0)           # (R,)
    r_hit_runs = rhit.mean(axis=0)
    r_terr_runs = rterr.mean(axis=0)
    p_err_rand = float((1 + np.sum(r_err_runs <= err.mean())) / (1 + len(r_err_runs)))
    p_hit_rand = float((1 + np.sum(r_hit_runs >= hit.mean())) / (1 + len(r_hit_runs)))
    p_err_med = _sign_p(err - b_err)
    pct = lambda x: float(np.expm1(x) * 100)  # noqa: E731
    mase = float(err.mean() / b_err.mean()) if b_err.mean() > 0 else None
    mase_rand = float(err.mean() / r_err_runs.mean()) if r_err_runs.mean() > 0 else None
    mase_t = float(terr.mean() / b_terr.mean()) if b_terr.mean() > 0 else None
    # verdetto calcolato dai dati
    if n < 30:
        verdict = "anecdotal"
    else:
        better = (mase is not None and mase < 1) and (mase_rand is not None and mase_rand < 1)
        sig = p_err_rand < 0.05 and (p_err_med is not None and p_err_med < 0.05)
        half = n // 2
        stable = all(np.abs(lr[s] - a_lr[s]).mean() < np.abs(b_lr[s] - a_lr[s]).mean() for s in (slice(0, half), slice(half, n)))
        if better and sig and stable and hit.mean() >= b_hit.mean():
            verdict = "strong"
        elif better and (p_err_rand < 0.10 or (p_err_med is not None and p_err_med < 0.10) or p_hit_rand < 0.10):
            verdict = "weak"
        else:
            verdict = "none"
    halves = []
    for s in (slice(0, n // 2), slice(n // 2, n)):
        if s.stop - s.start < 5:
            continue
        halves.append({"from": int(S["time"][rows[s.start]["T"]]), "to": int(S["time"][rows[s.stop - 1]["T"]]), "n": int(s.stop - s.start),
                       "hit": float(hit[s].mean() * 100), "base_hit": float(b_hit[s].mean() * 100),
                       "mase": float(err[s].mean() / b_err[s].mean()) if b_err[s].mean() > 0 else None})
    btc = None
    if "btc_pred" in rows[-1]:
        br = [r for r in rows if "btc_pred" in r]
        bp, ba, bn = (np.array([r[k] for r in br]) for k in ("btc_pred", "btc_act", "btc_now"))
        lo, hi = np.array([r["btc_lo"] for r in br]), np.array([r["btc_hi"] for r in br])
        e_m = np.abs(np.log(bp / ba))
        e_b = np.abs(np.log(bn / ba))
        btc = {"n": len(br), "err_med": pct(float(np.median(e_m))), "base_err_med": pct(float(np.median(e_b))),
               "mase": float(e_m.mean() / e_b.mean()) if e_b.mean() > 0 else None,
               "cov": float(np.mean((ba >= lo) & (ba <= hi)) * 100), "p_sign": _sign_p(e_m - e_b),
               "dir_hit": float(np.mean(np.sign(bp - bn) == np.sign(ba - bn)) * 100)}
    recent = []
    for r in rows[-14:]:
        p0 = float(P["p"][r["m"]])
        recent.append({
            "time": int(S["time"][r["T"]]), "kind": "high" if r["kind"] == 1 else "low",
            "pred_label": LAB_NAME[int(r["pred_lab"])], "actual_label": LAB_NAME[int(r["act_lab"])], "hit": bool(r["pred_lab"] == r["act_lab"]),
            "pred": p0 * math.exp(r["lr"]), "lo": p0 * math.exp(r["lr25"]), "hi": p0 * math.exp(r["lr75"]), "actual": p0 * math.exp(r["act_lr"]),
            "actual_time": int(S["time"][int(P["i"][r["m"] + 1])]), "inside": bool(r["lr25"] <= r["act_lr"] <= r["lr75"]),
            "err": pct(abs(r["lr"] - r["act_lr"])), "base_err": pct(abs(r["b_lr"] - r["act_lr"])),
        })
    return {
        "n": n, "from": int(S["time"][rows[0]["T"]]), "to": int(S["time"][rows[-1]["T"]]),
        "model": {"hit": float(hit.mean() * 100), "cov": float(cov.mean() * 100), "cov_raw": float(cov_raw.mean() * 100), "err_med": pct(float(np.median(err))),
                  "err_mean": pct(float(err.mean())), "time_err_med": float(np.median(terr)), "time_cov": float(tcov.mean() * 100),
                  "agree_hit": _agree_hit(rows)},
        "base_median": {"hit": float(b_hit.mean() * 100), "err_med": pct(float(np.median(b_err))), "err_mean": pct(float(b_err.mean())),
                        "time_err_med": float(np.median(b_terr))},
        "base_random": {"hit": float(r_hit_runs.mean() * 100), "err_med": pct(float(np.median(rerr))), "err_mean": pct(float(r_err_runs.mean())),
                        "time_err_med": float(np.median(rterr)), "hit_q95": float(np.quantile(r_hit_runs, 0.95) * 100),
                        "err_q05": pct(float(np.quantile(r_err_runs, 0.05)))},
        "mase": mase, "mase_random": mase_rand, "mase_time": mase_t,
        "p_err_random": p_err_rand, "p_hit_random": p_hit_rand, "p_err_median": p_err_med,
        "next2": {"hit": float(hit2.mean() * 100), "base_hit": float(b_hit2.mean() * 100), "cov": float(cov2.mean() * 100),
                  "err_med": pct(float(np.median(err2))), "base_err_med": pct(float(np.median(b_err2))),
                  "mase": float(err2.mean() / b_err2.mean()) if b_err2.mean() > 0 else None},
        "btc": btc, "halves": halves, "verdict": verdict, "recent": recent,
    }


def _agree_hit(rows: list[dict]) -> dict | None:
    """Hit rate quando ≥ 80% dei top-N concordano sull'etichetta (sottoinsieme ad alta concordanza)."""
    sub = [r for r in rows if r["agree"] >= 0.8]
    if len(sub) < 10:
        return None
    return {"n": len(sub), "hit": float(np.mean([r["pred_lab"] == r["act_lab"] for r in sub]) * 100)}


# ================================================================== risposta

def _rp(v: float, unit: str) -> float:
    v = float(v)
    if unit == "usd":
        return int(round(v)) if v >= 1000 else round(v, 2)
    if unit == "pct":
        return round(v, 4)
    return round(v, 6)


def _candles(S: dict, a: int, b: int, unit: str) -> list[dict]:
    t, o, h, l, c = S["time"], S["open"], S["high"], S["low"], S["close"]
    return [{"time": int(t[i]), "open": _rp(o[i], unit), "high": _rp(h[i], unit), "low": _rp(l[i], unit), "close": _rp(c[i], unit)}
            for i in range(a, b)]


def _seg_pivots(S: dict, P: dict, a: int, idxs: list[int], first_n: int, unit: str, after_from: int | None = None) -> list[dict]:
    out = []
    for n_, q in enumerate(idxs, first_n):
        out.append({"n": n_, "idx": int(P["i"][q] - a), "time": int(S["time"][P["i"][q]]), "price": _rp(P["p"][q], unit),
                    "kind": "high" if P["k"][q] == 1 else "low", "label": LAB_NAME.get(int(P["lab"][q])),
                    "confirmed": int(S["time"][P["ci"][q]]), "after": bool(after_from is not None and q >= after_from)})
    return out


def _seg_breaks(S: dict, brk: list[dict], a: int, b: int, unit: str, forming_i: int | None) -> list[dict]:
    out = []
    for e in brk:
        if e["pivot_i"] >= a and e["i"] < b:
            out.append({"kind": e["kind"], "from_idx": int(e["pivot_i"] - a), "to_idx": int(e["i"] - a), "level": _rp(e["level"], unit),
                        "from_time": int(S["time"][e["pivot_i"]]), "time": int(S["time"][e["i"]])})
    return out


def _bar_time(S: dict, bar: float) -> int:
    n = S["n"]
    b = int(round(bar))
    if b < n:
        return int(S["time"][max(0, b)])
    return int(S["time"][-1] + (b - (n - 1)) * S["step"])


def analyze(asset: str, tf: str, mult: float, K: int, top: int) -> dict:
    S = load_series(asset, tf)
    unit = "usd" if asset == "btc" else "pct" if asset == "usdtd" else "ratio"
    P, pend, brk = pivots(S, mult)
    m_all = len(P["p"])
    if m_all < 4 * K + 10:
        raise ValueError("pivot insufficienti: abbassa la soglia ZigZag o il numero di swing")
    F = features(P, K)
    bt = _bt_cached(asset, tf, mult, K, top, S, P, F)
    m = m_all - 1                                   # ultimo pivot confermato
    n = S["n"]
    T = n - 1
    js = candidates(F, P, m, K)
    if pend is not None:
        ext_i, ext_p = int(pend["i"]), float(pend["price"])
    else:
        ext_i, ext_p = pend_state(S, P, m, T)
    lp_m = math.log(P["p"][m])
    ext_lr = math.log(ext_p) - lp_m
    kind_next = -int(P["k"][m])
    pend_frac = abs(ext_lr) / F["sa"][m]
    ext_dt, now_dt = float(ext_i - P["i"][m]), float(T - P["i"][m])
    a_cur = max(0, int(P["i"][m - K]) - max(3, int(F["st"][m] * 0.35)))
    forming_i = n - 1 if S["forming"] else None
    cur = {
        "candles": _candles(S, a_cur, n, unit),
        "pivots": _seg_pivots(S, P, a_cur, list(range(m - K, m + 1)), 1, unit),
        "pending": {"idx": ext_i - a_cur, "time": int(S["time"][ext_i]), "price": _rp(ext_p, unit), "kind": "high" if kind_next == 1 else "low",
                    "label": LAB_NAME[predicted_label(P, m, 1, ext_p)], "move": float(np.expm1(ext_lr) * 100)},
        "breaks": _seg_breaks(S, brk, a_cur, n, unit, forming_i),
        "last": {"time": int(S["time"][-1]), "price": _rp(S["close"][-1], unit), "forming": S["forming"]},
        "btc_price": _rp(S["btc"][-1], "usd"),
        "swings": [{"amp": float(np.expm1(F["amp"][m][q]) * 100), "bars": int(F["dur"][m][q])} for q in range(K)],
        "scale": {"amp": float(np.expm1(F["sa"][m]) * 100), "bars": float(F["st"][m])},
        "start": int(S["time"][P["i"][m - K]]), "end": int(S["time"][P["i"][m]]),
    }
    el = elasticity(S, P, m) if asset != "btc" else None
    gap = max(2, K)
    analogs_out: list[dict] = []
    proj_out = None
    calibrated = False
    if len(js) >= 1:
        dd = distances(F, P, m, js, pend_frac)
        sel = pick_top(js, dd["D"], top, gap)
        projs = []
        for rank, k in enumerate(sel, 1):
            j = int(js[k])
            lr0, dt0 = project_one(P, F, m, j)
            lr, dt, reached = apply_pending(lr0, dt0, kind_next, ext_lr, ext_dt, now_dt)
            projs.append((lr, dt))
            a = max(0, int(P["i"][j - K]) - max(3, int(F["st"][j] * 0.35)))
            b = min(n, int(P["i"][j + H]) + max(3, int(F["st"][j] * 0.6)) + 1)
            seq = list(range(j - K, j + H + 1))
            outc = []
            for h in range(1, H + 1):
                outc.append({"h": h, "label": LAB_NAME.get(int(P["lab"][j + h])), "kind": "high" if P["k"][j + h] == 1 else "low",
                             "change": float(np.expm1(math.log(P["p"][j + h] / P["p"][j])) * 100), "bars": int(P["i"][j + h] - P["i"][j])})
            analogs_out.append({
                "rank": rank, "similarity": float(100 * math.exp(-dd["D"][k] / SIM_SCALE)), "distance": float(dd["D"][k]),
                "parts": {"amp": float(dd["amp"][k]), "dur": float(dd["dur"][k]), "mismatch": int(dd["mism"][k]), "scale": float(dd["scale"][k]),
                          "short": float(dd["short"][k])},
                "start": int(S["time"][P["i"][j - K]]), "end": int(S["time"][P["i"][j]]), "after_end": int(S["time"][P["i"][j + H]]),
                "candles": _candles(S, a, b, unit),
                "pivots": _seg_pivots(S, P, a, seq, 1, unit, after_from=j + 1),
                "breaks": _seg_breaks(S, brk, a, b, unit, None),
                "end_idx": int(P["i"][j] - a),
                "ratio": {"amp": float(np.clip(F["sa"][m] / F["sa"][j], 1 / 3, 3)), "time": float(np.clip(F["st"][m] / F["st"][j], 1 / 3, 3))},
                "scale": {"amp": float(np.expm1(F["sa"][j]) * 100), "bars": float(F["st"][j])},
                "labels": [LAB_NAME.get(int(x)) for x in F["lab"][j]],
                "outcome": outc,
                "projection": [_pp(S, P, m, h, lr[h - 1], lr[h - 1], lr[h - 1], dt[h - 1], dt[h - 1], dt[h - 1], reached and h == 1, unit, el, None,
                                   ref1=float(lr[0])) for h in range(1, H + 1)],
            })
        if projs:
            cmb = combine(projs)
            cal = bt.get("calibration") or {}
            calibrated = bool(cal) and all(cal["lr"][h] is not None and cal["dt"][h] is not None for h in range(H))
            pts = []
            for h in range(1, H + 1):
                lr, dt = float(cmb["lr"][h - 1]), float(cmb["dt"][h - 1])
                if calibrated:     # intervallo = proiezione + quantili 25–75 dei residui del backtest walk-forward
                    lo, hi = lr + min(0.0, cal["lr"][h - 1][0]), lr + max(0.0, cal["lr"][h - 1][1])
                    tlo, thi = dt + min(0.0, cal["dt"][h - 1][0]), dt + max(0.0, cal["dt"][h - 1][1])
                else:              # pochi residui: dispersione dei top-N
                    lo, hi = float(cmb["lr25"][h - 1]), float(cmb["lr75"][h - 1])
                    tlo, thi = float(cmb["dt25"][h - 1]), float(cmb["dt75"][h - 1])
                reached = bool(h == 1 and kind_next * lr <= kind_next * ext_lr + 1e-12)
                if h == 1:         # il pivot in formazione non può essere meno estremo del prezzo già toccato
                    if kind_next == 1:
                        lo = max(lo, ext_lr)
                        hi = max(hi, lo)
                    else:
                        hi = min(hi, ext_lr)
                        lo = min(lo, hi)
                    tlo = max(tlo, ext_dt)
                else:
                    tlo = max(tlo, now_dt + 1)
                thi = max(thi, tlo, dt)
                tlo = min(tlo, dt)
                pts.append(_pp(S, P, m, h, lr, lo, hi, dt, tlo, thi, reached, unit, el, cmb["all"][:, h - 1], ref1=float(cmb["lr"][0])))
            proj_out = {"n": len(projs), "pivots": pts, "calibrated": calibrated, "few": bool(len(js) < MIN_CANDIDATES)}
    return {
        "asset": asset, "tf": tf, "mult": mult, "k": K, "top": top, "unit": unit, "generated_at": int(time.time()),
        "assets": {k: list(v) for k, v in ASSETS.items()},
        "synthetic": bool(S["synthetic"]),
        "current": cur, "projection": proj_out, "analogs": analogs_out,
        "translation": ({"method": "leg_elasticity", **el, "legs": ELAST_LEGS} if el else None),
        "history": {"pivots": m_all, "candidates": int(len(js)), "first": int(S["time"][0]), "max_mismatch": _max_mism(K)},
        "backtest": bt,
    }


def _pp(S, P, m, h, lr, lr25, lr75, dt, dt25, dt75, reached, unit, el, all_lr, ref1: float | None = None) -> dict:
    """Un pivot proiettato (h = 1..3) in prezzo/data con intervallo; `ref1` = log-variazione proiettata del pivot 1 (per l'etichetta del 3)."""
    p0 = float(P["p"][m])
    kind = (-P["k"][m]) if h % 2 == 1 else P["k"][m]
    price = p0 * math.exp(lr)

    def lab_of(v: float) -> int:
        if h <= 2:
            return predicted_label(P, m, h, p0 * math.exp(v))
        r = ref1 if ref1 is not None else v
        if kind == 1:
            return LAB_CODE["HH"] if v > r else LAB_CODE["LH"]
        return LAB_CODE["HL"] if v > r else LAB_CODE["LL"]

    lab = lab_of(lr)
    agree = float(np.mean([lab_of(v) == lab for v in all_lr]) * 100) if all_lr is not None else None
    out = {
        "h": h, "kind": "high" if kind == 1 else "low", "label": LAB_NAME[lab], "agree": agree,
        "price": _rp(price, unit), "lo": _rp(p0 * math.exp(min(lr25, lr75)), unit), "hi": _rp(p0 * math.exp(max(lr25, lr75)), unit),
        "change": float((price / float(S["close"][-1]) - 1) * 100),
        "time": _bar_time(S, P["i"][m] + dt), "t_lo": _bar_time(S, P["i"][m] + min(dt25, dt75)), "t_hi": _bar_time(S, P["i"][m] + max(dt25, dt75)),
        "bar": float(P["i"][m] + dt - (S["n"] - 1)), "reached": bool(reached),
        "btc": None,
    }
    if el is not None:
        sh = math.log(float(S["close"][-1])) - math.log(p0)
        tr = translate(el, float(S["btc"][-1]), lr - sh, lr25 - sh, lr75 - sh, h)
        out["btc"] = {k: _rp(v, "usd") for k, v in tr.items()}
    return out


# ================================================================== cache

_bt_lock = threading.Lock()
_bt_store: dict[tuple, tuple[tuple, dict]] = {}


def _bt_cached(asset, tf, mult, K, top, S, P, F) -> dict:
    """Il backtest cambia solo quando si conferma un nuovo pivot: chiave = parametri + numero di pivot confermati."""
    key = (asset, tf, mult, K, top)
    stamp = (len(P["p"]), int(P["ci"][-1]) if len(P["ci"]) else 0, int(S["time"][0]))
    with _bt_lock:
        hit = _bt_store.get(key)
        if hit and hit[0] == stamp:
            return hit[1]
        t0 = time.perf_counter()
        res = backtest(S, P, F, K, top)
        res["ms"] = int((time.perf_counter() - t0) * 1000)
        _bt_store[key] = (stamp, res)
        return res


@util.ttl_cache(30)
def cached(asset: str, tf: str, mult: float, K: int, top: int) -> dict:
    return util.clean(analyze(asset, tf, mult, K, top))


def compute(asset: str = "btc", tf: str = "1d", mult: float | None = None, k: int = 5, top: int = 5) -> dict:
    if asset not in ASSETS:
        raise ValueError(f"asset non valido: {asset} (ammessi: {', '.join(ASSETS)})")
    if tf not in ASSETS[asset]:
        raise ValueError(f"tf non valido per {asset}: {tf} (ammessi: {', '.join(ASSETS[asset])})")
    mult = float(mult if mult is not None else DEFAULT_MULT[tf])
    mult = round(min(max(mult, MULT_RANGE[0]), MULT_RANGE[1]) * 2) / 2
    k = int(min(max(k, K_RANGE[0]), K_RANGE[1]))
    top = int(min(max(top, TOP_RANGE[0]), TOP_RANGE[1]))
    return cached(asset, tf, mult, k, top)
