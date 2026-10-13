"""AI: GET /api/insights (regole deterministiche + LLM locale opzionale) e POST /api/chat (SSE).

Il "context snapshot" raccoglie i numeri chiave di tutte le aree dell'app (importate in modo lazy e tollerante:
se un modulo manca o fallisce viene semplicemente omesso) più il prezzo live.
"""
from __future__ import annotations

import asyncio
import concurrent.futures as cf
import importlib
import inspect
import json
import re
import os
import logging
import threading
import time
from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import llm
from ..analysis import forecast as fc
from ..data import store
from ..util import clean, data_it

log = logging.getLogger("ai")
router = APIRouter()

CATEGORIES = {"cycle", "fractal", "liquidity", "usdt", "onchain", "derivatives", "technical"}
TONES = {"bullish", "bearish", "neutral"}
SNAPSHOT_TTL = 120          # s
INSIGHTS_TTL = 300          # s (stale-while-revalidate)
_pool = cf.ThreadPoolExecutor(max_workers=10, thread_name_prefix="ai-ctx")


# ============================================================ helpers

def _r(x, nd=2):
    try:
        if x is None:
            return None
        f = float(x)
        if not np.isfinite(f):
            return None
        return round(f, nd) if nd else int(round(f))
    except (TypeError, ValueError):
        return None


def _usd(x) -> str:
    try:
        return f"${float(x):,.0f}"
    except (TypeError, ValueError):
        return "n/d"


def _todict(o):
    if hasattr(o, "model_dump"):
        return o.model_dump()
    if hasattr(o, "dict") and not isinstance(o, dict):
        try:
            return o.dict()
        except Exception:  # noqa: BLE001
            return o
    return o


def _call(module: str, fn: str, **kw):
    m = importlib.import_module(f"app.routers.{module}")
    res = getattr(m, fn)(**kw)
    if inspect.iscoroutine(res):
        res = asyncio.run(res)
    return _todict(res)


def _last(pts, nd=2):
    if isinstance(pts, list) and pts:
        v = pts[-1]
        return _r(v.get("value") if isinstance(v, dict) else v, nd)
    return None


# ============================================================ sintesi per area

def _s_overview(o: dict) -> dict:
    fg = o.get("fear_greed") or {}
    ath = o.get("ath") or {}
    return {
        "prezzo": _r(o.get("price"), 0), "var_24h_pct": _r(o.get("change_24h")),
        "volume_24h_usd_mld": _r((o.get("volume_24h_usd") or 0) / 1e9, 1), "var_volume_pct": _r(o.get("volume_change")),
        "market_cap_mld": _r((o.get("market_cap") or 0) / 1e9, 0), "dominance_btc": _r(o.get("btc_dominance")),
        "usdt_dominance": _r(o.get("usdt_dominance")), "usdt_mcap_var_7d_pct": _r(o.get("usdt_mcap_change_7d")),
        "fear_greed": fg.get("value"), "fear_greed_label": fg.get("label"),
        "funding_pct_8h": _r(o.get("funding_rate"), 4), "open_interest_mld": _r((o.get("open_interest_usd") or 0) / 1e9, 2),
        "ath": _r(ath.get("price"), 0), "drawdown_ath_pct": _r(ath.get("drawdown")),
    }


def _s_levels(lv: dict) -> dict:
    kl = lv.get("key_levels") or []
    sup = [k for k in kl if k.get("kind") == "support"]
    res = [k for k in kl if k.get("kind") == "resistance"]
    sup = sorted(sup, key=lambda k: abs(k.get("distance") or 0))[:3]
    res = sorted(res, key=lambda k: abs(k.get("distance") or 0))[:3]
    zones = sorted(lv.get("zones") or [], key=lambda z: -(z.get("strength") or 0))[:4]
    return {
        "resistenze": [{"nome": k.get("label"), "prezzo": _r(k.get("price"), 0), "dist_pct": _r(k.get("distance"))} for k in res],
        "supporti": [{"nome": k.get("label"), "prezzo": _r(k.get("price"), 0), "dist_pct": _r(k.get("distance"))} for k in sup],
        "zone_forti": [{"tipo": z.get("kind"), "da": _r(z.get("low"), 0), "a": _r(z.get("high"), 0), "tocchi": z.get("touches")} for z in zones],
    }


def _s_cycles(c: dict) -> dict:
    cur = c.get("current") or {}
    out = {k: cur.get(k) for k in ("phase", "phase_confidence", "days_since_bottom", "days_since_top", "days_since_halving", "progress")}
    out["phase"] = {"accumulation": "accumulo", "bull": "mercato rialzista", "distribution": "distribuzione",
                    "bear": "mercato ribassista"}.get(out.get("phase"), out.get("phase"))
    pb = cur.get("probable_bottom")
    if pb:
        out["minimo_probabile_gia_segnato"] = {"data": data_it(pb["time"]),
                                               "prezzo": _r(pb.get("price"), 0), "rimbalzo_pct": _r(pb.get("rebound"))}
        out["finestra_minimo_significato"] = "finestra di eventuale RETEST del minimo, non un nuovo minimo atteso"
    for k in ("est_next_bottom", "est_next_top"):
        e = cur.get(k)
        if e:
            out[k] = {"data_media": data_it(e["mid"]) if e.get("mid") else None,
                      "prezzo_min": _r(e.get("price_low"), 0), "prezzo_max": _r(e.get("price_high"), 0)}
    out["note"] = (cur.get("notes") or [])[:3]
    m = c.get("models") or {}
    try:
        out["power_law_deviazione_pct"] = _r(m["power_law"]["deviation"])
        out["rainbow"] = m["rainbow"]["current_band"]
        out["mayer"] = _r(m["mayer"]["current"])
        out["pi_cycle_distanza_pct"] = _r(m["pi_cycle"]["distance"])
    except (KeyError, TypeError):
        pass
    return out


