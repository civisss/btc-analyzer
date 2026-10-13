"""Holder di breve (STH) e lungo periodo (LTH): prezzo realizzato (costo medio), MVRV, SOPR, quote di supply.

Fonte: BGeometrics (bitcoin-data.com) piano gratuito — dati con 7 giorni di ritardo, storico gratuito di ~4 anni
(finestra mobile: lo storico locale si allunga perché le righe vecchie restano nel parquet), limite 10 richieste/ora.
Dataset registrato: pos_bgeo (time, sth_rp, lth_rp, sth_sopr), ttl 12 h (3 richieste per aggiornamento).
STH-MVRV/LTH-MVRV sono ricalcolati come prezzo / prezzo realizzato (identici a quelli BGeometrics a parità di prezzo),
così la lettura corrente usa il prezzo live sull'ultimo costo medio disponibile.
"""
from __future__ import annotations

import logging
import threading
import time

import httpx
import numpy as np
import pandas as pd

from .. import util
from ..data import store

log = logging.getLogger("holders")

BGEO = "https://bitcoin-data.com/v1"
_client = httpx.Client(timeout=40, headers={"User-Agent": "btc-analyzer/1.0", "Accept": "application/json"})
# endpoint -> colonna (ogni chiamata costa 1 delle 10 richieste orarie gratuite)
ENDPOINTS = {
    "sth-realized-price": "sth_rp",
    "lth-realized-price": "lth_rp",
    "sth-sopr": "sth_sopr",
    # sth-supply / lth-supply: 404 sul piano gratuito (verificato), quindi non richiesti
}
REQUIRED = ("sth_rp", "lth_rp")
_last_attempt: dict[str, float] = {}
_lock = threading.Lock()
RETRY_S = 3600


_blocked_until = 0.0


def _rate_limited(r: httpx.Response) -> None:
    """429: blocca TUTTE le chiamate fino al reset indicato dal server (anche le richieste respinte consumano la quota)."""
    global _blocked_until
    wait = 3600.0
    try:
        reset = int(r.headers.get("X-RateLimit-Reset-Hour", "0"))
        srv = pd.Timestamp(r.headers["Date"]).timestamp()
        if reset > srv:
            wait = reset - srv
    except Exception:  # noqa: BLE001
        pass
    _blocked_until = time.time() + wait + 60
    log.warning("BGeometrics: limite orario raggiunto, nuove richieste tra %.0f min", (wait + 60) / 60)


def _fetch(ep: str, col: str) -> pd.DataFrame | None:
    """Scarica lo storico di un endpoint; None se non disponibile (rate limit, non gratuito, formato inatteso)."""
    with _lock:
        last = _last_attempt.get(ep, 0)
        if time.time() - last < RETRY_S or time.time() < _blocked_until:
            return None
        _last_attempt[ep] = time.time()
    try:
        r = _client.get(f"{BGEO}/{ep}")
        if r.status_code == 429:
            _rate_limited(r)
            return None
        if r.status_code != 200:
            log.warning("BGeometrics %s: HTTP %s", ep, r.status_code)
            return None
        if r.headers.get("X-RateLimit-Remaining-Hour") == "0":
            _rate_limited(r)
        j = r.json()
        if not isinstance(j, list) or not j:
            return None
        key = next((k for k in j[0] if k not in ("d", "unixTs", "delayed", "message")), None)
        if key is None:
            return None
        df = pd.DataFrame(j)
        out = pd.DataFrame({"time": pd.to_datetime(df["d"], utc=True), col: pd.to_numeric(df[key], errors="coerce")})
        with _lock:
            _last_attempt[ep] = 0  # successo: il prossimo tentativo segue solo il TTL del dataset
        return out.dropna().drop_duplicates("time", keep="last")
    except Exception as e:  # noqa: BLE001
        log.warning("BGeometrics %s non disponibile: %s", ep, e)
        return None


def _refresh(old):
    base = None
    if old is not None and len(old):
        base = old.copy()
        base["time"] = pd.to_datetime(base["time"], utc=True)
        base = base.set_index("time")
    got = 0
    for ep, col in ENDPOINTS.items():
        # STH/LTH realized price obbligatori, gli altri solo se c'è budget (prima volta o > 3 giorni dall'ultimo dato)
        new = _fetch(ep, col)
        if new is None:
            continue
        got += 1
        s = new.set_index("time")[col]
        if base is None:
            base = s.to_frame()
        else:
            cur = base[col] if col in base else pd.Series(dtype=float)
            merged = pd.concat([cur.dropna(), s])
            merged = merged[~merged.index.duplicated(keep="last")].sort_index()
            base = base.reindex(base.index.union(merged.index))
            base[col] = merged.reindex(base.index)
    if base is None or not all(c in base for c in REQUIRED):
        raise RuntimeError("BGeometrics: prezzi realizzati STH/LTH non disponibili")
    if got == 0 and old is not None:
        return old
    out = base.sort_index().reset_index().rename(columns={"index": "time"})
    return out


store.register("pos_bgeo", _refresh, 12 * 3600)


