"""Track record / affidabilità: registro persistente delle previsioni emesse da agenti e moduli.

- `record_snapshot()` registra le previsioni correnti (idempotente: una riga per fonte per intervallo, es. 1 al giorno
  per le fonti giornaliere, 1 ogni 4 h per quelle 4h);
- `score()` risolve le previsioni scadute sui prezzi reali (candele 1h Binance chiuse) e calcola per fonte:
  hit rate della direzione, Brier score e calibrazione (reliability buckets), MAE della mediana, copertura delle bande,
  performance degli ultimi 30/90 giorni;
- `backfill()` ricostruisce uno storico "backtest" dove è onestamente possibile: il backtest walk-forward già calcolato
  dal modello di previsione (30 g) e la ricerca di frattali/analoghi rieseguita su date passate con i soli dati
  disponibili a quella data (nessun lookahead). Le righe sono marcate mode="backtest" e non si mescolano con "live";
- `reliability_weights()` → {agent_id: peso 0..1} per pesare le opinioni nell'Analista.
Registro: backend/data/tracking_ledger.parquet (volume persistente).
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import math
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd

from . import util
from .data import store

log = logging.getLogger("tracking")

LEDGER = store.DATA_DIR / "tracking_ledger.parquet"
BT_VERSION = 1
BT_VERSIONS = {"forecast_30d": 2}   # versione per fonte (forecast v2: rigenera solo lo storico backtest della previsione)
SNAPSHOT_EVERY = 30 * 60
H4, D1 = 4 * 3600, 86400

COLS = ["id", "source", "agent", "mode", "made_at", "t0", "due_at", "price0", "direction", "up_prob", "median", "low", "high",
        "band", "meta", "resolved", "actual", "resolved_at", "hit", "brier", "err_pct", "in_band"]

SOURCES: dict[str, dict] = {
    "forecast_7d": {"agent": "forecast", "label": "Previsioni ML · 7 g", "horizon": "7 giorni", "bucket": D1},
    "forecast_30d": {"agent": "forecast", "label": "Previsioni ML · 30 g", "horizon": "30 giorni", "bucket": D1},
    "fractals_4h": {"agent": "patterns", "label": "Frattali 4H", "horizon": "30 candele 4h (5 g)", "bucket": H4},
    "fractals_1d": {"agent": "patterns", "label": "Frattali 1D", "horizon": "30 giorni", "bucket": D1},
    "analogs_4h": {"agent": "analogs", "label": "Analoghi grafici 4H", "horizon": "30 candele 4h (5 g)", "bucket": H4},
    "analogs_1d": {"agent": "analogs", "label": "Analoghi grafici 1D", "horizon": "30 giorni", "bucket": D1},
    "timepivots": {"agent": "timepivots", "label": "Pivot temporali", "horizon": "7 g dopo la data pivot", "bucket": None},
    "cycle_phase": {"agent": "cycles", "label": "Fase di ciclo", "horizon": "90 giorni", "bucket": D1},
    "flows": {"agent": "flows", "label": "Flussi spot/perp", "horizon": "24 ore", "bucket": H4},
    "analyst": {"agent": "analyst", "label": "Consenso del team", "horizon": "7 giorni", "bucket": D1},
}
AGENT_LABEL = {"forecast": "Previsioni ML", "patterns": "Frattali & Pattern", "analogs": "Analoghi grafici", "timepivots": "Pivot temporali",
               "cycles": "Cicli", "flows": "Flussi Spot/Futures", "analyst": "Analista AI"}

_lock = threading.RLock()
_df: pd.DataFrame | None = None
_bf = {"status": "idle", "done": [], "started_at": None, "finished_at": None, "error": None, "progress": None}


# ------------------------------------------------------------------ registro

def _empty() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="object") for c in COLS})


def _load() -> pd.DataFrame:
    global _df
    with _lock:
        if _df is None:
            if LEDGER.exists():
                try:
                    _df = pd.read_parquet(LEDGER)
                except Exception as e:  # noqa: BLE001
                    log.warning("registro illeggibile (%s): ne creo uno nuovo", e)
                    _df = _empty()
            else:
                _df = _empty()
        return _df


def _save(df: pd.DataFrame) -> None:
    global _df
    with _lock:
        df = df.reset_index(drop=True)
        for c in ("made_at", "t0", "due_at", "resolved_at"):
            df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
        for c in ("price0", "up_prob", "median", "low", "high", "band", "actual", "hit", "brier", "err_pct", "in_band"):
            df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
        df["resolved"] = df["resolved"].fillna(False).astype(bool)
        for c in ("id", "source", "agent", "mode", "direction", "meta"):
            df[c] = df[c].astype(str)
        tmp = LEDGER.with_suffix(".tmp")
        df.to_parquet(tmp, index=False)
        tmp.replace(LEDGER)
        _df = df


def _row(source: str, mode: str, made_at: int, due_at: int, *, t0: int | None = None, price0=None, direction: str = "neutral",
         up_prob=None, median=None, low=None, high=None, band=None, meta: dict | None = None, key: str | None = None) -> dict:
    cfg = SOURCES[source]
    if key is None:
        b = cfg["bucket"] or D1
        key = str(int(made_at // b * b))
    return {"id": f"{source}:{mode}:{key}", "source": source, "agent": cfg["agent"], "mode": mode, "made_at": made_at,
            "t0": t0 if t0 is not None else made_at, "due_at": due_at, "price0": util.num(price0), "direction": direction,
            "up_prob": util.num(up_prob), "median": util.num(median), "low": util.num(low), "high": util.num(high), "band": band,
            "meta": json.dumps(meta or {}, ensure_ascii=False), "resolved": False, "actual": None, "resolved_at": None,
            "hit": None, "brier": None, "err_pct": None, "in_band": None}


def _append(rows: list[dict]) -> int:
    if not rows:
        return 0
    with _lock:
        df = _load()
        have = set(df["id"]) if len(df) else set()
        new = [r for r in rows if r["id"] not in have]
        if not new:
            return 0
        out = pd.concat([df, pd.DataFrame(new, columns=COLS)], ignore_index=True) if len(df) else pd.DataFrame(new, columns=COLS)
        _save(out)
        return len(new)


# ------------------------------------------------------------------ prezzi

def _hourly() -> tuple[np.ndarray, np.ndarray]:
    """(tempo di chiusura, close) delle candele 1h CHIUSE."""
    k = store.get("k_1h")[["time", "close"]].dropna().sort_values("time")
    t = ((k["time"] - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(np.int64) + 3600
    c = k["close"].to_numpy(float)
    now = time.time()
    ok = t <= now
    return t[ok], c[ok]


def _price_at(t: float, H: tuple[np.ndarray, np.ndarray]) -> float | None:
    ht, hc = H
    if not len(ht) or t > ht[-1] or t < ht[0] - 3600:
        return None
    i = int(np.searchsorted(ht, t, side="right")) - 1
    return float(hc[i]) if i >= 0 else None


def _live_price() -> float | None:
    try:
        from .routers.market import live_price
        return live_price()
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------ snapshot live

def _dir_prob(up_prob: float | None, median: float | None, price0: float | None) -> str:
    if median is not None and price0:
        return "up" if median > price0 else "down" if median < price0 else "neutral"
    if up_prob is not None:
        return "up" if up_prob > 50 else "down" if up_prob < 50 else "neutral"
    return "neutral"


def _snap_forecast(now: int, p: float) -> list[dict]:
    from .analysis import forecast as fc
    if not fc.is_ready():
        return []
    f = fc.build(90)
    out = []
    members = {h: fc.member_quantiles(h) for h in (7, 30)}
    for t in f.get("targets", []):
        if t["days"] not in (7, 30):
            continue
        p0 = f["last_price"]
        out.append(_row(f"forecast_{t['days']}d", "live", now, now + t["days"] * D1, price0=p0,
                        direction=_dir_prob(t["up_prob"], t["median"], p0), up_prob=t["up_prob"], median=t["median"],
                        low=t["low"], high=t["high"], band=90,
                        meta={"model_trained_at": f.get("model_trained_at"), "version": f.get("version"),
                              "members": members.get(t["days"], {})}))
    return out


def _snap_fractals(now: int, p: float) -> list[dict]:
    from .routers import fractals as frr
    out = []
    for tf, step, b in (("4h", H4, H4), ("1d", D1, D1)):
        r = frr.build(tf=tf, window=60, horizon=30, top=5)
        pr = r["projection"]
        p0 = r["current"][-1]["close"]
        due = int(pr["times"][-1]) + step
        out.append(_row(f"fractals_{tf}", "live", now, due, price0=p0, direction=_dir_prob(pr["up_prob"], None, p0),
                        up_prob=pr["up_prob"], median=pr["p50"][-1], low=pr["p10"][-1], high=pr["p90"][-1], band=80,
                        meta={"bias": pr["bias"], "similarity": r["matches"][0]["similarity"] if r["matches"] else None}))
    return out


def _snap_analogs(now: int, p: float) -> list[dict]:
    from .routers import analogs as anr
    out = []
    for tf, step in (("4h", H4), ("1d", D1)):
        r = anr.build(tf=tf)
        s = r["summary"]
        if not s.get("count") or s.get("median_outcome") is None:
            continue
        p0 = r["current"]["close"]
        due = int(r["current"]["end"]) + step * (r["horizon"] + 1)
        up_prob = s["up"] / s["count"] * 100
        med = p0 * (1 + s["median_outcome"] / 100)
        out.append(_row(f"analogs_{tf}", "live", now, due, price0=p0, direction=_dir_prob(None, med, p0), up_prob=up_prob,
                        median=med, meta={"bias": s["bias"], "count": s["count"], "best_similarity": s.get("best_similarity")}))
    return out


EXP_DIR = {"rialzo": "up", "inversione_rialzista": "up", "ribasso": "down", "inversione_ribassista": "down"}


def _snap_timepivots(now: int, p: float) -> list[dict]:
    from .routers import timepivots as tpr
    tp = tpr.build(90)
    out = []
    for it in tp.get("calendar", []):
        d = EXP_DIR.get(it.get("expected"))
        if not d or not (now - D1 <= it["time"] <= now + 2 * D1):
            continue
        prob = it.get("probability")
        up = (prob if d == "up" else 100 - prob) if prob is not None else None
        t0 = int(it["time"])
        out.append(_row("timepivots", "live", now, t0 + 7 * D1, t0=t0, direction=d, up_prob=up,
                        meta={"label": it["label"], "confluence": it.get("confluence"), "expected": it.get("expected")},
                        key=f"{it['id']}:{t0}"))
    return out


def _snap_cycle(now: int, p: float) -> list[dict]:
    from .routers import cycles as cr
    ph = cr.build()["current"]["phase"]
    d = "up" if ph in ("accumulation", "bull") else "down" if ph in ("distribution", "bear") else "neutral"
    return [_row("cycle_phase", "live", now, now + 90 * D1, price0=p, direction=d, meta={"phase": ph})]


def _snap_flows(now: int, p: float) -> list[dict]:
    from .routers import flows as fl
    b = fl.build(tf="1h", range="7d")["current"]["bias"]
    d = {"bullish": "up", "bearish": "down"}.get(b, "neutral")
    return [_row("flows", "live", now, now + D1, price0=p, direction=d, meta={"bias": b})]


def _snap_analyst(now: int, p: float) -> list[dict]:
    from .agents.engine import bus
    a = bus.agents.get("analyst")
    c = a.state.get("consensus") if a else None
    if c is None:
        return []
    d = "up" if c > 15 else "down" if c < -15 else "neutral"
    return [_row("analyst", "live", now, now + 7 * D1, price0=p, direction=d, meta={"consensus": round(float(c), 1)})]


SNAPSHOTS = [_snap_forecast, _snap_fractals, _snap_analogs, _snap_timepivots, _snap_cycle, _snap_flows, _snap_analyst]


def record_snapshot() -> dict:
    """Registra le previsioni correnti di tutte le fonti (idempotente per fonte e intervallo)."""
    now = int(time.time())
    p = _live_price()
    rows, errors = [], {}
    for fn in SNAPSHOTS:
        try:
            rows += fn(now, p)
        except Exception as e:  # noqa: BLE001
            errors[fn.__name__.replace("_snap_", "")] = str(e)[:200]
            log.info("snapshot %s non disponibile: %s", fn.__name__, e)
    added = _append(rows)
    return {"added": added, "candidates": len(rows), "errors": errors}


# ------------------------------------------------------------------ risoluzione

def _resolve_df(df: pd.DataFrame, H) -> pd.DataFrame:
    now = time.time()
    pend = df.index[(~df["resolved"].astype(bool)) & (df["due_at"].astype(float) <= now)]
    for i in pend:
        r = df.loc[i]
        p0 = r["price0"]
        if p0 is None or (isinstance(p0, float) and math.isnan(p0)):
            p0 = _price_at(float(r["t0"]), H)
            if p0 is None:
                continue
            df.at[i, "price0"] = p0
        act = _price_at(float(r["due_at"]), H)
        if act is None:
            continue
        _score_row(df, i, float(p0), act, int(now))
    return df


def _score_row(df: pd.DataFrame, i, p0: float, act: float, when: int) -> None:
    r = df.loc[i]
    up = act > p0
    df.at[i, "actual"] = act
    df.at[i, "resolved"] = True
    df.at[i, "resolved_at"] = when
    d = r["direction"]
    df.at[i, "hit"] = float((d == "up") == up) if d in ("up", "down") else np.nan
    upp = util.num(r["up_prob"])
    df.at[i, "brier"] = (upp / 100 - float(up)) ** 2 if upp is not None else np.nan
    med = util.num(r["median"])
    df.at[i, "err_pct"] = abs(med - act) / act * 100 if med is not None else np.nan
    lo, hi = util.num(r["low"]), util.num(r["high"])
    df.at[i, "in_band"] = float(lo <= act <= hi) if lo is not None and hi is not None else np.nan


def resolve() -> int:
    with _lock:
        df = _load().copy()
        if not len(df):
            return 0
        before = int(df["resolved"].astype(bool).sum())
        df = _resolve_df(df, _hourly())
        n = int(df["resolved"].astype(bool).sum()) - before
        if n:
            _save(df)
        return n


# ------------------------------------------------------------------ backfill (walk-forward, senza lookahead)

def _fresh(name: str):
    """Istanza separata di un modulo di analisi: si può sostituire `load` con dati troncati senza toccare l'app."""
    path = Path(__file__).resolve().parent / "analysis" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"app.analysis._bt_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _bt_forecast() -> list[dict]:
    """Storico backtest della previsione a 30 g: punti walk-forward fuori campione dell'ensemble v2 (ultimi 4 anni,
    uno ogni ~7 giorni) con P(rialzo) dalla distribuzione calibrata."""
    from .analysis import forecast as fc
    fc._full()
    bt = fc.build(90)["backtest"]
    H = int(bt["horizon"])
    v = BT_VERSIONS.get("forecast_30d", BT_VERSION)
    rows = []
    for pt in bt["points"]:
        p0 = pt.get("price0")
        if not p0:
            continue
        made = int(pt["time"]) - H * D1 + D1
        due = int(pt["time"]) + D1
        pred = pt["predicted"]
        r = _row("forecast_30d", "backtest", made, due, price0=p0, direction=_dir_prob(pt.get("up_prob"), pred, p0),
                 up_prob=pt.get("up_prob"), median=pred, low=pt.get("p05"), high=pt.get("p95"), band=90,
                 meta={"bt": v, "model": f"forecast v{fc.VERSION}"})
        r.update(resolved=False)
        rows.append((r, p0, float(pt["actual"])))
    return rows


