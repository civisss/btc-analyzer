"""Leva aggregata Binance + Bybit + OKX: open interest (BTC e USD) per exchange e totale, funding per exchange e medio
ponderato per OI, long/short, storico giornaliero (Bybit dal 2020) e raccolta persistente in avanti.

Contratti inclusi (perpetui BTC, i principali per ogni exchange):
  Binance  BTCUSDT (USDⓈ-M), BTCUSDC (USDC-M), BTCUSD_PERP (COIN-M, 100 USD/contratto)
  Bybit    BTCUSDT, BTCPERP (USDC), BTCUSD (inverso, OI in USD)
  OKX      BTC-USDT-SWAP (0.01 BTC/contratto), BTC-USD-SWAP (inverso, 100 USD/contratto)
Esclusi: futures a scadenza, CME, Deribit, Hyperliquid e gli altri exchange (vedi `crosscheck.coverage_pct`).

ATTENZIONE Bybit: nella API v5 `openInterest` è la somma dei DUE lati (doc ufficiale: "sum of both sides"); l'OI
convenzionale (un lato, come Binance e OKX) è `singleOpenInterest`. Qui si usa sempre il valore a un lato.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store

log = logging.getLogger("aggregate")

BIN_F = "https://fapi.binance.com"
BIN_D = "https://dapi.binance.com"
BYBIT = "https://api.bybit.com/v5/market"
OKX = "https://www.okx.com/api/v5"
COINGECKO_DERIV = "https://api.coingecko.com/api/v3/derivatives"

EXCHANGES = [("binance", "Binance"), ("bybit", "Bybit"), ("okx", "OKX")]
CONTRACTS = {
    "binance": [("BTCUSDT", "USDT"), ("BTCUSDC", "USDC"), ("BTCUSD_PERP", "COIN-M")],
    "bybit": [("BTCUSDT", "USDT"), ("BTCPERP", "USDC"), ("BTCUSD", "COIN-M")],
    "okx": [("BTC-USDT-SWAP", "USDT"), ("BTC-USD-SWAP", "COIN-M")],
}
# nomi dei mercati su CoinGecko /derivatives per il controllo incrociato
CG_MARKETS = {"binance": "Binance (Futures)", "bybit": "Bybit (Futures)", "okx": "OKX (Futures)"}
DAY_MS = 86_400_000


def _f(x) -> float | None:
    try:
        v = float(x)
        return v if np.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _okx(path: str, params: dict) -> list:
    r = src._get(f"{OKX}{path}", params)
    if str(r.get("code")) != "0":
        raise RuntimeError(f"OKX {path}: {r.get('msg') or r.get('code')}")
    return r.get("data") or []


def _bybit(path: str, params: dict) -> dict:
    r = src._get(f"{BYBIT}{path}", params)
    if int(r.get("retCode", -1)) != 0:
        raise RuntimeError(f"Bybit {path}: {r.get('retMsg')}")
    return r.get("result") or {}


# =================================================================== snapshot live

def _binance_live() -> list[dict]:
    prem = {p["symbol"]: p for p in src._get(f"{BIN_F}/fapi/v1/premiumIndex") if p.get("symbol") in ("BTCUSDT", "BTCUSDC")}
    out = []
    for sym, kind in (("BTCUSDT", "USDT"), ("BTCUSDC", "USDC")):
        oi = float(src._get(f"{BIN_F}/fapi/v1/openInterest", {"symbol": sym})["openInterest"])
        mark = float(prem[sym]["markPrice"])
        out.append({"symbol": sym, "kind": kind, "oi_btc": oi, "oi_usd": oi * mark, "funding": float(prem[sym]["lastFundingRate"]),
                    "interval_h": 8, "mark": mark})
    p = src._get(f"{BIN_D}/dapi/v1/premiumIndex", {"symbol": "BTCUSD_PERP"})[0]
    oi = float(src._get(f"{BIN_D}/dapi/v1/openInterest", {"symbol": "BTCUSD_PERP"})["openInterest"])  # contratti da 100 USD
    mark = float(p["markPrice"])
    out.append({"symbol": "BTCUSD_PERP", "kind": "COIN-M", "oi_btc": oi * 100 / mark, "oi_usd": oi * 100, "funding": float(p["lastFundingRate"]),
                "interval_h": 8, "mark": mark})
    return out


def _bybit_live() -> list[dict]:
    out = []
    for cat, sym, kind in (("linear", "BTCUSDT", "USDT"), ("linear", "BTCPERP", "USDC"), ("inverse", "BTCUSD", "COIN-M")):
        t = _bybit("/tickers", {"category": cat, "symbol": sym})["list"][0]
        mark = float(t["markPrice"])
        single = _f(t.get("singleOpenInterest"))
        both = _f(t.get("openInterest"))
        if single is None and both is not None:  # campo assente: la doc dice che openInterest conta i due lati
            single = both / 2
        if cat == "inverse":  # OI in USD
            oi_usd, oi_btc = single, single / mark
            both_usd = both
        else:
            oi_btc, oi_usd = single, single * mark
            both_usd = (both or 0) * mark
        out.append({"symbol": sym, "kind": kind, "oi_btc": oi_btc, "oi_usd": oi_usd, "funding": float(t.get("fundingRate") or 0),
                    "interval_h": float(t.get("fundingIntervalHour") or 8), "mark": mark, "oi_usd_both_sides": both_usd})
    return out


def _okx_live() -> list[dict]:
    out = []
    for sym, kind in (("BTC-USDT-SWAP", "USDT"), ("BTC-USD-SWAP", "COIN-M")):
        oi = _okx("/public/open-interest", {"instType": "SWAP", "instId": sym})[0]
        fr = _okx("/public/funding-rate", {"instId": sym})[0]
        mk = _okx("/public/mark-price", {"instType": "SWAP", "instId": sym})[0]
        interval = (int(fr.get("nextFundingTime") or 0) - int(fr.get("fundingTime") or 0)) / 3_600_000 or 8
        out.append({"symbol": sym, "kind": kind, "oi_btc": float(oi["oiCcy"]), "oi_usd": float(oi["oiUsd"]),
                    "funding": float(fr["fundingRate"]), "interval_h": interval if 0 < interval <= 24 else 8, "mark": float(mk["markPx"])})
    return out


_LIVE = {"binance": _binance_live, "bybit": _bybit_live, "okx": _okx_live}


@util.ttl_cache(30)
def live_snapshot() -> dict:
    """{exchange: [contratti] | {"error": str}} — richieste in parallelo."""
    out: dict = {}
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {k: ex.submit(fn) for k, fn in _LIVE.items()}
        for k, f in futs.items():
            try:
                out[k] = f.result(timeout=40)
            except Exception as e:  # noqa: BLE001
                log.warning("snapshot %s non disponibile: %s", k, e)
                out[k] = {"error": str(e)[:200]}
    out["time"] = time.time()
    return out


def _ex_totals(contracts: list[dict]) -> dict:
    oi_btc = sum(c["oi_btc"] for c in contracts)
    oi_usd = sum(c["oi_usd"] for c in contracts)
    f8 = [(c["funding"] * 8 / c["interval_h"] * 100, c["oi_usd"]) for c in contracts]
    w = sum(u for _, u in f8)
    fund = sum(f * u for f, u in f8) / w if w else None
    return {"oi_btc": oi_btc, "oi_usd": oi_usd, "funding_8h": fund}


# =================================================================== storico giornaliero (dataset persistenti)

def _ns(df: pd.DataFrame) -> pd.DataFrame:
    """Colonna time sempre datetime64[ns, UTC] (le sorgenti producono ms/us/ns)."""
    if df is not None and "time" in df and len(df):
        df = df.copy()
        df["time"] = pd.to_datetime(df["time"], utc=True).astype("datetime64[ns, UTC]")
    return df


def _merge(old, new: pd.DataFrame) -> pd.DataFrame:
    new = _ns(new)
    if old is None or old.empty:
        return new.sort_values("time").reset_index(drop=True)
    o = _ns(old)
    out = pd.concat([o, new]).drop_duplicates("time", keep="last").sort_values("time")
    return out.reset_index(drop=True)


def _combine(frames: list[pd.DataFrame]) -> pd.DataFrame:
    frames = [_ns(f) for f in frames if f is not None and not f.empty]
    if not frames:
        return pd.DataFrame(columns=["time"])
    out = frames[0]
    for f in frames[1:]:
        out = out.merge(f, on="time", how="outer")
    return out.sort_values("time").reset_index(drop=True)


def _bybit_pages(path: str, params: dict, ts_key: str, start_ms: int, limit: int) -> list[dict]:
    """Pagine all'indietro con endTime fino a start_ms."""
    rows: list[dict] = []
    end = int(time.time() * 1000)
    for _ in range(400):
        lst = _bybit(path, {**params, "limit": limit, "startTime": start_ms, "endTime": end}).get("list") or []
        if not lst:
            break
        rows.extend(lst)
        oldest = min(int(x[ts_key]) for x in lst)
        if oldest <= start_ms or len(lst) < limit:
            break
        end = oldest - 1
    return rows


