"""Collector live dell'order book e dei trade aggressivi Binance (heatmap stile Bookmap + footprint).

Gira in un thread daemon con il proprio event loop asyncio (non blocca il loop di FastAPI). Per ogni mercato
(futures = Binance USDⓈ-M BTCUSDT, spot = Binance BTCUSDT; env ORDERBOOK_MARKETS, default "futures,spot"):

  depth   wss diff stream @100ms + snapshot REST -> LocalBook (procedura ufficiale Binance, risincronizzazione automatica
          sui buchi di update id). Ogni VERIFY_S secondi: nuovo snapshot REST, book "ombra" portato allo stesso update id
          e confronto livello per livello (atteso 0 differenze); i livelli dello snapshot riparano/estendono il book.
  trades  wss aggTrade (lato aggressore da `m`: true = compratore maker = vendita aggressiva). Buchi negli id `a`
          (riconnessioni) recuperati via REST aggTrades; se il recupero fallisce i minuti sono marcati incompleti.
  sampler ogni 1 s: liquidità in bucket da $10 entro ±RANGE_PCT dal mid + statistiche dei trade del secondo;
          muri / liquidità ritirata (WallTracker); medie al minuto.
  verify  ogni 5 min: volume aggressivo per minuto (buy+sell) vs volume delle kline 1m ufficiali (REST).
  flush   ogni 60 s (thread executor): parquet atomici via store.write_parquet / write_text; retention dichiarata.

File in DATA_DIR/orderbook/<market>/:
  hs_YYYYMMDD_HH.parquet  campioni 1 s, solo variazioni: r (campione), p (bucket [p, p+10)), q (BTC; −1 = fuori range)
  hsm_YYYYMMDD_HH.parquet meta per campione (t, mid, best bid/ask, trade del secondo, ...)   retention HS_DAYS (entrambi)
  hm_YYYYMMDD.parquet     medie al minuto, stesso schema + n (campioni)                           retention HM_DAYS
  fp_YYYYMMDD.parquet     footprint: t (minuto), p (bin $5), buy, sell (BTC aggressivi)           retention FP_DAYS
  fk_YYYYMMDD.parquet     candele 1m dai trade: o h l c buy sell n a0 a1 ok                         retention FP_DAYS
  ev_YYYYMMDD.parquet     eventi dei muri (appeared / consumed / pulled)                           retention FP_DAYS
  meta.json               inizio raccolta, sessioni, risincronizzazioni, verifiche
"""
from __future__ import annotations

import asyncio
import calendar
import json
import logging
import math
import os
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd

from .analysis.orderbook_core import (
    BASE_BUCKET, FP_BASE_BIN, BookSample, LocalBook, WallTracker, bucketize, compare_books, fp_bin, parse_depth,
)
from .data import store

log = logging.getLogger("orderbook")

RANGE_PCT = 1.5          # ±% dal mid campionato nella heatmap
SAMPLE_S = 1             # intervallo di campionamento (s)
FLUSH_S = 60
MEM_SAMPLES = 7200       # 2 h di campioni 1 s in memoria per mercato
HS_DAYS = 7              # retention campioni 1 s
HM_DAYS = 30             # retention medie al minuto
FP_DAYS = 30             # retention footprint / candele / eventi
PRUNE_PCT = 8.0          # livelli del book oltre ±8% dal mid scartati (memoria)
KLINE_CHECK_S = 300
DEBUG = os.environ.get("ORDERBOOK_DEBUG") == "1"

MARKETS = {
    "futures": {
        "kind": "futures", "label": "Binance USDⓈ-M BTCUSDT",
        "depth_ws": "wss://fstream.binance.com/public/ws/btcusdt@depth@100ms",
        "trade_ws": "wss://fstream.binance.com/market/ws/btcusdt@aggTrade",
        "snap": "https://fapi.binance.com/fapi/v1/depth", "snap_limit": 1000,
        "agg": "https://fapi.binance.com/fapi/v1/aggTrades", "klines": "https://fapi.binance.com/fapi/v1/klines",
        "verify_s": 120, "wall_min_qty": 2.0,
    },
    "spot": {
        "kind": "spot", "label": "Binance spot BTCUSDT",
        "depth_ws": "wss://stream.binance.com:9443/ws/btcusdt@depth@100ms",
        "trade_ws": "wss://stream.binance.com:9443/ws/btcusdt@aggTrade",
        "snap": "https://api.binance.com/api/v3/depth", "snap_limit": 5000,
        "agg": "https://api.binance.com/api/v3/aggTrades", "klines": "https://api.binance.com/api/v3/klines",
        "verify_s": 300, "wall_min_qty": 1.0,
    },
}
ENABLED = [m.strip() for m in (os.environ.get("ORDERBOOK_MARKETS") or "futures,spot").split(",") if m.strip() in MARKETS]

ROOT = store.DATA_DIR / "orderbook"
META_COLS = ["mid", "bb", "ba", "last", "hi", "lo", "vb", "vs", "vwap", "bd05", "ad05", "bd1", "ad1", "tlo", "thi"]


def _day(t: float) -> str:
    return time.strftime("%Y%m%d", time.gmtime(t))


def _hour(t: float) -> str:
    return time.strftime("%Y%m%d_%H", time.gmtime(t))


# ============================================================================ helpers: samples <-> dataframe

