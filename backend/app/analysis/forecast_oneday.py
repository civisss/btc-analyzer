"""Previsione a 1 giorno — onesta: modello walk-forward fuori campione contro il naive "domani = oggi".

Perché esiste: i grafici "prezzo reale vs previsto" a un passo (es. il repository CryptoPredictions) sembrano perfetti
perché la previsione di domani resta per forza attaccata al prezzo di oggi. Qui lo stesso grafico è accompagnato dalle
metriche che contano: MASE rispetto al naive, direzione con p-value, correlazione dei RENDIMENTI, test Diebold-Mariano.

Pipeline (point-in-time, nessun lookahead):
  1. Feature store giornaliero (forecast_features, 88 variabili con i ritardi di pubblicazione delle fonti); si usano
     solo giorni CHIUSI (la candela di oggi è esclusa).
  2. Target A "chiusura": log(close[t+1]/close[t]). Target B "prezzo medio": log(mid[t+1]/close[t]), mid = (H+L)/2 Binance.
     Prezzo previsto = prezzo di oggi × exp(rendimento previsto).
  3. LightGBM a quantili (5–95%, target normalizzato per la volatilità, iperparametri del forecast v2), walk-forward
     a finestra ESPANDENTE con riaddestramento MENSILE: le previsioni del mese M usano un modello addestrato solo su
     righe con target realizzato entro il 1° giorno di M. Previsioni fuori campione dal 2019-01-01.
  4. Bande 50%/90% calibrate con conformal (CQR relativo, finestra 3 anni di errori passati realizzati), P(rialzo)
     calibrata con Platt sulle sole previsioni passate (finestra 4 anni).
  5. Baseline: naive (domani = oggi), deriva media storica (espandente). Replica dimostrativa del metodo
     CryptoPredictions (4 giorni di OHLCV + RSI + MACD + prezzo medio -> prezzo medio di domani in LIVELLO, Random Forest
     sklearn 1000 alberi, stesse date di train/valid del loro config), reimplementata qui.
  6. Metriche per periodo e verdetto calcolato dai dati; controllo di leakage strutturale + point-in-time delle feature.
Calcolo pesante una volta al giorno (dopo la chiusura UTC), incrementale; cache su disco con scritture atomiche.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from scipy import stats

from ..data import store
from ..util import clean, ts
from . import forecast_features as ff
from . import forecast_models as fm

log = logging.getLogger("forecast")

VERSION = 1
OOS_START = pd.Timestamp("2019-01-01")          # prima origine di previsione fuori campione
MID_TRAIN_START = pd.Timestamp("2017-08-18")    # Binance 1d (H/L e close dalla stessa candela)
SERIES_FILE = store.DATA_DIR / "forecast_oneday_series.parquet"
RAW_FILE = store.DATA_DIR / "forecast_oneday_oos.parquet"
META_FILE = store.DATA_DIR / "forecast_oneday.json"
DIR_EPS = 1e-4                                   # |variazione prevista| sotto 0,01% = nessuna direzione
SETTLE_MIN = 20                                  # minuti dopo le 00:00 UTC prima del ricalcolo (dataset aggiornati)

# config del repository CryptoPredictions (configs/hydra/dataset_loader/common.yaml)
REPO = {
    "url": "https://github.com/alimohammadiamirhossein/CryptoPredictions",
    "window_size": 5, "train_start": "2018-10-20 13:30:00", "train_end": "2021-11-10 09:30:00",
    "valid_start": "2021-11-10 10:30:00", "valid_end": "2023-01-16 10:30:00", "warmup_rows": 100,
    "features": ["open", "high", "low", "close", "volume", "rsi", "macd", "mean"], "n_estimators": 1000,
}
QCOLS = ["q05", "q25", "q50", "q75", "q95"]


# ------------------------------------------------------------------ dati

def _today() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC").tz_convert(None).normalize()


def _last_closed_day() -> pd.Timestamp:
    """Ultima candela giornaliera chiusa e consolidata (SETTLE_MIN minuti dopo le 00:00 UTC)."""
    now = pd.Timestamp.now(tz="UTC").tz_convert(None) - pd.Timedelta(minutes=SETTLE_MIN)
    return now.normalize() - pd.Timedelta(days=1)


def _ohlc() -> pd.DataFrame:
    k = ff._ds("k_1d")
    d = k.copy()
    d["time"] = pd.to_datetime(d["time"], utc=True).dt.tz_convert(None).dt.normalize()
    d = d.drop_duplicates("time", keep="last").set_index("time").sort_index()
    return d[["open", "high", "low", "close", "volume"]].astype(float)


def _load_inputs():
    feat = ff.build()
    feat = feat[feat.index < _today()]                       # solo candele chiuse
    ohlc = _ohlc()
    ohlc = ohlc[ohlc.index < _today()]
    return feat, ohlc


# ------------------------------------------------------------------ walk-forward LightGBM (cache incrementale)

def _ctxs(feat: pd.DataFrame, ohlc: pd.DataFrame):
    ctx = fm.Ctx(feat, (1,))
    mid = ((ohlc["high"] + ohlc["low"]) / 2).reindex(feat.index)
    lmid = np.log(mid.to_numpy(float))
    ymid = np.r_[lmid[1:] - ctx.lc[:-1], np.nan]
    ctx_m = fm.Ctx.__new__(fm.Ctx)
    ctx_m.__dict__.update(ctx.__dict__)
    ctx_m.y = {1: ymid}
    ctx_m.start = int(np.searchsorted(ctx.dates.values, MID_TRAIN_START.to_datetime64()))
    return ctx, ctx_m, mid


def _member(n_jobs=1):
    return fm.LGBQuantile(None, fm.LGB_TUNED, target="z", weight_floor=fm.LGB_TUNED_FLOOR, n_jobs=n_jobs, name="lgb1d")


def _load_raw() -> pd.DataFrame | None:
    try:
        if RAW_FILE.exists():
            df = pd.read_parquet(RAW_FILE)
            if len(df) and int(df["version"].iloc[0]) == VERSION:
                return df
    except Exception as e:  # noqa: BLE001
        log.warning("cache 1g illeggibile: %s", e)
    return None


_month_models: dict = {}     # (target, mese) -> modello (evita di riaddestrare il mese corrente a ogni giro)


def _walk_forward(ctx, ctx_m, raw: pd.DataFrame | None, progress) -> pd.DataFrame:
    D = ctx.dates
    T = ctx.n - 1
    first = int(np.searchsorted(D.values, OOS_START.to_datetime64()))
    have = set(pd.to_datetime(raw["origin"])) if raw is not None else set()
    idx = np.array([p for p in range(first, T + 1) if D[p] not in have], int)
    if not len(idx):
        return raw
    blocks = fm.refit_points(ctx, idx)
    progress(f"LightGBM 1 giorno walk-forward ({len(blocks)} riaddestramenti mensili)")
    now = time.time()

    def run(task):
        key, c, (fst, blk) = task
        mkey = (key, str(D[fst].to_period("M")))
        m = _month_models.get(mkey)
        if m is None:
            m = _member().fit(c, 1, fst - 1)          # righe <= fst-1: target close[fst] noto all'origine fst
            _month_models[mkey] = m
        rows = fm._rows(c, 1, fst - 1)
        q, _ = m.predict(c, 1, blk)
        return key, blk, q, int(rows[-1]) if len(rows) else -1

    tasks = [(k, c, b) for k, c in (("close", ctx), ("mid", ctx_m)) for b in blocks]
    out: dict[int, dict] = {int(p): {} for p in idx}
    import os  # noqa: PLC0415

    with ThreadPoolExecutor(max(2, (os.cpu_count() or 4) - 2)) as ex:
        for key, blk, q, last_row in ex.map(run, tasks):
            for p, r in zip(blk, q):
                o = out[int(p)]
                for j, c in enumerate(QCOLS):
                    o[f"{key}_{c}"] = float(r[j])
                o[f"{key}_train_end"] = D[last_row] if last_row >= 0 else pd.NaT
    # tieni in memoria solo i modelli del mese corrente
    cur = str(D[T].to_period("M"))
    for k in [k for k in _month_models if k[1] != cur]:
        _month_models.pop(k, None)
    rows = []
    for p, o in out.items():
        # registro onesto: è "in tempo reale" solo la previsione dell'ultima candela chiusa calcolata da un aggiornamento
        # incrementale (il primo calcolo completo è un backtest, anche se rigorosamente fuori campione)
        rows.append({"origin": D[p], "version": VERSION, "made_at": now, "live": bool(raw is not None and p == T), **o})
    new = pd.DataFrame(rows)
    df = new if raw is None else pd.concat([raw, new], ignore_index=True)
    return df.sort_values("origin").drop_duplicates("origin", keep="first").reset_index(drop=True)


# ------------------------------------------------------------------ replica CryptoPredictions

def _repo_rsi(x: pd.Series, n=14) -> pd.Series:
    d = x.diff()
    up, dn = d.clip(lower=0), (-d.clip(upper=0))
    rs = up.rolling(n).mean() / dn.rolling(n).mean()
    return 100 - 100 / (1 + rs)


def _replica(ohlc: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Stesso schema del repo: input = 4 giorni × [open, high, low, close, volume, RSI14, MACD12/26, medio] (la finestra
    di 5 del config usa l'ultimo giorno come target), target = prezzo medio del giorno dopo in LIVELLO, Random Forest
    1000 alberi (random_state 42) addestrata una volta su train e valutata su valid. Indicatori sul prezzo medio, prime
    100 righe scartate. Dopo il periodo valid lo stesso modello congelato continua (solo dimostrativo)."""
    from sklearn.ensemble import RandomForestRegressor  # noqa: PLC0415

    d = ohlc[ohlc.index > pd.Timestamp(REPO["train_start"])].copy()
    d["mean"] = (d["high"] + d["low"]) / 2
    d["rsi"] = _repo_rsi(d["mean"])
    d["macd"] = d["mean"].ewm(span=12, adjust=False).mean() - d["mean"].ewm(span=26, adjust=False).mean()
    d = d.iloc[REPO["warmup_rows"]:]
    cols = REPO["features"]
    A = d[cols].to_numpy(float)
    L = REPO["window_size"] - 1                         # 4 giorni di input
    dates = d.index
    X, y, d0, dlast, dtgt = [], [], [], [], []
    for i in range(len(d) - L + 1):
        X.append(A[i:i + L].reshape(-1))
        d0.append(dates[i])
        dlast.append(dates[i + L - 1])
        j = i + L
        y.append(A[j, cols.index("mean")] if j < len(d) else np.nan)
        dtgt.append(dates[j] if j < len(d) else dates[i + L - 1] + pd.Timedelta(days=1))
    X, y = np.array(X), np.array(y)
    d0 = pd.DatetimeIndex(d0)
    tr = (d0 > pd.Timestamp(REPO["train_start"])) & (d0 < pd.Timestamp(REPO["train_end"])) & ~np.isnan(y)
    va = (d0 > pd.Timestamp(REPO["valid_start"])) & (d0 < pd.Timestamp(REPO["valid_end"]))
    va &= pd.DatetimeIndex(dtgt) <= pd.Timestamp(REPO["valid_end"]).normalize()   # il loro dataset finisce a valid_end
    rf = RandomForestRegressor(n_estimators=REPO["n_estimators"], random_state=42, n_jobs=4)
    rf.fit(X[tr], y[tr])
    after = d0 > pd.Timestamp(REPO["valid_start"])      # valid + estensione con modello congelato
    pred = rf.predict(X[after])
    out = pd.DataFrame({"target": pd.DatetimeIndex(dtgt)[after], "replica": pred,
                        "in_valid": va[after]}).set_index("target")
    tgt_tr = pd.DatetimeIndex(dtgt)[tr]
    info = {
        "train_rows": int(tr.sum()), "train_from": d0[tr][0], "train_to": tgt_tr[-1],
        "valid_from": out.index[out["in_valid"]][0], "valid_to": out.index[out["in_valid"]][-1],
        "valid_rows": int(out["in_valid"].sum()), "train_max_price": float(np.nanmax(y[tr])),
        "no_overlap": bool(tgt_tr.max() < out.index[out["in_valid"]].min()),
    }
    return out, info


