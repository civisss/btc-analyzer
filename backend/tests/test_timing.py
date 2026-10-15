"""Test della sezione Timing (Gann · Wyckoff · ritmi): regole su casi sintetici e assenza di dati futuri nei backtest.

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_timing.py
Usa solo dati sintetici e i parquet su disco (BTC_DATA_DIR o backend/data), nessuna chiamata di rete.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis import timing_gann as tg  # noqa: E402
from app.analysis import timing_rhythms as trh  # noqa: E402
from app.analysis import timing_wyckoff as tw  # noqa: E402
from app.analysis.timepivots import DailyGrid  # noqa: E402


# ======================================================== Wyckoff: casi sintetici

def _bar(o, h, l, c, v):
    return {"open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v)}


def synthetic_accumulation() -> pd.DataFrame:
    """Ribasso → SC su volume → AR → ST → fase B → Spring → Test → SOS su volume → LPS → markup."""
    rows = []
    prev = 100.0
    for i in range(70):                                   # ribasso regolare 100 → 70
        c = 100 - 30 * (i + 1) / 70
        rows.append(_bar(prev, max(prev, c) + 0.5, min(prev, c) - 0.5, c, 100))
        prev = c
    rows.append(_bar(70, 70.3, 64, 67, 400))               # 70: SC (nuovo minimo, volume ×4)
    for c in (68, 69.5, 71, 72):                           # 71–74: AR (massimo 72.5 alla barra 74)
        rows.append(_bar(prev, c + 0.5, prev - 0.3, c, 120)); prev = c
    for c in (71, 70):                                     # 75–76: conferma dell'AR (frattale)
        rows.append(_bar(prev, prev + 0.2, c - 0.5, c, 100)); prev = c
    for c in (69, 68, 67, 66.5):                           # 77–80: discesa verso lo SC (ST alla barra 80, volume basso)
        rows.append(_bar(prev, prev + 0.2, c - 1.0, c, 80)); prev = c
    rows.append(_bar(66.5, 67.5, 66.6, 67, 80)); prev = 67   # 81: uscita dalla zona → ST confermato, fase B
    for k in range(14):                                    # 82–95: fase B dentro il range
        c = 68 if k % 2 == 0 else 70
        rows.append(_bar(prev, c + 0.7, min(prev, c) - 0.3, c, 90)); prev = c
    rows.append(_bar(prev, prev + 0.2, 63, 65, 150)); prev = 65   # 96: Spring (minimo 63 sotto 64, chiusura dentro)
    rows.append(_bar(65, 66.5, 64.8, 66, 70)); prev = 66          # 97: test (minimo più alto, volume minore)
    rows.append(_bar(66, 67.2, 66.5, 67, 80)); prev = 67          # 98: uscita dalla zona → Test confermato
    for c in (67.5, 68.5, 69.5, 70.5, 71.5, 72):                  # 99–104: salita verso il bordo
        rows.append(_bar(prev, c + 0.4, prev - 0.2, c, 100)); prev = c
    rows.append(_bar(72, 75, 71.8, 74.5, 250)); prev = 74.5       # 105: SOS (chiusura sopra 72.5, volume ×2.5)
    for c in (76, 75, 74, 75, 76.5):                              # 106–110: pullback e LPS (minimo 73.5 alla barra 108)
        rows.append(_bar(prev, c + 0.5, c - 0.5, c, 110)); prev = c
    for c in (78, 79, 80):                                        # 111–113: uscita (fase E)
        rows.append(_bar(prev, c + 0.5, prev - 0.2, c, 130)); prev = c
    df = pd.DataFrame(rows)
    df.insert(0, "time", pd.date_range("2020-01-01", periods=len(df), freq="D", tz="UTC"))
    return df


def mirror(df: pd.DataFrame, k: float = 200.0) -> pd.DataFrame:
    """Specchio dei prezzi (k − p): un'accumulazione diventa una distribuzione con le stesse proporzioni."""
    out = df.copy()
    out["open"], out["close"] = k - df["open"], k - df["close"]
    out["high"], out["low"] = k - df["low"], k - df["high"]
    return out


def _keys(r):
    return [e["key"] for e in r["events"]]


