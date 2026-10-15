"""Fasi di Wyckoff: trading range di accumulazione/distribuzione rilevati con regole esplicite e CAUSALI.

Una macchina a stati scorre le candele chiuse una alla volta: ogni evento ha l'indice della candela in cui si è
formato (`i`) e quello in cui diventa noto (`ci`, conferma). Il backtest misura i rendimenti dalla chiusura di `ci`,
quindi non usa mai informazioni future. Regole (atr = ATR(14) della candela precedente, rv = volume ÷ mediana dei 50
volumi precedenti, ampiezza = (massimo − minimo) ÷ atr):

ACCUMULAZIONE (dopo un ribasso)
- SC (selling climax): nuovo minimo delle ultime `lb` candele, discesa dal massimo delle ultime `trend` candele ≥ 5 atr e
  ≥ `trend_pct`, con rv ≥ 1.8 oppure (rv ≥ 1.4 e ampiezza ≥ 1.6). Un minimo più basso entro 3 candele sposta lo SC.
- PS (preliminary support): l'ultima candela prima dello SC (entro `ps_lb`) con rv ≥ 1.4 e chiusura nella metà alta.
- AR (automatic rally): massimo frattale (2 candele dopo più basse) dopo lo SC, rimbalzo ≥ 2 atr; fissa il range
  [minimo SC, massimo AR], ampiezza tra 2 (1D) / 3 (4H) e 16 atr. Nessun AR entro `ar_max` candele: candidato scartato.
- Il range deve durare almeno `min_age` candele (7 in 1D, 12 in 4H): uscite precedenti lo scartano.
- ST (secondary test): visita del 20% basso del range (anche leggermente sotto lo SC con chiusura dentro) → fase B.
- Spring: in fase B, minimo sotto il range (≥ 0.05 atr, al massimo max(1.5 atr, 30% del range)) e chiusura di nuovo
  dentro nella stessa candela o entro 2 → fase C. Test: dopo lo Spring, visita del 25% basso con minimo più alto e
  volume minore.
- SOS (sign of strength): chiusura sopra il range + 0.1 atr con rv ≥ 1.2 o ampiezza ≥ 1.2 → fase D (una rottura
  senza forza porta comunque in fase D, ma non è etichettata SOS).
- LPS: primo minimo frattale dopo la rottura che resta sopra metà range; «BU» se ritesta il bordo (≤ 0.5 atr).
- Fase E: chiusura sopra il massimo successivo alla rottura dopo l'LPS, oppure sopra range + 1 ampiezza.
  Due chiusure di fila di nuovo dentro il range (o una sotto metà range) annullano la rottura: si torna in fase B.
- Rottura al ribasso: 2 chiusure sotto il range − 0.1 atr (o una sotto il limite dello Spring) → range fallito.
DISTRIBUZIONE: speculare (PSY, BC, AR, ST, UT/UTAD, SOW, LPSY). UT = upthrust poco profondo (≤ 0.5 atr) in fase B,
UTAD = upthrust più profondo o oltre un UT precedente → fase C.
Fasi: A (arresto: PS/SC/AR/ST) · B (costruzione della causa) · C (Spring/UTAD e test) · D (SOS/LPS o SOW/LPSY) · E (uscita).
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .astro import bh
from .market import atr as _atr

TF_CFG = {
    "1d": {"lb": 50, "trend": 60, "trend_pct": 12.0, "ps_lb": 30, "ar_max": 25, "max_bars": 240, "min_age": 7, "min_w": 2.0, "bpd": 1, "vol_n": 50},
    "4h": {"lb": 120, "trend": 180, "trend_pct": 6.0, "ps_lb": 60, "ar_max": 60, "max_bars": 600, "min_age": 12, "min_w": 3.0, "bpd": 6, "vol_n": 50},
}
HORIZONS_D = (5, 10, 20)
N_PERM = 2000
N_BOOT = 2000
SEED = 20261015
ALPHA = 0.05
MIN_N = 12

# evento -> (fase in cui nasce, direzione attesa dalla teoria: +1 rialzo, −1 ribasso)
EVENTS = {
    "PS": ("A", 1), "SC": ("A", 1), "AR_A": ("A", 1), "ST_A": ("A", 1), "SPRING": ("C", 1), "TEST": ("C", 1),
    "SOS": ("D", 1), "LPS": ("D", 1), "BRK_DN": ("E", -1),
    "PSY": ("A", -1), "BC": ("A", -1), "AR_D": ("A", -1), "ST_D": ("A", -1), "UT": ("B", -1), "UTAD": ("C", -1),
    "SOW": ("D", -1), "LPSY": ("D", -1), "BRK_UP": ("E", 1),
}
LABEL = {"AR_A": "AR", "AR_D": "AR", "ST_A": "ST", "ST_D": "ST", "SPRING": "Spring", "TEST": "Test", "BRK_DN": "Rottura",
         "BRK_UP": "Rottura"}
BACKTEST_KEYS = ["SC", "ST_A", "SPRING", "TEST", "SOS", "LPS", "BC", "ST_D", "UT", "UTAD", "SOW", "LPSY"]
KEY_EVENTS = ["SPRING", "UTAD", "SOS", "SOW"]


def rnd(x, d: int = 3):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(f) else round(f, d)


def _prep(df: pd.DataFrame, vol_n: int) -> dict:
    o, h, l, c, v = (df[x].to_numpy(float) for x in ("open", "high", "low", "close", "volume"))
    a = _atr(df).to_numpy(float)
    a_prev = np.concatenate([[np.nan], a[:-1]])
    med = pd.Series(v).shift(1).rolling(vol_n, min_periods=20).median().to_numpy(float)
    rv = np.where(med > 0, v / med, np.nan)
    sp = (h - l) / a_prev
    return {"o": o, "h": h, "l": l, "c": c, "v": v, "a": a_prev, "rv": rv, "sp": sp, "n": len(df)}


def _climax(D: dict, t: int, rv_hi: float = 1.8) -> bool:
    rv, sp = D["rv"][t], D["sp"][t]
    if not (np.isfinite(rv) and np.isfinite(sp)):
        return False
    return rv >= rv_hi or (rv >= 1.4 and sp >= 1.6)


class _Range:
    """Range in costruzione/attivo (side = 'acc' | 'dist')."""

    def __init__(self, side: str, ci: int):
        self.side = side
        self.events: list[dict] = []
        self.phase = "A"
        self.H = self.L = math.nan
        self.start = ci
        self.end: int | None = None
        self.status = "active"
        self.visit: dict | None = None   # visita della zona di test in corso
        self.pending: dict | None = None  # spring/upthrust con chiusura fuori, in attesa di rientro
        self.below = 0                    # chiusure consecutive oltre il bordo "sbagliato"
        self.broke: int | None = None     # indice della rottura nella direzione della fase D
        self.post_ext = math.nan          # estremo dopo la rottura
        self.lps_done = False
        self.spring_low = math.nan
        self.spring_rv = math.nan
        self.ut_high = math.nan
        self.climax_rv = math.nan

    def add(self, key: str, i: int, ci: int, price: float, D: dict, **kw):
        self.events.append({"key": key, "i": int(i), "ci": int(ci), "price": float(price),
                            "rv": rnd(D["rv"][i], 2), "phase": self.phase, **kw})


def detect(df: pd.DataFrame, tf: str) -> list[dict]:
    """Scorre le candele (chiuse) e restituisce tutti i range (attivo incluso) con gli eventi."""
    cfg = TF_CFG[tf]
    D = _prep(df, cfg["vol_n"])
    h, l, c, a, rv, sp = D["h"], D["l"], D["c"], D["a"], D["rv"], D["sp"]
    n = D["n"]
    ranges: list[_Range] = []
    cur: _Range | None = None
    cand: dict | None = None   # candidato climax in attesa di AR
    start = max(cfg["trend"], cfg["lb"], 30)

    def close_range(r: _Range, t: int, status: str):
        r.end = t
        r.status = status

    for t in range(start, n):
        at = a[t]
        if not np.isfinite(at) or at <= 0:
            continue
        # ------------------------------------------------ range attivo
        if cur is not None:
            r = cur
            acc = r.side == "acc"
            H, L = r.H, r.L
            W = H - L
            tol = max(1.5 * at, 0.3 * W)
            # ---- rientro dopo una spinta oltre il bordo (spring / upthrust con chiusura fuori)
            if r.pending is not None:
                p = r.pending
                if t - p["i0"] > 2:
                    r.pending = None
                elif (acc and c[t] > L) or (not acc and c[t] < H):
                    _confirm_thrust(r, p, t, D)
                    r.pending = None
                    continue
            if r.phase in ("A", "B", "C"):
                # ---- fallimento: chiusure oltre il bordo opposto alla teoria
                out = (c[t] < L - 0.1 * at) if acc else (c[t] > H + 0.1 * at)
                deep = (c[t] < L - tol) if acc else (c[t] > H + tol)
                r.below = r.below + 1 if out else 0
                young = t - r.start < cfg["min_age"]
                brk = (c[t] > H + 0.1 * at) if acc else (c[t] < L - 0.1 * at)
                if young and (deep or (r.below >= 2 and r.pending is None) or brk):
                    cur = None          # il range non si è formato davvero (uscita prima di min_age candele): scartato
                    continue
                if deep or (r.below >= 2 and r.pending is None):
                    r.add("BRK_DN" if acc else "BRK_UP", t, t, c[t], D)
                    close_range(r, t, "failed")
                    ranges.append(r)
                    cur = None
                    continue
                # ---- rottura nella direzione della teoria (SOS / SOW)
                if brk:
                    strong = (np.isfinite(rv[t]) and rv[t] >= 1.2) or (np.isfinite(sp[t]) and sp[t] >= 1.2)
                    r.phase = "D"
                    r.below = 0
                    r.broke = t
                    r.post_ext = h[t] if acc else l[t]
                    if strong:
                        r.add("SOS" if acc else "SOW", t, t, c[t], D)
                    r.visit = None
                    continue
                # ---- spinta oltre il bordo con rientro (Spring / UT / UTAD) in fase B/C
                pen = (L - l[t]) if acc else (h[t] - H)
                if r.phase == "B" and pen > 0.05 * at and pen <= tol:
                    p = {"i0": t, "i": t, "ext": l[t] if acc else h[t], "pen": pen}
                    if (acc and c[t] > L) or (not acc and c[t] < H):
                        _confirm_thrust(r, p, t, D)
                    else:
                        r.pending = p
                    continue
                # ---- visite della zona di test (ST in fase A, Test dopo lo Spring/UTAD)
                zone = 0.2 * W if r.phase == "A" else 0.25 * W
                inside_zone = (l[t] <= L + zone) if acc else (h[t] >= H - zone)
                if inside_zone and not (acc and c[t] < L) and not (not acc and c[t] > H):
                    ext = l[t] if acc else h[t]
                    if r.visit is None:
                        r.visit = {"i": t, "ext": ext}
                    elif (acc and ext < r.visit["ext"]) or (not acc and ext > r.visit["ext"]):
                        r.visit = {"i": t, "ext": ext}
                elif r.visit is not None:
                    vi = r.visit["i"]
                    r.visit = None
                    if r.phase == "A" and vi > r.events[-1]["i"]:
                        r.add("ST_A" if acc else "ST_D", vi, t, l[vi] if acc else h[vi], D, low_vol=bool(rv[vi] < r.climax_rv))
                        r.phase = "B"
                    elif r.phase == "C" and not any(e["key"] == "TEST" for e in r.events) and acc and l[vi] > r.spring_low \
                            and (not np.isfinite(r.spring_rv) or rv[vi] < r.spring_rv):
                        r.add("TEST", vi, t, l[vi], D)
                # ---- range troppo lungo senza esito
                if t - r.start > cfg["max_bars"]:
                    close_range(r, t, "expired")
                    ranges.append(r)
                    cur = None
                continue
            # ------------------------------------------------ fase D
            if r.phase == "D":
                acc = r.side == "acc"
                prev_ext = r.post_ext
                r.post_ext = max(r.post_ext, h[t]) if acc else min(r.post_ext, l[t])
                # rientro: 2 chiusure di fila di nuovo dentro il range (o una sotto metà range) → rottura fallita, fase B
                inside = (c[t] < H - 0.1 * at) if acc else (c[t] > L + 0.1 * at)
                r.below = r.below + 1 if inside else 0
                deep_back = (c[t] < H - 0.5 * W) if acc else (c[t] > L + 0.5 * W)
                if deep_back or r.below >= 2:
                    r.phase = "B"
                    r.broke = None
                    r.lps_done = False
                    r.below = 0
                    continue
                # LPS / LPSY: frattale (2 candele) dopo la rottura che resta oltre metà range
                j = t - 2
                if not r.lps_done and r.broke is not None and j > r.broke:
                    if acc and l[j] < l[j - 1] and l[j] <= l[j + 1] and l[j] <= l[t] and l[j] >= L + 0.5 * W:
                        r.add("LPS", j, t, l[j], D, bu=bool(l[j] <= H + 0.5 * at))
                        r.lps_done = True
                    elif not acc and h[j] > h[j - 1] and h[j] >= h[j + 1] and h[j] >= h[t] and h[j] <= H - 0.5 * W:
                        r.add("LPSY", j, t, h[j], D, bu=bool(h[j] >= L - 0.5 * at))
                        r.lps_done = True
                # fase E
                beyond = (c[t] > H + W) if acc else (c[t] < L - W)
                cont = r.lps_done and ((c[t] > prev_ext) if acc else (c[t] < prev_ext))
                if beyond or (cont and t - r.events[-1]["ci"] >= 1):
                    r.phase = "E"
                    close_range(r, t, "up" if acc else "down")
                    ranges.append(r)
                    cur = None
                elif t - r.start > cfg["max_bars"]:
                    close_range(r, t, "expired")
                    ranges.append(r)
                    cur = None
                continue

        # ------------------------------------------------ ricerca di un climax / AR
        if cand is not None:
            acc = cand["side"] == "acc"
            if acc and l[t] < cand["ext0"]:
                if t - cand["i"] <= 3 or _climax(D, t):
                    cand.update({"i": t, "ext0": l[t], "rv": max(cand["rv"], rv[t] if np.isfinite(rv[t]) else 0), "best": h[t], "best_i": t})
                else:
                    cand = None
            elif not acc and h[t] > cand["ext0"]:
                if t - cand["i"] <= 3 or _climax(D, t):
                    cand.update({"i": t, "ext0": h[t], "rv": max(cand["rv"], rv[t] if np.isfinite(rv[t]) else 0), "best": l[t], "best_i": t})
                else:
                    cand = None
            if cand is not None:
                if acc and h[t] > cand["best"]:
                    cand["best"], cand["best_i"] = h[t], t
                if not acc and l[t] < cand["best"]:
                    cand["best"], cand["best_i"] = l[t], t
                j = cand["best_i"]
                move = (cand["best"] - cand["ext0"]) if acc else (cand["ext0"] - cand["best"])
                if j <= t - 2 and j > cand["i"] and move >= 2 * at:
                    H, L = (cand["best"], cand["ext0"]) if acc else (cand["ext0"], cand["best"])
                    if cfg["min_w"] * at <= H - L <= 16 * at:
                        r = _Range(cand["side"], t)
                        r.H, r.L = H, L
                        r.climax_rv = cand["rv"]
                        if cand.get("ps") is not None:
                            ps = cand["ps"]
                            r.add("PS" if acc else "PSY", ps, t, l[ps] if acc else h[ps], D)
                        r.add("SC" if acc else "BC", cand["i"], t, cand["ext0"], D)
                        r.add("AR_A" if acc else "AR_D", j, t, cand["best"], D)
                        cur = r
                        cand = None
                        continue
                    cand = None
                elif t - cand["i"] > cfg["ar_max"]:
                    cand = None
            continue
        # nuovo climax?
        lo_win = l[t - cfg["lb"]:t].min()
        hi_win = h[t - cfg["lb"]:t].max()
        if l[t] < lo_win and _climax(D, t):
            top = h[t - cfg["trend"]:t].max()
            if top - l[t] >= 5 * at and (top / l[t] - 1) * 100 >= cfg["trend_pct"]:
                cand = {"side": "acc", "i": t, "ext0": l[t], "rv": rv[t], "best": h[t], "best_i": t, "ps": _ps(D, t, cfg["ps_lb"], True)}
        elif h[t] > hi_win and _climax(D, t):
            bot = l[t - cfg["trend"]:t].min()
            if h[t] - bot >= 5 * at and (h[t] / bot - 1) * 100 >= cfg["trend_pct"]:
                cand = {"side": "dist", "i": t, "ext0": h[t], "rv": rv[t], "best": l[t], "best_i": t, "ps": _ps(D, t, cfg["ps_lb"], False)}
    if cur is not None:
        ranges.append(cur)
    out = []
    for r in ranges:
        out.append({"side": r.side, "start": r.start, "end": r.end, "status": r.status, "phase": r.phase, "H": r.H, "L": r.L,
                    "first": min(e["i"] for e in r.events), "events": r.events})
    return out


def _ps(D: dict, t: int, lb: int, acc: bool) -> int | None:
    o, h, l, c, rv = D["o"], D["h"], D["l"], D["c"], D["rv"]
    for j in range(t - 1, max(0, t - lb), -1):
        if not np.isfinite(rv[j]) or rv[j] < 1.4 or h[j] <= l[j]:
            continue
        pos = (c[j] - l[j]) / (h[j] - l[j])
        if (acc and pos >= 0.5 and l[j] > l[t]) or (not acc and pos <= 0.5 and h[j] < h[t]):
            return j
    return None


def _confirm_thrust(r: _Range, p: dict, t: int, D: dict):
    acc = r.side == "acc"
    i = p["i"]
    a = D["a"][t]
    if acc:
        r.add("SPRING", i, t, D["l"][i], D, pen=rnd(p["pen"] / a, 2))
        r.spring_low, r.spring_rv = D["l"][i], D["rv"][i]
        r.phase = "C"
    else:
        deep = p["pen"] > 0.5 * a or (np.isfinite(r.ut_high) and D["h"][i] > r.ut_high)
        if deep:
            r.add("UTAD", i, t, D["h"][i], D, pen=rnd(p["pen"] / a, 2))
            r.phase = "C"
        else:
            r.add("UT", i, t, D["h"][i], D, pen=rnd(p["pen"] / a, 2))
            r.ut_high = max(r.ut_high, D["h"][i]) if np.isfinite(r.ut_high) else D["h"][i]


# ============================================================ backtest

def _fwd(c: np.ndarray, hb: int) -> np.ndarray:
    out = np.full(len(c), np.nan)
    out[:-hb] = (c[hb:] / c[:-hb] - 1) * 100
    return out


def backtest(segments: list[tuple[pd.DataFrame, list[dict]]], tf: str) -> dict:
    """Rendimenti dopo gli eventi (dalla chiusura della candela di conferma) contro tutte le candele del campione.
    `segments`: uno o più tratti di storico indipendenti (es. Bitstamp 2013–2017 + Binance 2017→ per l'1D)."""
    cfg = TF_CFG[tf]
    rng = np.random.default_rng(SEED)
    lo = max(cfg["trend"], cfg["lb"], 30)
    fw: dict[int, list[np.ndarray]] = {hd: [] for hd in HORIZONS_D}
    times: list[np.ndarray] = []
    evs: dict[str, list[tuple[int, int]]] = {k: [] for k in BACKTEST_KEYS}
    bars = 0
    for si, (df, ranges) in enumerate(segments):
        c = df["close"].to_numpy(float)
        for hd in HORIZONS_D:
            f = _fwd(c, hd * cfg["bpd"])
            f[:lo] = np.nan
            fw[hd].append(f)
        times.append(df["time"].to_numpy())
        bars += max(0, len(c) - lo)
        seen = set()
        for r in ranges:
            for e in r["events"]:
                if e["key"] in evs and (e["key"], e["ci"]) not in seen:
                    seen.add((e["key"], e["ci"]))
                    evs[e["key"]].append((si, e["ci"]))
    base = {}
    pools = {}
    for hd in HORIZONS_D:
        pool = np.concatenate(fw[hd])
        pool = pool[np.isfinite(pool)]
        pools[hd] = pool
        base[hd] = {"mean": float(pool.mean()), "up": float(np.mean(pool > 0) * 100)}
    all_t = np.concatenate(times)
    t_half = np.sort(all_t)[len(all_t) // 2]
    rows = []
    pvals = []
    for key in BACKTEST_KEYS:
        d = EVENTS[key][1]
        ev = sorted(evs[key], key=lambda x: times[x[0]][x[1]])
        row = {"key": key, "side": "acc" if key in ("SC", "ST_A", "SPRING", "TEST", "SOS", "LPS") else "dist",
               "direction": "up" if d > 0 else "down", "n": len(ev), "horizons": []}
        for hd in HORIZONS_D:
            vals_t = [(fw[hd][si][i], times[si][i]) for si, i in ev if np.isfinite(fw[hd][si][i])]
            vals = np.array([v for v, _ in vals_t])
            m = len(vals)
            b = base[hd]
            h = {"days": hd, "n": m, "base_mean": rnd(b["mean"], 2), "base_up": rnd(b["up"], 1)}
            if m:
                mean = float(vals.mean())
                hit = float(np.mean(np.sign(vals) == d) * 100)
                base_hit = b["up"] if d > 0 else 100 - b["up"]
                null = rng.choice(pools[hd], size=(N_PERM, m), replace=True).mean(axis=1)
                ex = mean - b["mean"]
                p = float((1 + np.sum(np.abs(null - b["mean"]) >= abs(ex) - 1e-12)) / (1 + N_PERM))
                boot = rng.choice(vals, size=(N_BOOT, m), replace=True).mean(axis=1) - b["mean"]
                first = [v - b["mean"] for v, tt in vals_t if tt < t_half]
                second = [v - b["mean"] for v, tt in vals_t if tt >= t_half]
                stable = bool(len(first) >= 3 and len(second) >= 3 and np.sign(np.mean(first)) == np.sign(np.mean(second)) == np.sign(ex))
                h.update({"mean": rnd(mean, 2), "median": rnd(float(np.median(vals)), 2), "excess": rnd(ex, 2),
                          "ci": [rnd(float(np.quantile(boot, 0.025)), 2), rnd(float(np.quantile(boot, 0.975)), 2)],
                          "hit": rnd(hit, 1), "base_hit": rnd(base_hit, 1), "p": rnd(p, 4), "stable": stable,
                          "halves": [{"n": len(first), "excess": rnd(float(np.mean(first)) if first else None, 2)},
                                     {"n": len(second), "excess": rnd(float(np.mean(second)) if second else None, 2)}],
                          "agrees": bool(np.sign(ex) == d)})
                pvals.append(p)
            else:
                pvals.append(None)
            row["horizons"].append(h)
        rows.append(row)
    adj = bh(pvals)
    k = 0
    for row in rows:
        for h in row["horizons"]:
            h["p_bh"] = adj[k]
            k += 1
            if not h["n"] or h["n"] < MIN_N:
                h["verdict"] = "anecdotal"
            elif (h.get("p_bh") or 1) < ALPHA and h.get("stable") and h.get("agrees"):
                h["verdict"] = "strong"
            elif (h.get("p") or 1) < ALPHA:
                h["verdict"] = "weak"
            else:
                h["verdict"] = "none"
    return {"rows": rows, "base": {str(k): {"mean": rnd(v["mean"], 2), "up": rnd(v["up"], 1)} for k, v in base.items()},
            "segments": [{"since": df["time"].iat[min(lo, len(df) - 1)], "until": df["time"].iat[-1], "bars": max(0, len(df) - lo)} for df, _ in segments],
            "bars": bars, "tests": len([p for p in pvals if p is not None]), "split": t_half}


# ============================================================ output

def public_range(r: dict, df: pd.DataFrame, last: int) -> dict:
    t = df["time"]
    c = df["close"].to_numpy(float)
    end = r["end"] if r["end"] is not None else last
    out_ret = None
    if r["end"] is not None and r["end"] + 20 <= last:
        out_ret = (c[r["end"] + 20] / c[r["end"]] - 1) * 100
    return {
        "side": r["side"], "status": r["status"], "phase": r["phase"], "high": rnd(r["H"], 2), "low": rnd(r["L"], 2),
        "start": t.iat[r["first"]], "confirmed": t.iat[r["start"]], "end": t.iat[end] if r["end"] is not None else None,
        "bars": int(end - r["first"] + 1), "width_pct": rnd((r["H"] / r["L"] - 1) * 100, 2),
        "after_20": rnd(out_ret, 2),
        "events": [{"key": e["key"], "time": t.iat[e["i"]], "confirmed": t.iat[e["ci"]],
                    "price": rnd(e["price"], 2), "rv": e["rv"], "phase": e["phase"],
                    **({"bu": e["bu"]} if "bu" in e else {}), **({"pen": e["pen"]} if "pen" in e else {}),
                    **({"low_vol": e["low_vol"]} if "low_vol" in e else {})} for e in r["events"]],
    }


def compute(df: pd.DataFrame, tf: str, chart_bars: int = 500, extra: list[pd.DataFrame] | None = None) -> dict:
    """df: candele CHIUSE (time, open, high, low, close, volume). `extra`: storici precedenti indipendenti, solo per il backtest."""
    df = df.reset_index(drop=True)
    ranges = detect(df, tf)
    segs = [(x.reset_index(drop=True), detect(x.reset_index(drop=True), tf)) for x in (extra or []) if len(x) > 300]
    bt = backtest(segs + [(df, ranges)], tf)
    last = len(df) - 1
    active = ranges[-1] if ranges and ranges[-1]["status"] == "active" else None
    chart_from = max(0, last - chart_bars)
    visible = [public_range(r, df, last) for r in ranges if (r["end"] or last) >= chart_from]
    timeline = [public_range(r, df, last) for r in ranges]
    status_counts = {}
    for r in ranges:
        if r["status"] != "active":
            key = f"{r['side']}_{r['status']}"
            status_counts[key] = status_counts.get(key, 0) + 1
    return {
        "tf": tf, "bars": len(df), "since": df["time"].iat[0], "last_closed": df["time"].iat[last],
        "active": public_range(active, df, last) if active else None,
        "last_range": timeline[-1] if timeline else None,
        "ranges": visible, "timeline": timeline[::-1][:60], "outcomes": status_counts,
        "backtest": bt, "chart_from": df["time"].iat[chart_from],
        "params": {**TF_CFG[tf], "horizons": list(HORIZONS_D), "n_perm": N_PERM, "n_boot": N_BOOT, "min_n": MIN_N, "alpha": ALPHA},
    }