# ------------------------------------------------------------------ metriche

def _binom_p(k: int, n: int, p: float) -> float | None:
    if n <= 0 or not 0 < p < 1:
        return None
    return float(stats.binomtest(k, n, p, alternative="greater").pvalue)


def _dm(e_model: np.ndarray, e_naive: np.ndarray) -> tuple[float | None, float | None]:
    """Diebold-Mariano (perdita = errore assoluto, h = 1) con correzione Harvey-Leybourne-Newbold, bilaterale.
    Statistica negativa = il modello sbaglia meno del naive."""
    d = np.abs(e_model) - np.abs(e_naive)
    d = d[~np.isnan(d)]
    n = len(d)
    if n < 30 or np.allclose(d, 0):
        return None, None
    v = np.var(d, ddof=0) / n
    if v <= 0:
        return None, None
    dm = float(np.mean(d) / np.sqrt(v)) * np.sqrt((n - 1) / n)     # HLN, h = 1
    p = float(2 * stats.t.sf(abs(dm), df=n - 1))
    return dm, p


def _metrics(A, P, R, naive, lo50=None, hi50=None, lo90=None, hi90=None, pu=None, pc=None, naive2=None) -> dict:
    """A = prezzo realizzato, P = previsto, R = prezzo di riferimento di oggi (per rendimenti e direzione),
    naive = previsione naive (scala del MASE). Errori in log (≈ %): confrontabili tra 2019 e oggi."""
    ok = ~(np.isnan(A) | np.isnan(P) | np.isnan(R) | np.isnan(naive))
    n = int(ok.sum())
    if n < 10:
        return {"n": n}
    n2 = naive2[ok] if naive2 is not None else None
    A, P, R, naive = A[ok], P[ok], R[ok], naive[ok]
    e = np.log(P / A)
    en = np.log(naive / A)
    pr, ar = np.log(P / R), np.log(A / R)
    mae_n = float(np.mean(np.abs(en)))
    out = {
        "n": n,
        "mae": float(np.mean(np.abs(P - A))), "mape": 100 * float(np.mean(np.abs(P / A - 1))),
        "rmse_pct": 100 * float(np.sqrt(np.mean(e ** 2))),
        "mase": float(np.mean(np.abs(e)) / mae_n) if mae_n > 0 else None,
        "bias_pct": 100 * float(np.mean(-e)),
        "corr_price": float(np.corrcoef(P, A)[0, 1]),
        "corr_ret": float(np.corrcoef(pr, ar)[0, 1]) if np.std(pr) > 1e-12 and np.std(ar) > 0 else None,
    }
    m = (np.abs(pr) > DIR_EPS) & (ar != 0)
    nd = int(m.sum())
    out["n_dir"] = nd
    if nd >= 10:
        k = int((np.sign(pr[m]) == np.sign(ar[m])).sum())
        up_share = float(np.mean(ar[m] > 0))
        out.update({
            "hit_rate": 100 * k / nd, "always_up": 100 * up_share,
            "p_dir": _binom_p(k, nd, 0.5), "p_dir_vs_up": _binom_p(k, nd, max(up_share, 1e-6)) if up_share < 1 else None,
            "share_up_calls": 100 * float(np.mean(pr[m] > 0)),
        })
    else:
        out.update({"hit_rate": None, "always_up": 100 * float(np.mean(ar[ar != 0] > 0)) if (ar != 0).any() else None,
                    "p_dir": None, "p_dir_vs_up": None, "share_up_calls": None})
    dm, p = _dm(e, en)
    out["dm_stat"], out["dm_p"] = dm, p
    if n2 is not None:
        # prezzo medio: confronto anche con il naive più furbo "medio di domani = chiusura di oggi"
        e2 = np.log(n2 / A)
        m2 = float(np.mean(np.abs(e2)))
        out["mase_vs_close"] = float(np.mean(np.abs(e)) / m2) if m2 > 0 else None
        dm2, p2 = _dm(e, e2)
        out["dm_stat_vs_close"], out["dm_p_vs_close"] = dm2, p2
    if lo90 is not None:
        L5, H5, L9, H9 = (x[ok] for x in (lo50, hi50, lo90, hi90))
        okb = ~np.isnan(L9)
        if okb.sum() >= 10:
            a = A[okb]
            out["coverage_50"] = 100 * float(np.mean((a >= L5[okb]) & (a <= H5[okb])))
            out["coverage_90"] = 100 * float(np.mean((a >= L9[okb]) & (a <= H9[okb])))
            out["width_50"] = 100 * float(np.mean((H5[okb] - L5[okb]) / R[okb]))
            out["width_90"] = 100 * float(np.mean((H9[okb] - L9[okb]) / R[okb]))
    if pu is not None:
        u, c = pu[ok], pc[ok]
        okp = ~np.isnan(u)
        if okp.sum() >= 10:
            up = (ar[okp] > 0).astype(float)
            b = float(np.mean((u[okp] - up) ** 2))
            bref = float(np.mean((c[okp] - up) ** 2))
            out["brier"] = b
            out["brier_skill"] = 100 * (1 - b / bref) if bref > 0 else None
    return out


