"""Macro & Rotazione: liquidità (stablecoin / FRED), dollaro e tassi, correlazioni cross-asset, rotazione BTC→altcoin.

Dataset registrati qui (cache parquet automatica via store):
  macro_dxy, macro_spx, macro_ndx, macro_gold, macro_us10y, macro_vix   (Yahoo Finance, close giornaliero)
  ethbtc_1d (Binance ETHBTC + ETHUSDT close giornaliero), macro_stables (DefiLlama, se "stables_total" non esiste)
  macro_fred_walcl / _rrp / _tga / _m2 (solo se FRED_API_KEY è impostata)
"""
from __future__ import annotations

import logging
import os
import time

import httpx
import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store
from . import cycles as cy

log = logging.getLogger("macro")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")
_client = httpx.Client(timeout=30, headers={"User-Agent": UA, "Accept": "application/json"})

YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
LLAMA = "https://stablecoins.llama.fi/stablecoincharts/all"
FRED = "https://api.stlouisfed.org/fred/series/observations"

# key -> (simbolo yahoo, etichetta)
YAHOO_SYMBOLS = {
    "dxy": ("DX-Y.NYB", "DXY"),
    "spx": ("^GSPC", "S&P 500"),
    "ndx": ("^IXIC", "Nasdaq"),
    "gold": ("GC=F", "Oro"),
    "us10y": ("^TNX", "US10Y"),
    "vix": ("^VIX", "VIX"),
}
FRED_SERIES = {"walcl": "WALCL", "rrp": "RRPONTSYD", "tga": "WTREGEN", "m2": "M2SL"}
DAY = pd.Timedelta(days=1)


# ===================================================================== fetchers

def _get(url: str, params: dict | None = None, retries: int = 4):
    for attempt in range(retries):
        try:
            r = _client.get(url, params=params)
            if r.status_code == 429:
                time.sleep(2 + attempt * 3)
                continue
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError:
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt * 2)
    raise RuntimeError(f"GET fallita: {url}")


def _merge(old: pd.DataFrame | None, new: pd.DataFrame) -> pd.DataFrame:
    if old is None or old.empty:
        return new.reset_index(drop=True)
    if new is None or new.empty:
        return old
    o = old.copy()
    o["time"] = pd.to_datetime(o["time"], utc=True)
    out = pd.concat([o, new]).drop_duplicates("time", keep="last").sort_values("time")
    return out.reset_index(drop=True)


