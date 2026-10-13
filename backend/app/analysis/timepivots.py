"""Pivot temporali di Bitcoin (pura computazione, nessun I/O).

- stagionalità: mese×anno, trimestri, settimana dell'anno, giorno della settimana/mese, ora UTC, sessioni,
  anno del ciclo dell'halving × mese
- finestre ricorrenti di inversione ("date pivot"): per ogni giorno dell'anno, comportamento nei K giorni
  prima/dopo in ogni anno + presenza di swing (zigzag ATR) entro ±N giorni; test binomiale contro il tasso base
- pivot di ciclo: giorni dall'halving / minimo / massimo dei cicli passati -> date proiettate (adattive)
- proiezioni temporali dagli swing recenti: Fibonacci time zones, gambe di uguale durata, spaziatura mediana
- eventi ricorrenti: apertura/chiusura mese e trimestre, metà mese, weekend (gap CME), scadenze opzioni, FOMC
- calendario unificato con punteggio di confluenza
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from .. import util
from . import cycles as cy
from . import market as mk

DAY = pd.Timedelta(days=1)
MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre",
        "ottobre", "novembre", "dicembre"]
MESI_BREVI = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"]
GIORNI = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"]
GIORNI_BREVI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"]
CYCLE_YEAR_LABELS = ["Anno dell'halving", "Anno post-halving", "Anno di mid-cycle", "Anno pre-halving"]
CYCLE_YEAR_SHORT = ["Anno 0 · halving", "Anno 1 · post-halving", "Anno 2 · mid-cycle", "Anno 3 · pre-halving"]

# Date delle decisioni FOMC (giorno del comunicato, ora USA). 2020: incluse le riunioni d'emergenza.
FOMC_DATES = [
    "2017-02-01", "2017-03-15", "2017-05-03", "2017-06-14", "2017-07-26", "2017-09-20", "2017-11-01", "2017-12-13",
    "2018-01-31", "2018-03-21", "2018-05-02", "2018-06-13", "2018-08-01", "2018-09-26", "2018-11-08", "2018-12-19",
    "2019-01-30", "2019-03-20", "2019-05-01", "2019-06-19", "2019-07-31", "2019-09-18", "2019-10-30", "2019-12-11",
    "2020-01-29", "2020-03-03", "2020-03-15", "2020-04-29", "2020-06-10", "2020-07-29", "2020-09-16", "2020-11-05",
    "2020-12-16",
    "2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15",
    "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14",
    "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13",
    "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
    "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
    # calendario ufficiale 2026 pubblicato dalla Fed
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
]

ZZ_LEVELS = [(2.5, "minore"), (4.0, "medio"), (6.0, "forte")]  # sensibilità zigzag (multipli di ATR)
PARAMS = [(3, 7), (5, 14)]  # (N = ±giorni della finestra, K = giorni prima/dopo)
PATTERNS = {
    "rev_up": ("inversione_rialzista", "scendeva prima e poi è salito"),
    "rev_down": ("inversione_ribassista", "saliva e poi è sceso"),
    "up": ("rialzo", "è salito nei giorni successivi"),
    "down": ("ribasso", "è sceso nei giorni successivi"),
    "cont_up": ("rialzo", "continuazione rialzista"),
    "cont_down": ("ribasso", "continuazione ribassista"),
}
MOVE_TH = 1.0  # % minimo per considerare "salita"/"discesa" nelle inversioni


# ===================================================================== utilità

def rnd(x, d: int = 2):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, d)


def ts(t) -> int:
    return int(pd.Timestamp(t).timestamp())


def binom_sf(k: int, n: int, p: float) -> float:
    """P(X >= k) con X ~ Bin(n, p)."""
    if n <= 0:
        return 1.0
    if k <= 0:
        return 1.0
    p = min(max(p, 1e-9), 1 - 1e-9)
    return float(min(1.0, sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k, n + 1))))


def wilson_lb(k: int, n: int, z: float = 1.96) -> float:
    if n == 0:
        return 0.0
    ph = k / n
    den = 1 + z * z / n
    c = ph + z * z / (2 * n)
    a = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
    return (c - a) / den


def basic_stats(vals, labels=None) -> dict:
    v = np.asarray([x for x in vals if x is not None and not (isinstance(x, float) and math.isnan(x))], float)
    if len(v) == 0:
        return {"avg": None, "median": None, "win_rate": None, "n": 0, "std": None, "best": None, "worst": None}
    out = {"avg": rnd(v.mean()), "median": rnd(np.median(v)), "win_rate": rnd((v > 0).mean() * 100, 1),
           "n": int(len(v)), "std": rnd(v.std(ddof=0))}
    if labels is not None:
        pairs = [(lab, x) for lab, x in zip(labels, vals) if x is not None and not (isinstance(x, float) and math.isnan(x))]
        if pairs:
            b = max(pairs, key=lambda p: p[1])
            w = min(pairs, key=lambda p: p[1])
            out["best"] = {"year": b[0], "value": rnd(b[1])}
            out["worst"] = {"year": w[0], "value": rnd(w[1])}
    return out


def fmt_day_range(a: pd.Timestamp, b: pd.Timestamp) -> str:
    if a.month == b.month:
        return f"{a.day}–{b.day} {MESI[a.month - 1]}"
    return f"{a.day} {MESI[a.month - 1]} – {b.day} {MESI[b.month - 1]}"


def fmt_date(t: pd.Timestamp, year: bool = False) -> str:
    return f"{t.day} {MESI[t.month - 1]}" + (f" {t.year}" if year else "")


def cycle_year_idx(year: int) -> int:
    return (year - 2012) % 4


def confidence_label(p: float, n: int, rate: float) -> str:
    if p < 0.01 and n >= 8 and rate >= 0.7:
        return "alta"
    if p < 0.05 and n >= 6:
        return "media"
    return "bassa"


# ================================================================ stagionalità

def seasonality(close: pd.Series, k1d: pd.DataFrame | None, k1h: pd.DataFrame | None, now: pd.Timestamp) -> dict:
    close = close[close.index >= pd.Timestamp("2010-12-01", tz="UTC")]
    out: dict[str, Any] = {}

    # ------------------------------------------------ mese × anno
    me = close.resample("ME").last()
    mret = (me.pct_change() * 100).dropna()
    mret = mret[mret.index.year >= 2011]
    years = sorted(set(int(y) for y in mret.index.year))
    mat = [[None] * 12 for _ in years]
    for t, v in mret.items():
        mat[years.index(t.year)][t.month - 1] = rnd(v)
    cur_partial = (now.year, now.month)
    full = mret[~((mret.index.year == now.year) & (mret.index.month == now.month))]
    mstats = []
    for m in range(1, 13):
        s = full[full.index.month == m]
        st = basic_stats(s.values.tolist(), [int(y) for y in s.index.year])
        st.update({"month": m, "label": MESI_BREVI[m - 1]})
        mstats.append(st)
    ystats = []
    for y in years:
        row = mat[years.index(y)]
        vals = [x for x in row if x is not None]
        tot = None
        if vals:
            tot = (np.prod([1 + x / 100 for x in vals]) - 1) * 100
        ystats.append({"year": y, "total": rnd(tot, 1), "cycle_year": cycle_year_idx(y)})
    cur_val = mat[years.index(now.year)][now.month - 1] if now.year in years else None
    out["monthly"] = {"years": years, "matrix": mat, "stats": mstats, "year_totals": ystats,
                      "current": {"year": cur_partial[0], "month": cur_partial[1], "value": cur_val, "partial": True}}

    # ------------------------------------------------ trimestri
    qe = close.resample("QE").last()
    qret = (qe.pct_change() * 100).dropna()
    qret = qret[qret.index.year >= 2011]
    qyears = sorted(set(int(y) for y in qret.index.year))
    qmat = [[None] * 4 for _ in qyears]
    for t, v in qret.items():
        qmat[qyears.index(t.year)][(t.month - 1) // 3] = rnd(v, 1)
    cur_q = (now.month - 1) // 3 + 1
    qfull = qret[~((qret.index.year == now.year) & (qret.index.quarter == cur_q))]
    qstats = []
    for q in range(1, 5):
        s = qfull[qfull.index.quarter == q]
        st = basic_stats(s.values.tolist(), [int(y) for y in s.index.year])
        st.update({"quarter": q, "label": f"Q{q}"})
        qstats.append(st)
    out["quarterly"] = {"years": qyears, "matrix": qmat, "stats": qstats, "current": {"year": now.year, "quarter": cur_q}}

    # ------------------------------------------------ settimana dell'anno
    we = close.resample("W-SUN").last()
    wret = (we.pct_change() * 100).dropna()
    wret = wret[(wret.index.year >= 2011) & (wret.index <= now.normalize() - DAY)]
    wk = wret.index.isocalendar().week.astype(int).values
    weekly = []
    for w in range(1, 54):
        s = wret.values[wk == w]
        if len(s) == 0:
            continue
        st = basic_stats(s.tolist())
        st["week"] = w
        weekly.append(st)
    out["weekly"] = {"stats": weekly, "current_week": int(now.isocalendar()[1])}

    # ------------------------------------------------ giorno della settimana (Binance 1d, open->close)
    if k1d is not None and len(k1d) > 30:
        d = k1d.iloc[:-1]
        r = (d["close"] / d["open"] - 1) * 100
        rng = (d["high"] - d["low"]) / d["open"] * 100
        dow = d["time"].dt.dayofweek.values
        wd = []
        for i in range(7):
            m = dow == i
            st = basic_stats(r.values[m].tolist())
            st.update({"dow": i, "label": GIORNI_BREVI[i], "name": GIORNI[i], "avg_range": rnd(rng.values[m].mean())})
            wd.append(st)
        out["weekday"] = {"stats": wd, "current_dow": int(now.dayofweek)}
    else:
        out["weekday"] = {"stats": [], "current_dow": int(now.dayofweek)}

    # ------------------------------------------------ giorno del mese (close->close)
    dret = (close.pct_change() * 100).dropna()
    dret = dret[dret.index.year >= 2011]
    dd = dret.index.day.values
    md = []
    for day in range(1, 32):
        st = basic_stats(dret.values[dd == day].tolist())
        st["day"] = day
        md.append(st)
    out["monthday"] = {"stats": md, "current_day": int(now.day)}

    # ------------------------------------------------ ora UTC e sessioni (Binance 1h)
    if k1h is not None and len(k1h) > 500:
        h = k1h.iloc[:-1].copy()
        h["r"] = (h["close"] / h["open"] - 1) * 100
        h["rng"] = (h["high"] - h["low"]) / h["open"] * 100
        h["hour"] = h["time"].dt.hour
        h["dow"] = h["time"].dt.dayofweek
        h["date"] = h["time"].dt.normalize()
        dv = h.groupby("date")["volume"].transform("sum").replace(0, np.nan)
        h["vshare"] = h["volume"] / dv * 100
        g = h.groupby("hour")
        hourly = []
        for hr, s in g:
            st = basic_stats(s["r"].values.tolist())
            st.update({"hour": int(hr), "avg_range": rnd(s["rng"].mean(), 3), "vol_share": rnd(s["vshare"].mean())})
            st["avg"] = rnd(s["r"].mean(), 4)
            st["median"] = rnd(s["r"].median(), 4)
            hourly.append(st)
        piv = h.pivot_table(index="dow", columns="hour", values="r", aggfunc="mean")
        pivr = h.pivot_table(index="dow", columns="hour", values="rng", aggfunc="mean")
        hour_dow = {"avg": [[rnd(piv.loc[i, j], 4) if (i in piv.index and j in piv.columns) else None for j in range(24)] for i in range(7)],
                    "range": [[rnd(pivr.loc[i, j], 3) if (i in pivr.index and j in pivr.columns) else None for j in range(24)] for i in range(7)]}
        # sessioni
        sess_def = [("asia", "Asia", 0, 8), ("europa", "Europa", 8, 13), ("usa", "USA", 13, 21), ("late", "Fine giornata USA", 21, 24)]
        h["sess"] = pd.cut(h["hour"], bins=[-1, 7, 12, 20, 23], labels=[s[0] for s in sess_def]).astype(str)
        sg = h.groupby(["date", "sess"]).agg(o=("open", "first"), c=("close", "last"), hi=("high", "max"), lo=("low", "min"))
        sg["r"] = (sg["c"] / sg["o"] - 1) * 100
        sg["rng"] = (sg["hi"] - sg["lo"]) / sg["o"] * 100
        sessions = []
        for key, label, a, b in sess_def:
            s = sg.xs(key, level="sess") if key in sg.index.get_level_values("sess") else None
            if s is None or len(s) == 0:
                continue
            st = basic_stats(s["r"].values.tolist())
            st.update({"key": key, "label": label, "hours": f"{a:02d}:00–{b:02d}:00 UTC",
                       "avg_range": rnd(s["rng"].mean()), "avg": rnd(s["r"].mean(), 3)})
            # ultimi 365 giorni
            rec = s[s.index >= now - pd.Timedelta(days=365)]
            st["recent_avg"] = rnd(rec["r"].mean(), 3) if len(rec) else None
            st["recent_win_rate"] = rnd((rec["r"] > 0).mean() * 100, 1) if len(rec) else None
            sessions.append(st)
        out["hourly"] = {"stats": hourly, "current_hour": int(now.hour), "since": ts(h["time"].iloc[0])}
        out["hour_dow"] = hour_dow
        out["sessions"] = sessions
    else:
        out["hourly"] = {"stats": [], "current_hour": int(now.hour), "since": None}
        out["hour_dow"] = {"avg": [], "range": []}
        out["sessions"] = []

    # ------------------------------------------------ anno del ciclo × mese
    rows = []
    for ci in range(4):
        yrs = [y for y in years if cycle_year_idx(y) == ci]
        months = []
        for m in range(1, 13):
            vals, labs = [], []
            for y in yrs:
                if (y, m) == cur_partial:
                    continue
                v = mat[years.index(y)][m - 1]
                if v is not None:
                    vals.append(v)
                    labs.append(y)
            st = basic_stats(vals, labs)
            st["values"] = [{"year": y, "value": v} for y, v in zip(labs, vals)]
            months.append(st)
        annual = [yt for yt in ystats if yt["cycle_year"] == ci]
        full_years = [a["total"] for a in annual if a["year"] != now.year and a["total"] is not None]
        rows.append({"idx": ci, "label": CYCLE_YEAR_LABELS[ci], "short": CYCLE_YEAR_SHORT[ci], "years": yrs, "months": months,
                     "annual": {"avg": rnd(np.mean(full_years), 1) if full_years else None,
                                "median": rnd(np.median(full_years), 1) if full_years else None,
                                "win_rate": rnd(np.mean([x > 0 for x in full_years]) * 100, 1) if full_years else None,
                                "values": [{"year": a["year"], "value": a["total"]} for a in annual]}})
    out["halving_cycle"] = {"rows": rows, "current": {"idx": cycle_year_idx(now.year), "month": now.month, "year": now.year,
                                                      "label": CYCLE_YEAR_LABELS[cycle_year_idx(now.year)]}}
    return out


# ======================================================= finestre ricorrenti

class DailyGrid:
    """Serie giornaliera continua con accesso per posizione (giorni dall'inizio)."""

    def __init__(self, df: pd.DataFrame):
        idx = pd.date_range(df.index[0], df.index[-1], freq="D")
        d = df.reindex(idx).ffill()
        self.start = idx[0]
        self.idx = idx
        self.close = d["close"].to_numpy(float)
        self.high = d["high"].to_numpy(float)
        self.low = d["low"].to_numpy(float)
        self.last = len(idx) - 1
        self.frame = pd.DataFrame({"time": idx, "high": self.high, "low": self.low, "close": self.close})

    def pos(self, t: pd.Timestamp) -> int:
        return int((t.normalize() - self.start) / DAY)

    def at(self, P: np.ndarray) -> np.ndarray:
        P = np.asarray(P)
        ok = (P >= 0) & (P <= self.last)
        out = np.full(P.shape, np.nan)
        out[ok] = self.close[P[ok]]
        return out


def _pivot_positions(g: DailyGrid, mult: float) -> dict[str, np.ndarray]:
    zz = mk.zigzag(g.frame, mult=mult, atr_n=14)
    lows = np.array(sorted(p["i"] for p in zz if p["kind"] == "low" and not p.get("open")), int)
    highs = np.array(sorted(p["i"] for p in zz if p["kind"] == "high" and not p.get("open")), int)
    return {"low": lows, "high": highs}


def _nearest(piv: np.ndarray, P: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Distanza (giorni) e posizione del pivot più vicino per ogni posizione di P."""
    if len(piv) == 0:
        return np.full(P.shape, 10 ** 6), np.full(P.shape, -1)
    j = np.searchsorted(piv, P)
    a = piv[np.clip(j - 1, 0, len(piv) - 1)]
    b = piv[np.clip(j, 0, len(piv) - 1)]
    da, db = np.abs(P - a), np.abs(b - P)
    return np.minimum(da, db), np.where(da <= db, a, b)


def recurring_windows(g: DailyGrid, now: pd.Timestamp, horizon: int = 90, first_year: int = 2011) -> dict:
    cal = pd.date_range("2023-01-01", "2023-12-31", freq="D")  # griglia di 365 giorni (senza 29/2)
    years = list(range(first_year, now.year + 1))
    Y, C = len(years), len(cal)
    P = np.zeros((Y, C), int)
    for yi, y in enumerate(years):
        for ci, c in enumerate(cal):
            P[yi, ci] = g.pos(pd.Timestamp(year=y, month=c.month, day=c.day, tz="UTC"))
    PATH = 14
    offs = np.arange(-PATH, PATH + 1)
    path_all = g.at(P[:, :, None] + offs[None, None, :]) / g.at(P)[:, :, None] * 100 - 100  # Y×C×29

    # pivot zigzag (vari livelli di sensibilità)
    pivs = {lvl: _pivot_positions(g, mult) for mult, lvl in ZZ_LEVELS}
    near = {}
    for lvl in pivs:
        for kind in ("low", "high"):
            near[(lvl, kind)] = _nearest(pivs[lvl][kind], P)

    results: dict[tuple[int, int], dict] = {}
    base_rates: dict[str, dict] = {}
    arrays: dict[int, dict] = {}
    close_s = pd.Series(g.close)
    for N, K in PARAMS:
        A0 = g.at(P)
        pre = (A0 / g.at(P - K) - 1) * 100
        post = (g.at(P + K) / A0 - 1) * 100
        valid = (P - K >= 0) & (P + K <= g.last) & np.isfinite(pre) & np.isfinite(post)
        # inversioni: estremo (minimo/massimo di chiusura) dentro la finestra ±N, misurato dai K giorni prima/dopo il centro
        rmin = close_s.rolling(2 * N + 1, center=True, min_periods=1).min().to_numpy()
        rmax = close_s.rolling(2 * N + 1, center=True, min_periods=1).max().to_numpy()
        Pc = np.clip(P, 0, g.last)
        lo_w, hi_w = rmin[Pc], rmax[Pc]
        pre_lo, post_lo = (lo_w / g.at(P - K) - 1) * 100, (g.at(P + K) / lo_w - 1) * 100
        pre_hi, post_hi = (hi_w / g.at(P - K) - 1) * 100, (g.at(P + K) / hi_w - 1) * 100
        th = 0.4 * float(np.nanmedian(np.abs(post[valid])))  # soglia adattiva (~40% del movimento tipico a K giorni)
        masks = {
            "rev_up": (pre_lo <= -th) & (post_lo >= th),
            "rev_down": (pre_hi >= th) & (post_hi <= -th),
            "up": post > 0,
            "down": post < 0,
            "cont_up": (pre >= MOVE_TH) & (post >= MOVE_TH),
            "cont_down": (pre <= -MOVE_TH) & (post <= -MOVE_TH),
        }
        arrays[K] = {"pre": pre, "post": post, "valid": valid, "masks": masks, "th": th,
                     "pre_lo": pre_lo, "post_lo": post_lo, "pre_hi": pre_hi, "post_hi": post_hi}
        piv_any_low = near[("minore", "low")][0] <= N
        piv_any_high = near[("minore", "high")][0] <= N
        base = {k: float(m[valid].mean()) for k, m in masks.items()}
        base["pivot_low"] = float(piv_any_low[valid].mean())
        base["pivot_high"] = float(piv_any_high[valid].mean())
        base_rates[f"{N}_{K}"] = {**{k: rnd(v * 100, 1) for k, v in base.items()}, "threshold": rnd(th, 2)}
        n_c = valid.sum(axis=0)
        mean_post = np.nanmean(np.where(valid, post, np.nan), axis=0)
        med_post = np.nanmedian(np.where(valid, post, np.nan), axis=0)
        for pat, m in masks.items():
            k_c = (m & valid).sum(axis=0)
            for ci in range(C):
                n, k = int(n_c[ci]), int(k_c[ci])
                if n < 6:
                    continue
                # coerenza della direzione: media e mediana devono concordare con lo schema
                if pat in ("up", "cont_up") and (mean_post[ci] <= 0 or med_post[ci] <= 0):
                    continue
                if pat in ("down", "cont_down") and (mean_post[ci] >= 0 or med_post[ci] >= 0):
                    continue
                pval = binom_sf(k, n, base[pat])
                score = -math.log10(max(pval, 1e-12))
                if pat.startswith("rev"):
                    score *= 1.3  # le inversioni sono l'oggetto principale dello studio
                key = (ci, K)
                prev = results.get(key)
                if prev is None or score > prev["score"]:
                    results[key] = {"ci": ci, "N": N, "K": K, "pattern": pat, "k": k, "n": n, "p": pval, "score": score,
                                    "rate": k / n, "base": base[pat]}
    for r in results.values():
        a = arrays[r["K"]]
        ci = r["ci"]
        r["valid"], r["mask"] = a["valid"][:, ci], a["masks"][r["pattern"]][:, ci]
        if r["pattern"] == "rev_up":
            r["pre"], r["post"] = a["pre_lo"][:, ci], a["post_lo"][:, ci]
        elif r["pattern"] == "rev_down":
            r["pre"], r["post"] = a["pre_hi"][:, ci], a["post_hi"][:, ci]
        else:
            r["pre"], r["post"] = a["pre"][:, ci], a["post"][:, ci]
        r["m_up"], r["m_down"] = a["masks"]["rev_up"][:, ci], a["masks"]["rev_down"][:, ci]
        r["pre_c"], r["post_c"] = a["pre"][:, ci], a["post"][:, ci]

    def detail(r: dict, upcoming_date: pd.Timestamp | None = None) -> dict:
        ci, N, K, pat = r["ci"], r["N"], r["K"], r["pattern"]
        c = cal[ci]
        expected, desc = PATTERNS[pat]
        rows = []
        posts, pres, posts_c = [], [], []
        n_low = n_high = n_major = 0
        for yi, y in enumerate(years):
            if not r["valid"][yi]:
                continue
            pv, po = float(r["pre"][yi]), float(r["post"][yi])
            pres.append(pv)
            posts.append(po)
            posts_c.append(float(r["post_c"][yi]))
            # pivot più significativo entro ±N
            pk = None
            for lvl in ("forte", "medio", "minore"):
                dl, pl = near[(lvl, "low")][0][yi, ci], near[(lvl, "low")][1][yi, ci]
                dh, ph = near[(lvl, "high")][0][yi, ci], near[(lvl, "high")][1][yi, ci]
                cand = []
                if dl <= N:
                    cand.append((dl, "minimo", pl))
                if dh <= N:
                    cand.append((dh, "massimo", ph))
                if cand:
                    dist, kind, pp = min(cand)
                    pk = {"kind": kind, "level": lvl, "time": ts(g.idx[pp])}
                    break
            if pk:
                n_low += pk["kind"] == "minimo"
                n_high += pk["kind"] == "massimo"
                n_major += pk["level"] in ("forte", "medio")
            pc, qc = float(r["pre_c"][yi]), float(r["post_c"][yi])
            is_rev = pat.startswith("rev")
            if is_rev and r["m_up"][yi] and not r["m_down"][yi]:
                typ = "Ribasso → rialzo"
            elif is_rev and r["m_down"][yi] and not r["m_up"][yi]:
                typ = "Rialzo → ribasso"
            elif is_rev and r["m_up"][yi] and r["m_down"][yi]:
                typ = "Ribasso → rialzo" if qc > 0 else "Rialzo → ribasso"
            elif pc <= -MOVE_TH and qc >= MOVE_TH:
                typ = "Ribasso → rialzo"
            elif pc >= MOVE_TH and qc <= -MOVE_TH:
                typ = "Rialzo → ribasso"
            elif pc >= MOVE_TH and qc >= MOVE_TH:
                typ = "Continuazione rialzista"
            elif pc <= -MOVE_TH and qc <= -MOVE_TH:
                typ = "Continuazione ribassista"
            elif qc > 0:
                typ = "Salita"
            else:
                typ = "Discesa"
            rows.append({"year": y, "pre": rnd(pv, 1), "post": rnd(po, 1), "type": typ, "match": bool(r["mask"][yi]),
                         "pivot": pk})
        n = len(rows)
        # percorso medio −14..+14 giorni
        pth = path_all[:, ci, :]
        okp = np.all(np.isfinite(pth), axis=1)
        pth = pth[okp]
        path = None
        if len(pth) >= 3:
            path = {"days": offs.tolist(), "mean": [rnd(x) for x in pth.mean(axis=0)],
                    "median": [rnd(x) for x in np.median(pth, axis=0)],
                    "p25": [rnd(x) for x in np.percentile(pth, 25, axis=0)],
                    "p75": [rnd(x) for x in np.percentile(pth, 75, axis=0)], "n": int(len(pth))}
        posts_a = np.array(posts)
        pres_a = np.array(pres)
        sel = r["mask"][r["valid"]]
        avg_post_match = float(posts_a[sel].mean()) if sel.any() else None
        ref = upcoming_date if upcoming_date is not None else pd.Timestamp(year=2023, month=c.month, day=c.day, tz="UTC")
        a, b = ref - N * DAY, ref + N * DAY
        rng_txt = fmt_day_range(a, b)
        k = r["k"]
        postc_a = np.array(posts_c)
        avg_post = float(postc_a.mean())
        if pat == "rev_up":
            txt = (f"Intorno {util.art(rng_txt, 'al')} BTC ha invertito da ribasso a rialzo in {k} anni su {n} "
                   f"({avg_post_match:+.1f}% medio dal minimo della finestra nei {K} giorni successivi).")
        elif pat == "rev_down":
            txt = (f"Intorno {util.art(rng_txt, 'al')} BTC ha invertito da rialzo a ribasso in {k} anni su {n} "
                   f"({avg_post_match:+.1f}% medio dal massimo della finestra nei {K} giorni successivi).")
        elif pat == "up":
            txt = (f"Nei {K} giorni dopo {util.art(fmt_date(ref))} BTC è salito in {k} anni su {n} "
                   f"(media {avg_post:+.1f}%, mediana {float(np.median(posts_a)):+.1f}%).")
        elif pat == "down":
            txt = (f"Nei {K} giorni dopo {util.art(fmt_date(ref))} BTC è sceso in {k} anni su {n} "
                   f"(media {avg_post:+.1f}%, mediana {float(np.median(posts_a)):+.1f}%).")
        elif pat == "cont_up":
            txt = (f"Intorno {util.art(rng_txt, 'al')} il rialzo dei {K} giorni precedenti è proseguito in {k} anni su {n} "
                   f"({avg_post_match:+.1f}% medio dopo).")
        else:
            txt = (f"Intorno {util.art(rng_txt, 'al')} il ribasso dei {K} giorni precedenti è proseguito in {k} anni su {n} "
                   f"({avg_post_match:+.1f}% medio dopo).")
        piv_txt = None
        if n_low + n_high:
            piv_txt = (f"Swing (zigzag ATR) entro ±{N} giorni in {n_low + n_high} anni su {n}: "
                       f"{n_low} minimi, {n_high} massimi ({n_major} significativi).")
        # stabilità: metà recente vs metà vecchia
        half = n // 2
        recent = [rw["match"] for rw in rows[half:]]
        older = [rw["match"] for rw in rows[:half]]
        out = {
            "id": f"w{c.month:02d}{c.day:02d}_{K}",
            "month": c.month, "day": c.day, "label": rng_txt,
            "N": N, "K": K, "pattern": pat, "expected": expected, "pattern_label": desc,
            "hits": k, "n": n, "consistency": rnd(r["rate"] * 100, 1), "base_rate": rnd(r["base"] * 100, 1),
            "wilson_lb": rnd(wilson_lb(k, n) * 100, 1), "p_value": rnd(r["p"], 5),
            "confidence": confidence_label(r["p"], n, r["rate"]),
            "score": rnd(r["score"], 3),
            "avg_pre": rnd(pres_a.mean()), "avg_post": rnd(avg_post), "median_post": rnd(np.median(postc_a)),
            "avg_post_hits": rnd(avg_post_match),
            "avg_abs_post": rnd(np.abs(postc_a).mean()), "threshold": rnd(arrays[K]["th"], 2),
            "pivots": {"low": n_low, "high": n_high, "major": n_major,
                       "rate": rnd((n_low + n_high) / n * 100, 1) if n else None},
            "recent_consistency": rnd(np.mean(recent) * 100, 1) if recent else None,
            "older_consistency": rnd(np.mean(older) * 100, 1) if older else None,
            "text": txt, "pivot_text": piv_txt,
            "years": rows, "path": path,
        }
        if upcoming_date is not None:
            out["date"] = ts(upcoming_date)
            out["start"] = ts(a)
            out["end"] = ts(b)
        return out

    def best_per_center() -> list[dict]:
        best: dict[int, dict] = {}
        for (ci, K), r in results.items():
            if ci not in best or r["score"] > best[ci]["score"]:
                best[ci] = r
        return list(best.values())

    cands = best_per_center()

    def circ(a: int, b: int) -> int:
        d = abs(a - b)
        return min(d, C - d)

    # --- top globali (non-max suppression ±7 giorni)
    top = []
    for r in sorted(cands, key=lambda x: -x["score"]):
        if r["rate"] < 0.6 or r["p"] > 0.1:
            continue
        if any(circ(r["ci"], t["ci"]) < 8 for t in top):
            continue
        top.append(r)
        if len(top) >= 24:
            break
    top_out = [detail(r) for r in top]
    top_out.sort(key=lambda x: (x["month"], x["day"]))

    # --- prossimi `horizon` giorni
    today = now.normalize()
    up = []
    for r in cands:
        c = cal[r["ci"]]
        t = pd.Timestamp(year=today.year, month=c.month, day=c.day, tz="UTC")
        if t < today - r["N"] * DAY:
            t = pd.Timestamp(year=today.year + 1, month=c.month, day=c.day, tz="UTC")
        if t > today + horizon * DAY:
            continue
        up.append((r, t))
    chosen: list[tuple[dict, pd.Timestamp]] = []
    for th_p, th_rate in ((0.05, 0.65), (0.15, 0.6), (0.35, 0.55)):
        for r, t in sorted(up, key=lambda x: -x[0]["score"]):
            if r["p"] > th_p or r["rate"] < th_rate:
                continue
            if any(abs((t - t2).days) < 6 for _, t2 in chosen):
                continue
            chosen.append((r, t))
            if len(chosen) >= 16:
                break
        if len(chosen) >= 8:
            break
    upcoming = [detail(r, t) for r, t in chosen]
    upcoming.sort(key=lambda x: x["date"])

    # --- finestre attive oggi
    active = []
    for r, t in sorted(up, key=lambda x: -x[0]["score"]):
        if abs((t - today).days) <= r["N"] and r["p"] < 0.2 and r["rate"] >= 0.6:
            active.append(detail(r, t))
            if len(active) >= 3:
                break

    # heatmap annuale compatta: punteggio per giorno del calendario (per il grafico ad anello / striscia)
    strip = []
    for r in sorted(cands, key=lambda x: x["ci"]):
        exp = PATTERNS[r["pattern"]][0]
        strip.append([int(cal[r["ci"]].month), int(cal[r["ci"]].day), exp, rnd(r["rate"] * 100, 0), rnd(r["score"], 2)])

    return {"years": years, "base_rates": base_rates, "top": top_out, "upcoming": upcoming, "active": active,
            "strip": strip,
            "method": ("Per ogni giorno dell'anno e per ogni anno dal 2011 si misura la variazione nei K giorni prima e dopo "
                       "(K = 7 e 14). Un'inversione richiede che il minimo (o massimo) di chiusura entro ±N giorni sia almeno ~40% del movimento tipico a K giorni sotto (sopra) il prezzo di K giorni prima e del prezzo K giorni dopo. La coerenza è confrontata con il "
                       "tasso base dello stesso schema su tutti i giorni (test binomiale a una coda, limite inferiore di Wilson). "
                       "Gli swing sono rilevati con uno zigzag adattivo all'ATR a tre sensibilità (2.5×, 4×, 6× ATR) entro ±N "
                       "giorni (N = 3 per K = 7, N = 5 per K = 14). Testando centinaia di date, qualche finestra appare "
                       "significativa per caso: preferire quelle con confidenza alta, coerenza stabile tra anni vecchi e recenti "
                       "e confluenza con altri metodi.")}


# ============================================================ pivot di ciclo

def cycle_pivots(g: DailyGrid, cyc: dict, now: pd.Timestamp, horizon: int) -> dict:
    halv = [(h["n"], pd.Timestamp(h["time"], unit="s", tz="UTC"), bool(h.get("estimated"))) for h in cyc["halvings"]]
    past_h = [(n, t) for n, t, e in halv if not e]
    next_h = next((t for n, t, e in halv if e), None)
    cycles = cyc["cycles"]
    cur = cyc["current"]

    def T(x):
        return pd.Timestamp(x, unit="s", tz="UTC") if x is not None else None

    def halving_before(t):
        hs = [h for _, h in past_h if h <= t]
        return hs[-1] if hs else None

    today = now.normalize()
    last_h = halving_before(today)
    days_since_h = (today - last_h).days
    items = []

    def proj(pairs):
        if len([p for p in pairs if p[0] > 1]) >= 2:
            pairs = [p for p in pairs if p[0] > 1]
        if not pairs:
            return None, None
        ns, ys = zip(*pairs)
        return cy.adaptive_projection(list(ns), list(ys), max(ns) + 1)

    def add(key, label, kind, anchor_label, anchor_t, hist, est_days, unc, note=None, observed=None):
        if anchor_t is None or est_days is None or est_days != est_days:
            return
        mid = anchor_t + pd.Timedelta(days=float(est_days))
        unc = max(float(unc or 0), 20.0)
        status = "futuro" if mid - pd.Timedelta(days=unc) > today else ("in corso" if mid + pd.Timedelta(days=unc) >= today else "passato")
        verb = "il massimo" if kind == "top" else "il minimo"
        hist_txt = ", ".join(f"{h['days']} gg (ciclo {h['n']})" for h in hist)
        text = (f"Storicamente {verb} di ciclo si è formato {hist_txt} dopo {anchor_label}: proiezione adattiva "
                f"≈ {est_days:.0f} giorni → {fmt_date(mid, True)} (±{unc:.0f} gg).")
        if observed is not None:
            text += f" Nel ciclo in corso: {observed}."
        items.append({"key": key, "label": label, "kind": kind, "anchor": anchor_label, "anchor_time": ts(anchor_t),
                      "history": hist, "projected_days": rnd(est_days, 0), "uncertainty": rnd(unc, 0),
                      "mid": ts(mid), "from": ts(mid - pd.Timedelta(days=unc)), "to": ts(mid + pd.Timedelta(days=unc)),
                      "status": status, "days_away": (mid - today).days, "text": text, "note": note})

    # -------------- halving -> top / halving -> bottom / top -> bottom / bottom -> top
    h2t, h2b, t2b, b2t, b2h = [], [], [], [], []
    for c in cycles:
        b, t, nb = T(c["bottom"]["time"]), T((c.get("top") or {}).get("time")), T((c.get("next_bottom") or {}).get("time"))
        if t is not None:
            h = halving_before(t)
            if h is not None and h > b:
                h2t.append({"n": c["n"], "days": (t - h).days, "time": ts(t)})
                if nb is not None:
                    h2b.append({"n": c["n"], "days": (nb - h).days, "time": ts(nb)})
            b2t.append({"n": c["n"], "days": (t - b).days, "time": ts(t)})
            if nb is not None:
                t2b.append({"n": c["n"], "days": (nb - t).days, "time": ts(nb)})
        hs_after = [hh for _, hh in past_h if hh > b]
        if hs_after and (nb is None or hs_after[0] < nb):
            b2h.append({"n": c["n"], "days": (hs_after[0] - b).days})
    cur_c = cycles[-1] if cycles else None
    cur_top = T((cur_c or {}).get("top", {}).get("time") if cur_c and cur_c.get("top") else None)
    cur_bottom = T(cur_c["bottom"]["time"]) if cur_c else None
    in_bear = cur_c is not None and cur_top is not None and cur_c.get("next_bottom") is None

    complete_h2t = [x for x in h2t if cur_top is None or x["time"] != ts(cur_top)]
    if in_bear:
        # ciclo attuale: il massimo è già segnato; proietta il minimo
        e, u = proj([(x["n"], x["days"]) for x in h2b])
        obs = None
        pb = cur.get("probable_bottom")
        if pb:
            obs = f"minimo probabile già segnato {util.art(fmt_date(T(pb['time']), True))} ({(T(pb['time']) - last_h).days} gg dall'halving)"
        add("halving_bottom", "Halving → minimo di ciclo", "bottom", "l'halving", last_h, h2b, e, u, observed=obs)
        e, u = proj([(x["n"], x["days"]) for x in t2b])
        add("top_bottom", "Massimo → minimo di ciclo", "bottom", "il massimo di ciclo", cur_top, t2b, e, u, observed=obs)
        # prossimo massimo dal prossimo halving
        e, u = proj([(x["n"], x["days"]) for x in h2t])
        add("halving_top_next", "Halving → massimo (prossimo ciclo)", "top", "l'halving", next_h, h2t, e, u,
            note="Riferito al prossimo halving stimato.")
    else:
        e, u = proj([(x["n"], x["days"]) for x in complete_h2t])
        add("halving_top", "Halving → massimo di ciclo", "top", "l'halving", last_h, complete_h2t, e, u)
        e, u = proj([(x["n"], x["days"]) for x in b2t])
        add("bottom_top", "Minimo → massimo di ciclo", "top", "il minimo di ciclo", cur_bottom, b2t, e, u)
    if cur.get("est_next_bottom"):
        w = cur["est_next_bottom"]
        mid = T(w["mid"])
        unc = (w["to"] - w["from"]) / 2 / 86400
        items.append({"key": "cycles_bottom_window", "label": "Finestra del minimo (pagina Cicli)" if cur.get("bottom_window_kind") != "retest" else "Finestra di retest del minimo (pagina Cicli)",
                      "kind": "bottom", "anchor": "modello Cicli", "anchor_time": None, "history": [],
                      "projected_days": None, "uncertainty": rnd(unc, 0), "mid": w["mid"], "from": w["from"], "to": w["to"],
                      "status": "futuro" if T(w["from"]) > today else ("in corso" if T(w["to"]) >= today else "passato"),
                      "days_away": (mid - today).days,
                      "text": (f"La stima adattiva della pagina Cicli colloca il {'retest del ' if cur.get('bottom_window_kind') == 'retest' else ''}"
                               f"minimo tra {fmt_date(T(w['from']), True)} e {fmt_date(T(w['to']), True)} "
                               f"(area ${w['price_low'] / 1000:,.0f}k–${w['price_high'] / 1000:,.0f}k)."),
                      "note": None})

    # -------------- pivot maggiori intermedi rispetto all'halving (cluster tra cicli)
    zz = mk.zigzag(g.frame, mult=6.0, atr_n=14, min_pct=20)
    major = [p for p in zz if not p.get("open")]
    per_cycle: list[tuple[int, int, str, int]] = []  # (n halving, giorni, kind, pos)
    for i, (n, h) in enumerate(past_h):
        end = past_h[i + 1][1] if i + 1 < len(past_h) else today
        for p in major:
            t = g.idx[p["i"]]
            if h <= t < end:
                per_cycle.append((n, (t - h).days, p["kind"], p["i"]))
    clusters = []
    hist_cycles = [n for n, _ in past_h[:-1]]
    used = set()
    for kind in ("low", "high"):
        pts = sorted([x for x in per_cycle if x[2] == kind and x[0] in hist_cycles], key=lambda x: x[1])
        for x in pts:
            if (x[0], x[1], kind) in used:
                continue
            grp = [y for y in pts if abs(y[1] - x[1]) <= 50 and (y[0], y[1], kind) not in used]
            # un solo punto per ciclo (il più vicino)
            byc: dict[int, tuple] = {}
            for y in grp:
                if y[0] not in byc or abs(y[1] - x[1]) < abs(byc[y[0]][1] - x[1]):
                    byc[y[0]] = y
            if len(byc) < 2:
                continue
            for y in byc.values():
                used.add((y[0], y[1], kind))
            members = sorted(byc.values())
            pairs = [(m[0], m[1]) for m in members]
            ns, ds = zip(*pairs)
            est, unc = cy.adaptive_projection(list(ns), list(ds), past_h[-1][0], lo_clip=0.7, hi_clip=1.3)
            unc = max(unc, 15.0)
            mid = last_h + pd.Timedelta(days=est)
            # il ciclo attuale ha già avuto un pivot simile?
            cur_match = [y for y in per_cycle if y[0] == past_h[-1][0] and y[2] == kind and abs(y[1] - est) <= 60]
            kname = "minimo" if kind == "low" else "massimo"
            clusters.append({
                "kind": "bottom" if kind == "low" else "top", "kind_label": kname,
                "cycles": len(members), "of": len(hist_cycles),
                "members": [{"halving": m[0], "days": m[1], "time": ts(g.idx[m[3]]), "price": rnd(g.low[m[3]] if kind == "low" else g.high[m[3]], 2)} for m in members],
                "mean_days": rnd(np.mean(ds), 0), "projected_days": rnd(est, 0), "uncertainty": rnd(unc, 0),
                "mid": ts(mid), "from": ts(mid - pd.Timedelta(days=unc)), "to": ts(mid + pd.Timedelta(days=unc)),
                "days_away": (mid - today).days,
                "confirmed": ({"days": cur_match[0][1], "time": ts(g.idx[cur_match[0][3]])} if cur_match else None),
                "status": "futuro" if mid - pd.Timedelta(days=unc) > today else ("in corso" if mid + pd.Timedelta(days=unc) >= today else "passato"),
                "text": (f"~{est:.0f} giorni dopo l'halving si è formato un {kname} importante in {len(members)} cicli su {len(hist_cycles)} "
                         f"({', '.join(str(m[1]) for m in members)} gg) → nel ciclo attuale ≈ {fmt_date(mid, True)}."),
            })
    clusters.sort(key=lambda c: c["projected_days"] or 0)
    return {"days_since_halving": days_since_h, "last_halving": ts(last_h), "next_halving": ts(next_h) if next_h is not None else None,
            "phase": cur.get("phase"), "items": items, "clusters": clusters,
            "method": ("Durate storiche tra halving, minimi e massimi di ciclo (rilevati come nella pagina Cicli) proiettate "
                       "sul ciclo in corso con una regressione pesata sui cicli recenti (cicli che si accorciano). I cluster "
                       "uniscono swing maggiori (zigzag 6× ATR, ≥20%) caduti a distanza simile dall'halving in più cicli.")}


# ======================================================= proiezioni temporali

def _swings(df: pd.DataFrame, mult: float, min_pct: float = 0) -> list[dict]:
    zz = mk.zigzag(df, mult=mult, atr_n=14, min_pct=min_pct)
    return [{"time": pd.Timestamp(p["time"]), "price": float(p["price"]), "kind": p["kind"], "open": bool(p.get("open"))} for p in zz]


def time_projections(g: DailyGrid, k4h: pd.DataFrame | None, now: pd.Timestamp, horizon: int) -> dict:
    today = now.normalize()
    lo_t, hi_t = today - 3 * DAY, today + horizon * DAY
    recent = g.frame[g.frame["time"] >= today - pd.Timedelta(days=1200)].reset_index(drop=True)
    major = _swings(recent, 4.0, 10)
    conf = [p for p in major if not p["open"]]
    open_p = major[-1] if major and major[-1]["open"] else None
    items: list[dict] = []
    fib: list[dict] = []
    legs_out = []
    for a, b in zip(conf[:-1], conf[1:]):
        legs_out.append({"from": ts(a["time"]), "to": ts(b["time"]), "days": (b["time"] - a["time"]).days,
                         "from_price": rnd(a["price"]), "to_price": rnd(b["price"]),
                         "change": rnd((b["price"] / a["price"] - 1) * 100, 1), "dir": "up" if b["kind"] == "high" else "down"})
    # prossimo pivot atteso: opposto all'estremo in formazione
    next_kind = None
    if open_p:
        next_kind = "top" if open_p["kind"] == "high" else "bottom"
    elif conf:
        next_kind = "top" if conf[-1]["kind"] == "low" else "bottom"
    expected = "inversione_ribassista" if next_kind == "top" else "inversione_rialzista"

    # ---- Fibonacci time zones dalle ultime 2 gambe maggiori confermate
    ratios = [0.382, 0.618, 1.0, 1.618, 2.618]
    for a, b in list(zip(conf[:-1], conf[1:]))[-2:]:
        D = (b["time"] - a["time"]).days
        if D < 10:
            continue
        for r in ratios:
            t = b["time"] + pd.Timedelta(days=round(D * r))
            fib.append({"ratio": r, "anchor_from": ts(a["time"]), "anchor_to": ts(b["time"]), "leg_days": D, "time": ts(t),
                        "status": "futuro" if t > today else "passato", "days_away": (t - today).days,
                        "label": f"Fib {r:g}× della gamba {fmt_date(a['time'], True)} → {fmt_date(b['time'], True)} ({D} gg)"})
            if lo_t <= t <= hi_t:
                items.append({"source": "fibonacci", "time": ts(t), "start": ts(t - 2 * DAY), "end": ts(t + 2 * DAY),
                              "strength": 0.4 if r in (1.0, 1.618) else 0.28, "expected": "inversione",
                              "text": f"Fibonacci time zone {r:g}× della gamba {fmt_date(a['time'])}→{fmt_date(b['time'])} ({D} giorni)."})

    # ---- gambe di uguale durata
    equal = []
    if conf:
        last = conf[-1]
        same_dir = [lg for lg in legs_out if lg["dir"] == ("up" if last["kind"] == "low" else "down")]
        if same_dir:
            d_last = same_dir[-1]["days"]
            d_med = float(np.median([lg["days"] for lg in same_dir[-4:]]))
            for lab, d in (("uguale all'ultima gamba nella stessa direzione", d_last),
                           ("mediana delle ultime gambe nella stessa direzione", d_med)):
                t = last["time"] + pd.Timedelta(days=round(d))
                equal.append({"label": lab, "days": rnd(d, 0), "anchor": ts(last["time"]), "time": ts(t),
                              "status": "futuro" if t > today else "passato", "days_away": (t - today).days})
                if lo_t <= t <= hi_t:
                    items.append({"source": "gambe", "time": ts(t), "start": ts(t - 3 * DAY), "end": ts(t + 3 * DAY),
                                  "strength": 0.32, "expected": expected,
                                  "text": f"Gamba di durata {lab} ({d:.0f} gg dal {'minimo' if last['kind'] == 'low' else 'massimo'} {util.art(fmt_date(last['time']), 'del')})."})

    # ---- spaziatura mediana tra pivot (1d e 4h)
    spacing = []
    sets = [("1d", g.frame[g.frame["time"] >= today - pd.Timedelta(days=500)].reset_index(drop=True), 2.5)]
    if k4h is not None and len(k4h) > 300:
        sets.append(("4h", k4h.iloc[-1500:].reset_index(drop=True), 3.0))
    for tf, frame, mult in sets:
        sw = [p for p in _swings(frame, mult) if not p["open"]][-14:]
        if len(sw) < 4:
            continue
        gaps = np.diff([p["time"].value for p in sw]) / 86400e9
        med = float(np.median(gaps))
        q1, q3 = np.percentile(gaps, [25, 75])
        last = sw[-1]
        nxt = []
        t = last["time"]
        while len(nxt) < 4 and med > 0.2:
            t = t + pd.Timedelta(days=med)
            if t >= today - DAY:
                nxt.append(t)
            if t > hi_t:
                break
        spacing.append({"tf": tf, "median_days": rnd(med, 1), "iqr": [rnd(q1, 1), rnd(q3, 1)], "count": len(sw),
                        "last_pivot": {"time": ts(last["time"]), "price": rnd(last["price"]), "kind": "massimo" if last["kind"] == "high" else "minimo"},
                        "next": [ts(x) for x in nxt]})
        for x in nxt[:2 if tf == "1d" else 1]:
            if lo_t <= x <= hi_t:
                w = max(1.0, (q3 - q1) / 2)
                items.append({"source": "spaziatura", "time": ts(x), "start": ts(x - pd.Timedelta(days=w)), "end": ts(x + pd.Timedelta(days=w)),
                              "strength": 0.25 if tf == "1d" else 0.15, "expected": "inversione",
                              "text": f"Spaziatura mediana degli swing {tf}: {med:.1f} giorni dall'ultimo {'massimo' if last['kind'] == 'high' else 'minimo'} ({fmt_date(last['time'])})."})
    return {"swings": [{"time": ts(p["time"]), "price": rnd(p["price"]), "kind": p["kind"], "open": p["open"]} for p in major[-10:]],
            "legs": legs_out[-8:], "fib": fib, "equal_legs": equal, "spacing": spacing, "next_kind": next_kind,
            "items": items,
            "method": ("Swing maggiori daily con zigzag 4× ATR (≥10%). Fibonacci time zones: data dell'ultimo pivot + "
                       "0.382/0.618/1/1.618/2.618 volte la durata della gamba. Gambe uguali: il movimento in corso dura quanto "
                       "l'ultima gamba nella stessa direzione. Spaziatura: mediana dei giorni tra gli ultimi swing (1d 2.5× ATR, 4h 3× ATR).")}


# ============================================================ eventi ricorrenti

def _last_friday(y: int, m: int) -> pd.Timestamp:
    end = pd.Timestamp(year=y, month=m, day=1, tz="UTC") + pd.offsets.MonthEnd(0)
    return end - pd.Timedelta(days=(end.dayofweek - 4) % 7)


def events(g: DailyGrid, k1h: pd.DataFrame | None, now: pd.Timestamp, horizon: int) -> dict:
    today = now.normalize()
    c = pd.Series(g.close, index=g.idx)
    c = c[c.index >= pd.Timestamp("2011-01-01", tz="UTC")]
    r1 = (c.pct_change() * 100).dropna()
    r3 = ((c.shift(-3) / c - 1) * 100).dropna()
    base_abs1 = float(r1.abs().median())
    base_abs3 = float(r3.abs().median())
    base_up1 = float((r1 > 0).mean() * 100)
    stats = []

    def ev_stat(key, label, dates: list[pd.Timestamp], kind: str, desc: str, pre_days=3, post_days=3):
        rows = []
        for d in dates:
            p = g.pos(d)
            if p - pre_days < 0 or p + post_days > g.last:
                continue
            pre = (g.close[p] / g.close[p - pre_days] - 1) * 100
            post = (g.close[p + post_days] / g.close[p] - 1) * 100
            day = (g.close[p] / g.close[p - 1] - 1) * 100
            rows.append({"time": ts(d), "pre": pre, "post": post, "day": day})
        if not rows:
            return None
        post = np.array([x["post"] for x in rows])
        day = np.array([x["day"] for x in rows])
        pre = np.array([x["pre"] for x in rows])
        st = {"key": key, "label": label, "kind": kind, "description": desc, "n": len(rows),
              "post_avg": rnd(post.mean()), "post_median": rnd(np.median(post)), "post_win_rate": rnd((post > 0).mean() * 100, 1),
              "pre_avg": rnd(pre.mean()), "pre_win_rate": rnd((pre > 0).mean() * 100, 1),
              "day_avg": rnd(day.mean()), "day_win_rate": rnd((day > 0).mean() * 100, 1),
              "abs_post": rnd(np.abs(post).mean()), "vol_ratio": rnd(np.median(np.abs(post)) / base_abs3, 2) if base_abs3 else None,
              "big_move_rate": rnd((np.abs(post) > base_abs3).mean() * 100, 1),
              "recent": [{"time": x["time"], "pre": rnd(x["pre"], 1), "post": rnd(x["post"], 1), "day": rnd(x["day"], 1)} for x in rows[-12:]]}
        stats.append(st)
        return st

    idx = c.index
    month_starts = [t for t in idx if t.day == 1]
    month_ends = [t for t in idx if (t + DAY).day == 1]
    q_starts = [t for t in month_starts if t.month in (1, 4, 7, 10)]
    y_starts = [t for t in month_starts if t.month == 1]
    mids = [t for t in idx if t.day == 15]
    ev_stat("month_open", "Apertura del mese", month_starts, "mese",
            "Variazione del 1° giorno del mese e nei 3 giorni successivi.")
    ev_stat("month_close", "Chiusura del mese", month_ends, "mese",
            "Ultimi 3 giorni del mese (pre) e primi 3 del mese nuovo (post).")
    ev_stat("quarter_open", "Apertura del trimestre", q_starts, "trimestre",
            "Primo giorno del trimestre e 3 giorni successivi.")
    ev_stat("year_open", "Inizio anno", y_starts, "anno", "Primo giorno dell'anno e 3 giorni successivi.")
    ev_stat("mid_month", "Metà mese (15)", mids, "mese", "Movimento nei 3 giorni prima e dopo il 15 del mese.")
    opex = [_last_friday(y, m) for y in range(2019, now.year + 1) for m in range(1, 13)]
    opex = [t for t in opex if t <= today]
    ev_stat("opex_month", "Scadenza opzioni mensile", [t for t in opex if t.month not in (3, 6, 9, 12)], "opzioni",
            "Ultimo venerdì del mese (Deribit, 08:00 UTC): ±3 giorni.")
    ev_stat("opex_quarter", "Scadenza opzioni trimestrale", [t for t in opex if t.month in (3, 6, 9, 12)], "opzioni",
            "Ultimo venerdì di mar/giu/set/dic, scadenza più grande: ±3 giorni.")
    fomc_all = [pd.Timestamp(d, tz="UTC") for d in FOMC_DATES]
    fomc_past = [t for t in fomc_all if t + 3 * DAY <= today]
    fomc = ev_stat("fomc", "Riunione FOMC (Fed)", fomc_past, "macro",
                   "Decisione sui tassi Fed: 3 giorni prima e 3 giorni dopo il comunicato.")

    # ---- weekend / gap CME (orari UTC, k_1h)
    weekend = None
    if k1h is not None and len(k1h) > 1000:
        h = k1h[["time", "open", "high", "low", "close"]].reset_index(drop=True)
        tt = h["time"]
        fri = h.index[(tt.dt.dayofweek == 4) & (tt.dt.hour == 20)]
        pos_of = {t.value: k for k, t in enumerate(tt)}
        rows = []
        hi, lo, op, cl = h["high"].values, h["low"].values, h["open"].values, h["close"].values
        for i in fri:
            j = pos_of.get((tt.iat[i] + pd.Timedelta(hours=51)).value)  # barra ven 20:00 -> barra dom 23:00
            if j is None or j + 1 >= len(h):
                continue
            fc = cl[i]
            gap = (op[j] / fc - 1) * 100
            # riempimento entro venerdì successivo
            end = min(len(h), j + 117)
            filled_at = None
            for k in range(j, end):
                if lo[k] <= fc <= hi[k]:
                    filled_at = k - j
                    break
            mon_end = min(len(h) - 1, j + 24)
            rows.append({"gap": gap, "filled": filled_at is not None, "hours": filled_at, "mon": (cl[mon_end] / op[j] - 1) * 100})
        if rows:
            gaps = np.array([x["gap"] for x in rows])
            big = [x for x in rows if abs(x["gap"]) >= 1.0]
            weekend = {"n": len(rows), "avg_gap": rnd(gaps.mean()), "avg_abs_gap": rnd(np.abs(gaps).mean()),
                       "up_rate": rnd((gaps > 0).mean() * 100, 1),
                       "big_gap_rate": rnd(len(big) / len(rows) * 100, 1),
                       "fill_rate": rnd(np.mean([x["filled"] for x in rows]) * 100, 1),
                       "big_fill_rate": rnd(np.mean([x["filled"] for x in big]) * 100, 1) if big else None,
                       "median_fill_hours": rnd(np.median([x["hours"] for x in rows if x["filled"]]), 0) if any(x["filled"] for x in rows) else None,
                       "monday_avg": rnd(np.mean([x["mon"] for x in rows])),
                       "monday_win_rate": rnd(np.mean([x["mon"] > 0 for x in rows]) * 100, 1),
                       "text": ""}
            weekend["text"] = (f"Dal venerdì 21:00 UTC (chiusura CME) alla domenica 23:00 UTC BTC si è mosso in media del "
                               f"{weekend['avg_abs_gap']:.2f}% (gap ≥1% nel {weekend['big_gap_rate']:.0f}% dei weekend); il livello di "
                               f"chiusura del venerdì è stato ritoccato entro la settimana nel {weekend['fill_rate']:.0f}% dei casi "
                               f"({weekend['big_fill_rate'] or 0:.0f}% per i gap ≥1%).")

    # ---- prossimi eventi nel periodo
    upcoming = []
    end = today + horizon * DAY
    by_key = {s["key"]: s for s in stats}

    def push(key, t, title):
        st = by_key.get(key)
        if st is None or not (today <= t <= end):
            return
        wr = st["post_win_rate"] or 50
        if wr >= 60:
            exp, prob = "rialzo", wr
        elif wr <= 40:
            exp, prob = "ribasso", 100 - wr
        else:
            exp, prob = "volatilita", st["big_move_rate"]
        strength = {"fomc": 0.45, "opex_quarter": 0.35, "quarter_open": 0.3, "year_open": 0.3, "month_open": 0.2,
                    "month_close": 0.2, "opex_month": 0.18, "mid_month": 0.12}.get(key, 0.15)
        strength *= 0.7 + 0.6 * min(1.0, abs(wr - 50) / 25)
        text = (f"{title}: storicamente nei 3 giorni successivi BTC è salito nel {st['post_win_rate']:.0f}% dei casi "
                f"(media {st['post_avg']:+.2f}%, n={st['n']}); movimento oltre la mediana nel {st['big_move_rate']:.0f}% dei casi.")
        upcoming.append({"key": key, "title": title, "time": ts(t), "start": ts(t - DAY), "end": ts(t + 3 * DAY),
                         "expected": exp, "probability": rnd(prob, 1), "strength": rnd(strength, 3), "text": text})

    for t in pd.date_range(today, end, freq="D"):
        if t.day == 1:
            if t.month == 1:
                push("year_open", t, "Inizio anno")
            elif t.month in (4, 7, 10):
                push("quarter_open", t, f"Apertura del trimestre Q{(t.month - 1) // 3 + 1}")
            else:
                push("month_open", t, f"Apertura di {MESI[t.month - 1]}")
        if t.day == 15:
            push("mid_month", t, f"Metà {MESI[t.month - 1]}")
        if t == _last_friday(t.year, t.month):
            push("opex_quarter" if t.month in (3, 6, 9, 12) else "opex_month", t,
                 f"Scadenza opzioni {'trimestrale' if t.month in (3, 6, 9, 12) else 'mensile'} ({fmt_date(t)})")
    for t in fomc_all:
        if today <= t <= end:
            push("fomc", t, f"FOMC {fmt_date(t, True)}")
    fomc_next = [ts(t) for t in fomc_all if t >= today]
    return {"stats": stats, "weekend": weekend, "upcoming": upcoming,
            "fomc": {"dates": [ts(t) for t in fomc_all], "next": fomc_next[:3], "stats": fomc,
                     "note": "Date FOMC dal calendario ufficiale della Federal Reserve (2017–2026)."},
            "baseline": {"abs_1d": rnd(base_abs1), "abs_3d": rnd(base_abs3), "up_rate_1d": rnd(base_up1, 1)}}


# ===================================================================== calendario

SRC_LABEL = {"stagionale": "Finestra stagionale", "ciclo": "Tempo di ciclo", "fibonacci": "Fibonacci time zone",
             "gambe": "Gambe uguali", "spaziatura": "Spaziatura swing", "evento": "Evento ricorrente"}
BULL = {"rialzo", "inversione_rialzista"}
BEAR = {"ribasso", "inversione_ribassista"}


def calendar(windows: dict, cyc: dict, proj: dict, ev: dict, now: pd.Timestamp, horizon: int) -> list[dict]:
    today = now.normalize()
    end = today + horizon * DAY
    raw: list[dict] = []
    for w in windows["upcoming"]:
        s = min(0.6, (-math.log10(max(w["p_value"] or 1, 1e-9))) / 5) * (0.5 + 0.5 * (w["consistency"] or 0) / 100)
        if w["confidence"] == "alta":
            s = min(0.65, s * 1.1)
        raw.append({"source": "stagionale", "time": w["date"], "start": w["start"], "end": w["end"], "strength": s,
                    "expected": w["expected"], "probability": w["consistency"], "text": w["text"], "ref": w["id"],
                    "title": f"Finestra {w['label']}"})
    for it in cyc["items"] + [dict(c, key=f"cl_{i}", label=f"Cluster {c['kind_label']} ~{c['projected_days']:.0f} giorni dall'halving")
                              for i, c in enumerate(cyc["clusters"])]:
        a, b = pd.Timestamp(it["from"], unit="s", tz="UTC"), pd.Timestamp(it["to"], unit="s", tz="UTC")
        if b < today or a > end:
            continue
        mid = pd.Timestamp(it["mid"], unit="s", tz="UTC")
        unc = max(5.0, (b - a).days / 2)
        is_cl = it["key"].startswith("cl_")
        s = (0.3 + 0.08 * (it.get("cycles", 2) - 1)) if is_cl else (0.45 if unc <= 30 else 0.38)
        exp = "inversione_rialzista" if it["kind"] == "bottom" else "inversione_ribassista"
        base = {"source": "ciclo", "expected": exp, "probability": None, "text": it["text"], "title": it["label"],
                "mid": it["mid"], "unc": unc}
        # elemento puntuale al centro della finestra (se cade nel periodo)
        if today - 3 * DAY <= mid <= end:
            raw.append(dict(base, time=it["mid"], start=ts(mid - 3 * DAY), end=ts(mid + 3 * DAY), strength=s))
        # la finestra ampia rafforza (con peso decrescente dal centro) gli altri pivot che vi cadono dentro
        raw.append(dict(base, time=it["mid"], start=ts(max(a, today)), end=ts(min(b, end)), strength=s, wide=True))
    for it in proj["items"]:
        raw.append({"source": it["source"], "time": it["time"], "start": it["start"], "end": it["end"], "strength": it["strength"],
                    "expected": it["expected"], "probability": None, "text": it["text"], "title": SRC_LABEL[it["source"]]})
    for it in ev["upcoming"]:
        raw.append({"source": "evento", "time": it["time"], "start": it["start"], "end": it["end"], "strength": it["strength"],
                    "expected": it["expected"], "probability": it["probability"], "text": it["text"], "title": it["title"],
                    "event_key": it["key"]})

    # le finestre di ciclo molto ampie non formano cluster da sole: si agganciano agli elementi puntuali che cadono dentro
    point = sorted([r for r in raw if not r.get("wide")], key=lambda r: r["time"])
    wide = [r for r in raw if r.get("wide")]
    clusters: list[list[dict]] = []
    for r in point:
        if clusters:
            cl = clusters[-1]
            c_end = max(x["end"] for x in cl)
            c_start = min(x["start"] for x in cl)
            if r["start"] <= c_end + 86400 and r["time"] - c_start <= 9 * 86400:
                cl.append(r)
                continue
        clusters.append([r])
    out = []
    for cl in clusters:
        mid_t = sum(x["time"] * x["strength"] for x in cl) / max(1e-9, sum(x["strength"] for x in cl))
        own = {(x["source"], x["title"]) for x in cl}
        attached = [w for w in wide if w["start"] <= mid_t <= w["end"] and (w["source"], w["title"]) not in own]
        members = cl + [dict(w, strength=w["strength"] * 0.45 * math.exp(-((mid_t - w["mid"]) / 86400 / w["unc"]) ** 2))
                        for w in attached]
        members = [m for m in members if m["strength"] >= 0.04]
        src_types = sorted(set(x["source"] for x in members))
        # stesso tipo di fonte = informazione correlata: conta la più forte + 30% delle altre
        eff: dict[int, float] = {}
        prod = 1.0
        for st in src_types:
            grp = sorted([x for x in members if x["source"] == st], key=lambda x: -x["strength"])
            tot = grp[0]["strength"] + 0.3 * sum(x["strength"] for x in grp[1:])
            cap = min(0.75, tot)
            for x in grp:
                eff[id(x)] = x["strength"] * cap / tot if tot > 0 else 0
            prod *= 1 - cap
        conf = (1 - prod) * 100 * min(1.0, 0.6 + 0.15 * len(src_types))
        conf = float(min(100.0, conf))
        # la direzione la decidono i pivot puntuali; le finestre di ciclo ampie solo se non ce ne sono
        W = lambda x: eff.get(id(x), 0.0) * (0.25 if x.get("wide") else 1.0)  # noqa: E731
        bull = sum(W(x) for x in members if x["expected"] in BULL)
        bear = sum(W(x) for x in members if x["expected"] in BEAR)
        rev = sum(W(x) for x in members if x["expected"].startswith("inversione"))
        vol = sum(W(x) for x in members if x["expected"] == "volatilita")
        if bull > 1.4 * bear and bull >= 0.15:
            rev_share = sum(W(x) for x in members if x["expected"] == "inversione_rialzista") / bull
            expected = "inversione_rialzista" if rev_share > 0.5 else "rialzo"
        elif bear > 1.4 * bull and bear >= 0.15:
            rev_share = sum(W(x) for x in members if x["expected"] == "inversione_ribassista") / bear
            expected = "inversione_ribassista" if rev_share > 0.5 else "ribasso"
        elif rev >= vol and rev > 0:
            expected = "inversione"
        else:
            expected = "volatilita"
        probs = [x["probability"] for x in members if x.get("probability") is not None and
                 ((expected in BULL and x["expected"] in BULL) or (expected in BEAR and x["expected"] in BEAR) or
                  (expected in ("volatilita", "inversione")))]
        prob = rnd(np.mean(probs), 1) if probs else None
        start = int(max(min(x["start"] for x in cl), min(x["time"] for x in cl) - 3 * 86400, mid_t - 6 * 86400))
        endt = int(min(max(x["end"] for x in cl), max(x["time"] for x in cl) + 3 * 86400, mid_t + 6 * 86400))
        a = pd.Timestamp(start, unit="s", tz="UTC")
        b = pd.Timestamp(endt, unit="s", tz="UTC")
        lead = max(cl, key=lambda x: x["strength"])
        exp_txt = {"rialzo": "rialzo", "ribasso": "ribasso", "inversione_rialzista": "inversione al rialzo",
                   "inversione_ribassista": "inversione al ribasso", "inversione": "possibile inversione",
                   "volatilita": "aumento di volatilità"}[expected]
        summary = (f"{fmt_day_range(a, b)}: {len(src_types)} {'fonte' if len(src_types) == 1 else 'fonti indipendenti'} "
                   f"({', '.join(SRC_LABEL[s].lower() for s in src_types)}) indicano {exp_txt}"
                   + (f" (probabilità storica {prob:.0f}%)." if prob is not None else "."))
        out.append({
            "id": f"p{int(mid_t)}", "time": int(mid_t), "start": start, "end": endt, "label": fmt_day_range(a, b),
            "title": lead["title"], "confluence": rnd(conf, 0), "expected": expected, "probability": prob,
            "sources": [{"type": x["source"], "label": SRC_LABEL[x["source"]], "title": x["title"], "text": x["text"],
                         "expected": x["expected"], "strength": rnd(x["strength"] * 100, 0), "probability": rnd(x.get("probability"), 1),
                         "ref": x.get("ref")} for x in sorted(members, key=lambda x: -x["strength"])],
            "source_types": src_types, "summary": summary,
            "days_away": int(round((mid_t - today.timestamp()) / 86400)),
        })
    out.sort(key=lambda x: x["time"])
    return out


# ===================================================================== kpi / oggi

def today_block(seas: dict, windows: dict, cal: list[dict], now: pd.Timestamp) -> dict:
    today = now.normalize()
    week_end = today + 7 * DAY
    wd = next((x for x in seas["weekday"]["stats"] if x["dow"] == now.dayofweek), None)
    mday = next((x for x in seas["monthday"]["stats"] if x["day"] == now.day), None)
    month = seas["monthly"]["stats"][now.month - 1]
    this_week = [c for c in cal if c["start"] <= week_end.timestamp() and c["end"] >= today.timestamp()]
    lines = []
    if wd and wd["avg"] is not None:
        lines.append(f"Oggi è {GIORNI[now.dayofweek].lower()}: storicamente rendimento medio {wd['avg']:+.2f}% e chiusura positiva nel {wd['win_rate']:.0f}% dei casi.")
    if month["avg"] is not None:
        lines.append(f"{MESI[now.month - 1].capitalize()}: positivo in {round(month['win_rate'] * month['n'] / 100)} anni su {month['n']} (media {month['avg']:+.1f}%, mediana {month['median']:+.1f}%).")
    for w in windows["active"][:2]:
        lines.append(w["text"])
    if this_week:
        lines.append(f"Questa settimana: {len(this_week)} pivot nel calendario, il più forte {this_week[0]['label'] if len(this_week) == 1 else max(this_week, key=lambda c: c['confluence'])['label']} "
                     f"(confluenza {max(c['confluence'] for c in this_week):.0f}/100).")
    return {"date": ts(today), "weekday": wd, "monthday": mday, "month": month, "active_windows": [w["id"] for w in windows["active"]],
            "this_week": [c["id"] for c in this_week], "lines": lines}
