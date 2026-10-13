"""Basis annualizzato e struttura a termine dei futures BTC.

- Curva live: tutte le scadenze Deribit (mark vs indice) + trimestrali Binance USDⓈ-M e COIN-M (mark vs indice dell'exchange).
- Storico: Binance trimestrali (continuousKlines CURRENT_QUARTER / NEXT_QUARTER, giornaliero) contro il proprio indice
  (indexPriceKlines): COIN-M dal 27 giu 2020, USDⓈ-M dal 3 feb 2021.
  Ogni giorno si calcola il basis annualizzato DEL SINGOLO CONTRATTO (giorni alla sua scadenza: ultimo venerdì di
  mar/giu/set/dic alle 08:00 UTC); la serie continua usa il trimestrale corrente finché mancano almeno 14 giorni alla
  scadenza, poi il successivo: i giorni di cambio (roll) sono marcati e non producono salti artificiali.
- Annualizzazione semplice: ann = (F / S − 1) × 365 / giorni — la stessa convenzione dell'`annualizedBasisRate`
  pubblicato da Binance (/futures/data/basis), che si usa come controllo incrociato.
- Contratti con meno di 7 giorni alla scadenza: annualizzato marcato come rumoroso (escluso da curva e confronti).
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store

log = logging.getLogger("basis")

DERIBIT = "https://www.deribit.com/api/v2/public"
BIN_F = "https://fapi.binance.com"
BIN_D = "https://dapi.binance.com"
ROLL_DAYS = 14
NOISY_DAYS = 7
CM_DAYS = 90
SERIES_START = {"coinm": "2020-06-27", "usdm": "2021-02-03"}  # COIN-M: prima del 26 giu 2020 l'etichetta CURRENT_QUARTER era il settembre


# ------------------------------------------------------------------ calendario scadenze trimestrali

def _last_friday(y: int, m: int) -> datetime:
    d = datetime(y + (m == 12), (m % 12) + 1, 1, 8, tzinfo=timezone.utc) - timedelta(days=1)
    while d.weekday() != 4:
        d -= timedelta(days=1)
    return d.replace(hour=8, minute=0, second=0, microsecond=0)


def quarter_expiries(y0: int = 2019, y1: int | None = None) -> list[pd.Timestamp]:
    y1 = y1 or datetime.now(timezone.utc).year + 2
    return [pd.Timestamp(_last_friday(y, m)) for y in range(y0, y1 + 1) for m in (3, 6, 9, 12)]


_EXP = None


def _expiries() -> np.ndarray:
    global _EXP
    if _EXP is None:
        _EXP = np.array([e.value for e in quarter_expiries()], dtype=np.int64)
    return _EXP


def expiry_after(t: pd.Series, k: int = 0) -> pd.Series:
    """k-esima scadenza trimestrale strettamente successiva a t (0 = corrente, 1 = successiva)."""
    exp = _expiries()
    tv = pd.to_datetime(t, utc=True).astype("datetime64[ns, UTC]").astype("int64").to_numpy()
    idx = np.searchsorted(exp, tv, side="right") + k
    return pd.Series(pd.to_datetime(exp[np.minimum(idx, len(exp) - 1)], utc=True), index=t.index)


# ------------------------------------------------------------------ storico Binance

def _klines(url: str, params: dict, start_ms: int) -> pd.DataFrame:
    rows = []
    start = start_ms
    now = int(time.time() * 1000)
    while start < now:
        batch = src._get(url, {**params, "interval": "1d", "startTime": start, "limit": 1500 if "fapi" in url else 1000})
        if not batch:
            break
        rows.extend(batch)
        nxt = int(batch[-1][0]) + 86_400_000
        if nxt <= start:
            break
        start = nxt
    if not rows:
        return pd.DataFrame(columns=["time", "close", "close_time", "volume"])
    df = pd.DataFrame(rows)
    return pd.DataFrame({
        "time": pd.to_datetime(df[0].astype("int64"), unit="ms", utc=True),
        "close": df[4].astype(float),
        "volume": df[5].astype(float),
        "close_time": pd.to_datetime(df[6].astype("int64"), unit="ms", utc=True),
    }).drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)


def _binq(base: str, prefix: str, pair: str):
    def fn(old):
        start = int(pd.Timestamp(SERIES_START["coinm" if "dapi" in base else "usdm"], tz="UTC").timestamp() * 1000) - 30 * 86_400_000
        if old is not None and not old.empty:
            start = int(pd.Timestamp(old["time"].iloc[-1]).timestamp() * 1000) - 3 * 86_400_000
        cq = _klines(f"{base}/{prefix}/v1/continuousKlines", {"pair": pair, "contractType": "CURRENT_QUARTER"}, start)
        nq = _klines(f"{base}/{prefix}/v1/continuousKlines", {"pair": pair, "contractType": "NEXT_QUARTER"}, start)
        ix = _klines(f"{base}/{prefix}/v1/indexPriceKlines", {"pair": pair}, start)
        # contratto non quotato (es. USDⓈ-M 2021 senza NEXT_QUARTER): Binance restituisce candele piatte a volume 0 -> scartate
        cq = cq[cq["volume"] > 0]
        nq = nq[nq["volume"] > 0]
        df = ix[["time", "close", "close_time"]].rename(columns={"close": "index"}) \
            .merge(cq[["time", "close", "volume"]].rename(columns={"close": "cq", "volume": "cq_vol"}), on="time", how="left") \
            .merge(nq[["time", "close", "volume"]].rename(columns={"close": "nq", "volume": "nq_vol"}), on="time", how="left")
        df["time"] = df["time"].astype("datetime64[ns, UTC]")
        df["close_time"] = df["close_time"].astype("datetime64[ns, UTC]")
        if old is None or old.empty:
            return df.reset_index(drop=True)
        o = old.copy()
        o["time"] = pd.to_datetime(o["time"], utc=True).astype("datetime64[ns, UTC]")
        o["close_time"] = pd.to_datetime(o["close_time"], utc=True).astype("datetime64[ns, UTC]")
        return pd.concat([o, df]).drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)
    return fn


store.register("basis_coinm_1d", _binq(BIN_D, "dapi", "BTCUSD"), 3600)
store.register("basis_usdm_1d", _binq(BIN_F, "fapi", "BTCUSDT"), 3600)


def stitched(df: pd.DataFrame, start: str) -> pd.DataFrame:
    """Basis annualizzato per contratto + serie continua con roll a 14 giorni dalla scadenza."""
    d = df[df["time"] >= pd.Timestamp(start, tz="UTC")].dropna(subset=["index"]).copy()
    if d.empty:
        return d
    tc = d["close_time"]
    d["exp_cq"], d["exp_nq"] = expiry_after(tc, 0), expiry_after(tc, 1)
    d["days_cq"] = (d["exp_cq"] - tc).dt.total_seconds() / 86400
    d["days_nq"] = (d["exp_nq"] - tc).dt.total_seconds() / 86400
    d["ann_cq"] = (d["cq"] / d["index"] - 1) * 365 / d["days_cq"] * 100
    d["ann_nq"] = (d["nq"] / d["index"] - 1) * 365 / d["days_nq"] * 100
    use_nq = (d["days_cq"] < ROLL_DAYS) & d["nq"].notna()
    d["ann"] = np.where(use_nq, d["ann_nq"], np.where(d["days_cq"] >= NOISY_DAYS, d["ann_cq"], np.nan))
    d["contract"] = np.where(use_nq, d["exp_nq"].astype("int64"), d["exp_cq"].astype("int64"))
    d["roll"] = d["contract"].ne(d["contract"].shift()) & d["contract"].shift().notna()
    d.loc[d.index[0], "roll"] = False
    # scadenza costante 90 g: interpolazione lineare tra corrente e successivo (nessun gradino ai roll)
    w = (d["days_nq"] - CM_DAYS) / (d["days_nq"] - d["days_cq"])
    interp = w * d["ann_cq"] + (1 - w) * d["ann_nq"]
    cq_ok = d["days_cq"] >= NOISY_DAYS
    d["cm90"] = np.where(d["nq"].notna() & cq_ok, interp, np.where(d["nq"].notna(), d["ann_nq"], np.where(cq_ok, d["ann_cq"], np.nan)))
    return d.reset_index(drop=True)


# ------------------------------------------------------------------ curva live

@util.ttl_cache(3600)
def _deribit_instruments() -> dict:
    r = src._get(f"{DERIBIT}/get_instruments", {"currency": "BTC", "kind": "future"})["result"]
    return {x["instrument_name"]: x for x in r}


@util.ttl_cache(3600)
def _binance_quarterlies() -> list[tuple[str, str, int]]:
    """[(venue, symbol, deliveryDate ms)] dei trimestrali BTC attivi su USDⓈ-M e COIN-M."""
    out = []
    for venue, base, path, pair in (("binance_usdm", BIN_F, "/fapi/v1/exchangeInfo", "BTCUSDT"), ("binance_coinm", BIN_D, "/dapi/v1/exchangeInfo", "BTCUSD")):
        for s in src._get(f"{base}{path}")["symbols"]:
            if s.get("pair") == pair and s.get("contractType") in ("CURRENT_QUARTER", "NEXT_QUARTER") and s.get("contractStatus", s.get("status")) in (None, "TRADING"):
                out.append((venue, s["symbol"], int(s["deliveryDate"])))
    return out


@util.ttl_cache(20)
def curve() -> dict:
    now = time.time()
    rows: list[dict] = []
    perps: dict = {}
    index_price = None
    try:
        inst = _deribit_instruments()
        for x in src._get(f"{DERIBIT}/get_book_summary_by_currency", {"currency": "BTC", "kind": "future"})["result"]:
            name = x["instrument_name"]
            mark, idx = float(x.get("mark_price") or 0), float(x.get("estimated_delivery_price") or 0)
            if mark <= 0 or idx <= 0:
                continue
            index_price = index_price or idx
            if name == "BTC-PERPETUAL":
                perps["deribit"] = {"mark": mark, "index": idx, "premium_pct": (mark / idx - 1) * 100,
                                    "funding_8h": util.num((x.get("funding_8h") or 0) * 100), "oi_usd": x.get("open_interest")}
                continue
            exp = inst.get(name, {}).get("expiration_timestamp")
            if not exp:
                continue
            days = (exp / 1000 - now) / 86400
            if days <= 0:
                continue
            b = (mark / idx - 1) * 100
            rows.append({"venue": "deribit", "instrument": name, "expiry": int(exp / 1000), "days": days, "mark": mark, "index": idx,
                         "basis_pct": b, "annualized_pct": b * 365 / days, "oi_usd": float(x.get("open_interest") or 0), "noisy": days < NOISY_DAYS})
    except Exception as e:  # noqa: BLE001
        log.warning("curva Deribit non disponibile: %s", e)
    try:
        q = _binance_quarterlies()
        for venue, base, path in (("binance_usdm", BIN_F, "/fapi/v1/premiumIndex"), ("binance_coinm", BIN_D, "/dapi/v1/premiumIndex")):
            prem = src._get(f"{base}{path}")
            pm = {p["symbol"]: p for p in prem}
            for v, sym, deliv in q:
                if v != venue or sym not in pm:
                    continue
                p = pm[sym]
                mark, idx = float(p["markPrice"]), float(p["indexPrice"])
                days = (deliv / 1000 - now) / 86400
                if days <= 0 or idx <= 0:
                    continue
                b = (mark / idx - 1) * 100
                rows.append({"venue": venue, "instrument": sym, "expiry": int(deliv / 1000), "days": days, "mark": mark, "index": idx,
                             "basis_pct": b, "annualized_pct": b * 365 / days, "oi_usd": None, "noisy": days < NOISY_DAYS})
            perp_sym = "BTCUSDT" if venue == "binance_usdm" else "BTCUSD_PERP"
            if perp_sym in pm:
                p = pm[perp_sym]
                mark, idx = float(p["markPrice"]), float(p["indexPrice"])
                perps[venue] = {"mark": mark, "index": idx, "premium_pct": (mark / idx - 1) * 100,
                                "funding_8h": float(p.get("lastFundingRate") or 0) * 100, "oi_usd": None}
    except Exception as e:  # noqa: BLE001
        log.warning("trimestrali Binance non disponibili: %s", e)
    rows.sort(key=lambda r: (r["expiry"], r["venue"]))
    return {"rows": rows, "perps": perps, "index_price": index_price, "time": int(now)}


# ------------------------------------------------------------------ snapshot Deribit giornaliero (accumulo)

def _deribit_snap(old):
    c = curve()
    rows = [{"time": pd.Timestamp.now(tz="UTC").normalize(), "instrument": r["instrument"], "expiry": r["expiry"], "days": r["days"],
             "annualized_pct": r["annualized_pct"], "basis_pct": r["basis_pct"]} for r in c["rows"] if r["venue"] == "deribit"]
    new = pd.DataFrame(rows)
    if new.empty:
        return old if old is not None else pd.DataFrame(columns=["time"])
    new["time"] = new["time"].astype("datetime64[ns, UTC]")
    if old is None or old.empty:
        return new
    o = old.copy()
    o["time"] = pd.to_datetime(o["time"], utc=True).astype("datetime64[ns, UTC]")
    o = o[o["time"] != new["time"].iloc[0]]
    return pd.concat([o, new]).sort_values(["time", "expiry"]).reset_index(drop=True)


store.register("basis_deribit_snap", _deribit_snap, 1800)


def _cm90(snap: pd.DataFrame) -> list[dict]:
    """Basis Deribit a scadenza costante 90 giorni (interpolazione lineare tra le due scadenze adiacenti, ≥7 g)."""
    out = []
    if snap is None or snap.empty:
        return out
    for t, g in snap.groupby("time"):
        g = g[g["days"] >= NOISY_DAYS].sort_values("days")
        if len(g) < 2 or g["days"].min() > 90 or g["days"].max() < 90:
            continue
        out.append({"time": util.ts(t), "value": float(np.interp(90, g["days"], g["annualized_pct"]))})
    return out


# ------------------------------------------------------------------ build

def _official_binance() -> dict | None:
    """Controllo incrociato: annualizedBasisRate pubblicato da Binance (USDⓈ-M, trimestrale corrente, ultimo giorno)."""
    try:
        r = src._get(f"{BIN_F}/futures/data/basis", {"pair": "BTCUSDT", "contractType": "CURRENT_QUARTER", "period": "1d", "limit": 5})
        return r[-1] if r else None
    except Exception as e:  # noqa: BLE001
        log.warning("basis ufficiale Binance non disponibile: %s", e)
        return None


def _hist(name: str, start: str) -> tuple[pd.DataFrame, list[dict], list[dict], list[int]]:
    """(frame, serie scadenza costante 90 g, serie per contratto con roll, giorni di roll)."""
    try:
        d = stitched(store.get(name), start)
    except Exception as e:  # noqa: BLE001
        log.warning("storico %s non disponibile: %s", name, e)
        return pd.DataFrame(), [], [], []
    if d.empty:
        return d, [], [], []
    ok = d[d["ann"].notna()]
    cm = d[d["cm90"].notna()]
    return d, util.series_pts(cm["time"], cm["cm90"]), util.series_pts(ok["time"], ok["ann"]), [util.ts(t) for t in d.loc[d["roll"], "time"]]


def _live_cm90(rows: list[dict], venue: str) -> float | None:
    """Basis live a scadenza costante 90 g dai trimestrali dell'exchange (stessa regola dello storico)."""
    q = sorted([r for r in rows if r["venue"] == venue], key=lambda r: r["days"])
    if len(q) < 2:
        return None
    cq, nq = q[0], q[1]
    if cq["days"] < NOISY_DAYS:
        return nq["annualized_pct"]
    w = (nq["days"] - CM_DAYS) / (nq["days"] - cq["days"])
    return w * cq["annualized_pct"] + (1 - w) * nq["annualized_pct"]