def _bt_search(kind: str, tf: str, years: float, every: int) -> list[tuple[dict, float, float]]:
    from .analysis import analogs as an0
    from .analysis import fractals as fr0
    step = H4 if tf == "4h" else D1
    mod = _fresh(kind)
    D = (fr0 if kind == "fractals" else an0).load(tf)
    D = {k: np.asarray(v) for k, v in D.items()}
    n = len(D["close"])
    horizon = 30
    per_year = int(365 * D1 / step)
    first = n - 1 - int(years * per_year)
    rows = []
    for cut in range(first, n - 1 - horizon, every):     # cut = indice dell'ultima candela nota (chiusa)
        T = {k: v[:cut + 1] for k, v in D.items()}
        mod.load = lambda _tf, T=T: T
        try:
            r = mod.search(tf, 60, 30, 5) if kind == "fractals" else mod.search(tf, 60, 5, horizon)
        except Exception as e:  # noqa: BLE001
            log.debug("backtest %s %s cut %d: %s", kind, tf, cut, e)
            continue
        p0 = float(D["close"][cut])
        act = float(D["close"][cut + horizon])
        made = int(D["time"][cut]) + step
        due = int(D["time"][cut + horizon]) + step
        if kind == "fractals":
            pr = r["projection"]
            row = _row(f"fractals_{tf}", "backtest", made, due, price0=p0, direction=_dir_prob(pr["up_prob"], None, p0),
                       up_prob=pr["up_prob"], median=float(pr["p50"][-1]), low=float(pr["p10"][-1]), high=float(pr["p90"][-1]),
                       band=80, meta={"bt": BT_VERSION, "bias": pr["bias"]}, key=str(made))
        else:
            s = r["summary"]
            if not s.get("count") or s.get("median_outcome") is None:
                continue
            med = p0 * (1 + s["median_outcome"] / 100)
            row = _row(f"analogs_{tf}", "backtest", made, due, price0=p0, direction=_dir_prob(None, med, p0),
                       up_prob=s["up"] / s["count"] * 100, median=med, meta={"bt": BT_VERSION, "bias": s["bias"]}, key=str(made))
        rows.append((row, p0, act))
    return rows


