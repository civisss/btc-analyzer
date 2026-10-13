"""Collector live delle liquidazioni REALI multi-exchange (oltre allo stream Binance BTCUSDT di `live.py`).

Stream (tutti pubblici, senza chiave):
  - Binance COIN-M  wss://dstream.binance.com/ws/btcusd_perp@forceOrder        (contratti da 100 USD)
  - Binance USDC-M  wss://fstream.binance.com/market/ws/btcusdc@forceOrder     (quantità in BTC)
  - Bybit linear    wss://stream.bybit.com/v5/public/linear   allLiquidation.BTCUSDT + allLiquidation.BTCPERP
  - Bybit inverse   wss://stream.bybit.com/v5/public/inverse  allLiquidation.BTCUSD  (taglia in USD)
  - OKX             wss://ws.okx.com:8443/ws/v5/public  liquidation-orders (SWAP) filtrato su BTC-USDT-SWAP / BTC-USD-SWAP
    + recupero REST ogni 60 s da /api/v5/public/liquidation-orders (riempie i buchi dopo riavvii/disconnessioni).

Ogni evento è normalizzato in {time, exchange, symbol, side('long'|'short' = lato LIQUIDATO), price, qty(BTC), usd},
salvato con `store.add_liquidation` e inoltrato al WebSocket del browser (messaggio "liquidation" con `exchange`).

Semantica del lato (verificata sulla documentazione ufficiale):
  - Binance forceOrder: ordine SELL = chiusura forzata di un long  -> long liquidato.
  - Bybit allLiquidation: "When you receive a Buy update, this means that a long position has been liquidated".
  - OKX: posSide long/short; in modalità net, side "sell" = long liquidato.
Limiti noti: Binance forceOrder invia al massimo 1 evento al secondo per simbolo (sottostima nei picchi).
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections import deque
from pathlib import Path

import pandas as pd

from .data import store

log = logging.getLogger("liq_collectors")

BYBIT_LINEAR = "wss://stream.bybit.com/v5/public/linear"
BYBIT_INVERSE = "wss://stream.bybit.com/v5/public/inverse"
OKX_WS = "wss://ws.okx.com:8443/ws/v5/public"
OKX_REST = "https://www.okx.com/api/v5/public/liquidation-orders"
BIN_COINM = "wss://dstream.binance.com/ws/btcusd_perp@forceOrder"
BIN_USDC = "wss://fstream.binance.com/market/ws/btcusdc@forceOrder"

# OKX: valore del contratto (ctVal) da /public/instruments — USDT: 0.01 BTC, USD (inverso): 100 USD
OKX_INST = {"BTC-USDT-SWAP": ("linear", 0.01), "BTC-USD-SWAP": ("inverse", 100.0)}
META_FILE = store.DATA_DIR / "liq_collect_meta.json"

# stato per stream (chiave = nome stream)
_streams: dict[str, dict] = {}
_seen: deque = deque(maxlen=20000)
_seen_set: set = set()
_meta: dict[str, float] = {}
_meta_lock = threading.Lock()
_started = False
_start_lock = threading.Lock()


# ------------------------------------------------------------------ meta "in raccolta dal"

def _load_meta() -> None:
    global _meta
    try:
        if META_FILE.exists():
            _meta = {k: float(v) for k, v in json.loads(META_FILE.read_text(encoding="utf-8")).items()}
    except Exception as e:  # noqa: BLE001
        log.warning("meta liquidazioni illeggibile: %s", e)


def _mark_started(exchange: str) -> None:
    """Prima connessione riuscita di un exchange: data di inizio della raccolta (persistita)."""
    with _meta_lock:
        if exchange in _meta:
            return
        _meta[exchange] = time.time()
        try:
            Path(META_FILE).write_text(json.dumps(_meta), encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log.warning("meta liquidazioni non salvata: %s", e)


def collecting_meta() -> dict[str, float]:
    """exchange -> unix secondi della prima connessione riuscita dello stream."""
    if not _meta:
        _load_meta()
    return dict(_meta)


# ------------------------------------------------------------------ normalizzazione

def _ev(t_ms: int, exchange: str, symbol: str, side: str, price: float, qty: float, usd: float) -> dict:
    return {"time": pd.Timestamp(int(t_ms), unit="ms", tz="UTC"), "exchange": exchange, "symbol": symbol,
            "side": side, "price": float(price), "qty": float(qty), "usd": float(usd)}


def parse_bybit(msg: dict, category: str) -> list[dict]:
    """allLiquidation: data=[{T, s, S, v, p}]; S=Buy -> long liquidato. Inverso: v in USD."""
    out = []
    topic = str(msg.get("topic", ""))
    if not topic.startswith("allLiquidation."):
        return out
    data = msg.get("data") or []
    if isinstance(data, dict):
        data = [data]
    for d in data:
        try:
            sym = str(d.get("s") or topic.split(".", 1)[1])
            p, v = float(d["p"]), float(d["v"])
            if p <= 0 or v <= 0:
                continue
            side = "long" if str(d.get("S", "")).lower() == "buy" else "short"
            if category == "inverse":
                usd, qty = v, v / p
            else:
                qty, usd = v, v * p
            out.append(_ev(int(d.get("T") or msg.get("ts") or time.time() * 1000), "bybit", sym, side, p, qty, usd))
        except Exception:  # noqa: BLE001
            continue
    return out


def parse_okx_detail(inst_id: str, d: dict) -> dict | None:
    if inst_id not in OKX_INST:
        return None
    kind, ct_val = OKX_INST[inst_id]
    try:
        p, sz = float(d.get("bkPx") or 0), float(d.get("sz") or 0)
        if p <= 0 or sz <= 0:
            return None
        pos = str(d.get("posSide", "")).lower()
        if pos in ("long", "short"):
            side = pos
        else:  # modalità net: un ordine di vendita chiude un long
            side = "long" if str(d.get("side", "")).lower() == "sell" else "short"
        if kind == "inverse":
            usd = sz * ct_val
            qty = usd / p
        else:
            qty = sz * ct_val
            usd = qty * p
        return _ev(int(d.get("ts") or d.get("time") or time.time() * 1000), "okx", inst_id, side, p, qty, usd)
    except Exception:  # noqa: BLE001
        return None


def parse_okx(msg: dict) -> list[dict]:
    out = []
    for item in msg.get("data") or []:
        inst = str(item.get("instId", ""))
        for d in item.get("details") or []:
            ev = parse_okx_detail(inst, d)
            if ev:
                out.append(ev)
    return out


def parse_binance(raw: str | bytes, symbol: str, coin_m: bool) -> list[dict]:
    """forceOrder: S=SELL -> long liquidato. COIN-M: quantità in contratti da 100 USD."""
    try:
        msg = json.loads(raw)
        o = msg.get("o") or {}
        if not o or str(o.get("s", "")).upper() != symbol:
            return []
        price = float(o.get("ap") or 0) or float(o.get("p") or 0)
        q = float(o.get("z") or 0) or float(o.get("q") or 0)
        if price <= 0 or q <= 0:
            return []
        if coin_m:
            usd, qty = q * 100.0, q * 100.0 / price
        else:
            qty, usd = q, q * price
        side = "long" if str(o.get("S", "")).upper() == "SELL" else "short"
        return [_ev(int(o.get("T") or msg.get("E") or time.time() * 1000), "binance", symbol, side, price, qty, usd)]
    except Exception:  # noqa: BLE001
        return []


# ------------------------------------------------------------------ pubblicazione

def _key(ev: dict) -> tuple:
    return (ev["exchange"], ev["symbol"], int(ev["time"].value // 1_000_000), round(ev["qty"], 8), round(ev["price"], 4), ev["side"])


def _seen_add(k: tuple) -> bool:
    """True se l'evento è nuovo."""
    if k in _seen_set:
        return False
    if len(_seen) == _seen.maxlen:
        _seen_set.discard(_seen[0])
    _seen.append(k)
    _seen_set.add(k)
    return True


