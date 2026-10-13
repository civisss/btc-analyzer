"""DOMANDA E OFFERTA — riserve e flussi degli exchange (CoinMetrics community), flussi degli ETF spot USA (Farside)
con assorbimento dell'emissione dei miner, attenzione retail (pageviews di Wikipedia).

Regole: solo dati passati per z-score e percentili (nessun lookahead); i valori recenti CoinMetrics sono "flash"
(preliminari) e vengono ricaricati per intero a ogni aggiornamento; la riga ETF più recente è provvisoria; il
controvalore in BTC dei flussi ETF è una stima (flusso USD ÷ prezzo BTC alle 16:00 di New York).
"""
from __future__ import annotations

import logging
import time

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store
from . import etf_flows
from .cycles import detect_bottoms, detect_tops, merged_daily

log = logging.getLogger("supply_demand")

DAY = pd.Timedelta(days=1)
STATS_START = pd.Timestamp("2015-01-01", tz="UTC")   # prima: copertura degli indirizzi exchange in costruzione (Mt.Gox ecc.)
CHART_START = pd.Timestamp("2012-01-01", tz="UTC")
WIKI_UA = "BitcoinAnalyzer/1.0 (personal research dashboard; https://github.com/; contact: btc-analyzer-research@users.noreply.github.com) httpx"


# ===================================================================== dataset (store)

def _cm_status(metrics: list[str], start: str) -> pd.DataFrame:
    """CoinMetrics community con lo stato del dato ("flash" = preliminare) della prima metrica di flusso."""
    params = {"assets": "btc", "metrics": ",".join(metrics), "frequency": "1d", "start_time": start, "page_size": 10000}
    rows, url = [], src.COINMETRICS
    while url:
        data = src._get(url, params)
        rows.extend(data.get("data", []))
        url = data.get("next_page_url")
        params = None
    df = pd.DataFrame(rows)
    df["time"] = pd.to_datetime(df["time"], utc=True).dt.normalize()
    out = pd.DataFrame({"time": df["time"]})
    for m in metrics:
        out[m] = pd.to_numeric(df.get(m), errors="coerce")
    st = df.get("SplyExNtv-status")
    out["flash"] = (st == "flash") if st is not None else False
    stt = df.get("SplyExNtv-status-time")
    out["status_time"] = pd.to_datetime(stt, utc=True, errors="coerce") if stt is not None else pd.NaT
    return out


def _exchange_refresher(old):
    # ricarica completa (2 richieste): i valori "flash" recenti possono essere rivisti
    return _cm_status(["SplyExNtv", "FlowInExNtv", "FlowOutExNtv", "IssTotNtv", "SplyCur", "PriceUSD"], "2011-01-01")


def _wiki_fetch(project: str, start: str) -> pd.DataFrame:
    end = (pd.Timestamp.now(tz="UTC") - DAY).strftime("%Y%m%d")
    url = f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/all-access/user/Bitcoin/daily/{start}/{end}"
    import httpx
    last = None
    for attempt in range(3):
        try:
            r = httpx.get(url, headers={"User-Agent": WIKI_UA, "Accept": "application/json"}, timeout=30)
            if r.status_code == 404:  # nessun dato nel periodo richiesto
                return pd.DataFrame(columns=["time", "views"])
            r.raise_for_status()
            items = r.json().get("items", [])
            df = pd.DataFrame(items)
            if df.empty:
                return pd.DataFrame(columns=["time", "views"])
            return pd.DataFrame({"time": pd.to_datetime(df["timestamp"].str[:8], format="%Y%m%d", utc=True), "views": df["views"].astype(float)})
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1 + attempt * 2)
    raise RuntimeError(f"Wikimedia non raggiungibile: {last}")


def _wiki_refresher(project: str):
    def fn(old):
        if old is not None and not old.empty:
            start = (pd.Timestamp(old["time"].max()) - 5 * DAY).strftime("%Y%m%d")
            new = _wiki_fetch(project, start)
            return store._merge(old, new)
        return _wiki_fetch(project, "20150701")
    return fn


store.register("sd_exchange", _exchange_refresher, 6 * 3600)
store.register("sd_etf", etf_flows.refresher, 3600)
store.register("sd_wiki_en", _wiki_refresher("en.wikipedia"), 6 * 3600)
store.register("sd_wiki_it", _wiki_refresher("it.wikipedia"), 6 * 3600)


# ===================================================================== helper

def _r(x, nd: int = 2):
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(f) else round(f, nd)


