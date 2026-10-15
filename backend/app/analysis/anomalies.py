"""Rilevamento delle anomalie (z-score robusto, point-in-time) e backtest di cosa è successo dopo.

Metodo (dichiarato in UI, CONTRACT.md § SUPERCHART):
  - trasformazione per tipo di serie: livello (funding, flussi), variazione logaritmica % (open interest, riserve, macro),
    differenza (rapporti come MVRV), logaritmo (volumi, liquidazioni: log1p);
  - z robusto = (x_t − mediana) / scala, con mediana e scala calcolate SOLO sui `window` valori precedenti (t−W … t−1):
    il punto corrente non entra mai nella propria statistica, nessun dato futuro; scala = IQR / 1.349 (equivale a σ per
    una normale), con ripiego sulla deviazione standard della finestra quando più di metà dei valori sono uguali (IQR = 0);
  - anomalia quando |z| ≥ soglia (default 3); gli eventi dello stesso segno entro `gap` giorni dal precedente sono un unico
    episodio (si conta il primo), così le finestre di backtest a 7 giorni non si sovrappongono.

Backtest per tipo (serie giornaliere, giorni completi):
  - ingresso alla chiusura del primo giorno in cui il dato era pubblicato (data dell'osservazione + ritardo di pubblicazione);
  - rendimento a 1/3/7 giorni e movimento assoluto medio (|rendimento|, misura di volatilità) dopo l'ingresso;
  - IC 95% bootstrap della media degli eventi (2000 ricampionamenti);
  - p-value bilaterale contro n giorni casuali dello stesso periodo (Monte Carlo, 4000 estrazioni);
  - correzione Benjamini-Hochberg su tutti i test (tipi × segni × orizzonti × metriche);
  - verdetto: strong (p BH < 0.05) · weak (p < 0.05 ma non dopo la correzione) · none · anecdotal (n < 8).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from .. import util
from ..data import store
from . import aggregate, supply_demand  # noqa: F401  (registrano lev_bybit_1d, sd_etf, sd_exchange)

log = logging.getLogger("anomalies")

DAY = 86400
HORIZONS = (1, 3, 7)
WINDOW_DAYS = 90
GAP_DAYS = 7
MIN_N = 8
N_MC = 4000
N_BOOT = 2000
RECENT_DAYS = 30
DEFAULT_THR = 3.0


# ===================================================================== z-score robusto

def secs(x) -> np.ndarray:
    """Date (indice, serie o array, con o senza fuso) -> secondi UNIX int64, qualunque sia la risoluzione interna."""
    if isinstance(x, pd.Series):
        x = pd.DatetimeIndex(x)
    idx = pd.DatetimeIndex(x)
    if idx.tz is not None:
        idx = idx.tz_convert("UTC").tz_localize(None)
    return idx.to_numpy(dtype="datetime64[s]").astype(np.int64)


def transform(x: np.ndarray, how: str) -> np.ndarray:
    """Serie stazionaria su cui misurare l'anomalia."""
    x = np.asarray(x, dtype=float)
    if how == "level":
        return x
    if how == "diff":
        return np.concatenate([[np.nan], np.diff(x)])
    if how == "pct":
        with np.errstate(divide="ignore", invalid="ignore"):
            lx = np.where(x > 0, np.log(np.where(x > 0, x, 1.0)), np.nan)
        return np.concatenate([[np.nan], np.diff(lx) * 100])
    if how == "log":
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(x > 0, np.log(np.where(x > 0, x, 1.0)), np.nan)
    if how == "log1p":
        return np.log1p(np.clip(x, 0, None))
    raise ValueError(f"trasformazione sconosciuta: {how}")