BACKFILLS = [
    ("forecast_30d", lambda: _bt_forecast()),
    ("fractals_1d", lambda: _bt_search("fractals", "1d", 2, 3)),
    ("fractals_4h", lambda: _bt_search("fractals", "4h", 2, 6)),
    ("analogs_1d", lambda: _bt_search("analogs", "1d", 2, 5)),
    ("analogs_4h", lambda: _bt_search("analogs", "4h", 2, 18)),
]


def backfill(force: bool = False) -> dict:
    """Ricostruisce lo storico backtest (una volta: salta le fonti già presenti con la stessa versione)."""
    _bf.update(status="running", started_at=int(time.time()), error=None, done=[])
    try:
        for src, fn in BACKFILLS:
            df = _load()
            have = df[(df["source"] == src) & (df["mode"] == "backtest")] if len(df) else df
            ver = BT_VERSIONS.get(src, BT_VERSION)
            if len(have) and not force and all(f'"bt": {ver}' in m for m in have["meta"].head(3)):
                _bf["done"].append(src)
                continue
            _bf["progress"] = src
            t0 = time.time()
            items = fn()
            now = int(time.time())
            with _lock:
                df = _load()
                if len(df):
                    df = df[~((df["source"] == src) & (df["mode"] == "backtest"))]
                rows = pd.DataFrame([r for r, _, _ in items], columns=COLS)
                for k, (_, p0, act) in enumerate(items):
                    _score_row(rows, k, p0, act, now)
                out = pd.concat([df, rows], ignore_index=True) if len(df) else rows
                _save(out)
            _bf["done"].append(src)
            log.info("backfill %s: %d previsioni in %.1fs", src, len(items), time.time() - t0)
        _bf.update(status="done", finished_at=int(time.time()), progress=None)
    except Exception as e:  # noqa: BLE001
        log.exception("backfill fallito")
        _bf.update(status="error", error=str(e)[:300], finished_at=int(time.time()), progress=None)
    _summary_cache.clear()
    return dict(_bf)


