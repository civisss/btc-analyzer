"""Heatmap stimata delle liquidazioni (modello stile Coinglass/Hyblock) + pool di liquidità + eventi reali multi-exchange.

Modello (OI AGGREGATO Binance + Bybit + OKX, allocazione per exchange):
  - si percorrono le candele futures 15m (prezzo Binance BTCUSDT) allineate all'open interest 15m di OGNI exchange
    (Binance BTCUSDT, Bybit BTCUSDT a un lato, OKX BTC-USDT-SWAP — per OKX oltre ~10 g la serie è oraria interpolata);
  - il ΔOI di ciascun exchange è scalato per coprire anche gli altri suoi perpetui (USDC, COIN-M) con il rapporto live
    OI totale perpetui / OI del contratto USDT;
  - quando l'OI cresce, il nuovo nozionale (ΔOI·prezzo tipico) viene allocato al prezzo tipico della candela,
    diviso tra long/short usando il taker-buy ratio della candela e il long% degli account,
    e distribuito su una griglia di leve -> prezzi di liquidazione stimati;
  - quando l'OI cala, tutte le posizioni attive vengono ridotte proporzionalmente;
  - un livello viene "consumato" quando il prezzo lo attraversa (low <= liq long, high >= liq short).
Ipotesi esplicite (uguali per tutti gli exchange): distribuzione delle leve LEVERAGE/LEV_W, margine di mantenimento MMR,
quota long = 0.6·taker-buy ratio + 0.4·long% account Binance.
Validazione: `validate()` confronta il modello con le liquidazioni reali raccolte (vedi docstring).
"""
from __future__ import annotations

import logging
import math

import numpy as np
import pandas as pd

from .. import util
from ..data import store

log = logging.getLogger("liquidations")

LEVERAGE = np.array([5, 10, 20, 25, 50, 100], dtype=float)
LEV_W = np.array([0.10, 0.25, 0.25, 0.15, 0.15, 0.10])
MMR = 0.004
RANGES = {"1d": (1, "15min"), "3d": (3, "30min"), "7d": (7, "1h"), "30d": (30, "4h")}
N_PRICE = 150


