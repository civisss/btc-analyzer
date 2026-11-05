"""Backtest walk-forward dei Segnali. Protocollo fissato PRIMA di guardare l'holdout:

  sviluppo   dal lancio del perpetuo (set 2019) al 31 dic 2023: regole e parametri si scelgono solo qui;
  walk-forward nello sviluppo: per il 2021, 2022 e 2023 i parametri si scelgono sul passato e si misurano sull'anno dopo;
  holdout    dal 1 gen 2024 alla data di congelamento: mai usato per scegliere regole, soglie o parametri;
  dopo       quello che arriva dopo il congelamento è fuori campione per costruzione, e non cambia il verdetto.

Un'ipotesi è setup × timeframe × direzione. È "validata" solo se passa TUTTI i controlli dichiarati in `verdict()`.
Eseguibile da riga di comando: `python -m app.analysis.signal_backtest [dev|full]`.
"""
from __future__ import annotations

import json
import logging
import sys
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..data import store
from ..util import clean
from . import signal_data  # noqa: F401  (registra i dataset)
from . import signal_setups as ss
from . import signal_sim as sim
from .anomalies import bh

log = logging.getLogger("signal_backtest")

RESULT_FILE = store.DATA_DIR / "signals_backtest.json"

DEV_END = int(pd.Timestamp("2024-01-01", tz="UTC").timestamp())
HOLDOUT_START = DEV_END
FREEZE = int(pd.Timestamp("2026-11-01", tz="UTC").timestamp())
WF_YEARS = (2021, 2022, 2023)
MIN_N_FIT = 20          # minimo di trade per scegliere un parametro
MIN_N_DEV = 30          # minimo di trade nel walk-forward
MIN_N_HOLD = 30         # minimo di trade nell'holdout
Q_MAX = 0.05            # soglia sul q-value BH
MIN_YEARS_POS = 0.6     # quota minima di anni con R medio positivo nell'holdout
POOL_K = 2000
MC_B = 4000
SEED = 7


def year_start(y: int) -> int:
    return int(pd.Timestamp(f"{y}-01-01", tz="UTC").timestamp())


@dataclass
class Market:
    A: sim.Fine
    ft: np.ndarray
    fr: np.ndarray
    frames: dict[str, ss.Frame]


def _peek(name: str) -> pd.DataFrame | None:
    p = store.DATA_DIR / f"{name}.parquet"
    return pd.read_parquet(p) if p.exists() else None


def load() -> Market:
    m5 = _peek("sig_perp_5m")
    if m5 is None or m5.empty:
        raise RuntimeError("dataset sig_perp_5m assente")
    spot = _peek("sig_spot_15m")
    fund = _peek("funding")
    oi = _peek("lev_bybit_1d")
    frames = {tf: ss.build_frame(m5, spot, fund, oi, tf) for tf in ss.TF_S}
    A = fine_from(m5)
    return Market(A, ss.secs(fund["time"]), fund["rate"].to_numpy(float) * 100, frames)


def fine_from(m5: pd.DataFrame) -> sim.Fine:
    return sim.Fine(ss.secs(m5["time"]), m5["open"].to_numpy(float), m5["high"].to_numpy(float), m5["low"].to_numpy(float), m5["close"].to_numpy(float), 300)


def plan_of(c: ss.Cand, close_t: int) -> sim.Plan:
    s = ss.TF_S[c.tf]
    return sim.Plan(c.side, c.kind, c.entry, c.sl, c.tp1, c.tp2, c.inv, close_t + ss.PEND_BARS[c.tf] * s, close_t + ss.HOLD_BARS[c.tf] * s, s)