def _publish(ev: dict, name: str, broadcast: bool = True) -> None:
    if not _seen_add(_key(ev)):
        return
    store.add_liquidation(ev)
    st = _streams.get(name)
    if st is not None:
        st["events"] += 1
        st["last_event"] = time.time()
    if not broadcast:
        return
    try:
        from .routers.stream import hub
        hub.publish_threadsafe({
            "type": "liquidation", "time": int(ev["time"].value // 1_000_000_000), "side": ev["side"], "price": ev["price"],
            "qty": ev["qty"], "usd": ev["usd"], "exchange": ev["exchange"], "symbol": ev["symbol"],
        })
    except Exception as e:  # noqa: BLE001
        log.debug("broadcast liquidazione fallito: %s", e)


# ------------------------------------------------------------------ loop websocket generico

async def _run_ws(name: str, exchange: str, url: str, subscribe: list, parse, ping_payload, ping_every: float) -> None:
    import websockets

    st = _streams.setdefault(name, {"exchange": exchange, "connected": False, "events": 0, "last_event": None, "reconnects": 0, "error": None})
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20, open_timeout=15, close_timeout=5, max_size=2**22) as ws:
                for sub in subscribe:
                    await ws.send(json.dumps(sub) if not isinstance(sub, str) else sub)
                st["connected"] = True
                st["error"] = None
                backoff = 1.0
                _mark_started(exchange)
                log.info("stream liquidazioni %s connesso", name)
                while True:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=ping_every)
                    except asyncio.TimeoutError:
                        if ping_payload is not None:
                            await ws.send(ping_payload)
                        continue
                    if raw in ("pong", b"pong"):
                        continue
                    for ev in parse(raw):
                        _publish(ev, name)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            st["error"] = str(e)[:200]
            st["reconnects"] += 1
            log.warning("stream liquidazioni %s disconnesso: %s (retry in %.0fs)", name, e, backoff)
        finally:
            st["connected"] = False
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


