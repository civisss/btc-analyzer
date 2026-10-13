"""Fetcher per le fonti dati pubbliche (nessuna API key richiesta)."""
from __future__ import annotations

import time
from datetime import datetime, timezone

import httpx
import pandas as pd

BINANCE = "https://api.binance.com"
BINANCE_FUT = "https://fapi.binance.com"
BITSTAMP = "https://www.bitstamp.net/api/v2"
COINMETRICS = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
COINGECKO = "https://api.coingecko.com/api/v3"

_client = httpx.Client(timeout=30, headers={"User-Agent": "btc-analyzer/1.0"})

INTERVAL_MS = {
    "15m": 15 * 60_000,
    "1h": 3_600_000,
    "4h": 4 * 3_600_000,
    "1d": 86_400_000,
    "1w": 7 * 86_400_000,
}


def _get(url: str, params: dict | None = None, retries: int = 4):
    for attempt in range(retries):
        try:
            r = _client.get(url, params=params)
            if r.status_code == 429:
                time.sleep(2 + attempt * 3)
                continue
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError:
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt * 2)
    raise RuntimeError(f"GET fallita: {url}")


def _ohlc_frame(rows: list[list], ts_unit: str = "ms") -> pd.DataFrame:
    df = pd.DataFrame(rows)
    out = pd.DataFrame(
        {
            "time": pd.to_datetime(df[0].astype("int64"), unit=ts_unit, utc=True),
            "open": df[1].astype(float),
            "high": df[2].astype(float),
            "low": df[3].astype(float),
            "close": df[4].astype(float),
            "volume": df[5].astype(float),
        }
    )
    if df.shape[1] > 9:
        out["taker_buy"] = df[9].astype(float)
    return out.drop_duplicates("time").sort_values("time").reset_index(drop=True)


# ---------------------------------------------------------------- Binance spot

def binance_klines(interval: str, start_ms: int | None = None, symbol: str = "BTCUSDT") -> pd.DataFrame:
    """Scarica tutte le candele da start_ms (default: inizio storia) a ora."""
    start = start_ms if start_ms is not None else 1_500_000_000_000  # lug 2017
    rows: list[list] = []
    now = int(time.time() * 1000)
    while start < now:
        batch = _get(
            f"{BINANCE}/api/v3/klines",
            {"symbol": symbol, "interval": interval, "startTime": start, "limit": 1000},
        )
        if not batch:
            break
        rows.extend(batch)
        start = batch[-1][0] + INTERVAL_MS[interval]
        if len(batch) < 1000:
            break
    if not rows:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])
    return _ohlc_frame(rows)


def binance_ticker() -> dict:
    return _get(f"{BINANCE}/api/v3/ticker/24hr", {"symbol": "BTCUSDT"})


# ------------------------------------------------------------- Bitstamp storico

def bitstamp_daily() -> pd.DataFrame:
    """Storico giornaliero BTC/USD dal 2011."""
    start = int(datetime(2011, 8, 1, tzinfo=timezone.utc).timestamp())
    rows = []
    now = int(time.time())
    while start < now:
        data = _get(f"{BITSTAMP}/ohlc/btcusd/", {"step": 86400, "limit": 1000, "start": start})
        batch = data["data"]["ohlc"]
        if not batch:
            break
        rows.extend(
            [int(b["timestamp"]), b["open"], b["high"], b["low"], b["close"], b["volume"]] for b in batch
        )
        nxt = int(batch[-1]["timestamp"]) + 86400
        if nxt <= start:
            break
        start = nxt
    return _ohlc_frame(rows, ts_unit="s")


# ------------------------------------------------------------- Binance futures

def funding_history(start_ms: int | None = None) -> pd.DataFrame:
    start = start_ms or 1_567_900_000_000  # set 2019
    rows = []
    now = int(time.time() * 1000)
    while start < now:
        batch = _get(f"{BINANCE_FUT}/fapi/v1/fundingRate", {"symbol": "BTCUSDT", "startTime": start, "limit": 1000})
        if not batch:
            break
        rows.extend(batch)
        start = batch[-1]["fundingTime"] + 1
        if len(batch) < 1000:
            break
    df = pd.DataFrame(rows)
    if df.empty:
        return pd.DataFrame(columns=["time", "rate"])
    return pd.DataFrame(
        {
            "time": pd.to_datetime(df["fundingTime"].astype("int64"), unit="ms", utc=True),
            "rate": df["fundingRate"].astype(float),
        }
    ).drop_duplicates("time")


