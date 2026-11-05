"""Test del tabellone Bull vs Bear, della mappa per leva e del rilevamento dei movimenti.

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_scoreboard.py
Nessuna chiamata di rete: dati sintetici.
"""
from __future__ import annotations

import math
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_TMP = tempfile.mkdtemp(prefix="sbtest_")
os.environ.setdefault("BTC_DATA_DIR", _TMP)
os.environ.setdefault("USER_DATA_DIR", _TMP)
os.environ["TERMINAL_COLLECTOR"] = "off"

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from app import util  # noqa: E402
from app.analysis import liq_leverage as ll  # noqa: E402
from app.analysis import moves as mv  # noqa: E402
from app.analysis import scoreboard as sb  # noqa: E402

BULL, BEAR = sb.BULL, sb.BEAR


def side(h):
    return (h.side, h.conf) if h else None


# ------------------------------------------------------------------ regole

def test_macro_thresholds():
    assert side(sb.r_hy({"hy": 3.4, "hy_chg5": 0})) == (BULL, 3)
    assert side(sb.r_hy({"hy": 5.1, "hy_chg5": 0})) == (BEAR, 3)
    assert side(sb.r_hy({"hy": 4.0, "hy_chg5": 0.3})) == (BEAR, 2)
    assert sb.r_hy({"hy": 4.0, "hy_chg5": 0.1}) is None
    assert side(sb.r_sofr({"sofr": 3.97, "iorb": 3.90})) == (BEAR, 3)
    assert side(sb.r_sofr({"sofr": 3.94, "iorb": 3.90})) == (BEAR, 2)
    assert sb.r_sofr({"sofr": 3.90, "iorb": 3.90}) is None
    assert side(sb.r_sofr({"sofr": 3.86, "iorb": 3.90})) == (BULL, 1)
    assert side(sb.r_dxy({"dxy": 101.58, "dxy_p5": 101.87, "dxy_chg5": -0.28})) is None
    assert side(sb.r_dxy({"dxy": 100, "dxy_p5": 101, "dxy_chg5": -1.0})) == (BULL, 2)
    assert side(sb.r_reserves({"wres": 2.89e12, "wres_chg1w": -69e9})) == (BEAR, 2)
    assert side(sb.r_real({"real10": 2.62})) == (BEAR, 2)
    assert side(sb.r_real({"real10": 3.1})) == (BEAR, 3)
    assert side(sb.r_fedfut({"zq_rate": 4.03, "effr": 3.88, "zq_month": "2026-12"})) == (BEAR, 3)
    assert side(sb.r_fedfut({"zq_rate": 3.70, "effr": 3.88, "zq_month": "2026-12"})) == (BULL, 3)
    assert sb.r_fedfut({"zq_rate": 3.90, "effr": 3.88, "zq_month": "2026-12"}) is None


def test_structure_and_flows():
    assert side(sb.r_4h({"c4": 80274, "ema4": 79000, "atr4": 800})) == (BULL, 3)
    assert side(sb.r_4h({"c4": 79000, "ema4": 79100, "atr4": 300})) == (BEAR, 2)
    assert sb.r_4h({"c4": 79000, "ema4": 79010, "atr4": 300}) is None
    assert side(sb.r_emaw({"px": 80000, "ema50w": 78500, "ema100w": 79000, "wclose": 77000})) == (BULL, 2)
    assert side(sb.r_emaw({"px": 80000, "ema50w": 78500, "ema100w": 79000, "wclose": 79500})) == (BULL, 3)
    assert sb.r_emaw({"px": 78800, "ema50w": 78500, "ema100w": 79000, "wclose": 78000}) is None
    assert side(sb.r_wrun({"wrun": -4})) == (BEAR, 3)
    assert side(sb.r_wrun({"wrun": 3})) == (BULL, 2)
    assert sb.r_wrun({"wrun": -2}) is None
    assert side(sb.r_etf({"etf3": -1.16e9})) == (BEAR, 3)
    assert side(sb.r_stable({"usdt30": -5.7e9, "usdc30": -3.3e9})) == (BEAR, 3)
    assert side(sb.r_spot({"spot24": 218e6, "spot7": 149e6})) == (BULL, 2)
    assert side(sb.r_spot({"spot24": 218e6, "spot7": -149e6})) == (BULL, 1)
    assert side(sb.r_perpled({"px24": 2.0, "perp24": 1.8e9, "spot24": 129e6})) == (BEAR, 2)
    assert side(sb.r_cb({"cb": -0.09})) == (BEAR, 1)