def _json_parse(fn):
    def inner(raw):
        try:
            msg = json.loads(raw)
        except Exception:  # noqa: BLE001
            return []
        return fn(msg) if isinstance(msg, dict) else []
    return inner


async def _okx_rest_loop() -> None:
    """Recupero REST delle ultime liquidazioni OKX (max 100 per famiglia): colma i buchi dello stream."""
    from .data import sources as src

    name = "okx_rest"
    st = _streams.setdefault(name, {"exchange": "okx", "connected": False, "events": 0, "last_event": None, "reconnects": 0, "error": None})
    while True:
        try:
            for fam in ("BTC-USDT", "BTC-USD"):
                r = await asyncio.to_thread(src._get, OKX_REST, {"instType": "SWAP", "instFamily": fam, "state": "filled", "limit": 100})
                if str(r.get("code")) != "0":
                    raise RuntimeError(r.get("msg") or r.get("code"))
                now = time.time()
                for ev in parse_okx(r):
                    # gli eventi recuperati e recenti arrivano anche al browser; quelli vecchi solo su disco
                    _publish(ev, name, broadcast=now - ev["time"].timestamp() < 120)
            st["connected"] = True
            st["error"] = None
        except Exception as e:  # noqa: BLE001
            st["connected"] = False
            st["error"] = str(e)[:200]
            log.warning("recupero REST liquidazioni OKX fallito: %s", e)
        await asyncio.sleep(60)


async def _main() -> None:
    bybit_ping = json.dumps({"op": "ping"})
    await asyncio.gather(
        _run_ws("binance_coinm", "binance", BIN_COINM, [], lambda raw: parse_binance(raw, "BTCUSD_PERP", True), None, 30),
        _run_ws("binance_usdc", "binance", BIN_USDC, [], lambda raw: parse_binance(raw, "BTCUSDC", False), None, 30),
        _run_ws("bybit_linear", "bybit", BYBIT_LINEAR, [{"op": "subscribe", "args": ["allLiquidation.BTCUSDT", "allLiquidation.BTCPERP"]}],
                _json_parse(lambda m: parse_bybit(m, "linear")), bybit_ping, 20),
        _run_ws("bybit_inverse", "bybit", BYBIT_INVERSE, [{"op": "subscribe", "args": ["allLiquidation.BTCUSD"]}],
                _json_parse(lambda m: parse_bybit(m, "inverse")), bybit_ping, 20),
        _run_ws("okx", "okx", OKX_WS, [{"op": "subscribe", "args": [{"channel": "liquidation-orders", "instType": "SWAP"}]}],
                _json_parse(parse_okx), "ping", 25),
        _okx_rest_loop(),
    )


def _seed_seen() -> None:
    """Evita di ri-salvare (dopo un riavvio) gli eventi OKX già su disco recuperati di nuovo dal REST."""
    try:
        df = store.liquidations()
        if df is None or df.empty:
            return
        d = df[df["exchange"] == "okx"].tail(5000)
        for r in d.itertuples():
            _seen_add(("okx", r.symbol, int(pd.Timestamp(r.time).value // 1_000_000), round(float(r.qty), 8), round(float(r.price), 4), r.side))
    except Exception as e:  # noqa: BLE001
        log.debug("seed eventi OKX: %s", e)


def _thread() -> None:
    _load_meta()
    _seed_seen()
    while True:
        try:
            asyncio.run(_main())
        except Exception as e:  # noqa: BLE001
            log.warning("loop collector liquidazioni terminato: %s", e)
        time.sleep(5)


def start() -> None:
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    try:
        threading.Thread(target=_thread, daemon=True, name="liq-multi").start()
    except Exception as e:  # noqa: BLE001
        log.warning("impossibile avviare i collector multi-exchange: %s", e)


def stats() -> dict:
    """Stato per stream ed exchange (connesso, eventi in questa sessione, ultimo evento)."""
    by_ex: dict[str, dict] = {}
    for name, st in _streams.items():
        e = by_ex.setdefault(st["exchange"], {"connected": False, "events": 0, "last_event": None})
        if name != "okx_rest":
            e["connected"] = e["connected"] or st["connected"]
        e["events"] += st["events"]
        if st["last_event"] and (e["last_event"] is None or st["last_event"] > e["last_event"]):
            e["last_event"] = st["last_event"]
    return {"streams": {k: dict(v) for k, v in _streams.items()}, "exchanges": by_ex}
