"""Logica pura del Terminale (nessuna rete): normalizzazione dei trade multi-exchange, aggregazione al minuto, CVD a candele.

Stream (chiave -> exchange, mercato):
  binance_perp  Binance USDⓈ-M BTCUSDT  aggTrade      lato aggressore = not m (m = vero: compratore maker -> vendita aggressiva)
  bybit_perp    Bybit linear BTCUSDT     publicTrade   S = lato del taker ("Buy"/"Sell"), v in BTC
  okx_perp      OKX BTC-USDT-SWAP        trades-all    side = lato del taker, sz in CONTRATTI × ctVal (0.01 BTC, verificato da /public/instruments)
  binance_spot  Binance BTCUSDT          aggTrade
  coinbase_spot Coinbase BTC-USD         matches       side = lato del MAKER (doc ufficiale) -> aggressore = lato opposto
  bybit_spot    Bybit spot BTCUSDT       publicTrade
  okx_spot      OKX BTC-USDT             trades-all    sz in BTC
Un trade normalizzato è la tupla (ts_ms, prezzo, qty_btc, buy_aggressore, id).
"""
from __future__ import annotations

from collections import deque
from typing import Iterable

STREAMS: dict[str, dict] = {
    "binance_perp": {"ex": "binance", "mkt": "perp", "label": "Binance USDⓈ-M BTCUSDT"},
    "bybit_perp": {"ex": "bybit", "mkt": "perp", "label": "Bybit BTCUSDT perp"},
    "okx_perp": {"ex": "okx", "mkt": "perp", "label": "OKX BTC-USDT-SWAP"},
    "binance_spot": {"ex": "binance", "mkt": "spot", "label": "Binance BTCUSDT spot"},
    "coinbase_spot": {"ex": "coinbase", "mkt": "spot", "label": "Coinbase BTC-USD"},
    "bybit_spot": {"ex": "bybit", "mkt": "spot", "label": "Bybit BTCUSDT spot"},
    "okx_spot": {"ex": "okx", "mkt": "spot", "label": "OKX BTC-USDT spot"},
}
GROUPS = {"spot": [k for k, v in STREAMS.items() if v["mkt"] == "spot"],
          "perp": [k for k, v in STREAMS.items() if v["mkt"] == "perp"]}
GROUPS["all"] = GROUPS["perp"] + GROUPS["spot"]
OKX_INST = {"BTC-USDT-SWAP": "okx_perp", "BTC-USDT": "okx_spot"}
OKX_CT_VAL_DEFAULT = 0.01          # BTC per contratto BTC-USDT-SWAP (riletto all'avvio da /public/instruments)
LARGE_USD = 100_000.0              # grande trade (come FlowX "Large ≥ $100K")

# colonne della barra 1m per stream
BAR_COLS = ["vb", "vs", "qb", "qs", "nb", "ns", "lvb", "lvs", "lnb", "lns", "o", "h", "l", "c"]
I_VB, I_VS, I_QB, I_QS, I_NB, I_NS, I_LVB, I_LVS, I_LNB, I_LNS, I_O, I_H, I_L, I_C = range(14)


def _f(x) -> float:
    return float(x)


# ============================================================================ parser per exchange

def parse_binance(d: dict) -> tuple | None:
    """Evento aggTrade (spot o futures) -> trade. Id = `a` (id aggregato, continuo: i buchi si recuperano via REST)."""
    if d.get("e") != "aggTrade":
        return None
    p, q = _f(d["p"]), _f(d["q"])
    if p <= 0 or q <= 0:
        return None
    return (int(d["T"]), p, q, not bool(d["m"]), int(d["a"]))


def parse_bybit(msg: dict) -> list[tuple]:
    """Messaggio publicTrade (linear o spot) -> trade. `S` è il lato del taker; `v` in BTC per BTCUSDT."""
    if not str(msg.get("topic", "")).startswith("publicTrade."):
        return []
    out = []
    for x in msg.get("data") or []:
        p, q = _f(x["p"]), _f(x["v"])
        if p <= 0 or q <= 0:
            continue
        out.append((int(x["T"]), p, q, x.get("S") == "Buy", str(x["i"])))
    return out


def parse_okx(msg: dict, ct_val: float = OKX_CT_VAL_DEFAULT) -> list[tuple[str, tuple]]:
    """Messaggio trades-all -> [(stream, trade)]. SWAP: sz in contratti -> BTC = sz × ctVal; spot: sz già in BTC."""
    arg = msg.get("arg") or {}
    if arg.get("channel") not in ("trades-all", "trades"):
        return []
    out = []
    for x in msg.get("data") or []:
        inst = x.get("instId") or arg.get("instId")
        key = OKX_INST.get(inst)
        if key is None:
            continue
        p, sz = _f(x["px"]), _f(x["sz"])
        q = sz * ct_val if key == "okx_perp" else sz
        if p <= 0 or q <= 0:
            continue
        out.append((key, (int(x["ts"]), p, q, x.get("side") == "buy", int(x["tradeId"]))))
    return out