def _pctl(vals: np.ndarray, x: float) -> float | None:
    vals = vals[np.isfinite(vals)]
    return float((vals < x).mean() * 100) if len(vals) and np.isfinite(x) else None


def _signals(cur, pctl, shape, slope, perp, pairs, avg30) -> list[dict]:
    out = []

    def add(t, tone):
        out.append({"text": t, "tone": tone})

    if cur is not None:
        if cur >= 20:
            add(f"Basis annualizzato a 90 giorni {cur:.1f}%: carry molto alto, domanda di leva long euforica (tipico dei massimi di ciclo).", "bearish")
        elif cur >= 10:
            add(f"Basis annualizzato a 90 giorni {cur:.1f}%: carry elevato, gli speculatori pagano caro per stare long a termine.", "neutral")
        elif cur >= 4:
            add(f"Basis annualizzato a 90 giorni {cur:.1f}%: carry nella norma, il cash-and-carry rende quanto un tasso privo di rischio o poco più.", "neutral")
        elif cur >= 0:
            add(f"Basis annualizzato a 90 giorni {cur:.1f}%: carry basso, poca domanda di leva rialzista (fasi di sfiducia o di accumulo).", "bullish")
        else:
            add(f"Futures in backwardation ({cur:.1f}% annuo): rara pressione ribassista sui derivati, storicamente vicina ai minimi.", "bullish")
        if pctl is not None:
            add(f"Il basis a 90 giorni è al {pctl:.0f}° percentile dello storico Binance COIN-M dal 2020.", "neutral")
    if avg30 is not None and cur is not None and abs(cur - avg30) >= 2:
        add(f"Basis {'in salita' if cur > avg30 else 'in calo'} rispetto alla media 30 g ({avg30:.1f}%): {'la leva istituzionale si sta riaccendendo' if cur > avg30 else 'il carry si sta comprimendo'}.", "neutral")
    if shape == "contango" and slope is not None:
        if slope <= -0.5:
            add(f"Curva in contango (tutti i future sopra l'indice) con annualizzato decrescente ({slope:+.1f} punti da breve a lungo): la domanda di leva è concentrata sulle scadenze brevi.", "neutral")
        elif slope >= 0.5:
            add(f"Curva in contango con annualizzato crescente ({slope:+.1f} punti da breve a lungo): il mercato paga di più per l'esposizione lunga, attese rialziste sul medio termine.", "neutral")
        else:
            add(f"Curva in contango con carry uniforme sulle scadenze ({slope:+.1f} punti da breve a lungo): struttura ordinata, nessuno stress.", "neutral")
    elif shape == "backwardation":
        add("Curva in backwardation: i future quotano sotto l'indice, segnale di stress o di forte domanda di copertura ribassista.", "bullish")
    elif shape == "mixed":
        add("Curva mista: alcune scadenze sopra e altre sotto l'indice, nessuna direzione di carry chiara.", "neutral")
    p = (perp or {}).get("binance_usdm")
    if p:
        add(f"Premium del perpetuo Binance {p['premium_pct']:+.3f}% sull'indice (funding {p['funding_8h']:.4f}%/8h).", "neutral")
    if pairs:
        d = max(abs(x["diff_pp"]) for x in pairs if x.get("diff_pp") is not None) if any(x.get("diff_pp") is not None for x in pairs) else None
        if d is not None and d > 1.5:
            add(f"Deribit e Binance divergono fino a {d:.1f} punti di basis annualizzato sulla stessa scadenza: possibile arbitraggio o indici diversi (USD vs USDT).", "neutral")
    return out