def robust_z(y: np.ndarray, window: int, min_periods: int | None = None, return_med: bool = False):
    """z robusto di ogni punto rispetto ai `window` valori PRECEDENTI (il punto corrente è escluso: nessun look-ahead).
    scala = max(IQR/1.349, ½·deviazione standard della finestra): la prima è la stima robusta di σ, la seconda evita z
    enormi quando la serie resta quasi costante per mesi (es. funding fermo allo 0,01%)."""
    s = pd.Series(np.asarray(y, dtype=float))
    past = s.shift(1)
    mp = min_periods or max(10, window // 3)
    r = past.rolling(window, min_periods=mp)
    med = r.median()
    iqr = (r.quantile(0.75) - r.quantile(0.25)) / 1.349
    scale = np.maximum(iqr, 0.5 * r.std())
    scale = scale.where(scale > 1e-12)
    z = ((s - med) / scale).to_numpy(dtype=float)
    return (z, med.to_numpy(dtype=float)) if return_med else z


def decluster(t: np.ndarray, z: np.ndarray, thr: float, gap_s: float) -> np.ndarray:
    """Indici degli episodi: |z| ≥ soglia, un solo evento per segno entro `gap_s` secondi dal precedente contato."""
    idx = np.flatnonzero(np.abs(np.nan_to_num(z, nan=0.0)) >= thr)
    out = []
    last = {1: -np.inf, -1: -np.inf}
    for i in idx:
        sg = 1 if z[i] > 0 else -1
        if t[i] - last[sg] >= gap_s:
            out.append(i)
            last[sg] = t[i]
    return np.asarray(out, dtype=np.int64)


def window_for(res_s: int) -> int:
    """Finestra (in osservazioni): ~90 giorni per le serie giornaliere o più lente, ~30 giorni per le intraday (30…1000)."""
    if res_s >= DAY:
        return 90 if res_s < 7 * DAY else 52
    return int(min(1000, max(30, round(30 * DAY / max(res_s, 1)))))


# ===================================================================== statistica

def bh(p: list[float | None]) -> list[float | None]:
    """Correzione Benjamini-Hochberg (q-value) per una lista di p-value (None ignorati)."""
    idx = [i for i, v in enumerate(p) if v is not None and np.isfinite(v)]
    out: list[float | None] = [None] * len(p)
    if not idx:
        return out
    vals = np.array([p[i] for i in idx], dtype=float)
    m = len(vals)
    order = np.argsort(vals)
    ranked = vals[order] * m / np.arange(1, m + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    q = np.minimum(q, 1.0)
    for k, o in enumerate(order):
        out[idx[o]] = float(q[k])
    return out


def _mc_p(ev: np.ndarray, pool: np.ndarray, rng: np.random.Generator) -> tuple[float | None, float | None]:
    """p bilaterale: media di n giorni casuali (dal pool) lontana dalla media del pool almeno quanto quella degli eventi."""
    n = len(ev)
    if n == 0 or len(pool) < 30:
        return None, None
    mu = float(pool.mean())
    draws = pool[rng.integers(0, len(pool), size=(N_MC, n))].mean(axis=1)
    obs = abs(float(ev.mean()) - mu)
    p = (1 + int((np.abs(draws - mu) >= obs - 1e-12).sum())) / (N_MC + 1)
    return p, mu


def _boot_ci(ev: np.ndarray, rng: np.random.Generator) -> list[float | None]:
    if len(ev) < 2:
        return [None, None]
    b = ev[rng.integers(0, len(ev), size=(N_BOOT, len(ev)))].mean(axis=1)
    return [float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))]


def verdict(n: int, p: float | None, p_bh: float | None) -> str:
    if n < MIN_N or p is None:
        return "anecdotal"
    if p_bh is not None and p_bh < 0.05:
        return "strong"
    if p < 0.05:
        return "weak"
    return "none"


# ===================================================================== tipi (serie giornaliere)

@dataclass
class TypeDef:
    id: str
    how: str                     # trasformazione
    signs: tuple[int, ...]       # segni considerati (1 = alto/afflusso, −1 = basso/deflusso)
    lag: int                     # ritardo di pubblicazione: disponibile a time + lag
    unit: str                    # unità del valore grezzo
    load: Callable[[], pd.Series]  # indice = giorno UTC (00:00), solo giorni completi


def _complete(s: pd.Series, lag: int) -> pd.Series:
    """Solo osservazioni già pubblicate (giorno completo + ritardo ≤ ora)."""
    now = pd.Timestamp.now(tz="UTC")
    s = s.dropna()
    return s[s.index + pd.Timedelta(seconds=lag) <= now]


def _norm_idx(s: pd.Series) -> pd.Series:
    s.index = pd.to_datetime(s.index, utc=True).normalize()
    return s[~s.index.duplicated(keep="last")].sort_index()


def _funding() -> pd.Series:
    f = store.get("funding")
    s = f.assign(day=pd.to_datetime(f["time"], utc=True).dt.floor("D")).groupby("day")["rate"].agg(["mean", "count"])
    s = s[s["count"] >= 3]["mean"] * 100
    return _complete(_norm_idx(s), DAY)


def _oi() -> pd.Series:
    y = store.get("lev_bybit_1d")
    s = y.set_index("time")["oi_usdt"].astype(float)
    return _complete(_norm_idx(s[s > 0]), DAY)


def _liq(side: str) -> Callable[[], pd.Series]:
    def fn() -> pd.Series:
        d = store.liquidations()
        if d is None or d.empty:
            return pd.Series(dtype=float)
        d = d[d["side"] == side]
        first = pd.to_datetime(store.liquidations()["time"], utc=True).min().ceil("D")   # primo giorno intero di raccolta
        s = d.assign(day=pd.to_datetime(d["time"], utc=True).dt.floor("D")).groupby("day")["usd"].sum()
        idx = pd.date_range(first, pd.Timestamp.now(tz="UTC").floor("D") - pd.Timedelta(days=1), freq="D")
        s = s.reindex(idx, fill_value=0.0) if len(idx) else s.iloc[0:0]
        return _complete(_norm_idx(s), DAY)
    return fn


