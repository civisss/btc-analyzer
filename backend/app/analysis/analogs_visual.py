"""Somiglianza GRAFICA tra due finestre di candele (usata da analogs.py).

Componenti (ciascuna 0..100):
  - shape:      forma del percorso dei prezzi (corr + DTW, calcolata in analogs.search)
  - candles:    geometria delle candele (corpo/ombre normalizzati per ATR) — DTW multivariato + distribuzione
  - legs:       gambe ZigZag allineate con DTW, confronto % e durata gamba per gamba
  - pattern:    figure grafiche deterministiche (doppio massimo/minimo, testa e spalle, triangoli, cunei,
                bandiere/pennant, canali, rettangolo, V, tazza con manico) + geometria delle trendline
  - volume:     profilo dei volumi (per prezzo e nel tempo)
  - volatility: inviluppo di volatilità (ATR mobile)
"""
from __future__ import annotations

import math

import numpy as np

VIS_WEIGHTS = {"shape": 0.30, "candles": 0.20, "legs": 0.20, "pattern": 0.15, "volume": 0.075, "volatility": 0.075}
VIS_LABELS = {
    "shape": "Forma del percorso", "candles": "Geometria delle candele", "legs": "Gambe e swing (ZigZag)",
    "pattern": "Figure grafiche e trendline", "volume": "Profilo dei volumi", "volatility": "Inviluppo di volatilità",
}


def _sg(v: float, d: int = 1) -> str:
    s = "+" if v > 0 else ("−" if v < 0 else "")
    return f"{s}{abs(v):.{d}f}%"


# ================================================================== candele

def candle_vectors(o, h, l, c) -> np.ndarray:
    atr = float(np.mean(h - l)) or 1e-9
    body = (c - o) / atr
    up = (h - np.maximum(o, c)) / atr
    lo = (np.minimum(o, c) - l) / atr
    return np.stack([body, up, lo], axis=-1)


def dtw_multi(q: np.ndarray, cands: np.ndarray, band: int) -> np.ndarray:
    """DTW L1 multivariato con banda, vettoriale sui candidati. q (n,d), cands (c,n,d) -> distanza media per passo."""
    c, n, _ = cands.shape
    prev = np.full((c, n + 1), np.inf)
    prev[:, 0] = 0.0
    for i in range(1, n + 1):
        cur = np.full((c, n + 1), np.inf)
        lo, hi = max(1, i - band), min(n, i + band)
        cost = np.abs(cands[:, lo - 1:hi, :] - q[i - 1]).sum(axis=-1)
        for k, j in enumerate(range(lo, hi + 1)):
            cur[:, j] = cost[:, k] + np.minimum(np.minimum(prev[:, j], cur[:, j - 1]), prev[:, j - 1])
        prev = cur
    return prev[:, n] / n


def candle_dist_score(vc: np.ndarray, va: np.ndarray) -> float:
    """Somiglianza dello 'stile' delle candele: quantili di corpo/ombre + quota di candele verdi."""
    qs = [0.25, 0.5, 0.75, 0.9]
    d = 0.0
    for k in range(3):
        a = np.quantile(np.abs(vc[:, k]), qs)
        b = np.quantile(np.abs(va[:, k]), qs)
        d += float(np.mean(np.abs(a - b)))
    d /= 3
    g = abs(float(np.mean(vc[:, 0] > 0)) - float(np.mean(va[:, 0] > 0)))
    return 100 * (0.75 * math.exp(-d / 0.25) + 0.25 * (1 - min(1.0, g * 2.5)))


def candle_seq_score(dist: float) -> float:
    """Calibrata empiricamente: distanza ~1.0 = coppia di finestre casuali, <=0.7 = sequenze quasi uguali."""
    return 100 * min(1.0, max(0.0, (1.2 - dist) / 0.5))


