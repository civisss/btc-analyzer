"""Router MARKET: /overview, /candles, /indicators, /levels."""
from __future__ import annotations

import logging
import threading
import time

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..analysis import market as ta
from ..data import sources as src
from ..data import store

log = logging.getLogger("market")
router = APIRouter()

TF_DATASET = {"15m": "fut_15m", "1h": "k_1h", "4h": "k_4h", "1d": "k_1d", "1w": "k_1w"}
TF_SECONDS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}
WARMUP = 600


def _check_tf(tf: str) -> str:
    if tf not in TF_DATASET:
        raise HTTPException(400, f"tf non valido: {tf} (usa {', '.join(TF_DATASET)})")
    return tf


def _frame(tf: str, live: bool = True) -> pd.DataFrame:
    """OHLCV del timeframe; l'ultima riga è la candela aperta, aggiornata col prezzo live."""
    df = store.get(TF_DATASET[tf])
    df = df[["time", "open", "high", "low", "close", "volume"]].dropna().reset_index(drop=True)
    if live and tf != "15m" and len(df):
        lp = live_price()
        last_close = float(df["close"].iloc[-1])
        end = df["time"].iloc[-1] + pd.Timedelta(seconds=TF_SECONDS[tf])
        if lp and abs(lp / last_close - 1) < 0.08 and pd.Timestamp.now(tz="UTC") < end:
            df = df.copy()
            i = df.index[-1]
            df.loc[i, "close"] = lp
            df.loc[i, "high"] = max(float(df.loc[i, "high"]), lp)
            df.loc[i, "low"] = min(float(df.loc[i, "low"]), lp)
    return df


def live_price() -> float | None:
    """Ultimo prezzo spot Binance (cache ~5s)."""
    tk = _cached_live("ticker", src.binance_ticker, 5)
    return util.num(tk.get("lastPrice")) if isinstance(tk, dict) else None


def _pts(times, values, nd: int | None = None) -> list[dict]:
    out = []
    for t, v in zip(times, values):
        v = util.num(v)
        if v is not None and nd is not None:
            v = round(v, nd)
        out.append({"time": util.ts(t), "value": v})
    return out


def _r(x, nd=2):
    x = util.num(x)
    return None if x is None else round(x, nd)


# ===================================================================== candles

@util.ttl_cache(20)
def build_candles(tf: str = "1d", limit: int = 1000) -> list[dict]:
    _check_tf(tf)
    df = _frame(tf).tail(max(1, min(int(limit), 5000)))
    return util.clean([
        {"time": util.ts(t), "open": o, "high": h, "low": l, "close": c, "volume": v}
        for t, o, h, l, c, v in zip(df["time"], df["open"], df["high"], df["low"], df["close"], df["volume"])
    ])


# ================================================================== indicators

def _anchor_index(df: pd.DataFrame, tf: str) -> int:
    """Ancora del VWAP per 1d/1w: inizio dell'ultimo swing maggiore (zigzag ampio)."""
    piv = ta.zigzag(df, mult=8.0 if tf == "1d" else 5.0)
    conf = [p for p in piv if not p.get("open")]
    if conf:
        return int(conf[-1]["i"])
    return max(0, len(df) - 365)


def _pct(a, b):
    a, b = util.num(a), util.num(b)
    if a is None or b in (None, 0):
        return None
    return (a / b - 1) * 100


