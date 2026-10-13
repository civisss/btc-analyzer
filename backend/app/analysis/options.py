"""Opzioni BTC su Deribit: open interest per strike, max pain, put/call, skew 25Δ, struttura a termine IV, DVOL, gamma.

Dataset registrati qui (cache parquet via store):
  pos_dvol           DVOL giornaliero (Deribit volatility index, 2021→): time, open, high, low, close
  pos_opt_daily      snapshot giornaliero del posizionamento opzioni (accumula da oggi in poi)
  pos_maxpain_snap   max pain per scadenza, una riga per (giorno, scadenza) — serve a misurare il prezzo verso il max pain
"""
from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timezone

import httpx
import numpy as np
import pandas as pd

from .. import util
from ..data import store

log = logging.getLogger("options")

DERIBIT = "https://www.deribit.com/api/v2/public"
_client = httpx.Client(timeout=30, headers={"User-Agent": "btc-analyzer/1.0"})
MONTHS = {m: i + 1 for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}
DAY_S = 86400
YEAR_S = 365 * DAY_S


def _get(path: str, params: dict | None = None, retries: int = 3):
    for attempt in range(retries):
        try:
            r = _client.get(f"{DERIBIT}/{path}", params=params)
            if r.status_code == 429:
                time.sleep(1 + attempt * 2)
                continue
            r.raise_for_status()
            return r.json()["result"]
        except httpx.HTTPError:
            if attempt == retries - 1:
                raise
            time.sleep(0.5 + attempt)
    raise RuntimeError(f"Deribit: GET fallita {path}")


# ===================================================================== catena opzioni

def _parse_name(name: str):
    """BTC-13OCT26-73000-C -> (expiry unix s [08:00 UTC], strike, 'C'|'P')."""
    try:
        _, d, k, t = name.split("-")
        day, mon, yr = int(d[:-5]), MONTHS[d[-5:-2]], 2000 + int(d[-2:])
        exp = int(datetime(yr, mon, day, 8, tzinfo=timezone.utc).timestamp())
        return exp, float(k), t
    except Exception:  # noqa: BLE001
        return None


@util.ttl_cache(45)
def chain() -> tuple[pd.DataFrame, float, float]:
    """(catena opzioni, indice BTC/USD Deribit, istante del dato)."""
    rows = _get("get_book_summary_by_currency", {"currency": "BTC", "kind": "option"})
    recs = []
    for r in rows:
        p = _parse_name(r.get("instrument_name", ""))
        if not p:
            continue
        recs.append({
            "expiry": p[0], "strike": p[1], "type": p[2],
            "oi": float(r.get("open_interest") or 0.0), "vol": float(r.get("volume") or 0.0),
            "vol_usd": float(r.get("volume_usd") or 0.0),
            "iv": util.num(r.get("mark_iv")), "fwd": util.num(r.get("underlying_price")),
            "mark": util.num(r.get("mark_price")),
        })
    df = pd.DataFrame(recs)
    now = time.time()
    df = df[df["expiry"] > now].reset_index(drop=True)
    try:
        idx = float(_get("get_index_price", {"index_name": "btc_usd"})["index_price"])
    except Exception:  # noqa: BLE001
        idx = float(df["fwd"].dropna().iloc[0])
    return df, idx, now


# ===================================================================== Black-76

def _ncdf(x):
    return 0.5 * (1.0 + _erf(np.asarray(x, dtype=float) / math.sqrt(2.0)))


_erf = np.vectorize(math.erf, otypes=[float])


def _d1(F, K, sig, T):
    sig = np.maximum(np.asarray(sig, dtype=float), 1e-4)
    return (np.log(F / K) + 0.5 * sig * sig * T) / (sig * np.sqrt(T))


def _delta(F, K, sig, T, call: bool):
    d = _ncdf(_d1(F, K, sig, T))
    return d if call else d - 1.0