def test_wyckoff_accumulation_rules():
    df = synthetic_accumulation()
    rs = tw.detect(df, "1d")
    acc = [r for r in rs if r["side"] == "acc"]
    assert len(acc) == 1, rs
    r = acc[0]
    ks = _keys(r)
    for need in ("SC", "AR_A", "ST_A", "SPRING", "TEST", "SOS", "LPS"):
        assert need in ks, (need, ks)
    order = [ks.index(k) for k in ("SC", "AR_A", "ST_A", "SPRING", "TEST", "SOS", "LPS")]
    assert order == sorted(order), ks
    ev = {e["key"]: e for e in r["events"]}
    assert ev["SC"]["i"] == 70 and abs(ev["SC"]["price"] - 64) < 1e-9
    assert ev["AR_A"]["i"] == 74 and ev["AR_A"]["ci"] == 76            # AR confermato 2 candele dopo il massimo
    assert ev["SPRING"]["i"] == 96 and ev["SPRING"]["phase"] == "B"    # lo Spring nasce in fase B e porta in C
    assert ev["SOS"]["i"] == 105
    assert ev["LPS"]["i"] == 108 and ev["LPS"]["ci"] == 110
    assert abs(r["H"] - 72.5) < 1e-9 and abs(r["L"] - 64) < 1e-9
    assert r["status"] == "up" and r["phase"] == "E"
    for e in r["events"]:
        assert e["ci"] >= e["i"], e                                    # mai confermato prima di essersi formato


def test_wyckoff_distribution_mirror():
    df = mirror(synthetic_accumulation())
    rs = tw.detect(df, "1d")
    dist = [r for r in rs if r["side"] == "dist"]
    assert len(dist) == 1, rs
    ks = _keys(dist[0])
    for need in ("BC", "AR_D", "ST_D", "SOW", "LPSY"):
        assert need in ks, (need, ks)
    assert "UTAD" in ks or "UT" in ks, ks
    assert dist[0]["status"] == "down"


def test_wyckoff_failed_range():
    """Rottura al ribasso con due chiusure sotto il range dopo la fase B: range fallito, nessun SOS."""
    df = synthetic_accumulation().iloc[:96].copy()
    rows = df.to_dict("records")
    t = rows[-1]["time"]
    prev = rows[-1]["close"]
    for c in (63.0, 62.0, 61.0, 60.0, 59.0):
        t = t + pd.Timedelta(days=1)
        rows.append({"time": t, **_bar(prev, prev + 0.2, c - 0.5, c, 120)})
        prev = c
    rs = tw.detect(pd.DataFrame(rows), "1d")
    r = [x for x in rs if x["side"] == "acc"][0]
    assert r["status"] == "failed" and _keys(r)[-1] == "BRK_DN", _keys(r)
    assert "SOS" not in _keys(r)


def _real(name: str) -> pd.DataFrame | None:
    try:
        from app.data import store
        df = store.get(name)[["time", "open", "high", "low", "close", "volume"]].dropna().reset_index(drop=True)
        return df if len(df) > 500 else None
    except Exception:  # noqa: BLE001
        return None


def test_wyckoff_no_lookahead():
    """La macchina a stati è causale: tagliando lo storico a m candele, gli eventi confermati prima di m sono identici."""
    df = _real("k_1d")
    if df is None:
        df = pd.concat([synthetic_accumulation()] * 1, ignore_index=True)
    full = tw.detect(df, "1d")
    fe = sorted((e["key"], e["i"], e["ci"]) for r in full for e in r["events"])
    for m in np.linspace(300, len(df) - 1, 9).astype(int):
        part = tw.detect(df.iloc[:m].reset_index(drop=True), "1d")
        pe = sorted((e["key"], e["i"], e["ci"]) for r in part for e in r["events"])
        assert pe == [x for x in fe if x[2] < m], f"eventi diversi tagliando a {m}"


def test_wyckoff_backtest_uses_confirmation():
    """Il backtest misura i rendimenti dalla chiusura della candela di conferma: rendimenti noti a mano."""
    df = synthetic_accumulation()
    rs = tw.detect(df, "1d")
    bt = tw.backtest([(df, rs)], "1d")
    sos = next(r for r in bt["rows"] if r["key"] == "SOS")
    h5 = next(h for h in sos["horizons"] if h["days"] == 5)
    c = df["close"].to_numpy()
    ci = next(e["ci"] for r in rs for e in r["events"] if e["key"] == "SOS")
    assert abs(h5["mean"] - round((c[ci + 5] / c[ci] - 1) * 100, 2)) < 0.011


# ======================================================== Gann

def _grid_from(df: pd.DataFrame) -> DailyGrid:
    d = df.set_index(pd.DatetimeIndex(df["time"]).normalize())[["high", "low", "close"]]
    return DailyGrid(d)


def test_sq9_cross_numbers():
    xs = tg._sq9_cross(1, 200)
    for v in (2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 15, 17, 19, 21, 23, 25, 28, 31, 34, 37, 40, 43, 46, 49):
        assert v in xs, v
    assert xs == sorted(xs) and 10 not in xs and 12 not in xs