def _secs(s: pd.Series) -> np.ndarray:
    s = pd.to_datetime(pd.Series(s), utc=True).astype("datetime64[ns, UTC]")
    return ((s - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(dtype=np.int64)


# ------------------------------------------------------------------ modello

EX_NAMES = {"binance": "Binance", "bybit": "Bybit", "okx": "OKX"}


def _inputs() -> tuple[dict, dict]:
    """(serie OI 15m per exchange, fattori di scala) — mai bloccante: se manca un exchange lo si dichiara nella copertura."""
    try:
        from . import aggregate
        series = aggregate.oi_15m_by_exchange()
    except Exception as e:  # noqa: BLE001
        log.warning("OI per exchange non disponibile: %s", e)
        series = {}
    if "binance" not in series:
        series["binance"] = store.get("oi_15m")[["time", "oi"]]
    try:
        from . import aggregate
        factors = aggregate.scale_factors()
    except Exception as e:  # noqa: BLE001
        log.warning("fattori di scala OI non disponibili: %s", e)
        factors = {}
    return series, factors


@util.ttl_cache(60)
def model() -> dict:
    """Simulazione completa sull'intero storico 15m (cache 1 min), un'allocazione per exchange."""
    fut = store.get("fut_15m").sort_values("time")
    fut = fut[fut["time"] >= fut["time"].iloc[-1] - pd.Timedelta(days=45)].reset_index(drop=True)
    df = fut.copy()
    df["time"] = pd.to_datetime(df["time"], utc=True).astype("datetime64[ns, UTC]")
    series, factors = _inputs()
    exs = [e for e in ("binance", "bybit", "okx") if e in series and series[e] is not None and len(series[e])]
    cover = {}
    for e in exs:
        o = series[e][["time", "oi"]].copy()
        o["time"] = pd.to_datetime(o["time"], utc=True).astype("datetime64[ns, UTC]")
        o = o.drop_duplicates("time").sort_values("time")
        df = df.merge(o.rename(columns={"oi": f"oi_{e}"}), on="time", how="left")
        first = o["time"].iloc[0]
        df[f"oi_{e}"] = df[f"oi_{e}"].ffill()
        cover[e] = {"since": util.ts(max(first, df["time"].iloc[0]))}
    df["oi"] = df.get("oi_binance")  # compatibilità: colonna OI Binance come prima
    try:
        ls = store.get("ls")[["time", "long_pct"]].sort_values("time")
        ls["time"] = pd.to_datetime(ls["time"], utc=True).astype("datetime64[ns, UTC]")
        df = pd.merge_asof(df, ls, on="time", direction="backward")
    except Exception:  # noqa: BLE001
        df["long_pct"] = np.nan
    df["long_pct"] = df["long_pct"].ffill().bfill().fillna(0.5)

    n = len(df)
    hi = df["high"].to_numpy(float)
    lo = df["low"].to_numpy(float)
    cl = df["close"].to_numpy(float)
    typ = (hi + lo + cl) / 3
    vol = df["volume"].to_numpy(float)
    tb = df["taker_buy"].to_numpy(float) if "taker_buy" in df else vol / 2
    taker = np.where(vol > 0, tb / np.where(vol > 0, vol, 1), 0.5)
    long_share = np.clip(0.6 * taker + 0.4 * df["long_pct"].to_numpy(float), 0.15, 0.85)

    nl = len(LEVERAGE)
    birth = np.repeat(np.arange(n), 2 * nl)
    is_long = np.tile(np.r_[np.ones(nl, bool), np.zeros(nl, bool)], n)
    lev = np.tile(np.r_[LEVERAGE, LEVERAGE], n)
    w = np.tile(np.r_[LEV_W, LEV_W], n)
    entry = typ[birth]
    liq = np.where(is_long, entry * (1 - 1 / lev + MMR), entry * (1 + 1 / lev - MMR))
    share = np.where(is_long, long_share[birth], 1 - long_share[birth])
    # indice di consumo per ogni livello: prima candela > nascita che attraversa il prezzo di liquidazione
    death = np.where(is_long, _first_cross(lo, birth, liq, below=True), _first_cross(hi, birth, liq, below=False))

    amount0 = np.zeros((len(exs), len(birth)))
    log_scale = np.zeros((len(exs), n))
    for i, e in enumerate(exs):
        oi_btc = df[f"oi_{e}"].to_numpy(float)
        k = float((factors.get(e) or {}).get("factor") or 1.0)
        cover[e]["factor"] = k
        cover[e]["scaled"] = e in factors
        d_oi = np.nan_to_num(np.diff(oi_btc, prepend=np.nan), nan=0.0)
        d_usd = d_oi * typ * k
        amount0[i] = np.where(d_usd[birth] > 0, d_usd[birth], 0.0) * share * w
        # riduzioni proporzionali su cali di OI: le chiusure si distribuiscono su TUTTO l'OI dell'exchange
        prev_oi = np.r_[np.nan, oi_btc[:-1]]
        with np.errstate(invalid="ignore", divide="ignore"):
            frac = np.where((d_oi < 0) & (prev_oi > 0), -d_oi / prev_oi, 0.0)
        f = np.clip(1 - np.nan_to_num(frac), 0.05, 1.0)
        log_scale[i] = np.cumsum(np.log(f))

    return {
        "df": df, "birth": birth, "death": death, "liq": liq, "is_long": is_long,
        "amount0": amount0, "log_scale": log_scale, "lev": lev, "exchanges": exs, "cover": cover, "factors": factors,
    }


def _first_cross(x: np.ndarray, birth: np.ndarray, level: np.ndarray, below: bool) -> np.ndarray:
    """Per ogni livello: primo indice t > birth con x[t] <= level (below) o x[t] >= level; n se mai.
    Binary lifting su sparse table di min/max (vettoriale)."""
    n = len(x)
    op = np.minimum if below else np.maximum
    table = [x.copy()]
    j = 1
    while (1 << j) <= n:
        prev = table[-1]
        half = 1 << (j - 1)
        nxt = prev.copy()
        nxt[: n - half] = op(prev[: n - half], prev[half:])
        table.append(nxt)
        j += 1
    pos = birth + 1
    for j in range(len(table) - 1, -1, -1):
        step = 1 << j
        ok = pos + step <= n
        idx = np.minimum(pos, n - 1)
        seg = table[j][idx]
        safe = seg > level if below else seg < level
        adv = ok & safe
        pos = np.where(adv, pos + step, pos)
    return np.minimum(pos, n).astype(np.int64)


def _active_at(m: dict, t: int) -> tuple[np.ndarray, np.ndarray]:
    """(maschera livelli vivi alla fine della candela t, importo corrente sommato sugli exchange)."""
    b, d = m["birth"], m["death"]
    a0, ls = m["amount0"], m["log_scale"]
    mask = (b <= t) & (d > t) & (a0.sum(axis=0) > 0)
    bm = b[mask]
    amt = np.zeros(int(mask.sum()))
    for i in range(a0.shape[0]):
        amt += a0[i, mask] * np.exp(ls[i, t] - ls[i, bm])
    return mask, amt


def _nice_step(x: float) -> float:
    e = 10 ** math.floor(math.log10(x))
    for k in (1, 2, 2.5, 5, 10):
        if x <= k * e:
            return k * e
    return 10 * e


# ------------------------------------------------------------------ heatmap

def heatmap(m: dict, rng: str) -> dict:
    days, rule = RANGES[rng]
    df = m["df"]
    t_end = df["time"].iloc[-1]
    start = t_end - pd.Timedelta(days=days)
    sel = df.index[df["time"] > start]
    sub = df.loc[sel].copy()
    sub["bucket"] = sub["time"].dt.floor(rule)
    g = sub.groupby("bucket")
    candles_df = pd.DataFrame({
        "open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
        "close": g["close"].last(), "volume": g["volume"].sum(),
    })
    last_idx = sub.reset_index().groupby("bucket")["index"].max().to_numpy()

    cur = float(df["close"].iloc[-1])
    p_lo = min(float(candles_df["low"].min()), cur * 0.9)
    p_hi = max(float(candles_df["high"].max()), cur * 1.1)
    edges = np.linspace(p_lo, p_hi, N_PRICE + 1)
    centers = (edges[:-1] + edges[1:]) / 2

    values = []
    for t in last_idx:
        mask, amt = _active_at(m, int(t))
        p = m["liq"][mask]
        ok = (p >= p_lo) & (p < p_hi)
        bi = np.clip(((p[ok] - p_lo) / (p_hi - p_lo) * N_PRICE).astype(int), 0, N_PRICE - 1)
        col = np.bincount(bi, weights=amt[ok], minlength=N_PRICE)
        values.append(np.round(col).astype(np.int64).tolist())
    vmax = max((max(r) for r in values), default=0)

    times = _secs(pd.Series(candles_df.index))
    candles = [
        {"time": int(tt), "open": o, "high": h, "low": l, "close": c, "volume": v}
        for tt, o, h, l, c, v in zip(times, candles_df["open"], candles_df["high"], candles_df["low"], candles_df["close"], candles_df["volume"])
    ]
    step = _nice_step((p_hi - p_lo) / N_PRICE)
    prices = [round(float(x), 2 if step < 1 else 1) for x in centers]
    return {"times": times.tolist(), "prices": prices, "values": values, "max": vmax, "candles": candles}


def clusters(m: dict, n_top: int = 15, max_dist: float = 15.0) -> tuple[list[dict], dict | None]:
    df = m["df"]
    t = len(df) - 1
    cur = float(df["close"].iloc[-1])
    mask, amt = _active_at(m, t)
    p = m["liq"][mask]
    il = m["is_long"][mask]
    step = _nice_step(cur * 0.0025)
    b = np.round(p / step) * step
    agg = pd.DataFrame({"price": b, "long": il, "usd": amt}).groupby(["price", "long"], as_index=False)["usd"].sum()
    agg["distance"] = (agg["price"] / cur - 1) * 100
    agg = agg[agg["distance"].abs() <= max_dist]
    agg = agg.sort_values("usd", ascending=False).reset_index(drop=True)
    # raggruppa i bucket adiacenti dello stesso lato in un unico cluster (±0.4%)
    taken = np.zeros(len(agg), bool)
    pr, lg, us = agg["price"].to_numpy(), agg["long"].to_numpy(), agg["usd"].to_numpy()
    groups = []
    for i in range(len(agg)):
        if taken[i]:
            continue
        sel = (~taken) & (lg == lg[i]) & (np.abs(pr / pr[i] - 1) <= 0.004)
        taken |= sel
        tot = float(us[sel].sum())
        groups.append({"price": float(pr[i]), "usd": tot, "side": "long" if lg[i] else "short",
                       "distance": float((pr[i] / cur - 1) * 100)})
        if len(groups) >= 60:
            break
    groups.sort(key=lambda g: -g["usd"])
    out = groups[:n_top]
    near = [g for g in groups if abs(g["distance"]) <= 10]
    magnet = None
    if near:
        g = near[0]
        magnet = {"price": g["price"], "side": g["side"], "usd": g["usd"]}
    return out, magnet


# ------------------------------------------------------------------ pools

def _pivots(h: np.ndarray, l: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    n = len(h)
    ph, pl = np.zeros(n, bool), np.zeros(n, bool)
    for i in range(k, n - k):
        wh, wl = h[i - k:i + k + 1], l[i - k:i + k + 1]
        ph[i] = h[i] == wh.max() and (wh == h[i]).sum() == 1
        pl[i] = l[i] == wl.min() and (wl == l[i]).sum() == 1
    return ph, pl


def pools(cur: float) -> list[dict]:
    out: list[dict] = []
    for tf, name, days, k, tfw in (("1h", "k_1h", 21, 3, 1.0), ("4h", "k_4h", 120, 3, 1.6)):
        try:
            d = store.get(name)
        except Exception:  # noqa: BLE001
            continue
        d = d[d["time"] >= d["time"].iloc[-1] - pd.Timedelta(days=days)].reset_index(drop=True)
        h, l = d["high"].to_numpy(float), d["low"].to_numpy(float)
        n = len(d)
        ph, pl = _pivots(h, l, k)
        # massimo/minimo futuro dopo ogni pivot -> il livello è ancora "intatto"?
        fut_max = np.r_[np.maximum.accumulate(h[::-1])[::-1][1:], -np.inf]
        fut_min = np.r_[np.minimum.accumulate(l[::-1])[::-1][1:], np.inf]
        highs = [(i, h[i]) for i in np.where(ph)[0] if fut_max[i] < h[i] and h[i] > cur]
        lows = [(i, l[i]) for i in np.where(pl)[0] if fut_min[i] > l[i] and l[i] < cur]
        for lst, kind, word in ((highs, "buy_side", "massimi"), (lows, "sell_side", "minimi")):
            used = set()
            for a in range(len(lst)):
                if a in used:
                    continue
                grp = [a]
                for b in range(a + 1, len(lst)):
                    if b not in used and abs(lst[b][1] / lst[a][1] - 1) < 0.0015:
                        grp.append(b)
                used.update(grp)
                price = float(np.mean([lst[g][1] for g in grp]))
                touches = len(grp)
                age = (n - 1 - lst[grp[-1]][0]) / n
                dist = abs(price / cur - 1) * 100
                if dist > 20:
                    continue
                strength = min(100.0, (35 + 25 * (touches - 1)) * tfw * (1.0 - 0.3 * age) * (1.2 if dist < 3 else 1.0))
                src_txt = f"{'Equal highs' if kind == 'buy_side' else 'Equal lows'} {tf} ({touches} tocchi)" if touches > 1 else \
                    f"Swing {'high' if kind == 'buy_side' else 'low'} {tf} intatto"
                out.append({"price": price, "kind": kind, "source": src_txt, "strength": round(strength, 1), "_word": word})
    # deduplica livelli vicini tra timeframe (tiene il più forte)
    out.sort(key=lambda x: -x["strength"])
    final: list[dict] = []
    for p in out:
        if all(abs(p["price"] / q["price"] - 1) > 0.002 or p["kind"] != q["kind"] for q in final):
            p.pop("_word", None)
            final.append(p)
    final = final[:16]
    final.sort(key=lambda x: -x["price"])
    return final




# ------------------------------------------------------------------ eventi reali (multi-exchange)

THROTTLE_NOTE = {
    "binance": "forceOrder: al massimo 1 evento al secondo per simbolo (sottostima nei picchi)",
    "bybit": "allLiquidation: tutte le liquidazioni, pacchetti ogni 500 ms",
    "okx": "liquidation-orders via WebSocket + recupero REST ogni 60 s",
}
SYMBOLS = {"binance": ["BTCUSDT", "BTCUSDC", "BTCUSD_PERP"], "bybit": ["BTCUSDT", "BTCPERP", "BTCUSD"], "okx": ["BTC-USDT-SWAP", "BTC-USD-SWAP"]}


def _collector_state() -> tuple[dict, dict]:
    try:
        from .. import liq_collectors, live
        meta = liq_collectors.collecting_meta()
        st = liq_collectors.stats().get("exchanges", {})
        b = dict(st.get("binance") or {})
        b["connected"] = bool(live.is_connected()) or bool(b.get("connected"))
        st["binance"] = b
        return meta, st
    except Exception:  # noqa: BLE001
        return {}, {}


def events_totals() -> tuple[list[dict], dict]:
    empty = {"long_24h": 0.0, "short_24h": 0.0, "long_7d": 0.0, "short_7d": 0.0}
    totals = {**empty, "collecting_since": None, "all_since": None, "by_exchange": {}}
    meta, st = _collector_state()
    try:
        ev = store.liquidations()
    except Exception as e:  # noqa: BLE001
        log.warning("liquidazioni live non leggibili: %s", e)
        ev = pd.DataFrame()
    now = pd.Timestamp.now(tz="UTC")
    has = ev is not None and not ev.empty
    if has:
        ev = ev.copy()
        ev["time"] = pd.to_datetime(ev["time"], utc=True)
        ev = ev.sort_values("time")
        for side in ("long", "short"):
            s_ = ev[ev["side"] == side]
            totals[f"{side}_24h"] = float(s_.loc[s_["time"] >= now - pd.Timedelta(hours=24), "usd"].sum())
            totals[f"{side}_7d"] = float(s_.loc[s_["time"] >= now - pd.Timedelta(days=7), "usd"].sum())
        totals["collecting_since"] = util.ts(ev["time"].iloc[0])
    for ex, name in EX_NAMES.items():
        e = ev[ev["exchange"] == ex] if has else pd.DataFrame()
        row = {"name": name, **empty, "count_24h": 0, "symbols": SYMBOLS[ex], "note": THROTTLE_NOTE[ex],
               "connected": bool((st.get(ex) or {}).get("connected")), "last_event": None}
        since = [int(meta[ex])] if meta.get(ex) else []
        if len(e):
            for side in ("long", "short"):
                s_ = e[e["side"] == side]
                row[f"{side}_24h"] = float(s_.loc[s_["time"] >= now - pd.Timedelta(hours=24), "usd"].sum())
                row[f"{side}_7d"] = float(s_.loc[s_["time"] >= now - pd.Timedelta(days=7), "usd"].sum())
            row["count_24h"] = int((e["time"] >= now - pd.Timedelta(hours=24)).sum())
            row["last_event"] = util.ts(e["time"].iloc[-1])
            since.append(util.ts(e["time"].iloc[0]))
        row["collecting_since"] = int(min(since)) if since else None
        totals["by_exchange"][ex] = row
    ss = [r["collecting_since"] for r in totals["by_exchange"].values()]
    totals["all_since"] = max(ss) if all(ss) else None
    if totals["collecting_since"] is None and any(ss):
        totals["collecting_since"] = min(x for x in ss if x)
    events = []
    if has:
        recent = ev.iloc[::-1].head(300)
        events = [{"time": util.ts(r.time), "side": r.side, "price": float(r.price), "qty": float(r.qty), "usd": float(r.usd),
                   "exchange": r.exchange, "symbol": r.symbol} for r in recent.itertuples()]
    return events, totals


# ------------------------------------------------------------------ copertura e validazione

def coverage(m: dict) -> dict:
    """Exchange inclusi nel modello e quota dell'OI coperta."""
    factors = m.get("factors") or {}
    tot = sum(v["oi_usd"] for v in factors.values()) or None
    rows = []
    for ex, name in EX_NAMES.items():
        f = factors.get(ex) or {}
        c = (m.get("cover") or {}).get(ex) or {}
        rows.append({"id": ex, "name": name, "included": ex in m["exchanges"], "oi_usd": f.get("oi_usd"), "oi_btc": f.get("oi_btc"),
                     "share_pct": f["oi_usd"] / tot * 100 if tot and f.get("oi_usd") else None, "factor": c.get("factor"),
                     "series_since": c.get("since"), "resolution": "1h→15m" if ex == "okx" else "15m"})
    binance_usdt = None
    b = factors.get("binance")
    if b and tot and b.get("oi_btc"):
        binance_usdt = b["modeled_oi_btc"] / b["oi_btc"] * b["oi_usd"] / tot * 100
    glob = None
    try:
        from . import aggregate
        glob = aggregate.build().get("crosscheck", {}).get("coverage_pct")
    except Exception:  # noqa: BLE001
        pass
    included_usd = sum(r["oi_usd"] or 0 for r in rows if r["included"]) or None
    return {
        "exchanges": rows, "included_oi_usd": included_usd,
        "share_of_three_pct": included_usd / tot * 100 if tot and included_usd else None,
        "previous_binance_usdt_share_pct": binance_usdt, "share_of_global_pct": glob,
        "assumptions": {"leverage": [{"lev": float(lv), "weight": float(w) * 100} for lv, w in zip(LEVERAGE, LEV_W)], "mmr_pct": MMR * 100,
                        "long_share": "0.6 × taker-buy ratio + 0.4 × long% account Binance (15%–85%)"},
    }


@util.ttl_cache(300)
def validate() -> dict:
    """Confronto onesto modello vs liquidazioni REALI raccolte (tutti gli exchange in raccolta).

    1. Tempo: per ogni ora, liquidazioni previste dal modello (livelli consumati dal prezzo, importo al momento del
       consumo) vs liquidazioni reali. Correlazione di Spearman e "hit rate" sulle ore di picco reale (>= 90° percentile):
       quota di quelle ore in cui anche il modello era nel suo quartile alto (per caso = 25%).
    2. Prezzo: per ogni liquidazione reale, il prezzo cadeva in una zona densa del modello (20% dei bin da 0.25% più
       carichi entro ±10%) alla candela precedente? Atteso per caso = quota del range percorso dalla candela coperta da
       zone dense (lift = osservato / atteso).
    """
    out = {"status": "insufficient", "hours": 0, "events": 0, "from": None, "to": None, "exchanges": [],
           "spearman": None, "peak_hit_pct": None, "peak_hours": 0, "baseline_pct": 25.0,
           "price_hit_pct": None, "price_expected_pct": None, "price_lift": None, "price_events": 0}
    try:
        ev = store.liquidations()
    except Exception:  # noqa: BLE001
        return out
    if ev is None or ev.empty:
        return out
    m = model()
    df = m["df"]
    t0, t1 = df["time"].iloc[0], df["time"].iloc[-1] + pd.Timedelta(minutes=15)
    ev = ev.copy()
    ev["time"] = pd.to_datetime(ev["time"], utc=True).astype("datetime64[ns, UTC]")
    ev = ev[(ev["time"] >= t0) & (ev["time"] < t1)].sort_values("time")
    if ev.empty:
        return out
    times = df["time"].astype("datetime64[ns, UTC]").to_numpy()
    ev["k"] = np.searchsorted(times, ev["time"].to_numpy(), side="right") - 1
    ev = ev[ev["k"] >= 1]
    if ev.empty:
        return out
    out.update({"events": int(len(ev)), "exchanges": sorted(ev["exchange"].unique().tolist()),
                "from": util.ts(ev["time"].iloc[0]), "to": util.ts(ev["time"].iloc[-1])})
    # ---- 1) tempo: volume previsto per candela (livelli consumati)
    n = len(df)
    d = m["death"]
    a0, ls = m["amount0"], m["log_scale"]
    alive = (d < n) & (a0.sum(axis=0) > 0)
    di, bi = d[alive], m["birth"][alive]
    amt = np.zeros(int(alive.sum()))
    for i in range(a0.shape[0]):
        amt += a0[i, alive] * np.exp(ls[i, np.maximum(di - 1, 0)] - ls[i, bi])
    pred = np.bincount(di, weights=amt, minlength=n)[:n]
    hours = df["time"].dt.floor("1h").to_numpy()
    p_h = pd.Series(pred, index=hours).groupby(level=0).sum()
    r_h = ev.groupby(ev["time"].dt.floor("1h"))["usd"].sum()
    h0, h1 = ev["time"].iloc[0].floor("1h"), ev["time"].iloc[-1].floor("1h")
    idx = p_h.index[(p_h.index >= h0) & (p_h.index <= h1)]
    p_h, r_h = p_h.reindex(idx).fillna(0), r_h.reindex(idx).fillna(0)
    out["hours"] = int(len(idx))
    if len(idx) >= 12:
        out["spearman"] = float(pd.Series(p_h.values).rank().corr(pd.Series(r_h.values).rank()))
        peak = (r_h >= r_h.quantile(0.9)) & (r_h > 0)
        out["peak_hours"] = int(peak.sum())
        if peak.sum():
            out["peak_hit_pct"] = float((p_h[peak] >= p_h.quantile(0.75)).mean() * 100)
    # ---- 2) prezzo: zone dense del modello alla candela precedente l'evento
    hit_usd = exp_usd = tot_usd = 0.0
    n_ev = 0
    hi, lo, op = df["high"].to_numpy(float), df["low"].to_numpy(float), df["open"].to_numpy(float)
    for k, g in ev.groupby("k"):
        k = int(k)
        mask, a = _active_at(m, k - 1)
        if not len(a):
            continue
        ref = op[k]
        step = ref * 0.0025
        edges = np.arange(ref * 0.9, ref * 1.1 + step, step)
        dens, _ = np.histogram(m["liq"][mask], bins=edges, weights=a)
        if dens.max() <= 0:
            continue
        thr = np.quantile(dens, 0.8)
        dense = dens >= thr if thr > 0 else dens > 0
        px = g["price"].to_numpy(float)
        bix = np.clip(np.searchsorted(edges, px, side="right") - 1, 0, len(dens) - 1)
        inside = (px >= edges[0]) & (px < edges[-1])
        usd = g["usd"].to_numpy(float)
        hit_usd += float(usd[inside & dense[bix]].sum())
        tot_usd += float(usd.sum())
        r0 = int(np.clip(np.searchsorted(edges, lo[k], side="right") - 1, 0, len(dens) - 1))
        r1 = int(np.clip(np.searchsorted(edges, hi[k], side="right") - 1, 0, len(dens) - 1))
        cov = float(dense[r0:r1 + 1].mean()) if r1 >= r0 else 0.0
        exp_usd += cov * float(usd.sum())
        n_ev += len(g)
    if tot_usd > 0:
        out["price_hit_pct"] = hit_usd / tot_usd * 100
        out["price_expected_pct"] = exp_usd / tot_usd * 100
        out["price_lift"] = (hit_usd / exp_usd) if exp_usd > 0 else None
        out["price_events"] = n_ev
    out["status"] = "ok" if out["hours"] >= 72 and n_ev >= 100 else "preliminary" if out["hours"] >= 12 else "insufficient"
    return out


def near_totals(m: dict, pct: float = 5.0) -> dict:
    """USD stimati entro ±pct% dal prezzo su tutte le posizioni del modello, non solo sui cluster principali."""
    df = m["df"]
    cur = float(df["close"].iloc[-1])
    mask, amt = _active_at(m, len(df) - 1)
    p, il = m["liq"][mask], m["is_long"][mask]
    sel = np.abs(p / cur - 1) * 100 <= pct
    return {"pct": pct, "long": float(amt[sel & il].sum()), "short": float(amt[sel & ~il].sum())}


# ------------------------------------------------------------------ entry

@util.ttl_cache(30)
def _static(rng: str) -> dict:
    m = model()
    cur = float(m["df"]["close"].iloc[-1])
    cl, magnet = clusters(m)
    try:
        cov = coverage(m)
    except Exception as e:  # noqa: BLE001
        log.warning("copertura modello non calcolabile: %s", e)
        cov = None
    try:
        val = validate()
    except Exception as e:  # noqa: BLE001
        log.warning("validazione modello non calcolabile: %s", e)
        val = None
    return {"heatmap": heatmap(m, rng), "clusters": cl, "near": near_totals(m), "pools": pools(cur), "magnet": magnet, "coverage": cov, "validation": val}


def compute(rng: str = "7d") -> dict:
    if rng not in RANGES:
        rng = "7d"
    st = _static(rng)
    events, totals = events_totals()
    return {**st, "events": events, "totals": totals}
