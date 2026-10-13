"""Derivati: funding, open interest, long/short, basis + segnali testuali (IT)."""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store

log = logging.getLogger("derivatives")


def _pts(df: pd.DataFrame, col: str, scale: float = 1.0) -> list[dict]:
    if df is None or df.empty or col not in df:
        return []
    return util.series_pts(df["time"], df[col].astype(float) * scale)


@util.ttl_cache(30)
def _premium() -> dict | None:
    try:
        return src.futures_premium()
    except Exception as e:  # noqa: BLE001
        log.warning("premiumIndex non disponibile: %s", e)
        return None


@util.ttl_cache(30)
def _live_oi() -> float | None:
    try:
        return float(src.futures_open_interest()["openInterest"])
    except Exception:  # noqa: BLE001
        return None


def _safe(name: str) -> pd.DataFrame:
    try:
        return store.get(name)
    except Exception as e:  # noqa: BLE001
        log.warning("dataset %s non disponibile: %s", name, e)
        return pd.DataFrame()


def _change_over(df: pd.DataFrame, col: str, delta: pd.Timedelta) -> float | None:
    if df.empty:
        return None
    last_t = df["time"].iloc[-1]
    past = df[df["time"] <= last_t - delta]
    if past.empty:
        return None
    a, b = float(past[col].iloc[-1]), float(df[col].iloc[-1])
    return (b / a - 1) * 100 if a else None


def compute() -> dict:
    fund = _safe("funding")
    oi15 = _safe("oi_15m")
    oi1h = _safe("oi_1h")
    ls = _safe("ls")
    fut = _safe("fut_15m")

    # ------------------------------------------------------------ funding
    funding = {"current": None, "annualized": None, "series": [], "avg_7d": None, "avg_30d": None}
    if not fund.empty:
        f = fund.sort_values("time")
        rate = f["rate"].astype(float) * 100  # percent / 8h
        last_t = f["time"].iloc[-1]
        cur = float(rate.iloc[-1])
        try:  # funding corrente (in maturazione) dal premium index, come KPI e WebSocket
            cur = float(src.futures_premium()["lastFundingRate"]) * 100
        except Exception:  # noqa: BLE001
            pass
        recent = f["time"] >= last_t - pd.Timedelta(days=180)
        funding = {
            "current": cur,
            "annualized": cur * 3 * 365,
            "series": util.series_pts(f["time"][recent], rate[recent]),
            "avg_7d": float(rate[f["time"] > last_t - pd.Timedelta(days=7)].mean()),
            "avg_30d": float(rate[f["time"] > last_t - pd.Timedelta(days=30)].mean()),
        }

    # ------------------------------------------------------- open interest
    oi_src = oi15 if not oi15.empty else oi1h
    open_interest = {"current_usd": None, "change_24h": None, "series": []}
    if not oi_src.empty:
        cur_usd = float(oi_src["oi_usd"].iloc[-1])
        live = _live_oi()
        if live and not fut.empty:
            cur_usd = live * float(fut["close"].iloc[-1])
        open_interest = {
            "current_usd": cur_usd,
            "change_24h": _change_over(oi_src, "oi_usd", pd.Timedelta(hours=24)),
            "series": _pts(oi1h if not oi1h.empty else oi15, "oi_usd"),
        }

    # ---------------------------------------------------------- long/short
    long_short = {"accounts": [], "top_traders": [], "taker": [], "current_long_pct": None}
    if not ls.empty:
        long_short = {
            "accounts": _pts(ls, "ls_accounts"),
            "top_traders": _pts(ls, "ls_top"),
            "taker": _pts(ls, "taker_ratio"),
            "current_long_pct": float(ls["long_pct"].dropna().iloc[-1]) * 100 if ls["long_pct"].notna().any() else None,
        }

    # --------------------------------------------------------------- basis
    basis = {"mark": None, "index": None, "premium": None}
    p = _premium()
    if p:
        mark, index = float(p.get("markPrice") or 0), float(p.get("indexPrice") or 0)
        basis = {"mark": mark, "index": index, "premium": (mark / index - 1) * 100 if index else None}
    else:
        try:
            spot = float(store.get("k_1h")["close"].iloc[-1])
            mark = float(fut["close"].iloc[-1])
            basis = {"mark": mark, "index": spot, "premium": (mark / spot - 1) * 100}
        except Exception:  # noqa: BLE001
            pass

    price_chg_24h = _change_over(fut, "close", pd.Timedelta(hours=24)) if not fut.empty else None
    signals = _signals(funding, open_interest, long_short, basis, ls, price_chg_24h)
    return {"funding": funding, "open_interest": open_interest, "long_short": long_short, "basis": basis, "signals": signals}


