"""Dopo il movimento: rileva i movimenti forti recenti e descrive cosa li ha accompagnati, senza prevedere nulla.

Rilevamento su candele 15m Binance perp (funzione pura `detect`):
  base = mediana del true range delle 96 candele precedenti (24 ore, esclusa la corrente);
  z    = variazione di chiusura su 4 candele (1 ora) / (base × √4);
  movimento = |z| ≥ K e variazione ≥ MIN_PCT. Le candele vicine dello stesso segno si uniscono; inizio e fine stanno sugli estremi.
Dettaglio a 5m su [inizio − 3h, fine + 3h]: CVD spot e perp in USD (kline ufficiali Binance; multi-exchange solo se la raccolta del
Terminale copriva tutti gli stream), OI aggregato Binance + Bybit + OKX (campioni 30 s, fotografie 5 min o stima 15 min, dichiarata)
e liquidazioni raccolte. Le letture vengono da `read_move`, regole esplicite con soglie dichiarate.
"""
from __future__ import annotations

import logging
import math
import time

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store

log = logging.getLogger("moves")

K = 3.0
MIN_PCT = 0.75
BASE_BARS = 96
RET_BARS = 4
BAR_S = 900
DETAIL_S = 300
PAD_S = 3 * 3600
LOOKBACK_BARS = 1344          # 14 giorni
MAX_EVENTS = 10
OI_MOVE_PCT = 0.5             # soglia per dire che l'OI è salito o sceso
SPOT_SHARE = 0.15             # spot "protagonista" se almeno il 15% del delta perp
STREAM_MIN_SHARE = 0.9
PERP_URL = "https://fapi.binance.com/fapi/v1/klines"
SPOT_URL = "https://api.binance.com/api/v3/klines"