def _pts(s: pd.Series, nd: int = 2, daily_days: int = 365, step: int = 7) -> list[dict]:
    """Serie storica: campionata ogni `step` giorni nel passato, giornaliera negli ultimi `daily_days`."""
    s = s.dropna()
    if s.empty:
        return []
    cut = s.index[-1] - pd.Timedelta(days=daily_days)
    old, new = s[s.index < cut], s[s.index >= cut]
    if len(old):
        old = old.iloc[np.arange(len(old) - 1, -1, -step)[::-1]]
    s = pd.concat([old, new])
    return [{"time": util.ts(t), "value": _r(v, nd)} for t, v in s.items()]


@util.ttl_cache(900)
def _prices() -> pd.DataFrame:
    """Daily (close/high/low) dal 2010, stessa serie usata dal modulo Cicli."""
    def safe(n):
        try:
            return store.get(n)
        except Exception:  # noqa: BLE001
            return None
    return merged_daily(safe("daily"), safe("onchain"), safe("k_1d"))


def _fwd(close: pd.Series, h: int) -> pd.Series:
    """Rendimento % a h giorni di calendario (NaN se il futuro non è ancora disponibile)."""
    fut = close.reindex(close.index + pd.Timedelta(days=h))
    fut.index = close.index
    return (fut / close - 1) * 100


def _block(mask: pd.Series, fwd: dict[int, pd.Series], horizons=(30, 90, 180)) -> dict:
    idx = mask[mask].index
    out: dict = {"days": int(len(idx))}
    if len(idx):
        gaps = np.diff(idx.asi8) / 86_400e9 if len(idx) > 1 else np.array([])
        out["episodes"] = int(1 + (gaps > 14).sum())
        out["last"] = util.ts(idx[-1])
    else:
        out["episodes"], out["last"] = 0, None
    for h in horizons:
        r = fwd[h].reindex(idx).dropna()
        ok = len(r) >= 10
        out[f"r{h}"] = _r(r.median(), 1) if ok else None
        out[f"hit{h}"] = _r((r > 0).mean() * 100, 0) if ok else None
        out[f"n{h}"] = int(len(r))
    return out


def _cycle_legs(px: pd.DataFrame, start: pd.Timestamp) -> list[dict]:
    """Gambe di ciclo rialzo (minimo -> massimo) e ribasso (massimo -> minimo) dai massimi/minimi di ciclo."""
    tops = detect_tops(px)
    bottoms = detect_bottoms(px, tops)
    pts = sorted([(t, "top") for t in tops] + [(b, "bottom") for b in bottoms])
    legs = []
    for (a, ka), (b, _kb) in zip(pts[:-1], pts[1:]):
        legs.append({"start": a, "end": b, "kind": "ribasso" if ka == "top" else "rialzo", "ongoing": False})
    if pts:
        a, ka = pts[-1]
        legs.append({"start": a, "end": px.index[-1], "kind": "ribasso" if ka == "top" else "rialzo", "ongoing": True})
    return [lg for lg in legs if lg["end"] > start]


# ===================================================================== 1. EXCHANGE

