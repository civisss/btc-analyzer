"""Test del Terminale: normalizzazione dei trade per exchange (incl. contratti OKX), aggregazione 1m, CVD a candele,
assenza di doppi conteggi alla riconnessione / nel recupero REST, persistenza e serie con sostituzione da kline.

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_terminal.py
Nessuna chiamata di rete (messaggi sintetici nel formato documentato dagli exchange).
"""
from __future__ import annotations

import math
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_TMP = tempfile.mkdtemp(prefix="termtest_")
os.environ.setdefault("BTC_DATA_DIR", _TMP)
os.environ.setdefault("USER_DATA_DIR", _TMP)
os.environ["TERMINAL_COLLECTOR"] = "off"

import pandas as pd  # noqa: E402

from app.analysis import terminal_core as tc  # noqa: E402

M0 = 1_792_000_000 - (1_792_000_000 % 60)    # inizio di un minuto (s)
T0 = M0 * 1000                                # ms


def close(a, b, eps=1e-9):
    return abs(a - b) <= eps * max(1.0, abs(a), abs(b))


# ------------------------------------------------------------------ parser
def test_binance_side_from_m():
    buy = tc.parse_binance({"e": "aggTrade", "a": 10, "p": "80000.5", "q": "0.25", "T": T0 + 5, "m": False})
    sell = tc.parse_binance({"e": "aggTrade", "a": 11, "p": "80000.0", "q": "1.5", "T": T0 + 6, "m": True})
    assert buy == (T0 + 5, 80000.5, 0.25, True, 10)          # m = falso: il compratore è taker -> acquisto aggressivo
    assert sell[3] is False and sell[4] == 11                 # m = vero: compratore maker -> vendita aggressiva
    assert tc.parse_binance({"e": "markPriceUpdate"}) is None


def test_bybit_taker_side_and_size():
    msg = {"topic": "publicTrade.BTCUSDT", "type": "snapshot", "data": [
        {"T": T0 + 1, "s": "BTCUSDT", "S": "Buy", "v": "0.006", "p": "81752.50", "i": "0a63db69-490a", "BT": False},
        {"T": T0 + 2, "s": "BTCUSDT", "S": "Sell", "v": "0.024", "p": "81752.40", "i": "34ac089f-5e62", "BT": False}]}
    out = tc.parse_bybit(msg)
    assert out[0] == (T0 + 1, 81752.5, 0.006, True, "0a63db69-490a")
    assert out[1][3] is False and close(out[1][2], 0.024)
    assert tc.parse_bybit({"op": "pong"}) == []


def test_okx_contracts_to_btc():
    swap = {"arg": {"channel": "trades-all", "instId": "BTC-USDT-SWAP"},
            "data": [{"instId": "BTC-USDT-SWAP", "tradeId": "3001808405", "px": "81766.4", "sz": "1.96", "side": "sell", "ts": str(T0 + 3)}]}
    spot = {"arg": {"channel": "trades-all", "instId": "BTC-USDT"},
            "data": [{"instId": "BTC-USDT", "tradeId": "77", "px": "81800", "sz": "0.12060306", "side": "buy", "ts": str(T0 + 4)}]}
    (k1, t1), = tc.parse_okx(swap, 0.01)
    (k2, t2), = tc.parse_okx(spot, 0.01)
    assert k1 == "okx_perp" and close(t1[2], 0.0196) and t1[3] is False and t1[4] == 3001808405   # 1.96 contratti × 0.01 BTC
    assert k2 == "okx_spot" and close(t2[2], 0.12060306) and t2[3] is True                          # spot: sz già in BTC
    assert tc.parse_okx({"arg": {"channel": "trades-all", "instId": "ETH-USDT-SWAP"},
                         "data": [{"instId": "ETH-USDT-SWAP", "tradeId": "1", "px": "1", "sz": "1", "side": "buy", "ts": "1"}]}) == []


def test_coinbase_maker_side_inverted():
    m = {"type": "match", "trade_id": 1107165178, "side": "sell", "size": "0.5", "price": "81690.72", "product_id": "BTC-USD",
         "time": "2026-10-16T23:06:11.865307Z"}
    tr = tc.parse_coinbase(m)
    assert tr[3] is True                 # maker vende -> il taker compra (up-tick)
    assert tr[0] == 1_792_191_971_865    # 2026-10-16T23:06:11.865Z in ms
    assert tc.parse_coinbase({**m, "side": "buy"})[3] is False
    assert tc.parse_coinbase({**m, "type": "last_match"}) is None
    rest = tc.parse_coinbase_rest({"trade_id": 5, "side": "buy", "size": "0.1", "price": "80000", "time": "2026-10-16T23:06:43.620891Z"})
    assert rest[3] is False and rest[4] == 5