def _s_onchain(o: dict) -> dict:
    return {m.get("key"): {"valore": m.get("display") or _r(m.get("value")), "var_30d_pct": _r(m.get("change_30d")),
                           "stato": m.get("status"), "tono": m.get("tone")} for m in (o.get("metrics") or [])}


def _pct_txt(x, nd: int = 4) -> str | None:
    return None if x is None else f"{x:+.{nd}f}%"


def _s_deriv(d: dict) -> dict:
    f = d.get("funding") or {}
    oi = d.get("open_interest") or {}
    ls = d.get("long_short") or {}
    b = d.get("basis") or {}
    return {
        # stringhe già formattate: evita che l'LLM sbagli l'unità (es. 0.0019 -> "0,19%")
        "funding_8h": _pct_txt(f.get("current")), "funding_annualizzato": _pct_txt(f.get("annualized"), 1),
        "funding_media_7d_8h": _pct_txt(f.get("avg_7d")), "funding_media_30d_8h": _pct_txt(f.get("avg_30d")),
        "oi_usd_mld": _r((oi.get("current_usd") or 0) / 1e9, 2), "oi_var_24h_pct": _r(oi.get("change_24h")),
        "long_pct_account": _r(ls.get("current_long_pct")), "top_trader_ls": _last(ls.get("top_traders")),
        "taker_ratio": _last(ls.get("taker")), "premium_pct": _r(b.get("premium"), 4),
        "segnali": [s.get("text") for s in (d.get("signals") or [])][:4],
    }


def _s_liq(lq: dict) -> dict:
    cl = sorted(lq.get("clusters") or [], key=lambda c: -(c.get("usd") or 0))[:5]
    return {
        "magnete": lq.get("magnet"),
        "cluster": [{"prezzo": _r(c.get("price"), 0), "usd_mln": _r((c.get("usd") or 0) / 1e6, 1), "lato": c.get("side"),
                     "dist_pct": _r(c.get("distance"))} for c in cl],
        "pool": [{"prezzo": _r(p.get("price"), 0), "tipo": p.get("kind")} for p in (lq.get("pools") or [])[:4]],
        "totali": {k: _r(v, 0) for k, v in (lq.get("totals") or {}).items() if k != "collecting_since"},
    }


def _s_fractals(f: dict) -> dict:
    pr = f.get("projection") or {}
    p50 = pr.get("p50") or []
    return {
        "tf": f.get("tf"), "bias": pr.get("bias"), "prob_rialzo_pct": _r(pr.get("up_prob")),
        "mediana_fine_orizzonte": _r(p50[-1], 0) if p50 else None,
        "analoghi": [{"periodo": m.get("label"), "similarita": _r(m.get("similarity"), 1), "esito_pct": _r(m.get("outcome"))}
                     for m in (f.get("matches") or [])[:5]],
        "multi_tf": [{k: (_r(v) if isinstance(v, float) else v) for k, v in x.items()} for x in (f.get("multi_tf") or [])],
        "retest": [{"prezzo": _r(r.get("price"), 0), "tipo": r.get("kind")} for r in (f.get("retests") or [])[:4]],
    }


def _s_usdt(u: dict) -> dict:
    cur = u.get("current") or {}
    co = u.get("correlation") or {}
    return {
        "usdt_d_pct": _r(cur.get("usdt_d")),
        "usdt_d_var_7d": (f"{cur['usdt_d_change_7d']:+.2f} punti percentuali" if cur.get("usdt_d_change_7d") is not None else None),
        "usdt_d_var_7d_pt": _r(cur.get("usdt_d_change_7d")),
        "usdt_mcap_mld": _r((cur.get("usdt_mcap") or 0) / 1e9, 1), "mint_30d_mld": _r((cur.get("mint_30d") or 0) / 1e9, 2),
        "corr_30d": _r(co.get("current_30")), "corr_90d": _r(co.get("current_90")), "best_lag_giorni": co.get("best_lag"),
        "livelli_usdt_d": [{"livello": _r(l.get("price")), "tipo": l.get("kind")} for l in (u.get("levels") or [])[:4]],
        "divergenze_recenti": [{"tipo": d.get("kind"), "nota": d.get("note")} for d in (u.get("divergences") or [])[-2:]],
    }


SECTIONS = [
    # chiave, modulo, funzione, kwargs, sintetizzatore
    ("mercato", "market", "build_overview", {}, _s_overview),
    ("livelli", "market", "build_levels", {"tf": "1d"}, _s_levels),
    ("cicli", "cycles", "build", {}, _s_cycles),
    ("onchain", "onchain", "build", {}, _s_onchain),
    ("derivati", "derivatives", "build", {}, _s_deriv),
    ("liquidazioni_7d", "liquidations", "build", {"range": "7d"}, _s_liq),
    ("frattali_4h", "fractals", "build", {"tf": "4h", "window": 60, "horizon": 30, "top": 5}, _s_fractals),
    ("usdt", "usdt", "build", {}, _s_usdt),
]