@util.ttl_cache(30)
def build() -> dict:
    c = curve()
    rows = c["rows"]
    der = [r for r in rows if r["venue"] == "deribit" and not r["noisy"]]
    shape, slope = None, None
    if len(der) >= 3:
        a = np.array([r["annualized_pct"] for r in der])
        slope = float(a[-1] - a[0])
        # forma in PREZZO: contango = tutti i future sopra l'indice, backwardation = tutti sotto; la pendenza
        # dell'annualizzato (breve -> lungo) descrive dove si concentra il carry
        b = np.array([r["basis_pct"] for r in der])
        shape = "contango" if (b > 0).all() else "backwardation" if (b < 0).all() else "mixed"
    # confronto stessa scadenza Deribit vs Binance
    pairs = []
    for r in rows:
        if r["venue"] != "deribit" or r["noisy"]:
            continue
        same = {x["venue"]: x for x in rows if x["venue"] != "deribit" and abs(x["expiry"] - r["expiry"]) < 3600}
        if same:
            bu, bc = same.get("binance_usdm"), same.get("binance_coinm")
            ref = bu or bc
            pairs.append({"expiry": r["expiry"], "deribit_pct": r["annualized_pct"], "binance_usdm_pct": bu["annualized_pct"] if bu else None,
                          "binance_coinm_pct": bc["annualized_pct"] if bc else None, "diff_pp": r["annualized_pct"] - ref["annualized_pct"]})
    # storico
    dc, coinm, coinm_c, rolls_c = _hist("basis_coinm_1d", SERIES_START["coinm"])
    du, usdm, usdm_c, rolls_u = _hist("basis_usdm_1d", SERIES_START["usdm"])
    agreement = None
    if not dc.empty and not du.empty:
        m = dc[["time", "cm90"]].merge(du[["time", "cm90"]], on="time", suffixes=("_c", "_u")).dropna()
        if len(m) > 30:
            recent = m[m["time"] >= m["time"].iloc[-1] - pd.Timedelta(days=365)]
            agreement = {"n": int(len(m)), "mean_abs_diff_pp": float((m["cm90_c"] - m["cm90_u"]).abs().mean()),
                         "mean_abs_diff_1y_pp": float((recent["cm90_c"] - recent["cm90_u"]).abs().mean()),
                         "corr": float(np.corrcoef(m["cm90_c"], m["cm90_u"])[0, 1])}
    # salti ai roll: variazione giornaliera mediana nei giorni di roll vs gli altri giorni (serie per contratto e 90 g)
    roll_check = None
    if not dc.empty:
        jc, jm = dc["ann"].diff().abs(), dc["cm90"].diff().abs()
        roll_check = {"n_rolls": int(dc["roll"].sum()),
                      "contract_roll_pp": float(jc[dc["roll"]].median()), "contract_other_pp": float(jc[~dc["roll"]].median()),
                      "cm90_roll_pp": float(jm[dc["roll"]].median()), "cm90_other_pp": float(jm[~dc["roll"]].median())}
    stats = {"current_pct": None, "percentile": None, "percentile_1y": None, "avg_30d": None, "max": None, "min": None, "source": "binance_coinm", "live": False}
    if not dc.empty and dc["cm90"].notna().any():
        ok = dc[dc["cm90"].notna()]
        vals = ok["cm90"].to_numpy(float)
        live = _live_cm90(rows, "binance_coinm")
        cur = live if live is not None else float(vals[-1])
        last_year = ok[ok["time"] >= ok["time"].iloc[-1] - pd.Timedelta(days=365)]["cm90"].to_numpy(float)
        imax, imin = int(np.nanargmax(vals)), int(np.nanargmin(vals))
        stats = {
            "current_pct": cur, "percentile": _pctl(vals, cur), "percentile_1y": _pctl(last_year, cur),
            "avg_30d": float(ok[ok["time"] >= ok["time"].iloc[-1] - pd.Timedelta(days=30)]["cm90"].mean()),
            "max": {"value": float(vals[imax]), "time": util.ts(ok["time"].iloc[imax])},
            "min": {"value": float(vals[imin]), "time": util.ts(ok["time"].iloc[imin])},
            "source": "binance_coinm", "live": live is not None, "usdm_live_pct": _live_cm90(rows, "binance_usdm"),
        }
    off = _official_binance()
    official = None
    if off and not du.empty:
        t = pd.Timestamp(int(off["timestamp"]), unit="ms", tz="UTC")
        fut, idx = float(off["futuresPrice"]), float(off["indexPrice"])
        exp = expiry_after(pd.Series([t]), 0).iloc[0]
        days = (exp - t).total_seconds() / 86400
        ours = (fut / idx - 1) * 365 / days * 100
        official = {"time": util.ts(t), "binance_pct": float(off["annualizedBasisRate"]) * 100, "ours_pct": ours,
                    "diff_pp": ours - float(off["annualizedBasisRate"]) * 100, "days": days}
    try:
        snap = store.get("basis_deribit_snap")
        snap = snap.copy()
        snap["time"] = pd.to_datetime(snap["time"], utc=True)
        cm = _cm90(snap)
        since = util.ts(snap["time"].min()) if len(snap) else None
    except Exception:  # noqa: BLE001
        cm, since = [], None
    sig = _signals(stats["current_pct"], stats["percentile"], shape, slope, c["perps"], pairs, stats["avg_30d"])
    return util.clean({
        "time": c["time"], "index_price": c["index_price"], "curve": rows, "perpetual": c["perps"],
        "shape": shape, "slope_pp": slope, "stats": stats,
        "crosscheck": {"pairs": pairs, "binance_official": official, "coinm_vs_usdm": agreement, "roll_check": roll_check},
        "history": {"coinm": coinm, "usdm": usdm, "coinm_contract": coinm_c, "usdm_contract": usdm_c,
                    "rolls": {"coinm": rolls_c, "usdm": rolls_u},
                    "start": {"coinm": coinm[0]["time"] if coinm else None, "usdm": usdm[0]["time"] if usdm else None}},
        "deribit_cm90": {"since": since, "series": cm},
        "signals": sig,
        "params": {"roll_days": ROLL_DAYS, "noisy_days": NOISY_DAYS, "cm_days": CM_DAYS},
    })