def _daily_open() -> pd.DataFrame:
    try:
        d = store.get("daily")[["time", "open"]].copy()
        d["time"] = pd.to_datetime(d["time"], utc=True).dt.normalize()
        return _ns(d.drop_duplicates("time", keep="last"))
    except Exception:  # noqa: BLE001
        return pd.DataFrame(columns=["time", "open"])


def _bybit_1d(old):
    start = 1_577_836_800_000  # 1 gen 2020 (Bybit risponde dal primo giorno disponibile)
    if old is not None and not old.empty:
        start = int(pd.Timestamp(old["time"].iloc[-1]).timestamp() * 1000) - 3 * DAY_MS
    frames = []
    for cat, sym, col in (("linear", "BTCUSDT", "oi_usdt"), ("linear", "BTCPERP", "oi_usdc"), ("inverse", "BTCUSD", "oi_inverse_usd")):
        rows = _bybit_pages("/open-interest", {"category": cat, "symbol": sym, "intervalTime": "1d"}, "timestamp", start, 200)
        if rows:
            df = pd.DataFrame(rows)
            single = pd.to_numeric(df.get("singleOpenInterest"), errors="coerce") if "singleOpenInterest" in df else None
            both = pd.to_numeric(df["openInterest"], errors="coerce")
            val = single.fillna(both / 2) if single is not None else both / 2
            frames.append(pd.DataFrame({"time": pd.to_datetime(df["timestamp"].astype("int64"), unit="ms", utc=True), col: val}).drop_duplicates("time"))
    rows = _bybit_pages("/funding/history", {"category": "linear", "symbol": "BTCUSDT"}, "fundingRateTimestamp", start, 200)
    if rows:
        f = pd.DataFrame(rows)
        f["time"] = pd.to_datetime(f["fundingRateTimestamp"].astype("int64"), unit="ms", utc=True).dt.floor("D")
        f["rate"] = pd.to_numeric(f["fundingRate"], errors="coerce")
        frames.append(f.groupby("time", as_index=False)["rate"].mean().rename(columns={"rate": "funding"}))
    rows = _bybit_pages("/account-ratio", {"category": "linear", "symbol": "BTCUSDT", "period": "1d"}, "timestamp", start, 500)
    if rows:
        r = pd.DataFrame(rows)
        frames.append(pd.DataFrame({"time": pd.to_datetime(r["timestamp"].astype("int64"), unit="ms", utc=True),
                                    "long_pct": pd.to_numeric(r["buyRatio"], errors="coerce")}).drop_duplicates("time"))
    new = _combine(frames)
    if "oi_inverse_usd" in new:
        px = _daily_open()
        new = pd.merge_asof(new.sort_values("time"), px.rename(columns={"open": "_px"}), on="time", direction="backward")
        new["oi_inverse"] = new["oi_inverse_usd"] / new["_px"]
        new = new.drop(columns=["_px"])
    if old is not None and not old.empty:  # non sovrascrivere colonne valide con NaN di una pagina parziale
        o = _ns(old)
        if new.empty:
            return o
        return new.set_index("time").combine_first(o.set_index("time")).reset_index().sort_values("time").reset_index(drop=True)
    return new