def _summary(df, e, s, bb, r, m, sig, hist, a, vw) -> list[dict]:
    c = float(df["close"].iloc[-1])
    rows = []

    def add(name, value, signal):
        rows.append({"name": name, "value": value, "signal": signal})

    for n in ("21", "50", "200"):
        v = e[n].iloc[-1]
        d = _pct(c, v)
        if d is None:
            continue
        add(f"Prezzo vs EMA {n}", f"{'Sopra' if d >= 0 else 'Sotto'} ({d:+.2f}%)", "bullish" if d > 0.3 else "bearish" if d < -0.3 else "neutral")
    for n in ("50", "200"):
        v = s[n].iloc[-1]
        d = _pct(c, v)
        if d is None:
            continue
        add(f"Prezzo vs SMA {n}", f"{'Sopra' if d >= 0 else 'Sotto'} ({d:+.2f}%)", "bullish" if d > 0.3 else "bearish" if d < -0.3 else "neutral")
    # allineamento EMA
    e21, e50, e200 = (util.num(e[k].iloc[-1]) for k in ("21", "50", "200"))
    if None not in (e21, e50, e200):
        if e21 > e50 > e200:
            add("Allineamento EMA 21/50/200", "Rialzista (21 > 50 > 200)", "bullish")
        elif e21 < e50 < e200:
            add("Allineamento EMA 21/50/200", "Ribassista (21 < 50 < 200)", "bearish")
        else:
            add("Allineamento EMA 21/50/200", "Misto / in transizione", "neutral")
    # golden / death cross
    s50, s200 = s["50"], s["200"]
    if s200.notna().sum() > 2:
        diff = (s50 - s200).dropna()
        cross = np.sign(diff).diff().fillna(0)
        idx = cross[cross != 0].index
        last_kind = "Golden cross" if diff.iloc[-1] > 0 else "Death cross"
        ago = f", {len(df) - 1 - idx[-1]} barre fa" if len(idx) else ""
        add("SMA 50 / SMA 200", f"{last_kind}{ago}", "bullish" if diff.iloc[-1] > 0 else "bearish")
    rv = util.num(r.iloc[-1])
    if rv is not None:
        if rv >= 70:
            add("RSI 14", f"{rv:.1f} — ipercomprato", "bearish")
        elif rv <= 30:
            add("RSI 14", f"{rv:.1f} — ipervenduto", "bullish")
        elif rv >= 55:
            add("RSI 14", f"{rv:.1f} — momentum positivo", "bullish")
        elif rv <= 45:
            add("RSI 14", f"{rv:.1f} — momentum debole", "bearish")
        else:
            add("RSI 14", f"{rv:.1f} — neutrale", "neutral")
    mv, sv, hv = util.num(m.iloc[-1]), util.num(sig.iloc[-1]), util.num(hist.iloc[-1])
    hp = util.num(hist.iloc[-2]) if len(hist) > 1 else None
    if None not in (mv, sv, hv):
        trend = ""
        if hp is not None:
            trend = ", istogramma in crescita" if hv > hp else ", istogramma in calo"
        if mv > sv:
            add("MACD (12,26,9)", f"Sopra la signal{trend}", "bullish" if (hp is None or hv >= hp or mv > 0) else "neutral")
        else:
            add("MACD (12,26,9)", f"Sotto la signal{trend}", "bearish" if (hp is None or hv <= hp or mv < 0) else "neutral")
    up, mid, lo = (util.num(x.iloc[-1]) for x in bb)
    if None not in (up, mid, lo) and up > lo:
        pb = (c - lo) / (up - lo)
        bw = (up - lo) / mid * 100
        bw_hist = ((bb[0] - bb[2]) / bb[1] * 100).dropna().tail(120)
        squeeze = len(bw_hist) > 20 and bw <= bw_hist.quantile(0.15)
        txt = f"%B {pb:.2f}, ampiezza {bw:.1f}%" + (" — squeeze" if squeeze else "")
        if pb > 1:
            add("Bande di Bollinger (20,2)", txt + " — sopra la banda superiore", "bearish")
        elif pb < 0:
            add("Bande di Bollinger (20,2)", txt + " — sotto la banda inferiore", "bullish")
        else:
            add("Bande di Bollinger (20,2)", txt, "bullish" if pb > 0.6 else "bearish" if pb < 0.4 else "neutral")
    av = util.num(a.iloc[-1])
    if av is not None:
        rel = av / c * 100
        avg = (a / df["close"] * 100).dropna().tail(100).mean()
        lvl = "alta" if rel > avg * 1.25 else "bassa" if rel < avg * 0.8 else "nella media"
        add("ATR 14 (volatilità)", f"{ta.fmt_usd(av)} ({rel:.2f}% del prezzo) — volatilità {lvl}", "neutral")
    if vw is not None:
        vv = util.num(vw.iloc[-1])
        d = _pct(c, vv)
        if d is not None:
            add("VWAP", f"{'Sopra' if d >= 0 else 'Sotto'} ({d:+.2f}%)", "bullish" if d > 0.2 else "bearish" if d < -0.2 else "neutral")
    return rows


