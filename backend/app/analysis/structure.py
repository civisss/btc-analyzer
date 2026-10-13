"""Struttura di mercato in stile KillaXBT / LP_NXT — funzioni pure, nessun I/O.

A) Pivot di apertura: Monday range (1h UTC), aperture settimanali/mensili/trimestrali/annuali come livelli
   ("magnete"), prima settimana del mese, analisi delle chiusure settimanali.
B) Struttura e range: range HTF correnti (4h/1d/1w), deviazioni/sweep, accettazione, recupero, retest
   ("integrità strutturale del range"), SFP, HH/HL/LH/LL con BOS/CHoCH; statistiche storiche degli esiti.

Convenzioni: percentuali in punti percentuali (2.3 = 2.3%), prezzi USD, tempi pandas UTC (convertiti da util.clean).
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .market import atr as _atr
from .market import true_range
from ..util import art

MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]


# ======================================================================= helpers

def usd(x: float | None) -> str:
    if x is None or not np.isfinite(x):
        return "n/d"
    return f"${x:,.0f}"


def pc(x: float | None, d: int = 1, signed: bool = True) -> str:
    if x is None or not np.isfinite(x):
        return "n/d"
    s = "+" if (signed and x > 0) else ""
    return f"{s}{x:.{d}f}%"


def dit(t) -> str:
    t = pd.Timestamp(t)
    return f"{t.day} {MESI[t.month - 1]} {t.year}"


def dit_short(t) -> str:
    t = pd.Timestamp(t)
    return f"{t.day} {MESI[t.month - 1]}"


def _r(x, nd=2):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(f) else round(f, nd)


def nel(x) -> str:
    """'nel 34%' / 'nell'81.6%' (n/d se mancante)."""
    return art(f"{x}%", "nel") if x is not None else "n/d"


def rate(k: float, n: float) -> float | None:
    return round(100.0 * k / n, 1) if n else None


def dist(a) -> dict:
    """Distribuzione sintetica (percentili) di un array di percentuali."""
    x = np.asarray([v for v in a if v is not None and np.isfinite(v)], float)
    if not len(x):
        return {"n": 0, "median": None, "mean": None, "p25": None, "p75": None, "p90": None}
    q = np.percentile(x, [25, 50, 75, 90])
    return {"n": int(len(x)), "median": _r(q[1]), "mean": _r(x.mean()), "p25": _r(q[0]), "p75": _r(q[2]), "p90": _r(q[3])}


def fwd_stats(vals) -> dict:
    x = np.asarray([v for v in vals if v is not None and np.isfinite(v)], float)
    if not len(x):
        return {"n": 0, "median": None, "mean": None, "win_rate": None}
    return {"n": int(len(x)), "median": _r(np.median(x)), "mean": _r(x.mean()), "win_rate": rate((x > 0).sum(), len(x))}


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    h, l = df["high"], df["low"]
    up = h.diff()
    dn = -l.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    mdm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    a = true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    pdi = 100 * pdm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / a
    mdi = 100 * mdm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / a
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


ADX_TREND = 25.0
REGIMES = [("ranging", "Laterale (ADX < 25)"), ("trending", "In trend (ADX ≥ 25)")]


def regime_of(v: float | None) -> str | None:
    if v is None or not np.isfinite(v):
        return None
    return "trending" if v >= ADX_TREND else "ranging"


def week_start(t: pd.Series) -> pd.Series:
    return (t - pd.to_timedelta(t.dt.dayofweek, unit="D")).dt.normalize()


# ================================================================ A1 Monday range

def _monday_week(g: pd.DataFrame) -> dict | None:
    dow = g["time"].dt.dayofweek.to_numpy()
    mon = dow == 0
    if mon.sum() < 20 or (~mon).sum() < 100:
        return None
    hi, lo, cl = g["high"].to_numpy(float), g["low"].to_numpy(float), g["close"].to_numpy(float)
    mh, ml = hi[mon].max(), lo[mon].min()
    rh, rl, rc = hi[~mon], lo[~mon], cl[~mon]
    out = {"mh": mh, "ml": ml, "open": float(g["open"].iat[0]), "mclose": cl[mon][-1], "wclose": cl[-1],
           "range_pct": (mh / ml - 1) * 100}
    for side in ("h", "l"):
        brk = rh > mh if side == "h" else rl < ml
        if not brk.any():
            out[side] = None
            continue
        i = int(np.argmax(brk))
        ph, pl = rh[i:], rl[i:]
        if side == "h":
            ext = (ph.max() / mh - 1) * 100
            back = bool((rc[i + 1:] < mh).any()) if i + 1 < len(rc) else False
            run = np.maximum.accumulate(ph)
            inv = float(((run - pl) / run).max() * 100)
            opp = bool(pl.min() <= ml)
            beyond = bool(cl[-1] > mh)
            lvl = float((1 - pl.min() / mh) * 100)
        else:
            ext = (1 - pl.min() / ml) * 100
            back = bool((rc[i + 1:] > ml).any()) if i + 1 < len(rc) else False
            run = np.minimum.accumulate(pl)
            inv = float(((ph - run) / run).max() * 100)
            opp = bool(ph.max() >= mh)
            beyond = bool(cl[-1] < ml)
            lvl = float((ph.max() / ml - 1) * 100)
        out[side] = {"i": i, "hours": i + 1, "ext": ext, "back": back, "inv": inv, "lvl": lvl, "opp": opp, "beyond": beyond}
    return out


def _side_stats(rows: list[dict], side: str) -> dict:
    n = len(rows)
    br = [r[side] for r in rows if r[side] is not None]
    first = 0
    other = "l" if side == "h" else "h"
    for r in rows:
        if r[side] is not None and (r[other] is None or r[side]["i"] < r[other]["i"]):
            first += 1
    nb = len(br)
    return {
        "weeks": n, "broken": nb, "broken_pct": rate(nb, n), "first_pct": rate(first, n),
        "back_inside_pct": rate(sum(b["back"] for b in br), nb),
        "rev2_pct": rate(sum(b["back"] and b["lvl"] >= 2 for b in br), nb),
        "rev3_pct": rate(sum(b["back"] and b["lvl"] >= 3 for b in br), nb),
        "reversal": dist([b["lvl"] for b in br]),
        "reach_opposite_pct": rate(sum(b["opp"] for b in br), nb),
        "close_beyond_pct": rate(sum(b["beyond"] for b in br), nb),
        "extension": dist([b["ext"] for b in br]),
        "inverse": dist([b["inv"] for b in br]),
        "hours_to_break_median": _r(np.median([b["hours"] for b in br]), 0) if br else None,
    }