def run_trades(M: Market, cands: list[ss.Cand], until: int | None = None) -> list[dict]:
    """Simula i candidati in ordine di tempo: un solo trade alla volta per ipotesi (i segnali durante una posizione aperta si saltano)."""
    F = M.frames[cands[0].tf] if cands else None
    out: list[dict] = []
    busy = 0
    for c in cands:
        close_t = int(F.t[c.i]) + ss.TF_S[c.tf]
        if close_t < busy or (until and close_t >= until):
            continue
        i0 = int(np.searchsorted(M.A.t, close_t))
        tr = sim.simulate(plan_of(c, close_t), M.A, i0)
        if tr.status != "closed":
            continue
        busy = tr.exit_t
        if tr.fill is None:
            continue
        r = tr.net_r(M.ft, M.fr)
        if r is None or (until and tr.exit_t >= until):
            continue
        risk = abs(tr.fill - c.sl)
        out.append({"i": c.i, "t": close_t, "exit_t": tr.exit_t, "outcome": tr.outcome, "tp1": tr.tp1_done, "r": r, "risk_pct": tr.risk_pct(),
                    "risk_atr": risk / F.a[c.i], "tp1_r": abs(c.tp1 - tr.fill) / risk, "tp2_r": abs(c.tp2 - tr.fill) / risk,
                    "trend": int(F.trend[c.i]), "vol": float(F.vol[c.i]) if np.isfinite(F.vol[c.i]) else None})
    return out


# ------------------------------------------------------------------ statistiche

def max_dd(r: np.ndarray) -> float:
    if not len(r):
        return 0.0
    eq = np.cumsum(r)
    return float(np.max(np.maximum.accumulate(np.maximum(eq, 0)) - eq))


def boot_ci(r: np.ndarray, rng: np.random.Generator, b: int = 2000) -> tuple[float | None, float | None]:
    if len(r) < 5:
        return None, None
    m = r[rng.integers(0, len(r), (b, len(r)))].mean(axis=1)
    return float(np.quantile(m, 0.025)), float(np.quantile(m, 0.975))


def year_of(t: int) -> int:
    return pd.Timestamp(t, unit="s", tz="UTC").year


def stats(tr: list[dict], rng: np.random.Generator) -> dict:
    if not tr:
        return {"n": 0, "win_rate": None, "mean_r": None, "total_r": 0.0, "pf": None, "max_dd_r": 0.0, "ci": [None, None], "tp1_rate": None,
                "by_year": [], "by_regime": []}
    r = np.array([x["r"] for x in tr])
    pos, neg = r[r > 0].sum(), -r[r < 0].sum()
    lo, hi = boot_ci(r, rng)
    yrs: dict[int, list[float]] = {}
    for x in tr:
        yrs.setdefault(year_of(x["t"]), []).append(x["r"])
    reg: dict[str, list[float]] = {}
    for x in tr:
        reg.setdefault({1: "up", -1: "down", 0: "range"}[x["trend"]], []).append(x["r"])
    return {"n": len(r), "win_rate": float((r > 0).mean() * 100), "mean_r": float(r.mean()), "total_r": float(r.sum()),
            "pf": float(pos / neg) if neg > 0 else None, "max_dd_r": max_dd(r), "ci": [lo, hi],
            "tp1_rate": float(np.mean([x["tp1"] for x in tr]) * 100),
            "by_year": [{"year": y, "n": len(v), "mean_r": float(np.mean(v))} for y, v in sorted(yrs.items())],
            "by_regime": [{"regime": k, "n": len(v), "mean_r": float(np.mean(v))} for k, v in sorted(reg.items())]}


def random_pool(M: Market, tf: str, side: int, tr: list[dict], t0: int, t1: int, rng: np.random.Generator, k: int = POOL_K) -> np.ndarray:
    """Entrate casuali nello stesso periodo e direzione, con la geometria stop/target dei trade reali (in ATR e in R)."""
    F = M.frames[tf]
    step = ss.TF_S[tf]
    ct = F.t + step
    ok = np.flatnonzero((ct >= t0) & (ct < t1) & np.isfinite(F.a) & (np.arange(len(ct)) >= ss.WARMUP))
    if not len(ok) or not tr:
        return np.array([])
    tmpl = np.array([[x["risk_atr"], x["tp1_r"], x["tp2_r"]] for x in tr])
    out = []
    picks = rng.choice(ok, size=k, replace=True)
    rows = tmpl[rng.integers(0, len(tmpl), k)]
    for i, (ra, a, b) in zip(picks, rows):
        e = F.c[i]
        r = ra * F.a[i]
        if r / e * 100 < ss.MIN_RISK_PCT:
            r = e * ss.MIN_RISK_PCT / 100
        close_t = int(ct[i])
        pl = sim.Plan(side, "market", e, e - side * r, e + side * a * r, e + side * b * r, None, close_t + step, close_t + ss.HOLD_BARS[tf] * step, step)
        t = sim.simulate(pl, M.A, int(np.searchsorted(M.A.t, close_t)))
        if t.status == "closed" and t.exit_t < t1:
            x = t.net_r(M.ft, M.fr)
            if x is not None:
                out.append(x)
    return np.array(out)


