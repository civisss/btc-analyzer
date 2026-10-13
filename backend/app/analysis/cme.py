"""Posizionamento CME (CFTC Commitments of Traders — Traders in Financial Futures, solo futures).

Fonte: CFTC Public Reporting (Socrata) `gpe5-46if`, senza chiave.
  - Bitcoin CME (codice 133741, contratto da 5 BTC) dal 10 apr 2018
  - Micro Bitcoin CME (codice 133742, 0.1 BTC) dal 4 mag 2021 — mercato separato, mostrato a parte
Dato riferito al martedì, pubblicato di norma il venerdì successivo alle 15:30 ET (ritardo 3 giorni; slitta con le festività USA).
Verifica automatica: l'ultima settimana viene confrontata con il report testuale ufficiale CFTC (financial_lf.htm).
"""
from __future__ import annotations

import logging
import re
import shutil
import subprocess
from datetime import timedelta

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store

log = logging.getLogger("cme")

SOCRATA = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
TFF_TEXT = "https://www.cftc.gov/dea/futures/financial_lf.htm"
CODES = {"133741": ("btc", 5.0), "133742": ("micro", 0.1)}
FIELDS = {
    "oi": "open_interest_all",
    "dealer_long": "dealer_positions_long_all", "dealer_short": "dealer_positions_short_all", "dealer_spread": "dealer_positions_spread_all",
    "am_long": "asset_mgr_positions_long", "am_short": "asset_mgr_positions_short", "am_spread": "asset_mgr_positions_spread",
    "lev_long": "lev_money_positions_long", "lev_short": "lev_money_positions_short", "lev_spread": "lev_money_positions_spread",
    "other_long": "other_rept_positions_long", "other_short": "other_rept_positions_short", "other_spread": "other_rept_positions_spread",
    "nr_long": "nonrept_positions_long_all", "nr_short": "nonrept_positions_short_all",
    "traders": "traders_tot_all", "traders_lev_long": "traders_lev_money_long_all", "traders_lev_short": "traders_lev_money_short_all",
    "traders_am_long": "traders_asset_mgr_long_all", "traders_am_short": "traders_asset_mgr_short_all",
}
CATS = [("lev", "Leveraged funds"), ("am", "Asset manager"), ("dealer", "Dealer"), ("other", "Altri riportabili"), ("nr", "Non riportabili")]


def _refresh(old):
    frames = []
    for code, (market, _) in CODES.items():
        rows = src._get(SOCRATA, {"cftc_contract_market_code": code, "$order": "report_date_as_yyyy_mm_dd ASC", "$limit": 5000})
        if not rows:
            continue
        df = pd.DataFrame(rows)
        out = pd.DataFrame({"time": pd.to_datetime(df["report_date_as_yyyy_mm_dd"], utc=True), "market": market})
        for k, col in FIELDS.items():
            out[k] = pd.to_numeric(df[col], errors="coerce") if col in df else np.nan
        frames.append(out)
    if not frames:
        raise RuntimeError("CFTC: nessun dato")
    df = pd.concat(frames).sort_values(["market", "time"]).reset_index(drop=True)
    df["time"] = df["time"].astype("datetime64[ns, UTC]")
    return df


store.register("cot_cme", _refresh, 6 * 3600)


def _curl(url: str) -> str | None:
    exe = shutil.which("curl")
    if not exe:
        return None
    try:
        p = subprocess.run([exe, "-sfL", "--max-time", "30", url], capture_output=True, timeout=40)
        return p.stdout.decode("latin-1") if p.returncode == 0 and p.stdout else None
    except Exception:  # noqa: BLE001
        return None


