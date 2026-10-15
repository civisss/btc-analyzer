"""Test delle Onde di Elliott: regole su casi sintetici, riconoscimento dei pattern e assenza di dati futuri.

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_elliott.py
Usa dati sintetici e i parquet su disco (BTC_DATA_DIR o backend/data), nessuna chiamata di rete obbligatoria.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis import elliott as el  # noqa: E402
from app.analysis.structure_analogs import causal_atr  # noqa: E402


# ======================================================== helpers

def _synthetic(points: list[float], bars_per_leg: int = 12, seed: int = 3) -> dict:
    """Serie a gambe lineari tra i punti dati (rumore minimo), OHLC coerente, 40 candele piatte iniziali per l'ATR."""
    rng = np.random.default_rng(seed)
    c: list[float] = [points[0]] * 40
    for a, b in zip(points[:-1], points[1:]):
        c.extend(np.linspace(a, b, bars_per_leg, endpoint=False))
    c.append(points[-1])
    c = np.array(c) * (1 + rng.normal(0, 0.0005, len(c)))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) * 1.001
    l = np.minimum(o, c) * 0.999
    n = len(c)
    S = {"time": np.arange(n, dtype=np.int64) * 86400 + 1_500_000_000, "open": o, "high": h, "low": l, "close": c,
         "volume": np.ones(n), "rsi": np.full(n, 50.0), "n": n, "step": 86400, "forming": False}
    S["atr"] = causal_atr(h, l, c)
    return S


def _cands(points: list[float], mult: float = 1.5) -> tuple[list[dict], dict]:
    S = _synthetic(points)
    P = el.pivots(S, mult)
    m = len(P["p"]) - 1
    _, cs = el.evaluate_instant(S, P, m, S["n"] - 1, mult, {}, None)
    return cs, P


def _has(cs: list[dict], pattern: str, k: int, variant: str | None = None) -> bool:
    return any(c["pattern"] == pattern and c["k"] == k and (variant is None or c["variant"] == variant) for c in cs)


# ======================================================== pivot sintetici

def test_synthetic_pivots_match_points():
    pts = [130, 100, 150, 120, 220, 190, 250, 215]
    _, P = _cands(pts)
    got = [round(x) for x in P["p"]]
    # l'ultimo punto è l'estremo in corso (non confermato); i pivot confermati coincidono con i punti interni
    assert got[-6:] == [100, 150, 120, 220, 190, 250], got


# ======================================================== regole dell'impulso

def test_valid_impulse_accepted():
    cs, _ = _cands([130, 100, 150, 120, 220, 190, 250, 215])
    assert _has(cs, "impulse", 5), [(c["pattern"], c["k"]) for c in cs]
    c = next(c for c in cs if c["pattern"] == "impulse" and c["k"] == 5)
    keys = {r["key"] for r in c["rules"]}
    assert {"w2_start", "w3_beyond_w1", "w4_overlap", "w3_shortest"} <= keys
    # invalidazione del conteggio completo: oltre la fine dell'onda 5
    assert c["inv"]["above"] is not None and abs(c["inv"]["above"] - 250) < 2


def test_wave3_shortest_rejected():
    # onda 1 = 50, onda 3 = 40, onda 5 = 70 (in termini percentuali l'onda 3 resta la più corta)
    cs, _ = _cands([130, 100, 150, 120, 160, 140, 230, 200])
    assert not _has(cs, "impulse", 5)


def test_wave4_overlap_rejected():
    # onda 4 (140) entra nel territorio dell'onda 1 (fine 150)
    cs, _ = _cands([130, 100, 150, 120, 220, 140, 250, 215])
    assert not _has(cs, "impulse", 5)


def test_wave2_beyond_start_rejected():
    # onda 2 (95) oltre l'inizio dell'onda 1 (100): niente impulso che parte da 100
    cs, P = _cands([130, 100, 150, 95, 220, 190, 250, 215])
    s100 = int(np.argmin(np.abs(P["p"] - 100)))
    assert not any(c["pattern"] == "impulse" and c["s"] == s100 for c in cs)


def test_wave4_in_progress_invalidation_is_wave1_end():
    # onda 4 in corso: l'invalidazione è la fine dell'onda 1
    cs, _ = _cands([130, 100, 150, 120, 220, 190])
    c = next((c for c in cs if c["pattern"] == "impulse" and c["k"] == 3), None)
    assert c is not None
    assert abs(c["inv"]["below"] - 150) < 2, c["inv"]


def test_wave5_cap_when_wave3_shorter_than_wave1():
    # onda 3 più corta dell'onda 1: l'onda 5 non può superare la lunghezza della 3 (tetto di invalidazione)
    cs, _ = _cands([130, 100, 160, 140, 190, 175, 182])
    c = next((c for c in cs if c["pattern"] == "impulse" and c["k"] == 4), None)
    assert c is not None and c["inv"]["above"] is not None
    assert c["inv"]["above_rule"] == "w3_shortest"


# ======================================================== correzioni