def samples_to_df(rows: list[tuple[float, int, np.ndarray, dict]], extra: list[str] | None = None) -> pd.DataFrame:
    """[(t, lo_idx, arr, meta)] -> DataFrame wide (t, META_COLS, extra, p<prezzo>...)."""
    if not rows:
        return pd.DataFrame()
    lo = min(r[1] for r in rows)
    hi = max(r[1] + len(r[2]) for r in rows)
    M = np.full((len(rows), hi - lo), np.nan, np.float32)
    for i, (_, li, arr, _) in enumerate(rows):
        M[i, li - lo: li - lo + len(arr)] = arr
    M = np.round(M, 3)
    data: dict[str, object] = {"t": np.array([r[0] for r in rows], np.float64)}
    for c in META_COLS + (extra or []):
        data[c] = np.array([r[3].get(c, np.nan) if r[3].get(c) is not None else np.nan for r in rows], np.float64)
    cols = {f"p{int(round((lo + j) * BASE_BUCKET))}": M[:, j] for j in range(hi - lo)}
    return pd.DataFrame({**data, **cols})


def df_price_cols(columns) -> list[tuple[int, str]]:
    out = []
    for c in columns:
        if isinstance(c, str) and c.startswith("p") and c[1:].isdigit():
            out.append((int(c[1:]), c))
    return sorted(out)