def yahoo_daily(symbol: str, start: int = 1_230_768_000) -> pd.DataFrame:
    """Close giornaliero da Yahoo (time = data di borsa locale, mezzanotte UTC)."""
    j = _get(YAHOO.format(symbol=symbol), {"period1": start, "period2": int(time.time()) + 86400, "interval": "1d",
                                           "includePrePost": "false", "events": ""})
    res = j["chart"]["result"][0]
    tsx = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0].get("close") or []
    off = int(res.get("meta", {}).get("gmtoffset") or 0)
    df = pd.DataFrame({"t": tsx, "close": closes}).dropna()
    df = df[df["close"] > 0]
    df["time"] = pd.to_datetime((df["t"].astype("int64") + off) // 86400 * 86400, unit="s", utc=True)
    return df[["time", "close"]].astype({"close": float}).drop_duplicates("time", keep="last").reset_index(drop=True)


def _yahoo_refresher(symbol: str):
    def fn(old):
        if old is not None and len(old):
            start = int(pd.Timestamp(old["time"].iloc[-1]).timestamp()) - 20 * 86400
            return _merge(old, yahoo_daily(symbol, start))
        return yahoo_daily(symbol)
    return fn


def _ethbtc(old):
    start = None
    if old is not None and len(old) > 3:
        start = int(pd.Timestamp(old["time"].iloc[-3]).timestamp() * 1000)
    eb = src.binance_klines("1d", start, symbol="ETHBTC")[["time", "close"]].rename(columns={"close": "ethbtc"})
    eu = src.binance_klines("1d", start, symbol="ETHUSDT")[["time", "close"]].rename(columns={"close": "ethusdt"})
    new = eb.merge(eu, on="time", how="outer").sort_values("time")
    return _merge(old, new)


def llama_stables() -> pd.DataFrame:
    rows = _get(LLAMA)
    out = []
    for r in rows:
        v = (r.get("totalCirculatingUSD") or {}).get("peggedUSD")
        if v:
            out.append((int(r["date"]), float(v)))
    df = pd.DataFrame(out, columns=["t", "total"])
    df["time"] = pd.to_datetime(df["t"] // 86400 * 86400, unit="s", utc=True)
    return df[["time", "total"]].drop_duplicates("time", keep="last").reset_index(drop=True)


def fred_key() -> str | None:
    k = (os.environ.get("FRED_API_KEY") or "").strip()
    return k or None


def fred_series(series_id: str) -> pd.DataFrame:
    key = fred_key()
    if not key:
        raise RuntimeError("FRED_API_KEY non impostata")
    j = _get(FRED, {"series_id": series_id, "api_key": key, "file_type": "json", "observation_start": "2008-01-01"})
    obs = j.get("observations") or []
    df = pd.DataFrame([(o["date"], o["value"]) for o in obs], columns=["date", "value"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["time"] = pd.to_datetime(df["date"], utc=True)
    return df.dropna()[["time", "value"]].reset_index(drop=True)


for _k, (_sym, _lbl) in YAHOO_SYMBOLS.items():
    store.register(f"macro_{_k}", _yahoo_refresher(_sym), 3600)
store.register("ethbtc_1d", _ethbtc, 3600)
STABLES_SHARED = "stables_total"
if STABLES_SHARED not in store.REGISTRY:
    store.register("macro_stables", lambda old: llama_stables(), 3 * 3600)
if fred_key():
    for _k, _sid in FRED_SERIES.items():
        store.register(f"macro_fred_{_k}", (lambda sid: (lambda old: fred_series(sid)))(_sid), 6 * 3600)


# ===================================================================== helpers

def _safe(name: str) -> pd.DataFrame | None:
    try:
        return store.get(name)
    except Exception as e:  # noqa: BLE001
        log.warning("dataset %s non disponibile: %s", name, e)
        return None


def _daily_series(df: pd.DataFrame | None, col: str) -> pd.Series:
    if df is None or df.empty or col not in df:
        return pd.Series(dtype=float)
    s = df[["time", col]].dropna().copy()
    s["time"] = pd.to_datetime(s["time"], utc=True).dt.normalize()
    s = s.drop_duplicates("time", keep="last").set_index("time")[col].astype(float)
    return s.sort_index()


def _stables() -> tuple[pd.Series, str]:
    """Supply totale stablecoin (USD). Preferisce il dataset condiviso 'stables_total' se registrato."""
    if STABLES_SHARED in store.REGISTRY:
        df = _safe(STABLES_SHARED)
        if df is not None and len(df):
            cols = [c for c in df.columns if c != "time" and pd.api.types.is_numeric_dtype(df[c])]
            pref = [c for c in cols if c.lower() in ("total", "supply", "total_supply", "circulating", "mcap", "value")]
            c = (pref or cols or [None])[0]
            if c is not None:
                s = _daily_series(df, c)
                if len(s) > 400 and s.iloc[-1] > 1e10:
                    return s, STABLES_SHARED
    if "macro_stables" not in store.REGISTRY:
        return pd.Series(dtype=float), "n/d"
    return _daily_series(_safe("macro_stables"), "total"), "macro_stables"


def _sample(s: pd.Series, daily_days: int = 180, start: str | None = "2014-01-01", sig: int = 5) -> list[dict]:
    """Serie per i grafici: settimanale nello storico, giornaliera negli ultimi `daily_days` giorni."""
    s = s.replace([np.inf, -np.inf], np.nan).dropna()
    if start is not None:
        s = s[s.index >= pd.Timestamp(start, tz="UTC")]
    if s.empty:
        return []
    cut = s.index[-1] - pd.Timedelta(days=daily_days)
    old = s[s.index < cut]
    old = old.iloc[np.arange(len(old) - 1, -1, -7)[::-1]] if len(old) else old
    s2 = pd.concat([old, s[s.index >= cut]])
    return [{"time": util.ts(t), "value": cy.round_sig(float(v), sig)} for t, v in s2.items()]


def _r(x, nd: int = 4):
    v = util.num(x)
    return None if v is None else round(v, nd)


def _chg(s: pd.Series, days: int, pts: bool = False) -> float | None:
    """Variazione su `days` giorni di calendario (percentuale, o in punti se pts)."""
    s = s.dropna()
    if len(s) < 2:
        return None
    t0 = s.index[-1] - pd.Timedelta(days=days)
    prev = s[s.index <= t0]
    if prev.empty:
        return None
    a, b = float(prev.iloc[-1]), float(s.iloc[-1])
    if pts:
        return b - a
    return (b / a - 1) * 100 if a else None


def _fmt_pct(v, nd=1, signed=True) -> str:
    if v is None:
        return "n/d"
    s = "+" if (signed and v > 0) else ("−" if v < 0 else "")
    return f"{s}{abs(v):.{nd}f}%"


def _fmt_pt(v, nd=2) -> str:
    if v is None:
        return "n/d"
    s = "+" if v > 0 else ("−" if v < 0 else "")
    return f"{s}{abs(v):.{nd}f} pt"


def _fmt_num(v, nd=2) -> str:
    return "n/d" if v is None else f"{v:,.{nd}f}"


def _usd_big(v) -> str:
    if v is None:
        return "n/d"
    a = abs(v)
    if a >= 1e12:
        return f"${v / 1e12:.2f}T"
    if a >= 1e9:
        return f"${v / 1e9:.1f}B"
    return f"${v / 1e6:.0f}M"


def _btc_price() -> pd.Series:
    df = cy.merged_daily(_safe("daily"), _safe("onchain"), _safe("k_1d"))
    return df["close"].astype(float)


# ===================================================================== analisi

def _lag_analysis(key: str, label: str, liq: pd.Series, btc: pd.Series, start: str, unit: str) -> dict | None:
    """Correlazione tra variazione a 90g della liquidità al tempo t e variazione a 90g di BTC al tempo t+lag."""
    idx = pd.date_range(max(liq.index[0], btc.index[0]), btc.index[-1], freq="D")
    L = np.log(liq.reindex(idx).ffill())
    B = np.log(btc.reindex(idx).ffill())
    lx = (L - L.shift(90)) * 100
    by = (B - B.shift(90)) * 100
    m = idx >= pd.Timestamp(start, tz="UTC")
    lags = []
    for lag in range(0, 121, 5):
        y = by.shift(-lag)
        ok = m & lx.notna().to_numpy() & y.notna().to_numpy()
        if ok.sum() < 200:
            lags.append({"lag": lag, "corr": None})
            continue
        lags.append({"lag": lag, "corr": _r(np.corrcoef(lx[ok], y[ok])[0, 1], 3)})
    valid = [x for x in lags if x["corr"] is not None]
    if not valid:
        return None
    best = max(valid, key=lambda x: x["corr"])
    bl, bc = best["lag"], best["corr"]
    c0 = lags[0]["corr"]
    weeks = round(bl / 7)
    lc = label[0].lower() + label[1:]
    if bc < 0.15:
        text = (f"La correlazione tra {lc} e BTC è debole (massimo ρ {bc:.2f}): al momento la relazione "
                f"non offre un anticipo affidabile.")
    elif bl == 0:
        text = (f"BTC e {lc} si muovono insieme senza ritardo apprezzabile (ρ {bc:.2f} a lag 0): "
                f"la liquidità accompagna il prezzo più che anticiparlo.")
    else:
        text = (f"BTC segue {lc} con circa {weeks} settimane di ritardo ({bl} giorni, ρ {bc:.2f} "
                f"contro {c0:.2f} senza ritardo): le variazioni di liquidità di oggi tendono a riflettersi sul prezzo "
                f"verso {_mese(btc.index[-1] + pd.Timedelta(days=bl))}.")
    shifted = lx.shift(bl)  # liquidità traslata in avanti di bl giorni
    future = pd.date_range(idx[-1] + DAY, idx[-1] + pd.Timedelta(days=bl), freq="D") if bl else []
    if len(future):
        shifted = pd.concat([shifted, pd.Series(lx.iloc[-bl:].to_numpy(), index=future)])
    st = start
    return {
        "key": key, "label": label, "unit": unit,
        "lags": lags, "best_lag": bl, "best_corr": bc, "corr_lag0": c0, "text": text,
        "liq_level": _sample(liq, start=st, daily_days=0, sig=4),
        "liq_change_shifted": _sample(shifted, start=st, daily_days=0, sig=3),
        "btc_change": _sample(by, start=st, daily_days=0, sig=3),
    }


MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre",
        "novembre", "dicembre"]


def _mese(t) -> str:
    t = pd.Timestamp(t)
    return f"{MESI[t.month - 1]} {t.year}"


def _regime_stats(regime: pd.Series, btc: pd.Series, labels: dict[str, str], fwd: int, since: str = "2013-01-01") -> list[dict]:
    """Rendimento BTC a `fwd` giorni e annualizzato durante ciascun regime (storico giornaliero)."""
    idx = regime.index
    p = btc.reindex(idx).ffill()
    fwd_ret = (p.shift(-fwd) / p - 1) * 100
    dlog = np.log(p).diff().shift(-1)  # rendimento del giorno successivo (regime noto a fine giornata)
    m = idx >= pd.Timestamp(since, tz="UTC")
    out = []
    for k, lbl in labels.items():
        sel = m & (regime == k).to_numpy()
        f = fwd_ret[sel].dropna()
        d = dlog[sel].dropna()
        out.append({
            "regime": k, "label": lbl, "days": int(sel.sum()),
            "share": _r(sel.sum() / max(1, m.sum()) * 100, 1),
            "fwd_median": _r(f.median(), 1) if len(f) > 20 else None,
            "fwd_mean": _r(f.mean(), 1) if len(f) > 20 else None,
            "win_rate": _r((f > 0).mean() * 100, 1) if len(f) > 20 else None,
            "ann_return": _r((np.exp(d.mean() * 365) - 1) * 100, 1) if len(d) > 20 else None,
        })
    return out


def _dollar_rates(mk: dict[str, pd.Series], btc: pd.Series) -> dict:
    cal = pd.date_range(pd.Timestamp("2010-01-01", tz="UTC"), btc.index[-1], freq="D")
    out: dict = {}

    # --------------------------------------------------- DXY
    dxy = mk["dxy"]
    ma200 = dxy.rolling(200, min_periods=150).mean()
    chg6 = (dxy / dxy.shift(126) - 1) * 100
    reg = pd.Series(np.where((dxy > ma200) & (chg6 > 0), "strong", np.where((dxy < ma200) & (chg6 < 0), "weak", "mixed")),
                    index=dxy.index)
    reg[ma200.isna() | chg6.isna()] = "na"
    reg_cal = reg.reindex(cal).ffill()
    dlabels = {"strong": "Dollaro forte", "mixed": "Transizione", "weak": "Dollaro debole"}
    cur = reg.iloc[-1]
    stats = _regime_stats(reg_cal, btc, dlabels, 90)
    cur_ma = float(ma200.iloc[-1])
    cs = next((s for s in stats if s["regime"] == cur), None)
    dtext = {
        "strong": "Il dollaro è sopra la media a 200 giorni e in rafforzamento su 6 mesi: storicamente un vento contrario per BTC.",
        "weak": "Il dollaro è sotto la media a 200 giorni e in indebolimento su 6 mesi: storicamente il contesto più favorevole a BTC.",
        "mixed": "Il dollaro è in transizione (media a 200 giorni e trend a 6 mesi discordi): impatto su BTC meno netto.",
    }.get(cur, "")
    if cs and cs["fwd_median"] is not None:
        dtext += (f" In questo regime BTC ha reso in mediana {_fmt_pct(cs['fwd_median'])} nei 90 giorni successivi "
                  f"(positivo nel {cs['win_rate']:.0f}% dei casi).")
    out["dxy"] = {
        "value": _r(dxy.iloc[-1], 3), "change_1d": _r(_chg_n(dxy, 1), 2), "change_30d": _r(_chg(dxy, 30), 2),
        "change_6m": _r(chg6.iloc[-1], 2), "ma200": _r(cur_ma, 3), "above_ma200": bool(dxy.iloc[-1] > cur_ma),
        "regime": cur, "regime_label": dlabels.get(cur, "n/d"), "text": dtext, "stats": stats,
        "series": _sample(dxy, start="2015-01-01"), "ma200_series": _sample(ma200, start="2015-01-01"),
    }

    # --------------------------------------------------- US10Y (rendimento in %)
    y = mk["us10y"]
    ych = y - y.shift(126)
    yreg = pd.Series(np.where(ych > 0.5, "rising", np.where(ych < -0.5, "falling", "stable")), index=y.index)
    yreg[ych.isna()] = "na"
    ylabels = {"rising": "Tassi in salita", "stable": "Tassi stabili", "falling": "Tassi in discesa"}
    ystats = _regime_stats(yreg.reindex(cal).ffill(), btc, ylabels, 90)
    ycur = yreg.iloc[-1]
    ytext = {
        "rising": "I rendimenti decennali USA sono saliti di oltre mezzo punto in 6 mesi: condizioni finanziarie più strette.",
        "falling": "I rendimenti decennali USA sono scesi di oltre mezzo punto in 6 mesi: condizioni finanziarie più distese.",
        "stable": "I rendimenti decennali USA sono stabili su 6 mesi (variazione entro ±0.5 pt).",
    }.get(ycur, "")
    out["us10y"] = {
        "value": _r(y.iloc[-1], 3), "change_1d": _r(_chg_n(y, 1, pts=True), 3), "change_30d": _r(_chg(y, 30, pts=True), 3),
        "change_6m": _r(ych.iloc[-1], 3), "regime": ycur, "regime_label": ylabels.get(ycur, "n/d"), "text": ytext,
        "stats": ystats, "series": _sample(y, start="2015-01-01"),
    }

    # --------------------------------------------------- VIX
    v = mk["vix"]
    vreg = pd.Series(pd.cut(v, [0, 15, 22, 30, 1000], labels=["calm", "normal", "tense", "panic"]).astype(str), index=v.index)
    vlabels = {"calm": "Calma (< 15)", "normal": "Normale (15–22)", "tense": "Tensione (22–30)", "panic": "Panico (> 30)"}
    vstats = _regime_stats(vreg.reindex(cal).ffill(), btc, vlabels, 30)
    vcur = vreg.iloc[-1]
    vtext = {
        "calm": "Volatilità azionaria bassa: mercati in modalità risk-on, ma la compiacenza può precedere scossoni.",
        "normal": "Volatilità azionaria nella norma: nessun segnale di stress sui mercati tradizionali.",
        "tense": "Volatilità azionaria elevata: avversione al rischio in aumento, BTC tende a soffrire nel breve.",
        "panic": "Volatilità azionaria estrema: fase di panico. Storicamente i picchi di VIX hanno coinciso con minimi di medio periodo.",
    }.get(vcur, "")
    out["vix"] = {
        "value": _r(v.iloc[-1], 2), "change_1d": _r(_chg_n(v, 1), 2), "change_30d": _r(_chg(v, 30), 2),
        "regime": vcur, "regime_label": vlabels.get(vcur, "n/d"), "text": vtext, "stats": vstats,
        "series": _sample(v, start="2015-01-01"),
    }
    return out


def _chg_n(s: pd.Series, n: int, pts: bool = False) -> float | None:
    """Variazione rispetto a n osservazioni (sedute) fa."""
    s = s.dropna()
    if len(s) <= n:
        return None
    a, b = float(s.iloc[-1 - n]), float(s.iloc[-1])
    return (b - a) if pts else ((b / a - 1) * 100 if a else None)


ASSETS = [("btc", "BTC"), ("eth", "ETH"), ("spx", "S&P 500"), ("ndx", "Nasdaq"), ("gold", "Oro"), ("dxy", "DXY"),
          ("us10y", "US10Y"), ("vix", "VIX")]


def _returns(mk: dict[str, pd.Series], btc: pd.Series, eth: pd.Series) -> pd.DataFrame:
    """Rendimenti sulle sedute USA (date in cui quota l'S&P 500): log-rendimenti, variazione in punti per US10Y."""
    days = mk["spx"].index
    lv = pd.DataFrame({"btc": btc.reindex(days, method="ffill"), "eth": eth.reindex(days, method="ffill") if len(eth) else np.nan})
    for k in ("spx", "ndx", "gold", "dxy", "vix", "us10y"):
        lv[k] = mk[k].reindex(days).ffill(limit=3)
    r = pd.DataFrame(index=days)
    for k in lv:
        r[k] = lv[k].diff() if k == "us10y" else np.log(lv[k]).diff()
    return r


def _correlations(R: pd.DataFrame) -> dict:
    keys = [k for k, _ in ASSETS]
    names = dict(ASSETS)
    mats = []
    for win, lbl in ((63, "90g"), (252, "1 anno")):
        sub = R.iloc[-win:][keys]
        c = sub.corr(min_periods=int(win * 0.6))
        mats.append({"window": lbl, "days": win, "values": [[_r(c.loc[a, b], 2) for b in keys] for a in keys]})
    rolling = {}
    cal = pd.date_range(R.index[0], R.index[-1], freq="D")

    def rc(k: str, w: int, daily: int) -> list[dict]:
        s = R["btc"].rolling(w, min_periods=int(w * 0.8)).corr(R[k]).reindex(cal).ffill(limit=5)
        return _sample(s, start="2015-01-01", daily_days=daily, sig=3)
    rolling = {"dxy": {f"r{lbl}": rc("dxy", w, 365) for w, lbl in ((21, 30), (63, 90), (126, 180))}}
    for k in ("spx", "ndx", "gold", "us10y"):
        rolling[k] = {"r90": rc(k, 63, 0)}
    betas = []
    for k in ("spx", "ndx", "gold", "dxy"):
        row = {"asset": k, "label": names[k]}
        for win, lbl in ((63, "90d"), (252, "1y")):
            sub = R[["btc", k]].iloc[-win:].dropna()
            if len(sub) > win * 0.6 and sub[k].var() > 0:
                row[f"corr_{lbl}"] = _r(sub["btc"].corr(sub[k]), 2)
                row[f"beta_{lbl}"] = _r(sub["btc"].cov(sub[k]) / sub[k].var(), 2)
            else:
                row[f"corr_{lbl}"] = row[f"beta_{lbl}"] = None
        betas.append(row)
    return {"assets": [{"key": k, "label": names[k]} for k in keys], "matrices": mats, "rolling": rolling, "betas": betas}


def _pct_rank(s: pd.Series) -> pd.Series:
    return s.rank(pct=True)


def _cycle_info() -> dict:
    try:
        from ..routers.cycles import build as cycles_build
        c = cycles_build()
        return {"cycles": c.get("cycles") or [], "current": c.get("current") or {}, "halvings": c.get("halvings") or []}
    except Exception as e:  # noqa: BLE001
        log.warning("cicli non disponibili: %s", e)
        return {"cycles": [], "current": {}, "halvings": []}


PHASE_IT = {"accumulation": "accumulo", "bull": "bull market", "distribution": "distribuzione", "bear": "bear market"}


def _rotation(ethbtc: pd.Series, dom: pd.Series, cyc: dict) -> dict:
    idx = pd.date_range(max(ethbtc.index[0], dom.index[0]), max(ethbtc.index[-1], dom.index[-1]), freq="D")
    eb = ethbtc.reindex(idx).ffill()
    dm = dom.reindex(idx).ffill()
    eb_ma = eb.rolling(200, min_periods=150).mean()
    dm_ma = dm.rolling(200, min_periods=150).mean()
    comp = pd.DataFrame({
        "eb_mom": _pct_rank(np.log(eb).diff(90)),
        "eb_trend": _pct_rank(eb / eb_ma - 1),
        "dom_mom": _pct_rank(-(dm - dm.shift(90))),
        "dom_trend": _pct_rank(-(dm - dm_ma)),
    }, index=idx)
    alt = (comp.mean(axis=1, skipna=False) * 100).ewm(span=7, min_periods=1).mean()
    alt[comp.isna().any(axis=1)] = np.nan
    cur_alt = float(alt.dropna().iloc[-1])

    def phase_of(v):
        return "btc_season" if v < 35 else ("alt_rotation" if v > 65 else "neutral")
    PH = {"btc_season": "BTC season", "neutral": "Neutrale", "alt_rotation": "Rotazione verso altcoin"}
    ph = phase_of(cur_alt)
    last_c = comp.dropna().iloc[-1]
    components = [
        {"key": "eb_mom", "label": "Momentum ETH/BTC (90g)", "value": _r(last_c["eb_mom"] * 100, 1)},
        {"key": "eb_trend", "label": "ETH/BTC vs media 200g", "value": _r(last_c["eb_trend"] * 100, 1)},
        {"key": "dom_mom", "label": "Calo dominance BTC (90g)", "value": _r(last_c["dom_mom"] * 100, 1)},
        {"key": "dom_trend", "label": "Dominance sotto media 200g", "value": _r(last_c["dom_trend"] * 100, 1)},
    ]

    # ------------------------------------------- confronto con i cicli precedenti (giorni dall'halving)
    halv = [pd.Timestamp(t) for _, t, _ in cy.HALVINGS]
    now = idx[-1]
    h_now = max(h for h in halv if h <= now)
    d_since = int((now - h_now).days)
    compare = []
    for h in halv:
        t = h + pd.Timedelta(days=d_since)
        if t > now or h == h_now:
            continue
        if t < idx[0] + pd.Timedelta(days=200):
            continue
        t_end = min(t + pd.Timedelta(days=180), now)
        e_h = eb.asof(h) if h >= idx[0] else np.nan
        compare.append({
            "cycle": f"Halving {h.year}", "halving": util.ts(h), "time": util.ts(t),
            "ethbtc": _r(eb.asof(t), 5), "ethbtc_since_halving": _r((eb.asof(t) / e_h - 1) * 100, 1) if util.num(e_h) else None,
            "dominance": _r(dm.asof(t), 2), "altseason": _r(alt.asof(t), 1),
            "ethbtc_next_180d": _r((eb.asof(t_end) / eb.asof(t) - 1) * 100, 1) if t_end > t + pd.Timedelta(days=30) else None,
            "dominance_next_180d": _r(dm.asof(t_end) - dm.asof(t), 2) if t_end > t + pd.Timedelta(days=30) else None,
        })
    e_h_now = eb.asof(h_now)
    compare.append({
        "cycle": f"Attuale (halving {h_now.year})", "halving": util.ts(h_now), "time": util.ts(now),
        "ethbtc": _r(eb.iloc[-1], 5), "ethbtc_since_halving": _r((eb.iloc[-1] / e_h_now - 1) * 100, 1),
        "dominance": _r(dm.iloc[-1], 2), "altseason": _r(cur_alt, 1), "ethbtc_next_180d": None, "dominance_next_180d": None,
    })

    # ------------------------------------------- annotazioni di ciclo
    marks = []
    for c in cyc.get("cycles", []):
        for kind, key in (("bottom", "bottom"), ("top", "top")):
            p = c.get(key)
            if p and p.get("time") and p["time"] >= util.ts(idx[0]):
                marks.append({"time": p["time"], "kind": kind, "label": ("Minimo ciclo " if kind == "bottom" else "Massimo ciclo ") + _mese(pd.Timestamp(p["time"], unit="s"))})
    for h in halv:
        if h >= idx[0]:
            marks.append({"time": util.ts(h), "kind": "halving", "label": f"Halving {h.year}"})
    marks.sort(key=lambda m: m["time"])

    eb_now, eb_ma_now = float(eb.iloc[-1]), float(eb_ma.iloc[-1])
    dm_now = float(dm.iloc[-1])
    eb30, eb90 = _chg(eb, 30), _chg(eb, 90)
    dm30, dm90 = _chg(dm, 30, pts=True), _chg(dm, 90, pts=True)
    cur_phase = (cyc.get("current") or {}).get("phase")

    bullets = []
    bullets.append(f"ETH/BTC a {eb_now:.4f} ({'sopra' if eb_now > eb_ma_now else 'sotto'} la media a 200 giorni {eb_ma_now:.4f}), "
                   f"{_fmt_pct(eb90)} in 90 giorni.")
    bullets.append(f"Dominance BTC al {dm_now:.1f}% ({_fmt_pt(dm90, 1)} in 90 giorni)" +
                   (": il capitale si sta concentrando su Bitcoin." if (dm90 or 0) > 0.5 else
                    ": il capitale sta defluendo verso le altcoin." if (dm90 or 0) < -0.5 else ": quota stabile."))
    expl = {
        "btc_season": "Fase di BTC season: Bitcoin sovraperforma il resto del mercato. Tipica della prima metà del ciclo e "
                      "delle fasi di avversione al rischio, quando il capitale si rifugia nell'asset più liquido.",
        "neutral": "Fase neutrale: né Bitcoin né le altcoin mostrano una sovraperformance netta. La rotazione non è ancora partita "
                   "(o si è esaurita).",
        "alt_rotation": "Rotazione verso altcoin: ETH/BTC sale e la dominance BTC scende. Storicamente avviene nella fase avanzata "
                        "del bull market, spesso a ridosso del massimo di ciclo: segnale di euforia da monitorare.",
    }[ph]
    prev = [c for c in compare if not c["cycle"].startswith("Attuale") and c["altseason"] is not None]
    if prev:
        avg_prev = float(np.mean([c["altseason"] for c in prev]))
        nxt = [c["ethbtc_next_180d"] for c in prev if c["ethbtc_next_180d"] is not None]
        b = (f"A {d_since} giorni dall'halving l'indice altseason è {cur_alt:.0f} contro una media di {avg_prev:.0f} nei cicli "
             f"precedenti allo stesso punto")
        if nxt:
            b += f"; nei 180 giorni successivi ETH/BTC aveva fatto in media {_fmt_pct(float(np.mean(nxt)))}"
        bullets.append(b + ".")
    if cur_phase:
        bullets.append(f"Fase del ciclo BTC: {PHASE_IT.get(cur_phase, cur_phase)}.")

    return {
        "ethbtc": {"value": _r(eb_now, 6), "change_30d": _r(eb30, 2), "change_90d": _r(eb90, 2), "ma200": _r(eb_ma_now, 6),
                   "above_ma200": eb_now > eb_ma_now, "series": _sample(eb, start=None), "ma200_series": _sample(eb_ma, start=None)},
        "dominance": {"value": _r(dm_now, 2), "change_30d": _r(dm30, 2), "change_90d": _r(dm90, 2), "ma200": _r(dm_ma.iloc[-1], 2),
                      "series": _sample(dm, start=None, sig=4), "ma200_series": _sample(dm_ma, start=None, sig=4)},
        "altseason": {"value": _r(cur_alt, 1), "phase": ph, "phase_label": PH[ph], "components": components,
                      "series": _sample(alt, start=None, sig=3), "explanation": expl},
        "cycle_marks": marks, "cycle_phase": cur_phase, "days_since_halving": d_since,
        "compare": compare, "bullets": bullets,
    }


def _fred_block(btc: pd.Series) -> tuple[dict, list[dict], dict | None]:
    """(blocco fred, analisi lag aggiuntive, componente per il punteggio)."""
    if not fred_key():
        return ({"available": False,
                 "message": "Dati Fed non disponibili.",
                 "net_liquidity": None, "m2_yoy": None, "series": None}, [], None)
    try:
        walcl = _daily_series(_safe("macro_fred_walcl"), "value") * 1e6   # milioni -> USD
        rrp = _daily_series(_safe("macro_fred_rrp"), "value") * 1e9       # miliardi -> USD
        tga = _daily_series(_safe("macro_fred_tga"), "value") * 1e6       # milioni -> USD
        m2 = _daily_series(_safe("macro_fred_m2"), "value") * 1e9         # miliardi -> USD
        if walcl.empty or tga.empty:
            raise RuntimeError("serie FRED vuote")
        idx = pd.date_range(walcl.index[0], btc.index[-1], freq="D")
        net = walcl.reindex(idx).ffill() - rrp.reindex(idx).ffill().fillna(0) - tga.reindex(idx).ffill()
        net = net.dropna()
        m2d = m2.reindex(pd.date_range(m2.index[0], btc.index[-1], freq="D")).ffill() if len(m2) else m2
        m2yoy = (m2d / m2d.shift(365) - 1) * 100 if len(m2d) else m2d
        lags = []
        la = _lag_analysis("net_liquidity", "Liquidità netta USA", net, btc, "2015-01-01", "usd")
        if la:
            lags.append(la)
        if len(m2d):
            lb = _lag_analysis("m2", "Massa monetaria M2", m2d, btc, "2015-01-01", "usd")
            if lb:
                lags.append(lb)
        n13 = _chg(net, 91)
        comp = {"key": "fed_liquidity", "label": "Liquidità Fed", "value": _fmt_pct(n13) + " (13 sett.)",
                "score": _r(float(np.clip((n13 or 0) / 4, -1, 1)) * 100, 0),
                "text": (f"Liquidità netta USA {_usd_big(float(net.iloc[-1]))}, {_fmt_pct(n13)} in 13 settimane: "
                         + ("la Fed sta immettendo liquidità." if (n13 or 0) > 1 else
                            "la liquidità si sta riducendo." if (n13 or 0) < -1 else "liquidità stabile."))}
        return ({"available": True, "message": "Dati FRED attivi (aggiornamento settimanale/mensile).",
                 "net_liquidity": {"value": _r(net.iloc[-1], 0), "change_13w": _r(n13, 2),
                                   "walcl": _r(walcl.iloc[-1], 0), "rrp": _r(rrp.iloc[-1], 0) if len(rrp) else None,
                                   "tga": _r(tga.iloc[-1], 0), "as_of": util.ts(net.index[-1])},
                 "m2_yoy": _r(m2yoy.dropna().iloc[-1], 2) if len(m2yoy.dropna()) else None,
                 "series": {
                            "m2_yoy": _sample(m2yoy, start="2015-01-01", daily_days=0, sig=4)}},
                lags, comp)
    except Exception as e:  # noqa: BLE001
        log.warning("FRED non disponibile: %s", e)
        return ({"available": False, "message": "Dati Fed temporaneamente non disponibili.",
                 "net_liquidity": None, "m2_yoy": None, "series": None}, [], None)


def _summary(dr: dict, mk: dict[str, pd.Series], stables: dict, fred_comp: dict | None) -> dict:
    comps = []
    d = dr["dxy"]
    s_d = float(np.clip(-(d["change_6m"] or 0) / 5, -1, 1)) * 0.6 + (-0.4 if d["above_ma200"] else 0.4)
    comps.append({"key": "dxy", "label": "Dollaro (DXY)", "value": f"{_fmt_num(d['value'])} · 6m {_fmt_pct(d['change_6m'])}",
                  "score": round(s_d * 100), "text": f"{d['regime_label']}: " + (
                      "un dollaro debole libera liquidità globale ed è favorevole agli asset rischiosi." if s_d > 0.2 else
                      "un dollaro forte drena liquidità ed è un freno per BTC." if s_d < -0.2 else "segnale misto dal dollaro.")})
    y = dr["us10y"]
    s_y = float(np.clip(-(y["change_6m"] or 0) / 0.75, -1, 1))
    comps.append({"key": "us10y", "label": "Tassi USA 10 anni", "value": f"{_fmt_num(y['value'])}% · 6m {_fmt_pt(y['change_6m'])}",
                  "score": round(s_y * 100), "text": f"{y['regime_label']}: " + (
                      "rendimenti in calo allentano le condizioni finanziarie." if s_y > 0.2 else
                      "rendimenti in salita rendono più costoso il rischio." if s_y < -0.2 else "nessuna pressione rilevante dai tassi.")})
    v = dr["vix"]
    s_v = float(np.clip((20 - (v["value"] or 20)) / 10, -1, 1))
    comps.append({"key": "vix", "label": "Volatilità (VIX)", "value": _fmt_num(v["value"]),
                  "score": round(s_v * 100), "text": f"{v['regime_label']}: " + (
                      "appetito per il rischio sui mercati tradizionali." if s_v > 0.2 else
                      "stress sui mercati tradizionali, contesto risk-off." if s_v < -0.2 else "volatilità nella norma.")})
    g = stables.get("growth_90d")
    s_s = float(np.clip((g or 0) / 8, -1, 1))
    comps.append({"key": "stables", "label": "Liquidità stablecoin", "value": f"{_usd_big(stables.get('supply'))} · 90g {_fmt_pct(g)}",
                  "score": round(s_s * 100), "text": (
                      "la supply di stablecoin cresce: nuova liquidità pronta a entrare nel mercato crypto." if s_s > 0.2 else
                      "la supply di stablecoin si contrae: liquidità in uscita dal mercato crypto." if s_s < -0.2 else
                      "supply di stablecoin quasi ferma.")})
    spx = mk["spx"]
    ma = spx.rolling(200, min_periods=150).mean()
    r3 = _chg(spx, 91)
    s_e = (0.5 if spx.iloc[-1] > ma.iloc[-1] else -0.5) + float(np.clip((r3 or 0) / 10, -1, 1)) * 0.5
    comps.append({"key": "equities", "label": "Azionario USA (S&P 500)", "value": f"3m {_fmt_pct(r3)}",
                  "score": round(s_e * 100), "text": (
                      f"S&P 500 {'sopra' if spx.iloc[-1] > ma.iloc[-1] else 'sotto'} la media a 200 giorni: " +
                      ("trend azionario sano, sostiene la propensione al rischio." if s_e > 0.2 else
                       "azionario debole, pesa sugli asset rischiosi." if s_e < -0.2 else "trend azionario incerto."))})
    if fred_comp:
        comps.append(fred_comp)
    for c in comps:
        c["tone"] = "bullish" if c["score"] > 20 else "bearish" if c["score"] < -20 else "neutral"
    avg = float(np.mean([c["score"] for c in comps])) / 100
    score = round(50 + 50 * avg, 1)
    label = "Risk-on" if score >= 60 else "Risk-off" if score <= 40 else "Neutrale"
    tone = "bullish" if score >= 60 else "bearish" if score <= 40 else "neutral"
    pos = [c["label"] for c in comps if c["tone"] == "bullish"]
    neg = [c["label"] for c in comps if c["tone"] == "bearish"]
    headline = {
        "Risk-on": "Contesto macro favorevole agli asset rischiosi.",
        "Risk-off": "Contesto macro sfavorevole: prevale l'avversione al rischio.",
        "Neutrale": "Contesto macro misto, senza una direzione prevalente.",
    }[label]
    bullets = [headline]
    if pos:
        bullets.append("A favore: " + ", ".join(pos) + ".")
    if neg:
        bullets.append("Contro: " + ", ".join(neg) + ".")
    bullets += [f"{c['label']}: {c['text']}" for c in comps]
    return {"score": score, "label": label, "tone": tone, "components": comps, "bullets": bullets}


@util.ttl_cache(300)
def build() -> dict:
    btc = _btc_price()
    mk: dict[str, pd.Series] = {}
    for k in YAHOO_SYMBOLS:
        s = _daily_series(_safe(f"macro_{k}"), "close")
        if s.empty:
            raise RuntimeError(f"serie {k} non disponibile")
        mk[k] = s
    eth_df = _safe("ethbtc_1d")
    ethbtc = _daily_series(eth_df, "ethbtc")
    eth = _daily_series(eth_df, "ethusdt")

    # --------------------------------------------- liquidità
    st, st_src = _stables()
    stables = {"supply": None, "change_30d": None, "growth_90d": None, "source": st_src, "series": [], "growth_series": []}
    lag_list = []
    if len(st) > 400:
        st = st[st.index >= pd.Timestamp("2018-01-01", tz="UTC")]
        g90 = (st / st.shift(90, freq="D").reindex(st.index) - 1) * 100
        stables.update({"supply": _r(st.iloc[-1], 0), "change_30d": _r(_chg(st, 30), 2), "growth_90d": _r(_chg(st, 90), 2),
                        "series": _sample(st, start="2018-01-01", sig=4), "growth_series": _sample(g90, start="2020-06-01", sig=3)})
        la = _lag_analysis("stables", "Liquidità stablecoin", st, btc, "2020-01-01", "usd")
        if la:
            lag_list.append(la)
    fred, fred_lags, fred_comp = _fred_block(btc)
    lag_list += fred_lags

    dr = _dollar_rates(mk, btc)
    R = _returns(mk, btc, eth)
    corr = _correlations(R)
    # DXY vs BTC (assi doppi)
    dr["dxy"]["btc_series"] = _sample(btc, start="2015-01-01")

    # --------------------------------------------- rotazione
    try:
        from . import usdt as usdt_an
        fr, _, _ = usdt_an._frame()
        fr = fr.set_index("time")
        fr.index = pd.to_datetime(fr.index, utc=True).normalize()
        dom = (fr["btc_cap"] / fr["total"] * 100).dropna()
        try:  # allinea l'ultimo valore alla dominance CoinGecko mostrata in dashboard (stessa scala per tutta la serie)
            from ..routers import market
            cg_dom = market.build_overview().get("btc_dominance")
            if cg_dom and len(dom):
                dom = dom * (cg_dom / float(dom.iloc[-1]))
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        log.warning("dominance non disponibile: %s", e)
        caps = store.get("caps").set_index("time")
        dom = (caps["btc"] / caps.sum(axis=1) * 100 / (1 / 0.9)).dropna()
        dom.index = pd.to_datetime(dom.index, utc=True).normalize()
    cyc = _cycle_info()
    rot = _rotation(ethbtc, dom, cyc)

    summary = _summary(dr, mk, stables, fred_comp)
    kpi = {
        "dxy": {"value": dr["dxy"]["value"], "change_1d": dr["dxy"]["change_1d"], "change_30d": dr["dxy"]["change_30d"]},
        "us10y": {"value": dr["us10y"]["value"], "change_30d": dr["us10y"]["change_30d"]},
        "vix": {"value": dr["vix"]["value"], "change_1d": dr["vix"]["change_1d"]},
        "stables": {"value": stables["supply"], "growth_90d": stables["growth_90d"]},
        "ethbtc": {"value": rot["ethbtc"]["value"], "change_30d": rot["ethbtc"]["change_30d"]},
        "dominance": {"value": rot["dominance"]["value"], "change_30d": rot["dominance"]["change_30d"]},
        "altseason": {"value": rot["altseason"]["value"], "phase_label": rot["altseason"]["phase_label"]},
        "spx": {"value": _r(mk["spx"].iloc[-1], 2), "change_1d": _r(_chg_n(mk["spx"], 1), 2)},
        "gold": {"value": _r(mk["gold"].iloc[-1], 2), "change_1d": _r(_chg_n(mk["gold"], 1), 2)},
    }
    asof = {k: util.ts(mk[k].index[-1]) for k in mk}
    return util.clean({
        "kpi": kpi,
        "liquidity": {"stables": stables, "lags": lag_list, "btc_price": _sample(btc, start="2015-01-01", daily_days=0)},
        "fred": fred,
        "dollar_rates": dr,
        "correlations": corr,
        "rotation": rot,
        "summary": summary,
        "as_of": asof,
        "note": ("Dati: Yahoo Finance (DXY, S&P 500, Nasdaq, oro, US10Y, VIX — chiusure giornaliere), Binance (ETH/BTC, ETH/USDT), "
                 "DefiLlama (supply totale stablecoin), CoinMetrics (market cap per la dominance), FRED opzionale. "
                 "Correlazioni calcolate sui rendimenti giornalieri nelle sedute USA (US10Y: variazione in punti); "
                 "finestre 30/90/180 giorni ≈ 21/63/126 sedute. L'analisi del ritardo confronta la variazione a 90 giorni "
                 "della liquidità con la variazione a 90 giorni di BTC spostata in avanti di 0–120 giorni. "
                 "L'indice altseason (0–100) è la media dei percentili storici di momentum e trend di ETH/BTC e del calo "
                 "della dominance BTC. Correlazione non implica causalità."),
        "generated_at": int(time.time()),
    })
