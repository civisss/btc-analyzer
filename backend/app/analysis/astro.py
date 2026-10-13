"""Studio "Astronomia e numeri": ipotesi astronomiche e numeriche testate sullo storico di BTC contro il caso.

Principio: ogni ipotesi è un test statistico, non un segnale.
  - Rendimenti giornalieri logaritmici close-to-close (candele UTC), campione dal 1° gen 2012 a ieri
    (la candela di oggi è incompleta e viene esclusa).
  - Studi di evento: rendimento cumulato nella finestra [d+a, d+b] attorno all'evento d, confrontato con la media
    di TUTTE le finestre della stessa lunghezza (effetto = media eventi − media incondizionata).
  - p-value da placebo: le date degli eventi vengono traslate rigidamente nel tempo (traslazione circolare di
    tutte le possibili ampiezze ≥ 30 giorni): la struttura degli eventi (spaziatura, stagionalità, raggruppamenti)
    e quella dei rendimenti (volatilità a grappoli, trend) restano intatte, si rompe solo l'allineamento.
    p = quota di traslazioni con |effetto| ≥ |effetto osservato| (bilaterale).
  - Intervallo di confidenza 95%: bootstrap degli eventi (o a blocchi di 30 giorni per i periodi).
  - Correzione per test multipli: Benjamini-Hochberg su tutte le ipotesi della pagina.
  - Stabilità: stesso segno nella prima e nella seconda metà del campione e in almeno il 75% dei cicli dell'halving
    con ≥ 3 eventi.
  - Verdetto (calcolato): n < 12 → "aneddotico"; p BH < 0.05 e stabile → "significativo e stabile";
    p < 0.05 oppure p BH < 0.05 ma instabile → "debole e instabile"; altrimenti "nessun effetto distinguibile dal caso".
Numeri: livelli tondi / Gann confrontati con griglie identiche ma sfasate a caso; Fibonacci con insiemi di rapporti casuali.
"""
from __future__ import annotations

import json
import logging
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store
from . import astro_calendar as ac
from . import market as mk
from .cycles import HALVINGS

log = logging.getLogger("astro")
DAY = pd.Timedelta(days=1)
SAMPLE_START = pd.Timestamp("2012-01-01", tz="UTC")
MIN_SHIFT = 30
N_BOOT = 2000
N_CTRL = 1000
SEED = 20261013
ALPHA = 0.05
MIN_N = 12
VERIFICATION_FILE = Path(__file__).with_name("astro_verification.json")


def rnd(x, d: int = 3):
    x = util.num(x)
    return None if x is None else round(x, d)


# =============================================================== dati geomagnetici e solari (GFZ Potsdam + NOAA)

GFZ_ALL = "https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt"
GFZ_NOW = "https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_nowcast.txt"


def _parse_gfz(txt: str) -> pd.DataFrame:
    rows = []
    for ln in txt.splitlines():
        if not ln or ln[0] == "#":
            continue
        f = ln.split()
        if len(f) < 28 or int(f[0]) < 2009:
            continue
        kp = [float(x) for x in f[7:15]]
        kp_ok = [k for k in kp if k >= 0]
        rows.append({"time": pd.Timestamp(year=int(f[0]), month=int(f[1]), day=int(f[2]), tz="UTC"),
                     "kp_max": max(kp_ok) if kp_ok else np.nan, "kp_sum": sum(kp_ok) if len(kp_ok) == 8 else np.nan,
                     "ap": float(f[23]) if float(f[23]) >= 0 else np.nan, "sn": float(f[24]) if float(f[24]) >= 0 else np.nan,
                     "f107": float(f[25]) if float(f[25]) > 0 else np.nan, "definitive": int(f[27])})
    return pd.DataFrame(rows)


def _gfz(old: pd.DataFrame | None) -> pd.DataFrame:
    full = old is None or old.empty or len(old) < 1000
    txt = src._client.get(GFZ_ALL if full else GFZ_NOW).text
    new = _parse_gfz(txt)
    if new.empty:
        raise RuntimeError("file GFZ vuoto")
    if full:
        return new
    out = pd.concat([old, new]).drop_duplicates("time", keep="last").sort_values("time")
    return out.reset_index(drop=True)


store.register("astro_gfz", _gfz, 6 * 3600)


@util.ttl_cache(900)
def noaa_kp() -> dict:
    """Kp osservato (ultimi giorni) e previsione a 3 giorni di NOAA SWPC."""
    out: dict = {"recent": [], "forecast": []}
    try:
        rows = src._get("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json")
        for r in rows:
            if isinstance(r, dict):
                t, kp, obs = r.get("time_tag"), r.get("kp"), r.get("observed")
            else:   # vecchio formato: lista di liste con intestazione
                if r[0] == "time_tag":
                    continue
                t, kp, obs = r[0], r[1], r[2]
            item = {"time": util.ts(pd.Timestamp(t, tz="UTC")), "kp": util.num(kp)}
            (out["forecast"] if obs == "predicted" else out["recent"]).append(item)
    except Exception as e:  # noqa: BLE001
        log.warning("Kp NOAA non disponibile: %s", e)
    return out


@util.ttl_cache(12 * 3600)
def noaa_ssn_prediction() -> list[dict]:
    try:
        rows = src._get("https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json")
        out = []
        for r in rows:
            t = pd.Timestamp(r["time-tag"] + "-01", tz="UTC")
            out.append({"time": util.ts(t), "ssn": util.num(r.get("predicted_ssn")),
                        "lo": util.num(r.get("low_ssn")), "hi": util.num(r.get("high_ssn"))})
        return out
    except Exception as e:  # noqa: BLE001
        log.warning("previsione ciclo solare NOAA non disponibile: %s", e)
        return []


