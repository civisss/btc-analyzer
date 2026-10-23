"""Test della scheda Kronos (app/analysis/kronos_forecast.py + app/vendor/kronos).

Eseguibile con pytest o direttamente:  .venv/Scripts/python tests/test_kronos.py
Nessuna rete: i test principali usano pesi FINTI (modello minuscolo a pesi casuali salvato in safetensors in una cartella
temporanea, KRONOS_OFFLINE=1) e candele sintetiche. Il test con i pesi veri si salta in modo pulito se i pesi non ci sono.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["KRONOS_OFFLINE"] = "1"
os.environ.setdefault("KRONOS_LIVE", "off")

_had_torch = "torch" in sys.modules
from app.analysis import kronos_forecast as kf  # noqa: E402

_IMPORT_PULLED_TORCH = (not _had_torch) and "torch" in sys.modules
_REAL_MODEL_DIR = kf.MODEL_DIR

try:
    import torch  # noqa: E402
except Exception:  # noqa: BLE001
    torch = None


try:   # sotto pytest il salto è un vero "skipped"; eseguito direttamente è un'eccezione propria
    import pytest

    Skip = pytest.skip.Exception
except Exception:  # noqa: BLE001
    class Skip(Exception):
        pass


def _need_torch():
    if torch is None:
        raise Skip("torch non installato")


# ------------------------------------------------------------------ pesi finti e candele sintetiche
TOK_CFG = {"d_in": 6, "d_model": 32, "n_heads": 2, "ff_dim": 64, "n_enc_layers": 2, "n_dec_layers": 2, "ffn_dropout_p": 0.0,
           "attn_dropout_p": 0.0, "resid_dropout_p": 0.0, "s1_bits": 4, "s2_bits": 4, "beta": 0.05, "gamma0": 1.0, "gamma": 1.1,
           "zeta": 0.05, "group_size": 4}
MOD_CFG = {"s1_bits": 4, "s2_bits": 4, "n_layers": 1, "d_model": 32, "n_heads": 2, "ff_dim": 64, "ffn_dropout_p": 0.0,
           "attn_dropout_p": 0.0, "resid_dropout_p": 0.0, "token_dropout_p": 0.0, "learn_te": True}
_mock: dict = {}


def _mock_engine():
    """Scrive pesi casuali nel formato Hugging Face (config.json + model.safetensors) e li carica con il percorso reale."""
    _need_torch()
    if _mock:
        return _mock["eng"]
    from safetensors.torch import save_file

    from app.vendor.kronos import Kronos, KronosTokenizer

    tmp = Path(tempfile.mkdtemp(prefix="kronos_test_"))
    kf.MODEL_DIR = tmp
    torch.manual_seed(0)
    for cls, cfg, spec in ((KronosTokenizer, TOK_CFG, kf.TOKENIZERS["base"]), (Kronos, MOD_CFG, kf.MODELS["small"])):
        d = kf._local_dir(spec["repo"])
        d.mkdir(parents=True, exist_ok=True)
        m = cls(**cfg)
        (d / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
        save_file({k: v.contiguous() for k, v in m.state_dict().items()}, str(d / "model.safetensors"))
    kf._engine.clear()
    eng = kf.engine("small", device="cpu")
    eng["ctx"] = 64                      # contesto ridotto: test veloci
    _mock["eng"] = eng
    return eng


def _synthetic(n=400, sec=3600, seed=1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    t = pd.date_range("2024-01-01", periods=n, freq=f"{sec}s", tz="UTC")
    c = 40000 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) * (1 + rng.uniform(0, 0.004, n))
    lo = np.minimum(o, c) * (1 - rng.uniform(0, 0.004, n))
    v = rng.uniform(100, 1000, n)
    return pd.DataFrame({"open": o, "high": h, "low": lo, "close": c, "volume": v}, index=t)


# ------------------------------------------------------------------ test
def test_import_is_lazy():
    """L'import del modulo non deve caricare torch né toccare la rete (avvio dell'app non bloccato)."""
    assert not _IMPORT_PULLED_TORCH, "importare kronos_forecast non deve importare torch"


def test_offline_mock_load_and_shape():
    eng = _mock_engine()
    assert eng["device"] == "cpu"
    assert not eng["model"].training and not eng["tokenizer"].training, "modelli in eval (dropout spento)"
    d = _synthetic()
    x, xs, ys, fut = kf._window(d, len(d) - 1, 60, 3600, 5)
    assert x.shape == (60, 6) and xs.shape == (60, 5) and ys.shape == (5, 5) and len(fut) == 5
    assert fut[0] == d.index[-1] + pd.Timedelta(hours=1)
    P = kf.sample_paths(eng, [x, x], [xs, xs], [ys, ys], 5, 7, [1, 2], chunk=4)
    assert P.shape == (2, 7, 5, 6)
    assert np.isfinite(P).all()


def test_offline_download_refused():
    """Con KRONOS_OFFLINE e pesi assenti il download è rifiutato con un errore chiaro (nessuna rete)."""
    _need_torch()
    st_dir = kf.MODEL_DIR
    try:
        kf.MODEL_DIR = Path(tempfile.mkdtemp(prefix="kronos_empty_"))
        try:
            kf._download("NeoQuasar/Kronos-small", "x")
            raise AssertionError("doveva fallire")
        except RuntimeError as e:
            assert "offline" in str(e)
        assert kf._status["weights"]["NeoQuasar/Kronos-small"]["state"] == "error"
    finally:
        kf.MODEL_DIR = st_dir
        kf._status["weights"].pop("NeoQuasar/Kronos-small", None)


def test_fast_inference_equals_upstream():
    """L'inferenza ottimizzata (teste solo sull'ultima posizione) dà gli stessi percorsi dell'implementazione upstream."""
    eng = _mock_engine()
    d = _synthetic()
    for L, H in ((40, 6), (64, 8)):        # senza e con finestra scorrevole (L + H > contesto 64)
        x, xs, ys, _ = kf._window(d, len(d) - 1, L, 3600, H)
        a = kf.sample_paths(eng, [x], [xs], [ys], H, 4, [3], upstream=True)
        b = kf.sample_paths(eng, [x], [xs], [ys], H, 4, [3])
        assert np.allclose(a, b, rtol=1e-5, atol=1e-3), f"differenza massima {np.abs(a - b).max()}"