def _volume() -> pd.Series:
    k = store.get("k_1d")
    return _complete(_norm_idx(k.set_index("time")["volume"].astype(float)), DAY)


ETF_LAG = DAY + 12 * 3600    # Farside: totale della seduta pubblicato la sera USA / mattina dopo (stima prudente)
ONCHAIN_LAG = 2 * DAY        # CoinMetrics community: dato del giorno D pubblicato nel corso del giorno D+1


def _etf() -> pd.Series:
    e = store.get("sd_etf")
    s = _norm_idx(e.set_index("time")["total_reported"].astype(float)).dropna()
    s = s.iloc[:-1]           # ultima seduta provvisoria: fuori dal backtest
    return _complete(s, ETF_LAG)


def _exchange() -> pd.Series:
    x = store.get("sd_exchange")
    s = x.set_index("time")
    net = (s["FlowInExNtv"].astype(float) - s["FlowOutExNtv"].astype(float))
    net = _norm_idx(net)
    return _complete(net[net.index >= pd.Timestamp("2015-01-01", tz="UTC")], ONCHAIN_LAG)


TYPES: list[TypeDef] = [
    TypeDef("funding", "level", (1, -1), DAY, "pct_8h", _funding),
    TypeDef("oi", "pct", (1, -1), DAY, "btc", _oi),
    TypeDef("liq_long", "log1p", (1,), DAY, "usd", _liq("long")),
    TypeDef("liq_short", "log1p", (1,), DAY, "usd", _liq("short")),
    TypeDef("volume", "log", (1,), DAY, "btc", _volume),
    TypeDef("etf", "level", (1, -1), ETF_LAG, "musd", _etf),
    TypeDef("exchange", "level", (1, -1), ONCHAIN_LAG, "btc", _exchange),
]
TYPE_IDS = [t.id for t in TYPES]


def _daily_close() -> pd.Series:
    """Chiusure giornaliere complete (BTC/USD, 2010→): il giorno in corso è escluso."""
    d = store.get("daily")
    s = _norm_idx(d.set_index("time")["close"].astype(float))
    today = pd.Timestamp.now(tz="UTC").floor("D")
    return s[s.index < today]


# ===================================================================== backtest