def _okx_hist(inst: str, period: str, until_ms: int | None = None, max_pages: int = 40) -> pd.DataFrame:
    rows = []
    end = None
    for _ in range(max_pages):
        p = {"instId": inst, "period": period, "limit": 100}
        if end:
            p["end"] = end
        data = _okx("/rubik/stat/contracts/open-interest-history", p)
        if not data:
            break
        rows.extend(data)
        oldest = min(int(x[0]) for x in data)
        if until_ms and oldest <= until_ms:
            break
        end = oldest
        time.sleep(0.12)  # 20 richieste / 2 s
    if not rows:
        return pd.DataFrame(columns=["time", "oi"])
    df = pd.DataFrame(rows).iloc[:, :4]
    df.columns = ["ts", "oi_ct", "oi_ccy", "oi_usd"]
    return pd.DataFrame({"time": pd.to_datetime(df["ts"].astype("int64"), unit="ms", utc=True),
                         "oi": pd.to_numeric(df["oi_ccy"], errors="coerce")}).drop_duplicates("time").sort_values("time").reset_index(drop=True)


def _okx_1d(old):
    until = None
    if old is not None and not old.empty:
        until = int(pd.Timestamp(old["time"].iloc[-1]).timestamp() * 1000) - 3 * DAY_MS
    frames = []
    for inst, col in (("BTC-USDT-SWAP", "oi_usdt"), ("BTC-USD-SWAP", "oi_inverse")):
        h = _okx_hist(inst, "1D", until)
        if not h.empty:
            # snapshot giornaliero OKX alle 16:00 UTC (mezzanotte UTC+8) -> giorno UTC successivo (scarto di 8 h)
            h["time"] = (h["time"] + pd.Timedelta(hours=8)).dt.floor("D")
            frames.append(h.rename(columns={"oi": col}).drop_duplicates("time", keep="last"))
    fr = []
    after = None
    for _ in range(10):  # funding: OKX conserva circa 3 mesi -> si accumula
        p = {"instId": "BTC-USDT-SWAP", "limit": 100}
        if after:
            p["after"] = after
        data = _okx("/public/funding-rate-history", p)
        if not data:
            break
        fr.extend(data)
        after = min(int(x["fundingTime"]) for x in data)
        if until and after <= until:
            break
        time.sleep(0.12)
    if fr:
        f = pd.DataFrame(fr)
        f["time"] = pd.to_datetime(f["fundingTime"].astype("int64"), unit="ms", utc=True).dt.floor("D")
        f["rate"] = pd.to_numeric(f.get("realizedRate", f["fundingRate"]), errors="coerce").fillna(pd.to_numeric(f["fundingRate"], errors="coerce"))
        frames.append(f.groupby("time", as_index=False)["rate"].mean().rename(columns={"rate": "funding"}))
    try:
        ls = _okx("/rubik/stat/contracts/long-short-account-ratio-contract", {"instId": "BTC-USDT-SWAP", "period": "1D", "limit": 100})
        if ls:
            d = pd.DataFrame(ls).iloc[:, :2]
            d.columns = ["ts", "ratio"]
            r = pd.to_numeric(d["ratio"], errors="coerce")
            t = (pd.to_datetime(d["ts"].astype("int64"), unit="ms", utc=True) + pd.Timedelta(hours=8)).dt.floor("D")
            frames.append(pd.DataFrame({"time": t, "long_pct": r / (1 + r)}).drop_duplicates("time"))
    except Exception as e:  # noqa: BLE001
        log.warning("long/short OKX non disponibile: %s", e)
    new = _combine(frames)
    if old is not None and not old.empty:
        o = _ns(old)
        if new.empty:
            return o
        return new.set_index("time").combine_first(o.set_index("time")).reset_index().sort_values("time").reset_index(drop=True)
    return new