@util.ttl_cache(6 * 3600)
def _exchange_heavy() -> dict:
    raw = store.get("sd_exchange").copy()
    raw = raw.set_index("time").sort_index()
    d = raw.dropna(subset=["SplyExNtv", "FlowInExNtv", "FlowOutExNtv"])
    d = d[d.index >= CHART_START]
    px = _prices()
    close = px["close"]
    res = d["SplyExNtv"]
    supply = d["SplyCur"].ffill()
    res_pct = res / supply * 100
    net = d["FlowInExNtv"] - d["FlowOutExNtv"]
    net7, net30, net90 = (net.rolling(n, min_periods=n).sum() for n in (7, 30, 90))

    s = net[net.index >= STATS_START - pd.Timedelta(days=800)]
    mu = s.shift(1).rolling(365, min_periods=180).mean()
    sd = s.shift(1).rolling(365, min_periods=180).std()
    z = ((s - mu) / sd)[lambda x: x.index >= STATS_START]
    s30 = net30[net30.index >= STATS_START - pd.Timedelta(days=800)]
    z30 = ((s30 - s30.shift(1).rolling(730, min_periods=365).mean()) / s30.shift(1).rolling(730, min_periods=365).std())
    z30 = z30[z30.index >= STATS_START]

    # ---- coerenza: variazione delle riserve vs flusso netto (stessa fonte, deve coincidere salvo rettifiche di copertura)
    gap = (res.diff() - net).dropna()
    gap = gap[gap.index >= STATS_START]
    adj = gap[gap.abs() > 1000]

    # ---- estremi (z-score giornaliero, solo storia passata)
    fwd = {h: _fwd(close, h) for h in (7, 30, 90, 180)}
    def ev(t):
        return {"time": util.ts(t), "net": _r(net[t], 0), "inflow": _r(d["FlowInExNtv"][t], 0), "outflow": _r(d["FlowOutExNtv"][t], 0),
                "z": _r(z.get(t), 2), "price": _r(close.get(t), 0), "r30": _r(fwd[30].get(t), 1), "r90": _r(fwd[90].get(t), 1)}
    zz = z.dropna()
    top_in = [ev(t) for t in _distinct(zz.sort_values(ascending=False).index, 10)]
    top_out = [ev(t) for t in _distinct(zz.sort_values().index, 10)]

    # ---- regimi del flusso netto a 30 giorni (z-score su 2 anni precedenti) e rendimenti successivi
    zones = [(-np.inf, -1.5, "deflussi_forti"), (-1.5, -0.5, "deflussi"), (-0.5, 0.5, "neutro"), (0.5, 1.5, "afflussi"), (1.5, np.inf, "afflussi_forti")]
    zr = z30.dropna()
    regimes = []
    for lo, hi, key in zones:
        m = (zr > lo) & (zr <= hi) if np.isfinite(lo) else (zr <= hi)
        regimes.append({"key": key, "lo": None if not np.isfinite(lo) else lo, "hi": None if not np.isfinite(hi) else hi,
                        **_block(m, fwd)})
    baseline = _block(pd.Series(True, index=zr.index), fwd)
    daily_big = {"outflow": _block((zz <= -2), fwd, (7, 30, 90)), "inflow": _block((zz >= 2), fwd, (7, 30, 90)),
                 "baseline": _block(pd.Series(True, index=zz.index), fwd, (7, 30, 90))}

    # ---- fasi di ciclo
    phases = []
    for lg in _cycle_legs(px, STATS_START):
        a, b = max(lg["start"], STATS_START), lg["end"]
        rr = res.loc[a:b]
        nn = net.loc[a:b]
        pp = res_pct.loc[a:b]
        if len(rr) < 30:
            continue
        phases.append({
            "kind": lg["kind"], "start": util.ts(a), "end": util.ts(b), "ongoing": lg["ongoing"], "days": int((b - a).days),
            "price_change": _r((close.asof(b) / close.asof(a) - 1) * 100, 1),
            "reserve_start": _r(rr.iloc[0], 0), "reserve_end": _r(rr.iloc[-1], 0), "reserve_change": _r(rr.iloc[-1] - rr.iloc[0], 0),
            "reserve_change_pct": _r((rr.iloc[-1] / rr.iloc[0] - 1) * 100, 1), "share_change_pt": _r(pp.iloc[-1] - pp.iloc[0], 2),
            "avg_daily_net": _r(nn.mean(), 0), "outflow_days_pct": _r((nn < 0).mean() * 100, 0),
            "start_partial": bool(lg["start"] < STATS_START),
        })

    # ---- serie per i grafici
    series = {
        "reserve": _pts(res, 0), "reserve_pct": _pts(res_pct, 3), "price": _pts(close[close.index >= CHART_START], 0),
        "net30": _pts(net30[net30.index >= STATS_START], 0),
        "net90": _pts(net90[net90.index >= STATS_START], 0), "z30": _pts(z30, 2),
    }
    last2y = net[net.index >= net.index[-1] - pd.Timedelta(days=365)]
    series["net_daily"] = [{"time": util.ts(t), "value": _r(v, 0)} for t, v in last2y.items()]
    wk = net[net.index >= STATS_START].resample("W-MON", label="left", closed="left").sum(min_count=1)
    series["net_weekly"] = [{"time": util.ts(t), "value": _r(v, 0)} for t, v in wk.items()]

    return {"d": d, "res": res, "res_pct": res_pct, "net": net, "net7": net7, "net30": net30, "net90": net90, "z": z, "z30": z30,
            "close": close, "series": series, "top_in": top_in, "top_out": top_out, "regimes": regimes, "baseline": baseline,
            "daily_big": daily_big, "phases": phases, "gap": gap, "adj": adj, "raw": raw}


def _distinct(idx, n: int, gap_days: int = 10) -> list:
    """Primi n timestamp di un indice ordinato, separati da almeno gap_days (un evento = un episodio)."""
    out: list = []
    for t in idx:
        if all(abs((t - o).days) >= gap_days for o in out):
            out.append(t)
        if len(out) >= n:
            break
    return out


