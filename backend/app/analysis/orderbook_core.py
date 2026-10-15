"""Order book e footprint: logica pura (senza rete né disco), testata in backend/tests/test_orderbook.py.

Contiene:
  - LocalBook: book locale Binance (snapshot REST + diff stream) secondo la procedura ufficiale
      futures USDⓈ-M: scarta gli eventi con u < lastUpdateId; il primo evento deve avere U <= lastUpdateId <= u;
                      ogni evento successivo deve avere pu == u dell'evento precedente, altrimenti risincronizza.
      spot:           scarta gli eventi con u <= lastUpdateId; il primo evento deve avere U <= lastUpdateId+1 <= u;
                      ogni evento successivo deve avere U == u precedente + 1, altrimenti risincronizza.
    Le quantità sono assolute (non delta): quantità 0 = livello rimosso.
  - compare_books: verifica incrociata tra due book allo stesso update id (atteso: 0 differenze).
  - bucketize: liquidità del book aggregata in bucket di prezzo fissi (base $10) entro ±R% dal mid.
  - WallTracker: muri di liquidità (soglia statistica k × mediana dei bucket entro ±1%), comparsa, consumo,
    "liquidità ritirata prima del tocco" (il muro sparisce mentre il prezzo è vicino ma senza scambi a quel livello).
  - footprint: aggregazione dei trade aggressivi per candela e bin di prezzo, POC, delta, imbalance diagonali.
  - heatmap: ricampionamento tempo × prezzo e codifica compatta (uint16 base64).
"""
from __future__ import annotations

import base64
import math
from collections import deque
from dataclasses import dataclass, field

import numpy as np

BASE_BUCKET = 10.0      # $ — risoluzione di campionamento della heatmap (ri-aggregabile a 20/50/100/250)
FP_BASE_BIN = 5.0       # $ — risoluzione dei bin del footprint (ri-aggregabile a 10/25/50/100)


# ============================================================================ local order book

def parse_depth(d: dict) -> dict:
    """Evento depthUpdate Binance -> {U, u, pu, E, b: [(p, q)], a: [(p, q)]} (prezzi/quantità float)."""
    return {
        "U": int(d["U"]), "u": int(d["u"]), "pu": int(d["pu"]) if d.get("pu") is not None else None,
        "E": int(d.get("E") or 0),
        "b": [(float(p), float(q)) for p, q in d.get("b", ())],
        "a": [(float(p), float(q)) for p, q in d.get("a", ())],
    }


