"""Collector dei trade multi-exchange per il Terminale (order flow, CVD spot/perp aggregato, premio Coinbase, OI aggregato).

Thread daemon `terminal` con event loop asyncio proprio (come app/ob_collector.py). WebSocket pubblici, senza chiave:
  binance_perp  wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@ticker/btcusdt@markPrice@1s
                (anche ticker 24h del perpetual, mark/index, funding e prossimo funding)
  binance_spot  wss://stream.binance.com:9443/ws/btcusdt@aggTrade
  bybit_perp    wss://stream.bybit.com/v5/public/linear  publicTrade.BTCUSDT   (ping {"op":"ping"} ogni 20 s)
  bybit_spot    wss://stream.bybit.com/v5/public/spot    publicTrade.BTCUSDT
  okx_*         wss://ws.okx.com:8443/ws/v5/business     trades-all BTC-USDT-SWAP + BTC-USDT (un trade per messaggio; ping "ping" ogni 25 s)
  coinbase_spot wss://ws-feed.exchange.coinbase.com      matches + heartbeat BTC-USD
Normalizzazione e aggregazione in app/analysis/terminal_core.py. Continuità e recupero:
  - id continui (Binance `a`, OKX tradeId, Coinbase trade_id): un buco negli id -> recupero via REST (aggTrades fromId,
    history-trades, /trades?after); se gli id di uno stream si rivelano non contigui il controllo si disattiva da solo;
  - Bybit (id non ordinati): a ogni riconnessione GET recent-trade (1000 linear / 60 spot) dei trade successivi all'ultimo visto;
  - ogni id già contato viene scartato (MinuteAgg.seen): nessun doppio conteggio; i minuti non recuperati sono "incompleti".
Ogni 5 min: kline 1m ufficiali di ogni stream -> verifica del volume per minuto (scarto atteso < 1%); per Binance anche il
taker buy (fallback del CVD) e, all'avvio, 7 giorni di kline 1m Binance spot/perp (CVD storico) + 3 giorni di candele 1m Coinbase
(premio storico). Ogni 30 s OI e funding aggregati (Binance+Bybit+OKX, analysis/aggregate.live_snapshot).
Persistenza ogni 60 s in DATA_DIR/terminal/ (store.write_parquet, atomico), retention RETENTION_DAYS:
  tb_YYYYMMDD  barre 1m per stream dai trade (t, s, vb, vs, qb, qs, nb, ns, lvb, lvs, lnb, lns, o, h, l, c, ok)
  tg_YYYYMMDD  delta di gruppo per minuto (t, g, d, dmax, dmin)            tk_YYYYMMDD  kline 1m ufficiali (t, s, vol, vb, n, c)
  tp_YYYYMMDD  premio Coinbase per minuto (t, pm, cb, bn, n)               to_YYYYMMDD  OI/funding aggregati (campioni 30 s)
  meta.json    inizio raccolta per stream, sessioni, ultimi id salvati (recupero dopo un riavvio breve)
"""
from __future__ import annotations

import asyncio
import calendar
import json
import logging
import os
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd

from .analysis import terminal_core as tc
from .analysis.terminal_core import STREAMS
from .data import store

log = logging.getLogger("terminal")

ROOT = store.DATA_DIR / "terminal"
RETENTION_DAYS = 30
FLUSH_S = 60
KLINE_CHECK_S = 300
OI_POLL_S = 30
BACKFILL_DAYS = 7
CB_BACKFILL_DAYS = 3
FEED_MIN_USD = 10_000.0        # trade singoli nel feed da $10K; sotto: aggregati ogni 250 ms per stream e lato
SEC_KEEP = 16 * 60             # bucket al secondo tenuti in memoria (order flow 1/5/15 min)
ENABLED = os.environ.get("TERMINAL_COLLECTOR", "on").lower() not in ("off", "0", "false")
DEBUG = os.environ.get("TERMINAL_DEBUG") == "1"

WS = {
    "binance_perp": "wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@ticker/btcusdt@markPrice@1s",
    "binance_spot": "wss://stream.binance.com:9443/ws/btcusdt@aggTrade",
    "bybit_perp": "wss://stream.bybit.com/v5/public/linear",
    "bybit_spot": "wss://stream.bybit.com/v5/public/spot",
    "okx": "wss://ws.okx.com:8443/ws/v5/business",
    "coinbase_spot": "wss://ws-feed.exchange.coinbase.com",
}
REST = {
    "binance_perp": {"agg": "https://fapi.binance.com/fapi/v1/aggTrades", "klines": "https://fapi.binance.com/fapi/v1/klines", "limit": 1500},
    "binance_spot": {"agg": "https://api.binance.com/api/v3/aggTrades", "klines": "https://api.binance.com/api/v3/klines", "limit": 1000},
}
CONTINUOUS = {"binance_perp", "binance_spot", "okx_perp", "okx_spot", "coinbase_spot"}


def _day(t: float) -> str:
    return time.strftime("%Y%m%d", time.gmtime(t))


class StreamState:
    def __init__(self, key: str):
        self.key = key
        self.connected = False
        self.msgs = 0
        self.trades = 0
        self.dupes = 0
        self.last_ts: int | None = None          # ms dell'ultimo trade (exchange)
        self.last_recv: float | None = None
        self.last_price: float | None = None
        self.last_id: int | None = None          # solo stream con id continui
        self.reconnects = 0
        self.connects = 0
        self.first_min: int | None = None        # primo minuto (incompleto) della sessione corrente
        self.incomplete: set[int] = set()
        self.recoveries: deque[dict] = deque(maxlen=40)
        self.false_gaps = 0
        self.check_ids = key in CONTINUOUS
        self.latency_ms: deque[float] = deque(maxlen=300)
        self.need_recent = False                 # Bybit: dopo una riconnessione si chiedono i trade recenti


