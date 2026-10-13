"""Analisi avanzata dei cicli (pura computazione, nessun I/O).

1. Orologio del ciclo: Cycle Score composito 0–100 senza lookahead (percentili a finestra espandente,
   pesi walk-forward stimati solo sugli eventi di ciclo già noti a quella data).
2. Ciclo dei miner: Hash Ribbons, Difficulty Ribbon (difficoltà approssimata dall'hashrate), drawdown hashrate, Puell.
3. Confronto "stesso giorno del ciclo" + analisi di sopravvivenza delle durate.
4. Ciclo della leva: funding / rapporto volumi perp-spot / OI per fase di ciclo.
"""
from __future__ import annotations

import bisect
import math

import numpy as np
import pandas as pd

from . import cycles as cy

DAY = pd.Timedelta(days=1)
MIN_HIST = 200            # giorni minimi di storia prima di calcolare un percentile
SMOOTH_SPAN = 7           # EMA (causale) applicata allo score combinato
PRIOR_TOP_OFF = 500       # prior "modello a 4 anni": massimo ~16 mesi dopo l'halving
PRIOR_BOTTOM_OFF = 900    # minimo ~30 mesi dopo l'halving
CYCLE_DAYS = 1458         # durata media di un'epoca di halving (210k blocchi)

COMPONENTS = [
    # key, label, descrizione
    ("pi", "Pi Cycle", "Distanza tra SMA 111 e 2×SMA 350 (log): vicino allo zero = rischio di massimo"),
    ("mvrv_z", "MVRV Z-Score", "Capitalizzazione di mercato vs realizzata, in deviazioni standard"),
    ("nupl", "NUPL", "Profitto/perdita netti non realizzati della rete"),
    ("puell", "Puell Multiple", "Ricavi giornalieri dei miner vs media annua (log)"),
    ("mayer", "Mayer Multiple", "Prezzo / SMA 200 giorni (log)"),
    ("power_law", "Residuo Power Law", "Scostamento dal fair value power law ricalcolato ogni 30 giorni solo sui dati disponibili"),
    ("ma2y", "Moltiplicatore MA 2 anni", "Posizione del prezzo tra MA 2 anni (×1) e MA 2 anni ×5 (log)"),
    ("drawdown", "Distanza dall'ATH", "Drawdown dal massimo storico: 0% = sui massimi"),
    ("halving", "Fase dall'halving", "Giorni dall'halving vs tempi tipici di massimo e minimo dei cicli già conclusi"),
]
COMP_KEYS = [c[0] for c in COMPONENTS]

ZONES = [  # (soglia superiore esclusa, chiave, etichetta)
    (20, "bottom", "zona di minimo"),
    (40, "accumulation", "accumulo"),
    (60, "mid", "metà ciclo"),
    (80, "euphoria", "euforia"),
    (101, "top", "zona di massimo"),
]


def zone_of(v: float | None) -> tuple[str | None, str | None]:
    if v is None or not np.isfinite(v):
        return None, None
    for hi, k, lbl in ZONES:
        if v < hi:
            return k, lbl
    return ZONES[-1][1], ZONES[-1][2]


# ------------------------------------------------------------------ utilità

def expanding_pct(x: np.ndarray, min_n: int = MIN_HIST) -> tuple[np.ndarray, list[float]]:
    """Percentile (0..100, mid-rank) di ogni valore rispetto a TUTTA la storia fino a quel giorno incluso."""
    out = np.full(len(x), np.nan)
    hist: list[float] = []
    for i, v in enumerate(x):
        if not np.isfinite(v):
            continue
        bisect.insort(hist, float(v))
        n = len(hist)
        if n >= min_n:
            lo, hi = bisect.bisect_left(hist, v), bisect.bisect_right(hist, v)
            out[i] = (lo + hi) / 2 / n * 100
    return out, hist


def pct_in(hist: list[float], v: float) -> float | None:
    if not hist or v is None or not np.isfinite(v):
        return None
    lo, hi = bisect.bisect_left(hist, v), bisect.bisect_right(hist, v)
    return (lo + hi + 1) / 2 / (len(hist) + 1) * 100


