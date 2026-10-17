"""Terminale: prezzo, order flow, CVD spot/perp aggregato, OI e funding aggregati, premio Coinbase, liquidazioni, book a scala.

  GET /api/terminal/snapshot?tf&dm&ds          stato iniziale (ticker, order flow, book a scala, feed, liquidazioni, livelli stimati)
  GET /api/terminal/series?tf&from&to          pannelli a candele/barre allineati alla griglia delle candele (array colonnari)
  GET /api/terminal/status                     integrità (verifica vs kline ufficiali, recuperi, copertura, storage, CPU)
  GET /api/terminal/signals                    letture per l'agente "flow"
  GET/POST/PUT/DELETE /api/terminal/layouts    layout salvati
  WS  /api/ws/terminal                         streaming ≤ 4 msg/s (ticker, feed, order flow, barra corrente, liquidazioni, book, heatmap)
Tipi in CONTRACT.md § TERMINAL. Dati multi-exchange solo da quando l'app è accesa (Binance spot/perp anche da kline ufficiali).
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time

import numpy as np
import pandas as pd
from fastapi import APIRouter, Body, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from .. import terminal_collector as tcol
from .. import terminal_layouts as layouts
from .. import util
from ..analysis import terminal_core as tc
from ..analysis.terminal_core import GROUPS, STREAMS
from ..data import store

log = logging.getLogger("terminal")
router = APIRouter()

TF_S = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600}
MAX_BARS = 1500
DEF_BARS = {"1m": 720, "5m": 600, "15m": 600, "1h": 720}
DOM_STEPS = (0.1, 1, 5, 10, 25, 50, 100)
LIQ_MIN_USD = {"1m": 1000, "5m": 2500, "15m": 5000, "1h": 10000}
BIG_TRADE_USD = 1_000_000
LIQ_BURST_USD = 5_000_000


def _json(obj) -> Response:
    return Response(content=json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False), media_type="application/json")


def _col(a, nd: int) -> list:
    """Array -> lista JSON compatta (NaN -> null, arrotondata)."""
    out = []
    for x in a:
        if x is None:
            out.append(None)
            continue
        x = float(x)
        out.append(None if math.isnan(x) or math.isinf(x) else round(x, nd))
    return out


def _c() -> "tcol.TermCollector":
    tcol.start()
    return tcol.collector


# ============================================================================ dati al minuto (file + memoria)

def _mem_frames(t0: float, t1: float) -> dict[str, pd.DataFrame]:
    c = _c()
    with c.lock:
        tb = [(m, k, *b, m not in c.st[k].incomplete) for k in STREAMS for m, b in c.agg.bars[k].items() if t0 <= m < t1]
        tg = [(m, g, *r) for g in GROUPS for m, r in c.agg.grp[g].items() if t0 <= m < t1]
        tk = [(m, k, *v) for k in STREAMS for m, v in c.kl[k].items() if t0 <= m < t1]
        tp = [(m, r[0] / r[1], r[2], r[3], r[1]) for m, r in c.prem.items() if t0 <= m < t1 and r[1]]
        to = [r for r in c.oi if t0 <= r[0] < t1]
    return {
        "tb": pd.DataFrame(tb, columns=["t", "s", *tc.BAR_COLS, "ok"]),
        "tg": pd.DataFrame(tg, columns=["t", "g", "d", "dmax", "dmin"]),
        "tk": pd.DataFrame(tk, columns=["t", "s", "vol", "vb", "n", "c"]),
        "tp": pd.DataFrame(tp, columns=["t", "pm", "cb", "bn", "n"]),
        "to": pd.DataFrame(to, columns=["t", "oi_btc", "oi_usd", "binance", "bybit", "okx", "f8", "price"]),
    }


_frames_cache: dict = {}


def _frames(t0: float, t1: float) -> dict[str, pd.DataFrame]:
    """File giornalieri (parte già salvata) + memoria (più recente) senza duplicati. Cache 5 s."""
    key = (int(t0), int(t1 // 5))
    hit = _frames_cache.get(key)
    if hit and time.time() - hit[0] < 5:
        return hit[1]
    mem = _mem_frames(t0, t1)
    keys = {"tb": ["t", "s"], "tg": ["t", "g"], "tk": ["t", "s"], "tp": ["t"], "to": ["t"]}
    out = {}
    for kind, k in keys.items():
        f = tcol.read_days(kind, t0, t1)
        parts = [x for x in (f, mem[kind]) if len(x)]
        df = pd.concat(parts, ignore_index=True).drop_duplicates(k, keep="last") if parts else mem[kind]
        out[kind] = df.sort_values(k).reset_index(drop=True) if len(df) else df
    _frames_cache.clear()
    _frames_cache[key] = (time.time(), out)
    return out


# ============================================================================ candele Binance perp (griglia comune)

@util.ttl_cache(8)
def _perp_klines(tf: str, end_s: int | None, limit: int) -> pd.DataFrame:
    from ..data import sources as src
    p = {"symbol": "BTCUSDT", "interval": tf, "limit": limit}
    if end_s is not None:
        p["endTime"] = end_s * 1000
    rows = src._get("https://fapi.binance.com/fapi/v1/klines", p)
    return pd.DataFrame({"t": [int(r[0]) // 1000 for r in rows], "o": [float(r[1]) for r in rows], "h": [float(r[2]) for r in rows],
                         "l": [float(r[3]) for r in rows], "c": [float(r[4]) for r in rows], "v": [float(r[5]) for r in rows],
                         "tb": [float(r[9]) for r in rows]})


# ============================================================================ serie

def _group_minutes(F: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, dict]:
    """Delta per minuto e gruppo (spot/perp/all), con sostituzione dai dati kline per i minuti Binance mancanti/incompleti."""
    tb, tk, tg = F["tb"], F["tk"], F["tg"]
    cov: dict = {}
    rows = []
    if len(tb):
        ws = tb[["t", "s", "vb", "vs", "ok"]].copy()
        ws["src"] = "ws"
    else:
        ws = pd.DataFrame(columns=["t", "s", "vb", "vs", "ok", "src"])
    for k in STREAMS:
        w = ws[ws["s"] == k]
        cov[k] = {"ws_from": int(w["t"].min()) if len(w) else None}
        if k in tcol.REST:     # Binance: kline ufficiali (taker buy) dove il flusso live manca o è incompleto
            kk = tk[(tk["s"] == k) & tk["vb"].notna()] if len(tk) else tk
            cov[k]["kline_from"] = int(kk["t"].min()) if len(kk) else None
            if len(kk):
                good = set(w.loc[w["ok"].astype(bool), "t"].astype(int))
                sub = kk[~kk["t"].astype(int).isin(good)]
                if len(sub):
                    w = w[~w["t"].isin(sub["t"])]
                    rows.append(pd.DataFrame({"t": sub["t"], "s": k, "vb": sub["vb"], "vs": sub["vol"] - sub["vb"], "ok": True, "src": "kline"}))
        rows.append(w)
    allm = pd.concat([r for r in rows if len(r)], ignore_index=True) if any(len(r) for r in rows) else ws
    if not len(allm):
        return pd.DataFrame(columns=["t", "g", "d", "dmax", "dmin", "vb", "vs"]), cov
    allm["d"] = allm["vb"].astype(float) - allm["vs"].astype(float)
    allm["kl"] = (allm["src"] == "kline").astype(np.int8)
    parts = []
    for g, keys in GROUPS.items():
        sub = allm[allm["s"].isin(keys)]
        if not len(sub):
            continue
        agg = sub.groupby("t").agg(d=("d", "sum"), vb=("vb", "sum"), vs=("vs", "sum"), kl=("kl", "max")).reset_index()
        agg["kl"] = agg["kl"].astype(bool)
        agg["g"] = g
        parts.append(agg)
    G = pd.concat(parts, ignore_index=True)
    if len(tg):
        G = G.merge(tg.rename(columns={"d": "d_tg"}), on=["t", "g"], how="left")
        same = (G["d_tg"] - G["d"]).abs() <= 1e-4 + 1e-6 * G["d"].abs()
        G["dmax"] = np.where(same & ~G["kl"], G["dmax"], np.nan)
        G["dmin"] = np.where(same & ~G["kl"], G["dmin"], np.nan)
    else:
        G["dmax"] = np.nan
        G["dmin"] = np.nan
    G["dmax"] = np.fmax(G["dmax"].fillna(0.0), np.maximum(G["d"], 0.0))
    G["dmin"] = np.fmin(G["dmin"].fillna(0.0), np.minimum(G["d"], 0.0))
    return G.sort_values(["g", "t"]).reset_index(drop=True), cov


def _to_grid(t: np.ndarray, rows: list[tuple]) -> tuple[list, list, list, list]:
    idx = {int(x): i for i, x in enumerate(t)}
    o, h, l, c = ([None] * len(t) for _ in range(4))
    for bt, a, b, d, e in rows:
        i = idx.get(int(bt))
        if i is not None:
            o[i], h[i], l[i], c[i] = a, b, d, e
    return o, h, l, c


def _near(sorted_t: np.ndarray, x: float, tol: float) -> bool:
    """True se in `sorted_t` (ordinato) c'è un tempo entro ±tol da x."""
    if not len(sorted_t):
        return False
    i = int(np.searchsorted(sorted_t, x))
    return any(0 <= j < len(sorted_t) and abs(sorted_t[j] - x) <= tol for j in (i - 1, i))