def test_positioning():
    assert side(sb.r_liq24({"liq_long": 94e6, "liq_short": 301e6, "liq_cov": 1.0})) == (BULL, 3)
    assert sb.r_liq24({"liq_long": 94e6, "liq_short": 301e6, "liq_cov": 0.2}) is None, "senza raccolta nessun punto"
    assert side(sb.r_oiprice({"px24": 3.0, "oi24": -2.5})) == (BEAR, 2)
    assert side(sb.r_oiprice({"px24": -3.0, "oi24": -2.5})) == (BULL, 1)
    assert sb.r_oiprice({"px24": 0.2, "oi24": -2.5}) is None
    assert side(sb.r_ls({"long_pct": 70.7, "long_pct_p": 60})) == (BEAR, 2)
    assert side(sb.r_funding({"funding": 0.0075})) == (BULL, 1)
    assert sb.r_funding({"funding": 0.01}) is None
    assert side(sb.r_funding({"funding": -0.02})) == (BULL, 3)
    assert side(sb.r_liqmap({"map7_short": 0.7e9, "map7_long": 1.9e9})) == (BEAR, 1)


def test_polymarket():
    now = pd.Timestamp("2026-11-05", tz="UTC")
    mk = {"question": "Law?", "outcomes": '["Yes","No"]', "outcomePrices": '["0.03","0.97"]', "volume": "2000000", "endDate": "2027-01-01T00:00:00Z", "closed": False}
    ev = [{"slug": "law", "markets": [mk]}, {"slug": "many", "markets": [mk, mk]}, {"slug": "small", "markets": [{**mk, "volume": "10"}]},
          {"slug": "past", "markets": [{**mk, "endDate": "2026-01-01T00:00:00Z"}]}, {"slug": "done", "closed": True, "markets": [mk]}]
    out = sb.parse_poly_events(ev, now)
    assert [m["slug"] for m in out] == ["law"], out
    assert side(sb.r_poly(out[0])) == (BEAR, 2)
    assert side(sb.r_poly({"question": "q", "p": 70, "volume": 60_000})) == (BULL, 1)
    assert sb.r_poly({"question": "q", "p": 45, "volume": 60_000}) is None


def test_counting_is_plain():
    pts = [{"cat": "macro", "side": BULL, "conf": 3, "id": "a"}, {"cat": "macro", "side": BEAR, "conf": 1, "id": "b"}, {"cat": "altro", "side": BEAR, "conf": 3, "id": "c"}]
    t = sb.tally(pts)
    assert (t["bull"], t["bear"]) == (1, 2)
    assert t["by_cat"]["macro"] == {"bull": 1, "bear": 1}
    assert [p["id"] for p in sb.sort_points(pts)] == ["a", "b", "c"]


def test_helpers():
    assert list(sb.run_length(np.array([1, 1, -1, -1, -1, 0, 1]))) == [1, 2, -1, -2, -3, 0, 1]
    assert sb.next_month_contract(pd.Timestamp("2026-11-05", tz="UTC")) == ("ZQZ26.CBT", "2026-12")
    assert sb.next_month_contract(pd.Timestamp("2026-12-05", tz="UTC")) == ("ZQF27.CBT", "2027-01")
    assert sb.usd(-1.16e9) == "−$1.16B" and sb.usd(301e6, True) == "+$301M"