def walk_forward_power_law(close: pd.Series, refit_days: int = 30) -> pd.Series:
    """Residuo log10(prezzo / fair) dove il fair è stimato SOLO con i dati fino all'ultimo refit."""
    s = close[close.index >= pd.Timestamp("2010-07-18", tz="UTC")].dropna()
    x_all = np.log10(cy.days_since_genesis(s.index))
    y_all = np.log10(s.values)
    out = np.full(len(s), np.nan)
    start = 365
    i = start
    while i < len(s):
        b, a = np.polyfit(x_all[:i], y_all[:i], 1)
        j = min(i + refit_days, len(s))
        out[i:j] = y_all[i:j] - (a + b * x_all[i:j])
        i = j
    return pd.Series(out, index=s.index).reindex(close.index)


def halving_phase_value(days: float, top_off: float, bottom_off: float) -> float:
    """0..100: sale da 50 (halving) a 100 al massimo tipico, scende a 0 al minimo tipico, risale a 50 al prossimo halving."""
    if not np.isfinite(days) or days < 0:
        return float("nan")
    d = days % CYCLE_DAYS
    if d <= top_off:
        return 50 + 50 * d / top_off
    if d <= bottom_off:
        return 100 - 100 * (d - top_off) / (bottom_off - top_off)
    return 50 * (d - bottom_off) / (CYCLE_DAYS - bottom_off)


def _sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


# ------------------------------------------------------------------ frame

def build_frame(df: pd.DataFrame, oc: pd.DataFrame) -> pd.DataFrame:
    """Unisce prezzo giornaliero (cycles.merged_daily) e metriche on-chain derivate (onchain.derive)."""
    f = df[["close", "high", "low"]].copy()
    o = oc.reindex(f.index).ffill(limit=3)
    for c in ["mvrv", "mvrv_z", "nupl", "puell", "hashrate", "issuance_usd", "supply", "realized_cap"]:
        f[c] = o[c] if c in o else np.nan
    return f


def raw_components(f: pd.DataFrame, events: dict) -> tuple[pd.DataFrame, dict]:
    close = f["close"]
    s111, s350, s200, s730 = _sma(close, 111), _sma(close, 350), _sma(close, 200), _sma(close, 730)
    raw = pd.DataFrame(index=f.index)
    raw["pi"] = np.log(s111 / (2 * s350))
    raw["mvrv_z"] = f["mvrv_z"]
    raw["nupl"] = f["nupl"]
    raw["puell"] = np.log(f["puell"].where(f["puell"] > 0))
    raw["mayer"] = np.log(close / s200)
    raw["power_law"] = walk_forward_power_law(close)
    raw["ma2y"] = np.log(close / s730) / math.log(5)
    raw["drawdown"] = close / close.cummax() - 1

    # fase dall'halving: offset tipici stimati walk-forward sui cicli già conclusi
    halv = [t for _, t, _ in cy.HALVINGS]
    hv = np.full(len(f), np.nan)
    known = []  # (known_at, kind, offset)
    for h in halv:
        top = next((t for t in events["tops"] if t > h), None)
        if top is not None and (len(halv) == halv.index(h) + 1 or top < halv[halv.index(h) + 1]):
            known.append((top + 365 * DAY, "top", (top - h).days))
        bot = next((b for b in events["bottoms"] if top is not None and b > top), None)
        if bot is not None:
            kb = events["known_bottom"].get(bot, bot + 180 * DAY)
            known.append((kb, "bottom", (bot - h).days))
    idx = f.index
    hi_arr = np.searchsorted(np.array([h.value for h in halv]), idx.asi8, side="right") - 1
    offsets_cache: dict = {}
    for i, t in enumerate(idx):
        k = hi_arr[i]
        if k < 0:
            continue
        tops_k = [o for ka, kind, o in known if kind == "top" and ka <= t]
        bots_k = [o for ka, kind, o in known if kind == "bottom" and ka <= t]
        key = (len(tops_k), len(bots_k))
        if key not in offsets_cache:
            to = float(np.mean(tops_k)) if tops_k else PRIOR_TOP_OFF
            bo = float(np.mean(bots_k)) if bots_k else PRIOR_BOTTOM_OFF
            offsets_cache[key] = (to, max(bo, to + 120))
        to, bo = offsets_cache[key]
        hv[i] = halving_phase_value((t - halv[k]).days, to, bo)
    raw["halving"] = hv
    raw = raw.replace([np.inf, -np.inf], np.nan)
    last_offsets = offsets_cache.get(max(offsets_cache) if offsets_cache else None, (PRIOR_TOP_OFF, PRIOR_BOTTOM_OFF))
    return raw, {"s111": s111, "s350": s350, "s200": s200, "s730": s730, "halving_offsets": last_offsets}


