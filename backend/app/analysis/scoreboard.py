"""Tabellone Bull vs Bear: punti rialzisti e ribassisti calcolati da regole esplicite, con soglie dichiarate.

Ogni regola è una funzione pura (valori -> Hit | None): stessi numeri, stesso esito, sia dal vivo sia nel backtest.
La confidenza (1 bassa, 2 media, 3 alta) dice quanto il dato supera la soglia, non quanto è probabile un movimento.
Il tabellone conta i punti e basta: nessun punteggio viene trasformato in previsione.

Fonti: FRED (spread HY, SOFR, IORB, riserve, RRP, TGA, reale 10y, 10y, EFFR), Yahoo (DXY, VIX, Nasdaq futures, Brent, futures Fed
funds, STRC), Binance (candele, funding, long/short), Farside (ETF), DefiLlama (USDT, USDC), Coin Metrics (BTC sugli exchange),
Coinbase (premio), Bybit e OKX (open interest), Polymarket Gamma (politica), collector interni (liquidazioni, book).

Testi: `tpl` è un modello italiano con segnaposto e `vars` contiene solo numeri già formattati. Il frontend lo passa a t(tpl, vars):
la traduzione inglese è in frontend/src/i18n/en/scoreboard.ts e i numeri non passano mai dall'LLM.
"""
from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from .. import util
from ..data import sources as src
from ..data import store
from . import macro
from . import supply_demand  # noqa: F401  (registra sd_etf e sd_exchange)

log = logging.getLogger("scoreboard")

CATS = ("macro", "politica", "struttura", "flussi", "posizionamento", "altro")
LOW, MED, HIGH = 1, 2, 3
BULL, BEAR = "bull", "bear"
MINUS = "−"
DAY = pd.Timedelta(days=1)
ZQ_MONTHS = "FGHJKMNQUVXZ"
POLY_URL = "https://gamma-api.polymarket.com/public-search"
# gruppi di ricerca: un solo mercato per gruppo (il più scambiato). SÌ è sempre l'esito favorevole a BTC.
POLY_GROUPS = (("legge", ("CLARITY Act", "crypto market structure")), ("riserva", ("bitcoin reserve",)))
POLY_MIN_VOLUME = 50_000.0
POLY_MED_VOLUME = 1_000_000.0

FRED_IDS = {"hy": "BAMLH0A0HYM2", "sofr": "SOFR", "iorb": "IORB", "wres": "WRESBAL", "rrp": "RRPONTSYD", "tga": "WTREGEN",
            "real10": "DFII10", "y10": "DGS10", "effr": "EFFR"}
# giorni tra la data del dato e la sua pubblicazione, usati solo dal backtest (nessun dato futuro)
LAG = {"hy": 1, "sofr": 1, "iorb": 1, "wres": 2, "rrp": 1, "tga": 2, "real10": 1, "y10": 1, "effr": 1, "etf": 1, "exch": 2, "fng": 0,
       "usdt": 1, "usdc": 1}

for _k, _id in FRED_IDS.items():
    if macro.fred_key():
        store.register(f"fred_{_id.lower()}", (lambda i: lambda old: macro.fred_series(i))(_id), 6 * 3600)
store.register("sb_nq", macro._yahoo_refresher("NQ=F"), 1800)
store.register("sb_brent", macro._yahoo_refresher("BZ=F"), 1800)
store.register("sb_strc", macro._yahoo_refresher("STRC"), 3600)