def test_seed_reproducible():
    eng = _mock_engine()
    d = _synthetic()
    x, xs, ys, _ = kf._window(d, len(d) - 1, 48, 3600, 4)
    a = kf.sample_paths(eng, [x], [xs], [ys], 4, 6, [11])
    b = kf.sample_paths(eng, [x], [xs], [ys], 4, 6, [11])
    assert np.array_equal(a, b)


def test_quantiles_monotone_and_summary():
    rng = np.random.default_rng(0)
    close = 100 * np.exp(np.cumsum(rng.normal(0.001, 0.01, (100, 24)), axis=1))
    s = kf.summarize(close, 100.0)
    q = s["q"]
    assert q.shape == (5, 24)
    assert (np.diff(q, axis=0) >= -1e-9).all(), "percentili 5 <= 25 <= 50 <= 75 <= 95 a ogni passo"
    e = s["end"]
    assert e["p05"] <= e["p25"] <= e["median"] <= e["p75"] <= e["p95"]
    assert 0 <= e["up_prob"] <= 100
    assert abs(e["up_prob"] - 100 * np.mean(close[:, -1] > 100)) < 1e-9


def test_regime_thresholds():
    up = np.r_[np.full(80, 110.0), np.full(20, 95.0)]               # 80% al rialzo, mediana +10%
    r = kf.regime_of(up, 100.0)
    assert r["code"] == "trend_up" and abs(r["agree"] - 0.8) < 1e-9
    dn = 100 * np.exp(np.random.default_rng(1).normal(-0.05, 0.02, 200))
    assert kf.regime_of(dn, 100.0)["code"] == "trend_down"
    mix = 100 * np.exp(np.random.default_rng(2).normal(0.0, 0.05, 400))   # simmetrico: laterale
    assert kf.regime_of(mix, 100.0)["code"] == "choppy"
    # accordo alto ma rendimento minimo rispetto alla dispersione (SNR basso) → choppy
    skew = np.r_[np.full(70, 100.01), np.full(30, 80.0)]
    r = kf.regime_of(skew, 100.0)
    assert r["agree"] >= kf.AGREE_MIN and r["code"] == "choppy"
    assert kf.efficiency(np.array([101, 102, 103.0]), 100) > 0.99
    assert kf.efficiency(np.array([101, 100, 101, 100.0]), 100) < 0.01


def test_window_point_in_time():
    """La finestra all'origine i non cambia se si alterano le candele successive."""
    d = _synthetic()
    i = 300
    a = kf._window(d, i, 128, 3600, 24)
    d2 = d.copy()
    d2.iloc[i + 1:] *= 3.0
    b = kf._window(d2, i, 128, 3600, 24)
    for u, v in zip(a[:3], b[:3]):
        assert np.array_equal(u, v)