def monday_range(h1: pd.DataFrame, d1: pd.DataFrame, now: pd.Timestamp, price: float) -> dict:
    df = h1[h1["time"] >= "2018-01-01"][["time", "open", "high", "low", "close"]].reset_index(drop=True)
    df["wk"] = week_start(df["time"])
    adx_d = adx(d1).to_numpy()
    adx_by_day = dict(zip(d1["time"].dt.normalize(), adx_d))
    cur_wk = week_start(pd.Series([now]))[0]
    rows: list[dict] = []
    for wk, g in df.groupby("wk", sort=True):
        if wk >= cur_wk:
            continue
        r = _monday_week(g)
        if r is None:
            continue
        r["week"] = wk
        r["year"] = wk.year
        r["adx"] = adx_by_day.get(wk)
        r["regime"] = regime_of(r["adx"])
        rows.append(r)

    stats = {"weeks": len(rows), "since": rows[0]["week"] if rows else None,
             "high": _side_stats(rows, "h"), "low": _side_stats(rows, "l"),
             "both_pct": rate(sum(r["h"] is not None and r["l"] is not None for r in rows), len(rows)),
             "none_pct": rate(sum(r["h"] is None and r["l"] is None for r in rows), len(rows)),
             "range_pct": dist([r["range_pct"] for r in rows])}
    by_regime = []
    for key, label in REGIMES:
        sub = [r for r in rows if r["regime"] == key]
        by_regime.append({"key": key, "label": label, "weeks": len(sub), "high": _side_stats(sub, "h"), "low": _side_stats(sub, "l")})
    by_year = []
    for y in sorted({r["year"] for r in rows}):
        sub = [r for r in rows if r["year"] == y]
        hs, ls = _side_stats(sub, "h"), _side_stats(sub, "l")
        by_year.append({"year": y, "weeks": len(sub),
                        "high_broken_pct": hs["broken_pct"], "high_rev2_pct": hs["rev2_pct"], "high_rev3_pct": hs["rev3_pct"],
                        "low_broken_pct": ls["broken_pct"], "low_rev2_pct": ls["rev2_pct"], "low_rev3_pct": ls["rev3_pct"]})
    stats["by_regime"] = by_regime
    stats["by_year"] = by_year

    # ------------------------------------------------ settimana corrente (live)
    cur = df[df["wk"] == cur_wk]
    cur_mon = cur[cur["time"].dt.dayofweek == 0]
    current = None
    if len(cur_mon):
        mh, ml = float(cur_mon["high"].max()), float(cur_mon["low"].min())
        if cur_mon["time"].iloc[-1] == cur["time"].iloc[-1]:  # l'ultima candela 1h è di lunedì: includi il prezzo live
            mh, ml = max(mh, price), min(ml, price)
        complete = now >= cur_wk + pd.Timedelta(days=1)
        rest = cur[cur["time"].dt.dayofweek > 0]
        hi_r = max(float(rest["high"].max()), price) if len(rest) else None
        lo_r = min(float(rest["low"].min()), price) if len(rest) else None
        broke_h = complete and hi_r is not None and hi_r > mh
        broke_l = complete and lo_r is not None and lo_r < ml
        first = None
        if broke_h or broke_l:
            th = rest["time"][rest["high"] > mh].min() if broke_h else None
            tl = rest["time"][rest["low"] < ml].min() if broke_l else None
            if th is not None and pd.isna(th):
                th = now
            if tl is not None and pd.isna(tl):
                tl = now
            first = "high" if (tl is None or (th is not None and th <= tl)) else "low"
        pos = "sopra" if price > mh else "sotto" if price < ml else "dentro"
        rng = (mh / ml - 1) * 100
        rank = None
        if rows:
            arr = np.array([r["range_pct"] for r in rows])
            rank = _r((arr <= rng).mean() * 100, 0)
        s_h, s_l = stats["high"], stats["low"]
        reg_now = regime_of(adx_d[-1] if len(adx_d) else None)
        if not complete:
            text = (f"Il lunedì è ancora in corso: range provvisorio {usd(ml)}–{usd(mh)} ({pc(rng, 2, False)}). "
                    f"Dal 2018 il massimo del lunedì è stato superato {nel(s_h['broken_pct'])} delle settimane e il minimo {nel(s_l['broken_pct'])}.")
        elif broke_h and not broke_l:
            text = (f"Massimo del lunedì ({usd(mh)}) superato. Storicamente, dopo la rottura del massimo, il prezzo è rientrato nel range "
                    f"con un movimento inverso ≥2% {nel(s_h['rev2_pct'])} dei casi e ha raggiunto il minimo del lunedì {nel(s_h['reach_opposite_pct'])}.")
        elif broke_l and not broke_h:
            text = (f"Minimo del lunedì ({usd(ml)}) violato. Storicamente, dopo la rottura del minimo, il prezzo è rientrato nel range "
                    f"con un movimento inverso ≥2% {nel(s_l['rev2_pct'])} dei casi e ha raggiunto il massimo del lunedì {nel(s_l['reach_opposite_pct'])}.")
        elif broke_h and broke_l:
            text = f"Entrambi gli estremi del lunedì sono stati violati ({stats['both_pct']}% delle settimane storiche): il range del lunedì ha esaurito la sua funzione di riferimento."
        else:
            text = (f"Prezzo dentro il range del lunedì ({usd(ml)}–{usd(mh)}). Nessun estremo violato finora; "
                    f"solo {nel(stats['none_pct'])} delle settimane storiche nessuno dei due viene rotto entro domenica.")
        current = {
            "week_start": cur_wk, "monday_complete": bool(complete), "high": mh, "low": ml, "mid": (mh + ml) / 2,
            "open": float(cur["open"].iloc[0]), "range_pct": _r(rng), "range_rank": rank, "price": price, "position": pos,
            "dist_high": _r((mh / price - 1) * 100), "dist_low": _r((ml / price - 1) * 100),
            "broke_high": bool(broke_h), "broke_low": bool(broke_l), "first_break": first,
            "ext_high": _r((hi_r / mh - 1) * 100) if broke_h else None, "ext_low": _r((1 - lo_r / ml) * 100) if broke_l else None,
            "regime": reg_now, "adx": _r(adx_d[-1] if len(adx_d) else None, 1), "text": text,
        }

    prev = rows[-1] if rows else None
    previous = None
    if prev:
        bh, bl = prev["h"], prev["l"]
        if bh and bl:
            first = "high" if bh["i"] < bl["i"] else "low"
        else:
            first = "high" if bh else "low" if bl else None
        if bh and not bl:
            otxt = f"Massimo rotto ({pc(bh['ext'])} oltre), " + ("rientro nel range" if bh["back"] else "nessun rientro") + f", movimento inverso dal livello {pc(bh['lvl'], 1, False)}."
        elif bl and not bh:
            otxt = f"Minimo rotto ({pc(-bl['ext'])} oltre), " + ("rientro nel range" if bl["back"] else "nessun rientro") + f", movimento inverso dal livello {pc(bl['lvl'], 1, False)}."
        elif bh and bl:
            otxt = f"Rotti entrambi: prima il {'massimo' if first == 'high' else 'minimo'}."
        else:
            otxt = "Nessun estremo del lunedì rotto."
        previous = {"week_start": prev["week"], "high": prev["mh"], "low": prev["ml"], "close": prev["wclose"],
                    "broke_high": bh is not None, "broke_low": bl is not None, "first_break": first, "text": otxt}

    history = []
    for r in rows[-26:][::-1]:
        bh, bl = r["h"], r["l"]
        first = None
        if bh or bl:
            first = "high" if (bh and (not bl or bh["i"] < bl["i"])) else "low"
        history.append({
            "week_start": r["week"], "high": r["mh"], "low": r["ml"], "range_pct": _r(r["range_pct"]),
            "broke_high": bh is not None, "broke_low": bl is not None, "first_break": first,
            "ext_high": _r(bh["ext"]) if bh else None, "ext_low": _r(bl["ext"]) if bl else None,
            "reversal": _r((bh if first == "high" else bl)["lvl"]) if first else None,
            "back_inside": bool((bh if first == "high" else bl)["back"]) if first else None,
            "week_return": _r((r["wclose"] / r["mclose"] - 1) * 100),
            "regime": r["regime"],
        })
    return {"current": current, "previous": previous, "stats": stats, "history": history}


# ===================================================== A2 aperture come livelli

def _revisit(o: float, hi: np.ndarray, lo: np.ndarray, thr: tuple) -> dict:
    exc = np.maximum(hi / o - 1, 1 - lo / o) * 100
    out = {}
    for d in thr:
        idx = np.where(exc >= d)[0]
        if not len(idx):
            out[d] = None
            continue
        i = idx[0]
        later = np.where((lo[i + 1:] <= o) & (hi[i + 1:] >= o))[0]
        out[d] = (True, int(later[0]) + 1) if len(later) else (False, None)
    return out


def _magnet(groups: list[tuple[float, np.ndarray, np.ndarray]], thr: tuple, unit_hours: float) -> list[dict]:
    res = {d: [] for d in thr}
    for o, hi, lo in groups:
        r = _revisit(o, hi, lo, thr)
        for d in thr:
            if r[d] is not None:
                res[d].append(r[d])
    out = []
    for d in thr:
        v = res[d]
        n = len(v)
        k = sum(1 for x in v if x[0])
        lag = [x[1] * unit_hours for x in v if x[0]]
        out.append({"threshold": d, "periods": len(groups), "n": n, "reached_pct": rate(n, len(groups)),
                    "revisit_pct": rate(k, n), "median_hours": _r(np.median(lag), 0) if lag else None})
    return out


def _current_excursion(o: float, hi: np.ndarray, lo: np.ndarray, price: float) -> dict:
    if not len(hi):
        return {"max_exc": 0.0, "revisited": None, "side": "sopra" if price >= o else "sotto"}
    exc = np.maximum(hi / o - 1, 1 - lo / o) * 100
    m = float(exc.max())
    i = int(np.argmax(exc))
    revisited = bool(((lo[i + 1:] <= o) & (hi[i + 1:] >= o)).any()) if i + 1 < len(hi) else False
    return {"max_exc": _r(m), "revisited": revisited, "side": "sopra" if price >= o else "sotto"}