def _verdict(m: dict, naive_key=False, vs_close=False) -> dict:
    """Verdetto in linguaggio semplice calcolato dai numeri (codice + parametri; il testo lo compone la UI).
    vs_close=True (target prezzo medio): il termine di paragone è il naive più forte "chiusura di oggi"."""
    if naive_key:
        return {"code": "baseline"}
    mase, p = (m.get("mase_vs_close"), m.get("dm_p_vs_close")) if vs_close else (m.get("mase"), m.get("dm_p"))
    if mase is None:
        return {"code": "n_a"}
    better = mase < 1
    sig = p is not None and p < 0.05
    if better and sig:
        code = "edge" if mase < 0.97 else "small_edge"
    elif better:
        code = "no_edge"
    elif sig:
        code = "worse"
    else:
        code = "no_edge" if mase < 1.02 else "worse_ns"
    dir_sig = m.get("p_dir") is not None and m["p_dir"] < 0.05
    dir_beats_up = m.get("p_dir_vs_up") is not None and m["p_dir_vs_up"] < 0.05
    return {"code": code, "mase": mase, "dm_p": p, "benchmark": "naive_close" if vs_close else "naive",
            "direction_significant": bool(dir_sig),
            "direction_beats_always_up": bool(dir_beats_up)}


# ------------------------------------------------------------------ calibrazione e serie

