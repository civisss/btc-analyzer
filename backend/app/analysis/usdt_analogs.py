"""Analoghi VISIVI della USDT dominance ("frattali" storici della USDT.D) e cosa fece BTC dopo.

Riusa il motore grafico di `analogs_visual` / `analogs` trattando la USDT.D come serie di sole chiusure:
  - candidati per forma: correlazione di Pearson + DTW con banda sul log(USDT.D) z-normalizzato;
  - re-rank visivo: forma, gambe ZigZag allineate, figure grafiche + trendline, inviluppo di volatilità
    (OHLC sintetico: open = chiusura precedente, high/low = max/min tra le due). Geometria delle candele e
    volumi non sono applicabili (componenti nulle, pesi rinormalizzati con `vis.combine`);
  - contesto (20%): livello della USDT.D, variazione nella finestra, RSI della USDT.D, variazione di BTC, specchio;
  - per ogni analogo: gambe, figure sulla USDT.D, punti strutturali, esito di BTC (variazione, max/min,
    percorso riscalato sul prezzo di oggi) e percorso della USDT.D dopo.
Inoltre: relazione "a specchio" BTC vs USDT.D invertita (rottura dello specchio), tecnica sulla USDT.D
(RSI, EMA 50/200, zone di rifiuto e reazione storica di BTC) e stima intraday 4H della USDT.D.
"""
from __future__ import annotations

import logging
import math
import time

import numpy as np
import pandas as pd

from .. import util
from ..data import store
from . import analogs as an
from . import analogs_visual as vis
from . import fractals as fr
from . import stablecoins as sc

log = logging.getLogger("usdt_analogs")

TFS = ("1d", "4h")
STEP = {"1d": 86400, "4h": 14400}
UNIT = {"1d": "giorni", "4h": "candele 4H"}


def _next(h: int, tf: str) -> str:
    return f"nei {h} giorni successivi" if tf == "1d" else f"nelle {h} candele 4H successive"
SEARCH_FROM = pd.Timestamp("2018-01-01", tz="UTC")
N_PREFILTER = 150
N_RERANK = 60
W_VISUAL = 0.80
MIRROR_WIN = 30
BREAK_K = 0.15   # soglia (in deviazioni standard delle variazioni a 7 giorni) per una "rottura dello specchio"


# ================================================================== dati