# =============================================================== serie dei rendimenti

class Series:
    """Rendimenti giornalieri (log, %) dal SAMPLE_START a ieri, con somme cumulate per finestre rapide."""

    def __init__(self, g, start: pd.Timestamp = SAMPLE_START):
        i0 = g.pos(start)
        i1 = g.last - 1                       # escludo la candela di oggi (incompleta)
        self.idx = g.idx[i0:i1 + 1]
        c = g.close[i0 - 1:i1 + 1]
        self.r = np.diff(np.log(c)) * 100
        self.close = g.close[i0:i1 + 1]
        self.high = g.high[i0:i1 + 1]
        self.low = g.low[i0:i1 + 1]
        self.prev = g.close[i0 - 1:i1]
        self.N = len(self.r)
        self.cs = np.concatenate([[0.0], np.cumsum(self.r)])
        self.cs_abs = np.concatenate([[0.0], np.cumsum(np.abs(self.r))])
        self.start, self.end = self.idx[0], self.idx[-1]
        mid = self.N // 2
        self.halves = [(0, mid - 1), (mid, self.N - 1)]
        self.cycles = self._cycles()

    def _cycles(self) -> list[tuple[str, int, int]]:
        bounds = [self.start] + [h[1] for h in HALVINGS[1:]] + [self.end + DAY]
        labels = ["2012", "2016", "2020", "2024"]
        out = []
        for lab, a, b in zip(labels, bounds[:-1], bounds[1:]):
            pa, pb = max(0, self.pos(a)), min(self.N - 1, self.pos(b) - 1)
            if pb > pa:
                out.append((lab, pa, pb))
        return out

    def pos(self, t: pd.Timestamp) -> int:
        return int((pd.Timestamp(t).normalize() - self.start) / DAY)

    def positions(self, dates) -> np.ndarray:
        P = np.array(sorted({self.pos(t) for t in dates}), int)
        return P[(P >= 0) & (P < self.N)]

    def win(self, a: int, b: int) -> np.ndarray:
        """W[p] = somma dei rendimenti dei giorni p+a..p+b (NaN se la finestra esce dal campione)."""
        W = np.full(self.N, np.nan)
        lo, hi = max(0, -a), min(self.N, self.N - b)
        p = np.arange(lo, hi)
        W[lo:hi] = self.cs[p + b + 1] - self.cs[p + a]
        return W

    def win_abs(self, a: int, b: int) -> np.ndarray:
        W = np.full(self.N, np.nan)
        lo, hi = max(0, -a), min(self.N, self.N - b)
        p = np.arange(lo, hi)
        W[lo:hi] = (self.cs_abs[p + b + 1] - self.cs_abs[p + a]) / (b - a + 1)
        return W

    def win_dd(self, a: int, b: int) -> np.ndarray:
        """Massimo drawdown (%) dentro la finestra, misurato dalla chiusura precedente alla finestra."""
        L = b - a + 1
        W = np.full(self.N, np.nan)
        lo, hi = max(0, -a), min(self.N, self.N - b)
        if hi <= lo:
            return W
        sw = np.lib.stride_tricks.sliding_window_view(self.r, L)      # sw[j] = r[j..j+L-1]
        cum = np.cumsum(sw, axis=1)
        peak = np.maximum.accumulate(np.concatenate([np.zeros((len(cum), 1)), cum], axis=1), axis=1)[:, 1:]
        dd = (np.exp((cum - peak).min(axis=1) / 100) - 1) * 100
        W[lo:hi] = dd[lo + a:hi + a]
        return W


def _shift_null(Wv: np.ndarray, q: np.ndarray, step: int = 1) -> np.ndarray:
    """Media dei valori Wv agli indici q traslati di ogni ampiezza ammessa (circolare). Esaustivo."""
    L = len(Wv)
    shifts = np.arange(MIN_SHIFT, L - MIN_SHIFT)
    if step > 1:
        shifts = shifts[shifts % step == 0]
    out = np.empty(len(shifts))
    for i in range(0, len(shifts), 512):
        s = shifts[i:i + 512]
        out[i:i + 512] = np.nanmean(Wv[(q[None, :] + s[:, None]) % L], axis=1)
    return out


def _pval(null: np.ndarray, obs: float) -> float:
    null = null[np.isfinite(null)]
    return float((1 + np.sum(np.abs(null) >= abs(obs) - 1e-12)) / (1 + len(null)))


def _stable(effect: float | None, halves: list[dict], cycles: list[dict]) -> bool:
    if effect is None or not np.isfinite(effect) or effect == 0:
        return False
    s = np.sign(effect)
    hs = [h for h in halves if h["effect"] is not None and h["n"] >= 3]
    if len(hs) < 2 or any(np.sign(h["effect"]) != s for h in hs):
        return False
    cs = [c for c in cycles if c["effect"] is not None and c["n"] >= 3]
    if cs and sum(np.sign(c["effect"]) == s for c in cs) / len(cs) < 0.75:
        return False
    return True