def candle_stats(v: np.ndarray) -> dict:
    return {"green": float(np.mean(v[:, 0] > 0) * 100), "body": float(np.median(np.abs(v[:, 0]))),
            "wick": float(np.median(v[:, 1] + v[:, 2]))}


# ================================================================== ZigZag e gambe

def zigzag(h: np.ndarray, l: np.ndarray, c: np.ndarray, thr: float) -> list[tuple[int, str, float]]:
    """ZigZag percentuale su massimi/minimi. Ritorna punti (idx, 'start'|'high'|'low'|'end', prezzo)."""
    n = len(c)
    piv: list[tuple[int, str, float]] = []
    c0 = float(c[0])
    trend, ei, ep = 0, 0, c0
    for i in range(1, n):
        if trend == 0:
            if h[i] >= c0 * (1 + thr):
                trend, ei, ep = 1, i, float(h[i])
            elif l[i] <= c0 * (1 - thr):
                trend, ei, ep = -1, i, float(l[i])
        elif trend == 1:
            if h[i] > ep:
                ei, ep = i, float(h[i])
            elif l[i] <= ep * (1 - thr):
                piv.append((ei, "high", ep))
                trend, ei, ep = -1, i, float(l[i])
        else:
            if l[i] < ep:
                ei, ep = i, float(l[i])
            elif h[i] >= ep * (1 + thr):
                piv.append((ei, "low", ep))
                trend, ei, ep = 1, i, float(h[i])
    if trend != 0 and 0 < ei < n - 1:
        piv.append((ei, "high" if trend == 1 else "low", ep))
    return [(0, "start", c0)] + [p for p in piv if 0 < p[0] < n - 1] + [(n - 1, "end", float(c[-1]))]


def zz_threshold(h, l, c) -> float:
    atr = float(np.mean((h - l) / c))
    rng = float(h.max() / l.min() - 1)
    return max(min(2.0 * atr, 0.3 * rng), 0.14 * rng, 0.003)


def legs_of(zz) -> list[dict]:
    out = []
    for a, b in zip(zz, zz[1:]):
        out.append({"i0": a[0], "i1": b[0], "p0": a[2], "p1": b[2], "pct": (b[2] / a[2] - 1) * 100, "dur": b[0] - a[0]})
    return out


def legs_align(lc: list[dict], la: list[dict], w: int, rng_c: float, rng_a: float) -> tuple[float, list[tuple[int, int]]]:
    """DTW sulle gambe (movimento relativo al range della finestra + durata relativa). Ritorna (score, coppie)."""
    n, m = len(lc), len(la)
    if not n or not m:
        return 0.0, []
    def cost(x, y):
        mx = x["pct"] / max(rng_c, 1e-6)
        my = y["pct"] / max(rng_a, 1e-6)
        d = abs(mx - my) + 0.8 * abs(x["dur"] - y["dur"]) / w
        if (x["pct"] > 0) != (y["pct"] > 0):
            d += 0.6
        return d
    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = cost(lc[i - 1], la[j - 1]) + min(D[i - 1, j - 1], D[i - 1, j] + 0.25, D[i, j - 1] + 0.25)
    i, j = n, m
    path = [(n - 1, m - 1)]
    while i > 1 or j > 1:
        opts = []
        if i > 1 and j > 1:
            opts.append((D[i - 1, j - 1], i - 1, j - 1))
        if i > 1:
            opts.append((D[i - 1, j], i - 1, j))
        if j > 1:
            opts.append((D[i, j - 1], i, j - 1))
        _, i, j = min(opts, key=lambda x: x[0])
        path.append((i - 1, j - 1))
    path = path[::-1]
    mean_cost = D[n, m] / max(n, m)
    score = 100 * math.exp(-mean_cost / 0.35)
    return score, path


# ================================================================== trendline e figure

def _fit(xs, ys):
    if len(xs) < 2:
        return None
    a, b = np.polyfit(xs, ys, 1)
    res = float(np.mean(np.abs(np.array(ys) - (a * np.array(xs) + b))))
    return float(a), float(b), res


