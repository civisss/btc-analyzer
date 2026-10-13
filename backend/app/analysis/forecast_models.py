"""Membri dell'ensemble di previsione + motore walk-forward, combinazione e calibrazione conforme.

Convenzioni: ogni membro produce, per un orizzonte h e un insieme di giorni p, i quantili QS del log-rendimento
log(P[p+h]/P[p]) (array (n, 5)) e, se disponibile, una probabilità di rialzo. Ogni `fit(ctx, h, end)` usa SOLO
righe d <= end con target già realizzato (end = giorno di refit − h): nessun lookahead.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm

from .forecast_features import FEATURE_KEYS

QS = np.array([0.05, 0.25, 0.50, 0.75, 0.95])
Z = norm.ppf(QS)
TRAIN_START = "2012-01-01"
TOP_WINDOWS = [("2013-11-01", "2014-01-31"), ("2017-11-01", "2018-01-31"), ("2021-10-01", "2021-12-31")]
HALVINGS = pd.to_datetime(["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"])

OLD_FEATURES = ["ret_1d", "ret_7d", "ret_30d", "ret_90d", "vol_30d", "vol_90d", "rsi_14", "mayer", "dist_ma200w", "mvrv",
                "mvrv_z", "funding", "funding_7d", "fng", "days_halving", "dd_ath", "days_ath", "usdt_30d"]


# ------------------------------------------------------------------ contesto

class Ctx:
    """Dati condivisi dai membri: feature, log-prezzi, target per orizzonte, volatilità point-in-time."""

    def __init__(self, feat: pd.DataFrame, horizons=(7, 30, 60, 90)):
        self.feat = feat
        self.dates = feat.index
        self.n = len(feat)
        self.lc = np.log(feat["close"].to_numpy(float))
        self.r = np.r_[0.0, np.diff(self.lc)]
        self.cols = {k: i for i, k in enumerate(FEATURE_KEYS)}
        self.X = feat[FEATURE_KEYS].to_numpy(float)
        self.y = {h: np.r_[self.lc[h:] - self.lc[:-h], np.full(h, np.nan)] for h in horizons}
        r2 = pd.Series(self.r ** 2)
        # vol giornaliera PIT: mix EWMA(30) e media 1 anno (più stabile sugli orizzonti lunghi)
        v = 0.5 * r2.ewm(span=30, min_periods=20).mean() + 0.5 * r2.rolling(365, min_periods=60).mean()
        self.sig = np.sqrt(v.bfill().to_numpy())
        self.start = int(np.searchsorted(self.dates.values, np.datetime64(TRAIN_START)))
        self.rv = {k: np.log(r2.rolling(k, min_periods=1).mean().to_numpy() + 1e-8) for k in (1, 7, 30, 90)}

    def cols_of(self, keys):
        return [self.cols[k] for k in keys]


def _rows(ctx: Ctx, h: int, end: int) -> np.ndarray:
    i = np.arange(ctx.start, min(end, ctx.n - 1 - h) + 1)
    return i[~np.isnan(ctx.y[h][i])]


def _time_w(ctx: Ctx, rows: np.ndarray, floor=0.4) -> np.ndarray:
    yrs = (rows - rows[0]) / 365.25
    return floor + (1 - floor) * yrs / max(yrs.max(), 1e-9)


def wquantile(v: np.ndarray, w: np.ndarray, qs=QS) -> np.ndarray:
    o = np.argsort(v)
    v, w = v[o], w[o]
    c = np.cumsum(w) - 0.5 * w
    c /= w.sum()
    return np.interp(qs, c, v)


# ------------------------------------------------------------------ LightGBM a quantili

LGB_PARAMS = dict(n_estimators=250, learning_rate=0.03, num_leaves=15, min_child_samples=60, subsample=0.8,
                  subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0)
# Optuna (TPE, 150 prove) con CV temporale SOLO su dati < 2019 (fold di test 2016/2017/2018, orizzonti 7/30/90),
# obiettivo = pinball relativa alla passeggiata aleatoria: 1.175 (parametri di default) -> 0.948.
LGB_TUNED = dict(n_estimators=444, learning_rate=0.0103, num_leaves=17, min_child_samples=357, subsample=0.593,
                 subsample_freq=1, colsample_bytree=0.934, reg_lambda=15.98)
LGB_TUNED_FLOOR = 0.454


class LGBQuantile:
    """Regressione a quantili LightGBM. target='z': log-rendimento normalizzato per la volatilità attuale (σ·√h),
    così il modello impara la FORMA condizionata della distribuzione e la scala segue il regime di volatilità."""

    def __init__(self, features=None, params=None, target="z", weight_floor=0.4, n_jobs=2, name="lgb", select=0):
        self.features = list(features or FEATURE_KEYS)
        self.all_features, self.select = list(self.features), select
        self.params = {**LGB_PARAMS, **(params or {})}
        self.target, self.floor, self.n_jobs, self.name = target, weight_floor, n_jobs, name
        self.models = None

    def _scale(self, ctx, h, i):
        return ctx.sig[i] * np.sqrt(h) if self.target == "z" else np.ones(len(i))

    def fit(self, ctx: Ctx, h: int, end: int):
        import lightgbm as lgb

        rows = _rows(ctx, h, end)
        y = ctx.y[h][rows] / self._scale(ctx, h, rows)
        w = _time_w(ctx, rows, self.floor)
        if self.select:
            # selezione delle feature DENTRO il fold: importanza (gain) del modello mediano sui soli dati di training
            Xa = ctx.X[np.ix_(rows, ctx.cols_of(self.all_features))]
            m = lgb.LGBMRegressor(objective="quantile", alpha=0.5, verbose=-1, n_jobs=self.n_jobs, **self.params)
            m.fit(Xa, y, sample_weight=w)
            g = m.booster_.feature_importance(importance_type="gain")
            self.features = [self.all_features[i] for i in np.argsort(-g)[:self.select]]
        X = ctx.X[np.ix_(rows, ctx.cols_of(self.features))]
        self.models = []
        for q in QS:
            m = lgb.LGBMRegressor(objective="quantile", alpha=float(q), verbose=-1, n_jobs=self.n_jobs, **self.params)
            m.fit(X, y, sample_weight=w)
            self.models.append(m)
        return self

    def predict(self, ctx: Ctx, h: int, idx: np.ndarray):
        X = ctx.X[np.ix_(idx, ctx.cols_of(self.features))]
        P = np.column_stack([m.predict(X) for m in self.models])
        P = np.sort(P, axis=1) * self._scale(ctx, h, idx)[:, None]
        return P, None

    def contrib(self, ctx: Ctx, h: int, i: int) -> np.ndarray:
        """Contributi SHAP (pred_contrib) del modello mediano per il giorno i, in unità di log-rendimento."""
        X = ctx.X[[i]][:, ctx.cols_of(self.features)]
        c = self.models[2].predict(X, pred_contrib=True)[0]
        return c * self._scale(ctx, h, np.array([i]))[0]          # ultimo elemento = valore atteso (bias)


# ------------------------------------------------------------------ classificatore di direzione

class LGBDirection:
    """P(rialzo) da LightGBM binario (la calibrazione isotonica/Platt viene stimata a valle sui fold passati)."""

    def __init__(self, features=None, params=None, n_jobs=2, name="clf"):
        self.features = list(features or FEATURE_KEYS)
        self.params = {**dict(n_estimators=200, learning_rate=0.03, num_leaves=7, min_child_samples=120, subsample=0.8,
                              subsample_freq=1, colsample_bytree=0.6, reg_lambda=5.0), **(params or {})}
        self.n_jobs, self.name = n_jobs, name
        self.model = None

    def fit(self, ctx: Ctx, h: int, end: int):
        import lightgbm as lgb

        rows = _rows(ctx, h, end)
        X = ctx.X[np.ix_(rows, ctx.cols_of(self.features))]
        y = (ctx.y[h][rows] > 0).astype(int)
        self.model = lgb.LGBMClassifier(objective="binary", verbose=-1, n_jobs=self.n_jobs, **self.params)
        self.model.fit(X, y, sample_weight=_time_w(ctx, rows))
        return self

    def predict(self, ctx: Ctx, h: int, idx: np.ndarray):
        X = ctx.X[np.ix_(idx, ctx.cols_of(self.features))]
        return None, self.model.predict_proba(X)[:, 1]


# ------------------------------------------------------------------ kNN "stato di mercato"

KNN_STATE = ["ret_30d", "ret_90d", "ret_180d", "vol_30d", "dd_ath", "mayer", "dist_ma200w", "mvrv", "rsi_14",
             "pl_resid", "halv_sin", "halv_cos", "days_low"]
_LOGS = {"vol_30d", "mayer", "mvrv", "days_low"}


class KNNAnalog:
    """Giorni passati con stato di mercato simile (feature standardizzate) -> distribuzione dei loro rendimenti futuri,
    riscalati per il rapporto di volatilità (σ oggi / σ allora)."""

    def __init__(self, features=None, k=120, name="knn"):
        self.features = list(features or KNN_STATE)
        self.k, self.name = k, name

    def _state(self, ctx):
        if getattr(ctx, "_knn_state", None) is None or ctx._knn_keys != self.features:
            S = ctx.feat[self.features].copy()
            for c in self.features:
                if c in _LOGS:
                    S[c] = np.log(np.maximum(S[c], 1e-6) + (1.0 if c == "days_low" else 0.0))
            ctx._knn_state, ctx._knn_keys = S.to_numpy(float), list(self.features)
        return ctx._knn_state

    def fit(self, ctx: Ctx, h: int, end: int):
        S = self._state(ctx)
        rows = np.arange(ctx.start, end + 1)
        self.mu = np.nanmean(S[rows], axis=0)
        self.sd = np.nanstd(S[rows], axis=0) + 1e-9
        return self

    def predict(self, ctx: Ctx, h: int, idx: np.ndarray):
        S = (self._state(ctx) - self.mu) / self.sd
        y = ctx.y[h]
        out = np.full((len(idx), 5), np.nan)
        for j, p in enumerate(idx):
            cand = np.arange(ctx.start, p - h + 1)
            cand = cand[~np.isnan(y[cand])]
            if len(cand) < 300:
                continue
            D = S[cand] - S[p]
            ok = ~np.isnan(D)
            d = np.sqrt(np.where(ok, D * D, 0).sum(1) / np.maximum(ok.sum(1), 1))
            k = min(self.k, len(cand) // 5)
            sel = np.argpartition(d, k)[:k]
            dk = d[sel]
            w = np.exp(-0.5 * (dk / (np.median(dk) + 1e-9)) ** 2)
            nb = cand[sel]
            yy = y[nb] * (ctx.sig[p] / ctx.sig[nb])
            out[j] = wquantile(yy, w)
        return out, None


# ------------------------------------------------------------------ HAR: volatilità + residui empirici

class HARVol:
    """HAR-RV (Corsi) sul log della varianza realizzata media dei prossimi h giorni; la distribuzione è
    σ̂_h · quantili empirici dei rendimenti standardizzati passati (cattura asimmetria e drift storico)."""

    name = "har"

    def _X(self, ctx, i):
        return np.column_stack([np.ones(len(i))] + [ctx.rv[k][i] for k in (1, 7, 30, 90)])

    def fit(self, ctx: Ctx, h: int, end: int):
        rows = _rows(ctx, h, end)
        r2 = ctx.r ** 2
        cs = np.r_[0, np.cumsum(r2)]
        tgt = np.log((cs[rows + h + 1] - cs[rows + 1]) / h + 1e-8)
        w = _time_w(ctx, rows)
        A = self._X(ctx, rows) * np.sqrt(w)[:, None]
        self.beta = np.linalg.lstsq(A, tgt * np.sqrt(w), rcond=None)[0]
        sig = np.sqrt(np.exp(self._X(ctx, rows) @ self.beta) * h)
        z = ctx.y[h][rows] / sig
        self.zq = wquantile(z[-1500:], w[-1500:])
        return self

    def predict(self, ctx: Ctx, h: int, idx: np.ndarray):
        sig = np.sqrt(np.exp(self._X(ctx, idx) @ self.beta) * h)
        return sig[:, None] * self.zq[None, :], None


# ------------------------------------------------------------------ Monte Carlo per regimi (invariato)

class RegimeMC:
    name = "mc"

    def __init__(self, ctx: Ctx, n_paths=500, L=10):
        f = ctx.feat
        self.r = ctx.r
        self.vol = (pd.Series(self.r).rolling(30).std() * np.sqrt(365)).bfill().to_numpy()
        st = np.column_stack([
            np.log(np.maximum(self.vol, 1e-3)), f["dd_ath"].to_numpy(),
            np.log1p(f["days_ath"].fillna(0).to_numpy()) * 0.5, f["ret_90d"].fillna(0).to_numpy(),
        ])
        self.state = np.nan_to_num(st)
        self.n_paths, self.L = n_paths, L
        self._cache: dict = {}

    def fit(self, ctx, h, end):
        return self

    def path(self, T: int, H: int, n_paths=None, seed=0) -> np.ndarray:
        n_paths = n_paths or self.n_paths
        L = self.L
        rng = np.random.default_rng(seed + T)
        cand = np.arange(365, T - L)
        S = self.state[cand]
        sd = S.std(axis=0) + 1e-9
        d = np.sqrt((((S - self.state[T]) / sd) ** 2 * np.array([1.0, 1.5, 1.0, 0.7])).sum(axis=1))
        K = max(150, int(0.05 * len(cand)))
        nb = cand[np.argsort(d)[:K]]
        lr_vol = float(np.median(self.vol[max(365, T - 4 * 365):T]))
        vol_now = float(self.vol[T])
        nblk = int(np.ceil(H / L))
        starts = rng.choice(nb, size=(n_paths, nblk))
        offs = np.arange(1, L + 1)
        blk = self.r[starts[..., None] + offs]
        src_vol = np.repeat(self.vol[starts][..., None], L, axis=2)
        blk = blk.reshape(n_paths, -1)[:, :H]
        src_vol = src_vol.reshape(n_paths, -1)[:, :H]
        t = np.arange(1, H + 1)
        target_vol = lr_vol + (vol_now - lr_vol) * np.exp(-t / 60.0)
        scale = np.clip(target_vol[None, :] / np.maximum(src_vol, 1e-3), 0.5, 2.0)
        mu_nb = float(self.r[(nb[:, None] + offs).ravel()].mean())
        mu_c = float(np.clip(0.4 * mu_nb, -0.001, 0.001))
        adj = (blk - mu_nb) * scale + mu_c
        cum = np.concatenate([np.zeros((n_paths, 1)), np.cumsum(adj, axis=1)], axis=1)
        return np.quantile(cum, QS, axis=0).T

    def predict(self, ctx, h, idx):
        out = np.empty((len(idx), 5))
        for j, p in enumerate(idx):
            key = (int(p), 90 if h <= 90 else 365)
            if key not in self._cache:
                self._cache[key] = self.path(key[0], key[1])
            out[j] = self._cache[key][h]
        return out, None


# ------------------------------------------------------------------ analoghi di ciclo (invariato)

class CycleAnalog:
    name = "an"

    def __init__(self, ctx: Ctx):
        self.idx = ctx.dates
        self.lc = ctx.lc
        r = ctx.r
        self.vol365 = pd.Series(r).rolling(365, min_periods=120).std().bfill().to_numpy()
        self.vol90 = pd.Series(r).rolling(90, min_periods=30).std().bfill().to_numpy()
        self.tops = []
        for a, b in TOP_WINDOWS:
            m = (self.idx >= a) & (self.idx <= b)
            if m.any():
                ii = np.where(m)[0]
                self.tops.append(int(ii[np.argmax(self.lc[ii])]))
        self.halv = [int(np.searchsorted(self.idx.values, h.to_datetime64())) for h in HALVINGS]

    def fit(self, ctx, h, end):
        return self

    def anchors(self, T: int, H: int):
        hist = self.lc[: T + 1]
        ath = int(np.argmax(hist))
        dd = hist[-1] - hist[ath]
        dsa = T - ath
        mode, anchors = None, []
        if dd <= np.log(0.8) and dsa >= 90:
            tops = [tp for tp in self.tops if tp < ath - 365 and tp + dsa + H <= T]
            if len(tops) >= 2:
                mode, anchors = "top", [(tp, tp + dsa) for tp in tops]
        if mode is None:
            hv = [h for h in self.halv if h <= T]
            if hv:
                dsh = T - hv[-1]
                prev = [h for h in hv[:-1] if h + dsh + H <= T]
                if len(prev) >= 2:
                    mode, anchors = "halving", [(h, h + dsh) for h in prev]
        return mode, anchors

    def quantiles(self, T: int, H: int):
        mode, anchors = self.anchors(T, H)
        if not anchors:
            return None, None, []
        n = len(anchors)
        w = np.arange(1, n + 1, dtype=float)
        w /= w.sum()
        paths = []
        for _, a in anchors:
            scale = float(np.clip(self.vol365[T] / self.vol365[a], 0.25, 1.25))
            paths.append((self.lc[a: a + H + 1] - self.lc[a]) * scale)
        P = np.array(paths)
        center = (w[:, None] * P).sum(axis=0) * 0.75
        between = (w[:, None] * (P - center) ** 2).sum(axis=0)
        t = np.arange(H + 1)
        sd = np.sqrt(between + (self.vol90[T] ** 2) * t)
        return center[:, None] + sd[:, None] * Z[None, :], mode, [(self.idx[tp], P[i]) for i, (tp, _) in enumerate(anchors)]

    def predict(self, ctx, h, idx):
        out = np.full((len(idx), 5), np.nan)
        for j, p in enumerate(idx):
            q, _, _ = self.quantiles(int(p), h)
            if q is not None:
                out[j] = q[h]
        return out, None


# ------------------------------------------------------------------ baseline

class RandomWalk:
    """Baseline: passeggiata aleatoria lognormale. drift=False -> deriva nulla; True -> deriva storica (media espandente)."""

    def __init__(self, drift=False):
        self.drift = drift
        self.name = "rw_drift" if drift else "rw0"

    def fit(self, ctx, h, end):
        self.mu = float(np.mean(ctx.r[ctx.start:end + 1])) if self.drift else 0.0
        return self

    def predict(self, ctx, h, idx):
        sd = np.array([np.std(ctx.r[max(1, p - 364):p + 1]) for p in idx]) * np.sqrt(h)
        return self.mu * h + sd[:, None] * Z[None, :], None


# ------------------------------------------------------------------ walk-forward

def refit_points(ctx: Ctx, idx: np.ndarray) -> list[tuple[int, np.ndarray]]:
    """Raggruppa i giorni di test per mese di calendario: il modello del blocco è riaddestrato il 1° del mese."""
    months = ctx.dates[idx].to_period("M")
    out = []
    for m in pd.unique(months):
        blk = idx[months == m]
        first = int(np.searchsorted(ctx.dates.values, m.start_time.to_datetime64()))
        out.append((first, blk))
    return out


def walk_forward(ctx: Ctx, h: int, member, idx: np.ndarray, refit=1):
    """Previsioni out-of-sample del membro per i giorni idx (refit ogni `refit` mesi su dati con target realizzato)."""
    Q = np.full((len(idx), 5), np.nan)
    P = np.full(len(idx), np.nan)
    pos = 0
    for k, (first, blk) in enumerate(refit_points(ctx, idx)):
        if k % refit == 0:
            member.fit(ctx, h, first - h)
        q, p = member.predict(ctx, h, blk)
        if q is not None:
            Q[pos:pos + len(blk)] = q
        if p is not None:
            P[pos:pos + len(blk)] = p
        pos += len(blk)
    return Q, P


# ------------------------------------------------------------------ metriche

def pinball(Q: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Pinball loss media sui 5 quantili, per riga (≈ CRPS/2 discretizzato)."""
    d = y[:, None] - Q
    return np.mean(np.maximum(QS * d, (QS - 1) * d), axis=1)