def event_test(S: Series, dates, a: int, b: int, step: int = 1, rng=None) -> dict:
    """Studio di evento con placebo a traslazione e bootstrap degli eventi."""
    rng = rng or np.random.default_rng(SEED)
    W = S.win(a, b)
    A = S.win_abs(a, b)
    D = S.win_dd(a, b)
    P = S.positions(dates)
    P = P[np.isfinite(W[P])]
    n = len(P)
    valid = np.flatnonzero(np.isfinite(W))
    base = float(np.nanmean(W))
    out: dict = {"n": n, "window": [a, b], "baseline": rnd(base), "unit": "%"}
    if n == 0:
        return out | {"effect": None, "p": None}
    vals = W[P]
    obs = float(vals.mean())
    eff = obs - base
    q = np.searchsorted(valid, P)
    null = _shift_null(W[valid], q, step) - base
    bs = rng.choice(vals, (N_BOOT, n)).mean(axis=1) - base
    vr = float(np.mean(A[P]) / np.nanmean(A))
    vnull = _shift_null(A[valid], q, step) / np.nanmean(A)
    vol_p = _pval(vnull - 1, vr - 1)

    def sub(p0: int, p1: int) -> dict:
        m = (P >= p0) & (P <= p1)
        if not m.any():
            return {"effect": None, "n": 0}
        return {"effect": rnd(np.mean(W[P[m]]) - np.nanmean(W[p0:p1 + 1])), "n": int(m.sum())}

    halves = [sub(*h) for h in S.halves]
    cycles = [{"label": lab, **sub(p0, p1)} for lab, p0, p1 in S.cycles]
    out.update({
        "observed": rnd(obs), "effect": rnd(eff), "ci": [rnd(np.percentile(bs, 2.5)), rnd(np.percentile(bs, 97.5))],
        "p": rnd(_pval(null, eff), 4), "null": {"q05": rnd(np.percentile(null, 5)), "q95": rnd(np.percentile(null, 95))},
        "vol_ratio": rnd(vr), "vol_p": rnd(vol_p, 4),
        "up_rate": rnd(np.mean(vals > 0) * 100, 1), "up_base": rnd(np.mean(W[valid] > 0) * 100, 1),
        "dd": rnd(np.nanmean(D[P]), 2), "dd_base": rnd(np.nanmean(D), 2),
        "median": rnd(np.median(vals)),
        "halves": halves, "cycles": cycles, "stable": _stable(eff, halves, cycles),
        "values": [{"time": util.ts(S.idx[p]), "ret": rnd(W[p], 2)} for p in P],
    })
    return out


def mask_test(S: Series, mask: np.ndarray, rng=None) -> dict:
    """Rendimento medio giornaliero dentro il periodo − fuori (in punti % al giorno). Placebo: traslazione circolare della maschera."""
    rng = rng or np.random.default_rng(SEED)
    r = S.r
    m = mask.astype(bool)
    n_in = int(m.sum())

    def diff(mm: np.ndarray, rr: np.ndarray) -> float:
        return float(rr[mm].mean() - rr[~mm].mean()) if mm.any() and (~mm).any() else np.nan

    eff = diff(m, r)
    # null esaustivo con FFT: somma dei rendimenti dentro la maschera traslata di s
    fr, fm = np.fft.rfft(r), np.fft.rfft(m.astype(float))
    ins = np.fft.irfft(np.conj(fm) * fr, n=S.N)          # ins[s] = Σ_j r[j]·m[j−s]
    tot = r.sum()
    shifts = np.arange(MIN_SHIFT, S.N - MIN_SHIFT)
    null = ins[shifts] / n_in - (tot - ins[shifts]) / (S.N - n_in)
    # bootstrap a blocchi di 30 giorni
    B = 30
    nb = S.N // B
    starts = rng.integers(0, S.N - B, (N_BOOT, nb))
    idx = (starts[:, :, None] + np.arange(B)[None, None, :]).reshape(N_BOOT, -1)
    rb, mb = r[idx], m[idx]
    s_in = (rb * mb).sum(1)
    c_in = mb.sum(1)
    bs = s_in / np.maximum(c_in, 1) - (rb.sum(1) - s_in) / np.maximum(idx.shape[1] - c_in, 1)

    def sub(p0: int, p1: int) -> dict:
        mm = m[p0:p1 + 1]
        return {"effect": rnd(diff(mm, r[p0:p1 + 1]), 4), "n": int(mm.sum())}

    halves = [sub(*h) for h in S.halves]
    cycles = [{"label": lab, **sub(p0, p1)} for lab, p0, p1 in S.cycles]
    absr = np.abs(r)
    vr = float(absr[m].mean() / absr[~m].mean())
    a_ins = np.fft.irfft(np.conj(fm) * np.fft.rfft(absr), n=S.N)
    vnull = (a_ins[shifts] / n_in) / ((absr.sum() - a_ins[shifts]) / (S.N - n_in))
    # per i periodi "n" = giorni nel periodo; gli episodi indipendenti sono molti meno (riportati a parte)
    return {"n": n_in, "unit": "pp/g", "observed": rnd(r[m].mean(), 4), "baseline": rnd(r[~m].mean(), 4),
            "effect": rnd(eff, 4), "ci": [rnd(np.percentile(bs, 2.5), 4), rnd(np.percentile(bs, 97.5), 4)],
            "p": rnd(_pval(null, eff), 4), "null": {"q05": rnd(np.percentile(null, 5), 4), "q95": rnd(np.percentile(null, 95), 4)},
            "vol_ratio": rnd(vr), "vol_p": rnd(_pval(vnull - 1, vr - 1), 4),
            "up_rate": rnd(np.mean(r[m] > 0) * 100, 1), "up_base": rnd(np.mean(r[~m] > 0) * 100, 1),
            "halves": halves, "cycles": cycles, "stable": _stable(eff, halves, cycles), "window": None}