def _gamma(F, K, sig, T):
    sig = np.maximum(np.asarray(sig, dtype=float), 1e-4)
    d1 = _d1(F, K, sig, T)
    return np.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi) / (F * sig * np.sqrt(T))


# ===================================================================== per-scadenza

def _kind(exp: int) -> str:
    d = pd.Timestamp(exp, unit="s", tz="UTC")
    if d.weekday() != 4:
        return "giornaliera"
    last_fri = (d + pd.Timedelta(days=7)).month != d.month
    if last_fri:
        return "trimestrale" if d.month in (3, 6, 9, 12) else "mensile"
    return "settimanale"


KIND_ORDER = {"giornaliera": 0, "settimanale": 1, "mensile": 2, "trimestrale": 3}


def max_pain(g: pd.DataFrame) -> tuple[float | None, list[dict]]:
    """Strike che minimizza il valore intrinseco totale pagato ai detentori (call + put) alla scadenza."""
    c = g[(g["type"] == "C") & (g["oi"] > 0)]
    p = g[(g["type"] == "P") & (g["oi"] > 0)]
    if c.empty and p.empty:
        return None, []
    S = np.sort(g["strike"].unique())
    pay_c = (np.maximum(S[:, None] - c["strike"].to_numpy()[None, :], 0) * c["oi"].to_numpy()[None, :]).sum(1)
    pay_p = (np.maximum(p["strike"].to_numpy()[None, :] - S[:, None], 0) * p["oi"].to_numpy()[None, :]).sum(1)
    tot = pay_c + pay_p
    i = int(np.argmin(tot))
    curve = [{"strike": float(s), "payout": float(v)} for s, v in zip(S, tot)]
    return float(S[i]), curve


def _smile(g: pd.DataFrame, T: float):
    """Smile OTM (put sotto il forward, call sopra) con delta Black-76 calcolato dal mark IV di ciascuno strike."""
    F = float(g["fwd"].median())
    q = g[(g["iv"].notna()) & (g["iv"] > 1)]
    puts = q[(q["type"] == "P") & (q["strike"] <= F)].sort_values("strike")
    calls = q[(q["type"] == "C") & (q["strike"] >= F)].sort_values("strike")
    pts = pd.concat([puts, calls]).drop_duplicates("strike").sort_values("strike")
    if len(pts) < 4:
        return None
    K = pts["strike"].to_numpy()
    iv = pts["iv"].to_numpy() / 100
    lm = np.log(K / F)
    atm = float(np.interp(0.0, lm, iv)) * 100 if lm.min() <= 0 <= lm.max() else None
    out = {"F": F, "atm": atm, "k": K, "iv": iv * 100, "put25": None, "call25": None}
    if len(calls) >= 2:
        dc = _delta(F, calls["strike"].to_numpy(), calls["iv"].to_numpy() / 100, T, True)
        o = np.argsort(dc)
        if dc.min() <= 0.25 <= dc.max():
            out["call25"] = float(np.interp(0.25, dc[o], calls["iv"].to_numpy()[o]))
    if len(puts) >= 2:
        dp = _delta(F, puts["strike"].to_numpy(), puts["iv"].to_numpy() / 100, T, False)
        o = np.argsort(dp)
        if dp.min() <= -0.25 <= dp.max():
            out["put25"] = float(np.interp(-0.25, dp[o], puts["iv"].to_numpy()[o]))
    return out