def p_random(obs: float, n: int, pool: np.ndarray, rng: np.random.Generator) -> float | None:
    """p a una coda: quanto spesso n entrate casuali fanno almeno quanto il setup."""
    if n < 5 or len(pool) < 100:
        return None
    m = pool[rng.integers(0, len(pool), (MC_B, n))].mean(axis=1)
    return float((1 + (m >= obs).sum()) / (MC_B + 1))


def verdict(row: dict) -> tuple[str, str]:
    """Il verdetto è calcolato solo da questi controlli, nell'ordine. Le soglie sono le costanti in cima al file."""
    w, h = row["wf"], row.get("holdout")
    if w["n"] < MIN_N_DEV:
        return "experimental", "dev_small"
    if w["mean_r"] <= 0:
        return "experimental", "dev_negative"
    if h is None:
        return "experimental", "pending"
    if h["n"] < MIN_N_HOLD:
        return "experimental", "holdout_small"
    if h["mean_r"] <= 0:
        return "experimental", "holdout_negative"
    if h["ci"][0] is None or h["ci"][0] <= 0:
        return "experimental", "ci_includes_zero"
    if h.get("q") is None or h["q"] > Q_MAX:
        return "experimental", "not_significant"
    years = [y for y in h["by_year"] if y["n"] >= 5]
    if years and np.mean([y["mean_r"] > 0 for y in years]) < MIN_YEARS_POS:
        return "experimental", "unstable"
    return "validated", "passed"


# ------------------------------------------------------------------ esecuzione

def hypotheses() -> list[tuple[str, str, int]]:
    return [(s, tf, side) for s, d in ss.SETUPS.items() for tf in d["tfs"] for side in (1, -1)]


def pick_params(by_param: list[tuple[dict, list[dict]]], until: int) -> tuple[dict, float | None]:
    """Parametri con il miglior R medio su dati chiusi prima di `until`. Senza campione sufficiente si usa il primo della griglia."""
    best, score = by_param[0][0], None
    for p, tr in by_param:
        r = [x["r"] for x in tr if x["exit_t"] < until]
        if len(r) >= MIN_N_FIT and (score is None or np.mean(r) > score):
            best, score = p, float(np.mean(r))
    return best, score


def evaluate_dev(M: Market, verbose: bool = True) -> list[dict]:
    rows = []
    rng = np.random.default_rng(SEED)
    t0 = time.time()
    for setup, tf, side in hypotheses():
        grid = ss.SETUPS[setup]["grid"]
        F = M.frames[tf]
        by_param = [(p, run_trades(M, ss.candidates(F, setup, side, p), until=DEV_END)) for p in grid]
        wf: list[dict] = []
        chosen = []
        for y in WF_YEARS:
            ys, ye = year_start(y), year_start(y + 1)
            p, _ = pick_params(by_param, ys)
            chosen.append({"year": y, "params": p})
            tr = next(t for q, t in by_param if q == p)
            wf += [x for x in tr if ys <= x["t"] < ye]
        final, _ = pick_params(by_param, DEV_END)
        w = stats(wf, rng)
        pool = random_pool(M, tf, side, wf, year_start(WF_YEARS[0]), DEV_END, rng)
        w["p"] = p_random(w["mean_r"], w["n"], pool, rng) if wf else None
        w["pool_mean_r"] = float(pool.mean()) if len(pool) else None
        tr_all = next(t for q, t in by_param if q == final)
        row = {"setup": setup, "tf": tf, "family": ss.FAMILY[tf], "side": "long" if side > 0 else "short", "params": final, "wf_params": chosen,
               "n_grid": len(grid), "wf": w, "dev": stats(tr_all, rng)}
        rows.append(row)
        if verbose:
            m = w["mean_r"]
            print(f"{setup:13s}{tf:4s}{row['side']:6s} grid {len(grid)} wf n={w['n']:5d} R={'-' if m is None else format(m, '+.3f')} "
                  f"win={'-' if m is None else format(w['win_rate'], '.0f')} p={w['p']} pool={w['pool_mean_r'] if w['pool_mean_r'] is None else round(w['pool_mean_r'], 3)} "
                  f"dev n={row['dev']['n']} R={row['dev']['mean_r'] if row['dev']['mean_r'] is None else round(row['dev']['mean_r'], 3)} {final}", flush=True)
    log.info("sviluppo: %d ipotesi in %.0f s", len(rows), time.time() - t0)
    ps = bh([r["wf"].get("p") for r in rows])
    for r, q in zip(rows, ps):
        r["wf"]["q"] = q
    return rows


