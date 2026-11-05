"""Meta-modello dei Segnali: stima la probabilità che un candidato raggiunga TP1 prima dello stop.

LightGBM addestrato solo su esiti già chiusi al momento del riaddestramento, a ogni trimestre dal 2021, con calibrazione isotonica
sull'ultimo tratto del set di training. Il filtro non ha soglie da scegliere: tiene un candidato se la probabilità calibrata supera
la probabilità di pareggio del trade, (1 + costi in R) / (1 + TP1 in R).

Si tiene solo se migliora l'aspettativa rispetto alle sole regole nel walk-forward di sviluppo E nell'holdout, con calibrazione
sufficiente (`keep()`); altrimenti l'app non mostra alcuna probabilità.
"""
from __future__ import annotations

import logging
import pickle

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

from ..data import store
from . import forecast_features as ff
from . import scoreboard as sb
from . import signal_setups as ss
from . import signal_sim as sim

log = logging.getLogger("signal_meta")

MODEL_FILE = store.DATA_DIR / "signals_meta.pkl"
DAILY = ("mayer", "rsi_14", "ret_7d", "ret_30d", "dist_ma50", "vol_30d", "dd_ath", "halv_year", "fng", "vix", "spx_30d", "dxy_30d")
LOCAL = ("side", "tf_i", "setup_i", "risk_pct", "risk_atr", "tp1_r", "tp2_r", "adx", "vol", "trend_rel", "vw_dist", "sd_atr", "fund", "fund_z_rel", "oi7", "regime_i", "balance")
FEATS = LOCAL + DAILY
ECE_MAX = 5.0        # punti percentuali
MIN_KEPT = 100
TF_I = {tf: i for i, tf in enumerate(ss.TF_S)}
SETUP_I = {s: i for i, s in enumerate(ss.SETUPS)}
REGIME_I = {"bear": -1, "accumulation": 0, "bull": 1}


def daily_context() -> pd.DataFrame:
    """Riga del giorno D = dati chiusi alle 24:00 di D: `at()` legge sempre il giorno precedente a quello del segnale."""
    ff.OFFLINE = True
    feat = ff.build()
    out = feat[list(DAILY)].copy()
    out["regime_i"] = ff.regime_of(feat).map(REGIME_I)
    try:
        D, _ = sb.daily_inputs(lagged=True)
        bal = sb.daily_balance(D)
        s = pd.Series((bal["bull"] - bal["bear"]).to_numpy(float), index=pd.to_datetime(bal.index, utc=True).tz_convert(None).normalize())
        out["balance"] = s[~s.index.duplicated(keep="last")].reindex(out.index).ffill(limit=5)
    except Exception as e:  # noqa: BLE001
        log.warning("saldo Bull vs Bear non disponibile: %s", e)
        out["balance"] = np.nan
    return out


def row(F: ss.Frame, i: int, setup: str, side: int, risk_pct: float, risk_atr: float, tp1_r: float, tp2_r: float, ctx: pd.DataFrame | None, close_t: int) -> dict:
    a = F.a[i]
    x = {"side": side, "tf_i": TF_I[F.tf], "setup_i": SETUP_I[setup], "risk_pct": risk_pct, "risk_atr": risk_atr, "tp1_r": tp1_r, "tp2_r": tp2_r,
         "adx": F.adx[i], "vol": F.vol[i], "trend_rel": int(F.trend[i]) * side, "vw_dist": side * (F.c[i] - F.vw[i]) / a, "sd_atr": F.sd[i] / a,
         "fund": F.fund[i], "fund_z_rel": side * F.fund_z[i], "oi7": F.oi7[i]}
    if ctx is not None:
        d = pd.Timestamp(close_t - 86400, unit="s").normalize()   # giorno chiuso più recente
        k = ctx.index.searchsorted(d, side="right") - 1
        if k >= 0:
            x.update(ctx.iloc[k].to_dict())
    return x


def dataset(M, frozen: dict[str, dict], run_trades, ctx: pd.DataFrame | None) -> pd.DataFrame:
    rows = []
    for key, p in frozen.items():
        setup, tf, s = key.split("|")
        side = 1 if s == "long" else -1
        F = M.frames[tf]
        for tr in run_trades(M, ss.candidates(F, setup, side, p)):
            x = row(F, tr["i"], setup, side, tr["risk_pct"], tr["risk_atr"], tr["tp1_r"], tr["tp2_r"], ctx, tr["t"])
            x.update({"key": key, "t": tr["t"], "exit_t": tr["exit_t"], "y": int(tr["tp1"]), "r": tr["r"]})
            rows.append(x)
    return pd.DataFrame(rows).sort_values("t").reset_index(drop=True)


def _clf() -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(n_estimators=150, learning_rate=0.03, num_leaves=7, min_child_samples=30, subsample=0.8, subsample_freq=1,
                              colsample_bytree=0.7, reg_lambda=5.0, random_state=7, n_jobs=2, verbose=-1)


def _x(df: pd.DataFrame) -> pd.DataFrame:
    return df.reindex(columns=list(FEATS)).astype(float)


