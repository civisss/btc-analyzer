"""Previsione probabilistica del prezzo BTC — v2: modello di posizione nel ciclo + ML, combinati e calibrati.

Pipeline (tutta point-in-time, nessun lookahead):
  1. Feature store giornaliero (forecast_features): prezzo, volatilità, ciclo, on-chain, STH/LTH, derivati, stablecoin,
     macro, opzioni, sentiment, indicatori tecnici, stagionalità — con i ritardi di pubblicazione delle fonti.
  2. Membri (forecast_models / forecast_cycle):
       - "cycle": modello di posizione nel ciclo (cicli passati allineati su massimo/minimo/halving, distorsione temporale,
         riscalatura d'ampiezza, pesi per similarità di stato) — il cuore della previsione, fino a 365 giorni;
       - "lgb": LightGBM a quantili (target normalizzato per la volatilità, iperparametri Optuna su dati < 2019), 7–90 g;
       - "mc": Monte Carlo per regimi (block bootstrap con volatilità che rientra verso la media);
       - "rw0": passeggiata aleatoria senza deriva (ancora l'ensemble alla baseline più difficile da battere).
  3. Walk-forward (griglia ogni 3 giorni dal 2014, LightGBM riaddestrato ogni mese dal 2018-07): previsioni fuori
     campione salvate su disco (cache incrementale) -> pesi convessi per orizzonte che minimizzano la pinball sulle
     previsioni passate già realizzate (+ aggiustamento dal registro live di /affidabilita) -> calibrazione conforme
     (CQR relativo) delle bande 50% e 90%.
  4. Valutazione onesta sugli ultimi 4 anni fuori campione vs baseline (random walk, deriva storica, versione precedente).
Addestramento in un thread in background, una volta al giorno o al cambio di versione; le richieste usano sempre l'ultimo
modello pronto (anche da disco dopo un riavvio) e ri-ancorano le bande al prezzo live.
"""
from __future__ import annotations

import json
import logging
import os
import pickle
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from scipy.stats import norm

from ..data import store
from ..util import art, clean, data_it, ts
from . import forecast_cycle as fcy
from . import forecast_features as ff
from . import forecast_models as fm

log = logging.getLogger("forecast")

VERSION = 2
QS = fm.QS
Z = fm.Z
HORIZONS = [7, 30, 60, 90]                  # `targets` (retro-compatibilità)
ALL_H = [7, 30, 60, 90, 180, 365]
ML_H = [7, 30, 60, 90]
MAX_H = 365
GRID_START = pd.Timestamp("2014-01-01")
GRID_STEP = 3
LGB_START = pd.Timestamp("2018-07-01")
TEST_DAYS = 4 * 365
OOS_MAX_AGE = 30 * 86400                    # ricalcolo completo del walk-forward ogni 30 giorni (revisioni dei dati)
OOS_FILE = store.DATA_DIR / "forecast_oos.pkl"
MODEL_FILE = store.DATA_DIR / "forecast_model.pkl"
CYCLE_KAPPA = 0.5                           # la mediana del modello di ciclo è dimezzata (shrinkage verso 0: migliore fuori campione)

MEMBERS_SHORT = ["cycle", "lgb", "mc", "rw0"]
MEMBERS_LONG = ["cycle", "mc", "rw0"]
MEMBER_INFO = {
    "cycle": ("Posizione nel ciclo",
              "Cicli passati allineati sulla posizione attuale (giorni dal massimo, dal minimo e dall'halving), con velocità "
              "del ciclo e ampiezza riscalate sul ciclo in corso e pesi per similarità di stato (drawdown, giorni dal minimo, "
              "MVRV, volatilità). Domina gli orizzonti lunghi."),
    "lgb": ("LightGBM a quantili",
            "Regressione a quantili su ~90 feature point-in-time (prezzo, volatilità, ciclo, on-chain, STH/LTH, derivati, "
            "stablecoin, macro, DVOL, sentiment, indicatori tecnici), target normalizzato per la volatilità, iperparametri "
            "ottimizzati con Optuna su dati precedenti al 2019. Solo 7–90 giorni."),
    "mc": ("Monte Carlo per regimi",
           "Block bootstrap (blocchi di 10 giorni) da periodi storici con volatilità e fase di ciclo simili; volatilità "
           "riportata gradualmente verso la media di lungo periodo (stile GARCH)."),
    "rw0": ("Passeggiata aleatoria",
            "Baseline: nessuna deriva, volatilità dell'ultimo anno. Nell'ensemble funge da àncora prudente: riceve peso "
            "quando gli altri modelli non battono il caso."),
}
BASELINE_INFO = {
    "rw0": "Random walk (deriva zero)", "rw_drift": "Random walk con deriva storica", "previous": "Versione precedente (v1)",
    "ensemble": "Ensemble v2 calibrato",
}

DISCLAIMER = (
    "Questa è un'analisi statistica e probabilistica basata su dati storici e modelli quantitativi (posizione nel ciclo, "
    "LightGBM a quantili, Monte Carlo per regimi), valutata fuori campione con un backtest walk-forward. Non costituisce "
    "consiglio finanziario né raccomandazione di investimento. Le bande descrivono l'incertezza stimata, non certezze: "
    "i cicli passati sono pochi (3–4) e il mercato può comportarsi in modo molto diverso dal passato."
)

# alias per compatibilità (routers/ai.py usa daily_close/build_features)
daily_close = ff.daily_close
build_features = ff.build


# ------------------------------------------------------------------ helper quantili

def _cdf_at(qrow: np.ndarray, x: float = 0.0) -> float:
    return float(fm.cdf0(np.asarray(qrow, float)[None, :], x)[0])


def _q_at(qrow: np.ndarray, p: float) -> float:
    """Quantile al livello p da 5 quantili (interp. in spazio normale, estrapolazione lineare nelle code)."""
    z = norm.ppf(p)
    if z <= Z[0]:
        return float(qrow[0] + (z - Z[0]) * (qrow[1] - qrow[0]) / (Z[1] - Z[0]))
    if z >= Z[-1]:
        return float(qrow[-1] + (z - Z[-1]) * (qrow[-1] - qrow[-2]) / (Z[-1] - Z[-2]))
    return float(np.interp(z, Z, qrow))


def _interp_anchor(anchors: dict[int, np.ndarray], t: np.ndarray) -> np.ndarray:
    """Quantili giornalieri da quantili a orizzonti discreti: mediana lineare a tratti, dispersione ~ √t."""
    hs = np.array(sorted(anchors))
    qa = np.array([anchors[h] for h in hs])
    med = qa[:, 2]
    spr = (qa - med[:, None]) / np.sqrt(hs)[:, None]
    m = np.interp(t, np.r_[0, hs], np.r_[0, med])
    s = np.stack([np.interp(t, hs, spr[:, k]) for k in range(5)], axis=1)
    out = m[:, None] + s * np.sqrt(t)[:, None]
    out[t > hs[-1]] = np.nan
    return out