def build_exchanges() -> dict:
    h = _exchange_heavy()
    d, res, res_pct, net, close = h["d"], h["res"], h["res_pct"], h["net"], h["close"]
    last = d.index[-1]

    def chg(s, days):
        prev = s[s.index <= last - pd.Timedelta(days=days)]
        return float(s.iloc[-1] - prev.iloc[-1]) if len(prev) else None

    # minimo dal… (ultima data con riserve inferiori a oggi)
    lower = res[(res < res.iloc[-1]) & (res.index < last - pd.Timedelta(days=30))]
    lowest_since = util.ts(lower.index[-1]) if len(lower) else None
    zr = h["z30"].dropna()
    zcur = float(zr.iloc[-1]) if len(zr) else None
    regime = next((r["key"] for r in h["regimes"] if (r["lo"] is None or zcur > r["lo"]) and (r["hi"] is None or zcur <= r["hi"])), None) if zcur is not None else None
    flash_recent = d["status_time"].iloc[-1] if "status_time" in d else None
    raw = h["raw"]

    recent = []
    for t in d.index[-30:][::-1]:
        recent.append({"time": util.ts(t), "inflow": _r(d.at[t, "FlowInExNtv"], 0), "outflow": _r(d.at[t, "FlowOutExNtv"], 0),
                       "net": _r(net[t], 0), "reserve": _r(res[t], 0), "z": _r(h["z"].get(t), 2), "flash": bool(d.at[t, "flash"]) if "flash" in d else True})

    def check_day(day: str):
        t = pd.Timestamp(day, tz="UTC")
        return {"inflow": _r(d.at[t, "FlowInExNtv"], 0), "outflow": _r(d.at[t, "FlowOutExNtv"], 0), "net": _r(net[t], 0)} if t in d.index else None

    iss = raw["IssTotNtv"].dropna()
    iss30 = float(iss.iloc[-30:].mean()) if len(iss) else None
    gap = h["gap"]
    checks = {
        "black_thursday": {"date": util.ts(pd.Timestamp("2020-03-13", tz="UTC")), "expected_inflow": 191_000, **(check_day("2020-03-13") or {})},
        "ftx": {"date": util.ts(pd.Timestamp("2022-11-10", tz="UTC")), "expected_net": -34_800, **(check_day("2022-11-10") or {})},
        "identity_days": int(len(gap)), "identity_ok_pct": _r((gap.abs() < 1).mean() * 100, 1),
        "adjustments": int(len(h["adj"])), "adjustment_btc": _r(h["adj"].sum(), 0),
        "adjustments_list": [{"time": util.ts(t), "btc": _r(v, 0)} for t, v in h["adj"].abs().sort_values(ascending=False).head(5).items()],
        "flash_rows_pct": _r(d["flash"].mean() * 100, 0) if "flash" in d else None,
        "issuance_30d_avg": _r(iss30, 1),
    }
    return util.clean({
        "as_of": util.ts(last),
        "flash_computed_at": util.ts(flash_recent) if flash_recent is not None and pd.notna(flash_recent) else None,
        "kpi": {
            "reserve": _r(res.iloc[-1], 0), "reserve_pct": _r(res_pct.iloc[-1], 3),
            "reserve_change_30d": _r(chg(res, 30), 0), "reserve_change_365d": _r(chg(res, 365), 0),
            "reserve_change_365d_pct": _r((res.iloc[-1] / res[res.index <= last - pd.Timedelta(days=365)].iloc[-1] - 1) * 100, 2),
            "share_change_365d_pt": _r(chg(res_pct, 365), 3),
            "net_1d": _r(net.iloc[-1], 0), "z_1d": _r(h["z"].iloc[-1], 2),
            "net_7d": _r(h["net7"].iloc[-1], 0), "net_30d": _r(h["net30"].iloc[-1], 0), "net_90d": _r(h["net90"].iloc[-1], 0),
            "z_30d": _r(zcur, 2), "regime": regime, "lowest_since": lowest_since,
            "reserve_ath": _r(res.max(), 0), "reserve_ath_time": util.ts(res.idxmax()),
            "inflow_1d": _r(d["FlowInExNtv"].iloc[-1], 0), "outflow_1d": _r(d["FlowOutExNtv"].iloc[-1], 0),
            "price": _r(close.iloc[-1], 0),
        },
        "series": h["series"],
        "recent": recent,
        "extremes": {"inflows": h["top_in"], "outflows": h["top_out"]},
        "regimes": {"since": util.ts(h["z30"].dropna().index[0]), "rows": h["regimes"], "baseline": h["baseline"], "daily": h["daily_big"]},
        "phases": h["phases"],
        "checks": checks,
        "stats_since": util.ts(STATS_START),
    })


# ===================================================================== 2. ETF

def _price_ny16(dates: pd.DatetimeIndex) -> pd.Series:
    """Prezzo BTC alle 16:00 di New York (chiusura NAV) per ogni data: close della candela 1h Binance che termina alle 16:00 ET;
    fallback = chiusura giornaliera UTC."""
    out = pd.Series(np.nan, index=dates)
    try:
        k = store.get("k_1h")
        k = k[k["time"] >= dates.min() - 2 * DAY].set_index("time")["close"]
        opens = [pd.Timestamp(t.strftime("%Y-%m-%d") + " 15:00", tz="America/New_York").tz_convert("UTC") for t in dates]
        vals = k.reindex(pd.DatetimeIndex(opens)).to_numpy()
        out[:] = vals
    except Exception as e:  # noqa: BLE001
        log.warning("prezzi orari non disponibili: %s", e)
    if out.isna().any():
        close = _prices()["close"]
        out = out.fillna(close.reindex(dates))
    return out


