"""Timing in stile Gann: conteggi di giorni dai pivot maggiori, date chiave con confluenza e verifica storica.

Funzioni pure (nessun I/O). Convenzioni:
- serie giornaliera continua (DailyGrid di timepivots: high/low/close per posizione = giorni dall'inizio);
- ancore = pivot maggiori dello zigzag ATR confermato (structure.zigzag_confirmed), con l'indice di conferma `ci`:
  una proiezione è valida solo se la sua finestra inizia DOPO la conferma dell'ancora (nessun dato futuro);
- bersaglio = pivot a N giorni (frattale: massimo/minimo più estremo delle 2N+1 candele centrate);
- colpo = almeno un bersaglio entro ±W giorni dalla data proiettata.
Test: placebo a traslazione circolare delle date proiettate (stessa densità e stessi grappoli di date) e placebo dei
conteggi (stesse ancore, conteggi vicini non di Gann). Correzione di Benjamini-Hochberg su tutti i tipi di conteggio.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .astro import bh
from .market import atr as _atr
from .structure import fractals, zigzag_confirmed

DAY = pd.Timedelta(days=1)
SAMPLE_START = pd.Timestamp("2012-01-01", tz="UTC")
ANCHOR_MULT = 4.0          # zigzag 4×ATR(14) giornaliero = pivot maggiori
MIN_SHIFT = 30             # traslazione minima del placebo (giorni)
N_CTRL = 400               # estrazioni del placebo dei conteggi
SEED = 20261015
ALPHA = 0.05
MIN_N = 30                 # sotto questo numero di date proiettate il verdetto è "aneddotico"
CLUSTER_TOL = 1            # due proiezioni a ≤1 giorno appartengono alla stessa data di confluenza
YEAR = 365.25


def _sq9_cross(lo: int = 20, hi: int = 400) -> list[int]:
    """Numeri sulle croci cardinale e diagonale del quadrato del 9 (anello r: (2r−1)² + j·r, j = 1..8)."""
    out = set()
    for r in range(1, 12):
        base = (2 * r - 1) ** 2
        for j in range(1, 9):
            v = base + j * r
            if lo <= v <= hi:
                out.add(v)
    return sorted(out)


# id -> (etichetta, conteggi in giorni, descrizione). I tipi "seasonal" e "anniv" sono trattati a parte.
COUNT_TYPES: dict[str, dict] = {
    "c30": {"days": [30], "group": "giorni"},
    "c45": {"days": [45], "group": "giorni"},
    "c60": {"days": [60], "group": "giorni"},
    "c90": {"days": [90], "group": "giorni"},
    "c120": {"days": [120], "group": "giorni"},
    "c144": {"days": [144], "group": "giorni"},
    "c180": {"days": [180], "group": "giorni"},
    "c270": {"days": [270], "group": "giorni"},
    "c360": {"days": [360], "group": "giorni"},
    "c_mult": {"days": [540, 720, 1080], "group": "giorni"},
    "sq9": {"days": _sq9_cross(), "group": "quadrato"},
    "yeardiv": {"days": [round(YEAR * f) for f in (1 / 8, 1 / 6, 1 / 4, 1 / 3)], "group": "anno"},
    "anniv": {"days": [round(YEAR * k) for k in (1, 2, 3, 4)], "group": "anno"},
    "seasonal": {"days": [], "group": "anno"},   # date fisse: equinozi, solstizi e punti intermedi (1/8 dell'anno)
}
TYPE_ORDER = list(COUNT_TYPES)
# date stagionali di Gann (mese, giorno): equinozi/solstizi e date intermedie (ottavi dell'anno solare)
SEASONAL_DATES = [(2, 4), (3, 21), (5, 6), (6, 21), (8, 8), (9, 22), (11, 8), (12, 21)]


def rnd(x, d: int = 3):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(f) else round(f, d)


# ============================================================ preparazione

def _causal_atr(g) -> np.ndarray:
    """ATR(14) con le prime candele (senza ATR) riempite col primo valore disponibile: nessuna dipendenza dal futuro."""
    a = _atr(g.frame).to_numpy(float)
    ok = np.isfinite(a)
    return np.where(ok, a, a[ok][0] if ok.any() else 1.0)


def anchors(g, mult: float = ANCHOR_MULT) -> list[dict]:
    """Pivot maggiori confermati: i = posizione del pivot, ci = posizione della conferma (prima data in cui è noto)."""
    piv = zigzag_confirmed(g.high, g.low, _causal_atr(g), mult)
    out = []
    for p in piv:
        if p.get("ci") is None:
            continue
        out.append({"i": int(p["i"]), "ci": int(p["ci"]), "kind": p["kind"], "price": float(p["price"])})
    return out


def open_extreme(g, mult: float = ANCHOR_MULT) -> dict | None:
    piv = zigzag_confirmed(g.high, g.low, _causal_atr(g), mult)
    if piv and piv[-1].get("ci") is None:
        p = piv[-1]
        return {"i": int(p["i"]), "kind": p["kind"], "price": float(p["price"])}
    return None


def targets(g, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Pivot a n giorni (massimi e minimi frattali). Valutabili solo fino a last − n."""
    ph, pl = fractals(g.high, g.low, n)
    return ph, pl