@util.ttl_cache(6 * 3600)
def verify_text_report() -> dict | None:
    """Confronta l'ultima settimana con il report testuale ufficiale CFTC (Traders in Financial Futures, solo futures)."""
    try:
        r = src._client.get(TFF_TEXT, headers={"User-Agent": "Mozilla/5.0 btc-analyzer"}, timeout=30)
        r.raise_for_status()
        txt = r.text
    except Exception as e:  # noqa: BLE001
        # il CDN della CFTC a volte rifiuta il client Python (403 su qualunque user-agent) ma accetta curl
        txt = _curl(TFF_TEXT)
        if txt is None:
            log.warning("report testuale CFTC non disponibile: %s", e)
            return None
    i = txt.find("BITCOIN - CHICAGO MERCANTILE EXCHANGE")
    if i < 0:
        return None
    block = txt[i:i + 1500]
    m_oi = re.search(r"Open Interest is\s+([\d,]+)", block)
    m_date = re.search(r"Positions as of (\w+ \d{1,2}, \d{4})", txt[max(0, i - 3000):i])
    lines = block.splitlines()
    try:
        k = next(j for j, ln in enumerate(lines) if ln.strip().startswith("Positions"))
        nums = [int(x.replace(",", "")) for x in lines[k + 1].split()]
    except (StopIteration, ValueError):
        return None
    keys = ["dealer_long", "dealer_short", "dealer_spread", "am_long", "am_short", "am_spread", "lev_long", "lev_short", "lev_spread",
            "other_long", "other_short", "other_spread", "nr_long", "nr_short"]
    if len(nums) != len(keys) or not m_oi:
        return None
    out = dict(zip(keys, nums))
    out["oi"] = int(m_oi.group(1).replace(",", ""))
    out["date"] = pd.Timestamp(m_date.group(1), tz="UTC") if m_date else None
    return out


def _pctl(series: pd.Series, x: float) -> float | None:
    s = series.dropna()
    return float((s < x).mean() * 100) if len(s) > 10 else None


@util.ttl_cache(60)
def build() -> dict:
    df = store.get("cot_cme").copy()
    df["time"] = pd.to_datetime(df["time"], utc=True)
    btc = df[df["market"] == "btc"].sort_values("time").reset_index(drop=True)
    micro = df[df["market"] == "micro"].sort_values("time").reset_index(drop=True)
    if btc.empty:
        raise RuntimeError("COT CME vuoto")
    for c, _ in CATS:
        btc[f"{c}_net"] = btc[f"{c}_long"] - btc[f"{c}_short"]
    last, prev = btc.iloc[-1], btc.iloc[-2] if len(btc) > 1 else None
    report = last["time"]
    published = report + timedelta(days=3)  # venerdì 15:30 ET (di norma)
    next_report = report + timedelta(days=7)
    next_pub = published + timedelta(days=7)
    w3 = btc[btc["time"] >= report - pd.Timedelta(days=3 * 365)]
    cats = []
    for c, label in CATS:
        net = float(last[f"{c}_net"])
        cats.append({
            "id": c, "label": label, "long": float(last[f"{c}_long"]), "short": float(last[f"{c}_short"]),
            "spread": util.num(last.get(f"{c}_spread")), "net": net, "net_btc": net * 5,
            "net_change": net - float(prev[f"{c}_net"]) if prev is not None else None,
            "long_change": float(last[f"{c}_long"] - prev[f"{c}_long"]) if prev is not None else None,
            "short_change": float(last[f"{c}_short"] - prev[f"{c}_short"]) if prev is not None else None,
            "pct_oi_long": float(last[f"{c}_long"] / last["oi"] * 100), "pct_oi_short": float(last[f"{c}_short"] / last["oi"] * 100),
            "net_pctl_3y": _pctl(w3[f"{c}_net"], net),
        })
    micro_last = micro.iloc[-1] if len(micro) else None
    oi_btc = float(last["oi"]) * 5
    micro_btc = float(micro_last["oi"]) * 0.1 if micro_last is not None and micro_last["time"] == report else None
    oi_prev = float(prev["oi"]) if prev is not None else None
    ver = verify_text_report()
    verification = None
    if ver:
        same_week = ver.get("date") is not None and ver["date"].normalize() == report.normalize()
        diffs = {k: int(ver[k] - last[k]) for k in ("oi", "dealer_long", "dealer_short", "am_long", "am_short", "lev_long", "lev_short", "nr_long", "nr_short")}
        verification = {"report_date": util.ts(ver["date"]) if ver.get("date") is not None else None, "same_week": same_week,
                        "match": same_week and all(v == 0 for v in diffs.values()), "diffs": diffs, "source": TFF_TEXT}
    hist = {
        "oi_btc": util.series_pts(btc["time"], btc["oi"] * 5),
        "micro_oi_btc": util.series_pts(micro["time"], micro["oi"] * 0.1) if len(micro) else [],
        **{f"{c}_net": util.series_pts(btc["time"], btc[f"{c}_net"]) for c, _ in CATS},
    }
    signals = _signals(cats, float(last["oi"]), oi_prev, w3)
    return util.clean({
        "report_date": util.ts(report), "published": util.ts(published), "next_report": util.ts(next_report), "next_publication": util.ts(next_pub),
        "contract_btc": 5, "oi_contracts": float(last["oi"]), "oi_btc": oi_btc, "oi_change": float(last["oi"] - oi_prev) if oi_prev else None,
        "oi_change_btc": float(last["oi"] - oi_prev) * 5 if oi_prev else None,
        "oi_pctl_3y": _pctl(w3["oi"], float(last["oi"])),
        "micro": {"oi_contracts": util.num(micro_last["oi"]) if micro_last is not None else None, "oi_btc": micro_btc,
                  "since": util.ts(micro["time"].iloc[0]) if len(micro) else None},
        "traders": {"total": util.num(last.get("traders")), "lev_long": util.num(last.get("traders_lev_long")), "lev_short": util.num(last.get("traders_lev_short")),
                    "am_long": util.num(last.get("traders_am_long")), "am_short": util.num(last.get("traders_am_short"))},
        "categories": cats, "history": hist, "since": util.ts(btc["time"].iloc[0]), "weeks": int(len(btc)),
        "verification": verification, "signals": signals,
    })


