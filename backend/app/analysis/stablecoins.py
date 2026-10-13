"""Liquidità delle stablecoin: supply totale (DefiLlama), dominance delle stablecoin, Stablecoin Supply Ratio (SSR),
mint/burn e relazione tra emissione netta e rendimenti di BTC.

Registra due dataset aggiuntivi nello store:
  - "stables_total": supply totale delle stablecoin ancorate al dollaro (DefiLlama, giornaliera)
  - "eth_4h":        candele 4h ETHUSDT (Binance) usate per la stima intraday della USDT.D
"""
from __future__ import annotations

import logging
import time

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store

log = logging.getLogger("stablecoins")

LLAMA_URL = "https://stablecoins.llama.fi/stablecoincharts/all"
SINCE = pd.Timestamp("2020-01-01", tz="UTC")       # serie restituite (prima la supply era trascurabile)
SSR_WIN = 365                                      # finestra mobile per media/deviazione dell'SSR


# ================================================================== dataset

def _stables_total(old: pd.DataFrame | None) -> pd.DataFrame:
    rows = src._get(LLAMA_URL)
    out = []
    for r in rows:
        try:
            v = float((r.get("totalCirculatingUSD") or {}).get("peggedUSD") or 0)
            out.append((int(r["date"]), v))
        except (TypeError, ValueError, KeyError):
            continue
    df = pd.DataFrame(out, columns=["t", "total"])
    df["time"] = pd.to_datetime(df["t"], unit="s", utc=True).dt.normalize()
    df = df[df["total"] > 0].drop_duplicates("time", keep="last").sort_values("time")
    return df[["time", "total"]].reset_index(drop=True)


def _eth_4h(old: pd.DataFrame | None) -> pd.DataFrame:
    start = None
    if old is not None and len(old) > 2:
        start = int(old["time"].iloc[-2].timestamp() * 1000)  # ricarica l'ultima candela (aperta)
    return store._merge(old, src.binance_klines("4h", start, symbol="ETHUSDT"))


store.register("stables_total", _stables_total, 3 * 3600)
store.register("eth_4h", _eth_4h, 60)


# ================================================================== helper

def live_price() -> float | None:
    """Ultimo prezzo BTC dal ticker WebSocket condiviso (None se assente o vecchio)."""
    try:
        from ..routers.stream import hub
        tk = hub.last.get("ticker")
        if tk and tk.get("price") and time.time() - float(tk.get("time") or 0) < 180:
            return float(tk["price"])
    except Exception:  # noqa: BLE001
        pass
    return None


@util.ttl_cache(60)
def daily_frame() -> pd.DataFrame:
    """Frame giornaliero di usdt._frame() (USDT.D calibrata su CoinGecko) con l'ultima riga allineata al prezzo live."""
    from .usdt import _frame
    d, factor, _cal = _frame()
    d = d.copy()
    p = live_price()
    if p and len(d):
        i = d.index[-1]
        b0 = float(d.at[i, "btc"])
        if b0 > 0 and 0.8 < p / b0 < 1.25:
            r = p / b0
            cap_new = float(d.at[i, "btc_cap"]) * r
            d.at[i, "sum"] = float(d.at[i, "sum"]) - float(d.at[i, "btc_cap"]) + cap_new
            d.at[i, "btc_cap"] = cap_new
            d.at[i, "btc"] = p
            d.at[i, "total"] = float(d.at[i, "sum"]) * factor
            d.at[i, "usdt_d"] = float(d.at[i, "usdt"]) / float(d.at[i, "total"]) * 100
    d.attrs["live"] = bool(p)
    return d


def _usd(v: float) -> str:
    a = abs(v)
    s = "−" if v < 0 else ""
    if a >= 1e9:
        return f"{s}${a / 1e9:.1f} mld"
    if a >= 1e6:
        return f"{s}${a / 1e6:.0f} mln"
    return f"{s}${a:,.0f}"


def _sg(v: float | None, d: int = 1, suf: str = "%") -> str:
    if v is None or not np.isfinite(v):
        return "n/d"
    s = "+" if v > 0 else ("−" if v < 0 else "")
    return f"{s}{abs(v):.{d}f}{suf}"