def bh(pvals: list[float | None]) -> list[float | None]:
    """Benjamini-Hochberg (FDR): p corretti, monotoni, ≤ 1."""
    idx = [i for i, p in enumerate(pvals) if p is not None]
    m = len(idx)
    out: list[float | None] = [None] * len(pvals)
    if not m:
        return out
    order = sorted(idx, key=lambda i: pvals[i])
    adj = [0.0] * m
    prev = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        prev = min(prev, pvals[i] * m / rank)
        adj[rank - 1] = prev
    for k, i in enumerate(order):
        out[i] = round(min(1.0, adj[k]), 4)
    return out


def verdict(h: dict) -> str:
    if h.get("p") is None:
        return "none"
    if (h.get("n_events") or h.get("n") or 0) < MIN_N:
        return "anecdotal"
    if (h.get("p_bh") or 1) < ALPHA and h.get("stable"):
        return "strong"
    if h["p"] < ALPHA or (h.get("p_bh") or 1) < ALPHA:
        return "weak"
    return "none"


# =============================================================== Luna

def lunar_profile(S: Series, elong: np.ndarray) -> list[dict]:
    """Rendimento medio giornaliero per giorno del ciclo sinodico (30 classi di 12°) con banda placebo 5–95%."""
    bins = np.floor((elong % 360) / 12).astype(int)
    r = S.r
    out = []
    sums = np.bincount(bins, weights=r, minlength=30)
    cnt = np.bincount(bins, minlength=30)
    rng = np.random.default_rng(SEED)
    shifts = rng.integers(MIN_SHIFT, S.N - MIN_SHIFT, 1000)
    nulls = np.empty((len(shifts), 30))
    for i, s in enumerate(shifts):
        nulls[i] = np.bincount(bins, weights=np.roll(r, s), minlength=30) / np.maximum(cnt, 1)
    for k in range(30):
        v = r[bins == k]
        se = v.std(ddof=1) / math.sqrt(len(v)) if len(v) > 1 else np.nan
        mean = sums[k] / max(cnt[k], 1)
        out.append({"day": k, "deg": k * 12 + 6, "mean": rnd(mean, 4), "lo": rnd(mean - 1.96 * se, 4), "hi": rnd(mean + 1.96 * se, 4),
                    "placebo_lo": rnd(np.percentile(nulls[:, k], 5), 4), "placebo_hi": rnd(np.percentile(nulls[:, k], 95), 4),
                    "n": int(cnt[k])})
    return out


def event_path(S: Series, dates, k: int = 7) -> list[dict]:
    """Percorso medio cumulato (%) da d−k a d+k rispetto alla chiusura di d−k−1, con banda placebo 5–95%."""
    P = S.positions(dates)
    P = P[(P - k >= 0) & (P + k < S.N)]
    if not len(P):
        return []
    L = S.N - 2 * k
    q = P - k
    rng = np.random.default_rng(SEED)
    shifts = rng.integers(MIN_SHIFT, L - MIN_SHIFT, 1000)
    out = []
    for j in range(-k, k + 1):
        V = S.cs[np.arange(k, S.N - k) + j + 1] - S.cs[np.arange(k, S.N - k) - k]   # per ogni p valido
        V = (np.exp(V / 100) - 1) * 100
        obs = V[q].mean()
        null = V[(q[None, :] + shifts[:, None]) % L].mean(1)
        out.append({"day": j, "mean": rnd(obs), "placebo_lo": rnd(np.percentile(null, 5)), "placebo_hi": rnd(np.percentile(null, 95)),
                    "placebo_mid": rnd(np.median(null))})
    return out


# =============================================================== Numeri: livelli e Fibonacci