def detect(t: np.ndarray, o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray, *, k: float = K, min_pct: float = MIN_PCT,
           base_bars: int = BASE_BARS, ret_bars: int = RET_BARS) -> list[dict]:
    """Movimenti forti su candele chiuse. Restituisce gli indici di inizio e fine sugli estremi di prezzo."""
    n = len(c)
    if n <= base_bars + ret_bars:
        return []
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    base = pd.Series(tr).shift(1).rolling(base_bars, min_periods=base_bars // 2).median().to_numpy()
    d = np.r_[np.full(ret_bars, np.nan), c[ret_bars:] - c[:-ret_bars]]
    ref = np.r_[np.full(ret_bars, np.nan), c[:-ret_bars]]
    with np.errstate(invalid="ignore", divide="ignore"):
        z = d / (base * math.sqrt(ret_bars))
        ret = d / ref * 100
    flag = (np.abs(z) >= k) & (np.abs(ret) >= min_pct)
    runs: list[list[int]] = []
    for i in np.where(flag)[0]:
        s = 1 if d[i] > 0 else -1
        if runs and runs[-1][2] == s and i - runs[-1][1] <= ret_bars:
            runs[-1][1] = int(i)
        else:
            runs.append([int(i), int(i), s])
    out = []
    for a, b, s in runs:
        lo_i, hi_i = max(a - ret_bars, 0), min(b + 2, n - 1)
        if s > 0:
            i0 = lo_i + int(np.argmin(l[lo_i:a + 1]))
            i1 = i0 + int(np.argmax(h[i0:hi_i + 1]))
            p0, p1 = float(l[i0]), float(h[i1])
        else:
            i0 = lo_i + int(np.argmax(h[lo_i:a + 1]))
            i1 = i0 + int(np.argmin(l[i0:hi_i + 1]))
            p0, p1 = float(h[i0]), float(l[i1])
        out.append({"i0": i0, "i1": i1, "dir": s, "p0": p0, "p1": p1, "ret_pct": (p1 / p0 - 1) * 100, "z": float(np.nanmax(np.abs(z[a:b + 1])))})
    # due movimenti dello stesso segno che si toccano sono uno solo
    merged: list[dict] = []
    for e in out:
        if merged and merged[-1]["dir"] == e["dir"] and e["i0"] <= merged[-1]["i1"] + 1:
            m = merged[-1]
            m["i1"], m["p1"], m["z"] = e["i1"], e["p1"], max(m["z"], e["z"])
            m["ret_pct"] = (m["p1"] / m["p0"] - 1) * 100
        else:
            merged.append(e)
    return merged


def read_move(direction: int, oi_pct: float | None, spot_usd: float | None, perp_usd: float | None,
              liq_long: float | None, liq_short: float | None) -> list[str]:
    """Letture descrittive, nell'ordine in cui vanno mostrate. Nessuna dice cosa succederà dopo."""
    tags: list[str] = []
    oi_down = oi_pct is not None and oi_pct <= -OI_MOVE_PCT
    oi_up = oi_pct is not None and oi_pct >= OI_MOVE_PCT
    if direction > 0:
        if oi_down:
            tags.append("short_squeeze")
        elif oi_up:
            tags.append("new_longs")
    else:
        if oi_down:
            tags.append("long_flush")
        elif oi_up:
            tags.append("new_shorts")
    if spot_usd is not None and perp_usd is not None:
        same = spot_usd * direction > 0
        if same and abs(spot_usd) >= SPOT_SHARE * abs(perp_usd):
            tags.append("spot_buying" if direction > 0 else "spot_selling")
        elif perp_usd * direction > 0:
            tags.append("perp_led")
        elif not same:
            tags.append("spot_against")
    if liq_long is not None and liq_short is not None and liq_long + liq_short > 0:
        hi, lo = max(liq_long, liq_short), min(liq_long, liq_short)
        if hi >= 2 * max(lo, 1.0):
            tags.append("liq_shorts" if liq_short > liq_long else "liq_longs")
    return tags or ["no_reading"]


# ------------------------------------------------------------------ copertura della raccolta

def _sessions() -> list[tuple[float, float]]:
    """Intervalli in cui la raccolta era accesa (sessioni del perpetual Binance salvate dal collector)."""
    try:
        from .. import terminal_collector as tcol
        tcol.start()
        return [(float(a), float(b)) for a, b in (tcol.collector.meta.get("sessions") or {}).get("binance_perp", [])]
    except Exception as e:  # noqa: BLE001
        log.info("sessioni di raccolta non disponibili: %s", e)
        return []


def overlap_share(sessions: list[tuple[float, float]], t0: float, t1: float) -> float:
    """Quota di [t0, t1) coperta dalle sessioni."""
    if t1 <= t0:
        return 0.0
    tot = 0.0
    edge = t0
    for a, b in sorted(sessions):
        a2, b2 = max(a, edge), min(b, t1)
        if b2 > a2:
            tot += b2 - a2
            edge = b2
    return min(1.0, tot / (t1 - t0))


def collection_share(t0: float, t1: float) -> float:
    return overlap_share(_sessions(), t0, t1)


# ------------------------------------------------------------------ dati

def _klines(url: str, interval: str, t0: float, t1: float) -> pd.DataFrame:
    rows, start = [], int(t0) * 1000
    while True:
        part = src._get(url, {"symbol": "BTCUSDT", "interval": interval, "startTime": start, "endTime": int(t1) * 1000 - 1, "limit": 1500})
        rows += part
        if len(part) < 1500:
            break
        start = int(part[-1][0]) + 1
    a = np.array([[float(x) for x in r[:11]] for r in rows]) if rows else np.zeros((0, 11))
    return pd.DataFrame({"t": (a[:, 0] // 1000).astype(np.int64), "o": a[:, 1], "h": a[:, 2], "l": a[:, 3], "c": a[:, 4], "v": a[:, 5], "qv": a[:, 7], "tbq": a[:, 10]})


@util.ttl_cache(60)
def _bars15(end_bucket: int) -> pd.DataFrame:
    now = time.time()
    return _klines(PERP_URL, "15m", now - LOOKBACK_BARS * BAR_S - BASE_BARS * BAR_S, now // BAR_S * BAR_S)


def _oi_grid(t: np.ndarray, t0: float, t1: float) -> tuple[np.ndarray, int]:
    """OI in BTC sulla griglia delle candele e risoluzione peggiore della fonte nel periodo (30, 300 o 900 s)."""
    from ..routers import terminal as tr
    F = tr._frames(t0, t1)
    samples, _ = tr._oi_sources(t0, t1, F)
    if not samples:
        return np.full(len(t), np.nan), 0
    a = np.array([(s[0], s[1], s[3]) for s in samples], dtype=float)
    a = a[np.argsort(a[:, 0])]
    i = np.searchsorted(a[:, 0], t + DETAIL_S, side="right") - 1
    v = np.where(i >= 0, a[np.maximum(i, 0), 1], np.nan)
    return v, int(a[:, 2].max())


def _multi_delta(t: np.ndarray, t0: float, t1: float, px: np.ndarray) -> dict | None:
    """Delta per candela in USD dai trade di tutti gli stream, solo se la raccolta copriva l'intera finestra."""
    from ..routers import terminal as tr
    from .terminal_core import STREAMS
    F = tr._frames(t0, t1)
    tb = F["tb"]
    if not len(tb):
        return None
    per_min = tb.groupby("t")["s"].nunique()
    if (per_min >= len(STREAMS)).sum() < STREAM_MIN_SHARE * (t1 - t0) / 60:
        return None
    G, _ = tr._group_minutes(F)
    out = {}
    for g in ("spot", "perp"):
        sub = G[G["g"] == g]
        bars = (sub["t"].astype(np.int64) // DETAIL_S * DETAIL_S)
        s = sub.groupby(bars)["d"].sum()
        out[g] = s.reindex(t).fillna(0.0).to_numpy(float) * px
    return out


def _liq_rows(t0: float, t1: float) -> pd.DataFrame:
    ev = store.liquidations()
    if ev is None or ev.empty:
        return pd.DataFrame(columns=["t", "side", "usd", "exchange"])
    tt = pd.to_datetime(ev["time"], utc=True).map(lambda x: x.timestamp())
    return ev.assign(t=tt)[(tt >= t0) & (tt < t1)]


@util.ttl_cache(300)
def detail(s0: int, s1: int, direction: int) -> dict:
    """Serie a 5m e statistiche del movimento [s0, s1)."""
    now = time.time()
    v0, v1 = s0 - PAD_S, min(s1 + PAD_S, now // DETAIL_S * DETAIL_S)
    P = _klines(PERP_URL, "5m", v0, v1)
    S = _klines(SPOT_URL, "5m", v0, v1)
    t = P["t"].to_numpy(np.int64)
    px = P["c"].to_numpy(float)
    spot_b = pd.Series((2 * S["tbq"] - S["qv"]).to_numpy(float), index=S["t"]).reindex(t).fillna(0.0).to_numpy(float)
    perp_b = (2 * P["tbq"] - P["qv"]).to_numpy(float)
    scope = "binance"
    try:
        md = _multi_delta(t, v0, v1, px)
        if md:
            spot_b, perp_b, scope = md["spot"], md["perp"], "multi"
    except Exception as e:  # noqa: BLE001
        log.info("delta multi-exchange non disponibile: %s", e)
    win = (t >= s0) & (t < s1)
    start_i = int(np.argmax(t >= s0)) if win.any() else 0
    # CVD azzerato all'inizio del movimento, come nel confronto "da inizio movimento"
    spot_c = np.cumsum(spot_b)
    perp_c = np.cumsum(perp_b)
    base_s = spot_c[start_i - 1] if start_i else 0.0
    base_p = perp_c[start_i - 1] if start_i else 0.0
    spot_c, perp_c = spot_c - base_s, perp_c - base_p
    oi, oi_res = _oi_grid(t, v0, v1 + DETAIL_S)
    last_i = int(np.where(win)[0][-1]) if win.any() else len(t) - 1
    oi0 = oi[start_i - 1] if start_i and not np.isnan(oi[start_i - 1]) else oi[start_i]
    oi1 = oi[last_i]
    oi_btc = float(oi1 - oi0) if not (np.isnan(oi0) or np.isnan(oi1)) else None
    oi_pct = oi_btc / float(oi0) * 100 if oi_btc is not None and oi0 else None
    L = _liq_rows(v0, v1 + DETAIL_S)
    lw = L[(L["t"] >= s0) & (L["t"] < s1)]
    cov = collection_share(s0, s1)
    ll, ls_ = float(lw.loc[lw["side"] == "long", "usd"].sum()), float(lw.loc[lw["side"] == "short", "usd"].sum())
    liq_status = "full" if cov >= 0.9 else "partial" if len(lw) else "none"
    bars_l = np.zeros(len(t))
    bars_s = np.zeros(len(t))
    if len(L):
        idx = np.clip(np.searchsorted(t, L["t"].to_numpy(float), side="right") - 1, 0, len(t) - 1)
        np.add.at(bars_l, idx[(L["side"] == "long").to_numpy()], L.loc[L["side"] == "long", "usd"].to_numpy(float))
        np.add.at(bars_s, idx[(L["side"] == "short").to_numpy()], L.loc[L["side"] == "short", "usd"].to_numpy(float))
    spot_usd = float(spot_b[win].sum()) if win.any() else None
    perp_usd = float(perp_b[win].sum()) if win.any() else None
    known = liq_status == "full"
    tags = read_move(direction, oi_pct, spot_usd, perp_usd, ll if known else None, ls_ if known else None)
    after = None
    if last_i < len(t) - 1:
        after = {"ret_pct": (px[-1] / px[last_i] - 1) * 100, "hours": (int(t[-1]) + DETAIL_S - s1) / 3600,
                 "oi_btc": float(oi[-1] - oi1) if not (np.isnan(oi[-1]) or np.isnan(oi1)) else None}
    return {
        "stats": {"spot_usd": spot_usd, "perp_usd": perp_usd, "oi_btc": oi_btc, "oi_pct": oi_pct, "liq_long": ll, "liq_short": ls_, "liq_status": liq_status,
                  "liq_cov": cov, "cvd_scope": scope, "oi_res": oi_res, "high": float(P["h"][win].max()) if win.any() else None,
                  "low": float(P["l"][win].min()) if win.any() else None, "after": after},
        "tags": tags,
        "series": {"t": t.tolist(), "o": P["o"].tolist(), "h": P["h"].tolist(), "l": P["l"].tolist(), "c": P["c"].tolist(),
                   "spot": spot_c.tolist(), "perp": perp_c.tolist(), "oi": oi.tolist(), "liq_long": bars_l.tolist(), "liq_short": bars_s.tolist()},
    }


@util.ttl_cache(60)
def build() -> dict:
    now = time.time()
    B = _bars15(int(now // BAR_S))
    B = B[B["t"] + BAR_S <= now].reset_index(drop=True)
    ev = detect(B["t"].to_numpy(), B["o"].to_numpy(float), B["h"].to_numpy(float), B["l"].to_numpy(float), B["c"].to_numpy(float))
    t = B["t"].to_numpy(np.int64)
    rows = []
    for e in sorted(ev, key=lambda x: -x["i1"])[:MAX_EVENTS]:
        s0, s1 = int(t[e["i0"]]), int(t[e["i1"]]) + BAR_S
        row = {"id": s0, "from": s0, "to": s1, "dir": e["dir"], "p0": e["p0"], "p1": e["p1"], "ret_pct": e["ret_pct"], "z": e["z"], "minutes": (s1 - s0) // 60}
        try:
            d = detail(s0, s1, e["dir"])
            row.update({"stats": d["stats"], "tags": d["tags"]})
        except Exception as ex:  # noqa: BLE001
            log.warning("dettaglio movimento %s non disponibile: %s", s0, ex)
            row.update({"stats": None, "tags": []})
        rows.append(row)
    return util.clean({"events": rows, "time": now, "scanned_from": int(t[0]) if len(t) else None, "scanned_to": int(t[-1]) + BAR_S if len(t) else None,
                       "rule": {"k": K, "min_pct": MIN_PCT, "base_bars": BASE_BARS, "ret_bars": RET_BARS, "bar_min": BAR_S // 60, "oi_move_pct": OI_MOVE_PCT, "spot_share": SPOT_SHARE}})


def event_detail(eid: int) -> dict | None:
    for e in build()["events"]:
        if e["id"] == eid:
            return util.clean({**e, "series": detail(e["from"], e["to"], e["dir"])["series"]})
    return None


TAG_IT = {"short_squeeze": "squeeze di short (OI in calo con prezzo su)", "new_longs": "leva nuova (OI su con prezzo su)", "long_flush": "long in uscita (OI in calo con prezzo giù)",
          "new_shorts": "short nuovi (OI su con prezzo giù)", "spot_buying": "acquisti spot", "spot_selling": "vendite spot", "perp_led": "guidato dai perpetui",
          "spot_against": "spot in direzione opposta", "liq_shorts": "liquidati soprattutto short", "liq_longs": "liquidati soprattutto long", "no_reading": "nessuna lettura netta"}


def describe_it(e: dict) -> str:
    """Testo per l'agente e per gli avvisi."""
    from . import scoreboard as sb
    s = e.get("stats") or {}
    parts = [f"Movimento {sb.pct(e['ret_pct'])} in {e['minutes']} minuti"]
    if s.get("spot_usd") is not None:
        parts.append(f"spot {sb.usd(s['spot_usd'], True)}, perp {sb.usd(s['perp_usd'], True)}")
    if s.get("oi_btc") is not None:
        parts.append(f"OI {sb.pct(s['oi_pct'])}")
    return ": ".join(parts[:2]) + ("; " + parts[2] if len(parts) > 2 else "") + ". Lettura: " + ", ".join(TAG_IT.get(x, x) for x in e.get("tags") or []) + "."