def opens(h1: pd.DataFrame, d1: pd.DataFrame, daily: pd.DataFrame, now: pd.Timestamp, price: float) -> dict:
    d1 = d1[["time", "open", "high", "low", "close"]].reset_index(drop=True)
    today = now.normalize()
    wk = today - pd.Timedelta(days=today.dayofweek)
    mo = today.replace(day=1)
    qm = 3 * ((today.month - 1) // 3) + 1
    qo = today.replace(month=qm, day=1)
    yo = today.replace(month=1, day=1)

    def open_at(t):
        row = d1[d1["time"] >= t]
        return float(row["open"].iloc[0]) if len(row) else None

    def hl(t0, t1):
        sub = d1[(d1["time"] >= t0) & (d1["time"] < t1)]
        if not len(sub):
            return None, None, None
        return float(sub["high"].max()), float(sub["low"].min()), float(sub["close"].iloc[-1])

    pw_h, pw_l, pw_c = hl(wk - pd.Timedelta(days=7), wk)
    prev_m0 = (mo - pd.Timedelta(days=1)).replace(day=1)
    pm_h, pm_l, pm_c = hl(prev_m0, mo)

    # ---------------- magnete settimanale (1h, dal 2018)
    h = h1[h1["time"] >= "2018-01-01"][["time", "open", "high", "low"]].copy()
    h["wk"] = week_start(h["time"])
    wgroups = []
    cur_w = None
    for k, g in h.groupby("wk", sort=True):
        hi, lo = g["high"].to_numpy(float), g["low"].to_numpy(float)
        if k >= wk:
            cur_w = (float(g["open"].iat[0]), hi, lo)
            continue
        if len(g) >= 150:
            wgroups.append((float(g["open"].iat[0]), hi, lo))
    W_THR = (1.0, 2.0, 3.0, 5.0)
    weekly_mag = _magnet(wgroups, W_THR, 1.0)

    # ---------------- magnete mensile / trimestrale / annuale (daily dal 2012)
    dl = daily[daily["time"] >= "2012-01-01"][["time", "open", "high", "low", "close"]].copy()
    dl["m"] = dl["time"].dt.tz_localize(None).dt.to_period("M")
    dl["q"] = dl["time"].dt.tz_localize(None).dt.to_period("Q")
    dl["y"] = dl["time"].dt.year
    cur_m_p, cur_q_p = pd.Period(today.tz_localize(None), "M"), pd.Period(today.tz_localize(None), "Q")

    def groups_by(col, cur_key):
        out, cur_ = [], None
        for k, g in dl.groupby(col, sort=True):
            item = (float(g["open"].iat[0]), g["high"].to_numpy(float), g["low"].to_numpy(float))
            if k == cur_key:
                cur_ = item
            else:
                out.append(item)
        return out, cur_

    mg, _ = groups_by("m", cur_m_p)
    qg, _ = groups_by("q", cur_q_p)
    yg, _ = groups_by("y", today.year)
    monthly_mag = _magnet(mg, (3.0, 5.0, 10.0), 24.0)
    quarterly_mag = _magnet(qg, (5.0, 10.0, 20.0), 24.0)
    yearly_mag = _magnet(yg, (10.0, 20.0, 30.0), 24.0)

    # escursioni del periodo corrente (Binance)
    def cur_exc(t0, o):
        sub = d1[d1["time"] >= t0]
        hi, lo = sub["high"].to_numpy(float).copy(), sub["low"].to_numpy(float).copy()
        if len(hi):
            hi[-1], lo[-1] = max(hi[-1], price), min(lo[-1], price)
        return _current_excursion(o, hi, lo, price)

    w_open = cur_w[0] if cur_w else open_at(wk)
    if cur_w:
        hi_w, lo_w = cur_w[1].copy(), cur_w[2].copy()
        hi_w[-1], lo_w[-1] = max(hi_w[-1], price), min(lo_w[-1], price)
        w_exc = _current_excursion(w_open, hi_w, lo_w, price)
    else:
        w_exc = cur_exc(wk, w_open)
    m_open, q_open, y_open = open_at(mo), open_at(qo), open_at(yo)

    def mag_text(name, exc, table, art_word):
        reached = [x for x in table if exc["max_exc"] is not None and exc["max_exc"] >= x["threshold"] and x["revisit_pct"] is not None]
        if not reached:
            t0 = table[0]
            return (f"Finora il prezzo non si è allontanato di almeno {t0['threshold']:.0f}% dall'apertura {name}; "
                    f"quando succede, l'apertura viene rivisitata entro la fine del periodo {nel(t0['revisit_pct'])} dei casi.")
        x = reached[-1]
        if exc["revisited"]:
            return (f"Il prezzo si è allontanato fino {art(f'{exc["max_exc"]:.1f}%', 'al')} dall'apertura {name} ed è già tornato a toccarla.")
        return (f"Il prezzo si è allontanato fino {art(f'{exc["max_exc"]:.1f}%', 'al')} dall'apertura {name} senza ancora tornarci: "
                f"storicamente, dopo uno scostamento ≥{x['threshold']:.0f}%, {art_word} è stata rivisitata entro fine periodo {nel(x['revisit_pct'])} dei casi.")

    levels = []

    def lvl(key, label, p, group, note=None):
        if p is None:
            return
        levels.append({"key": key, "label": label, "price": p, "distance": _r((p / price - 1) * 100), "group": group,
                       "side": "sopra" if p > price else "sotto", "note": note})

    lvl("weekly_open", "Apertura settimanale", w_open, "open")
    lvl("monthly_open", "Apertura mensile", m_open, "open")
    lvl("quarterly_open", "Apertura trimestrale", q_open, "open", "coincide con l'apertura mensile" if qo == mo else None)
    lvl("yearly_open", "Apertura annuale", y_open, "open")
    lvl("prev_week_high", "Massimo settimana precedente", pw_h, "prev")
    lvl("prev_week_low", "Minimo settimana precedente", pw_l, "prev")
    lvl("prev_month_high", "Massimo mese precedente", pm_h, "prev")
    lvl("prev_month_low", "Minimo mese precedente", pm_l, "prev")
    levels.sort(key=lambda x: -x["price"])

    first_week = first_week_of_month(daily, now)
    return {
        "week_start": wk, "month_start": mo, "quarter_start": qo, "year_start": yo,
        "weekly": {"open": w_open, "excursion": w_exc, "magnet": weekly_mag, "since": "2018",
                   "text": mag_text("settimanale", w_exc, weekly_mag, "l'apertura")},
        "monthly": {"open": m_open, "excursion": cur_exc(mo, m_open) if m_open else None, "magnet": monthly_mag, "since": "2012",
                    "text": mag_text("mensile", cur_exc(mo, m_open), monthly_mag, "l'apertura") if m_open else ""},
        "quarterly": {"open": q_open, "excursion": cur_exc(qo, q_open) if q_open else None, "magnet": quarterly_mag, "since": "2012"},
        "yearly": {"open": y_open, "excursion": cur_exc(yo, y_open) if y_open else None, "magnet": yearly_mag, "since": "2012"},
        "prev_week": {"high": pw_h, "low": pw_l, "close": pw_c},
        "prev_month": {"high": pm_h, "low": pm_l, "close": pm_c},
        "levels": levels,
        "first_week": first_week,
    }


def first_week_of_month(daily: pd.DataFrame, now: pd.Timestamp) -> dict:
    dl = daily[daily["time"] >= "2012-01-01"][["time", "open", "high", "low", "close"]].copy()
    dl["m"] = dl["time"].dt.tz_localize(None).dt.to_period("M")
    cur_key = pd.Period(now.tz_localize(None), "M")
    rows = []
    cur = None
    for k, g in dl.groupby("m", sort=True):
        if len(g) < 7:
            if k == cur_key:
                cur = {"days": len(g), "fw_return": None}
            continue
        o = float(g["open"].iat[0])
        fw = g.iloc[:7]
        fw_ret = (float(fw["close"].iat[-1]) / o - 1) * 100
        if k == cur_key:
            cur = {"days": len(g), "fw_return": _r(fw_ret), "fw_high": float(fw["high"].max()), "fw_low": float(fw["low"].min()),
                   "mtd": _r((float(g["close"].iat[-1]) / o - 1) * 100)}
            continue
        m_ret = (float(g["close"].iat[-1]) / o - 1) * 100
        rest_ret = (float(g["close"].iat[-1]) / float(fw["close"].iat[-1]) - 1) * 100
        ih = int(np.argmax(g["high"].to_numpy()))
        il = int(np.argmin(g["low"].to_numpy()))
        rows.append({"fw": fw_ret, "m": m_ret, "rest": rest_ret, "hi_fw": ih < 7, "lo_fw": il < 7})
    n = len(rows)
    up = [r for r in rows if r["fw"] > 0]
    dn = [r for r in rows if r["fw"] <= 0]
    stats = {
        "months": n,
        "same_direction_pct": rate(sum((r["fw"] > 0) == (r["m"] > 0) for r in rows), n),
        "high_in_first_week_pct": rate(sum(r["hi_fw"] for r in rows), n),
        "low_in_first_week_pct": rate(sum(r["lo_fw"] for r in rows), n),
        "extreme_in_first_week_pct": rate(sum(r["hi_fw"] or r["lo_fw"] for r in rows), n),
        "after_up": {**fwd_stats([r["rest"] for r in up]), "month_up_pct": rate(sum(r["m"] > 0 for r in up), len(up))},
        "after_down": {**fwd_stats([r["rest"] for r in dn]), "month_up_pct": rate(sum(r["m"] > 0 for r in dn), len(dn))},
        "first_week": fwd_stats([r["fw"] for r in rows]),
    }
    text = ""
    if cur and cur.get("fw_return") is not None:
        side = stats["after_up"] if cur["fw_return"] > 0 else stats["after_down"]
        text = (f"Prima settimana del mese {pc(cur['fw_return'])}. Storicamente, dopo una prima settimana "
                f"{'positiva' if cur['fw_return'] > 0 else 'negativa'}, il mese ha chiuso in rialzo {nel(side['month_up_pct'])} dei casi "
                f"(resto del mese: mediana {pc(side['median'])}). Il massimo o il minimo del mese cade nella prima settimana nel "
                f"{stats['extreme_in_first_week_pct']}% dei mesi.")
    elif cur:
        text = f"La prima settimana del mese è in corso ({cur['days']} giorni su 7)."
    return {"current": cur, "stats": stats, "text": text, "since": "2012"}


# ===================================================== A3 chiusure settimanali

WEEKLY_EVENTS = [
    ("all", "Tutte le settimane", "Base di confronto"),
    ("sweep_reclaim_low", "Sweep del minimo precedente e chiusura sopra", "Minimo sotto quello della settimana precedente, chiusura sopra di esso"),
    ("close_above_prev_low", "Chiusura sopra il minimo precedente", "Chiusura settimanale sopra il minimo (wick) della settimana precedente"),
    ("close_below_prev_low", "Chiusura sotto il minimo precedente", "Chiusura settimanale sotto il minimo (wick) della settimana precedente"),
    ("sweep_reject_high", "Sweep del massimo precedente e chiusura sotto", "Massimo sopra quello della settimana precedente, chiusura sotto di esso"),
    ("close_above_prev_high", "Chiusura sopra il massimo precedente", "Chiusura settimanale sopra il massimo (wick) della settimana precedente"),
    ("close_above_range_4w", "Chiusura sopra il range di 4 settimane", "Chiusura sopra il massimo delle 4 settimane precedenti"),
    ("close_below_range_4w", "Chiusura sotto il range di 4 settimane", "Chiusura sotto il minimo delle 4 settimane precedenti"),
    ("inside_week", "Settimana interna", "Massimo e minimo dentro la settimana precedente"),
]


def _weekly_frame(daily: pd.DataFrame) -> pd.DataFrame:
    d = daily[daily["time"] >= "2012-01-02"][["time", "open", "high", "low", "close"]].copy()
    d["wk"] = week_start(d["time"])
    w = d.groupby("wk").agg(open=("open", "first"), high=("high", "max"), low=("low", "min"), close=("close", "last"), n=("time", "size"))
    return w.reset_index().rename(columns={"wk": "time"})


def _weekly_flags(o, h, l, c, i) -> dict:
    p = i - 1
    r4h = h[max(0, i - 4):i].max() if i >= 4 else np.nan
    r4l = l[max(0, i - 4):i].min() if i >= 4 else np.nan
    return {
        "all": True,
        "sweep_reclaim_low": l[i] < l[p] and c[i] > l[p],
        "close_above_prev_low": c[i] > l[p],
        "close_below_prev_low": c[i] < l[p],
        "sweep_reject_high": h[i] > h[p] and c[i] < h[p],
        "close_above_prev_high": c[i] > h[p],
        "close_above_range_4w": bool(i >= 4 and c[i] > r4h),
        "close_below_range_4w": bool(i >= 4 and c[i] < r4l),
        "inside_week": h[i] <= h[p] and l[i] >= l[p],
    }


def weekly_close(daily: pd.DataFrame, w1: pd.DataFrame, now: pd.Timestamp, price: float) -> dict:
    w = _weekly_frame(daily)
    cur_wk = week_start(pd.Series([now]))[0]
    w = w[(w["time"] < cur_wk) & (w["n"] == 7)].reset_index(drop=True)
    o, h, l, c = (w[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    n = len(w)
    acc = {k: {1: [], 2: [], 4: []} for k, _, _ in WEEKLY_EVENTS}
    cnt = {k: 0 for k, _, _ in WEEKLY_EVENTS}
    last_occ = {k: None for k, _, _ in WEEKLY_EVENTS}
    for i in range(1, n):
        f = _weekly_flags(o, h, l, c, i)
        for k, v in f.items():
            if not v:
                continue
            cnt[k] += 1
            last_occ[k] = w["time"].iat[i]
            for hz in (1, 2, 4):
                if i + hz < n:
                    acc[k][hz].append((c[i + hz] / c[i] - 1) * 100)
    base_n = cnt["all"]
    events = []
    for k, label, desc in WEEKLY_EVENTS:
        events.append({"key": k, "label": label, "description": desc, "n": cnt[k], "freq_pct": rate(cnt[k], base_n),
                       "w1": fwd_stats(acc[k][1]), "w2": fwd_stats(acc[k][2]), "w4": fwd_stats(acc[k][4]),
                       "last": last_occ[k]})

    # ---------------- settimana corrente (Binance) e ultima chiusa
    wb = w1[["time", "open", "high", "low", "close"]].reset_index(drop=True)
    cur_i = len(wb) - 1 if wb["time"].iat[-1] >= cur_wk else None
    last_closed = None
    current = None
    ob, hb, lb, cb = (wb[k].to_numpy(float).copy() for k in ("open", "high", "low", "close"))
    if cur_i is not None:
        hb[cur_i], lb[cur_i], cb[cur_i] = max(hb[cur_i], price), min(lb[cur_i], price), price
        lc = cur_i - 1
    else:
        lc = len(wb) - 1
    if lc >= 5:
        f = _weekly_flags(ob, hb, lb, cb, lc)
        tags = [k for k, _, _ in WEEKLY_EVENTS if k not in ("all", "close_above_prev_low", "close_below_prev_low") and f[k]]
        tags.insert(0, "close_above_prev_low" if f["close_above_prev_low"] else "close_below_prev_low")
        last_closed = {"week_start": wb["time"].iat[lc], "open": ob[lc], "high": hb[lc], "low": lb[lc], "close": cb[lc],
                       "prev_high": hb[lc - 1], "prev_low": lb[lc - 1], "events": tags}
    if cur_i is not None:
        f = _weekly_flags(ob, hb, lb, cb, cur_i)
        r4h, r4l = hb[cur_i - 4:cur_i].max(), lb[cur_i - 4:cur_i].min()
        tags = [k for k, _, _ in WEEKLY_EVENTS if k != "all" and f[k]]
        pl, ph = lb[cur_i - 1], hb[cur_i - 1]
        ev_map = {e["key"]: e for e in events}
        key = "close_above_prev_low" if price > pl else "close_below_prev_low"
        e = ev_map[key]
        text = (f"Se la settimana chiudesse ora ({usd(price)}), chiuderebbe {'sopra' if price > pl else 'sotto'} il minimo della settimana precedente "
                f"({usd(pl)}): storicamente, dopo questo tipo di chiusura, la settimana successiva è stata positiva {nel(e['w1']['win_rate'])} dei casi "
                f"(mediana a 4 settimane {pc(e['w4']['median'])}).")
        current = {"week_start": wb["time"].iat[cur_i], "open": ob[cur_i], "high": hb[cur_i], "low": lb[cur_i], "price": price,
                   "prev_high": ph, "prev_low": pl, "range4_high": r4h, "range4_low": r4l,
                   "provisional_events": tags, "text": text,
                   "levels": [
                       {"label": "Massimo settimana precedente", "price": ph, "distance": _r((ph / price - 1) * 100)},
                       {"label": "Minimo settimana precedente", "price": pl, "distance": _r((pl / price - 1) * 100)},
                       {"label": "Massimo 4 settimane", "price": r4h, "distance": _r((r4h / price - 1) * 100)},
                       {"label": "Minimo 4 settimane", "price": r4l, "distance": _r((r4l / price - 1) * 100)},
                   ]}
    return {"events": events, "current": current, "last_closed": last_closed, "weeks": base_n, "since": w["time"].iat[0] if n else None}


# ======================================================== B swing / zigzag

def zigzag_confirmed(h: np.ndarray, l: np.ndarray, a: np.ndarray, mult: float) -> list[dict]:
    """Zigzag ATR con indice di conferma (ci) — utilizzabile in modo causale."""
    n = len(h)
    piv: list[dict] = []
    trend = 0
    ext_i = 0
    ext_hi, ext_lo = h[0], l[0]
    hi_i, lo_i = 0, 0
    for i in range(1, n):
        thr = mult * a[i]
        if not np.isfinite(thr):
            continue
        if trend == 0:
            if h[i] > ext_hi:
                ext_hi, hi_i = h[i], i
            if l[i] < ext_lo:
                ext_lo, lo_i = l[i], i
            if ext_hi - l[i] > thr and hi_i < i:
                piv.append({"i": hi_i, "kind": "high", "ci": i})
                trend, ext_i, ext_lo = -1, i, l[i]
            elif h[i] - ext_lo > thr and lo_i < i:
                piv.append({"i": lo_i, "kind": "low", "ci": i})
                trend, ext_i, ext_hi = 1, i, h[i]
            continue
        if trend == 1:
            if h[i] >= ext_hi:
                ext_hi, ext_i = h[i], i
            elif ext_hi - l[i] > thr:
                piv.append({"i": ext_i, "kind": "high", "ci": i})
                trend, ext_i, ext_lo = -1, i, l[i]
        else:
            if l[i] <= ext_lo:
                ext_lo, ext_i = l[i], i
            elif h[i] - ext_lo > thr:
                piv.append({"i": ext_i, "kind": "low", "ci": i})
                trend, ext_i, ext_hi = 1, i, h[i]
    if trend == 1:
        piv.append({"i": ext_i, "kind": "high", "ci": None})
    elif trend == -1:
        piv.append({"i": ext_i, "kind": "low", "ci": None})
    for p in piv:
        p["price"] = float(h[p["i"]] if p["kind"] == "high" else l[p["i"]])
    return piv


def fractals(h: np.ndarray, l: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    n = len(h)
    ph = np.zeros(n, bool)
    pl = np.zeros(n, bool)
    if n < 2 * k + 1:
        return ph, pl
    from numpy.lib.stride_tricks import sliding_window_view as sw
    wh = sw(h, 2 * k + 1)
    wl = sw(l, 2 * k + 1)
    c = k
    left_h = wh[:, :c].max(axis=1)
    right_h = wh[:, c + 1:].max(axis=1)
    left_l = wl[:, :c].min(axis=1)
    right_l = wl[:, c + 1:].min(axis=1)
    ph[k:n - k] = (wh[:, c] > left_h) & (wh[:, c] >= right_h)
    pl[k:n - k] = (wl[:, c] < left_l) & (wl[:, c] <= right_l)
    return ph, pl


def label_swings(piv: list[dict]) -> list[dict]:
    last = {"high": None, "low": None}
    for p in piv:
        prev = last[p["kind"]]
        if prev is None:
            p["label"] = None
        elif p["kind"] == "high":
            p["label"] = "HH" if p["price"] > prev else "LH"
        else:
            p["label"] = "HL" if p["price"] > prev else "LL"
        last[p["kind"]] = p["price"]
    return piv


# ===================================================== B storico eventi (causale)

TF_CFG = {
    # lookback range, max ampiezza in ATR, giorni->barre, frattali k, zigzag mult
    "1d": {"R": 20, "wmax": 7.0, "bpd": 1, "k": 3, "zz": 2.5, "cool": 3},
    "4h": {"R": 42, "wmax": 8.0, "bpd": 6, "k": 3, "zz": 3.0, "cool": 6},
    "1w": {"R": 12, "wmax": 7.0, "bpd": 1, "k": 2, "zz": 2.0, "cool": 2},   # solo per lo stato corrente (niente statistiche)
}
HORIZONS_D = (1, 3, 7, 14)

EVENT_DEFS = {
    "dev_high": ("Deviazione sopra il range", "Wick oltre il massimo del range e chiusura di nuovo dentro", -1, "metà range", "minimo del range", "nuovo massimo oltre la deviazione"),
    "dev_low": ("Deviazione sotto il range", "Wick sotto il minimo del range e chiusura di nuovo dentro (sweep)", 1, "metà range", "massimo del range", "nuovo minimo sotto la deviazione"),
    "failed_break_high": ("Rottura fallita sopra", "Una chiusura sopra il massimo, poi chiusura di nuovo dentro", -1, "metà range", "minimo del range", "nuovo massimo oltre la rottura"),
    "reclaim_low": ("Recupero del minimo", "Una chiusura sotto il minimo, poi chiusura di nuovo dentro (reclaim)", 1, "metà range", "massimo del range", "nuovo minimo sotto la rottura"),
    "accept_high": ("Accettazione sopra", "Due chiusure consecutive sopra il massimo del range", 1, "+½ ampiezza", "+1× ampiezza (measured move)", "ritorno a metà range"),
    "accept_low": ("Accettazione sotto", "Due chiusure consecutive sotto il minimo del range", -1, "−½ ampiezza", "−1× ampiezza (measured move)", "ritorno a metà range"),
    "retest_hold_high": ("Retest tenuto sopra", "Dopo l'accettazione sopra, ritorno sul vecchio massimo con chiusura sopra (integrità strutturale)", 1, "+½ ampiezza", "+1× ampiezza", "ritorno a metà range"),
    "retest_fail_high": ("Retest fallito sopra", "Dopo l'accettazione sopra, ritorno sul vecchio massimo con chiusura dentro il range", -1, "metà range", "minimo del range", "nuovo massimo dopo la rottura"),
    "retest_hold_low": ("Retest tenuto sotto", "Dopo l'accettazione sotto, ritorno sul vecchio minimo con chiusura sotto", -1, "−½ ampiezza", "−1× ampiezza", "ritorno a metà range"),
    "retest_fail_low": ("Retest fallito sotto", "Dopo l'accettazione sotto, ritorno sul vecchio minimo con chiusura dentro il range", 1, "metà range", "massimo del range", "nuovo minimo dopo la rottura"),
    "sfp_high": ("SFP sul massimo", "Swing failure: wick sopra l'ultimo swing high e chiusura sotto", -1, "−1.5 ATR", "−3 ATR", "nuovo massimo oltre la SFP"),
    "sfp_low": ("SFP sul minimo", "Swing failure: wick sotto l'ultimo swing low e chiusura sopra", 1, "+1.5 ATR", "+3 ATR", "nuovo minimo sotto la SFP"),
    "bos_up": ("BOS rialzista", "Chiusura sopra l'ultimo swing high in struttura rialzista", 1, "+1.5 ATR", "+3 ATR", "rottura dell'ultimo swing low"),
    "bos_down": ("BOS ribassista", "Chiusura sotto l'ultimo swing low in struttura ribassista", -1, "−1.5 ATR", "−3 ATR", "rottura dell'ultimo swing high"),
    "choch_up": ("CHoCH rialzista", "Cambio di carattere: chiusura sopra l'ultimo swing high in struttura ribassista", 1, "+1.5 ATR", "+3 ATR", "rottura dell'ultimo swing low"),
    "choch_down": ("CHoCH ribassista", "Cambio di carattere: chiusura sotto l'ultimo swing low in struttura rialzista", -1, "−1.5 ATR", "−3 ATR", "rottura dell'ultimo swing high"),
}
EVENT_ORDER = list(EVENT_DEFS)


def _touches(arr: np.ndarray, level: float, tol: float, high: bool) -> int:
    near = arr >= level - tol if high else arr <= level + tol
    if not near.any():
        return 0
    # tocchi distinti = sequenze separate di barre vicine al livello
    return int(near[0]) + int(((near[1:]) & (~near[:-1])).sum())


def detect_events(df: pd.DataFrame, tf: str) -> tuple[list[dict], dict]:
    """Rileva in modo causale (nessun dato futuro) gli eventi di range/SFP/struttura su tutto lo storico."""
    cfg = TF_CFG[tf]
    R, wmax, cool, k = cfg["R"], cfg["wmax"], cfg["cool"], cfg["k"]
    o, h, l, c = (df[x].to_numpy(float) for x in ("open", "high", "low", "close"))
    a = _atr(df).to_numpy(float)
    n = len(df)
    ev: list[dict] = []
    last_at: dict[str, int] = {}

    def add(key, i, **ref):
        if i - last_at.get(key, -10 ** 9) <= cool:
            return
        last_at[key] = i
        ev.append({"key": key, "i": i, **ref})

    # ---------------- range (Donchian R barre con >=2 tocchi per lato e ampiezza contenuta)
    pend = None   # breakout in attesa della seconda chiusura
    watch = []    # retest dopo accettazione
    for t in range(R + 15, n):
        H = h[t - R:t].max()
        L = l[t - R:t].min()
        at = a[t - 1]
        if not np.isfinite(at) or at <= 0:
            continue
        # follow-up dei breakout pendenti
        if pend is not None and t == pend["t0"] + 1:
            Hp, Lp, d = pend["H"], pend["L"], pend["dir"]
            if d > 0:
                if c[t] > Hp:
                    add("accept_high", t, H=Hp, L=Lp, ext=max(h[pend["t0"]], h[t]))
                    watch.append({"dir": 1, "H": Hp, "L": Lp, "t0": t, "ext": max(h[pend["t0"]], h[t])})
                else:
                    add("failed_break_high", t, H=Hp, L=Lp, ext=max(h[pend["t0"]], h[t]))
            else:
                if c[t] < Lp:
                    add("accept_low", t, H=Hp, L=Lp, ext=min(l[pend["t0"]], l[t]))
                    watch.append({"dir": -1, "H": Hp, "L": Lp, "t0": t, "ext": min(l[pend["t0"]], l[t])})
                else:
                    add("reclaim_low", t, H=Hp, L=Lp, ext=min(l[pend["t0"]], l[t]))
            pend = None
            continue
        keep = []
        for w in watch:
            if t - w["t0"] > 10:
                continue
            if w["dir"] > 0:
                w["ext"] = max(w["ext"], h[t])
                if l[t] <= w["H"] * 1.0025:
                    add("retest_hold_high" if c[t] > w["H"] else "retest_fail_high", t, H=w["H"], L=w["L"], ext=w["ext"])
                    continue
            else:
                w["ext"] = min(w["ext"], l[t])
                if h[t] >= w["L"] * 0.9975:
                    add("retest_hold_low" if c[t] < w["L"] else "retest_fail_low", t, H=w["H"], L=w["L"], ext=w["ext"])
                    continue
            keep.append(w)
        watch = keep
        width = H - L
        if width / at > wmax:
            continue
        tol = 0.75 * at
        if _touches(h[t - R:t], H, tol, True) < 2 or _touches(l[t - R:t], L, tol, False) < 2:
            continue
        if c[t] > H:
            pend = {"dir": 1, "H": H, "L": L, "t0": t}
        elif c[t] < L:
            pend = {"dir": -1, "H": H, "L": L, "t0": t}
        elif h[t] > H + 0.05 * at:
            add("dev_high", t, H=H, L=L, ext=h[t])
        elif l[t] < L - 0.05 * at:
            add("dev_low", t, H=H, L=L, ext=l[t])

    # ---------------- SFP su frattali confermati
    ph, pl = fractals(h, l, k)
    highs: list[tuple[int, float]] = []
    lows: list[tuple[int, float]] = []
    for t in range(k + 1, n):
        j = t - k  # frattale confermato al tempo t
        if ph[j]:
            highs.append((j, h[j]))
        if pl[j]:
            lows.append((j, l[j]))
        highs = [x for x in highs if t - x[0] <= 60]
        lows = [x for x in lows if t - x[0] <= 60]
        sw_h = [x for x in highs if h[t] > x[1] and x[0] < t]
        if sw_h:
            top = max(x[1] for x in sw_h)
            if c[t] < top:
                add("sfp_high", t, level=top, ext=h[t], atr=a[t])
            highs = [x for x in highs if x not in sw_h]
        sw_l = [x for x in lows if l[t] < x[1] and x[0] < t]
        if sw_l:
            bot = min(x[1] for x in sw_l)
            if c[t] > bot:
                add("sfp_low", t, level=bot, ext=l[t], atr=a[t])
            lows = [x for x in lows if x not in sw_l]

    # ---------------- BOS / CHoCH su zigzag confermato
    piv = zigzag_confirmed(h, l, np.nan_to_num(a, nan=np.nanmean(a)), cfg["zz"])
    conf = sorted([p for p in piv if p["ci"] is not None], key=lambda p: p["ci"])
    trend = 0
    sh = sl = None
    pi = 0
    for t in range(n):
        while pi < len(conf) and conf[pi]["ci"] <= t:
            p = conf[pi]
            if p["kind"] == "high":
                sh = {"price": p["price"], "broken": False, "i": p["i"]}
            else:
                sl = {"price": p["price"], "broken": False, "i": p["i"]}
            pi += 1
        if sh and not sh["broken"] and c[t] > sh["price"]:
            sh["broken"] = True
            add("choch_up" if trend < 0 else "bos_up", t, level=sh["price"], inv=sl["price"] if sl else None, atr=a[t])
            trend = 1
        if sl and not sl["broken"] and c[t] < sl["price"]:
            sl["broken"] = True
            add("choch_down" if trend > 0 else "bos_down", t, level=sl["price"], inv=sh["price"] if sh else None, atr=a[t])
            trend = -1
    ev.sort(key=lambda e: e["i"])
    return ev, {"piv": piv}


def _targets(e: dict, c: float) -> tuple[int, float, float, float]:
    key = e["key"]
    d = EVENT_DEFS[key][2]
    if key in ("dev_high", "dev_low", "failed_break_high", "reclaim_low", "retest_fail_high", "retest_fail_low"):
        mid = (e["H"] + e["L"]) / 2
        t2 = e["L"] if d < 0 else e["H"]
        return d, mid, t2, e["ext"]
    if key in ("accept_high", "accept_low", "retest_hold_high", "retest_hold_low"):
        W = e["H"] - e["L"]
        mid = (e["H"] + e["L"]) / 2
        if d > 0:
            return d, e["H"] + 0.5 * W, e["H"] + W, mid
        return d, e["L"] - 0.5 * W, e["L"] - W, mid
    at = e.get("atr") or 0
    inv = e.get("ext") if key.startswith("sfp") else e.get("inv")
    if inv is None or not np.isfinite(inv):
        inv = c - 3 * at * d
    return d, c + 1.5 * at * d, c + 3 * at * d, inv


def event_stats(df: pd.DataFrame, tf: str) -> dict:
    cfg = TF_CFG[tf]
    bpd = cfg["bpd"]
    ev, _ = detect_events(df, tf)
    h, l, c = (df[x].to_numpy(float) for x in ("high", "low", "close"))
    n = len(df)
    hz_bars = [x * bpd for x in HORIZONS_D]
    win = 14 * bpd
    base = {}
    for hd, hb in zip(HORIZONS_D, hz_bars):
        r = (c[hb:] / c[:-hb] - 1) * 100
        base[f"d{hd}"] = fwd_stats(r)
    groups: dict[str, list] = {k: [] for k in EVENT_ORDER}
    for e in ev:
        i = e["i"]
        if i + 1 >= n:
            continue
        d, t1, t2, inv = _targets(e, c[i])
        rec = {"i": i, "dir": d}
        for hd, hb in zip(HORIZONS_D, hz_bars):
            rec[f"d{hd}"] = (c[i + hb] / c[i] - 1) * 100 if i + hb < n else None
        hit1 = hit2 = hit_inv = False
        if i + win < n:
            for j in range(i + 1, i + win + 1):
                bad = l[j] <= inv if d > 0 else h[j] >= inv
                if bad:
                    hit_inv = True
                    break
                if (h[j] >= t1) if d > 0 else (l[j] <= t1):
                    hit1 = True
                if (h[j] >= t2) if d > 0 else (l[j] <= t2):
                    hit2 = True
                    break
            rec["outcome"] = (hit1 or hit2, hit2, hit_inv)
        else:
            rec["outcome"] = None
        groups[e["key"]].append(rec)
    out = []
    for key in EVENT_ORDER:
        recs = groups[key]
        label, desc, d, t1l, t2l, invl = EVENT_DEFS[key]
        done = [r["outcome"] for r in recs if r["outcome"] is not None]
        nd = len(done)
        fw = {f"d{hd}": fwd_stats([r[f"d{hd}"] for r in recs]) for hd in HORIZONS_D}
        d7 = [r["d7"] for r in recs if r["d7"] is not None]
        follow = rate(sum((x > 0) == (d > 0) for x in d7 if x != 0), len(d7)) if d7 else None
        out.append({
            "key": key, "label": label, "description": desc, "direction": "up" if d > 0 else "down",
            "n": len(recs), "fwd": fw, "follow_pct": follow,
            "target1": t1l, "target2": t2l, "invalidation": invl,
            "p_target1": rate(sum(x[0] for x in done), nd), "p_target2": rate(sum(x[1] for x in done), nd),
            "p_invalid": rate(sum(x[2] for x in done), nd), "n_outcome": nd,
            "last": df["time"].iat[recs[-1]["i"]] if recs else None,
        })
    return {"tf": tf, "since": df["time"].iat[0], "bars": n, "events": out, "base": base}


# ===================================================== B range corrente

RANGE_CFG = {
    "4h": {"zz": 2.0, "frac": 3, "max_bars": 360, "min_bars": 18, "accept": 3, "cool": 6, "wmin": 1.5, "wmax": 9.0},
    "1d": {"zz": 1.5, "frac": 2, "max_bars": 260, "min_bars": 10, "accept": 2, "cool": 3, "wmin": 1.5, "wmax": 9.0},
    "1w": {"zz": 1.5, "frac": 2, "max_bars": 160, "min_bars": 6, "accept": 2, "cool": 2, "wmin": 1.5, "wmax": 9.0},
}


def _cluster(levels: list[tuple[int, float]], tol: float) -> list[list[tuple[int, float]]]:
    pts = sorted(levels, key=lambda x: x[1])
    out: list[list[tuple[int, float]]] = []
    for p in pts:
        if out and p[1] - out[-1][0][1] <= tol:
            out[-1].append(p)
        else:
            out.append([p])
    return out


def _range_candidate(df_h, df_l, df_c, ph, pl, a_now, s, e, cfg, extra_hi=None, extra_lo=None):
    tol = 0.5 * a_now
    his = [(i, df_h[i]) for i in range(s, e + 1) if ph[i]]
    los = [(i, df_l[i]) for i in range(s, e + 1) if pl[i]]
    if extra_hi is not None:
        his.append(extra_hi)
    if extra_lo is not None:
        los.append(extra_lo)
    his = list(dict.fromkeys(his))
    los = list(dict.fromkeys(los))
    if not his or not los:
        return None
    ch = _cluster(his, tol)
    cl = _cluster(los, tol)
    multi_h = [g for g in ch if len(g) >= 2]
    multi_l = [g for g in cl if len(g) >= 2]
    gh = multi_h[-1] if multi_h else ch[-1]
    gl = multi_l[0] if multi_l else cl[0]
    H = max(x[1] for x in gh)
    L = min(x[1] for x in gl)
    if H <= L:
        return None
    W = H - L
    if not (cfg["wmin"] <= W / a_now <= cfg["wmax"]):
        return None
    # chiusure finali fuori dal range (rottura in corso) escluse dal contenimento
    closes = df_c[s:e + 1]
    tail = 0
    for x in closes[::-1]:
        if x > H + 0.1 * a_now and tail >= 0:
            tail += 1
        elif x < L - 0.1 * a_now and tail <= 0:
            tail -= 1
        else:
            break
    body = closes[: len(closes) - abs(tail)] if tail else closes
    if len(body) < cfg["min_bars"]:
        return None
    inside = ((body >= L - 0.3 * a_now) & (body <= H + 0.3 * a_now)).mean()
    if inside < 0.9:
        return None
    return {"s": s, "H": H, "L": L, "th": len(gh), "tl": len(gl), "tail": tail, "inside": float(inside),
            "hi_pts": gh, "lo_pts": gl}


def detect_range(df: pd.DataFrame, tf: str) -> dict | None:
    cfg = RANGE_CFG[tf]
    df = df.tail(cfg["max_bars"] + 60).reset_index(drop=True)
    h, l, c = (df[x].to_numpy(float) for x in ("high", "low", "close"))
    a = _atr(df).to_numpy(float)
    n = len(df)
    a_now = float(a[-1])
    ph, pl = fractals(h, l, cfg["frac"])
    piv = zigzag_confirmed(h, l, np.nan_to_num(a, nan=a_now), cfg["zz"])
    starts = [p for p in piv if p["i"] >= n - cfg["max_bars"] and p["i"] <= n - cfg["min_bars"]]
    cands = []
    for p in reversed(starts):
        s = p["i"]
        eh = (s, h[s]) if p["kind"] == "high" else None
        el = (s, l[s]) if p["kind"] == "low" else None
        r = _range_candidate(h, l, c, ph, pl, a_now, s, n - 1, cfg, eh, el)
        if r:
            r["start_kind"] = p["kind"]
            cands.append(r)
    if not cands:
        return None

    def same(x, y):
        return abs(x["H"] - y["H"]) <= 0.2 * a_now and abs(x["L"] - y["L"]) <= 0.2 * a_now

    # gruppi con gli stessi estremi: tieni l'inizio più antico
    merged: list[dict] = []
    for r in cands:  # dal più recente al più vecchio
        if merged and same(merged[-1], r):
            merged[-1] = {**r, "th": max(r["th"], merged[-1]["th"]), "tl": max(r["tl"], merged[-1]["tl"])}
        else:
            merged.append(r)
    strong = [r for r in merged if r["th"] >= 2 and r["tl"] >= 2]
    primary = strong[0] if strong else max(merged, key=lambda r: (r["th"] + r["tl"], n - r["s"]))
    macro = None
    wider = [r for r in merged if r is not primary and r["s"] < primary["s"] and (r["H"] - r["L"]) > 1.25 * (primary["H"] - primary["L"])]
    if wider:
        macro = max(wider, key=lambda r: n - r["s"])
    return {"df": df, "atr": a_now, "primary": primary, "macro": macro, "piv": piv, "ph": ph, "pl": pl}


def _range_events_live(df: pd.DataFrame, H: float, L: float, s: int, a_now: float, accept: int, cool: int) -> list[dict]:
    """Eventi sul range corrente (estremi congelati) dalla sua nascita a oggi."""
    h, l, c = (df[x].to_numpy(float) for x in ("high", "low", "close"))
    n = len(df)
    out: list[dict] = []
    pen = 0.1 * a_now
    last: dict[str, int] = {}

    def push(key, i, price):
        if key.startswith(("dev", "reclaim", "failed")) and i - last.get(key, -10 ** 9) <= cool:
            return
        last[key] = i
        if key.startswith("retest_fail"):  # il rientro nel range assorbe sweep/recuperi immediatamente successivi
            for k_ in ("dev_low", "dev_high", "reclaim_low", "failed_break_high"):
                last[k_] = i
        out.append({"key": key, "i": i, "price": price})

    i = s + 1
    accepted = 0  # +1 sopra, -1 sotto
    while i < n:
        if accepted == 0:
            if c[i] > H:
                run = 1
                while i + run < n and c[i + run] > H:
                    run += 1
                if run >= accept:
                    push("accept_high", i + accept - 1, c[i + accept - 1])
                    accepted = 1
                    i += accept
                    continue
                if i + run < n:
                    push("failed_break_high", i + run, float(h[i:i + run + 1].max()))
                else:
                    push("close_above", i, c[i])
                i += run + 1
                continue
            if c[i] < L:
                run = 1
                while i + run < n and c[i + run] < L:
                    run += 1
                if run >= accept:
                    push("accept_low", i + accept - 1, c[i + accept - 1])
                    accepted = -1
                    i += accept
                    continue
                if i + run < n:
                    push("reclaim_low", i + run, float(l[i:i + run + 1].min()))
                else:
                    push("close_below", i, c[i])
                i += run + 1
                continue
            if h[i] > H + pen:
                push("dev_high", i, h[i])
            elif l[i] < L - pen:
                push("dev_low", i, l[i])
        elif accepted == 1:
            if l[i] <= H * 1.0025:
                push("retest_hold_high" if c[i] > H else "retest_fail_high", i, l[i])
                accepted = 2 if c[i] > H else 0
        elif accepted == 2:
            if c[i] <= H:
                push("retest_fail_high", i, l[i])
                accepted = 0
        elif accepted == -1:
            if h[i] >= L * 0.9975:
                push("retest_hold_low" if c[i] < L else "retest_fail_low", i, h[i])
                accepted = -2 if c[i] < L else 0
        elif accepted == -2:
            if c[i] >= L:
                push("retest_fail_low", i, h[i])
                accepted = 0
        i += 1
    return out


LIVE_LABEL = {
    "dev_high": "Deviazione sopra", "dev_low": "Deviazione sotto (sweep)", "failed_break_high": "Rottura fallita sopra",
    "reclaim_low": "Recupero del minimo", "accept_high": "Accettazione sopra", "accept_low": "Accettazione sotto",
    "retest_hold_high": "Retest tenuto sopra", "retest_fail_high": "Retest fallito sopra", "retest_hold_low": "Retest tenuto sotto",
    "retest_fail_low": "Retest fallito sotto", "close_above": "Chiusura sopra (da confermare)", "close_below": "Chiusura sotto (da confermare)",
    "sfp_high": "SFP sul massimo", "sfp_low": "SFP sul minimo", "bos_up": "BOS rialzista", "bos_down": "BOS ribassista",
    "choch_up": "CHoCH rialzista", "choch_down": "CHoCH ribassista",
}
STRUCT_PHRASE = {"bullish": "rialzista (massimi e minimi crescenti)", "bearish": "ribassista (massimi e minimi decrescenti)",
                 "neutral": "mista (nessuna sequenza ordinata di massimi e minimi)"}
TF_WORD = {"4h": "4 ore", "1d": "giornaliero", "1w": "settimanale"}
TF_CLOSE = {"4h": "chiusura a 4 ore", "1d": "chiusura giornaliera", "1w": "chiusura settimanale"}
TF_BARS_WORD = {"4h": "candele 4h", "1d": "giorni", "1w": "settimane"}


def _structure_state(df: pd.DataFrame, tf: str) -> dict:
    cfg = TF_CFG[tf]["zz"]
    h, l = df["high"].to_numpy(float), df["low"].to_numpy(float)
    a = _atr(df).to_numpy(float)
    piv = zigzag_confirmed(h, l, np.nan_to_num(a, nan=float(np.nanmean(a))), cfg)
    label_swings(piv)
    conf = [p for p in piv if p["ci"] is not None]
    lh = [p for p in conf if p["kind"] == "high"]
    ll = [p for p in conf if p["kind"] == "low"]
    lab_h = lh[-1]["label"] if lh else None
    lab_l = ll[-1]["label"] if ll else None
    if lab_h == "HH" and lab_l == "HL":
        trend, tl = "bullish", "Rialzista (HH · HL)"
    elif lab_h == "LH" and lab_l == "LL":
        trend, tl = "bearish", "Ribassista (LH · LL)"
    else:
        trend, tl = "neutral", f"Mista ({lab_h or '—'} · {lab_l or '—'})"
    swings = [{"time": df["time"].iat[p["i"]], "price": p["price"], "kind": p["kind"], "label": p.get("label"),
               "confirmed": p["ci"] is not None} for p in piv[-12:]]
    return {"trend": trend, "trend_label": tl, "swings": swings, "last_high_label": lab_h, "last_low_label": lab_l,
            "last_high": lh[-1]["price"] if lh else None, "last_low": ll[-1]["price"] if ll else None,
            "last_high_time": df["time"].iat[lh[-1]["i"]] if lh else None, "last_low_time": df["time"].iat[ll[-1]["i"]] if ll else None}


def range_state(df_full: pd.DataFrame, tf: str, price: float) -> dict:
    """Range corrente + stato + eventi recenti + struttura per un timeframe (dati Binance con candela live)."""
    det = detect_range(df_full, tf)
    struct = _structure_state(df_full.tail(1500).reset_index(drop=True), tf)
    # eventi SFP/BOS/CHoCH recenti dal motore causale (ultime ~400 barre)
    tail = df_full.tail(450).reset_index(drop=True)
    ev_tail, _ = detect_events(tail, tf)
    st_ev = [e for e in ev_tail if e["key"].startswith(("bos", "choch"))]
    if st_ev:
        le = st_ev[-1]
        up = le["key"] in ("bos_up", "choch_up")
        struct["last_event"] = {"key": le["key"], "label": LIVE_LABEL[le["key"]], "time": tail["time"].iat[le["i"]], "level": le.get("level")}
        sw = f"{struct['last_high_label'] or '—'} · {struct['last_low_label'] or '—'}"
        struct["trend"] = "bullish" if up else "bearish"
        consistent = (struct["last_high_label"], struct["last_low_label"]) == (("HH", "HL") if up else ("LH", "LL"))
        struct["trend_label"] = f"{'Rialzista' if up else 'Ribassista'} ({sw})" if consistent else f"{'Rialzista' if up else 'Ribassista'} dopo {'CHoCH' if le['key'].startswith('choch') else 'BOS'} ({sw})"
    else:
        struct["last_event"] = None
    lookback = {"4h": 120, "1d": 75, "1w": 60}[tf]
    recent_struct = [e for e in ev_tail if e["key"].startswith(("sfp", "bos", "choch")) and e["i"] >= len(tail) - lookback]
    out = {"tf": tf, "price": price, "structure": struct, "range": None, "macro_range": None, "events": [], "state": None,
           "state_label": "Nessun range", "text": "", "key_levels": []}
    events = []
    for e in recent_struct[-8:]:
        lvl = e.get("level")
        events.append({"key": e["key"], "label": LIVE_LABEL[e["key"]], "time": tail["time"].iat[e["i"]],
                       "price": float(lvl if lvl is not None else tail["close"].iat[e["i"]]),
                       "kind": "structure" if e["key"].startswith(("bos", "choch")) else "sfp"})
    if det is None:
        out["events"] = sorted(events, key=lambda x: x["time"])
        for k_, e in enumerate(out["events"]):
            e["n"] = k_ + 1
        out["text"] = f"Sul {TF_WORD[tf]} non è riconoscibile un range con almeno tre tocchi: il prezzo è in fase direzionale. Struttura di mercato {STRUCT_PHRASE[struct['trend']]}."
        return out
    d = det["df"]
    a_now = det["atr"]
    P = det["primary"]
    H, L = P["H"], P["L"]
    W = H - L
    M = (H + L) / 2
    s = P["s"]
    accept = RANGE_CFG[tf]["accept"]
    live_ev = _range_events_live(d, H, L, s, a_now, accept, RANGE_CFG[tf]["cool"])
    bar_s = {"4h": 14400, "1d": 86400, "1w": 604800}[tf]
    rng_ev = [{"key": e["key"], "label": LIVE_LABEL[e["key"]], "time": d["time"].iat[e["i"]], "price": float(e["price"]), "kind": "range"} for e in live_ev]
    # SFP che coincidono con uno sweep del range (stessa zona, ±2 barre) sono già rappresentati dall'evento di range
    events = [e for e in events if not (e["kind"] == "sfp" and any(
        abs((e["time"] - r["time"]).total_seconds()) <= 2 * bar_s and abs(e["price"] / r["price"] - 1) < 0.02 for r in rng_ev))]
    events = sorted(events + rng_ev, key=lambda x: x["time"])[-12:]
    for k_, e in enumerate(events):
        e["n"] = k_ + 1
    c = d["close"].to_numpy(float)
    last_c = float(c[-1])
    pos = (price - L) / W * 100
    # stato
    last_range_ev = live_ev[-1] if live_ev else None
    tail_ = P["tail"]
    if tail_ >= accept or (last_range_ev and last_range_ev["key"] in ("accept_high", "retest_hold_high") and price > H):
        state = "accepted_above"
        lab = "Accettazione sopra il range"
        if last_range_ev and last_range_ev["key"] == "retest_hold_high":
            state, lab = "retest_held_above", "Retest del massimo tenuto"
    elif tail_ <= -accept or (last_range_ev and last_range_ev["key"] in ("accept_low", "retest_hold_low") and price < L):
        state = "accepted_below"
        lab = "Accettazione sotto il range"
        if last_range_ev and last_range_ev["key"] == "retest_hold_low":
            state, lab = "retest_held_below", "Retest del minimo perso"
    elif tail_ > 0 or price > H:
        state, lab = "above_unconfirmed", "Sopra il range, accettazione da confermare"
    elif tail_ < 0 or price < L:
        state, lab = "below_unconfirmed", "Sotto il range, accettazione da confermare"
    else:
        state = "inside"
        lab = "Dentro il range"
        recent = [e for e in live_ev if e["i"] >= len(d) - max(6, RANGE_CFG[tf]["min_bars"])]
        if recent:
            k = recent[-1]["key"]
            if k in ("dev_low", "reclaim_low"):
                state, lab = "inside_after_sweep_low", "Dentro il range dopo uno sweep del minimo"
            elif k in ("dev_high", "failed_break_high"):
                state, lab = "inside_after_sweep_high", "Dentro il range dopo uno sweep del massimo"
            elif k in ("retest_fail_high", "retest_fail_low"):
                state, lab = "inside_after_failed_breakout", "Rientrato nel range dopo una rottura fallita"
    t_start = d["time"].iat[s]
    dur = len(d) - s
    unit = TF_BARS_WORD[tf]
    dur_days = (d["time"].iat[-1] - t_start).total_seconds() / 86400
    half = "metà superiore" if pos >= 50 else "metà inferiore"
    sweeps_lo = [e for e in live_ev if e["key"] in ("dev_low", "reclaim_low")]
    sweeps_hi = [e for e in live_ev if e["key"] in ("dev_high", "failed_break_high")]
    rng_txt = (f"range {usd(L)}–{usd(H)} (ampiezza {pc(W / L * 100, 1, False)}, metà {usd(M)}), iniziato il {dit(t_start)} "
               f"({dur} {unit}), con {P['th']} tocchi sul massimo e {P['tl']} sul minimo")
    if state.startswith("inside"):
        parts = [f"Sul {TF_WORD[tf]} il prezzo si muove in un {rng_txt}."]
    elif state in ("accepted_above", "retest_held_above", "above_unconfirmed"):
        parts = [f"Sul {TF_WORD[tf]} il prezzo è sopra il {rng_txt}."]
    else:
        parts = [f"Sul {TF_WORD[tf]} il prezzo è sotto il {rng_txt}."]
    if state.startswith("inside"):
        parts.append(f"Il prezzo è nella {half} ({pos:.0f}% dell'ampiezza).")
    if sweeps_lo:
        e = sweeps_lo[-1]
        parts.append(f"Ultimo sweep del minimo il {dit_short(d['time'].iat[e['i']])} fino a {usd(e['price'])}, poi chiusura di nuovo dentro: "
                     "la liquidità sotto il range è stata presa e il livello difeso.")
    if sweeps_hi:
        e = sweeps_hi[-1]
        parts.append(f"Ultima deviazione sopra il {dit_short(d['time'].iat[e['i']])} fino a {usd(e['price'])}, senza accettazione.")
    if state in ("accepted_above", "retest_held_above"):
        parts.append(f"Il massimo {usd(H)} è stato accettato con {TF_CLOSE[tf]}: finché il retest tiene sopra {usd(H)} l'integrità strutturale della rottura resta valida; "
                     f"il measured move (1× ampiezza) punta a {usd(H + W)}.")
    if state in ("accepted_below", "retest_held_below"):
        parts.append(f"Il minimo {usd(L)} è stato perso con accettazione: un ritorno sopra {usd(L)} con {TF_CLOSE[tf]} invaliderebbe la rottura; "
                     f"il measured move punta a {usd(L - W)}.")
    if state == "above_unconfirmed":
        parts.append(f"Serve una seconda {TF_CLOSE[tf]} sopra {usd(H)} per parlare di accettazione; un rientro sotto il massimo la trasformerebbe in deviazione.")
    if state == "below_unconfirmed":
        parts.append(f"Serve una seconda {TF_CLOSE[tf]} sotto {usd(L)} per l'accettazione; un rientro sopra il minimo la trasformerebbe in sweep/recupero.")
    le = struct.get("last_event")
    if le:
        parts.append(f"Struttura di mercato {'rialzista' if struct['trend'] == 'bullish' else 'ribassista'}: ultimo evento {le['label']} "
                     f"il {dit_short(le['time'])} (livello {usd(le['level'])}); swing confermati {struct['trend_label'].split('(')[-1].rstrip(')')}.")
    else:
        parts.append(f"Struttura di mercato {STRUCT_PHRASE[struct['trend']]}.")
    key_levels = [
        {"label": "Massimo del range", "price": H, "kind": "range_high"},
        {"label": "Metà range (equilibrio)", "price": M, "kind": "range_mid"},
        {"label": "Minimo del range", "price": L, "kind": "range_low"},
    ]
    if sweeps_lo:
        key_levels.append({"label": "Estremo dello sweep sotto", "price": float(min(e["price"] for e in sweeps_lo)), "kind": "sweep_low"})
    if sweeps_hi:
        key_levels.append({"label": "Estremo della deviazione sopra", "price": float(max(e["price"] for e in sweeps_hi)), "kind": "sweep_high"})
    if state in ("accepted_above", "retest_held_above"):
        key_levels.append({"label": "Measured move (+1× ampiezza)", "price": H + W, "kind": "target"})
    if state in ("accepted_below", "retest_held_below"):
        key_levels.append({"label": "Measured move (−1× ampiezza)", "price": L - W, "kind": "target"})
    def _dup(p_):
        return any(abs(p_ / k_["price"] - 1) < 0.002 for k_ in key_levels)
    if struct["last_high"] and not _dup(struct["last_high"]):
        key_levels.append({"label": "Ultimo swing high", "price": struct["last_high"], "kind": "swing_high"})
    if struct["last_low"] and not _dup(struct["last_low"]):
        key_levels.append({"label": "Ultimo swing low", "price": struct["last_low"], "kind": "swing_low"})
    for k_ in key_levels:
        k_["distance"] = _r((k_["price"] / price - 1) * 100)
    key_levels.sort(key=lambda x: -x["price"])
    out.update({
        "range": {"high": H, "low": L, "mid": M, "start": t_start, "end": d["time"].iat[-1], "bars": dur, "days": _r(dur_days, 1),
                  "touches_high": P["th"], "touches_low": P["tl"], "width_pct": _r(W / L * 100), "width_atr": _r(W / a_now, 1),
                  "position": _r(pos, 1), "containment": _r(P["inside"] * 100, 1),
                  "touch_points": [{"time": d["time"].iat[i], "price": float(p), "kind": "high"} for i, p in P["hi_pts"]]
                  + [{"time": d["time"].iat[i], "price": float(p), "kind": "low"} for i, p in P["lo_pts"]]},
        "macro_range": ({"high": det["macro"]["H"], "low": det["macro"]["L"], "mid": (det["macro"]["H"] + det["macro"]["L"]) / 2,
                         "start": d["time"].iat[det["macro"]["s"]], "bars": len(d) - det["macro"]["s"],
                         "touches_high": det["macro"]["th"], "touches_low": det["macro"]["tl"],
                         "width_pct": _r((det["macro"]["H"] / det["macro"]["L"] - 1) * 100)} if det["macro"] else None),
        "events": events, "state": state, "state_label": lab, "text": " ".join(parts), "key_levels": key_levels,
        "atr": a_now, "last_close": last_c,
    })
    return out
