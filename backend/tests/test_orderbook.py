"""Test dell'order book locale, del footprint e della heatmap (app/analysis/orderbook_core.py + app/ob_collector.py).

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_orderbook.py
Nessuna chiamata di rete: sequenze di update sintetiche (incl. buchi negli update id e snapshot vecchi/nuovi).
"""
from __future__ import annotations

import math
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("BTC_DATA_DIR", tempfile.mkdtemp(prefix="obtest_"))

from app.analysis.orderbook_core import (  # noqa: E402
    BookSample, LocalBook, WallTracker, bucketize, compare_books, decode_u16, encode_u16, footprint_levels, parse_depth,
    rebin, rebucket, resample,
)


def fev(U, u, pu, b=(), a=()):
    return {"U": U, "u": u, "pu": pu, "E": 0, "b": list(b), "a": list(a)}


def sev(U, u, b=(), a=()):
    return {"U": U, "u": u, "pu": None, "E": 0, "b": list(b), "a": list(a)}


SNAP_B = [(100.0, 1.0), (99.0, 2.0), (98.0, 3.0)]
SNAP_A = [(101.0, 1.5), (102.0, 2.5), (103.0, 3.5)]


# ------------------------------------------------------------------ futures: procedura ufficiale
def test_futures_sync_and_apply():
    b = LocalBook("futures")
    assert b.on_event(fev(90, 95, 89, b=[(97.0, 9.0)])) == "buffered"      # più vecchio dello snapshot: scartato
    assert b.on_event(fev(96, 105, 95, b=[(100.0, 0.0)], a=[(101.0, 4.0)])) == "buffered"
    assert b.on_event(fev(106, 110, 105, b=[(99.5, 1.0)])) == "buffered"
    assert b.load_snapshot(100, SNAP_B, SNAP_A) == "synced"                 # primo evento: U=96 <= 100 <= u=105
    assert b.synced and b.last_u == 110
    assert 97.0 not in b.bids                                               # evento u < lastUpdateId ignorato
    assert 100.0 not in b.bids and b.asks[101.0] == 4.0 and b.bids[99.5] == 1.0
    assert b.best() == (99.5, 101.0)
    assert b.on_event(fev(111, 115, 110, a=[(101.0, 0.0), (101.2, 0.7)])) == "applied"
    assert b.best() == (99.5, 101.2)
    assert b.on_event(fev(111, 116, 109)) == "gap"                          # pu != u precedente -> risincronizza
    assert not b.synced and not b.bids and len(b.buffer) == 1


def test_futures_stale_snapshot_and_waiting():
    b = LocalBook("futures")
    b.on_event(fev(200, 210, 199))
    assert b.load_snapshot(150, SNAP_B, SNAP_A) == "stale"                  # snapshot più vecchio del primo evento
    assert b.pending is None
    b2 = LocalBook("futures")
    b2.on_event(fev(200, 210, 199))
    assert b2.load_snapshot(300, SNAP_B, SNAP_A) == "waiting"               # snapshot più nuovo: servono eventi successivi
    assert b2.on_event(fev(211, 290, 210)) == "waiting"
    assert b2.on_event(fev(291, 305, 290, b=[(98.0, 0.0)])) == "synced"
    assert b2.synced and b2.last_u == 305 and 98.0 not in b2.bids


def test_futures_gap_inside_buffer():
    b = LocalBook("futures")
    b.on_event(fev(96, 105, 95))
    b.on_event(fev(107, 110, 106))                                          # buco: pu=106 ma u precedente=105
    assert b.load_snapshot(100, SNAP_B, SNAP_A) == "gap"
    assert not b.synced and len(b.buffer) == 1


def test_remove_missing_level_is_ok():
    b = LocalBook("futures")
    b.on_event(fev(96, 105, 95, b=[(55.0, 0.0)]))
    assert b.load_snapshot(100, SNAP_B, SNAP_A) == "synced"
    assert 55.0 not in b.bids


# ------------------------------------------------------------------ spot
def test_spot_sync_rules():
    b = LocalBook("spot")
    b.on_event(sev(90, 100))                                                # u <= lastUpdateId: scartato
    b.on_event(sev(101, 104, b=[(100.0, 5.0)]))                             # U <= L+1 <= u
    assert b.load_snapshot(100, SNAP_B, SNAP_A) == "synced"
    assert b.bids[100.0] == 5.0 and b.last_u == 104
    assert b.on_event(sev(103, 104)) == "old"
    assert b.on_event(sev(105, 108, a=[(101.0, 0.0)])) == "applied"
    assert b.best()[1] == 102.0
    assert b.on_event(sev(110, 112)) == "gap"                               # U != u precedente + 1


def test_spot_stale():
    b = LocalBook("spot")
    b.on_event(sev(105, 110))
    assert b.load_snapshot(100, SNAP_B, SNAP_A) == "stale"                  # L+1=101 < U=105