def near_mask(tgt: np.ndarray, w: int) -> np.ndarray:
    """near[t] = c'è almeno un bersaglio in [t − w, t + w]."""
    k = np.ones(2 * w + 1)
    return np.convolve(tgt.astype(float), k, mode="same") > 0


def _seasonal_positions(g, lo: int, hi: int, shift: int = 0) -> np.ndarray:
    out = []
    for y in range(g.idx[0].year, g.idx[-1].year + 2):
        for m, d in SEASONAL_DATES:
            t = pd.Timestamp(year=y, month=m, day=d, tz="UTC") + shift * DAY
            p = int((t - g.start) / DAY)
            if lo <= p <= hi:
                out.append(p)
    return np.array(sorted(set(out)), int)


def projections(anc: list[dict], days: list[int], w: int, lo: int, hi: int) -> np.ndarray:
    """Posizioni proiettate (uniche) valide: dentro [lo, hi] e con la finestra che inizia dopo la conferma dell'ancora."""
    out = set()
    for a in anc:
        for k in days:
            p = a["i"] + k
            if p - w > a["ci"] and lo <= p <= hi:
                out.add(p)
    return np.array(sorted(out), int)


def _proj_pairs(anc: list[dict], days: list[int], w: int, lo: int, hi: int) -> list[tuple[int, int, int]]:
    """(ancora, conteggio, posizione) validi, per il placebo dei conteggi."""
    out = []
    for ai, a in enumerate(anc):
        for k in days:
            p = a["i"] + k
            if p - w > a["ci"] and lo <= p <= hi:
                out.append((ai, k, p))
    return out


# ============================================================ test

def _shift_null(near: np.ndarray, q: np.ndarray, lo: int, hi: int) -> np.ndarray:
    """Hit rate delle date q traslate circolarmente di ogni ampiezza ammessa dentro [lo, hi] (esaustivo)."""
    L = hi - lo + 1
    seg = near[lo:hi + 1].astype(float)
    qq = q - lo
    shifts = np.arange(MIN_SHIFT, L - MIN_SHIFT)
    out = np.empty(len(shifts))
    for i in range(0, len(shifts), 512):
        s = shifts[i:i + 512]
        out[i:i + 512] = seg[(qq[None, :] + s[:, None]) % L].mean(axis=1)
    return out


def _count_null(near: np.ndarray, anc: list[dict], pairs: list[tuple[int, int, int]], w: int, lo: int, hi: int,
                rng: np.random.Generator) -> np.ndarray:
    """Stesse ancore, conteggi alternativi k' = k·U(0.8, 1.2) lontani da k (|k' − k| > w + 1): hit rate per estrazione."""
    if not pairs:
        return np.array([])
    ai = np.array([p[0] for p in pairs])
    ks = np.array([p[1] for p in pairs], float)
    base_i = np.array([anc[a]["i"] for a in ai])
    ci = np.array([anc[a]["ci"] for a in ai])
    out = np.empty(N_CTRL)
    for r in range(N_CTRL):
        f = rng.uniform(0.8, 1.2, len(ks))
        k2 = np.round(ks * f).astype(int)
        bad = np.abs(k2 - ks) <= w + 1
        k2[bad] = np.round(ks[bad] * np.where(f[bad] >= 1, 1.2, 0.8)).astype(int)
        p = base_i + k2
        ok = (p - w > ci) & (p >= lo) & (p <= hi)
        pu = np.unique(p[ok])
        out[r] = near[pu].mean() if len(pu) else np.nan
    return out[np.isfinite(out)]