@util.ttl_cache(30)
def build_indicators(tf: str = "1d", limit: int = 1000) -> dict:
    _check_tf(tf)
    limit = max(10, min(int(limit), 5000))
    df = _frame(tf).tail(limit + WARMUP).reset_index(drop=True)
    c = df["close"]
    e = {str(n): ta.ema(c, n) for n in (21, 50, 200)}
    s = {str(n): ta.sma(c, n) for n in (50, 200)}
    bb = ta.bollinger(c)
    r = ta.rsi(c)
    m, sig, hist = ta.macd(c)
    a = ta.atr(df)
    if tf in ("15m", "1h"):
        vw = ta.vwap(df, reset="D")
    elif tf == "4h":
        vw = ta.vwap(df, reset="W")
    else:
        vw = ta.vwap(df, anchor_idx=_anchor_index(df, tf))
    summary = _summary(df, e, s, bb, r, m, sig, hist, a, vw)
    sl = slice(len(df) - min(limit, len(df)), len(df))
    t = df["time"].iloc[sl]
    nd = 2

    def P(x, d=nd):
        return _pts(t, x.iloc[sl], d)

    return util.clean({
        "ema": {k: P(v) for k, v in e.items()},
        "sma": {k: P(v) for k, v in s.items()},
        "bb": {"upper": P(bb[0]), "mid": P(bb[1]), "lower": P(bb[2])},
        "rsi": P(r),
        "macd": {"macd": P(m), "signal": P(sig), "hist": P(hist)},
        "vwap": P(vw),
        "atr": P(a),
        "summary": summary,
    })


# ====================================================================== levels

LEVELS_BARS = {"15m": 2880, "1h": 1500, "4h": 1500, "1d": 1100, "1w": 600}
ZZ_MULT = {"15m": 2.5, "1h": 2.5, "4h": 2.5, "1d": 2.5, "1w": 2.0}
MAJOR_MULT = {"15m": 7.0, "1h": 7.0, "4h": 7.0, "1d": 6.0, "1w": 4.0}


def _pivots_block() -> dict:
    d = store.get("k_1d")[["time", "open", "high", "low", "close"]].dropna()
    w = store.get("k_1w")[["time", "open", "high", "low", "close"]].dropna()
    out = {}
    # periodo precedente completato: l'ultima riga è la candela in corso
    prev_d = d.iloc[-2]
    out["daily"] = ta.pivot_set(prev_d.high, prev_d.low, prev_d.close)
    prev_w = w.iloc[-2]
    out["weekly"] = ta.pivot_set(prev_w.high, prev_w.low, prev_w.close)
    mon = d.set_index("time").resample("MS").agg({"high": "max", "low": "min", "close": "last"}).dropna()
    now = pd.Timestamp.now(tz="UTC")
    cur_month = pd.Timestamp(year=now.year, month=now.month, day=1, tz="UTC")
    mon = mon[mon.index < cur_month]
    pm = mon.iloc[-1]
    out["monthly"] = ta.pivot_set(pm.high, pm.low, pm.close)
    return out


