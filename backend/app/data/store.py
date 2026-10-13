"""Cache su disco (parquet) + memoria, con aggiornamento incrementale."""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable

import pandas as pd

from . import sources as src

log = logging.getLogger("store")
# BTC_DATA_DIR: cartella dati alternativa (istanze di test isolate); default backend/data
DATA_DIR = Path(os.environ.get("BTC_DATA_DIR") or (Path(__file__).resolve().parents[2] / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

_mem: dict[str, pd.DataFrame] = {}
_stamp: dict[str, float] = {}
_locks: dict[str, threading.Lock] = {}


def _path(name: str) -> Path:
    return DATA_DIR / f"{name}.parquet"


def _load_disk(name: str) -> pd.DataFrame | None:
    p = _path(name)
    if p.exists():
        df = _norm(pd.read_parquet(p))
        _stamp.setdefault(name, p.stat().st_mtime)
        return df
    return None


def _norm(df: pd.DataFrame) -> pd.DataFrame:
    """Colonna time sempre datetime64[ns, UTC] (concat di sorgenti diverse puo' produrre dtype object)."""
    if "time" in df and len(df):
        df = df.copy()
        df["time"] = pd.to_datetime(df["time"], utc=True).astype("datetime64[ns, UTC]")
    return df


def _save(name: str, df: pd.DataFrame) -> None:
    df = _norm(df)
    df.to_parquet(_path(name), index=False)
    _mem[name] = df
    _stamp[name] = time.time()


def _merge(old: pd.DataFrame | None, new: pd.DataFrame) -> pd.DataFrame:
    if old is None or old.empty:
        return new.reset_index(drop=True)
    if new is None or new.empty:
        return old
    out = pd.concat([_norm(old), _norm(new)]).drop_duplicates("time", keep="last").sort_values("time")
    return out.reset_index(drop=True)


# ------------------------------------------------------------------ refreshers

def _incremental_klines(interval: str):
    def fn(old: pd.DataFrame | None) -> pd.DataFrame:
        start = None
        if old is not None and not old.empty:
            start = int(old["time"].iloc[-2].timestamp() * 1000)  # ricarica ultima candela (aperta)
        return _merge(old, src.binance_klines(interval, start))
    return fn


def _daily_long(old):
    """Daily dal 2010: CoinMetrics (solo close) prima di Bitstamp, poi Bitstamp OHLC."""
    bs = src.bitstamp_daily()
    cm = src.coinmetrics("btc", ["PriceUSD"], start="2010-07-01")
    cm = cm[cm["time"] < bs["time"].min()].dropna()
    early = pd.DataFrame(
        {"time": cm["time"], "open": cm["PriceUSD"], "high": cm["PriceUSD"], "low": cm["PriceUSD"], "close": cm["PriceUSD"], "volume": 0.0}
    )
    df = pd.concat([early, bs]).sort_values("time").reset_index(drop=True)
    # Allinea l'ultima candela al prezzo Binance (più liquido/aggiornato)
    try:
        t = src.binance_ticker()
        df.loc[df.index[-1], "close"] = float(t["lastPrice"])
    except Exception:  # noqa: BLE001
        pass
    return df


def _funding(old):
    start = int(old["time"].iloc[-1].timestamp() * 1000) + 1 if old is not None and not old.empty else None
    return _merge(old, src.funding_history(start))


def _oi(old):
    return _merge(old, src.open_interest_history("15m", 29))


def _oi_1h(old):
    return _merge(old, src.open_interest_history("1h", 29))


def _ls(old):
    return _merge(old, src.long_short_history("1h", 29))


def _fut15(old):
    return _merge(old, src.futures_klines("15m", 30))


def _fut1h(old):
    days = 3 if old is not None and not old.empty else 365
    return _merge(old, src.futures_klines("1h", days))


def _fut1d(old):
    days = 5 if old is not None and not old.empty else 2700
    return _merge(old, src.futures_klines("1d", days))


def _onchain(old):
    return src.coinmetrics(
        "btc", ["PriceUSD", "CapMrktCurUSD", "CapMVRVCur", "HashRate", "AdrActCnt", "TxCnt", "SplyCur", "IssTotUSD"], start="2010-07-01"
    )


CAP_ASSETS = ["btc", "eth", "usdt", "usdc", "xrp", "doge", "ada"]


def _caps(old):
    frames = []
    for a in CAP_ASSETS:
        df = src.coinmetrics(a, ["CapMrktCurUSD"], start="2013-01-01").rename(columns={"CapMrktCurUSD": a})
        frames.append(df.set_index("time"))
    out = pd.concat(frames, axis=1).sort_index()
    return out.reset_index().rename(columns={"index": "time"})


def _fng(old):
    return src.fear_greed()


REGISTRY: dict[str, tuple[Callable, int]] = {
    # name: (refresher, ttl secondi)
    "daily": (_daily_long, 900),
    "k_1w": (_incremental_klines("1w"), 300),
    "k_1d": (_incremental_klines("1d"), 60),
    "k_4h": (_incremental_klines("4h"), 60),
    "k_1h": (_incremental_klines("1h"), 60),
    "fut_15m": (_fut15, 60),
    "fut_1h": (_fut1h, 60),
    "fut_1d": (_fut1d, 300),
    "funding": (_funding, 1800),
    "oi_15m": (_oi, 120),
    "oi_1h": (_oi_1h, 900),
    "ls": (_ls, 300),
    "onchain": (_onchain, 6 * 3600),
    "caps": (_caps, 6 * 3600),
    "fng": (_fng, 3 * 3600),
}


def register(name: str, refresher: Callable, ttl: int) -> None:
    """Registra un dataset aggiuntivo da un modulo esterno (refresher(old_df|None) -> DataFrame con colonna 'time')."""
    REGISTRY.setdefault(name, (refresher, ttl))


def get(name: str, force: bool = False) -> pd.DataFrame:
    refresher, ttl = REGISTRY[name]
    lock = _locks.setdefault(name, threading.Lock())
    with lock:
        if name not in _mem:
            disk = _load_disk(name)
            if disk is not None:
                _mem[name] = disk
        fresh = name in _mem and (time.time() - _stamp.get(name, 0)) < ttl
        if fresh and not force:
            return _mem[name]
        try:
            df = refresher(_mem.get(name))
            _save(name, df)
            log.info("aggiornato %s (%d righe)", name, len(df))
        except Exception as e:  # noqa: BLE001
            log.warning("refresh %s fallito: %s", name, e)
            if name not in _mem:
                raise
        return _mem[name]


def age(name: str) -> float | None:
    return time.time() - _stamp[name] if name in _stamp else None


def refresh_all(names: list[str] | None = None) -> None:
    for n in names or REGISTRY:
        try:
            get(n)
        except Exception as e:  # noqa: BLE001
            log.warning("dataset %s non disponibile: %s", n, e)


# ------------------------------------------------------- liquidazioni live

LIQ_FILE = DATA_DIR / "liquidations.parquet"
LIQ_COLUMNS = ["time", "side", "price", "qty", "usd", "exchange", "symbol"]
_liq_buffer: list[dict] = []
_liq_lock = threading.Lock()


def add_liquidation(ev: dict) -> None:
    """Evento normalizzato {time, side('long'|'short' = lato liquidato), price, qty, usd, exchange?, symbol?}.
    `exchange` mancante = 'binance' (compatibilità con il collector originale BTCUSDT)."""
    with _liq_lock:
        _liq_buffer.append(ev)


def _liq_fill(df: pd.DataFrame) -> pd.DataFrame:
    """Righe storiche senza exchange/symbol: erano tutte Binance BTCUSDT."""
    if "exchange" not in df:
        df["exchange"] = "binance"
    if "symbol" not in df:
        df["symbol"] = "BTCUSDT"
    df["exchange"] = df["exchange"].fillna("binance").astype(str)
    df["symbol"] = df["symbol"].fillna("BTCUSDT").astype(str)
    return df


def flush_liquidations() -> pd.DataFrame:
    with _liq_lock:
        buf = list(_liq_buffer)
        _liq_buffer.clear()
        old = pd.read_parquet(LIQ_FILE) if LIQ_FILE.exists() else pd.DataFrame(columns=LIQ_COLUMNS)
        old = _liq_fill(old)
        if buf:
            new = _liq_fill(pd.DataFrame(buf))
            old["time"] = pd.to_datetime(old["time"], utc=True)
            new["time"] = pd.to_datetime(new["time"], utc=True)
            old = pd.concat([old, new]).reset_index(drop=True)
            cutoff = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=60)
            old = old[pd.to_datetime(old["time"], utc=True) >= cutoff]
            old = old.drop_duplicates(["time", "exchange", "symbol", "side", "price", "qty"]).reset_index(drop=True)
            old.to_parquet(LIQ_FILE, index=False)
    return old


def liquidations() -> pd.DataFrame:
    df = flush_liquidations()
    if not df.empty:
        df["time"] = pd.to_datetime(df["time"], utc=True)
        # stesso evento ricevuto due volte (riconnessioni, recupero REST): una sola riga
        df = df.drop_duplicates(["time", "exchange", "symbol", "side", "price", "qty"]).reset_index(drop=True)
    return df