def _binance_1d(old):
    frames = []
    for base, path, params, col, val in (
        (BIN_F, "/futures/data/openInterestHist", {"symbol": "BTCUSDT"}, "oi_usdt", "sumOpenInterest"),
        (BIN_F, "/futures/data/openInterestHist", {"symbol": "BTCUSDC"}, "oi_usdc", "sumOpenInterest"),
        (BIN_D, "/futures/data/openInterestHist", {"pair": "BTCUSD", "contractType": "PERPETUAL"}, "oi_inverse", "sumOpenInterestValue"),
    ):
        rows = src._get(f"{base}{path}", {**params, "period": "1d", "limit": 30})
        if rows:
            d = pd.DataFrame(rows)
            frames.append(pd.DataFrame({"time": pd.to_datetime(d["timestamp"].astype("int64"), unit="ms", utc=True),
                                        col: pd.to_numeric(d[val], errors="coerce")}).drop_duplicates("time"))
    return _merge(old, _combine(frames))


def _snap(old):
    """Fotografia ogni 5 minuti (raccolta in avanti a risoluzione intraday)."""
    s = live_snapshot()
    row = {"time": pd.Timestamp.now(tz="UTC").floor("5min")}
    for ex, _ in EXCHANGES:
        c = s.get(ex)
        if isinstance(c, list) and c:
            t = _ex_totals(c)
            row[f"{ex}_oi_btc"], row[f"{ex}_oi_usd"], row[f"{ex}_funding_8h"] = t["oi_btc"], t["oi_usd"], t["funding_8h"]
            row["price"] = c[0]["mark"]
    return _merge(old, pd.DataFrame([row]))


