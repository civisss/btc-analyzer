"""Test del Superchart e delle anomalie: allineamento delle serie, assenza di look-ahead in replay e nelle anomalie,
validazione e persistenza dei layout.

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_superchart.py
Usa dati sintetici e i parquet su disco (BTC_DATA_DIR o backend/data). Per non toccare i dati utente, i layout sono
scritti in una cartella temporanea (USER_DATA_DIR impostata qui se assente).
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("USER_DATA_DIR", tempfile.mkdtemp(prefix="sc_user_"))

from app.analysis import anomalies as an  # noqa: E402
from app.analysis import superchart as sc  # noqa: E402

H = 3600
DAY = 86400


def _grid(n: int, step: int = H, t0: int = 1_700_000_000 // DAY * DAY) -> sc.Grid:
    t = t0 + np.arange(n, dtype=np.int64) * step
    one = np.ones(n)
    return sc.Grid("1h" if step == H else "1d", step, t, t + step, one, one, one, one, one, one * np.nan)


# ======================================================== allineamento

def test_align_last_respects_availability():
    g = _grid(72)                                   # 3 giorni di candele orarie
    d0 = int(g.t[0])
    nat = sc._nat([d0, d0 + DAY], {"x": [1.0, 2.0]}, DAY, "last", DAY)   # giornaliera: D disponibile a D+1 00:00
    cols, obs = sc.align(nat, g)
    x = cols["x"]
    # il valore del giorno 0 compare solo sulla candela che chiude alle 00:00 del giorno 1 (indice 23)
    assert np.isnan(x[:23]).all()
    assert x[23] == 1.0 and (x[23:47] == 1.0).all()
    assert x[47] == 2.0 and obs[47] == d0 + DAY
    # nessun valore mostrato prima della sua disponibilità
    av = obs[np.isfinite(x)] + DAY
    assert (av <= g.close[np.isfinite(x)]).all()


def test_align_stale_and_sum():
    g = _grid(24 * 10)
    d0 = int(g.t[0])
    nat = sc._nat([d0], {"x": [5.0]}, DAY, "last", DAY, stale=2 * DAY)
    x = sc.align(nat, g)[0]["x"]
    ok = np.flatnonzero(np.isfinite(x))
    assert g.close[ok[-1]] - (d0 + DAY) <= 2 * DAY and np.isnan(x[ok[-1] + 1:]).all()
    # flussi: ogni valore in UNA sola candela (quella in cui diventa disponibile), mai ripetuto
    ev = sc._nat([d0 + 10, d0 + 20, d0 + 4000], {"s": [1.0, 2.0, 4.0]}, 0, "sum", 0, fill0=True)
    s = sc.align(ev, g)[0]["s"]
    assert s[0] == 3.0 and s[1] == 4.0 and s[2] == 0.0 and np.nansum(s) == 7.0


def test_align_mean_finer_and_coarser():
    g = _grid(8, step=4 * H)
    d0 = int(g.t[0])
    pts = d0 + np.arange(32, dtype=np.int64) * H
    nat = sc._nat(pts, {"f": np.arange(32, dtype=float)}, H, "mean", H)       # orario su candele 4h: media nella candela
    f = sc.align(nat, g)[0]["f"]
    # candela 0 = (t0, t0+4h]: disponibili le ore 0,1,2,3 (avail = ora+1h) → media 1.5
    assert f[0] == 1.5


# ======================================================== z robusto: nessun look-ahead

def test_robust_z_is_causal():
    rng = np.random.default_rng(1)
    y = rng.standard_t(3, 3000)
    z_full = an.robust_z(y, 90)
    for k in (200, 1000, 2500):
        z_cut = an.robust_z(y[:k], 90)
        assert np.allclose(z_full[:k], z_cut, equal_nan=True)
        y2 = y.copy()
        y2[k:] = 1e6                                 # futuro alterato: il passato non cambia
        assert np.allclose(an.robust_z(y2, 90)[:k], z_full[:k], equal_nan=True)


def test_decluster_gap():
    t = np.arange(20, dtype=np.int64) * DAY
    z = np.zeros(20)
    z[[2, 3, 4, 12]] = 4.0
    z[5] = -4.0
    idx = an.decluster(t, z, 3.0, 7 * DAY)
    assert list(idx) == [2, 5, 12]


def test_entry_after_publication():
    ct = np.arange(10, dtype=np.int64) * DAY
    assert list(an._entry_idx(np.array([0, 3 * DAY]), ct, DAY)) == [0, 3]              # completo a D+1: chiusura di D
    assert list(an._entry_idx(np.array([0]), ct, DAY + 12 * 3600)) == [1]              # ETF: chiusura di D+1
    assert list(an._entry_idx(np.array([0]), ct, 2 * DAY)) == [1]                      # on-chain T+1


def test_bh():
    q = an.bh([0.01, 0.04, 0.03, None, 0.5])
    assert q[3] is None and abs(q[0] - 0.04) < 1e-12 and q[4] == 0.5 and q[1] == q[2]


# ======================================================== replay su dati reali: nessun look-ahead

REPLAY_IDS = ["vwap", "rsi", "macd", "volume", "cvd_spot", "funding_binance", "funding_agg", "oi_agg", "liquidations",
              "cb_premium", "basis", "etf_flows", "exch_reserve", "exch_netflow", "mvrv", "sopr_sth", "mvrv_holders",
              "fng", "usdt_dom", "stables", "dxy"]


def _same(a: np.ndarray, b: np.ndarray) -> bool:
    return np.allclose(a, b, equal_nan=True, rtol=1e-9, atol=1e-12)


def _check_replay(tf: str, asof: int, ids: list[str]) -> int:
    full = sc.grid(tf)
    cut = sc.grid(tf, asof)
    k = len(cut.t)
    assert k > 50
    assert (cut.t + cut.step <= asof).all(), "candela non ancora chiusa in replay"
    assert (full.t[:k] == cut.t).all()
    checked = 0
    for sid in ids:
        try:
            g_full, c_full = sc.compute(sid, tf, None)
            g_cut, c_cut = sc.compute(sid, tf, asof)
        except Exception as e:  # noqa: BLE001
            print(f"  (salto {sid}: dati non disponibili: {e})")
            continue
        assert len(g_cut.t) == k
        for col, v in c_cut.cols.items():
            assert _same(v, c_full.cols[col][:k]), f"{sid}.{col}: replay ≠ storico troncato ({tf}, asof {asof})"
        if c_cut.obs is not None:
            o = c_cut.obs[c_cut.obs >= 0]
            assert (o <= asof).all(), f"{sid}: osservazione successiva alla data di replay"
        # anomalie: quelle visibili in replay sono identiche a quelle dello storico completo fino alla candela k
        a_full = [a for a in c_full.anomalies if a[0] < k]
        a_cut = c_cut.anomalies
        assert [a[0] for a in a_cut] == [a[0] for a in a_full], f"{sid}: anomalie diverse in replay"
        assert all(abs(x[1] - y[1]) < 1e-9 for x, y in zip(a_cut, a_full))
        assert all(a[5] <= asof for a in a_cut)
        checked += 1
    return checked


def test_replay_no_lookahead_1h():
    now = int(time.time())
    for asof in (now - 400 * DAY, now - 12 * DAY + 1234):
        assert _check_replay("1h", asof, REPLAY_IDS) >= 10


def test_replay_no_lookahead_1d_4h_15m():
    now = int(time.time())
    assert _check_replay("1d", now - 900 * DAY, REPLAY_IDS) >= 10
    assert _check_replay("4h", now - 60 * DAY, ["vwap", "funding_binance", "oi_binance", "cvd_perp", "etf_flows", "spx"]) >= 4
    assert _check_replay("15m", now - 20 * DAY, ["vwap", "rsi", "cvd_perp", "oi_binance", "ls_ratio", "funding_binance"]) >= 4


def test_series_payload_shapes():
    g, c = sc.compute("liquidations", "1h")
    i0, i1 = sc.window(g, 5000, None)
    p = sc.series_payload(sc.IND["liquidations"], c, i0, i1)
    assert set(p["cols"]) == {"long", "short"} and all(len(v) == i1 - i0 for v in p["cols"].values())
    g, c = sc.compute("cvd_spot", "1h")
    p = sc.series_payload(sc.IND["cvd_spot"], c, i0, i1)
    assert "v" not in p["cols"]


# ======================================================== layout

def test_layouts_roundtrip():
    from app import superchart_layouts as L
    st = {"tf": "1h", "log": True, "panes": [{"id": "funding_binance", "h": 2000, "an": True}, {"id": "vwap", "h": 50}]}
    it = L.create("  Mio   layout ", st)
    assert it["name"] == "Mio layout" and it["state"]["panes"][0]["h"] == 600 and it["state"]["panes"][1]["ov"] is True
    assert L.FILE.exists()
    L._items = None                                      # rilettura dal disco
    assert any(x["id"] == it["id"] for x in L.list_layouts())
    up = L.update(it["id"], name="Altro")
    assert up["name"] == "Altro"
    for bad in ({"tf": "2h", "panes": []}, {"tf": "1h", "panes": [{"id": "nope"}]}, {"tf": "1h", "panes": [{"id": "rsi"}, {"id": "rsi"}]}):
        try:
            L.create("x", bad)
            raise AssertionError("stato non valido accettato")
        except L.LayoutError:
            pass
    L.delete(it["id"])
    assert not any(x["id"] == it["id"] for x in L.list_layouts())


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        t0 = time.perf_counter()
        try:
            fn()
            print(f"OK    {fn.__name__} ({(time.perf_counter() - t0) * 1000:.0f} ms)")
        except Exception as e:  # noqa: BLE001
            failed += 1
            import traceback
            traceback.print_exc()
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} test superati")
    sys.exit(1 if failed else 0)