def _oi_sources(t0: float, t1: float, F: dict) -> tuple[list[tuple[float, float, float | None, int]], dict]:
    """[(t, oi_btc, f8, risoluzione_s)]: campioni 30 s del collector; prima, fotografie 5 min (lev_snap); prima ancora stima a 15 min
    (OI dei contratti USDT di Binance/Bybit/OKX × fattore di scala live verso tutti i perpetui inclusi)."""
    own = F["to"]
    out: list[tuple] = []
    first_own = float(own["t"].min()) if len(own) else math.inf
    info = {"own_from": None if first_own == math.inf else first_own, "snap_from": None, "est_from": None}
    for r in own.itertuples(index=False):
        out.append((float(r.t), float(r.oi_btc), None if pd.isna(r.f8) else float(r.f8), 30))
    first = first_own
    own_t = np.sort(own["t"].to_numpy(float)) if len(own) else np.array([])
    try:
        from ..analysis import aggregate  # noqa: F401  (registra il dataset lev_snap)
        s = store.get("lev_snap")
        s = s[(s["time"] >= pd.Timestamp(t0, unit="s", tz="UTC"))].copy()
        if len(s):
            ts = s["time"].map(lambda x: x.timestamp())
            cols = [f"{e}_oi_btc" for e in ("binance", "bybit", "okx")]
            ok = s[cols].notna().all(axis=1)
            for tt, (_, r) in zip(ts[ok], s[ok].iterrows()):
                if tt >= t1 or _near(own_t, tt, 300):
                    continue
                oi = sum(float(r[c]) for c in cols)
                w = sum(float(r[f"{e}_oi_usd"]) for e in ("binance", "bybit", "okx"))
                f8 = sum(float(r[f"{e}_funding_8h"]) * float(r[f"{e}_oi_usd"]) for e in ("binance", "bybit", "okx")) / w if w else None
                out.append((float(tt), oi, f8, 300))
            snaps = [x[0] for x in out if x[3] == 300]
            if snaps:
                info["snap_from"] = min(snaps)
                first = min(first, min(snaps))
    except Exception as e:  # noqa: BLE001
        log.info("terminal: lev_snap non disponibile: %s", e)
    try:
        from ..analysis import aggregate
        ser = aggregate.oi_15m_by_exchange()
        fac = aggregate.scale_factors()
        if all(e in ser and e in fac for e in ("binance", "bybit", "okx")):
            frames = []
            for e in ("binance", "bybit", "okx"):
                d = ser[e].copy()
                d["time"] = pd.to_datetime(d["time"], utc=True)
                frames.append(d.set_index("time")["oi"].rename(e) * float(fac[e]["factor"]))
            M = pd.concat(frames, axis=1).dropna()
            M = M[(M.index >= pd.Timestamp(t0, unit="s", tz="UTC"))]
            tot = M.sum(axis=1)
            med = tot.rolling(9, center=True, min_periods=3).median()
            tot = tot[(tot / med - 1).abs() <= 0.03]
            better = np.sort(np.r_[own_t, [x[0] for x in out if x[3] == 300]])
            est = [(x.timestamp(), float(v)) for x, v in tot.items() if x.timestamp() < t1 and not _near(better, x.timestamp(), 900)]
            out += [(a, b, None, 900) for a, b in est]
            if est:
                info["est_from"] = est[0][0]
    except Exception as e:  # noqa: BLE001
        log.info("terminal: stima OI storica non disponibile: %s", e)
    out.sort()
    return out, info