class TermCollector:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.agg = tc.MinuteAgg()
        self.st = {k: StreamState(k) for k in STREAMS}
        self.started_at: float | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self._http = None
        self.okx_ct_val = tc.OKX_CT_VAL_DEFAULT
        self.okx_ct_verified: dict | None = None
        # order flow al secondo, feed, liquidazioni
        self.secs: dict[int, dict[str, list[float]]] = {}
        self.feed: deque[dict] = deque(maxlen=3000)
        self.feed_seq = 0
        self._pend: dict[tuple[str, bool], list[float]] = {}
        self.liqs: deque[dict] = deque(maxlen=2000)
        self.liq_seq = 0
        self._liq_seen: deque = deque(maxlen=5000)
        # ticker perp Binance
        self.tick: dict = {}
        # premio Coinbase: campioni al secondo -> minuto
        self.prem: dict[int, list[float]] = {}            # minuto -> [somma pm, n, cb ultimo, bn ultimo]
        self.prem_last: float | None = None
        # OI / funding aggregati
        self.oi: list[tuple] = []                         # (t, oi_btc, oi_usd, bn, by, okx, f8, price)
        self.oi_last: dict | None = None
        # kline ufficiali e verifiche
        self.kl: dict[str, dict[int, list]] = {k: {} for k in STREAMS}   # minuto -> [vol, vbuy|nan, n, close]
        self.kchecks: dict[str, dict[int, dict]] = {k: {} for k in STREAMS}
        self.backfill_info: dict = {}
        self.prem_check: dict | None = None
        # persistenza / meta
        self.meta: dict = {}
        self.dirty_days: set[str] = set()
        self.flush_ms: deque[float] = deque(maxlen=60)
        self.cpu = {"collector_pct": 0.0, "flush_pct": 0.0}
        self._cpu_flush_s = 0.0
        self.force_close: set[str] = set()

    # ================================================================ lifecycle
    def start(self) -> None:
        if self.started_at is not None or not ENABLED:
            return
        self.started_at = time.time()
        ROOT.mkdir(parents=True, exist_ok=True)
        self._load_meta()
        try:
            self._load_recent()
        except Exception as e:  # noqa: BLE001
            log.warning("terminal: storico recente non caricato: %s", e)
        store.LIQ_TAPS.append(self.on_liquidation)
        threading.Thread(target=self._thread, daemon=True, name="terminal").start()

    def _thread(self) -> None:
        while True:
            try:
                asyncio.run(self._main())
            except Exception as e:  # noqa: BLE001
                log.warning("terminal loop terminato: %s", e)
            time.sleep(5)

    async def _main(self) -> None:
        import httpx
        self.loop = asyncio.get_running_loop()
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "btc-analyzer"}) as http:
            self._http = http
            await self._okx_ct()
            tasks = [self._ws_binance("binance_perp"), self._ws_binance("binance_spot"), self._ws_bybit("bybit_perp", "linear"),
                     self._ws_bybit("bybit_spot", "spot"), self._ws_okx(), self._ws_coinbase(), self._ticker_loop(), self._flusher(),
                     self._kline_loop(), self._oi_loop(), self._cpu_meter()]
            await asyncio.gather(*[asyncio.create_task(t) for t in tasks])

    async def _okx_ct(self) -> None:
        """ctVal di BTC-USDT-SWAP dalla API ufficiale (atteso 0.01 BTC per contratto)."""
        try:
            r = await self._http.get("https://www.okx.com/api/v5/public/instruments", params={"instType": "SWAP", "instId": "BTC-USDT-SWAP"})
            x = r.json()["data"][0]
            v = float(x["ctVal"])
            if x.get("ctValCcy") == "BTC" and 0 < v < 1:
                self.okx_ct_val = v
            self.okx_ct_verified = {"ct_val": v, "ccy": x.get("ctValCcy"), "t": time.time(), "ok": abs(v - tc.OKX_CT_VAL_DEFAULT) < 1e-12}
        except Exception as e:  # noqa: BLE001
            log.warning("terminal: ctVal OKX non verificato (uso %.2f): %s", self.okx_ct_val, e)

    # ================================================================ ingest
    def on_trade(self, key: str, tr: tuple, live: bool = True) -> bool:
        ts, p, q, buy, tid = tr
        s = self.st[key]
        with self.lock:
            if not self.agg.add(key, tr, live):
                s.dupes += 1
                return False
            m = (ts // 60000) * 60
            s.trades += 1
            if live:
                if s.first_min is None:
                    s.first_min = m
                    s.incomplete.add(m)
                    self.meta.setdefault("first_start", {}).setdefault(key, time.time())
                if s.last_ts is None or ts >= s.last_ts:
                    s.last_ts = ts
                    s.last_price = p
                if key in CONTINUOUS and isinstance(tid, int) and tid > (s.last_id or 0):
                    s.last_id = tid
                s.last_recv = time.time()
                s.latency_ms.append(time.time() * 1000 - ts)
            self.dirty_days.add(_day(m))
            usd = p * q
            if live and ts >= time.time() * 1000 - SEC_KEEP * 1000:
                sec = ts // 1000
                row = self.secs.get(sec)
                if row is None:
                    row = self.secs[sec] = {}
                a = row.get(key)
                if a is None:
                    a = row[key] = [0.0] * 8
                big = usd >= tc.LARGE_USD
                if buy:
                    a[0] += q; a[2] += usd; a[4] += 1; a[6] += big
                else:
                    a[1] += q; a[3] += usd; a[5] += 1; a[7] += big
                # feed
                if usd >= FEED_MIN_USD:
                    self.feed_seq += 1
                    self.feed.append({"k": self.feed_seq, "s": key, "t": ts, "p": p, "u": round(usd, 2), "q": round(q, 5), "b": int(buy), "n": 1, "a": 0})
                else:
                    pd_ = self._pend.get((key, buy))
                    if pd_ is None:
                        self._pend[(key, buy)] = [usd, q, 1, p * q, ts]
                    else:
                        pd_[0] += usd; pd_[1] += q; pd_[2] += 1; pd_[3] += p * q; pd_[4] = max(pd_[4], ts)
            # premio Coinbase vs Binance spot (ultimi prezzi)
        return True

    def flush_feed(self) -> None:
        with self.lock:
            pend, self._pend = self._pend, {}
            for (key, buy), (usd, q, n, pq, ts) in pend.items():
                self.feed_seq += 1
                self.feed.append({"k": self.feed_seq, "s": key, "t": ts, "p": round(pq / q, 2) if q else None, "u": round(usd, 2), "q": round(q, 5),
                                  "b": int(buy), "n": int(n), "a": 1})

    def on_liquidation(self, ev: dict) -> None:
        """Tap di store.add_liquidation (liquidazioni REALI Binance/Bybit/OKX)."""
        try:
            t = pd.Timestamp(ev["time"]).timestamp()
            k = (round(t, 3), ev.get("exchange"), ev.get("symbol"), ev.get("side"), ev.get("price"), ev.get("qty"))
            with self.lock:
                if k in self._liq_seen:
                    return
                self._liq_seen.append(k)
                self.liq_seq += 1
                self.liqs.append({"k": self.liq_seq, "t": t, "side": ev.get("side"), "price": float(ev["price"]), "qty": float(ev.get("qty") or 0),
                                  "usd": float(ev.get("usd") or 0), "ex": ev.get("exchange") or "binance", "sym": ev.get("symbol")})
        except Exception:  # noqa: BLE001
            pass

    def _gap(self, key: str, tid: int, ts: int) -> None:
        """Id continuo: se manca un tratto si recupera via REST (in background)."""
        s = self.st[key]
        last = s.last_id      # aggiornato da on_trade (stesso lock delle barre)
        if last is None or not s.check_ids or tid <= last + 1:
            return
        a0, a1 = last + 1, tid - 1
        if a1 - a0 > 200_000:       # buco enorme (riavvio lungo): non recuperabile in modo affidabile
            self._mark_incomplete(key, s.last_ts, ts)
            return
        asyncio.get_running_loop().create_task(self._recover(key, a0, a1, s.last_ts, ts))

    def _mark_incomplete(self, key: str, t0_ms: int | None, t1_ms: int) -> None:
        if t0_ms is None:
            return
        with self.lock:
            for m in range((t0_ms // 60000) * 60, (t1_ms // 60000) * 60 + 60, 60):
                self.st[key].incomplete.add(m)

    # ================================================================ recupero REST
    async def _recover(self, key: str, a0: int, a1: int, t0: int | None, t1: int) -> None:
        rec = {"t": time.time(), "from": a0, "to": a1, "n": a1 - a0 + 1, "fetched": 0, "new": 0, "ok": False}
        got: list[tuple] = []
        try:
            if key.startswith("binance"):
                nxt = a0
                for _ in range(60):
                    if nxt > a1:
                        break
                    r = await self._http.get(REST[key]["agg"], params={"symbol": "BTCUSDT", "fromId": nxt, "limit": 1000})
                    r.raise_for_status()
                    rows = r.json()
                    if not rows:
                        break
                    for x in rows:
                        if int(x["a"]) > a1:
                            break
                        got.append((int(x["T"]), float(x["p"]), float(x["q"]), not bool(x["m"]), int(x["a"])))
                    nxt = int(rows[-1]["a"]) + 1
                    await asyncio.sleep(0.15)
                rec["ok"] = nxt > a1
            elif key.startswith("okx"):
                inst = "BTC-USDT-SWAP" if key == "okx_perp" else "BTC-USDT"
                after = a1 + 1
                for _ in range(60):
                    r = await self._http.get("https://www.okx.com/api/v5/market/history-trades",
                                             params={"instId": inst, "type": "1", "after": str(after), "limit": "100"})
                    rows = r.json().get("data") or []
                    if not rows:
                        break
                    for x in rows:
                        tid = int(x["tradeId"])
                        if a0 <= tid <= a1:
                            sz = float(x["sz"])
                            got.append((int(x["ts"]), float(x["px"]), sz * self.okx_ct_val if key == "okx_perp" else sz, x.get("side") == "buy", tid))
                    low = min(int(x["tradeId"]) for x in rows)
                    if low <= a0:
                        rec["ok"] = True
                        break
                    after = low
                    await asyncio.sleep(0.12)
            elif key == "coinbase_spot":
                after = a1 + 1
                for _ in range(30):
                    r = await self._http.get("https://api.exchange.coinbase.com/products/BTC-USD/trades", params={"after": str(after), "limit": "1000"})
                    r.raise_for_status()
                    rows = r.json()
                    if not rows:
                        break
                    for x in rows:
                        tid = int(x["trade_id"])
                        if a0 <= tid <= a1:
                            got.append(tc.parse_coinbase_rest(x))
                    low = min(int(x["trade_id"]) for x in rows)
                    if low <= a0:
                        rec["ok"] = True
                        break
                    after = low
                    await asyncio.sleep(0.2)
        except Exception as e:  # noqa: BLE001
            log.warning("terminal %s: recupero trade %d..%d fallito: %s", key, a0, a1, e)
        new = sum(1 for tr in got if self.on_trade(key, tr, live=False))
        rec["fetched"], rec["new"] = len(got), new
        s = self.st[key]
        if rec["ok"] and len(got) == 0:          # ids non contigui per questo stream: niente più recuperi inutili
            s.false_gaps += 1
            if s.false_gaps >= 20 and s.check_ids:
                s.check_ids = False
                log.info("terminal %s: id non contigui, controllo dei buchi disattivato", key)
        else:
            s.false_gaps = 0
        if not rec["ok"]:
            self._mark_incomplete(key, t0, t1)
        s.recoveries.append(rec)
        if DEBUG or rec["n"] > 5:
            log.info("terminal %s: recupero %d..%d -> %d/%d (%s)", key, a0, a1, new, rec["n"], "ok" if rec["ok"] else "incompleto")

    async def _recent_bybit(self, key: str, cat: str) -> None:
        """Dopo una riconnessione: trade recenti via REST successivi all'ultimo visto (Bybit non ha id ordinati)."""
        s = self.st[key]
        t_last = s.last_ts
        rec = {"t": time.time(), "from": t_last, "fetched": 0, "new": 0, "ok": False}
        try:
            r = await self._http.get("https://api.bybit.com/v5/market/recent-trade",
                                     params={"category": cat, "symbol": "BTCUSDT", "limit": 1000 if cat == "linear" else 60})
            rows = (r.json().get("result") or {}).get("list") or []
            trs = [(int(x["time"]), float(x["price"]), float(x["size"]), x["side"] == "Buy", str(x["execId"])) for x in rows]
            fresh = s.need_recent          # primo collegamento dopo un riavvio: gli id del processo precedente non sono noti
            s.need_recent = False
            trs = [t for t in trs if t_last is None or (t[0] > t_last if fresh else t[0] >= t_last - 1000)]
            rec["fetched"] = len(trs)
            rec["new"] = sum(1 for tr in sorted(trs) if self.on_trade(key, tr, live=False))
            oldest = min((int(x["time"]) for x in rows), default=None)
            rec["ok"] = t_last is not None and oldest is not None and oldest <= t_last
        except Exception as e:  # noqa: BLE001
            log.warning("terminal %s: trade recenti non recuperati: %s", key, e)
        if not rec["ok"] and t_last is not None:
            self._mark_incomplete(key, t_last, int(time.time() * 1000))
        s.recoveries.append(rec)

    # ================================================================ WebSocket
    async def _connect(self, key: str, url: str):
        import websockets
        return websockets.connect(url, ping_interval=20, ping_timeout=20, open_timeout=15, close_timeout=5, max_size=2 ** 22)

    def _opened(self, keys: list[str]) -> None:
        for k in keys:
            s = self.st[k]
            s.connected = True
            s.connects += 1
            if s.connects > 1:
                s.reconnects += 1
            self._session_open(k)

    def _closed(self, keys: list[str], e: Exception | None) -> None:
        for k in keys:
            self.st[k].connected = False
        if e is not None:
            log.warning("terminal %s disconnesso: %s", "/".join(keys), e)

    def _check_force(self, key: str) -> None:
        if key in self.force_close:
            self.force_close.discard(key)
            raise ConnectionError("disconnessione simulata (debug)")

    async def _ws_binance(self, key: str) -> None:
        backoff = 1.0
        while True:
            err = None
            try:
                async with await self._connect(key, WS[key]) as ws:
                    self._opened([key])
                    backoff = 1.0
                    s = self.st[key]
                    async for raw in ws:
                        self._check_force(key)
                        d = json.loads(raw)
                        stream = d.get("stream", "")
                        if "data" in d:
                            d = d["data"]
                        s.msgs += 1
                        e = d.get("e")
                        if e == "aggTrade":
                            tr = tc.parse_binance(d)
                            if tr:
                                self._gap(key, tr[4], tr[0])
                                self.on_trade(key, tr)
                        elif e == "24hrTicker" or stream.endswith("@ticker"):
                            self.tick.update({"high_24h": float(d["h"]), "low_24h": float(d["l"]), "vol_24h_btc": float(d["v"]),
                                              "vol_24h_usd": float(d["q"]), "change_24h": float(d["P"]), "t24": time.time()})
                        elif e == "markPriceUpdate":
                            self.tick.update({"mark": float(d["p"]), "index": float(d["i"]), "funding_rate": float(d["r"]) * 100,
                                              "next_funding": int(d["T"]) // 1000, "tm": time.time()})
            except asyncio.CancelledError:
                raise
            except Exception as ex:  # noqa: BLE001
                err = ex
            self._closed([key], err)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    async def _ws_bybit(self, key: str, cat: str) -> None:
        backoff = 1.0
        while True:
            err = None
            try:
                async with await self._connect(key, WS[key]) as ws:
                    await ws.send(json.dumps({"op": "subscribe", "args": ["publicTrade.BTCUSDT"]}))
                    self._opened([key])
                    backoff = 1.0
                    s = self.st[key]
                    if s.last_ts is not None:
                        asyncio.get_running_loop().create_task(self._recent_bybit(key, cat))

                    async def pinger():
                        while True:
                            await asyncio.sleep(20)
                            await ws.send(json.dumps({"op": "ping"}))
                    pt = asyncio.create_task(pinger())
                    try:
                        async for raw in ws:
                            self._check_force(key)
                            d = json.loads(raw)
                            s.msgs += 1
                            for tr in tc.parse_bybit(d):
                                self.on_trade(key, tr)
                    finally:
                        pt.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as ex:  # noqa: BLE001
                err = ex
            self._closed([key], err)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    async def _ws_okx(self) -> None:
        keys = ["okx_perp", "okx_spot"]
        backoff = 1.0
        while True:
            err = None
            try:
                async with await self._connect("okx", WS["okx"]) as ws:
                    await ws.send(json.dumps({"op": "subscribe", "args": [{"channel": "trades-all", "instId": "BTC-USDT-SWAP"},
                                                                          {"channel": "trades-all", "instId": "BTC-USDT"}]}))
                    self._opened(keys)
                    backoff = 1.0

                    async def pinger():
                        while True:
                            await asyncio.sleep(25)
                            await ws.send("ping")
                    pt = asyncio.create_task(pinger())
                    try:
                        async for raw in ws:
                            if raw == "pong":
                                continue
                            for k in keys:
                                self._check_force(k)
                            d = json.loads(raw)
                            for k, tr in tc.parse_okx(d, self.okx_ct_val):
                                self.st[k].msgs += 1
                                self._gap(k, tr[4], tr[0])
                                self.on_trade(k, tr)
                    finally:
                        pt.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as ex:  # noqa: BLE001
                err = ex
            self._closed(keys, err)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    async def _ws_coinbase(self) -> None:
        key = "coinbase_spot"
        backoff = 1.0
        while True:
            err = None
            try:
                async with await self._connect(key, WS[key]) as ws:
                    await ws.send(json.dumps({"type": "subscribe", "product_ids": ["BTC-USD"], "channels": ["matches", "heartbeat"]}))
                    self._opened([key])
                    backoff = 1.0
                    s = self.st[key]
                    async for raw in ws:
                        self._check_force(key)
                        d = json.loads(raw)
                        s.msgs += 1
                        ty = d.get("type")
                        if ty == "match":
                            tr = tc.parse_coinbase(d)
                            if tr:
                                self._gap(key, tr[4], tr[0])
                                self.on_trade(key, tr)
                        elif ty == "heartbeat" and d.get("last_trade_id") and s.last_id is not None:
                            # trade persi in silenzio (messaggi scartati dal canale): il heartbeat porta l'ultimo id
                            ltid = int(d["last_trade_id"])
                            if ltid > s.last_id and s.check_ids:
                                a0, a1 = s.last_id + 1, ltid
                                s.last_id = ltid
                                asyncio.get_running_loop().create_task(self._recover(key, a0, a1, s.last_ts, int(time.time() * 1000)))
            except asyncio.CancelledError:
                raise
            except Exception as ex:  # noqa: BLE001
                err = ex
            self._closed([key], err)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    # ================================================================ ogni 250 ms / 1 s
    async def _ticker_loop(self) -> None:
        last_sec = 0
        while True:
            await asyncio.sleep(0.25)
            try:
                self.flush_feed()
                now = time.time()
                sec = int(now)
                if sec != last_sec:
                    last_sec = sec
                    self._sample_premium(now)
                    with self.lock:
                        for k in [k for k in self.secs if k < sec - SEC_KEEP]:
                            del self.secs[k]
            except Exception as e:  # noqa: BLE001
                log.warning("terminal ticker: %s", e)

    def _sample_premium(self, now: float) -> None:
        cb, bn = self.st["coinbase_spot"], self.st["binance_spot"]
        if cb.last_price is None or bn.last_price is None or cb.last_recv is None or bn.last_recv is None:
            return
        if now - cb.last_recv > 10 or now - bn.last_recv > 10:
            return
        pm = (cb.last_price / bn.last_price - 1) * 100
        m = int(now // 60) * 60
        with self.lock:
            r = self.prem.get(m)
            if r is None:
                r = self.prem[m] = [0.0, 0, 0.0, 0.0]
            r[0] += pm; r[1] += 1; r[2] = cb.last_price; r[3] = bn.last_price
            self.prem_last = pm
            self.dirty_days.add(_day(m))

    # ================================================================ OI / funding
    async def _oi_loop(self) -> None:
        await asyncio.sleep(3)
        while True:
            try:
                from .analysis import aggregate
                snap = await self.loop.run_in_executor(None, aggregate.live_snapshot)
                row = {"t": float(snap.get("time") or time.time())}
                tot_btc = tot_usd = 0.0
                fw = fwn = 0.0
                price = None
                ok = 0
                for ex in ("binance", "bybit", "okx"):
                    c = snap.get(ex)
                    if not isinstance(c, list) or not c:
                        row[ex] = None
                        continue
                    t = aggregate._ex_totals(c)
                    row[ex] = t["oi_btc"]
                    tot_btc += t["oi_btc"]; tot_usd += t["oi_usd"]
                    if t["funding_8h"] is not None:
                        fw += t["funding_8h"] * t["oi_usd"]; fwn += t["oi_usd"]
                    price = price or c[0].get("mark")
                    ok += 1
                if ok == 3:
                    f8 = fw / fwn if fwn else None
                    rec = (row["t"], tot_btc, tot_usd, row["binance"], row["bybit"], row["okx"], f8, price)
                    with self.lock:
                        if not self.oi or self.oi[-1][0] != rec[0]:
                            self.oi.append(rec)
                            self.dirty_days.add(_day(rec[0]))
                        self.oi_last = {"t": rec[0], "oi_btc": tot_btc, "oi_usd": tot_usd, "binance": row["binance"], "bybit": row["bybit"],
                                        "okx": row["okx"], "f8": f8}
            except Exception as e:  # noqa: BLE001
                log.warning("terminal OI: %s", e)
            await asyncio.sleep(OI_POLL_S)

    # ================================================================ kline ufficiali: backfill + verifica
    async def _klines(self, key: str, start_ms: int | None = None, limit: int = 60) -> list[list]:
        """[[minuto, vol BTC, vbuy|nan, n, close]] dalle kline 1m ufficiali dello stream."""
        h = self._http
        if key.startswith("binance"):
            p = {"symbol": "BTCUSDT", "interval": "1m", "limit": limit}
            if start_ms is not None:
                p["startTime"] = start_ms
            r = await h.get(REST[key]["klines"], params=p)
            r.raise_for_status()
            return [[int(k[0]) // 1000, float(k[5]), float(k[9]), int(k[8]), float(k[4])] for k in r.json()]
        if key.startswith("bybit"):
            r = await h.get("https://api.bybit.com/v5/market/kline", params={"category": "linear" if key == "bybit_perp" else "spot",
                                                                            "symbol": "BTCUSDT", "interval": "1", "limit": limit})
            return [[int(k[0]) // 1000, float(k[5]), np.nan, 0, float(k[4])] for k in r.json()["result"]["list"]]
        if key.startswith("okx"):
            inst = "BTC-USDT-SWAP" if key == "okx_perp" else "BTC-USDT"
            r = await h.get("https://www.okx.com/api/v5/market/candles", params={"instId": inst, "bar": "1m", "limit": str(min(limit, 300))})
            # SWAP: vol in contratti, volCcy in BTC; spot: vol in BTC
            return [[int(k[0]) // 1000, float(k[6] if key == "okx_perp" else k[5]), np.nan, 0, float(k[4])] for k in r.json()["data"]]
        if key == "coinbase_spot":
            p = {"granularity": 60}
            if start_ms is not None:
                from datetime import datetime, timezone
                iso = lambda x: datetime.fromtimestamp(x, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
                p.update({"start": iso(start_ms // 1000), "end": iso(start_ms // 1000 + 299 * 60)})
            r = await h.get("https://api.exchange.coinbase.com/products/BTC-USD/candles", params=p)
            r.raise_for_status()
            return [[int(k[0]), float(k[5]), np.nan, 0, float(k[4])] for k in r.json()]
        return []

    def _store_klines(self, key: str, rows: list[list]) -> None:
        now_min = int(time.time() // 60) * 60
        with self.lock:
            for m, vol, vb, n, c in rows:
                if m >= now_min:          # minuto ancora aperto
                    continue
                self.kl[key][m] = [vol, vb, n, c]
                self.dirty_days.add(_day(m))

    async def _backfill(self) -> None:
        """All'avvio: kline 1m Binance spot/perp (CVD storico da taker buy) e candele 1m Coinbase (premio storico)."""
        now = int(time.time() // 60) * 60
        for key, days in (("binance_perp", BACKFILL_DAYS), ("binance_spot", BACKFILL_DAYS), ("coinbase_spot", CB_BACKFILL_DAYS)):
            have = self.kl[key]
            start = now - days * 86400
            missing = [m for m in range(start, now, 60) if m not in have]
            info = {"days": days, "missing_before": len(missing), "fetched": 0, "requests": 0}
            if not missing:
                self.backfill_info[key] = info
                continue
            step = (REST[key]["limit"] if key in REST else 300) * 60
            t = missing[0]
            try:
                while t < now:
                    rows = await self._klines(key, start_ms=t * 1000, limit=REST[key]["limit"] if key in REST else 300)
                    info["requests"] += 1
                    self._store_klines(key, rows)
                    info["fetched"] += len(rows)
                    t += step
                    await asyncio.sleep(0.35 if key == "coinbase_spot" else 0.15)
            except Exception as e:  # noqa: BLE001
                log.warning("terminal backfill %s: %s", key, e)
                info["error"] = str(e)[:120]
            self.backfill_info[key] = info
            log.info("terminal: backfill kline %s -> %d minuti (%d richieste)", key, info["fetched"], info["requests"])

    async def _kline_loop(self) -> None:
        await asyncio.sleep(5)
        try:
            await self._backfill()
        except Exception as e:  # noqa: BLE001
            log.warning("terminal backfill: %s", e)
        await asyncio.sleep(60)
        while True:
            for key in STREAMS:
                try:
                    rows = await self._klines(key, limit=90 if key in REST else 60)
                    self._store_klines(key, rows)
                    self._check(key, rows)
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    log.warning("terminal verifica kline %s: %s", key, e)
                await asyncio.sleep(0.5)
            self._check_premium()
            await asyncio.sleep(KLINE_CHECK_S)

    def _check(self, key: str, rows: list[list]) -> None:
        now_min = int(time.time() // 60) * 60
        s = self.st[key]
        # Coinbase pubblica le candele 1m con qualche minuto di ritardo: si confrontano solo minuti chiusi da ≥ 3 min
        lag = 180 if key == "coinbase_spot" else 60
        with self.lock:
            for m, vol, vb, n, c in rows:
                if m >= now_min - lag or s.first_min is None or m <= s.first_min or m in s.incomplete:
                    continue
                b = self.agg.bars[key].get(m)
                if b is None or vol <= 0:
                    continue
                ours = b[tc.I_VB] + b[tc.I_VS]
                rec = {"t": m, "ours": round(ours, 5), "official": vol, "diff_pct": (ours / vol - 1) * 100}
                if vb == vb and vb > 0:     # taker buy disponibile (Binance)
                    rec["buy_diff_pct"] = (b[tc.I_VB] / vb - 1) * 100
                self.kchecks[key][m] = rec
            cut = time.time() - 86400
            for m in [m for m in self.kchecks[key] if m < cut]:
                del self.kchecks[key][m]

    def _check_premium(self) -> None:
        """Premio live (media al minuto) vs serie oraria esistente pos_cb_1h / k_1h (stesse chiusure orarie)."""
        try:
            h = store.get("pos_cb_1h")
            k = store.get("k_1h")
            cb = h.set_index(pd.to_datetime(h["time"], utc=True))["close"].astype(float)
            bn = k.set_index(pd.to_datetime(k["time"], utc=True))["close"].astype(float)
            ref = ((cb / bn.reindex(cb.index) - 1) * 100).dropna()
            diffs = []
            with self.lock:
                prem = dict(self.prem)
            for ts_h, v in ref.tail(48).items():
                # chiusura oraria = ultimo minuto dell'ora (le candele orarie sono etichettate all'apertura)
                m = int(ts_h.timestamp()) + 3540
                r = prem.get(m)
                if r and r[1] > 0:
                    ours = (r[2] / r[3] - 1) * 100     # ultimi prezzi del minuto di chiusura
                    diffs.append({"t": m, "ours": ours, "ref": float(v), "diff_pp": ours - float(v)})
            a = np.abs([d["diff_pp"] for d in diffs]) if diffs else np.array([])
            self.prem_check = {"n": len(diffs), "median_abs_pp": float(np.median(a)) if len(a) else None, "max_abs_pp": float(a.max()) if len(a) else None,
                               "last": diffs[-3:], "t": time.time()}
        except Exception as e:  # noqa: BLE001
            log.info("terminal: confronto premio non disponibile: %s", e)

    # ================================================================ CPU
    async def _cpu_meter(self) -> None:
        last_w, last_c, last_f = time.perf_counter(), time.thread_time(), self._cpu_flush_s
        while True:
            await asyncio.sleep(30)
            w, c, f = time.perf_counter(), time.thread_time(), self._cpu_flush_s
            dw = max(w - last_w, 1e-6)
            self.cpu = {"collector_pct": round((c - last_c) / dw * 100, 2), "flush_pct": round((f - last_f) / dw * 100, 2), "window_s": round(dw)}
            last_w, last_c, last_f = w, c, f

    # ================================================================ persistenza
    async def _flusher(self) -> None:
        last_ret = 0.0
        while True:
            await asyncio.sleep(FLUSH_S)
            try:
                await self.loop.run_in_executor(None, self.flush)
                if time.time() - last_ret > 3600:
                    last_ret = time.time()
                    await self.loop.run_in_executor(None, self.retention)
            except Exception as e:  # noqa: BLE001
                log.warning("terminal flush fallito: %s", e)

    def flush(self) -> None:
        c0 = time.thread_time()
        t0 = time.perf_counter()
        ROOT.mkdir(parents=True, exist_ok=True)
        snap = []
        with self.lock:
            days, self.dirty_days = self.dirty_days, set()
            # ultimi id contati (recupero dopo un riavvio breve): fotografati insieme alle barre, quindi coerenti con ciò che si scrive
            self.meta["last"] = {k: {"id": s.last_id, "ts": s.last_ts} for k, s in self.st.items()}
            for d in sorted(days):
                d0 = calendar.timegm(time.strptime(d, "%Y%m%d"))
                d1 = d0 + 86400
                snap.append((d,
                             [(m, k, *b, m not in self.st[k].incomplete) for k in STREAMS for m, b in self.agg.bars[k].items() if d0 <= m < d1],
                             [(m, g, *r) for g in tc.GROUPS for m, r in self.agg.grp[g].items() if d0 <= m < d1],
                             [(m, k, *v) for k in STREAMS for m, v in self.kl[k].items() if d0 <= m < d1],
                             [(m, r[0] / r[1], r[2], r[3], r[1]) for m, r in self.prem.items() if d0 <= m < d1 and r[1]],
                             [r for r in self.oi if d0 <= r[0] < d1]))
        for d, tb, tg, tk, tp, to in snap:
            if tb:
                store.write_parquet(pd.DataFrame(tb, columns=["t", "s", *tc.BAR_COLS, "ok"]), ROOT / f"tb_{d}.parquet")
            if tg:
                store.write_parquet(pd.DataFrame(tg, columns=["t", "g", "d", "dmax", "dmin"]), ROOT / f"tg_{d}.parquet")
            if tk:
                store.write_parquet(pd.DataFrame(tk, columns=["t", "s", "vol", "vb", "n", "c"]), ROOT / f"tk_{d}.parquet")
            if tp:
                store.write_parquet(pd.DataFrame(tp, columns=["t", "pm", "cb", "bn", "n"]), ROOT / f"tp_{d}.parquet")
            if to:
                store.write_parquet(pd.DataFrame(to, columns=["t", "oi_btc", "oi_usd", "binance", "bybit", "okx", "f8", "price"]), ROOT / f"to_{d}.parquet")
        for k in STREAMS:
            self._session_touch(k)
        try:
            store.write_text(ROOT / "meta.json", json.dumps(self.meta))
            # verifiche vs kline delle ultime 24 h (sopravvivono a un riavvio)
            with self.lock:
                kc = {k: list(v.values()) for k, v in self.kchecks.items()}
            store.write_text(ROOT / "kline_checks.json", json.dumps(kc))
        except Exception as e:  # noqa: BLE001
            log.warning("terminal meta non salvata: %s", e)
        # memoria: oggi + ieri (il resto si legge dai file)
        cutoff = (int(time.time() // 86400) - 1) * 86400
        with self.lock:
            self.agg.prune(cutoff)
            for k in STREAMS:
                self.kl[k] = {m: v for m, v in self.kl[k].items() if m >= cutoff - BACKFILL_DAYS * 86400} if k in REST or k == "coinbase_spot" else \
                    {m: v for m, v in self.kl[k].items() if m >= cutoff}
                self.st[k].incomplete = {m for m in self.st[k].incomplete if m >= cutoff - 86400}
            self.prem = {m: r for m, r in self.prem.items() if m >= cutoff}
            self.oi = [r for r in self.oi if r[0] >= cutoff]
        self.flush_ms.append((time.perf_counter() - t0) * 1000)
        self._cpu_flush_s += time.thread_time() - c0

    def retention(self) -> None:
        now = time.time()
        for f in ROOT.glob("*.parquet"):
            try:
                day = f.stem.split("_", 1)[1][:8]
                if (now - calendar.timegm(time.strptime(day, "%Y%m%d"))) / 86400 > RETENTION_DAYS + 1:
                    f.unlink()
                    log.info("terminal retention: rimosso %s", f.name)
            except Exception:  # noqa: BLE001
                continue

    def _load_recent(self) -> None:
        """Avvio: ricarica oggi e ieri (barre, gruppi, premio, OI) e le kline del periodo di backfill."""
        now = time.time()
        for d in (_day(now - 86400), _day(now)):
            p = ROOT / f"tb_{d}.parquet"
            if p.exists():
                for r in pd.read_parquet(p).itertuples(index=False):
                    m, k = int(r.t), str(r.s)
                    if k not in STREAMS:
                        continue
                    self.agg.bars[k][m] = [float(getattr(r, c)) for c in tc.BAR_COLS]
                    self.agg.tlast[k][m] = m * 1000
                    self.agg.tfirst[k][m] = m * 1000
                    if not r.ok:
                        self.st[k].incomplete.add(m)
            p = ROOT / f"tg_{d}.parquet"
            if p.exists():
                for r in pd.read_parquet(p).itertuples(index=False):
                    self.agg.grp[str(r.g)][int(r.t)] = [float(r.d), float(r.dmax), float(r.dmin)]
            p = ROOT / f"tp_{d}.parquet"
            if p.exists():
                for r in pd.read_parquet(p).itertuples(index=False):
                    self.prem[int(r.t)] = [float(r.pm) * int(r.n), int(r.n), float(r.cb), float(r.bn)]
            p = ROOT / f"to_{d}.parquet"
            if p.exists():
                self.oi += [tuple(x) for x in pd.read_parquet(p).itertuples(index=False)]
        for i in range(BACKFILL_DAYS + 1):
            p = ROOT / f"tk_{_day(now - i * 86400)}.parquet"
            if p.exists():
                for r in pd.read_parquet(p).itertuples(index=False):
                    if str(r.s) in STREAMS:
                        self.kl[str(r.s)][int(r.t)] = [float(r.vol), float(r.vb), int(r.n), float(r.c)]
        p = ROOT / "kline_checks.json"
        if p.exists():
            try:
                for k, rows in json.loads(p.read_text(encoding="utf-8")).items():
                    if k in self.kchecks:
                        self.kchecks[k] = {int(r["t"]): r for r in rows if r.get("t", 0) >= now - 86400}
            except Exception as e:  # noqa: BLE001
                log.warning("terminal: verifiche kline non ricaricate: %s", e)
        # riavvio ravvicinato (< 15 min): si riparte dagli ultimi id salvati, così il primo trade live fa recuperare via REST quelli persi
        last = self.meta.get("last") or {}
        for k, s in self.st.items():
            L = last.get(k) or {}
            if L.get("ts") and now * 1000 - L["ts"] < 900_000 and k in CONTINUOUS and L.get("id"):
                s.last_id, s.last_ts = int(L["id"]), int(L["ts"])
            elif L.get("ts"):
                m_last = (int(L["ts"]) // 60000) * 60
                s.incomplete.add(m_last)          # i trade dopo l'ultimo flush di quel minuto non sono più recuperabili
                if k.startswith("bybit") and now * 1000 - L["ts"] < 900_000:
                    s.last_ts = int(L["ts"])
                    s.need_recent = True
        self.oi.sort()

    # ================================================================ meta / sessioni
    def _load_meta(self) -> None:
        p = ROOT / "meta.json"
        try:
            if p.exists():
                self.meta = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            log.warning("terminal meta illeggibile: %s", e)
            self.meta = {}

    def _session_open(self, key: str) -> None:
        ses = self.meta.setdefault("sessions", {}).setdefault(key, [])
        now = time.time()
        if not ses or ses[-1][1] < now - 120:
            ses.append([now, now])
        self.meta["sessions"][key] = ses[-200:]

    def _session_touch(self, key: str) -> None:
        ses = (self.meta.get("sessions") or {}).get(key)
        if ses and self.st[key].connected:
            ses[-1][1] = time.time()


# ============================================================================ lettura file

def read_days(kind: str, t0: float, t1: float) -> pd.DataFrame:
    """Concatena i parquet giornalieri `kind` (tb/tg/tk/tp/to) che coprono [t0, t1)."""
    frames = []
    d = int(t0 // 86400) * 86400
    while d < t1:
        p = ROOT / f"{kind}_{_day(d)}.parquet"
        if p.exists():
            try:
                df = pd.read_parquet(p)
                frames.append(df[(df["t"] >= t0) & (df["t"] < t1)])
            except Exception as e:  # noqa: BLE001
                log.warning("terminal: lettura %s fallita: %s", p.name, e)
        d += 86400
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


collector = TermCollector()


def start() -> None:
    try:
        collector.start()
    except Exception as e:  # noqa: BLE001
        log.warning("collector terminale non avviato: %s", e)