def detect_events(df: pd.DataFrame, cycles_out: list[dict], probable_bottom: dict | None) -> dict:
    """Massimi/minimi di ciclo (da routers.cycles) + quando sarebbero stati 'noti' (per il walk-forward)."""
    tops = [pd.Timestamp(c["top"]["time"], unit="s", tz="UTC") for c in cycles_out if c.get("top")]
    bottoms = [pd.Timestamp(c["bottom"]["time"], unit="s", tz="UTC") for c in cycles_out]
    # massimo del 2011 (precede il primo minimo rilevato)
    first = cy.detect_tops(df)
    tops = sorted(set([t for t in first if not bottoms or t < bottoms[0]] + tops))
    prob = None
    if probable_bottom:
        prob = pd.Timestamp(probable_bottom["time"], unit="s", tz="UTC")
    close = df["close"]
    known_bottom = {}
    for b in bottoms + ([prob] if prob is not None else []):
        p0 = float(df["low"].loc[b])
        after = close.loc[b + 180 * DAY:]
        hit = after[after >= 2 * p0]
        known_bottom[b] = hit.index[0] if len(hit) else b + 400 * DAY
    return {"tops": tops, "bottoms": bottoms, "probable_bottom": prob, "known_bottom": known_bottom}


def combine(pcts: pd.DataFrame, events: dict) -> tuple[pd.Series, pd.Series, list[dict]]:
    """Score equal-weight e score con pesi walk-forward (separazione massimi vs minimi già noti)."""
    K = len(COMP_KEYS)
    avail = pcts.notna()
    eq = (pcts.sum(axis=1) / avail.sum(axis=1)).where(avail.sum(axis=1) >= 3)

    # eventi con la data in cui diventano noti
    ev = [(t + 365 * DAY, "top", t) for t in events["tops"]]
    ev += [(events["known_bottom"].get(b, b + 180 * DAY), "bottom", b) for b in events["bottoms"]]
    ev.sort(key=lambda x: x[0])
    weights_hist = []
    w = pd.DataFrame(1.0, index=pcts.index, columns=COMP_KEYS)
    for k, (known_at, _, _) in enumerate(ev):
        known = [e for e in ev[: k + 1]]
        tops_k = [e[2] for e in known if e[1] == "top"]
        bots_k = [e[2] for e in known if e[1] == "bottom"]
        if not tops_k or not bots_k:
            continue
        seps = {}
        for c in COMP_KEYS:
            tv = [pcts[c].loc[t - 30 * DAY: t + 7 * DAY].mean() for t in tops_k]
            bv = [pcts[c].loc[b - 30 * DAY: b + 30 * DAY].mean() for b in bots_k]
            tv, bv = [x for x in tv if np.isfinite(x)], [x for x in bv if np.isfinite(x)]
            seps[c] = (np.mean(tv) - np.mean(bv)) if tv and bv else np.nan
        pos = {c: max(s, 0.0) ** 2 if np.isfinite(s) else 0.0 for c, s in seps.items()}
        tot = sum(pos.values())
        wk = {c: 0.5 / K + (0.5 * pos[c] / tot if tot > 0 else 0.5 / K) for c in COMP_KEYS}
        w.loc[known_at:, :] = [wk[c] for c in COMP_KEYS]
        weights_hist.append({"from": known_at, "events": len(known), "weights": wk,
                             "separation": {c: (None if not np.isfinite(s) else s) for c, s in seps.items()}})
    wv = w.where(avail, 0.0)
    wf = ((pcts.fillna(0) * wv).sum(axis=1) / wv.sum(axis=1)).where(avail.sum(axis=1) >= 3)
    eq = eq.ewm(span=SMOOTH_SPAN, adjust=False, ignore_na=True).mean().where(eq.notna())
    wf = wf.ewm(span=SMOOTH_SPAN, adjust=False, ignore_na=True).mean().where(wf.notna())
    return eq, wf, weights_hist