def _sparse_ohlc(t: np.ndarray, tf_s: int, samples: list[tuple]) -> tuple[list, list, list, list, list]:
    """Candele dell'OI per barra dai campioni [(t, oi, f8, risoluzione_s)]. Apertura = chiusura della barra precedente (serie continua).
    Barre senza campioni ma entro la risoluzione della fonte (fotografie 5 min / stime 15 min su barre più fini): chiusura interpolata
    linearmente tra i campioni vicini; oltre la risoluzione (app spenta) la barra resta vuota. Ultimo elemento: f8 medio."""
    n = len(t)
    o, h, l, c, f = ([None] * n for _ in range(5))
    if not samples:
        return o, h, l, c, f
    st = np.array([s[0] for s in samples], float)
    sv = np.array([s[1] for s in samples], float)
    j = 0
    last = None
    prev_c = None
    for i in range(n):
        a, b = float(t[i]), float(t[i] + tf_s)
        vals, fs = [], []
        while j < len(samples) and st[j] < b:
            if st[j] >= a:
                vals.append(samples[j][1])
                if samples[j][2] is not None:
                    fs.append(samples[j][2])
            last = samples[j]
            j += 1
        if vals:
            op = prev_c if prev_c is not None else vals[0]
            o[i], h[i], l[i], c[i] = op, max(vals + [op]), min(vals + [op]), vals[-1]
            f[i] = sum(fs) / len(fs) if fs else None
            prev_c = vals[-1]
        elif last is not None and a - last[0] <= last[3]:
            nxt_ok = j < len(samples) and st[j] - last[0] <= 2 * last[3]
            cv = float(np.interp(b, [last[0], st[j]], [last[1], sv[j]])) if nxt_ok else float(last[1])
            op = prev_c if prev_c is not None else float(last[1])
            o[i], h[i], l[i], c[i] = op, max(op, cv), min(op, cv), cv
            f[i] = last[2]
            prev_c = cv
        else:
            prev_c = None
    return o, h, l, c, f