# ------------------------------------------------------------------ verifica incrociata (book ombra)
def test_shadow_verification_zero_diff():
    rng = np.random.default_rng(1)
    live, events = LocalBook("futures"), []
    u = 1000
    for i in range(300):
        U, u2 = u + 1, u + int(rng.integers(1, 20))
        b = [(round(100 - rng.integers(0, 30) * 0.5, 1), float(rng.integers(0, 5))) for _ in range(5)]
        a = [(round(101 + rng.integers(0, 30) * 0.5, 1), float(rng.integers(0, 5))) for _ in range(5)]
        events.append(fev(U, u2, u, b, a))
        u = u2
    live.on_event(events[0])
    assert live.load_snapshot(events[0]["u"] - 1, SNAP_B, SNAP_A) == "synced"
    for ev in events[1:150]:
        assert live.on_event(ev) == "applied"
    # "snapshot REST" = stato vero a un update id interno a un evento: lo ricostruisco applicando fino all'evento precedente
    truth = LocalBook("futures")
    truth.on_event(events[0])
    truth.load_snapshot(events[0]["u"] - 1, SNAP_B, SNAP_A)
    for ev in events[1:140]:
        truth.on_event(ev)
    L = events[140]["U"] + (events[140]["u"] - events[140]["U"]) // 2
    snap_b = sorted(truth.bids.items(), reverse=True)
    snap_a = sorted(truth.asks.items())
    # nota: lo snapshot reale includerebbe parte dell'evento 140; i livelli toccati dall'evento 140 vengono comunque sovrascritti
    shadow = LocalBook("futures")
    for ev in events[140:150]:
        shadow.on_event(ev)
    assert shadow.load_snapshot(L, snap_b, snap_a) == "synced"
    res = compare_books(live, shadow, -1e9, 1e9)
    assert res["update_id_a"] == res["update_id_b"]
    assert res["range_mismatch"] == 0 and res["top_mismatch"] == 0 and res["best_match"]
    # un livello sbagliato nel book live viene rilevato e riparato
    live.bids[50.0] = 1.0
    res = compare_books(live, shadow, -1e9, 1e9)
    assert res["range_mismatch"] == 1
    live.overwrite_range(shadow, -1e9, 1e9)
    assert compare_books(live, shadow, -1e9, 1e9)["range_mismatch"] == 0


def test_parse_depth():
    d = parse_depth({"e": "depthUpdate", "E": 1, "U": 5, "u": 9, "pu": 4, "b": [["100.10", "1.5"]], "a": [["100.20", "0"]]})
    assert d["b"] == [(100.1, 1.5)] and d["a"] == [(100.2, 0.0)] and d["pu"] == 4


# ------------------------------------------------------------------ bucket della heatmap
def test_bucketize():
    b = LocalBook("futures")
    b.on_event(fev(1, 10, 0))
    b.load_snapshot(5, [(81005.0, 1.0), (81001.0, 2.0), (80995.0, 4.0), (79000.0, 50.0)],
                    [(81010.0, 3.0), (81019.9, 1.0), (82000.0, 7.0)])
    s = bucketize(b, 0.0, 1.0)
    mid = (81005.0 + 81010.0) / 2
    assert abs(s.mid - mid) < 1e-9
    price = lambda i: (s.lo_idx + i) * 10  # noqa: E731
    got = {price(i): float(v) for i, v in enumerate(s.arr) if v > 0}
    assert got == {81000.0: 3.0, 80990.0: 4.0, 81010.0: 4.0}                # 79000 e 82000 fuori da ±1%
    assert s.bd05 == 7.0 and s.ad05 == 4.0


def test_resample_rebucket_encode():
    t = np.arange(0, 10, 1.0)
    M = np.tile(np.array([1.0, 2.0, np.nan, 4.0], np.float32), (10, 1))
    col_t, mean, n = resample(t, M, 0, 10, 5)
    assert mean.shape == (5, 4) and np.isnan(mean[:, 2]).all() and (n == 2).all()
    rb, lo = rebucket(mean, 8101, 10, 20)                                    # bucket da $20: [81000,81020) ecc.
    assert lo == 4050 and rb.shape[1] == 3
    assert math.isnan(rb[0, 0]) is False and rb[0, 0] == 1.0 and rb[0, 1] == 2.0 and rb[0, 2] == 4.0
    b64, scale = encode_u16(rb)
    back = decode_u16(b64, scale, rb.shape)
    assert np.allclose(np.nan_to_num(back), np.nan_to_num(rb), atol=scale)


# ------------------------------------------------------------------ footprint
def test_footprint_poc_imbalance():
    lv = {100.0: (1.0, 0.5), 105.0: (6.0, 1.0), 110.0: (0.5, 0.2), 115.0: (0.1, 3.0)}
    r = footprint_levels(lv, 5.0, 3.0, 0.01)
    assert r["poc"] == 105.0
    assert abs(r["delta"] - (7.6 - 4.7)) < 1e-9
    # buy@105=6 vs sell@100=0.5 -> 12:1 imbalance in acquisto; sell@115=3 vs buy@120 (assente) -> 3 >= 1% del volume
    imb = dict(zip(r["p"], r["imb"]))
    assert imb[105.0] & 1 and imb[115.0] & 2
    assert not imb[110.0] & 1                                               # buy 0.5 vs sell@105=1.0
    assert imb[100.0] & 1                                                   # sell@95 assente e buy 1.0 >= 1% del volume