def _expiry_table(df: pd.DataFrame, idx: float, now: float) -> list[dict]:
    out = []
    for exp, g in df.groupby("expiry"):
        T = max((exp - now) / YEAR_S, 1 / (365 * 24))
        mp, _ = max_pain(g)
        oc, op = float(g.loc[g["type"] == "C", "oi"].sum()), float(g.loc[g["type"] == "P", "oi"].sum())
        vc, vp = float(g.loc[g["type"] == "C", "vol"].sum()), float(g.loc[g["type"] == "P", "vol"].sum())
        sm = _smile(g, T) if (exp - now) > DAY_S else None
        skew = sm["put25"] - sm["call25"] if sm and sm["put25"] is not None and sm["call25"] is not None else None
        out.append({
            "expiry": int(exp), "days": (exp - now) / DAY_S, "kind": _kind(int(exp)),
            "max_pain": mp, "max_pain_dist": (mp / idx - 1) * 100 if mp else None,
            "oi_calls": oc, "oi_puts": op, "oi_btc": oc + op, "notional_usd": (oc + op) * idx,
            "pc_oi": op / oc if oc else None, "pc_vol": vp / vc if vc else None,
            "forward": float(g["fwd"].median()), "atm_iv": sm["atm"] if sm else None,
            "iv_put25": sm["put25"] if sm else None, "iv_call25": sm["call25"] if sm else None, "skew_25d": skew,
        })
    return sorted(out, key=lambda r: r["expiry"])


def _const_maturity(rows: list[dict], key: str, days: float):
    pts = [(r["days"], r[key]) for r in rows if r[key] is not None and r["days"] > 1]
    if not pts:
        return None
    x = np.array([p[0] for p in pts])
    y = np.array([p[1] for p in pts])
    if days < x.min() or days > x.max():
        return float(y[np.argmin(np.abs(x - days))]) if abs(x[np.argmin(np.abs(x - days))] - days) < days * 0.5 else None
    return float(np.interp(days, x, y))


def _strike_profile(g: pd.DataFrame, idx: float, lo: float, hi: float) -> list[dict]:
    g = g[(g["strike"] >= lo) & (g["strike"] <= hi)]
    piv = g.pivot_table(index="strike", columns="type", values="oi", aggfunc="sum").fillna(0.0)
    out = []
    for k, r in piv.iterrows():
        c, p = float(r.get("C", 0.0)), float(r.get("P", 0.0))
        if c + p <= 0:
            continue
        out.append({"strike": float(k), "calls": c, "puts": p, "calls_usd": c * idx, "puts_usd": p * idx})
    return out


def _gamma_profile(df: pd.DataFrame, idx: float, now: float) -> list[dict]:
    """Gamma in dollari per un movimento dell'1% (Γ·OI·S²·1%), lordo, per strike — chi è lungo/corto non è noto."""
    q = df[(df["oi"] > 0) & df["iv"].notna() & (df["iv"] > 1)].copy()
    T = np.maximum((q["expiry"].to_numpy() - now) / YEAR_S, 1 / (365 * 24))
    gam = _gamma(q["fwd"].to_numpy(), q["strike"].to_numpy(), q["iv"].to_numpy() / 100, T)
    q["gex"] = gam * q["oi"].to_numpy() * idx * idx * 0.01
    q = q[(q["strike"] >= idx * 0.8) & (q["strike"] <= idx * 1.2)]
    piv = q.pivot_table(index="strike", columns="type", values="gex", aggfunc="sum").fillna(0.0)
    return [{"strike": float(k), "calls": float(r.get("C", 0.0)), "puts": float(r.get("P", 0.0)),
             "total": float(r.get("C", 0.0) + r.get("P", 0.0))} for k, r in piv.iterrows()]


# ===================================================================== DVOL

DVOL_START = int(datetime(2021, 3, 24, tzinfo=timezone.utc).timestamp() * 1000)


def _dvol_fetch(start_ms: int, end_ms: int, res: str = "86400") -> pd.DataFrame:
    rows = []
    s = start_ms
    step = 900 * 86_400_000 if res == "86400" else 900 * 3_600_000
    while s < end_ms:
        e = min(end_ms, s + step)
        r = _get("get_volatility_index_data", {"currency": "BTC", "start_timestamp": s, "end_timestamp": e, "resolution": res})
        rows.extend(r.get("data") or [])
        s = e + 1
    if not rows:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close"])
    d = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close"])
    d["time"] = pd.to_datetime(d["t"].astype("int64"), unit="ms", utc=True)
    return d[["time", "open", "high", "low", "close"]].drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)