# ===================================================================== analisi

def _price() -> pd.Series:
    d = store.get("daily")
    s = d.set_index("time")["close"].astype(float)
    s.index = pd.to_datetime(s.index, utc=True).normalize()
    return s[~s.index.duplicated(keep="last")]


def _pts(s: pd.Series, nd: int = 4) -> list[dict]:
    """Serie giornaliera per i grafici: completa nell'ultimo anno, un punto ogni 2 giorni prima (payload)."""
    s = s.dropna()
    if len(s) > 400:
        cut = s.index[-1] - pd.Timedelta(days=365)
        old, new = s[s.index < cut], s[s.index >= cut]
        s = pd.concat([old.iloc[::-1].iloc[::2].iloc[::-1], new])
    return [{"time": util.ts(t), "value": round(float(v), nd)} for t, v in s.items()]


def _fwd(price: pd.Series, h: int) -> pd.Series:
    return (price.shift(-h) / price - 1) * 100


MVRV_BUCKETS = [(0, 0.9, "< 0.9", "capitolazione"), (0.9, 1.0, "0.9–1.0", "sotto costo"),
                (1.0, 1.2, "1.0–1.2", "neutrale"), (1.2, 1.4, "1.2–1.4", "caldo"), (1.4, 99, "> 1.4", "surriscaldato")]


def _bucket_stats(m: pd.Series, price: pd.Series) -> list[dict]:
    f30, f90 = _fwd(price, 30).reindex(m.index), _fwd(price, 90).reindex(m.index)
    out = []
    for lo, hi, label, name in MVRV_BUCKETS:
        sel = (m >= lo) & (m < hi)
        a, b = f30[sel].dropna(), f90[sel].dropna()
        out.append({"range": label, "label": name, "days": int(sel.sum()),
                    "fwd30_median": float(a.median()) if len(a) >= 5 else None, "fwd30_hit": float((a > 0).mean() * 100) if len(a) >= 5 else None,
                    "fwd90_median": float(b.median()) if len(b) >= 5 else None, "fwd90_hit": float((b > 0).mean() * 100) if len(b) >= 5 else None})
    return out


def _regimes(above: pd.Series) -> list[dict]:
    """Periodi consecutivi sopra/sotto il costo medio STH (ultimi 8)."""
    out = []
    if above.empty:
        return out
    grp = (above != above.shift()).cumsum()
    for _, g in above.groupby(grp):
        out.append({"start": util.ts(g.index[0]), "end": util.ts(g.index[-1]), "above": bool(g.iloc[0]), "days": len(g)})
    return out[-8:]


def _fmt_usd(v) -> str:
    return f"${v:,.0f}"


@util.ttl_cache(300)
def _frame() -> tuple[pd.DataFrame, pd.Series]:
    bg = store.get("pos_bgeo").copy()
    bg["time"] = pd.to_datetime(bg["time"], utc=True).dt.normalize()
    bg = bg.drop_duplicates("time", keep="last").set_index("time").sort_index()
    price = _price()
    df = bg.join(price.rename("price"), how="left")
    df = df[df["sth_rp"].notna() & df["price"].notna()].copy()
    df["sth_mvrv"] = df["price"] / df["sth_rp"]
    df["lth_mvrv"] = df["price"] / df["lth_rp"]
    return df, price