def _events(td: TypeDef, thr: float) -> tuple[pd.DataFrame, pd.Series, np.ndarray]:
    s = td.load()
    if s is None or len(s) == 0:
        return pd.DataFrame(columns=["time", "value", "x", "z", "sign"]), pd.Series(dtype=float), np.empty(0)
    t = secs(s.index)
    y = transform(s.to_numpy(float), td.how)
    z = robust_z(y, WINDOW_DAYS, max(20, WINDOW_DAYS // 3))
    ii = decluster(t, z, thr, GAP_DAYS * DAY)
    ev = pd.DataFrame({"time": t[ii], "value": s.to_numpy(float)[ii], "x": y[ii], "z": z[ii], "sign": np.sign(z[ii]).astype(int)})
    ev = ev[ev["sign"].isin(td.signs)]
    return ev.reset_index(drop=True), s, z


def _entry_idx(day_t: np.ndarray, close_t: np.ndarray, lag: int) -> np.ndarray:
    """Indice del primo giorno (nelle chiusure) la cui chiusura (giorno + 1) è ≥ disponibilità (osservazione + lag)."""
    avail = day_t + lag
    return np.searchsorted(close_t + DAY, avail, side="left")


def backtest(thr: float = DEFAULT_THR, seed: int = 7) -> dict:
    rng = np.random.default_rng(seed)
    px = _daily_close()
    ct = secs(px.index)
    cv = px.to_numpy(float)
    rows: list[dict] = []
    tests: list[tuple[int, int, str]] = []   # (row, horizon idx, metric)
    pvals: list[float | None] = []
    recent: list[dict] = []
    now = time.time()
    for td in TYPES:
        try:
            ev, s, z = _events(td, thr)
        except Exception as e:  # noqa: BLE001
            log.warning("anomalie %s non disponibili: %s", td.id, e)
            for sg in td.signs:
                rows.append({"id": f"{td.id}{'_up' if sg > 0 else '_dn'}", "type": td.id, "sign": sg, "n": 0, "available": False, "horizons": []})
            continue
        st = secs(s.index) if len(s) else np.empty(0, dtype=np.int64)
        zok = np.isfinite(z)
        sample_from = int(st[zok][0]) if zok.any() else None
        sample_to = int(st[-1]) if len(st) else None
        # giorni di base: tutti i giorni del periodo in cui il tipo era misurabile, con lo stesso ritardo d'ingresso
        base_e = np.empty(0, dtype=np.int64)
        if sample_from is not None:
            base_days = st[zok]
            base_e = _entry_idx(base_days, ct, td.lag)
        for sg in td.signs:
            e = ev[ev["sign"] == sg]
            e_idx = _entry_idx(e["time"].to_numpy(np.int64), ct, td.lag) if len(e) else np.empty(0, dtype=np.int64)
            row = {"id": f"{td.id}{'_up' if sg > 0 else '_dn'}", "type": td.id, "sign": sg, "unit": td.unit, "available": True,
                   "lag_s": td.lag, "sample_from": sample_from, "sample_to": sample_to, "n_events": int(len(e)),
                   "last_event": int(e["time"].iloc[-1]) if len(e) else None, "horizons": []}
            for hi, h in enumerate(HORIZONS):
                ok = e_idx + h < len(cv)
                r = (cv[e_idx[ok] + h] / cv[e_idx[ok]] - 1) * 100 if ok.any() else np.empty(0)
                bok = base_e + h < len(cv)
                pool = (cv[base_e[bok] + h] / cv[base_e[bok]] - 1) * 100 if bok.any() else np.empty(0)
                cell = {"h": h, "n": int(len(r))}
                for metric, ev_v, pool_v in (("ret", r, pool), ("vol", np.abs(r), np.abs(pool))):
                    p, mu = _mc_p(ev_v, pool_v, rng)
                    cell[metric] = {"mean": float(ev_v.mean()) if len(ev_v) else None, "median": float(np.median(ev_v)) if len(ev_v) else None,
                                    "ci": _boot_ci(ev_v, rng), "base": mu if mu is not None else (float(pool_v.mean()) if len(pool_v) else None),
                                    "diff": (float(ev_v.mean()) - mu) if len(ev_v) and mu is not None else None, "p": p, "p_bh": None,
                                    "up": float((ev_v > 0).mean() * 100) if metric == "ret" and len(ev_v) else None}
                    tests.append((len(rows), hi, metric))
                    pvals.append(p)
                row["horizons"].append(cell)
            row["n"] = max((c["n"] for c in row["horizons"]), default=0)
            rows.append(row)
            # anomalie recenti (giorni completi, ultimi 30 giorni di osservazione)
            for _, x in e[e["time"] >= now - RECENT_DAYS * DAY].iterrows():
                recent.append({"type": td.id, "sign": sg, "id": row["id"], "time": int(x["time"]), "avail": int(x["time"]) + td.lag,
                               "value": float(x["value"]), "x": float(x["x"]), "how": td.how, "z": float(x["z"]), "unit": td.unit})
    q = bh(pvals)
    for (ri, hi, metric), qq in zip(tests, q):
        rows[ri]["horizons"][hi][metric]["p_bh"] = qq
    for row in rows:
        for c in row["horizons"]:
            for metric in ("ret", "vol"):
                m = c[metric]
                m["verdict"] = verdict(c["n"], m["p"], m["p_bh"])
        row["verdict"], row["headline"] = _headline(row)
    recent.sort(key=lambda r: (r["time"], abs(r["z"])), reverse=True)
    return util.clean({
        "params": {"thr": thr, "window": WINDOW_DAYS, "gap_days": GAP_DAYS, "horizons": list(HORIZONS), "min_n": MIN_N,
                   "n_mc": N_MC, "n_boot": N_BOOT, "tests": len([p for p in pvals if p is not None]), "recent_days": RECENT_DAYS},
        "types": rows, "recent": recent, "generated_at": int(now),
    })


RANK = {"strong": 3, "weak": 2, "none": 1, "anecdotal": 0}


def _headline(row: dict) -> tuple[str, dict | None]:
    """Verdetto del tipo = il più forte tra orizzonti e metriche (a parità, p più basso)."""
    best, key = None, (-1, 0.0)
    for c in row.get("horizons") or []:
        for metric in ("ret", "vol"):
            m = c[metric]
            k = (RANK[m["verdict"]], -(m["p"] if m["p"] is not None else 1.0))
            if k > key:
                key, best = k, {"h": c["h"], "metric": metric}
    if best is None:
        return "anecdotal", None
    return row["horizons"][HORIZONS.index(best["h"])][best["metric"]]["verdict"], best


_cache: dict[float, tuple[float, dict]] = {}


def build(thr: float = DEFAULT_THR) -> dict:
    """Backtest per tipo + anomalie recenti (cache 30 min per soglia)."""
    thr = float(min(5.0, max(2.0, round(thr * 2) / 2)))
    hit = _cache.get(thr)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    t0 = time.perf_counter()
    out = backtest(thr)
    out["compute_ms"] = int((time.perf_counter() - t0) * 1000)
    _cache[thr] = (time.time(), out)
    return out