def test_templates_survive_prose_and_are_translated():
    """I modelli arrivano al frontend come chiavi di t(): util.clean non deve alterarli e ognuno deve avere la traduzione."""
    src = Path(sb.__file__).read_text(encoding="utf-8")
    tpl = re.findall(r'Hit\((?:BULL|BEAR), [^,]+(?:\sif[^,]+else [A-Z]+)?, "((?:[^"\\]|\\.)*)"', src)
    assert len(tpl) >= 50, len(tpl)
    tpl = [x.replace('\\"', '"') for x in tpl]
    keys = tpl + [r.thr for r in sb.RULES] + [r.label for r in sb.RULES] + [sb.POLY_RULE["thr"]]
    en = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "i18n" / "en" / "scoreboard.ts")
    if en.exists():
        body = en.read_text(encoding="utf-8")
        common = "".join(p.read_text(encoding="utf-8") for p in en.parent.glob("*.ts"))
        for k in keys:
            assert util.prose(k) == k, k
            if not re.search(r"[a-zà-ù]{3}", k):
                continue
            ok = k in body or k.replace("'", "\\'") in common or k in common
            assert ok or k in ("Nasdaq futures", "VIX", "Brent", "Funding", "STRC", "Fear & Greed"), f"traduzione mancante: {k}"


def test_balance_uses_only_history_rules():
    D = pd.DataFrame([{"hy": 3.0, "hy_chg5": 0.0, "wrun": -5.0, "funding": 0.0075}, {"hy": 4.0, "hy_chg5": 0.0, "wrun": 3.0, "funding": 0.01}],
                     index=pd.date_range("2024-01-01", periods=2, freq="D", tz="UTC"))
    B = sb.daily_balance(D)
    assert (B["bull"].iloc[0], B["bear"].iloc[0], B["n"].iloc[0]) == (2, 1, 3)
    assert (B["bull"].iloc[1], B["bear"].iloc[1], B["n"].iloc[1]) == (1, 0, 3)


def test_balance_stats_detects_relation_and_noise():
    idx = pd.date_range("2022-01-01", periods=800, freq="D", tz="UTC")
    rng = np.random.default_rng(1)
    r = rng.normal(0, 0.02, 800)
    px = pd.Series(100 * np.exp(np.cumsum(r)), index=idx)
    noise = pd.Series(rng.normal(size=800), index=idx)
    s = sb.balance_stats(noise, px, 7)
    assert s and not s["significant"], s
    fwd = (px.shift(-8) / px.shift(-1) - 1).fillna(0)
    s2 = sb.balance_stats(fwd, px, 7)
    assert s2 and s2["significant"] and s2["ic"] > 0.9
    assert s2["days"] == 800 - 8 and s2["independent"] == s2["days"] // 7


# ------------------------------------------------------------------ mappa per leva

def test_map_conservation():
    rng = np.random.default_rng(3)
    cur = 80_000.0
    n = 5000
    lev = rng.choice([5, 10, 20, 25, 50, 100], n).astype(float)
    il = rng.random(n) < 0.5
    entry = cur * (1 + rng.normal(0, 0.02, n))
    liq = np.where(il, entry * (1 - 1 / lev), entry * (1 + 1 / lev))
    usd = rng.uniform(1e4, 1e6, n)
    step = ll.band_step(cur)
    assert step == 250
    b = ll.bin_levels(liq, usd, il, lev, cur, step)
    assert math.isclose(b["bars"].sum() + b["outside"], usd.sum(), rel_tol=1e-9), "barre + fuori intervallo = totale"
    assert math.isclose(b["total"], usd.sum(), rel_tol=1e-12)
    inside = (liq >= b["lo"]) & (liq < b["hi"])
    for s, m in ((0, il), (1, ~il)):
        assert math.isclose(b["bars"][s].sum(), usd[m & inside].sum(), rel_tol=1e-9)
    for k, levs in enumerate(((5, 10, 20, 25), (50,), (100,))):
        assert math.isclose(b["bars"][:, k].sum(), usd[np.isin(lev, levs) & inside].sum(), rel_tol=1e-9), "somma per gruppo di leva"