def _usdc_supply(old):
    """USDC in circolazione da DefiLlama (stesso formato di usdt_supply)."""
    rows = src._get("https://stablecoins.llama.fi/stablecoincharts/all", {"stablecoin": 2})
    out = [(int(r["date"]), float(v)) for r in rows if (v := (r.get("totalCirculatingUSD") or {}).get("peggedUSD"))]
    df = pd.DataFrame(out, columns=["t", "usdc"])
    df["time"] = pd.to_datetime(df["t"] // 86400 * 86400, unit="s", utc=True)
    return df[df["time"] >= "2021-01-01"][["time", "usdc"]].drop_duplicates("time", keep="last").reset_index(drop=True)


store.register("usdc_supply", _usdc_supply, 3 * 3600)


# ------------------------------------------------------------------ formato

def usd(x: float, sign: bool = False) -> str:
    a = abs(x)
    s = f"${a / 1e12:.2f}T" if a >= 1e12 else f"${a / 1e9:.2f}B" if a >= 1e9 else f"${a / 1e6:.0f}M" if a >= 1e6 else f"${a / 1e3:.0f}K"
    return (MINUS if x < 0 else "+" if sign else "") + s


def pct(x: float, nd: int = 1, sign: bool = True) -> str:
    return (MINUS if x < 0 else "+" if sign else "") + f"{abs(x):.{nd}f}%"


def num(x: float, nd: int = 2) -> str:
    return (MINUS if x < 0 else "") + f"{abs(x):,.{nd}f}"


def bp(x: float) -> str:
    return (MINUS if x < 0 else "+") + f"{abs(x):.0f}"


def price(x: float) -> str:
    return f"${x:,.0f}"


def _ok(*xs) -> bool:
    return all(x is not None and not (isinstance(x, float) and math.isnan(x)) for x in xs)


@dataclass
class Hit:
    side: str
    conf: int
    tpl: str
    vars: dict


# ------------------------------------------------------------------ regole (funzioni pure)

def r_nq(x):
    c = x.get("nq_chg")
    if not _ok(c) or abs(c) < 0.5:
        return None
    v = {"chg": pct(c)}
    conf = HIGH if abs(c) >= 1 else MED
    return Hit(BULL, conf, "Azionario su: Nasdaq futures {chg} nell'ultima sessione", v) if c > 0 else \
        Hit(BEAR, conf, "Azionario giù: Nasdaq futures {chg} nell'ultima sessione", v)


def r_vix(x):
    v, c, p = x.get("vix"), x.get("vix_chg5"), x.get("vix_p5")
    if not _ok(v, c, p):
        return None
    va = {"from": num(p, 1), "to": num(v, 1)}
    if v >= 25:
        return Hit(BEAR, HIGH if v >= 30 else MED, "Volatilità alta: VIX {to}, oltre la soglia di 25", va)
    if c >= 20:
        return Hit(BEAR, MED, "Volatilità in salita: VIX da {from} a {to} in 5 sedute", va)
    if c <= -15:
        return Hit(BULL, MED, "Volatilità in calo: VIX da {from} a {to} in 5 sedute", va)
    if v <= 16:
        return Hit(BULL, LOW, "Volatilità bassa: VIX {to}, sotto 16", va)
    return None


def r_hy(x):
    s, c = x.get("hy"), x.get("hy_chg5")
    if not _ok(s):
        return None
    va = {"v": num(s) + "%"}
    if s >= 5:
        return Hit(BEAR, HIGH, "Credito sotto stress: spread high yield {v}, oltre il 5%", va)
    if _ok(c) and c >= 0.30:
        return Hit(BEAR, MED, "Credito in peggioramento: spread high yield {v}, +{d} pt in 5 sedute", {**va, "d": num(c)})
    if s <= 3.5:
        return Hit(BULL, HIGH, "Credito tranquillo: spread high yield {v}, sotto la soglia di stress del 3.5%", va)
    return None


def r_brent(x):
    v, c, p = x.get("brent"), x.get("brent_chg5"), x.get("brent_p5")
    if not _ok(v, c, p) or abs(c) < 5:
        return None
    va = {"from": num(p, 1), "to": num(v, 1), "chg": pct(c)}
    conf = HIGH if abs(c) >= 10 else MED
    return Hit(BULL, conf, "Petrolio in calo: Brent da {from} a {to} ({chg}) in 5 sedute", va) if c < 0 else \
        Hit(BEAR, conf, "Petrolio in rialzo: Brent da {from} a {to} ({chg}) in 5 sedute", va)


def r_10y(x):
    v, d, p = x.get("y10"), x.get("y10_chg5"), x.get("y10_p5")
    if not _ok(v, d, p) or abs(d) < 10:
        return None
    va = {"from": num(p) + "%", "to": num(v) + "%", "d": bp(d)}
    conf = HIGH if abs(d) >= 20 else MED
    return Hit(BULL, conf, "Rendimento decennale in calo: da {from} a {to} ({d} bp) in 5 sedute", va) if d < 0 else \
        Hit(BEAR, conf, "Rendimento decennale in salita: da {from} a {to} ({d} bp) in 5 sedute", va)


def r_dxy(x):
    v, c, p = x.get("dxy"), x.get("dxy_chg5"), x.get("dxy_p5")
    if not _ok(v, c, p) or abs(c) < 0.3:
        return None
    va = {"from": num(p), "to": num(v), "chg": pct(c)}
    conf = HIGH if abs(c) >= 2 else MED if abs(c) >= 1 else LOW
    return Hit(BULL, conf, "Dollaro più debole: DXY da {from} a {to} ({chg}) in 5 sedute", va) if c < 0 else \
        Hit(BEAR, conf, "Dollaro più forte: DXY da {from} a {to} ({chg}) in 5 sedute", va)


def r_fedfut(x):
    fut, ef, mo = x.get("zq_rate"), x.get("effr"), x.get("zq_month")
    if not _ok(fut, ef) or not mo:
        return None
    d = (fut - ef) * 100
    if abs(d) < 5:
        return None
    va = {"fut": num(fut) + "%", "now": num(ef) + "%", "d": bp(d), "mo": mo}
    extra = x.get("poly_hike")
    conf = HIGH if abs(d) >= 10 else MED
    if d > 0:
        if _ok(extra):
            return Hit(BEAR, conf, "Rialzo Fed prezzato: futures {mo} {fut} contro EFFR {now} ({d} bp); Polymarket {p}", {**va, "p": pct(extra, 0, False)})
        return Hit(BEAR, conf, "Rialzo Fed prezzato: futures {mo} {fut} contro EFFR {now} ({d} bp)", va)
    return Hit(BULL, conf, "Taglio Fed prezzato: futures {mo} {fut} contro EFFR {now} ({d} bp)", va)


def r_sofr(x):
    s, i = x.get("sofr"), x.get("iorb")
    if not _ok(s, i):
        return None
    d = (s - i) * 100
    va = {"s": num(s) + "%", "i": num(i) + "%", "d": bp(d)}
    if d >= 2:
        return Hit(BEAR, HIGH if d >= 5 else MED, "Finanziamento teso: SOFR {s} sopra IORB {i} ({d} bp)", va)
    if d <= -3:
        return Hit(BULL, LOW, "Finanziamento disteso: SOFR {s} sotto IORB {i} ({d} bp)", va)
    return None


def r_reserves(x):
    v, d = x.get("wres"), x.get("wres_chg1w")
    if not _ok(v, d) or abs(d) < 50e9:
        return None
    va = {"v": usd(v), "d": usd(d, True)}
    conf = HIGH if abs(d) >= 100e9 else MED
    return Hit(BEAR, conf, "Riserve bancarie {v}, {d} in una settimana", va) if d < 0 else \
        Hit(BULL, conf, "Riserve bancarie {v}, {d} in una settimana", va)


def r_tga(x):
    v, d = x.get("tga"), x.get("tga_chg4w")
    if not _ok(v, d) or abs(d) < 100e9:
        return None
    va = {"v": usd(v), "d": usd(d, True)}
    conf = HIGH if abs(d) >= 200e9 else MED
    return Hit(BEAR, conf, "Il Tesoro drena liquidità: TGA {v}, {d} in 4 settimane", va) if d > 0 else \
        Hit(BULL, conf, "Il Tesoro immette liquidità: TGA {v}, {d} in 4 settimane", va)


def r_rrp(x):
    v = x.get("rrp")
    if not _ok(v) or v > 50e9:
        return None
    return Hit(BEAR, LOW, "Reverse repo quasi vuoto: {v}, il cuscinetto di liquidità è finito", {"v": usd(v)})


def r_real(x):
    v = x.get("real10")
    if not _ok(v):
        return None
    va = {"v": num(v) + "%"}
    if v >= 2.5:
        return Hit(BEAR, HIGH if v >= 3 else MED, "Rendimento reale a 10 anni {v}, ancora alto", va)
    if v <= 1.5:
        return Hit(BULL, MED, "Rendimento reale a 10 anni {v}, basso", va)
    return None


def r_4h(x):
    c, e, a = x.get("c4"), x.get("ema4"), x.get("atr4")
    if not _ok(c, e, a) or a <= 0:
        return None
    z = (c - e) / a
    if abs(z) < 0.1:
        return None
    va = {"c": price(c), "e": price(e), "z": num(abs(z), 1)}
    conf = HIGH if abs(z) >= 1 else MED if abs(z) >= 0.25 else LOW
    return Hit(BULL, conf, "Ultima chiusura 4h {c} sopra EMA 50 ({e}), {z} ATR", va) if z > 0 else \
        Hit(BEAR, conf, "Ultima chiusura 4h {c} sotto EMA 50 ({e}), {z} ATR", va)


def r_emaw(x):
    p, e50, e100, wc = x.get("px"), x.get("ema50w"), x.get("ema100w"), x.get("wclose")
    if not _ok(p, e50, e100):
        return None
    va = {"p": price(p), "a": price(e50), "b": price(e100)}
    hi, lo = max(e50, e100), min(e50, e100)
    if p > hi:
        conf = MED if not _ok(wc) or wc <= hi else HIGH
        return Hit(BULL, conf, "Prezzo {p} sopra EMA 50w e 100w ({a}, {b})", va)
    if p < lo:
        conf = MED if not _ok(wc) or wc >= lo else HIGH
        return Hit(BEAR, conf, "Prezzo {p} sotto EMA 50w e 100w ({a}, {b})", va)
    return None


def r_wrun(x):
    n = x.get("wrun")
    if not _ok(n) or abs(n) < 3:
        return None
    va = {"n": str(int(abs(n)))}
    conf = HIGH if abs(n) >= 4 else MED
    return Hit(BEAR, conf, "{n} chiusure settimanali rosse di fila", va) if n < 0 else \
        Hit(BULL, conf, "{n} chiusure settimanali verdi di fila", va)


def r_etf(x):
    v = x.get("etf3")
    if not _ok(v) or abs(v) < 50e6:
        return None
    va = {"v": usd(v, True)}
    conf = HIGH if abs(v) >= 500e6 else MED if abs(v) >= 150e6 else LOW
    return Hit(BULL, conf, "ETF spot {v} nelle ultime 3 sedute riportate", va) if v > 0 else \
        Hit(BEAR, conf, "ETF spot {v} nelle ultime 3 sedute riportate", va)


def r_stable(x):
    a, b = x.get("usdt30"), x.get("usdc30")
    if not _ok(a, b):
        return None
    s = a + b
    if abs(s) < 0.5e9:
        return None
    va = {"a": usd(a, True), "b": usd(b, True)}
    conf = HIGH if abs(s) >= 5e9 else MED if abs(s) >= 2e9 else LOW
    return Hit(BEAR, conf, "USDT {a}, USDC {b} in 30 giorni: liquidità in uscita", va) if s < 0 else \
        Hit(BULL, conf, "USDT {a}, USDC {b} in 30 giorni: liquidità in entrata", va)


def r_spot(x):
    a, b = x.get("spot24"), x.get("spot7")
    if not _ok(a, b) or abs(a) < 50e6:
        return None
    va = {"a": usd(a, True), "b": usd(b, True)}
    same = (a > 0) == (b > 0)
    conf = HIGH if same and abs(a) >= 300e6 else MED if same else LOW
    return Hit(BULL, conf, "Spot in acquisto: CVD {a} in 24h, {b} in 7 giorni", va) if a > 0 else \
        Hit(BEAR, conf, "Spot in vendita: CVD {a} in 24h, {b} in 7 giorni", va)


def r_perpled(x):
    pc, s, f = x.get("px24"), x.get("spot24"), x.get("perp24")
    if not _ok(pc, s, f):
        return None
    va = {"p": pct(pc), "f": usd(f, True), "s": usd(s, True)}
    if pc >= 1 and f > 0 and s < f / 5:
        return Hit(BEAR, MED, "Rialzo guidato dai perpetui: prezzo {p}, perp {f} contro spot {s} in 24h", va)
    if pc <= -1 and s >= 0:
        return Hit(BULL, MED, "Lo spot assorbe il calo: prezzo {p}, spot {s}, perp {f} in 24h", va)
    return None


def r_cb(x):
    v = x.get("cb")
    if not _ok(v) or abs(v) < 0.05:
        return None
    va = {"v": pct(v, 2)}
    conf = MED if abs(v) >= 0.1 else LOW
    return Hit(BULL, conf, "Coinbase a premio ({v}, media 24h)", va) if v > 0 else \
        Hit(BEAR, conf, "Coinbase a sconto ({v}, media 24h)", va)


def r_exch(x):
    v, d = x.get("exch_chg30"), x.get("exch_d30")
    if not _ok(v, d) or abs(v) < 1:
        return None
    va = {"v": pct(v), "d": (MINUS if d < 0 else "+") + f"{abs(d) / 1000:.1f}K"}
    return Hit(BULL, LOW, "BTC sugli exchange {d} ({v}) in 30 giorni", va) if v < 0 else \
        Hit(BEAR, LOW, "BTC sugli exchange {d} ({v}) in 30 giorni", va)


def r_liq24(x):
    a, b, cov = x.get("liq_long"), x.get("liq_short"), x.get("liq_cov")
    if not _ok(a, b, cov) or cov < 0.6 or a + b < 20e6:
        return None
    va = {"l": usd(a), "s": usd(b)}
    hi, lo = max(a, b), max(min(a, b), 1.0)
    r = hi / lo
    if r < 1.5:
        return None
    conf = HIGH if r >= 3 and hi >= 100e6 else MED if r >= 2 else LOW
    return Hit(BULL, conf, "Short liquidati {s} contro long {l} in 24h", va) if b > a else \
        Hit(BEAR, conf, "Long liquidati {l} contro short {s} in 24h", va)


def r_oiprice(x):
    p, o = x.get("px24"), x.get("oi24")
    if not _ok(p, o) or abs(p) < 0.5 or abs(o) < 1:
        return None
    va = {"p": pct(p), "o": pct(o)}
    if p > 0 and o < 0:
        return Hit(BEAR, MED, "OI {o} con prezzo {p} in 24h: niente posizioni nuove dietro il rialzo", va)
    if p < 0 and o > 0:
        return Hit(BEAR, MED, "OI {o} con prezzo {p} in 24h: leva nuova nel calo", va)
    if p > 0 and o > 0:
        return Hit(BULL, LOW, "OI {o} con prezzo {p} in 24h: posizioni nuove nel rialzo", va)
    return Hit(BULL, LOW, "OI {o} con prezzo {p} in 24h: la leva si scarica", va)


def r_ls(x):
    v, p = x.get("long_pct"), x.get("long_pct_p")
    if not _ok(v):
        return None
    va = {"v": pct(v, 1, False), "p": pct(p, 1, False) if _ok(p) else "—"}
    if v >= 65:
        return Hit(BEAR, HIGH if v >= 72 else MED, "Conti long {v} (7 giorni fa {p}): posizionamento affollato", va)
    if v <= 48:
        return Hit(BULL, MED, "Conti long {v} (7 giorni fa {p}): mercato non affollato sul long", va)
    return None


def r_funding(x):
    f = x.get("funding")
    if not _ok(f):
        return None
    va = {"v": pct(f, 4, False) if f >= 0 else pct(f, 4)}
    if f >= 0.03:
        return Hit(BEAR, HIGH if f >= 0.05 else MED, "Funding {v} per 8h: oltre 3 volte la base dello 0.01%", va)
    if f < 0:
        return Hit(BULL, HIGH if f <= -0.01 else MED, "Funding {v} per 8h: gli short pagano i long", va)
    if f < 0.0095:
        return Hit(BULL, LOW, "Funding {v} per 8h, sotto la base dello 0.01%", va)
    return None


def r_book(x):
    b, a, lo, hi = x.get("wall_bid"), x.get("wall_ask"), x.get("wall_lo"), x.get("wall_hi")
    if not _ok(b, a) or b + a <= 0:
        return None
    hi_q, lo_q = max(a, b), max(min(a, b), 0.1)
    if hi_q / lo_q < 1.25:
        return None
    va = {"a": f"{a:,.0f}", "b": f"{b:,.0f}", "lo": price(lo) if _ok(lo) else "—", "hi": price(hi) if _ok(hi) else "—"}
    return Hit(BEAR, LOW, "Più muri in vendita: {a} BTC sopra contro {b} BTC sotto (entro ±1%)", va) if a > b else \
        Hit(BULL, LOW, "Più muri in acquisto: {b} BTC sotto contro {a} BTC sopra (entro ±1%)", va)


def r_liqmap(x):
    s, l_ = x.get("map7_short"), x.get("map7_long")
    if not _ok(s, l_) or min(s, l_) <= 0 or max(s, l_) / min(s, l_) < 1.5:
        return None
    va = {"s": usd(s), "l": usd(l_)}
    return Hit(BULL, LOW, "Mappa 7 giorni (stima): {s} di short sopra contro {l} di long sotto", va) if s > l_ else \
        Hit(BEAR, LOW, "Mappa 7 giorni (stima): {l} di long sotto contro {s} di short sopra", va)


def r_liqnear(x):
    s, l_, r = x.get("near_short"), x.get("near_long"), x.get("near_span")
    if not _ok(s, l_, r) or min(s, l_) <= 0 or max(s, l_) / min(s, l_) < 1.5:
        return None
    va = {"s": usd(s), "l": usd(l_), "r": price(r)}
    return Hit(BULL, LOW, "Mappa vicina al prezzo (stima): {s} di short entro {r} sopra contro {l} di long sotto", va) if s > l_ else \
        Hit(BEAR, LOW, "Mappa vicina al prezzo (stima): {l} di long entro {r} sotto contro {s} di short sopra", va)


def r_strc(x):
    v = x.get("strc")
    if not _ok(v):
        return None
    va = {"v": f"${v:.2f}"}
    if v >= 99.5:
        return Hit(BULL, LOW, "STRC a {v}, vicino alla parità di $100: Strategy può raccogliere capitale", va)
    if v <= 95:
        return Hit(BEAR, LOW, "STRC a {v}, sotto la parità di $100: raccolta di Strategy più difficile", va)
    return None


def r_fng(x):
    v = x.get("fng")
    if not _ok(v):
        return None
    va = {"v": f"{v:.0f}"}
    if v <= 20:
        return Hit(BULL, LOW, "Fear & Greed {v}: paura estrema (lettura contrarian)", va)
    if v >= 80:
        return Hit(BEAR, LOW, "Fear & Greed {v}: euforia estrema (lettura contrarian)", va)
    return None


def r_poly(m: dict):
    p, vol = m["p"], m["volume"]
    conf = MED if vol >= POLY_MED_VOLUME else LOW
    va = {"q": m["question"], "p": pct(p, 1, False), "vol": usd(vol)}
    if p >= 60:
        return Hit(BULL, conf, "Polymarket: \"{q}\" al {p} (volume {vol})", va)
    if p <= 25:
        return Hit(BEAR, conf, "Polymarket: \"{q}\" solo al {p} (volume {vol})", va)
    return None


@dataclass
class Rule:
    id: str
    cat: str
    label: str
    thr: str            # soglie dichiarate (mostrate in Metodo, tradotte nel frontend)
    source: str
    fn: Callable
    hist: bool = False  # True: ricostruibile nel tempo, entra nel backtest
    dep: tuple = ()     # chiavi usate per l'orario del dato


RULES: list[Rule] = [
    Rule("nq", "macro", "Nasdaq futures", "Variazione dell'ultima sessione: ±0.5% media, ±1% alta.", "Yahoo NQ=F", r_nq, True, ("nq",)),
    Rule("vix", "macro", "VIX", "VIX ≥ 25 ribassista (≥ 30 alta); +20% in 5 sedute ribassista; −15% in 5 sedute rialzista; ≤ 16 rialzista bassa.", "Yahoo ^VIX", r_vix, True, ("vix",)),
    Rule("hy", "macro", "Spread high yield", "≤ 3.5% rialzista alta; ≥ 5% ribassista alta; +0.30 pt in 5 sedute ribassista media.", "FRED BAMLH0A0HYM2", r_hy, True, ("hy",)),
    Rule("brent", "macro", "Brent", "Variazione in 5 sedute: ±5% media, ±10% alta. Calo rialzista, rialzo ribassista.", "Yahoo BZ=F", r_brent, True, ("brent",)),
    Rule("y10", "macro", "Decennale USA", "Variazione in 5 sedute: ±10 bp media, ±20 bp alta. Calo rialzista.", "FRED DGS10", r_10y, True, ("y10",)),
    Rule("dxy", "macro", "Dollaro DXY", "Variazione in 5 sedute: ±0.3% bassa, ±1% media, ±2% alta. Calo rialzista.", "Yahoo DX-Y.NYB", r_dxy, True, ("dxy",)),
    Rule("fedfut", "macro", "Futures Fed funds", "Tasso implicito del contratto del mese prossimo meno EFFR: ±5 bp media, ±10 bp alta. Rialzo prezzato ribassista.", "Yahoo ZQ, FRED EFFR, Polymarket", r_fedfut, False, ("effr",)),
    Rule("sofr", "macro", "SOFR contro IORB", "SOFR − IORB: ≥ +2 bp ribassista media, ≥ +5 bp alta; ≤ −3 bp rialzista bassa.", "FRED SOFR, IORB", r_sofr, True, ("sofr",)),
    Rule("reserves", "macro", "Riserve bancarie", "Variazione settimanale: ±$50B media, ±$100B alta.", "FRED WRESBAL", r_reserves, True, ("wres",)),
    Rule("tga", "macro", "Conto del Tesoro (TGA)", "Variazione in 4 settimane: ±$100B media, ±$200B alta. Aumento ribassista.", "FRED WTREGEN", r_tga, True, ("tga",)),
    Rule("rrp", "macro", "Reverse repo", "RRP ≤ $50B ribassista bassa.", "FRED RRPONTSYD", r_rrp, True, ("rrp",)),
    Rule("real", "macro", "Rendimento reale 10 anni", "≥ 2.5% ribassista media (≥ 3% alta); ≤ 1.5% rialzista media.", "FRED DFII10", r_real, True, ("real10",)),
    Rule("c4h", "struttura", "Chiusura 4h", "Distanza dall'EMA 50 in ATR 14: ≥ 0.1 bassa, ≥ 0.25 media, ≥ 1 alta.", "Binance BTCUSDT", r_4h, True, ("k4",)),
    Rule("emaw", "struttura", "EMA 50w e 100w", "Prezzo sopra o sotto entrambe: media; alta se anche l'ultima chiusura settimanale lo conferma.", "Binance BTCUSDT", r_emaw, True, ("kw",)),
    Rule("wrun", "struttura", "Serie settimanale", "Almeno 3 chiusure settimanali dello stesso colore: 3 media, 4 o più alta.", "Binance BTCUSDT", r_wrun, True, ("kw",)),
    Rule("etf", "flussi", "ETF spot", "Somma delle ultime 3 sedute: ±$50M bassa, ±$150M media, ±$500M alta.", "Farside", r_etf, True, ("etf",)),
    Rule("stable", "flussi", "USDT e USDC", "Variazione in 30 giorni di USDT + USDC: ±$0.5B bassa, ±$2B media, ±$5B alta.", "DefiLlama", r_stable, True, ("usdt",)),
    Rule("spot", "flussi", "CVD spot", "CVD 24h ≥ ±$50M; media se il 7 giorni ha lo stesso segno, alta da ±$300M.", "Binance spot", r_spot, False, ("flows",)),
    Rule("perpled", "flussi", "Perp contro spot", "Prezzo 24h ≥ +1% con perp in acquisto oltre 5 volte lo spot ribassista; prezzo ≤ −1% con spot ≥ 0 rialzista.", "Binance spot e perp", r_perpled, False, ("flows",)),
    Rule("cb", "flussi", "Premio Coinbase", "Media 24h: ±0.05% bassa, ±0.1% media.", "Coinbase, Binance", r_cb, True, ("cb",)),
    Rule("exch", "flussi", "BTC sugli exchange", "Variazione in 30 giorni oltre ±1%: bassa. Calo rialzista.", "Coin Metrics", r_exch, True, ("exch",)),
    Rule("liq24", "posizionamento", "Liquidazioni 24h", "Totale ≥ $20M, un lato ≥ 1.5 volte l'altro; 2 volte media, 3 volte e ≥ $100M alta. Raccolta attiva almeno il 60% delle 24h.", "Raccolta Binance, Bybit, OKX", r_liq24, False, ("liq",)),
    Rule("oiprice", "posizionamento", "OI contro prezzo", "|prezzo 24h| ≥ 0.5% e |OI 24h| ≥ 1%: segni opposti su, o OI su con prezzo giù, ribassista media; altri casi rialzista bassa.", "Binance, Bybit, OKX", r_oiprice, False, ("oi",)),
    Rule("ls", "posizionamento", "Conti long", "≥ 65% ribassista media (≥ 72% alta); ≤ 48% rialzista media.", "Binance", r_ls, False, ("ls",)),
    Rule("funding", "posizionamento", "Funding", "Media delle ultime 3 letture: ≥ 0.03% ribassista media (≥ 0.05% alta); negativo rialzista; sotto 0.0095% rialzista bassa.", "Binance", r_funding, True, ("funding",)),
    Rule("book", "posizionamento", "Muri del book", "Muri entro ±1%: un lato ≥ 1.25 volte l'altro, bassa.", "Book Binance perp", r_book, False, ("book",)),
    Rule("liqmap", "posizionamento", "Mappa liquidazioni", "Mappa 7 giorni: un lato ≥ 1.5 volte l'altro, bassa (è una stima).", "Modello interno", r_liqmap, False, ("map",)),
    Rule("liqnear", "posizionamento", "Mappa vicino al prezzo", "Stessa regola entro ±$2,000 dal prezzo, bassa (è una stima).", "Modello interno", r_liqnear, False, ("map",)),
    Rule("strc", "altro", "STRC", "Chiusura ≥ $99.50 rialzista bassa; ≤ $95 ribassista bassa.", "Yahoo STRC", r_strc, False, ("strc",)),
    Rule("fng", "altro", "Fear & Greed", "≤ 20 rialzista bassa; ≥ 80 ribassista bassa (contrarian).", "Alternative.me", r_fng, True, ("fng",)),
]
POLY_RULE = {"id": "poly", "cat": "politica", "label": "Polymarket",
             "thr": "Solo mercati attivi con volume ≥ $50K: legge sulla struttura dei mercati crypto e riserva BTC USA. SÌ ≥ 60% rialzista, ≤ 25% ribassista; media da $1M di volume, altrimenti bassa.",
             "source": "Polymarket Gamma"}


# ------------------------------------------------------------------ dati

def _safe(name: str) -> pd.DataFrame | None:
    try:
        d = store.get(name)
        return d if d is not None and len(d) else None
    except Exception as e:  # noqa: BLE001
        log.info("dataset %s non disponibile: %s", name, e)
        return None


def _col(name: str, col: str) -> pd.Series:
    """Serie giornaliera ordinata, indice UTC a mezzanotte."""
    d = _safe(name)
    if d is None or col not in d:
        return pd.Series(dtype=float)
    s = pd.Series(pd.to_numeric(d[col], errors="coerce").to_numpy(float), index=pd.to_datetime(d["time"], utc=True).dt.normalize())
    return s[~s.index.duplicated(keep="last")].dropna().sort_index()


def _fred(key: str) -> pd.Series:
    return _col(f"fred_{FRED_IDS[key].lower()}", "value") if f"fred_{FRED_IDS[key].lower()}" in store.REGISTRY else pd.Series(dtype=float)


def _ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def closed_bars(name: str, bar: pd.Timedelta) -> pd.DataFrame:
    """Candele chiuse del dataset (l'ultima, ancora aperta, viene esclusa)."""
    d = _safe(name)
    if d is None:
        return pd.DataFrame()
    d = d.copy()
    d["time"] = pd.to_datetime(d["time"], utc=True)
    return d[d["time"] + bar <= pd.Timestamp.now(tz="UTC")].sort_values("time").reset_index(drop=True)


def run_length(sign: np.ndarray) -> np.ndarray:
    """Per ogni posizione, la serie corrente dello stesso segno (positiva verdi, negativa rosse, 0 azzera)."""
    out = np.zeros(len(sign), dtype=int)
    for i, s in enumerate(sign):
        if s == 0:
            continue
        out[i] = (out[i - 1] + s) if i and out[i - 1] * s > 0 else s
    return out


def etf_reported() -> pd.Series:
    """Totale giornaliero in USD delle sole sedute riportate (la riga di oggi con i trattini non è una seduta)."""
    d = _safe("sd_etf")
    if d is None:
        return pd.Series(dtype=float)
    ncols = len([c for c in d.columns if c not in ("time", "total_reported", "n_dash")])
    d = d[d["n_dash"] < ncols - 1]
    s = pd.Series(d["total_reported"].to_numpy(float) * 1e6, index=pd.to_datetime(d["time"], utc=True).dt.normalize())
    return s.dropna().sort_index()


def exchange_supply() -> pd.Series:
    """BTC sugli exchange (Coin Metrics). I dati preliminari restano nella serie, ma l'ultimo giorno si scarta se salta di oltre l'1%."""
    s = _col("sd_exchange", "SplyExNtv")
    if len(s) > 5:
        if abs(s.iloc[-1] / s.iloc[-2] - 1) > 0.01:   # visto il 4 nov 2026: +41K BTC in un giorno su un dato preliminare
            s = s.iloc[:-1]
    return s


def daily_inputs(lagged: bool = False) -> tuple[pd.DataFrame, dict]:
    """Input giornalieri ricostruibili nel tempo. Con lagged=True ogni serie arriva il giorno in cui era pubblicata davvero."""
    S: dict[str, pd.Series] = {}
    asof: dict[str, pd.Timestamp] = {}

    def put(name: str, s: pd.Series, key: str | None = None, limit: int = 7) -> None:
        if not len(s):
            return
        k = key or name
        if k not in asof or s.index[-1] > asof[k]:
            asof[k] = s.index[-1]
        lag = LAG.get(k, 0) if lagged else 0
        S[name] = (s.shift(lag, freq="D") if lag else s, limit)  # type: ignore[assignment]

    nq = _col("sb_nq", "close")
    put("nq_chg", (nq / nq.shift(1) - 1) * 100, "nq")
    vix = _col("macro_vix", "close")
    put("vix", vix)
    put("vix_p5", vix.shift(5), "vix")
    put("vix_chg5", (vix / vix.shift(5) - 1) * 100, "vix")
    hy = _fred("hy")
    put("hy", hy)
    put("hy_chg5", hy - hy.shift(5), "hy")
    br = _col("sb_brent", "close")
    put("brent", br)
    put("brent_p5", br.shift(5), "brent")
    put("brent_chg5", (br / br.shift(5) - 1) * 100, "brent")
    y = _fred("y10")
    put("y10", y)
    put("y10_p5", y.shift(5), "y10")
    put("y10_chg5", (y - y.shift(5)) * 100, "y10")
    dx = _col("macro_dxy", "close")
    put("dxy", dx)
    put("dxy_p5", dx.shift(5), "dxy")
    put("dxy_chg5", (dx / dx.shift(5) - 1) * 100, "dxy")
    put("effr", _fred("effr"))
    put("sofr", _fred("sofr"))
    put("iorb", _fred("iorb"))
    w = _fred("wres") * 1e6
    put("wres", w, limit=10)
    put("wres_chg1w", w - w.shift(1), "wres", 10)
    tg = _fred("tga") * 1e6
    put("tga", tg, limit=10)
    put("tga_chg4w", tg - tg.shift(4), "tga", 10)
    put("rrp", _fred("rrp") * 1e9)
    put("real10", _fred("real10"))
    k4 = closed_bars("k_4h", pd.Timedelta(hours=4))
    if len(k4):
        c = pd.Series(k4["close"].to_numpy(float), index=k4["time"])
        tr = pd.concat([k4["high"] - k4["low"], (k4["high"] - k4["close"].shift()).abs(), (k4["low"] - k4["close"].shift()).abs()], axis=1).max(axis=1)
        atr = pd.Series(tr.to_numpy(float), index=k4["time"]).rolling(14).mean()
        # sul giorno d vale l'ultima 4h chiusa entro la fine di d (o l'ultima disponibile dal vivo)
        last = lambda s: s.groupby(s.index.normalize()).last()  # noqa: E731
        put("c4", last(c), "k4", 2)
        put("ema4", last(_ema(c, 50)), "k4", 2)
        put("atr4", last(atr), "k4", 2)
        asof["k4"] = k4["time"].iloc[-1] + pd.Timedelta(hours=4)
    kw = closed_bars("k_1w", pd.Timedelta(days=7))
    if len(kw):
        wc = pd.Series(kw["close"].to_numpy(float), index=(kw["time"] + pd.Timedelta(days=7)).dt.normalize())
        put("wclose", wc, "kw", 8)
        put("ema50w", _ema(wc, 50), "kw", 8)
        put("ema100w", _ema(wc, 100), "kw", 8)
        sign = np.sign((kw["close"] - kw["open"]).to_numpy(float)).astype(int)
        put("wrun", pd.Series(run_length(sign).astype(float), index=wc.index), "kw", 8)
    kd = _col("k_1d", "close")
    put("px", kd, "px", 2)
    etf = etf_reported()
    put("etf3", etf.rolling(3).sum(), "etf")
    usdt = _col("usdt_supply", "usdt")
    put("usdt30", usdt - usdt.shift(30, freq="D").reindex(usdt.index).ffill(), "usdt")
    usdc = _col("usdc_supply", "usdc")
    put("usdc30", usdc - usdc.shift(30, freq="D").reindex(usdc.index).ffill(), "usdc")
    ex = exchange_supply()
    if len(ex):
        prev = ex.shift(30, freq="D").reindex(ex.index).ffill()
        put("exch_chg30", (ex / prev - 1) * 100, "exch")
        put("exch_d30", ex - prev, "exch")
    try:
        from . import sentiment
        cb = sentiment._premium_daily()
        cb.index = pd.to_datetime(cb.index, utc=True).normalize()
        put("cb", cb, "cb", 3)
    except Exception as e:  # noqa: BLE001
        log.info("premio Coinbase non disponibile: %s", e)
    fu = _safe("funding")
    if fu is not None:
        r = pd.Series(fu["rate"].to_numpy(float) * 100, index=pd.to_datetime(fu["time"], utc=True)).sort_index().rolling(3).mean()
        put("funding", r.groupby(r.index.normalize()).last(), "funding", 2)
        asof["funding"] = pd.to_datetime(fu["time"], utc=True).iloc[-1]
    put("fng", _col("fng", "value") if _safe("fng") is not None and "value" in _safe("fng") else pd.Series(dtype=float), limit=3)
    put("strc", _col("sb_strc", "close"), limit=5)
    if not S:
        return pd.DataFrame(), asof
    start = min(v[0].index[0] for v in S.values())
    grid = pd.date_range(start, pd.Timestamp.now(tz="UTC").normalize(), freq="D")
    out = pd.DataFrame(index=grid)
    for k, (s, limit) in S.items():
        s = s[~s.index.duplicated(keep="last")]
        out[k] = s.reindex(grid.union(s.index)).ffill(limit=limit).reindex(grid)
    return out, asof


# ------------------------------------------------------------------ input solo dal vivo

def next_month_contract(now: pd.Timestamp) -> tuple[str, str]:
    """(simbolo Yahoo, 'yyyy-mm') del future Fed funds del mese successivo."""
    y, m = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
    return f"ZQ{ZQ_MONTHS[m - 1]}{y % 100:02d}.CBT", f"{y}-{m:02d}"


@util.ttl_cache(1800)
def _zq() -> dict:
    sym, mo = next_month_contract(pd.Timestamp.now(tz="UTC"))
    d = macro.yahoo_daily(sym, int(time.time()) - 20 * 86400)
    if d.empty:
        return {}
    return {"zq_rate": 100 - float(d["close"].iloc[-1]), "zq_month": mo, "zq_time": d["time"].iloc[-1]}


@util.ttl_cache(900)
def _poly_search(q: str) -> list[dict]:
    r = macro._client.get(POLY_URL, params={"q": q, "limit_per_type": 10, "events_status": "active"})
    r.raise_for_status()
    return r.json().get("events") or []


def parse_poly_events(events: list[dict], now: pd.Timestamp) -> list[dict]:
    """Mercati binari attivi di eventi a mercato unico (niente mercati su singoli voti o scaglioni)."""
    out = []
    for e in events:
        ms = e.get("markets") or []
        if len(ms) != 1 or e.get("closed"):
            continue
        m = ms[0]
        try:
            prices = json.loads(m.get("outcomePrices") or "[]")
            outcomes = json.loads(m.get("outcomes") or '["Yes","No"]')
            vol = float(m.get("volume") or 0)
            end = pd.Timestamp(m.get("endDate") or e.get("endDate"))
        except (ValueError, TypeError):
            continue
        if m.get("closed") or len(prices) != 2 or vol < POLY_MIN_VOLUME or end < now or str(outcomes[0]).lower() != "yes":
            continue
        out.append({"question": str(m.get("question") or e.get("title")), "p": float(prices[0]) * 100, "volume": vol,
                    "slug": e.get("slug"), "end": util.ts(end)})
    return out


def _poly() -> tuple[list[dict], str | None]:
    """Mercato più scambiato per ogni gruppo, e l'eventuale errore."""
    now = pd.Timestamp.now(tz="UTC")
    best, err = [], None
    for _g, queries in POLY_GROUPS:
        found: dict[str, dict] = {}
        for q in queries:
            try:
                for m in parse_poly_events(_poly_search(q), now):
                    found[m["slug"]] = m
            except Exception as e:  # noqa: BLE001
                err = str(e)[:120]
        if found:
            best.append(max(found.values(), key=lambda m: m["volume"]))
    return best, err


@util.ttl_cache(900)
def _poly_fed_hike() -> float | None:
    """Probabilità Polymarket di un rialzo Fed alla prossima riunione: seconda fonte per i futures."""
    try:
        for e in _poly_search("Fed decision"):
            if not str(e.get("slug", "")).startswith("fed-decision-in") or e.get("closed"):
                continue
            tot = 0.0
            for m in e.get("markets") or []:
                q = str(m.get("question") or "").lower()
                if "increase" in q and not m.get("closed"):
                    tot += float(json.loads(m.get("outcomePrices") or "[0]")[0])
            return tot * 100 if tot else None
    except Exception as e:  # noqa: BLE001
        log.info("Polymarket Fed non disponibile: %s", e)
    return None


def _oi24() -> tuple[float | None, pd.Timestamp | None]:
    from . import aggregate
    ser = aggregate.oi_15m_by_exchange()
    frames = []
    for e, d in ser.items():
        frames.append(pd.Series(d["oi"].to_numpy(float), index=pd.to_datetime(d["time"], utc=True), name=e))
    if len(frames) < 3:
        return None, None
    tot = pd.concat(frames, axis=1).sort_index().dropna().sum(axis=1)
    med = tot.rolling(9, center=True, min_periods=3).median()
    tot = tot[(tot / med - 1).abs() <= 0.03]
    if len(tot) < 100:
        return None, None
    t1 = tot.index[-1]
    prev = tot[tot.index <= t1 - DAY]
    return (float(tot.iloc[-1] / prev.iloc[-1] - 1) * 100 if len(prev) else None), t1


def _liq24() -> dict:
    from . import moves
    now = time.time()
    ev = store.liquidations()
    out = {"liq_long": 0.0, "liq_short": 0.0, "liq_cov": moves.collection_share(now - 86400, now), "liq_time": now}
    if ev is not None and len(ev):
        t = pd.to_datetime(ev["time"], utc=True)
        e = ev[t >= pd.Timestamp(now - 86400, unit="s", tz="UTC")]
        out["liq_long"] = float(e.loc[e["side"] == "long", "usd"].sum())
        out["liq_short"] = float(e.loc[e["side"] == "short", "usd"].sum())
    return out


def _book() -> dict:
    from ..routers import orderbook
    s = orderbook.build_signals("futures")
    if not s.get("synced") or not s.get("mid"):
        return {}
    walls = s.get("walls") or []
    b = [w for w in walls if w.get("side") == "bid"]
    a = [w for w in walls if w.get("side") == "ask"]
    return {"wall_bid": float(sum(w.get("qty") or 0 for w in b)), "wall_ask": float(sum(w.get("qty") or 0 for w in a)),
            "wall_lo": min((w["price"] for w in b), default=None), "wall_hi": max((w["price"] for w in a), default=None), "book_time": s.get("time")}


def _attempt(fn: Callable, errs: dict, key: str) -> dict:
    try:
        return fn() or {}
    except Exception as e:  # noqa: BLE001
        errs[key] = str(e)[:160]
        log.info("input %s non disponibile: %s", key, e)
        return {}


def live_inputs() -> tuple[dict, dict, dict]:
    """(input dal vivo, orari dei dati in secondi, errori per sorgente)."""
    errs: dict[str, str] = {}
    asof: dict[str, float] = {}
    x: dict = {}

    def flows() -> dict:
        from ..routers import flows as fl
        w = {r["label"]: r for r in fl.build(tf="1h", range="7d")["windows"]}
        asof["flows"] = time.time()
        return {"spot24": w["24h"]["spot_delta"], "spot7": w["7d"]["spot_delta"], "perp24": w["24h"]["perp_delta"], "px24": w["24h"]["price_change"]}

    def ls() -> dict:
        d = store.get("ls").sort_values("time")
        t = pd.to_datetime(d["time"], utc=True)
        prev = d[t <= t.iloc[-1] - pd.Timedelta(days=7)]
        asof["ls"] = t.iloc[-1].timestamp()
        return {"long_pct": float(d["long_pct"].iloc[-1]) * 100, "long_pct_p": float(prev["long_pct"].iloc[-1]) * 100 if len(prev) else None}

    def oi() -> dict:
        v, t = _oi24()
        if t is not None:
            asof["oi"] = t.timestamp()
        return {"oi24": v}

    def liq() -> dict:
        r = _liq24()
        asof["liq"] = r["liq_time"]
        return r

    def book() -> dict:
        r = _book()
        if r:
            asof["book"] = r.get("book_time") or time.time()
        return r

    def lmap() -> dict:
        from . import liq_leverage
        m = liq_leverage.summary("7d")
        asof["map"] = time.time()
        return {"map7_short": m["short_above"], "map7_long": m["long_below"], "near_short": m["near"]["short"], "near_long": m["near"]["long"], "near_span": m["near"]["span"]}

    def zq() -> dict:
        r = _zq()
        return {**{k: v for k, v in r.items() if k != "zq_time"}, "poly_hike": _poly_fed_hike()}

    for key, fn in (("flows", flows), ("ls", ls), ("oi", oi), ("liq", liq), ("book", book), ("map", lmap), ("zq", zq)):
        x.update(_attempt(fn, errs, key))
    return x, asof, errs


# ------------------------------------------------------------------ tabellone

def evaluate(x: dict, rules: list[Rule] | None = None) -> list[tuple[Rule, Hit | None]]:
    return [(r, r.fn(x)) for r in (rules or RULES)]


def _point(cat: str, rid: str, h: Hit, source: str, at: float | None) -> dict:
    return {"id": rid, "cat": cat, "side": h.side, "conf": h.conf, "tpl": h.tpl, "vars": h.vars, "source": source, "time": at}


def text_it(p: dict) -> str:
    """Testo italiano del punto (agenti e avvisi)."""
    s = p["tpl"]
    for k, v in p["vars"].items():
        s = s.replace("{" + k + "}", str(v))
    return s


def tally(points: list[dict]) -> dict:
    """Conteggi totali e per categoria: solo somme, nessuna ponderazione."""
    by = {c: {"bull": 0, "bear": 0} for c in CATS}
    for p in points:
        by[p["cat"]][p["side"]] += 1
    return {"bull": sum(v["bull"] for v in by.values()), "bear": sum(v["bear"] for v in by.values()), "by_cat": by}


def sort_points(points: list[dict]) -> list[dict]:
    order = {c: i for i, c in enumerate(CATS)}
    return sorted(points, key=lambda p: (order[p["cat"]], 0 if p["side"] == BULL else 1, -p["conf"], p["id"]))


def missing_reason(rule: Rule, x: dict, errs: dict) -> str | None:
    """Motivo per cui una regola non è valutabile (None: valutata, nessun punto perché il dato è entro le soglie)."""
    probes = {"hy": "hy", "sofr": "sofr", "reserves": "wres", "tga": "tga", "rrp": "rrp", "real": "real10", "y10": "y10", "fedfut": "effr"}
    if rule.id in probes and not _ok(x.get(probes[rule.id])):
        return "fred" if not macro.fred_key() else "data"
    needed = {"nq": "nq_chg", "vix": "vix", "brent": "brent", "dxy": "dxy", "c4h": "c4", "emaw": "ema50w", "wrun": "wrun", "etf": "etf3", "stable": "usdt30",
              "spot": "spot24", "perpled": "spot24", "cb": "cb", "exch": "exch_chg30", "oiprice": "oi24", "ls": "long_pct", "funding": "funding",
              "book": "wall_bid", "liqmap": "map7_short", "liqnear": "near_short", "strc": "strc", "fng": "fng", "liq24": "liq_cov"}
    k = needed.get(rule.id)
    if k and not _ok(x.get(k)):
        return "data"
    if rule.id == "liq24" and x.get("liq_cov", 0) < 0.6:
        return "coverage"
    return None


@util.ttl_cache(60)
def build() -> dict:
    D, asof_d = daily_inputs()
    x: dict = {}
    if len(D):
        row = D.iloc[-1]
        x = {k: (None if pd.isna(v) else float(v)) for k, v in row.items()}
    lv, asof_l, errs = live_inputs()
    x.update(lv)
    if x.get("px") is not None:
        try:
            t = src.binance_ticker()
            x["px"] = float(t["lastPrice"])
        except Exception:  # noqa: BLE001
            pass
    at: dict[str, float] = {k: v.timestamp() for k, v in asof_d.items()}
    at.update(asof_l)
    points, quiet, off = [], [], []
    for r, h in evaluate(x):
        t = max((at[d] for d in r.dep if d in at), default=None)
        if h is not None:
            points.append(_point(r.cat, r.id, h, r.source, t))
            continue
        why = missing_reason(r, x, errs)
        (off if why else quiet).append({"id": r.id, "cat": r.cat, "label": r.label, **({"reason": why} if why else {})})
    poly, perr = _poly()
    poly_shown = []
    for m in poly:
        h = r_poly(m)
        poly_shown.append({"question": m["question"], "p": m["p"], "volume": m["volume"], "slug": m["slug"], "point": bool(h)})
        if h:
            points.append(_point("politica", "poly_" + str(m["slug"])[:24], h, POLY_RULE["source"], time.time()))
    if perr and not poly:
        off.append({"id": "poly", "cat": "politica", "label": "Polymarket", "reason": "data"})
    points = sort_points(points)
    tl = tally(points)
    fresh = [p["time"] for p in points if p.get("time")]
    return util.clean({
        "time": time.time(), "bull": tl["bull"], "bear": tl["bear"], "by_cat": tl["by_cat"], "cats": list(CATS), "points": points,
        "quiet": quiet, "unavailable": off, "polymarket": poly_shown,
        "data_from": min(fresh) if fresh else None, "data_to": max(fresh) if fresh else None,
        "rules": [{"id": r.id, "cat": r.cat, "label": r.label, "thr": r.thr, "source": r.source, "hist": r.hist} for r in RULES] + [{**POLY_RULE, "hist": False}],
        "errors": errs,
    })


# ------------------------------------------------------------------ backtest

BT_START = pd.Timestamp("2021-02-01", tz="UTC")
BT_HORIZONS = (7, 30)
BT_MIN_RULES = 8


def daily_balance(D: pd.DataFrame) -> pd.DataFrame:
    """Per ogni giorno: bull, bear e regole valutabili. Solo le regole con storico, stesse funzioni usate dal vivo."""
    rules = [r for r in RULES if r.hist]
    rows = D.to_dict("records")
    out = []
    for x in rows:
        x = {k: (None if v is None or (isinstance(v, float) and math.isnan(v)) else v) for k, v in x.items()}
        b = s = n = 0
        for r in rules:
            if missing_reason(r, x, {}) is not None:
                continue
            n += 1
            h = r.fn(x)
            if h is not None:
                b += h.side == BULL
                s += h.side == BEAR
        out.append((b, s, n))
    return pd.DataFrame(out, columns=["bull", "bear", "n"], index=D.index)


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    return float(pd.Series(a).rank().corr(pd.Series(b).rank()))


def balance_stats(bal: pd.Series, px: pd.Series, h: int, seed: int = 7) -> dict | None:
    """Saldo del giorno d contro il rendimento BTC da d+1 a d+1+h. IC di Spearman con bootstrap a blocchi di h giorni."""
    fwd = (px.shift(-(h + 1)) / px.shift(-1) - 1) * 100
    d = pd.DataFrame({"b": bal, "f": fwd}).dropna()
    if len(d) < 200:
        return None
    a, f = d["b"].to_numpy(float), d["f"].to_numpy(float)
    rng = np.random.default_rng(seed)
    n, nb = len(d), max(2, len(d) // h)
    boots = []
    for _ in range(1000):
        starts = rng.integers(0, n - h + 1, nb)
        idx = (starts[:, None] + np.arange(h)[None, :]).ravel()
        boots.append(_spearman(a[idx], f[idx]))
    lo, hi = float(np.nanpercentile(boots, 2.5)), float(np.nanpercentile(boots, 97.5))
    q = pd.qcut(pd.Series(a).rank(method="first"), 3, labels=False).to_numpy()
    groups = []
    for g, name in ((0, "low"), (1, "mid"), (2, "high")):
        m = q == g
        groups.append({"group": name, "days": int(m.sum()), "balance_min": float(a[m].min()), "balance_max": float(a[m].max()),
                       "mean": float(f[m].mean()), "median": float(np.median(f[m])), "up_pct": float((f[m] > 0).mean() * 100)})
    return {"horizon": h, "days": n, "independent": n // h, "ic": _spearman(a, f), "ic_lo": lo, "ic_hi": hi,
            "base_mean": float(f.mean()), "base_up_pct": float((f > 0).mean() * 100), "groups": groups,
            "significant": bool(lo > 0 or hi < 0)}


@util.ttl_cache(6 * 3600)
def backtest() -> dict:
    D, _ = daily_inputs(lagged=True)
    if D.empty:
        return {"status": "unavailable", "rules": [], "horizons": []}
    D = D[D.index >= BT_START]
    B = daily_balance(D)
    B = B[B["n"] >= BT_MIN_RULES]
    px = _col("daily", "close")
    px = px.reindex(pd.date_range(px.index[0], px.index[-1], freq="D")).ffill()
    # saldo normalizzato: il numero di regole valutabili cresce nel tempo
    bal = (B["bull"] - B["bear"]) / B["n"]
    hs = [balance_stats(bal, px, h) for h in BT_HORIZONS]
    hs = [h for h in hs if h]
    if not hs:
        return {"status": "insufficient", "rules": [r.id for r in RULES if r.hist], "horizons": []}
    return util.clean({
        "status": "ok", "from": B.index[0], "to": B.index[-1], "days": len(B), "rules": [r.id for r in RULES if r.hist],
        "rules_live_only": [r.id for r in RULES if not r.hist] + ["poly"], "rules_min": int(B["n"].min()), "rules_max": int(B["n"].max()),
        "horizons": hs, "current": float(bal.iloc[-1]), "any_significant": any(h["significant"] for h in hs),
    })