def curve_of(tr: list[dict], maxn: int = 160) -> list[list[float]]:
    """Curva cumulata in R, sotto-campionata."""
    if not tr:
        return []
    c = np.cumsum([x["r"] for x in tr])
    ix = np.unique(np.linspace(0, len(c) - 1, min(maxn, len(c))).astype(int))
    return [[tr[i]["exit_t"], round(float(c[i]), 3)] for i in ix]


def evaluate_holdout(M: Market, rows: list[dict]) -> None:
    """Applica ai dati dell'holdout i parametri congelati a fine sviluppo. Nessuna scelta avviene qui."""
    rng = np.random.default_rng(SEED + 1)
    for r in rows:
        side = 1 if r["side"] == "long" else -1
        tr = run_trades(M, ss.candidates(M.frames[r["tf"]], r["setup"], side, r["params"]))
        hold = [x for x in tr if HOLDOUT_START <= x["t"] < FREEZE and x["exit_t"] < FREEZE]
        post = [x for x in tr if x["t"] >= FREEZE]
        h = stats(hold, rng)
        pool = random_pool(M, r["tf"], side, hold, HOLDOUT_START, FREEZE, rng)
        h["p"] = p_random(h["mean_r"], h["n"], pool, rng) if hold else None
        h["pool_mean_r"] = float(pool.mean()) if len(pool) else None
        r["holdout"], r["post"], r["curve"] = h, stats(post, rng), curve_of(hold)
    passed = [r for r in rows if r["wf"]["n"] >= MIN_N_DEV and (r["wf"]["mean_r"] or 0) > 0]
    # famiglia BH per il verdetto: le ipotesi che hanno passato lo sviluppo; q_all: tutte le ipotesi, per trasparenza
    for r, q in zip(passed, bh([r["holdout"]["p"] for r in passed])):
        r["holdout"]["q"] = q
    for r, q in zip(rows, bh([r["holdout"]["p"] for r in rows])):
        r["holdout"]["q_all"] = q
    for r in rows:
        r["verdict"], r["reason"] = verdict(r)


def resolution_check(M: Market, rows: list[dict]) -> dict | None:
    """Stessi trade dal 2025 risolti con candele da 1 minuto invece che da 5: quanto cambia il risultato."""
    d = _peek("vwap_binance_hist")
    if d is None or d.empty:
        return None
    A1 = sim.Fine(ss.secs(d["time"]), d["open"].to_numpy(float), d["high"].to_numpy(float), d["low"].to_numpy(float), d["close"].to_numpy(float), 60)
    t0, t1 = int(A1.t[0]), int(A1.t[-1])
    diffs, changed, n = [], 0, 0
    for r in rows:
        side = 1 if r["side"] == "long" else -1
        F = M.frames[r["tf"]]
        busy = 0
        for c in ss.candidates(F, r["setup"], side, r["params"]):
            ct = int(F.t[c.i]) + ss.TF_S[c.tf]
            if ct < max(t0, busy) or ct >= t1 - 30 * 86400:
                continue
            pl = plan_of(c, ct)
            a = sim.simulate(pl, M.A, int(np.searchsorted(M.A.t, ct)))
            b = sim.simulate(pl, A1, int(np.searchsorted(A1.t, ct)))
            busy = a.exit_t or busy
            ra, rb = a.net_r(M.ft, M.fr), b.net_r(M.ft, M.fr)
            if ra is None or rb is None:
                continue
            n += 1
            diffs.append(rb - ra)
            changed += a.outcome != b.outcome
    if not n:
        return None
    x = np.array(diffs)
    return {"n": n, "mean_diff_r": float(x.mean()), "mean_abs_diff_r": float(np.abs(x).mean()), "changed_pct": changed / n * 100}


