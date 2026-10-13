"""Sentiment contrarian: indice composito 0–100 (0 = paura massima, 100 = euforia) + backtest dei rendimenti successivi.

Componenti (punteggio 0–100, alto = avidità):
  fng       Fear & Greed (alternative.me)                     percentile mobile 4 anni, senza lookahead
  funding   funding perp Binance, media 7 giorni              percentile mobile
  flows     quota acquisti aggressivi sui perpetual, 7 giorni percentile mobile
  premium   Coinbase premium (BTC-USD vs Binance BTCUSDT), 7g percentile mobile (negativo = domanda USA debole)
  dvol      DVOL Deribit (invertito: volatilità alta = paura) percentile mobile
  ls        % account long Binance (storico breve, 30 g → si accumula)  percentile sullo storico disponibile
  skew      skew 25Δ 30 giorni (put − call)                   scala fissa: +12.5 punti → 0, −12.5 → 100
Il percentile al giorno t usa solo i dati fino a t (finestra mobile 1460 g, minimo 365 g; `ls` minimo 14 g).
Dataset registrati: pos_cb_1d (Coinbase BTC-USD daily, 2017→), pos_cb_1h (Coinbase BTC-USD hourly, ultimi 180 g → accumula).
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import httpx
import numpy as np
import pandas as pd

from .. import util
from ..data import store

log = logging.getLogger("sentiment")

COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD"
_client = httpx.Client(timeout=30, headers={"User-Agent": "btc-analyzer/1.0", "Accept": "application/json"})
WIN, MINP = 1460, 365


def _get(url: str, params: dict | None = None, retries: int = 4):
    for attempt in range(retries):
        try:
            r = _client.get(url, params=params)
            if r.status_code == 429:
                time.sleep(1 + attempt * 2)
                continue
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError:
            if attempt == retries - 1:
                raise
            time.sleep(0.5 + attempt)
    raise RuntimeError(f"GET fallita: {url}")


# ===================================================================== Coinbase

def _cb_candles(gran: int, start: int, end: int) -> pd.DataFrame:
    rows = []
    s = start
    while s < end:
        e = min(end, s + gran * 300)
        iso = lambda x: datetime.fromtimestamp(x, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
        batch = _get(f"{COINBASE}/candles", {"granularity": gran, "start": iso(s), "end": iso(e)})
        if isinstance(batch, list):
            rows.extend(batch)
        s = e
        time.sleep(0.15)
    if not rows:
        return pd.DataFrame(columns=["time", "close", "volume"])
    d = pd.DataFrame(rows, columns=["t", "low", "high", "open", "close", "volume"])
    d["time"] = pd.to_datetime(d["t"].astype("int64"), unit="s", utc=True)
    return d[["time", "close", "volume"]].astype({"close": float, "volume": float}).drop_duplicates("time").sort_values("time").reset_index(drop=True)


def _cb_refresher(gran: int, first_start: int):
    def fn(old):
        now = int(time.time())
        if old is not None and len(old) > 3:
            start = int(pd.Timestamp(old["time"].iloc[-3]).timestamp())
            new = _cb_candles(gran, start, now)
            o = old.copy()
            o["time"] = pd.to_datetime(o["time"], utc=True)
            return pd.concat([o, new]).drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)
        return _cb_candles(gran, first_start(), now)
    return fn


store.register("pos_cb_1d", _cb_refresher(86400, lambda: int(datetime(2017, 8, 1, tzinfo=timezone.utc).timestamp())), 1800)
store.register("pos_cb_1h", _cb_refresher(3600, lambda: int(time.time()) - 180 * 86400), 300)


@util.ttl_cache(20)
def premium_live() -> dict:
    """Premium istantaneo: ticker Coinbase BTC-USD vs ultimo prezzo Binance BTCUSDT."""
    try:
        from ..routers.market import live_price
        cb = float(_get(f"{COINBASE}/ticker")["price"])
        bn = live_price()
        if not bn:
            return {"coinbase": cb, "binance": None, "premium": None, "premium_usd": None}
        return {"coinbase": cb, "binance": bn, "premium": (cb / bn - 1) * 100, "premium_usd": cb - bn}
    except Exception as e:  # noqa: BLE001
        log.warning("premium live non disponibile: %s", e)
        return {"coinbase": None, "binance": None, "premium": None, "premium_usd": None}


# ===================================================================== serie giornaliere

def _daily(df: pd.DataFrame, col: str, how: str = "last") -> pd.Series:
    s = df.set_index(pd.to_datetime(df["time"], utc=True))[col].astype(float)
    return getattr(s.resample("1D"), how)().dropna()


def _premium_daily() -> pd.Series:
    cb = _daily(store.get("pos_cb_1d"), "close")
    bn = _daily(store.get("k_1d"), "close")
    p = ((cb / bn - 1) * 100).dropna()
    # le ultime settimane: media delle letture orarie (più robusta della sola chiusura)
    try:
        h = store.get("pos_cb_1h")
        cbh = h.set_index(pd.to_datetime(h["time"], utc=True))["close"].astype(float)
        k1h = store.get("k_1h").tail(24 * 200)
        bnh = k1h.set_index(pd.to_datetime(k1h["time"], utc=True))["close"].astype(float)
        ph = ((cbh / bnh - 1) * 100).dropna()
        pdh = ph.resample("1D").mean().dropna()
        pdh = pdh[pdh.index.isin(p.index) | (pdh.index > p.index[-1])]
        p = pd.concat([p[~p.index.isin(pdh.index)], pdh]).sort_index()
    except Exception as e:  # noqa: BLE001
        log.warning("premium orario non disponibile: %s", e)
    # outlier (candele mancanti/illiquide nei primi anni)
    return p[p.abs() < 5]


def _premium_hourly(days: int = 30) -> pd.Series:
    h = store.get("pos_cb_1h")
    cbh = h.set_index(pd.to_datetime(h["time"], utc=True))["close"].astype(float)
    k1h = store.get("k_1h").tail(24 * (days + 2))
    bnh = k1h.set_index(pd.to_datetime(k1h["time"], utc=True))["close"].astype(float)
    p = ((cbh / bnh - 1) * 100).dropna()
    return p[p.index >= p.index[-1] - pd.Timedelta(days=days)]


def _flows_perp() -> pd.Series:
    f = store.get("fut_1d")
    s = f.set_index(pd.to_datetime(f["time"], utc=True))
    buy = s["taker_buy"].rolling(7).sum()
    tot = s["volume"].rolling(7).sum()
    return (buy / tot * 100).dropna()


def _funding() -> pd.Series:
    f = store.get("funding")
    s = _daily(f.assign(rate=f["rate"] * 100), "rate", "mean")
    return s.rolling(7, min_periods=3).mean().dropna()


def _ls() -> pd.Series:
    d = store.get("ls")
    return _daily(d, "long_pct", "mean") * 100 if "long_pct" in d else pd.Series(dtype=float)


def _dvol() -> pd.Series:
    d = store.get("pos_dvol")
    return _daily(d, "close")


def _fng() -> pd.Series:
    return _daily(store.get("fng"), "value")


def _skew_hist() -> pd.Series:
    try:
        d = store.get("pos_opt_daily")
        return _daily(d, "skew_30d") if "skew_30d" in d else pd.Series(dtype=float)
    except Exception:  # noqa: BLE001
        return pd.Series(dtype=float)


def _roll_pct(s: pd.Series, minp: int = MINP) -> pd.Series:
    """Percentile (0–100) del valore al giorno t rispetto alla finestra mobile che termina in t (nessun lookahead)."""
    return (s.rolling(WIN, min_periods=minp).rank(pct=True) * 100).dropna()


def _skew_score(v):
    return np.clip(50 - 4 * np.asarray(v, dtype=float), 0, 100)


COMPONENTS = [
    # key, label, unità, invertito
    ("fng", "Fear & Greed", "indice", False),
    ("funding", "Funding perp (7g)", "% / 8h", False),
    ("flows", "Acquisti aggressivi perp (7g)", "% taker buy", False),
    ("premium", "Coinbase premium (7g)", "%", False),
    ("dvol", "Volatilità implicita (DVOL)", "punti", True),
    ("ls", "Account long Binance", "% long", False),
    ("skew", "Skew opzioni 25Δ 30g", "punti vol", None),
]


def _component_frames(skew_now: float | None, dvol_now: float | None, prem: pd.Series):
    raw: dict[str, pd.Series] = {}
    score: dict[str, pd.Series] = {}
    loaders = {"fng": _fng, "funding": _funding, "flows": _flows_perp, "dvol": _dvol, "ls": _ls}
    for k, fn in loaders.items():
        try:
            raw[k] = fn()
        except Exception as e:  # noqa: BLE001
            log.warning("componente %s non disponibile: %s", k, e)
            raw[k] = pd.Series(dtype=float)
    raw["premium"] = prem.rolling(7, min_periods=3).mean().dropna()
    sk = _skew_hist()
    today = pd.Timestamp.now(tz="UTC").normalize()
    if skew_now is not None:
        sk = pd.concat([sk[sk.index != today], pd.Series([skew_now], index=[today])]).sort_index()
    raw["skew"] = sk.dropna()
    if dvol_now is not None and len(raw["dvol"]):
        raw["dvol"] = pd.concat([raw["dvol"][raw["dvol"].index != today], pd.Series([dvol_now], index=[today])]).sort_index()
    for key, _l, _u, inv in COMPONENTS:
        s = raw[key]
        if s.empty:
            score[key] = s
        elif key == "skew":
            score[key] = pd.Series(_skew_score(s.to_numpy()), index=s.index)
        elif key == "ls":
            score[key] = _roll_pct(s, 14)
        else:
            p = _roll_pct(s)
            score[key] = 100 - p if inv else p
    return raw, score


# ===================================================================== backtest

FWD = (7, 30, 90)


def _bt_block(mask: pd.Series, fwd: dict[int, pd.Series]) -> dict:
    idx = mask[mask].index
    out: dict = {"days": int(len(idx))}
    # episodi: giorni segnale separati da almeno 7 giorni senza segnale
    if len(idx):
        gaps = np.diff(idx.asi8) / 86_400e9 if len(idx) > 1 else np.array([])
        out["episodes"] = int(1 + (gaps > 7).sum())
        out["last"] = util.ts(idx[-1])
    else:
        out["episodes"], out["last"] = 0, None
    for h in FWD:
        r = fwd[h].reindex(idx).dropna()
        ok = len(r) >= 5
        out[f"r{h}_median"] = float(r.median()) if ok else None
        out[f"r{h}_mean"] = float(r.mean()) if ok else None
        out[f"hit{h}"] = float((r > 0).mean() * 100) if ok else None
        out[f"n{h}"] = int(len(r))
    return out


ZONES = [(0, 25, "Paura estrema"), (25, 40, "Paura"), (40, 60, "Neutrale"), (60, 75, "Avidità"), (75, 100.01, "Euforia")]


def _zone(v: float | None) -> str:
    if v is None:
        return "n/d"
    return next(z[2] for z in ZONES if z[0] <= v < z[1])


@util.ttl_cache(300)
def _history() -> dict:
    """Parte pesante (serie, percentili, backtest): cache 5 minuti."""
    from . import options as opt
    try:
        s = opt.summary()
        skew_now, dvol_now = s.get("skew_30d"), s.get("dvol")
    except Exception as e:  # noqa: BLE001
        log.warning("opzioni non disponibili per il sentiment: %s", e)
        skew_now = dvol_now = None
    prem = _premium_daily()
    raw, score = _component_frames(skew_now, dvol_now, prem)

    sc = pd.DataFrame({k: v for k, v in score.items() if len(v)})
    sc.index = pd.to_datetime(sc.index, utc=True).normalize()
    sc = sc[~sc.index.duplicated(keep="last")].sort_index()
    n_av = sc.notna().sum(axis=1)
    comp = sc.mean(axis=1, skipna=True)[n_av >= 3]
    comp_s = comp.rolling(3, min_periods=1).mean()  # leggera media 3g contro il rumore giornaliero

    price = store.get("daily")
    px = price.set_index(pd.to_datetime(price["time"], utc=True))["close"].astype(float)
    px.index = px.index.normalize()
    px = px[~px.index.duplicated(keep="last")]
    fwd = {h: (px.shift(-h) / px - 1) * 100 for h in FWD}

    start = comp_s.index[0]
    base = pd.Series(True, index=px.index[px.index >= start])
    zones = []
    for lo, hi, label in ZONES:
        m = (comp_s >= lo) & (comp_s < hi)
        zones.append({"zone": label, "lo": lo, "hi": min(hi, 100), **_bt_block(m, fwd)})
    comp_bt = {"since": util.ts(start), "baseline": _bt_block(base, fwd), "zones": zones}

    comp_rows = []
    for key, label, _u, _inv in COMPONENTS:
        s = sc[key].dropna() if key in sc else pd.Series(dtype=float)
        if len(s) < 200:
            comp_rows.append({"key": key, "label": label, "since": util.ts(s.index[0]) if len(s) else None, "enough": False,
                              "fear": None, "greed": None})
            continue
        comp_rows.append({"key": key, "label": label, "since": util.ts(s.index[0]), "enough": True,
                          "fear": _bt_block(s <= 10, fwd), "greed": _bt_block(s >= 90, fwd)})

    return {"raw": raw, "score": sc, "composite": comp_s, "composite_bt": comp_bt, "component_bt": comp_rows,
            "premium": prem, "price": px}


def _p(s: pd.Series, step: int = 1, nd: int = 2) -> list[dict]:
    s = s.dropna()
    if step > 1:
        s = s.iloc[::-1].iloc[::step].iloc[::-1]
    return [{"time": util.ts(t), "value": round(float(v), nd)} for t, v in s.items()]


def _fmt_raw(key: str, v) -> str:
    if v is None or not np.isfinite(v):
        return "—"
    sg = lambda x, d: ("+" if x > 0 else "−" if x < 0 else "") + f"{abs(x):.{d}f}"  # noqa: E731
    return {
        "fng": f"{v:.0f}/100", "funding": f"{sg(v, 4)}%", "flows": f"{v:.1f}%", "premium": f"{sg(v, 3)}%",
        "dvol": f"{v:.1f}", "ls": f"{v:.1f}%", "skew": f"{sg(v, 1)} pt",
    }[key]


def _comp_text(key: str, sc: float, raw: float | None) -> str:
    fear = sc <= 25
    greed = sc >= 75
    t = {
        "fng": ("Indice Fear & Greed in zona di paura." if fear else "Indice Fear & Greed in zona di avidità." if greed else "Fear & Greed nella media storica."),
        "funding": ("Funding basso o negativo: gli short pagano, la leva rialzista è stata smontata." if fear else
                    "Funding elevato: i long pagano caro la leva, posizionamento affollato." if greed else "Funding nella norma."),
        "flows": ("Prevalgono le vendite aggressive sui perpetual." if fear else "Acquisti aggressivi con leva sopra la media." if greed else "Flussi perp equilibrati."),
        "premium": ("Coinbase sconta rispetto a Binance: domanda USA debole." if fear else "Premio Coinbase elevato: forte domanda USA/istituzionale." if greed else "Premio Coinbase nella norma."),
        "dvol": ("Volatilità implicita alta: il mercato paga per protezione." if fear else "Volatilità implicita compressa: compiacenza." if greed else "Volatilità implicita nella media."),
        "ls": ("Pochi account long rispetto alle ultime settimane." if fear else "Molti account retail long: posizionamento affollato." if greed else "Rapporto long/short nella media recente."),
        "skew": ("Put più care delle call: domanda di protezione." if fear else "Call più care delle put: euforia sulle opzioni." if greed else "Skew opzioni bilanciato."),
    }[key]
    return t


@util.ttl_cache(30)
def build() -> dict:
    h = _history()
    sc: pd.DataFrame = h["score"]
    comp: pd.Series = h["composite"]
    raw = h["raw"]
    cur = float(comp.iloc[-1])
    last_t = comp.index[-1]
    components = []
    for key, label, unit, _inv in COMPONENTS:
        s = sc[key].dropna() if key in sc else pd.Series(dtype=float)
        r = raw.get(key, pd.Series(dtype=float)).dropna()
        stale = len(s) == 0 or (last_t - s.index[-1]).days > 3
        v = None if stale else float(s.iloc[-1])
        rv = float(r.iloc[-1]) if len(r) else None
        components.append({
            "key": key, "label": label, "unit": unit, "score": v, "raw": rv, "raw_display": _fmt_raw(key, rv),
            "as_of": util.ts(s.index[-1]) if len(s) else None, "history_days": int(len(s)),
            "method": "scala fissa" if key == "skew" else "percentile" + (" (storico breve)" if key == "ls" else ""),
            "text": _comp_text(key, v, rv) if v is not None else "Dato non disponibile.",
            "in_composite": v is not None,
        })
    zone = _zone(cur)
    ch7 = cur - float(comp.iloc[-8]) if len(comp) > 8 else None
    # percentile del composito stesso (no lookahead, finestra intera)
    pctl = float((comp <= cur).mean() * 100)

    bt = h["composite_bt"]
    zrow = next((z for z in bt["zones"] if z["zone"] == zone), None)
    base = bt["baseline"]
    fear = bt["zones"][0]
    greed = bt["zones"][-1]
    act = [c for c in components if c["score"] is not None]
    lowest = sorted(act, key=lambda c: c["score"])[:2]
    highest = sorted(act, key=lambda c: -c["score"])[:2]
    expl = [
        f"Indice di sentiment {cur:.0f}/100 ({zone.lower()}): media dei percentili di {len(act)} componenti. "
        "In chiave contrarian la paura estrema è il classico segnale d'acquisto e l'euforia quello di prudenza: il backtest qui sotto misura quanto ha funzionato davvero.",
    ]
    if zrow and zrow.get("r30_median") is not None and base.get("r30_median") is not None:
        expl.append(f"Dal {util.data_it(bt['since'])}, nei giorni in zona '{zone.lower()}' il rendimento mediano a 30 giorni è stato "
                    f"{zrow['r30_median']:+.1f}% (positivo nel {zrow['hit30']:.0f}% dei casi) contro {base['r30_median']:+.1f}% di tutti i giorni.")
    if fear.get("r90_median") is not None:
        expl.append(f"Paura estrema (< 25): {fear['days']} giorni in {fear['episodes']} episodi, rendimento mediano a 90 giorni "
                    f"{fear['r90_median']:+.1f}%, positivo nel {fear['hit90']:.0f}% dei casi.")
    if greed.get("r90_median") is not None:
        expl.append(f"Euforia (≥ 75): {greed['days']} giorni, rendimento mediano a 90 giorni {greed['r90_median']:+.1f}% "
                    f"(positivo nel {greed['hit90']:.0f}%).")
    if lowest and highest:
        expl.append("Componenti più impaurite: " + ", ".join(f"{c['label']} ({c['score']:.0f})" for c in lowest)
                    + "; più avide: " + ", ".join(f"{c['label']} ({c['score']:.0f})" for c in highest) + ".")

    prem = h["premium"]
    p7 = prem.rolling(7, min_periods=3).mean().dropna()
    p_cur7 = float(p7.iloc[-1]) if len(p7) else None
    p_hist = p7[p7.index >= p7.index[-1] - pd.Timedelta(days=1460)]
    try:
        hourly = _premium_hourly(30)
    except Exception:  # noqa: BLE001
        hourly = pd.Series(dtype=float)
    live = premium_live()
    prem_text = None
    if p_cur7 is not None:
        pp = float((p_hist <= p_cur7).mean() * 100)
        prem_text = (f"Coinbase premium medio 7 giorni {p_cur7:+.3f}% ({pp:.0f}° percentile su 4 anni): "
                     + ("i compratori USA pagano meno che su Binance, domanda statunitense debole (spesso vicino ai minimi locali)." if p_cur7 < -0.05 else
                        "premio positivo: domanda USA/istituzionale sostenuta." if p_cur7 > 0.05 else "nessuna differenza significativa tra USA e offshore."))
    else:
        pp = None

    px = h["price"]
    comp_view = comp[comp.index >= comp.index[-1] - pd.Timedelta(days=365 * 8)]
    return util.clean({
        "current": {"value": cur, "zone": zone, "change_7d": ch7, "percentile": pctl, "as_of": util.ts(last_t),
                    "n_components": len(act)},
        "components": components,
        "explanation": expl,
        "history": {"composite": _p(comp_view, 1, 1), "price": _p(px[px.index >= comp_view.index[0]], 1, 0)},
        "backtest": {"since": bt["since"], "baseline": base, "zones": bt["zones"], "components": h["component_bt"],
                     "thresholds": {"composite_fear": 25, "composite_greed": 75, "component_fear": 10, "component_greed": 90}},
        "premium": {
            "live": live.get("premium"), "live_usd": live.get("premium_usd"), "coinbase": live.get("coinbase"), "binance": live.get("binance"),
            "avg_7d": p_cur7, "percentile_4y": pp, "text": prem_text,
            "daily": _p(p7[p7.index >= p7.index[-1] - pd.Timedelta(days=365 * 4)], 1, 4),
            "hourly": _p(hourly, 1, 4),
        },
        "note": ("Ogni componente è convertita in un punteggio 0–100 (0 = paura massima, 100 = euforia) con il percentile mobile su 4 anni "
                 "calcolato solo con i dati disponibili fino a quel giorno (nessun lookahead; minimo 1 anno di storico). DVOL è invertito "
                 "(volatilità alta = paura). Lo skew usa una scala fissa (+12.5 punti → 0, −12.5 → 100) e il rapporto long/short "
                 "il percentile sul breve storico disponibile da Binance (30 giorni, si accumula): entrambi entrano solo nelle letture recenti. "
                 "Indice = media delle componenti disponibili (minimo 3), media mobile 3 giorni. Backtest: rendimenti BTC a 7/30/90 giorni "
                 "dalla chiusura del giorno del segnale; 'episodi' = gruppi di giorni separati da almeno 7 giorni. I giorni consecutivi "
                 "sono correlati: il numero di episodi è la misura onesta del campione. Coinbase premium = Coinbase BTC-USD / Binance BTC-USDT − 1 "
                 "(include l'eventuale scostamento USDT/USD)."),
    })