def _seasonal_null(near: np.ndarray, g, w: int, lo: int, hi: int) -> np.ndarray:
    vals = []
    for s in range(-22, 23):
        if abs(s) <= w + 1:
            continue
        q = _seasonal_positions(g, lo, hi, s)
        if len(q):
            vals.append(near[q].mean())
    return np.array(vals)


def _pv_greater(null: np.ndarray, obs: float) -> float | None:
    null = null[np.isfinite(null)]
    if not len(null) or not np.isfinite(obs):
        return None
    return float((1 + np.sum(null >= obs - 1e-12)) / (1 + len(null)))


def _halves(near: np.ndarray, q: np.ndarray, lo: int, hi: int, base_fn) -> list[dict]:
    mid = (lo + hi) // 2
    out = []
    for a, b in ((lo, mid), (mid + 1, hi)):
        qq = q[(q >= a) & (q <= b)]
        base = base_fn(a, b)
        rate = float(near[qq].mean()) if len(qq) else None
        out.append({"n": int(len(qq)), "rate": rnd(rate * 100 if rate is not None else None, 1), "base": rnd(base * 100, 1),
                    "lift": rnd(rate / base if rate is not None and base else None, 2)})
    return out


def verdict(row: dict) -> str:
    if row.get("p_shift") is None:
        return "none"
    if row["n"] < MIN_N:
        return "anecdotal"
    pc = row.get("p_counts")
    if (row.get("p_bh") or 1) < ALPHA and (pc is None or pc < ALPHA) and row.get("stable"):
        return "strong"
    if row["p_shift"] < ALPHA or (row.get("p_bh") or 1) < ALPHA:
        return "weak"
    return "none"


def backtest(g, anc: list[dict], near: np.ndarray, w: int, lo: int, hi: int) -> list[dict]:
    rng = np.random.default_rng(SEED)

    def base_fn(a, b):
        return float(near[a:b + 1].mean())

    rows = []
    for tid in TYPE_ORDER:
        cfg = COUNT_TYPES[tid]
        if tid == "seasonal":
            q = _seasonal_positions(g, lo, hi)
            ctrl = _seasonal_null(near, g, w, lo, hi)
        else:
            q = projections(anc, cfg["days"], w, lo, hi)
            ctrl = _count_null(near, anc, _proj_pairs(anc, cfg["days"], w, lo, hi), w, lo, hi, rng)
        n = int(len(q))
        if n == 0:
            rows.append({"id": tid, "n": 0, "verdict": "anecdotal"})
            continue
        obs = float(near[q].mean())
        null = _shift_null(near, q, lo, hi)
        halves = _halves(near, q, lo, hi, base_fn)
        base = float(np.mean(null))
        lift = obs / base if base else None
        stable = bool(lift and lift > 1 and all((h["lift"] or 0) > 1 for h in halves if h["n"] >= 10))
        rows.append({
            "id": tid, "group": cfg["group"], "days": cfg["days"], "n": n, "hits": int(near[q].sum()),
            "hit_rate": rnd(obs * 100, 1), "base_rate": rnd(base * 100, 1), "lift": rnd(lift, 2),
            "null_q05": rnd(np.quantile(null, 0.05) * 100, 1), "null_q95": rnd(np.quantile(null, 0.95) * 100, 1),
            "ctrl_rate": rnd(float(np.mean(ctrl)) * 100, 1) if len(ctrl) else None,
            "p_shift": rnd(_pv_greater(null, obs), 4), "p_counts": rnd(_pv_greater(ctrl, obs), 4),
            "halves": halves, "stable": stable,
        })
    pb = bh([r.get("p_shift") for r in rows])
    for r, p in zip(rows, pb):
        r["p_bh"] = p
        r["verdict"] = verdict(r) if r["n"] else "anecdotal"
    return rows


# ============================================================ confluenza