@util.ttl_cache(3600)
def _etf_heavy() -> dict:
    raw = store.get("sd_etf").copy()
    meta = etf_flows.load_meta()
    issuers = [c for c in (meta.get("issuers") or []) if c in raw.columns] or \
        [c for c in raw.columns if c not in ("time", "total_reported", "n_dash")]
    raw["time"] = pd.to_datetime(raw["time"], utc=True)
    raw = raw.set_index("time").sort_index()
    vals = raw[issuers]
    # giorni di borsa chiusa / oggi senza dati: tutte le celle "-"
    has = vals.notna().any(axis=1)
    df = raw[has].copy()
    vals = df[issuers]
    total = vals.sum(axis=1, min_count=1).fillna(0.0)
    mismatch = int(((total - df["total_reported"]).abs() > 0.15).sum())
    px16 = _price_ny16(df.index)
    btc = vals.div(px16, axis=0) * 1e6
    btc_total = total / px16 * 1e6

    # emittenti attivi: già con un dato prima dell'ultima riga -> la riga è parziale se manca un loro dato
    last_t = df.index[-1]
    started = vals.iloc[:-1].notna().any()
    missing_last = [c for c in issuers if started.get(c, False) and pd.isna(vals.at[last_t, c])]

    # ---- assorbimento: BTC ETF vs BTC emessi dai miner
    ex = store.get("sd_exchange").set_index("time").sort_index()
    iss = ex["IssTotNtv"].dropna()
    iss = iss[iss.index >= etf_flows.LAUNCH]
    cal = pd.date_range(etf_flows.LAUNCH, max(iss.index[-1], last_t), freq="D", tz="UTC")
    etf_cal = btc_total.reindex(cal).fillna(0.0)
    iss_cal = iss.reindex(cal)
    # il rapporto si calcola solo sui giorni in cui l'emissione è nota (CoinMetrics +1 g)
    known = iss_cal.notna()
    roll_e = etf_cal.where(known).rolling(30, min_periods=25).sum()
    roll_i = iss_cal.rolling(30, min_periods=25).sum()
    ratio30 = (roll_e / roll_i).where(known)

    def agg(freq: str, label: str):
        e = etf_cal.where(known).resample(freq, label="left", closed="left").sum(min_count=1)
        i = iss_cal.resample(freq, label="left", closed="left").sum(min_count=1)
        n_known = known.resample(freq, label="left", closed="left").sum()
        n_all = known.resample(freq, label="left", closed="left").count()
        u = total.reindex(cal).fillna(0).where(known).resample(freq, label="left", closed="left").sum(min_count=1)
        rows = []
        for t in e.index:
            ii = i.get(t)
            rows.append({"time": util.ts(t), "etf_btc": _r(e.get(t), 0), "issued_btc": _r(ii, 0), "etf_usd": _r(u.get(t), 1),
                         "ratio": _r(e.get(t) / ii, 2) if ii and np.isfinite(ii) and ii > 0 and pd.notna(e.get(t)) else None,
                         "complete": bool(n_known.get(t, 0) == n_all.get(t, 0) and t + pd.tseries.frequencies.to_offset(freq) <= cal[-1] + DAY)})
        return rows

    weekly = agg("W-MON", "w")
    monthly = agg("MS", "m")

    # ---- serie di striscia (giorni consecutivi con flusso totale dello stesso segno)
    sign = np.sign(total.round(1))
    streaks = []
    cur = None
    for t, sgn in sign.items():
        if sgn == 0:
            cur = None
            continue
        if cur and cur["sign"] == sgn:
            cur["end"] = t
            cur["days"] += 1
            cur["usd"] += total[t]
        else:
            cur = {"sign": sgn, "start": t, "end": t, "days": 1, "usd": total[t]}
            streaks.append(cur)

    def sfmt(s):
        return None if s is None else {"sign": int(s["sign"]), "start": util.ts(s["start"]), "end": util.ts(s["end"]), "days": s["days"],
                                       "usd": _r(s["usd"], 1), "btc": _r(btc_total.loc[s["start"]:s["end"]].sum(), 0)}
    longest_in = max((s for s in streaks if s["sign"] > 0), key=lambda s: (s["days"], s["usd"]), default=None)
    longest_out = max((s for s in streaks if s["sign"] < 0), key=lambda s: (s["days"], -s["usd"]), default=None)
    current = streaks[-1] if streaks and streaks[-1]["end"] == last_t else None

    # ---- reazione del prezzo dopo grandi flussi (rendimenti calendario dalla chiusura del giorno)
    close = _prices()["close"]
    fwd = {h: _fwd(close, h) for h in (7, 30, 90)}
    big = {}
    for key, m in (("big_in", total >= 500), ("big_out", total <= -500), ("all", pd.Series(True, index=total.index))):
        idx = total.index[m.to_numpy()]
        blk = {"days": int(len(idx))}
        for hh in (7, 30, 90):
            r = fwd[hh].reindex(idx).dropna()
            blk[f"r{hh}"] = _r(r.median(), 1) if len(r) >= 5 else None
            blk[f"hit{hh}"] = _r((r > 0).mean() * 100, 0) if len(r) >= 5 else None
            blk[f"n{hh}"] = int(len(r))
        big[key] = blk

    return {"df": df, "issuers": issuers, "vals": vals, "total": total, "btc": btc, "btc_total": btc_total, "px16": px16,
            "mismatch": mismatch, "missing_last": missing_last, "ratio30": ratio30, "weekly": weekly, "monthly": monthly,
            "longest_in": sfmt(longest_in), "longest_out": sfmt(longest_out), "current": sfmt(current), "big": big, "meta": meta,
            "iss": iss, "etf_cal": etf_cal}