def test_footprint_stacked_and_rebin():
    lv = {100.0 + 5 * i: (3.0, 0.5) for i in range(4)}
    r = footprint_levels(lv, 5.0)
    assert any(s["side"] == "buy" and s["n"] >= 3 for s in r["stacked"])
    rb = rebin({100.0: [1, 2], 105.0: [3, 4], 110.0: [5, 6]}, 10)
    assert rb == {100.0: [4, 6], 110.0: [5, 6]}


def test_footprint_aggregation_collector():
    """Market.on_trade: bin $5, lato aggressore da m, candela 1m, recupero REST fuori ordine."""
    from app.ob_collector import Market
    mk = Market("futures")
    T = 1_700_000_000_000 - (1_700_000_000_000 % 60000)
    mk.on_trade(1, 81003.0, 0.5, T + 1000, buyer_maker=False)   # buy aggressivo
    mk.on_trade(2, 81004.9, 0.25, T + 2000, buyer_maker=True)   # sell aggressivo
    mk.on_trade(4, 81011.0, 1.0, T + 5000, buyer_maker=False)
    mk.on_trade(3, 80999.0, 2.0, T + 3000, buyer_maker=True, live=False)   # recuperato via REST
    m = T // 1000
    assert mk.fp[m][81000.0] == [0.5, 0.25] and mk.fp[m][81010.0] == [1.0, 0.0] and mk.fp[m][80995.0] == [0.0, 2.0]
    k = mk.fk[m]
    assert k[0] == 81003.0 and k[1] == 81011.0 and k[2] == 80999.0 and k[3] == 81011.0
    assert abs(k[4] - 1.5) < 1e-12 and abs(k[5] - 2.25) < 1e-12 and k[6] == 4
    sec = mk.take_second()
    assert abs(sec["vb"] - 1.5) < 1e-12 and abs(sec["vs"] - 0.25) < 1e-12   # il recupero non entra nel secondo live


# ------------------------------------------------------------------ muri e liquidità ritirata
def _sample(t, mid, wall_idx=None, wall_q=0.0, lo_idx=8000, n=40):
    arr = np.full(n, 1.0, np.float32)
    if wall_idx is not None:
        arr[wall_idx - lo_idx] = wall_q
    return BookSample(t=t, lo_idx=lo_idx, arr=arr, mid=mid, bb=mid - 0.05, ba=mid + 0.05)


def test_wall_pulled_before_touch():
    wt = WallTracker(k=5, min_qty=1, min_age=10, near_pct=0.15, window_pct=1.0)
    evs = []
    for t in range(30):
        evs += wt.update(_sample(float(t), 80150.0, 8018, 40.0))            # muro ask a $80,180 (0.04% sopra)
    assert any(e["kind"] == "appeared" for e in evs)
    evs = wt.update(_sample(30.0, 80150.0, 8018, 1.0), traded={}, trade_lo=80148, trade_hi=80152)
    assert [e["kind"] for e in evs] == ["pulled"]


def test_wall_consumed():
    wt = WallTracker(k=5, min_qty=1, min_age=10)
    for t in range(30):
        wt.update(_sample(float(t), 80150.0, 8018, 40.0))
    evs = wt.update(_sample(30.0, 80185.0, 8018, 2.0), traded={8018: 35.0}, trade_lo=80170, trade_hi=80186)
    assert [e["kind"] for e in evs] == ["consumed"]


def test_wall_far_removed_not_reported():
    wt = WallTracker(k=5, min_qty=1, min_age=10, near_pct=0.15)
    for t in range(30):
        wt.update(_sample(float(t), 80050.0, 8035, 40.0))                  # muro a $80,350 (0.37% sopra)
    assert wt.update(_sample(30.0, 80050.0, 8035, 1.0)) == []


def test_hs_change_only_roundtrip():
    """Formato su disco dei campioni 1 s: solo variazioni, ricostruzione esatta (a 0,01 BTC) incl. bucket usciti dal range."""
    from app.ob_collector import decode_hs, encode_hs, samples_to_df
    rng = np.random.default_rng(3)
    rows = []
    for i in range(50):
        lo = 8100 + (i // 10)                               # il range si sposta: bucket che entrano/escono
        arr = np.round(rng.integers(0, 3, 30) * 1.25, 2).astype(np.float32)
        rows.append((1000.0 + i, lo, arr, {"mid": 81000.0 + i}))
    df = samples_to_df(rows)
    long_df, meta = encode_hs(df)
    lo, M = decode_hs(long_df, len(meta))
    ref = df[[c for c in df.columns if c.startswith("p") and c[1:].isdigit()]].to_numpy(np.float64)
    assert lo == 8100 and M.shape == ref.shape
    assert np.array_equal(np.isnan(M), np.isnan(ref)) and np.allclose(np.nan_to_num(M), np.nan_to_num(ref))
    assert len(long_df) < ref.size                           # più compatto del formato denso
    assert list(meta["mid"]) == [81000.0 + i for i in range(50)]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