class LocalBook:
    """Book locale sincronizzato con snapshot + diff stream. Stato: synced / buffering / pending snapshot."""

    def __init__(self, kind: str = "futures", max_buffer: int = 3000):
        assert kind in ("futures", "spot")
        self.kind = kind
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.last_u: int | None = None
        self.synced = False
        self.buffer: deque[dict] = deque(maxlen=max_buffer)
        self.pending: tuple[int, list, list] | None = None
        self.snap_lo: float | None = None   # unione degli intervalli di prezzo coperti dagli snapshot dall'ultima sincronizzazione
        self.snap_hi: float | None = None
        self.last_snapshot_id: int | None = None
        self.gaps = 0
        self.applied = 0

    # -- helpers
    def _first_ok(self, ev: dict, L: int) -> bool:
        if self.kind == "futures":
            return ev["U"] <= L <= ev["u"]
        return ev["U"] <= L + 1 <= ev["u"]

    def _stale(self, ev: dict, L: int) -> bool:
        return ev["u"] < L if self.kind == "futures" else ev["u"] <= L

    def _continuous(self, ev: dict) -> bool:
        if self.kind == "futures":
            return ev["pu"] == self.last_u
        return ev["U"] == (self.last_u or 0) + 1

    def _apply(self, ev: dict) -> None:
        bids, asks = self.bids, self.asks
        for p, q in ev["b"]:
            if q == 0:
                bids.pop(p, None)   # rimuovere un livello assente è normale
            else:
                bids[p] = q
        for p, q in ev["a"]:
            if q == 0:
                asks.pop(p, None)
            else:
                asks[p] = q
        self.last_u = ev["u"]
        self.applied += 1

    def _lose_sync(self, ev: dict | None) -> None:
        self.synced = False
        self.gaps += 1
        self.bids.clear()
        self.asks.clear()
        self.last_u = None
        self.snap_lo = self.snap_hi = None
        self.buffer.clear()
        if ev is not None:
            self.buffer.append(ev)

    def reset(self) -> None:
        self.synced = False
        self.bids.clear()
        self.asks.clear()
        self.last_u = None
        self.pending = None
        self.snap_lo = self.snap_hi = None
        self.buffer.clear()

    # -- API
    def on_event(self, ev: dict) -> str:
        """'applied' | 'old' | 'gap' (sincronizzazione persa: serve un nuovo snapshot) | 'buffered' | 'waiting' | 'synced' | 'stale'."""
        if self.synced:
            if self.kind == "spot" and self.last_u is not None and ev["u"] <= self.last_u:
                return "old"
            if not self._continuous(ev):
                self._lose_sync(ev)
                return "gap"
            self._apply(ev)
            return "applied"
        self.buffer.append(ev)
        if self.pending is not None:
            return self._try_sync()
        return "buffered"

    def load_snapshot(self, last_id: int, bids: list, asks: list) -> str:
        """Snapshot REST (lastUpdateId, [(p, q)], [(p, q)]). 'synced' | 'waiting' (servono eventi più recenti) | 'stale' | 'gap'."""
        self.pending = (int(last_id), bids, asks)
        return self._try_sync()

    def _try_sync(self) -> str:
        assert self.pending is not None
        L, bids, asks = self.pending
        while self.buffer and self._stale(self.buffer[0], L):
            self.buffer.popleft()
        if not self.buffer:
            return "waiting"
        first = self.buffer[0]
        if not self._first_ok(first, L):
            # lo snapshot è più vecchio del primo evento disponibile: ne serve uno nuovo
            self.pending = None
            return "stale"
        self.bids = {float(p): float(q) for p, q in bids if float(q) > 0}
        self.asks = {float(p): float(q) for p, q in asks if float(q) > 0}
        self.last_u = None
        events = list(self.buffer)
        self.buffer.clear()
        self.pending = None
        self._apply(events[0])
        for i, ev in enumerate(events[1:], start=1):
            if self.kind == "spot" and ev["u"] <= (self.last_u or 0):
                continue
            if not self._continuous(ev):
                self.synced = False
                self.gaps += 1
                self.bids.clear()
                self.asks.clear()
                self.last_u = None
                self.buffer.extend(events[i:])
                return "gap"
            self._apply(ev)
        self.synced = True
        self.last_snapshot_id = L
        if bids and asks:
            lo = min(float(p) for p, _ in bids)
            hi = max(float(p) for p, _ in asks)
            self.snap_lo = lo if self.snap_lo is None else min(self.snap_lo, lo)
            self.snap_hi = hi if self.snap_hi is None else max(self.snap_hi, hi)
        return "synced"

    def best(self) -> tuple[float | None, float | None]:
        return (max(self.bids) if self.bids else None, min(self.asks) if self.asks else None)

    def prune(self, lo: float, hi: float) -> int:
        """Elimina i livelli fuori da [lo, hi] (memoria limitata) e restringe di conseguenza l'intervallo affidabile."""
        n = 0
        for d in (self.bids, self.asks):
            out = [p for p in d if p < lo or p > hi]
            for p in out:
                del d[p]
            n += len(out)
        if self.snap_lo is not None:
            self.snap_lo = max(self.snap_lo, lo)
            self.snap_hi = min(self.snap_hi, hi)
        return n

    def overwrite_range(self, other: "LocalBook", lo: float, hi: float) -> None:
        """Copia nel book i livelli di `other` (stesso update id) entro [lo, hi] — autoriparazione dopo una verifica."""
        for mine, theirs in ((self.bids, other.bids), (self.asks, other.asks)):
            for p in [p for p in mine if lo <= p <= hi]:
                del mine[p]
            for p, q in theirs.items():
                if lo <= p <= hi:
                    mine[p] = q
        self.snap_lo = lo if self.snap_lo is None else min(self.snap_lo, lo)
        self.snap_hi = hi if self.snap_hi is None else max(self.snap_hi, hi)