def score_series(anc: list[dict], g, w: int, lo: int, hi: int, known_at: int | None = None) -> tuple[np.ndarray, list[list[tuple]]]:
    """Per ogni giorno: numero di TIPI di conteggio distinti con una proiezione a ≤ CLUSTER_TOL giorni.
    Una proiezione conta solo se la sua finestra inizia dopo la conferma dell'ancora; con `known_at` (futuro) contano
    solo le ancore confermate entro quella posizione. Restituisce anche i contributi per giorno (solo se richiesto)."""
    size = hi + 1
    per_type = np.zeros((len(TYPE_ORDER), size), bool)
    contrib: list[list[tuple]] | None = [[] for _ in range(size)] if known_at is not None else None
    for ti, tid in enumerate(TYPE_ORDER):
        if tid == "seasonal":
            for p in _seasonal_positions(g, lo, hi):
                for d in range(p - CLUSTER_TOL, p + CLUSTER_TOL + 1):
                    if lo <= d <= hi:
                        per_type[ti, d] = True
                        if contrib is not None:
                            contrib[d].append((tid, None, 0, p))
            continue
        for ai, a in enumerate(anc):
            if known_at is not None and a["ci"] > known_at:
                continue
            for k in COUNT_TYPES[tid]["days"]:
                p = a["i"] + k
                if p - w <= a["ci"] or p < lo - CLUSTER_TOL or p > hi + CLUSTER_TOL:
                    continue
                for d in range(p - CLUSTER_TOL, p + CLUSTER_TOL + 1):
                    if lo <= d <= hi:
                        per_type[ti, d] = True
                        if contrib is not None:
                            contrib[d].append((tid, ai, k, p))
    return per_type.sum(axis=0), contrib


SCORE_BINS = [(0, 1), (2, 2), (3, 3), (4, 4), (5, 99)]


def score_backtest(S: np.ndarray, near: np.ndarray, lo: int, hi: int) -> list[dict]:
    """Hit rate dei giorni per punteggio di confluenza, con p da traslazione circolare della serie dei punteggi."""
    seg_s = S[lo:hi + 1]
    seg_n = near[lo:hi + 1].astype(float)
    L = len(seg_s)
    base = float(seg_n.mean())
    shifts = np.arange(MIN_SHIFT, L - MIN_SHIFT, 3)
    out = []
    pvals = []
    for a, b in SCORE_BINS:
        m = (seg_s >= a) & (seg_s <= b)
        n = int(m.sum())
        if n == 0:
            out.append({"min": a, "max": b if b < 99 else None, "n": 0})
            pvals.append(None)
            continue
        obs = float(seg_n[m].mean())
        idx = np.nonzero(m)[0]
        null = np.array([seg_n[(idx + s) % L].mean() for s in shifts])
        p = _pv_greater(null, obs)
        pvals.append(p)
        out.append({"min": a, "max": b if b < 99 else None, "n": n, "hit_rate": rnd(obs * 100, 1), "base_rate": rnd(base * 100, 1),
                    "lift": rnd(obs / base if base else None, 2), "null_q95": rnd(np.quantile(null, 0.95) * 100, 1), "p": rnd(p, 4)})
    for r, p in zip(out, bh(pvals)):
        r["p_bh"] = p
        if r["n"] == 0:
            r["verdict"] = "anecdotal"
        else:
            r["verdict"] = ("anecdotal" if r["n"] < MIN_N else "strong" if (p or 1) < ALPHA and (r["p"] or 1) < ALPHA else
                            "weak" if (r["p"] or 1) < ALPHA else "none")
    return out


def bin_of(score: int) -> int:
    for i, (a, b) in enumerate(SCORE_BINS):
        if a <= score <= b:
            return i
    return len(SCORE_BINS) - 1