def encode_hs(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Campioni 1 s densi -> formato "solo variazioni" (≈3–10× più compatto: la maggior parte dei livelli non cambia ogni secondo).

    meta_df: una riga per campione (t + META_COLS). long_df: (r = indice di riga, p = prezzo del bucket, q = BTC) solo dove il
    valore cambia rispetto al campione precedente; la prima riga è completa; q = −1 = bucket uscito dal range campionato.
    """
    pcols = df_price_cols(df.columns)
    meta_df = df[["t"] + [c for c in META_COLS if c in df.columns]].copy()
    if not pcols:
        return pd.DataFrame({"r": [], "p": [], "q": []}), meta_df
    M = df[[c for _, c in pcols]].to_numpy(np.float64)
    M = np.round(M, 2)
    prev = np.vstack([np.full((1, M.shape[1]), np.inf), M[:-1]])
    nan, pnan = np.isnan(M), np.isnan(prev)
    changed = (M != prev) & ~(nan & pnan)
    changed[0] = ~nan[0]
    r, c = np.nonzero(changed)
    q = np.where(nan[r, c], -1.0, M[r, c]).astype(np.float32)
    prices = np.array([p for p, _ in pcols], np.int32)
    return pd.DataFrame({"r": r.astype(np.int32), "p": prices[c], "q": q}), meta_df


def decode_hs(long_df: pd.DataFrame, n: int, plo: float | None = None, phi: float | None = None) -> tuple[int, np.ndarray]:
    """Inverso di encode_hs (con proiezione opzionale sul range di prezzo) -> (lo_idx, M[n × m] float32, NaN = assente)."""
    if plo is not None:
        long_df = long_df[(long_df["p"] >= plo - BASE_BUCKET) & (long_df["p"] <= phi)]
    if long_df.empty:
        return 0, np.zeros((n, 0), np.float32)
    idx = np.round(long_df["p"].to_numpy() / BASE_BUCKET).astype(np.int64)
    lo, hi = int(idx.min()), int(idx.max()) + 1
    M = np.full((n, hi - lo), np.nan, np.float64)
    r = long_df["r"].to_numpy(np.int64)
    ok = r < n
    M[r[ok], idx[ok] - lo] = long_df["q"].to_numpy(np.float64)[ok]
    M = pd.DataFrame(M).ffill().to_numpy(np.float64, copy=True)
    M[M < 0] = np.nan
    return lo, M.astype(np.float32)


# ============================================================================ market state

class Market:
    def __init__(self, name: str):
        self.name = name
        self.cfg = MARKETS[name]
        self.dir = ROOT / name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.book = LocalBook(self.cfg["kind"])
        self.shadow: LocalBook | None = None
        self.verify_started: float | None = None
        self.depth_connected = False
        self.trade_connected = False
        self.depth_msgs = 0
        self.trade_msgs = 0
        self.last_depth_E: int | None = None
        self.last_trade_T: int | None = None
        self.latency_ms: deque[float] = deque(maxlen=200)
        self.resyncs: deque[dict] = deque(maxlen=50)
        self.verifications: deque[dict] = deque(maxlen=100)
        self.kline_checks: dict[int, dict] = {}
        self.need_snapshot = True
        self.snap_inflight = False
        self.last_snapshot_at = 0.0
        self.snapshots = 0
        self.disconnects = {"depth": 0, "trades": 0}
        self.drop_next_depth = False     # debug: simula un buco negli update id
        self.force_close: set[str] = set()
        # campioni
        self.samples: deque[BookSample] = deque(maxlen=MEM_SAMPLES)
        self.tracker = WallTracker(min_qty=self.cfg["wall_min_qty"])
        self.events: list[dict] = []           # eventi dei muri (oggi + ieri in memoria)
        self.hm_rows: list[tuple[float, int, np.ndarray, dict]] = []   # medie al minuto (oggi + ieri)
        self._macc: dict | None = None         # accumulatore del minuto corrente
        # trade del secondo corrente
        self._sec = self._new_sec()
        self.last_price: float | None = None
        # footprint
        self.fp: dict[int, dict[float, list[float]]] = {}      # minuto -> bin -> [buy, sell]
        self.fk: dict[int, list] = {}                          # minuto -> [o,h,l,c,buy,sell,n,a0,a1]
        self.incomplete: set[int] = set()
        self.first_trade_min: int | None = None
        self.last_a: int | None = None
        self.last_a_T: int | None = None
        self.backfills: deque[dict] = deque(maxlen=50)
        # persistenza
        self.dirty_days: set[str] = set()
        self.dirty_hours: set[str] = set()
        self.hour_prefix: dict[str, list] = {}
        self.flush_ms: deque[float] = deque(maxlen=60)

    @staticmethod
    def _new_sec() -> dict:
        return {"vb": 0.0, "vs": 0.0, "pv": 0.0, "hi": None, "lo": None, "bk": {}}

    # ------------------------------------------------------------ trades
    def on_trade(self, a: int, p: float, q: float, T: int, buyer_maker: bool, live: bool = True) -> None:
        buy = not buyer_maker
        m = (T // 60000) * 60
        with self.lock:
            if live:
                if self.first_trade_min is None:
                    self.first_trade_min = m
                    self.incomplete.add(m)   # primo minuto: raccolta iniziata a metà
                self.last_a, self.last_a_T = a, T
                self.last_trade_T = T
                self.last_price = p
                s = self._sec
                if buy:
                    s["vb"] += q
                else:
                    s["vs"] += q
                s["pv"] += p * q
                s["hi"] = p if s["hi"] is None or p > s["hi"] else s["hi"]
                s["lo"] = p if s["lo"] is None or p < s["lo"] else s["lo"]
                k = int(p // BASE_BUCKET)
                s["bk"][k] = s["bk"].get(k, 0.0) + q
            lv = self.fp.get(m)
            if lv is None:
                lv = self.fp[m] = {}
            b = fp_bin(p)
            cell = lv.get(b)
            if cell is None:
                lv[b] = [q, 0.0] if buy else [0.0, q]
            elif buy:
                cell[0] += q
            else:
                cell[1] += q
            k = self.fk.get(m)
            if k is None:
                self.fk[m] = [p, p, p, p, q if buy else 0.0, 0.0 if buy else q, 1, a, a, T, T]
            else:
                if T < k[9]:          # trade recuperato via REST più vecchio: aggiorna l'apertura
                    k[0], k[9] = p, T
                if T >= k[10]:
                    k[3], k[10] = p, T
                if p > k[1]:
                    k[1] = p
                if p < k[2]:
                    k[2] = p
                if buy:
                    k[4] += q
                else:
                    k[5] += q
                k[6] += 1
                k[7] = min(k[7], a)
                k[8] = max(k[8], a)
            self.dirty_days.add(_day(m))

    def take_second(self) -> dict:
        with self.lock:
            s, self._sec = self._sec, self._new_sec()
        return s

    # ------------------------------------------------------------ samples
    def add_sample(self, s: BookSample, sec: dict) -> list[dict]:
        v = sec["vb"] + sec["vs"]
        s.extra = {"last": self.last_price, "hi": sec["hi"], "lo": sec["lo"], "vb": round(sec["vb"], 4), "vs": round(sec["vs"], 4),
                   "vwap": sec["pv"] / v if v > 0 else None}
        events = self.tracker.update(s, sec["bk"], sec["lo"], sec["hi"])
        for e in events:
            e["market"] = self.name
        with self.lock:
            self.samples.append(s)
            self.dirty_hours.add(_hour(s.t))
            if events:
                self.events.extend(events)
                self.dirty_days.add(_day(s.t))
            self._acc_minute(s)
        return events

    def _acc_minute(self, s: BookSample) -> None:
        m = int(s.t // 60) * 60
        acc = self._macc
        if acc is not None and acc["t"] != m:
            self._close_minute()
            acc = None
        if acc is None:
            acc = self._macc = {"t": m, "lo": s.lo_idx, "sum": np.zeros(len(s.arr), np.float64), "cnt": np.zeros(len(s.arr), np.float64),
                                "n": 0, "meta": {c: [] for c in META_COLS}}
        lo, n = acc["lo"], len(acc["sum"])
        new_lo, new_hi = min(lo, s.lo_idx), max(lo + n, s.lo_idx + len(s.arr))
        if new_lo != lo or new_hi != lo + n:
            pad = ((lo - new_lo), (new_hi - lo - n))
            acc["sum"] = np.pad(acc["sum"], pad)
            acc["cnt"] = np.pad(acc["cnt"], pad)
            acc["lo"] = lo = new_lo
        off = s.lo_idx - lo
        acc["sum"][off: off + len(s.arr)] += s.arr
        acc["cnt"][off: off + len(s.arr)] += 1
        acc["n"] += 1
        meta = self.sample_meta(s)
        for c in META_COLS:
            acc["meta"][c].append(meta.get(c))

    def _close_minute(self) -> None:
        acc = self._macc
        self._macc = None
        if not acc or acc["n"] == 0:
            return
        with np.errstate(invalid="ignore", divide="ignore"):
            arr = np.where(acc["cnt"] > 0, acc["sum"] / np.maximum(acc["cnt"], 1), np.nan).astype(np.float32)
        meta: dict[str, float | None] = {}
        for c, vals in acc["meta"].items():
            v = [x for x in vals if x is not None and not (isinstance(x, float) and math.isnan(x))]
            if not v:
                meta[c] = None
            elif c in ("vb", "vs"):
                meta[c] = float(sum(v))
            elif c == "hi":
                meta[c] = float(max(v))
            elif c == "lo":
                meta[c] = float(min(v))
            elif c in ("last", "tlo", "thi"):
                meta[c] = float(v[-1])
            else:
                meta[c] = float(np.mean(v))
        pv = sum((x or 0) * ((b or 0) + (s_ or 0)) for x, b, s_ in zip(acc["meta"]["vwap"], acc["meta"]["vb"], acc["meta"]["vs"]))
        vol = (meta.get("vb") or 0) + (meta.get("vs") or 0)
        meta["vwap"] = pv / vol if vol > 0 else None
        meta["n"] = acc["n"]
        self.hm_rows.append((float(acc["t"]), acc["lo"], arr, meta))
        self.dirty_days.add(_day(acc["t"]))

    @staticmethod
    def sample_meta(s: BookSample) -> dict:
        e = s.extra or {}
        return {"mid": s.mid, "bb": s.bb, "ba": s.ba, "last": e.get("last"), "hi": e.get("hi"), "lo": e.get("lo"), "vb": e.get("vb"),
                "vs": e.get("vs"), "vwap": e.get("vwap"), "bd05": s.bd05, "ad05": s.ad05, "bd1": s.bd1, "ad1": s.ad1,
                "tlo": s.tlo, "thi": s.thi}

    # ------------------------------------------------------------ resync / verification
    def note_resync(self, reason: str) -> None:
        """reason: 'connect' (nuova connessione depth) | 'gap' (buco negli update id)."""
        self.resyncs.append({"t": time.time(), "reason": reason})
        log.info("orderbook %s: risincronizzazione (%s)", self.name, reason)

    def finish_verification(self) -> None:
        sh = self.shadow
        if sh is None or not sh.synced:
            return
        if sh.last_u != self.book.last_u or not self.book.synced:
            self.shadow = None
            return
        lo, hi = sh.snap_lo, sh.snap_hi
        # zona già coperta da snapshot precedenti (mantenuta esatta dal diff stream: atteso 0 differenze) vs zona nuova,
        # raggiunta dal prezzo dopo l'ultimo snapshot e ricostruita solo dagli aggiornamenti (livelli mai toccati assenti)
        plo, phi = self.book.snap_lo, self.book.snap_hi
        tlo, thi = (max(lo, plo), min(hi, phi)) if plo is not None else (lo, lo - 1)
        full = compare_books(self.book, sh, lo, hi)
        res = compare_books(self.book, sh, tlo, thi) if thi >= tlo else {**full, "range_levels": 0, "range_mismatch": 0}
        res.update({"t": time.time(), "snapshot_id": sh.last_snapshot_id, "lo": lo, "hi": hi, "trusted_lo": tlo, "trusted_hi": thi,
                    "new_zone_levels": full["range_levels"] - res["range_levels"],
                    "new_zone_mismatch": full["range_mismatch"] - res["range_mismatch"],
                    "diff_only": self._diff_only_levels(lo, hi)})
        self.verifications.append(res)
        if res["range_mismatch"] or not res["best_match"] or res["top_mismatch"]:
            bad = [(p, self.book.bids.get(p, self.book.asks.get(p)), sh.bids.get(p, sh.asks.get(p)))
                   for p in sorted(set(self.book.bids) | set(self.book.asks) | set(sh.bids) | set(sh.asks))
                   if tlo <= p <= thi and (self.book.bids.get(p), self.book.asks.get(p)) != (sh.bids.get(p), sh.asks.get(p))][:5]
            log.warning("orderbook %s: verifica con %d differenze nella zona coperta (top %d) — riparate dallo snapshot: %s",
                        self.name, res["range_mismatch"], res["top_mismatch"], bad)
        self.book.overwrite_range(sh, lo, hi)
        self.shadow = None
        self.verify_started = None

    def _diff_only_levels(self, lo: float, hi: float) -> int:
        """Quanti dei livelli confrontati erano fuori dall'intervallo coperto dagli snapshot precedenti (ricostruiti dal solo diff stream)."""
        b = self.book
        if b.snap_lo is None:
            return 0
        n = 0
        for d in (b.bids, b.asks):
            n += sum(1 for p in d if lo <= p <= hi and (p < b.snap_lo or p > b.snap_hi))
        return n


# ============================================================================ collector

class Collector:
    def __init__(self) -> None:
        self.markets: dict[str, Market] = {}
        self.started_at: float | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.cpu: dict[str, float] = {"collector_pct": 0.0, "flush_pct": 0.0}
        self._cpu_flush_s = 0.0
        self.meta: dict = {}
        self._http = None

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self.started_at is not None or not ENABLED:
            return
        self.started_at = time.time()
        ROOT.mkdir(parents=True, exist_ok=True)
        for m in ENABLED:
            self.markets[m] = Market(m)
        self._load_meta()
        for mk in self.markets.values():
            try:
                self._load_recent(mk)
            except Exception as e:  # noqa: BLE001
                log.warning("orderbook %s: storico recente non caricato: %s", mk.name, e)
        threading.Thread(target=self._thread, daemon=True, name="orderbook").start()

    def _thread(self) -> None:
        while True:
            try:
                asyncio.run(self._main())
            except Exception as e:  # noqa: BLE001
                log.warning("orderbook loop terminato: %s", e)
            time.sleep(5)

    async def _main(self) -> None:
        import httpx
        self.loop = asyncio.get_running_loop()
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "btc-analyzer"}) as http:
            self._http = http
            tasks = [asyncio.create_task(self._sampler()), asyncio.create_task(self._flusher()), asyncio.create_task(self._cpu_meter())]
            for mk in self.markets.values():
                tasks += [asyncio.create_task(self._depth(mk)), asyncio.create_task(self._trades(mk)),
                          asyncio.create_task(self._snapshots(mk)), asyncio.create_task(self._kline_check(mk))]
            await asyncio.gather(*tasks)

    # ------------------------------------------------------------ depth
    async def _depth(self, mk: Market) -> None:
        import websockets
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(mk.cfg["depth_ws"], ping_interval=20, ping_timeout=20, open_timeout=15,
                                              close_timeout=5, max_size=2 ** 22) as ws:
                    mk.depth_connected = True
                    backoff = 1.0
                    mk.book.reset()
                    mk.shadow = None
                    mk.need_snapshot = True
                    mk.note_resync("connect")
                    self._session_open(mk)
                    async for raw in ws:
                        if "depth" in mk.force_close:
                            mk.force_close.discard("depth")
                            raise ConnectionError("disconnessione simulata (debug)")
                        d = json.loads(raw)
                        if "data" in d:
                            d = d["data"]
                        if d.get("e") != "depthUpdate":
                            continue
                        mk.depth_msgs += 1
                        if mk.drop_next_depth:
                            mk.drop_next_depth = False
                            continue
                        ev = parse_depth(d)
                        mk.last_depth_E = ev["E"]
                        if ev["E"]:
                            mk.latency_ms.append(time.time() * 1000 - ev["E"])
                        r = mk.book.on_event(ev)
                        if r == "gap":
                            mk.note_resync("gap")
                            mk.shadow = None
                            mk.need_snapshot = True
                        elif r == "stale":
                            mk.need_snapshot = True
                        elif r == "synced":
                            log.info("orderbook %s: book sincronizzato (u=%s, %d bid / %d ask)", mk.name, mk.book.last_u,
                                     len(mk.book.bids), len(mk.book.asks))
                        if mk.shadow is not None:
                            rs = mk.shadow.on_event(ev)
                            if rs in ("gap", "stale"):
                                mk.shadow = None
                            elif mk.shadow.synced:
                                mk.finish_verification()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("orderbook %s depth disconnesso: %s (retry %.0fs)", mk.name, e, backoff)
            mk.depth_connected = False
            mk.disconnects["depth"] += 1
            mk.book.reset()
            mk.shadow = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    async def _fetch_snapshot(self, mk: Market) -> tuple[int, list, list] | None:
        r = await self._http.get(mk.cfg["snap"], params={"symbol": "BTCUSDT", "limit": mk.cfg["snap_limit"]})
        r.raise_for_status()
        d = r.json()
        mk.snapshots += 1
        mk.last_snapshot_at = time.time()
        return int(d["lastUpdateId"]), [(float(p), float(q)) for p, q in d["bids"]], [(float(p), float(q)) for p, q in d["asks"]]

    async def _snapshots(self, mk: Market) -> None:
        """Snapshot iniziali / dopo un buco e snapshot periodici di verifica (book ombra allo stesso update id)."""
        fails = 0
        while True:
            await asyncio.sleep(0.25)
            try:
                if not mk.depth_connected:
                    continue
                if not mk.book.synced:
                    if mk.book.pending is not None or not mk.book.buffer:
                        continue           # in attesa del primo evento o di eventi più recenti dello snapshot
                    if time.time() - mk.last_snapshot_at < min(2.0 * (fails + 1), 30):
                        continue
                    snap = await self._fetch_snapshot(mk)
                    if snap is None:
                        continue
                    r = mk.book.load_snapshot(*snap)
                    if r == "synced":
                        fails = 0
                        log.info("orderbook %s: sincronizzato con snapshot %d", mk.name, snap[0])
                    elif r in ("stale", "gap"):
                        fails += 1
                    continue
                # verifica periodica
                if mk.shadow is None and time.time() - mk.last_snapshot_at >= mk.cfg["verify_s"]:
                    mk.shadow = LocalBook(mk.cfg["kind"])
                    mk.verify_started = time.time()
                    snap = await self._fetch_snapshot(mk)
                    if snap is None or mk.shadow is None:
                        mk.shadow = None
                        continue
                    r = mk.shadow.load_snapshot(*snap)
                    if r == "synced":
                        mk.finish_verification()
                    elif r in ("stale", "gap"):
                        mk.shadow = None
                elif mk.shadow is not None and mk.verify_started and time.time() - mk.verify_started > 60:
                    mk.shadow = None          # verifica non conclusa (snapshot troppo nuovo e nessun evento): si riprova
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                fails += 1
                mk.shadow = None
                log.warning("orderbook %s snapshot fallito: %s", mk.name, e)
                await asyncio.sleep(min(5 * fails, 60))

    # ------------------------------------------------------------ trades
    async def _trades(self, mk: Market) -> None:
        import websockets
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(mk.cfg["trade_ws"], ping_interval=20, ping_timeout=20, open_timeout=15, close_timeout=5) as ws:
                    mk.trade_connected = True
                    backoff = 1.0
                    async for raw in ws:
                        if "trades" in mk.force_close:
                            mk.force_close.discard("trades")
                            raise ConnectionError("disconnessione simulata (debug)")
                        d = json.loads(raw)
                        if "data" in d:
                            d = d["data"]
                        if d.get("e") != "aggTrade":
                            continue
                        mk.trade_msgs += 1
                        a = int(d["a"])
                        if mk.last_a is not None:
                            if a <= mk.last_a:
                                continue
                            if a > mk.last_a + 1:
                                asyncio.create_task(self._backfill(mk, mk.last_a + 1, a - 1, mk.last_a_T, int(d["T"])))
                        mk.on_trade(a, float(d["p"]), float(d["q"]), int(d["T"]), bool(d["m"]))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("orderbook %s trades disconnesso: %s (retry %.0fs)", mk.name, e, backoff)
            mk.trade_connected = False
            mk.disconnects["trades"] += 1
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    async def _backfill(self, mk: Market, a0: int, a1: int, t0: int | None, t1: int) -> None:
        """Recupera via REST i trade aggregati mancanti (id a0..a1) dopo una disconnessione."""
        rec = {"t": time.time(), "from": a0, "to": a1, "n": a1 - a0 + 1, "ok": False, "fetched": 0}
        got = 0
        nxt = a0
        try:
            for _ in range(40):
                if nxt > a1:
                    break
                r = await self._http.get(mk.cfg["agg"], params={"symbol": "BTCUSDT", "fromId": nxt, "limit": 1000})
                r.raise_for_status()
                rows = r.json()
                if not rows:
                    break
                for x in rows:
                    a = int(x["a"])
                    if a > a1:
                        break
                    mk.on_trade(a, float(x["p"]), float(x["q"]), int(x["T"]), bool(x["m"]), live=False)
                    got += 1
                nxt = int(rows[-1]["a"]) + 1
                await asyncio.sleep(0.2)
            rec["ok"] = nxt > a1
        except Exception as e:  # noqa: BLE001
            log.warning("orderbook %s recupero trade fallito: %s", mk.name, e)
        rec["fetched"] = got
        if not rec["ok"] and t0 is not None:
            with mk.lock:
                for m in range((t0 // 60000) * 60, (t1 // 60000) * 60 + 60, 60):
                    mk.incomplete.add(m)
        mk.backfills.append(rec)
        log.info("orderbook %s: recupero trade %d..%d -> %d (%s)", mk.name, a0, a1, got, "ok" if rec["ok"] else "incompleto")

    # ------------------------------------------------------------ sampler
    async def _sampler(self) -> None:
        last_prune = 0.0
        while True:
            now = time.time()
            await asyncio.sleep(SAMPLE_S - (now % SAMPLE_S) + 0.002)
            t = float(int(time.time()))
            for mk in self.markets.values():
                try:
                    sec = mk.take_second()
                    s = bucketize(mk.book, t, RANGE_PCT)
                    if s is not None:
                        mk.add_sample(s, sec)
                        if t - last_prune >= 60:
                            mk.book.prune(s.mid * (1 - PRUNE_PCT / 100), s.mid * (1 + PRUNE_PCT / 100))
                except Exception as e:  # noqa: BLE001
                    log.warning("orderbook %s campionamento: %s", mk.name, e)
            if t - last_prune >= 60:
                last_prune = t

    # ------------------------------------------------------------ verifica volumi vs kline 1m ufficiali
    async def _kline_check(self, mk: Market) -> None:
        await asyncio.sleep(90)
        while True:
            try:
                r = await self._http.get(mk.cfg["klines"], params={"symbol": "BTCUSDT", "interval": "1m", "limit": 90})
                r.raise_for_status()
                now_min = int(time.time() // 60) * 60
                for k in r.json():
                    m = int(k[0]) // 1000
                    if m >= now_min - 60:     # minuto non ancora chiuso (o appena chiuso: recuperi in corso)
                        continue
                    with mk.lock:
                        ours = mk.fk.get(m)
                        ok = ours is not None and m not in mk.incomplete and mk.first_trade_min is not None and m > mk.first_trade_min
                        if not ok:
                            continue
                        vol, vbuy = ours[4] + ours[5], ours[4]
                        n_ours = ours[6]
                    off_vol, off_buy, off_n = float(k[5]), float(k[9]), int(k[8])
                    mk.kline_checks[m] = {
                        "t": m, "ours": round(vol, 4), "official": off_vol, "diff_pct": (vol / off_vol - 1) * 100 if off_vol else None,
                        "buy_diff_pct": (vbuy / off_buy - 1) * 100 if off_buy else None, "trades_official": off_n, "agg_trades": n_ours,
                    }
                cut = time.time() - 86400
                for m in [m for m in mk.kline_checks if m < cut]:
                    del mk.kline_checks[m]
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("orderbook %s verifica kline: %s", mk.name, e)
            await asyncio.sleep(KLINE_CHECK_S)

    # ------------------------------------------------------------ CPU
    async def _cpu_meter(self) -> None:
        last_w, last_c, last_f = time.perf_counter(), time.thread_time(), self._cpu_flush_s
        while True:
            await asyncio.sleep(30)
            w, c, f = time.perf_counter(), time.thread_time(), self._cpu_flush_s
            dw = max(w - last_w, 1e-6)
            self.cpu = {"collector_pct": round((c - last_c) / dw * 100, 2), "flush_pct": round((f - last_f) / dw * 100, 2),
                        "window_s": round(dw)}
            last_w, last_c, last_f = w, c, f

    # ------------------------------------------------------------ persistence
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
                log.warning("orderbook flush fallito: %s", e)

    def flush(self) -> None:
        c0 = time.thread_time()
        for mk in self.markets.values():
            t0 = time.perf_counter()
            try:
                self._flush_market(mk)
            except Exception as e:  # noqa: BLE001
                log.warning("orderbook %s flush: %s", mk.name, e)
            mk.flush_ms.append((time.perf_counter() - t0) * 1000)
            self._session_touch(mk)
        try:
            store.write_text(ROOT / "meta.json", json.dumps(self.meta))
        except Exception as e:  # noqa: BLE001
            log.warning("orderbook meta non salvata: %s", e)
        self._cpu_flush_s += time.thread_time() - c0

    def _flush_market(self, mk: Market) -> None:
        with mk.lock:
            hours, mk.dirty_hours = mk.dirty_hours, set()
            days, mk.dirty_days = mk.dirty_days, set()
            samples = list(mk.samples)
        # campioni 1 s per ora
        for h in sorted(hours):
            rows = [(s.t, s.lo_idx, s.arr, mk.sample_meta(s)) for s in samples if _hour(s.t) == h]
            if not rows:
                continue
            path = mk.dir / f"hs_{h}.parquet"
            if h not in mk.hour_prefix:     # campioni della stessa ora scritti prima di un riavvio
                seg = read_segment(path) if path.exists() else None
                pre: list = []
                if seg is not None:
                    t, lo, M, meta = seg
                    for i in range(len(t)):
                        if t[i] < rows[0][0]:
                            pre.append((float(t[i]), lo, M[i], {c: (None if np.isnan(v[i]) else float(v[i])) for c, v in meta.items()}))
                mk.hour_prefix[h] = pre
            long_df, meta_df = encode_hs(samples_to_df(mk.hour_prefix[h] + rows))
            store.write_parquet(meta_df, mk.dir / f"hsm_{h}.parquet")
            store.write_parquet(long_df, path)
        for h in list(mk.hour_prefix):
            if h not in hours and h < _hour(time.time() - 7200):
                del mk.hour_prefix[h]
        # file giornalieri
        for d in sorted(days):
            with mk.lock:
                hm = [r for r in mk.hm_rows if _day(r[0]) == d]
                fp_rows = [(m, p, c[0], c[1]) for m, lv in mk.fp.items() if _day(m) == d for p, c in lv.items()]
                fk_rows = [(m, *v[:9], m not in mk.incomplete) for m, v in mk.fk.items() if _day(m) == d]
                ev = [e for e in mk.events if _day(e["t"]) == d]
            if hm:
                store.write_parquet(samples_to_df(hm, extra=["n"]), mk.dir / f"hm_{d}.parquet")
            if fp_rows:
                df = pd.DataFrame(fp_rows, columns=["t", "p", "buy", "sell"]).sort_values(["t", "p"])
                df = df.astype({"t": "int64", "p": "float32", "buy": "float32", "sell": "float32"})
                store.write_parquet(df, mk.dir / f"fp_{d}.parquet")
            if fk_rows:
                df = pd.DataFrame(fk_rows, columns=["t", "o", "h", "l", "c", "buy", "sell", "n", "a0", "a1", "ok"]).sort_values("t")
                store.write_parquet(df, mk.dir / f"fk_{d}.parquet")
            if ev:
                store.write_parquet(pd.DataFrame(ev), mk.dir / f"ev_{d}.parquet")
        # memoria: oltre ieri si legge dai file
        cutoff = (int(time.time() // 86400) - 1) * 86400
        with mk.lock:
            for m in [m for m in mk.fp if m < cutoff]:
                del mk.fp[m]
            for m in [m for m in mk.fk if m < cutoff]:
                del mk.fk[m]
            mk.hm_rows = [r for r in mk.hm_rows if r[0] >= cutoff]
            mk.events = [e for e in mk.events if e["t"] >= cutoff]
            mk.incomplete = {m for m in mk.incomplete if m >= cutoff - 86400}

    def retention(self) -> None:
        now = time.time()
        for mk in self.markets.values():
            for f in mk.dir.glob("*.parquet"):
                try:
                    kind, stamp = f.stem.split("_", 1)
                    day = stamp[:8]
                    age_days = (now - calendar.timegm(time.strptime(day, "%Y%m%d"))) / 86400
                    keep = HS_DAYS if kind in ("hs", "hsm") else HM_DAYS if kind == "hm" else FP_DAYS
                    if age_days > keep + 1:
                        f.unlink()
                        log.info("orderbook retention: rimosso %s", f.name)
                except Exception:  # noqa: BLE001
                    continue

    def _load_recent(self, mk: Market) -> None:
        """All'avvio ricarica oggi e ieri (footprint, candele, medie al minuto, eventi) per non perderli alla riscrittura."""
        now = time.time()
        for d in (_day(now - 86400), _day(now)):
            p = mk.dir / f"fp_{d}.parquet"
            if p.exists():
                for t, pr, b, s in pd.read_parquet(p).itertuples(index=False):
                    mk.fp.setdefault(int(t), {})[float(pr)] = [float(b), float(s)]
            p = mk.dir / f"fk_{d}.parquet"
            if p.exists():
                for r in pd.read_parquet(p).itertuples(index=False):
                    m = int(r.t)
                    mk.fk[m] = [r.o, r.h, r.l, r.c, r.buy, r.sell, int(r.n), int(r.a0), int(r.a1), m * 1000, m * 1000 + 59999]
                    if not r.ok:
                        mk.incomplete.add(m)
            p = mk.dir / f"hm_{d}.parquet"
            if p.exists():
                seg = read_segment(p)
                if seg is not None:
                    t, lo, M, meta = seg
                    for i in range(len(t)):
                        row = M[i]
                        mk.hm_rows.append((float(t[i]), lo, row, {c: (None if np.isnan(meta[c][i]) else float(meta[c][i])) for c in meta}))
            p = mk.dir / f"ev_{d}.parquet"
            if p.exists():
                mk.events.extend(pd.read_parquet(p).to_dict("records"))
        # riavvio ravvicinato (< 15 min): riparto dall'ultimo id aggregato salvato, così il primo trade live fa recuperare via
        # REST quelli persi tra spegnimento e riaccensione (se il recupero fallisce i minuti sono marcati incompleti)
        if mk.fk:
            m_last = max(mk.fk)
            if now - m_last < 900:
                k = mk.fk[m_last]
                mk.last_a, mk.last_a_T = int(k[8]), int(k[10])
                mk.first_trade_min = min(mk.fk)
            else:   # i trade dopo l'ultimo flush dell'ultimo minuto salvato non sono più recuperabili in modo affidabile
                mk.incomplete.add(m_last)

    # ------------------------------------------------------------ meta / sessioni
    def _load_meta(self) -> None:
        p = ROOT / "meta.json"
        try:
            if p.exists():
                self.meta = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            log.warning("orderbook meta illeggibile: %s", e)
            self.meta = {}

    def _session_open(self, mk: Market) -> None:
        m = self.meta.setdefault(mk.name, {"first_start": time.time(), "sessions": []})
        ses = m.setdefault("sessions", [])
        now = time.time()
        if not ses or ses[-1][1] < now - 120:
            ses.append([now, now])
        m["sessions"] = ses[-200:]

    def _session_touch(self, mk: Market) -> None:
        m = self.meta.get(mk.name)
        if m and m.get("sessions") and mk.book.synced:
            m["sessions"][-1][1] = time.time()


# ============================================================================ lettura parquet

def read_segment(path: Path, columns_price: tuple[float, float] | None = None, tmin: float | None = None,
                 tmax: float | None = None) -> tuple[np.ndarray, int, np.ndarray, dict] | None:
    """File hs (+hsm) o hm -> (t, lo_idx, M[n × m] float32 con NaN, meta{col: array}). Proiezione opzionale sul range di prezzo."""
    try:
        if path.name.startswith("hs_"):
            mpath = path.with_name("hsm_" + path.name[3:])
            mdf = pd.read_parquet(mpath)
            ldf = pd.read_parquet(path)
            lo, M = decode_hs(ldf, len(mdf), *(columns_price or (None, None)))
            df = mdf
            metas = [c for c in META_COLS if c in df.columns]
        else:
            import pyarrow.parquet as pq
            schema = pq.read_schema(path)
            pcols = df_price_cols(schema.names)
            if columns_price is not None:
                plo, phi = columns_price
                pcols = [(p, c) for p, c in pcols if plo - BASE_BUCKET <= p <= phi]
            metas = [c for c in META_COLS + ["n"] if c in schema.names]
            df = pd.read_parquet(path, columns=["t"] + metas + [c for _, c in pcols])
            if pcols:
                lo = int(round(pcols[0][0] / BASE_BUCKET))
                hi = int(round(pcols[-1][0] / BASE_BUCKET)) + 1
                M = np.full((len(df), hi - lo), np.nan, np.float32)
                for p, c in pcols:
                    M[:, int(round(p / BASE_BUCKET)) - lo] = df[c].to_numpy(np.float32)
            else:
                lo, M = 0, np.zeros((len(df), 0), np.float32)
    except Exception as e:  # noqa: BLE001
        log.warning("orderbook: lettura %s fallita: %s", path.name, e)
        return None
    keep = np.ones(len(df), bool)
    if tmin is not None:
        keep &= df["t"].to_numpy() >= tmin
    if tmax is not None:
        keep &= df["t"].to_numpy() < tmax
    if not keep.any():
        return None
    t = df["t"].to_numpy(np.float64)[keep]
    meta = {c: df[c].to_numpy(np.float64)[keep] for c in metas}
    return t, lo, M[keep], meta


collector = Collector()


def start() -> None:
    try:
        collector.start()
    except Exception as e:  # noqa: BLE001
        log.warning("collector order book non avviato: %s", e)