def _futures_data(path: str, period: str, days: int = 29, **extra) -> list[dict]:
    """Endpoint /futures/data/* (max 30 giorni di storico, 500 punti per chiamata)."""
    step = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}[period]
    end = int(time.time() * 1000)
    start = end - days * 86_400_000
    rows = []
    for _ in range(40):
        if start >= end:
            break
        batch = _get(
            f"{BINANCE_FUT}/futures/data/{path}",
            {"symbol": "BTCUSDT", "period": period, "startTime": start, "endTime": min(end, start + 499 * step), "limit": 500, **extra},
        )
        if not batch:
            start += 499 * step
            continue
        rows.extend(batch)
        start = max(start + step, int(batch[-1]["timestamp"]) + step)
    return rows


def open_interest_history(period: str = "15m", days: int = 29) -> pd.DataFrame:
    rows = _futures_data("openInterestHist", period, days)
    df = pd.DataFrame(rows)
    return pd.DataFrame(
        {
            "time": pd.to_datetime(df["timestamp"].astype("int64"), unit="ms", utc=True),
            "oi": df["sumOpenInterest"].astype(float),
            "oi_usd": df["sumOpenInterestValue"].astype(float),
        }
    ).drop_duplicates("time").sort_values("time").reset_index(drop=True)


def long_short_history(period: str = "1h", days: int = 29) -> pd.DataFrame:
    acc = pd.DataFrame(_futures_data("globalLongShortAccountRatio", period, days))
    top = pd.DataFrame(_futures_data("topLongShortPositionRatio", period, days))
    taker = pd.DataFrame(_futures_data("takerlongshortRatio", period, days))
    out = pd.DataFrame(
        {
            "time": pd.to_datetime(acc["timestamp"].astype("int64"), unit="ms", utc=True),
            "ls_accounts": acc["longShortRatio"].astype(float),
            "long_pct": acc["longAccount"].astype(float),
        }
    )
    if not top.empty:
        t = pd.DataFrame({"time": pd.to_datetime(top["timestamp"].astype("int64"), unit="ms", utc=True), "ls_top": top["longShortRatio"].astype(float)})
        out = out.merge(t, on="time", how="left")
    if not taker.empty:
        t = pd.DataFrame({"time": pd.to_datetime(taker["timestamp"].astype("int64"), unit="ms", utc=True), "taker_ratio": taker["buySellRatio"].astype(float)})
        out = out.merge(t, on="time", how="left")
    return out.drop_duplicates("time").sort_values("time").reset_index(drop=True)


def futures_premium() -> dict:
    return _get(f"{BINANCE_FUT}/fapi/v1/premiumIndex", {"symbol": "BTCUSDT"})


def futures_open_interest() -> dict:
    return _get(f"{BINANCE_FUT}/fapi/v1/openInterest", {"symbol": "BTCUSDT"})


def futures_klines(interval: str, days: int) -> pd.DataFrame:
    start = int(time.time() * 1000) - days * 86_400_000
    rows = []
    now = int(time.time() * 1000)
    while start < now:
        batch = _get(f"{BINANCE_FUT}/fapi/v1/klines", {"symbol": "BTCUSDT", "interval": interval, "startTime": start, "limit": 1500})
        if not batch:
            break
        rows.extend(batch)
        start = batch[-1][0] + INTERVAL_MS[interval]
        if len(batch) < 1500:
            break
    return _ohlc_frame(rows)


# ------------------------------------------------------------------ CoinMetrics

def coinmetrics(asset: str, metrics: list[str], start: str = "2010-01-01") -> pd.DataFrame:
    params = {
        "assets": asset,
        "metrics": ",".join(metrics),
        "frequency": "1d",
        "start_time": start,
        "page_size": 10000,
    }
    rows = []
    url = COINMETRICS
    while url:
        data = _get(url, params)
        rows.extend(data.get("data", []))
        url = data.get("next_page_url")
        params = None
    if not rows:
        return pd.DataFrame(columns=["time", *metrics])
    df = pd.DataFrame(rows)
    df["time"] = pd.to_datetime(df["time"], utc=True).dt.normalize()
    for m in metrics:
        if m in df:
            df[m] = pd.to_numeric(df[m], errors="coerce")
    return df[["time", *[m for m in metrics if m in df]]]


# -------------------------------------------------------------------- Varie

def fear_greed() -> pd.DataFrame:
    data = _get("https://api.alternative.me/fng/", {"limit": 0})["data"]
    df = pd.DataFrame(data)
    return pd.DataFrame(
        {
            "time": pd.to_datetime(df["timestamp"].astype("int64"), unit="s", utc=True),
            "value": df["value"].astype(int),
            "label": df["value_classification"],
        }
    ).sort_values("time").reset_index(drop=True)


def coingecko_global() -> dict:
    return _get(f"{COINGECKO}/global")["data"]


def mempool_stats() -> dict:
    out = {}
    try:
        out["fees"] = _get("https://mempool.space/api/v1/fees/recommended")
        out["difficulty"] = _get("https://mempool.space/api/v1/difficulty-adjustment")
        out["height"] = _get("https://mempool.space/api/blocks/tip/height")
    except Exception:  # noqa: BLE001
        pass
    return out