def compare_books(a: LocalBook, b: LocalBook, lo: float, hi: float, topn: int = 20) -> dict:
    """Confronto di due book allo stesso update id: best bid/ask, primi N livelli per lato, tutti i livelli in [lo, hi]."""
    def top(d: dict, rev: bool) -> list[tuple[float, float]]:
        return sorted(d.items(), reverse=rev)[:topn]

    tb_a, tb_b = top(a.bids, True), top(b.bids, True)
    ta_a, ta_b = top(a.asks, False), top(b.asks, False)
    top_mismatch = sum(1 for x, y in zip(tb_a, tb_b) if x != y) + sum(1 for x, y in zip(ta_a, ta_b) if x != y)
    top_mismatch += abs(len(tb_a) - len(tb_b)) + abs(len(ta_a) - len(ta_b))
    range_mismatch = 0
    compared = 0
    for da, db in ((a.bids, b.bids), (a.asks, b.asks)):
        keys = {p for p in da if lo <= p <= hi} | {p for p in db if lo <= p <= hi}
        compared += len(keys)
        range_mismatch += sum(1 for p in keys if da.get(p) != db.get(p))
    bb_a, ba_a = a.best()
    bb_b, ba_b = b.best()
    return {
        "best_bid": bb_a, "best_ask": ba_a, "ref_best_bid": bb_b, "ref_best_ask": ba_b,
        "best_match": bb_a == bb_b and ba_a == ba_b,
        "top_levels": len(tb_b) + len(ta_b), "top_mismatch": top_mismatch,
        "range_levels": compared, "range_mismatch": range_mismatch,
        "update_id_a": a.last_u, "update_id_b": b.last_u,
    }


# ============================================================================ bucketing

def book_arrays(d: dict) -> tuple[np.ndarray, np.ndarray]:
    n = len(d)
    return np.fromiter(d.keys(), np.float64, n), np.fromiter(d.values(), np.float64, n)


@dataclass
class BookSample:
    """Campione del book in bucket di prezzo: arr[i] = liquidità (BTC) nel bucket [(lo_idx+i)·base, (lo_idx+i+1)·base)."""
    t: float
    lo_idx: int
    arr: np.ndarray
    mid: float
    bb: float
    ba: float
    bd05: float = 0.0   # BTC in bid entro 0,5% dal mid
    ad05: float = 0.0
    bd1: float = 0.0    # BTC in bid entro 1% dal mid
    ad1: float = 0.0
    tlo: float | None = None   # intervallo coperto dagli snapshot (affidabile); fuori = ricostruito dal solo diff stream
    thi: float | None = None
    extra: dict = field(default_factory=dict)


def bucketize(book: LocalBook, t: float, range_pct: float, base: float = BASE_BUCKET) -> BookSample | None:
    if not book.synced or not book.bids or not book.asks:
        return None
    bp, bq = book_arrays(book.bids)
    ap, aq = book_arrays(book.asks)
    bb, ba = float(bp.max()), float(ap.min())
    mid = (bb + ba) / 2
    lo, hi = mid * (1 - range_pct / 100), mid * (1 + range_pct / 100)
    lo_idx, hi_idx = int(math.floor(lo / base)), int(math.floor(hi / base))
    n = hi_idx - lo_idx + 1
    arr = np.zeros(n, np.float64)
    for prices, qty in ((bp, bq), (ap, aq)):
        m = (prices >= lo_idx * base) & (prices < (hi_idx + 1) * base)
        if m.any():
            idx = (np.floor(prices[m] / base).astype(np.int64) - lo_idx)
            arr += np.bincount(idx, weights=qty[m], minlength=n)[:n]
    b05 = bp >= mid * 0.995
    a05 = ap <= mid * 1.005
    b1 = bp >= mid * 0.99
    a1 = ap <= mid * 1.01
    return BookSample(t=t, lo_idx=lo_idx, arr=arr.astype(np.float32), mid=mid, bb=bb, ba=ba,
                      bd05=float(bq[b05].sum()), ad05=float(aq[a05].sum()), bd1=float(bq[b1].sum()), ad1=float(aq[a1].sum()),
                      tlo=book.snap_lo, thi=book.snap_hi)