def fit(train: pd.DataFrame) -> tuple[lgb.LGBMClassifier, IsotonicRegression]:
    """Il modello impara dal primo 75% del passato, la calibrazione dal restante 25%, poi il modello si riaddestra su tutto."""
    cut = int(len(train) * 0.75)
    head, tail = train.iloc[:cut], train.iloc[cut:]
    m = _clf().fit(_x(head), head["y"])
    iso = IsotonicRegression(y_min=0.01, y_max=0.99, out_of_bounds="clip").fit(m.predict_proba(_x(tail))[:, 1], tail["y"])
    return _clf().fit(_x(train), train["y"]), iso


def quarters(t0: int, t1: int) -> list[int]:
    return [int(x.timestamp()) for x in pd.date_range(pd.Timestamp(t0, unit="s", tz="UTC"), pd.Timestamp(t1, unit="s", tz="UTC"), freq="QS")]


def walk_forward(df: pd.DataFrame, start: int, end: int) -> pd.DataFrame:
    """Probabilità fuori campione: al riaddestramento entra solo ciò che è già USCITO (exit_t), non ciò che è solo entrato."""
    out = []
    qs = quarters(start, end) + [end]
    for a, b in zip(qs[:-1], qs[1:]):
        train = df[df["exit_t"] < a]
        test = df[(df["t"] >= a) & (df["t"] < b)]
        if len(train) < 300 or test.empty:
            continue
        m, iso = fit(train)
        p = iso.predict(m.predict_proba(_x(test))[:, 1])
        out.append(test.assign(p=p))
    return pd.concat(out) if out else df.iloc[0:0].assign(p=[])


def breakeven(df: pd.DataFrame) -> np.ndarray:
    cost_r = sim.COST_PCT / df["risk_pct"].to_numpy()
    return (1 + cost_r) / (1 + df["tp1_r"].to_numpy())


def ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> tuple[float | None, list[dict]]:
    if not len(p):
        return None, []
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    k = np.clip(np.searchsorted(np.unique(edges), p, "right") - 1, 0, None)
    out, err = [], 0.0
    for b in np.unique(k):
        m = k == b
        pm, ym = float(p[m].mean()), float(y[m].mean())
        out.append({"p": pm * 100, "obs": ym * 100, "n": int(m.sum())})
        err += abs(pm - ym) * m.mean()
    return float(err * 100), out


def evaluate(o: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Regole contro regole + filtro, sugli stessi candidati."""
    if o.empty:
        return {"n": 0}
    keep = o["p"].to_numpy() >= breakeven(o)
    r = o["r"].to_numpy()
    y = o["y"].to_numpy()
    p = o["p"].to_numpy()
    e, curve = ece(p, y)
    base = float(y.mean())
    res = {"n": len(o), "kept": int(keep.sum()), "rules_mean_r": float(r.mean()), "filtered_mean_r": float(r[keep].mean()) if keep.any() else None,
           "brier": float(np.mean((p - y) ** 2)), "brier_base": float(np.mean((base - y) ** 2)), "ece": e, "base_rate": base * 100, "reliability": curve,
           "auc": float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) and len(np.unique(p)) > 1 else None}
    if keep.any() and (~keep).any():
        b = 2000
        d = r[keep][rng.integers(0, keep.sum(), (b, keep.sum()))].mean(axis=1) - r[rng.integers(0, len(r), (b, len(r)))].mean(axis=1)
        res["delta"] = float(r[keep].mean() - r.mean())
        res["delta_ci"] = [float(np.quantile(d, 0.025)), float(np.quantile(d, 0.975))]
    return res


def keep(dev: dict, hold: dict) -> tuple[bool, str]:
    """Il meta-modello resta solo se tutti i controlli passano, in quest'ordine."""
    if not dev.get("n") or not hold.get("n"):
        return False, "no_data"
    if dev.get("delta") is None or dev["delta"] <= 0:
        return False, "dev_no_gain"
    if hold.get("delta") is None or hold["delta"] <= 0:
        return False, "holdout_no_gain"
    if hold["delta_ci"][0] <= 0:
        return False, "holdout_gain_uncertain"
    if hold.get("kept", 0) < MIN_KEPT:
        return False, "holdout_small"
    if hold.get("filtered_mean_r") is None or hold["filtered_mean_r"] <= 0:
        return False, "filtered_negative"
    if hold.get("ece") is None or hold["ece"] > ECE_MAX:
        return False, "not_calibrated"
    return True, "passed"


def save(m, iso) -> None:
    tmp = MODEL_FILE.with_name(f".{MODEL_FILE.name}.tmp")
    tmp.write_bytes(pickle.dumps({"model": m, "iso": iso}))
    tmp.replace(MODEL_FILE)


def predict(x: dict) -> float | None:
    """Probabilità calibrata di un candidato live. None se il modello non è stato tenuto."""
    if not MODEL_FILE.exists():
        return None
    b = pickle.loads(MODEL_FILE.read_bytes())
    return float(b["iso"].predict(b["model"].predict_proba(_x(pd.DataFrame([x])))[:, 1])[0])