# ================================================================== analisi

def compute() -> dict:
    st = store.get("stables_total").copy()
    st["time"] = pd.to_datetime(st["time"], utc=True).dt.normalize()
    d = daily_frame()
    df = d.set_index("time")[["btc", "btc_cap", "total", "usdt"]].join(
        st.set_index("time")["total"].rename("stables"), how="left")
    df["stables"] = df["stables"].ffill()       # DefiLlama può essere indietro di un giorno
    df = df.dropna(subset=["stables"])
    df = df[df["stables"] > 1e8]
    live = bool(d.attrs.get("live"))

    df["dominance"] = df["stables"] / df["total"] * 100
    df["ssr"] = df["btc_cap"] / df["stables"]
    roll = df["ssr"].rolling(SSR_WIN, min_periods=120)
    df["ssr_mid"] = roll.mean()
    df["ssr_sd"] = roll.std()
    df["ssr_z"] = (df["ssr"] - df["ssr_mid"]) / df["ssr_sd"]
    df["chg30"] = df["stables"].pct_change(30) * 100
    df["usdt_share"] = df["usdt"] / df["stables"] * 100

    last = df.iloc[-1]
    t_last = df.index[-1]

    def ago(col: str, days: int) -> float | None:
        p = df[df.index <= t_last - pd.Timedelta(days=days)]
        return float(p[col].iloc[-1]) if len(p) else None

    sup = float(last["stables"])
    net = {k: (sup - ago("stables", k)) if ago("stables", k) is not None else None for k in (7, 30, 90, 365)}
    pct = {k: (net[k] / (sup - net[k]) * 100) if net[k] is not None and sup - net[k] > 0 else None for k in net}
    ath = float(df["stables"].max())
    ath_t = df["stables"].idxmax()
    dom_30 = ago("dominance", 30)
    ssr_z = float(last["ssr_z"]) if np.isfinite(last["ssr_z"]) else None
    ssr_pct = float((df["ssr_z"].dropna() <= (ssr_z if ssr_z is not None else 0)).mean() * 100) if ssr_z is not None else None

    # ---- serie (dal 2020)
    s = df[df.index >= SINCE]
    secs = ((s.index - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy()
    series = []
    for t_, row in zip(secs, s.itertuples()):
        series.append({
            "time": int(t_), "supply": round(float(row.stables) / 1e6) * 1e6, "dominance": round(float(row.dominance), 3),
            "ssr": round(float(row.ssr), 3), "ssr_mid": util.num(round(row.ssr_mid, 3)) if np.isfinite(row.ssr_mid) else None,
            "ssr_sd": util.num(round(row.ssr_sd, 3)) if np.isfinite(row.ssr_sd) else None,
            "chg30": util.num(round(row.chg30, 2)) if np.isfinite(row.chg30) else None,
        })

    # ---- mint/burn settimanale (ultime 104 settimane, settimana chiusa la domenica)
    wk = df["stables"].resample("W-SUN").last()
    wnet = wk.diff().dropna().iloc[-104:]
    weekly = [{"time": util.ts(t_ - pd.Timedelta(days=6)), "value": round(float(v) / 1e6) * 1e6} for t_, v in wnet.items()]
    daily_net = df["stables"].diff().iloc[-90:]
    daily = [{"time": util.ts(t_), "value": round(float(v) / 1e6) * 1e6} for t_, v in daily_net.items() if np.isfinite(v)]

    # ---- emissione netta vs rendimenti BTC (settimanale, ultimi 4 anni)
    w = df[["stables", "btc"]].resample("W-SUN").last().dropna()
    w = w[w.index >= t_last - pd.Timedelta(days=4 * 365)]
    g = np.log(w["stables"]).diff(4) * 100          # crescita della supply a 4 settimane (%)
    rb = np.log(w["btc"]).diff(4) * 100             # rendimento BTC a 4 settimane (%)
    lead_lag = []
    for lag in range(-8, 9):
        # lag > 0: l'emissione di `lag` settimane prima anticipa il rendimento BTC
        c = rb.corr(g.shift(lag))
        lead_lag.append({"lag": lag, "corr": round(float(c), 3) if pd.notna(c) else None})
    valid = [x for x in lead_lag if x["corr"] is not None]
    best = max(valid, key=lambda x: abs(x["corr"])) if valid else {"lag": 0, "corr": None}
    contemporaneous = next((x["corr"] for x in lead_lag if x["lag"] == 0), None)

    # rendimento BTC a 30 giorni dopo fasi di forte / debole emissione (giornaliero, dal 2020)
    dd = df[df.index >= SINCE]
    fwd = (dd["btc"].shift(-30) / dd["btc"] - 1) * 100
    c30 = dd["chg30"]
    ok = fwd.notna() & c30.notna()
    q_hi, q_lo = c30[ok].quantile(0.67), c30[ok].quantile(0.33)
    def cond(mask):
        v = fwd[ok & mask]
        return {"n": int(len(v)), "median": round(float(v.median()), 2) if len(v) else None,
                "up_rate": round(float((v > 0).mean() * 100), 1) if len(v) else None}
    regimes = [
        {"key": "strong", "label": f"Emissione 30g forte (≥ {q_hi:+.1f}%)", **cond(c30 >= q_hi)},
        {"key": "mid", "label": "Emissione 30g intermedia", **cond((c30 < q_hi) & (c30 > q_lo))},
        {"key": "weak", "label": f"Emissione 30g debole (≤ {q_lo:+.1f}%)", **cond(c30 <= q_lo)},
    ]
    cur_c30 = float(last["chg30"]) if np.isfinite(last["chg30"]) else None
    cur_regime = None if cur_c30 is None else ("strong" if cur_c30 >= q_hi else "weak" if cur_c30 <= q_lo else "mid")

    # ---- interpretazioni
    cards = []
    near_ath = sup >= ath * 0.995
    tone_sup = "bullish" if (pct[30] or 0) > 1 else "bearish" if (pct[30] or 0) < -0.5 else "neutral"
    cards.append({
        "key": "supply", "title": "Supply totale delle stablecoin", "tone": tone_sup,
        "text": (f"La supply totale è {_usd(sup)}" + (" (massimo storico)" if near_ath else f", {_sg((sup / ath - 1) * 100)} dal massimo di {_usd(ath)}")
                 + f". In 30 giorni {_usd(net[30]) if net[30] is not None else 'n/d'} ({_sg(pct[30], 2)}), in 90 giorni {_sg(pct[90], 2)}. "
                 + ("Nuova liquidità in dollari sta entrando nell'ecosistema: carburante potenziale per gli acquisti." if tone_sup == "bullish"
                    else "Le stablecoin vengono riscattate: la liquidità esce dall'ecosistema crypto." if tone_sup == "bearish"
                    else "Supply sostanzialmente stabile: nessun impulso di liquidità rilevante.")),
    })
    if ssr_z is not None:
        tone_ssr = "bullish" if ssr_z <= -1 else "bearish" if ssr_z >= 1 else "neutral"
        cards.append({
            "key": "ssr", "title": "Stablecoin Supply Ratio", "tone": tone_ssr,
            "text": (f"SSR = cap BTC / supply stablecoin = {float(last['ssr']):.2f}, z-score {ssr_z:+.2f} rispetto alla media mobile "
                     f"di {SSR_WIN} giorni ({float(last['ssr_mid']):.2f}). "
                     + ("SSR basso: le stablecoin hanno un potere d'acquisto elevato rispetto a BTC (storicamente favorevole)." if tone_ssr == "bullish"
                        else "SSR alto: poca liquidità in stablecoin rispetto alla capitalizzazione di BTC (meno carburante per nuovi acquisti)." if tone_ssr == "bearish"
                        else "SSR in zona neutra: potere d'acquisto delle stablecoin in linea con l'ultimo anno.")),
        })
    if dom_30 is not None:
        dd30 = float(last["dominance"]) - dom_30
        tone_dom = "bearish" if dd30 > 0.3 else "bullish" if dd30 < -0.3 else "neutral"
        dom_txt = f"{float(last['dominance']):.2f}%"
        cards.append({
            "key": "dominance", "title": "Dominance delle stablecoin", "tone": tone_dom,
            "text": (f"Le stablecoin valgono {util.art(dom_txt)} della capitalizzazione crypto ({_sg(dd30, 2, ' pt')} in 30 giorni). "
                     + ("La quota sale: il mercato si sposta verso la liquidità (fase difensiva)." if tone_dom == "bearish"
                        else "La quota scende: la liquidità viene impiegata in asset rischiosi." if tone_dom == "bullish"
                        else "Quota stabile: nessuna rotazione marcata verso o dalla liquidità.")),
        })
    reg = next((r for r in regimes if r["key"] == cur_regime), None)
    if reg and reg["median"] is not None:
        cards.append({
            "key": "issuance", "title": "Emissione netta e BTC", "tone": "bullish" if reg["median"] > 1 else "bearish" if reg["median"] < -1 else "neutral",
            "text": (f"Crescita della supply a 30 giorni {_sg(cur_c30, 2)}: regime «{reg['label'].split(' (')[0].lower()}». Dal 2020, in questo regime "
                     f"BTC ha reso una mediana del {_sg(reg['median'])} nei 30 giorni successivi (positivo nel {reg['up_rate']:.0f}% dei casi, {reg['n']} giorni)."),
        })
    if best["corr"] is not None:
        bl = best["lag"]
        cards.append({
            "key": "leadlag", "title": "Anticipo dell'emissione", "tone": "neutral",
            "text": (f"Correlazione tra crescita della supply e rendimento BTC a 4 settimane: {contemporaneous:+.2f} in contemporanea; "
                     f"massima ({best['corr']:+.2f}) con lag {_sg(bl, 0, '')} settimane — "
                     + ("l'emissione tende ad anticipare BTC." if bl > 0 else "BTC tende a muoversi prima dell'emissione (le stablecoin seguono il prezzo)." if bl < 0
                        else "i due si muovono insieme senza un anticipo chiaro.") + " Correlazioni deboli: indicazione di contesto, non un segnale operativo."),
        })

    return {
        "generated_at": int(time.time()), "live": live,
        "current": {
            "supply": sup, "supply_ath": ath, "supply_ath_time": util.ts(ath_t), "at_ath": near_ath,
            "net_7d": net[7], "net_30d": net[30], "net_90d": net[90], "net_365d": net[365],
            "pct_7d": pct[7], "pct_30d": pct[30], "pct_90d": pct[90], "pct_365d": pct[365],
            "dominance": float(last["dominance"]), "dominance_change_30d": (float(last["dominance"]) - dom_30) if dom_30 is not None else None,
            "ssr": float(last["ssr"]), "ssr_mid": util.num(last["ssr_mid"]), "ssr_sd": util.num(last["ssr_sd"]), "ssr_z": ssr_z,
            "ssr_percentile": ssr_pct, "usdt_share": float(last["usdt_share"]), "btc_cap": float(last["btc_cap"]),
            "total_cap": float(last["total"]), "time": util.ts(t_last),
        },
        "series": series,
        "weekly_net": weekly,
        "daily_net": daily,
        "issuance": {
            "lead_lag": lead_lag, "best_lag": best["lag"], "best_corr": best["corr"], "corr_0": contemporaneous,
            "regimes": regimes, "current_regime": cur_regime, "current_chg30": cur_c30,
        },
        "interpretation": cards,
        "note": ("Supply totale = somma delle stablecoin ancorate al dollaro secondo DefiLlama (totalCirculatingUSD.peggedUSD). "
                 "Dominance = supply stablecoin / capitalizzazione crypto totale stimata (stessa ricostruzione calibrata su CoinGecko "
                 "della pagina USDT). SSR = capitalizzazione di BTC / supply stablecoin; bande = media mobile a 365 giorni ± 1 e 2 "
                 "deviazioni standard. Mint/burn = variazione netta della supply. Lead/lag su variazioni a 4 settimane degli ultimi 4 anni "
                 "(lag positivo = l'emissione anticipa BTC). L'ultimo punto usa il prezzo BTC live quando disponibile."),
    }


@util.ttl_cache(60)
def build_cached() -> dict:
    return util.clean(compute())
