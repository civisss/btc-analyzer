"""Superchart: libreria di serie GIÀ presenti nell'app, allineate alla griglia delle candele in modo point-in-time.

Regola unica di allineamento (nessuna interpolazione):
  ogni osservazione nativa ha un tempo `t` e una disponibilità `avail = t + lag` (lag = durata del periodo osservato +
  ritardo di pubblicazione noto o stimato). Il valore mostrato sulla candela i è quello NOTO alla chiusura della candela
  (close_i = apertura + timeframe; per la candela in formazione: adesso):
    - `last`  (livelli: OI, MVRV, DXY…): ultimo valore con avail ≤ close_i, ripetuto finché non arriva il successivo
               (entro `stale` secondi, poi vuoto);
    - `mean`  (tassi: funding, premio): media dei valori disponibili dentro la candela; se la serie è più lenta del
               timeframe vale come `last` (il tasso resta in vigore fino al successivo);
    - `sum`   (flussi: liquidazioni, ETF, netflow, delta): somma dei valori diventati disponibili dentro la candela,
               mai ripetuti.
In replay alla candela k si mostrano solo le candele 0..k: per costruzione ogni valore visibile era pubblicato
alla chiusura di k (test: backend/tests/test_superchart.py).
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

from ..data import store
from . import anomalies as an
from . import aggregate, basis, holders, macro, sentiment, stablecoins, supply_demand, usdt, vwap  # noqa: F401  (registrano i dataset)
from . import market as ta

log = logging.getLogger("superchart")

DAY = 86400
TF_S = {"15m": 900, "1h": 3600, "4h": 14400, "1d": DAY, "1w": 7 * DAY}
SPOT_DS = {"1h": "k_1h", "4h": "k_4h", "1d": "k_1d", "1w": "k_1w"}
DEFAULT_BARS = {"15m": 20000, "1h": 20000, "4h": 25000, "1d": 10000, "1w": 2000}
MAX_BARS = 120_000
ONCHAIN_LAG = an.ONCHAIN_LAG     # CoinMetrics community: D pubblicato nel corso di D+1 → disponibile a D+2 00:00 (prudente)
ETF_LAG = an.ETF_LAG             # Farside: seduta D pubblicata la sera USA / mattina di D+1 → D+1 12:00 UTC (prudente)
BGEO_LAG = 8 * DAY               # BGeometrics piano gratuito: dati con 7 giorni di ritardo (+1 giorno di chiusura)
secs = an.secs


# ===================================================================== griglia delle candele

@dataclass
class Grid:
    tf: str
    step: int
    t: np.ndarray          # apertura (s)
    close: np.ndarray      # istante in cui la candela è nota: apertura + step (candela in formazione: adesso)
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    v: np.ndarray
    tb: np.ndarray         # volume taker buy (NaN se la fonte non lo fornisce)
    source: str = ""

    def cut(self, asof: int) -> "Grid":
        """Solo candele chiuse entro `asof` (replay/test: niente candela parziale)."""
        k = int(np.searchsorted(self.t + self.step, asof, side="right"))
        return Grid(self.tf, self.step, self.t[:k], np.minimum(self.close[:k], self.t[:k] + self.step), self.o[:k], self.h[:k],
                    self.l[:k], self.c[:k], self.v[:k], self.tb[:k], self.source)


def _f(df: pd.DataFrame, col: str) -> np.ndarray:
    return df[col].to_numpy(dtype=float) if col in df else np.full(len(df), np.nan)


def _grid_spot(tf: str) -> Grid:
    df = store.get(SPOT_DS[tf]).dropna(subset=["open", "high", "low", "close"]).sort_values("time")
    t = secs(df["time"])
    step = TF_S[tf]
    o, h, l, c = _f(df, "open"), _f(df, "high"), _f(df, "low"), _f(df, "close")
    now = int(time.time())
    if len(t) and now < t[-1] + step:      # candela in formazione: prezzo live come nel resto dell'app (market._frame)
        try:
            from ..routers.market import live_price
            lp = live_price()
            if lp and abs(lp / c[-1] - 1) < 0.08:
                c = c.copy(); h = h.copy(); l = l.copy()
                c[-1] = lp; h[-1] = max(h[-1], lp); l[-1] = min(l[-1], lp)
        except Exception as e:  # noqa: BLE001
            log.debug("prezzo live non disponibile: %s", e)
    close = np.minimum(t + step, now)
    return Grid(tf, step, t, close, o, h, l, c, _f(df, "volume"), _f(df, "taker_buy"), "binance_spot")


def _grid_15m() -> Grid:
    """15m: Binance USDⓈ-M BTCUSDT. Storico dalle candele 1m del modulo VWAP (dal 1° gennaio dell'anno precedente),
    ultimi 30 giorni (con la candela in formazione e il taker buy) da fut_15m."""
    step = 900
    parts_t, parts = [], []
    try:
        A = vwap.arrays("binance")
        if len(A["t"]):
            b = A["t"] // step * step
            starts = np.flatnonzero(np.r_[True, b[1:] != b[:-1]])
            ends = np.r_[starts[1:], len(b)] - 1
            parts_t.append(b[starts])
            parts.append({"o": A["o"][starts], "h": np.maximum.reduceat(A["h"], starts), "l": np.minimum.reduceat(A["l"], starts),
                          "c": A["c"][ends], "v": np.add.reduceat(A["v"], starts), "tb": np.full(len(starts), np.nan)})
    except Exception as e:  # noqa: BLE001
        log.info("candele 1m Binance non disponibili: %s", e)
    try:
        f = store.get("fut_15m").dropna(subset=["open", "close"]).sort_values("time")
        ft = secs(f["time"])
        if parts_t and len(ft):
            keep = parts_t[0] < ft[0]
            parts_t[0] = parts_t[0][keep]
            parts[0] = {k: v[keep] for k, v in parts[0].items()}
        parts_t.append(ft)
        parts.append({"o": _f(f, "open"), "h": _f(f, "high"), "l": _f(f, "low"), "c": _f(f, "close"), "v": _f(f, "volume"), "tb": _f(f, "taker_buy")})
    except Exception as e:  # noqa: BLE001
        log.info("fut_15m non disponibile: %s", e)
    if not parts_t:
        raise RuntimeError("candele 15m non disponibili")
    t = np.concatenate(parts_t).astype(np.int64)
    cols = {k: np.concatenate([p[k] for p in parts]) for k in ("o", "h", "l", "c", "v", "tb")}
    now = int(time.time())
    return Grid("15m", step, t, np.minimum(t + step, now), cols["o"], cols["h"], cols["l"], cols["c"], cols["v"], cols["tb"], "binance_usdm")


_grid_cache: dict[str, tuple[float, Grid]] = {}
_lock = threading.Lock()


def grid(tf: str, asof: int | None = None) -> Grid:
    if tf not in TF_S:
        raise ValueError(f"tf non valido: {tf}")
    with _lock:
        hit = _grid_cache.get(tf)
    if hit and time.time() - hit[0] < 10:
        g = hit[1]
    else:
        g = _grid_15m() if tf == "15m" else _grid_spot(tf)
        with _lock:
            _grid_cache[tf] = (time.time(), g)
    return g.cut(asof) if asof is not None else g


# ===================================================================== serie native e allineamento

@dataclass
class Native:
    t: np.ndarray                     # tempo dell'osservazione (s)
    cols: dict[str, np.ndarray]
    lag: np.ndarray | int             # avail = t + lag
    agg: str                          # last | mean | sum
    res: int                          # risoluzione nativa (s); 0 = eventi
    stale: int | None = None          # età massima del valore ripetuto (last)
    fill0: bool = False               # sum: candele senza eventi = 0 dentro la copertura

    def avail(self) -> np.ndarray:
        return (self.t + self.lag).astype(np.int64)

    def cut(self, asof: int) -> "Native":
        m = self.avail() <= asof
        lag = self.lag[m] if isinstance(self.lag, np.ndarray) else self.lag
        return Native(self.t[m], {k: v[m] for k, v in self.cols.items()}, lag, self.agg, self.res, self.stale, self.fill0)


def _nat(t, cols: dict, lag, agg: str, res: int, **kw) -> Native:
    t = np.asarray(t, dtype=np.int64)
    lag_a = np.asarray(lag, dtype=np.int64) if np.ndim(lag) else int(lag)
    av = t + lag_a
    order = np.argsort(av, kind="stable")
    t = t[order]
    cols = {k: np.asarray(v, dtype=float)[order] for k, v in cols.items()}
    if np.ndim(lag_a):
        lag_a = lag_a[order]
    return Native(t, cols, lag_a, agg, res, **kw)


def align(nat: Native, g: Grid) -> tuple[dict[str, np.ndarray], np.ndarray | None]:
    """Valori noti alla chiusura di ogni candela (vedi docstring del modulo). Ritorna (colonne, tempo dell'osservazione | None)."""
    n = len(g.t)
    out: dict[str, np.ndarray] = {}
    if n == 0 or len(nat.t) == 0:
        return {k: np.full(n, np.nan) for k in nat.cols}, (np.full(n, -1, dtype=np.int64) if nat.agg != "sum" else None)
    av = nat.avail()
    if nat.agg == "last" or (nat.agg == "mean" and nat.res >= g.step):
        stale = nat.stale if nat.stale is not None else int(np.max(nat.lag)) + 4 * max(nat.res, 3600)
        idx = np.searchsorted(av, g.close, side="right") - 1
        ic = np.clip(idx, 0, None)
        ok = (idx >= 0) & ((g.close - av[ic]) <= stale)
        for k, v in nat.cols.items():
            out[k] = np.where(ok, v[ic], np.nan)
        return out, np.where(ok, nat.t[ic], -1)
    b = np.searchsorted(g.close, av, side="left")
    bc = np.clip(b, 0, n - 1)
    valid = (b < n) & (av > g.t[bc])
    bb = b[valid]
    for k, v in nat.cols.items():
        vv = v[valid]
        fin = np.isfinite(vv)
        cnt = np.bincount(bb[fin], minlength=n)
        s = np.bincount(bb[fin], weights=vv[fin], minlength=n)
        res = s / np.where(cnt > 0, cnt, 1) if nat.agg == "mean" else s
        res = np.where(cnt > 0, res, np.nan)
        if nat.fill0 and len(bb):
            first = int(bb.min())
            res[first:] = np.where(np.isnan(res[first:]), 0.0, res[first:])
        out[k] = res
    return out, None


# ===================================================================== builder delle serie native

def _pts_native(pts: list[dict], lag: int, agg: str, res: int, col: str, scale: float = 1.0) -> Native:
    t = np.array([p["time"] for p in pts if p.get("value") is not None], dtype=np.int64)
    v = np.array([p["value"] for p in pts if p.get("value") is not None], dtype=float) * scale
    return _nat(t, {col: v}, lag, agg, res)


def _daily_close_map() -> pd.Series:
    d = store.get("daily")
    s = d.set_index(pd.to_datetime(d["time"], utc=True).dt.normalize())["close"].astype(float)
    return s[~s.index.duplicated(keep="last")]


def n_funding_binance(tf: str) -> Native:
    f = store.get("funding").dropna(subset=["rate"])
    return _nat(secs(f["time"]), {"f": f["rate"].to_numpy(float) * 100}, 0, "mean", 8 * 3600)


def n_funding_agg(tf: str) -> Native:
    return _pts_native(aggregate._history()["funding"]["weighted"], DAY, "mean", DAY, "f")


def n_oi_binance(tf: str) -> Native:
    o = store.get("oi_15m").dropna(subset=["oi"])
    return _nat(secs(o["time"]), {"oi": o["oi"].to_numpy(float)}, 900, "last", 900)


def n_oi_agg(tf: str) -> Native:
    parts = []
    for name in ("oi_15m", "oi15_bybit", "oi15_okx"):
        d = store.get(name)[["time", "oi"]].dropna()
        d = d.assign(time=pd.to_datetime(d["time"], utc=True)).drop_duplicates("time", keep="last").set_index("time")["oi"].rename(name)
        parts.append(d)
    m = pd.concat(parts, axis=1, join="inner").dropna()
    return _nat(secs(m.index), {"oi": m.sum(axis=1).to_numpy(float)}, 900, "last", 900)


def n_ls(tf: str) -> Native:
    d = store.get("ls").dropna(subset=["ls_accounts"])
    return _nat(secs(d["time"]), {"r": d["ls_accounts"].to_numpy(float)}, 3600, "last", 3600)


def n_liquidations(tf: str) -> Native:
    d = store.liquidations()
    if d is None or d.empty:
        return _nat([], {"long": [], "short": []}, 0, "sum", 0, fill0=True)
    usd = d["usd"].to_numpy(float)
    side = d["side"].astype(str).to_numpy()
    return _nat(secs(d["time"]), {"long": np.where(side == "long", usd, 0.0), "short": np.where(side == "short", usd, 0.0)}, 0, "sum", 0, fill0=True)


FUT_DS = {"15m": ("fut_15m", 900), "1h": ("fut_1h", 3600), "4h": ("fut_1h", 3600), "1d": ("fut_1d", DAY), "1w": ("fut_1d", DAY)}


def n_cvd_perp(tf: str) -> Native:
    name, res = FUT_DS[tf]
    f = store.get(name).dropna(subset=["volume", "taker_buy"])
    d = 2 * f["taker_buy"].to_numpy(float) - f["volume"].to_numpy(float)
    return _nat(secs(f["time"]), {"d": d, "v": f["volume"].to_numpy(float)}, res, "sum", res)


def n_cb_premium(tf: str) -> Native:
    dly = sentiment._premium_daily()
    td = secs(dly.index)
    if tf in ("15m", "1h", "4h"):
        cb = store.get("pos_cb_1h")
        k = store.get("k_1h")
        a = cb.assign(time=pd.to_datetime(cb["time"], utc=True)).set_index("time")["close"].astype(float)
        b = k.assign(time=pd.to_datetime(k["time"], utc=True)).set_index("time")["close"].astype(float)
        p = ((a / b.reindex(a.index) - 1) * 100).dropna()
        p = p[p.abs() < 5]
        th = secs(p.index)
        if len(th):
            keep = td + DAY <= th[0]
            t = np.r_[td[keep], th]
            v = np.r_[dly.to_numpy(float)[keep], p.to_numpy(float)]
            lag = np.r_[np.full(int(keep.sum()), DAY), np.full(len(th), 3600)]
            return _nat(t, {"p": v}, lag, "mean", 3600, stale=DAY + 6 * 3600)
    return _nat(td, {"p": dly.to_numpy(float)}, DAY, "mean", DAY)


def n_basis(tf: str) -> Native:
    _, cm, _, _ = basis._hist("basis_usdm_1d", basis.SERIES_START["usdm"])
    return _pts_native(cm, DAY, "last", DAY, "b")


def n_etf(tf: str) -> Native:
    e = store.get("sd_etf").dropna(subset=["total_reported"])
    return _nat(secs(e["time"]), {"f": e["total_reported"].to_numpy(float)}, ETF_LAG, "sum", DAY)


def _sd_exchange() -> pd.DataFrame:
    return store.get("sd_exchange").dropna(subset=["SplyExNtv"])


def n_exch_reserve(tf: str) -> Native:
    x = _sd_exchange()
    return _nat(secs(x["time"]), {"r": x["SplyExNtv"].to_numpy(float)}, ONCHAIN_LAG, "last", DAY)


def n_exch_netflow(tf: str) -> Native:
    x = store.get("sd_exchange").dropna(subset=["FlowInExNtv", "FlowOutExNtv"])
    return _nat(secs(x["time"]), {"n": (x["FlowInExNtv"] - x["FlowOutExNtv"]).to_numpy(float)}, ONCHAIN_LAG, "sum", DAY)


def _onchain() -> pd.DataFrame:
    return store.get("onchain").dropna(subset=["CapMVRVCur"])


def n_mvrv(tf: str) -> Native:
    o = _onchain()
    return _nat(secs(o["time"]), {"mvrv": o["CapMVRVCur"].to_numpy(float)}, ONCHAIN_LAG, "last", DAY)


def n_nupl(tf: str) -> Native:
    o = _onchain()
    return _nat(secs(o["time"]), {"nupl": 1 - 1 / o["CapMVRVCur"].to_numpy(float)}, ONCHAIN_LAG, "last", DAY)


def _bgeo() -> pd.DataFrame:
    bg = store.get("pos_bgeo").copy()
    bg["time"] = pd.to_datetime(bg["time"], utc=True).dt.normalize()
    return bg.drop_duplicates("time", keep="last").sort_values("time")


def n_sopr_sth(tf: str) -> Native:
    bg = _bgeo().dropna(subset=["sth_sopr"])
    return _nat(secs(bg["time"]), {"sopr": bg["sth_sopr"].to_numpy(float)}, BGEO_LAG, "last", DAY)


def n_mvrv_holders(tf: str) -> Native:
    bg = _bgeo().dropna(subset=["sth_rp", "lth_rp"])
    px = _daily_close_map().reindex(pd.DatetimeIndex(bg["time"])).to_numpy(float)
    return _nat(secs(bg["time"]), {"sth": px / bg["sth_rp"].to_numpy(float), "lth": px / bg["lth_rp"].to_numpy(float)}, BGEO_LAG, "last", DAY)


def n_fng(tf: str) -> Native:
    f = store.get("fng").dropna(subset=["value"])
    return _nat(secs(f["time"]), {"v": f["value"].to_numpy(float)}, 0, "last", DAY)


def n_usdt_dom(tf: str) -> Native:
    df, _, _ = usdt._frame()
    return _nat(secs(df["time"]), {"d": df["usdt_d"].to_numpy(float)}, DAY, "last", DAY)


def n_stables(tf: str) -> Native:
    s = store.get("stables_total").dropna(subset=["total"])
    return _nat(secs(s["time"]), {"s": s["total"].to_numpy(float) / 1e9}, DAY, "last", DAY)


def _macro(key: str) -> Callable[[str], Native]:
    def fn(tf: str) -> Native:
        m = store.get(f"macro_{key}").dropna(subset=["close"])
        return _nat(secs(m["time"]), {"c": m["close"].to_numpy(float)}, DAY, "last", DAY)
    return fn


# ------------------------------------------------------------------ serie dalla griglia (point-in-time per costruzione)

def b_volume(g: Grid) -> dict:
    return {"v": g.v}


def b_rsi(g: Grid) -> dict:
    return {"rsi": ta.rsi(pd.Series(g.c)).to_numpy(float)}


def b_macd(g: Grid) -> dict:
    m, s, h = ta.macd(pd.Series(g.c))
    return {"macd": m.to_numpy(float), "signal": s.to_numpy(float), "hist": h.to_numpy(float)}


def b_cvd_spot(g: Grid) -> dict:
    return {"d": 2 * g.tb - g.v, "v": np.where(np.isfinite(g.tb), g.v, np.nan)}


def anchors(t: np.ndarray) -> dict[str, np.ndarray]:
    """Ancore UTC (come la pagina VWAP): lunedì 00:00 · giorno 1 del mese · trimestre · 1 gennaio."""
    days = t // DAY
    dt = t.astype("datetime64[s]")
    mon = dt.astype("datetime64[M]").astype(np.int64)
    return {"w": days - (days + 3) % 7, "m": mon, "q": mon - mon % 3, "y": dt.astype("datetime64[Y]").astype(np.int64)}


def n_vwap(tf: str, asof: int | None = None) -> Native:
    """VWAP ancorati W/M/Q/Y: prezzo tipico delle candele chiuse dall'ancora, base 1h spot (15m: la griglia 15m)."""
    base = grid("15m" if tf == "15m" else "1h", asof)
    tp = (base.h + base.l + base.c) / 3
    v = np.nan_to_num(base.v)
    pv = tp * v
    cols = {}
    for p, key in anchors(base.t).items():
        k = pd.Series(key)
        num = pd.Series(pv).groupby(k).cumsum().to_numpy()
        den = pd.Series(v).groupby(k).cumsum().to_numpy()
        cols[p] = np.where(den > 0, num / np.where(den > 0, den, 1), np.nan)
    return _nat(base.t, cols, (base.close - base.t).astype(np.int64), "last", base.step, stale=base.step * 2)


# ===================================================================== catalogo

@dataclass
class Ind:
    id: str
    group: str
    cols: list[str]
    native: Callable[[str], Native] | None = None       # serie nativa (allineata)
    bar: Callable[[Grid], dict] | None = None           # serie calcolata sulla griglia
    anom: tuple[str, str] | None = None                 # (colonna, trasformazione) per le anomalie
    place: str = "pane"                                 # pane | overlay
    cum: list[str] = field(default_factory=list)        # colonne cumulate nella finestra (CVD)
    nd: int = 4                                         # cifre significative indicative (arrotondamento)
    unit: str = ""
    source: str = ""
    res: int = 0                                        # risoluzione nativa (s; 0 = timeframe del grafico)
    lag: int = 0                                        # ritardo tipico oltre la chiusura del periodo (s)
    na_tf: tuple[str, ...] = ()                         # timeframe senza dati
    obs: bool = True                                    # restituire il tempo dell'osservazione
    hidden: tuple[str, ...] = ()                        # colonne di servizio non restituite


INDICATORS: list[Ind] = [
    Ind("vwap", "price", ["w", "m", "q", "y"], native=lambda tf: n_vwap(tf), place="overlay", nd=7, unit="usd", source="binance_spot", obs=False),
    Ind("volume", "price", ["v"], bar=b_volume, anom=("v", "log"), unit="btc", source="binance_spot"),
    Ind("rsi", "price", ["rsi"], bar=b_rsi, unit="idx", source="binance_spot"),
    Ind("macd", "price", ["macd", "signal", "hist"], bar=b_macd, unit="usd", source="binance_spot"),
    Ind("funding_binance", "derivatives", ["f"], native=n_funding_binance, anom=("f", "level"), unit="pct_8h", source="binance", res=8 * 3600),
    Ind("funding_agg", "derivatives", ["f"], native=n_funding_agg, anom=("f", "level"), unit="pct_8h", source="agg3", res=DAY, lag=DAY),
    Ind("oi_binance", "derivatives", ["oi"], native=n_oi_binance, anom=("oi", "pct"), unit="btc", source="binance", res=900),
    Ind("oi_agg", "derivatives", ["oi"], native=n_oi_agg, anom=("oi", "pct"), unit="btc", source="agg3", res=900),
    Ind("ls_ratio", "derivatives", ["r"], native=n_ls, anom=("r", "level"), unit="ratio", source="binance", res=3600),
    Ind("liquidations", "derivatives", ["long", "short"], native=n_liquidations, anom=("long+short", "log1p"), unit="usd", source="agg3_live", res=0),
    Ind("cvd_spot", "derivatives", ["d"], bar=b_cvd_spot, anom=("imb", "level"), cum=["d"], unit="btc", source="binance_spot", na_tf=("15m",), hidden=("v",)),
    Ind("cvd_perp", "derivatives", ["d"], native=n_cvd_perp, anom=("imb", "level"), cum=["d"], unit="btc", source="binance_usdm", hidden=("v",)),
    Ind("cb_premium", "derivatives", ["p"], native=n_cb_premium, anom=("p", "level"), unit="pct", source="coinbase", res=3600),
    Ind("basis", "derivatives", ["b"], native=n_basis, anom=("b", "level"), unit="pct", source="binance_usdm", res=DAY),
    Ind("etf_flows", "flows", ["f"], native=n_etf, anom=("f", "level"), unit="musd", source="farside", res=DAY, lag=ETF_LAG - DAY),
    Ind("exch_reserve", "flows", ["r"], native=n_exch_reserve, anom=("r", "pct"), unit="btc", source="coinmetrics", res=DAY, lag=ONCHAIN_LAG - DAY),
    Ind("exch_netflow", "flows", ["n"], native=n_exch_netflow, anom=("n", "level"), unit="btc", source="coinmetrics", res=DAY, lag=ONCHAIN_LAG - DAY),
    Ind("mvrv", "onchain", ["mvrv"], native=n_mvrv, unit="ratio", source="coinmetrics", res=DAY, lag=ONCHAIN_LAG - DAY),
    Ind("nupl", "onchain", ["nupl"], native=n_nupl, unit="ratio", source="coinmetrics", res=DAY, lag=ONCHAIN_LAG - DAY),
    Ind("sopr_sth", "onchain", ["sopr"], native=n_sopr_sth, anom=("sopr", "diff"), unit="ratio", source="bgeometrics", res=DAY, lag=BGEO_LAG - DAY),
    Ind("mvrv_holders", "onchain", ["sth", "lth"], native=n_mvrv_holders, unit="ratio", source="bgeometrics", res=DAY, lag=BGEO_LAG - DAY),
    Ind("fng", "macro", ["v"], native=n_fng, anom=("v", "diff"), unit="idx", source="alternative", res=DAY),
    Ind("usdt_dom", "macro", ["d"], native=n_usdt_dom, unit="pct", source="coinmetrics_cg", res=DAY),
    Ind("stables", "macro", ["s"], native=n_stables, anom=("s", "pct"), unit="busd", source="defillama", res=DAY),
    Ind("dxy", "macro", ["c"], native=_macro("dxy"), anom=("c", "pct"), unit="idx", source="yahoo", res=DAY),
    Ind("spx", "macro", ["c"], native=_macro("spx"), anom=("c", "pct"), unit="idx", source="yahoo", res=DAY),
    Ind("gold", "macro", ["c"], native=_macro("gold"), anom=("c", "pct"), unit="usd", source="yahoo", res=DAY),
]
IND = {i.id: i for i in INDICATORS}

PRESETS = [
    {"id": "essential", "tf": "4h", "log": False, "panes": [
        {"id": "vwap", "h": 0, "ov": True, "an": False}, {"id": "volume", "h": 90, "an": True},
        {"id": "funding_binance", "h": 110, "an": True}, {"id": "oi_agg", "h": 110, "an": True}, {"id": "fng", "h": 100, "an": False}]},
    {"id": "derivatives", "tf": "1h", "log": False, "panes": [
        {"id": "funding_binance", "h": 110, "an": True}, {"id": "oi_agg", "h": 110, "an": True}, {"id": "liquidations", "h": 110, "an": True},
        {"id": "cvd_perp", "h": 110, "an": False}, {"id": "ls_ratio", "h": 100, "an": False}, {"id": "cb_premium", "h": 100, "an": False}]},
    {"id": "onchain", "tf": "1d", "log": True, "panes": [
        {"id": "mvrv", "h": 110, "an": False}, {"id": "nupl", "h": 100, "an": False}, {"id": "sopr_sth", "h": 100, "an": True},
        {"id": "exch_reserve", "h": 110, "an": True}, {"id": "etf_flows", "h": 110, "an": True}]},
    {"id": "macro", "tf": "1d", "log": True, "panes": [
        {"id": "dxy", "h": 100, "an": True}, {"id": "spx", "h": 100, "an": True}, {"id": "gold", "h": 100, "an": False},
        {"id": "usdt_dom", "h": 110, "an": False}, {"id": "stables", "h": 100, "an": False}]},
]


# ===================================================================== calcolo di un indicatore

@dataclass
class Computed:
    cols: dict[str, np.ndarray]
    obs: np.ndarray | None
    anomalies: list[tuple]           # (indice candela, z, valore grezzo, valore trasformato, mediana, tempo osservazione)
    first: int | None                # prima osservazione nativa (s)
    last: int | None
    ms: int = 0


def _anoms_on_bars(g: Grid, x: np.ndarray, how: str, thr: float, obs: np.ndarray | None) -> list[tuple]:
    """Anomalie misurate al timeframe del grafico. La candela in formazione è esclusa (valori parziali)."""
    y = an.transform(x, how)
    z, med = robust_z_med(y, an.window_for(g.step))
    if len(g.t) and g.close[-1] < g.t[-1] + g.step:
        z = z.copy()
        z[-1] = np.nan
    ii = an.decluster(g.t, z, thr, 6 * g.step)
    return [(int(i), float(z[i]), float(x[i]), float(y[i]), _fnum(med[i]), int(obs[i]) if obs is not None and obs[i] >= 0 else int(g.t[i])) for i in ii]


def _anoms_on_native(nat: Native, col: str, how: str, g: Grid, thr: float) -> list[tuple]:
    if not len(nat.t) or not len(g.t):
        return []
    x = nat.cols[col]
    y = an.transform(x, how)
    z, med = robust_z_med(y, an.window_for(max(nat.res, 3600)))
    gap = 3 * max(nat.res, 3600)
    ii = an.decluster(nat.t, z, thr, gap)
    if not len(ii):
        return []
    av = nat.avail()[ii]
    b = np.searchsorted(g.close, av, side="left")
    best: dict[int, tuple] = {}
    for k, i in enumerate(ii):
        if b[k] >= len(g.t):
            continue        # non ancora disponibile alla chiusura dell'ultima candela
        row = (int(b[k]), float(z[i]), float(x[i]), float(y[i]), _fnum(med[i]), int(nat.t[i]))
        cur = best.get(row[0])
        if cur is None or abs(row[1]) > abs(cur[1]):
            best[row[0]] = row
    return [best[k] for k in sorted(best)]


def _anom_x(cols: dict[str, np.ndarray], col: str) -> np.ndarray:
    """Serie su cui cercare le anomalie: una colonna, la somma long+short, o lo sbilanciamento taker delta/volume (CVD)."""
    if col == "long+short":
        return cols["long"] + cols["short"]
    if col == "imb":
        v = cols["v"]
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(v > 0, cols["d"] / np.where(v > 0, v, 1), np.nan)
    return cols[col]


def _fnum(x) -> float | None:
    return float(x) if x is not None and np.isfinite(x) else None


def robust_z_med(y: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    return an.robust_z(y, window, return_med=True)


def compute(ind_id: str, tf: str, asof: int | None = None, thr: float = 3.0, want_anom: bool = True) -> tuple[Grid, Computed]:
    ind = IND[ind_id]
    g = grid(tf, asof)
    t0 = time.perf_counter()
    if tf in ind.na_tf:
        return g, Computed({c: np.full(len(g.t), np.nan) for c in ind.cols}, None, [], None, None)
    anoms: list[tuple] = []
    if ind.bar is not None:
        cols = {k: np.asarray(v, dtype=float) for k, v in ind.bar(g).items()}
        obs = None
        if want_anom and ind.anom:
            anoms = _anoms_on_bars(g, _anom_x(cols, ind.anom[0]), ind.anom[1], thr, None)
        first = int(g.t[0]) if len(g.t) else None
        last = int(g.t[-1]) if len(g.t) else None
    else:
        nat = n_vwap(tf, asof) if ind.id == "vwap" else ind.native(tf)
        if asof is not None:
            nat = nat.cut(asof)
        cols, obs = align(nat, g)
        if not ind.obs:
            obs = None
        if want_anom and ind.anom:
            col, how = ind.anom
            if col in ("long+short", "imb") or nat.res < g.step:
                # serie più fine del grafico: anomalie al timeframe del grafico (valore noto a fine candela)
                anoms = _anoms_on_bars(g, _anom_x(cols, col), how, thr, None)
            else:
                anoms = _anoms_on_native(nat, col, how, g, thr)
        first = int(nat.t[0]) if len(nat.t) else None
        last = int(nat.t[-1]) if len(nat.t) else None
    return g, Computed(cols, obs, anoms, first, last, int((time.perf_counter() - t0) * 1000))


_cache: dict[tuple, tuple[float, Grid, Computed]] = {}


def compute_cached(ind_id: str, tf: str, thr: float = 3.0) -> tuple[Grid, Computed]:
    key = (ind_id, tf, thr)
    hit = _cache.get(key)
    g_now = grid(tf)
    if hit and time.time() - hit[0] < 30 and hit[1] is g_now:
        return hit[1], hit[2]
    g, c = compute(ind_id, tf, None, thr)
    _cache[key] = (time.time(), g, c)
    return g, c


# ===================================================================== risposta (colonnare, compatta)

def _col(x: np.ndarray, sig: int = 6) -> list:
    """Array → lista JSON (NaN → null), arrotondata a `sig` cifre significative (compressione)."""
    x = np.asarray(x, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        mag = np.where(np.isfinite(x) & (x != 0), np.floor(np.log10(np.abs(np.where(x == 0, 1, x)))), 0)
    dec = np.clip(sig - 1 - mag, 0, 12).astype(int)
    out = []
    for v, d in zip(x.tolist(), dec.tolist()):
        out.append(None if v != v or v in (float("inf"), float("-inf")) else round(v, d))
    return out


def window(g: Grid, bars: int | None, to: int | None) -> tuple[int, int]:
    i1 = len(g.t) if to is None else int(np.searchsorted(g.t, to, side="right"))
    nb = min(MAX_BARS, max(50, int(bars or DEFAULT_BARS[g.tf])))
    return max(0, i1 - nb), i1


def candles_payload(g: Grid, i0: int, i1: int) -> dict:
    return {"o": _col(g.o[i0:i1], 7), "h": _col(g.h[i0:i1], 7), "l": _col(g.l[i0:i1], 7), "c": _col(g.c[i0:i1], 7), "v": _col(g.v[i0:i1], 5)}


def series_payload(ind: Ind, comp: Computed, i0: int, i1: int) -> dict:
    cols = {}
    for k, v in comp.cols.items():
        if k in ind.hidden:
            continue
        x = v[i0:i1]
        if k in ind.cum:
            fin = np.isfinite(x)
            cs = np.cumsum(np.where(fin, x, 0.0))
            started = np.maximum.accumulate(fin) if len(fin) else fin
            x = np.where(started, cs, np.nan)
        cols[k] = _col(x, 6)
    an_rows = [[int(i) - i0, round(z, 2), _round(v), _round(y), _round(m), ot] for i, z, v, y, m, ot in comp.anomalies if i0 <= i < i1]
    out = {"cols": cols, "first": comp.first, "last": comp.last, "anomalies": an_rows, "ms": comp.ms}
    if comp.obs is not None:
        o = comp.obs[i0:i1]
        out["obs"] = [int(x) if x >= 0 else None for x in o.tolist()]
    return out


def _round(x):
    if x is None or not np.isfinite(x):
        return None
    return float(f"{x:.5g}")


def catalog() -> dict:
    items = []
    for i in INDICATORS:
        items.append({"id": i.id, "group": i.group, "cols": i.cols, "place": i.place, "anom": i.anom is not None,
                      "anom_how": i.anom[1] if i.anom else None, "unit": i.unit, "source": i.source, "res": i.res, "lag": i.lag,
                      "na_tf": list(i.na_tf), "cum": i.cum})
    return {"indicators": items, "presets": PRESETS, "tfs": list(TF_S), "default_bars": DEFAULT_BARS, "max_bars": MAX_BARS}