def episodes(score: pd.Series, thr: float, above: bool, gap_days: int = 30) -> list[tuple[pd.Timestamp, pd.Timestamp, float]]:
    s = score.dropna()
    m = s >= thr if above else s <= thr
    eps: list[list] = []
    for t in s.index[m.values]:
        v = float(s.loc[t])
        if eps and (t - eps[-1][1]).days <= gap_days:
            eps[-1][1] = t
            eps[-1][2] = max(eps[-1][2], v) if above else min(eps[-1][2], v)
        else:
            eps.append([t, t, v])
    return [tuple(e) for e in eps]


def backtest(score: pd.Series, events: dict, now: pd.Timestamp) -> dict:
    s = score.dropna()
    rows = []

    def first_cross(lo, hi, thr, above):
        seg = s.loc[lo:hi]
        hit = seg[seg >= thr] if above else seg[seg <= thr]
        return hit.index[0] if len(hit) else None

    for kind, ts_list in (("top", events["tops"]), ("bottom", events["bottoms"] + ([events["probable_bottom"]] if events["probable_bottom"] is not None else []))):
        for t in ts_list:
            if t < s.index[0]:
                continue
            v = float(s.loc[:t].iloc[-1]) if len(s.loc[:t]) else None
            win = s.loc[t - 30 * DAY: t + 30 * DAY]
            ext = float(win.max() if kind == "top" else win.min()) if len(win) else None
            thr = (80, 90) if kind == "top" else (20, 10)
            leads = []
            for th in thr:
                c = first_cross(t - 365 * DAY, t, th, kind == "top")
                leads.append((t - c).days if c is not None else None)
            pre = s.loc[t - 365 * DAY: t + 30 * DAY]
            pk = (pre.idxmax() if kind == "top" else pre.idxmin()) if len(pre) else None
            rows.append({"kind": kind, "time": t, "score": v, "extreme_30d": ext,
                         "extreme_365": float(pre.loc[pk]) if pk is not None else None, "extreme_365_time": pk,
                         "lead_1": leads[0], "lead_2": leads[1], "thresholds": list(thr),
                         "probable": kind == "bottom" and t == events["probable_bottom"]})
    rows.sort(key=lambda r: r["time"])

    sig = []
    for thr, above in ((80, True), (90, True), (20, False), (10, False)):
        evs = events["tops"] if above else events["bottoms"] + ([events["probable_bottom"]] if events["probable_bottom"] is not None else [])
        eps = episodes(s, thr, above)
        items, true_n, false_n, pending = [], 0, 0, 0
        for a, b, ext in eps:
            match = next((e for e in evs if a - 60 * DAY <= e <= a + 365 * DAY), None)
            if match is not None:
                status = "vero"
                true_n += 1
            elif a + 365 * DAY > now:
                status = "in_corso"
                pending += 1
            else:
                status = "falso"
                false_n += 1
            items.append({"start": a, "end": b, "days": (b - a).days + 1, "extreme": ext, "status": status,
                          "event": match, "lead": (match - a).days if match is not None else None})
        sig.append({"threshold": thr, "direction": "above" if above else "below", "episodes": len(eps),
                    "true": true_n, "false": false_n, "pending": pending, "items": items})
    tops_sc = [r["score"] for r in rows if r["kind"] == "top" and r["score"] is not None]
    bots_sc = [r["score"] for r in rows if r["kind"] == "bottom" and r["score"] is not None]
    return {"events": rows, "signals": sig,
            "mean_at_tops": float(np.mean(tops_sc)) if tops_sc else None,
            "mean_at_bottoms": float(np.mean(bots_sc)) if bots_sc else None}


