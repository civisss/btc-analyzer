"""Flusso di acquisti/vendite aggressive: spot vs futures perpetual (taker buy/sell, delta, CVD)."""
from __future__ import annotations

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from .. import util
from ..data import store

router = APIRouter()

# tf -> (dataset spot, dataset futures, regola di resample)
SOURCES = {
    "1h": ("k_1h", "fut_1h", None),
    "4h": ("k_4h", "fut_1h", "4h"),
    "1d": ("k_1d", "fut_1d", None),
}
RANGES = {"1d": 1, "3d": 3, "7d": 7, "30d": 30, "90d": 90, "1y": 365, "3y": 1095}
WINDOWS = [("1h", 1 / 24), ("4h", 4 / 24), ("24h", 1), ("7d", 7), ("30d", 30)]


def _side(df: pd.DataFrame, prefix: str) -> pd.DataFrame:
    """Volumi in USD: acquisti aggressivi (taker buy) e vendite aggressive."""
    px = (df["high"] + df["low"] + df["close"]) / 3
    buy = df["taker_buy"] * px
    tot = df["volume"] * px
    return pd.DataFrame({f"{prefix}_buy": buy.to_numpy(), f"{prefix}_sell": (tot - buy).to_numpy()},
                        index=pd.DatetimeIndex(df["time"]))


def _resample(df: pd.DataFrame, rule: str | None) -> pd.DataFrame:
    if not rule:
        return df
    d = df.set_index("time")
    out = d.resample(rule, origin="epoch").agg({"open": "first", "high": "max", "low": "min", "close": "last",
                                                "volume": "sum", "taker_buy": "sum"}).dropna()
    return out.reset_index()


@util.ttl_cache(15)
def _frame(tf: str) -> pd.DataFrame:
    spot_name, fut_name, rule = SOURCES[tf]
    spot = store.get(spot_name)
    fut = _resample(store.get(fut_name), rule)
    s = _side(spot, "spot")
    f = _side(fut, "perp")
    df = s.join(f, how="inner")
    df["price"] = spot.set_index("time")["close"].reindex(df.index)
    return df.dropna()


def _windows(df: pd.DataFrame, tf_hours: float) -> list[dict]:
    out = []
    end = df.index[-1] + pd.Timedelta(hours=tf_hours)
    for label, days in WINDOWS:
        w = df[df.index >= end - pd.Timedelta(days=days)]
        if w.empty or (days * 24) < tf_hours:
            continue
        sb, ss, pb, ps = (float(w[c].sum()) for c in ("spot_buy", "spot_sell", "perp_buy", "perp_sell"))
        sv, pv = sb + ss, pb + ps
        p0 = float(w["price"].iloc[0])
        out.append({
            "label": label,
            "spot_delta": sb - ss, "perp_delta": pb - ps,
            "spot_buy_pct": sb / sv * 100 if sv else None, "perp_buy_pct": pb / pv * 100 if pv else None,
            "spot_volume": sv, "perp_volume": pv, "perp_spot_ratio": pv / sv if sv else None,
            "price_change": (float(w["price"].iloc[-1]) / p0 - 1) * 100 if p0 else None,
        })
    return out


def _fmt(x: float) -> str:
    a = abs(x)
    s = f"${a / 1e9:.2f}B" if a >= 1e9 else f"${a / 1e6:.0f}M" if a >= 1e6 else f"${a / 1e3:.0f}k"
    return ("+" if x >= 0 else "−") + s