def _grid_levels(c0: np.ndarray, step: np.ndarray, u: np.ndarray, sqrt: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Primo livello sopra e sotto la chiusura precedente per griglie L = step·(m + u) (u: matrice G×1)."""
    x = np.sqrt(c0) if sqrt else c0
    up = step * (np.floor(x / step - u) + 1 + u)
    dn = step * (np.ceil(x / step - u) - 1 + u)
    if sqrt:
        return up ** 2, dn ** 2
    return up, dn


def level_test(S: Series, kind: str, rng=None) -> dict:
    """Tasso di rifiuto ai livelli: il massimo (minimo) del giorno tocca il primo livello sopra (sotto) la chiusura
    precedente ma la chiusura resta dal lato di partenza. Livelli tondi/Gann vs N_CTRL griglie identiche sfasate a caso."""
    rng = rng or np.random.default_rng(SEED)
    ok = (S.high > S.low) & np.isfinite(S.prev)
    p_idx = np.flatnonzero(ok)
    c0, h, l, c = S.prev[ok], S.high[ok], S.low[ok], S.close[ok]
    sqrt = kind == "gann_sq9"
    if kind == "round_major":
        step = 10.0 ** np.floor(np.log10(c0)) * 0.5
    elif kind == "round_minor":
        step = 10.0 ** np.floor(np.log10(c0)) * 0.1
    else:
        step = np.full_like(c0, 2.0)                     # Quadrato del 9: un giro completo = +2 sulla radice del prezzo
    U = np.concatenate([[0.0], rng.uniform(0.1, 0.9, N_CTRL)])[:, None]
    up, dn = _grid_levels(c0[None, :], step[None, :], U, sqrt)
    t_up, t_dn = h[None, :] >= up, l[None, :] <= dn
    r_up, r_dn = t_up & (c[None, :] < up), t_dn & (c[None, :] > dn)
    touches = t_up.astype(int) + t_dn.astype(int)
    rejects = r_up.astype(int) + r_dn.astype(int)

    def rate(cols: np.ndarray | slice) -> np.ndarray:
        T = touches[:, cols].sum(1)
        return rejects[:, cols].sum(1) / np.maximum(T, 1) * 100

    rates = rate(slice(None))
    obs, ctrl = rates[0], rates[1:]
    eff = obs - ctrl.mean()
    # bootstrap sui giorni con tocco del livello tondo
    td = np.flatnonzero(touches[0] > 0)
    bi = rng.integers(0, len(td), (N_BOOT, len(td)))
    bs = rejects[0, td][bi].sum(1) / touches[0, td][bi].sum(1) * 100 - ctrl.mean()

    def sub(p0: int, p1: int) -> dict:
        cols = (p_idx >= p0) & (p_idx <= p1)
        rr = rate(cols)
        return {"effect": rnd(rr[0] - rr[1:].mean(), 2), "n": int(touches[0, cols].sum())}

    halves = [sub(*hh) for hh in S.halves]
    cycles = [{"label": lab, **sub(p0, p1)} for lab, p0, p1 in S.cycles]
    hist, edges = np.histogram(ctrl - ctrl.mean(), bins=24)
    return {"n": int(touches[0].sum()), "unit": "pp", "observed": rnd(obs, 2), "baseline": rnd(ctrl.mean(), 2),
            "effect": rnd(eff, 2), "ci": [rnd(np.percentile(bs, 2.5), 2), rnd(np.percentile(bs, 97.5), 2)],
            "p": rnd(_pval(ctrl - ctrl.mean(), eff), 4),
            "null": {"q05": rnd(np.percentile(ctrl - ctrl.mean(), 5), 2), "q95": rnd(np.percentile(ctrl - ctrl.mean(), 95), 2)},
            "halves": halves, "cycles": cycles, "stable": _stable(eff, halves, cycles), "window": None,
            "control_hist": [{"x": rnd((edges[i] + edges[i + 1]) / 2, 2), "n": int(hist[i])} for i in range(len(hist))],
            "touch_days": int(len(td))}


FIB_PRICE = [0.236, 0.382, 0.5, 0.618, 0.786]
FIB_TIME = [0.382, 0.618, 1.0, 1.618, 2.618]


def _swings(S: Series) -> list[dict]:
    df = pd.DataFrame({"time": S.idx, "high": S.high, "low": S.low, "close": S.close})
    zz = mk.zigzag(df, mult=3.0, atr_n=14)
    piv = []
    for p in zz:
        if p.get("open"):
            continue
        i = p["i"]
        piv.append({"i": i, "kind": p["kind"], "price": S.high[i] if p["kind"] == "high" else S.low[i]})
    return piv


def _random_sets(rng, lo: float, hi: float, k: int, min_gap: float, n: int) -> np.ndarray:
    out = []
    while len(out) < n:
        s = np.sort(rng.uniform(lo, hi, k))
        if np.all(np.diff(s) >= min_gap):
            out.append(s)
    return np.array(out)


def fib_test(S: Series, kind: str, rng=None) -> dict:
    """Quota di ritracciamenti (prezzo) o rapporti di durata (tempo) entro la tolleranza da un rapporto di Fibonacci,
    contro N_CTRL insiemi di 5 rapporti casuali con spaziatura minima simile."""
    rng = rng or np.random.default_rng(SEED)
    piv = _swings(S)
    ratios, times = [], []
    for A, B, C in zip(piv, piv[1:], piv[2:]):
        if kind == "fib_price":
            leg = abs(B["price"] - A["price"])
            if leg <= 0:
                continue
            x = abs(C["price"] - B["price"]) / leg
            if 0 < x < 1:
                ratios.append(x)
                times.append(C["i"])
        else:
            t1, t2 = B["i"] - A["i"], C["i"] - B["i"]
            if t1 > 0 and t2 > 0:
                ratios.append(t2 / t1)
                times.append(C["i"])
    x = np.array(ratios)
    ti = np.array(times)
    if kind == "fib_price":
        fib = np.array(FIB_PRICE)
        ctrl = _random_sets(rng, 0.15, 0.9, 5, 0.1, N_CTRL)
        dist = lambda v, s: np.min(np.abs(v[None, :, None] - s[:, None, :]), axis=2)  # noqa: E731
        tol = 0.025
        X = x
    else:
        fib = np.log(np.array(FIB_TIME))
        ctrl = _random_sets(rng, math.log(0.3), math.log(3.5), 5, 0.3, N_CTRL)
        dist = lambda v, s: np.min(np.abs(v[None, :, None] - s[:, None, :]), axis=2)  # noqa: E731
        tol = math.log(1.08)
        X = np.log(x)
    sets = np.vstack([fib[None, :], ctrl])
    hits = dist(X, sets) <= tol                          # (1+N_CTRL) × n
    rates = hits.mean(1) * 100
    obs, cr = rates[0], rates[1:]
    eff = obs - cr.mean()
    bi = rng.integers(0, len(X), (N_BOOT, len(X)))
    bs = hits[0][bi].mean(1) * 100 - cr.mean()

    def sub(p0: int, p1: int) -> dict:
        m = (ti >= p0) & (ti <= p1)
        if not m.any():
            return {"effect": None, "n": 0}
        rr = hits[:, m].mean(1) * 100
        return {"effect": rnd(rr[0] - rr[1:].mean(), 2), "n": int(m.sum())}

    halves = [sub(*hh) for hh in S.halves]
    cycles = [{"label": lab, **sub(p0, p1)} for lab, p0, p1 in S.cycles]
    if kind == "fib_price":
        hist, edges = np.histogram(x, bins=np.arange(0, 1.0001, 0.025))
        hx = [{"x": rnd((edges[i] + edges[i + 1]) / 2), "n": int(hist[i])} for i in range(len(hist))]
    else:
        e = np.linspace(math.log(0.1), math.log(10), 41)
        hist, _ = np.histogram(np.log(x), bins=e)
        hx = [{"x": rnd(math.exp((e[i] + e[i + 1]) / 2)), "n": int(hist[i])} for i in range(len(hist))]
    return {"n": int(len(X)), "unit": "pp", "observed": rnd(obs, 2), "baseline": rnd(cr.mean(), 2), "effect": rnd(eff, 2),
            "ci": [rnd(np.percentile(bs, 2.5), 2), rnd(np.percentile(bs, 97.5), 2)],
            "p": rnd(_pval(cr - cr.mean(), eff), 4),
            "null": {"q05": rnd(np.percentile(cr - cr.mean(), 5), 2), "q95": rnd(np.percentile(cr - cr.mean(), 95), 2)},
            "halves": halves, "cycles": cycles, "stable": _stable(eff, halves, cycles), "window": None,
            "ratios_hist": hx, "levels": FIB_PRICE if kind == "fib_price" else FIB_TIME, "tolerance": rnd(tol if kind == "fib_price" else 0.08)}


# =============================================================== Sole: ciclo solare vs BTC

def solar_cycle(S: Series, gfz: pd.DataFrame | None, g) -> tuple[dict | None, dict]:
    """Correlazione tra macchie solari (media mobile 13 mesi) e rendimento di BTC a 12 mesi, con placebo a traslazione."""
    info: dict = {"monthly": [], "cycles": [], "predicted": noaa_ssn_prediction()}
    if gfz is None or gfz.empty:
        return None, info
    sn = gfz.dropna(subset=["sn"]).set_index("time")["sn"]
    m = sn.resample("MS").mean()
    # media mobile centrata a 13 mesi con pesi 1/2 agli estremi (definizione SILSO)
    w = np.r_[0.5, np.ones(11), 0.5] / 12
    smooth = pd.Series(np.convolve(m.values, w, mode="same"), index=m.index)
    smooth.iloc[:6] = np.nan
    smooth.iloc[-6:] = np.nan
    close = pd.Series(g.close, index=g.idx)
    mclose = close.resample("MS").last()        # chiusura dell'ultimo giorno del mese (etichetta = inizio mese)
    ret12 = np.log(mclose / mclose.shift(12)) * 100
    df = pd.DataFrame({"ssn": m, "smooth": smooth, "close": mclose, "ret12": ret12})
    df = df[df.index >= pd.Timestamp("2010-01-01", tz="UTC")]
    for t, r in df.iterrows():
        info["monthly"].append({"time": util.ts(t), "ssn": rnd(r["ssn"], 1), "smooth": rnd(r["smooth"], 1),
                                "close": rnd(r["close"], 2), "ret12": rnd(r["ret12"], 1)})
    # massimi/minimi del ciclo solare (dalla media a 13 mesi) e picchi di BTC per ciclo dell'halving
    sm = smooth.dropna()
    sm = sm[sm.index >= pd.Timestamp("2008-01-01", tz="UTC")]
    if len(sm):
        info["solar_extrema"] = []
        for a, b, kind in (("2008-01-01", "2010-06-01", "min"), ("2012-01-01", "2016-01-01", "max"), ("2018-01-01", "2021-06-01", "min"),
                           ("2023-01-01", "2026-01-01", "max")):
            seg = sm[(sm.index >= pd.Timestamp(a, tz="UTC")) & (sm.index < pd.Timestamp(b, tz="UTC"))]
            if len(seg) < 6:
                continue
            t = seg.idxmin() if kind == "min" else seg.idxmax()
            info["solar_extrema"].append({"kind": kind, "time": util.ts(t), "ssn": rnd(seg.loc[t], 1)})
    peaks = []   # picco di ciclo = massima chiusura entro 600 giorni dall'halving (i top storici cadono 12–18 mesi dopo)
    for _, a, _b in HALVINGS:
        seg = close[(close.index >= a) & (close.index < a + pd.Timedelta(days=600))]
        if len(seg):
            peaks.append({"time": util.ts(seg.idxmax()), "price": rnd(seg.max(), 0)})
    info["btc_peaks"] = peaks
    d = df.dropna(subset=["smooth", "ret12"])
    d = d[d.index >= SAMPLE_START]
    n = len(d)
    if n < 36:
        return None, info
    x, y = d["smooth"].values, d["ret12"].values
    corr = float(np.corrcoef(x, y)[0, 1])
    shifts = np.arange(12, n - 12)
    null = np.array([np.corrcoef(x, np.roll(y, s))[0, 1] for s in shifts])
    from scipy import stats as sst
    naive_p = float(sst.pearsonr(x, y).pvalue)
    rng = np.random.default_rng(SEED)
    B = 24
    bs = []
    for _ in range(N_BOOT):
        st = rng.integers(0, n - B, n // B + 1)
        ii = (st[:, None] + np.arange(B)[None, :]).ravel()[:n]
        if np.std(x[ii]) > 0 and np.std(y[ii]) > 0:
            bs.append(np.corrcoef(x[ii], y[ii])[0, 1])
    half = n // 2
    halves = [{"effect": rnd(np.corrcoef(x[:half], y[:half])[0, 1]), "n": half},
              {"effect": rnd(np.corrcoef(x[half:], y[half:])[0, 1]), "n": n - half}]
    h = {"n": n, "unit": "r", "observed": rnd(corr), "baseline": 0.0, "effect": rnd(corr),
         "ci": [rnd(np.percentile(bs, 2.5)), rnd(np.percentile(bs, 97.5))], "p": rnd(_pval(null, corr), 4),
         "naive_p": rnd(naive_p, 6), "null": {"q05": rnd(np.percentile(null, 5)), "q95": rnd(np.percentile(null, 95))},
         "halves": halves, "cycles": [], "stable": _stable(corr, halves, []), "window": None,
         "solar_cycles_in_sample": rnd(n / 132, 1)}
    return h, info


# =============================================================== Numeri di Bitcoin (fatti verificabili)

def issued_supply(height: int) -> float:
    """Emissione teorica programmata fino al blocco `height` incluso (regole di consenso: 50 BTC, dimezzamento ogni 210,000 blocchi,
    arrotondamento al satoshi). Non sottrae le monete perse o mai riscosse (es. genesi non spendibile)."""
    sats, sub, h = 0, 50 * 10 ** 8, height + 1
    while h > 0 and sub > 0:
        k = min(h, 210_000)
        sats += k * sub
        h -= k
        sub //= 2
    return sats / 1e8


def milestones(g) -> dict:
    close = pd.Series(g.close, index=g.idx)
    high = pd.Series(g.high, index=g.idx)
    levels = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000]
    first = []
    prev_t = None
    for L in levels:
        hit = close[close >= L]
        if not len(hit):
            first.append({"level": L, "time": None, "days_from_prev": None})
            continue
        t = hit.index[0]
        first.append({"level": L, "time": util.ts(t), "days_from_prev": int((t - prev_t) / DAY) if prev_t is not None else None})
        prev_t = t
    rep = []
    for digits in range(2, 7):
        for d in range(1, 10):
            L = int(str(d) * digits)
            hit = high[high >= L]
            rep.append({"level": L, "time": util.ts(hit.index[0]) if len(hit) else None})
    rep = [r for r in rep if r["level"] >= 11]
    # date palindrome (GGMMAAAA) nella storia del prezzo, con il rendimento nei 30 giorni successivi
    pal = []
    d = pd.Timestamp("2010-07-18", tz="UTC")
    end = g.idx[-1]
    while d <= end + pd.Timedelta(days=3650):
        s = d.strftime("%d%m%Y")
        if s == s[::-1]:
            item = {"time": util.ts(d), "price": None, "ret30": None, "future": bool(d > end)}
            if d <= end:
                p = int((d - g.idx[0]) / DAY)
                item["price"] = rnd(g.close[p], 2)
                if p + 30 <= g.last:
                    item["ret30"] = rnd((g.close[p + 30] / g.close[p] - 1) * 100, 1)
            pal.append(item)
        d += DAY
    return {"powers": first, "repdigits": rep, "palindromes": pal}


# =============================================================== build

HYP_META = {   # id -> (gruppo, metrica)
    "moon_full": ("luna", "window_ret"), "moon_new": ("luna", "window_ret"), "moon_halves": ("luna", "daily_diff"),
    "supermoon": ("eclissi", "window_ret"), "lunar_eclipse_total": ("eclissi", "window_ret"),
    "lunar_eclipse_all": ("eclissi", "window_ret"), "solar_eclipse": ("eclissi", "window_ret"),
    "mercury_retro": ("pianeti", "daily_diff"), "seasons": ("pianeti", "window_ret"), "friday13": ("numeri", "window_ret"),
    "geomag_storm": ("sole", "window_ret"), "solar_cycle": ("sole", "corr"),
    "round_major": ("numeri", "reject_rate"), "round_minor": ("numeri", "reject_rate"), "gann_sq9": ("numeri", "reject_rate"),
    "fib_price": ("numeri", "hit_rate"), "fib_time": ("numeri", "hit_rate"),
}


def _safe(name: str):
    try:
        return store.get(name)
    except Exception as e:  # noqa: BLE001
        log.warning("dataset %s non disponibile: %s", name, e)
        return None


def compute(g) -> dict:
    """Parte pesante (cache giornaliera): calendari storici, test di tutte le ipotesi, profili."""
    t0 = time.time()
    S = Series(g)
    y0, y1 = 2010, pd.Timestamp.now(tz="UTC").year + 1
    q = ac.moon_quarters(y0, y1)
    fulls = q[q["key"] == "full"]
    news = q[q["key"] == "new"]
    lun = ac.lunar_eclipses(y0, y1)
    sol = ac.solar_eclipses(y0, y1)
    seas = ac.seasons(y0, y1)
    merc = ac.mercury_periods(y0, y1)
    f13 = ac.friday13(y0, y1)
    elong = ac.elongation_daily(S.idx)
    gfz = _safe("astro_gfz")

    H: dict[str, dict] = {}
    H["moon_full"] = event_test(S, fulls["time"], -3, 3)
    H["moon_new"] = event_test(S, news["time"], -3, 3)
    new_half = (elong >= 270) | (elong < 90)
    H["moon_halves"] = mask_test(S, new_half)
    H["moon_halves"]["n_events"] = int(len(news[(news["time"] >= S.start) & (news["time"] <= S.end)]))
    H["supermoon"] = event_test(S, fulls[fulls["supermoon"]]["time"], -3, 3)
    H["lunar_eclipse_total"] = event_test(S, [e["time"] for e in lun if e["kind"] == "total"], -3, 3)
    H["lunar_eclipse_all"] = event_test(S, [e["time"] for e in lun], -3, 3)
    H["solar_eclipse"] = event_test(S, [e["time"] for e in sol], -3, 3)
    mask = np.zeros(S.N, bool)
    n_ep = 0
    for p in merc:
        a, b = S.pos(p["start"]), S.pos(p["end"])
        if b < 0 or a >= S.N:
            continue
        mask[max(0, a):min(S.N, b + 1)] = True
        n_ep += 1
    H["mercury_retro"] = mask_test(S, mask)
    H["mercury_retro"]["n_events"] = n_ep
    H["seasons"] = event_test(S, [s["time"] for s in seas], -3, 3)
    H["friday13"] = event_test(S, f13, 0, 0, step=7)
    storms = []
    if gfz is not None and len(gfz):
        gz = gfz.dropna(subset=["kp_max"]).set_index("time")["kp_max"]
        storm_days = gz[gz >= 5.0].index
        last = None
        for t in storm_days:
            if last is None or (t - last) > pd.Timedelta(days=7):
                storms.append(t)
            last = t
        H["geomag_storm"] = event_test(S, storms, 1, 6)
    sc, solar_info = solar_cycle(S, gfz, g)
    if sc:
        H["solar_cycle"] = sc
    for k in ("round_major", "round_minor", "gann_sq9"):
        H[k] = level_test(S, k)
    for k in ("fib_price", "fib_time"):
        H[k] = fib_test(S, k)

    ids = [k for k in HYP_META if k in H]
    padj = bh([H[k].get("p") for k in ids])
    hyps = []
    for k, pa in zip(ids, padj):
        h = H[k]
        h["p_bh"] = pa
        h["verdict"] = verdict(h)
        hyps.append({"id": k, "group": HYP_META[k][0], "metric": HYP_META[k][1], **h})

    # ---- profili lunari e percorsi
    profile = lunar_profile(S, elong)
    paths = {"full": event_path(S, fulls["time"]), "new": event_path(S, news["time"])}

    # ---- tabelle evento con rendimenti (per eclissi, superlune, Mercurio, stagioni)
    W3 = S.win(-3, 3)
    W30 = S.win(1, 30)

    def evrow(t) -> dict:
        p = S.pos(t)
        ok = 0 <= p < S.N
        return {"ret7": rnd(W3[p], 2) if ok else None, "ret30": rnd(W30[p], 2) if ok else None}

    lunar_rows = [{"time": util.ts(e["time"]), "kind": e["kind"], "obscuration": rnd(e["obscuration"]), "total_min": rnd(e["total_min"], 0),
                   **evrow(e["time"])} for e in lun]
    solar_rows = [{"time": util.ts(e["time"]), "kind": e["kind"], "obscuration": rnd(e["obscuration"]), "lat": rnd(e["lat"], 1),
                   "lon": rnd(e["lon"], 1), **evrow(e["time"])} for e in sol]
    super_rows = [{"time": util.ts(r.time), "distance_km": rnd(r.distance_km, 0), **evrow(r.time)} for r in fulls[fulls["supermoon"]].itertuples()]
    merc_rows = []
    for p in merc:
        a, b = S.pos(p["start"]), S.pos(p["end"])
        ret = None
        if 0 <= a and b < S.N:
            ret = rnd((math.exp((S.cs[b + 1] - S.cs[a]) / 100) - 1) * 100, 2)
        merc_rows.append({"start": util.ts(p["start"]), "end": util.ts(p["end"]), "ret": ret,
                          "days": rnd((p["end"] - p["start"]) / DAY, 1)})
    season_rows = [{"time": util.ts(s["time"]), "key": s["key"], **evrow(s["time"])} for s in seas]
    storm_rows = []
    if gfz is not None and len(gfz):
        W6 = S.win(1, 6)
        gzi = gfz.set_index("time")
        for t in storms[-60:]:
            p = S.pos(t)
            storm_rows.append({"time": util.ts(t), "kp": rnd(gzi.loc[t, "kp_max"], 2), "ap": rnd(gzi.loc[t, "ap"], 0),
                               "ret6": rnd(W6[p], 2) if 0 <= p < S.N else None})
    # tempeste per anno (contesto del ciclo solare)
    storms_year = []
    if gfz is not None and len(gfz):
        gy = gfz.dropna(subset=["kp_max"])
        for y, grp in gy.groupby(gy["time"].dt.year):
            storms_year.append({"year": int(y), "days_g1": int((grp["kp_max"] >= 5).sum()), "days_g3": int((grp["kp_max"] >= 7).sum())})

    # ---- marcatori storici delle fasi per il grafico dei prezzi
    moon_events = [{"time": util.ts(r.time), "key": r.key, "supermoon": bool(r.supermoon)}
                   for r in q[q["key"].isin(["full", "new"])].itertuples() if S.start <= r.time <= S.end + 2 * DAY]
    log.info("astro: studio calcolato in %.1fs", time.time() - t0)
    return {
        "sample": {"start": util.ts(S.start), "end": util.ts(S.end), "days": S.N,
                   "cycles": [{"label": lab, "start": util.ts(S.idx[a]), "end": util.ts(S.idx[b])} for lab, a, b in S.cycles]},
        "hypotheses": hyps,
        "moon": {"profile": profile, "paths": paths, "events": moon_events},
        "eclipses": {"lunar": lunar_rows, "solar": solar_rows}, "supermoons": super_rows,
        "mercury": {"periods": merc_rows}, "seasons": season_rows,
        "solar": solar_info, "geomag": {"storms": storm_rows, "storms_year": storms_year, "threshold": 5.0},
        "numbers": {"milestones": milestones(g)},
    }


def load_verification() -> dict | None:
    try:
        return json.loads(VERIFICATION_FILE.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        log.warning("verifica astronomica non leggibile: %s", e)
        return None