# ------------------------------------------------------------------ miner

RIBBON = [9, 14, 25, 40, 60, 90, 128, 200]


def miner_frame(f: pd.DataFrame) -> pd.DataFrame:
    hr = f["hashrate"]
    m = pd.DataFrame(index=f.index)
    m["hashrate"] = hr
    m["sma30"] = hr.rolling(30, min_periods=25).mean()
    m["sma60"] = hr.rolling(60, min_periods=50).mean()
    hr7 = hr.rolling(7, min_periods=5).mean()
    m["hr_drawdown"] = (hr7 / hr7.cummax() - 1) * 100
    diff = hr.rolling(14, min_periods=10).mean()  # ~2016 blocchi: proxy della difficoltà
    m["difficulty"] = diff
    smas = pd.concat([diff.rolling(n, min_periods=n).mean().rename(f"rb{n}") for n in RIBBON], axis=1)
    m["ribbon_compression"] = (smas.max(axis=1) / smas.min(axis=1) - 1) * 100
    m["ribbon_inverted"] = smas.iloc[:, 0] < smas.iloc[:, -1]
    for n in RIBBON:
        m[f"rb{n}"] = smas[f"rb{n}"]
    m["puell"] = f["puell"]
    m["issuance_usd"] = f["issuance_usd"]
    m["close"] = f["close"]
    m["p10"] = f["close"].rolling(10).mean()
    m["p20"] = f["close"].rolling(20).mean()
    return m


def hash_ribbon_signals(m: pd.DataFrame, min_cap_days: int = 7) -> list[dict]:
    cap = (m["sma30"] < m["sma60"]).fillna(False)
    close = m["close"]
    out = []
    start = None
    idx = m.index
    for i in range(1, len(idx)):
        if cap.iloc[i] and not cap.iloc[i - 1]:
            start = idx[i]
        if not cap.iloc[i] and cap.iloc[i - 1] and start is not None:
            dur = (idx[i] - start).days
            if dur >= min_cap_days:
                t = idx[i]
                # variante con conferma momentum: prima chiusura con SMA10 prezzo > SMA20 entro 90 giorni
                seg = m.loc[t: t + 90 * DAY]
                ok = seg[seg["p10"] > seg["p20"]]
                tm = ok.index[0] if len(ok) else None
                out.append({"time": t, "cap_start": start, "cap_days": dur,
                            "hr_drawdown": float(m["hr_drawdown"].loc[start:t].min()),
                            "price": float(close.loc[t]),
                            "ret": fwd_returns(close, t), "momentum_time": tm,
                            "momentum_ret": fwd_returns(close, tm) if tm is not None else {}})
            start = None
    return out


def fwd_returns(close: pd.Series, t, horizons=(30, 90, 180)) -> dict:
    out = {}
    if t is None:
        return out
    p0 = float(close.loc[t])
    for h in horizons:
        t1 = t + h * DAY
        out[str(h)] = (float(close.loc[:t1].iloc[-1]) / p0 - 1) * 100 if t1 <= close.index[-1] else None
    return out


def hit_stats(sigs: list[dict], key: str, close: pd.Series) -> list[dict]:
    rows = []
    lr = np.log(close)
    for h in ("30", "90", "180"):
        vals = [s[key].get(h) for s in sigs if s[key].get(h) is not None]
        base = (np.exp(lr.shift(-int(h)) - lr) - 1).dropna() * 100
        base = base[base.index >= pd.Timestamp("2011-01-01", tz="UTC")]
        rows.append({"horizon": int(h), "n": len(vals),
                     "hit_rate": float(np.mean([v > 0 for v in vals]) * 100) if vals else None,
                     "avg": float(np.mean(vals)) if vals else None, "median": float(np.median(vals)) if vals else None,
                     "base_hit_rate": float((base > 0).mean() * 100), "base_median": float(base.median())})
    return rows