# ------------------------------------------------------------------ metriche

def _f(x, d=1):
    return util.num(round(float(x), d)) if x is not None and np.isfinite(x) else None


def _buckets(df: pd.DataFrame) -> list[dict]:
    d = df[df["up_prob"].notna() & df["resolved"]]
    out = []
    if not len(d):
        return out
    obs = (d["actual"] > d["price0"]).astype(float).to_numpy()
    pr = d["up_prob"].to_numpy(float)
    b = np.clip((pr // 10).astype(int), 0, 9)
    for k in range(10):
        m = b == k
        if not m.any():
            continue
        out.append({"bin": k, "from": k * 10, "to": k * 10 + 10, "n": int(m.sum()),
                    "predicted": _f(pr[m].mean()), "observed": _f(obs[m].mean() * 100)})
    return out


def _ece(buckets: list[dict]) -> float | None:
    n = sum(b["n"] for b in buckets)
    if not n:
        return None
    return _f(sum(b["n"] * abs(b["predicted"] - b["observed"]) for b in buckets) / n)


def _metrics(d: pd.DataFrame, now: float) -> dict:
    res = d[d["resolved"]]
    dirs = res[res["hit"].notna()]
    pr = res[res["brier"].notna()]
    out = {"n_total": int(len(d)), "n_resolved": int(len(res)), "n_pending": int((~d["resolved"]).sum()), "n_dir": int(len(dirs)),
           "hit_rate": _f(dirs["hit"].mean() * 100) if len(dirs) else None,
           "brier": _f(pr["brier"].mean(), 4) if len(pr) else None}
    if len(pr):
        base = float((pr["actual"] > pr["price0"]).mean())
        ref = base * (1 - base)
        out["brier_ref"] = _f(ref, 4)
        out["brier_skill"] = _f((1 - pr["brier"].mean() / ref) * 100) if ref > 0 else None
        out["avg_up_prob"] = _f(pr["up_prob"].mean())
    else:
        out.update(brier_ref=None, brier_skill=None, avg_up_prob=None)
    out["up_rate_actual"] = _f((res["actual"] > res["price0"]).mean() * 100) if len(res) else None
    e = res[res["err_pct"].notna()]
    out["mae_pct"] = _f(e["err_pct"].mean(), 2) if len(e) else None
    bd = res[res["in_band"].notna()]
    out["coverage"] = _f(bd["in_band"].mean() * 100) if len(bd) else None
    out["band_nominal"] = _f(bd["band"].iloc[0], 0) if len(bd) and pd.notna(bd["band"].iloc[0]) else None
    bk = _buckets(d)
    out["ece"] = _ece(bk)
    out["buckets"] = bk
    ref_t = float(res["due_at"].max()) if len(res) and (d["mode"] == "backtest").all() else now
    for days in (30, 90):
        w = dirs[dirs["due_at"] >= ref_t - days * D1]
        out[f"last{days}"] = {"n": int(len(w)), "hit_rate": _f(w["hit"].mean() * 100) if len(w) else None}
    out["first"] = int(d["made_at"].min()) if len(d) else None
    out["last"] = int(d["made_at"].max()) if len(d) else None
    return out


_summary_cache: dict = {}


def summary(mode: str = "all") -> dict:
    hit = _summary_cache.get(mode)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    now = time.time()
    df = _load().copy()
    if len(df):
        df["resolved"] = df["resolved"].astype(bool)
    sel = df if mode == "all" or not len(df) else df[df["mode"] == mode]
    sources = []
    for src, cfg in SOURCES.items():
        for m in ("live", "backtest"):
            if mode != "all" and m != mode:
                continue
            d = sel[(sel["source"] == src) & (sel["mode"] == m)] if len(sel) else sel
            if not len(d):
                continue
            mt = _metrics(d, now)
            sources.append({"source": src, "agent": cfg["agent"], "agent_label": AGENT_LABEL.get(cfg["agent"], cfg["agent"]),
                            "label": cfg["label"], "horizon": cfg["horizon"], "mode": m, **{k: v for k, v in mt.items() if k != "buckets"},
                            "note": _source_note(src, m, mt)})
    # complessivo
    res = sel[sel["resolved"]] if len(sel) else sel
    overall = {k: v for k, v in _metrics(sel, now).items() if k not in ("buckets", "first", "last")}
    rel = {"overall": _buckets(sel) if len(sel) else [],
           "by_source": {f"{s['source']}|{s['mode']}": _buckets(sel[(sel["source"] == s["source"]) & (sel["mode"] == s["mode"])]) for s in sources}}
    split = {}
    for m in ("live", "backtest"):
        d = df[df["mode"] == m] if len(df) else df
        r = d[d["resolved"]] if len(d) else d
        h = r[r["hit"].notna()] if len(r) else r
        split[m] = {"n_total": int(len(d)), "n_resolved": int(len(r)), "n_pending": int(len(d) - len(r)),
                    "hit_rate": _f(h["hit"].mean() * 100) if len(h) else None}
    recent = []
    if len(res):
        rr = res.sort_values("due_at", ascending=False)
        live_first = pd.concat([rr[rr["mode"] == "live"].head(25), rr[rr["mode"] == "backtest"].head(25)])
        for _, r in live_first.head(40).iterrows():
            recent.append(_pred_out(r))
    pending = []
    pl = df[(df["mode"] == "live") & (~df["resolved"])].sort_values("due_at") if len(df) else df
    for _, r in pl.head(20).iterrows():
        pending.append(_pred_out(r))
    out = util.clean({
        "generated_at": int(now), "mode": mode, "overall": overall, "split": split, "sources": sources,
        "reliability": rel, "recent": recent, "pending": pending, "weights": reliability_weights(df),
        "backfill": dict(_bf),
        "method": ("Ogni previsione è registrata con prezzo di partenza, direzione, probabilità di rialzo (se disponibile), mediana e banda; "
                   "alla scadenza viene confrontata con la chiusura della candela 1h Binance. Hit rate = % di direzioni corrette (le previsioni "
                   "neutrali sono escluse). Brier = errore quadratico medio della probabilità di rialzo (0 perfetto, 0.25 = moneta); "
                   "skill = miglioramento % rispetto alla frequenza di base del campione. Calibrazione: le probabilità sono raggruppate in "
                   "fasce di 10 punti e confrontate con la frequenza osservata (ECE = scarto medio pesato). MAE = errore % medio della mediana. "
                   "Copertura = % di esiti dentro la banda (nominale 90% per le Previsioni ML, 80% per i Frattali). "
                   "Backtest: Previsioni ML = backtest walk-forward del modello (30 g, settimanale, probabilità derivata dalle bande); "
                   "Frattali e Analoghi = ricerca rieseguita su date degli ultimi 2 anni usando solo i dati disponibili a quella data. "
                   "Le finestre si sovrappongono: il numero di casi indipendenti è inferiore a n."),
    })
    _summary_cache[mode] = (time.time(), out)
    return out


def _pred_out(r) -> dict:
    meta = {}
    try:
        meta = json.loads(r["meta"]) if r["meta"] else {}
    except Exception:  # noqa: BLE001
        pass
    p0, act = util.num(r["price0"]), util.num(r["actual"])
    return {"id": r["id"], "source": r["source"], "label": SOURCES.get(r["source"], {}).get("label", r["source"]), "agent": r["agent"],
            "mode": r["mode"], "made_at": int(r["made_at"]), "due_at": int(r["due_at"]), "price0": p0,
            "direction": r["direction"], "up_prob": util.num(r["up_prob"]), "median": util.num(r["median"]),
            "low": util.num(r["low"]), "high": util.num(r["high"]), "actual": act,
            "change": (act / p0 - 1) * 100 if act and p0 else None,
            "hit": None if pd.isna(r["hit"]) else bool(r["hit"]), "err_pct": util.num(r["err_pct"]),
            "in_band": None if pd.isna(r["in_band"]) else bool(r["in_band"]), "resolved": bool(r["resolved"]),
            "context": meta.get("label") or CTX_IT.get(meta.get("phase") or meta.get("bias") or "", meta.get("phase") or meta.get("bias"))}


CTX_IT = {"bullish": "bias rialzista", "bearish": "bias ribassista", "neutral": "bias neutrale", "accumulation": "fase di accumulo",
          "bull": "fase rialzista", "distribution": "fase di distribuzione", "bear": "fase ribassista"}


def _source_note(src: str, mode: str, m: dict) -> str:
    if not m["n_resolved"]:
        return "Nessuna previsione ancora scaduta." if mode == "live" else "Backtest non disponibile."
    parts = []
    if m["hit_rate"] is not None:
        parts.append(f"direzione corretta nel {m['hit_rate']:.0f}% di {m['n_dir']} casi (rialzi effettivi {m['up_rate_actual']:.0f}%)")
    if m.get("brier_skill") is not None:
        parts.append(f"probabilità {'più informative' if m['brier_skill'] > 0 else 'meno informative'} della frequenza di base "
                     f"(skill {m['brier_skill']:+.0f}%)")
    if m.get("coverage") is not None and m.get("band_nominal"):
        parts.append(f"banda {m['band_nominal']:.0f}% centrata nel {m['coverage']:.0f}% dei casi")
    return ("; ".join(parts) + ".").capitalize() if parts else ""


def reliability_weights(df: pd.DataFrame | None = None) -> dict[str, float]:
    """Peso 0..1 per agente (0.5 = neutro/nessun dato). Combina hit rate e Brier (live pesato 2× rispetto al backtest),
    con shrinkage verso 0.5 quando le previsioni risolte sono poche: w = 0.5 + (raw − 0.5)·n/(n+50)."""
    if df is None:
        df = _load()
    out = {a: 0.5 for a in AGENT_LABEL}
    if not len(df):
        return out
    res = df[df["resolved"].astype(bool)]
    for agent in AGENT_LABEL:
        d = res[res["agent"] == agent]
        if not len(d):
            continue
        w = np.where(d["mode"] == "live", 2.0, 1.0)
        skills = []
        h = d["hit"].notna().to_numpy()
        if h.any():
            hr = np.average(d["hit"].to_numpy(float)[h], weights=w[h])
            skills.append((hr - 0.5) / 0.5)
        b = d["brier"].notna().to_numpy()
        if b.any():
            br = np.average(d["brier"].to_numpy(float)[b], weights=w[b])
            skills.append(1 - br / 0.25)
        if not skills:
            continue
        raw = float(np.clip(0.5 + np.mean(skills), 0, 1))
        n = float(w[h | b].sum())
        out[agent] = round(0.5 + (raw - 0.5) * n / (n + 50), 3)
    return out


# ------------------------------------------------------------------ ciclo in background

_task: asyncio.Task | None = None


async def _loop() -> None:
    await asyncio.sleep(45)          # lascia scaldare cache e agenti
    try:
        await asyncio.to_thread(backfill)
    except Exception as e:  # noqa: BLE001
        log.warning("backfill: %s", e)
    while True:
        try:
            r = await asyncio.to_thread(record_snapshot)
            n = await asyncio.to_thread(resolve)
            _summary_cache.clear()
            log.info("tracking: %d nuove previsioni, %d risolte", r["added"], n)
        except Exception as e:  # noqa: BLE001
            log.warning("tracking loop: %s", e)
        await asyncio.sleep(SNAPSHOT_EVERY)


def start() -> None:
    """Avvia il ciclo di registrazione/risoluzione nel loop di FastAPI (idempotente)."""
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_running_loop().create_task(_loop())