def _dvol_refresh(old):
    now = int(time.time() * 1000)
    if old is not None and len(old) > 5:
        start = int(pd.Timestamp(old["time"].iloc[-3]).timestamp() * 1000)
        new = _dvol_fetch(start, now)
        o = old.copy()
        o["time"] = pd.to_datetime(o["time"], utc=True)
        return pd.concat([o, new]).drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)
    return _dvol_fetch(DVOL_START, now)


@util.ttl_cache(60)
def dvol_live() -> float | None:
    now = int(time.time() * 1000)
    try:
        r = _get("get_volatility_index_data", {"currency": "BTC", "start_timestamp": now - 3 * 3_600_000, "end_timestamp": now, "resolution": "60"})
        d = r.get("data") or []
        return float(d[-1][4]) if d else None
    except Exception:  # noqa: BLE001
        return None


# ===================================================================== snapshot giornalieri

def _today() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC").normalize()


def _replace_today(old, new: pd.DataFrame) -> pd.DataFrame:
    if old is None or old.empty:
        return new
    o = old.copy()
    o["time"] = pd.to_datetime(o["time"], utc=True)
    o = o[o["time"] != new["time"].iloc[0]]
    return pd.concat([o, new]).sort_values("time").reset_index(drop=True)


def _snap_daily(old):
    s = summary()
    row = {k: s.get(k) for k in ("index", "pc_oi", "pc_vol", "oi_usd", "skew_7d", "skew_30d", "skew_90d",
                                 "atm_7d", "atm_30d", "atm_90d", "dvol")}
    row["time"] = _today()
    return _replace_today(old, pd.DataFrame([row]))


def _snap_maxpain(old):
    df, idx, now = chain()
    rows = []
    for r in _expiry_table(df, idx, now):
        if r["max_pain"] is None or r["days"] > 120:
            continue
        rows.append({"time": _today(), "expiry": r["expiry"], "max_pain": r["max_pain"], "spot": idx,
                     "oi_btc": r["oi_btc"], "pc_oi": r["pc_oi"]})
    return _replace_today(old, pd.DataFrame(rows))


store.register("pos_dvol", _dvol_refresh, 3600)
store.register("pos_opt_daily", _snap_daily, 3600)
store.register("pos_maxpain_snap", _snap_maxpain, 3600)


@util.ttl_cache(6 * 3600)
def _delivery_prices() -> dict[str, float]:
    """Prezzi di regolamento giornalieri Deribit (08:00 UTC), ultimi ~120 giorni."""
    r = _get("get_delivery_prices", {"index_name": "btc_usd", "count": 120})
    return {x["date"]: float(x["delivery_price"]) for x in r.get("data") or []}


def _expiry_history() -> dict:
    """Comportamento del prezzo verso il max pain sulle scadenze già passate (dagli snapshot raccolti)."""
    try:
        snap = store.get("pos_maxpain_snap")
    except Exception:  # noqa: BLE001
        snap = None
    if snap is None or snap.empty:
        return {"since": None, "rows": [], "n": 0, "converged_pct": None, "median_abs_gap": None}
    snap = snap.copy()
    snap["time"] = pd.to_datetime(snap["time"], utc=True)
    since = util.ts(snap["time"].min())
    now = time.time()
    past = sorted(e for e in snap["expiry"].unique() if e < now)
    rows = []
    try:
        dp = _delivery_prices() if past else {}
    except Exception:  # noqa: BLE001
        dp = {}
    for e in past:
        g = snap[snap["expiry"] == e].sort_values("time")
        settle = dp.get(pd.Timestamp(int(e), unit="s", tz="UTC").strftime("%Y-%m-%d"))
        if settle is None:
            continue
        target = pd.Timestamp(int(e) - 7 * DAY_S, unit="s", tz="UTC")
        h = g.iloc[(g["time"] - target).abs().argsort().iloc[0]]
        lead = (int(e) - util.ts(h["time"])) / DAY_S
        mp, spot0 = float(h["max_pain"]), float(h["spot"])
        rows.append({"expiry": int(e), "lead_days": lead, "max_pain": mp, "spot_before": spot0, "settlement": settle,
                     "gap_before": (spot0 / mp - 1) * 100, "gap_settle": (settle / mp - 1) * 100,
                     "converged": abs(settle - mp) < abs(spot0 - mp), "oi_btc": float(h["oi_btc"])})
    n = len(rows)
    conv = sum(r["converged"] for r in rows)
    return {"since": since, "rows": rows[-20:], "n": n, "converged_pct": conv / n * 100 if n else None,
            "median_abs_gap": float(np.median([abs(r["gap_settle"]) for r in rows])) if n else None}