def _signals(cats, oi, oi_prev, w3) -> list[dict]:
    out = []
    by = {c["id"]: c for c in cats}
    lev, am = by["lev"], by["am"]

    def add(t, tone):
        out.append({"text": t, "tone": tone})

    if lev["net"] < 0 and am["net"] > 0:
        add(f"Leveraged funds net short {abs(lev['net']):,.0f} contratti ({abs(lev['net_btc']):,.0f} BTC) mentre gli asset manager sono net long "
            f"{am['net']:,.0f}: struttura tipica del basis trade (long spot/ETF, short futures CME), non necessariamente una scommessa ribassista.", "neutral")
    elif lev["net"] > 0:
        add(f"Leveraged funds net long {lev['net']:,.0f} contratti: gli hedge fund scommettono direttamente al rialzo (raro sul CME).", "bullish")
    if lev.get("net_pctl_3y") is not None:
        p = lev["net_pctl_3y"]
        if p <= 10:
            add(f"Short netti dei leveraged funds ai massimi dei 3 anni ({p:.0f}° percentile): carry trade affollato, sensibile a un calo del basis.", "neutral")
        elif p >= 90:
            add(f"Posizione netta dei leveraged funds al {p:.0f}° percentile a 3 anni: short ridotti, basis trade in smontaggio.", "neutral")
    if am.get("net_change") is not None and abs(am["net_change"]) >= 300:
        add(f"Asset manager {'in aumento' if am['net_change'] > 0 else 'in riduzione'} di {abs(am['net_change']):,.0f} contratti netti nella settimana: "
            f"{'domanda istituzionale direzionale in crescita' if am['net_change'] > 0 else 'esposizione istituzionale in calo'}.", "bullish" if am["net_change"] > 0 else "bearish")
    if oi_prev:
        ch = (oi / oi_prev - 1) * 100
        if abs(ch) >= 5:
            add(f"Open interest CME {ch:+.1f}% in una settimana: {'nuova leva istituzionale' if ch > 0 else 'chiusura di posizioni istituzionali'}.", "neutral")
    return out
