"""VWAP ancorati al calendario UTC (settimana, mese, trimestre, anno) con bande ±σ e livelli del periodo precedente.

Formula (validata replicando al centesimo i 24 valori di uno screenshot di riferimento su Kraken Futures PF_XBTUSD):
  prezzo tipico tp = (H + L + C) / 3 di ogni candela CHIUSA dall'ancora,
  VWAP = Σ(tp·v) / Σv,   σ = sqrt(Σ(v·tp²)/Σv − VWAP²)  (deviazione standard pesata per volume),
  bande = VWAP ± kσ,   livelli del periodo precedente = valori finali (VWAP, ±1σ) del periodo completo precedente.
Ancore: lunedì 00:00 · giorno 1 del mese · 1 gen/apr/lug/ott · 1 gennaio (UTC).

Due modalità di calcolo:
  - "fine"  (default): candele da 1 minuto, la risoluzione più fine disponibile per entrambe le fonti;
  - "chart": candele del timeframe del grafico (W 5m · M 30m · Q 1h · Y 4h), come la piattaforma dello screenshot.
La differenza tra le due è misurata a ogni calcolo e restituita in `resolution_check`.

Dati: candele 1m dal 1° gennaio dell'anno precedente, persistite in due dataset per fonte:
  vwap_<fonte>_hist  (fino alle 00:00 UTC di oggi, scritto al massimo una volta l'ora; bootstrap a tranche),
  vwap_<fonte>_live  (da ieri 00:00 UTC a ora, aggiornato ogni minuto).
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store

log = logging.getLogger("vwap")

UTC = timezone.utc
PERIODS = ("w", "m", "q", "y")
TF = {"w": 300, "m": 1800, "q": 3600, "y": 14400}          # timeframe dei grafici (s)
SOURCES = {
    "kraken": {"exchange": "Kraken Futures", "instrument": "PF_XBTUSD", "quote": "USD"},
    "binance": {"exchange": "Binance USDⓈ-M", "instrument": "BTCUSDT", "quote": "USDT"},
}
DEFAULT_SOURCE = "kraken"
KRAKEN_URL = "https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/1m"
BINANCE_URL = "https://fapi.binance.com/fapi/v1/klines"
COLS = ["time", "open", "high", "low", "close", "volume"]
BUDGET_S = 25            # secondi massimi di download per singola chiamata del refresher (bootstrap a tranche)
CONFLUENCE_PCT = 0.5


# ------------------------------------------------------------------ calendario

def _dt(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, UTC)


def anchor(p: str, ts: float) -> int:
    """Inizio (unix s) del periodo `p` che contiene `ts`."""
    d = _dt(ts)
    if p == "w":
        a = datetime(d.year, d.month, d.day, tzinfo=UTC) - timedelta(days=d.weekday())
    elif p == "m":
        a = datetime(d.year, d.month, 1, tzinfo=UTC)
    elif p == "q":
        a = datetime(d.year, 3 * ((d.month - 1) // 3) + 1, 1, tzinfo=UTC)
    else:
        a = datetime(d.year, 1, 1, tzinfo=UTC)
    return int(a.timestamp())


def prev_anchor(p: str, a: int) -> int:
    return anchor(p, a - 1)


def history_start(now: float | None = None) -> int:
    """1° gennaio dell'anno precedente: serve l'anno precedente intero per i livelli pY."""
    return prev_anchor("y", anchor("y", now or time.time()))


def _day_start(ts: float) -> int:
    return int(ts // 86400 * 86400)


# ------------------------------------------------------------------ download

def _frame(rows: list[tuple]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=COLS)
    df = pd.DataFrame(rows, columns=COLS)
    df["time"] = pd.to_datetime(df["time"].astype("int64"), unit="s", utc=True)
    return df.drop_duplicates("time").sort_values("time").reset_index(drop=True)


def _kraken_page(frm: int, to: int) -> list[tuple]:
    """Candele 1m Kraken in [frm, to] (max 2000 per chiamata). Sotto carico l'API a volte risponde con una pagina
    vuota o parziale: si ritenta finché la pagina è completa (una pagina del passato deve avere ~tutte le candele)."""
    expected = (to - frm) // 60 + 1
    rows: list[tuple] = []
    for attempt in range(6):
        try:
            r = src._client.get(KRAKEN_URL, params={"from": frm, "to": to})
            if r.status_code == 429:
                time.sleep(2 + attempt * 2)
                continue
            r.raise_for_status()
            cs = r.json().get("candles") or []
            rows = [(int(c["time"]) // 1000, float(c["open"]), float(c["high"]), float(c["low"]), float(c["close"]), float(c["volume"])) for c in cs]
            # pagina vuota = risposta spuria (anche vicino ad ora): si ritenta
            if rows and len(rows) >= expected - max(3, 0.02 * expected):
                return rows
        except (httpx.HTTPError, ValueError, KeyError) as e:
            log.debug("kraken page %s: %s", frm, e)
        time.sleep(1 + attempt)
    if rows:
        log.warning("kraken 1m: pagina %s incompleta (%d/%d candele)", _dt(frm), len(rows), expected)
    return rows


def _kraken_fetch(start: int, end: int, deadline: float) -> list[tuple]:
    out: list[tuple] = []
    cur = start
    while cur <= end and time.time() < deadline:
        to = min(cur + 1999 * 60, end)
        rows = _kraken_page(cur, to)
        if not rows and to > time.time() - 3600:
            break       # ultima ora senza risposta: riprova al prossimo giro invece di saltare la finestra
        out.extend(rows)
        cur = to + 60   # nel passato avanza comunque: una finestra davvero vuota (fermo dell'exchange) non blocca il download
    return out


_bin_lock = threading.Lock()


def _binance_fetch(start: int, end: int, deadline: float) -> list[tuple]:
    """Klines 1m Binance USDⓈ-M (limit 1000 = peso 5). Rispetta il limite di peso per IP condiviso con il resto dell'app:
    oltre 1200/2400 al minuto aspetta il minuto successivo."""
    out: list[tuple] = []
    cur = start
    with _bin_lock:
        while cur <= end and time.time() < deadline:
            try:
                r = src._client.get(BINANCE_URL, params={"symbol": "BTCUSDT", "interval": "1m", "startTime": cur * 1000,
                                                         "endTime": end * 1000 + 59_999, "limit": 1000})
                if r.status_code in (418, 429):
                    time.sleep(min(60, int(r.headers.get("retry-after", 30))))
                    continue
                r.raise_for_status()
                batch = r.json()
            except (httpx.HTTPError, ValueError) as e:
                log.info("binance 1m: %s", e)
                time.sleep(2)
                continue
            if not batch:
                break
            out.extend((int(k[0]) // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])) for k in batch)
            cur = int(batch[-1][0]) // 1000 + 60
            if int(r.headers.get("x-mbx-used-weight-1m", 0)) > 1200:
                time.sleep(61 - time.time() % 60)
            if len(batch) < 1000:
                break
    return out


FETCH = {"kraken": _kraken_fetch, "binance": _binance_fetch}


def _last_closed_start(now: float) -> int:
    """Inizio dell'ultima candela 1m chiusa."""
    return int(now // 60 * 60) - 60


def _hist_refresher(source: str):
    def fn(old: pd.DataFrame | None) -> pd.DataFrame:
        now = time.time()
        h0, end = history_start(now), _day_start(now) - 60          # fino alle 23:59 di ieri
        if old is not None and not old.empty:
            old = old[old["time"] >= pd.Timestamp(h0, unit="s", tz="UTC")]
        start = h0 if old is None or old.empty else int(old["time"].iloc[-1].timestamp()) + 60
        if start > end:
            return old if old is not None else pd.DataFrame(columns=COLS)
        new = _frame(FETCH[source](start, end, time.time() + BUDGET_S))
        new = new[new["time"] <= pd.Timestamp(end, unit="s", tz="UTC")]
        return store._merge(old, new) if old is not None else new
    return fn


def _live_refresher(source: str):
    def fn(old: pd.DataFrame | None) -> pd.DataFrame:
        now = time.time()
        keep_from = _day_start(now) - 86400
        last = _last_closed_start(now)
        if old is not None and not old.empty:
            old = old[old["time"] >= pd.Timestamp(keep_from, unit="s", tz="UTC")]
        start = keep_from if old is None or old.empty else max(keep_from, int(old["time"].iloc[-1].timestamp()) - 120)
        new = _frame(FETCH[source](start, last, time.time() + BUDGET_S))
        new = new[new["time"] <= pd.Timestamp(last, unit="s", tz="UTC")]   # solo candele chiuse
        return store._merge(old, new) if old is not None and not old.empty else new
    return fn


for _s in SOURCES:
    store.register(f"vwap_{_s}_hist", _hist_refresher(_s), 3600)
    store.register(f"vwap_{_s}_live", _live_refresher(_s), 45)


def _safe_get(name: str, force: bool = False) -> pd.DataFrame | None:
    try:
        return store.get(name, force=force)
    except Exception as e:  # noqa: BLE001
        log.info("dataset %s non disponibile: %s", name, e)
        return None


def _peek(name: str) -> pd.DataFrame | None:
    """Lettura senza download (percorso delle richieste HTTP): memoria o disco. Gli aggiornamenti li fanno l'agente
    (ensure, ogni minuto) e il refresher generale dei dataset."""
    df = store._mem.get(name)
    if df is None:
        try:
            df = store._load_disk(name)
        except Exception as e:  # noqa: BLE001
            log.info("lettura %s fallita: %s", name, e)
            df = None
        if df is not None:
            store._mem.setdefault(name, df)
    return df


# ------------------------------------------------------------------ array 1m combinati

_arr_cache: dict[str, tuple] = {}
_arr_lock = threading.Lock()


def _to_np(df: pd.DataFrame | None) -> dict[str, np.ndarray]:
    if df is None or df.empty:
        return {k: np.empty(0, dtype=np.int64 if k == "t" else float) for k in ("t", "o", "h", "l", "c", "v")}
    return {"t": df["time"].values.astype("datetime64[s]").astype(np.int64),
            "o": df["open"].to_numpy(float), "h": df["high"].to_numpy(float), "l": df["low"].to_numpy(float),
            "c": df["close"].to_numpy(float), "v": df["volume"].to_numpy(float)}


def arrays(source: str) -> dict:
    """Candele 1m chiuse (storico + live) come array numpy, con stato di completezza."""
    hist, live = _peek(f"vwap_{source}_hist"), _peek(f"vwap_{source}_live")
    key = (len(hist) if hist is not None else 0, str(hist["time"].iloc[-1]) if hist is not None and len(hist) else "",
           len(live) if live is not None else 0, str(live["time"].iloc[-1]) if live is not None and len(live) else "")
    with _arr_lock:
        hit = _arr_cache.get(source)
        if hit and hit[0] == key:
            return hit[1]
    H, L = _to_np(hist), _to_np(live)
    if len(H["t"]) and len(L["t"]):
        m = L["t"] > H["t"][-1]
        A = {k: np.concatenate([H[k], L[k][m]]) for k in H}
    else:
        A = H if len(H["t"]) else L
    now = time.time()
    h0 = history_start(now)
    i0 = int(np.searchsorted(A["t"], h0))
    A = {k: v[i0:] for k, v in A.items()}
    t = A["t"]
    n = len(t)
    last = int(t[-1]) if n else None
    first = int(t[0]) if n else None
    gaps = np.diff(t) // 60 - 1 if n > 1 else np.empty(0, dtype=np.int64)
    missing = int(gaps[gaps > 0].sum()) if len(gaps) else 0
    big = int((gaps > 30).sum()) if len(gaps) else 0
    span = max(1.0, now - 60 - h0)
    progress = min(1.0, n * 60 / span)          # quota dei minuti attesi già presenti
    ready = bool(n and first <= h0 + 86400 and last >= _last_closed_start(now) - 600 and big == 0)
    out = {"source": source, "key": key, **A, "first": first, "last": last, "missing_min": missing, "big_gaps": big,
           "ready": ready, "progress": round(progress, 4), "n": n}
    with _arr_lock:
        _arr_cache[source] = (key, out)
    return out


def ensure(source: str, budget_s: float = 240, force_live: bool = True) -> dict:
    """Bootstrap/aggiornamento sincrono (thread dell'agente): scarica lo storico a tranche finché è completo."""
    t0 = time.time()
    hist_name = f"vwap_{source}_hist"
    while time.time() - t0 < budget_s:
        h = _safe_get(hist_name)
        end = _day_start(time.time()) - 60
        if h is not None and len(h) and int(h["time"].iloc[-1].timestamp()) >= end and int(h["time"].iloc[0].timestamp()) <= history_start() + 86400:
            break
        before = len(h) if h is not None else 0
        h = _safe_get(hist_name, force=True)
        if h is None or len(h) == before:
            break   # nessun progresso (rete giù): riprova al prossimo giro
    _safe_get(f"vwap_{source}_live", force=force_live)
    return arrays(source)


# ------------------------------------------------------------------ calcolo

def _agg(A: dict, tf: int, t0: int) -> dict:
    """Aggrega le candele 1m in candele da `tf` secondi a partire da t0 (allineate all'epoca UTC)."""
    i0 = int(np.searchsorted(A["t"], t0))
    t = A["t"][i0:]
    if not len(t):
        return {"t": np.empty(0, dtype=np.int64), "o": np.empty(0), "h": np.empty(0), "l": np.empty(0), "c": np.empty(0), "v": np.empty(0), "n": np.empty(0, dtype=np.int64)}
    b = t - t % tf
    starts = np.flatnonzero(np.r_[True, b[1:] != b[:-1]])
    ends = np.r_[starts[1:], len(t)] - 1
    return {"t": b[starts], "o": A["o"][i0:][starts], "h": np.maximum.reduceat(A["h"][i0:], starts),
            "l": np.minimum.reduceat(A["l"][i0:], starts), "c": A["c"][i0:][ends], "v": np.add.reduceat(A["v"][i0:], starts),
            "n": ends - starts + 1}


def _cum(tp: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """VWAP e σ pesata cumulativi (centrati per stabilità numerica)."""
    if not len(tp):
        return np.empty(0), np.empty(0)
    ref = float(tp[0])
    x = tp - ref
    cv = np.cumsum(v)
    with np.errstate(invalid="ignore", divide="ignore"):
        m = np.cumsum(v * x) / cv
        var = np.cumsum(v * x * x) / cv - m * m
    vw = np.where(cv > 0, m + ref, np.nan)
    sd = np.where(cv > 0, np.sqrt(np.clip(var, 0, None)), np.nan)
    return vw, sd


def _rows(A: dict, p: str, calc: str, t0: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Righe di calcolo (inizio, tp, volume, durata) dal tempo t0: 1m oppure candele chiuse del timeframe del grafico."""
    if calc == "chart":
        tf = TF[p]
        g = _agg(A, tf, t0)
        end_closed = (A["last"] + 60) if A["last"] is not None else 0
        closed = g["t"] + tf <= end_closed
        return g["t"][closed], ((g["h"] + g["l"] + g["c"]) / 3)[closed], g["v"][closed], tf
    i0 = int(np.searchsorted(A["t"], t0))
    return A["t"][i0:], (A["h"][i0:] + A["l"][i0:] + A["c"][i0:]) / 3, A["v"][i0:], 60


def _f(x) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), 2)


def _period(A: dict, p: str, calc: str) -> dict:
    now_end = A["last"] + 60                     # fine dell'ultima candela 1m chiusa
    a = anchor(p, now_end - 1) if now_end else anchor(p, time.time())
    pa = prev_anchor(p, a)
    rt, tp, v, res = _rows(A, p, calc, pa)
    prev_m = rt < a
    cur_m = ~prev_m
    pvw, psd = _cum(tp[prev_m], v[prev_m])
    cvw, csd = _cum(tp[cur_m], v[cur_m])
    lv = lambda arr: float(arr[-1]) if len(arr) else np.nan  # noqa: E731
    vw, sd, pv, ps = lv(cvw), lv(csd), lv(pvw), lv(psd)
    return {
        "id": p, "tf": TF[p], "anchor": a, "prev_anchor": pa, "prev_end": a - 1,
        "vwap": _f(vw), "sd": _f(sd), "up1": _f(vw + sd), "dn1": _f(vw - sd), "up2": _f(vw + 2 * sd), "dn2": _f(vw - 2 * sd),
        "prev": {"vwap": _f(pv), "sd": _f(ps), "up1": _f(pv + ps), "dn1": _f(pv - ps)},
        "rows": int(cur_m.sum()), "prev_rows": int(prev_m.sum()),
        "_cum": (rt, prev_m, cur_m, pvw, psd, cvw, csd, res),
    }


def _levels(A: dict, calc: str) -> dict[str, dict]:
    return {p: _period(A, p, calc) for p in PERIODS}


def _public(per: dict) -> dict:
    return {k: v for k, v in per.items() if not k.startswith("_")}


_LVL_KEYS = (("vwap", None), ("up1", None), ("dn1", None), ("vwap", "prev"), ("up1", "prev"), ("dn1", "prev"))


def _vals(per: dict) -> list[float | None]:
    return [(per["prev"] if g else per)[k] for k, g in _LVL_KEYS]


def _diff_bp(a: list, b: list) -> list[float | None]:
    return [None if x is None or y is None or not y else round((x / y - 1) * 1e4, 2) for x, y in zip(a, b)]


def live_price(source: str) -> tuple[float | None, int | None]:
    """Ultimo prezzo dal WebSocket (Kraken trade feed / Binance perp kline 1m) se fresco (< 30 s)."""
    try:
        from ..routers.stream import hub
        if source == "kraken":
            m = hub.last.get("vwap_tick")
            if m and time.time() - m["time"] < 30:
                return float(m["price"]), int(m["time"])
        else:
            m = hub.last.get("perp_kline")
            if m and time.time() - m["candle"]["time"] < 90:
                return float(m["candle"]["close"]), int(time.time())
    except Exception:  # noqa: BLE001
        pass
    return None, None


LEVEL_NAMES = {"vwap": "VWAP", "up1": "+1σ", "dn1": "−1σ"}


def _confluence(levels: dict[str, dict], price: float | None) -> list[dict]:
    """Gruppi di livelli di periodi DIVERSI entro lo 0,5% (ampiezza del gruppo). Periodi con la stessa ancora (es. M e Q
    a ottobre) danno lo stesso VWAP corrente: il duplicato non conta come confluenza."""
    items = []
    seen_anchor: dict[int, str] = {}
    for p in PERIODS:
        per = levels[p]
        dup = per["anchor"] in seen_anchor
        seen_anchor.setdefault(per["anchor"], p)
        for k in ("vwap", "up1", "dn1"):
            if not dup and per[k] is not None:
                items.append({"id": f"{p}_{k}", "period": p, "prev": False, "level": k, "price": per[k]})
        for k in ("vwap", "up1", "dn1"):
            v = per["prev"][k]
            if v is not None and not any(i["prev"] and i["level"] == k and abs(i["price"] - v) < 1e-6 for i in items):
                items.append({"id": f"p{p}_{k}", "period": p, "prev": True, "level": k, "price": v})
    items.sort(key=lambda x: x["price"])
    groups, cur = [], []
    for it in items:
        if cur and (it["price"] / cur[0]["price"] - 1) * 100 > CONFLUENCE_PCT:
            groups.append(cur)
            cur = []
        cur.append(it)
    if cur:
        groups.append(cur)
    out = []
    for g in groups:
        if len({i["period"] + ("p" if i["prev"] else "") for i in g}) < 2:   # serve almeno due serie diverse (es. W e pM)
            continue
        lo, hi = g[0]["price"], g[-1]["price"]
        mid = (lo + hi) / 2
        out.append({"low": lo, "high": hi, "mid": round(mid, 2), "width_pct": round((hi / lo - 1) * 100, 3),
                    "members": [i["id"] for i in g], "n": len(g),
                    "distance_pct": round((mid / price - 1) * 100, 3) if price else None})
    out.sort(key=lambda c: abs(c["distance_pct"]) if c["distance_pct"] is not None else 1e9)
    return out[:6]


def _status(A: dict) -> dict:
    return {"ready": A["ready"], "progress": A["progress"], "first": A["first"], "last": A["last"],
            "last_closed_end": (A["last"] + 60) if A["last"] is not None else None, "rows": A["n"],
            "missing_min": A["missing_min"], "big_gaps": A["big_gaps"], "history_start": history_start()}


_sum_cache: dict[tuple, tuple] = {}


def build(source: str = DEFAULT_SOURCE, calc: str = "fine") -> dict:
    """Riepilogo: livelli W/M/Q/Y (+ periodo precedente), posizione del prezzo, confluenze, verifiche incrociate."""
    if source not in SOURCES:
        raise ValueError("source")
    if calc not in ("fine", "chart"):
        raise ValueError("calc")
    A = arrays(source)
    # niente nomi in chiaro (exchange/strumento): il traduttore EN del middleware li toccherebbe; le etichette sono nel frontend
    meta = {"source": source, "calc": calc, "periods": list(PERIODS), "tf": TF,
            "sources": {s: {"ready": (A if s == source else arrays(s))["ready"], "progress": (A if s == source else arrays(s))["progress"]} for s in SOURCES}}
    if not A["ready"]:
        return util.clean({**meta, "status": _status(A), "periods_data": None})
    ck = (source, calc, A["key"])
    hit = _sum_cache.get((source, calc))
    if hit and hit[0] == ck:
        base = hit[1]
    else:
        lv = _levels(A, calc)
        other_calc = "chart" if calc == "fine" else "fine"
        lv_other = _levels(A, other_calc)
        res_check = {p: {"diff_bp": _diff_bp(_vals(_public(lv[p])), _vals(_public(lv_other[p]))), "tf": TF[p]} for p in PERIODS}
        # verifica incrociata con l'altra fonte (stessa formula e risoluzione)
        cross = None
        other = next(s for s in SOURCES if s != source)
        B = arrays(other)
        if B["ready"]:
            lb = _levels(B, calc)
            n = min(len(A["t"]), 1440)
            ta, ca = A["t"][-n:], A["c"][-n:]
            j = np.isin(B["t"], ta)
            tb, cb = B["t"][j], B["c"][j]
            k = np.isin(ta, tb)
            basis = float(np.median(cb / ca[k] - 1) * 1e4) if k.sum() else None
            cross = {"other": other,
                     "price_basis_bp_24h": round(basis, 2) if basis is not None else None,
                     "periods": {p: {"other": _vals(_public(lb[p])), "diff_bp": _diff_bp(_vals(_public(lb[p])), _vals(_public(lv[p])))} for p in PERIODS}}
        base = {"levels": {p: _public(lv[p]) for p in PERIODS}, "resolution_check": res_check, "crosscheck": cross,
                "close": float(A["c"][-1]), "close_time": int(A["t"][-1])}
        _sum_cache[(source, calc)] = (ck, base)
    price, ptime = live_price(source)
    px = price or base["close"]
    periods = {}
    for p in PERIODS:
        L = base["levels"][p]
        vw, sd = L["vwap"], L["sd"]
        periods[p] = {**L,
                      "dist_pct": (px / vw - 1) * 100 if vw else None,
                      "z": (px - vw) / sd if vw and sd else None,
                      "prev_dist_pct": (px / L["prev"]["vwap"] - 1) * 100 if L["prev"]["vwap"] else None}
    return util.clean({**meta, "status": _status(A), "price": px, "price_time": ptime or base["close_time"] + 60,
                       "price_live": price is not None, "close": base["close"], "periods_data": periods,
                       "confluence": _confluence(base["levels"], px), "confluence_pct": CONFLUENCE_PCT,
                       "resolution_check": base["resolution_check"], "crosscheck": base["crosscheck"], "time": int(time.time())})


_panel_cache: dict[tuple, tuple] = {}


def _arr(x: np.ndarray) -> list:
    return [None if not np.isfinite(v) else round(float(v), 2) for v in x]


def panel(p: str, source: str = DEFAULT_SOURCE, calc: str = "fine") -> dict:
    """Candele del timeframe del pannello dal periodo precedente a ora + linee VWAP/±σ correnti e del periodo precedente
    (crescente durante il periodo precedente, poi piatta = livello esteso). Array colonnari allineati alle candele."""
    if p not in PERIODS or source not in SOURCES or calc not in ("fine", "chart"):
        raise ValueError("parametri")
    A = arrays(source)
    if not A["ready"]:
        return util.clean({"id": p, "source": source, "calc": calc, "status": _status(A), "candles": None})
    ck = (p, source, calc, A["key"])
    hit = _panel_cache.get((p, source, calc))
    if hit and hit[0] == ck:
        return hit[1]
    per = _period(A, p, calc)
    tf = TF[p]
    rt, prev_m, cur_m, pvw, psd, cvw, csd, res = per["_cum"]
    g = _agg(A, tf, per["prev_anchor"])
    T = g["t"]
    end_closed = A["last"] + 60
    forming = len(T) > 0 and T[-1] + tf > end_closed
    n = len(T)
    nan = np.full(n, np.nan)
    lines = {k: nan.copy() for k in ("vwap", "up1", "dn1", "pvwap", "pup1", "pdn1")}   # ±2σ: derivate nel frontend
    a = per["anchor"]
    # periodo precedente: valore cumulativo a fine candela, poi esteso piatto
    rt_p, rt_c = rt[prev_m], rt[cur_m]
    ends = T + tf
    if len(rt_p):
        k = np.searchsorted(rt_p, ends, side="left") - 1
        inprev = T < a
        kk = np.where(inprev, k, len(rt_p) - 1)
        ok = kk >= 0
        lines["pvwap"][ok] = pvw[kk[ok]]
        lines["pup1"][ok] = pvw[kk[ok]] + psd[kk[ok]]
        lines["pdn1"][ok] = pvw[kk[ok]] - psd[kk[ok]]
    if len(rt_c):
        k = np.searchsorted(rt_c, ends, side="left") - 1
        ok = (T >= a) & (k >= 0)
        if calc == "chart" and forming:
            ok[-1] = False
        vw, sd = cvw[k[ok]], csd[k[ok]]
        lines["vwap"][ok], lines["up1"][ok], lines["dn1"][ok] = vw, vw + sd, vw - sd
    out = util.clean({
        "id": p, "source": source, "calc": calc, "tf": tf, "status": _status(A),
        "anchor": a, "prev_anchor": per["prev_anchor"], "prev_end": per["prev_end"], "last_closed_end": end_closed,
        "forming": bool(forming),
        "candles": {"t": T.tolist(), "o": g["o"].tolist(), "h": g["h"].tolist(), "l": g["l"].tolist(), "c": g["c"].tolist()},
        "lines": {k: _arr(v) for k, v in lines.items()},
        "levels": _public(per),
    })
    _panel_cache[(p, source, calc)] = (ck, out)
    return out


# ================================================================== grafico unico + volume profile per sessione

OVERVIEW_TFS = {"30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400}
VA_PCT = 0.70
_NICE = (10, 20, 25, 50, 100, 200, 250, 500, 1000)


def _nice_bin(price: float, frac: float) -> float:
    """Ampiezza dei bin del profilo: valore tondo più vicino a prezzo × frac (settimana 0,06% ≈ $50, mese 0,12% ≈ $100 a 83k)."""
    target = max(1.0, price * frac)
    return float(min(_NICE, key=lambda x: abs(np.log(x / target))))


def volume_profile(h: np.ndarray, l: np.ndarray, v: np.ndarray, B: float) -> tuple[float, np.ndarray]:
    """Volume per bin di prezzo di ampiezza B. Il volume di ogni candela è distribuito uniformemente tra minimo e massimo
    (calcolo esatto: F(x) = Σ s·(relu(x−l) − relu(x−h)) con s = v/(h−l), valutata sui bordi dei bin con somme cumulative
    ordinate). Candele con h = l: tutto il volume nel bin che contiene il prezzo. -> (prezzo inferiore del primo bin, volumi)."""
    lo = float(np.floor(l.min() / B) * B)
    hi = float(np.ceil(h.max() / B) * B)
    if hi <= lo:
        hi = lo + B
    edges = lo + B * np.arange(int(round((hi - lo) / B)) + 1)
    rng = h - l
    flat = rng <= 1e-9

    def relu_sum(x, pts, w):
        if not len(pts):
            return np.zeros_like(x)
        o = np.argsort(pts, kind="stable")
        p, ws = pts[o], w[o]
        cs, cps = np.r_[0.0, np.cumsum(ws)], np.r_[0.0, np.cumsum(ws * p)]
        k = np.searchsorted(p, x, side="left")
        return x * cs[k] - cps[k]

    s = v[~flat] / rng[~flat]
    F = relu_sum(edges, l[~flat], s) - relu_sum(edges, h[~flat], s)
    if flat.any():
        m = (l[flat] + h[flat]) / 2
        o = np.argsort(m, kind="stable")
        cw = np.r_[0.0, np.cumsum(v[flat][o])]
        F = F + cw[np.searchsorted(m[o], edges, side="right")]
    vols = np.diff(F)
    vols[-1] += float(v.sum()) - float(F[-1])        # volume esattamente sul bordo superiore
    return lo, np.clip(vols, 0, None)


def value_area(vols: np.ndarray, pct: float = VA_PCT) -> tuple[int, int, int]:
    """Value area standard: parte dal POC (bin a volume massimo) e aggiunge ogni volta il bin adiacente (sopra o sotto)
    con più volume, finché il volume incluso raggiunge `pct` del totale. -> (poc, bin_basso, bin_alto)."""
    n = len(vols)
    poc = int(np.argmax(vols))
    total, acc = float(vols.sum()), float(vols[poc])
    lo = hi = poc
    while acc < pct * total and (lo > 0 or hi < n - 1):
        up = vols[hi + 1] if hi + 1 < n else -1.0
        dn = vols[lo - 1] if lo > 0 else -1.0
        if up >= dn:
            hi += 1
            acc += up
        else:
            lo -= 1
            acc += dn
    return poc, lo, hi


def _vp_levels(h, l, v, B) -> dict:
    lo, vols = volume_profile(h, l, v, B)
    poc, a, b = value_area(vols)
    return {"lo": lo, "vols": vols, "poc": lo + (poc + 0.5) * B, "val": lo + a * B, "vah": lo + (b + 1) * B, "poc_i": poc, "va": (a, b)}


def _session_bounds(mode: str, t0: int, end: int) -> list[tuple[int, int]]:
    p = "w" if mode == "week" else "m"
    out, s = [], anchor(p, t0)
    while s < end:
        nxt = anchor(p, s + (8 * 86400 if p == "w" else 32 * 86400))
        out.append((s, nxt))
        s = nxt
    return out


def _profiles(A: dict, mode: str, t0: int) -> list[dict]:
    if mode == "off":
        return []
    end = A["last"] + 60
    frac = 0.0006 if mode == "week" else 0.0012
    out = []
    for s, e in _session_bounds(mode, t0, end):
        i0, i1 = int(np.searchsorted(A["t"], s)), int(np.searchsorted(A["t"], e))
        if i1 - i0 < 30:
            continue
        h, l, v = A["h"][i0:i1], A["l"][i0:i1], A["v"][i0:i1]
        B = _nice_bin(float(A["c"][i1 - 1]), frac)
        r = _vp_levels(h, l, v, B)
        rob = {"poc": 0.0, "vah": 0.0, "val": 0.0}          # robustezza: bin dimezzati e raddoppiati
        for Bx in (B / 2, B * 2):
            r2 = _vp_levels(h, l, v, Bx)
            for k in rob:
                rob[k] = max(rob[k], abs(r2[k] / r[k] - 1) * 1e4)
        vols = r["vols"]
        out.append({"start": s, "end": e, "complete": bool(e <= end), "bin": B, "lo": r["lo"],
                    "vols": [round(float(x), 3) for x in vols], "volume": round(float(vols.sum()), 2),
                    "poc": r["poc"], "vah": r["vah"], "val": r["val"], "va_bins": list(r["va"]), "poc_bin": r["poc_i"],
                    "robust_bp": {k: round(x, 1) for k, x in rob.items()}})
    return out


_ov_cache: dict[tuple, tuple] = {}


def overview(source: str = DEFAULT_SOURCE, calc: str = "fine", tf: str = "2h", profile: str = "week") -> dict:
    """Grafico unico: candele `tf` dall'inizio del mese di (ora − 35 g), VWAP correnti W/M/Q/Y (dall'ancora), livelli del
    periodo precedente (estesi nel frontend), volume profile per sessione (settimana/mese) con POC e value area 70%."""
    if source not in SOURCES or calc not in ("fine", "chart") or tf not in OVERVIEW_TFS or profile not in ("week", "month", "off"):
        raise ValueError("parametri")
    A = arrays(source)
    if not A["ready"]:
        return util.clean({"source": source, "calc": calc, "tf": tf, "status": _status(A), "candles": None})
    ck = (source, calc, tf, profile, A["key"])
    hit = _ov_cache.get((source, calc, tf, profile))
    if hit and hit[0] == ck:
        return hit[1]
    step = OVERVIEW_TFS[tf]
    end_closed = A["last"] + 60
    t0 = anchor("m", end_closed - 35 * 86400)
    g = _agg(A, step, t0)
    T = g["t"]
    forming = len(T) > 0 and T[-1] + step > end_closed
    lines, levels = {}, {}
    for p in PERIODS:
        per = _period(A, p, calc)
        rt, prev_m, cur_m, pvw, psd, cvw, csd, res = per["_cum"]
        a = per["anchor"]
        arr = {k: np.full(len(T), np.nan) for k in ("vwap", "up1", "dn1")}
        rt_c = rt[cur_m]
        if len(rt_c):
            k = np.searchsorted(rt_c, T + step, side="left") - 1
            ok = (T + step > a) & (k >= 0)
            if calc == "chart" and forming:
                ok[-1] = False
            vw, sd = cvw[k[ok]], csd[k[ok]]
            arr["vwap"][ok], arr["up1"][ok], arr["dn1"][ok] = vw, vw + sd, vw - sd
        lines[p] = {k: _arr(x) for k, x in arr.items()}
        levels[p] = _public(per)
    out = util.clean({
        "source": source, "calc": calc, "tf": tf, "step": step, "status": _status(A), "from": t0,
        "last_closed_end": end_closed, "forming": bool(forming),
        "candles": {"t": T.tolist(), "o": g["o"].tolist(), "h": g["h"].tolist(), "l": g["l"].tolist(), "c": g["c"].tolist()},
        "lines": lines, "levels": levels,
        "profile": {"mode": profile, "va_pct": VA_PCT * 100, "sessions": _profiles(A, profile, t0)},
    })
    _ov_cache[(source, calc, tf, profile)] = (ck, out)
    return out


def prev_week_profile(source: str = DEFAULT_SOURCE) -> dict | None:
    """POC/VAH/VAL del volume profile della settimana precedente completa (livelli per avvisi e agente)."""
    A = arrays(source)
    if not A["ready"]:
        return None
    a = anchor("w", A["last"] + 59)
    pa = prev_anchor("w", a)
    i0, i1 = int(np.searchsorted(A["t"], pa)), int(np.searchsorted(A["t"], a))
    if i1 - i0 < 30:
        return None
    B = _nice_bin(float(A["c"][i1 - 1]), 0.0006)
    r = _vp_levels(A["h"][i0:i1], A["l"][i0:i1], A["v"][i0:i1], B)
    return {"start": pa, "end": a, "bin": B, "poc": r["poc"], "vah": r["vah"], "val": r["val"]}