def _calibrate(raw: pd.DataFrame, ctx, ctx_m, mid: pd.Series) -> pd.DataFrame:
    D = ctx.dates
    pos = pd.Series(np.arange(ctx.n), index=D)
    p_idx = pos.reindex(pd.to_datetime(raw["origin"])).to_numpy(int)
    close = ctx.feat["close"].to_numpy(float)
    out = pd.DataFrame({"origin": D[p_idx]})
    out["target"] = out["origin"] + pd.Timedelta(days=1)
    out["ref_close"] = close[p_idx]
    nxt = np.minimum(p_idx + 1, ctx.n - 1)
    out["close"] = np.where(p_idx + 1 < ctx.n, close[nxt], np.nan)
    mid_v = mid.to_numpy(float)
    out["ref_mid"] = mid_v[p_idx]
    out["mid"] = np.where(p_idx + 1 < ctx.n, mid_v[nxt], np.nan)
    for key, c in (("close", ctx), ("mid", ctx_m)):
        Q = raw[[f"{key}_{q}" for q in QCOLS]].to_numpy(float)
        y = c.y[1][p_idx]
        Qc, _C = fm.conformal(Q, y, p_idx, 1, window=1095, min_n=60)
        pu_raw = 1 - fm.cdf0(Qc)
        pu, _ = fm.platt_stack([pu_raw], y, p_idx, 1, window=1460, min_n=150)
        pu = np.where(np.isnan(pu), pu_raw, pu)
        for j, q in enumerate(QCOLS):
            out[f"{key}_{q}"] = Qc[:, j]
        out[f"{key}_up_raw"] = pu_raw
        out[f"{key}_up"] = pu
    # deriva storica (media espandente dei rendimenti realizzati fino all'origine) e frequenza storica dei rialzi
    r = ctx.r
    cs, cu = np.cumsum(r), np.cumsum(r > 0)
    st = ctx.start
    out["drift"] = [(cs[p] - cs[st]) / max(p - st, 1) for p in p_idx]
    out["clim_up"] = [(cu[p] - cu[st]) / max(p - st, 1) for p in p_idx]
    out["train_end_close"] = pd.to_datetime(raw["close_train_end"]).to_numpy()
    out["train_end_mid"] = pd.to_datetime(raw["mid_train_end"]).to_numpy()
    out["live"] = raw["live"].to_numpy(bool)
    return out