# ============================================================================ walls / pulls

@dataclass
class _Wall:
    idx: int
    side: str
    first: float
    last: float
    qmax: float
    q: float
    announced: bool = False
    near_min_pct: float = 99.0   # distanza minima del prezzo dal muro durante la sua vita (%)


class WallTracker:
    """Muri di liquidità e loro destino.

    Soglia (dichiarata): un bucket da $10 è un "muro" se la sua liquidità è ≥ K × mediana dei bucket non vuoti entro ±1% dal mid
    e ≥ MIN_QTY BTC. Un muro è "confermato" dopo MIN_AGE secondi. Quando scende sotto DROP × il suo massimo:
      - 'consumed' se negli ultimi secondi si è scambiato a quel livello almeno metà della liquidità sparita o il prezzo lo ha raggiunto;
      - 'pulled' (liquidità ritirata prima del tocco) se nessuno dei due e il prezzo era entro NEAR_PCT;
      - altrimenti rimozione lontana dal prezzo (non segnalata).
    Nessuna accusa di spoofing: la liquidità visibile può essere ritirata per molti motivi legittimi.
    """

    def __init__(self, k: float = 5.0, min_qty: float = 1.0, min_age: float = 20.0, drop: float = 0.3,
                 near_pct: float = 0.15, window_pct: float = 1.0, base: float = BASE_BUCKET, trade_memory_s: int = 5):
        self.k, self.min_qty, self.min_age, self.drop = k, min_qty, min_age, drop
        self.near_pct, self.window_pct, self.base = near_pct, window_pct, base
        self.walls: dict[int, _Wall] = {}
        self.trades: deque[tuple[float, dict[int, float], float, float]] = deque(maxlen=trade_memory_s)
        self.threshold: float | None = None
        self.median: float | None = None

    def _recent_traded(self, idx: int) -> float:
        return sum(tr.get(idx, 0.0) for _, tr, _, _ in self.trades)

    def _touched(self, w: _Wall) -> bool:
        lo, hi = w.idx * self.base, (w.idx + 1) * self.base
        for _, _, tlo, thi in self.trades:
            if tlo is not None and thi is not None and tlo < hi and thi >= lo:
                return True
        return False

    def update(self, s: BookSample, traded: dict[int, float] | None = None, trade_lo: float | None = None,
               trade_hi: float | None = None) -> list[dict]:
        """`traded` = volume scambiato per bucket nell'ultimo secondo; trade_lo/hi = prezzo min/max dei trade dell'ultimo secondo."""
        self.trades.append((s.t, traded or {}, trade_lo, trade_hi))
        events: list[dict] = []
        n = len(s.arr)
        prices = (np.arange(n) + s.lo_idx) * self.base
        win = (prices + self.base > s.mid * (1 - self.window_pct / 100)) & (prices < s.mid * (1 + self.window_pct / 100))
        vals = s.arr[win]
        nz = vals[vals > 0]
        if len(nz) < 10:
            return events
        med = float(np.median(nz))
        thr = max(self.k * med, self.min_qty)
        self.median, self.threshold = med, thr
        cand = np.nonzero(win & (s.arr >= thr))[0]
        seen: set[int] = set()
        for i in cand:
            idx = int(i) + s.lo_idx
            q = float(s.arr[i])
            seen.add(idx)
            w = self.walls.get(idx)
            px = idx * self.base
            side = "bid" if px + self.base <= s.mid else "ask" if px >= s.mid else ("bid" if px < s.mid else "ask")
            if w is None:
                self.walls[idx] = _Wall(idx, side, s.t, s.t, q, q)
                continue
            w.last, w.q, w.qmax = s.t, q, max(w.qmax, q)
        for idx in list(self.walls):
            w = self.walls[idx]
            px = idx * self.base
            dist = 0.0 if px <= s.mid < px + self.base else min(abs(px - s.mid), abs(px + self.base - s.mid)) / s.mid * 100
            w.near_min_pct = min(w.near_min_pct, dist)
            i = idx - s.lo_idx
            q = float(s.arr[i]) if 0 <= i < n else None
            if q is None:                      # uscito dalla finestra campionata (prezzo lontano): smetto di seguirlo
                del self.walls[idx]
                continue
            if idx not in seen:
                w.q = q
            age = s.t - w.first
            if not w.announced and age >= self.min_age and q >= self.drop * w.qmax:
                w.announced = True
                events.append(self._ev(s, w, "appeared", q, dist))
            if q < self.drop * w.qmax:
                if w.announced:
                    gone = w.qmax - q
                    executed = self._recent_traded(idx)
                    if executed >= 0.5 * gone or self._touched(w) or dist == 0.0:
                        kind = "consumed"
                    elif dist <= self.near_pct:
                        kind = "pulled"
                    else:
                        kind = None
                    if kind:
                        ev = self._ev(s, w, kind, q, dist)
                        ev["executed"] = round(executed, 3)
                        events.append(ev)
                del self.walls[idx]
        return events

    def _ev(self, s: BookSample, w: _Wall, kind: str, q: float, dist: float) -> dict:
        return {"t": s.t, "kind": kind, "side": w.side, "price": w.idx * self.base, "qmax": round(w.qmax, 3), "q": round(q, 3),
                "age_s": round(s.t - w.first), "dist_pct": round(dist, 4), "mid": round(s.mid, 2),
                "k": self.k, "median": round(self.median or 0, 4)}

    def active(self, mid: float) -> list[dict]:
        out = []
        thr = self.threshold or 0.0
        for w in self.walls.values():
            if not w.announced or w.q < 0.8 * thr:   # mostrati solo se ancora vicini alla soglia (isteresi del tracciamento)
                continue
            px = w.idx * self.base
            out.append({"price": px, "side": w.side, "q": round(w.q, 3), "qmax": round(w.qmax, 3), "age_s": round(w.last - w.first),
                        "dist_pct": round((px + self.base / 2 - mid) / mid * 100, 3)})
        return sorted(out, key=lambda x: -x["q"])