def _key_levels(price: float, zones: list[dict], pivots: dict, ath: float | None) -> list[dict]:
    cands = []  # (price, kind, label, priority)
    for z in zones:
        if z["low"] <= price <= z["high"]:
            continue
        lvl = z["low"] if z["kind"] == "resistance" else z["high"]
        lvl = (lvl + z["mid"]) / 2
        name = "Zona di resistenza" if z["kind"] == "resistance" else "Zona di supporto"
        cands.append((lvl, z["kind"], f"{name} ({z['touches']} tocchi)", 0, z["strength"]))
    for per, lab in (("monthly", "mensile"), ("weekly", "settimanale")):
        for k, v in pivots[per]["classic"].items():
            if k == "P":
                cands.append((v, "resistance" if v > price else "support", f"Pivot {lab}", 1, 30))
            else:
                cands.append((v, "resistance" if v > price else "support", f"Pivot {lab} {k}", 1, 25))
    if ath:
        cands.append((ath, "resistance", "Massimo storico (ATH)", 0, 100))
    out = []
    for kind, sign in (("resistance", 1), ("support", -1)):
        side = [c for c in cands if (c[0] - price) * sign > price * 0.002]
        # zone reali preferite: i pivot "costano" il 60% di distanza in più
        side.sort(key=lambda c: abs(c[0] - price) * (1.6 if c[3] == 1 else 1.0) / (1 + c[4] / 400))
        chosen: list[tuple] = []
        for c in side:
            if any(abs(c[0] - x[0]) / price < 0.012 for x in chosen):
                continue
            chosen.append(c)
            if len(chosen) == 3:
                break
        chosen.sort(key=lambda c: abs(c[0] - price))
        for i, c in enumerate(chosen):
            tag = f"{'R' if kind == 'resistance' else 'S'}{i + 1}"
            out.append({"label": f"{tag} · {c[2]}", "price": round(c[0], 2), "kind": kind,
                        "distance": round((c[0] / price - 1) * 100, 2)})
    out.sort(key=lambda x: -x["price"])
    return out


@util.ttl_cache(30)
def build_levels(tf: str = "1d") -> dict:
    _check_tf(tf)
    full = _frame(tf)
    df = full.tail(LEVELS_BARS[tf]).reset_index(drop=True)
    price = live_price() or float(df["close"].iloc[-1])
    a_now = float(ta.atr(df).iloc[-1])
    piv = ta.zigzag(df, mult=ZZ_MULT[tf])
    ta.swing_strength(piv)
    conf = [p for p in piv if not p.get("open")]
    swings = [{"time": util.ts(p["time"]), "price": round(p["price"], 2), "kind": p["kind"], "strength": p["strength"]}
              for p in piv]
    bar_s = TF_SECONDS[tf]
    zones_raw = ta.cluster_zones(conf, price, a_now, df["time"].iloc[-1], halflife_bars=len(df) / 4, bar_seconds=bar_s)
    lo_lim, hi_lim = price * 0.45, price * 1.8
    zones_raw = [z for z in zones_raw if lo_lim < z["mid"] < hi_lim]
    zones = [{"low": round(z["low"], 2), "high": round(z["high"], 2), "kind": z["kind"], "touches": z["touches"],
              "strength": z["strength"], "last_touch": util.ts(z["last_touch"])} for z in zones_raw]
    pivots = _pivots_block()
    try:
        ath = float(max(store.get("k_1d")["high"].max(), full["high"].max()))
    except Exception:  # noqa: BLE001
        ath = None
    key = _key_levels(price, zones_raw, pivots, ath)
    # fibonacci dell'ultimo swing maggiore
    major = ta.zigzag(df, mult=MAJOR_MULT[tf])
    mconf = [p for p in major if not p.get("open")]
    fib = None
    if len(major) >= 2:
        # se l'estremo in formazione ha superato l'ultimo pivot confermato, usa l'ultimo tratto
        a_, b_ = (major[-2], major[-1]) if major[-1].get("open") and len(mconf) >= 1 else (mconf[-2], mconf[-1]) if len(mconf) >= 2 else (major[-2], major[-1])
        # tratto "maggiore": se l'ultimo tratto è piccolo rispetto al precedente usa quello precedente
        if len(major) >= 3:
            last_leg = abs(major[-1]["price"] - major[-2]["price"])
            prev_leg = abs(major[-2]["price"] - major[-3]["price"])
            if last_leg < 0.5 * prev_leg:
                a_, b_ = major[-3], major[-2]
        fib = {"from": {"time": util.ts(a_["time"]), "price": round(a_["price"], 2)},
               "to": {"time": util.ts(b_["time"]), "price": round(b_["price"], 2)},
               "levels": [{"ratio": l["ratio"], "price": round(l["price"], 2)} for l in ta.fib_levels(a_["price"], b_["price"])]}
    return util.clean({
        "pivots": {per: {k: {kk: round(vv, 2) for kk, vv in v.items()} for k, v in blk.items()} for per, blk in pivots.items()},
        "swings": swings,
        "zones": zones,
        "key_levels": key,
        "fib_retracement": fib,
    })


