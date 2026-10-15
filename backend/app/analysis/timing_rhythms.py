"""Scopritore di ritmi: verifica dei "pattern strani" di calendario contro il caso, con correzione per test multipli.

Due famiglie:
- `thirds`: il mese in tre parti (giorni 1–10, 11–20, 21–fine) con uno schema di segni (es. "+-+" = pump all'inizio,
  dump a metà, pump a fine mese). Definizioni: `close` = segno del rendimento chiusura→chiusura di ogni parte (la prima
  parte parte dalla chiusura del mese precedente); `extremes` = catena di estremi intra-mese con soglia θ: una parte "+"
  se il suo massimo supera di θ il riferimento (all'inizio la chiusura del mese precedente, poi l'estremo della parte
  precedente), una parte "−" se il suo minimo scende di θ sotto il riferimento.
  Atteso per caso = frequenza dello stesso schema su TUTTE le finestre di 30 giorni (10+10+10) che iniziano in un giorno
  qualsiasi dello stesso campione: misura quanto lo schema è comune per la sola volatilità di BTC, senza calendario.
  p = binomiale (mesi di calendario indipendenti) e correzione di Šidák per le combinazioni guardate.
- `weekday` · `monthweek` · `monthday` · `hour`: rendimento medio per casella (giorno della settimana, settimana del
  mese, giorno del mese, ora UTC) contro le altre caselle (t di Welch), Benjamini-Hochberg tra le caselle e test di
  famiglia (massimo |t| contro 500 permutazioni dei rendimenti).
Funzioni pure.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
from scipy import stats

from .astro import bh

ALPHA = 0.05
SEED = 20261015
N_PERM_FAMILY = 500
PATTERNS = ["+++", "++-", "+-+", "+--", "-++", "-+-", "--+", "---"]
THETAS = [2.0, 3.0, 5.0]
CUTS = (10, 20)
KINDS = ("thirds", "weekday", "monthweek", "monthday", "hour")
# combinazioni che lo strumento permette di guardare per il mese in tre parti: 26 schemi (+, −, qualsiasi; escluso
# "tutto qualsiasi") × 4 definizioni (chiusure + estremi con 3 soglie) → correzione di Šidák su 104 confronti
COMBOS = (3 ** 3 - 1) * (1 + len(THETAS))


def rnd(x, d: int = 3):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(f) else round(f, d)


def binom_sf(k: int, n: int, p: float) -> float:
    """P(X ≥ k), X ~ Bin(n, p)."""
    if n <= 0:
        return 1.0
    return float(stats.binom.sf(k - 1, n, p))


def sidak(p: float | None, m: int) -> float | None:
    if p is None:
        return None
    return float(1 - (1 - min(1.0, p)) ** m)


def verdict(p: float | None, p_adj: float | None, n: int, stable: bool, min_n: int) -> str:
    if p is None:
        return "none"
    if n < min_n:
        return "anecdotal"
    if (p_adj or 1) < ALPHA and stable:
        return "strong"
    if p < ALPHA or (p_adj or 1) < ALPHA:
        return "weak"
    return "none"


# ============================================================ thirds

def match(O: np.ndarray, segs: list[tuple[np.ndarray, np.ndarray, np.ndarray]], pattern: str, how: str, theta: float) -> np.ndarray:
    """Vettoriale: O = riferimento iniziale, segs = [(H, L, C)] per le 3 parti. Restituisce bool per finestra."""
    ok = np.ones(len(O), bool)
    if how == "close":
        prev = O
        for (H, L, C), s in zip(segs, pattern):
            r = C / prev - 1
            if s == "+":
                ok &= r > 0
            elif s == "-":
                ok &= r < 0
            prev = C
        return ok
    th = theta / 100
    P = O.astype(float)
    for (H, L, C), s in zip(segs, pattern):
        if s == "+":
            ok &= H >= P * (1 + th)
            P = H
        elif s == "-":
            ok &= L <= P * (1 - th)
            P = L
        else:
            P = C
    return ok


def _month_frame(g, start: pd.Timestamp, today: pd.Timestamp) -> list[dict]:
    """Per ogni mese di calendario dal `start`: riferimento (chiusura del mese precedente) ed estremi delle 3 parti.
    Le parti non ancora concluse (giorni ≥ oggi) restano None."""
    s = pd.DataFrame({"high": g.high, "low": g.low, "close": g.close}, index=g.idx)
    out = []
    m = pd.Timestamp(year=start.year, month=start.month, day=1, tz="UTC")
    while m <= today:
        nxt = m + pd.offsets.MonthBegin(1)
        prev_day = m - pd.Timedelta(days=1)
        if prev_day < s.index[0]:
            m = nxt
            continue
        O = float(s["close"].loc[prev_day])
        last_day = nxt - pd.Timedelta(days=1)
        bounds = [(m, m + pd.Timedelta(days=CUTS[0] - 1)), (m + pd.Timedelta(days=CUTS[0]), m + pd.Timedelta(days=CUTS[1] - 1)),
                  (m + pd.Timedelta(days=CUTS[1]), last_day)]
        segs = []
        for a, b in bounds:
            if b >= today.normalize():   # parte non conclusa (oggi è ancora in formazione)
                segs.append(None)
                continue
            x = s.loc[a:b]
            segs.append({"start": a, "end": b, "high": float(x["high"].max()), "low": float(x["low"].min()), "close": float(x["close"].iloc[-1])})
        out.append({"month": m, "open": O, "segs": segs, "complete": all(sg is not None for sg in segs)})
        m = nxt
    return out


def _eval_months(months: list[dict], pattern: str, how: str, theta: float) -> list[bool | None]:
    res = []
    for mo in months:
        if not mo["complete"]:
            res.append(None)
            continue
        O = np.array([mo["open"]])
        segs = [(np.array([sg["high"]]), np.array([sg["low"]]), np.array([sg["close"]])) for sg in mo["segs"]]
        res.append(bool(match(O, segs, pattern, how, theta)[0]))
    return res


def _partial_status(mo: dict, pattern: str, how: str, theta: float) -> list[bool | None]:
    """Mese in corso: esito parte per parte (None = parte non ancora conclusa)."""
    out = []
    O = mo["open"]
    P = O
    prev = O
    ok_so_far = True
    for sg, s in zip(mo["segs"], pattern):
        if sg is None:
            out.append(None)
            continue
        if how == "close":
            r = sg["close"] / prev - 1
            okk = True if s == "." else (r > 0 if s == "+" else r < 0)
            prev = sg["close"]
        else:
            th = theta / 100
            if s == "+":
                okk = sg["high"] >= P * (1 + th)
                P = sg["high"]
            elif s == "-":
                okk = sg["low"] <= P * (1 - th)
                P = sg["low"]
            else:
                okk = True
                P = sg["close"]
        ok_so_far = ok_so_far and okk
        out.append(bool(okk))
    return out


def _sliding_null(g, lo: int, hi: int, pattern: str, how: str, theta: float) -> tuple[float, int]:
    """Frequenza dello schema su tutte le finestre 10+10+10 giorni che iniziano in un giorno qualsiasi tra lo e hi."""
    from numpy.lib.stride_tricks import sliding_window_view as sw
    h, l, c = g.high, g.low, g.close
    starts = np.arange(max(lo, 1), hi - 29)
    if len(starts) < 50:
        return float("nan"), 0
    H10 = sw(h, 10).max(axis=1)
    L10 = sw(l, 10).min(axis=1)
    O = c[starts - 1]
    segs = []
    for k in range(3):
        idx = starts + 10 * k
        segs.append((H10[idx], L10[idx], c[idx + 9]))
    m = match(O, segs, pattern, how, theta)
    return float(m.mean()), int(len(starts))


def thirds(g, today: pd.Timestamp, start: pd.Timestamp, recent_from: pd.Timestamp, pattern: str, how: str, theta: float) -> dict:
    months = _month_frame(g, start, today)
    lo = g.pos(start)
    hi = g.pos(today) - 1
    hc = [mo for mo in months if mo["complete"]]
    def entry(pat: str) -> dict:
        res = _eval_months(hc, pat, how, theta)
        k = sum(1 for x in res if x)
        n = len(res)
        p0, _nw = _sliding_null(g, lo, hi, pat, how, theta)
        p = binom_sf(k, n, p0) if n and np.isfinite(p0) else None
        return {"pattern": pat, "n": n, "k": k, "rate": rnd(k / n * 100 if n else None, 1), "null": rnd(p0 * 100, 1),
                "lift": rnd((k / n) / p0 if n and p0 else None, 2), "p": rnd(p, 4)}

    fam = [entry(pat) for pat in PATTERNS]
    for f, pb in zip(fam, bh([f["p"] for f in fam])):
        f["p_bh"] = pb
    sel = next((f for f in fam if f["pattern"] == pattern), None) or entry(pattern)
    res_all = _eval_months(months, pattern, how, theta)
    rows = []
    for mo, r in zip(months, res_all):
        segs = []
        prev = mo["open"]
        for sg in mo["segs"]:
            if sg is None:
                segs.append(None)
                continue
            segs.append({"ret": rnd((sg["close"] / prev - 1) * 100, 2), "high": rnd(sg["high"], 2), "low": rnd(sg["low"], 2),
                         "close": rnd(sg["close"], 2), "up_from_ref": None})
            prev = sg["close"]
        rows.append({"month": mo["month"], "open": rnd(mo["open"], 2), "segs": segs, "match": r,
                     "partial": None if mo["complete"] else _partial_status(mo, pattern, how, theta)})
    # periodo recente (solo mesi completi da recent_from)
    rec = [(mo, r) for mo, r in zip(months, res_all) if mo["month"] >= recent_from.normalize().replace(day=1) and r is not None]
    kr = sum(1 for _, r in rec if r)
    nr = len(rec)
    p0 = (sel["null"] or 0) / 100
    p_rec = binom_sf(kr, nr, p0) if nr and p0 else None
    # stabilità per anno e per anno del ciclo dell'halving
    by_year: dict[int, list[bool]] = {}
    for mo, r in zip(months, res_all):
        if r is not None:
            by_year.setdefault(mo["month"].year, []).append(r)
    years = [{"year": y, "n": len(v), "k": sum(v), "rate": rnd(sum(v) / len(v) * 100, 1)} for y, v in sorted(by_year.items())]
    above = [y for y in years if y["n"] >= 6]
    stable = bool(above) and sum((y["rate"] or 0) > (sel["null"] or 0) for y in above) / len(above) >= 2 / 3
    # rendimento medio di ogni parte (chiusure) contro le altre due parti degli stessi mesi (t di Welch)
    seg_vals = []
    for si in range(3):
        vals = []
        for mo in hc:
            prev = mo["open"] if si == 0 else mo["segs"][si - 1]["close"]
            vals.append((mo["segs"][si]["close"] / prev - 1) * 100)
        seg_vals.append(np.array(vals))
    seg_means = []
    for si in range(3):
        v = seg_vals[si]
        others = np.concatenate([seg_vals[j] for j in range(3) if j != si])
        _t, p = _welch(v, others)
        seg_means.append({"seg": si + 1, "n": len(v), "mean": rnd(v.mean(), 2), "median": rnd(np.median(v), 2),
                          "up": rnd(np.mean(v > 0) * 100, 1), "others_mean": rnd(others.mean(), 2), "p": rnd(p, 4)})
    combos = COMBOS
    naive = None
    if how == "close":
        ups = [(s["up"] or 0) / 100 for s in seg_means]
        naive = 1.0
        for s, u in zip(pattern, ups):
            naive *= u if s == "+" else (1 - u) if s == "-" else 1
    p_full = sel["p"]
    return {
        "kind": "thirds", "pattern": pattern, "def": how, "theta": theta, "cuts": list(CUTS),
        "full": {**sel, "naive": rnd(naive * 100, 1) if naive is not None else None, "coin": rnd(100 / 2 ** sum(1 for s in pattern if s in "+-"), 1)},
        "recent": {"from": recent_from, "n": nr, "k": kr, "rate": rnd(kr / nr * 100 if nr else None, 1), "p": rnd(p_rec, 4),
                   "months": [{"month": mo["month"], "match": r} for mo, r in rec]},
        "family": fam, "combos": combos, "p_sidak": rnd(sidak(p_full, combos), 4),
        "verdict": verdict(p_full, sidak(p_full, combos), sel["n"], stable, 24),
        "stable": stable, "by_year": years, "seg_means": seg_means, "months": rows[::-1],
        "null_windows": _sliding_null(g, lo, hi, pattern, how, theta)[1],
    }


# ============================================================ caselle (giorno, settimana, ora)

def _bucket_series(kind: str, g, k1h: pd.DataFrame | None, start: pd.Timestamp, today: pd.Timestamp) -> tuple[pd.Series, pd.Series, list]:
    if kind == "hour":
        if k1h is None or not len(k1h):
            raise ValueError("dati orari non disponibili")
        d = k1h[["time", "close"]].copy()
        d = d[d["time"] >= start - pd.Timedelta(hours=1)]
        r = np.log(d["close"]).diff() * 100
        t = pd.DatetimeIndex(d["time"])
        s = pd.Series(r.to_numpy(), index=t).iloc[1:]
        s = s[s.index < today.floor("h")]      # ultima ora in formazione esclusa
        return s, pd.Series(s.index.hour, index=s.index), list(range(24))
    c = pd.Series(g.close, index=g.idx)
    r = (np.log(c).diff() * 100)
    r = r[(r.index >= start) & (r.index < today.normalize())]
    idx = r.index
    if kind == "weekday":
        b = pd.Series(idx.dayofweek, index=idx)
        return r, b, list(range(7))
    if kind == "monthweek":
        b = pd.Series(np.minimum((idx.day - 1) // 7, 4), index=idx)
        return r, b, list(range(5))
    b = pd.Series(idx.day, index=idx)
    return r, b, list(range(1, 32))


def _welch(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    if len(x) < 3 or len(y) < 3:
        return float("nan"), float("nan")
    t, p = stats.ttest_ind(x, y, equal_var=False)
    return float(t), float(p)


def buckets(kind: str, g, k1h: pd.DataFrame | None, today: pd.Timestamp, start: pd.Timestamp, recent_from: pd.Timestamp) -> dict:
    r, b, labels = _bucket_series(kind, g, k1h, start, today)
    rv = r.to_numpy(float)
    bv = b.to_numpy(int)
    ok = np.isfinite(rv)
    rv, bv, tix = rv[ok], bv[ok], r.index[ok]
    years = tix.year.to_numpy()
    rec = tix >= recent_from
    min_n = 30 if kind != "hour" else 100
    rows = []
    ts = []
    for lab in labels:
        m = bv == lab
        x, y = rv[m], rv[~m]
        t, p = _welch(x, y)
        ts.append(abs(t) if np.isfinite(t) else 0.0)
        mr = m & rec
        xr, yr = rv[mr], rv[~m & rec]
        tr_, pr = _welch(xr, yr)
        # stabilità: segno della differenza (casella − resto) per anno
        signs = []
        per_year = []
        for yy in np.unique(years):
            my = years == yy
            a, bb = rv[m & my], rv[~m & my]
            if len(a) >= (3 if kind != "hour" else 20):
                dlt = a.mean() - bb.mean()
                signs.append(np.sign(dlt))
                per_year.append({"year": int(yy), "diff": rnd(dlt, 3), "n": int(len(a))})
        eff = x.mean() - y.mean() if len(x) and len(y) else np.nan
        same = [s for s in signs if s == np.sign(eff)]
        stable = bool(len(signs) >= 4 and len(same) / len(signs) >= 2 / 3)
        rows.append({"bucket": lab, "n": int(len(x)), "mean": rnd(x.mean() if len(x) else None, 3), "median": rnd(np.median(x) if len(x) else None, 3),
                     "up": rnd(np.mean(x > 0) * 100 if len(x) else None, 1), "diff": rnd(eff, 3), "t": rnd(t, 2), "p": rnd(p, 4),
                     "stable": stable, "share_same_sign": rnd(len(same) / len(signs) * 100 if signs else None, 0),
                     "recent": {"n": int(len(xr)), "mean": rnd(xr.mean() if len(xr) else None, 3), "up": rnd(np.mean(xr > 0) * 100 if len(xr) else None, 1),
                                "diff": rnd(xr.mean() - yr.mean() if len(xr) and len(yr) else None, 3), "p": rnd(pr, 4)},
                     "years": per_year})
    for row, pb in zip(rows, bh([x["p"] for x in rows])):
        row["p_bh"] = pb
        row["verdict"] = verdict(row["p"], pb, row["n"], row["stable"], min_n)
    for row, pb in zip(rows, bh([x["recent"]["p"] for x in rows])):
        row["recent"]["p_bh"] = pb
    # test di famiglia: max |t| osservato contro le permutazioni dei rendimenti (calendario distrutto)
    rng = np.random.default_rng(SEED)
    obs = max(ts) if ts else 0.0
    K = max(labels) + 1
    cnt = np.bincount(bv, minlength=K)
    exceed = 0
    tot_n = len(rv)
    for _ in range(N_PERM_FAMILY):
        pr_ = rng.permutation(rv)
        s1 = np.bincount(bv, weights=pr_, minlength=K)
        s2 = np.bincount(bv, weights=pr_ ** 2, minlength=K)
        S1, S2 = pr_.sum(), (pr_ ** 2).sum()
        mx = 0.0
        for lab in labels:
            n1 = cnt[lab]
            n2 = tot_n - n1
            if n1 < 3 or n2 < 3:
                continue
            m1, m2 = s1[lab] / n1, (S1 - s1[lab]) / n2
            v1 = max(s2[lab] / n1 - m1 ** 2, 1e-12) * n1 / (n1 - 1)
            v2 = max((S2 - s2[lab]) / n2 - m2 ** 2, 1e-12) * n2 / (n2 - 1)
            tt = abs(m1 - m2) / math.sqrt(v1 / n1 + v2 / n2)
            mx = max(mx, tt)
        exceed += mx >= obs - 1e-12
    p_family = (1 + exceed) / (1 + N_PERM_FAMILY)
    # mappa anno × casella (rendimento medio) per la stabilità
    heat = []
    for yy in np.unique(years):
        my = years == yy
        row = []
        for lab in labels:
            x = rv[my & (bv == lab)]
            row.append(rnd(x.mean() if len(x) >= (2 if kind != "hour" else 10) else None, 3))
        heat.append({"year": int(yy), "values": row})
    return {"kind": kind, "labels": labels, "rows": rows, "family": {"max_t": rnd(obs, 2), "p": rnd(p_family, 4), "n_perm": N_PERM_FAMILY,
            "tests": len(labels)}, "heat": heat, "n": int(len(rv)), "since": tix[0] if len(tix) else None,
            "recent": {"from": recent_from, "n": int(rec.sum())}}