def test_map_group_and_band_edges():
    assert list(ll.group_of(np.array([5, 10, 20, 25, 50, 100.0]))) == [0, 0, 0, 0, 1, 2]
    b = ll.bin_levels(np.array([79_999.0, 80_000.0]), np.array([1.0, 2.0]), np.array([True, True]), np.array([100.0, 100.0]), 80_000, 250)
    i = int((80_000 - b["lo"]) / 250)
    assert b["bars"][0, 2, i] == 2 and b["bars"][0, 2, i - 1] == 1


def test_clusters_do_not_overlap():
    v = np.zeros(40)
    v[10:13] = 10
    v[11] = 50
    v[30] = 20
    c = ll.top_clusters(v, 70_000, 250)
    assert len(c) == 2 and c[0]["usd"] == 70
    assert c[0]["hi"] + 4 * 250 <= c[1]["lo"] or c[1]["hi"] + 4 * 250 <= c[0]["lo"]
    assert ll.top_clusters(np.zeros(40), 70_000, 250) == []


# ------------------------------------------------------------------ movimenti

def _bars(jump_at=None, size=0.0, n=400, seed=5):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, 0.0006, n)
    if jump_at is not None:
        r[jump_at:jump_at + 3] += size / 3
    c = 80_000 * np.exp(np.cumsum(r))
    o = np.r_[c[0], c[:-1]]
    w = np.abs(rng.normal(0, 0.0005, n)) * c
    return np.arange(n) * 900, o, np.maximum(o, c) + w, np.minimum(o, c) - w, c


def test_detect_finds_the_move_and_its_direction():
    t, o, h, l, c = _bars(300, 0.035)
    ev = mv.detect(t, o, h, l, c)
    assert len(ev) == 1, ev
    e = ev[0]
    assert e["dir"] == 1 and 295 <= e["i0"] <= 301 and 301 <= e["i1"] <= 306
    assert e["ret_pct"] > 3 and e["z"] >= mv.K
    t, o, h, l, c = _bars(300, -0.035)
    ev = mv.detect(t, o, h, l, c)
    assert len(ev) == 1 and ev[0]["dir"] == -1 and ev[0]["ret_pct"] < -3


def test_detect_ignores_quiet_markets_and_short_history():
    t, o, h, l, c = _bars()
    assert mv.detect(t, o, h, l, c) == []
    t, o, h, l, c = _bars(n=50)
    assert mv.detect(t, o, h, l, c) == []


def test_detect_needs_minimum_percent():
    t, o, h, l, c = _bars(300, 0.035)
    assert mv.detect(t, o, h, l, c, min_pct=10) == []


def test_readings():
    # lo spot è sotto il 15% dei perp: il movimento risulta guidato dai perpetui
    assert mv.read_move(1, -1.8, 166e6, 1.9e9, 0, 229e6) == ["short_squeeze", "perp_led", "liq_shorts"]
    assert mv.read_move(1, 1.0, 500e6, 1e9, None, None) == ["new_longs", "spot_buying"]
    assert mv.read_move(-1, -2.0, -300e6, -1e9, 200e6, 10e6) == ["long_flush", "spot_selling", "liq_longs"]
    assert mv.read_move(-1, 1.0, 100e6, -1e9, None, None) == ["new_shorts", "perp_led"]
    assert mv.read_move(1, 0.1, None, None, None, None) == ["no_reading"]


def test_collection_overlap():
    s = [(0.0, 100.0), (50.0, 150.0), (300.0, 400.0)]
    assert mv.overlap_share(s, 0, 200) == 0.75
    assert mv.overlap_share(s, 200, 300) == 0
    assert mv.overlap_share([], 0, 10) == 0
    assert mv.overlap_share(s, 10, 10) == 0


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    bad = 0
    for f in fns:
        try:
            f()
            print("ok  ", f.__name__)
        except AssertionError as e:
            bad += 1
            print("FAIL", f.__name__, str(e)[:300])
    print(f"{len(fns) - bad}/{len(fns)} test superati")
    sys.exit(1 if bad else 0)