def test_backtest_no_lookahead():
    """Backtest con pesi finti su candele sintetiche: alterare i prezzi DOPO un'origine non cambia le previsioni di
    quell'origine (cambiano solo i realizzati)."""
    _mock_engine()
    d = _synthetic(n=900, sec=86400, seed=3)
    d.index = pd.date_range("2023-01-01", periods=len(d), freq="D", tz="UTC")
    saved = (kf.candles, kf.LOOKBACK, kf.BT_H, kf.PRETRAIN_END)
    out1, out2 = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
    try:
        kf.LOOKBACK, kf.BT_H = 48, 6
        kf.PRETRAIN_END = pd.Timestamp("2025-01-01", tz="UTC")
        kf.candles = lambda tf, closed_only=True: d
        kf.run_backtest(tfs=("1d",), samples=4, pre_every=30, post_every=30, batch_origins=2, chunk=8, progress=lambda s: None,
                        out_dir=out1, limit=3)
        r1 = pd.read_parquet(out1 / kf.BT_FILE)
        o = pd.Timestamp(r1["origin"].iloc[0])
        d2 = d.copy()
        d2.loc[d2.index > o, ["open", "high", "low", "close"]] *= 1.5
        kf.candles = lambda tf, closed_only=True: d2
        kf.run_backtest(tfs=("1d",), samples=4, pre_every=30, post_every=30, batch_origins=2, chunk=8, progress=lambda s: None,
                        out_dir=out2, limit=3)
        r2 = pd.read_parquet(out2 / kf.BT_FILE)
        a = r1[pd.to_datetime(r1["origin"], utc=True) == o].sort_values("step")
        b = r2[pd.to_datetime(r2["origin"], utc=True) == o].sort_values("step")
        assert len(a) == 6 and len(b) == 6
        for c in ("ref", "q05", "q50", "q95", "mean", "regime", "sig1", "drift1"):
            assert (a[c].to_numpy() == b[c].to_numpy()).all(), f"la colonna {c} dipende dal futuro"
        assert not np.allclose(a["actual"].to_numpy(), b["actual"].to_numpy()), "i realizzati devono cambiare"
        # origini dei due periodi separate dalla fine del pre-addestramento
        assert set(r1["period"]) <= {"pre", "post"}
        po = pd.to_datetime(r1["origin"], utc=True) + pd.Timedelta(days=1)
        assert ((r1["period"] == "post") == (po >= kf.PRETRAIN_END)).all()
        meta = json.loads((out1 / kf.BT_META).read_text(encoding="utf-8"))
        assert meta["complete"] is True
    finally:
        kf.candles, kf.LOOKBACK, kf.BT_H, kf.PRETRAIN_END = saved


def test_metrics_basics():
    rng = np.random.default_rng(5)
    R = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 400)))
    A = R * np.exp(rng.normal(0, 0.02, 400))
    m = kf._point_metrics(A, R, R)
    assert abs(m["mase"] - 1) < 1e-12, "il naive ha MASE 1 per definizione"
    dm, p = kf._dm_hac(np.log(A * 1.01 / A), np.log(R / A), 0)
    assert p is not None and 0 <= p <= 1
    # CRPS empirico ≈ CRPS gaussiano con molti campioni
    s = rng.normal(0, 1, 20000)
    c1 = kf._crps_samples(s, 0.3)
    c2 = float(kf._crps_gauss(np.array([0.0]), np.array([1.0]), np.array([0.3]))[0])
    assert abs(c1 - c2) < 0.01


def test_real_weights_forecast():
    """Con i pesi veri già scaricati (cartella dati) la previsione corrente ha la forma attesa. Saltato se mancano."""
    _need_torch()
    spec = kf.MODELS["small"]
    real = _REAL_MODEL_DIR / spec["repo"].replace("/", "__")
    tok = _REAL_MODEL_DIR / kf.TOKENIZERS["base"]["repo"].replace("/", "__")
    if not (kf._have_files(real) and kf._have_files(tok)):
        raise Skip("pesi Kronos non scaricati")
    from app.data import store
    if not (store.DATA_DIR / "k_1d.parquet").exists():
        raise Skip("dati k_1d assenti")
    saved_dir, saved_candles = kf.MODEL_DIR, kf.candles
    try:
        kf.MODEL_DIR = _REAL_MODEL_DIR
        kf._engine.clear()
        d = store._load_disk("k_1d").set_index("time")[["open", "high", "low", "close", "volume"]].astype(float)
        kf.candles = lambda tf, closed_only=True: d.iloc[:-1]
        f = kf.forecast_once("1d", 6, 8)
        assert f["q"].shape == (5, 6) and len(f["steps"]) == 6 and f["paths"].shape == (8, 6)
        assert (np.diff(f["q"], axis=0) >= -1e-6).all()
        assert f["regime"]["code"] in ("trend_up", "trend_down", "choppy")
        assert 0.3 < f["end"]["median"] / f["ref_price"] < 3
    finally:
        kf.MODEL_DIR, kf.candles = saved_dir, saved_candles
        kf._engine.clear()
        _mock.clear()


if __name__ == "__main__":
    ok = skip = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                ok += 1
                print(f"ok    {name}")
            except Skip as e:
                skip += 1
                print(f"SKIP  {name}: {e}")
    print(f"{ok} superati, {skip} saltati")
