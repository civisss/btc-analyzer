"""USDT dominance ricostruita, correlazioni con BTC, livelli, divergenze e frattale congiunto BTC+USDT.D."""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store
from .fractals import _rolling_corr, _z

log = logging.getLogger("usdt")

CAP_COLS = ["btc", "eth", "usdt", "usdc", "xrp", "doge", "ada"]
FALLBACK_FACTOR = 1 / 0.9
MIN_DIV_PT = 0.03  # differenza minima di USDT.D (punti) perché una divergenza sia significativa
_LAST_FACTOR: dict = {"v": None}  # ultima calibrazione CoinGecko riuscita
J_WINDOW, J_HORIZON, J_TOP = 60, 30, 5


@util.ttl_cache(120)
def _cg_global() -> tuple[float | None, float | None]:
    """(cap totale, cap USDT) da CoinGecko, la stessa fonte delle card in dashboard."""
    try:
        g = src.coingecko_global()
        tot = float(g["total_market_cap"]["usd"])
        usdt = tot * float(g["market_cap_percentage"]["usdt"]) / 100
        return (tot if tot > 0 else None), (usdt if usdt > 0 else None)
    except Exception as e:  # noqa: BLE001
        log.warning("coingecko global non disponibile: %s", e)
        return None, None


def _secs(s: pd.Series) -> np.ndarray:
    s = pd.to_datetime(pd.Series(s), utc=True).astype("datetime64[ns, UTC]")
    return ((s - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(dtype=np.int64)


def _frame() -> tuple[pd.DataFrame, float, bool]:
    caps = store.get("caps").sort_values("time").copy()
    caps["time"] = caps["time"].dt.normalize()
    cols = [c for c in CAP_COLS if c in caps]
    caps["sum"] = caps[cols].sum(axis=1, min_count=1)
    caps = caps[caps["usdt"].notna() & (caps["usdt"] > 5e7)]
    # prezzo BTC giornaliero: Binance 1d (incl. candela aperta di oggi) con prestorico CoinMetrics
    k1d = store.get("k_1d")[["time", "close"]].copy()
    k1d["time"] = k1d["time"].dt.normalize()
    try:
        oc = store.get("onchain")[["time", "PriceUSD"]].dropna().rename(columns={"PriceUSD": "close"})
        oc["time"] = oc["time"].dt.normalize()
        price = pd.concat([oc[oc["time"] < k1d["time"].iloc[0]], k1d])
    except Exception:  # noqa: BLE001
        price = k1d
    price = price.drop_duplicates("time", keep="last").set_index("time")["close"]

    df = caps.set_index("time")[["usdt", "sum", "btc"]].rename(columns={"btc": "btc_cap"})
    # estende all'ultima giornata di prezzo (caps CoinMetrics ha ~1 giorno di ritardo): mcap USDT costante,
    # cap totale scalata con la variazione di BTC.
    last_t = df.index[-1]
    extra = price[price.index > last_t]
    if len(extra) and last_t in price.index:
        p0 = float(price.loc[last_t])
        rows = []
        for t, p in extra.items():
            r = p / p0
            btc_cap = df["btc_cap"].iloc[-1] * r
            rows.append({"time": t, "usdt": df["usdt"].iloc[-1], "btc_cap": btc_cap,
                         "sum": df["sum"].iloc[-1] - df["btc_cap"].iloc[-1] + btc_cap})
        df = pd.concat([df, pd.DataFrame(rows).set_index("time")])
    df["btc"] = price.reindex(df.index).ffill()

    cg, cg_usdt = _cg_global()
    if cg_usdt:
        # allinea la serie USDT di CoinMetrics alla supply CoinGecko (differenze di metodologia ~2-3%)
        k = cg_usdt / float(df["usdt"].iloc[-1])
        if 0.9 <= k <= 1.1:
            df["sum"] = df["sum"] + df["usdt"] * (k - 1)
            df["usdt"] = df["usdt"] * k
    latest_sum = float(df["sum"].iloc[-1])
    calibrated = bool(cg)
    factor = cg / latest_sum if cg else (_LAST_FACTOR["v"] or FALLBACK_FACTOR)
    if not (1.0 <= factor <= 2.0):  # protezione da valori anomali
        factor, calibrated = (_LAST_FACTOR["v"] or FALLBACK_FACTOR), False
    elif calibrated:
        _LAST_FACTOR["v"] = factor
    df["total"] = df["sum"] * factor
    df["usdt_d"] = df["usdt"] / df["total"] * 100
    df = df.dropna(subset=["btc", "usdt_d"])
    return df.reset_index().rename(columns={"index": "time"}), factor, calibrated


def _pivots(x: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    n = len(x)
    hi, lo = [], []
    for i in range(k, n - k):
        seg = x[i - k:i + k + 1]
        if x[i] == seg.max():
            hi.append(i)
        elif x[i] == seg.min():
            lo.append(i)
    return np.array(hi, int), np.array(lo, int)


def _levels(d: pd.DataFrame) -> list[dict]:
    recent = d[d["time"] >= d["time"].iloc[-1] - pd.Timedelta(days=3 * 365)]
    u = recent["usdt_d"].to_numpy(float)
    cur = float(u[-1])
    hi, lo = _pivots(u, 10)
    pts = [(float(u[i]), "h") for i in hi] + [(float(u[i]), "l") for i in lo]
    pts.sort()
    clusters: list[list] = []
    for v, k in pts:
        if clusters and abs(v / np.mean([p[0] for p in clusters[-1]]) - 1) < 0.03:
            clusters[-1].append((v, k))
        else:
            clusters.append([(v, k)])
    cand = []
    for c in clusters:
        price = float(np.mean([p[0] for p in c]))
        if abs(price / cur - 1) < 0.01:
            continue
        cand.append((len(c), price))
    cand.sort(key=lambda x: -x[0])
    out = [{"price": round(p, 3), "kind": "resistance" if p > cur else "support"} for _, p in cand[:8]]
    out.sort(key=lambda x: -x["price"])
    return out


def _divergences(d: pd.DataFrame) -> list[dict]:
    recent = d[d["time"] >= d["time"].iloc[-1] - pd.Timedelta(days=4 * 365)].reset_index(drop=True)
    b = recent["btc"].to_numpy(float)
    u = recent["usdt_d"].to_numpy(float)
    times = recent["time"]
    bh, bl = _pivots(b, 5)
    out = []

    def win_ext(i, fn):
        return fn(u[max(0, i - 3):i + 4])

    for a, c in zip(bl[:-1], bl[1:]):
        if b[c] < b[a] and win_ext(c, np.max) < win_ext(a, np.max) - MIN_DIV_PT:
            out.append({"time": util.ts(times[c]), "kind": "bullish",
                        "note": f"BTC segna un minimo inferiore ({b[c]:,.0f} < {b[a]:,.0f}) ma USDT.D un massimo inferiore "
                                f"({win_ext(c, np.max):.2f}% < {win_ext(a, np.max):.2f}%): la fuga verso le stablecoin si esaurisce."})
    for a, c in zip(bh[:-1], bh[1:]):
        if b[c] > b[a] and win_ext(c, np.min) > win_ext(a, np.min) + MIN_DIV_PT:
            out.append({"time": util.ts(times[c]), "kind": "bearish",
                        "note": f"BTC segna un massimo superiore ({b[c]:,.0f} > {b[a]:,.0f}) ma USDT.D un minimo superiore "
                                f"({win_ext(c, np.min):.2f}% > {win_ext(a, np.min):.2f}%): la liquidità non conferma il rialzo."})
    out.sort(key=lambda x: x["time"])
    return out[-12:]


def _joint_fractal(d: pd.DataFrame) -> dict:
    xb = np.log(d["btc"].to_numpy(float))
    xu = np.log(d["usdt_d"].to_numpy(float))
    times = _secs(d["time"])
    n = len(xb)
    w, h = J_WINDOW, J_HORIZON
    m = n - 2 * w - h + 1
    if m < 20:
        return {"similarity": None, "matches": []}
    cb = _rolling_corr(xb, _z(xb[-w:]), m)
    cu = _rolling_corr(xu, _z(xu[-w:]), m)
    comb = 100 * (0.5 * np.clip(cb, 0, 1) + 0.5 * np.clip(cu, 0, 1))
    comb[(cb <= 0) | (cu <= 0)] *= 0.5
    chosen: list[int] = []
    for s in np.argsort(-comb):
        if all(abs(s - c) >= w for c in chosen):
            chosen.append(int(s))
        if len(chosen) >= J_TOP:
            break
    matches = []
    bc, uc = d["btc"].to_numpy(float), d["usdt_d"].to_numpy(float)
    for s in chosen:
        e = s + w - 1
        matches.append({
            "start": int(times[s]), "end": int(times[e]), "similarity": round(float(comb[s]), 2),
            "btc_outcome": round(float((bc[e + h] / bc[e] - 1) * 100), 2),
            "usdt_outcome": round(float((uc[e + h] / uc[e] - 1) * 100), 2),
        })
    return {"similarity": matches[0]["similarity"] if matches else None, "matches": matches}


def compute() -> dict:
    d, factor, calibrated = _frame()
    t = d["time"]
    last_t = t.iloc[-1]

    def at_days_ago(col, days):
        past = d[t <= last_t - pd.Timedelta(days=days)]
        return float(past[col].iloc[-1]) if not past.empty else None

    cur_d = float(d["usdt_d"].iloc[-1])
    d7 = at_days_ago("usdt_d", 7)
    m30 = at_days_ago("usdt", 30)
    current = {
        "usdt_d": cur_d,
        "usdt_d_change_7d": cur_d - d7 if d7 is not None else None,  # punti percentuali
        "usdt_mcap": float(d["usdt"].iloc[-1]),
        "mint_30d": float(d["usdt"].iloc[-1]) - m30 if m30 is not None else None,
    }

    # ---- correlazioni
    r_btc = np.log(d["btc"]).diff()
    r_u = np.log(d["usdt_d"]).diff()
    r30 = r_btc.rolling(30).corr(r_u)
    r90 = r_btc.rolling(90).corr(r_u)
    since = t >= pd.Timestamp("2019-01-01", tz="UTC")
    lag_win = t >= last_t - pd.Timedelta(days=730)
    rb7 = np.log(d["btc"]).diff(7)[lag_win].reset_index(drop=True)
    ru7 = np.log(d["usdt_d"]).diff(7)[lag_win].reset_index(drop=True)
    lead_lag = []
    for lag in range(-14, 15):
        # lag > 0: la variazione di USDT.D di `lag` giorni prima anticipa il rendimento BTC
        c = rb7.corr(ru7.shift(lag))
        lead_lag.append({"lag": lag, "corr": float(c) if pd.notna(c) else None})
    valid = [x for x in lead_lag if x["corr"] is not None]
    best_lag = max(valid, key=lambda x: abs(x["corr"]))["lag"] if valid else 0
    correlation = {
        "r30": util.series_pts(t[since], r30[since]),
        "r90": util.series_pts(t[since], r90[since]),
        "current_30": float(r30.iloc[-1]),
        "current_90": float(r90.iloc[-1]),
        "lead_lag": lead_lag,
        "best_lag": best_lag,
    }

    sd = d[t >= pd.Timestamp("2017-01-01", tz="UTC")]
    series = [
        {"time": int(tt), "btc": round(float(b), 2), "usdt_d": round(float(u), 4), "usdt_mcap": round(float(um)), "total_mcap_est": round(float(tm))}
        for tt, b, u, um, tm in zip(_secs(sd["time"]), sd["btc"], sd["usdt_d"], sd["usdt"], sd["total"])
    ]

    note = (
        "USDT.D ricostruita giornalmente: capitalizzazione USDT / capitalizzazione totale stimata. "
        "Il totale è la somma delle cap di BTC, ETH, USDT, USDC, XRP, DOGE e ADA (CoinMetrics), moltiplicata per un fattore "
        + (f"di calibrazione {factor:.3f} = cap totale CoinGecko / somma attuale"
           if calibrated else f"fisso {factor:.3f} (CoinGecko non disponibile: si assume che questi asset siano ~90% del mercato)")
        + ". Il fattore è costante su tutta la storia, quindi i valori lontani nel tempo sono approssimati "
        "(la quota delle altcoin minori è variata). Correlazioni su rendimenti giornalieri logaritmici; lead/lag su variazioni a 7 giorni "
        "degli ultimi 2 anni (lag positivo = USDT.D anticipa BTC). Correlazione attesa fortemente negativa e in parte meccanica "
        "(BTC è la quota maggiore del denominatore): i segnali informativi sono le deviazioni, cioè mint/burn di USDT e le divergenze "
        "tra minimi/massimi di BTC e di USDT.D. Il frattale congiunto cerca finestre di 60 giorni in cui sia la forma di BTC sia quella "
        "di USDT.D somigliano alle attuali, con esito dopo 30 giorni."
    )
    return {
        "series": series,
        "current": current,
        "correlation": correlation,
        "levels": _levels(d),
        "fractal": _joint_fractal(d),
        "divergences": _divergences(d),
        "note": note,
    }


@util.ttl_cache(60)
def build_cached() -> dict:
    return util.clean(compute())