# ==================================================================== overview

_live_lock = threading.Lock()
_live: dict[str, tuple[float, object]] = {}


def _cached_live(name: str, fn, ttl: float):
    """Snapshot live con TTL e fallback all'ultimo valore valido."""
    now = time.time()
    with _live_lock:
        hit = _live.get(name)
    if hit and now - hit[0] < ttl:
        return hit[1]
    try:
        val = fn()
        with _live_lock:
            _live[name] = (now, val)
        return val
    except Exception as e:  # noqa: BLE001
        log.warning("live %s non disponibile: %s", name, e)
        if hit:
            with _live_lock:
                _live[name] = (now - ttl + 30, hit[1])  # riprova tra ~30s
            return hit[1]
        return None


FNG_IT = {"extreme fear": "Paura estrema", "fear": "Paura", "neutral": "Neutrale", "greed": "Avidità", "extreme greed": "Avidità estrema"}


def _spark_daily(times, values, n=60):
    s = pd.Series(list(values), index=pd.DatetimeIndex(times)).dropna()
    s = s[~s.index.duplicated(keep="last")].tail(n)
    return [{"time": util.ts(t), "value": util.num(v)} for t, v in s.items()]


@util.ttl_cache(5)
@util.ttl_cache(10)
def _premium() -> dict:
    return src.futures_premium()