def _secs(s) -> np.ndarray:
    s = pd.to_datetime(pd.Series(s), utc=True).astype("datetime64[ns, UTC]")
    return ((s - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(dtype=np.int64)


@util.ttl_cache(60)
def frame_4h() -> pd.DataFrame:
    """Stima 4H della USDT.D.

    - mcap USDT: interpolata linearmente tra le chiusure giornaliere (cambia lentamente);
    - resto del mercato (cap totale − USDT): valore di fine giornata precedente scalato con le variazioni intraday di
      BTC (peso = quota di BTC) e di ETH (peso = resto, proxy delle altcoin).
    """
    d = sc.daily_frame()
    b = store.get("k_4h")[["time", "close"]].rename(columns={"close": "btc"})
    e = store.get("eth_4h")[["time", "close"]].rename(columns={"close": "eth"})
    df = b.merge(e, on="time", how="inner").sort_values("time").reset_index(drop=True)
    p = sc.live_price()
    if p and len(df) and 0.8 < p / float(df["btc"].iloc[-1]) < 1.25:
        df.loc[df.index[-1], "btc"] = p
    df["day"] = df["time"].dt.normalize()
    dd = d.set_index("time")
    X = dd["total"] - dd["usdt"]
    share = (dd["btc_cap"] / X).clip(0, 1)
    prev = df["day"] - pd.Timedelta(days=1)
    df["X0"] = X.reindex(prev).to_numpy()
    df["sh"] = share.reindex(prev).to_numpy()
    cb = df.set_index("time")["btc"]
    ce = df.set_index("time")["eth"]
    ref_t = df["day"] - pd.Timedelta(hours=4)          # ultima candela del giorno precedente
    df["b0"] = cb.reindex(ref_t).to_numpy()
    df["e0"] = ce.reindex(ref_t).to_numpy()
    close_s = _secs(df["time"]) + 4 * 3600
    eod = _secs(d["time"]) + 86400                      # valori giornalieri = fine giornata
    df["usdt"] = np.interp(close_s, eod, d["usdt"].to_numpy(float))
    Xt = df["X0"] * (df["sh"] * df["btc"] / df["b0"] + (1 - df["sh"]) * df["eth"] / df["e0"])
    df["usdt_d"] = df["usdt"] / (df["usdt"] + Xt) * 100
    df = df.dropna(subset=["usdt_d"])
    df = df[df["time"] >= SEARCH_FROM]
    return df[["time", "btc", "usdt_d", "usdt"]].reset_index(drop=True)


def _series(tf: str) -> dict:
    if tf == "4h":
        df = frame_4h()
    else:
        df = sc.daily_frame()
        df = df[df["time"] >= SEARCH_FROM]
    df = df.reset_index(drop=True)
    u = df["usdt_d"].to_numpy(float)
    o = np.r_[u[0], u[:-1]]
    return {"time": _secs(df["time"]), "u": u, "o": o, "h": np.maximum(o, u), "l": np.minimum(o, u),
            "btc": df["btc"].to_numpy(float)}


def _rsi(x: np.ndarray, n: int = 14) -> np.ndarray:
    s = pd.Series(x)
    dlt = s.diff()
    up = dlt.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-dlt.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return (100 - 100 / (1 + up / dn.replace(0, np.nan))).to_numpy(float)


def _mirror(btc: np.ndarray, u: np.ndarray, win: int) -> np.ndarray:
    """Specchio = −correlazione mobile dei rendimenti log di BTC e USDT.D (1 = specchio perfetto)."""
    rb = pd.Series(np.log(btc)).diff()
    ru = pd.Series(np.log(u)).diff()
    return (-rb.rolling(win).corr(ru)).to_numpy(float)


# ================================================================== formattazione

def _sg(v, d: int = 1, suf: str = "%") -> str:
    if v is None or not math.isfinite(v):
        return "n/d"
    v = round(float(v), d)
    s = "+" if v > 0 else ("−" if v < 0 else "")
    return f"{s}{abs(v):.{d}f}{suf}"


def _pt(v, d: int = 2) -> str:
    return _sg(v, d, " pt")


def _btc(p: float) -> float:
    return int(round(p)) if p >= 1000 else round(float(p), 2)


BTC_TONE = {"bullish": "bearish", "bearish": "bullish", "neutral": "neutral"}
BTC_MEANING = {
    "bullish": "per BTC è una lettura favorevole (la liquidità tende a uscire dalle stablecoin)",
    "bearish": "per BTC è una lettura sfavorevole (la liquidità tende a rifugiarsi nelle stablecoin)",
    "neutral": "per BTC una lettura neutra finché la figura non si risolve",
}


def _usdt_pats(pats: list[dict], t) -> list[dict]:
    out = an._pats_out(pats, t)
    for p in out:
        p["btc_tone"] = BTC_TONE.get(p["tone"], "neutral")
        p["label"] = f"{p['name']} sulla USDT.D"
        for ln in p["lines"]:
            for q in ln["points"]:
                q["price"] = round(float(q["price"]), 4)
        for q in p["points"]:
            q["price"] = round(float(q["price"]), 4)
    return out


def _legs(legs: list[dict], t, labels: list[str]) -> list[dict]:
    out = an._legs_out(legs, t, labels)
    for o, g in zip(out, legs):
        o["from_price"] = round(float(g["p0"]), 4)
        o["to_price"] = round(float(g["p1"]), 4)
        o["pts"] = round(float(g["p1"] - g["p0"]), 3)
    return out


# ================================================================== contesto

def _ctx(S: dict, rsi: np.ndarray, mir: np.ndarray, s: int, e: int) -> dict:
    u, b = S["u"], S["btc"]
    return {
        "level": float(u[e]),
        "change": (u[e] / u[s] - 1) * 100,
        "rsi": float(rsi[e]) if np.isfinite(rsi[e]) else None,
        "btc": (b[e] / b[s] - 1) * 100,
        "mirror": float(mir[e]) if np.isfinite(mir[e]) else None,
    }


CTX_SPECS = [
    # key, label, peso
    ("level", "Livello della USDT.D", 1.0),
    ("change", "Variazione della USDT.D nella finestra", 1.0),
    ("rsi", "RSI 14 della USDT.D", 0.8),
    ("btc", "Variazione di BTC nella finestra", 1.0),
    ("mirror", "Forza dello specchio BTC ↔ USDT.D", 0.7),
]


def _ctx_sim(key: str, a, b, sig_u: float, sig_b: float) -> float | None:
    if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
        return None
    if key == "level":
        d, sc_ = abs(math.log(max(a, 1e-6) / max(b, 1e-6))), 0.3
    elif key == "change":
        d, sc_ = abs(a - b), max(0.5 * sig_u, 2.0) + 0.25 * max(abs(a), abs(b))
    elif key == "rsi":
        d, sc_ = abs(a - b), 10.0
    elif key == "btc":
        d, sc_ = abs(a - b), max(0.5 * sig_b, 2.0) + 0.25 * max(abs(a), abs(b))
    else:
        d, sc_ = abs(a - b), 0.3
    return 100.0 * 2 ** (-(d / sc_) ** 2)


def _ctx_display(key: str, v) -> str:
    if v is None:
        return "n/d"
    if key == "level":
        return f"{v:.2f}%"
    if key in ("change", "btc"):
        return _sg(v)
    if key == "rsi":
        return f"{v:.0f}"
    return f"{v:+.2f}"


def _ctx_list(fc: dict, fa: dict, sig_u: float, sig_b: float, when: str) -> tuple[list[dict], float]:
    out, num, den = [], 0.0, 0.0
    for key, lab, w in CTX_SPECS:
        s = _ctx_sim(key, fc[key], fa[key], sig_u, sig_b)
        if s is not None:
            num += w * s
            den += w
        dc, da = _ctx_display(key, fc[key]), _ctx_display(key, fa[key])
        if s is None:
            ex = "Dato non disponibile per uno dei due periodi."
        elif key == "level":
            ex = f"USDT.D a {dc} oggi contro {da} {when}: livello di dominance {an._qual(s)}."
        elif key == "change":
            ex = f"La USDT.D è variata del {dc} nella finestra, {when} del {da} (variazione relativa, non in punti)."
        elif key == "rsi":
            ex = f"RSI della USDT.D {dc} oggi vs {da} {when}: momentum della dominance {an._qual(s)}."
        elif key == "btc":
            ex = f"Nello stesso intervallo BTC ha fatto {dc}, {when} {da}."
        else:
            ex = (f"Specchio (−correlazione {MIRROR_WIN} periodi dei rendimenti) {dc} oggi vs {da} {when}: "
                  + ("relazione inversa forte in entrambi." if min(fc[key], fa[key]) > 0.6 else f"intensità {an._qual(s, True)}."))
        out.append({"key": key, "label": lab, "current": fc[key], "analog": fa[key], "display_current": dc,
                    "display_analog": da, "similarity": round(s, 1) if s is not None else None, "weight": w, "explanation": ex})
    return out, (num / den if den else 0.0)


# ================================================================== analoghi visivi

def search(tf: str, window: int, top: int, horizon: int) -> dict:
    S = _series(tf)
    t, u, O, H, L, B = S["time"], S["u"], S["o"], S["h"], S["l"], S["btc"]
    n_all = len(u)
    w = window
    m = n_all - 2 * w - horizon + 1
    if m < max(20, top * 2):
        raise ValueError(f"storico insufficiente per tf={tf}, window={w}, horizon={horizon}")
    x = np.log(u)
    cs, ce = n_all - w, n_all - 1
    rsi = _rsi(u)
    mir = _mirror(B, u, MIRROR_WIN if tf == "1d" else MIRROR_WIN * 6)

    # 1) candidati per forma
    qz = fr._z(x[-w:])
    corr = fr._rolling_corr(x, qz, m)
    order = np.argsort(-corr)
    blocked = np.zeros(m, bool)
    half = max(1, w // 3)
    picks: list[int] = []
    for s in order:
        if corr[s] <= 0 or len(picks) >= N_PREFILTER:
            break
        if blocked[s]:
            continue
        picks.append(int(s))
        blocked[max(0, s - half):s + half + 1] = True
    if not picks:
        picks = [int(s) for s in order[:N_PREFILTER]]
    pa = np.array(picks)
    cands = fr._z(x[pa[:, None] + np.arange(w)[None, :]])
    dtw = fr.dtw_banded(qz, cands, max(2, w // 10))
    c = corr[pa]
    shape = 100 * (0.6 * np.clip(c, 0, 1) + 0.4 * np.exp(-dtw / 0.35))

    # 2) re-rank visivo + contesto
    cur = slice(cs, ce + 1)
    oc, hc, lc, cc = O[cur], H[cur], L[cur], u[cur]
    zc = vis.zigzag(hc, lc, cc, vis.zz_threshold(hc, lc, cc))
    legs_c = vis.legs_of(zc)
    rng_c = (hc.max() / lc.min() - 1) * 100
    pats_c = vis.detect_patterns(oc, hc, lc, cc)
    geo_c = vis.trend_geometry(vis.zigzag(hc, lc, cc, vis.zz_threshold(hc, lc, cc) * 0.7), hc, lc)
    sig_u = float(np.std(np.diff(x[-w:])) * math.sqrt(w) * 100)
    sig_b = float(np.std(np.diff(np.log(B[-w:]))) * math.sqrt(w) * 100)
    fc = _ctx(S, rsi, mir, cs, ce)

    pool = [int(k) for k in np.argsort(-shape)[:N_RERANK]]
    scored = []
    for k in pool:
        s = int(pa[k])
        e = s + w - 1
        ws = slice(s, e + 1)
        oa, ha, la, ca = O[ws], H[ws], L[ws], u[ws]
        za = vis.zigzag(ha, la, ca, vis.zz_threshold(ha, la, ca))
        legs_a = vis.legs_of(za)
        rng_a = (ha.max() / la.min() - 1) * 100
        s_legs, pairs = vis.legs_align(legs_c, legs_a, w, rng_c, rng_a)
        pats_a = vis.detect_patterns(oa, ha, la, ca)
        geo_a = vis.trend_geometry(vis.zigzag(ha, la, ca, vis.zz_threshold(ha, la, ca) * 0.7), ha, la)
        s_pat, common, pat_text = vis.pattern_score(pats_c, pats_a, geo_c, geo_a)
        s_vty = vis.volatility_score(hc, lc, cc, ha, la, ca)
        comps = {"shape": float(shape[k]), "candles": None, "legs": s_legs, "pattern": s_pat, "volume": None, "volatility": s_vty}
        vscore = vis.combine(comps)
        fa = _ctx(S, rsi, mir, s, e)
        when = an._when(int(t[s]), int(t[e]))
        ctx, cscore = _ctx_list(fc, fa, sig_u, sig_b, when)
        total = W_VISUAL * vscore + (1 - W_VISUAL) * cscore
        scored.append({"score": total, "k": k, "s": s, "vscore": vscore, "cscore": cscore, "comps": comps, "ctx": ctx,
                       "za": za, "legs_a": legs_a, "pairs": pairs, "pats_a": pats_a, "common": common, "pat_text": pat_text,
                       "rng_a": rng_a, "when": when})
    scored.sort(key=lambda r: -r["score"])
    chosen: list[dict] = []
    for row in scored:
        if all(abs(row["s"] - r["s"]) >= w for r in chosen):
            chosen.append(row)
        if len(chosen) >= top:
            break

    # 3) output
    tc = t[cur]
    u_now, b_now = float(u[-1]), float(B[-1])
    step = STEP[tf]
    legs_c_out = _legs(legs_c, tc, [f"G{i + 1}" for i in range(len(legs_c))])
    pats_c_out = _usdt_pats(pats_c, tc)
    rt_c = an._retests(hc, lc, cc)
    matches = []
    for rank, row in enumerate(chosen, 1):
        k, s = row["k"], row["s"]
        e = s + w - 1
        ws = slice(s, e + 1)
        ha, la, ca = H[ws], L[ws], u[ws]
        ta = t[ws]
        when = row["when"]
        fut = slice(e + 1, e + 1 + horizon)
        bf, uf = B[fut], u[fut]
        be, ue = float(B[e]), float(u[e])
        comps = row["comps"]
        lab_a = []
        for j in range(len(row["legs_a"])):
            ii = [i for i, jj in row["pairs"] if jj == j]
            lab_a.append("G" + "/".join(str(i + 1) for i in ii[:2]) if ii else "–")
        legs_a_out = _legs(row["legs_a"], ta, lab_a)
        leg_pairs = []
        for i, j in row["pairs"]:
            gc, ga = legs_c[i], row["legs_a"][j]
            mx = gc["pct"] / max(rng_c, 1e-6)
            my = ga["pct"] / max(row["rng_a"], 1e-6)
            cost = abs(mx - my) + 0.8 * abs(gc["dur"] - ga["dur"]) / w + (0.6 if (gc["pct"] > 0) != (ga["pct"] > 0) else 0)
            sim = 100 * math.exp(-cost / 0.35)
            leg_pairs.append({
                "current": i + 1, "analog": j + 1, "similarity": round(sim, 1),
                "text": (f"Gamba {i + 1}: {_pt(gc['p1'] - gc['p0'])} ({_sg(gc['pct'])}) in {gc['dur']} candele ↔ "
                         f"{_pt(ga['p1'] - ga['p0'])} ({_sg(ga['pct'])}) in {ga['dur']} candele"),
            })
        good = sum(1 for p in leg_pairs if p["similarity"] >= 70)
        atr_c = float(np.mean((hc - lc) / cc) * 100)
        atr_a = float(np.mean((ha - la) / ca) * 100)
        na = "Non applicabile: la USDT.D è una serie di sole chiusure giornaliere (peso ridistribuito sulle altre componenti)."
        expl = {
            "shape": f"Correlazione {c[k]:.2f} e distanza DTW {dtw[k]:.2f} sul log della USDT.D normalizzato: le due curve "
                     f"disegnano un percorso {an._qual(comps['shape'])}.",
            "candles": na,
            "legs": f"{len(legs_c)} gambe oggi contro {len(row['legs_a'])} {when}; {good} coppie su {len(leg_pairs)} con "
                    f"ampiezza (relativa al range) e durata simili (≥70%).",
            "pattern": row["pat_text"].replace("Entrambi formano", "Entrambe le curve formano") if row["pat_text"] else row["pat_text"],
            "volume": "Non applicabile: la USDT.D non ha volumi.",
            "volatility": f"Variazione media per candela {atr_c:.2f}% oggi vs {atr_a:.2f}% {when} (relativa al livello); "
                          f"andamento della volatilità {an._qual(comps['volatility'], True)}.",
        }
        visual = {"score": round(row["vscore"], 1), "components": [
            {"key": key, "label": vis.VIS_LABELS[key] if key != "candles" else "Geometria delle candele",
             "score": round(comps[key], 1) if comps[key] is not None else None,
             "weight": wgt, "explanation": expl[key]} for key, wgt in vis.VIS_WEIGHTS.items()]}

        mp = an._mapping(zc, row["za"], row["pairs"], hc, lc, cc, ha, la, ca, tc, ta,
                         {"_retests": rt_c}, {"_retests": an._retests(ha, la, ca)}, when)
        for p in mp:
            ic, ia = p["current"]["idx"], p["analog"]["idx"]
            vc_ = float(p["current"]["price"])
            va_ = float(p["analog"]["price"])
            p["current"]["price"] = round(vc_, 4)
            p["analog"]["price"] = round(va_, 4)
            p["current"]["pts"] = round(vc_ - float(cc[0]), 3)
            p["analog"]["pts"] = round(va_ - float(ca[0]), 3)
            p["current"]["btc"] = _btc(B[cs + ic])
            p["analog"]["btc"] = _btc(B[s + ia])
            p["note"] = (f"{p['label']}: oggi USDT.D {vc_:.2f}% ({_pt(vc_ - cc[0])} dall'inizio, candela {ic + 1}), "
                         f"{when} {va_:.2f}% ({_pt(va_ - ca[0])}, candela {ia + 1})"
                         + ("." if p["same_role"] else f" — {when} era un «{p['analog_label'].lower()}»."))

        ok = len(bf) > 0
        outcome = {
            "candles": int(len(bf)),
            "change": round(float((bf[-1] / be - 1) * 100), 2) if ok else None,
            "max_up": round(max(0.0, float((bf.max() / be - 1) * 100)), 2) if ok else None,
            "max_down": round(min(0.0, float((bf.min() / be - 1) * 100)), 2) if ok else None,
            "usdt_change_pts": round(float(uf[-1] - ue), 3) if ok else None,
            "usdt_change": round(float((uf[-1] / ue - 1) * 100), 2) if ok else None,
            "end_time": int(t[e + len(bf)]) if ok else None,
        }
        times_f = [int(t[-1]) + step * (i + 1) for i in range(len(bf))]
        mt = {
            "rank": rank,
            "period": {"start": int(t[s]), "end": int(t[e]), "label": an.period_label(int(t[s]), int(t[e]), tf), "when": when},
            "similarity": round(float(row["score"]), 1),
            "visual_similarity": round(float(row["vscore"]), 1),
            "shape_similarity": round(float(shape[k]), 1),
            "context_similarity": round(float(row["cscore"]), 1),
            "correlation": round(float(c[k]), 4), "dtw": round(float(dtw[k]), 4),
            "visual": visual,
            "patterns": {"current": pats_c_out, "analog": _usdt_pats(row["pats_a"], ta), "common": row["common"],
                         "common_name": vis.NAMES.get(row["common"]) if row["common"] else None,
                         "text": expl["pattern"], "score": round(comps["pattern"], 1)},
            "legs_current": legs_c_out, "legs_analog": legs_a_out, "leg_pairs": leg_pairs,
            "context": row["ctx"], "mapping": mp,
            "usdt": {"times": [int(v) for v in t[s:e + 1 + len(bf)]], "values": [round(float(v), 4) for v in u[s:e + 1 + len(bf)]],
                     "window_change_pts": round(float(ca[-1] - ca[0]), 3), "window_change": round(float((ca[-1] / ca[0] - 1) * 100), 2)},
            "btc": {"values": [_btc(v) for v in B[s:e + 1 + len(bf)]], "window_change": round(float((B[e] / B[s] - 1) * 100), 2)},
            "outcome": outcome,
            "projection": {"times": times_f, "close": [_btc(v) for v in bf / be * b_now]},
            "usdt_projection": {"times": times_f, "value": [round(float(u_now + (v - ue)), 4) for v in uf]},
        }
        mt["narrative"] = _narrative(mt, tf, w, u_now, float(cc[0]))
        mt["narrative_llm"] = None
        matches.append(mt)

    # 4) riepilogo + banda dei percorsi BTC riscalati
    outs = np.array([mm["outcome"]["change"] for mm in matches if mm["outcome"]["change"] is not None])
    sims = np.array([mm["similarity"] for mm in matches if mm["outcome"]["change"] is not None])
    n_m = len(outs)
    up = int((outs > 0).sum())
    med = float(np.median(outs)) if n_m else None
    wavg = float((outs * sims).sum() / sims.sum()) if n_m and sims.sum() > 0 else None
    agree = max(up, n_m - up) / n_m * 100 if n_m else None
    bias = "neutral"
    if n_m and up / n_m >= 0.65 and (med or 0) > 0:
        bias = "bullish"
    elif n_m and up / n_m <= 0.35 and (med or 0) < 0:
        bias = "bearish"
    hz = min((len(mm["projection"]["close"]) for mm in matches), default=0)
    band = None
    if hz and n_m:
        P = np.array([mm["projection"]["close"][:hz] for mm in matches], float)
        U = np.array([mm["usdt_projection"]["value"][:hz] for mm in matches], float)
        band = {"times": matches[0]["projection"]["times"][:hz],
                "p25": [_btc(v) for v in np.percentile(P, 25, axis=0)], "p50": [_btc(v) for v in np.median(P, axis=0)],
                "p75": [_btc(v) for v in np.percentile(P, 75, axis=0)],
                "usdt_p50": [round(float(v), 4) for v in np.median(U, axis=0)]}
    dir_txt = {"bullish": "al rialzo", "bearish": "al ribasso", "neutral": "senza una direzione prevalente"}[bias]
    unit = UNIT[tf]
    usdt_med = float(np.median([mm["outcome"]["usdt_change_pts"] for mm in matches if mm["outcome"]["usdt_change_pts"] is not None])) if n_m else None
    text = (f"Dopo le {n_m} configurazioni della USDT.D più simili a quella attuale, BTC è salito {up} volte su {n_m} "
            f"{_next(horizon, tf)} (mediana {_sg(med)}, media pesata {_sg(wavg)}), mentre la USDT.D è variata in mediana di "
            f"{_pt(usdt_med)}: i precedenti si sono risolti {dir_txt}.") if n_m else "Nessun esito disponibile."

    first = float(u[cs])
    return {
        "tf": tf, "window": w, "horizon": horizon, "top": top, "generated_at": int(time.time()), "estimated": tf == "4h",
        "current": {
            "start": int(t[cs]), "end": int(t[ce]), "label": an.period_label(int(t[cs]), int(t[ce]), tf),
            "usdt_d": round(u_now, 4), "btc": _btc(b_now), "change_pts": round(u_now - first, 3),
            "change": round((u_now / first - 1) * 100, 2), "btc_change": round(float((B[-1] / B[cs] - 1) * 100), 2),
            "times": [int(v) for v in tc], "usdt": [round(float(v), 4) for v in cc], "btc_path": [_btc(v) for v in B[cur]],
            "patterns": pats_c_out, "legs": legs_c_out,
            "rsi": util.num(round(float(rsi[-1]), 1)) if np.isfinite(rsi[-1]) else None,
        },
        "summary": {"count": n_m, "up": up, "down": n_m - up, "agreement": round(agree, 1) if agree is not None else None,
                    "median_outcome": round(med, 2) if med is not None else None,
                    "weighted_outcome": round(wavg, 2) if wavg is not None else None,
                    "usdt_median_pts": round(usdt_med, 3) if usdt_med is not None else None,
                    "best_similarity": matches[0]["similarity"] if matches else None, "bias": bias, "text": text, "band": band},
        "matches": matches,
        "method": ("Candidati selezionati per forma sulla curva della USDT.D (correlazione di Pearson + DTW sul log della dominance "
                   f"normalizzato, dal 2018); i migliori {N_RERANK} sono riordinati con il motore grafico degli Analoghi: 80% "
                   "somiglianza grafica (forma 30%, gambe ZigZag allineate 20%, figure grafiche e trendline 15%, inviluppo di "
                   "volatilità 7.5%, rinormalizzati perché geometria delle candele e volumi non esistono per una serie di sole "
                   "chiusure) e 20% contesto (livello e RSI della USDT.D, variazione nella finestra, variazione di BTC, forza dello "
                   "specchio). L'esito di BTC è misurato sulle chiusure; il percorso è riportato sul prezzo attuale."
                   + (" In 4H la USDT.D è una STIMA: mcap USDT interpolata tra le chiusure giornaliere e resto del mercato scalato "
                      "con i movimenti intraday di BTC ed ETH." if tf == "4h" else "")),
    }


def _narrative(m: dict, tf: str, w: int, u_now: float, u_first: float) -> list[str]:
    vc = {c["key"]: c for c in m["visual"]["components"]}
    when = m["period"]["when"]
    unit = UNIT[tf]
    s = [f"La USDT.D attuale ({w} {unit}) somiglia graficamente a {m['period']['label']}: somiglianza grafica "
         f"{m['visual']['score']:.0f}% (forma {vc['shape']['score']:.0f}%, gambe {vc['legs']['score']:.0f}%, figure "
         f"{vc['pattern']['score']:.0f}%) e contesto {m['context_similarity']:.0f}%, complessiva {m['similarity']:.0f}%."]
    pc = m["patterns"]["current"]
    if m["patterns"]["common"]:
        p0 = next((p for p in pc if p["key"] == m["patterns"]["common"]), pc[0] if pc else None)
        tone = p0["btc_tone"] if p0 else "neutral"
        s.append(f"Su entrambe le curve si riconosce {vis.ART[m['patterns']['common']]}{vis._lname(m['patterns']['common'])} "
                 f"sulla USDT.D: {BTC_MEANING[tone]}.")
    elif m["patterns"]["text"]:
        s.append(m["patterns"]["text"])
    good = sorted([p for p in m["leg_pairs"] if p["similarity"] >= 70], key=lambda p: -p["similarity"])
    if m["leg_pairs"]:
        s.append(f"Le gambe della dominance si corrispondono in {len(good)} casi su {len(m['leg_pairs'])}"
                 + (f", ad esempio {an._lc(good[0]['text'])}." if good else "."))
    s.append(f"Nella finestra la USDT.D è passata da {u_first:.2f}% a {u_now:.2f}% ({_pt(u_now - u_first)}), {when} "
             f"variò di {_pt(m['usdt']['window_change_pts'])}; BTC {_sg(m['btc']['window_change'])} {when}.")
    o = m["outcome"]
    if o["change"] is not None:
        s.append(f"Dopo quella finestra BTC si mosse del {_sg(o['change'])} in {o['candles']} {unit} (escursione massima "
                 f"{_sg(o['max_up'])} / {_sg(o['max_down'])}) mentre la USDT.D variò di {_pt(o['usdt_change_pts'])}: "
                 "un precedente, non una previsione.")
    return s


# ================================================================== specchio BTC ↔ USDT.D

def mirror(window: int, horizon: int) -> dict:
    d = sc.daily_frame()
    d = d[d["time"] >= SEARCH_FROM].reset_index(drop=True)
    t = _secs(d["time"])
    b = d["btc"].to_numpy(float)
    u = d["usdt_d"].to_numpy(float)
    n = len(u)
    mr = _mirror(b, u, MIRROR_WIN)
    cur_m = float(mr[-1]) if np.isfinite(mr[-1]) else None
    hist = mr[np.isfinite(mr)]
    pctile = float((hist <= cur_m).mean() * 100) if cur_m is not None else None
    last_year = mr[-365:]
    avg_1y = float(np.nanmean(last_year))

    # ---- configurazioni congiunte: forma BTC + forma USDT.D + forza dello specchio
    w, h = window, horizon
    m = n - 2 * w - h + 1
    joint = []
    if m >= 20 and cur_m is not None:
        xb, xu = np.log(b), np.log(u)
        cb = fr._rolling_corr(xb, fr._z(xb[-w:]), m)
        cu = fr._rolling_corr(xu, fr._z(xu[-w:]), m)
        me = mr[np.arange(m) + w - 1]
        ms = np.where(np.isfinite(me), 100 * 2 ** (-((me - cur_m) / 0.25) ** 2), 0.0)
        comb = 0.4 * 100 * np.clip(cb, 0, 1) + 0.4 * 100 * np.clip(cu, 0, 1) + 0.2 * ms
        comb[(cb <= 0) | (cu <= 0)] *= 0.5
        chosen: list[int] = []
        for s in np.argsort(-comb):
            if all(abs(int(s) - c) >= w for c in chosen):
                chosen.append(int(s))
            if len(chosen) >= 5:
                break
        for r, s in enumerate(chosen, 1):
            e = s + w - 1
            fb = b[e + 1:e + 1 + h]
            joint.append({
                "rank": r, "start": int(t[s]), "end": int(t[e]), "label": an.period_label(int(t[s]), int(t[e]), "1d"),
                "similarity": round(float(comb[s]), 1), "btc_shape": round(float(cb[s]) * 100, 1), "usdt_shape": round(float(cu[s]) * 100, 1),
                "mirror_then": round(float(me[s]), 3) if np.isfinite(me[s]) else None,
                "btc_outcome": round(float((b[e + h] / b[e] - 1) * 100), 2),
                "btc_max_up": round(max(0.0, float((fb.max() / b[e] - 1) * 100)), 2),
                "btc_max_down": round(min(0.0, float((fb.min() / b[e] - 1) * 100)), 2),
                "usdt_outcome_pts": round(float(u[e + h] - u[e]), 3),
            })

    # ---- rotture dello specchio: BTC e USDT.D nella stessa direzione su 7 giorni
    db = pd.Series(b).pct_change(7).to_numpy() * 100
    du = pd.Series(u).pct_change(7).to_numpy() * 100
    sb, su = np.nanstd(db), np.nanstd(du)
    up = (db > BREAK_K * sb) & (du > BREAK_K * su)
    dn = (db < -BREAK_K * sb) & (du < -BREAK_K * su)
    breaks = []
    for kind, mask in (("both_up", up), ("both_down", dn)):
        idx = np.where(mask)[0]
        if not idx.size:
            continue
        groups = np.split(idx, np.where(np.diff(idx) > 5)[0] + 1)
        for g in groups:
            if len(g) < 2:
                continue
            i0, i1 = max(0, int(g[0]) - 7), int(g[-1])
            a14 = (b[i1 + 14] / b[i1] - 1) * 100 if i1 + 14 < n else None
            a30 = (b[i1 + 30] / b[i1] - 1) * 100 if i1 + 30 < n else None
            breaks.append({
                "kind": kind, "start": int(t[i0]), "end": int(t[i1]), "days": int(i1 - i0),
                "label": an.period_label(int(t[i0]), int(t[i1]), "1d").replace(" (1G)", ""),
                "btc_change": round(float((b[i1] / b[i0] - 1) * 100), 2), "usdt_change_pts": round(float(u[i1] - u[i0]), 3),
                "btc_after_14": round(float(a14), 2) if a14 is not None else None,
                "btc_after_30": round(float(a30), 2) if a30 is not None else None,
                "ongoing": bool(n - 1 - i1 <= 2),
            })
    breaks.sort(key=lambda x: x["start"])
    stats = []
    for kind, lab in (("both_up", "BTC e USDT.D in salita insieme"), ("both_down", "BTC e USDT.D in discesa insieme")):
        v = np.array([x["btc_after_30"] for x in breaks if x["kind"] == kind and x["btc_after_30"] is not None])
        stats.append({"kind": kind, "label": lab, "n": int(len(v)),
                      "median_after_30": round(float(np.median(v)), 2) if len(v) else None,
                      "up_rate_30": round(float((v > 0).mean() * 100), 1) if len(v) else None})
    for x in breaks:
        lab = "BTC e USDT.D salgono insieme" if x["kind"] == "both_up" else "BTC e USDT.D scendono insieme"
        nxt = (f"dopo 30 giorni BTC {_sg(x['btc_after_30'])}" if x["btc_after_30"] is not None
               else "esito a 30 giorni non ancora disponibile")
        x["text"] = f"{lab}: BTC {_sg(x['btc_change'])}, USDT.D {_pt(x['usdt_change_pts'])} in {x['days']} giorni; {nxt}."
    current_break = next((x for x in reversed(breaks) if x["ongoing"]), None)

    p10, p50 = (float(np.percentile(hist, 10)), float(np.percentile(hist, 50))) if hist.size else (0.0, 0.0)
    if cur_m is None:
        state, txt = "n/d", "Dati insufficienti."
    elif cur_m >= p50:
        state = "forte"
        txt = (f"Specchio forte ({cur_m:+.2f}, percentile {pctile:.0f} dal 2018): BTC e USDT.D si muovono in modo speculare, "
               "la dominance riflette quasi solo il prezzo di BTC.")
    elif cur_m >= p10:
        state = "moderato"
        txt = (f"Specchio nella norma ma sotto la mediana storica ({cur_m:+.2f}, percentile {pctile:.0f}): la relazione inversa "
               "regge, con qualche deviazione dovuta ai flussi di stablecoin o alla rotazione sulle altcoin.")
    else:
        state = "rotto"
        txt = (f"Specchio indebolito ({cur_m:+.2f}, percentile {pctile:.0f}): BTC e USDT.D non si muovono più in modo speculare; "
               "storicamente fasi di transizione in cui contano mint/burn di stablecoin e altcoin.")
    if current_break:
        txt += " In corso: " + current_break["text"][0].lower() + current_break["text"][1:]
    keep = t >= t[-1] - 2 * 365 * 86400
    return {
        "window": MIRROR_WIN, "current": cur_m, "avg_1y": avg_1y, "percentile": pctile, "p10": p10, "p50": p50, "state": state, "text": txt,
        "series": [{"time": int(tt), "value": round(float(v), 3) if np.isfinite(v) else None} for tt, v in zip(t[keep], mr[keep])],
        "joint": joint, "breaks": breaks[-14:][::-1], "break_stats": stats, "current_break": current_break,
    }


# ================================================================== tecnica sulla USDT.D

def technicals() -> dict:
    d = sc.daily_frame()
    d = d[d["time"] >= SEARCH_FROM].reset_index(drop=True)
    t = _secs(d["time"])
    b = d["btc"].to_numpy(float)
    u = d["usdt_d"].to_numpy(float)
    n = len(u)
    s = pd.Series(u)
    ema50 = s.ewm(span=50, adjust=False).mean().to_numpy()
    ema200 = s.ewm(span=200, adjust=False).mean().to_numpy()
    rsi = _rsi(u)
    cur = float(u[-1])

    # zone di rifiuto: pivot (±7 giorni) raggruppati entro il 4% relativo
    k = 7
    piv = []
    for i in range(k, n - k):
        seg = u[i - k:i + k + 1]
        if u[i] == seg.max():
            piv.append((i, "high"))
        elif u[i] == seg.min():
            piv.append((i, "low"))
    piv.sort(key=lambda p: u[p[0]])
    clusters: list[list] = []
    for p in piv:
        if clusters and abs(u[p[0]] / np.mean([u[q[0]] for q in clusters[-1]]) - 1) < 0.04:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    zones = []
    for cl in clusters:
        if len(cl) < 2:
            continue
        vals = np.array([u[i] for i, _ in cl])
        mid = float(np.median(vals))
        kind = "resistance" if mid > cur else "support"
        lo, hi = float(vals.min()), float(vals.max())
        pad = max(0.02 * mid, 0.03)
        lo, hi = min(lo, mid - pad), max(hi, mid + pad)
        # reazioni: massimi (per una resistenza) / minimi (per un supporto) della USDT.D nella zona
        want = "high" if kind == "resistance" else "low"
        ev = sorted(i for i, kd in cl if kd == want)
        a30 = [(b[i + 30] / b[i] - 1) * 100 for i in ev if i + 30 < n]
        a14 = [(b[i + 14] / b[i] - 1) * 100 for i in ev if i + 14 < n]
        last_touch = int(t[max(i for i, _ in cl)])
        med30 = float(np.median(a30)) if a30 else None
        upr = float(np.mean(np.array(a30) > 0) * 100) if a30 else None
        if kind == "resistance":
            txt = (f"Zona {lo:.2f}–{hi:.2f}%: la USDT.D vi ha fatto massimo {len(ev)} volte; dopo il rifiuto BTC ha reso in mediana "
                   f"{_sg(med30)} a 30 giorni (positivo {upr:.0f}% delle volte)." if a30 else
                   f"Zona {lo:.2f}–{hi:.2f}%: resistenza della dominance, reazioni di BTC non ancora misurabili.")
        else:
            txt = (f"Zona {lo:.2f}–{hi:.2f}%: la USDT.D vi ha fatto minimo {len(ev)} volte; dopo il rimbalzo BTC ha reso in mediana "
                   f"{_sg(med30)} a 30 giorni (positivo {upr:.0f}% delle volte)." if a30 else
                   f"Zona {lo:.2f}–{hi:.2f}%: supporto della dominance, reazioni di BTC non ancora misurabili.")
        zones.append({"low": round(lo, 3), "high": round(hi, 3), "mid": round(mid, 3), "kind": kind, "touches": len(cl),
                      "reactions": len(ev), "last_touch": last_touch, "distance_pts": round(mid - cur, 3),
                      "btc_after_14_median": round(float(np.median(a14)), 2) if a14 else None,
                      "btc_after_30_median": round(med30, 2) if med30 is not None else None,
                      "btc_up_rate_30": round(upr, 1) if upr is not None else None, "text": txt})
    # le 3 zone più vicine sopra e sotto
    res = sorted([z for z in zones if z["kind"] == "resistance"], key=lambda z: z["mid"])[:3]
    sup = sorted([z for z in zones if z["kind"] == "support"], key=lambda z: -z["mid"])[:3]
    zones = sorted(res + sup, key=lambda z: -z["mid"])
    inside = next((z for z in zones if z["low"] <= cur <= z["high"]), None)

    r = float(rsi[-1])
    e50, e200 = float(ema50[-1]), float(ema200[-1])
    sig = []
    if r >= 70:
        sig.append({"text": f"RSI della USDT.D a {r:.0f}: dominance in ipercomprato, spesso vicino a un massimo della paura (favorevole a BTC se si gira).", "tone": "bullish"})
    elif r <= 30:
        sig.append({"text": f"RSI della USDT.D a {r:.0f}: dominance in ipervenduto, euforia diffusa (rischio di rimbalzo della USDT.D, sfavorevole a BTC).", "tone": "bearish"})
    else:
        sig.append({"text": f"RSI della USDT.D a {r:.0f}: momentum della dominance in zona neutra.", "tone": "neutral"})
    if cur > e50 and cur > e200:
        sig.append({"text": f"USDT.D sopra EMA 50 ({e50:.2f}%) ed EMA 200 ({e200:.2f}%): trend della dominance rialzista, contesto difensivo per BTC.", "tone": "bearish"})
    elif cur < e50 and cur < e200:
        sig.append({"text": f"USDT.D sotto EMA 50 ({e50:.2f}%) ed EMA 200 ({e200:.2f}%): la liquidità esce dalle stablecoin, contesto favorevole a BTC.", "tone": "bullish"})
    else:
        sig.append({"text": f"USDT.D tra EMA 50 ({e50:.2f}%) ed EMA 200 ({e200:.2f}%): trend della dominance indeciso.", "tone": "neutral"})
    if inside:
        tone = "bullish" if inside["kind"] == "resistance" else "bearish"
        sig.append({"text": f"La USDT.D è dentro una zona di {'resistenza' if inside['kind'] == 'resistance' else 'supporto'}. {inside['text']}", "tone": tone})
    elif zones:
        near = min(zones, key=lambda z: abs(z["distance_pts"]))
        sig.append({"text": f"Zona più vicina a {_pt(near['distance_pts'])}: {near['text']}",
                    "tone": "neutral"})

    keep = slice(max(0, n - 400), n)
    series = [{"time": int(tt), "value": round(float(v), 4), "ema50": round(float(a), 4), "ema200": round(float(c), 4),
               "rsi": round(float(rr), 1) if np.isfinite(rr) else None}
              for tt, v, a, c, rr in zip(t[keep], u[keep], ema50[keep], ema200[keep], rsi[keep])]
    return {
        "usdt_d": cur, "rsi": r, "rsi_zone": "ipercomprato" if r >= 70 else "ipervenduto" if r <= 30 else "neutra",
        "ema50": e50, "ema200": e200, "dist_ema50_pts": cur - e50, "dist_ema200_pts": cur - e200,
        "trend": "rialzista" if cur > e50 > e200 else "ribassista" if cur < e50 < e200 else "laterale",
        "zones": zones, "signals": sig, "series": series,
    }


def intraday() -> dict:
    df = frame_4h()
    tail = df.iloc[-180:]
    u = tail["usdt_d"].to_numpy(float)
    d = sc.daily_frame()
    return {
        "estimated": True, "last": float(u[-1]), "time": int(_secs(tail["time"])[-1]),
        "change_24h_pts": float(u[-1] - u[-7]) if len(u) > 7 else None,
        "daily_last": float(d["usdt_d"].iloc[-1]),
        "series": [{"time": int(tt), "value": round(float(v), 4)} for tt, v in zip(_secs(tail["time"]), u)],
        "note": ("Stima 4H: mcap USDT interpolata tra le chiusure giornaliere, resto del mercato = valore di fine giornata "
                 "precedente scalato con i movimenti intraday di BTC (per la sua quota) ed ETH (per il resto)."),
    }


# ================================================================== build

@util.ttl_cache(60)
def cached(tf: str, window: int, top: int, horizon: int) -> dict:
    out = search(tf, window, top, horizon)
    try:
        out["mirror"] = mirror(window if tf == "1d" else 60, horizon if tf == "1d" else 30)
    except Exception as e:  # noqa: BLE001
        log.warning("specchio non disponibile: %s", e)
        out["mirror"] = None
    try:
        out["technicals"] = technicals()
    except Exception as e:  # noqa: BLE001
        log.warning("tecnica USDT.D non disponibile: %s", e)
        out["technicals"] = None
    try:
        out["intraday"] = intraday()
    except Exception as e:  # noqa: BLE001
        log.warning("stima 4H non disponibile: %s", e)
        out["intraday"] = None
    out["live"] = bool(sc.live_price())
    return util.clean(out)


def compute(tf: str, window: int, top: int, horizon: int) -> dict:
    r = cached(tf, window, top, horizon)
    if r["matches"]:
        best = r["matches"][0]
        key = ("usdt", tf, window, horizon, best["period"]["start"])
        txt = an._llm_narrative(key, best["narrative"])
        if txt:
            r = dict(r)
            r["matches"] = [dict(best, narrative_llm=txt)] + r["matches"][1:]
    return r