def build(live: float | None = None) -> dict:
    df, price = _frame()
    last_t = df.index[-1]
    px = live or float(price.iloc[-1])
    sth_rp, lth_rp = float(df["sth_rp"].iloc[-1]), float(df["lth_rp"].iloc[-1])
    sth_mvrv_now, lth_mvrv_now = px / sth_rp, px / lth_rp
    m = df["sth_mvrv"]
    mu, sd = float(m.mean()), float(m.std())

    sopr = df["sth_sopr"].dropna() if "sth_sopr" in df else pd.Series(dtype=float)
    sopr7 = sopr.rolling(7).mean()
    supply = None
    if "sth_supply" in df and "lth_supply" in df:
        ss, ls = df["sth_supply"].dropna(), df["lth_supply"].dropna()
        if len(ss) and len(ls):
            s_now, l_now = float(ss.iloc[-1]), float(ls.iloc[-1])
            share = l_now / (s_now + l_now) * 100
            sh = (df["lth_supply"] / (df["sth_supply"] + df["lth_supply"]) * 100).dropna()
            ch30 = share - float(sh.iloc[-31]) if len(sh) > 31 else None
            supply = {"sth": s_now, "lth": l_now, "lth_share": share, "lth_share_change_30d": ch30,
                      "series_lth_share": _pts(sh, 2)}

    above = (df["price"] > df["sth_rp"])
    regs = _regimes(above)
    days_in = regs[-1]["days"] if regs else None
    # costo medio STH: test recenti come supporto/resistenza (minimi/massimi entro ±3% del costo medio)
    near = df[(df["price"] / df["sth_rp"] - 1).abs() < 0.03]
    tests_1y = int((near.index >= last_t - pd.Timedelta(days=365)).sum())

    mmin_t, mmax_t = m.idxmin(), m.idxmax()
    dist_sth = (px / sth_rp - 1) * 100
    dist_lth = (px / lth_rp - 1) * 100
    zone = next((b for b in MVRV_BUCKETS if b[0] <= sth_mvrv_now < b[1]), MVRV_BUCKETS[2])

    bullets = [
        f"Prezzo medio di carico degli holder recenti (STH, monete mosse negli ultimi 155 giorni) a {_fmt_usd(sth_rp)}: "
        f"il prezzo attuale è {abs(dist_sth):.1f}% {'sopra' if dist_sth >= 0 else 'sotto'}"
        + (" — gli acquirenti recenti sono in media in profitto e tendono a difendere quel livello come supporto." if dist_sth >= 0 else
           " — gli acquirenti recenti sono in perdita: il costo medio diventa una resistenza (vendite a pareggio)."),
        f"STH-MVRV {sth_mvrv_now:.2f} (zona {zone[3]}): "
        + ("sotto 1 gli holder recenti vendono in perdita; storicamente le fasi < 0.9 hanno coinciso con capitolazioni e minimi di ciclo." if sth_mvrv_now < 1 else
           "sopra 1.4 il profitto non realizzato degli acquirenti recenti è eccessivo: in passato ha preceduto correzioni." if sth_mvrv_now > 1.4 else
           "in area 1.2–1.4 il mercato si scalda: profitti ampi per chi è entrato di recente." if sth_mvrv_now > 1.2 else
           "profitto moderato per gli holder recenti, nessun eccesso."),
        f"Prezzo medio di carico degli holder di lungo periodo (LTH) a {_fmt_usd(lth_rp)} ({dist_lth:+.1f}% dal prezzo): "
        f"storicamente il supporto estremo dei bear market. LTH-MVRV {lth_mvrv_now:.2f}.",
        f"Nello storico disponibile (dal {util.data_it(df.index[0])}) STH-MVRV ha toccato il minimo di {float(m.min()):.2f} il "
        f"{util.data_it(mmin_t)} e il massimo di {float(m.max()):.2f} il {util.data_it(mmax_t)}.",
    ]
    if len(sopr):
        s7 = float(sopr7.dropna().iloc[-1]) if sopr7.notna().any() else float(sopr.iloc[-1])
        bullets.append(f"SOPR degli holder recenti (media 7g) {s7:.3f}: "
                       + ("le monete spese di recente realizzano perdite, tipico delle fasi di paura." if s7 < 1 else
                          "le monete spese di recente realizzano profitti."))

    return util.clean({
        "price": px, "as_of": util.ts(last_t), "delay_days": int((pd.Timestamp.now(tz="UTC").normalize() - last_t).days),
        "kpi": {
            "sth_realized_price": sth_rp, "lth_realized_price": lth_rp,
            "sth_mvrv": sth_mvrv_now, "lth_mvrv": lth_mvrv_now,
            "sth_mvrv_as_of": float(m.iloc[-1]),
            "dist_sth": dist_sth, "dist_lth": dist_lth,
            "sth_sopr": float(sopr.iloc[-1]) if len(sopr) else None,
            "sth_sopr_7d": float(sopr7.dropna().iloc[-1]) if sopr7.notna().any() else None,
            "lth_share": supply["lth_share"] if supply else None,
            "regime": "above" if px > sth_rp else "below", "regime_days": days_in,
            "zone": zone[3],
        },
        "series": {
            "price": _pts(df["price"], 0), "sth_rp": _pts(df["sth_rp"], 0), "lth_rp": _pts(df["lth_rp"], 0),
            "sth_mvrv": _pts(m, 3), "lth_mvrv": _pts(df["lth_mvrv"], 3),
            "sth_sopr": _pts(sopr7, 4) if len(sopr) else [],
        },
        "bands": {"mean": mu, "sd1_low": mu - sd, "sd1_high": mu + sd, "sd2_low": mu - 2 * sd, "sd2_high": mu + 2 * sd,
                  "levels": [0.9, 1.0, 1.2, 1.4]},
        "extremes": {"min": float(m.min()), "min_time": util.ts(mmin_t), "max": float(m.max()), "max_time": util.ts(mmax_t)},
        "buckets": _bucket_stats(m, price),
        "regimes": regs, "tests_1y": tests_1y, "supply": supply, "bullets": bullets,
        "note": ("Fonte: BGeometrics (bitcoin-data.com), piano gratuito: dati con 7 giorni di ritardo, storico dal "
                 f"{util.data_it(df.index[0])}. STH = monete mosse negli ultimi 155 giorni, LTH = ferme da più di 155 giorni. "
                 "Prezzo realizzato = costo medio di acquisizione (valore all'ultimo movimento on-chain). "
                 "MVRV = prezzo / prezzo realizzato; la lettura corrente usa il prezzo live sull'ultimo costo medio pubblicato. "
                 "SOPR = prezzo di vendita / prezzo di acquisto delle monete spese (media mobile 7 giorni)."),
    })