# ===================================================================== build

@util.ttl_cache(45)
def summary() -> dict:
    """Numeri chiave (usati anche dagli snapshot e dal sentiment)."""
    df, idx, now = chain()
    rows = _expiry_table(df, idx, now)
    oc, op = float(df.loc[df["type"] == "C", "oi"].sum()), float(df.loc[df["type"] == "P", "oi"].sum())
    vc, vp = float(df.loc[df["type"] == "C", "vol"].sum()), float(df.loc[df["type"] == "P", "vol"].sum())
    out = {"index": idx, "pc_oi": op / oc if oc else None, "pc_vol": vp / vc if vc else None,
           "oi_btc": oc + op, "oi_usd": (oc + op) * idx, "oi_calls": oc, "oi_puts": op,
           "vol_calls": vc, "vol_puts": vp, "vol_usd": float(df["vol"].sum()) * idx, "dvol": dvol_live(), "rows": rows}
    for d in (7, 30, 90):
        out[f"skew_{d}d"] = _const_maturity(rows, "skew_25d", d)
        out[f"atm_{d}d"] = _const_maturity(rows, "atm_iv", d)
    return out


def _rv(days: int) -> float | None:
    d = store.get("k_1d")
    r = np.log(d["close"]).diff().dropna().tail(days)
    return float(r.std() * math.sqrt(365) * 100) if len(r) > 5 else None


def _pct_rank(hist: pd.Series, v: float | None) -> float | None:
    if v is None or hist.empty:
        return None
    return float((hist <= v).mean() * 100)


def _fmt_usd(v: float) -> str:
    return f"${v:,.0f}"


def _fmt_big(v: float) -> str:
    a = abs(v)
    return f"${a / 1e9:.2f}B" if a >= 1e9 else f"${a / 1e6:.0f}M"


