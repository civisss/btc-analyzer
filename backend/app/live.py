"""Collector live delle liquidazioni Binance Futures (stream forceOrder).

`start()` avvia un thread daemon che:
  - si connette a wss://fstream.binance.com/market/ws/btcusdt@forceOrder con riconnessione e backoff esponenziale,
  - converte ogni evento in `store.add_liquidation(...)`,
  - ogni ~60 s chiama `store.flush_liquidations()` (persistenza parquet).
Avvia anche i collector multi-exchange (Binance COIN-M/USDC, Bybit, OKX) di `liq_collectors`.
Non deve mai far cadere l'app: ogni errore è catturato e loggato.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time

import pandas as pd

from .data import store

log = logging.getLogger("live")

URL = "wss://fstream.binance.com/market/ws/btcusdt@forceOrder"
FLUSH_EVERY = 60

_connected = False
_started = False
_start_lock = threading.Lock()
_last_event: float | None = None
_events_total = 0


def is_connected() -> bool:
    return _connected


def stats() -> dict:
    out = {"connected": _connected, "events": _events_total, "last_event": _last_event}
    try:
        from . import liq_collectors
        out["multi"] = liq_collectors.stats()
    except Exception:  # noqa: BLE001
        pass
    return out


def parse_event(raw: str | bytes) -> dict | None:
    """Evento forceOrder -> dict per store.add_liquidation (None se non valido)."""
    try:
        msg = json.loads(raw)
        o = msg.get("o") or {}
        if not o:
            return None
        if str(o.get("s", "BTCUSDT")).upper() != "BTCUSDT":
            return None
        price = float(o.get("ap") or 0) or float(o.get("p") or 0)
        qty = float(o.get("z") or 0) or float(o.get("q") or 0)
        if price <= 0 or qty <= 0:
            return None
        t = int(o.get("T") or msg.get("E") or time.time() * 1000)
        return {
            "time": pd.Timestamp(t, unit="ms", tz="UTC"),
            "exchange": "binance",
            "symbol": "BTCUSDT",
            # ordine SELL = chiusura forzata di un long -> long liquidato
            "side": "long" if str(o.get("S", "")).upper() == "SELL" else "short",
            "price": price,
            "qty": qty,
            "usd": price * qty,
        }
    except Exception:  # noqa: BLE001
        return None


async def _consume() -> None:
    global _connected, _last_event, _events_total
    import websockets  # import ritardato: se manca il pacchetto il thread logga e termina

    backoff = 1.0
    while True:
        try:
            async with websockets.connect(URL, ping_interval=20, ping_timeout=20, open_timeout=15, close_timeout=5) as ws:
                _connected = True
                backoff = 1.0
                log.info("stream liquidazioni connesso")
                try:
                    from . import liq_collectors
                    liq_collectors._mark_started("binance")
                except Exception:  # noqa: BLE001
                    pass
                async for raw in ws:
                    ev = parse_event(raw)
                    if ev is not None:
                        store.add_liquidation(ev)
                        _last_event = time.time()
                        _events_total += 1
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("stream liquidazioni disconnesso: %s (retry in %.0fs)", e, backoff)
        finally:
            _connected = False
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


def _ws_thread() -> None:
    while True:
        try:
            asyncio.run(_consume())
        except Exception as e:  # noqa: BLE001
            log.warning("loop websocket terminato: %s", e)
        time.sleep(5)


def _flush_thread() -> None:
    while True:
        time.sleep(FLUSH_EVERY)
        try:
            store.flush_liquidations()
        except Exception as e:  # noqa: BLE001
            log.warning("flush liquidazioni fallito: %s", e)


def start() -> None:
    """Avvia (una sola volta) i thread di raccolta e flush."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    try:
        threading.Thread(target=_ws_thread, daemon=True, name="liq-ws").start()
        threading.Thread(target=_flush_thread, daemon=True, name="liq-flush").start()
    except Exception as e:  # noqa: BLE001
        log.warning("impossibile avviare il collector liquidazioni: %s", e)
    try:
        from . import liq_collectors
        liq_collectors.start()
    except Exception as e:  # noqa: BLE001
        log.warning("collector liquidazioni multi-exchange non avviati: %s", e)
    try:  # order book + trade aggressivi Binance (heatmap e footprint, app/ob_collector.py)
        from . import ob_collector
        ob_collector.start()
    except Exception as e:  # noqa: BLE001
        log.warning("collector order book non avviato: %s", e)
    try:  # trade multi-exchange per il Terminale (order flow, CVD aggregato, premio Coinbase; app/terminal_collector.py)
        from . import terminal_collector
        terminal_collector.start()
    except Exception as e:  # noqa: BLE001
        log.warning("collector terminale non avviato: %s", e)