def upcoming(g, anc: list[dict], today_pos: int, horizon: int, w: int, rows: dict[str, dict], sbt: list[dict]) -> list[dict]:
    """Prossime date da osservare: massimi locali del punteggio di confluenza tra oggi e oggi + horizon."""
    lo, hi = today_pos - CLUSTER_TOL, today_pos + horizon
    # estende la griglia oltre l'ultimo giorno disponibile
    S, contrib = score_series(anc, g, w, lo, hi + CLUSTER_TOL, known_at=today_pos)
    items = []
    d = max(lo, today_pos)
    used = np.zeros(len(S), bool)
    cand = sorted(range(max(lo, today_pos), hi + 1), key=lambda x: (-S[x], x))
    for d in cand:
        if S[d] < 1 or used[d]:
            continue
        # tutta la finestra ±W attorno a d diventa "usata"
        for x in range(d - w, d + w + 1):
            if 0 <= x < len(used):
                used[x] = True
        seen = set()
        srcs = []
        for tid, ai, k, p in contrib[d]:
            key = (tid, ai, k)
            if key in seen:
                continue
            seen.add(key)
            a = anc[ai] if ai is not None else None
            srcs.append({"type": tid, "days": k or None, "exact": g.start + p * DAY,
                         "anchor": (g.start + a["i"] * DAY) if a else None, "anchor_kind": a["kind"] if a else None,
                         "anchor_price": rnd(a["price"], 2) if a else None,
                         "verdict": rows.get(tid, {}).get("verdict"), "lift": rows.get(tid, {}).get("lift")})
        srcs.sort(key=lambda s: (TYPE_ORDER.index(s["type"]), s["days"] or 0))
        b = sbt[bin_of(int(S[d]))]
        items.append({"time": g.start + d * DAY, "start": g.start + (d - w) * DAY, "end": g.start + (d + w) * DAY,
                      "days_away": d - today_pos, "score": int(S[d]), "types": sorted({s["type"] for s in srcs}, key=TYPE_ORDER.index),
                      "sources": srcs, "hist_hit_rate": b.get("hit_rate"), "hist_base_rate": b.get("base_rate"),
                      "hist_lift": b.get("lift"), "hist_n": b.get("n"), "hist_verdict": b.get("verdict")})
    items.sort(key=lambda x: x["time"])
    series = []
    for x in range(today_pos, hi + 1):
        types = sorted({c[0] for c in contrib[x]}, key=TYPE_ORDER.index)
        series.append({"time": g.start + x * DAY, "score": int(S[x]), "types": types})
    return items, series


# ============================================================ livelli prezzo-tempo (opzionali)

def fan(anc: list[dict], g, today_pos: int, price: float) -> dict | None:
    """Ventaglio di Gann dall'ultimo pivot maggiore: 1×1 = pendenza media della gamba precedente (USD/giorno, dichiarata)."""
    if len(anc) < 2:
        return None
    a, b = anc[-2], anc[-1]
    dd = b["i"] - a["i"]
    if dd <= 0:
        return None
    slope = abs(b["price"] - a["price"]) / dd
    sign = 1 if b["kind"] == "low" else -1
    days = today_pos - b["i"]
    lines = []
    for key, f in (("1x2", 0.5), ("1x1", 1.0), ("2x1", 2.0)):
        v = b["price"] + sign * f * slope * days
        lines.append({"key": key, "factor": f, "slope": rnd(f * slope, 2), "price": rnd(v, 2) if v > 0 else None,
                      "dist": rnd((v / price - 1) * 100, 2) if v > 0 else None})
    return {"anchor": {"time": g.start + b["i"] * DAY, "price": rnd(b["price"], 2), "kind": b["kind"]},
            "prev": {"time": g.start + a["i"] * DAY, "price": rnd(a["price"], 2), "kind": a["kind"]},
            "leg_days": dd, "slope_1x1": rnd(slope, 2), "days_since": days, "direction": "up" if sign > 0 else "down", "lines": lines}


# ============================================================ entry point

DEFS = [(10, 1), (10, 2), (10, 3), (20, 1), (20, 2), (20, 3)]   # (pivot a N giorni, finestra ±W) consultabili nella pagina


def heavy(g, pivot_n: int = 10, w: int = 2) -> dict:
    """Parte storica (indipendente da oggi): backtest per tipo di conteggio e per punteggio di confluenza."""
    anc = anchors(g)
    ph, pl = targets(g, pivot_n)
    tgt = ph | pl
    near = near_mask(tgt, w)
    lo = max(g.pos(SAMPLE_START), 0)
    hi = g.last - pivot_n - w           # oltre, il bersaglio non è ancora valutabile
    rows = backtest(g, anc, near, w, lo, hi)
    S, _ = score_series(anc, g, w, lo, hi)
    sbt = score_backtest(S, near, lo, hi)
    return {"anc": anc, "near": near, "tgt": tgt, "ph": ph, "lo": lo, "hi": hi, "rows": rows, "S": S, "sbt": sbt, "pivot_n": pivot_n, "w": w}


def apply_global_correction(heavies: list[dict]) -> None:
    """BH su TUTTI i tipi × tutte le definizioni consultabili (data snooping tra definizioni): p_bh_all e verdetto finale."""
    flat = [(h, r) for h in heavies for r in h["rows"]]
    adj = bh([r.get("p_shift") for _, r in flat])
    for (_, r), pa in zip(flat, adj):
        r["p_bh_all"] = pa
        v = r.get("verdict")
        if v == "strong" and (pa is None or pa >= ALPHA):
            r["verdict"] = "weak"      # regge alla correzione nella definizione scelta ma non su tutte le definizioni