def _price_cols(s: pd.DataFrame) -> pd.DataFrame:
    s = s.copy()
    for key, ref in (("close", "ref_close"), ("mid", "ref_close")):
        for q in QCOLS:
            s[f"{key}_p_{q}"] = s[ref] * np.exp(s[f"{key}_{q}"])
    s["drift_p"] = s["ref_close"] * np.exp(s["drift"])
    return s


# ------------------------------------------------------------------ controllo di leakage

def leakage_check(dates: list[pd.Timestamp] | None = None, feat_full: pd.DataFrame | None = None) -> dict:
    """Ricostruisce le feature con TUTTE le sorgenti troncate alla fine del giorno d e verifica che la riga d coincida con
    quella calcolata sullo storico completo (se una feature usasse dati futuri, cambierebbe)."""
    feat_full = feat_full if feat_full is not None else ff.build()
    res = []
    for d in dates or []:
        d = pd.Timestamp(d)
        ft = ff.truncated_build(d + pd.Timedelta(days=1))
        a = feat_full.loc[d, ff.FEATURE_KEYS].astype(float)
        b = ft.loc[d, ff.FEATURE_KEYS].astype(float)
        both = a.notna() & b.notna()
        diff = (a[both] - b[both]).abs() / np.maximum(a[both].abs(), 1e-9)
        bad = sorted(diff[diff > 1e-6].index.tolist())
        nan_mismatch = sorted((a.isna() != b.isna())[lambda s: s].index.tolist())
        res.append({"date": d, "compared": int(both.sum()), "mismatch": bad, "nan_mismatch": nan_mismatch,
                    "max_rel_diff": float(diff.max()) if len(diff) else 0.0,
                    "close_equal": bool(abs(feat_full.loc[d, "close"] - ft.loc[d, "close"]) < 1e-9)})
    return {"dates": res, "passed": all(not r["mismatch"] and not r["nan_mismatch"] and r["close_equal"] for r in res)}