# ------------------------------------------------------------------ walk-forward con cache incrementale

def _grid(ctx: fm.Ctx) -> np.ndarray:
    first = int(np.searchsorted(ctx.dates.values, GRID_START.to_datetime64()))
    return np.arange(first, ctx.n, GRID_STEP)


def _load_oos() -> dict:
    try:
        if OOS_FILE.exists():
            with open(OOS_FILE, "rb") as f:
                c = pickle.load(f)
            if c.get("version") == VERSION and time.time() - c.get("created", 0) < OOS_MAX_AGE:
                return c
    except Exception as e:  # noqa: BLE001
        log.warning("cache walk-forward illeggibile: %s", e)
    return {"version": VERSION, "created": time.time(), "q": {}}


def _save_pickle(path, obj) -> None:
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as f:
        pickle.dump(obj, f, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, path)


def _walk_forward(ctx: fm.Ctx, cache: dict, progress) -> dict:
    """Completa la cache {(membro, h): {data: quantili}} per tutti i giorni della griglia con target realizzato."""
    Qc = cache["q"]
    D = ctx.dates
    grid = _grid(ctx)
    T = ctx.n - 1
    lgb_first = int(np.searchsorted(D.values, LGB_START.to_datetime64()))

    def missing(key, h, lo=0):
        have = Qc.setdefault((key, h), {})
        return np.array([p for p in grid if lo <= p <= T - h and D[p] not in have], int)

    # --- baseline random walk (vettoriale)
    for h in ALL_H:
        for key, drift in (("rw0", False), ("rw_drift", True)):
            mi = missing(key, h)
            if len(mi):
                for blk_first, blk in fm.refit_points(ctx, mi):
                    m = fm.RandomWalk(drift).fit(ctx, h, blk_first - h)
                    q, _ = m.predict(ctx, h, blk)
                    for p, r in zip(blk, q):
                        Qc[(key, h)][D[p]] = r
    # --- ciclo, Monte Carlo e analoghi v1 (un calcolo per data, tutti gli orizzonti)
    progress("modello di ciclo e Monte Carlo (walk-forward)")
    cyc = fcy.CycleModel(ctx, kappa=CYCLE_KAPPA)
    mc = fm.RegimeMC(ctx, n_paths=500)
    an = fm.CycleAnalog(ctx)
    need = sorted(set().union(*[set(missing("cycle", h)) for h in ALL_H], *[set(missing("mc", h)) for h in ALL_H],
                              *[set(missing("an", h, lgb_first)) for h in ML_H]))

    def per_date(p):
        out = {}
        hs = [h for h in ALL_H if p <= T - h]
        if not hs:
            return p, out
        for h, q in fcy.predict_multi(cyc, int(p), hs).items():
            out[("cycle", h)] = q
        path = mc.path(int(p), max(hs))
        for h in hs:
            out[("mc", h)] = path[h]
        if p >= lgb_first:
            for h in [h for h in ML_H if h in hs]:
                q, _, _ = an.quantiles(int(p), h)
                if q is not None:
                    out[("an", h)] = q[h]
        return p, out

    with ThreadPoolExecutor(max(2, min(8, (os.cpu_count() or 4) // 2))) as ex:
        for p, out in ex.map(per_date, need):
            for k, q in out.items():
                Qc.setdefault(k, {})[D[p]] = q
    # --- LightGBM (v2 tarato e v1), un task per (orizzonte, mese): riaddestramento mensile, solo target realizzati
    progress("LightGBM walk-forward (riaddestramento mensile)")
    tasks = []
    for h in ML_H:
        for key in ("lgb", "lgb_v1"):
            mi = missing(key, h, lgb_first)
            for first, blk in fm.refit_points(ctx, mi):
                tasks.append((key, h, first, blk))

    def run(t):
        key, h, first, blk = t
        m = _lgb_member(key)
        m.fit(ctx, h, first - h)
        q, _ = m.predict(ctx, h, blk)
        return key, h, blk, q

    with ThreadPoolExecutor(max(2, (os.cpu_count() or 4) - 2)) as ex:
        for key, h, blk, q in ex.map(run, tasks):
            for p, r in zip(blk, q):
                Qc[(key, h)][D[p]] = r
    return cache


def _lgb_member(key: str, n_jobs: int = 1):
    if key == "lgb_v1":
        return fm.LGBQuantile(fm.OLD_FEATURES, {"n_estimators": 150}, target="raw", n_jobs=n_jobs, name="lgb_v1")
    return fm.LGBQuantile(None, fm.LGB_TUNED, target="z", weight_floor=fm.LGB_TUNED_FLOOR, n_jobs=n_jobs, name="lgb")


def _arrays(ctx: fm.Ctx, cache: dict, keys, h) -> tuple[np.ndarray, dict]:
    D = ctx.dates
    T = ctx.n - 1
    idx = np.array([p for p in _grid(ctx) if p <= T - h], int)
    out = {}
    for k in keys:
        d = cache["q"].get((k, h), {})
        out[k] = np.array([d.get(D[p], np.full(5, np.nan)) for p in idx], float).reshape(len(idx), 5)
    return idx, out


# ------------------------------------------------------------------ metriche

def _climatology(ctx: fm.Ctx, idx: np.ndarray, h: int) -> np.ndarray:
    y = ctx.y[h]
    up = np.r_[0, np.cumsum(np.nan_to_num(y > 0))]
    cnt = np.r_[0, np.cumsum(~np.isnan(y))]
    s = ctx.start
    out = []
    for p in idx:
        e = max(p - h + 1, s + 1)
        n = cnt[e] - cnt[s]
        out.append((up[e] - up[s]) / n if n > 0 else 0.5)
    return np.array(out)


def _metrics(Q: np.ndarray, y: np.ndarray, pc: np.ndarray) -> dict:
    ok = ~np.isnan(y) & ~np.isnan(Q).any(1)
    n = int(ok.sum())
    if n < 10:
        return {"n": n}
    Q, y, pc = Q[ok], y[ok], pc[ok]
    med = Q[:, 2]
    pu = 1 - fm.cdf0(Q)
    up = (y > 0).astype(float)
    brier = float(np.mean((pu - up) ** 2))
    bref = float(np.mean((pc - up) ** 2))
    zero_med = np.abs(med).max() < 1e-12
    return {
        "n": n,
        "hit_rate": None if zero_med else 100 * float(np.mean(np.sign(med) == np.sign(y))),
        "brier": brier, "brier_clim": bref, "brier_skill": 100 * (1 - brier / bref) if bref > 0 else None,
        "mape": 100 * float(np.mean(np.abs(np.exp(med - y) - 1))),
        "mase": float(np.mean(np.abs(y - med)) / max(np.mean(np.abs(y)), 1e-12)),
        "pinball": float(fm.pinball(Q, y).mean()),
        "coverage_50": 100 * float(np.mean((y >= Q[:, 1]) & (y <= Q[:, 3]))),
        "coverage_90": 100 * float(np.mean((y >= Q[:, 0]) & (y <= Q[:, 4]))),
        "width_50": 100 * float(np.mean(np.exp(Q[:, 3]) - np.exp(Q[:, 1]))),
        "width_90": 100 * float(np.mean(np.exp(Q[:, 4]) - np.exp(Q[:, 0]))),
    }


def _reliability(pu: np.ndarray, up: np.ndarray, bins=10) -> tuple[list[dict], float | None]:
    out, ece, N = [], 0.0, len(pu)
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        m = (pu >= lo) & ((pu < hi) if b < bins - 1 else (pu <= hi))
        n = int(m.sum())
        pr = float(pu[m].mean() * 100) if n else None
        ob = float(up[m].mean() * 100) if n else None
        if n:
            ece += n / N * abs(pr - ob)
        out.append({"bin": b, "from": lo * 100, "to": hi * 100, "n": n, "predicted": pr, "observed": ob})
    return out, (ece if N else None)


def _prev_blend(Qs: dict, y: np.ndarray, idx: np.ndarray, h: int) -> np.ndarray:
    """Ensemble v1: pesi ∝ 1/pinball sulle previsioni passate realizzate (minimo 10%), nessuna calibrazione."""
    names = list(Qs)
    L = {k: fm.pinball(np.nan_to_num(Qs[k]), y) for k in names}
    for k in names:
        L[k][np.isnan(Qs[k]).any(1)] = np.nan
    W = {k: np.full(len(idx), np.nan) for k in names}
    for i, p in enumerate(idx):
        m = idx <= p - h
        inv = {}
        for k in names:
            v = L[k][m]
            v = v[~np.isnan(v)]
            inv[k] = 1 / v.mean() if len(v) >= 4 else 0.0
        s = sum(inv.values())
        if s <= 0:
            inv = {k: 1.0 for k in names}
            s = len(names)
        w = {k: max(v / s, 0.1) for k, v in inv.items()}
        s = sum(w.values())
        for k in names:
            W[k][i] = w[k] / s
    return fm.blend(Qs, W)


# ------------------------------------------------------------------ registro live (/affidabilita) -> pesi

def _live_losses(h: int) -> dict[str, tuple[float, int]]:
    """Pinball dei membri sulle previsioni LIVE già risolte del registro (meta.members salvato allo snapshot)."""
    try:
        from .. import tracking  # noqa: PLC0415

        df = tracking._load()
        d = df[(df["source"] == f"forecast_{h}d") & (df["mode"] == "live") & df["resolved"].astype(bool)]
        acc: dict[str, list[float]] = {}
        for _, r in d.iterrows():
            meta = json.loads(r["meta"] or "{}")
            mem = meta.get("members") or {}
            if not mem or not r["price0"] or not r["actual"]:
                continue
            y = float(np.log(float(r["actual"]) / float(r["price0"])))
            for k, q in mem.items():
                acc.setdefault(k, []).append(float(fm.pinball(np.array([q], float), np.array([y]))[0]))
        return {k: (float(np.mean(v)), len(v)) for k, v in acc.items()}
    except Exception as e:  # noqa: BLE001
        log.debug("perdite live non disponibili: %s", e)
        return {}


def _live_adjust(w: dict[str, float], live: dict[str, tuple[float, int]], temp=0.1) -> tuple[dict, dict]:
    if not live:
        return w, {}
    ls = {k: v for k, v in live.items() if k in w and v[1] > 0}
    if not ls:
        return w, {}
    best = min(v[0] for v in ls.values())
    out = dict(w)
    for k, (lv, n) in ls.items():
        out[k] *= float(np.exp(-(lv / max(best, 1e-9) - 1) / temp * n / (n + 50.0)))
    s = sum(out.values()) or 1.0
    out = {k: v / s for k, v in out.items()}
    return out, {k: {"pinball": v[0], "n": v[1]} for k, v in ls.items()}


# ------------------------------------------------------------------ addestramento

def _train(progress=lambda s: None) -> dict:
    t0 = time.time()
    tm = {}
    progress("feature store")
    feat = ff.build()
    ctx = fm.Ctx(feat, ALL_H)
    T = ctx.n - 1
    D = ctx.dates
    tm["features"] = time.time() - t0

    t1 = time.time()
    cache = _walk_forward(ctx, _load_oos(), progress)
    _save_pickle(OOS_FILE, cache)
    tm["walk_forward"] = time.time() - t1

    # ---------------- combinazione, calibrazione e valutazione per orizzonte
    progress("pesi, calibrazione conforme e valutazione")
    t2 = time.time()
    regime_all = ff.regime_of(feat)
    test_from = T - TEST_DAYS
    hz: dict[int, dict] = {}
    for h in ALL_H:
        names = MEMBERS_SHORT if h in ML_H else MEMBERS_LONG
        extra = ["rw_drift"] + (["lgb_v1", "an"] if h in ML_H else [])
        idx, A = _arrays(ctx, cache, names + extra, h)
        y = ctx.y[h][idx]
        Qs = {k: A[k] for k in names}
        W = fm.opt_weights(Qs, y, idx, h)
        Qraw = fm.blend(Qs, W)
        Qens, _C = fm.conformal(Qraw, y, idx, h)
        # pesi e fattori conformi per la previsione di oggi (solo passato realizzato)
        avail = np.column_stack([~np.isnan(Qs[k]).any(1) for k in names]).all(1)
        mw = (idx > T - h - 1460) & avail & ~np.isnan(y)
        w_now = fm.simplex_fit(np.stack([Qs[k][mw] for k in names]), y[mw]) if mw.sum() >= 60 else np.full(len(names), 1 / len(names))
        w_now = {k: float(v) for k, v in zip(names, w_now)}
        live_info = {}
        if h in (7, 30):
            w_now, live_info = _live_adjust(w_now, _live_losses(h))
        mc_ = idx > T - h - 1095
        c90 = fm.conformal_factor(Qraw, y, mc_, 0, 4, 0.90)
        c50 = fm.conformal_factor(Qraw, y, mc_, 1, 3, 0.50)
        # valutazione
        pc = _climatology(ctx, idx, h)
        dts = D[idx]
        sets = {"test": idx >= test_from, "last12": idx > T - h - 365}
        evalset = {"ensemble": Qens, **{k: A[k] for k in names}, "rw_drift": A["rw_drift"]}
        if h in ML_H:
            evalset["previous"] = _prev_blend({"lgb_v1": A["lgb_v1"], "mc": A["mc"], "an": A["an"]}, y, idx, h)
        ev = {per: {k: _metrics(Q[m], y[m], pc[m]) for k, Q in evalset.items()} for per, m in sets.items()}
        reg = regime_all.to_numpy()[idx]
        by_reg = {}
        for rk in ("bull", "bear", "accumulation"):
            m = sets["test"] & (reg == rk)
            by_reg[rk] = {k: _metrics(evalset[k][m], y[m], pc[m]) for k in ("ensemble", "rw0", "cycle")}
        mt = sets["test"] & ~np.isnan(Qens).any(1)
        pu = 1 - fm.cdf0(Qens[mt])
        rel, ece = _reliability(pu, (y[mt] > 0).astype(float))
        hz[h] = {
            "names": names, "w_now": w_now, "live": live_info, "c90": c90, "c50": c50,
            "w_hist_test": {k: float(np.nanmean(W[k][sets["test"]])) for k in names},
            "eval": ev, "by_regime": by_reg, "reliability": rel, "ece": ece,
            "oos": {"idx": idx, "y": y, "ens": Qens, "dates": dts},
            "test_from": D[max(test_from, 0)],
        }
    # tabella "ciclo per ciclo" (leave-future-cycles-out: ogni ciclo previsto solo con i precedenti)
    cyc_model = fcy.CycleModel(ctx, kappa=CYCLE_KAPPA)
    ev_now = cyc_model.events(T)
    tops = [D[t] for t in ev_now["top"]]
    bounds = [t for t in tops if t >= GRID_START - pd.Timedelta(days=60)]
    periods = []
    edges = [GRID_START] + [t for t in bounds if t > GRID_START] + [D[T] + pd.Timedelta(days=1)]
    for a, b in zip(edges[:-1], edges[1:]):
        periods.append((a, b))
    loco = []
    for h in (30, 90, 180, 365):
        idx, A = _arrays(ctx, cache, ["cycle", "rw0", "rw_drift"], h)
        y = ctx.y[h][idx]
        pc = _climatology(ctx, idx, h)
        ens = hz[h]["oos"]["ens"]
        for a, b in periods:
            m = (D[idx] >= a) & (D[idx] < b)
            if m.sum() < 10:
                continue
            row = {"horizon": h, "from": a, "to": min(b, D[T]), "label": f"{a.year}–{min(b, D[T]).year}"}
            for k, Q in (("cycle", A["cycle"]), ("ensemble", ens), ("rw0", A["rw0"]), ("rw_drift", A["rw_drift"])):
                row[k] = _metrics(Q[m], y[m], pc[m])
            loco.append(row)
    tm["combine"] = time.time() - t2

    # ---------------- modelli finali (tutti i dati realizzati) e previsione di oggi
    progress("modelli finali e previsione")
    t3 = time.time()
    final_lgb = {}

    def fit_final(h):
        m = _lgb_member("lgb", n_jobs=2).fit(ctx, h, T - h)
        q, _ = m.predict(ctx, h, np.array([T]))
        contrib = m.contrib(ctx, h, T)
        gain = m.models[2].booster_.feature_importance(importance_type="gain")
        return h, q[0], contrib, gain, m.features

    with ThreadPoolExecutor(4) as ex:
        for h, q, contrib, gain, feats in ex.map(fit_final, ML_H):
            final_lgb[h] = {"q": q, "contrib": contrib, "gain": gain, "features": feats}
    mc = fm.RegimeMC(ctx, n_paths=4000)
    q_mc = mc.path(T, MAX_H, n_paths=4000)
    P, Wp, meta = cyc_model.paths(T, MAX_H)
    q_cyc = fcy.weighted_day_quantiles(P, Wp, CYCLE_KAPPA) if P is not None else np.full((MAX_H + 1, 5), np.nan)
    t = np.arange(MAX_H + 1, dtype=float)
    sd365 = float(np.std(ctx.r[max(1, T - 364):T + 1]))
    q_rw = sd365 * np.sqrt(t)[:, None] * Z[None, :]
    q_lgb = _interp_anchor({h: final_lgb[h]["q"] for h in ML_H}, t)
    daily = {"cycle": q_cyc, "lgb": q_lgb, "mc": q_mc, "rw0": q_rw}
    # ensemble agli orizzonti di ancoraggio + percorso giornaliero (pesi e fattori conformi interpolati)
    keys = list(daily)
    WH = np.array([[hz[h]["w_now"].get(k, 0.0) for k in keys] for h in ALL_H])
    C90 = np.array([hz[h]["c90"] or 0.0 for h in ALL_H])
    C50 = np.array([hz[h]["c50"] or 0.0 for h in ALL_H])
    Q = np.zeros((MAX_H + 1, 5))
    for d in range(1, MAX_H + 1):
        w = np.array([np.interp(d, ALL_H, WH[:, j]) for j in range(len(keys))])
        num, den = np.zeros(5), 0.0
        for j, k in enumerate(keys):
            q = daily[k][d]
            if w[j] > 0 and not np.isnan(q).any():
                num += w[j] * q
                den += w[j]
        raw = np.sort(num / den) if den > 0 else q_rw[d]
        Q[d] = fm.apply_conformal(raw, float(np.interp(d, ALL_H, C90)), float(np.interp(d, ALL_H, C50)))
    tm["final"] = time.time() - t3

    # ---------------- uscite precalcolate (in log-rendimenti: il prezzo live viene applicato in build())
    close = feat["close"]
    last_price = float(close.iloc[-1])
    daily_vol = float(np.nanstd(np.diff(ctx.lc[-90:])))
    scen = {}
    for H in (30, 60, 90, 180, 365):
        thr = max(0.05, 0.6 * daily_vol * np.sqrt(H))
        p_up = 1 - _cdf_at(Q[H], thr)
        p_dn = _cdf_at(Q[H], -thr)
        p_base = max(0.0, 1 - p_up - p_dn)
        lv = {"bull": 1 - p_up / 2, "base": p_dn + p_base / 2, "bear": p_dn / 2}
        scen[H] = [{"key": key, "name": name, "prob": prob, "thr": thr,
                    "path_lr": np.array([_q_at(Q[d], lv[key]) if d else 0.0 for d in range(H + 1)])}
                   for key, name, prob in (("bull", "Rialzista", p_up), ("base", "Base", p_base), ("bear", "Ribassista", p_dn))]

    members_now = {k: {h: daily[k][h] for h in ALL_H if not np.isnan(daily[k][h]).any()} for k in keys}
    imp = np.zeros(len(ff.FEATURE_KEYS))
    for h in ML_H:
        g = final_lgb[h]["gain"]
        g = g / max(g.sum(), 1e-9)
        for f_, v in zip(final_lgb[h]["features"], g):
            imp[ff.FEATURE_KEYS.index(f_)] += v
    imp = imp / max(imp.sum(), 1e-9) * 100
    features_out = sorted(({"key": k, "name": ff.LABELS[k], "group": ff.FEATURES[k][1], "importance": float(v)}
                           for k, v in zip(ff.FEATURE_KEYS, imp)), key=lambda d: -d["importance"])
    drivers = _drivers(feat, final_lgb, hz)
    cycle_out = _cycle_output(ctx, cyc_model, P, Wp, meta, q_cyc, loco)
    reg_now = str(regime_all.iloc[-1])
    # punti del backtest a 30 g (ultimi 4 anni, uno ogni ~7 giorni) per la retro-compatibilità e il registro /affidabilita
    o, bt_points, last_t = hz[30]["oos"], [], None
    for p, yv, q in zip(o["idx"], o["y"], o["ens"]):
        dt = D[p]
        if dt < hz[30]["test_from"] or np.isnan(q).any() or (last_t is not None and (dt - last_t).days < 7):
            continue
        last_t = dt
        p0 = float(close.iloc[p])
        bt_points.append({"time": ts(dt + pd.Timedelta(days=30)), "price0": p0, "q": q, "actual": p0 * float(np.exp(yv))})
    elapsed = time.time() - t0
    tm["total"] = elapsed
    log.info("forecast v%d addestrato in %.1fs (%s)", VERSION, elapsed, ", ".join(f"{k} {v:.1f}s" for k, v in tm.items()))
    return {
        "version": VERSION, "trained_at": int(time.time()), "model_price": last_price, "model_time": D[T],
        "data_day": str(D[T].date()), "history": close.iloc[-400:], "Q": Q, "scenarios": scen, "hz": hz,
        "members_now": members_now, "features": features_out, "drivers": drivers, "cycle": cycle_out,
        "regime": reg_now, "regime_feat": {k: _f(feat[k].iloc[-1]) for k in ("mayer", "ma200_slope", "dd_ath", "days_low")},
        "timings": tm, "feature_stats": _feature_stats(feat), "bt_points": bt_points,
    }


def _f(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def _feature_stats(feat: pd.DataFrame) -> dict:
    first = feat[ff.FEATURE_KEYS].apply(lambda s: s.first_valid_index())
    return {"n_features": len(ff.FEATURE_KEYS),
            "available_now": int(feat[ff.FEATURE_KEYS].iloc[-1].notna().sum()),
            "first_valid": {k: (ts(v) if v is not None and not pd.isna(v) else None) for k, v in first.items()}}


def _drivers(feat: pd.DataFrame, final_lgb: dict, hz: dict) -> dict:
    """Contributi SHAP (pred_contrib) del modello LightGBM mediano per la previsione di oggi."""
    out = {}
    T = len(feat) - 1
    for h in ML_H:
        fl = final_lgb[h]
        c = fl["contrib"]
        base, cc = float(c[-1]), c[:-1]
        rows = []
        for k, v in zip(fl["features"], cc):
            rows.append({"key": k, "name": ff.LABELS[k], "group": ff.FEATURES[k][1], "value": _f(feat[k].iloc[T]),
                         "contribution": 100 * (np.exp(v) - 1)})
        rows.sort(key=lambda d: -abs(d["contribution"]))
        groups: dict[str, float] = {}
        for k, v in zip(fl["features"], cc):
            g = ff.FEATURES[k][1]
            groups[g] = groups.get(g, 0.0) + float(v)
        out[str(h)] = {
            "horizon": h, "lgb_weight": 100 * hz[h]["w_now"].get("lgb", 0.0),
            "baseline": 100 * (np.exp(base) - 1), "lgb_median": 100 * (np.exp(float(fl["q"][2])) - 1),
            "top": rows[:10],
            "groups": sorted(({"group": g, "contribution": 100 * (np.exp(v) - 1)} for g, v in groups.items()),
                             key=lambda d: -abs(d["contribution"])),
        }
    return out


def _fmt(p: float) -> str:
    return f"${p:,.0f}"


def _cycle_output(ctx: fm.Ctx, model: fcy.CycleModel, P, W, meta, q_cyc, loco) -> dict:
    T = ctx.n - 1
    D = ctx.dates
    close = ctx.feat["close"].to_numpy()
    ev = model.events(T)
    events = []
    for kind in ("top", "bottom", "halving"):
        for i in ev[kind]:
            events.append({"kind": kind, "time": D[i], "price": float(close[i]),
                           "probable": bool(kind == "bottom" and ev["probable_bottom"] == i) or
                           bool(kind == "top" and ev["provisional_top"] and i == ev["top"][-1])})
    events.sort(key=lambda e: e["time"])
    last = {k: (ev[k][-1] if ev[k] else None) for k in ("top", "bottom", "halving")}
    days = {k: (T - v if v is not None else None) for k, v in last.items()}
    segs = model._segments(ev)
    seg = segs[-1] if segs else None
    seg_it = {"top": "massimo", "bottom": "minimo", "halving": "halving"}
    anchors, cycles = [], []
    if P is not None:
        tot = W.sum()
        by_al: dict[str, float] = {}
        groups: dict[tuple, list[int]] = {}
        for i, (al, e, rank, s, sc, o, g) in enumerate(meta):
            by_al[al] = by_al.get(al, 0.0) + W[i]
            groups.setdefault((al, e), []).append(i)
        for al in fcy.ALIGNS:
            if al in by_al and last[al] is not None:
                anchors.append({"key": al, "label": fcy.ALIGN_IT[al], "event_time": D[last[al]], "days": days[al],
                                "weight": 100 * by_al[al] / tot})
        for (al, e), ii in groups.items():
            ii = np.array(ii)
            w = W[ii]
            core = [i for i in ii if meta[i][5] == 0 and meta[i][6] == 0.5] or [ii[np.argmax(w)]]
            i0 = core[0]
            _, _, rank, s, sc, _, _ = meta[i0]
            path = P[i0]
            aligned = e + s * days[al]
            pts = [{"day": d, "value": float(np.exp(path[d]) if not np.isnan(path[d]) else np.nan)}
                   for d in range(0, MAX_H + 1, 4)] + [{"day": MAX_H, "value": float(np.exp(path[MAX_H])) if not np.isnan(path[MAX_H]) else np.nan}]
            ok = ~np.isnan(path)
            cycles.append({
                "key": f"{al}:{D[e].date()}", "anchor": al, "anchor_label": fcy.ALIGN_IT[al],
                "label": f"{D[e].year} · {fcy.ALIGN_IT[al].replace('giorni ', '')} ({data_it(D[e])})",
                "anchor_time": D[e], "anchor_price": float(close[e]),
                "aligned_time": D[min(int(round(aligned)), T)], "time_scale": float(s), "amplitude_scale": float(sc),
                "weight": 100 * float(w.sum() / tot),
                "similarity": float(np.clip(100 * np.exp(-0.5 * (model.state_distance(int(round(aligned)), T) / model.bw) ** 2), 0, 100)),
                "return_180": 100 * (np.exp(path[180]) - 1) if ok[180] else None,
                "return_365": 100 * (np.exp(path[365]) - 1) if ok[365] else None,
                "path_ratio": pts,    # moltiplicatore del prezzo attuale (×) al giorno `day`
            })
        cycles.sort(key=lambda c: -c["weight"])
    # descrizione della posizione
    cl = close[T]
    parts = []
    if last["top"] is not None:
        parts.append(f"{days['top']} giorni dal massimo di ciclo del {data_it(D[last['top']])} ({_fmt(close[last['top']])}, "
                     f"{(cl / close[last['top']] - 1) * 100:+.0f}% da allora)")
    if last["bottom"] is not None and (last["top"] is None or last["bottom"] > last["top"]):
        lab = "minimo probabile" if ev["probable_bottom"] == last["bottom"] else "minimo di ciclo"
        parts.append(f"{days['bottom']} giorni dal {lab} del {data_it(D[last['bottom']])} ({_fmt(close[last['bottom']])}, "
                     f"{(cl / close[last['bottom']] - 1) * 100:+.0f}% da allora)")
    if last["halving"] is not None:
        parts.append(f"{days['halving']} giorni dall'halving del {data_it(D[last['halving']])}")
    if last["bottom"] is not None and last["top"] is not None and last["bottom"] > last["top"]:
        phase, phase_it = "post_bottom", "ripresa dopo il minimo di ciclo"
    elif last["top"] is not None and (last["bottom"] is None or last["top"] > last["bottom"]) and days["top"] >= 60:
        phase, phase_it = "bear", "fase ribassista dopo il massimo"
    else:
        phase, phase_it = "bull", "fase rialzista verso un nuovo massimo"
    text = "Posizione nel ciclo: " + "; ".join(parts) + f". Fase: {phase_it}."
    if seg is not None:
        k1, t1, k2, t2 = seg
        past = [(a1, a2) for (b1, a1, b2, a2) in segs[:-1] if b1 == k1 and b2 == k2]
        if past:
            avg = float(np.mean([a2 - a1 for a1, a2 in past]))
            cur = t2 - t1
            text += (f" L'ultimo tratto {seg_it[k1]} → {seg_it[k2]} è durato {cur} giorni contro {avg:.0f} in media nei cicli "
                     f"precedenti: il ciclo attuale è {'più rapido' if cur < avg * 0.9 else 'più lento' if cur > avg * 1.1 else 'in linea'}; "
                     "i percorsi passati vengono proiettati con velocità riscalata (con incertezza).")
    if cycles:
        best = cycles[0]
        text += (f" Il ciclo passato più pesante è {best['label']} (peso {best['weight']:.0f}%, similarità di stato "
                 f"{best['similarity']:.0f}/100).")
    ts_info = None
    if seg is not None:
        k1, t1, k2, t2 = seg
        ts_info = {"segment": f"{seg_it[k1]} → {seg_it[k2]}", "current_days": int(t2 - t1),
                   "past": [{"from": D[a1], "to": D[a2], "days": int(a2 - a1), "ratio": float((a2 - a1) / max(t2 - t1, 1))}
                            for (b1, a1, b2, a2) in segs[:-1] if b1 == k1 and b2 == k2],
                   "gammas": [{"gamma": g, "weight": w} for g, w in fcy.GAMMAS]}
    return {
        "position": {"text": text, "phase": phase, "phase_label": phase_it, "days_since_top": days["top"],
                     "days_since_bottom": days["bottom"] if last["bottom"] is not None and (last["top"] is None or last["bottom"] > last["top"]) else None,
                     "days_since_halving": days["halving"], "next_halving_est": fcy.NEXT_HALVING,
                     "probable_bottom": ev["probable_bottom"] is not None, "provisional_top": bool(ev["provisional_top"])},
        "events": events, "anchors": anchors, "time_scale": ts_info, "cycles": cycles,
        "quantiles": {h: q_cyc[h] for h in ALL_H if not np.isnan(q_cyc[h]).any()},
        "evaluation": loco,
        "method": ("Il modello allinea i cicli passati sulla posizione attuale secondo tre àncore (giorni dal massimo, dal minimo "
                   "e dall'halving), riscala la velocità del ciclo con il rapporto di durata dell'ultimo tratto completato "
                   "(esponente 0, ½ o 1: incertezza sulla velocità) e l'ampiezza con volatilità e ampiezza dell'ultimo tratto "
                   "(rendimenti decrescenti). Ogni percorso è pesato per recenza del ciclo e similarità dello stato di mercato; "
                   "i quantili pesati danno mediana e bande. La mediana è ridotta del 50% verso zero (migliora l'errore fuori "
                   "campione). Pesi delle àncore appresi fuori campione: valutati, nessun guadagno con 3–4 cicli, quindi uguali."),
    }


# ------------------------------------------------------------------ stato, cache su disco e thread di addestramento

_state = {"full": None, "training": False, "error": None, "started_at": None, "progress": None, "last_try": 0.0}
_train_lock = threading.Lock()
_ready = threading.Event()


def _load_model() -> dict | None:
    try:
        if MODEL_FILE.exists():
            with open(MODEL_FILE, "rb") as f:
                m = pickle.load(f)
            if m.get("version") == VERSION:
                return m
    except Exception as e:  # noqa: BLE001
        log.warning("modello su disco illeggibile: %s", e)
    return None


def _is_stale(full: dict | None) -> bool:
    if full is None or full.get("version") != VERSION:
        return True
    today = pd.Timestamp.now(tz="UTC").tz_convert(None).normalize()
    return pd.Timestamp(full["data_day"]) < today and time.time() - full["trained_at"] > 3600


def _train_thread() -> None:
    try:
        full = _train(lambda s: _state.update(progress=s))
        _save_pickle(MODEL_FILE, full)
        _state.update(full=full, error=None)
    except Exception as e:  # noqa: BLE001
        log.exception("addestramento forecast fallito")
        _state["error"] = str(e)[:300]
    finally:
        _state.update(training=False, progress=None)
        _ready.set()
        _train_lock.release()


def ensure_training() -> None:
    """Avvia l'addestramento in background se il modello manca o è vecchio (mai bloccante)."""
    if _state["full"] is None:
        m = _load_model()
        if m is not None:
            _state["full"] = m
            _ready.set()
    if not _is_stale(_state["full"]) or _state["training"]:
        return
    if time.time() - _state["last_try"] < 600 and _state["error"]:
        return
    if not _train_lock.acquire(blocking=False):
        return
    _state.update(training=True, started_at=int(time.time()), last_try=time.time())
    threading.Thread(target=_train_thread, daemon=True, name="forecast-train").start()


def _full(wait: bool = True, timeout: float = 900) -> dict:
    """Ultimo modello pronto. wait=True (thread di background) attende il primo addestramento se non ce n'è nessuno."""
    ensure_training()
    if _state["full"] is None and wait:
        _ready.wait(timeout)
    if _state["full"] is None:
        raise RuntimeError("modello di previsione in addestramento" if _state["training"] else (_state["error"] or "modello non disponibile"))
    return _state["full"]


# ------------------------------------------------------------------ prezzo live

_live = {"t": 0.0, "price": None}


def live_price() -> float | None:
    """Prezzo live: hub WebSocket (se attivo e fresco) -> ticker Binance REST (cache 10 s) -> None."""
    try:
        from ..routers.stream import hub  # noqa: PLC0415

        tk = hub.last.get("ticker")
        if tk and time.time() - tk["time"] < 30:
            return float(tk["price"])
    except Exception:  # noqa: BLE001
        pass
    if time.time() - _live["t"] < 10 and _live["price"]:
        return _live["price"]
    try:
        from ..data import sources  # noqa: PLC0415

        _live.update(t=time.time(), price=float(sources.binance_ticker()["lastPrice"]))
    except Exception:  # noqa: BLE001
        _live["t"] = time.time() - 5
    return _live["price"]


def _scenario_text(key: str, H: int, prob: float, tgt: float, price: float, thr: float) -> str:
    pct = (tgt / price - 1) * 100
    t = f"{thr * 100:.0f}%"
    if key == "bull":
        return (f"Probabilità stimata {prob * 100:.0f}% che entro {H} giorni il prezzo salga di oltre {art(t)}. "
                f"Valore centrale dello scenario circa {_fmt(tgt)} ({pct:+.1f}%): richiede ripresa della domanda, "
                "funding sano e assorbimento delle resistenze.")
    if key == "bear":
        return (f"Probabilità stimata {prob * 100:.0f}% di un calo superiore {art(t, 'al')} in {H} giorni. "
                f"Valore centrale circa {_fmt(tgt)} ({pct:+.1f}%): coerente con prosecuzione della fase correttiva "
                "del ciclo, deleveraging o shock macro.")
    return (f"Probabilità stimata {prob * 100:.0f}% che il prezzo resti entro ±{t} in {H} giorni, con valore "
            f"centrale intorno a {_fmt(tgt)} ({pct:+.1f}%): fase laterale/di consolidamento.")


REGIME_TEXT = {
    "bull": "Prezzo sopra la media mobile a 200 giorni, che sale: regime rialzista.",
    "bear": "Prezzo sotto la media mobile a 200 giorni, che scende: regime ribassista.",
    "accumulation": "Prezzo e media mobile a 200 giorni discordanti: fase di accumulo / transizione.",
}
METRIC_NOTE = (
    "Valutazione walk-forward fuori campione sugli ultimi 4 anni (giorni ogni 3, target sovrapposti: i campioni effettivi "
    "sono molti meno di n, soprattutto a 180–365 giorni). hit_rate = direzione della mediana corretta; brier_skill = "
    "miglioramento % del Brier di P(rialzo) rispetto alla frequenza storica dei rialzi; mase = errore assoluto medio "
    "della mediana (in rendimento) / quello della passeggiata aleatoria (<1 = meglio del caso); pinball = perdita media "
    "sui quantili 5/25/50/75/95 del log-rendimento (≈ CRPS, più bassa = meglio); coverage = % di esiti dentro le bande."
)


def _metrics_out(m: dict) -> dict:
    return {k: v for k, v in m.items() if k != "brier_clim"}


def _evaluation(full: dict) -> dict:
    out = {"note": METRIC_NOTE, "test_from": None, "horizons": []}
    for h in ALL_H:
        z = full["hz"][h]
        out["test_from"] = z["test_from"]
        ev = z["eval"]
        rows = []
        for k in ["ensemble"] + z["names"] + ["rw_drift"] + (["previous"] if "previous" in ev["test"] else []):
            if k not in ev["test"]:
                continue
            label = BASELINE_INFO.get(k) or MEMBER_INFO[k][0]
            kind = "ensemble" if k == "ensemble" else "baseline" if k in ("rw0", "rw_drift", "previous") else "member"
            if k == "rw0":
                kind = "baseline"
            rows.append({"key": k, "name": label, "kind": kind, "test": _metrics_out(ev["test"][k]),
                         "last12": _metrics_out(ev["last12"][k])})
        e, r = ev["test"]["ensemble"], ev["test"]["rw0"]
        p = ev["test"].get("previous")
        verdict = []
        if e.get("pinball") and r.get("pinball"):
            g = 100 * (1 - e["pinball"] / r["pinball"])
            verdict.append(f"pinball {g:+.1f}% vs random walk")
        if p and p.get("pinball"):
            verdict.append(f"{100 * (1 - e['pinball'] / p['pinball']):+.1f}% vs versione precedente")
        if e.get("mase") is not None:
            verdict.append(f"MASE {e['mase']:.2f}")
        out["horizons"].append({
            "horizon": h, "models": rows,
            "by_regime": [{"regime": rk, "label": ff.REGIME_IT[rk], **{k: _metrics_out(v) for k, v in d.items()}}
                          for rk, d in z["by_regime"].items()],
            "skill_vs_naive": (e.get("pinball") is not None and r.get("pinball") is not None and e["pinball"] < r["pinball"]),
            "summary": "; ".join(verdict),
        })
    out["cycle_by_cycle"] = [{**r, **{k: _metrics_out(r[k]) for k in ("cycle", "ensemble", "rw0", "rw_drift") if k in r}}
                             for r in full["cycle"]["evaluation"]]
    return out


def build(horizon: int = 90) -> dict:
    """Forecast per l'API (/api/forecast). Il modello è addestrato in background (giornaliero) e servito dalla cache;
    le bande sono ri-ancorate ad ogni richiesta sul prezzo live (i quantili sono log-rendimenti relativi)."""
    H = int(min(max(horizon, 7), MAX_H))
    full = _full(wait=False)
    P = live_price() or full["model_price"]
    today = pd.Timestamp.now(tz="UTC").tz_convert(None).normalize()
    day = lambda d: ts(today + pd.Timedelta(days=d))  # noqa: E731
    Q = full["Q"]
    prices = P * np.exp(Q)
    bands = [{"time": day(d), "p05": prices[d, 0], "p25": prices[d, 1], "p50": prices[d, 2],
              "p75": prices[d, 3], "p95": prices[d, 4]} for d in range(H + 1)]
    path = [{"day": d, "time": day(d), "p05": prices[d, 0], "p25": prices[d, 1], "p50": prices[d, 2],
             "p75": prices[d, 3], "p95": prices[d, 4]} for d in range(MAX_H + 1)]
    targets = [{"days": h, "low": prices[h, 0], "high": prices[h, 4], "median": prices[h, 2],
                "up_prob": 100 * (1 - _cdf_at(Q[h], 0.0))} for h in HORIZONS]
    horizons = []
    for h in ALL_H:
        z = full["hz"][h]
        e = z["eval"]["test"]["ensemble"]
        horizons.append({
            "days": h, "time": day(h), "median": prices[h, 2], "p05": prices[h, 0], "p25": prices[h, 1],
            "p75": prices[h, 3], "p95": prices[h, 4], "change_pct": 100 * (np.exp(Q[h, 2]) - 1),
            "up_prob": 100 * (1 - _cdf_at(Q[h], 0.0)),
            "weights": {k: 100 * v for k, v in z["w_now"].items()},
            "conformal": {"c90": z["c90"], "c50": z["c50"]},
            "backtest": {k: e.get(k) for k in ("n", "hit_rate", "mape", "mase",
                                                "coverage_50", "coverage_90", "brier_skill")},
        })
    sc_h = min((30, 60, 90, 180, 365), key=lambda x: (x < H, abs(x - H)))
    step = max(1, sc_h // 30)
    days_ = list(range(0, sc_h + 1, step)) + ([sc_h] if sc_h % step else [])
    scenarios = []
    for sc in full["scenarios"][sc_h]:
        tgt = P * float(np.exp(sc["path_lr"][-1]))
        scenarios.append({"name": sc["name"], "prob": 100 * sc["prob"], "target": tgt,
                          "description": _scenario_text(sc["key"], sc_h, sc["prob"], tgt, P, sc["thr"]),
                          "path": [{"time": day(d), "value": P * float(np.exp(sc["path_lr"][d]))} for d in days_]})
    hist = full["history"]
    hist = hist[hist.index < today].iloc[-365:]
    history = [{"time": ts(t), "value": float(v)} for t, v in hist.items()] + [{"time": day(0), "value": P}]
    # membri: retro-compatibile (weight / median_30d) + pesi e mediane per orizzonte
    models = []
    for k in MEMBERS_SHORT:
        mn = full["members_now"].get(k, {})
        models.append({
            "key": k, "name": MEMBER_INFO[k][0], "note": MEMBER_INFO[k][1],
            "weight": 100 * full["hz"][30]["w_now"].get(k, 0.0),
            "median_30d": P * float(np.exp(mn[30][2])) if 30 in mn else None,
            "weights": {str(h): 100 * full["hz"][h]["w_now"].get(k, 0.0) for h in ALL_H},
            "medians": {str(h): P * float(np.exp(mn[h][2])) for h in ALL_H if h in mn},
            "live": {str(h): full["hz"][h]["live"].get(k) for h in (7, 30) if full["hz"][h]["live"].get(k)},
        })
    # backtest (retro-compatibile): ensemble a 30 g, ultimi 4 anni, un punto ogni ~7 giorni
    z30 = full["hz"][30]
    e30 = z30["eval"]["test"]["ensemble"]
    bt_points = []
    for pt in full["bt_points"]:
        p0, q = pt["price0"], pt["q"]
        bt_points.append({"time": pt["time"], "predicted": p0 * float(np.exp(q[2])), "actual": pt["actual"],
                          "p05": p0 * float(np.exp(q[0])), "p95": p0 * float(np.exp(q[4])), "p25": p0 * float(np.exp(q[1])),
                          "p75": p0 * float(np.exp(q[3])), "up_prob": 100 * (1 - _cdf_at(q, 0.0)), "price0": p0})
    backtest = {"horizon": 30, "hit_rate": e30.get("hit_rate"), "mape": e30.get("mape"), "coverage_90": e30.get("coverage_90"),
                "coverage_50": e30.get("coverage_50"), "mase": e30.get("mase"), "samples": e30.get("n"), "points": bt_points}
    calibration = {
        "method": "P(rialzo) = 1 − CDF della distribuzione calibrata dell'ensemble in 0 (interpolazione dei quantili in spazio "
                  "normale). Testati e scartati perché peggiori fuori campione: classificatore LightGBM calibrato (Platt/stacking).",
        "horizons": [{"horizon": h, "buckets": full["hz"][h]["reliability"], "ece": full["hz"][h]["ece"],
                      "brier": full["hz"][h]["eval"]["test"]["ensemble"].get("brier"),
                      "brier_clim": full["hz"][h]["eval"]["test"]["ensemble"].get("brier_clim"),
                      "brier_skill": full["hz"][h]["eval"]["test"]["ensemble"].get("brier_skill")} for h in ALL_H],
    }
    cyc = full["cycle"]
    cycle_model = {k: v for k, v in cyc.items() if k not in ("quantiles", "evaluation")}
    cycle_model["cycles"] = [{**{k: v for k, v in c.items() if k != "path_ratio"},
                              "path": [{"day": pt["day"], "time": day(pt["day"]), "value": P * pt["value"]}
                                       for pt in c["path_ratio"] if np.isfinite(pt["value"])]}
                             for c in cyc["cycles"]]
    cycle_model["horizons"] = [{"days": h, "median": P * float(np.exp(q[2])), "p05": P * float(np.exp(q[0])),
                                "p25": P * float(np.exp(q[1])), "p75": P * float(np.exp(q[3])), "p95": P * float(np.exp(q[4])),
                                "up_prob": 100 * (1 - _cdf_at(q, 0.0))} for h, q in cyc["quantiles"].items()]
    rk = full["regime"]
    regime = {"key": rk, "label": ff.REGIME_IT[rk], "text": REGIME_TEXT[rk], "cycle_phase": cyc["position"]["phase"],
              "cycle_phase_label": cyc["position"]["phase_label"], "indicators": full["regime_feat"]}
    return clean({
        "horizon": H, "generated_at": int(time.time()), "last_price": P,
        "history": history, "bands": bands, "targets": targets, "scenarios": scenarios, "models": models,
        "features": full["features"], "backtest": backtest, "disclaimer": DISCLAIMER,
        "model_trained_at": full["trained_at"], "version": VERSION,
        "path": path, "horizons": horizons, "cycle_model": cycle_model, "evaluation": _evaluation(full),
        "calibration": calibration, "drivers": full["drivers"], "regime": regime,
        "training": {"status": "training" if _state["training"] else ("error" if _state["error"] else "ready"),
                     "progress": _state["progress"], "error": _state["error"], "trained_at": full["trained_at"],
                     "data_day": full["data_day"], "seconds": full["timings"], "features": full["feature_stats"]},
    })


def member_quantiles(h: int) -> dict[str, list[float]]:
    """Quantili (log-rendimento) dei membri per l'orizzonte h: salvati nel registro live per aggiornare i pesi."""
    full = _state["full"]
    if full is None:
        return {}
    return {k: [float(x) for x in v[h]] for k, v in full["members_now"].items() if h in v}


def summary() -> dict:
    """Numeri chiave per il contesto AI."""
    f = build(365)
    return clean({
        "last_price": round(f["last_price"]),
        "targets": [{"giorni": t["days"], "mediana": round(t["median"]), "p05": round(t["p05"]), "p95": round(t["p95"]),
                     "prob_rialzo": round(t["up_prob"], 1)} for t in f["horizons"]],
        "scenarios_365d": [{"name": s["name"], "prob": round(s["prob"], 1), "target": round(s["target"])} for s in f["scenarios"]],
        "posizione_ciclo": f["cycle_model"]["position"]["text"],
        "regime": f["regime"]["label"],
        "backtest_30d": {k: (round(f["backtest"][k], 2) if f["backtest"][k] is not None else None)
                         for k in ("hit_rate", "mape", "coverage_90", "mase")},
        "top_features": [x["name"] for x in f["features"][:5]],
    })


def is_ready() -> bool:
    return _state["full"] is not None


def warm() -> None:
    """Thread di avvio: carica il modello da disco o lo addestra; poi controlla ogni 10 minuti se serve riaddestrare."""
    while True:
        try:
            ensure_training()
        except Exception as e:  # noqa: BLE001
            log.warning("warm forecast fallito: %s", e)
        time.sleep(600)