def meta(M: Market, rows: list[dict]) -> dict:
    from . import signal_meta as sm
    rng = np.random.default_rng(SEED + 2)
    frozen = {ss.hyp_key(r["setup"], r["tf"], 1 if r["side"] == "long" else -1): r["params"] for r in rows}
    ctx = sm.daily_context()
    df = sm.dataset(M, frozen, run_trades, ctx)
    o = sm.walk_forward(df, year_start(WF_YEARS[0]), FREEZE)
    dev = sm.evaluate(o[o["t"] < DEV_END], rng)
    hold = sm.evaluate(o[o["t"] >= HOLDOUT_START], rng)
    good = {ss.hyp_key(r["setup"], r["tf"], 1 if r["side"] == "long" else -1) for r in rows if r["wf"]["n"] >= MIN_N_DEV and (r["wf"]["mean_r"] or 0) > 0}
    only = sm.evaluate(o[(o["t"] >= HOLDOUT_START) & o["key"].isin(good)], rng)
    kept, why = sm.keep(dev, hold)
    if sm.MODEL_FILE.exists():
        sm.MODEL_FILE.unlink()
    if kept:
        sm.save(*sm.fit(df[df["exit_t"] < FREEZE]))
    return {"kept": kept, "reason": why, "n": len(df), "features": list(sm.FEATS), "dev": dev, "holdout": hold, "holdout_passed_dev": only, "ece_max": sm.ECE_MAX}


def main(stage: str = "full") -> None:
    logging.basicConfig(level=logging.INFO)
    M = load()
    rows = evaluate_dev(M, verbose=stage == "dev")
    if stage == "dev":
        return
    evaluate_holdout(M, rows)
    res = {"status": "ok", "generated_at": int(time.time()), "data_to": int(M.A.t[-1]), "rows": rows,
           "frozen_ok": all(ss.FROZEN.get(ss.hyp_key(r["setup"], r["tf"], 1 if r["side"] == "long" else -1)) == r["params"] for r in rows),
           "protocol": {"dev_from": int(M.A.t[0]), "dev_end": DEV_END, "wf_years": list(WF_YEARS), "holdout_start": HOLDOUT_START, "freeze": FREEZE,
                        "min_n_fit": MIN_N_FIT, "min_n_dev": MIN_N_DEV, "min_n_hold": MIN_N_HOLD, "q_max": Q_MAX, "min_years_pos": MIN_YEARS_POS,
                        "fee_pct": sim.FEE_PCT, "slip_pct": sim.SLIP_PCT, "cost_pct": sim.COST_PCT, "tp1_fraction": sim.TP1_FRACTION, "min_risk_pct": ss.MIN_RISK_PCT,
                        "hypotheses": len(rows), "trials": sum(r["n_grid"] for r in rows), "pool": POOL_K, "mc": MC_B},
           "resolution_check": resolution_check(M, rows), "ml": meta(M, rows)}
    res["summary"] = {"validated": sum(r["verdict"] == "validated" for r in rows), "dev_passed": sum(r["wf"]["n"] >= MIN_N_DEV and (r["wf"]["mean_r"] or 0) > 0 for r in rows), "tested": len(rows)}
    store.write_text(RESULT_FILE, json.dumps(clean(res), ensure_ascii=False))
    log.info("backtest salvato: %s", res["summary"])


def read() -> dict | None:
    if not RESULT_FILE.exists():
        return None
    try:
        return json.loads(RESULT_FILE.read_text(encoding="utf-8"))
    except ValueError:
        return None


if __name__ == "__main__":
    main(*(sys.argv[1:2] or ["full"]))
