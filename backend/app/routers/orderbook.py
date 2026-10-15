"""Order book: heatmap della liquidità (stile Bookmap) e footprint dei trade aggressivi — Binance, dati raccolti in-process.

  GET /api/orderbook/status                       stato del collector, integrità dati (verifiche), storage, CPU
  GET /api/orderbook/heatmap?market&from&to&bucket&range&cols   matrice tempo × prezzo (uint16 base64) + prezzo/trade/eventi
  GET /api/orderbook/footprint?market&tf&from&to&bin&limit      candele con livelli buy/sell, delta, POC, imbalance, CVD
  GET /api/orderbook/signals?market               muri attivi, eventi recenti, squilibrio bid/ask, divergenza delta/CVD
  WS  /api/ws/orderbook?market&bucket&range&tf&bin               colonne nuove della heatmap (1/s) + candela corrente (≤2/s)
Tipi in CONTRACT.md § ORDER BOOK. Lo storico esiste solo da quando l'app è accesa.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from .. import ob_collector as obc
from ..analysis.orderbook_core import BASE_BUCKET, FP_BASE_BIN, encode_u16, footprint_levels, rebucket, rebin
from ..util import clean

router = APIRouter()

BUCKETS = (10, 20, 50, 100, 250)
FP_BINS = (5, 10, 25, 50, 100)
TFS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600}
MAX_ROWS = 900
MAX_CELLS = 2_400_000
IMB_RATIO = 3.0
IMB_MIN_SHARE = 0.01


def _mk(market: str) -> "obc.Market":
    obc.start()
    mk = obc.collector.markets.get(market)
    if mk is None:
        raise HTTPException(404, f"mercato non raccolto: {market}")
    return mk


# ============================================================================ heatmap

def _mem_segment_s(mk: "obc.Market", t0: float, t1: float):
    with mk.lock:
        rows = [s for s in mk.samples if t0 <= s.t < t1]
    if not rows:
        return None
    lo = min(s.lo_idx for s in rows)
    hi = max(s.lo_idx + len(s.arr) for s in rows)
    M = np.full((len(rows), hi - lo), np.nan, np.float32)
    for i, s in enumerate(rows):
        M[i, s.lo_idx - lo: s.lo_idx - lo + len(s.arr)] = s.arr
    metas = [mk.sample_meta(s) for s in rows]
    meta = {c: np.array([np.nan if m.get(c) is None else m[c] for m in metas], np.float64) for c in obc.META_COLS}
    return np.array([s.t for s in rows], np.float64), lo, M, meta


def _mem_segment_m(mk: "obc.Market", t0: float, t1: float):
    with mk.lock:
        rows = [r for r in mk.hm_rows if t0 <= r[0] < t1]
    if not rows:
        return None
    lo = min(r[1] for r in rows)
    hi = max(r[1] + len(r[2]) for r in rows)
    M = np.full((len(rows), hi - lo), np.nan, np.float32)
    for i, r in enumerate(rows):
        M[i, r[1] - lo: r[1] - lo + len(r[2])] = r[2]
    meta = {c: np.array([np.nan if r[3].get(c) is None else r[3][c] for r in rows], np.float64) for c in obc.META_COLS}
    return np.array([r[0] for r in rows], np.float64), lo, M, meta


def _file_list(mk: "obc.Market", tier: str, t0: float, t1: float) -> list[Path]:
    out = []
    if tier == "s":
        h = math.floor(t0 / 3600) * 3600
        while h < t1:
            p = mk.dir / f"hs_{obc._hour(h)}.parquet"
            if p.exists():
                out.append(p)
            h += 3600
    else:
        d = math.floor(t0 / 86400) * 86400
        while d < t1:
            p = mk.dir / f"hm_{obc._day(d)}.parquet"
            if p.exists():
                out.append(p)
            d += 86400
    return out


def _segments(mk: "obc.Market", tier: str, t0: float, t1: float, price: tuple[float, float] | None):
    """Segmenti (t, lo_idx, M, meta) ordinati: file per la parte non in memoria, poi memoria."""
    with mk.lock:
        mem_first = (mk.samples[0].t if mk.samples else None) if tier == "s" else (mk.hm_rows[0][0] if mk.hm_rows else None)
    segs = []
    file_end = min(t1, mem_first) if mem_first is not None else t1
    if file_end > t0:
        for p in _file_list(mk, tier, t0, file_end):
            seg = obc.read_segment(p, price, t0, file_end)
            if seg is not None:
                segs.append(seg)
    mem = (_mem_segment_s if tier == "s" else _mem_segment_m)(mk, max(t0, mem_first or t0), t1)
    if mem is not None:
        segs.append(mem)
    return segs


def _meta_only(mk, tier, t0, t1):
    """Primo passaggio economico: solo mid per stabilire la finestra di prezzo."""
    mids = []
    with mk.lock:
        mem_first = (mk.samples[0].t if mk.samples else None) if tier == "s" else (mk.hm_rows[0][0] if mk.hm_rows else None)
        if tier == "s":
            mids += [s.mid for s in mk.samples if t0 <= s.t < t1]
        else:
            mids += [r[3].get("mid") for r in mk.hm_rows if t0 <= r[0] < t1 and r[3].get("mid")]
    file_end = min(t1, mem_first) if mem_first is not None else t1
    if file_end > t0:
        for p in _file_list(mk, tier, t0, file_end):
            try:
                df = pd.read_parquet(p, columns=["t", "mid"])
                df = df[(df["t"] >= t0) & (df["t"] < file_end)]
                mids += df["mid"].dropna().tolist()
            except Exception:  # noqa: BLE001
                continue
    return mids


def build_heatmap(market: str = "futures", frm: float | None = None, to: float | None = None, bucket: int = 10,
                  range_pct: float = 1.0, cols: int = 1200) -> dict:
    mk = _mk(market)
    now = time.time()
    to = min(float(to or now), now + 1)
    frm = float(frm or to - 3600)
    frm = max(frm, to - 7 * 86400)
    span = max(to - frm, 60.0)
    cols = int(max(30, min(cols, 3000)))
    tier = "s" if span <= 6 * 3600 else "m"
    step = obc.SAMPLE_S if tier == "s" else 60
    cols = int(min(cols, math.ceil(span / step)))
    dt = span / cols
    range_pct = float(max(0.1, min(range_pct, obc.RANGE_PCT)))
    bucket = int(bucket) if int(bucket) in BUCKETS else 10

    mids = _meta_only(mk, tier, frm, to)
    base = {"market": market, "from": frm, "to": to, "tier": tier, "dt": dt, "range_pct": range_pct, "bucket": bucket,
            "collection_start": (obc.collector.meta.get(market) or {}).get("first_start")}
    if not mids:
        return clean({**base, "cols": 0, "rows": 0, "q": "", "scale": 1, "price_lo": None, "t": [], "empty": True})
    plo = min(mids) * (1 - range_pct / 100)
    phi = max(mids) * (1 + range_pct / 100)
    while (phi - plo) / bucket > MAX_ROWS and bucket < BUCKETS[-1]:
        bucket = BUCKETS[BUCKETS.index(bucket) + 1]
    lo_idx = int(math.floor(plo / BASE_BUCKET))
    hi_idx = int(math.floor(phi / BASE_BUCKET)) + 1
    W = hi_idx - lo_idx
    if cols * (W * BASE_BUCKET / bucket) > MAX_CELLS:
        cols = int(MAX_CELLS / (W * BASE_BUCKET / bucket))
        dt = span / cols
    sums = np.zeros((cols, W), np.float64)
    cnts = np.zeros((cols, W), np.float64)
    meta_frames = []
    for t, slo, M, meta in _segments(mk, tier, frm, to, (plo, phi)):
        col = np.floor((t - frm) / dt).astype(np.int64)
        ok = (col >= 0) & (col < cols)
        if not ok.any():
            continue
        t, col, M = t[ok], col[ok], M[ok]
        meta = {c: v[ok] for c, v in meta.items()}
        # sovrapposizione prezzi segmento ↔ finestra globale
        a = max(slo, lo_idx)
        b = min(slo + M.shape[1], hi_idx)
        if b > a:
            sub = M[:, a - slo: b - slo]
            valid = ~np.isnan(sub)
            vals = np.where(valid, sub, 0.0).astype(np.float64)
            starts = np.flatnonzero(np.r_[True, col[1:] != col[:-1]])
            uc = col[starts]
            sums[uc, a - lo_idx: b - lo_idx] += np.add.reduceat(vals, starts, axis=0)
            cnts[uc, a - lo_idx: b - lo_idx] += np.add.reduceat(valid.astype(np.float64), starts, axis=0)
        meta_frames.append(pd.DataFrame({"col": col, "t": t, **meta}))
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(cnts > 0, sums / np.maximum(cnts, 1), np.nan)
    mat, new_lo = rebucket(mean, lo_idx, BASE_BUCKET, bucket)
    b64, scale = encode_u16(mat)
    finite = mat[np.isfinite(mat) & (mat > 0)]
    pcts = {f"p{q}": float(np.percentile(finite, q)) for q in (50, 90, 95, 98, 99, 99.5)} if finite.size else {}

    # meta per colonna
    col_meta = {k: [None] * cols for k in ("mid", "last", "hi", "lo", "vb", "vs", "vwap", "bb", "ba", "imb", "tlo", "thi")}
    if meta_frames:
        mf = pd.concat(meta_frames, ignore_index=True).sort_values("t")
        mf["pv"] = mf["vwap"].fillna(0) * (mf["vb"].fillna(0) + mf["vs"].fillna(0))
        g = mf.groupby("col")
        agg = pd.DataFrame({
            "mid": g["mid"].last(), "last": g["last"].last(), "hi": g["hi"].max(), "lo": g["lo"].min(),
            "vb": g["vb"].sum(), "vs": g["vs"].sum(), "pv": g["pv"].sum(), "bb": g["bb"].last(), "ba": g["ba"].last(),
            "bd": g["bd05"].mean(), "ad": g["ad05"].mean(), "tlo": g["tlo"].last(), "thi": g["thi"].last(),
        })
        vol = agg["vb"] + agg["vs"]
        agg["vwap"] = np.where(vol > 0, agg["pv"] / vol.where(vol > 0, 1), np.nan)
        agg["imb"] = agg["bd"] / (agg["bd"] + agg["ad"])
        for k in col_meta:
            arr = col_meta[k]
            for c, v in agg[k].items():
                arr[int(c)] = None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 4)
    # buchi (colonne senza campioni consecutive)
    has = cnts.sum(axis=1) > 0
    gaps = []
    i = 0
    while i < cols:
        if not has[i]:
            j = i
            while j < cols and not has[j]:
                j += 1
            gaps.append([frm + i * dt, frm + j * dt])
            i = j
        else:
            i += 1
    # eventi dei muri nella finestra
    events = _events(mk, frm, to)
    with mk.lock:
        walls = mk.tracker.active(mk.samples[-1].mid) if mk.samples and to >= now - 5 else []
    return clean({
        **base, "bucket": bucket, "cols": cols, "rows": int(mat.shape[1]), "dt": dt, "price_lo": new_lo * bucket,
        "q": b64, "scale": scale, "pct": pcts,
        "t": [round(frm + (i + 0.5) * dt, 2) for i in range(cols)], **col_meta,
        "gaps": gaps, "events": events, "walls": walls,
        "wall_rule": {"k": mk.tracker.k, "min_qty": mk.tracker.min_qty, "min_age_s": mk.tracker.min_age, "near_pct": mk.tracker.near_pct,
                      "median": mk.tracker.median, "threshold": mk.tracker.threshold},
    })


def _events(mk: "obc.Market", t0: float, t1: float, kinds: tuple[str, ...] = ("pulled", "consumed", "appeared")) -> list[dict]:
    with mk.lock:
        mem = [e for e in mk.events if t0 <= e["t"] < t1 and e["kind"] in kinds]
        first_mem = min((e["t"] for e in mk.events), default=None)
    old = []
    if first_mem is None or t0 < first_mem:
        d = math.floor(t0 / 86400) * 86400
        while d < min(t1, first_mem or t1):
            p = mk.dir / f"ev_{obc._day(d)}.parquet"
            if p.exists():
                try:
                    df = pd.read_parquet(p)
                    df = df[(df["t"] >= t0) & (df["t"] < t1) & df["kind"].isin(kinds)]
                    if first_mem is not None:
                        df = df[df["t"] < first_mem]
                    old += df.to_dict("records")
                except Exception:  # noqa: BLE001
                    pass
            d += 86400
    out = [{k: e.get(k) for k in ("t", "kind", "side", "price", "qmax", "q", "age_s", "dist_pct", "executed")} for e in old + mem]
    return out[-600:]


# ============================================================================ footprint

def _fp_frames(mk: "obc.Market", t0: float, t1: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    with mk.lock:
        mem_first = min(mk.fk) if mk.fk else None
        fp_rows = [(m, p, c[0], c[1]) for m, lv in mk.fp.items() if t0 <= m < t1 for p, c in lv.items()]
        fk_rows = [(m, *v[:9], m not in mk.incomplete) for m, v in mk.fk.items() if t0 <= m < t1]
    fps = [pd.DataFrame(fp_rows, columns=["t", "p", "buy", "sell"])]
    fks = [pd.DataFrame(fk_rows, columns=["t", "o", "h", "l", "c", "buy", "sell", "n", "a0", "a1", "ok"])]
    end = min(t1, mem_first) if mem_first is not None else t1
    d = math.floor(t0 / 86400) * 86400
    while d < end:
        day = obc._day(d)
        for kind, lst in (("fp", fps), ("fk", fks)):
            p = mk.dir / f"{kind}_{day}.parquet"
            if p.exists():
                try:
                    df = pd.read_parquet(p)
                    lst.append(df[(df["t"] >= t0) & (df["t"] < end)])
                except Exception:  # noqa: BLE001
                    pass
        d += 86400
    fp = pd.concat([f for f in fps if len(f)], ignore_index=True) if any(len(f) for f in fps) else fps[0]
    fk = pd.concat([f for f in fks if len(f)], ignore_index=True) if any(len(f) for f in fks) else fks[0]
    return fp, fk.drop_duplicates("t", keep="last").sort_values("t")


def candle_footprint(mk: "obc.Market", t0: int, tf_s: int, bin_size: int) -> dict | None:
    """Footprint di una singola candela (in memoria): usato dal WS per la candela in formazione."""
    with mk.lock:
        mins = [m for m in range(t0, t0 + tf_s, 60) if m in mk.fk]
        if not mins:
            return None
        lv: dict[float, list[float]] = {}
        for m in mins:
            for p, c in mk.fp.get(m, {}).items():
                cur = lv.get(p)
                if cur is None:
                    lv[p] = [c[0], c[1]]
                else:
                    cur[0] += c[0]
                    cur[1] += c[1]
        ks = [mk.fk[m] for m in mins]
        complete = all(m not in mk.incomplete for m in mins)
    lev = footprint_levels(rebin(lv, bin_size), bin_size, IMB_RATIO, IMB_MIN_SHARE)
    return {"t": t0, "o": ks[0][0], "h": max(k[1] for k in ks), "l": min(k[2] for k in ks), "c": ks[-1][3],
            "buy": lev["buy_total"], "sell": lev["sell_total"], "delta": lev["delta"], "poc": lev["poc"], "n": sum(k[6] for k in ks),
            "ok": complete, "p": lev["p"], "lbuy": [round(x, 4) for x in lev["buy"]], "lsell": [round(x, 4) for x in lev["sell"]],
            "imb": lev["imb"], "stacked": lev["stacked"]}


def build_footprint(market: str = "futures", tf: str = "1m", frm: float | None = None, to: float | None = None, bin: int = 10,
                    limit: int = 120) -> dict:
    mk = _mk(market)
    if tf not in TFS:
        raise HTTPException(400, "tf non valido")
    tf_s = TFS[tf]
    bin_size = int(bin) if int(bin) in FP_BINS else 10
    limit = int(max(5, min(limit, 300)))
    now = time.time()
    to = float(to or now)
    to_c = math.floor(to / tf_s) * tf_s + tf_s
    frm_c = math.floor(float(frm) / tf_s) * tf_s if frm else to_c - tf_s * limit
    frm_c = max(frm_c, to_c - tf_s * limit)
    fp, fk = _fp_frames(mk, frm_c, to_c)
    base = {"market": market, "tf": tf, "bin": bin_size, "from": frm_c, "to": to_c, "ratio": IMB_RATIO, "min_share": IMB_MIN_SHARE,
            "collection_start": (obc.collector.meta.get(market) or {}).get("first_start")}
    if fk.empty:
        return clean({**base, "candles": {"t": []}, "levels": {"p": [], "buy": [], "sell": [], "imb": []}, "stacked": [], "empty": True})
    fk = fk.copy()
    fk["ct"] = (fk["t"] // tf_s) * tf_s
    g = fk.groupby("ct", sort=True)
    cand = pd.DataFrame({"o": g["o"].first(), "h": g["h"].max(), "l": g["l"].min(), "c": g["c"].last(), "n": g["n"].sum(),
                         "ok": g["ok"].all(), "mins": g["t"].count()})
    expected = tf_s // 60
    now_c = math.floor(now / tf_s) * tf_s
    cand["ok"] = cand["ok"] & ((cand["mins"] == expected) | (cand.index >= now_c))
    fp = fp.copy()
    fp["ct"] = (fp["t"] // tf_s) * tf_s
    fp["pb"] = np.floor(fp["p"] / bin_size + 1e-9) * bin_size
    lv = fp.groupby(["ct", "pb"], sort=True)[["buy", "sell"]].sum()
    t_out, o, h, l, c, buy, sell, delta, poc, n, ok, off, cnt = ([] for _ in range(13))
    P, B, S, I, stacked = [], [], [], [], []
    for ct, row in cand.iterrows():
        try:
            sub = lv.loc[ct]
        except KeyError:
            sub = pd.DataFrame(columns=["buy", "sell"])
        levels = {float(p): (float(r.buy), float(r.sell)) for p, r in sub.iterrows()}
        res = footprint_levels(levels, bin_size, IMB_RATIO, IMB_MIN_SHARE)
        i = len(t_out)
        t_out.append(int(ct)); o.append(row.o); h.append(row.h); l.append(row.l); c.append(row.c)
        buy.append(round(res["buy_total"], 4)); sell.append(round(res["sell_total"], 4)); delta.append(round(res["delta"], 4))
        poc.append(res["poc"]); n.append(int(row.n)); ok.append(bool(row.ok))
        off.append(len(P)); cnt.append(len(res["p"]))
        P += res["p"]; B += [round(x, 4) for x in res["buy"]]; S += [round(x, 4) for x in res["sell"]]; I += res["imb"]
        stacked += [{**s, "i": i} for s in res["stacked"]]
    cvd = np.cumsum(delta).round(4).tolist()
    return clean({**base, "candles": {"t": t_out, "o": o, "h": h, "l": l, "c": c, "buy": buy, "sell": sell, "delta": delta, "cvd": cvd,
                                      "poc": poc, "n": n, "ok": ok, "off": off, "cnt": cnt},
                  "levels": {"p": P, "buy": B, "sell": S, "imb": I}, "stacked": stacked})


# ============================================================================ signals (anche per l'agente)

def build_signals(market: str = "futures") -> dict:
    mk = _mk(market)
    now = time.time()
    with mk.lock:
        recent = [s for s in mk.samples if s.t >= now - 900]
        last = mk.samples[-1] if mk.samples else None
        walls = mk.tracker.active(last.mid) if last else []
        med, thr = mk.tracker.median, mk.tracker.threshold
        mins = sorted(m for m in mk.fk if m >= now - 3600 and m < now - 60)
        ks = [(m, mk.fk[m]) for m in mins]
    events = [e for e in _events(mk, now - 1800, now + 1) if e["kind"] in ("pulled", "consumed")]
    out: dict = {"market": market, "time": now, "synced": mk.book.synced, "mid": last.mid if last else None,
                 "wall_rule": {"k": mk.tracker.k, "min_qty": mk.tracker.min_qty, "median": med, "threshold": thr, "window_pct": mk.tracker.window_pct},
                 "walls": [w for w in walls if abs(w["dist_pct"]) <= 1.0][:8], "events": events[-40:]}
    # squilibrio bid/ask entro ±0,5% negli ultimi 15 minuti
    if len(recent) >= 120:
        r = np.array([s.bd05 / (s.bd05 + s.ad05) for s in recent if s.bd05 + s.ad05 > 0])
        if len(r):
            out["imbalance"] = {"mean": float(r.mean()), "share_bid": float((r > 0.6).mean()), "share_ask": float((r < 0.4).mean()),
                                "now": float(r[-1]), "minutes": round(len(recent) / 60, 1),
                                "persistent": "bid" if r.mean() > 0.6 and (r > 0.55).mean() > 0.8 else
                                              "ask" if r.mean() < 0.4 and (r < 0.45).mean() > 0.8 else None}
    # delta / CVD dell'ultima ora vs prezzo
    if len(ks) >= 20:
        vol = sum(k[4] + k[5] for _, k in ks)
        cvd = sum(k[4] - k[5] for _, k in ks)
        p0, p1 = ks[0][1][0], ks[-1][1][3]
        chg = (p1 / p0 - 1) * 100 if p0 else 0.0
        div = None
        if abs(chg) >= 0.2 and vol > 0 and abs(cvd) >= 0.1 * vol and (chg > 0) != (cvd > 0):
            div = "price_up_cvd_down" if chg > 0 else "price_down_cvd_up"
        out["cvd"] = {"minutes": len(ks), "price_change_pct": chg, "cvd": cvd, "volume": vol, "cvd_share": cvd / vol if vol else None,
                      "divergence": div}
    return clean(out)


# ============================================================================ status

_cov_cache: dict = {}


def _coverage(mk: "obc.Market") -> list[list[float]]:
    """Intervalli coperti dalla heatmap negli ultimi HM_DAYS giorni (minuti con almeno un campione; buco se > 2 min)."""
    hit = _cov_cache.get(mk.name)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    ts = []
    now = time.time()
    with mk.lock:
        mem = [r[0] for r in mk.hm_rows]
        mem_first = mem[0] if mem else None
    for p in sorted(mk.dir.glob("hm_*.parquet")):
        try:
            t = pd.read_parquet(p, columns=["t"])["t"]
            ts += [x for x in t.tolist() if mem_first is None or x < mem_first]
        except Exception:  # noqa: BLE001
            continue
    ts += mem
    with mk.lock:
        if mk.samples:
            ts.append(math.floor(mk.samples[-1].t / 60) * 60)
    ts = sorted(set(ts))
    segs: list[list[float]] = []
    for t in ts:
        if segs and t - segs[-1][1] <= 120:
            segs[-1][1] = t + 60
        else:
            segs.append([t, t + 60])
    segs = [s for s in segs if s[1] >= now - obc.HM_DAYS * 86400]
    _cov_cache[mk.name] = (time.time(), segs)
    return segs


_size_hist: dict[str, list[tuple[float, int]]] = {}


def _storage(mk: "obc.Market") -> dict:
    by: dict[str, dict[str, int]] = {}
    for f in mk.dir.glob("*.parquet"):
        kind, stamp = f.stem.split("_", 1)
        by.setdefault(kind, {})
        by[kind][stamp[:8]] = by[kind].get(stamp[:8], 0) + f.stat().st_size
    total = sum(sum(v.values()) for v in by.values())
    # MB/giorno — campioni 1 s: byte delle ore salvate (hs + hsm, ultime 48) / ore di campioni × 24;
    # altri file (medie al minuto, footprint, candele, eventi; riscritti per giorno): crescita misurata del loro totale
    import pyarrow.parquet as pq
    cur_h = obc._hour(time.time())
    hsm = sorted(mk.dir.glob("hsm_*.parquet"))[-48:]
    full = [f for f in hsm if f.stem[4:] != cur_h] or hsm
    hours_cov, hs_bytes = 0.0, 0
    for f in full:
        try:
            hours_cov += pq.read_metadata(f).num_rows * obc.SAMPLE_S / 3600
            hs_bytes += f.stat().st_size + (mk.dir / f"hs_{f.stem[4:]}.parquet").stat().st_size
        except Exception:  # noqa: BLE001
            pass
    other = sum(sum(v.values()) for k, v in by.items() if k not in ("hs", "hsm"))
    now = time.time()
    hist = _size_hist.setdefault(mk.name, [])
    hist.append((now, other))
    del hist[:-500]
    old = next(((t0, b0) for t0, b0 in hist if now - t0 <= 6 * 3600 and now - t0 >= 1800), None)
    other_rate = (other - old[1]) / (now - old[0]) * 86400 / 1e6 if old and other >= old[1] else None
    per_day = {"hs": hs_bytes / hours_cov * 24 / 1e6 if hours_cov > 0.05 else None, "other": other_rate}
    est = (per_day["hs"] or 0) + (per_day["other"] or 0)
    return {"total_mb": round(total / 1e6, 2), "mb_per_day": round(est, 2) if est else None,
            "hs_mb_per_day": per_day["hs"], "other_mb_per_day": per_day["other"], "hours_measured": round(hours_cov, 2),
            "files": sum(len(v) for v in by.values()),
            "by_kind_mb": {k: round(sum(v.values()) / 1e6, 2) for k, v in by.items()}}


def _rss_mb() -> float | None:
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            k32 = ctypes.WinDLL("kernel32")
            k32.GetCurrentProcess.restype = ctypes.c_void_p
            k32.K32GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(PMC), wintypes.DWORD]
            k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
            return pmc.WorkingSetSize / 1e6
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS"):
                    return int(line.split()[1]) / 1e3
    except Exception:  # noqa: BLE001
        return None
    return None


def _mem_est_mb(mk: "obc.Market") -> float:
    with mk.lock:
        samp = sum(s.arr.nbytes + 400 for s in mk.samples)
        hm = sum(r[2].nbytes + 600 for r in mk.hm_rows)
        fp = sum(len(v) for v in mk.fp.values()) * 150 + len(mk.fk) * 300
    book = (len(mk.book.bids) + len(mk.book.asks)) * 110
    return round((samp + hm + fp + book) / 1e6, 1)


def _pstats(vals: list[float]) -> dict:
    if not vals:
        return {"n": 0}
    a = np.abs(np.array(vals, np.float64))
    return {"n": len(a), "median_abs": float(np.median(a)), "p95_abs": float(np.percentile(a, 95)), "max_abs": float(a.max()),
            "within_05": float((a < 0.5).mean())}


def build_status() -> dict:
    obc.start()
    out: dict = {"markets": {}, "time": time.time(), "enabled": obc.ENABLED, "cpu": obc.collector.cpu, "rss_mb": _rss_mb(),
                 "config": {"range_pct": obc.RANGE_PCT, "sample_s": obc.SAMPLE_S, "base_bucket": BASE_BUCKET, "fp_base_bin": FP_BASE_BIN,
                            "buckets": list(BUCKETS), "fp_bins": list(FP_BINS), "retention_days": {"hs": obc.HS_DAYS, "hm": obc.HM_DAYS, "fp": obc.FP_DAYS},
                            "imb_ratio": IMB_RATIO, "imb_min_share": IMB_MIN_SHARE, "debug": obc.DEBUG}}
    for name, mk in obc.collector.markets.items():
        with mk.lock:
            last = mk.samples[-1] if mk.samples else None
            n_samples = len(mk.samples)
        vers = list(mk.verifications)
        kc = list(mk.kline_checks.values())
        lat = sorted(mk.latency_ms)
        meta = obc.collector.meta.get(name) or {}
        out["markets"][name] = {
            "depth_connected": mk.depth_connected, "trade_connected": mk.trade_connected, "synced": mk.book.synced,
            "last_update_id": mk.book.last_u, "levels": {"bids": len(mk.book.bids), "asks": len(mk.book.asks)},
            "best_bid": last.bb if last else None, "best_ask": last.ba if last else None, "mid": last.mid if last else None,
            "last_sample": last.t if last else None, "samples_mem": n_samples,
            "trusted": [mk.book.snap_lo, mk.book.snap_hi],
            "trusted_pct": [((mk.book.snap_lo / last.mid - 1) * 100) if last and mk.book.snap_lo else None,
                            ((mk.book.snap_hi / last.mid - 1) * 100) if last and mk.book.snap_hi else None],
            "msgs": {"depth": mk.depth_msgs, "trades": mk.trade_msgs}, "latency_ms_p50": lat[len(lat) // 2] if lat else None,
            "snapshots": mk.snapshots, "disconnects": mk.disconnects, "book_gaps": mk.book.gaps,
            "resyncs": {"n": len(mk.resyncs), "last": list(mk.resyncs)[-8:]},
            "verify": {
                "n": len(vers), "ok": sum(1 for v in vers if v["range_mismatch"] == 0 and v["top_mismatch"] == 0 and v["best_match"]),
                "top_mismatch": sum(v["top_mismatch"] for v in vers), "range_mismatch": sum(v["range_mismatch"] for v in vers),
                "levels_compared": sum(v["range_levels"] for v in vers), "diff_only_levels": sum(v.get("diff_only", 0) for v in vers),
                "new_zone_levels": sum(v.get("new_zone_levels", 0) for v in vers), "new_zone_mismatch": sum(v.get("new_zone_mismatch", 0) for v in vers),
                "every_s": mk.cfg["verify_s"], "last": vers[-1] if vers else None,
            },
            "kline_check": {**_pstats([x["diff_pct"] for x in kc if x["diff_pct"] is not None]),
                            "buy": _pstats([x["buy_diff_pct"] for x in kc if x["buy_diff_pct"] is not None]),
                            "last": sorted(kc, key=lambda x: x["t"])[-5:], "every_s": obc.KLINE_CHECK_S},
            "backfills": list(mk.backfills)[-5:], "incomplete_minutes": len(mk.incomplete),
            "collection_start": meta.get("first_start"), "sessions": (meta.get("sessions") or [])[-20:],
            "coverage": _coverage(mk), "storage": _storage(mk), "mem_est_mb": _mem_est_mb(mk),
            "flush_ms_p50": sorted(mk.flush_ms)[len(mk.flush_ms) // 2] if mk.flush_ms else None,
        }
    return clean(out)


# ============================================================================ endpoints

@router.get("/orderbook/status")
def orderbook_status():
    return build_status()


@router.get("/orderbook/heatmap")
def orderbook_heatmap(market: str = "futures", frm: float | None = Query(None, alias="from"), to: float | None = None,
                      bucket: int = 10, range: float = 1.0, cols: int = 1200):  # noqa: A002
    return build_heatmap(market, frm, to, bucket, range, cols)


@router.get("/orderbook/footprint")
def orderbook_footprint(market: str = "futures", tf: str = "1m", frm: float | None = Query(None, alias="from"), to: float | None = None,
                        bin: int = 10, limit: int = 120):  # noqa: A002
    return build_footprint(market, tf, frm, to, bin, limit)


@router.get("/orderbook/signals")
def orderbook_signals(market: str = "futures"):
    return build_signals(market)


@router.post("/orderbook/debug/{action}")
def orderbook_debug(action: str, market: str = "futures"):
    """Solo con ORDERBOOK_DEBUG=1: simula disconnessioni ('depth', 'trades') o un buco negli update id ('gap')."""
    if not obc.DEBUG:
        raise HTTPException(404, "non disponibile")
    mk = _mk(market)
    if action == "gap":
        mk.drop_next_depth = True
    elif action in ("depth", "trades"):
        mk.force_close.add(action)
    elif action == "flush":
        obc.collector.flush()
    else:
        raise HTTPException(400, "azione sconosciuta")
    return {"ok": True, "action": action, "market": market}


# ============================================================================ WebSocket live

def _live_cols(mk: "obc.Market", since: float, bucket: int, range_pct: float) -> tuple[list[dict], float]:
    with mk.lock:
        new = []
        for s in reversed(mk.samples):
            if s.t <= since:
                break
            new.append(s)
    new.reverse()
    out = []
    k = max(1, int(bucket // BASE_BUCKET))
    for s in new[-10:]:
        lo_p = s.mid * (1 - range_pct / 100)
        hi_p = s.mid * (1 + range_pct / 100)
        a = max(0, int(math.floor(lo_p / BASE_BUCKET)) - s.lo_idx)
        b = min(len(s.arr), int(math.floor(hi_p / BASE_BUCKET)) - s.lo_idx + 1)
        arr = s.arr[a:b].astype(np.float64)
        lo_idx = s.lo_idx + a
        nlo = (lo_idx // k) * k
        arr = np.pad(arr, (lo_idx - nlo, (-(len(arr) + lo_idx - nlo)) % k))
        arr = arr.reshape(-1, k).sum(axis=1)
        e = s.extra or {}
        out.append({"t": s.t, "mid": round(s.mid, 2), "bb": s.bb, "ba": s.ba, "last": e.get("last"), "hi": e.get("hi"), "lo": e.get("lo"),
                     "vb": e.get("vb"), "vs": e.get("vs"), "vwap": e.get("vwap"),
                     "imb": (s.bd05 / (s.bd05 + s.ad05)) if s.bd05 + s.ad05 > 0 else None, "tlo": s.tlo, "thi": s.thi,
                     "plo": nlo * BASE_BUCKET, "q": [round(float(x), 3) for x in arr]})
    return out, (new[-1].t if new else since)


@router.websocket("/ws/orderbook")
async def orderbook_ws(ws: WebSocket):
    await ws.accept()
    obc.start()
    qp = ws.query_params
    st = {"market": qp.get("market") or "futures", "bucket": int(qp.get("bucket") or 10), "range": float(qp.get("range") or 1.0),
          "tf": qp.get("tf") or "1m", "bin": int(qp.get("bin") or 10)}
    since = time.time() - 1.5
    last_fp_sig = None
    last_fp_sent = 0.0
    last_ev_t = time.time()

    async def reader():
        while True:
            data = json.loads(await ws.receive_text())
            for k in ("market", "bucket", "range", "tf", "bin"):
                if k in data:
                    st[k] = data[k]

    rtask = asyncio.create_task(reader())
    try:
        while True:
            await asyncio.sleep(0.33)
            if rtask.done():
                break
            mk = obc.collector.markets.get(str(st["market"]))
            if mk is None:
                continue
            msg: dict = {"type": "ob_live", "market": mk.name, "time": time.time(),
                         "status": {"synced": mk.book.synced, "depth": mk.depth_connected, "trades": mk.trade_connected}}
            cols, since = _live_cols(mk, since, int(st["bucket"]), float(st["range"]))
            if cols:
                msg["cols"] = cols
            with mk.lock:
                evs = [e for e in mk.events if e["t"] > last_ev_t and e["kind"] in ("pulled", "consumed", "appeared")]
            if evs:
                last_ev_t = evs[-1]["t"]
                msg["events"] = [{k: e.get(k) for k in ("t", "kind", "side", "price", "qmax", "q", "age_s", "dist_pct", "executed")} for e in evs]
            now = time.time()
            if now - last_fp_sent >= 0.5 and st["tf"] in TFS:
                tf_s = TFS[st["tf"]]
                t0 = int(now // tf_s * tf_s)
                with mk.lock:
                    sig = (t0, st["bin"], sum(mk.fk[m][6] for m in range(t0, t0 + tf_s, 60) if m in mk.fk))
                if sig != last_fp_sig:
                    fp = await asyncio.to_thread(candle_footprint, mk, t0, tf_s, int(st["bin"]))
                    if fp:
                        msg["fp"] = {**fp, "tf": st["tf"], "bin": int(st["bin"])}
                        last_fp_sig = sig
                        last_fp_sent = now
            if "cols" in msg or "fp" in msg or "events" in msg:
                await ws.send_text(json.dumps(clean(msg)))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        rtask.cancel()