# ------------------------------------------------------------------ addestramento giornaliero

def _periods(s: pd.DataFrame, rep_info: dict) -> dict[str, np.ndarray]:
    t = s["target"]
    last = t[s["close"].notna()].max()
    return {
        "all": s["close"].notna().to_numpy(),
        "y1": ((t > last - pd.Timedelta(days=365)) & s["close"].notna()).to_numpy(),
        "d90": ((t > last - pd.Timedelta(days=90)) & s["close"].notna()).to_numpy(),
        "repo": ((t >= rep_info["valid_from"]) & (t <= rep_info["valid_to"]) & s["close"].notna()).to_numpy(),
    }


def _evaluate(s: pd.DataFrame, rep_info: dict) -> dict:
    per = _periods(s, rep_info)
    A_c, A_m = s["close"].to_numpy(float), s["mid"].to_numpy(float)
    Rc, Rm = s["ref_close"].to_numpy(float), s["ref_mid"].to_numpy(float)
    pc_ = s["clim_up"].to_numpy(float)
    out = {}
    for name, m in per.items():
        g = lambda c: s[c].to_numpy(float)[m]  # noqa: E731
        close_rows = {
            "model": _metrics(A_c[m], g("close_p_q50"), Rc[m], Rc[m], g("close_p_q25"), g("close_p_q75"), g("close_p_q05"),
                              g("close_p_q95"), g("close_up"), pc_[m]),
            "naive": _metrics(A_c[m], Rc[m], Rc[m], Rc[m]),
            "drift": _metrics(A_c[m], g("drift_p"), Rc[m], Rc[m]),
        }
        rep = g("replica")
        mid_rows = {
            "model": _metrics(A_m[m], g("mid_p_q50"), Rm[m], Rm[m], g("mid_p_q25"), g("mid_p_q75"), g("mid_p_q05"), g("mid_p_q95"),
                              naive2=Rc[m]),
            "naive": _metrics(A_m[m], Rm[m], Rm[m], Rm[m], naive2=Rc[m]),
            "naive_close": _metrics(A_m[m], Rc[m], Rm[m], Rm[m], naive2=Rc[m]),
            "replica": _metrics(A_m[m], rep, Rm[m], Rm[m], naive2=Rc[m]) if np.isfinite(rep).sum() >= 10 else {"n": int(np.isfinite(rep).sum())},
        }
        t = s["target"][m]
        out[name] = {
            "from": t.min() if len(t) else None, "to": t.max() if len(t) else None,
            "close": {k: {**v, "verdict": _verdict(v, k == "naive")} for k, v in close_rows.items()},
            "mid": {k: {**v, "verdict": _verdict(v, k in ("naive", "naive_close"), vs_close=k == "model")}
                    for k, v in mid_rows.items()},
        }
    return out