def _oi15_bybit(old):
    """OI Bybit BTCUSDT (un lato, BTC) a 15 minuti per il modello di liquidazione."""
    start = int(time.time() * 1000) - 32 * DAY_MS
    if old is not None and not old.empty:
        start = int(pd.Timestamp(old["time"].iloc[-1]).timestamp() * 1000) - 3_600_000
    rows = _bybit_pages("/open-interest", {"category": "linear", "symbol": "BTCUSDT", "intervalTime": "15min"}, "timestamp", start, 200)
    if not rows:
        return old if old is not None else pd.DataFrame(columns=["time", "oi"])
    df = pd.DataFrame(rows)
    single = pd.to_numeric(df["singleOpenInterest"], errors="coerce") if "singleOpenInterest" in df else pd.to_numeric(df["openInterest"], errors="coerce") / 2
    new = pd.DataFrame({"time": pd.to_datetime(df["timestamp"].astype("int64"), unit="ms", utc=True), "oi": single}).drop_duplicates("time")
    return _merge(old, new)


def _oi15_okx(old):
    """OI OKX BTC-USDT-SWAP a 15 minuti: OKX conserva ~10 g a 15m e ~40 g a 1h -> 1h interpolata per lo storico più vecchio."""
    frames = []
    if old is None or old.empty:
        h = _okx_hist("BTC-USDT-SWAP", "1H", int(time.time() * 1000) - 32 * DAY_MS, max_pages=10)
        if not h.empty:
            h = h.set_index("time").resample("15min").asfreq().interpolate(limit=3).reset_index()
            h["res"] = "1h"
            frames.append(h)
        q = _okx_hist("BTC-USDT-SWAP", "15m", int(time.time() * 1000) - 12 * DAY_MS, max_pages=12)
    else:
        q = _okx_hist("BTC-USDT-SWAP", "15m", int(pd.Timestamp(old["time"].iloc[-1]).timestamp() * 1000) - 3_600_000, max_pages=12)
    if not q.empty:
        q["res"] = "15m"
        frames.append(q)
    if not frames:
        return old if old is not None else pd.DataFrame(columns=["time", "oi", "res"])
    new = pd.concat(frames).drop_duplicates("time", keep="last").sort_values("time")
    return _merge(old, new)


def _cg(old):
    """CoinGecko /derivatives: perpetui BTC di tutti gli exchange (controllo incrociato e copertura)."""
    data = src._get(COINGECKO_DERIV)
    rows = [{"market": x.get("market"), "symbol": x.get("symbol"), "oi_usd": _f(x.get("open_interest")), "funding_pct": _f(x.get("funding_rate")),
             "price": _f(x.get("price"))}
            for x in data if x.get("index_id") == "BTC" and x.get("contract_type") == "perpetual"]
    df = pd.DataFrame(rows)
    df["time"] = pd.Timestamp.now(tz="UTC")
    return df


store.register("lev_bybit_1d", _bybit_1d, 6 * 3600)
store.register("lev_okx_1d", _okx_1d, 6 * 3600)
store.register("lev_binance_1d", _binance_1d, 6 * 3600)
store.register("lev_snap", _snap, 300)
store.register("oi15_bybit", _oi15_bybit, 300)
store.register("oi15_okx", _oi15_okx, 300)
store.register("lev_cg", _cg, 3 * 3600)


def _safe(name: str) -> pd.DataFrame:
    try:
        d = store.get(name)
        if d is not None and not d.empty:
            return _ns(d).sort_values("time").reset_index(drop=True)
    except Exception as e:  # noqa: BLE001
        log.warning("dataset %s non disponibile: %s", name, e)
    return pd.DataFrame()


# =================================================================== serie per il modello delle liquidazioni

def oi_15m_by_exchange() -> dict[str, pd.DataFrame]:
    """{exchange: DataFrame(time, oi BTC)} del contratto USDT principale, a 15 minuti (per il modello heatmap)."""
    out = {}
    b = _safe("oi_15m")
    if not b.empty:
        out["binance"] = b[["time", "oi"]]
    y = _safe("oi15_bybit")
    if not y.empty:
        out["bybit"] = y[["time", "oi"]]
    o = _safe("oi15_okx")
    if not o.empty:
        out["okx"] = o[["time", "oi"]]
    return out