def cdf0(Q: np.ndarray, x: float = 0.0) -> np.ndarray:
    """P(logret <= x) per riga, interpolando i 5 quantili nello spazio dei punteggi normali (code lineari)."""
    out = np.full(len(Q), np.nan)
    for i, q in enumerate(Q):
        if np.isnan(q).any():
            continue
        q = np.maximum.accumulate(q)
        if q[-1] - q[0] < 1e-12:
            out[i] = 0.5
            continue
        if x <= q[0]:
            z = Z[0] + (x - q[0]) / max((q[1] - q[0]) / (Z[1] - Z[0]), 1e-9)
        elif x >= q[-1]:
            z = Z[-1] + (x - q[-1]) / max((q[-1] - q[-2]) / (Z[-1] - Z[-2]), 1e-9)
        else:
            z = float(np.interp(x, q + np.arange(5) * 1e-12, Z))
        out[i] = norm.cdf(z)
    return np.clip(out, 0.005, 0.995)


# ------------------------------------------------------------------ combinazione e calibrazione (solo passato)

def _past_mask(p_idx: np.ndarray, p: int, h: int, window: int) -> np.ndarray:
    return (p_idx <= p - h) & (p_idx > p - h - window)


def combine_weights(L: dict[str, np.ndarray], p_idx: np.ndarray, h: int, window=730, temp=0.08, min_n=20,
                    live: dict[str, tuple[float, int]] | None = None) -> dict[str, np.ndarray]:
    """Pesi per riga: softmax di −(pinball relativa)/temp calcolata sulle sole previsioni già realizzate nella finestra.
    `live` (membro -> (pinball live, n)) sposta la stima verso il rendimento live con peso n/(n+50) (solo produzione)."""
    names = list(L)
    W = {k: np.full(len(p_idx), np.nan) for k in names}
    for i, p in enumerate(p_idx):
        m = _past_mask(p_idx, p, h, window)
        mean = {}
        for k in names:
            v = L[k][m]
            v = v[~np.isnan(v)]
            if len(v) >= min_n:
                mean[k] = float(v.mean())
        if live:
            for k, (lv, n) in live.items():
                if k in mean and n > 0:
                    a = n / (n + 50.0)
                    mean[k] = (1 - a) * mean[k] + a * lv
        if not mean:
            for k in names:
                W[k][i] = 1.0
            continue
        best = min(mean.values())
        ex = {k: np.exp(-(v / best - 1) / temp) for k, v in mean.items()}
        s = sum(ex.values())
        for k in names:
            W[k][i] = ex.get(k, 0.0) / s
    return W


