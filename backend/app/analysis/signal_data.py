"""Dati dei Segnali: candele Binance USDⓈ-M BTCUSDT a 5m dal lancio del perpetuo e spot a 15m (per il delta spot contro perp).

Due dataset persistiti (TTL un'ora, perché il file è grande):
  sig_perp_5m  time open high low close volume taker_buy  (dal 2019-09-08)
  sig_spot_15m stesse colonne (Binance spot, dal 2019-09-01)
Il bootstrap avviene a tranche con un budget di tempo, come per i VWAP. Tra un aggiornamento e l'altro il tratto più recente
arriva da `tail()`, che legge direttamente le ultime candele chiuse.
"""
from __future__ import annotations

import logging
import time

import httpx
import numpy as np
import pandas as pd

from ..data import store

log = logging.getLogger("signal_data")

FAPI = "https://fapi.binance.com/fapi/v1/klines"
SPOT = "https://api.binance.com/api/v3/klines"
START_MS = 1567900800000     # 2019-09-08 00:00 UTC, primi giorni del perpetuo BTCUSDT
COLS = ["time", "open", "high", "low", "close", "volume", "taker_buy"]
BUDGET_S = 40
MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000}


def frame(rows: list[list]) -> pd.DataFrame:
    """Righe grezze delle klines Binance -> DataFrame standard."""
    if not rows:
        return pd.DataFrame(columns=COLS)
    a = np.array([[r[0], r[1], r[2], r[3], r[4], r[5], r[9]] for r in rows], dtype=float)
    df = pd.DataFrame(a, columns=COLS)
    df["time"] = pd.to_datetime(df["time"].astype("int64"), unit="ms", utc=True).astype("datetime64[ns, UTC]")
    return df


def fetch(url: str, interval: str, start_ms: int, end_ms: int | None = None, limit: int = 1500, deadline: float | None = None) -> list[list]:
    """Tutte le candele CHIUSE da start_ms (a pagine). Se il tempo finisce restituisce quanto scaricato fin lì."""
    step = MS[interval]
    now = int(time.time() * 1000)
    end = min(end_ms or now, now)
    rows: list[list] = []
    t = start_ms
    with httpx.Client(timeout=15.0) as c:
        while t < end:
            if deadline and time.time() > deadline:
                break
            r = c.get(url, params={"symbol": "BTCUSDT", "interval": interval, "startTime": t, "limit": limit})
            r.raise_for_status()
            b = r.json()
            if not b:
                break
            rows.extend(b)
            t = int(b[-1][0]) + step
            if len(b) < limit:
                break
    return [r for r in rows if int(r[0]) + step <= now]   # solo candele chiuse


def _refresher(url: str, interval: str, limit: int):
    def fn(old: pd.DataFrame | None) -> pd.DataFrame:
        start = START_MS if old is None or old.empty else int(old["time"].iloc[-1].timestamp() * 1000) + MS[interval]
        new = frame(fetch(url, interval, start, limit=limit, deadline=time.time() + BUDGET_S))
        if old is None or old.empty:
            return new
        return old if new.empty else pd.concat([old, new], ignore_index=True).drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)
    return fn


store.register("sig_perp_5m", _refresher(FAPI, "5m", 1500), 3600)
store.register("sig_spot_15m", _refresher(SPOT, "15m", 1000), 3600)


def bootstrap(budget_s: float = 600) -> None:
    """Completa i dataset (uso offline: backtest da riga di comando)."""
    t0 = time.time()
    for name in ("sig_perp_5m", "sig_spot_15m"):
        while time.time() - t0 < budget_s:
            n0 = len(peek(name))
            df = store.get(name, force=True)
            if len(df) == n0 or df["time"].iloc[-1] > pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=30):
                break


def peek(name: str) -> pd.DataFrame:
    """Dataset dalla memoria o dal disco, senza aggiornarlo."""
    if name in store._mem:
        return store._mem[name]
    d = store._load_disk(name)
    if d is None:
        return pd.DataFrame(columns=COLS)
    store._mem[name] = d
    return d


def tail(url: str, interval: str, since: pd.Timestamp, limit: int = 1500) -> pd.DataFrame:
    """Candele chiuse dopo `since`, lette al momento (per il tratto non ancora nel dataset)."""
    return frame(fetch(url, interval, int(since.timestamp() * 1000) + MS[interval], limit=limit, deadline=time.time() + 20))
