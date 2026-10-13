"""WebSocket /api/ws: relay in tempo reale degli stream Binance verso il browser.

Un'unica connessione upstream (hub) condivisa da tutti i client. Messaggi inviati:
  {"type":"ticker", time, price, change_24h, high_24h, low_24h, volume_24h_usd}   ~1/s
  {"type":"kline", tf, closed, candle:{time,open,high,low,close,volume}}        per ogni tf sottoscritto
  {"type":"mark", time, mark, index, funding_rate, next_funding}                 ~1/s (futures)
  {"type":"liquidation", time, side, price, qty, usd, exchange, symbol}          ad evento (Binance qui; Bybit/OKX/
                                                                                  Binance COIN-M/USDC da app/liq_collectors.py)
Il client può inviare {"tf": "4h"} (o {"tfs": ["1h","4h"]}) per scegliere le candele ricevute
(default: tutte). Query string opzionale ?tf=1h,4h.
"""
from __future__ import annotations

import asyncio
import json
import logging

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger("stream")
router = APIRouter()

TFS = ["1m", "15m", "1h", "4h", "1d", "1w"]
SPOT_URL = "wss://stream.binance.com:9443/stream?streams=" + "/".join(
    ["btcusdt@ticker", *[f"btcusdt@kline_{tf}" for tf in TFS]]
)
FUT_URL = "wss://fstream.binance.com/market/stream?streams=btcusdt@markPrice@1s/btcusdt@forceOrder/btcusdt@kline_1m"


class Hub:
    def __init__(self) -> None:
        self.clients: dict[WebSocket, set[str]] = {}
        self.lang: dict[WebSocket, str] = {}  # lingua del client (it/en) per i testi di agenti e notifiche
        self.last: dict[str, dict] = {}  # ultimo messaggio per chiave (snapshot per nuovi client)
        self.tasks: list[asyncio.Task] = []
        self.connected = {"spot": False, "futures": False}
        self.loop: asyncio.AbstractEventLoop | None = None

    def ensure_started(self) -> None:
        if not self.tasks or all(t.done() for t in self.tasks):
            loop = asyncio.get_running_loop()
            self.loop = loop
            self.tasks = [loop.create_task(self._run(SPOT_URL, "spot")), loop.create_task(self._run(FUT_URL, "futures"))]

    @staticmethod
    def _is_fut(env: dict) -> bool:
        return bool(env.get("_fut"))

    async def _run(self, url: str, name: str) -> None:
        backoff = 1
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, open_timeout=15) as ws:
                    self.connected[name] = True
                    backoff = 1
                    async for raw in ws:
                        env = json.loads(raw)
                        if name == "futures":
                            env["_fut"] = True
                        msg = self._parse(env)
                        if msg:
                            await self._broadcast(msg)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("stream %s disconnesso: %s", name, e)
            self.connected[name] = False
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    def _parse(self, env: dict) -> dict | None:
        stream, d = env.get("stream", ""), env.get("data", {})
        if stream.endswith("@ticker"):
            msg = {
                "type": "ticker", "time": d["E"] // 1000, "price": float(d["c"]),
                "change_24h": float(d["P"]), "high_24h": float(d["h"]), "low_24h": float(d["l"]),
                "volume_24h_usd": float(d["q"]),
            }
            self.last["ticker"] = msg
            return msg
        if "@kline_" in stream:
            k = d["k"]
            perp = d.get("ps") is not None or self._is_fut(env)
            candle = {"time": k["t"] // 1000, "open": float(k["o"]), "high": float(k["h"]),
                      "low": float(k["l"]), "close": float(k["c"]), "volume": float(k["v"]),
                      "taker_buy": float(k["V"])}
            if perp:  # candela 1m del perpetual: per il flusso spot vs futures
                msg = {"type": "perp_kline", "tf": k["i"], "closed": k["x"], "candle": candle}
                self.last["perp_kline"] = msg
                return msg
            msg = {"type": "kline", "tf": k["i"], "closed": k["x"], "candle": candle}
            self.last[f"kline_{k['i']}"] = msg
            return msg
        if "@markPrice" in stream:
            msg = {
                "type": "mark", "time": d["E"] // 1000, "mark": float(d["p"]), "index": float(d["i"]),
                "funding_rate": float(d["r"]) * 100, "next_funding": d["T"] // 1000,
            }
            self.last["mark"] = msg
            return msg
        if "@forceOrder" in stream:
            o = d["o"]
            price, qty = float(o["ap"]) or float(o["p"]), float(o["z"]) or float(o["q"])
            return {
                "type": "liquidation", "time": o["T"] // 1000, "side": "long" if o["S"] == "SELL" else "short",
                "price": price, "qty": qty, "usd": price * qty, "exchange": "binance", "symbol": "BTCUSDT",
            }
        return None

    def publish_threadsafe(self, msg: dict) -> None:
        """Invio da un altro thread (collector liquidazioni multi-exchange)."""
        loop = self.loop
        if loop is not None and loop.is_running() and self.clients:
            asyncio.run_coroutine_threadsafe(self._broadcast(msg), loop)

    async def _broadcast(self, msg: dict) -> None:
        text = json.dumps(msg)
        text_en = None
        dead = []
        for ws, tfs in list(self.clients.items()):
            if msg["type"] == "kline" and tfs and msg["tf"] not in tfs:
                continue
            out = text
            if self.lang.get(ws) == "en" and msg["type"] in ("agent_message", "toast"):
                if text_en is None:
                    from .. import i18n
                    text_en = json.dumps(i18n.translate_obj(msg), ensure_ascii=False)
                out = text_en
            try:
                await ws.send_text(out)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.pop(ws, None)


hub = Hub()


def _parse_tfs(value) -> set[str]:
    if isinstance(value, str):
        value = value.split(",")
    return {t.strip() for t in (value or []) if t and t.strip() in TFS}


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.ensure_started()
    tfs = _parse_tfs(ws.query_params.get("tf"))
    hub.clients[ws] = tfs
    hub.lang[ws] = (ws.query_params.get("lang") or "it").lower()
    # snapshot immediato
    for key, msg in list(hub.last.items()):
        if key.startswith("kline_") and tfs and msg["tf"] not in tfs:
            continue
        await ws.send_text(json.dumps(msg))
    try:
        while True:
            data = json.loads(await ws.receive_text())
            if "lang" in data:
                hub.lang[ws] = str(data["lang"]).lower()
            if "tf" in data or "tfs" in data:
                tfs = _parse_tfs(data.get("tfs") or [data.get("tf")])
                hub.clients[ws] = tfs
                snap = hub.last.get(f"kline_{data.get('tf')}")
                if snap:
                    await ws.send_text(json.dumps(snap))
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        hub.clients.pop(ws, None)
        hub.lang.pop(ws, None)


@router.get("/stream/status")
def stream_status():
    return {"clients": len(hub.clients), **hub.connected}