# ------------------------------------------------------------------ durate / sopravvivenza

def km_survival(samples: list[float], censored: list[float] | None = None) -> list[tuple[float, float]]:
    """Kaplan-Meier: [(t, S(t))] a gradini."""
    data = sorted([(x, 1) for x in samples] + [(x, 0) for x in (censored or [])])
    n = len(data)
    s = 1.0
    out = [(0.0, 1.0)]
    i = 0
    while i < n:
        t = data[i][0]
        d = sum(1 for x in data if x[0] == t and x[1] == 1)
        c = sum(1 for x in data if x[0] == t)
        at_risk = n - i
        if d:
            s *= 1 - d / at_risk
            out.append((t, s))
        i += c
    return out


def km_at(curve: list[tuple[float, float]], t: float) -> float:
    s = 1.0
    for x, v in curve:
        if x <= t:
            s = v
    return s


def lognorm_sf(samples: list[float], t: float) -> float | None:
    if len(samples) < 2:
        return None
    lg = np.log(samples)
    mu, sd = float(lg.mean()), float(max(lg.std(ddof=1), 0.08))
    if t <= 0:
        return 1.0
    z = (math.log(t) - mu) / sd
    return 0.5 * math.erfc(z / math.sqrt(2))


# ------------------------------------------------------------------ fasi storiche

PHASE_IT = {"accumulation": "Accumulo", "bull": "Mercato rialzista", "distribution": "Distribuzione", "bear": "Mercato ribassista"}


def phase_history(index: pd.DatetimeIndex, events: dict, current_phase: str) -> pd.Series:
    """Etichetta di fase per ogni giorno (definizione deterministica, documentata in `method`):
    accumulo = primo 25% del tratto minimo→massimo; rialzo = fino a 60 g prima del massimo;
    distribuzione = ±60 g attorno al massimo; ribasso = fino al minimo successivo.
    Nel ciclo in corso dopo il minimo probabile: accumulo, poi la fase corrente stimata da /api/cycles."""
    ph = pd.Series(index=index, dtype=object)
    tops = events["tops"]
    bottoms = list(events["bottoms"])
    if events["probable_bottom"] is not None:
        bottoms.append(events["probable_bottom"])
    for b in bottoms:
        t = next((x for x in tops if x > b), None)
        nb = next((x for x in bottoms if x > b), None)
        if t is None:
            end = nb or index[-1] + DAY
            span_ = (end - b).days
            ph.loc[b: b + max(span_, 0) * DAY] = "accumulation"
            if current_phase in ("bull", "distribution") and (index[-1] - b).days > 120:
                ph.loc[b + 120 * DAY:] = current_phase
            continue
        acc_end = b + (t - b) * 0.25
        ph.loc[b:acc_end] = "accumulation"
        ph.loc[acc_end:t - 60 * DAY] = "bull"
        ph.loc[t - 60 * DAY: t + 60 * DAY] = "distribution"
        if nb is not None:
            ph.loc[t + 60 * DAY: nb - DAY] = "bear"
        else:
            ph.loc[t + 60 * DAY:] = "bear"
    # prima del primo minimo
    if tops and bottoms:
        t0 = tops[0]
        ph.loc[:t0 - 60 * DAY] = ph.loc[:t0 - 60 * DAY].fillna("bull")
        ph.loc[t0 - 60 * DAY: t0 + 60 * DAY] = ph.loc[t0 - 60 * DAY: t0 + 60 * DAY].fillna("distribution")
        ph.loc[t0 + 60 * DAY: bottoms[0]] = ph.loc[t0 + 60 * DAY: bottoms[0]].fillna("bear")
    return ph