# ============================================================================ footprint

def fp_bin(price: float, bin_size: float = FP_BASE_BIN) -> float:
    return math.floor(price / bin_size + 1e-9) * bin_size


def footprint_levels(levels: dict[float, list[float]] | dict[float, tuple[float, float]], bin_size: float,
                     ratio: float = 3.0, min_share: float = 0.01) -> dict:
    """Livelli di una candela {prezzo_bin: (buy, sell)} -> righe ordinate per prezzo con delta, POC e imbalance diagonali.

    Imbalance diagonale (convenzione standard dei footprint bid×ask):
      buy  al livello p ≥ ratio × sell al livello p − bin  -> imbalance in acquisto (1)
      sell al livello p ≥ ratio × buy  al livello p + bin  -> imbalance in vendita (2); entrambi -> 3
    Un lato opposto a 0 vale solo se il volume del lato dominante è ≥ min_share del volume della candela.
    """
    if not levels:
        return {"p": [], "buy": [], "sell": [], "imb": [], "poc": None, "buy_total": 0.0, "sell_total": 0.0, "delta": 0.0,
                "stacked": []}
    ps = sorted(levels)
    buy = [float(levels[p][0]) for p in ps]
    sell = [float(levels[p][1]) for p in ps]
    tot = sum(buy) + sum(sell)
    min_q = tot * min_share
    bmap = dict(zip(ps, buy))
    smap = dict(zip(ps, sell))
    imb = []
    for p, b, s in zip(ps, buy, sell):
        flag = 0
        below = smap.get(round(p - bin_size, 6), 0.0)
        above = bmap.get(round(p + bin_size, 6), 0.0)
        if b > 0 and (b >= ratio * below if below > 0 else b >= min_q):
            flag |= 1
        if s > 0 and (s >= ratio * above if above > 0 else s >= min_q):
            flag |= 2
        imb.append(flag)
    vols = [b + s for b, s in zip(buy, sell)]
    i_poc = max(range(len(ps)), key=lambda i: (vols[i], -i))
    # stack: ≥3 livelli consecutivi con imbalance dello stesso lato
    stacked = []
    for bit in (1, 2):
        run = []
        for i, f in enumerate(imb):
            if f & bit and (not run or abs(ps[i] - ps[run[-1]] - bin_size) < 1e-6):
                run.append(i)
            else:
                if len(run) >= 3:
                    stacked.append({"side": "buy" if bit == 1 else "sell", "from": ps[run[0]], "to": ps[run[-1]] + bin_size, "n": len(run)})
                run = [i] if f & bit else []
        if len(run) >= 3:
            stacked.append({"side": "buy" if bit == 1 else "sell", "from": ps[run[0]], "to": ps[run[-1]] + bin_size, "n": len(run)})
    return {"p": ps, "buy": buy, "sell": sell, "imb": imb, "poc": ps[i_poc], "buy_total": sum(buy), "sell_total": sum(sell),
            "delta": sum(buy) - sum(sell), "stacked": stacked}