def test_zigzag_recognized():
    cs, _ = _cands([80, 140, 110, 125, 95, 105])
    assert _has(cs, "zigzag", 3), [(c["pattern"], c["k"], c["variant"]) for c in cs]
    assert not _has(cs, "flat", 3)


def test_flat_expanded_recognized():
    cs, _ = _cands([80, 140, 110, 143, 100, 112])
    assert _has(cs, "flat", 3, "expanded"), [(c["pattern"], c["k"], c["variant"]) for c in cs]
    assert not _has(cs, "zigzag", 3)       # B oltre il 100% di A: non può essere uno zigzag


def test_flat_regular_recognized():
    cs, _ = _cands([80, 140, 110, 139, 108, 120])
    assert _has(cs, "flat", 3, "regular"), [(c["pattern"], c["k"], c["variant"]) for c in cs]


def test_triangle_recognized():
    cs, _ = _cands([60, 150, 120, 140, 125, 136, 128, 145])
    assert _has(cs, "triangle", 5), [(c["pattern"], c["k"], c["variant"]) for c in cs]
    c = next(c for c in cs if c["pattern"] == "triangle" and c["k"] == 5)
    assert c["variant"] in ("contracting", "barrier")


def test_triangle_needs_prior_move():
    # nessun movimento precedente più ampio dell'onda A: non può essere un'onda 4/B/X
    cs, _ = _cands([140, 150, 120, 140, 125, 136, 128, 145])
    assert not _has(cs, "triangle", 5)


def test_contracting_triangle_rule():
    # C (115) oltre la fine di A (120): non è un triangolo contraente
    cs, _ = _cands([60, 150, 120, 140, 115, 136, 128, 145])
    assert not any(c["pattern"] == "triangle" and c["k"] == 5 and c["variant"] != "expanding" for c in cs)


# ======================================================== punteggio e obiettivi

def test_targets_and_score_shape():
    cs, _ = _cands([130, 100, 150, 120, 220, 190, 250, 215])
    for c in cs:
        t = c["target"]
        assert t["lo"] <= t["price"] <= t["hi"], (c["pattern"], t)
        assert 0 <= c["score"] <= 100
        for g in c["guides"]:
            assert 0 <= g["score"] <= 1 and g["weight"] > 0


# ======================================================== nessun dato futuro

def _series(tf: str) -> dict | None:
    try:
        S = el.load(tf)
    except Exception as e:  # noqa: BLE001
        print(f"  (salto {tf}: {e})")
        return None
    return el.cut(S, S["n"] - 2) if S["forming"] else S


def test_no_lookahead_candidates():
    """Il conteggio a T calcolato sulla serie intera (backtest) è identico a quello sulla serie troncata a T."""
    S = _series("1d")
    if S is None:
        return
    mult = dict(el.TF_DEGREES["1d"])["intermediate"]
    P = el.pivots(S, mult)
    ms = list(range(20, len(P["p"]) - 2, max(1, len(P["p"]) // 12)))
    for m in ms:
        T = int(P["ci"][m])
        _, full = el.evaluate_instant(S, P, m, T, mult, {}, None)
        Sc = el.cut(S, T)
        Pc = el.pivots(Sc, mult)
        assert len(Pc["p"]) == m + 1, (m, len(Pc["p"]))
        _, part = el.evaluate_instant(Sc, Pc, m, T, mult, {}, None)
        sig = lambda cs: [(c["pattern"], c["variant"], c["k"], round(c["score"], 6), round(c["target"]["price"], 4)) for c in cs]  # noqa: E731
        assert sig(full) == sig(part), m


def test_no_lookahead_higher_degree():
    S = _series("1d")
    if S is None:
        return
    full = el._hi_dirs(S, "1d", "intermediate")
    T = int(S["n"] * 0.7)
    part = el._hi_dirs(el.cut(S, T), "1d", "intermediate")
    k = full[0] <= T
    assert np.array_equal(full[0][k], part[0]) and np.array_equal(full[1][k], part[1])


def test_ml_uses_only_known_outcomes():
    """Il ranker a un istante j dipende solo dagli istanti precedenti con esito noto: troncare il futuro non cambia nulla."""
    S = _series("1d")
    if S is None:
        return
    rows: list = []
    el.backtest(S, "1d", "minor", rows_out=rows)
    if len(rows) < el.ML_MIN_TRAIN + 30:
        return
    full, _ = el._ml_walkforward(rows)
    j = len(rows) - 15
    part, _ = el._ml_walkforward(rows[: j + 1])
    for a, b in zip(full[: j + 1], part):
        assert (a is None and b is None) or list(a) == list(b)


def test_api_shape():
    S = _series("1d")
    if S is None:
        return
    r = el.compute("1d")
    assert r["counts"], "nessun conteggio valido"
    c = r["counts"][0]
    assert c["rank"] == 1 and c["points"] and c["projection"]
    inv = c["invalidation"]
    assert inv["below"] is not None or inv["above"] is not None
    bt = r["backtest"]
    assert bt["n"] > 30 and bt["verdict"] in ("none", "weak", "strong", "anecdotal")
    ranks = bt["calibration"]["ranks"]
    assert sum(x["p_best"] for x in ranks) <= 100.0001


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