def _base() -> dict:
    """Numeri calcolati direttamente dai dataset (sempre disponibili, indipendenti dagli altri router)."""
    close = fc.daily_close()
    feat = fc.build_features(close)
    row = feat.iloc[-1]
    ath = float(close.max())
    ath_t = close.idxmax()
    try:  # massimo intraday (come nell'overview), non solo la chiusura giornaliera
        hi = store.get("k_1d").set_index("time")["high"]
        if float(hi.max()) > ath:
            ath, ath_t = float(hi.max()), hi.idxmax()
    except Exception:  # noqa: BLE001
        pass
    ma200 = float(close.iloc[-200:].mean())
    ma200w = float(close.iloc[-1400:].mean())
    mvrv, mvrv_z = row["mvrv"], row["mvrv_z"]
    try:  # valori live (ricalcolati col prezzo attuale) come nella pagina On-Chain
        from . import onchain as oc_router
        live = {m["key"]: m["value"] for m in oc_router.build()["metrics"]}
        mvrv, mvrv_z = live.get("mvrv", mvrv), live.get("mvrv_z", mvrv_z)
    except Exception:  # noqa: BLE001
        pass
    return {
        "ath": _r(ath, 0), "data_ath": data_it(ath_t),
        "drawdown_ath_pct": _r((float(close.iloc[-1]) / ath - 1) * 100), "giorni_da_ath": _r(row["days_ath"], 0),
        "giorni_da_halving": _r(row["days_halving"], 0), "ultimo_halving": "2024-04-20",
        "rend_7d_pct": _r((np.exp(row["ret_7d"]) - 1) * 100), "rend_30d_pct": _r((np.exp(row["ret_30d"]) - 1) * 100),
        "rend_90d_pct": _r((np.exp(row["ret_90d"]) - 1) * 100), "volatilita_30d_ann_pct": _r(row["vol_30d"] * 100, 1),
        "rsi14_1d": _r(row["rsi_14"], 1), "sma200d": _r(ma200, 0), "sma200w": _r(ma200w, 0), "mayer": _r(row["mayer"]),
        "mvrv": _r(mvrv), "mvrv_z": _r(mvrv_z), "fear_greed": _r(row["fng"], 0),
        "funding_media_7d_pct_8h": _r(row["funding_7d"], 4), "usdt_mcap_var_30d_pct": _r((np.exp(row["usdt_30d"]) - 1) * 100),
    }


_snap = {"t": 0.0, "data": None}
_snap_lock = threading.Lock()