# ------------------------------------------------------------------ aggregazione 1m
def test_minute_bars_and_groups():
    a = tc.MinuteAgg(large_usd=100_000)
    assert a.add("binance_perp", (T0 + 1000, 100.0, 2.0, True, 1))        # +2
    assert a.add("binance_perp", (T0 + 2000, 101.0, 5.0, False, 2))       # -5 (cumulato −3)
    assert a.add("binance_perp", (T0 + 3000, 99.0, 1000.0, True, 3))      # +1000, $99,000 < soglia grandi
    assert a.add("coinbase_spot", (T0 + 1500, 100.0, 1500.0, False, 9))   # spot −1500, $150,000 grande
    assert a.add("binance_perp", (T0 + 500, 98.0, 1.0, True, 4))          # arrivato in ritardo: diventa l'apertura
    b = a.bars["binance_perp"][M0]
    assert close(b[tc.I_VB], 1003.0) and close(b[tc.I_VS], 5.0)
    assert close(b[tc.I_QB], 2 * 100 + 1000 * 99 + 98) and b[tc.I_NB] == 3 and b[tc.I_NS] == 1
    assert b[tc.I_LNB] == 0
    assert (b[tc.I_O], b[tc.I_H], b[tc.I_L], b[tc.I_C]) == (98.0, 101.0, 98.0, 99.0)
    cb = a.bars["coinbase_spot"][M0]
    assert cb[tc.I_LNS] == 1 and close(cb[tc.I_LVS], 1500.0)
    perp = a.grp["perp"][M0]
    assert close(perp[0], 998.0) and close(perp[1], 998.0) and close(perp[2], -3.0)
    al = a.grp["all"][M0]
    # ordine di arrivo: +2, −5, +1000, −1500 (spot), +1  -> cumulato 2, −3, 997, −503, −502
    assert close(al[0], -502.0) and close(al[1], 997.0) and close(al[2], -503.0)
    assert close(a.grp["spot"][M0][0], -1500.0)


def test_no_double_count_on_reconnect_and_recovery():
    a = tc.MinuteAgg()
    trades = [(T0 + i * 100, 100.0 + i, 0.1 * (i + 1), i % 2 == 0, 1000 + i) for i in range(10)]
    for tr in trades[:6]:
        a.add("binance_perp", tr)
    # riconnessione: lo stream ripete gli ultimi 2 trade e il recupero REST restituisce l'intero tratto 1003..1009
    for tr in trades[4:6]:
        assert a.add("binance_perp", tr) is False
    added = [a.add("binance_perp", tr, live=False) for tr in trades[3:]]
    assert added == [False, False, False, True, True, True, True]
    b = a.bars["binance_perp"][M0]
    assert close(b[tc.I_VB] + b[tc.I_VS], sum(t[2] for t in trades))
    assert b[tc.I_NB] + b[tc.I_NS] == 10
    exp_d = sum(t[2] if t[3] else -t[2] for t in trades)
    assert close(a.grp["perp"][M0][0], exp_d) and close(a.grp["all"][M0][0], exp_d)
    # Bybit: id stringa (UUID) — stessa deduplica
    assert a.add("bybit_perp", (T0, 100.0, 1.0, True, "uuid-1"))
    assert not a.add("bybit_perp", (T0, 100.0, 1.0, True, "uuid-1"))
    # stessi id su stream diversi non si escludono a vicenda
    assert a.add("okx_spot", (T0, 100.0, 1.0, True, 1000))


def test_seen_ring_evicts_oldest():
    s = tc.Seen(n=3)
    for k in (1, 2, 3, 4):
        assert s.add(k)
    assert 1 not in s and 4 in s and len(s) == 3


