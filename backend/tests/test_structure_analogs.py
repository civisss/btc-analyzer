"""Test dell'analogia di struttura (Analoghi → Analogia di struttura): regole su casi sintetici e assenza di dati futuri.

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_structure_analogs.py
Usa dati sintetici e i parquet su disco (BTC_DATA_DIR o backend/data), nessuna chiamata di rete obbligatoria.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis import structure_analogs as sa  # noqa: E402
from app.analysis.structure import label_swings, zigzag_breaks, zigzag_confirmed  # noqa: E402


# ======================================================== helpers

def _synthetic(points: list[float], bars_per_leg: int = 10, seed: int = 1) -> dict:
    """Serie a gambe lineari tra i punti dati (con un po' di rumore), OHLC coerente."""
    rng = np.random.default_rng(seed)
    c: list[float] = []
    for a, b in zip(points[:-1], points[1:]):
        c.extend(np.linspace(a, b, bars_per_leg, endpoint=False))
    c.append(points[-1])
    c = np.array(c) * (1 + rng.normal(0, 0.001, len(c)))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) * 1.002
    l = np.minimum(o, c) * 0.998
    n = len(c)
    t = np.arange(n, dtype=np.int64) * 86400 + 1_600_000_000
    return {"time": t, "open": o, "high": h, "low": l, "close": c, "btc": c, "synthetic": False, "is_btc": True,
            "n": n, "step": 86400, "forming": False}


def _cut(S: dict, T: int) -> dict:
    """Serie troncata all'istante T incluso (come se il presente fosse T)."""
    out = {k: (v[: T + 1] if isinstance(v, np.ndarray) else v) for k, v in S.items()}
    out["n"] = T + 1
    out["forming"] = False
    return out


def _series(asset: str, tf: str) -> dict | None:
    try:
        S = sa.load_series(asset, tf)
    except Exception as e:  # noqa: BLE001
        print(f"  (salto {asset} {tf}: {e})")
        return None
    if S["forming"]:          # la candela in formazione non entra nei test di causalità
        S = _cut(S, S["n"] - 2)
    return S


# ======================================================== regole

def test_labels_and_breaks_synthetic():
    # minimo 100 → 130 → 115 (HL) → 150 (HH, rompe 130: BOS rialzista) → 120 (HL) → 140 (LH) → 105 (LL, rompe 120: CHoCH ribassista)
    S = _synthetic([100, 130, 115, 150, 120, 140, 105, 125])
    a = sa.causal_atr(S["high"], S["low"], S["close"])
    piv = label_swings(zigzag_confirmed(S["high"], S["low"], a, 2.0))
    conf = [p for p in piv if p["ci"] is not None]
    labels = [p["label"] for p in conf]
    assert labels[:6] == [None, None, "HL", "HH", "HL", "LH"], labels
    assert labels[6] == "LL", labels
    kinds = [b["kind"] for b in zigzag_breaks(conf, S["close"])]
    assert kinds[0] == "bos_up", kinds          # la prima rottura è nella direzione del movimento
    assert "choch_down" in kinds, kinds         # 105 rompe il minimo 120 dopo una struttura rialzista
    for b in zigzag_breaks(conf, S["close"]):   # la rottura avviene DOPO il pivot rotto, su una chiusura oltre il livello
        assert b["i"] > b["pivot_i"]
        assert (S["close"][b["i"]] > b["level"]) if b["kind"].endswith("up") else (S["close"][b["i"]] < b["level"])


def test_elasticity_synthetic():
    # BTC = k · USDT.D^−2 esattamente: β = −2, R² = 1
    S = _synthetic([7, 6, 6.6, 5.5, 6.2, 5.0, 5.8, 4.6, 5.4, 4.4, 5.1, 4.2, 4.9], bars_per_leg=8)
    S["high"] = S["low"] = S["open"] = S["close"]          # niente ombre: il pivot coincide con la chiusura
    S["btc"] = 1e6 * S["close"] ** -2.0
    S["is_btc"] = False
    P, _, _ = sa.pivots(S, 2.0)
    el = sa.elasticity(S, P, len(P["p"]) - 1)
    assert el is not None
    assert abs(el["beta"] + 2) < 1e-6 and el["r2"] > 0.999 and el["strength"] == "strong", el
    tr = sa.translate(el, 50_000, math.log(0.9), math.log(0.85), math.log(0.95), 1)
    assert abs(tr["price"] - 50_000 * 0.9 ** -2) < 1e-6 and tr["lo"] < tr["price"] < tr["hi"]