def scale_factors() -> dict:
    """Per ogni exchange: OI totale dei perpetui inclusi / OI del contratto USDT modellato (live).
    Serve a estendere il modello (che usa la serie a 15 min del solo contratto USDT) agli altri perpetui dell'exchange."""
    s = live_snapshot()
    out = {}
    for ex, _ in EXCHANGES:
        c = s.get(ex)
        if isinstance(c, list) and c:
            usdt = next((x for x in c if x["kind"] == "USDT"), None)
            tot = sum(x["oi_btc"] for x in c)
            if usdt and usdt["oi_btc"] > 0:
                out[ex] = {"factor": tot / usdt["oi_btc"], "oi_btc": tot, "oi_usd": sum(x["oi_usd"] for x in c), "modeled_oi_btc": usdt["oi_btc"]}
    return out


# =================================================================== build

def _pts(t: pd.Series, v: pd.Series, scale: float = 1.0) -> list[dict]:
    m = v.notna()
    return util.series_pts(t[m], v[m] * scale)


def _crosscheck(s: dict) -> dict:
    cg = _safe("lev_cg")
    out = {"rows": [], "global_perp_oi_usd": None, "coverage_pct": None, "source_time": None, "contracts_global": None}
    if cg.empty:
        return out
    out["source_time"] = util.ts(cg["time"].iloc[0])
    ours_total = 0.0
    bybit_double = 0.0
    for ex, name in EXCHANGES:
        c = s.get(ex)
        if not isinstance(c, list):
            continue
        for x in c:
            ours_total += x["oi_usd"]
            r = cg[(cg["market"] == CG_MARKETS[ex]) & (cg["symbol"] == x["symbol"])]
            cg_usd = float(r["oi_usd"].iloc[0]) if len(r) and pd.notna(r["oi_usd"].iloc[0]) else None
            ref = x.get("oi_usd_both_sides") if ex == "bybit" else x["oi_usd"]
            if ex == "bybit" and cg_usd:
                bybit_double += cg_usd - x["oi_usd"]
            out["rows"].append({
                "exchange": ex, "symbol": x["symbol"], "ours_usd": x["oi_usd"], "coingecko_usd": cg_usd,
                "diff_pct": (cg_usd / ref - 1) * 100 if cg_usd and ref else None,
                "both_sides": ex == "bybit",
            })
    tot = float(cg["oi_usd"].fillna(0).sum())
    # il totale CoinGecko conta Bybit a due lati: lo si riporta a un lato prima di calcolare la quota
    tot_adj = tot - bybit_double
    out["global_perp_oi_usd"] = tot_adj
    out["contracts_global"] = int(len(cg))
    out["coverage_pct"] = ours_total / tot_adj * 100 if tot_adj > 0 else None
    return out