# ------------------------------------------------------------------ CVD a candele
def test_cvd_candles_ohlc():
    mins = [(M0, 5.0, 8.0, -1.0), (M0 + 60, -3.0, 1.0, -4.0), (M0 + 120, 2.0, 2.0, 0.0), (M0 + 300, -1.0, 0.0, -2.0)]
    c5 = tc.cvd_candles(mins, 300)
    # barra 1 (3 minuti): apre a 0, alto 8 (0+8), basso −1, poi 5 → minimo 5−4 = 1, alto 5+1; chiude 5−3+2 = 4
    assert c5[0] == (M0 - M0 % 300, 0.0, 8.0, -1.0, 4.0) or c5[0][1:] == (0.0, 8.0, -1.0, 4.0)
    assert c5[-1][1:] == (4.0, 4.0, 2.0, 3.0)
    c1 = tc.cvd_candles(mins, 60)
    assert [x[4] for x in c1] == [5.0, 2.0, 4.0, 3.0]
    assert c1[1][1:] == (5.0, 6.0, 1.0, 2.0)
    # estremi incoerenti (es. da kline): forzati a includere apertura e chiusura
    assert tc.cvd_candles([(M0, 3.0, 0.0, 0.0)], 60)[0][1:] == (0.0, 3.0, 0.0, 3.0)
    # bar_delta_stats coincide con la candela relativa all'apertura
    d, hi, lo = tc.bar_delta_stats(mins[:3])
    assert (d, hi, lo) == (4.0, 8.0, -1.0)
    start = tc.cvd_candles(mins, 300, start=10.0)
    assert start[0][1:] == (10.0, 18.0, 9.0, 14.0)


def test_ohlc_flow_book():
    assert tc.ohlc([(M0, 5.0), (M0 + 30, 7.0), (M0 + 50, 4.0), (M0 + 70, 6.0)], 60) == [(M0, 5.0, 7.0, 4.0, 4.0), (M0 + 60, 6.0, 6.0, 6.0, 6.0)]
    secs = {100: {"binance_perp": [1, 0, 100_000, 0, 1, 0, 1, 0], "coinbase_spot": [0, 2, 0, 200_000, 0, 2, 0, 1]},
            99: {"okx_perp": [1, 0, 50_000, 0, 1, 0, 0, 0]}, 40: {"okx_perp": [9, 0, 9e9, 0, 9, 0, 0, 0]}}
    f = tc.flow_window(secs, 100, 60)
    assert f["buy_usd"] == 150_000 and f["sell_usd"] == 200_000 and f["n_buy"] == 2 and f["n_sell"] == 2
    assert f["exchanges"] == 3 and f["large_buy"] == 1 and f["large_sell"] == 1
    assert close(f["buy_share"], 150 / 350) and f["perp_delta_usd"] == 150_000 and f["spot_delta_usd"] == -200_000
    bids = [(100.4, 1.0), (100.1, 2.0), (99.9, 3.0), (95.0, 4.0)]
    asks = [(100.6, 1.0), (101.0, 2.0), (101.2, 0.5)]
    assert tc.aggregate_book(bids, 1, True, 2) == [[100.0, 3.0], [99.0, 3.0]]
    assert tc.aggregate_book(asks, 1, False, 5) == [[101.0, 3.0], [102.0, 0.5]]