def trendlines(zz, n: int) -> dict | None:
    hs = [(p[0], p[2]) for p in zz if p[1] == "high"]
    ls_ = [(p[0], p[2]) for p in zz if p[1] == "low"]
    hs, ls_ = hs[-4:], ls_[-4:]
    if len(hs) < 2 or len(ls_) < 2:
        return None
    fu = _fit([x for x, _ in hs], [y for _, y in hs])
    fl = _fit([x for x, _ in ls_], [y for _, y in ls_])
    x0 = min(hs[0][0], ls_[0][0])
    return {"upper": fu, "lower": fl, "x0": x0, "x1": n - 1, "nh": len(hs), "nl": len(ls_)}


FAMILY = {
    "double_top": "rev_bear", "head_shoulders": "rev_bear", "rising_wedge": "rev_bear", "v_top": "rev_bear",
    "double_bottom": "rev_bull", "inv_head_shoulders": "rev_bull", "falling_wedge": "rev_bull", "v_bottom": "rev_bull",
    "cup_handle": "rev_bull",
    "asc_triangle": "triangle", "desc_triangle": "triangle", "sym_triangle": "triangle", "broadening": "triangle",
    "channel_up": "trend_up", "channel_down": "trend_down", "range": "range",
    "bull_flag": "cont_bull", "bull_pennant": "cont_bull", "bear_flag": "cont_bear", "bear_pennant": "cont_bear",
}
NAMES = {
    "double_top": "Doppio massimo", "double_bottom": "Doppio minimo", "head_shoulders": "Testa e spalle",
    "inv_head_shoulders": "Testa e spalle rovesciato", "asc_triangle": "Triangolo ascendente",
    "desc_triangle": "Triangolo discendente", "sym_triangle": "Triangolo simmetrico", "broadening": "Triangolo espanso",
    "rising_wedge": "Cuneo ascendente", "falling_wedge": "Cuneo discendente", "bull_flag": "Bandiera rialzista",
    "bear_flag": "Bandiera ribassista", "bull_pennant": "Pennant rialzista", "bear_pennant": "Pennant ribassista",
    "channel_up": "Canale rialzista", "channel_down": "Canale ribassista", "range": "Rettangolo / range",
    "v_bottom": "Inversione a V (minimo)", "v_top": "Inversione a V rovesciata (massimo)", "cup_handle": "Tazza con manico",
}
# articolo indeterminativo per la frase "Entrambi formano un/una ..."
ART = {k: ("un'" if v.split()[0] == "Inversione" else "una " if v.split()[0] in ("Bandiera", "Tazza") else "un ")
       for k, v in NAMES.items()}
def _lname(key: str) -> str:
    """Nome in minuscolo per l'uso in frase, preservando sigle come 'V'."""
    return " ".join(w if len(w) == 1 and w.isupper() else w.lower() for w in NAMES[key].split())


TONE = {"rev_bear": "bearish", "rev_bull": "bullish", "cont_bull": "bullish", "cont_bear": "bearish",
        "trend_up": "bullish", "trend_down": "bearish", "triangle": "neutral", "range": "neutral"}


def _line(i0, p0, i1, p1, kind):
    return {"kind": kind, "points": [{"idx": int(i0), "price": float(p0)}, {"idx": int(i1), "price": float(p1)}]}


def _pat(key, conf, lines, points):
    fam = FAMILY[key]
    if key in ("asc_triangle",):
        tone = "bullish"
    elif key in ("desc_triangle",):
        tone = "bearish"
    else:
        tone = TONE[fam]
    return {"key": key, "name": NAMES[key], "family": fam, "tone": tone, "confidence": round(float(min(95, max(0, conf))), 1),
            "lines": lines, "points": [{"idx": int(i), "price": float(p), "label": lab} for i, p, lab in points]}