def blend(Qs: dict[str, np.ndarray], W: dict[str, np.ndarray]) -> np.ndarray:
    """Media pesata dei quantili (Vincentizzazione), ignorando i membri non disponibili per la riga."""
    names = list(Qs)
    num = np.zeros_like(next(iter(Qs.values())))
    den = np.zeros(len(num))
    for k in names:
        q, w = Qs[k], np.nan_to_num(W[k])
        ok = ~np.isnan(q).any(axis=1) & (w > 0)
        num[ok] += w[ok, None] * q[ok]
        den[ok] += w[ok]
    out = num / np.where(den > 0, den, np.nan)[:, None]
    return np.sort(out, axis=1)


def conformal(Q: np.ndarray, y: np.ndarray, p_idx: np.ndarray, h: int, window=1095, min_n=60, cmax=1.0,
              pairs=((0, 4, 0.90), (1, 3, 0.50))) -> tuple[np.ndarray, np.ndarray]:
    """Split-conformal "CQR relativo" su finestra mobile di previsioni passate già realizzate: per ogni banda (lo, hi)
    s = max(lo − y, y − hi) / (hi − lo); la banda viene allargata/ristretta di c·(hi − lo), con c = quantile (1−α) di s.
    Restituisce i quantili calibrati e i fattori c per riga (colonne: banda 90, banda 50)."""
    out = Q.copy()
    C = np.full((len(Q), len(pairs)), np.nan)
    for j, (lo, hi, cov) in enumerate(pairs):
        wdt = np.maximum(Q[:, hi] - Q[:, lo], 1e-9)
        s = np.maximum(Q[:, lo] - y, y - Q[:, hi]) / wdt
        for i, p in enumerate(p_idx):
            m = _past_mask(p_idx, p, h, window) & ~np.isnan(s)
            if m.sum() < min_n:
                continue
            v = s[m]
            n = len(v)
            c = float(np.quantile(v, min(1.0, cov * (1 + 1 / n))))
            c = float(np.clip(c, -0.45, cmax))                  # limiti: non restringere oltre il 90%, non oltre ×(1+2·cmax)
            C[i, j] = c
            out[i, lo] = Q[i, lo] - c * wdt[i]
            out[i, hi] = Q[i, hi] + c * wdt[i]
    # coerenza: la banda 50 dentro la 90 e mediana in mezzo
    out[:, 1] = np.minimum(out[:, 1], out[:, 2])
    out[:, 3] = np.maximum(out[:, 3], out[:, 2])
    out[:, 0] = np.minimum(out[:, 0], out[:, 1])
    out[:, 4] = np.maximum(out[:, 4], out[:, 3])
    return out, C