def test_pending_constraint():
    # prossimo pivot = massimo: se gli analoghi proiettano meno di quanto già toccato, il pivot è "già raggiunto"
    lr, dt, reached = sa.apply_pending(np.array([0.05, -0.02, 0.07]), np.array([4.0, 9.0, 12.0]), 1, 0.08, 6.0, 7.0)
    assert reached and lr[0] == 0.08 and dt[0] == 6.0 and dt[1] > dt[0]
    lr, dt, reached = sa.apply_pending(np.array([0.10, -0.02, 0.07]), np.array([4.0, 5.0, 12.0]), 1, 0.08, 6.0, 7.0)
    assert not reached and lr[0] == 0.10 and dt[0] >= 8.0 and dt[1] > dt[0]   # non ancora toccato → nel futuro


# ======================================================== assenza di dati futuri

def test_zigzag_point_in_time():
    """I pivot confermati entro T sono identici se calcolati sulla serie intera o su quella troncata a T."""
    for asset, tf in (("btc", "1d"), ("usdtd", "1d")):
        S = _series(asset, tf)
        if S is None:
            continue
        P, _, brk = sa.pivots(S, sa.DEFAULT_MULT[tf])
        for T in np.linspace(400, S["n"] - 1, 7).astype(int):
            Pt, pend_t, brk_t = sa.pivots(_cut(S, int(T)), sa.DEFAULT_MULT[tf])
            known = P["ci"] <= T
            for key in ("i", "ci", "k", "lab"):
                assert np.array_equal(P[key][known], Pt[key]), (asset, T, key)
            assert np.allclose(P["p"][known], Pt["p"])
            assert all(p["ci"] is None for p in [pend_t] if p), "il pivot in formazione non è confermato"
            assert [b for b in brk if b["i"] <= T] == brk_t, (asset, T, "rotture")
            # caratteristiche dell'ultimo pivot noto a T
            K = 5
            F, Ft = sa.features(P, K), sa.features(Pt, K)
            m = len(Pt["p"]) - 1
            if m >= K:
                assert np.allclose(F["namp"][m], Ft["namp"][m]) and np.allclose(F["ndur"][m], Ft["ndur"][m])


def test_backtest_point_in_time():
    """Ogni riga del backtest (proiezione, intervallo calibrato, baseline, traduzione in BTC) non cambia troncando la serie:
    dati e pivot successivi all'istante T non entrano nel calcolo."""
    for asset, tf in (("btc", "1d"), ("usdtd", "1d"), ("ethbtc", "1d")):
        S = _series(asset, tf)
        if S is None:
            continue
        K, top, mult = 5, 5, sa.DEFAULT_MULT[tf]
        P, _, _ = sa.pivots(S, mult)
        full: list[dict] = []
        sa.backtest(S, P, sa.features(P, K), K, top, rows_out=full)
        by_m = {r["m"]: r for r in full}
        cut = int(S["n"] * 0.75)
        St = _cut(S, cut)
        Pt, _, _ = sa.pivots(St, mult)
        part: list[dict] = []
        sa.backtest(St, Pt, sa.features(Pt, K), K, top, rows_out=part)
        assert len(part) > 20, (asset, len(part))
        for r in part:
            assert r["T"] <= cut
            q = by_m[r["m"]]
            for key, v in r.items():
                assert np.isclose(v, q[key], rtol=1e-9, atol=1e-12), (asset, r["m"], key, v, q[key])
        print(f"  {asset} {tf}: {len(part)} istanti identici su {len(full)}")


def test_candidates_never_overlap_present():
    S = _series("btc", "1d")
    if S is None:
        return
    K = 6
    P, _, _ = sa.pivots(S, 2.5)
    F = sa.features(P, K)
    for m in range(K + 20, len(P["p"]), 37):
        js = sa.candidates(F, P, m, K)
        assert np.all(js + sa.H <= m - K)                       # analogo + 3 pivot dopo finiscono prima del tratto attuale
        assert np.all(P["ci"][js + sa.H] <= P["ci"][m])        # e sono già confermati all'istante T = ci[m]
        assert np.all(P["k"][js] == P["k"][m])


def test_api_shape():
    S = _series("btc", "1d")
    if S is None:
        return
    r = sa.compute("btc", "1d", 2.5, 5, 5)
    assert r["current"]["pivots"] and len(r["current"]["pivots"]) == 6
    bt = r["backtest"]
    assert bt["n"] > 30 and bt["verdict"] in ("none", "weak", "strong", "anecdotal")
    for k in ("hit", "cov", "err_med"):
        assert 0 <= bt["model"][k] <= 100 if k != "err_med" else bt["model"][k] >= 0
    if r["projection"]:
        for p in r["projection"]["pivots"]:
            assert p["lo"] <= p["price"] <= p["hi"], p
            assert p["t_lo"] <= p["time"] <= p["t_hi"], p


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"OK   {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
    sys.exit(1 if fails else 0)
