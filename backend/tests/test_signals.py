"""Test dei Segnali: ordine di TP e SL, costi, ciclo di vita, registro immutabile, ricostruzione dopo lo spegnimento, assenza di look-ahead.

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_signals.py
Nessuna chiamata di rete: dati sintetici.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_TMP = tempfile.mkdtemp(prefix="sigtest_")
os.environ["BTC_DATA_DIR"] = _TMP
os.environ["USER_DATA_DIR"] = _TMP
os.environ["TERMINAL_COLLECTOR"] = "off"

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from app import signals as sg  # noqa: E402
from app.analysis import signal_backtest as bt  # noqa: E402
from app.analysis import signal_meta as sm  # noqa: E402
from app.analysis import signal_setups as ss  # noqa: E402
from app.analysis import signal_sim as sim  # noqa: E402

NOF = (np.array([], dtype=np.int64), np.array([]))


def plan(side=1, kind="market", entry=100.0, sl=99.0, tp1=101.0, tp2=102.0, inv=None, pending=10_000, exit_by=100_000, tf=3600):
    return sim.Plan(side, kind, entry, sl, tp1, tp2, inv, pending, exit_by, tf)


def run(p, bars):
    tr = sim.Trade(p)
    for i, b in enumerate(bars):
        tr.step(i * 60, *b, False)
    return tr


# ------------------------------------------------------------------ TP e SL

def test_tp_and_sl_in_same_candle_counts_sl():
    tr = run(plan(), [(100, 101.5, 98.5, 100)])
    assert tr.outcome == "sl" and tr.exit_px == 99.0 and not tr.tp1_done


def test_short_same_candle_counts_sl():
    tr = run(plan(side=-1, sl=101.0, tp1=99.0, tp2=98.0), [(100, 101.5, 98.5, 100)])
    assert tr.outcome == "sl" and tr.exit_px == 101.0


def test_limit_entry_candle_ignores_target_but_not_stop():
    tr = run(plan(kind="limit", entry=100.0), [(100.5, 101.5, 99.5, 100.5)])
    assert tr.status == "active" and not tr.tp1_done
    tr = run(plan(kind="limit", entry=100.0), [(100.5, 101.5, 98.5, 100.5)])
    assert tr.outcome == "sl" and tr.exit_px == 99.0


def test_target_must_be_crossed_stop_only_touched():
    tr = run(plan(), [(100, 101.0, 99.5, 100.5)])
    assert tr.status == "active" and not tr.tp1_done
    tr = run(plan(), [(100, 100.5, 99.0, 100)])
    assert tr.outcome == "sl"


def test_gap_beyond_stop_exits_at_open():
    tr = run(plan(), [(100, 100.2, 99.8, 100), (98.0, 98.5, 97.5, 98)])
    assert tr.outcome == "sl" and tr.exit_px == 98.0


def test_tp1_moves_stop_to_breakeven():
    tr = run(plan(), [(100, 100.2, 99.8, 100.1), (100.2, 101.2, 100.1, 101), (101, 101.5, 99.9, 100.5)])
    assert tr.tp1_done and tr.outcome == "be" and tr.exit_px == 100.0


def test_tp1_and_breakeven_in_same_candle_is_breakeven():
    tr = run(plan(), [(100, 100.2, 99.8, 100), (100, 102.5, 99.9, 101)])
    assert tr.tp1_done and tr.outcome == "be"


def test_tp2_after_tp1():
    tr = run(plan(), [(100, 100.2, 99.8, 100.1), (100.2, 101.2, 100.1, 101), (101, 102.5, 100.5, 102)])
    assert tr.outcome == "tp2" and tr.exit_px == 102.0


# ------------------------------------------------------------------ costi

def test_costs_exact():
    assert sim.COST_PCT == 2 * (sim.FEE_PCT + sim.SLIP_PCT)
    tr = run(plan(), [(100, 100.2, 99.8, 100.1), (100.2, 101.2, 100.1, 101), (101, 102.5, 100.5, 102)])
    assert abs(tr.gross_pct() - 1.5) < 1e-9
    assert abs(tr.net_r(*NOF) - (1.5 - sim.COST_PCT) / 1.0) < 1e-9
    tr = run(plan(), [(100, 100.5, 98.5, 99)])
    assert abs(tr.net_r(*NOF) - (-1.0 - sim.COST_PCT)) < 1e-9


def test_funding_paid_by_longs_received_by_shorts():
    ft, fr = np.array([60, 120, 100000]), np.array([0.1, 0.1, 5.0])
    tr = run(plan(), [(100, 100.2, 99.8, 100), (100, 100.1, 99.9, 100), (100, 100.1, 99.9, 100), (100, 100.1, 98.0, 99)])
    assert tr.exit_t == 180 and abs(tr.funding_pct(ft, fr) - 0.2) < 1e-9
    assert abs(tr.net_r(ft, fr) - (-1.0 - sim.COST_PCT - 0.2)) < 1e-9
    s = run(plan(side=-1, sl=101.0, tp1=99.0, tp2=98.0), [(100, 100.2, 99.8, 100), (100, 100.1, 99.9, 100), (100, 100.1, 99.9, 100), (100, 102.0, 99.9, 101)])
    assert abs(s.funding_pct(ft, fr) + 0.2) < 1e-9


def test_funding_halves_after_tp1():
    ft, fr = np.array([120]), np.array([0.2])
    tr = run(plan(), [(100, 100.2, 99.8, 100.1), (100.2, 101.5, 100.1, 101), (101, 101.2, 100.5, 101), (101, 102.5, 100.5, 102)])
    assert abs(tr.funding_pct(ft, fr) - 0.1) < 1e-9


# ------------------------------------------------------------------ ciclo di vita

def test_pending_expires_without_trade():
    p = plan(kind="limit", entry=99.5, sl=98.5, tp1=100.5, tp2=101.5, pending=120)
    tr = run(p, [(100, 100.2, 99.8, 100), (100, 100.2, 99.8, 100), (100, 100.2, 99.8, 100)])
    assert tr.outcome == "expired" and tr.fill is None and tr.net_r(*NOF) is None


def test_target_before_entry_cancels():
    tr = run(plan(kind="limit", entry=99.5, sl=98.5, tp1=100.5, tp2=101.5), [(100, 100.7, 99.8, 100.6)])
    assert tr.outcome == "canceled" and tr.fill is None


def test_pending_invalidated_on_timeframe_close():
    tr = sim.Trade(plan(kind="limit", entry=98.0, sl=97.0, tp1=101.0, tp2=102.0, inv=99.0))
    tr.step(0, 100, 100.2, 98.5, 98.8, False)
    assert tr.status == "pending"
    tr.step(60, 98.8, 99.0, 98.5, 98.7, True)
    assert tr.outcome == "invalidated" and tr.fill is None


def test_active_invalidated_exits_at_next_open():
    tr = sim.Trade(plan(inv=99.5))
    tr.step(0, 100, 100.2, 99.6, 99.4, True)
    assert tr.status == "active" and tr.leave
    tr.step(60, 99.3, 99.6, 99.2, 99.4, False)
    assert tr.outcome == "invalidated" and tr.exit_px == 99.3


def test_time_stop():
    tr = run(plan(exit_by=120), [(100, 100.2, 99.8, 100), (100, 100.2, 99.8, 100), (100.1, 100.2, 99.8, 100)])
    assert tr.outcome == "timeout" and tr.exit_px == 100.1


def test_fast_simulation_matches_bar_by_bar():
    rng = np.random.default_rng(3)
    n = 6000
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.001, n)))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.0007, n)))
    l = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 0.0007, n)))
    A = sim.Fine(np.arange(n) * 300, o, h, l, c, 300)
    for k in range(200):
        i0 = int(rng.integers(0, n - 2000))
        e = c[i0]
        side = 1 if k % 2 else -1
        kind = "limit" if k % 3 == 0 else "market"
        en = e - side * 0.002 * e if kind == "limit" else e
        p = sim.Plan(side, kind, en, en - side * 0.005 * e, en + side * 0.005 * e, en + side * 0.01 * e, en - side * 0.003 * e if k % 4 == 0 else None,
                     int(A.t[i0]) + 3600 * 2, int(A.t[i0]) + 3600 * 48, 3600)
        fast = sim.simulate(p, A, i0)
        slow = sim.Trade(p)
        for j in range(i0, n):
            slow.step(int(A.t[j]), o[j], h[j], l[j], c[j], (int(A.t[j]) + 300) % 3600 == 0)
            if slow.status == "closed":
                break
        assert (fast.outcome, fast.exit_t, fast.exit_px, fast.tp1_done) == (slow.outcome, slow.exit_t, slow.exit_px, slow.tp1_done)


# ------------------------------------------------------------------ registro

def fresh_registry():
    sg.LEDGER_FILE.unlink(missing_ok=True)
    sg.STATE_FILE.unlink(missing_ok=True)
    sg.reset_cache()


def emitted(sig="a-1", **kw):
    d = {"setup": "sweep", "tf": "1h", "family": "low", "side": "long", "kind": "market", "tier": "experimental", "entry": 100.0, "sl": 99.0, "tp1": 101.0, "tp2": 102.0,
         "inv": None, "emitted_at": 0, "pending_until": 7200, "exit_by": 100000, "reasons": [], "context": {}}
    d.update(kw)
    return {"sig": sig, "type": "emitted", "time": d["emitted_at"], "price": d["entry"], "data": d}


def test_ledger_is_append_only_and_chained():
    fresh_registry()
    sg.append([emitted()])
    first = pd.read_parquet(sg.LEDGER_FILE).iloc[0].to_dict()
    sg.append([{"sig": "a-1", "type": "active", "time": 60, "price": 100.1}])
    df = pd.read_parquet(sg.LEDGER_FILE)
    assert len(df) == 2 and df.iloc[0].to_dict() == first and df.iloc[1]["prev"] == first["hash"]
    assert sg.verify()["ok"]


def test_emission_cannot_be_rewritten():
    fresh_registry()
    sg.append([emitted()])
    try:
        sg.append([emitted(entry=90.0)])
    except ValueError:
        pass
    else:
        raise AssertionError("una seconda emissione con lo stesso id deve fallire")
    assert sg.fold()["a-1"]["entry"] == 100.0
    try:
        sg.append([{"sig": "ignoto", "type": "sl", "time": 1, "price": 1.0}])
    except ValueError:
        return
    raise AssertionError("evento senza emissione accettato")


def test_tampering_is_detected():
    fresh_registry()
    sg.append([emitted()])
    sg.append([{"sig": "a-1", "type": "active", "time": 60, "price": 100.1}])
    df = pd.read_parquet(sg.LEDGER_FILE)
    d = json.loads(df.loc[0, "data"])
    d["sl"] = 50.0
    df.loc[0, "data"] = json.dumps(d, sort_keys=True)
    df.to_parquet(sg.LEDGER_FILE, index=False)
    v = sg.verify()
    assert not v["ok"] and v["broken_at"] == 0


def test_state_survives_a_process_restart():
    fresh_registry()
    sg.append([emitted()])
    sg.append(sg.advance(list(sg.fold().values()), [(0, 100, 100.2, 99.8, 100.1), (60, 100.2, 101.5, 100.1, 101)], 200, *NOF))
    sg.reset_cache()
    s = sg.fold()["a-1"]
    assert s["status"] == "active" and s["tp1_hit"] and s["fill"] == 100
    t = sg.trade_of(s)
    assert t.stop == 100 and t.tp1_done


def test_rebuild_after_shutdown():
    fresh_registry()
    sg.append([emitted()])
    sg.store.write_text(sg.STATE_FILE, json.dumps({"cursor": 0, "seen": 60}))
    bars = [(60, 100, 100.5, 99.9, 100), (120, 100.3, 101.2, 100.2, 101), (180, 101, 102.5, 100.5, 102)]
    now = 180 + 60 + 86400 * 2 - (180 + 60 + 86400 * 2) % 60 + 30
    out = sg.tick(now, bars_fn=lambda after: bars, frame_fn=lambda tf: (_ for _ in ()).throw(AssertionError("nessuna valutazione attesa")))
    s = sg.fold()["a-1"]
    assert s["outcome"] == "tp2" and s["rebuilt"] and out["rebuilt"] == len(s["events"]) - 1
    assert all(e["rebuilt"] for e in s["events"] if e["type"] != "emitted")
    assert s["r"] is not None and abs(s["r"] - (1.5 - sim.COST_PCT)) < 1e-6
    assert json.loads(sg.STATE_FILE.read_text())["cursor"] == 180


def test_live_events_are_not_marked_rebuilt():
    fresh_registry()
    sg.append([emitted()])
    sg.store.write_text(sg.STATE_FILE, json.dumps({"cursor": 0, "seen": 60}))
    sg.tick(150, bars_fn=lambda after: [(60, 100, 100.5, 99.9, 100)], frame_fn=lambda tf: None)
    s = sg.fold()["a-1"]
    assert s["status"] == "active" and not s["rebuilt"]


def test_offline_gap_never_emits_afterwards():
    fresh_registry()
    t0 = 1_700_000_000 // 3600 * 3600
    sg.store.write_text(sg.STATE_FILE, json.dumps({"cursor": t0 - 60, "seen": t0}))
    called = []
    bars = [(t0 + i * 60, 100, 100, 100, 100) for i in range(120)]
    sg.tick(t0 + 86400, bars_fn=lambda a: bars, frame_fn=lambda tf: called.append(tf))
    assert called == []


def test_close_missing_from_data_is_retried():
    fresh_registry()
    F = make_frame()
    close_t = int(F.t[-1]) + 3600
    sg.store.write_text(sg.STATE_FILE, json.dumps({"cursor": close_t - 120, "seen": close_t - 60}))
    calls = []

    def stale(tf):
        calls.append(tf)
        return make_frame(close_t // ss.TF_S[tf] - 1, tf)

    sg.tick(close_t + 20, bars_fn=lambda a: [(close_t - 60, 100, 100, 100, 100)], frame_fn=stale)
    assert calls and json.loads(sg.STATE_FILE.read_text())["seen"] == close_t - 60
    sg.tick(close_t + 40, bars_fn=lambda a: [], frame_fn=lambda tf: make_frame(close_t // ss.TF_S[tf], tf))
    assert json.loads(sg.STATE_FILE.read_text())["seen"] == close_t


def test_live_path_equals_backtest_path():
    rng = np.random.default_rng(5)
    n = 3000
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.0006, n)))
    o = np.r_[c[0], c[:-1]]
    h, l = np.maximum(o, c) * 1.0004, np.minimum(o, c) * 0.9996
    t = np.arange(n) * 60
    fresh_registry()
    e = float(c[9])
    sg.append([emitted(entry=e, sl=e * 0.994, tp1=e * 1.006, tp2=e * 1.012, emitted_at=600, pending_until=600 + 3600, exit_by=600 + 3600 * 40)])
    bars = [(int(t[i]), o[i], h[i], l[i], c[i]) for i in range(n)]
    for k in range(0, n, 37):      # a blocchi, come farebbe l'agente
        sg.append(sg.advance([s for s in sg.fold().values() if s["status"] in sg.OPEN_STATES], bars[k:k + 37], 10 ** 9, *NOF))
    s = sg.fold()["a-1"]
    tr = sim.simulate(sim.Plan(1, "market", e, e * 0.994, e * 1.006, e * 1.012, None, 4200, 600 + 3600 * 40, 3600), sim.Fine(t, o, h, l, c, 60), 10)
    assert s["outcome"] == tr.outcome and s["exit_t"] == tr.exit_t and abs(s["r"] - tr.net_r(*NOF)) < 1e-9


# ------------------------------------------------------------------ look-ahead

def synth(n=30000, seed=11):
    rng = np.random.default_rng(seed)
    t0 = 1_600_000_000 // 86400 * 86400
    r = rng.normal(0, 0.0018, n) + 0.0012 * np.sin(np.arange(n) / 900)
    c = 10000 * np.exp(np.cumsum(r))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.0012, n)))
    l = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 0.0012, n)))
    v = rng.gamma(2, 50, n)
    time = pd.to_datetime(t0 + np.arange(n) * 300, unit="s", utc=True)
    m5 = pd.DataFrame({"time": time, "open": o, "high": h, "low": l, "close": c, "volume": v, "taker_buy": v * rng.uniform(0.3, 0.7, n)})
    g = np.arange(n) // 3
    sp = m5.groupby(g).agg(time=("time", "first"), open=("open", "first"), high=("high", "max"), low=("low", "min"), close=("close", "last"), volume=("volume", "sum"), taker_buy=("taker_buy", "sum"))
    sp["taker_buy"] = sp["volume"] * rng.uniform(0.3, 0.7, len(sp))
    ft = pd.date_range(time[0], time[-1], freq="8h")
    fund = pd.DataFrame({"time": ft, "rate": rng.normal(0.0001, 0.0002, len(ft))})
    days = pd.date_range(time[0], time[-1], freq="1D")
    oi = pd.DataFrame({"time": days, "oi_usdt": 1e9 * np.exp(np.cumsum(rng.normal(0, 0.02, len(days)))), "oi_inverse_usd": 1e8})
    return m5, sp, fund, oi


COLS = ("o", "h", "l", "c", "a", "ema50", "ema200", "adx", "trend", "vol", "vw", "sd", "pdelta", "sdelta", "fund", "fund_z", "oi7")


def cut(df, t):
    return df[df["time"] < t].reset_index(drop=True)


def test_frame_rows_do_not_depend_on_the_future():
    m5, sp, fund, oi = synth()
    for tf in ("15m", "1h", "4h"):
        full = ss.build_frame(m5, sp, fund, oi, tf)
        k = int(len(full.t) * 0.7)
        t = pd.Timestamp(int(full.t[k]) + ss.TF_S[tf], unit="s", tz="UTC")
        part = ss.build_frame(cut(m5, t), cut(sp, t), cut(fund, t), cut(oi, t), tf)
        assert len(part.t) == k + 1 and part.t[-1] == full.t[k]
        for f in COLS:
            a, b = getattr(full, f)[: k + 1], getattr(part, f)
            assert np.allclose(a, b, equal_nan=True, rtol=1e-9), (tf, f)


def test_candidates_do_not_depend_on_the_future():
    m5, sp, fund, oi = synth()
    for tf in ("15m", "1h"):
        full = ss.build_frame(m5, sp, fund, oi, tf)
        k = int(len(full.t) * 0.75)
        t = pd.Timestamp(int(full.t[k]) + ss.TF_S[tf], unit="s", tz="UTC")
        part = ss.build_frame(cut(m5, t), cut(sp, t), cut(fund, t), cut(oi, t), tf)
        seen = 0
        for name, d in ss.SETUPS.items():
            if tf not in d["tfs"]:
                continue
            for side in (1, -1):
                for p in d["grid"]:
                    a = [(c.i, c.entry, c.sl, c.tp1, c.tp2, c.inv) for c in ss.candidates(full, name, side, p) if c.i <= k]
                    b = [(c.i, c.entry, c.sl, c.tp1, c.tp2, c.inv) for c in ss.candidates(part, name, side, p)]
                    assert a == b, (name, side, p)
                    seen += len(a)
        assert seen > 50


def test_entry_is_after_the_signal_candle_close():
    m5, sp, fund, oi = synth()
    F = ss.build_frame(m5, sp, fund, oi, "1h")
    A = bt.fine_from(m5)
    M = bt.Market(A, *NOF, {"1h": F})
    cs = ss.candidates(F, "vwap_reclaim", 1, {"regime": "any", "a": 1.0, "b": 2.0})
    assert cs
    tr = bt.run_trades(M, cs)
    assert tr
    for x in tr:
        assert x["t"] == int(F.t[x["i"]]) + 3600
    c = cs[0]
    close_t = int(F.t[c.i]) + 3600
    r = sim.simulate(bt.plan_of(c, close_t), A, int(np.searchsorted(A.t, close_t)))
    assert r.fill_t >= close_t
    k = int(np.searchsorted(A.t, close_t))
    assert r.fill == A.o[k]


def test_backtest_trades_ignore_prices_after_their_exit():
    m5, sp, fund, oi = synth()
    F = ss.build_frame(m5, sp, fund, oi, "1h")
    A = bt.fine_from(m5)
    cs = ss.candidates(F, "vwap_reclaim", 1, {"regime": "any", "a": 1.0, "b": 2.0})
    M = bt.Market(A, *NOF, {"1h": F})
    tr = bt.run_trades(M, cs)
    x = tr[len(tr) // 2]
    k = int(np.searchsorted(A.t, x["exit_t"])) + 1
    B = sim.Fine(A.t, A.o.copy(), A.h.copy(), A.l.copy(), A.c.copy(), 300)
    B.h[k:] *= 3
    B.l[k:] *= 0.3
    tr2 = bt.run_trades(bt.Market(B, *NOF, {"1h": F}), [c for c in cs if c.i <= x["i"]])
    assert tr2[-1]["r"] == x["r"] and tr2[-1]["exit_t"] == x["exit_t"]


def test_periods_do_not_overlap():
    assert bt.DEV_END == bt.HOLDOUT_START < bt.FREEZE
    assert max(bt.year_start(y + 1) for y in bt.WF_YEARS) <= bt.DEV_END


def test_params_chosen_only_from_past():
    tr = [{"r": -1.0, "exit_t": 100} for _ in range(25)] + [{"r": 5.0, "exit_t": 900} for _ in range(25)]
    other = [{"r": 0.1, "exit_t": 100} for _ in range(25)]
    p, _ = bt.pick_params([({"x": 1}, tr), ({"x": 2}, other)], until=500)
    assert p == {"x": 2}


def meta_frame(n=1600, seed=2):
    rng = np.random.default_rng(seed)
    t = 1_600_000_000 + np.arange(n) * 40000
    d = {k: rng.normal(size=n) for k in sm.FEATS}
    df = pd.DataFrame(d)
    df["t"], df["exit_t"] = t, t + 200000
    df["y"] = (rng.uniform(size=n) < 1 / (1 + np.exp(-df["adx"]))).astype(int)
    df["r"], df["key"] = rng.normal(size=n), "k"
    df["risk_pct"], df["tp1_r"] = 1.0, 1.5
    return df.sort_values("t").reset_index(drop=True)


def test_meta_model_only_learns_from_closed_outcomes():
    df = meta_frame()
    start = int(df["t"].iloc[900] // 86400 * 86400)
    end = int(df["t"].iloc[-1]) + 1
    o1 = sm.walk_forward(df, start, end)
    assert len(o1)
    qs = sm.quarters(start, end)
    a = qs[1]
    late = df.copy()
    # cambio gli esiti di tutto ciò che esce dopo il secondo riaddestramento: le previsioni del trimestre prima non possono cambiare
    mask = late["exit_t"] >= a
    late.loc[mask, "y"] = 1 - late.loc[mask, "y"]
    o2 = sm.walk_forward(late, start, end)
    x1 = o1[o1["t"] < a]["p"].to_numpy()
    x2 = o2[o2["t"] < a]["p"].to_numpy()
    assert len(x1) and np.array_equal(x1, x2)


def test_meta_daily_context_is_the_previous_closed_day():
    idx = pd.date_range("2024-01-01", periods=5, freq="D")
    ctx = pd.DataFrame({"mayer": [1.0, 2.0, 3.0, 4.0, 5.0]}, index=idx)
    m5, sp, fund, oi = synth(8000)
    F = ss.build_frame(m5, sp, fund, oi, "1h")
    close_t = int(pd.Timestamp("2024-01-03 12:00", tz="UTC").timestamp())
    x = sm.row(F, 300, "sweep", 1, 1.0, 1.0, 1.0, 2.0, ctx, close_t)
    assert x["mayer"] == 2.0      # il 3 gennaio si conosce solo il giorno chiuso del 2


def test_meta_keep_rule():
    good = {"n": 500, "kept": 200, "delta": 0.2, "delta_ci": [0.05, 0.3], "filtered_mean_r": 0.1, "ece": 3.0}
    assert sm.keep(good, good) == (True, "passed")
    assert sm.keep(dict(good, delta=-0.1), good)[1] == "dev_no_gain"
    assert sm.keep(good, dict(good, delta_ci=[-0.1, 0.3]))[1] == "holdout_gain_uncertain"
    assert sm.keep(good, dict(good, ece=7.0))[1] == "not_calibrated"


# ------------------------------------------------------------------ verdetti

def row(wn=100, wr=0.2, hn=100, hr=0.2, ci=(0.05, 0.4), q=0.01, years=((2024, 40, 0.2), (2025, 40, 0.2), (2026, 20, 0.1))):
    return {"wf": {"n": wn, "mean_r": wr}, "holdout": {"n": hn, "mean_r": hr, "ci": list(ci), "q": q, "by_year": [{"year": y, "n": n, "mean_r": m} for y, n, m in years]}}


def test_verdict_needs_every_check():
    assert bt.verdict(row()) == ("validated", "passed")
    assert bt.verdict(row(wn=10)) == ("experimental", "dev_small")
    assert bt.verdict(row(wr=-0.1)) == ("experimental", "dev_negative")
    assert bt.verdict(row(hn=10)) == ("experimental", "holdout_small")
    assert bt.verdict(row(hr=-0.1)) == ("experimental", "holdout_negative")
    assert bt.verdict(row(ci=(-0.1, 0.4))) == ("experimental", "ci_includes_zero")
    assert bt.verdict(row(q=0.2)) == ("experimental", "not_significant")
    assert bt.verdict(row(years=((2024, 40, 0.5), (2025, 40, -0.2), (2026, 20, -0.1)))) == ("experimental", "unstable")


def test_tiers():
    assert sg.tier_of(None) == "off"
    assert sg.tier_of(dict(row(), verdict="validated")) == "validated"
    assert sg.tier_of(dict(row(wr=-0.2, hr=0.1), verdict="experimental")) == "experimental"
    assert sg.tier_of(dict(row(wr=-0.2, hr=-0.1), verdict="experimental")) == "off"
    assert sg.tier_of(dict(row(wr=0.2, hr=-0.4), verdict="experimental", setup="band_revert", tf="15m", side="short")) == "off"
    assert sg.tier_of(dict(row(wn=5, hn=5), verdict="experimental")) == "off"


def test_random_baseline_p_value():
    rng = np.random.default_rng(1)
    pool = rng.normal(0, 1, 5000)
    assert bt.p_random(2.0, 50, pool, rng) < 0.01
    assert bt.p_random(0.0, 50, pool, rng) > 0.2
    assert bt.p_random(2.0, 3, pool, rng) is None


# ------------------------------------------------------------------ emissione

def make_frame(n=300, tf="1h"):
    z = np.full(n, 100.0)
    return ss.Frame(tf, np.arange(n) * ss.TF_S[tf], z, z + 1, z - 1, z, z * 0 + 1, z, z, z, np.zeros(n, np.int8), z * 0 + 0.5, z, z * 0 + 1, z, z, z * 0, z * 0, z * 0)


def with_candidates(found, tiers, fn):
    old_c, old_v, old_f = ss.candidates, sg.verdicts, dict(ss.FROZEN)
    ss.candidates = lambda F, setup, side, p: found.get((setup, side), [])
    sg.verdicts = lambda: tiers
    ss.FROZEN.clear()
    ss.FROZEN.update({k: {} for k in tiers})
    try:
        return fn()
    finally:
        ss.candidates, sg.verdicts = old_c, old_v
        ss.FROZEN.clear()
        ss.FROZEN.update(old_f)


def cand(F, setup, side=1):
    i = len(F.t) - 1
    return ss.Cand(i, F.tf, setup, side, "market", 100.0, 100.0 - side, 100.0 + side, 100.0 + 2 * side, None, [], {})


EXP = dict(row(wr=0.1, hr=-0.1), verdict="experimental", reason="holdout_negative")
VAL = dict(row(), verdict="validated", reason="passed")


def test_one_signal_per_family_and_direction():
    F = make_frame()
    close_t = int(F.t[-1]) + 3600
    found = {("sweep", 1): [cand(F, "sweep")], ("cvd_div", 1): [cand(F, "cvd_div")], ("sweep", -1): [cand(F, "sweep", -1)]}
    tiers = {"sweep|1h|long": EXP, "cvd_div|1h|long": EXP, "sweep|1h|short": EXP}
    out = with_candidates(found, tiers, lambda: sg.emit_for("1h", close_t, F, {}))
    assert sorted((e["data"]["side"]) for e in out) == ["long", "short"]


def test_no_duplicate_when_slot_is_taken():
    F = make_frame()
    close_t = int(F.t[-1]) + 3600
    busy = {"x": {"family": "low", "side": "long", "status": "active", "tier": "experimental", "id": "x"}}
    out = with_candidates({("sweep", 1): [cand(F, "sweep")]}, {"sweep|1h|long": EXP}, lambda: sg.emit_for("1h", close_t, F, busy))
    assert out == []


def test_validated_replaces_pending_experimental_only():
    F = make_frame()
    close_t = int(F.t[-1]) + 3600
    pend = {"x": {"family": "low", "side": "long", "status": "pending", "tier": "experimental", "id": "x"}}
    out = with_candidates({("sweep", 1): [cand(F, "sweep")]}, {"sweep|1h|long": VAL}, lambda: sg.emit_for("1h", close_t, F, pend))
    assert [e["type"] for e in out] == ["canceled", "emitted"]
    act = {"x": {"family": "low", "side": "long", "status": "active", "tier": "experimental", "id": "x"}}
    out = with_candidates({("sweep", 1): [cand(F, "sweep")]}, {"sweep|1h|long": VAL}, lambda: sg.emit_for("1h", close_t, F, act))
    assert out == []


def test_disabled_setup_does_not_emit():
    F = make_frame()
    close_t = int(F.t[-1]) + 3600
    off = dict(row(wr=-0.2, hr=-0.1), verdict="experimental", reason="dev_negative")
    assert with_candidates({("sweep", 1): [cand(F, "sweep")]}, {"sweep|1h|long": off}, lambda: sg.emit_for("1h", close_t, F, {})) == []


def test_only_last_closed_candle_emits():
    F = make_frame()
    close_t = int(F.t[-1]) + 3600
    c = cand(F, "sweep")
    c.i -= 1
    assert with_candidates({("sweep", 1): [c]}, {"sweep|1h|long": EXP}, lambda: sg.emit_for("1h", close_t, F, {})) == []
    assert with_candidates({("sweep", 1): [cand(F, "sweep")]}, {"sweep|1h|long": EXP}, lambda: sg.emit_for("1h", close_t + 3600, F, {})) is None


def test_agent_publishes_alerts_and_invalidation():
    import asyncio
    from app import alerts
    from app.agents import engine
    fresh_registry()
    sg.append([emitted(comment=None)])
    sent, pushed = [], []

    async def fake_emit(key, cd, al):
        sent.append((key, al))

    async def fake_push(msg):
        pushed.append(msg)

    old = alerts.emit, engine._ws_push, sg.comment_async
    alerts.emit, engine._ws_push, sg.comment_async = fake_emit, fake_push, lambda i: None
    try:
        a = engine.SignalsAgent("signals", "Segnali", 15)
        ev = {"written": [{"sig": "a-1", "type": "emitted", "data": "{}"}, {"sig": "a-1", "type": "sl", "price": 99.0, "data": {"r": -1.14}}]}
        asyncio.run(a._on_tick({"signals": {"written": [dict(ev["written"][0], data={}), ev["written"][1]]}}))
    finally:
        alerts.emit, engine._ws_push, sg.comment_async = old
    assert [k for k, _ in sent] == ["signal:a-1:emitted", "signal:a-1:sl"]
    assert all(x["category"] == "signals" and x["link"] == "/segnali" for _, x in sent)
    assert sent[0][1]["severity"] == "info" and "sperimentale" in sent[0][1]["title"]
    assert pushed and pushed[0]["keys"] == ["/signals"]
    assert a.findings[0]["tone"] == "neutral"
    engine.bus.agents.clear()
    assert any("signals." in s for x in engine.build_team() if x.id == "analyst" for s in x.subscribes)


def test_every_frozen_hypothesis_is_in_the_grid():
    for s, d in ss.SETUPS.items():
        for tf in d["tfs"]:
            for side in (1, -1):
                assert ss.FROZEN[ss.hyp_key(s, tf, side)] in d["grid"]
    assert len(ss.FROZEN) == len(bt.hypotheses())


# ------------------------------------------------------------------ LLM

SIG = {"id": "x", "setup": "sweep", "tf": "1h", "side": "long", "entry": 80000.0, "sl": 79000.0, "tp1": 81000.0, "tp2": 82000.0, "inv": None, "rr1": 1.0, "rr2": 2.0,
       "risk_pct": 1.25, "tier": "experimental", "reasons": [{"k": "sweep", "v": {"level": 79500.0}}], "context": {"atr": 400.0}}


def test_llm_comment_with_known_numbers_is_kept():
    txt = "Sweep sotto $79,500 con rientro: lo stop è a $79,000 e il primo target a $81,000."
    assert sg.comment_text(SIG, lambda *a, **k: txt) == txt


def test_llm_comment_with_invented_number_is_dropped():
    assert sg.comment_text(SIG, lambda *a, **k: "Target realistico a $95,300.") is None


def test_llm_cannot_touch_the_signal():
    fresh_registry()
    sg.append([emitted()])
    sg.append([{"sig": "a-1", "type": "comment", "time": 5, "data": {"text": "Commento", "entry": 1.0, "sl": 2.0}}])
    s = sg.fold()["a-1"]
    assert s["comment"] == "Commento" and s["entry"] == 100.0 and s["sl"] == 99.0 and s["status"] == "pending"


def test_anchored_vwap_matches_definition():
    t = np.arange(10) * 300 + 345600     # lunedì 5 gen 1970
    h, l, c, v = np.arange(10.0) + 2, np.arange(10.0), np.arange(10.0) + 1, np.arange(10.0) + 1
    vw, sd = ss.anchored_vwap(t, h, l, c, v, "w")
    tp = (h + l + c) / 3
    assert abs(vw[-1] - (tp * v).sum() / v.sum()) < 1e-9
    assert abs(sd[-1] - np.sqrt((v * tp ** 2).sum() / v.sum() - vw[-1] ** 2)) < 1e-9


def test_anchor_resets_on_monday():
    mon = int(pd.Timestamp("2024-01-08", tz="UTC").timestamp())
    k = ss.anchor_key(np.array([mon - 1, mon, mon + 6 * 86400 + 86399, mon + 7 * 86400]), "w")
    assert k[0] != k[1] and k[1] == k[2] and k[2] != k[3]
    q = ss.anchor_key(np.array([int(pd.Timestamp("2024-03-31 23:00", tz="UTC").timestamp()), int(pd.Timestamp("2024-04-01", tz="UTC").timestamp())]), "q")
    assert q[0] != q[1]


if __name__ == "__main__":
    fns = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    for f in fns:
        f()
        print("ok", f.__name__)
    print(f"{len(fns)} test superati")