def _history() -> dict:
    b, y, o = _safe("lev_binance_1d"), _safe("lev_bybit_1d"), _safe("lev_okx_1d")
    fund_b = _safe("funding")
    ls_b = _safe("ls")
    frames = {}
    if not b.empty:
        frames["binance"] = b.assign(oi_btc=b[[c for c in ("oi_usdt", "oi_usdc", "oi_inverse") if c in b]].sum(axis=1, min_count=1))
    if not y.empty:
        frames["bybit"] = y.assign(oi_btc=y[[c for c in ("oi_usdt", "oi_usdc", "oi_inverse") if c in y]].sum(axis=1, min_count=1))
    if not o.empty:
        frames["okx"] = o.assign(oi_btc=o[[c for c in ("oi_usdt", "oi_inverse") if c in o]].sum(axis=1, min_count=1))
    oi, starts = {}, {}
    for ex, f in frames.items():
        f = f[f["oi_btc"].notna()]
        oi[ex] = _pts(f["time"], f["oi_btc"])
        starts[ex] = util.ts(f["time"].iloc[0]) if len(f) else None
    # totale solo nei giorni coperti da tutti e tre gli exchange
    total = []
    total_start = None
    if len(frames) == 3:
        m = None
        for ex, f in frames.items():
            g = f[["time", "oi_btc"]].dropna().rename(columns={"oi_btc": ex})
            m = g if m is None else m.merge(g, on="time", how="inner")
        if m is not None and len(m):
            m["total"] = m[["binance", "bybit", "okx"]].sum(axis=1)
            total = _pts(m["time"], m["total"])
            total_start = util.ts(m["time"].iloc[0])
    # funding giornaliero (%/8h)
    funding = {}
    if not fund_b.empty:
        fb = fund_b.assign(time=fund_b["time"].dt.floor("D")).groupby("time", as_index=False)["rate"].mean()
        fb = fb[fb["time"] >= pd.Timestamp("2020-01-01", tz="UTC")]
        funding["binance"] = _pts(fb["time"], fb["rate"], 100)
    if "funding" in y:
        funding["bybit"] = _pts(y["time"], y["funding"], 100)
    if "funding" in o:
        funding["okx"] = _pts(o["time"], o["funding"], 100)
    long_pct = {}
    if not ls_b.empty and "long_pct" in ls_b:
        lb = ls_b.assign(time=ls_b["time"].dt.floor("D")).groupby("time", as_index=False)["long_pct"].mean()
        long_pct["binance"] = _pts(lb["time"], lb["long_pct"], 100)
    if "long_pct" in y:
        long_pct["bybit"] = _pts(y["time"], y["long_pct"], 100)
    if "long_pct" in o:
        long_pct["okx"] = _pts(o["time"], o["long_pct"], 100)
    # funding ponderato per OI (giorni in cui ci sono OI e funding dei tre exchange)
    weighted = []
    if len(frames) == 3 and not fund_b.empty and "funding" in y and "funding" in o:
        fbd = fund_b.assign(time=fund_b["time"].dt.floor("D")).groupby("time", as_index=False)["rate"].mean().rename(columns={"rate": "f_binance"})
        m = frames["binance"][["time", "oi_btc"]].rename(columns={"oi_btc": "w_binance"}).merge(fbd, on="time")
        m = m.merge(frames["bybit"][["time", "oi_btc", "funding"]].rename(columns={"oi_btc": "w_bybit", "funding": "f_bybit"}), on="time")
        m = m.merge(frames["okx"][["time", "oi_btc", "funding"]].rename(columns={"oi_btc": "w_okx", "funding": "f_okx"}), on="time").dropna()
        if len(m):
            w = m["w_binance"] + m["w_bybit"] + m["w_okx"]
            m["wf"] = (m["f_binance"] * m["w_binance"] + m["f_bybit"] * m["w_bybit"] + m["f_okx"] * m["w_okx"]) / w
            weighted = _pts(m["time"], m["wf"], 100)
    return {"oi_btc": {**oi, "total": total}, "starts": {**starts, "total": total_start}, "funding": {**funding, "weighted": weighted},
            "long_pct": long_pct}


def _intraday() -> dict:
    s = _safe("lev_snap")
    if s.empty:
        return {"since": None, "total_oi_btc": [], "funding_weighted": []}
    cols = [f"{ex}_oi_btc" for ex, _ in EXCHANGES]
    s = s.dropna(subset=[c for c in cols if c in s])
    if s.empty or not all(c in s for c in cols):
        return {"since": None, "total_oi_btc": [], "funding_weighted": []}
    tot = s[cols].sum(axis=1)
    wf = sum(s[f"{ex}_funding_8h"] * s[f"{ex}_oi_usd"] for ex, _ in EXCHANGES) / sum(s[f"{ex}_oi_usd"] for ex, _ in EXCHANGES)
    return {"since": util.ts(s["time"].iloc[0]), "total_oi_btc": _pts(s["time"], tot), "funding_weighted": _pts(s["time"], wf)}


def _chg(pts: list[dict], days: int) -> float | None:
    if len(pts) < 2:
        return None
    last = pts[-1]
    tgt = last["time"] - days * 86400
    past = [p for p in pts if p["time"] <= tgt and p["value"] is not None]
    if not past or not past[-1]["value"]:
        return None
    return (last["value"] / past[-1]["value"] - 1) * 100