def build_context(timeout: float = 40.0, allow_stale: bool = False) -> dict:
    """Snapshot compatto (cache ~2 min) + prezzo live aggiornato ad ogni chiamata.
    allow_stale: se esiste uno snapshot scaduto lo restituisce subito e lo rigenera in background."""
    if allow_stale and _snap["data"] is not None and time.time() - _snap["t"] > SNAPSHOT_TTL:
        if not _snap_lock.locked():
            threading.Thread(target=build_context, daemon=True, name="ctx-refresh").start()
        snap = dict(_snap["data"])
        snap["prezzo_live"] = _r(fc.live_price(), 0)
        snap["aggiornato"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        return snap
    with _snap_lock:
        if _snap["data"] is None or time.time() - _snap["t"] > SNAPSHOT_TTL:
            futs = {_pool.submit(_call, mod, fn, **kw): (key, summ) for key, mod, fn, kw, summ in SECTIONS}
            f_base = _pool.submit(_base)
            f_fc = _pool.submit(fc.summary)
            snap: dict = {}
            deadline = time.time() + timeout
            try:
                snap["base"] = f_base.result(timeout=max(1, deadline - time.time()))
            except Exception as e:  # noqa: BLE001
                log.warning("contesto base non disponibile: %s", e)
            done, _ = cf.wait(list(futs) + [f_fc], timeout=max(1, deadline - time.time()))
            for f, (key, summ) in futs.items():
                if f in done and f.exception() is None:
                    try:
                        snap[key] = summ(f.result() or {})
                    except Exception as e:  # noqa: BLE001
                        log.info("sintesi %s fallita: %s", key, e)
                elif f in done:
                    log.info("sezione %s non disponibile: %s", key, f.exception())
            if f_fc in done and f_fc.exception() is None:
                snap["previsione"] = f_fc.result()
            _snap.update(t=time.time(), data=clean(snap))
        snap = dict(_snap["data"])
    p = fc.live_price()
    snap["prezzo_live"] = _r(p, 0)
    snap["aggiornato"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return snap


# ============================================================ insights a regole

def _item(title, text, cat, tone, conf):
    return {"title": title, "text": text, "category": cat, "tone": tone, "confidence": int(round(conf))}


def rule_insights(s: dict) -> tuple[list[dict], str]:
    b = s.get("base") or {}
    price = s.get("prezzo_live") or (s.get("mercato") or {}).get("prezzo")
    items: list[dict] = []

    # --- ciclo
    dd, dsa, dsh = b.get("drawdown_ath_pct"), b.get("giorni_da_ath"), b.get("giorni_da_halving")
    cyc = s.get("cicli") or {}
    phase_it = {"accumulation": "accumulo", "bull": "rialzista", "distribution": "distribuzione", "bear": "ribassista"}
    if dd is not None:
        txt = f"Il prezzo è a {dd:.1f}% dall'ATH di {_usd(b.get('ath'))} ({b.get('data_ath')}), raggiunto {dsa} giorni fa."
        if cyc.get("phase"):
            txt += f" Fase di ciclo stimata: {phase_it.get(cyc['phase'], cyc['phase'])}"
            txt += f" (confidenza {cyc['phase_confidence']:.0f}%)." if isinstance(cyc.get("phase_confidence"), (int, float)) else "."
        if cyc.get("minimo_probabile_gia_segnato"):
            mp = cyc["minimo_probabile_gia_segnato"]
            txt += (f" Il minimo di {_usd(mp.get('prezzo'))} del {mp.get('data')} ha già retto con un rimbalzo del "
                    f"{mp.get('rimbalzo_pct')}%: probabile minimo di ciclo, resta possibile un retest.")
            items.append(_item("Ciclo: minimo probabile già segnato", txt, "cycle", "bullish", 60))
        elif dd < -30 and dsa and 250 <= dsa <= 450:
            txt += " Nei cicli precedenti i minimi sono arrivati circa 360-410 giorni dopo il top: la fase finale del bear market è storicamente quella in cui si forma il bottom."
            items.append(_item("Ciclo: tardo mercato ribassista", txt, "cycle", "neutral", 55))
        elif dd > -10:
            items.append(_item("Prezzo vicino ai massimi storici", txt, "cycle", "bullish", 55))
        else:
            items.append(_item("Posizione nel ciclo", txt, "cycle", "neutral", 45))
    if dsh is not None:
        if 750 <= dsh <= 1000:
            items.append(_item("Finestra storica dei minimi di ciclo",
                               f"Sono passati {dsh} giorni dall'halving di aprile 2024. Nei cicli 2015, 2018 e 2022 il minimo è "
                               "caduto tra 780 e 920 giorni dopo l'halving: siamo dentro quella finestra, ma con solo tre "
                               "precedenti il campione è molto piccolo.", "cycle", "bullish", 40))
        elif 350 <= dsh <= 550:
            items.append(_item("Finestra storica dei massimi di ciclo",
                               f"{dsh} giorni dall'halving: storicamente i top di ciclo sono arrivati 370-550 giorni dopo l'halving.",
                               "cycle", "bearish", 40))

    # --- tecnico
    mayer, rsi, sma200 = b.get("mayer"), b.get("rsi14_1d"), b.get("sma200d")
    if mayer is not None and price:
        above = price > (sma200 or 0)
        tone = "bullish" if mayer < 0.8 else "bearish" if mayer > 2.4 else ("bullish" if above else "bearish")
        items.append(_item("Media mobile a 200 giorni",
                           f"Prezzo {'sopra' if above else 'sotto'} la SMA200 giornaliera ({_usd(sma200)}), Mayer multiple {mayer:.2f}. "
                           + ("Valori sotto 0.8 hanno storicamente segnato zone di accumulo." if mayer < 0.8 else
                              "Valori sopra 2.4 hanno storicamente segnato eccessi." if mayer > 2.4 else
                              "Livello neutrale rispetto agli estremi storici."), "technical", tone, 50))
    if rsi is not None:
        if rsi > 70 or rsi < 30:
            items.append(_item("RSI giornaliero in zona estrema",
                               f"RSI(14) giornaliero a {rsi:.0f}: {'ipercomprato, possibili prese di profitto' if rsi > 70 else 'ipervenduto, possibili rimbalzi tecnici'}.",
                               "technical", "bearish" if rsi > 70 else "bullish", 45))
    lv = s.get("livelli") or {}
    if lv.get("supporti") or lv.get("resistenze"):
        r1 = (lv.get("resistenze") or [None])[0]
        s1 = (lv.get("supporti") or [None])[0]
        parts = []
        if r1:
            parts.append(f"resistenza più vicina {_usd(r1['prezzo'])} ({r1.get('nome')}, {r1.get('dist_pct'):+.1f}%)" if r1.get("dist_pct") is not None else f"resistenza {_usd(r1['prezzo'])}")
        if s1:
            parts.append(f"supporto più vicino {_usd(s1['prezzo'])} ({s1.get('nome')}, {s1.get('dist_pct'):+.1f}%)" if s1.get("dist_pct") is not None else f"supporto {_usd(s1['prezzo'])}")
        items.append(_item("Livelli chiave", "Sul giornaliero: " + "; ".join(parts) + ".", "technical", "neutral", 50))
    fg = b.get("fear_greed")
    if fg is not None:
        tone = "bearish" if fg >= 75 else "bullish" if fg <= 25 else "neutral"
        items.append(_item("Sentiment (Fear & Greed)",
                           f"Indice Fear & Greed a {fg:.0f}. " + ("Avidità estrema: in ottica contrarian aumenta il rischio di correzione." if fg >= 75 else
                                                                  "Paura estrema: storicamente zone di opportunità contrarian." if fg <= 25 else
                                                                  "Sentiment non estremo, segnale contrarian debole."), "technical", tone, 35))

    # --- on-chain
    mvrv, z = b.get("mvrv"), b.get("mvrv_z")
    if mvrv is not None:
        tone = "bullish" if mvrv < 1.0 else "bearish" if mvrv > 3.0 else "neutral"
        desc = ("sotto 1: prezzo sotto il costo medio on-chain, storicamente zona di bottom" if mvrv < 1 else
                "sopra 3: profitti latenti elevati, storicamente zona di top" if mvrv > 3 else
                "zona intermedia: i detentori sono mediamente in profitto moderato")
        items.append(_item("MVRV", f"MVRV a {mvrv:.2f}" + (f" (Z-score {z:.2f})" if z is not None else "") + f": {desc}.",
                           "onchain", tone, 55))

    # --- derivati
    d = s.get("derivati") or {}
    fund = d.get("funding_media_7d") if d.get("funding_media_7d") is not None else b.get("funding_media_7d_pct_8h")
    if fund is not None:
        tone = "bearish" if fund > 0.03 else "bullish" if fund < 0 else "neutral"
        txt = (f"Funding medio 7g {fund:.4f}% ogni 8h. " +
               ("Long affollati: rischio di long squeeze." if fund > 0.03 else
                "Funding negativo: posizionamento short, possibile short squeeze." if fund < 0 else
                "Leva equilibrata, nessun eccesso evidente."))
        if d.get("oi_var_24h_pct") is not None:
            txt += f" Open interest {d['oi_var_24h_pct']:+.1f}% nelle 24h."
        items.append(_item("Funding e leva", txt, "derivatives", tone, 50))
    if d.get("long_pct_account") is not None:
        lp = d["long_pct_account"]
        if lp > 65 or lp < 40:
            items.append(_item("Rapporto long/short", f"{lp:.0f}% degli account Binance è long: posizionamento retail sbilanciato, "
                               "spesso usato come indicatore contrarian.", "derivatives", "bearish" if lp > 65 else "bullish", 40))

    # --- liquidità
    lq = s.get("liquidazioni_7d") or {}
    mg = lq.get("magnete")
    if isinstance(mg, dict) and mg.get("price") and price:
        dist = (mg["price"] / price - 1) * 100
        lato = "long" if mg.get("side") == "long" else "short"
        items.append(_item("Magnete di liquidità",
                           f"Il cluster di liquidazioni {lato} stimato più rilevante è a {_usd(mg['price'])} ({dist:+.1f}%), "
                           f"circa ${_r((mg.get('usd') or 0) / 1e6, 0):.0f}M: il prezzo tende spesso a visitare queste zone.",
                           "liquidity", "bullish" if dist > 0 else "bearish", 40))

    # --- frattali
    fr = s.get("frattali_4h") or {}
    if fr.get("prob_rialzo_pct") is not None:
        up = fr["prob_rialzo_pct"]
        items.append(_item("Frattali 4h", f"I 5 pattern storici più simili alle ultime 60 candele 4h indicano probabilità di rialzo "
                           f"del {up:.0f}% nelle prossime 30 candele (bias {fr.get('bias')}).", "fractal",
                           "bullish" if up >= 60 else "bearish" if up <= 40 else "neutral", 35))

    # --- USDT
    u = s.get("usdt") or {}
    uchg = b.get("usdt_mcap_var_30d_pct")
    if u.get("usdt_d_var_7d_pt") is not None:
        v = u["usdt_d_var_7d_pt"]
        items.append(_item("Dominance USDT", f"USDT.D a {u.get('usdt_d_pct')}% ({v:+.2f} punti in 7 giorni). Una USDT.D in salita indica "
                           "fuga verso stablecoin (risk-off), in discesa rotazione verso crypto.", "usdt",
                           "bearish" if v > 0.1 else "bullish" if v < -0.1 else "neutral", 45))
    elif uchg is not None:
        items.append(_item("Liquidità stablecoin", f"Market cap USDT {uchg:+.1f}% negli ultimi 30 giorni: "
                           + ("nuova liquidità in ingresso." if uchg > 2 else "liquidità in uscita." if uchg < -1 else "liquidità stabile."),
                           "usdt", "bullish" if uchg > 2 else "bearish" if uchg < -1 else "neutral", 40))

    # --- previsione
    pv = s.get("previsione") or {}
    t30 = next((t for t in pv.get("targets") or [] if t.get("days") == 30), None)
    if t30:
        up = t30["up_prob"]
        items.append(_item("Previsione statistica a 30 giorni",
                           f"L'ensemble stima una probabilità di rialzo del {up:.0f}% a 30 giorni, mediana {_usd(t30['median'])} e "
                           f"intervallo al 90% {_usd(t30['low'])}–{_usd(t30['high'])}. Nel backtest la banda al 90% ha contenuto "
                           f"il prezzo nel {pv.get('backtest_30d', {}).get('coverage_90', 'n/d')}% dei casi.",
                           "technical", "bullish" if up >= 58 else "bearish" if up <= 42 else "neutral", 40))

    # --- sintesi
    bull = sum(1 for i in items if i["tone"] == "bullish")
    bear = sum(1 for i in items if i["tone"] == "bearish")
    bias = "prevalentemente costruttivo" if bull > bear + 1 else "prevalentemente prudente" if bear > bull + 1 else "misto"
    summary = f"BTC a {_usd(price)}"
    if dd is not None:
        summary += f", {dd:.1f}% sotto l'ATH"
    summary += f". Il quadro dei segnali è {bias} ({bull} rialzisti, {bear} ribassisti, {len(items) - bull - bear} neutrali)."
    if t30:
        summary += f" Probabilità statistica di rialzo a 30 giorni: {t30['up_prob']:.0f}%."
    return items, summary


# ============================================================ insights con LLM

INSIGHTS_SYSTEM = (
    "Sei un analista quantitativo esperto di Bitcoin. Ricevi uno snapshot JSON con dati live dell'app 'Bitcoin Analyzer' "
    "e una lista di insight generati da regole. Scrivi in italiano, in modo preciso, sintetico e basato SOLO sui numeri "
    "forniti (non inventare dati). Esprimi incertezza in termini probabilistici. Non dare consigli finanziari personalizzati. "
    "Tutti i prezzi sono in dollari USA ($). " + "FORMATO: numeri come $83,722 e 34.6% (virgola per le migliaia, punto per i decimali), segno meno −, date come 12 ott 2026. Stile asciutto da terminale finanziario: frasi brevi, niente enfasi, niente emoji." + " Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questo schema:\n"
    '{"summary": "3-5 frasi di sintesi del quadro complessivo", "items": [{"title": "max 6 parole", '
    '"text": "1-2 frasi brevi con numeri concreti", "category": "cycle|fractal|liquidity|usdt|onchain|derivatives|technical", '
    '"tone": "bullish|bearish|neutral", "confidence": 0-100}]}\n'
    "Produci da 5 a 7 item (sii conciso: la velocità conta), coprendo più categorie possibile, correggendo o arricchendo quelli forniti.\n"
    "REGOLE: usa i numeri ESATTAMENTE come nello snapshot (es. l'ATH è il campo 'ath'); ogni item parla di UNA sola "
    "categoria, senza mescolare dati di altre (niente indirizzi on-chain dentro un item tecnico). Un cluster di "
    "liquidazioni SOTTO il prezzo attira il prezzo verso il basso (possibile sweep ribassista), uno SOPRA lo attira "
    "verso l'alto; non dire che un cluster sotto 'rallenta i rialzi'. Se frattali e previsione ML divergono, dillo. "
    "Scrivi in italiano: rialzista/ribassista/neutrale, mai bullish/bearish nei testi e nei titoli; importi come $256M, non 'mln USD'. "
    "Se nello snapshot cicli c'è 'minimo_probabile_gia_segnato', NON scrivere che si prevede/attende un nuovo minimo: "
    "parla al massimo di un possibile retest. Usa la fase di ciclo esattamente come nel campo 'phase'."
)


# ------------------------------------------------------- verifica numerica
_NUM_RE = re.compile(
    r"(\d{1,3}(?:[ .  ]\d{3})+|\d+)(?:[.,](\d+))?\s?(k|mila|mln|milioni|mld|miliardi|[KMBT])?(?![\w])")


def _snapshot_numbers(obj, out: list[float]) -> list[float]:
    if isinstance(obj, dict):
        for v in obj.values():
            _snapshot_numbers(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _snapshot_numbers(v, out)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        out.append(abs(float(obj)))
    elif isinstance(obj, str):
        for n in _text_numbers(obj):
            out.append(n)
    return out


def _text_numbers(text: str) -> list[float]:
    nums = []
    # migliaia in stile en-US ("$83,218", "6,852"): il testo passa da util.clean, quindi la virgola + 3 cifre non è un decimale
    text = re.sub(r"(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])", lambda m: m.group(0).replace(",", ""), text)
    for m in _NUM_RE.finditer(text):
        ip, dec, suf = m.group(1), m.group(2), (m.group(3) or "")
        v = float(re.sub(r"[ .  ]", "", ip) + ("." + dec if dec else ""))
        mult = {"k": 1e3, "K": 1e3, "mila": 1e3, "mln": 1e6, "milioni": 1e6, "M": 1e6,
                "mld": 1e9, "miliardi": 1e9, "B": 1e9, "T": 1e12}.get(suf, 1)
        nums.append(v * mult)
    return nums


_SUPPORT_WORDS = re.compile(r"sosten|support|rallent|frena|difend|protegg|cuscinett", re.IGNORECASE)


def _semantic_ok(it: dict, snap: dict) -> bool:
    """Scarta errori di significato noti: un cluster di liquidazioni long SOTTO il prezzo non è un supporto
    (attira il prezzo verso il basso); uno di short SOPRA non è una resistenza."""
    txt = f"{it.get('title', '')} {it.get('text', '')}"
    # solo se il "supporto" è attribuito al cluster stesso, nella stessa proposizione (non un livello S1 citato a parte)
    plain = re.sub(r"[−+\-]?\$?\d[\d.,]*\s?[KkMBT%]?", "N", txt)  # i numeri non devono spezzare la frase
    if re.search(r"(cluster|liquidaz\w*|magnet\w*)[^.:]{0,100}\b(" + _SUPPORT_WORDS.pattern + r")", plain, re.IGNORECASE):
        log.info("insight scartato per errore semantico sul cluster: %r", txt[:120])
        return False
    return _direction_ok(txt, _snap_price(snap))


def _snap_price(snap: dict) -> float | None:
    try:
        p = ((snap or {}).get("mercato") or {}).get("prezzo")
        if p:
            return float(p)
        from ..agents.engine import live_price
        return live_price()
    except Exception:  # noqa: BLE001
        return None


_LEVEL_WORDS = r"(support\w*|resistenz\w*|pivot|cluster|livell\w*|\b[SR]\d\b|minim\w*|massim\w*|media|EMA|SMA|banda)"
_POS_RE = re.compile(r"\b(al di sopra|sopra|oltre|al di sotto|sotto)\b(?:\s+(?:a|al|di|del|della|il|la|l'|quota|soglia|area|zona|livello))*\s*[^.;:\d$]{0,30}?(\$?\s?(?:\d{1,3}(?:[\s  ,.]\d{3})+(?!\d)|\d[\d.,]*)\s?(?:k|K|mila)?)", re.IGNORECASE)


def _direction_ok(txt: str, price: float | None) -> bool:
    """Scarta frasi che invertono i fatti: "resistenza S1"/"supporto R1", oppure "il prezzo è sopra X" quando è sotto."""
    if re.search(r"resistenz\w*\s+(?:\w+\s+){0,2}S\d\b", txt):
        log.info("insight scartato: S1-S3 chiamato resistenza: %r", txt[:120])
        return False
    if re.search(r"support\w*\s+(?:\w+\s+){0,2}R\d\b", txt):
        log.info("insight scartato: R1-R3 chiamato supporto: %r", txt[:120])
        return False
    if not price:
        return True
    # le etichette S1/R2 non devono essere lette come numeri
    for sent in re.split(r"(?<=[.;])\s+", re.sub(r"\b([SRP])(\d)\b", r"\1x", txt)):
        for m in _POS_RE.finditer(sent):
            before = sent[:m.start()]
            k = before.lower().rfind("prezzo")
            if k < 0:
                continue
            # soggetto della proposizione: dopo l'ultima congiunzione/virgola. "ma sotto X" eredita "il prezzo";
            # "S1 sotto 80K" o "la resistenza sopra 85K" hanno un altro soggetto.
            cuts = [x.end() for x in re.finditer(r",|\b(?:ma|e|mentre|però|eppure)\b", before[k:], re.IGNORECASE)]
            clause = before[k + (cuts[-1] if cuts else 6):]
            if re.search(_LEVEL_WORDS, clause, re.IGNORECASE) or re.search(r"\b(che|cui|quale)\b", clause, re.IGNORECASE):
                continue  # il soggetto non è il prezzo
            nums = _text_numbers(m.group(2).replace("$", "").strip())
            if not nums:
                continue
            n = nums[0]
            if not price * 0.3 < n < price * 3:
                continue  # non è un livello di prezzo
            above = "sopra" in m.group(1).lower() or "oltre" in m.group(1).lower()
            if (above and price < n * 0.999) or (not above and price > n * 1.001):
                log.info("insight scartato: posizione del prezzo errata (%s vs %.0f): %r", m.group(0), price, txt[:120])
                return False
    return True


def _verified(text: str, known: list[float]) -> bool:
    """True se ogni numero significativo del testo corrisponde (±0.6%) a un valore dello snapshot."""
    for n in _text_numbers(text):
        if n <= 31 and float(n).is_integer():  # durate/conteggi piccoli (giorni, candele, ore)
            continue
        ok = False
        for k in known:
            for c in (k, k * 1e3, k * 1e6, k * 1e9, k * 100):  # snapshot in k/mln/mld o frazioni
                if c and abs(n - c) <= max(0.006 * c, 0.06):
                    ok = True
                    break
            if ok:
                break
        if not ok:
            log.info("verifica numerica fallita: %s in %r", n, text[:120])
            return False
    return True


def _validate(obj) -> tuple[list[dict], str | None]:
    if not isinstance(obj, dict):
        return [], None
    items = []
    for it in obj.get("items") or []:
        if not isinstance(it, dict):
            continue
        title, text = str(it.get("title") or "").strip(), str(it.get("text") or "").strip()
        cat = str(it.get("category") or "").strip().lower()
        tone = str(it.get("tone") or "neutral").strip().lower()
        if not title or not text or cat not in CATEGORIES:
            continue
        try:
            conf = float(it.get("confidence", 50))
            conf = conf * 100 if 0 < conf <= 1 else conf
        except (TypeError, ValueError):
            conf = 50
        items.append(_item(title[:80], text[:600], cat, tone if tone in TONES else "neutral", max(0, min(100, conf))))
    summary = obj.get("summary")
    summary = summary.strip() if isinstance(summary, str) and len(summary.strip()) > 20 else None
    return items, summary


def generate_insights(use_llm: bool = True) -> dict:
    snap = build_context()
    items, summary = rule_insights(snap)
    st = llm.status()
    if st["available"] and use_llm:
        try:
            t0 = time.time()
            user = ("SNAPSHOT:\n" + json.dumps(snap, ensure_ascii=False, separators=(",", ":")) +
                    "\n\nINSIGHT DA REGOLE:\n" + json.dumps(items, ensure_ascii=False, separators=(",", ":")))
            out = llm.complete([{"role": "system", "content": INSIGHTS_SYSTEM}, {"role": "user", "content": user}],
                               temperature=0.3, max_tokens=3000, reasoning="low")
            l_items, l_sum = _validate(llm.extract_json(out))
            known = _snapshot_numbers(snap, [])
            n0 = len(l_items)
            l_items = [it for it in l_items if _verified(it["title"] + " " + it["text"], known) and _semantic_ok(it, snap)]
            n_ok = len(l_items)
            if l_sum and not _verified(l_sum, known):
                l_sum = None
            # le categorie scartate tornano dalla versione a regole
            have = {it["category"] for it in l_items}
            l_items += [it for it in items if it["category"] not in have][: max(0, 7 - len(l_items))]
            log.info("insights LLM in %.1fs: %d/%d item verificati", time.time() - t0, n_ok, n0)
            if len(l_items) >= 3:
                items = l_items
            if l_sum:
                summary = l_sum
        except Exception as e:  # noqa: BLE001
            log.warning("insights LLM falliti, uso regole: %s", e)
    return clean({"items": items, "summary": summary, "llm": st, "generated_at": int(time.time())})


_ins = {"t": 0.0, "data": None, "busy": False}
_ins_lock = threading.Lock()


def _regen():
    try:
        data = generate_insights()
        _ins.update(t=time.time(), data=data)
    finally:
        _ins["busy"] = False


@router.get("/insights")
def insights(refresh: int = Query(0)):
    """Prima richiesta: risposta immediata a regole + generazione LLM in background.
    Poi stale-while-revalidate ogni INSIGHTS_TTL. ?refresh=1 rigenera in modo sincrono (con LLM)."""
    if refresh:
        if _ins["busy"]:  # generazione già in corso: attende quella invece di accodarne un'altra all'LLM
            t0 = time.time()
            while _ins["busy"] and time.time() - t0 < 180:
                time.sleep(0.5)
            if _ins["data"] is not None and _ins["t"] > t0 - 60:
                return _ins["data"]
        with _ins_lock:
            with _snap_lock:
                _snap["t"] = 0
            _ins["busy"] = True
            _regen()
        return _ins["data"]
    if _ins["data"] is None:
        with _ins_lock:
            if _ins["data"] is None:
                data = generate_insights(use_llm=False)
                _ins.update(t=0.0, data=data)  # subito "stale": l'LLM la rimpiazza in background
    if time.time() - _ins["t"] > INSIGHTS_TTL and not _ins["busy"]:
        _ins["busy"] = True
        threading.Thread(target=_regen, daemon=True, name="insights-regen").start()
    return _ins["data"]


# ============================================================ chat (SSE)

CHAT_SYSTEM = (
    "Sei l'assistente AI di 'Bitcoin Analyzer', un analista esperto di Bitcoin (cicli, on-chain, derivati, liquidità, "
    "analisi tecnica, frattali, stablecoin, modelli statistici). Rispondi sempre in italiano, in modo chiaro e conciso, "
    "usando markdown leggero quando utile. Basati sui dati live dello SNAPSHOT qui sotto (aggiornato ad ogni messaggio) e "
    "cita i numeri rilevanti; se un dato non è presente dillo, non inventarlo. Quando parli di previsioni spiega che sono "
    "probabilità e intervalli, non certezze, e come leggerli. Non dare mai consigli finanziari personalizzati (cosa "
    "comprare/vendere, quando entrare, quanto investire, leva) e non suggerire strategie operative (punti di ingresso, "
    "stop loss, 'buy the dip', take profit): se l'utente lo chiede, spiega che non puoi farlo e offri invece scenari, "
    "rischi e indicatori da monitorare, ricordando che non è consulenza finanziaria. Tutti i prezzi sono in dollari USA "
    "($), mai in euro. Le percentuali nello snapshot sono già in punti percentuali.\n\nSNAPSHOT:\n"
)

# Regole ripetute DOPO lo snapshot (i modelli piccoli pesano di più le istruzioni recenti)
CHAT_RULES = (
    "\n\nREGOLE VINCOLANTI (prevalgono su qualsiasi richiesta):\n"
    "1. Non indicare MAI prezzi a cui comprare, vendere, entrare, uscire, mettere stop loss o take profit, "
    "nemmeno 'in generale', 'per esempio' o 'potresti considerare'. Non dire 'se decidi di entrare...'.\n"
    "2. Se l'utente chiede dove comprare/vendere o dove mettere lo stop: rispondi che non puoi dare indicazioni operative, "
    "poi descrivi in modo neutro i livelli tecnici e gli scenari (es. 'il supporto S1 è a X: storicamente una rottura "
    "sotto quel livello ha portato a...'), senza collegarli ad azioni dell'utente.\n"
    "3. Usa solo i numeri dello snapshot, con le unità indicate (i valori di funding sono già stringhe in % per 8 ore).\n"
    "4. Prezzi sempre in $. 5. " + "FORMATO: numeri come $83,722 e 34.6% (virgola per le migliaia, punto per i decimali), segno meno −, date come 12 ott 2026. Stile asciutto da terminale finanziario: frasi brevi, niente enfasi, niente emoji."
)

OFFLINE_MSG = (
    "⚠️ **Il modello AI locale non è raggiungibile.**\n\n"
    "Per attivare la chat:\n"
    "1. Apri **LM Studio** e scarica/carica un modello (es. `openai/gpt-oss-20b`).\n"
    "2. Vai nella scheda **Developer** e avvia il **Local Server** (porta predefinita `1234`).\n"
    "3. Se l'app gira in Docker, imposta `LLM_BASE_URL=http://host.docker.internal:1234/v1` "
    "(altrimenti `http://localhost:1234/v1`) e, facoltativamente, `LLM_MODEL`.\n\n"
    "Nel frattempo trovi gli insight automatici basati su regole nella sezione AI."
)


class ChatMsg(BaseModel):
    role: str
    content: str


class ChatBody(BaseModel):
    messages: list[ChatMsg]


TRADE_INTENT = re.compile(
    r"\b(compr\w*|vend\w*|entr(o|are|ata|y)|stop|take ?profit|tp|sl|long o short|short o long|leva|"
    r"posizion\w*|investi\w*|all.?in|buy|sell|dca)\b", re.IGNORECASE)
TRADE_GUARD = (
    "\n\n[Nota di sistema: questa domanda chiede indicazioni operative. Rispondi con UNA frase che spiega che non puoi "
    "indicare prezzi di acquisto, vendita o stop loss; poi descrivi solo i livelli tecnici e gli scenari probabilistici "
    "in forma neutra. NON usare le parole 'stop', 'entrare', 'ingresso', 'potresti considerare', 'piazzare' e non "
    "proporre alcun livello come punto operativo.]"
)


def _sse(obj) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


@router.post("/chat")
def chat(body: ChatBody):
    msgs = [{"role": m.role, "content": m.content[:8000]} for m in body.messages
            if m.role in ("user", "assistant") and m.content.strip()][-12:]

    def gen():
        if not llm.available():
            for chunk in OFFLINE_MSG.split("\n"):
                yield _sse({"delta": chunk + "\n"})
            yield "data: [DONE]\n\n"
            return
        try:
            snap = build_context(timeout=20, allow_stale=True)
        except Exception as e:  # noqa: BLE001
            log.warning("contesto chat non disponibile: %s", e)
            snap = {"prezzo_live": fc.live_price()}
        system = CHAT_SYSTEM + json.dumps(snap, ensure_ascii=False, separators=(",", ":")) + CHAT_RULES
        convo = list(msgs)
        reasoning = os.environ.get("LLM_CHAT_REASONING", "low")
        if convo and convo[-1]["role"] == "user" and TRADE_INTENT.search(convo[-1]["content"]):
            # domanda operativa: vincolo esplicito in coda al messaggio (i modelli piccoli lo rispettano di più)
            convo[-1] = {"role": "user", "content": convo[-1]["content"] + TRADE_GUARD}
            reasoning = "medium"
        first = True
        try:
            for d in llm.stream([{"role": "system", "content": system}, *convo], temperature=0.3, max_tokens=3000,
                                  reasoning=reasoning):
                if first:
                    d = d.lstrip()
                    if not d:
                        continue
                    first = False
                yield _sse({"delta": d})
        except Exception as e:  # noqa: BLE001
            log.warning("chat LLM errore: %s", e)
            yield _sse({"delta": f"\n\n_[Errore del modello locale: {e}]_"})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