def iso_ms(s: str) -> int:
    """'2026-10-16T23:06:11.618497Z' -> ms UTC (senza dipendenze esterne)."""
    import calendar
    import time as _t
    main, _, frac = s.rstrip("Z").partition(".")
    sec = calendar.timegm(_t.strptime(main, "%Y-%m-%dT%H:%M:%S"))
    ms = int((frac + "000")[:3]) if frac else 0
    return sec * 1000 + ms


def parse_coinbase(msg: dict) -> tuple | None:
    """Messaggio `match` -> trade. `side` = lato del maker: maker "sell" -> il taker compra (up-tick)."""
    if msg.get("type") != "match" or msg.get("product_id") != "BTC-USD":
        return None
    p, q = _f(msg["price"]), _f(msg["size"])
    if p <= 0 or q <= 0:
        return None
    return (iso_ms(msg["time"]), p, q, msg.get("side") == "sell", int(msg["trade_id"]))


def parse_coinbase_rest(x: dict) -> tuple:
    """Riga di GET /products/BTC-USD/trades (stessa semantica di `side`: lato del maker)."""
    return (iso_ms(x["time"]), _f(x["price"]), _f(x["size"]), x.get("side") == "sell", int(x["trade_id"]))


# ============================================================================ deduplica

class Seen:
    """Ultimi N id visti per stream (insieme + coda): un trade ricevuto due volte (riconnessione, recupero REST) conta una volta."""

    def __init__(self, n: int = 200_000):
        self.n = n
        self.q: deque = deque()
        self.s: set = set()

    def add(self, k) -> bool:
        if k in self.s:
            return False
        self.s.add(k)
        self.q.append(k)
        if len(self.q) > self.n:
            self.s.discard(self.q.popleft())
        return True

    def __contains__(self, k) -> bool:
        return k in self.s

    def __len__(self) -> int:
        return len(self.q)


# ============================================================================ aggregazione al minuto

def new_bar(p: float) -> list[float]:
    return [0.0] * 10 + [p, p, p, p]