@util.ttl_cache(1800)
def _funding_hist() -> list[tuple[float, float, float]]:
    """Funding LIQUIDATO (ogni 8 h) di Binance, Bybit e OKX (BTCUSDT / BTC-USDT-SWAP) ponderato per l'OI stimato di ciascun exchange:
    [(inizio periodo, fine periodo, % su 8 h)]. Il tasso liquidato al tempo T matura nelle 8 h precedenti -> periodo [T−8h, T)."""
    from ..analysis import aggregate
    from ..data import sources as src
    rates: dict[str, dict[int, float]] = {"binance": {}, "bybit": {}, "okx": {}}
    try:
        f = store.get("funding")
        for tt, r in zip(f["time"], f["rate"]):
            rates["binance"][int(pd.Timestamp(tt).timestamp())] = float(r) * 100
    except Exception as e:  # noqa: BLE001
        log.info("terminal: funding Binance non disponibile: %s", e)
    try:
        rows = src._get("https://api.bybit.com/v5/market/funding/history", {"category": "linear", "symbol": "BTCUSDT", "limit": 200})["result"]["list"]
        for x in rows:
            rates["bybit"][int(x["fundingRateTimestamp"]) // 1000] = float(x["fundingRate"]) * 100
    except Exception as e:  # noqa: BLE001
        log.info("terminal: funding Bybit non disponibile: %s", e)
    try:
        after = None
        for _ in range(3):
            p = {"instId": "BTC-USDT-SWAP", "limit": "100"}
            if after:
                p["after"] = after
            rows = src._get("https://www.okx.com/api/v5/public/funding-rate-history", p).get("data") or []
            if not rows:
                break
            for x in rows:
                rates["okx"][int(x["fundingTime"]) // 1000] = float(x.get("realizedRate") or x["fundingRate"]) * 100
            after = rows[-1]["fundingTime"]
    except Exception as e:  # noqa: BLE001
        log.info("terminal: funding OKX non disponibile: %s", e)
    try:
        ser = aggregate.oi_15m_by_exchange()
        fac = aggregate.scale_factors()
    except Exception:  # noqa: BLE001
        ser, fac = {}, {}
    w: dict[str, pd.Series] = {}
    for e in rates:
        if e in ser and e in fac:
            d = ser[e].copy()
            w[e] = pd.Series(d["oi"].to_numpy(float) * float(fac[e]["factor"]), index=pd.to_datetime(d["time"], utc=True).map(lambda x: x.timestamp()))
    out = []
    common = set(rates["binance"]) & set(rates["bybit"]) & set(rates["okx"])
    for T in sorted(common):
        if T < time.time() - 35 * 86400:
            continue
        num = den = 0.0
        for e in rates:
            ws_ = w.get(e)
            wt = 1.0
            if ws_ is not None and len(ws_):
                i = ws_.index.searchsorted(T, side="right") - 1
                if i >= 0:
                    wt = float(ws_.iloc[i])
            num += rates[e][T] * wt
            den += wt
        if den:
            out.append((float(T - 28800), float(T), num / den))
    return out


def _premium(t: np.ndarray, tf_s: int, F: dict) -> tuple[list, dict]:
    tp, tk = F["tp"], F["tk"]
    per_min: dict[int, float] = {}
    if len(tk):
        cb = tk[tk["s"] == "coinbase_spot"].set_index("t")["c"]
        bn = tk[tk["s"] == "binance_spot"].set_index("t")["c"]
        j = (cb / bn.reindex(cb.index) - 1) * 100
        per_min.update({int(k): float(v) for k, v in j.dropna().items() if abs(v) < 5})
    kl_from = min(per_min) if per_min else None
    live_from = None
    if len(tp):
        per_min.update({int(r.t): float(r.pm) for r in tp.itertuples(index=False)})
        live_from = int(tp["t"].min())
    out: list = [None] * len(t)
    if per_min:
        s = pd.Series(per_min).sort_index()
        b = (s.index.to_numpy() // tf_s) * tf_s
        means = s.groupby(b).mean()
        idx = {int(x): i for i, x in enumerate(t)}
        for bt, v in means.items():
            i = idx.get(int(bt))
            if i is not None:
                out[i] = float(v)
    hourly_used = False
    if tf_s >= 3600 and any(v is None for v in out):
        try:
            from ..analysis import sentiment
            ph = sentiment._premium_hourly(days=45)
            hm = {int(x.timestamp()): float(v) for x, v in ph.items()}
            for i, x in enumerate(t):
                if out[i] is None and int(x) in hm:
                    out[i] = hm[int(x)]
                    hourly_used = True
        except Exception as e:  # noqa: BLE001
            log.info("terminal: premio orario non disponibile: %s", e)
    return out, {"live_from": live_from, "kline_from": kl_from, "hourly_fallback": hourly_used}


@util.ttl_cache(15)
def _liq_frame() -> pd.DataFrame:
    df = store.liquidations()
    if df.empty:
        return df
    df = df.copy()
    df["t"] = pd.to_datetime(df["time"], utc=True).map(lambda x: x.timestamp())
    return df


def build_series(tf: str = "5m", frm: float | None = None, to: float | None = None) -> dict:
    t_start = time.perf_counter()
    if tf not in TF_S:
        raise HTTPException(400, "tf non valido")
    tf_s = TF_S[tf]
    now = time.time()
    to_c = None if to is None or to >= now - tf_s else int(to)
    bars = DEF_BARS[tf] if frm is None else int(min(MAX_BARS, max(20, ((to or now) - frm) // tf_s + 1)))
    K = _perp_klines(tf, to_c, int(bars))
    if K.empty:
        raise HTTPException(503, "candele non disponibili")
    t = K["t"].to_numpy(np.int64)
    t0, t1 = float(t[0]), float(t[-1] + tf_s)
    F = _frames(t0, t1)
    G, cov = _group_minutes(F)
    cvd: dict = {}
    for g in GROUPS:
        sub = G[G["g"] == g]
        rows = tc.cvd_candles(zip(sub["t"].astype(int), sub["d"], sub["dmax"], sub["dmin"]), tf_s)
        o, h, l, c = _to_grid(t, rows)
        cvd[g] = {"o": _col(o, 3), "h": _col(h, 3), "l": _col(l, 3), "c": _col(c, 3)}
    vb = [None] * len(t)
    vs = [None] * len(t)
    al = G[G["g"] == "all"]
    if len(al):
        bb = (al["t"].astype(int) // tf_s) * tf_s
        s = al.groupby(bb)[["vb", "vs"]].sum()
        idx = {int(x): i for i, x in enumerate(t)}
        for bt, r in s.iterrows():
            i = idx.get(int(bt))
            if i is not None:
                vb[i], vs[i] = float(r.vb), float(r.vs)
    samples, oi_info = _oi_sources(t0, t1, F)
    oo, oh, ol, oc, f8 = _sparse_ohlc(t, tf_s, samples)
    f8_hist = False
    try:
        if any(v is None for v in f8):
            per = _funding_hist()
            for i, x in enumerate(t):
                if f8[i] is None:
                    k = int(np.searchsorted([p[0] for p in per], x, side="right")) - 1
                    if 0 <= k < len(per) and per[k][0] <= x < per[k][1]:
                        f8[i] = per[k][2]
                        f8_hist = True
    except Exception as e:  # noqa: BLE001
        log.info("terminal: funding storico non disponibile: %s", e)
    oi_info["f8_settled_fill"] = f8_hist
    pm, pm_info = _premium(t, tf_s, F)
    liq = {"t": [], "p": [], "u": [], "s": [], "x": []}
    L = _liq_frame()
    if len(L):
        L = L[(L["t"] >= t0) & (L["t"] < t1) & (L["usd"] >= LIQ_MIN_USD[tf])].sort_values("t").tail(4000)
        liq = {"t": _col(L["t"], 1), "p": _col(L["price"], 1), "u": _col(L["usd"], 0), "s": [1 if s == "long" else 0 for s in L["side"]],
               "x": [str(x) for x in L["exchange"]]}
    firsts = [cov[k]["ws_from"] for k in STREAMS]
    multi_from = max(firsts) if all(x is not None for x in firsts) else None
    return {
        "tf": tf, "from": t0, "to": t1, "t": t.tolist(),
        "o": _col(K["o"], 2), "h": _col(K["h"], 2), "l": _col(K["l"], 2), "c": _col(K["c"], 2), "v": _col(K["v"], 3),
        "vb": _col(vb, 3), "vs": _col(vs, 3), "cvd": cvd,
        "oi": {"o": _col(oo, 1), "h": _col(oh, 1), "l": _col(ol, 1), "c": _col(oc, 1)}, "f8": _col(f8, 5), "pm": _col(pm, 4),
        "liq": liq, "cov": cov, "multi_from": multi_from, "oi_info": oi_info, "pm_info": pm_info,
        "collection_start": (tcol.collector.meta.get("first_start") or {}), "ms": int((time.perf_counter() - t_start) * 1000),
    }


# ============================================================================ live: ticker, flow, book, barra corrente

def ticker() -> dict:
    c = _c()
    s = c.st["binance_perp"]
    tk = dict(c.tick)
    oi = c.oi_last or {}
    out = {"last": s.last_price, "last_ts": s.last_ts, "mark": tk.get("mark"), "index": tk.get("index"), "funding_rate": tk.get("funding_rate"),
           "next_funding": tk.get("next_funding"), "high_24h": tk.get("high_24h"), "low_24h": tk.get("low_24h"), "vol_24h_btc": tk.get("vol_24h_btc"),
           "vol_24h_usd": tk.get("vol_24h_usd"), "change_24h": tk.get("change_24h"), "oi_btc": oi.get("oi_btc"), "oi_usd": oi.get("oi_usd"),
           "f8": oi.get("f8"), "oi_t": oi.get("t"), "premium": c.prem_last, "cb": c.st["coinbase_spot"].last_price, "bn": c.st["binance_spot"].last_price}
    with c.lock:
        past = [r for r in c.oi if r[0] <= time.time() - 3600]
    if past and oi.get("oi_btc"):
        out["oi_chg_1h"] = (oi["oi_btc"] / past[-1][1] - 1) * 100
    return out


def flow() -> dict:
    c = _c()
    now = int(time.time())
    with c.lock:
        secs = {k: {s: list(a) for s, a in v.items()} for k, v in c.secs.items() if k > now - 901}
    # finestre che terminano al secondo precedente (il secondo corrente è ancora in formazione); cov_s = secondi effettivamente raccolti
    first = c.started_at or now
    out = {}
    for m in (1, 5, 15):
        w = tc.flow_window(secs, now - 1, m * 60)
        w["win_s"] = m * 60
        w["cov_s"] = int(min(m * 60, max(0, now - 1 - first)))
        out[f"w{m}"] = w
    return out


def dom(market: str = "futures", step: float = 10, n: int = 30) -> dict | None:
    """Book a scala dal book locale Binance di app/ob_collector.py (aggregazione `step` $)."""
    from .. import ob_collector as obc
    mk = obc.collector.markets.get(market)
    if mk is None or not mk.book.synced:
        return {"market": market, "synced": False}
    for _ in range(3):
        try:
            bids = list(mk.book.bids.items())
            asks = list(mk.book.asks.items())
            break
        except RuntimeError:     # dizionario modificato dal thread del book durante la copia
            continue
    else:
        return None
    if not bids or not asks:
        return {"market": market, "synced": False}
    bb, ba = max(p for p, _ in bids), min(p for p, _ in asks)
    span = step * n * 1.5
    B = tc.aggregate_book(((p, q) for p, q in bids if p >= bb - span), step, True, n)
    A = tc.aggregate_book(((p, q) for p, q in asks if p <= ba + span), step, False, n)
    return {"market": market, "synced": True, "step": step, "bb": bb, "ba": ba, "bids": B, "asks": A, "t": time.time()}


def bar_now(tf: str) -> dict:
    """Barra in formazione del timeframe: delta dei gruppi relativo all'apertura (d, max, min), OI, funding, premio."""
    c = _c()
    tf_s = TF_S.get(tf, 300)
    now = time.time()
    bt = int(now // tf_s) * tf_s
    out: dict = {"tf": tf, "t": bt, "cvd": {}}
    with c.lock:
        for g in GROUPS:
            mins = sorted((m, *r) for m, r in c.agg.grp[g].items() if bt <= m < bt + tf_s)
            d, hi, lo = tc.bar_delta_stats(mins)
            out["cvd"][g] = [round(d, 4), round(hi, 4), round(lo, 4)]
        bars = [b for m, b in c.agg.bars["binance_perp"].items() if bt <= m < bt + tf_s]
        out["v"] = round(sum(b[tc.I_VB] + b[tc.I_VS] for b in bars), 4) if bars else None
        vb = sum(b[tc.I_VB] for k in STREAMS for m, b in c.agg.bars[k].items() if bt <= m < bt + tf_s)
        vs = sum(b[tc.I_VS] for k in STREAMS for m, b in c.agg.bars[k].items() if bt <= m < bt + tf_s)
        out["vb"], out["vs"] = round(vb, 4), round(vs, 4)
        oi = [r for r in c.oi if r[0] >= bt]
        prem = [r for m, r in c.prem.items() if bt <= m < bt + tf_s and r[1]]
    if oi:
        v = [r[1] for r in oi]
        out["oi"] = [round(v[0], 1), round(max(v), 1), round(min(v), 1), round(v[-1], 1)]
        f = [r[6] for r in oi if r[6] is not None]
        out["f8"] = round(sum(f) / len(f), 6) if f else None
    if prem:
        out["pm"] = round(sum(r[0] for r in prem) / sum(r[1] for r in prem), 5)
    return out


@util.ttl_cache(300)
def est_levels() -> list[dict]:
    """Livelli di liquidazione STIMATI (modello di app/analysis/liquidations.py): cluster entro ±8% dal prezzo."""
    try:
        from ..analysis import liquidations as lq
        cl, _ = lq.clusters(lq.model(), n_top=24, max_dist=8.0)
        return [{"price": round(x["price"], 1), "usd": round(x["usd"]), "side": x["side"], "distance": round(x["distance"], 3)} for x in cl]
    except Exception as e:  # noqa: BLE001
        log.info("terminal: livelli stimati non disponibili: %s", e)
        return []


def _streams_brief() -> dict:
    c = _c()
    now = time.time()
    return {k: {"c": s.connected, "age": round(now - s.last_recv, 1) if s.last_recv else None} for k, s in c.st.items()}


def build_snapshot(tf: str = "5m", dm: str = "futures", ds: float = 10) -> dict:
    c = _c()
    with c.lock:
        feed = list(c.feed)[-200:]
        liqs = [x for x in c.liqs if x["t"] >= time.time() - 86400][-150:]
        fseq, lseq = c.feed_seq, c.liq_seq
    if len(liqs) < 20:   # appena avviato: ultime liquidazioni dal parquet
        L = _liq_frame()
        if len(L):
            L = L[L["t"] >= time.time() - 86400].sort_values("t").tail(100)
            liqs = [{"k": 0, "t": float(r.t), "side": r.side, "price": float(r.price), "qty": float(r.qty), "usd": float(r.usd), "ex": r.exchange,
                     "sym": r.symbol} for r in L.itertuples(index=False)] + [x for x in liqs]
    return util.clean({
        "time": time.time(), "ticker": ticker(), "flow": flow(), "dom": dom(dm, ds if ds in DOM_STEPS else 10), "feed": feed, "feed_seq": fseq,
        "liqs": liqs, "liq_seq": lseq, "est": est_levels(), "bar": bar_now(tf), "streams": _streams_brief(),
        "cfg": {"streams": {k: {**v} for k, v in STREAMS.items()}, "large_usd": tc.LARGE_USD, "feed_min_usd": tcol.FEED_MIN_USD,
                "dom_steps": list(DOM_STEPS), "tfs": list(TF_S), "okx_ct_val": c.okx_ct_val, "enabled": tcol.ENABLED},
    })


# ============================================================================ integrità

def _pstats(vals: list[float]) -> dict:
    if not vals:
        return {"n": 0}
    a = np.abs(np.array(vals, np.float64))
    return {"n": len(a), "median_abs": float(np.median(a)), "p95_abs": float(np.percentile(a, 95)), "max_abs": float(a.max()),
            "within_1": float((a < 1.0).mean())}


_size_hist: list[tuple[float, int]] = []


def _storage() -> dict:
    files = list(tcol.ROOT.glob("*.parquet"))
    total = sum(f.stat().st_size for f in files)
    by: dict[str, int] = {}
    for f in files:
        k = f.stem.split("_", 1)[0]
        by[k] = by.get(k, 0) + f.stat().st_size
    now = time.time()
    _size_hist.append((now, total - by.get("tk", 0)))
    del _size_hist[:-500]
    old = next(((a, b) for a, b in _size_hist if 1800 <= now - a <= 6 * 3600), None)
    rate = (total - by.get("tk", 0) - old[1]) / (now - old[0]) * 86400 / 1e6 if old else None
    # stima indipendente: byte di oggi (tb+tg+tp+to) / ore trascorse × 24
    today = tcol._day(now)
    b_today = sum(f.stat().st_size for f in files if f.stem.endswith(today) and not f.stem.startswith("tk"))
    hours = (now % 86400) / 3600
    est = b_today / max(hours, 0.25) * 24 / 1e6 if b_today else None
    return {"total_mb": round(total / 1e6, 2), "files": len(files), "by_kind_mb": {k: round(v / 1e6, 3) for k, v in by.items()},
            "mb_per_day": round(rate, 2) if rate else (round(est, 2) if est else None), "retention_days": tcol.RETENTION_DAYS}


def build_status() -> dict:
    c = _c()
    now = time.time()
    out: dict = {"time": now, "enabled": tcol.ENABLED, "cpu": c.cpu, "streams": {}, "okx_ct": c.okx_ct_verified, "premium_check": c.prem_check,
                 "backfill": c.backfill_info, "storage": _storage(), "flush_ms_p50": sorted(c.flush_ms)[len(c.flush_ms) // 2] if c.flush_ms else None,
                 "collection_start": c.meta.get("first_start") or {}, "large_usd": tc.LARGE_USD}
    try:
        from .orderbook import _rss_mb
        out["rss_mb"] = _rss_mb()
    except Exception:  # noqa: BLE001
        out["rss_mb"] = None
    for k, s in c.st.items():
        kc = list(c.kchecks[k].values())
        lat = sorted(s.latency_ms)
        ses = ((c.meta.get("sessions") or {}).get(k) or [])[-10:]
        out["streams"][k] = {
            **STREAMS[k], "connected": s.connected, "msgs": s.msgs, "trades": s.trades, "dupes": s.dupes, "reconnects": s.reconnects,
            "last_age_s": round(now - s.last_recv, 1) if s.last_recv else None, "last_price": s.last_price,
            "latency_ms_p50": round(lat[len(lat) // 2], 1) if lat else None,
            "incomplete_minutes": len(s.incomplete), "id_check": s.check_ids,
            "recoveries": {"n": len(s.recoveries), "ok": sum(1 for r in s.recoveries if r.get("ok")), "new": sum(r.get("new", 0) for r in s.recoveries),
                           "last": list(s.recoveries)[-3:]},
            "kline_check": {**_pstats([x["diff_pct"] for x in kc]), "buy": _pstats([x["buy_diff_pct"] for x in kc if "buy_diff_pct" in x]),
                            "last": sorted(kc, key=lambda x: x["t"])[-3:]},
            "first_start": (c.meta.get("first_start") or {}).get(k), "sessions": ses,
        }
    return util.clean(out)


# ============================================================================ segnali (agente "flow")

def build_signals() -> dict:
    c = _c()
    now = time.time()
    m_now = int(now // 60) * 60
    out: dict = {"time": now}
    with c.lock:
        grp = {g: {m: r[0] for m, r in c.agg.grp[g].items() if m_now - 3600 <= m < m_now} for g in GROUPS}
        vol = {g: sum(b[tc.I_VB] + b[tc.I_VS] for k in GROUPS[g] for m, b in c.agg.bars[k].items() if m_now - 3600 <= m < m_now) for g in ("spot", "perp")}
        perp = sorted((m, b) for m, b in c.agg.bars["binance_perp"].items() if m_now - 3600 <= m < m_now)
        mins = {m: [0.0, 0.0] for m in range(m_now - 900, m_now, 60)}
        for k in STREAMS:
            for m, b in c.agg.bars[k].items():
                if m in mins:
                    mins[m][0] += b[tc.I_QB]; mins[m][1] += b[tc.I_QS]
        big = [x for x in c.feed if not x["a"] and x["u"] >= BIG_TRADE_USD and x["t"] >= (now - 300) * 1000]
        liqs = [x for x in c.liqs if x["t"] >= now - 300]
        n_live = sum(1 for s in c.st.values() if s.connected)
    out["streams_live"] = n_live
    cover = min(len(grp["spot"]), len(grp["perp"]))
    if cover >= 30 and perp:
        sp, pp = sum(grp["spot"].values()), sum(grp["perp"].values())
        p0, p1 = perp[0][1][tc.I_O], perp[-1][1][tc.I_C]
        chg = (p1 / p0 - 1) * 100 if p0 else 0.0
        ss = sp / vol["spot"] if vol["spot"] else 0.0
        ps = pp / vol["perp"] if vol["perp"] else 0.0
        div = None
        if (sp > 0) != (pp > 0) and abs(ss) >= 0.05 and abs(ps) >= 0.03:
            div = "spot_buy_perp_sell" if sp > 0 else "spot_sell_perp_buy"
        out["cvd"] = {"minutes": cover, "spot": sp, "perp": pp, "spot_vol": vol["spot"], "perp_vol": vol["perp"], "spot_share": ss, "perp_share": ps,
                      "price_change_pct": chg, "divergence": div}
    tot = [(m, b, s) for m, (b, s) in sorted(mins.items()) if b + s > 0]
    if len(tot) >= 12:
        shares = [b / (b + s) for _, b, s in tot]
        mean = sum(b for _, b, _ in tot) / sum(b + s for _, b, s in tot)
        nb = sum(1 for x in shares if x > 0.5)
        pers = "buy" if mean >= 0.58 and nb >= 0.73 * len(shares) else "sell" if mean <= 0.42 and (len(shares) - nb) >= 0.73 * len(shares) else None
        out["imbalance"] = {"minutes": len(shares), "buy_share": mean, "minutes_buy": nb, "persistent": pers,
                            "delta_usd": sum(b - s for _, b, s in tot)}
    out["large"] = {"n": len(big), "usd": sum(x["u"] for x in big), "buy_usd": sum(x["u"] for x in big if x["b"]),
                    "max": max(big, key=lambda x: x["u"]) if big else None, "threshold": BIG_TRADE_USD}
    lu = sum(x["usd"] for x in liqs if x["side"] == "long")
    su = sum(x["usd"] for x in liqs if x["side"] == "short")
    out["liq5"] = {"long_usd": lu, "short_usd": su, "n": len(liqs), "burst": "long" if lu >= LIQ_BURST_USD and lu >= su else "short" if su >= LIQ_BURST_USD else None,
                   "threshold": LIQ_BURST_USD, "max": max(liqs, key=lambda x: x["usd"]) if liqs else None}
    return util.clean(out)


# ============================================================================ endpoint

@router.get("/terminal/snapshot")
def terminal_snapshot(tf: str = "5m", dm: str = "futures", ds: float = 10):
    return build_snapshot(tf, dm, ds)


@router.get("/terminal/series")
def terminal_series(tf: str = "5m", frm: float | None = Query(None, alias="from"), to: float | None = None):
    try:
        return _json(build_series(tf, frm, to))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("terminal series %s: %s", tf, e)
        raise HTTPException(503, "serie non disponibili") from e


@router.get("/terminal/status")
def terminal_status():
    return build_status()


@router.get("/terminal/signals")
def terminal_signals():
    return build_signals()


@router.post("/terminal/debug/{action}")
def terminal_debug(action: str, stream: str = "binance_perp"):
    """Solo con TERMINAL_DEBUG=1: disconnessione simulata di uno stream (test di recupero e assenza di doppi conteggi) o flush."""
    if not tcol.DEBUG:
        raise HTTPException(404, "non disponibile")
    c = _c()
    if action == "close":
        if stream not in STREAMS:
            raise HTTPException(400, "stream sconosciuto")
        c.force_close.add(stream)
    elif action == "flush":
        c.flush()
    else:
        raise HTTPException(400, "azione sconosciuta")
    return {"ok": True}


@router.get("/terminal/layouts")
def get_layouts():
    return util.clean({"layouts": layouts.list_layouts()})


@router.post("/terminal/layouts")
def post_layout(body: dict = Body(...)):
    try:
        return util.clean(layouts.create(body.get("name"), body.get("state")))
    except layouts.LayoutError as e:
        raise HTTPException(400, str(e)) from e


@router.put("/terminal/layouts/{lid}")
def put_layout(lid: str, body: dict = Body(...)):
    try:
        return util.clean(layouts.update(lid, body.get("name"), body.get("state")))
    except layouts.LayoutError as e:
        raise HTTPException(400, str(e)) from e
    except KeyError as e:
        raise HTTPException(404, "layout non trovato") from e


@router.delete("/terminal/layouts/{lid}")
def delete_layout(lid: str):
    try:
        layouts.delete(lid)
    except KeyError as e:
        raise HTTPException(404, "layout non trovato") from e
    return {"ok": True}


# ============================================================================ WebSocket

@router.websocket("/ws/terminal")
async def terminal_ws(ws: WebSocket):
    await ws.accept()
    c = _c()
    qp = ws.query_params
    st = {"tf": qp.get("tf") or "5m", "dm": qp.get("dm") or "futures", "ds": float(qp.get("ds") or 10), "dn": int(qp.get("dn") or 30),
          "hm": qp.get("hm", "1") == "1", "hb": int(qp.get("hb") or 10), "hr": float(qp.get("hr") or 1.0)}
    with c.lock:
        last_feed = c.feed_seq
        last_liq = c.liq_seq
    hm_since = time.time() - 1.5
    last_sec = 0
    last_dom_sig = None
    last_status = 0.0

    async def reader():
        while True:
            data = json.loads(await ws.receive_text())
            for k in ("tf", "dm", "ds", "dn", "hm", "hb", "hr"):
                if k in data:
                    st[k] = data[k]

    rtask = asyncio.create_task(reader())
    try:
        while True:
            await asyncio.sleep(0.25)          # ≤ 4 messaggi al secondo
            if rtask.done():
                break
            now = time.time()
            msg: dict = {"type": "term", "time": now}
            with c.lock:
                if c.feed_seq > last_feed:
                    items = [x for x in list(c.feed)[-120:] if x["k"] > last_feed]
                    msg["trades"] = items[-80:]
                    last_feed = c.feed_seq
                if c.liq_seq > last_liq:
                    msg["liqs"] = [x for x in list(c.liqs)[-50:] if x["k"] > last_liq]
                    last_liq = c.liq_seq
            msg["px"] = c.st["binance_perp"].last_price
            sec = int(now)
            if sec != last_sec:                # 1/s: ticker, order flow, barra corrente, colonna heatmap
                last_sec = sec
                msg["ticker"] = ticker()
                msg["flow"] = await asyncio.to_thread(flow)
                msg["bar"] = bar_now(str(st["tf"]))
                if st["hm"]:
                    try:
                        from .. import ob_collector as obc
                        from .orderbook import _live_cols
                        mk = obc.collector.markets.get("futures")
                        if mk is not None:
                            cols, hm_since = _live_cols(mk, hm_since, int(st["hb"]), float(st["hr"]))
                            if cols:
                                msg["hm"] = cols
                    except Exception as e:  # noqa: BLE001
                        log.debug("terminal hm: %s", e)
            d = await asyncio.to_thread(dom, str(st["dm"]), float(st["ds"]) if float(st["ds"]) in DOM_STEPS else 10, int(min(60, max(5, int(st["dn"])))))
            if d is not None:
                sig = (d.get("market"), d.get("step"), d.get("bb"), d.get("ba"), str(d.get("bids", [])[:12]), str(d.get("asks", [])[:12]))
                if sig != last_dom_sig:
                    last_dom_sig = sig
                    msg["dom"] = d
            if now - last_status >= 5:
                last_status = now
                msg["streams"] = _streams_brief()
            await ws.send_text(json.dumps(util.clean(msg), separators=(",", ":")))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        rtask.cancel()