def _interpret(s: dict, table: list[dict], walls: list[dict], dv: dict, idx: float) -> list[dict]:
    out = []
    nxt = next((r for r in table if r["days"] > 0.3), table[0] if table else None)
    big = max((r for r in table if r["kind"] in ("mensile", "trimestrale")), key=lambda r: r["notional_usd"], default=None)
    if nxt and nxt["max_pain"]:
        dist = nxt["max_pain_dist"]
        out.append({"tone": "neutral", "text": (
            f"Prossima scadenza {util.data_it(nxt['expiry'], False)} ({_fmt_big(nxt['notional_usd'])} di OI): max pain a "
            f"{_fmt_usd(nxt['max_pain'])}, {abs(dist):.1f}% {'sopra' if dist > 0 else 'sotto'} il prezzo. "
            "L'attrazione verso il max pain è tipicamente debole e conta soprattutto nelle ultime ore prima della scadenza.")})
    if big and big is not nxt and big["max_pain"]:
        out.append({"tone": "neutral", "text": (
            f"Scadenza {big['kind']} del {util.data_it(big['expiry'], False)}: {_fmt_big(big['notional_usd'])} di OI, max pain "
            f"{_fmt_usd(big['max_pain'])} ({big['max_pain_dist']:+.1f}% dal prezzo), put/call {big['pc_oi']:.2f}.")})
    pc = s["pc_oi"]
    if pc is not None:
        tone = "bearish" if pc > 0.9 else "bullish" if pc < 0.5 else "neutral"
        out.append({"tone": tone, "text": (
            f"Put/call sull'open interest {pc:.2f}: "
            + ("posizionamento difensivo, molte coperture al ribasso." if pc > 0.9 else
               "netta prevalenza di call, posizionamento rialzista (in eccesso diventa segnale contrarian)." if pc < 0.5 else
               "equilibrio tra call e put nella norma per BTC (storicamente 0.5–0.8).")
        )})
    sk = s["skew_30d"]
    if sk is not None:
        tone = "bearish" if sk > 4 else "bullish" if sk < -2 else "neutral"
        out.append({"tone": tone, "text": (
            f"Skew 25Δ a 30 giorni {sk:+.1f} punti di volatilità: "
            + ("le put costano più delle call, il mercato paga per proteggersi (paura; in eccesso è contrarian rialzista)." if sk > 4 else
               "le call costano più delle put: domanda di esposizione al rialzo (euforia se estremo)." if sk < -2 else
               "prezzi di put e call bilanciati, nessuna paura evidente.")
        )})
    if dv.get("current") is not None and dv.get("pct_1y") is not None:
        p = dv["pct_1y"]
        out.append({"tone": "neutral", "text": (
            f"DVOL {dv['current']:.1f}: {p:.0f}° percentile dell'ultimo anno. "
            + ("Volatilità implicita bassa: opzioni economiche, spesso precede movimenti ampi." if p < 20 else
               "Volatilità implicita elevata: mercato teso, opzioni care." if p > 80 else "Volatilità implicita nella norma.")
            + (f" Volatilità realizzata 30g {dv['rv_30d']:.1f}%." if dv.get("rv_30d") else ""))})
    if walls:
        w = walls[0]
        out.append({"tone": "neutral", "text": (
            f"Muro gamma principale a {_fmt_usd(w['strike'])} ({(w['strike'] / idx - 1) * 100:+.1f}%): concentrazione di gamma che può "
            "frenare o 'calamitare' il prezzo vicino alla scadenza, a seconda di come sono posizionati i dealer.")})
    return out