# ------------------------------------------------------------------ collector: feed, persistenza, ricarica
def test_collector_feed_flush_reload():
    from app import terminal_collector as tcol
    c = tcol.TermCollector()
    big = (T0 + 10, 80000.0, 1.0, True, 1)                # $80K -> trade singolo nel feed
    small = [(T0 + 20 + i, 80000.0, 0.01, False, 2 + i) for i in range(5)]   # $800 ciascuno -> aggregati
    import time as _t
    now_ms = int(_t.time() * 1000)
    shift = now_ms - T0 - 5000                            # trade "live" recenti per il buffer al secondo
    assert c.on_trade("binance_perp", (big[0] + shift, *big[1:]))
    for tr in small:
        c.on_trade("binance_perp", (tr[0] + shift, *tr[1:]))
    assert not c.on_trade("binance_perp", (small[0][0] + shift, *small[0][1:]))     # duplicato
    c.flush_feed()
    items = list(c.feed)
    assert items[0]["a"] == 0 and items[0]["u"] == 80000.0
    agg = [x for x in items if x["a"] == 1]
    assert len(agg) == 1 and agg[0]["n"] == 5 and close(agg[0]["q"], 0.05) and agg[0]["b"] == 0
    assert c.st["binance_perp"].dupes == 1
    # persistenza e ricarica: stesse barre e stesso delta di gruppo
    c.flush()
    m = ((big[0] + shift) // 60000) * 60
    c2 = tcol.TermCollector()
    c2._load_meta()
    c2._load_recent()
    b1, b2 = c.agg.bars["binance_perp"][m], c2.agg.bars["binance_perp"][m]
    assert all(close(x, y) for x, y in zip(b1, b2))
    assert close(c2.agg.grp["perp"][m][0], 1.0 - 0.05)
    assert m in c2.st["binance_perp"].incomplete          # primo minuto della raccolta: incompleto
    # riavvio ravvicinato: si riparte dall'ultimo id SALVATO (fotografato con le barre) -> il recupero REST parte da id + 1, nessun doppione
    assert c.meta["last"]["binance_perp"]["id"] == 6 and c2.st["binance_perp"].last_id == 6


def test_series_kline_substitution():
    """Minuti Binance senza flusso live (o incompleti): delta dalle kline ufficiali (taker buy); gli altri dal flusso live."""
    from app.routers import terminal as T
    tb = pd.DataFrame([
        (M0, "binance_perp", 3.0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, False),   # incompleto -> sostituito dalla kline
        (M0 + 60, "binance_perp", 2.0, 2.0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, True),
        (M0 + 60, "okx_spot", 1.0, 0.0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, True),
    ], columns=["t", "s", *tc.BAR_COLS, "ok"])
    tk = pd.DataFrame([(M0, "binance_perp", 10.0, 7.0, 5, 1.0), (M0 + 60, "binance_perp", 9.0, 1.0, 5, 1.0),
                       (M0 + 120, "binance_spot", 4.0, 1.0, 3, 1.0)], columns=["t", "s", "vol", "vb", "n", "c"])
    tg = pd.DataFrame([(M0 + 60, "perp", 0.0, 1.5, -0.5), (M0 + 60, "all", 1.0, 2.0, -0.5)], columns=["t", "g", "d", "dmax", "dmin"])
    G, cov = T._group_minutes({"tb": tb, "tk": tk, "tg": tg})
    perp = G[G["g"] == "perp"].set_index("t")
    assert close(perp.loc[M0, "d"], 7.0 - 3.0)                  # kline: 7 acquisti su 10
    assert close(perp.loc[M0 + 60, "d"], 0.0)                   # live ok: kline ignorata
    assert close(perp.loc[M0 + 60, "dmax"], 1.5) and close(perp.loc[M0 + 60, "dmin"], -0.5)   # estremi live conservati
    spot = G[G["g"] == "spot"].set_index("t")
    assert close(spot.loc[M0 + 60, "d"], 1.0) and close(spot.loc[M0 + 120, "d"], 1.0 - 3.0)
    al = G[G["g"] == "all"].set_index("t")
    assert close(al.loc[M0 + 60, "d"], 1.0) and close(al.loc[M0 + 60, "dmax"], 2.0)
    assert cov["binance_perp"]["kline_from"] == M0 and cov["okx_spot"]["ws_from"] == M0 + 60


def test_layout_validation():
    from app import terminal_layouts as L
    st = L.clean_state({"tf": "15m", "tiles": [{"id": "chart", "w": 20, "h": 1}, {"id": "dom", "w": 3, "h": 8, "hidden": True}],
                        "panes": ["cvd_spot", "oi", "xx", "oi"], "opts": {"heat": False}})
    assert st["tiles"][0] == {"id": "chart", "w": 12, "h": 2, "hidden": False}
    assert {t["id"] for t in st["tiles"]} == set(L.TILES) and st["panes"] == ["cvd_spot", "oi"]
    assert st["opts"]["heat"] is False and st["opts"]["est"] is True
    for bad in ({"tf": "2m", "tiles": [{"id": "chart"}]}, {"tiles": [{"id": "x"}]}, {"tiles": []}):
        try:
            L.clean_state(bad)
            raise AssertionError("atteso LayoutError")
        except L.LayoutError:
            pass


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as e:  # noqa: BLE001
                fails += 1
                import traceback
                traceback.print_exc()
                print(f"FAIL {name}: {e}")
    print(f"\n{'TUTTI OK' if not fails else f'{fails} FALLITI'}")
    sys.exit(1 if fails else 0)
    _ = math