def platt_stack(feats: list[np.ndarray], y: np.ndarray, p_idx: np.ndarray, h: int, window=1460, min_n=150, C=1.0):
    """P(rialzo) calibrata: regressione logistica su logit delle probabilità grezze, stimata solo sul passato."""
    from sklearn.linear_model import LogisticRegression

    Xl = np.column_stack([np.log(np.clip(f, 0.01, 0.99) / (1 - np.clip(f, 0.01, 0.99))) for f in feats])
    yy = (y > 0).astype(float)
    out = np.full(len(p_idx), np.nan)
    coefs = None
    last_fit = -10 ** 9
    model = None
    for i, p in enumerate(p_idx):
        if p - last_fit >= 30 or model is None:
            m = _past_mask(p_idx, p, h, window) & ~np.isnan(Xl).any(1) & ~np.isnan(y)
            if m.sum() >= min_n and 0 < yy[m].mean() < 1:
                model = LogisticRegression(C=C).fit(Xl[m], yy[m])
                coefs = (model.intercept_.tolist(), model.coef_.ravel().tolist())
                last_fit = p
        if model is not None and not np.isnan(Xl[i]).any():
            out[i] = model.predict_proba(Xl[[i]])[0, 1]
    return out, coefs


def simplex_fit(Qm: np.ndarray, ym: np.ndarray, init: np.ndarray | None = None, shrink=0.02) -> np.ndarray:
    """Pesi sul simplesso che minimizzano la pinball del blend (Qm: (k, n, 5)); penalità L2 verso pesi uguali."""
    from scipy.optimize import minimize

    k = Qm.shape[0]
    init = np.full(k, 1 / k) if init is None else init
    scale = float(np.mean(Qm.std()))

    def f(z):
        w = np.exp(z - z.max())
        w /= w.sum()
        B = np.sort(np.tensordot(w, Qm, axes=1), axis=1)
        return pinball(B, ym).mean() + shrink * scale * np.sum((w - 1 / k) ** 2)

    z = minimize(f, np.log(init + 1e-6), method="Nelder-Mead", options={"maxiter": 400, "xatol": 1e-3, "fatol": 1e-7}).x
    w = np.exp(z - z.max())
    return w / w.sum()