def build_etf() -> dict:
    h = _etf_heavy()
    df, issuers, vals, total, btc, btc_total, px16 = h["df"], h["issuers"], h["vals"], h["total"], h["btc"], h["btc_total"], h["px16"]
    last_t = df.index[-1]
    cum_usd = total.cumsum()
    cum_btc = btc_total.cumsum()

    def tail_sum(s, n):
        return _r(s.iloc[-n:].sum(), 1)

    # tabella emittenti
    rows = []
    for c in issuers:
        v = vals[c]
        first = v.first_valid_index()
        rows.append({
            "ticker": c, "first": util.ts(first) if first is not None else None,
            "cum_usd": _r(v.sum(), 1), "cum_btc": _r(btc[c].sum(), 0),
            "last": _r(v.iloc[-1], 1), "d5": _r(v.iloc[-5:].sum(min_count=1), 1), "d30": _r(v.iloc[-21:].sum(min_count=1), 1),
            "max_in": _r(v.max(), 1), "max_in_time": util.ts(v.idxmax()) if v.notna().any() else None,
            "max_out": _r(v.min(), 1), "max_out_time": util.ts(v.idxmin()) if v.notna().any() else None,
        })
    rows.sort(key=lambda r: -(r["cum_usd"] or 0))

    # dati giornalieri compatti (allineati a `dates`) per il grafico impilato
    daily = {
        "dates": [util.ts(t) for t in df.index],
        "issuers": {c: [_r(x, 1) for x in vals[c].to_numpy()] for c in issuers},
        "total": [_r(x, 1) for x in total.to_numpy()],
        "btc": [_r(x, 0) for x in btc_total.to_numpy()],
        "cum_usd": [_r(x, 0) for x in cum_usd.to_numpy()],
        "cum_btc": [_r(x, 0) for x in cum_btc.to_numpy()],
        "price": [_r(x, 0) for x in px16.to_numpy()],
    }
    recent = []
    for t in df.index[-20:][::-1]:
        recent.append({"time": util.ts(t), "total": _r(total[t], 1), "btc": _r(btc_total[t], 0), "price": _r(px16[t], 0),
                       "by": {c: _r(vals.at[t, c], 1) for c in issuers}, "provisional": bool(t == last_t)})

    meta = h["meta"]
    d1 = df.iloc[0]
    iss = h["iss"]
    r30 = h["ratio30"].dropna()
    known_vals = [  # valori pubblicati all'epoca (stampa finanziaria / Farside) per il controllo incrociato
        ("2024-01-11", "Total", 655.3), ("2024-03-12", "Total", 1045.0), ("2024-03-18", "GBTC", -642.5), ("2024-11-07", "IBIT", 1119.9),
    ]
    known = []
    for dd, col, exp in known_vals:
        t = pd.Timestamp(dd, tz="UTC")
        obs = (total.get(t) if col == "Total" else (vals.at[t, col] if t in vals.index and col in vals else None))
        known.append({"date": util.ts(t), "col": col, "expected": exp, "observed": _r(obs, 1), "ok": obs is not None and abs(float(obs) - exp) < 0.6})

    # stima in BTC verificata su IBIT (nessuna dotazione iniziale): detenzioni pubblicate da BlackRock a fine 2024 ≈ 552K BTC
    ib = btc["IBIT"].loc[:"2024-12-31"].sum() if "IBIT" in btc else None
    ibit_check = {"date": util.ts(pd.Timestamp("2024-12-31", tz="UTC")), "estimate": _r(ib, 0), "published": 552_000,
                  "ok": bool(ib is not None and abs(ib / 552_000 - 1) < 0.02)}
    last_iss_t = iss.index[-1] if len(iss) else None
    out = {
        "as_of": util.ts(last_t),
        "provisional": True,                         # l'ultima riga è sempre provvisoria finché non arriva la seduta successiva
        "partial_issuers": h["missing_last"],        # emittenti attivi senza dato nell'ultima riga
        "source": {"name": "Farside Investors", "url": etf_flows.URL_ALL, "mode": meta.get("source", "all"),
                   "fetched_at": int(meta["fetched_at"]) if meta.get("fetched_at") else None, "error": meta.get("error"),
                   "age_s": _r(store.age("sd_etf"), 0)},
        "kpi": {
            "last_usd": _r(total.iloc[-1], 1), "last_btc": _r(btc_total.iloc[-1], 0),
            "d5_usd": tail_sum(total, 5), "d5_btc": _r(btc_total.iloc[-5:].sum(), 0),
            "d20_usd": tail_sum(total, 20), "d20_btc": _r(btc_total.iloc[-20:].sum(), 0),
            "cum_usd": _r(cum_usd.iloc[-1], 0), "cum_btc": _r(cum_btc.iloc[-1], 0),
            "ratio_30d": _r(r30.iloc[-1], 2) if len(r30) else None, "ratio_30d_time": util.ts(r30.index[-1]) if len(r30) else None,
            "issued_30d": _r(iss.iloc[-30:].sum(), 0) if len(iss) else None,
            "etf_30d_btc": _r(h["etf_cal"].loc[: last_iss_t].iloc[-30:].sum(), 0) if last_iss_t is not None else None,
            "days": int(len(df)), "inflow_days_pct": _r((total > 0).mean() * 100, 0),
            "price_last": _r(px16.iloc[-1], 0),
        },
        "streaks": {"current": h["current"], "longest_in": h["longest_in"], "longest_out": h["longest_out"]},
        "issuers": rows,
        "daily": daily,
        "recent": recent,
        "absorption": {
            "ratio30": _pts(h["ratio30"], 2, daily_days=4000),
            "weekly": h["weekly"], "monthly": h["monthly"],
            "since_launch": {"etf_btc": _r(h["etf_cal"].loc[: last_iss_t].sum(), 0) if last_iss_t is not None else None,
                             "issued_btc": _r(iss.sum(), 0), "ratio": _r(h["etf_cal"].loc[: last_iss_t].sum() / iss.sum(), 2) if len(iss) else None},
            "post_halving": _post_halving(h["etf_cal"], iss),
        },
        "reaction": h["big"],
        "checks": {
            "day1_total": _r(d1["total_reported"], 1), "day1_expected": etf_flows.DAY1_TOTAL,
            "row_mismatches": h["mismatch"], "rows": int(len(df)),
            "footer_total": meta.get("footer_total"), "sum_total": _r(total.sum(), 1),
            "known": known, "ibit_2024": ibit_check,
        },
    }
    return util.clean(out)