def _train(progress=lambda s: None) -> dict:
    t0 = time.time()
    progress("feature store (giorni chiusi)")
    feat, ohlc = _load_inputs()
    ctx, ctx_m, mid = _ctxs(feat, ohlc)
    raw = _load_raw()
    raw = _walk_forward(ctx, ctx_m, raw, progress)
    store.write_parquet(raw, RAW_FILE)
    t1 = time.time()
    progress("calibrazione conforme e P(rialzo)")
    s = _calibrate(raw, ctx, ctx_m, mid)
    s = _price_cols(s)
    progress("replica CryptoPredictions (Random Forest)")
    rep, rep_info = _replica(ohlc)
    s = s.set_index("target", drop=False)
    s["replica"] = rep["replica"].reindex(s.index)
    s["replica_in_valid"] = rep["in_valid"].reindex(s.index).fillna(False).astype(bool)
    s = s.reset_index(drop=True)
    t2 = time.time()
    progress("metriche e verdetto")
    ev = _evaluate(s, rep_info)
    # controllo strutturale: ogni modello addestrato solo su target realizzati entro l'origine della previsione
    tr_c = pd.to_datetime(s["train_end_close"]) + pd.Timedelta(days=1)
    tr_m = pd.to_datetime(s["train_end_mid"]) + pd.Timedelta(days=1)
    viol = int(((tr_c > s["origin"]) | (tr_m > s["origin"])).sum())
    gap = (s["origin"] - (pd.to_datetime(s["train_end_close"]) + pd.Timedelta(days=1))).dt.days
    progress("controllo di leakage delle feature")
    T = ctx.n - 1
    D = ctx.dates
    chk_dates = [pd.Timestamp("2022-06-15"), D[max(T - 40, 0)]]
    try:
        pit = leakage_check(chk_dates, feat)
    except Exception as e:  # noqa: BLE001
        log.warning("controllo point-in-time fallito: %s", e)
        pit = {"dates": [], "passed": None, "error": str(e)[:200]}
    leak = {
        "structural_violations": viol, "rows": int(len(s)),
        "min_gap_days": int(gap.min()), "max_gap_days": int(gap.max()),
        "replica_no_overlap": rep_info["no_overlap"], "point_in_time": pit,
        "passed": bool(viol == 0 and rep_info["no_overlap"] and pit.get("passed") is not False),
    }
    live_rows = s[s["live"]]
    elapsed = time.time() - t0
    log.info("forecast 1g addestrato in %.1fs (walk-forward %.1fs, calibrazione+replica %.1fs)", elapsed, t1 - t0, t2 - t1)
    return {
        "version": VERSION, "trained_at": int(time.time()), "data_day": str(D[T].date()), "series": s,
        "evaluation": ev, "replica": rep_info, "leakage": leak,
        "live_from": live_rows["origin"].min() if len(live_rows) else None,
        "n_refits": int(pd.to_datetime(raw["origin"]).dt.to_period("M").nunique()),
        "seconds": {"total": elapsed, "walk_forward": t1 - t0, "calibration_replica": t2 - t1},
    }


# ------------------------------------------------------------------ stato, persistenza, thread

_state = {"full": None, "training": False, "error": None, "progress": None, "last_try": 0.0, "started_at": None}
_lock = threading.Lock()


def _save(full: dict) -> None:
    store.write_parquet(full["series"], SERIES_FILE)
    meta = {k: v for k, v in full.items() if k != "series"}
    store.write_text(META_FILE, json.dumps(clean(meta), ensure_ascii=False))


def _load() -> dict | None:
    try:
        if SERIES_FILE.exists() and META_FILE.exists():
            meta = json.loads(META_FILE.read_text(encoding="utf-8"))
            if meta.get("version") != VERSION:
                return None
            s = pd.read_parquet(SERIES_FILE)
            for c in ("origin", "target"):
                s[c] = pd.to_datetime(s[c])
            meta["series"] = s
            return meta
    except Exception as e:  # noqa: BLE001
        log.warning("cache 1g su disco illeggibile: %s", e)
    return None


def _is_stale(full: dict | None) -> bool:
    if full is None or full.get("version") != VERSION:
        return True
    return pd.Timestamp(full["data_day"]) < _last_closed_day()


def _thread() -> None:
    try:
        full = _train(lambda s: _state.update(progress=s))
        _save(full)
        _state.update(full=full, error=None)
    except Exception as e:  # noqa: BLE001
        log.exception("addestramento previsione 1g fallito")
        _state["error"] = str(e)[:300]
    finally:
        _state.update(training=False, progress=None)
        _lock.release()


def ensure_training() -> None:
    if _state["full"] is None:
        m = _load()
        if m is not None:
            _state["full"] = m
    if not _is_stale(_state["full"]) or _state["training"]:
        return
    if _state["error"] and time.time() - _state["last_try"] < 600:
        return
    if not _lock.acquire(blocking=False):
        return
    _state.update(training=True, started_at=int(time.time()), last_try=time.time())
    threading.Thread(target=_thread, daemon=True, name="forecast-1d-train").start()


def is_ready() -> bool:
    return _state["full"] is not None


# ------------------------------------------------------------------ risposta API

def _r(x, nd=0):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(x):
        return None
    return round(x, nd) if nd else round(x)


def _training_info(full: dict | None) -> dict:
    return {"status": "training" if _state["training"] else ("error" if _state["error"] else "ready"),
            "progress": _state["progress"], "error": _state["error"],
            "trained_at": full["trained_at"] if full else None, "data_day": full["data_day"] if full else None,
            "seconds": full["seconds"] if full else {}, "started_at": _state["started_at"]}