def test_gann_no_lookahead():
    """Ancore: tagliando lo storico, i pivot confermati prima del taglio sono identici; ogni proiezione inizia dopo la conferma."""
    df = _real("k_1d")
    if df is None:
        rng = np.random.default_rng(1)
        c = 100 * np.exp(np.cumsum(rng.normal(0, 0.03, 2000)))
        df = pd.DataFrame({"time": pd.date_range("2015-01-01", periods=2000, freq="D", tz="UTC"), "open": c, "high": c * 1.02, "low": c * 0.98, "close": c, "volume": 1.0})
    g = _grid_from(df)
    full = tg.anchors(g)
    for m in np.linspace(400, g.last, 6).astype(int):
        gp = _grid_from(df.iloc[:m])
        part = tg.anchors(gp)
        assert [(a["i"], a["ci"]) for a in part] == [(a["i"], a["ci"]) for a in full if a["ci"] < m], m
    w = 2
    for tid, cfg in tg.COUNT_TYPES.items():
        if tid == "seasonal":
            continue
        for ai, k, p in tg._proj_pairs(full, cfg["days"], w, 0, g.last):
            assert p - w > full[ai]["ci"]
    # punteggio "futuro": con known_at contano solo le ancore già confermate
    k_at = full[len(full) // 2]["ci"]
    S1, _ = tg.score_series([a for a in full if a["ci"] <= k_at], g, w, 0, g.last)
    S2, _ = tg.score_series(full, g, w, 0, g.last, known_at=k_at)
    assert np.array_equal(S1, S2)


def test_gann_backtest_hit_rate():
    """Hit rate = quota di date proiettate con un pivot frattale entro ±W, verificata a mano."""
    df = _real("k_1d")
    if df is None:
        return
    g = _grid_from(df)
    hv = tg.heavy(g, 10, 2)
    row = next(r for r in hv["rows"] if r["id"] == "c90")
    q = tg.projections(hv["anc"], [90], 2, hv["lo"], hv["hi"])
    ph, pl = tg.targets(g, 10)
    tgt = ph | pl
    manual = np.mean([tgt[max(0, p - 2):p + 3].any() for p in q]) * 100
    assert abs(row["hit_rate"] - round(manual, 1)) < 0.051
    assert row["n"] == len(q)


# ======================================================== ritmi

def test_rhythm_match_close_and_extremes():
    O = np.array([100.0, 100.0])
    segs = [(np.array([110, 101.0]), np.array([99, 95.0]), np.array([105, 96.0])),
            (np.array([106, 99.0]), np.array([95, 90.0]), np.array([97, 92.0])),
            (np.array([104, 99.0]), np.array([96, 91.0]), np.array([103, 98.0]))]
    assert list(trh.match(O, segs, "+-+", "close", 0)) == [True, False]          # 105 > 100, 97 < 105, 103 > 97
    # estremi θ = 3%: 110 ≥ 103 ✓, 95 ≤ 110·0.97 ✓, 104 ≥ 95·1.03 = 97.85 ✓ · seconda: 101 < 103 ✗
    assert list(trh.match(O, segs, "+-+", "extremes", 3)) == [True, False]
    assert list(trh.match(O, segs, "+.+", "close", 0)) == [True, False]


def test_rhythm_null_random_walk():
    """Su una passeggiata casuale simmetrica lo schema +−+ a chiusure è atteso nel ~12.5% delle finestre."""
    rng = np.random.default_rng(7)
    n = 6000
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
    df = pd.DataFrame({"time": pd.date_range("2005-01-01", periods=n, freq="D", tz="UTC"), "high": c * 1.01, "low": c * 0.99, "close": c})
    g = _grid_from(df)
    p0, nw = trh._sliding_null(g, 1, g.last, "+-+", "close", 0)
    assert nw > 5000 and abs(p0 - 0.125) < 0.02, p0


def test_rhythm_months_use_only_completed_segments():
    rng = np.random.default_rng(3)
    n = 800
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
    df = pd.DataFrame({"time": pd.date_range("2024-01-01", periods=n, freq="D", tz="UTC"), "high": c * 1.01, "low": c * 0.99, "close": c})
    g = _grid_from(df)
    today = g.idx[-1] + pd.Timedelta(hours=12)
    months = trh._month_frame(g, pd.Timestamp("2024-02-01", tz="UTC"), today)
    last = months[-1]
    for sg in last["segs"]:
        assert sg is None or sg["end"] < today.normalize()
    assert all(m["complete"] for m in months[:-1])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