class MinuteAgg:
    """Barre 1m per stream + delta di gruppo (spot/perp/all) con massimo/minimo del delta cumulato DENTRO il minuto
    (servono per le candele del CVD: alto = CVD a inizio minuto + massimo intra-minuto). Nessun lock: lo usa un solo thread."""

    def __init__(self, large_usd: float = LARGE_USD):
        self.large = large_usd
        self.bars: dict[str, dict[int, list[float]]] = {k: {} for k in STREAMS}
        self.tlast: dict[str, dict[int, int]] = {k: {} for k in STREAMS}    # ms dell'ultimo trade del minuto (per la chiusura)
        self.tfirst: dict[str, dict[int, int]] = {k: {} for k in STREAMS}
        self.grp: dict[str, dict[int, list[float]]] = {g: {} for g in GROUPS}   # minuto -> [d, dmax, dmin]
        self.seen: dict[str, Seen] = {k: Seen() for k in STREAMS}

    def add(self, stream: str, tr: tuple, live: bool = True) -> bool:
        """Aggiunge un trade; False se già contato (stesso id). `live=False` (recupero REST) non tocca gli estremi intra-minuto."""
        ts, p, q, buy, tid = tr
        if not self.seen[stream].add(tid):
            return False
        m = (ts // 60000) * 60
        b = self.bars[stream].get(m)
        if b is None:
            b = self.bars[stream][m] = new_bar(p)
            self.tfirst[stream][m] = ts
            self.tlast[stream][m] = ts
        usd = p * q
        big = usd >= self.large
        if buy:
            b[I_VB] += q; b[I_QB] += usd; b[I_NB] += 1
            if big:
                b[I_LVB] += q; b[I_LNB] += 1
        else:
            b[I_VS] += q; b[I_QS] += usd; b[I_NS] += 1
            if big:
                b[I_LVS] += q; b[I_LNS] += 1
        if p > b[I_H]:
            b[I_H] = p
        if p < b[I_L]:
            b[I_L] = p
        if ts >= self.tlast[stream][m]:
            b[I_C] = p
            self.tlast[stream][m] = ts
        if ts < self.tfirst[stream][m]:
            b[I_O] = p
            self.tfirst[stream][m] = ts
        sd = q if buy else -q
        mkt = STREAMS[stream]["mkt"]
        for g in (mkt, "all"):
            r = self.grp[g].get(m)
            if r is None:
                r = self.grp[g][m] = [0.0, 0.0, 0.0]
            r[0] += sd
            if live:
                if r[0] > r[1]:
                    r[1] = r[0]
                if r[0] < r[2]:
                    r[2] = r[0]
            else:   # recupero: gli estremi restano almeno compatibili con il delta finale
                r[1] = max(r[1], r[0])
                r[2] = min(r[2], r[0])
        return True

    def prune(self, before: int) -> None:
        for k in STREAMS:
            for d in (self.bars[k], self.tlast[k], self.tfirst[k]):
                for m in [m for m in d if m < before]:
                    del d[m]
        for g in GROUPS:
            for m in [m for m in self.grp[g] if m < before]:
                del self.grp[g][m]


# ============================================================================ CVD a candele

def cvd_candles(minutes: Iterable[tuple[int, float, float, float]], tf_s: int, start: float = 0.0) -> list[tuple]:
    """[(t_minuto, d, dmax, dmin)] ordinati -> [(t_barra, o, h, l, c)] del CVD cumulato (in coin) partendo da `start`.
    dmax/dmin = estremi del delta cumulato dentro il minuto (relativi all'inizio del minuto); sono forzati a includere 0 e d."""
    out: list[list] = []
    C = start
    cur = None
    for t, d, dmax, dmin in minutes:
        bt = (int(t) // tf_s) * tf_s
        hi = C + max(dmax, d, 0.0)
        lo = C + min(dmin, d, 0.0)
        if cur is None or cur[0] != bt:
            if cur is not None:
                out.append(tuple(cur))
            cur = [bt, C, hi, lo, C + d]
        else:
            cur[2] = max(cur[2], hi)
            cur[3] = min(cur[3], lo)
            cur[4] = C + d
        C += d
    if cur is not None:
        out.append(tuple(cur))
    return out


def bar_delta_stats(minutes: Iterable[tuple[int, float, float, float]]) -> tuple[float, float, float]:
    """Delta di una barra in formazione relativo alla sua apertura: (d, dmax, dmin)."""
    R, hi, lo = 0.0, 0.0, 0.0
    for _, d, dmax, dmin in minutes:
        hi = max(hi, R + max(dmax, d, 0.0))
        lo = min(lo, R + min(dmin, d, 0.0))
        R += d
    return R, hi, lo


def ohlc(values: list[tuple[float, float]], tf_s: int) -> list[tuple]:
    """Campioni [(t, v)] ordinati -> candele [(t_barra, o, h, l, c)] (OI in coin)."""
    out: list[list] = []
    for t, v in values:
        bt = (int(t) // tf_s) * tf_s
        if out and out[-1][0] == bt:
            c = out[-1]
            c[2] = max(c[2], v); c[3] = min(c[3], v); c[4] = v
        else:
            out.append([bt, v, v, v, v])
    return [tuple(c) for c in out]


def flow_window(secs: dict[int, dict[str, list[float]]], now_s: int, window_s: int) -> dict:
    """Order flow aggregato sugli ultimi `window_s` secondi da bucket al secondo {sec: {stream: [vb, vs, qb, qs, nb, ns, lnb, lns]}}."""
    vb = vs = qb = qs = nb = ns = lnb = lns = 0.0
    exs: set[str] = set()
    by_mkt = {"perp": [0.0, 0.0], "spot": [0.0, 0.0]}
    for s in range(now_s - window_s + 1, now_s + 1):
        row = secs.get(s)
        if not row:
            continue
        for k, a in row.items():
            vb += a[0]; vs += a[1]; qb += a[2]; qs += a[3]; nb += a[4]; ns += a[5]; lnb += a[6]; lns += a[7]
            if a[4] + a[5] > 0:
                exs.add(STREAMS[k]["ex"])
            mk = by_mkt[STREAMS[k]["mkt"]]
            mk[0] += a[2]; mk[1] += a[3]
    n = nb + ns
    tot = qb + qs
    return {"buy_usd": qb, "sell_usd": qs, "buy_btc": vb, "sell_btc": vs, "delta_usd": qb - qs, "delta_btc": vb - vs,
            "buy_share": qb / tot if tot > 0 else None, "n_buy": int(nb), "n_sell": int(ns),
            "avg_buy_usd": qb / nb if nb else None, "avg_sell_usd": qs / ns if ns else None, "avg_usd": tot / n if n else None,
            "large_buy": int(lnb), "large_sell": int(lns), "exchanges": len(exs),
            "perp_delta_usd": by_mkt["perp"][0] - by_mkt["perp"][1], "spot_delta_usd": by_mkt["spot"][0] - by_mkt["spot"][1],
            "perp_usd": by_mkt["perp"][0] + by_mkt["perp"][1], "spot_usd": by_mkt["spot"][0] + by_mkt["spot"][1]}


def aggregate_book(levels: Iterable[tuple[float, float]], step: float, bid: bool, n: int) -> list[list[float]]:
    """Livelli (prezzo, qty) -> raggruppati per `step` (bid: arrotondati per difetto, ask: per eccesso), i primi n dal best."""
    import math
    agg: dict[float, float] = {}
    for p, q in levels:
        k = math.floor(p / step + 1e-9) * step if bid else math.ceil(p / step - 1e-9) * step
        k = round(k, 2)
        agg[k] = agg.get(k, 0.0) + q
    keys = sorted(agg, reverse=bid)[:n]
    return [[k, round(agg[k], 4)] for k in keys]
