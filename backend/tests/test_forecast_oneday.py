"""Test di leakage della previsione a 1 giorno (app/analysis/forecast_oneday.py).

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_forecast_oneday.py
Usa solo i parquet su disco (BTC_DATA_DIR o backend/data), nessuna chiamata di rete.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis import forecast_features as ff  # noqa: E402
from app.analysis import forecast_models as fm  # noqa: E402
from app.analysis import forecast_oneday as od  # noqa: E402

ff.OFFLINE = True
_cache: dict = {}


def _inputs():
    if not _cache:
        feat, ohlc = od._load_inputs()
        ctx, ctx_m, mid = od._ctxs(feat, ohlc)
        _cache.update(feat=feat, ohlc=ohlc, ctx=ctx, ctx_m=ctx_m, mid=mid)
    return _cache


def test_no_partial_candle():
    c = _inputs()
    assert c["feat"].index.max() < od._today(), "la candela di oggi (parziale) non deve entrare nel modello"


def test_target_alignment():
    """Target = rendimento dalla chiusura di t a quella di t+1 (e dal close di t al medio di t+1): nessuno shift sbagliato."""
    c = _inputs()
    ctx, ctx_m, mid = c["ctx"], c["ctx_m"], c["mid"]
    close = c["feat"]["close"].to_numpy(float)
    p = ctx.n - 10
    assert abs(ctx.y[1][p] - np.log(close[p + 1] / close[p])) < 1e-12
    assert abs(ctx_m.y[1][p] - np.log(mid.iloc[p + 1] / close[p])) < 1e-12
    assert np.isnan(ctx.y[1][-1]), "l'ultima riga non ha target realizzato"


def test_refit_uses_only_realized_targets():
    """Per ogni mese di previsione il modello vede solo righe il cui target (giorno successivo) è <= origine."""
    c = _inputs()
    ctx = c["ctx"]
    D = ctx.dates
    first = int(np.searchsorted(D.values, od.OOS_START.to_datetime64()))
    for fst, blk in fm.refit_points(ctx, np.arange(first, ctx.n)):
        for cc in (ctx, c["ctx_m"]):
            rows = fm._rows(cc, 1, fst - 1)
            assert len(rows) > 0
            assert D[rows[-1]] + pd.Timedelta(days=1) <= D[blk[0]], "target di training successivo all'origine"


def test_features_point_in_time():
    """Le feature di un giorno ricostruite con le sorgenti troncate a quel giorno coincidono con quelle dello storico completo."""
    c = _inputs()
    full = ff.build()
    d = c["feat"].index[-30]
    res = od.leakage_check([pd.Timestamp("2022-06-15"), d], full)
    assert res["passed"], res


def test_check_detects_leak():
    """Controllo di sensibilità: una feature che usa il prezzo di domani DEVE essere rilevata dal confronto troncato."""
    d = pd.Timestamp("2022-06-15")
    full = ff.daily_close()
    ff._tl.cut = d + pd.Timedelta(days=1)
    try:
        trunc = ff.daily_close()
    finally:
        ff._tl.cut = None
    leak_full = np.log(full.shift(-1) / full)          # rendimento di domani: dato futuro
    leak_trunc = np.log(trunc.shift(-1) / trunc)
    assert np.isfinite(leak_full.loc[d]) and not np.isfinite(leak_trunc.loc[d])


def test_replica_split():
    c = _inputs()
    rep, info = od._replica(c["ohlc"])
    assert info["no_overlap"]
    assert info["train_to"] < info["valid_from"]
    assert info["valid_to"] <= pd.Timestamp(od.REPO["valid_end"]).normalize()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