def build_overview() -> dict:
    d1 = store.get("k_1d")
    tk = _cached_live("ticker", src.binance_ticker, 5) or {}
    gl = _cached_live("cg_global", src.coingecko_global, 120) or {}
    price = util.num(tk.get("lastPrice")) or float(d1["close"].iloc[-1])
    change_24h = util.num(tk.get("priceChangePercent"))
    high_24h = util.num(tk.get("highPrice"))
    low_24h = util.num(tk.get("lowPrice"))
    vol_24h = util.num(tk.get("quoteVolume"))
    h1 = store.get("k_1h").tail(48)
    qv = (h1["volume"] * h1["close"]).to_numpy()
    if change_24h is None and len(h1) >= 25:
        change_24h = (price / h1["close"].iloc[-25] - 1) * 100
    if high_24h is None:
        high_24h = float(h1["high"].tail(24).max())
        low_24h = float(h1["low"].tail(24).min())
    if vol_24h is None:
        vol_24h = float(qv[-24:].sum())
    volume_change = None
    if len(qv) >= 48 and qv[:24].sum() > 0:
        volume_change = (qv[-24:].sum() / qv[:24].sum() - 1) * 100

    caps = store.get("caps")
    oc = store.get("onchain")
    supply = util.num(oc["SplyCur"].dropna().iloc[-1]) if "SplyCur" in oc else None
    market_cap = price * supply if supply else util.num(caps["btc"].dropna().iloc[-1])
    mc_change = change_24h

    pct = gl.get("market_cap_percentage", {}) if isinstance(gl, dict) else {}
    total_mcap = util.num((gl.get("total_market_cap") or {}).get("usd")) if gl else None
    capcols = [c for c in caps.columns if c != "time"]
    caps_i = caps.set_index("time")
    est_dom = (caps_i["btc"] / caps_i[capcols].sum(axis=1, min_count=1) * 100).dropna()
    est_usdt = (caps_i["usdt"] / caps_i[capcols].sum(axis=1, min_count=1) * 100).dropna()
    btc_dom = util.num(pct.get("btc"))
    usdt_dom = util.num(pct.get("usdt"))
    usdt_series = caps_i["usdt"].dropna()
    usdt_mcap = usdt_series.iloc[-1] if len(usdt_series) else None
    if total_mcap and usdt_dom:
        usdt_mcap = total_mcap * usdt_dom / 100
    # calibrazione della dominance stimata (top-7 asset) su CoinGecko
    dom_spark_vals = est_dom
    dom_chg = None
    tot_chg = util.num(gl.get("market_cap_change_percentage_24h_usd"))
    if btc_dom and tot_chg is not None and change_24h is not None:
        dom_prev = btc_dom * (1 + tot_chg / 100) / (1 + change_24h / 100)
        dom_chg = btc_dom - dom_prev
    if btc_dom and len(est_dom):
        dom_spark_vals = est_dom * (btc_dom / est_dom.iloc[-1])
    else:
        btc_dom = util.num(est_dom.iloc[-1] * 0.82) if len(est_dom) else None
    if usdt_dom is None and len(est_usdt):
        usdt_dom = util.num(est_usdt.iloc[-1] * 0.82)
    usdt_7d = None
    if len(usdt_series) > 8:
        usdt_7d = (usdt_series.iloc[-1] / usdt_series.iloc[-8] - 1) * 100

    fng = store.get("fng")
    fv = int(fng["value"].iloc[-1])
    flabel = FNG_IT.get(str(fng["label"].iloc[-1]).lower(), str(fng["label"].iloc[-1]))
    fch = float(fng["value"].iloc[-1] - fng["value"].iloc[-2]) if len(fng) > 1 else None

    funding = None
    try:  # funding corrente (live) dal premium index; fallback all'ultimo funding regolato
        funding = float(_premium()["lastFundingRate"]) * 100
    except Exception:  # noqa: BLE001
        try:
            fr = store.get("funding")
            funding = float(fr["rate"].iloc[-1]) * 100
        except Exception:  # noqa: BLE001
            pass
    oi_usd = None
    try:
        oi = store.get("oi_15m")
        oi_usd = float(oi["oi_usd"].iloc[-1])
    except Exception:  # noqa: BLE001
        pass

    # ATH: daily lungo + Binance
    ath_p, ath_t = float(d1["high"].max()), d1["time"].iloc[int(d1["high"].values.argmax())]
    try:
        dl = store.get("daily")
        dl = dl[dl["time"] < d1["time"].iloc[0]]
        if len(dl) and dl["high"].max() > ath_p:
            ath_p, ath_t = float(dl["high"].max()), dl["time"].iloc[int(dl["high"].values.argmax())]
    except Exception:  # noqa: BLE001
        pass
    if price > ath_p:
        ath_p, ath_t = price, pd.Timestamp.now(tz="UTC")

    d60 = d1.tail(60)
    spark = {
        "price": _spark_daily(d60["time"], d60["close"]),
        "market_cap": _spark_daily(caps_i.index, caps_i["btc"]),
        "volume": _spark_daily(d60["time"], d60["volume"] * d60["close"]),
        "dominance": _spark_daily(dom_spark_vals.index, dom_spark_vals.values),
        "usdt": _spark_daily(usdt_series.index, usdt_series.values),
        "fng": _spark_daily(fng["time"], fng["value"]),
    }
    return util.clean({
        "price": price, "change_24h": change_24h, "high_24h": high_24h, "low_24h": low_24h,
        "volume_24h_usd": vol_24h, "volume_change": volume_change,
        "market_cap": market_cap, "market_cap_change_24h": mc_change,
        "btc_dominance": btc_dom, "btc_dominance_change_24h": dom_chg,
        "usdt_market_cap": usdt_mcap, "usdt_dominance": usdt_dom,
        "usdt_mcap_change_7d": usdt_7d,
        "fear_greed": {"value": fv, "label": flabel, "change_1d": fch},
        "funding_rate": funding, "open_interest_usd": oi_usd,
        "ath": {"price": ath_p, "time": util.ts(ath_t), "drawdown": (price / ath_p - 1) * 100},
        "sparklines": spark,
        "updated_at": int(time.time()),
    })


# ====================================================================== routes

@router.get("/overview")
def overview():
    return build_overview()


@router.get("/candles")
def candles(tf: str = Query("1d"), limit: int = Query(1000, ge=1, le=5000)):
    return build_candles(_check_tf(tf), limit)


@router.get("/indicators")
def indicators(tf: str = Query("1d"), limit: int = Query(1000, ge=10, le=5000)):
    return build_indicators(_check_tf(tf), limit)


@router.get("/levels")
def levels(tf: str = Query("1d")):
    return build_levels(_check_tf(tf))
