"""Feature store giornaliero point-in-time per la previsione del prezzo BTC.

Ogni riga `d` contiene SOLO informazioni disponibili alla chiusura del giorno `d` (UTC), rispettando i ritardi
di pubblicazione delle fonti:
  - CoinMetrics (on-chain, market cap)  -> +1 giorno  (il valore del giorno d esce il giorno d+1)
  - BGeometrics (STH/LTH realized price) -> +7 giorni
  - DefiLlama stablecoin totali          -> +1 giorno
  - macro USA (Yahoo)                    -> stesso giorno (chiusura NY < 24:00 UTC), riportata nei weekend/festivi (max 4 g)
  - volumi spot/perp                     -> solo giorni CHIUSI (+1 giorno: la candela di oggi è parziale)
  - funding / DVOL / Fear&Greed          -> stesso giorno (noti entro la chiusura giornaliera)
Le serie mancanti nella storia antica restano NaN (LightGBM e kNN le gestiscono).
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from ..data import store

log = logging.getLogger("forecast")

OFFLINE = False          # True = legge solo i parquet su disco (ricerca/test, nessuna chiamata di rete)
HALVINGS = pd.to_datetime(["2009-01-03", "2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"])
GENESIS = pd.Timestamp("2009-01-03")

# chiave -> (etichetta italiana, gruppo)
FEATURES: dict[str, tuple[str, str]] = {
    # prezzo / momentum
    "ret_1d": ("Rendimento 1g", "prezzo"), "ret_3d": ("Rendimento 3g", "prezzo"), "ret_7d": ("Rendimento 7g", "prezzo"),
    "ret_14d": ("Rendimento 14g", "prezzo"), "ret_30d": ("Rendimento 30g", "prezzo"), "ret_60d": ("Rendimento 60g", "prezzo"),
    "ret_90d": ("Rendimento 90g", "prezzo"), "ret_180d": ("Rendimento 180g", "prezzo"), "ret_365d": ("Rendimento 1 anno", "prezzo"),
    "rsi_14": ("RSI 14", "prezzo"), "mayer": ("Mayer multiple", "prezzo"), "dist_ma50": ("Distanza da MA 50", "prezzo"),
    "ma50_200": ("MA 50 / MA 200", "prezzo"), "ma200_slope": ("Pendenza MA 200 (30g)", "prezzo"),
    "dist_ma200w": ("Distanza da MA 200 sett.", "prezzo"), "z_365": ("Z-score prezzo vs media 1 anno", "prezzo"),
    # volatilità
    "vol_7d": ("Volatilità 7g", "volatilità"), "vol_30d": ("Volatilità 30g", "volatilità"), "vol_90d": ("Volatilità 90g", "volatilità"),
    "vol_ratio": ("Volatilità 7g / 90g", "volatilità"), "pk_vol_14": ("Volatilità range (Parkinson) 14g", "volatilità"),
    "skew_90": ("Asimmetria rendimenti 90g", "volatilità"), "maxdd_30": ("Max drawdown 30g", "volatilità"),
    # ciclo
    "dd_ath": ("Drawdown dall'ATH", "ciclo"), "days_ath": ("Giorni dall'ATH", "ciclo"),
    "days_low": ("Giorni dal minimo di ciclo", "ciclo"), "rally_low": ("Rialzo dal minimo di ciclo", "ciclo"),
    "days_halving": ("Giorni dall'halving", "ciclo"), "halv_sin": ("Fase halving (sin)", "ciclo"),
    "halv_cos": ("Fase halving (cos)", "ciclo"), "pl_resid": ("Residuo power law (walk-forward)", "ciclo"),
    # on-chain
    "mvrv": ("MVRV", "on-chain"), "mvrv_z": ("MVRV Z-score", "on-chain"), "nupl": ("NUPL", "on-chain"),
    "puell": ("Puell multiple", "on-chain"), "hash_ribbon": ("Hash ribbon (MA30/MA60)", "on-chain"),
    "hash_g90": ("Crescita hashrate 90g", "on-chain"), "adr_rel": ("Indirizzi attivi vs media 1 anno", "on-chain"),
    "tx_rel": ("Transazioni vs media 1 anno", "on-chain"), "rcap_g30": ("Crescita realized cap 30g", "on-chain"),
    "sth_dist": ("Distanza dal costo STH", "on-chain"), "lth_dist": ("Distanza dal costo LTH", "on-chain"),
    "sth_sopr": ("SOPR STH (7g)", "on-chain"),
    # derivati / flussi
    "funding": ("Funding giornaliero", "derivati"), "funding_7d": ("Funding media 7g", "derivati"),
    "funding_30d": ("Funding media 30g", "derivati"), "funding_z": ("Funding z-score (1 anno)", "derivati"),
    "perp_spot": ("Volumi perp / spot (7g)", "derivati"), "taker_fut": ("Taker buy futures (7g)", "derivati"),
    "taker_spot": ("Taker buy spot (7g)", "derivati"), "cb_prem": ("Premio Coinbase (7g)", "derivati"),
    # stablecoin
    "usdt_30d": ("Var. 30g market cap USDT", "stablecoin"), "stables_30d": ("Var. 30g stablecoin totali", "stablecoin"),
    "ssr": ("Stablecoin supply ratio (log)", "stablecoin"), "ssr_z": ("SSR z-score (1 anno)", "stablecoin"),
    # macro
    "dxy_30d": ("Dollaro (DXY) 30g", "macro"), "us10y_30d": ("Var. Treasury 10 anni 30g", "macro"),
    "vix": ("VIX", "macro"), "spx_30d": ("S&P 500 30g", "macro"), "spx_ma200": ("S&P 500 vs MA 200", "macro"),
    "ndx_30d": ("Nasdaq 100 30g", "macro"), "gold_30d": ("Oro 30g", "macro"), "corr_spx": ("Correlazione BTC–S&P 500 (120g)", "macro"),
    # opzioni / sentiment / altro
    "dvol": ("DVOL (vol. implicita)", "opzioni"), "dvol_rv": ("DVOL / vol. realizzata", "opzioni"),
    "fng": ("Fear & Greed", "sentiment"), "fng_7d": ("Fear & Greed media 7g", "sentiment"),
    "fng_chg": ("Var. Fear & Greed 14g", "sentiment"), "ethbtc_30d": ("ETH/BTC 30g", "sentiment"),
    "month_sin": ("Stagionalità mese (sin)", "stagionalità"), "month_cos": ("Stagionalità mese (cos)", "stagionalità"),
    "halv_year": ("Anno del ciclo di halving", "stagionalità"),
    # indicatori tecnici classici (OHLCV giornaliero Bitstamp, point-in-time)
    "ichi_cloud": ("Distanza dalla nuvola Ichimoku", "tecnici"), "ichi_tk": ("Ichimoku Tenkan/Kijun", "tecnici"),
    "aroon_up": ("Aroon up 25", "tecnici"), "aroon_dn": ("Aroon down 25", "tecnici"), "aroon_osc": ("Oscillatore Aroon 25", "tecnici"),
    "chop": ("Choppiness index 14", "tecnici"), "stoch_rsi": ("Stochastic RSI 14", "tecnici"), "kdj_j": ("KDJ (linea J)", "tecnici"),
    "willr": ("Williams %R 14", "tecnici"), "obv_slope": ("Pendenza OBV 20g", "tecnici"), "cmf": ("Chaikin Money Flow 20", "tecnici"),
    "donch_pos": ("Posizione nel canale di Donchian 20", "tecnici"), "kelt_pos": ("Posizione nel canale di Keltner 20", "tecnici"),
    "adx": ("ADX 14", "tecnici"), "dmi": ("DMI (+DI − −DI)", "tecnici"), "ha_streak": ("Serie candele Heikin-Ashi", "tecnici"),
}
TECH_KEYS = [k for k, v in FEATURES.items() if v[1] == "tecnici"]
FEATURE_KEYS = list(FEATURES)
LABELS = {k: v[0] for k, v in FEATURES.items()}


def _ds(name: str) -> pd.DataFrame | None:
    """Dataset dallo store (con refresh) o, in modalità offline / non registrato, dal parquet su disco."""
    if not OFFLINE and name in store.REGISTRY:
        try:
            return store.get(name)
        except Exception as e:  # noqa: BLE001
            log.warning("dataset %s non disponibile: %s", name, e)
    p = store.DATA_DIR / f"{name}.parquet"
    if p.exists():
        try:
            return pd.read_parquet(p)
        except Exception:  # noqa: BLE001
            return None
    return None


def _daily(df: pd.DataFrame | None, cols, how="last") -> pd.DataFrame | None:
    if df is None or not len(df):
        return None
    d = df.copy()
    d["time"] = pd.to_datetime(d["time"], utc=True).dt.tz_convert(None).dt.normalize()
    g = d.groupby("time")[cols]
    return g.mean() if how == "mean" else (g.sum() if how == "sum" else g.last())


def daily_close() -> pd.Series:
    """Chiusura giornaliera composita: CoinMetrics PriceUSD (2010→) + Binance 1d (2017→, include oggi)."""
    oc = _ds("onchain")[["time", "PriceUSD"]].dropna()
    s_oc = pd.Series(oc["PriceUSD"].to_numpy(float),
                     index=pd.to_datetime(oc["time"], utc=True).dt.normalize().dt.tz_convert(None))
    k = _ds("k_1d")
    s_k = pd.Series(k["close"].to_numpy(float),
                    index=pd.to_datetime(k["time"], utc=True).dt.normalize().dt.tz_convert(None))
    s = pd.concat([s_oc[s_oc.index < s_k.index[0]], s_k])
    s = s[~s.index.duplicated(keep="last")].sort_index()
    s = s[s > 0]
    return s.asfreq("D").ffill()


def _rsi(close: pd.Series, n=14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def _power_law_resid(close: pd.Series, refit: int = 30) -> pd.Series:
    """log10(prezzo) − fair power law, con fit OLS ricalcolato ogni `refit` giorni SOLO sui dati passati."""
    x = np.log10(np.maximum((close.index - GENESIS).days.to_numpy(float), 1.0))
    y = np.log10(close.to_numpy(float))
    cx, cy, cxx, cxy = np.cumsum(x), np.cumsum(y), np.cumsum(x * x), np.cumsum(x * y)
    out = np.full(len(y), np.nan)
    i = 365
    while i < len(y):
        n = i  # punti 0..i-1
        sx, sy, sxx, sxy = cx[n - 1], cy[n - 1], cxx[n - 1], cxy[n - 1]
        b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
        a = (sy - b * sx) / n
        j = min(i + refit, len(y))
        out[i:j] = y[i:j] - (a + b * x[i:j])
        i = j
    return pd.Series(out, index=close.index)


def _technical(idx: pd.DatetimeIndex) -> dict[str, pd.Series]:
    """Indicatori tecnici classici da OHLCV giornaliero (Bitstamp 2011→, candela di oggi parziale)."""
    d = _daily(_ds("daily"), ["open", "high", "low", "close", "volume"])
    if d is None:
        return {}
    d = d[(d["high"] > d["low"]) & (d.index >= "2011-08-01")].reindex(idx)
    o, h, l, c, v = (d[k] for k in ("open", "high", "low", "close", "volume"))
    out: dict[str, pd.Series] = {}
    mid = lambda n: (h.rolling(n).max() + l.rolling(n).min()) / 2  # noqa: E731
    tenkan, kijun = mid(9), mid(26)
    span_a, span_b = ((tenkan + kijun) / 2).shift(26), mid(52).shift(26)
    top, bot = np.maximum(span_a, span_b), np.minimum(span_a, span_b)
    out["ichi_cloud"] = np.where(c > top, np.log(c / top), np.where(c < bot, np.log(c / bot), 0.0))
    out["ichi_cloud"] = pd.Series(out["ichi_cloud"], index=idx).where(top.notna())
    out["ichi_tk"] = np.log(tenkan / kijun)
    n = 25
    out["aroon_up"] = h.rolling(n + 1).apply(np.argmax, raw=True) / n * 100
    out["aroon_dn"] = l.rolling(n + 1).apply(np.argmin, raw=True) / n * 100
    out["aroon_osc"] = out["aroon_up"] - out["aroon_dn"]
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    out["chop"] = 100 * np.log10(tr.rolling(14).sum() / (h.rolling(14).max() - l.rolling(14).min())) / np.log10(14)
    rsi = _rsi(c)
    out["stoch_rsi"] = (rsi - rsi.rolling(14).min()) / (rsi.rolling(14).max() - rsi.rolling(14).min())
    rsv = (c - l.rolling(9).min()) / (h.rolling(9).max() - l.rolling(9).min()) * 100
    kk = rsv.ewm(alpha=1 / 3, adjust=False).mean()
    dd = kk.ewm(alpha=1 / 3, adjust=False).mean()
    out["kdj_j"] = 3 * kk - 2 * dd
    out["willr"] = (h.rolling(14).max() - c) / (h.rolling(14).max() - l.rolling(14).min()) * -100
    vv = v.fillna(0)
    obv = (np.sign(c.diff()).fillna(0) * vv).cumsum()
    out["obv_slope"] = (obv - obv.shift(20)) / vv.rolling(20).sum().replace(0, np.nan)
    mfm = ((c - l) - (h - c)) / (h - l)
    out["cmf"] = (mfm * vv).rolling(20).sum() / vv.rolling(20).sum().replace(0, np.nan)
    out["donch_pos"] = (c - l.rolling(20).min()) / (h.rolling(20).max() - l.rolling(20).min())
    atr = tr.ewm(alpha=1 / 14, adjust=False).mean()
    out["kelt_pos"] = (c - c.ewm(span=20, adjust=False).mean()) / (2 * atr)
    up, dn = h.diff(), -l.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=idx)
    ndm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=idx)
    pdi = 100 * pdm.ewm(alpha=1 / 14, adjust=False).mean() / atr
    ndi = 100 * ndm.ewm(alpha=1 / 14, adjust=False).mean() / atr
    dx = 100 * (pdi - ndi).abs() / (pdi + ndi)
    out["adx"] = dx.ewm(alpha=1 / 14, adjust=False).mean()
    out["dmi"] = pdi - ndi
    ha_c = (o + h + l + c) / 4
    ha_o = ha_c.copy()
    hc, ho = ha_c.to_numpy(), np.full(len(idx), np.nan)
    oo, cc = o.to_numpy(), c.to_numpy()
    for i in range(len(idx)):
        if np.isnan(hc[i]):
            continue
        ho[i] = (oo[i] + cc[i]) / 2 if i == 0 or np.isnan(ho[i - 1]) else (ho[i - 1] + hc[i - 1]) / 2
    sign = np.sign(hc - ho)
    streak = np.zeros(len(idx))
    for i in range(1, len(idx)):
        if np.isnan(sign[i]):
            streak[i] = np.nan
        elif sign[i] != 0 and sign[i] == np.sign(streak[i - 1] if np.isfinite(streak[i - 1]) else 0):
            streak[i] = streak[i - 1] + sign[i]
        else:
            streak[i] = sign[i]
    out["ha_streak"] = pd.Series(streak, index=idx)
    _ = ha_o
    return {k: (vv_ if isinstance(vv_, pd.Series) else pd.Series(vv_, index=idx)) for k, vv_ in out.items()}


def build(close: pd.Series | None = None) -> pd.DataFrame:
    """DataFrame indicizzato per giorno (naive UTC) con `close` + tutte le FEATURE_KEYS (NaN dove non disponibili)."""
    if close is None:
        close = daily_close()
    idx = close.index
    lc = np.log(close)
    r = lc.diff()
    f: dict[str, pd.Series] = {}

    def put(s, name, lag=0, limit=5):
        if s is None:
            f[name] = pd.Series(np.nan, index=idx)
            return
        s = s[~s.index.duplicated(keep="last")].sort_index()
        s = s.reindex(s.index.union(idx)).ffill(limit=limit).reindex(idx)
        f[name] = s.shift(lag) if lag else s

    # ---------------- prezzo / momentum
    for n in (1, 3, 7, 14, 30, 60, 90, 180, 365):
        f[f"ret_{n}d"] = lc - lc.shift(n)
    f["rsi_14"] = _rsi(close)
    ma50, ma200 = close.rolling(50).mean(), close.rolling(200).mean()
    f["mayer"] = close / ma200
    f["dist_ma50"] = np.log(close / ma50)
    f["ma50_200"] = np.log(ma50 / ma200)
    f["ma200_slope"] = np.log(ma200 / ma200.shift(30))
    f["dist_ma200w"] = np.log(close / close.rolling(1400, min_periods=700).mean())
    f["z_365"] = (lc - lc.rolling(365).mean()) / lc.rolling(365).std()
    # ---------------- volatilità
    f["vol_7d"] = r.rolling(7).std() * np.sqrt(365)
    f["vol_30d"] = r.rolling(30).std() * np.sqrt(365)
    f["vol_90d"] = r.rolling(90).std() * np.sqrt(365)
    f["vol_ratio"] = np.log(f["vol_7d"] / f["vol_90d"])
    f["skew_90"] = r.rolling(90).skew()
    f["maxdd_30"] = lc - lc.rolling(30).max()
    dd = _daily(_ds("daily"), ["high", "low"])
    if dd is not None:
        hl = np.log(dd["high"] / dd["low"]).where(dd["high"] > dd["low"])
        pk = np.sqrt((hl ** 2).rolling(14, min_periods=10).mean() / (4 * np.log(2))) * np.sqrt(365)
        put(pk, "pk_vol_14", limit=2)
    else:
        put(None, "pk_vol_14")
    # ---------------- ciclo
    ath = close.cummax()
    f["dd_ath"] = np.log(close / ath)
    pos = np.arange(len(close), dtype=float)
    is_ath = close.to_numpy() >= ath.to_numpy()
    last_ath = pd.Series(np.where(is_ath, pos, np.nan), index=idx).ffill().to_numpy()
    f["days_ath"] = pd.Series(pos - last_ath, index=idx)
    # minimo dopo l'ultimo ATH (minimo del ciclo corrente)
    lows = np.empty(len(close))
    low_pos = np.empty(len(close))
    cv = close.to_numpy()
    cur_low, cur_pos = cv[0], 0
    for i in range(len(cv)):
        if is_ath[i] or cv[i] < cur_low:
            cur_low, cur_pos = cv[i], i
        lows[i], low_pos[i] = cur_low, cur_pos
    f["days_low"] = pd.Series(pos - low_pos, index=idx)
    f["rally_low"] = pd.Series(np.log(cv / lows), index=idx)
    hv = HALVINGS.values
    k = np.searchsorted(hv, idx.values, side="right") - 1
    dh = (idx.values - hv[np.clip(k, 0, None)]).astype("timedelta64[D]").astype(float)
    f["days_halving"] = pd.Series(dh, index=idx)
    ph = 2 * np.pi * dh / 1458.0
    f["halv_sin"], f["halv_cos"] = pd.Series(np.sin(ph), index=idx), pd.Series(np.cos(ph), index=idx)
    f["halv_year"] = pd.Series(np.floor(np.minimum(dh, 1457) / 365.25), index=idx)
    f["pl_resid"] = _power_law_resid(close)
    # ---------------- on-chain (CoinMetrics, +1 g)
    oc = _daily(_ds("onchain"), ["CapMrktCurUSD", "CapMVRVCur", "HashRate", "AdrActCnt", "TxCnt", "SplyCur", "IssTotUSD"])
    if oc is not None:
        oc = oc.reindex(oc.index.union(idx)).ffill(limit=5).reindex(idx).shift(1)
        rcap = oc["CapMrktCurUSD"] / oc["CapMVRVCur"]
        supply = oc["SplyCur"]
        mcap_now = close * supply                         # market cap al prezzo di oggi, offerta di ieri
        f["mvrv"] = mcap_now / rcap
        f["mvrv_z"] = (mcap_now - rcap) / oc["CapMrktCurUSD"].expanding(365).std()
        f["nupl"] = 1 - rcap / mcap_now
        f["puell"] = np.log(oc["IssTotUSD"] / oc["IssTotUSD"].rolling(365, min_periods=200).mean())
        hr = oc["HashRate"]
        f["hash_ribbon"] = np.log(hr.rolling(30).mean() / hr.rolling(60).mean())
        hr30 = hr.rolling(30).mean()
        f["hash_g90"] = np.log(hr30 / hr30.shift(90))
        f["adr_rel"] = np.log(oc["AdrActCnt"].rolling(30).mean() / oc["AdrActCnt"].rolling(365, min_periods=200).mean())
        f["tx_rel"] = np.log(oc["TxCnt"].rolling(30).mean() / oc["TxCnt"].rolling(365, min_periods=200).mean())
        f["rcap_g30"] = np.log(rcap / rcap.shift(30))
    else:
        mcap_now = None
        for c in ("mvrv", "mvrv_z", "nupl", "puell", "hash_ribbon", "hash_g90", "adr_rel", "tx_rel", "rcap_g30"):
            put(None, c)
    bg = _daily(_ds("pos_bgeo"), ["sth_rp", "lth_rp", "sth_sopr"])
    if bg is not None:
        bg = bg.reindex(bg.index.union(idx)).ffill(limit=5).reindex(idx).shift(7)
        f["sth_dist"] = np.log(close / bg["sth_rp"])
        f["lth_dist"] = np.log(close / bg["lth_rp"])
        f["sth_sopr"] = bg["sth_sopr"].rolling(7, min_periods=3).mean()
    else:
        for c in ("sth_dist", "lth_dist", "sth_sopr"):
            put(None, c)
    # ---------------- derivati
    fu = _daily(_ds("funding"), ["rate"], "mean")
    if fu is not None:
        put(fu["rate"] * 100, "funding", limit=3)
        f["funding_7d"] = f["funding"].rolling(7, min_periods=3).mean()
        f["funding_30d"] = f["funding"].rolling(30, min_periods=10).mean()
        f["funding_z"] = (f["funding_7d"] - f["funding_7d"].rolling(365, min_periods=90).mean()) / \
            f["funding_7d"].rolling(365, min_periods=90).std()
    else:
        for c in ("funding", "funding_7d", "funding_30d", "funding_z"):
            put(None, c)
    spot = _daily(_ds("k_1d"), ["volume", "taker_buy"])
    fut = _daily(_ds("fut_1d"), ["volume", "taker_buy"])
    if spot is not None:
        sv = spot.reindex(idx)
        f["taker_spot"] = (sv["taker_buy"].rolling(7, min_periods=5).sum() / sv["volume"].rolling(7, min_periods=5).sum()).shift(1)
    else:
        put(None, "taker_spot")
    if spot is not None and fut is not None:
        fv = fut.reindex(idx)
        f["perp_spot"] = np.log(fv["volume"].rolling(7, min_periods=5).sum() / sv["volume"].rolling(7, min_periods=5).sum()).shift(1)
        f["taker_fut"] = (fv["taker_buy"].rolling(7, min_periods=5).sum() / fv["volume"].rolling(7, min_periods=5).sum()).shift(1)
    else:
        put(None, "perp_spot")
        put(None, "taker_fut")
    cb = _daily(_ds("pos_cb_1d"), ["close"])
    if cb is not None:
        cbc = cb["close"].reindex(idx)
        f["cb_prem"] = (np.log(cbc / close) * 100).rolling(7, min_periods=4).mean()
    else:
        put(None, "cb_prem")
    # ---------------- stablecoin
    caps = _daily(_ds("caps"), ["usdt"])
    if caps is not None:
        u = caps["usdt"].reindex(caps.index.union(idx)).ffill(limit=5).reindex(idx).shift(1)
        f["usdt_30d"] = np.log(u / u.shift(30))
    else:
        put(None, "usdt_30d")
    st = _daily(_ds("stables_total"), ["total"])
    if st is not None:
        s = st["total"].reindex(st.index.union(idx)).ffill(limit=5).reindex(idx).shift(1)
        f["stables_30d"] = np.log(s / s.shift(30))
        if mcap_now is not None:
            ssr = np.log(mcap_now / s)
            f["ssr"] = ssr
            f["ssr_z"] = (ssr - ssr.rolling(365, min_periods=120).mean()) / ssr.rolling(365, min_periods=120).std()
        else:
            put(None, "ssr")
            put(None, "ssr_z")
    else:
        for c in ("stables_30d", "ssr", "ssr_z"):
            put(None, c)
    # ---------------- macro (giorni di borsa USA, riportati max 4 g)
    def macro(name):
        d = _daily(_ds(name), ["close"])
        if d is None:
            return None
        s = d["close"]
        return s.reindex(s.index.union(idx)).ffill(limit=4).reindex(idx)

    dxy, tnx, vix, spx, ndx, gold = (macro(f"macro_{k}") for k in ("dxy", "us10y", "vix", "spx", "ndx", "gold"))
    f["dxy_30d"] = np.log(dxy / dxy.shift(30)) if dxy is not None else np.nan
    f["us10y_30d"] = (tnx - tnx.shift(30)) if tnx is not None else np.nan
    f["vix"] = vix if vix is not None else np.nan
    f["spx_30d"] = np.log(spx / spx.shift(30)) if spx is not None else np.nan
    f["spx_ma200"] = np.log(spx / spx.rolling(280, min_periods=200).mean()) if spx is not None else np.nan
    f["ndx_30d"] = np.log(ndx / ndx.shift(30)) if ndx is not None else np.nan
    f["gold_30d"] = np.log(gold / gold.shift(30)) if gold is not None else np.nan
    if spx is not None:
        f["corr_spx"] = (lc - lc.shift(7)).rolling(120, min_periods=90).corr(np.log(spx / spx.shift(7)))
    else:
        f["corr_spx"] = np.nan
    # ---------------- opzioni / sentiment
    dv = _daily(_ds("pos_dvol"), ["close"])
    if dv is not None:
        put(dv["close"] / 100, "dvol", limit=3)
        f["dvol_rv"] = np.log(f["dvol"] / f["vol_30d"])
    else:
        put(None, "dvol")
        put(None, "dvol_rv")
    fg = _daily(_ds("fng"), ["value"])
    if fg is not None:
        put(fg["value"].astype(float), "fng", limit=3)
        f["fng_7d"] = f["fng"].rolling(7, min_periods=4).mean()
        f["fng_chg"] = f["fng_7d"] - f["fng_7d"].shift(14)
    else:
        for c in ("fng", "fng_7d", "fng_chg"):
            put(None, c)
    eb = _daily(_ds("ethbtc_1d"), ["ethbtc"])
    if eb is not None:
        e = eb["ethbtc"].reindex(eb.index.union(idx)).ffill(limit=3).reindex(idx)
        f["ethbtc_30d"] = np.log(e / e.shift(30))
    else:
        put(None, "ethbtc_30d")
    f.update(_technical(idx))
    m = idx.month.to_numpy()
    f["month_sin"] = pd.Series(np.sin(2 * np.pi * m / 12), index=idx)
    f["month_cos"] = pd.Series(np.cos(2 * np.pi * m / 12), index=idx)

    out = pd.DataFrame({"close": close})
    for k in FEATURE_KEYS:
        v = f.get(k, np.nan)
        out[k] = v if isinstance(v, pd.Series) else np.nan
    out[FEATURE_KEYS] = out[FEATURE_KEYS].astype(float).replace([np.inf, -np.inf], np.nan)
    return out


def regime_of(feat: pd.DataFrame) -> pd.Series:
    """Regime point-in-time: 'bull' (prezzo sopra MA200 crescente), 'bear' (sotto MA200 decrescente), altrimenti 'accumulation'."""
    above = feat["mayer"] > 1
    up = feat["ma200_slope"] > 0
    reg = np.where(above & up, "bull", np.where(~above & ~up, "bear", "accumulation"))
    return pd.Series(reg, index=feat.index)


REGIME_IT = {"bull": "Rialzista", "bear": "Ribassista", "accumulation": "Accumulo / transizione"}