def _post_halving(etf_cal: pd.Series, iss: pd.Series) -> dict:
    hv = pd.Timestamp("2024-04-20", tz="UTC")
    end = iss.index[-1] if len(iss) else hv
    e = etf_cal.loc[hv:end].sum()
    i = iss.loc[hv:].sum()
    return {"since": util.ts(hv), "etf_btc": _r(e, 0), "issued_btc": _r(i, 0), "ratio": _r(e / i, 2) if i else None}


# ===================================================================== 3. ATTENZIONE

@util.ttl_cache(6 * 3600)
def _attention_heavy() -> dict:
    en = store.get("sd_wiki_en").set_index("time")["views"].sort_index()
    try:
        it = store.get("sd_wiki_it").set_index("time")["views"].sort_index()
    except Exception as e:  # noqa: BLE001
        log.warning("it.wikipedia non disponibile: %s", e)
        it = pd.Series(dtype=float)
    en = en[~en.index.duplicated(keep="last")]
    ma7 = en.rolling(7, min_periods=5).mean()
    ma30 = en.rolling(30, min_periods=25).mean()
    # percentile senza lookahead: rango della media 30 g di ogni giorno tra tutti i valori fino a quel giorno
    vals = ma30.dropna()
    arr = vals.to_numpy()
    pct = np.full(len(arr), np.nan)
    for i in range(365, len(arr)):
        pct[i] = (arr[: i + 1] <= arr[i]).mean() * 100
    pct = pd.Series(pct, index=vals.index)

    px = _prices()
    close = px["close"]
    fwd = {h: _fwd(close, h) for h in (30, 90, 180)}
    zones = [(0, 20, "bassa"), (20, 50, "sotto_media"), (50, 80, "sopra_media"), (80, 95, "alta"), (95, 100.01, "estrema")]
    pc = pct.dropna()
    backtest = []
    for lo, hi, key in zones:
        m = (pc >= lo) & (pc < hi)
        backtest.append({"key": key, "lo": lo, "hi": min(hi, 100), **_block(m, fwd)})
    baseline = _block(pd.Series(True, index=pc.index), fwd)

    # picchi di attenzione intorno ai massimi di ciclo (finestra −365 / +180 giorni)
    tops = [t for t in detect_tops(px) if t >= en.index[0] + pd.Timedelta(days=180)]
    peaks = []
    for t in tops:
        w = ma30.loc[t - pd.Timedelta(days=365): t + pd.Timedelta(days=180)].dropna()
        wd = en.loc[t - pd.Timedelta(days=365): t + pd.Timedelta(days=180)].dropna()
        if w.empty:
            continue
        pk = w.idxmax()
        pkd = wd.idxmax()
        peaks.append({"top": util.ts(t), "top_price": _r(px["high"][t], 0), "peak30": util.ts(pk), "peak30_views": _r(w.max(), 0),
                      "lag30_days": int((pk - t).days), "peak_day": util.ts(pkd), "peak_day_views": _r(wd.max(), 0), "lag_day_days": int((pkd - t).days),
                      "complete": bool(t + pd.Timedelta(days=180) <= en.index[-1])})
    # giorni con più visite (episodi distinti)
    spikes = []
    for t in _distinct(en.sort_values(ascending=False).index, 10, 30):
        spikes.append({"time": util.ts(t), "views": _r(en[t], 0), "price": _r(close.get(t), 0),
                       "r30": _r(fwd[30].get(t), 1), "r90": _r(fwd[90].get(t), 1)})
    return {"en": en, "it": it, "ma7": ma7, "ma30": ma30, "pct": pct, "close": close, "backtest": backtest, "baseline": baseline,
            "peaks": peaks, "spikes": spikes}