@util.ttl_cache(45)
def build() -> dict:
    df, idx, now = chain()
    s = summary()
    table = s["rows"]
    # tabella max pain: prossime 6 scadenze + mensili/trimestrali successive (max 10 righe)
    sel = table[:6] + [r for r in table[6:] if r["kind"] in ("mensile", "trimestrale")]
    sel = sel[:10]

    lo, hi = idx * 0.5, idx * 1.6
    agg = _strike_profile(df, idx, lo, hi)
    per_exp = []
    for r in sel[:6]:
        g = df[df["expiry"] == r["expiry"]]
        per_exp.append({"expiry": r["expiry"], "kind": r["kind"], "max_pain": r["max_pain"],
                        "strikes": _strike_profile(g, idx, lo, hi)})

    gp = _gamma_profile(df, idx, now)
    walls = sorted(gp, key=lambda r: -r["total"])[:5]
    oi_walls = sorted([r for r in agg if idx * 0.85 <= r["strike"] <= idx * 1.15], key=lambda r: -(r["calls"] + r["puts"]))[:6]

    # smile per 3 scadenze rappresentative (~7, ~30, ~90 giorni)
    smiles = []
    used = set()
    for target in (7, 30, 90):
        cands = [r for r in table if r["days"] > 1.5 and r["expiry"] not in used]
        if not cands:
            continue
        r = min(cands, key=lambda x: abs(x["days"] - target))
        used.add(r["expiry"])
        g = df[df["expiry"] == r["expiry"]]
        sm = _smile(g, max((r["expiry"] - now) / YEAR_S, 1e-3))
        if not sm:
            continue
        m = (sm["k"] / sm["F"] >= 0.6) & (sm["k"] / sm["F"] <= 1.6)
        smiles.append({"expiry": r["expiry"], "days": r["days"], "forward": sm["F"], "atm_iv": sm["atm"],
                       "points": [{"strike": float(k), "moneyness": float(k / sm["F"] * 100), "iv": float(v)}
                                  for k, v in zip(sm["k"][m], sm["iv"][m])]})

    # DVOL
    dv = {"current": s["dvol"], "series": [], "pct_1y": None, "pct_all": None, "rv_30d": _rv(30), "iv_rv_spread": None,
          "min_1y": None, "max_1y": None, "change_7d": None}
    try:
        dvol = store.get("pos_dvol")
        ser = dvol.set_index("time")["close"].dropna()
        cur = dv["current"] if dv["current"] is not None else float(ser.iloc[-1])
        dv["current"] = cur
        last1y = ser[ser.index >= ser.index[-1] - pd.Timedelta(days=365)]
        dv.update(pct_1y=_pct_rank(last1y, cur), pct_all=_pct_rank(ser, cur), min_1y=float(last1y.min()), max_1y=float(last1y.max()),
                  series=[{"time": util.ts(t), "value": round(float(v), 2)} for t, v in ser.items()])
        if len(ser) > 8:
            dv["change_7d"] = cur - float(ser.iloc[-8])
        if dv["rv_30d"] is not None:
            dv["iv_rv_spread"] = cur - dv["rv_30d"]
    except Exception as e:  # noqa: BLE001
        log.warning("DVOL non disponibile: %s", e)

    term = [{"expiry": r["expiry"], "days": r["days"], "atm_iv": r["atm_iv"], "skew_25d": r["skew_25d"],
             "iv_put25": r["iv_put25"], "iv_call25": r["iv_call25"]} for r in table if r["days"] > 1 and r["atm_iv"] is not None]

    nxt = next((r for r in table if r["days"] > 0.3), None)
    hist = _expiry_history()
    return util.clean({
        "index_price": idx, "updated_at": int(now),
        "kpi": {
            "oi_usd": s["oi_usd"], "oi_btc": s["oi_btc"], "pc_oi": s["pc_oi"], "pc_vol": s["pc_vol"], "volume_usd_24h": s["vol_usd"],
            "next_expiry": nxt["expiry"] if nxt else None, "next_max_pain": nxt["max_pain"] if nxt else None,
            "next_max_pain_dist": nxt["max_pain_dist"] if nxt else None, "next_notional_usd": nxt["notional_usd"] if nxt else None,
            "skew_7d": s["skew_7d"], "skew_30d": s["skew_30d"], "skew_90d": s["skew_90d"],
            "atm_7d": s["atm_7d"], "atm_30d": s["atm_30d"], "atm_90d": s["atm_90d"], "dvol": dv["current"],
        },
        "expiries": [{k: r[k] for k in ("expiry", "days", "kind", "max_pain", "max_pain_dist", "oi_calls", "oi_puts", "oi_btc",
                                         "notional_usd", "pc_oi", "pc_vol", "atm_iv", "skew_25d")} for r in sel],
        "oi_by_strike": {"all": agg, "by_expiry": per_exp},
        "gamma": {"profile": gp, "walls": walls, "oi_walls": oi_walls},
        "term_structure": term, "smiles": smiles, "dvol": dv, "expiry_history": hist,
        "signals": _interpret(s, sel, walls, dv, idx),
        "note": ("Fonte: Deribit (API pubblica), circa l'85–90% dell'open interest globale sulle opzioni BTC. OI in BTC (1 contratto = 1 BTC), "
                 "nozionale = OI × indice. Max pain = strike che minimizza il valore intrinseco totale pagato a chi detiene call e put alla scadenza. "
                 "Skew 25Δ = IV put 25Δ − IV call 25Δ (positivo = put più care), delta Black-76 calcolati dal mark IV di ogni strike, "
                 "interpolati a scadenza costante 7/30/90 giorni. Gamma = Γ·OI·S²·1% (dollari di delta per un movimento dell'1%), lordo: "
                 "il segno delle posizioni dei dealer non è pubblico."),
    })