def build() -> dict:
    ensure_training()
    full = _state["full"]
    if full is None:
        raise RuntimeError("previsione a 1 giorno in addestramento" if _state["training"] else (_state["error"] or "non disponibile"))
    s = full["series"]
    last = s.iloc[-1]                          # origine = ultima candela chiusa, target = prossima chiusura
    from .forecast import live_price  # noqa: PLC0415

    lp = live_price()
    ref = float(last["ref_close"])
    q = {c: ref * float(np.exp(last[f"close_{c}"])) for c in QCOLS}
    qm = {c: ref * float(np.exp(last[f"mid_{c}"])) for c in QCOLS}
    target = pd.Timestamp(last["target"])
    tomorrow = {
        "origin": last["origin"], "target": target, "closes_at": target + pd.Timedelta(days=1),
        "ref_price": ref, "median": q["q50"], "p05": q["q05"], "p25": q["q25"], "p75": q["q75"], "p95": q["q95"],
        "change_pct": 100 * (q["q50"] / ref - 1), "up_prob": 100 * float(last["close_up"]),
        "up_prob_raw": 100 * float(last["close_up_raw"]),
        "mid": {"median": qm["q50"], "p05": qm["q05"], "p95": qm["q95"]},
        "drift_price": float(last["drift_p"]), "naive_price": ref,
        "live_price": lp,
        "live_change_pct": 100 * (lp / ref - 1) if lp else None,
        "live_in_band": (None if not lp else ("50" if q["q25"] <= lp <= q["q75"] else "90" if q["q05"] <= lp <= q["q95"] else "out")),
    }
    rs = s.iloc[:-1] if pd.isna(last["close"]) else s
    rs = rs[rs["close"].notna()]
    series = {
        "t": [ts(x) for x in rs["target"]],
        "close": [_r(x) for x in rs["close"]], "ref": [_r(x) for x in rs["ref_close"]],
        "model": [_r(x) for x in rs["close_p_q50"]],
        "p05": [_r(x) for x in rs["close_p_q05"]], "p25": [_r(x) for x in rs["close_p_q25"]],
        "p75": [_r(x) for x in rs["close_p_q75"]], "p95": [_r(x) for x in rs["close_p_q95"]],
        "up": [_r(100 * x, 1) for x in rs["close_up"]],
        "drift": [_r(x) for x in rs["drift_p"]],
        "mid": [_r(x) for x in rs["mid"]], "ref_mid": [_r(x) for x in rs["ref_mid"]],
        "model_mid": [_r(x) for x in rs["mid_p_q50"]],
        "replica": [_r(x) for x in rs["replica"]],
        "replica_valid": [bool(x) for x in rs["replica_in_valid"]],
        "live": [bool(x) for x in rs["live"]],
    }
    rep = full["replica"]
    return clean({
        "version": VERSION, "generated_at": int(time.time()), "data_day": full["data_day"],
        "tomorrow": tomorrow, "series": series, "evaluation": full["evaluation"],
        "periods": {"repo": {"from": rep["valid_from"], "to": rep["valid_to"]}},
        "replica": {**rep, **{k: REPO[k] for k in ("url", "window_size", "train_start", "train_end", "valid_start", "valid_end",
                                                   "features", "n_estimators")}},
        "leakage": full["leakage"], "live_from": full.get("live_from"), "n_refits": full.get("n_refits"),
        "settings": {"oos_start": OOS_START, "dir_eps_pct": DIR_EPS * 100, "conformal_window": 1095, "platt_window": 1460,
                     "n_features": len(ff.FEATURE_KEYS), "refit": "monthly", "window": "expanding",
                     "train_start_close": fm.TRAIN_START, "train_start_mid": MID_TRAIN_START},
        "training": _training_info(full),
    })


def summary() -> dict | None:
    """Numeri chiave per l'agente Previsioni (None se il modello non è pronto)."""
    if _state["full"] is None:
        ensure_training()
        if _state["full"] is None:
            return None
    f = build()
    ev = f["evaluation"]["all"]["close"]["model"]
    return {"tomorrow": f["tomorrow"], "all": ev, "naive": f["evaluation"]["all"]["close"]["naive"],
            "y1": f["evaluation"]["y1"]["close"]["model"], "data_day": f["data_day"]}


def warm() -> None:
    while True:
        try:
            ensure_training()
        except Exception as e:  # noqa: BLE001
            log.warning("warm previsione 1g fallito: %s", e)
        time.sleep(600)