def compute(g, today: pd.Timestamp, price: float, horizon: int = 90, pivot_n: int = 10, w: int = 2, hv: dict | None = None) -> dict:
    hv = hv or heavy(g, pivot_n, w)
    anc, near, tgt, lo, hi, rows, S, sbt = (hv[k] for k in ("anc", "near", "tgt", "lo", "hi", "rows", "S", "sbt"))
    today_pos = g.pos(today)
    byid = {r["id"]: r for r in rows}
    up, score_future = upcoming(g, anc, today_pos, horizon, w, byid, sbt)
    oe = open_extreme(g)
    recent_anchors = [{"time": g.start + a["i"] * DAY, "confirmed": g.start + a["ci"] * DAY, "kind": a["kind"], "price": rnd(a["price"], 2)}
                      for a in anc if a["i"] >= today_pos - 1500]
    last_anchor = anc[-1] if anc else None
    # ultime date proiettate già valutabili (tutti i tipi), con l'esito
    recent = []
    for tid in TYPE_ORDER:
        if tid == "seasonal":
            q = _seasonal_positions(g, max(lo, hi - 400), hi)
        else:
            q = projections(anc, COUNT_TYPES[tid]["days"], w, max(lo, hi - 400), hi)
        for p in q:
            recent.append({"time": g.start + p * DAY, "type": tid, "hit": bool(near[p]), "score": int(S[p]) if p < len(S) else None})
    recent.sort(key=lambda x: x["time"])
    # pivot a N giorni recenti (bersagli) per il grafico
    ph = hv["ph"]
    tg_recent = [{"time": g.start + i * DAY, "kind": "high" if ph[i] else "low", "price": rnd(g.high[i] if ph[i] else g.low[i], 2)}
                 for i in np.nonzero(tgt)[0] if i >= today_pos - 400]
    return {
        "params": {"pivot_n": pivot_n, "win": w, "anchor_mult": ANCHOR_MULT, "min_shift": MIN_SHIFT, "n_ctrl": N_CTRL,
                   "cluster_tol": CLUSTER_TOL, "min_n": MIN_N, "alpha": ALPHA, "defs": [list(d) for d in DEFS],
                   "tests_all": len(DEFS) * len(TYPE_ORDER)},
        "sample": {"start": g.start + lo * DAY, "end": g.start + hi * DAY, "days": hi - lo + 1, "anchors": len([a for a in anc if a["i"] >= lo]),
                   "targets": int(tgt[lo:hi + 1].sum()), "base_rate": rnd(float(near[lo:hi + 1].mean()) * 100, 1)},
        "types": rows,
        "score_bins": sbt,
        "upcoming": up,
        "score_future": score_future,
        "anchors": recent_anchors,
        "targets_recent": tg_recent,
        "open_extreme": {"time": g.start + oe["i"] * DAY, "kind": oe["kind"], "price": rnd(oe["price"], 2)} if oe else None,
        "recent": recent[-40:],
        "sq9": sq9_near(last_anchor, price) if last_anchor else None,
        "fan": fan(anc, g, today_pos, price),
        "counts": {k: v["days"] for k, v in COUNT_TYPES.items()},
        "seasonal_dates": SEASONAL_DATES,
    }


def sq9_near(a: dict, price: float, k: int = 4) -> dict:
    """Livelli del quadrato del 9 dal prezzo dell'ultimo pivot maggiore, i più vicini al prezzo attuale (passi di 45°)."""
    r0 = math.sqrt(a["price"])
    kc = round((math.sqrt(price) - r0) / 0.25)
    lv = []
    for j in range(kc - k, kc + k + 1):
        v = (r0 + j * 0.25) ** 2
        if v <= 0:
            continue
        lv.append({"deg": 45 * j, "turns": rnd(j / 8, 3), "price": rnd(v, 2), "dist": rnd((v / price - 1) * 100, 2)})
    return {"anchor": {"price": rnd(a["price"], 2), "kind": a["kind"]}, "levels": lv, "step_usd": rnd(((math.sqrt(price) + 0.25) ** 2 - price), 2)}
