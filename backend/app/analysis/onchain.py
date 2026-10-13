"""Metriche on-chain derivate dal dataset CoinMetrics (pura computazione)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def derive(oc: pd.DataFrame) -> pd.DataFrame:
    """Restituisce un DataFrame giornaliero (index=time) con le metriche derivate."""
    d = oc.copy()
    d["time"] = pd.DatetimeIndex(d["time"]).normalize()
    d = d.drop_duplicates("time", keep="last").set_index("time").sort_index()
    price = d["PriceUSD"]
    mcap = d["CapMrktCurUSD"]
    mvrv = d["CapMVRVCur"]
    out = pd.DataFrame(index=d.index)
    out["price"] = price
    out["mvrv"] = mvrv
    realized_cap = mcap / mvrv
    out["realized_cap"] = realized_cap
    out["realized_price"] = price / mvrv
    std = mcap.expanding(min_periods=365).std()
    out["mvrv_z"] = (mcap - realized_cap) / std
    out["hashrate"] = d["HashRate"] / 1e6  # TH/s -> EH/s
    out["active_addresses"] = d["AdrActCnt"]
    out["tx_count"] = d["TxCnt"]
    out["supply"] = d["SplyCur"]
    out["issuance_usd"] = d["IssTotUSD"]
    out["puell"] = d["IssTotUSD"] / d["IssTotUSD"].rolling(365, min_periods=300).mean()
    out["nupl"] = 1 - 1 / mvrv
    return out.replace([np.inf, -np.inf], np.nan)


def status_for(key: str, v: float, d: pd.DataFrame) -> tuple[str, str]:
    """(testo stato, tono) per ciascuna metrica."""
    if v is None or not np.isfinite(v):
        return "Dato non disponibile", "neutral"
    if key == "mvrv":
        if v < 1:
            return "Sottovalutato: zona di accumulo", "bullish"
        if v < 1.5:
            return "Vicino al costo medio: zona di valore", "bullish"
        if v < 2.4:
            return "Neutrale", "neutral"
        if v < 3.5:
            return "Surriscaldato", "bearish"
        return "Zona di massimo di ciclo", "bearish"
    if key == "mvrv_z":
        if v < 0:
            return "Zona di accumulo (sotto il valore realizzato)", "bullish"
        if v < 1.5:
            return ("Sottovalutato" if v < 0.8 else "Neutrale"), "bullish" if v < 0.8 else "neutral"
        if v < 3.5:
            return "Neutrale", "neutral"
        if v < 7:
            return "Euforia: rischio in aumento", "bearish"
        return "Zona di massimo di ciclo", "bearish"
    if key == "realized_price":
        p = d["price"].dropna().iloc[-1]
        diff = (p / v - 1) * 100
        if diff < 0:
            return f"{diff:+.0f}% vs prezzo realizzato · zona di accumulo", "bullish"
        if diff < 40:
            return f"Prezzo vicino al costo medio ({diff:+.0f}%)", "bullish"
        if diff < 150:
            return f"{diff:+.0f}% vs prezzo realizzato", "neutral"
        return f"Prezzo molto sopra il costo medio ({diff:+.0f}%)", "bearish"
    if key == "hashrate":
        h = d["hashrate"].dropna()
        ma30, ma60 = h.rolling(30).mean(), h.rolling(60).mean()
        if ma30.iloc[-1] < ma60.iloc[-1]:
            return "Hash ribbon negativo: capitolazione dei miner", "neutral"
        recent_cross = ((ma30 > ma60) & (ma30.shift(1) <= ma60.shift(1))).tail(30).any()
        if recent_cross:
            return "Hash ribbon: fine capitolazione (segnale d'acquisto)", "bullish"
        return "Hashrate in crescita", "bullish"
    if key in ("active_addresses", "tx_count"):
        s = d[key].dropna()
        r = s.tail(30).mean() / s.tail(365).mean() - 1
        name = "Attività" if key == "active_addresses" else "Transazioni"
        if r > 0.08:
            return f"{r * 100:+.0f}% vs media 1a", "bullish"
        if r < -0.08:
            return f"{r * 100:+.0f}% vs media 1a", "bearish"
        return f"{r * 100:+.0f}% vs media 1a", "neutral"
    if key == "supply":
        return f"{v / 21e6 * 100:.2f}% di 21M", "neutral"
    if key == "issuance_usd":
        s = d["issuance_usd"].dropna()
        r = s.tail(30).mean() / s.tail(365).mean() - 1
        return f"{r * 100:+.0f}% vs media 1a", "neutral"
    if key == "puell":
        if v < 0.5:
            return "Zona di accumulo: miner sotto stress", "bullish"
        if v < 0.8:
            return "Ricavi miner bassi", "bullish"
        if v < 1.5:
            return "Neutrale", "neutral"
        if v < 3.5:
            return "Ricavi miner elevati", "bearish"
        return "Zona di massimo di ciclo", "bearish"
    if key == "nupl":
        if v < 0:
            return "Capitolazione", "bullish"
        if v < 0.25:
            return "Speranza / Paura", "bullish"
        if v < 0.5:
            return "Ottimismo", "neutral"
        if v < 0.75:
            return "Fiducia / Negazione", "bearish"
        return "Euforia / Avidità", "bearish"
    return "", "neutral"


def display_for(key: str, v: float) -> str:
    if v is None or not np.isfinite(v):
        return "n/d"
    if key in ("mvrv", "puell"):
        return f"{v:.2f}"
    if key == "mvrv_z":
        return f"{v:.2f}"
    if key == "nupl":
        return f"{v:.2f} ({v * 100:.0f}%)"
    if key == "realized_price":
        return f"${v / 1000:,.1f}k" if v >= 1000 else f"${v:,.2f}"
    if key == "hashrate":
        return f"{v:,.0f} EH/s"
    if key in ("active_addresses", "tx_count"):
        return f"{v / 1e6:.2f}M" if v >= 1e6 else f"{v / 1e3:,.0f}k"
    if key == "supply":
        return f"{v / 1e6:.3f}M BTC"
    if key == "issuance_usd":
        return f"${v / 1e6:.1f}M/giorno"
    return f"{v:,.2f}"


LABELS = {
    "mvrv": "MVRV",
    "mvrv_z": "MVRV Z-Score",
    "realized_price": "Prezzo realizzato",
    "hashrate": "Hashrate",
    "active_addresses": "Indirizzi attivi",
    "tx_count": "Transazioni giornaliere",
    "supply": "Offerta circolante",
    "issuance_usd": "Emissione giornaliera (USD)",
    "puell": "Puell Multiple",
    "nupl": "NUPL (profitto/perdita netti non realizzati)",
}