def rebin(levels: dict[float, list[float]], bin_size: float) -> dict[float, list[float]]:
    out: dict[float, list[float]] = {}
    for p, (b, s) in levels.items():
        k = fp_bin(p, bin_size)
        cur = out.get(k)
        if cur is None:
            out[k] = [b, s]
        else:
            cur[0] += b
            cur[1] += s
    return out


# ============================================================================ heatmap matrix

def resample(times: np.ndarray, M: np.ndarray, t0: float, t1: float, ncols: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Media nel tempo di M (n × m, NaN = fuori range) su `ncols` colonne uguali in [t0, t1). Ritorna (col_t, mean, count)."""
    dt = (t1 - t0) / ncols
    col = np.floor((times - t0) / dt).astype(np.int64)
    ok = (col >= 0) & (col < ncols)
    col, Mk = col[ok], M[ok]
    m = M.shape[1]
    sums = np.zeros((ncols, m), np.float64)
    cnts = np.zeros((ncols, m), np.float64)
    nsamp = np.zeros(ncols, np.int64)
    if len(col):
        valid = ~np.isnan(Mk)
        vals = np.where(valid, Mk, 0.0)
        starts = np.flatnonzero(np.r_[True, col[1:] != col[:-1]])
        ucols = col[starts]
        sums[ucols] = np.add.reduceat(vals, starts, axis=0)
        cnts[ucols] = np.add.reduceat(valid.astype(np.float64), starts, axis=0)
        nsamp[ucols] = np.diff(np.r_[starts, len(col)])
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(cnts > 0, sums / np.maximum(cnts, 1), np.nan)
    col_t = t0 + (np.arange(ncols) + 0.5) * dt
    return col_t, mean, nsamp


def rebucket(mean: np.ndarray, lo_idx: int, base: float, bucket: float) -> tuple[np.ndarray, int]:
    """Somma i bucket base in bucket più grandi (bucket multiplo di base). NaN se tutti i bucket base sono NaN."""
    k = int(round(bucket / base))
    if k <= 1:
        return mean, lo_idx
    new_lo = math.floor(lo_idx / k)
    pad_left = lo_idx - new_lo * k
    m = mean.shape[1] + pad_left
    pad_right = (-m) % k
    padded = np.pad(mean, ((0, 0), (pad_left, pad_right)), constant_values=np.nan)
    r = padded.reshape(padded.shape[0], -1, k)
    allnan = np.isnan(r).all(axis=2)
    out = np.nansum(r, axis=2) if not allnan.all() else np.full(r.shape[:2], np.nan)
    out[allnan] = np.nan
    return out, new_lo


def encode_u16(mat: np.ndarray) -> tuple[str, float]:
    """Matrice float (NaN = assente) -> base64 di uint16 little-endian: 0 = assente, v = (code − 1) × scale."""
    finite = mat[np.isfinite(mat)]
    vmax = float(finite.max()) if finite.size else 0.0
    scale = max(vmax / 65000.0, 1e-4)
    codes = np.where(np.isfinite(mat), np.clip(np.round(np.nan_to_num(mat) / scale), 0, 65000) + 1, 0).astype("<u2")
    return base64.b64encode(codes.tobytes()).decode("ascii"), scale


def decode_u16(b64: str, scale: float, shape: tuple[int, int]) -> np.ndarray:
    codes = np.frombuffer(base64.b64decode(b64), dtype="<u2").reshape(shape).astype(np.float64)
    return np.where(codes == 0, np.nan, (codes - 1) * scale)