def _signals(funding, oi, lsd, basis, ls: pd.DataFrame, price_chg) -> list[dict]:
    out: list[dict] = []

    def add(text, tone):
        out.append({"text": text, "tone": tone})

    fr = funding.get("current")
    if fr is not None:
        ann = funding["annualized"]
        if fr >= 0.05:
            add(f"Funding molto positivo ({fr:.3f}%/8h, {ann:.0f}% annuo): leva long affollata, rischio di long squeeze.", "bearish")
        elif fr >= 0.02:
            add(f"Funding sopra la media ({fr:.3f}%/8h): i long pagano un premio, sentiment rialzista ma acceso.", "neutral")
        elif fr <= -0.01:
            add(f"Funding negativo ({fr:.3f}%/8h): short affollati, possibile short squeeze.", "bullish")
        elif fr < 0.005:
            add(f"Funding neutro/basso ({fr:.4f}%/8h): leva scarica, nessun eccesso evidente.", "neutral")
        else:
            add(f"Funding nella norma ({fr:.4f}%/8h, baseline 0.01%).", "neutral")
        a7, a30 = funding.get("avg_7d"), funding.get("avg_30d")
        if a7 is not None and a30 is not None and a30 != 0:
            if a7 > a30 * 1.5 and a7 > 0.01:
                add(f"Funding medio 7g ({a7:.4f}%) in aumento rispetto alla media 30g ({a30:.4f}%): la leva long sta crescendo.", "neutral")
            elif a7 < a30 * 0.5:
                add(f"Funding medio 7g ({a7:.4f}%) in calo rispetto ai 30g ({a30:.4f}%): raffreddamento della leva.", "neutral")

    ch = oi.get("change_24h")
    if ch is not None and price_chg is not None:
        if ch > 3 and price_chg > 1:
            add(f"OI +{ch:.1f}% in 24h con prezzo +{price_chg:.1f}%: nuovi long aprono posizioni, trend supportato dalla leva.", "bullish")
        elif ch > 3 and price_chg < -1:
            add(f"OI +{ch:.1f}% in 24h con prezzo {price_chg:.1f}%: short aggressivi in ingresso (carburante per uno squeeze).", "bearish")
        elif ch < -3 and price_chg > 1:
            add(f"OI {ch:.1f}% con prezzo in salita: rialzo guidato da chiusura di short (short covering).", "neutral")
        elif ch < -3 and price_chg < -1:
            add(f"OI {ch:.1f}% con prezzo in calo: deleveraging/liquidazioni long in corso.", "bearish")
        elif ch > 3:
            add(f"OI in aumento (+{ch:.1f}% in 24h) a prezzo stabile: accumulo di leva, possibile movimento violento.", "neutral")
        else:
            add(f"Open interest stabile ({ch:+.1f}% in 24h).", "neutral")

    lp = lsd.get("current_long_pct")
    if lp is not None:
        if lp >= 70:
            add(f"{lp:.0f}% degli account è long: posizionamento retail molto sbilanciato (contrarian ribassista).", "bearish")
        elif lp >= 60:
            add(f"{lp:.0f}% degli account è long: retail sbilanciato al rialzo.", "neutral")
        elif lp <= 40:
            add(f"Solo {lp:.0f}% degli account è long: retail short-heavy (contrarian rialzista).", "bullish")
        else:
            add(f"Rapporto long/short account equilibrato ({lp:.0f}% long).", "neutral")
    if not ls.empty and "ls_top" in ls and "ls_accounts" in ls:
        top = ls["ls_top"].dropna()
        acc = ls["ls_accounts"].dropna()
        if len(top) and len(acc):
            t, a = float(top.iloc[-1]), float(acc.iloc[-1])
            if t < a * 0.85:
                add(f"Top trader meno long ({t:.2f}) del retail ({a:.2f}): lo smart money non segue la folla.", "bearish")
            elif t > a * 1.15:
                add(f"Top trader più long ({t:.2f}) del retail ({a:.2f}): lo smart money è posizionato al rialzo.", "bullish")
    if not ls.empty and "taker_ratio" in ls:
        tk = ls["taker_ratio"].dropna().tail(24)
        if len(tk):
            m = float(tk.mean())
            if m > 1.08:
                add(f"Taker buy/sell medio 24h {m:.2f}: pressione in acquisto a mercato.", "bullish")
            elif m < 0.92:
                add(f"Taker buy/sell medio 24h {m:.2f}: pressione in vendita a mercato.", "bearish")

    pr = basis.get("premium")
    if pr is not None:
        if pr > 0.1:
            add(f"Premium perpetuo +{pr:.3f}% sull'indice: domanda di leva long.", "neutral")
        elif pr < -0.05:
            add(f"Perpetuo a sconto ({pr:.3f}%) sullo spot: pressione short sui derivati.", "bullish" if (fr or 0) < 0 else "neutral")
    return out


@util.ttl_cache(30)
def build_cached() -> dict:
    return util.clean(compute())