def opt_weights(Qs: dict[str, np.ndarray], y: np.ndarray, p_idx: np.ndarray, h: int, window=1460, min_n=60,
                every=30, shrink=0.02) -> dict[str, np.ndarray]:
    """Pesi convessi ristimati ogni `every` giorni sulle sole previsioni passate già realizzate (finestra mobile)."""
    names = list(Qs)
    k = len(names)
    W = {n: np.full(len(p_idx), np.nan) for n in names}
    avail = np.column_stack([~np.isnan(Qs[n]).any(1) for n in names])
    cur, last = np.full(k, 1 / k), -10 ** 9
    for i, p in enumerate(p_idx):
        if p - last >= every:
            m = _past_mask(p_idx, p, h, window) & avail.all(1) & ~np.isnan(y)
            if m.sum() >= min_n:
                cur = simplex_fit(np.stack([Qs[n][m] for n in names]), y[m], cur, shrink)
                last = p
        for j, n in enumerate(names):
            W[n][i] = cur[j]
    return W


def conformal_factor(Q: np.ndarray, y: np.ndarray, mask: np.ndarray, lo: int, hi: int, cov: float, min_n=60, cmax=1.0):
    """Fattore c del CQR relativo per una banda, stimato sulle righe `mask` (passato realizzato)."""
    wdt = np.maximum(Q[:, hi] - Q[:, lo], 1e-9)
    s = np.maximum(Q[:, lo] - y, y - Q[:, hi]) / wdt
    m = mask & ~np.isnan(s)
    if m.sum() < min_n:
        return None
    n = int(m.sum())
    return float(np.clip(np.quantile(s[m], min(1.0, cov * (1 + 1 / n))), -0.45, cmax))