def _signals(total: dict, exs: list[dict], hist: dict) -> list[dict]:
    out = []

    def add(text, tone):
        out.append({"text": text, "tone": tone})

    f = total.get("funding_8h")
    if f is not None:
        ann = f * 3 * 365
        if f >= 0.03:
            add(f"Funding medio ponderato per OI {f:.4f}%/8h ({ann:.1f}% annuo) sui tre exchange: i long pagano un premio elevato, leva rialzista affollata.", "bearish")
        elif f <= -0.005:
            add(f"Funding medio ponderato negativo ({f:.4f}%/8h): sono gli short a pagare, posizionamento ribassista affollato (carburante per uno short squeeze).", "bullish")
        else:
            add(f"Funding medio ponderato per OI {f:.4f}%/8h ({ann:.1f}% annuo): nessun eccesso di leva evidente (riferimento 0.01%/8h).", "neutral")
    fs = [e for e in exs if e.get("funding_8h") is not None]
    if len(fs) >= 2:
        hi, lo = max(fs, key=lambda e: e["funding_8h"]), min(fs, key=lambda e: e["funding_8h"])
        if hi["funding_8h"] - lo["funding_8h"] >= 0.01:
            add(f"Funding divergente tra exchange: {hi['name']} {hi['funding_8h']:.4f}% contro {lo['name']} {lo['funding_8h']:.4f}% per 8h: la domanda di leva non è uniforme.", "neutral")
    tot = hist.get("oi_btc", {}).get("total") or []
    c7 = _chg(tot, 7)
    if c7 is not None:
        if c7 > 5:
            add(f"OI aggregato +{c7:.1f}% in 7 giorni (in BTC): la leva totale sta crescendo, rischio di movimenti violenti.", "neutral")
        elif c7 < -5:
            add(f"OI aggregato {c7:.1f}% in 7 giorni (in BTC): deleveraging in corso sui tre exchange.", "neutral")
        else:
            add(f"OI aggregato stabile in 7 giorni ({c7:+.1f}% in BTC).", "neutral")
    by = hist.get("oi_btc", {}).get("bybit") or []
    if len(by) > 365:
        vals = np.array([p["value"] for p in by if p["value"] is not None])
        cur = vals[-1]
        pctl = float((vals < cur).mean() * 100)
        add(f"OI Bybit al {pctl:.0f}° percentile dello storico dal {util.data_it(by[0]['time'])} (in BTC, un lato).", "neutral")
    return out


@util.ttl_cache(30)
def build() -> dict:
    s = live_snapshot()
    exs = []
    for ex, name in EXCHANGES:
        c = s.get(ex)
        if isinstance(c, list) and c:
            t = _ex_totals(c)
            exs.append({"id": ex, "name": name, "ok": True, "error": None, **t,
                        "contracts": [{"symbol": x["symbol"], "kind": x["kind"], "oi_btc": x["oi_btc"], "oi_usd": x["oi_usd"],
                                       "funding_8h": x["funding"] * 8 / x["interval_h"] * 100, "interval_h": x["interval_h"], "mark": x["mark"],
                                       "oi_usd_both_sides": x.get("oi_usd_both_sides")} for x in c]})
        else:
            exs.append({"id": ex, "name": name, "ok": False, "error": (c or {}).get("error") if isinstance(c, dict) else None,
                        "oi_btc": None, "oi_usd": None, "funding_8h": None, "contracts": []})
    ok = [e for e in exs if e["ok"]]
    tot_usd = sum(e["oi_usd"] for e in ok)
    for e in exs:
        e["share_pct"] = e["oi_usd"] / tot_usd * 100 if e["ok"] and tot_usd else None
    wf = sum(e["funding_8h"] * e["oi_usd"] for e in ok if e["funding_8h"] is not None) / tot_usd if tot_usd else None
    hist = _history()
    # long % corrente per exchange (ultimo valore giornaliero / orario)
    for e in exs:
        lp = hist["long_pct"].get(e["id"]) or []
        e["long_pct"] = lp[-1]["value"] if lp else None
        e["long_pct_time"] = lp[-1]["time"] if lp else None
    total = {
        "oi_btc": sum(e["oi_btc"] for e in ok) if ok else None, "oi_usd": tot_usd or None, "funding_8h": wf,
        "funding_annual": wf * 3 * 365 if wf is not None else None,
        "funding_simple_avg": float(np.mean([e["funding_8h"] for e in ok if e["funding_8h"] is not None])) if ok else None,
        "exchanges_ok": len(ok), "change_7d_pct": _chg(hist["oi_btc"].get("total") or [], 7),
        "binance_usdt_share_pct": None,
    }
    b = next((e for e in ok if e["id"] == "binance"), None)
    if b and tot_usd:
        usdt = next((c for c in b["contracts"] if c["symbol"] == "BTCUSDT"), None)
        total["binance_usdt_share_pct"] = usdt["oi_usd"] / tot_usd * 100 if usdt else None
    return util.clean({
        "time": int(s.get("time") or time.time()), "exchanges": exs, "total": total,
        "crosscheck": _crosscheck(s), "history": hist, "intraday": _intraday(),
        "signals": _signals(total, exs, hist),
        "excluded": ["CME", "Deribit", "Hyperliquid", "Bitget", "Gate", "futures a scadenza"],
    })