def build_attention() -> dict:
    h = _attention_heavy()
    en, it, ma30, pct, close = h["en"], h["it"], h["ma30"], h["pct"], h["close"]
    last = en.index[-1]
    m30 = float(ma30.iloc[-1])
    prev_y = ma30[ma30.index <= last - pd.Timedelta(days=365)]
    ath30 = ma30.max()
    it30 = it.rolling(30, min_periods=25).mean() if len(it) else pd.Series(dtype=float)
    cur_pct = float(pct.iloc[-1]) if pct.notna().any() else None
    zone = next((z["key"] for z in h["backtest"] if cur_pct is not None and z["lo"] <= cur_pct < (z["hi"] if z["hi"] < 100 else 100.01)), None)
    # minimo dal… per la media 30 g
    lower = ma30[(ma30 <= m30) & (ma30.index < last - pd.Timedelta(days=60))]
    pr = close[close.index >= en.index[0]]
    out = {
        "as_of": util.ts(last),
        "kpi": {
            "views_1d": _r(en.iloc[-1], 0), "avg_30d": _r(m30, 0), "avg_7d": _r(h["ma7"].iloc[-1], 0),
            "change_365d": _r((m30 / prev_y.iloc[-1] - 1) * 100, 1) if len(prev_y) else None,
            "percentile": _r(cur_pct, 0), "zone": zone,
            "ath_30d": _r(ath30, 0), "ath_30d_time": util.ts(ma30.idxmax()), "vs_ath_pct": _r(m30 / ath30 * 100, 1),
            "ath_day": _r(en.max(), 0), "ath_day_time": util.ts(en.idxmax()),
            "it_avg_30d": _r(it30.iloc[-1], 0) if len(it30) else None, "it_ath_day_time": util.ts(it.idxmax()) if len(it) else None,
            "it_ath_day": _r(it.max(), 0) if len(it) else None,
            "lowest_since": util.ts(lower.index[-1]) if len(lower) else None,
        },
        "series": {
            "views30": _pts(ma30, 0),
            "it30": _pts(it30, 0) if len(it30) else [],
            "price": _pts(pr, 0), "percentile": _pts(pct, 1, daily_days=0),
        },
        "peaks": h["peaks"], "spikes": h["spikes"],
        "backtest": {"since": util.ts(pct.dropna().index[0]), "rows": h["backtest"], "baseline": h["baseline"]},
        "checks": {"en_peak_day": util.ts(en.idxmax()), "en_peak_views": _r(en.max(), 0),
                   "it_peak_day": util.ts(it.idxmax()) if len(it) else None, "days": int(len(en)), "first": util.ts(en.index[0])},
    }
    return util.clean(out)