def apply_conformal(q: np.ndarray, c90: float | None, c50: float | None) -> np.ndarray:
    q = np.array(q, float)
    for (lo, hi), c in (((0, 4), c90), ((1, 3), c50)):
        if c is None:
            continue
        w = q[hi] - q[lo]
        q[lo], q[hi] = q[lo] - c * w, q[hi] + c * w
    q[1] = min(q[1], q[2])
    q[3] = max(q[3], q[2])
    q[0] = min(q[0], q[1])
    q[4] = max(q[4], q[3])
    return q


def tune_lgb(ctx: Ctx, n_trials: int = 150, years=(2016, 2017, 2018), horizons=(7, 30, 90), seed: int = 1) -> dict:
    """Ricerca Optuna (TPE) degli iperparametri di LGBQuantile con CV temporale SOLO su dati precedenti a `years[-1]+1`
    (fold di test = anni interi, training = tutto ciò che è realizzato prima del fold). Obiettivo: pinball media relativa
    alla passeggiata aleatoria. Usata offline per ottenere LGB_TUNED (non viene eseguita all'avvio)."""
    import optuna  # noqa: PLC0415
    from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415

    D = ctx.dates.values
    folds = [(int(np.searchsorted(D, np.datetime64(f"{y}-01-01"))), int(np.searchsorted(D, np.datetime64(f"{y + 1}-01-01"))))
             for y in years]

    def score(params, floor):
        def one(t):
            h, a, b = t
            m = LGBQuantile(None, params, target="z", weight_floor=floor, n_jobs=1).fit(ctx, h, a - h)
            idx = np.arange(a, min(b, ctx.n - h), 3)
            q, _ = m.predict(ctx, h, idx)
            rw = RandomWalk(False).fit(ctx, h, a - h).predict(ctx, h, idx)[0]
            y = ctx.y[h][idx]
            return pinball(q, y).mean() / pinball(rw, y).mean()

        with ThreadPoolExecutor(9) as ex:
            return float(np.mean(list(ex.map(one, [(h, a, b) for h in horizons for a, b in folds]))))

    def objective(tr):
        p = dict(n_estimators=tr.suggest_int("n_estimators", 60, 500, log=True),
                 learning_rate=tr.suggest_float("learning_rate", 0.01, 0.1, log=True),
                 num_leaves=tr.suggest_int("num_leaves", 3, 31, log=True),
                 min_child_samples=tr.suggest_int("min_child_samples", 20, 400, log=True),
                 subsample=tr.suggest_float("subsample", 0.5, 1.0), subsample_freq=1,
                 colsample_bytree=tr.suggest_float("colsample_bytree", 0.2, 1.0),
                 reg_lambda=tr.suggest_float("reg_lambda", 1e-3, 30, log=True))
        return score(p, tr.suggest_float("floor", 0.1, 1.0))

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    st = optuna.create_study(sampler=optuna.samplers.TPESampler(seed=seed))
    st.optimize(objective, n_trials=n_trials)
    return {"best_value": st.best_value, "default_value": score({}, 0.4), "params": st.best_params}