def _signals(wins: list[dict]) -> tuple[list[dict], dict]:
    by = {w["label"]: w for w in wins}
    sig: list[dict] = []
    w = by.get("24h") or (wins[-1] if wins else None)
    cur = {"dominant": None, "bias": "neutral", "spot_buy_pct_24h": None, "perp_buy_pct_24h": None}
    if not w:
        return sig, cur
    sd, pdl, pc = w["spot_delta"], w["perp_delta"], w["price_change"] or 0
    cur.update(spot_buy_pct_24h=w["spot_buy_pct"], perp_buy_pct_24h=w["perp_buy_pct"],
               dominant="perp" if abs(pdl) > abs(sd) else "spot")
    if sd > 0 and pdl < 0:
        sig.append({"tone": "bullish", "text": f"24h: lo spot compra ({_fmt(sd)}) mentre i futures vendono ({_fmt(pdl)}): domanda organica, la leva è contro il movimento."})
    elif sd < 0 and pdl > 0:
        sig.append({"tone": "bearish", "text": f"24h: i futures comprano ({_fmt(pdl)}) ma lo spot vende ({_fmt(sd)}): spinta guidata dalla leva, meno sostenibile."})
    elif sd > 0 and pdl > 0:
        sig.append({"tone": "bullish", "text": f"24h: acquisti aggressivi sia sullo spot ({_fmt(sd)}) sia sui futures ({_fmt(pdl)})."})
    else:
        sig.append({"tone": "bearish", "text": f"24h: vendite aggressive sia sullo spot ({_fmt(sd)}) sia sui futures ({_fmt(pdl)})."})
    if pc > 0.5 and sd < 0:
        sig.append({"tone": "bearish", "text": f"Prezzo +{pc:.1f}% in 24h con CVD spot negativo: rialzo non confermato dagli acquisti spot."})
    elif pc < -0.5 and sd > 0:
        sig.append({"tone": "bullish", "text": f"Prezzo {pc:.1f}% in 24h ma lo spot assorbe le vendite (CVD spot positivo): possibile accumulo."})
    r = w["perp_spot_ratio"]
    if r:
        sig.append({"tone": "neutral", "text": f"Volume futures {r:.1f}× lo spot nelle 24h: "
                    + ("mercato dominato dai derivati." if r > 4 else "partecipazione spot significativa." if r < 2 else "rapporto nella norma.")})
    w7 = by.get("7d")
    if w7:
        if w7["spot_delta"] > 0 > w7["perp_delta"]:
            sig.append({"tone": "bullish", "text": f"7 giorni: accumulo spot ({_fmt(w7['spot_delta'])}) con futures in vendita netta."})
        elif w7["spot_delta"] < 0 < w7["perp_delta"]:
            sig.append({"tone": "bearish", "text": f"7 giorni: distribuzione spot ({_fmt(w7['spot_delta'])}) mentre i futures comprano."})
    score = sum(1 if s["tone"] == "bullish" else -1 if s["tone"] == "bearish" else 0 for s in sig)
    cur["bias"] = "bullish" if score > 0 else "bearish" if score < 0 else "neutral"
    return sig, cur


def build(tf: str = "1h", range: str = "7d", **_params) -> dict:  # noqa: A002
    if tf not in ("1h", "4h", "1d") or range not in RANGES:
        raise HTTPException(400, "Parametri non validi: tf 1h|4h|1d, range 1d|3d|7d|30d|90d|1y|3y")
    df = _frame(tf)
    tf_h = {"1h": 1, "4h": 4, "1d": 24}[tf]
    wins = _windows(_frame("1h"), 1)  # finestre sempre calcolate a 1h per precisione
    if not any(w["label"] == "30d" for w in wins):
        wins += [w for w in _windows(_frame("1d"), 24) if w["label"] == "30d"]
    sig, cur = _signals(wins)
    view = df[df.index >= df.index[-1] - pd.Timedelta(days=RANGES[range])]
    if len(view) > 1200:  # limite payload
        view = view.iloc[-1200:]
    sd = view["spot_buy"] - view["spot_sell"]
    pdl = view["perp_buy"] - view["perp_sell"]
    series = [
        {"time": util.ts(t), "price": p, "spot_buy": a, "spot_sell": b, "spot_delta": c, "perp_buy": d,
         "perp_sell": e, "perp_delta": f, "spot_cvd": g, "perp_cvd": h}
        for t, p, a, b, c, d, e, f, g, h in zip(view.index, view["price"], view["spot_buy"], view["spot_sell"], sd,
                                                view["perp_buy"], view["perp_sell"], pdl, sd.cumsum(), pdl.cumsum())
    ]
    corr = float(np.corrcoef(sd, pdl)[0, 1]) if len(view) > 10 else None
    return util.clean({
        "tf": tf, "range": range, "series": series, "windows": wins, "current": cur, "signals": sig,
        "delta_correlation": corr,
        "note": ("Volumi aggressivi (taker) su Binance BTC/USDT spot e perpetual USDⓈ-M, in USD. Delta = acquisti − vendite "
                 "a mercato; CVD = delta cumulato nel periodo. Spot = domanda 'reale', futures = posizionamento con leva."),
    })


@router.get("/flows")
def flows(tf: str = Query("1h"), range: str = Query("7d")):  # noqa: A002
    return build(tf=tf, range=range)
