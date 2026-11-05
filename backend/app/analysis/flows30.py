"""Flussi a 30 giorni: pannelli giornalieri allineati sugli stessi giorni UTC chiusi.

Candele Binance perp · flusso netto ETF (Farside) · variazione USDT e USDC (DefiLlama) · BTC sugli exchange (Coin Metrics) ·
CVD cumulato perp e spot (taker Binance) · open interest (Binance + Bybit + OKX) e liquidazioni raccolte.

Il giorno corrente è escluso. L'ultima seduta ETF può essere rivista. Il CVD multi-exchange esiste solo dove la raccolta del Terminale
era accesa, per cui il pannello resta su Binance: una base uniforme su tutti i 30 giorni.
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .. import util
from ..data import store
from . import scoreboard as sb

log = logging.getLogger("flows30")
DAYS = 30


def closed_days(now: pd.Timestamp, n: int = DAYS) -> pd.DatetimeIndex:
    end = now.normalize() - pd.Timedelta(days=1)
    return pd.date_range(end - pd.Timedelta(days=n - 1), end, freq="D")


@util.ttl_cache(300)
def _daily_klines(url: str, day0: int, day1: int) -> pd.DataFrame:
    """Kline giornaliere ufficiali: valori in USD esatti e nessun buco se l'app è rimasta spenta."""
    from . import moves
    k = moves._klines(url, "1d", day0, day1 + 86400)
    k.index = pd.to_datetime(k["t"], unit="s", utc=True)
    return k


def taker_delta(d: pd.DataFrame) -> pd.Series:
    """Delta in USD per giorno: acquisti aggressivi meno vendite aggressive, dai controvalori della kline."""
    return 2 * d["tbq"] - d["qv"]


def supply_change(s: pd.Series, days: pd.DatetimeIndex) -> pd.Series:
    """Variazione giornaliera della supply: valore del giorno meno valore del giorno prima."""
    full = s.reindex(pd.date_range(days[0] - pd.Timedelta(days=1), days[-1], freq="D")).ffill()
    return full.diff().reindex(days)


def _oi_daily(days: pd.DatetimeIndex, close: pd.Series) -> tuple[pd.Series, pd.Series]:
    from . import aggregate
    cols = {"lev_binance_1d": ("oi_usdt", "oi_usdc", "oi_inverse"), "lev_bybit_1d": ("oi_usdt", "oi_usdc", "oi_inverse"), "lev_okx_1d": ("oi_usdt", "oi_inverse")}
    tot = None
    for name, cs in cols.items():
        d = aggregate._safe(name)
        if d.empty:
            return pd.Series(index=days, dtype=float), pd.Series(index=days, dtype=float)
        s = pd.Series(d[[c for c in cs if c in d]].sum(axis=1, min_count=1).to_numpy(float), index=pd.to_datetime(d["time"], utc=True).dt.normalize())
        s = s[~s.index.duplicated(keep="last")].reindex(days)
        tot = s if tot is None else tot + s
    return tot, tot * close


def _liq_daily(days: pd.DatetimeIndex) -> tuple[pd.Series, pd.Series, int]:
    from . import moves
    ev = store.liquidations()
    z = pd.Series(0.0, index=days)
    covered = sum(1 for d in days if moves.collection_share(d.timestamp(), d.timestamp() + 86400) >= 0.9)
    if ev is None or ev.empty:
        return z, z.copy(), covered
    ev = ev.assign(d=pd.to_datetime(ev["time"], utc=True).dt.normalize())
    g = ev.groupby(["d", "side"])["usd"].sum().unstack(fill_value=0.0)
    return (g.get("long", z).reindex(days).fillna(0.0), g.get("short", z).reindex(days).fillna(0.0), covered)


def _pts(days: pd.DatetimeIndex, s: pd.Series) -> list:
    return [util.num(s.get(d)) for d in days]


@util.ttl_cache(60)
def build() -> dict:
    now = pd.Timestamp.now(tz="UTC")
    days = closed_days(now)
    from . import moves
    span = (util.ts(days[0]), util.ts(days[-1]))
    fut = _daily_klines(moves.PERP_URL, *span).reindex(days)
    spot = _daily_klines(moves.SPOT_URL, *span).reindex(days)
    close = fut["c"]

    etf_all = sb.etf_reported()
    etf = etf_all.reindex(days)
    etf_last = etf.dropna().index[-1] if etf.notna().any() else None
    usdt = sb._col("usdt_supply", "usdt")
    usdc = sb._col("usdc_supply", "usdc")
    d_usdt, d_usdc = supply_change(usdt, days), supply_change(usdc, days)
    ex = sb.exchange_supply()
    ex_raw = sb._col("sd_exchange", "SplyExNtv")
    exd = ex.reindex(days)
    perp_d, spot_d = taker_delta(fut), taker_delta(spot)
    perp_c, spot_c = perp_d.cumsum(), spot_d.cumsum()
    oi_btc, oi_usd = _oi_daily(days, close)
    liq_l, liq_s, liq_days = _liq_daily(days)

    def first_last(s: pd.Series) -> tuple[float | None, float | None]:
        v = s.dropna()
        return (float(v.iloc[0]), float(v.iloc[-1])) if len(v) else (None, None)

    ex0, ex1 = first_last(exd)
    oi0, oi1 = first_last(oi_usd)
    ob0, ob1 = first_last(oi_btc)
    return util.clean({
        "days": [util.ts(d) for d in days], "from": util.ts(days[0]), "to": util.ts(days[-1]), "today_excluded": util.ts(now.normalize()),
        "candles": {k: _pts(days, fut[c]) for k, c in (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c"))},
        "etf": _pts(days, etf), "usdt": _pts(days, d_usdt), "usdc": _pts(days, d_usdc), "exchange": _pts(days, exd),
        "cvd_perp": _pts(days, perp_c), "cvd_spot": _pts(days, spot_c), "oi_usd": _pts(days, oi_usd), "oi_btc": _pts(days, oi_btc),
        "liq_long": _pts(days, liq_l), "liq_short": _pts(days, liq_s),
        "summary": {
            "price_from": float(fut["o"].dropna().iloc[0]), "price_to": float(close.dropna().iloc[-1]),
            "price_pct": (float(close.dropna().iloc[-1]) / float(fut["o"].dropna().iloc[0]) - 1) * 100,
            "etf_30d": float(etf.sum()), "etf_7d": float(etf.iloc[-7:].sum()), "etf_days": int(etf.notna().sum()),
            "etf_last": util.ts(etf_last) if etf_last is not None else None,
            "usdt_30d": float(d_usdt.sum()), "usdc_30d": float(d_usdc.sum()),
            "exchange_change": (ex1 - ex0) if ex0 is not None else None, "exchange_last": util.ts(exd.dropna().index[-1]) if exd.notna().any() else None,
            "exchange_dropped": bool(len(ex_raw) > len(ex)),
            "cvd_perp": float(perp_c.dropna().iloc[-1]), "cvd_spot": float(spot_c.dropna().iloc[-1]),
            "oi_from": oi0, "oi_to": oi1, "oi_btc_from": ob0, "oi_btc_to": ob1,
            "liq_long": float(liq_l.sum()), "liq_short": float(liq_s.sum()), "liq_days": liq_days,
        },
        "missing": {k: int(np.isnan(np.array(v, dtype=float)).sum()) for k, v in (("etf", _pts(days, etf)), ("exchange", _pts(days, exd)), ("oi", _pts(days, oi_usd)))},
    })