def detect_patterns(o, h, l, c) -> list[dict]:
    n = len(c)
    H, L = float(h.max()), float(l.min())
    rngp = H - L
    if rngp <= 0 or n < 12:
        return []
    out: list[dict] = []
    zz = zigzag(h, l, c, zz_threshold(h, l, c) * 0.7)
    piv = [p for p in zz if p[1] in ("high", "low")]
    highs = [p for p in piv if p[1] == "high"]
    lows = [p for p in piv if p[1] == "low"]
    tol = 0.07 * rngp
    gap = max(3, n // 8)

    # ---- doppio massimo / minimo
    def double(pts, top: bool):
        best = None
        for a in range(len(pts)):
            for b in range(a + 1, len(pts)):
                ia, pa = pts[a][0], pts[a][2]
                ib, pb = pts[b][0], pts[b][2]
                if ib - ia < gap or abs(pa - pb) > tol:
                    continue
                ext = max(pa, pb) if top else min(pa, pb)
                # devono essere gli estremi della finestra (entro tolleranza)
                if (top and ext < H - tol) or (not top and ext > L + tol):
                    continue
                mid = l[ia:ib + 1].min() if top else h[ia:ib + 1].max()
                depth = (ext - mid) / rngp if top else (mid - ext) / rngp
                if depth < 0.3:
                    continue
                conf = 55 + 25 * (1 - abs(pa - pb) / tol) + 20 * min(1.0, (depth - 0.3) / 0.4)
                if best is None or conf > best[0]:
                    best = (conf, ia, pa, ib, pb, float(mid), int(ia + np.argmin(l[ia:ib + 1]) if top else ia + np.argmax(h[ia:ib + 1])))
        if best:
            conf, ia, pa, ib, pb, mid, im = best
            key = "double_top" if top else "double_bottom"
            lab = "Massimo" if top else "Minimo"
            out.append(_pat(key, conf, [_line(ia, pa, ib, pb, "resistance" if top else "support"),
                                        _line(im, mid, n - 1, mid, "neckline")],
                            [(ia, pa, f"{lab} 1"), (ib, pb, f"{lab} 2"), (im, mid, "Neckline")]))
    double(highs, True)
    double(lows, False)

    # ---- testa e spalle (e rovesciato)
    def hs(pts, inv: bool):
        best = None
        for k in range(len(pts) - 2):
            (i1, _, p1), (i2, _, p2), (i3, _, p3) = pts[k], pts[k + 1], pts[k + 2]
            if i3 - i1 < max(6, n // 4):
                continue
            head_ok = (p2 > max(p1, p3) + 0.12 * rngp) if not inv else (p2 < min(p1, p3) - 0.12 * rngp)
            if not head_ok or abs(p1 - p3) > 0.12 * rngp:
                continue
            seg1, seg2 = slice(i1, i2 + 1), slice(i2, i3 + 1)
            if not inv:
                t1, t2 = i1 + int(np.argmin(l[seg1])), i2 + int(np.argmin(l[seg2]))
                v1, v2 = float(l[t1]), float(l[t2])
            else:
                t1, t2 = i1 + int(np.argmax(h[seg1])), i2 + int(np.argmax(h[seg2]))
                v1, v2 = float(h[t1]), float(h[t2])
            sym = 1 - abs((i2 - i1) - (i3 - i2)) / max(1, i3 - i1)
            conf = 50 + 25 * (1 - abs(p1 - p3) / (0.12 * rngp)) + 20 * sym
            if best is None or conf > best[0]:
                best = (conf, i1, p1, i2, p2, i3, p3, t1, v1, t2, v2)
        if best:
            conf, i1, p1, i2, p2, i3, p3, t1, v1, t2, v2 = best
            slope = (v2 - v1) / max(1, t2 - t1)
            neck_end = v1 + slope * (n - 1 - t1)
            out.append(_pat("inv_head_shoulders" if inv else "head_shoulders", conf,
                            [_line(t1, v1, n - 1, neck_end, "neckline")],
                            [(i1, p1, "Spalla sx"), (i2, p2, "Testa"), (i3, p3, "Spalla dx")]))
    hs(highs, False)
    hs(lows, True)

    # ---- trendline: triangoli, cunei, canali, rettangolo
    tl = trendlines(zz, n)
    if tl and tl["upper"] and tl["lower"]:
        (au, bu, ru), (al, bl, rl) = tl["upper"], tl["lower"]
        x0, x1 = tl["x0"], n - 1
        span = x1 - x0
        if span >= n / 3:
            su = au * span / rngp  # variazione della linea sull'arco, in frazioni di range
            sl = al * span / rngp
            g0 = (au * x0 + bu) - (al * x0 + bl)
            g1 = (au * x1 + bu) - (al * x1 + bl)
            flat = 0.18
            fitq = max(0.0, 1 - (ru + rl) / (0.25 * rngp))
            conf = 40 + 35 * fitq + 5 * min(4, tl["nh"] + tl["nl"] - 4)
            key = None
            if g0 > 0 and g1 > 0:
                ratio = g1 / g0
                if ratio < 0.62:
                    if abs(su) < flat and sl > flat:
                        key = "asc_triangle"
                    elif su < -flat and abs(sl) < flat:
                        key = "desc_triangle"
                    elif su < -flat and sl > flat:
                        key = "sym_triangle"
                    elif su > flat and sl > flat:
                        key = "rising_wedge"
                    elif su < -flat and sl < -flat:
                        key = "falling_wedge"
                elif ratio > 1.6 and su > flat and sl < -flat:
                    key = "broadening"
                elif 0.7 <= ratio <= 1.45:
                    if su > flat and sl > flat:
                        key = "channel_up"
                    elif su < -flat and sl < -flat:
                        key = "channel_down"
                    elif abs(su) < flat and abs(sl) < flat:
                        key = "range"
            if key:
                out.append(_pat(key, conf, [_line(x0, au * x0 + bu, x1, au * x1 + bu, "resistance"),
                                            _line(x0, al * x0 + bl, x1, al * x1 + bl, "support")], []))

    # ---- bandiera / pennant
    for bull in (True, False):
        best = None
        for a, b in zip(piv, piv[1:]):
            if (a[1], b[1]) != (("low", "high") if bull else ("high", "low")):
                continue
            move = (b[2] - a[2]) if bull else (a[2] - b[2])
            dur = b[0] - a[0]
            rest = n - 1 - b[0]
            if move < 0.55 * rngp or dur > 0.45 * n or rest < max(4, int(0.15 * n)) or b[0] < n * 0.3:
                continue
            seg = slice(b[0], n)
            retr = ((b[2] - l[seg].min()) if bull else (h[seg].max() - b[2])) / move
            if retr > 0.5:
                continue
            xs = np.arange(b[0], n)
            fu = _fit(list(xs), list(h[seg]))
            fl = _fit(list(xs), list(l[seg]))
            gu0, gu1 = fu[0] * xs[0] + fu[1], fu[0] * xs[-1] + fu[1]
            gl0, gl1 = fl[0] * xs[0] + fl[1], fl[0] * xs[-1] + fl[1]
            converge = (gu1 - gl1) < 0.6 * (gu0 - gl0)
            conf = 50 + 30 * (1 - retr / 0.5) + 15 * min(1.0, move / rngp)
            if best is None or conf > best[0]:
                best = (conf, a, b, converge, (xs[0], gu0, xs[-1], gu1), (xs[0], gl0, xs[-1], gl1))
        if best:
            conf, a, b, converge, U, Lw = best
            key = ("bull_" if bull else "bear_") + ("pennant" if converge else "flag")
            out.append(_pat(key, conf, [_line(a[0], a[2], b[0], b[2], "pole"), _line(*U, "resistance"), _line(*Lw, "support")],
                            [(a[0], a[2], "Inizio asta"), (b[0], b[2], "Fine asta")]))

    # ---- inversione a V
    for bottom in (True, False):
        im = int(np.argmin(l)) if bottom else int(np.argmax(h))
        if not (0.2 * n <= im <= 0.8 * n):
            continue
        if bottom:
            pre = float(h[:im + 1].max())
            drop = (pre - L) / rngp
            rec = (c[-1] - L) / max(1e-9, pre - L)
        else:
            pre = float(l[:im + 1].min())
            drop = (H - pre) / rngp
            rec = (H - c[-1]) / max(1e-9, H - pre)
        if drop >= 0.7 and rec >= 0.75:
            ip = int(np.argmax(h[:im + 1])) if bottom else int(np.argmin(l[:im + 1]))
            conf = 50 + 30 * min(1.0, (rec - 0.75) / 0.25) + 15 * min(1.0, (drop - 0.7) / 0.3)
            key = "v_bottom" if bottom else "v_top"
            out.append(_pat(key, conf, [_line(ip, pre, im, L if bottom else H, "leg"),
                                        _line(im, L if bottom else H, n - 1, c[-1], "leg")],
                            [(im, L if bottom else H, "Vertice")]))

    # ---- tazza con manico (semplificata)
    k = int(n * 0.85)
    if k >= 12:
        xs = np.arange(k)
        a2, a1, a0 = np.polyfit(xs, c[:k], 2)
        fit = a2 * xs ** 2 + a1 * xs + a0
        ss = float(np.sum((c[:k] - c[:k].mean()) ** 2)) or 1e-9
        r2 = 1 - float(np.sum((c[:k] - fit) ** 2)) / ss
        vtx = -a1 / (2 * a2) if a2 != 0 else -1
        rim_l, rim_r = float(h[:max(2, k // 6)].max()), float(h[k - max(2, k // 6):k].max())
        depth = (min(rim_l, rim_r) - float(l[:k].min())) / rngp
        handle = (rim_r - float(l[k:].min())) / max(1e-9, rim_r - float(l[:k].min()))
        if a2 > 0 and r2 > 0.55 and 0.3 * k < vtx < 0.7 * k and abs(rim_l - rim_r) < 0.12 * rngp and depth > 0.5 and 0.05 < handle < 0.45:
            ib = int(np.argmin(l[:k]))
            out.append(_pat("cup_handle", 45 + 40 * (r2 - 0.55) / 0.45 + 10, [_line(0, rim_l, n - 1, rim_r, "resistance")],
                            [(int(np.argmax(h[:max(2, k // 6)])), rim_l, "Bordo sx"), (ib, float(l[ib]), "Fondo"),
                             (k - max(2, k // 6) + int(np.argmax(h[k - max(2, k // 6):k])), rim_r, "Bordo dx")]))

    out.sort(key=lambda p: -p["confidence"])
    # tieni al massimo 3 figure, una per famiglia
    seen, res = set(), []
    for p in out:
        if p["family"] in seen:
            continue
        seen.add(p["family"])
        res.append(p)
        if len(res) >= 3:
            break
    return res


def trend_geometry(zz, h, l) -> tuple[float, float] | None:
    n = len(h)
    tl = trendlines(zz, n)
    rngp = float(h.max() - l.min()) or 1e-9
    if not tl:
        return None
    span = tl["x1"] - tl["x0"]
    return tl["upper"][0] * span / rngp, tl["lower"][0] * span / rngp


def pattern_score(pc: list[dict], pa: list[dict], gc, ga) -> tuple[float, str | None, str]:
    """(score, chiave comune, testo)."""
    match = None
    common = None
    text = ""
    if pc or pa:
        best = 0.0
        for x in pc:
            for y in pa:
                if x["key"] == y["key"]:
                    s = 100 * (0.6 + 0.4 * min(x["confidence"], y["confidence"]) / 95)
                    if s > best:
                        best, common = s, x["key"]
                elif x["family"] == y["family"]:
                    best = max(best, 62.0)
        if not pc or not pa:
            best = 20.0
        match = best
        if common:
            text = f"Entrambi formano {ART[common]}{_lname(common)}."
        elif pc and pa:
            same_fam = [(x, y) for x in pc for y in pa if x["family"] == y["family"]]
            if same_fam:
                x, y = same_fam[0]
                text = f"Figure della stessa famiglia: oggi {_lname(x['key'])}, nell'analogo {_lname(y['key'])}."
            else:
                text = f"Figure diverse: oggi {_lname(pc[0]['key'])}, nell'analogo {_lname(pa[0]['key'])}."
        elif pc:
            text = f"Oggi si riconosce {ART[pc[0]['key']]}{_lname(pc[0]['key'])}, assente nell'analogo."
        else:
            text = f"Nell'analogo c'era {ART[pa[0]['key']]}{_lname(pa[0]['key'])}, oggi non riconosciuto."
    geo = None
    if gc and ga:
        d = abs(gc[0] - ga[0]) + abs(gc[1] - ga[1])
        geo = 100 * 2 ** (-(d / 0.5) ** 2)
        if not text:
            text = "Nessuna figura classica in entrambe: confronto basato sull'inclinazione delle trendline di massimi e minimi."
    if match is None and geo is None:
        return 50.0, None, "Struttura troppo irregolare per tracciare trendline."
    if match is None:
        return geo, common, text
    if geo is None:
        return match, common, text
    return 0.6 * match + 0.4 * geo, common, text


# ================================================================== volumi / volatilità

def volume_score(hc, lc, cc, vc, ha, la, ca, va) -> float | None:
    if not (np.isfinite(vc).mean() > 0.9 and np.isfinite(va).mean() > 0.9):
        return None
    vc = np.nan_to_num(vc, nan=np.nanmean(vc))
    va = np.nan_to_num(va, nan=np.nanmean(va))
    if vc.sum() <= 0 or va.sum() <= 0:
        return None

    def prof(h, l, c, v):
        tp = (h + l + c) / 3
        lo, hi = l.min(), h.max()
        b = np.clip(((tp - lo) / max(hi - lo, 1e-9) * 12).astype(int), 0, 11)
        p = np.bincount(b, weights=v, minlength=12)
        return p / p.sum()
    s_prof = 100 * (1 - 0.5 * float(np.abs(prof(hc, lc, cc, vc) - prof(ha, la, ca, va)).sum()))
    k = 3
    sm = lambda v: np.convolve(v / v.mean(), np.ones(k) / k, mode="valid")
    a, b = sm(vc), sm(va)
    corr = float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else 0.0
    s_time = 100 * max(0.0, corr) ** 0.7 if corr > 0 else 0.0
    return 0.55 * s_prof + 0.45 * s_time


def volatility_score(hc, lc, cc, ha, la, ca) -> float:
    k = 5
    ac = np.convolve((hc - lc) / cc, np.ones(k) / k, mode="valid")
    aa = np.convolve((ha - la) / ca, np.ones(k) / k, mode="valid")
    corr = float(np.corrcoef(ac, aa)[0, 1]) if ac.std() > 0 and aa.std() > 0 else 0.0
    lvl = math.exp(-abs(math.log(max(ac.mean(), 1e-9) / max(aa.mean(), 1e-9))) * 1.5)
    return 100 * (0.6 * max(0.0, corr) + 0.4 * lvl)


def combine(scores: dict) -> float:
    num = den = 0.0
    for k, w in VIS_WEIGHTS.items():
        v = scores.get(k)
        if v is None:
            continue
        num += w * v
        den += w
    return num / den if den else 0.0
