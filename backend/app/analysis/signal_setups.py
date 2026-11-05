"""Setup dei Segnali: regole esplicite, causali, identiche nel backtest e dal vivo.

Tutto si calcola da candele CHIUSE del perpetuo Binance USDⓈ-M BTCUSDT (5m aggregate) e, per il delta spot, dalle candele
spot Binance a 15m. Una riga del Frame dipende solo da dati noti alla chiusura di quella candela (test in tests/test_signals.py).

Famiglie: `low` = 15m e 1h (durata ore), `high` = 4h e 1g (durata giorni o settimane).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .anomalies import robust_z
from .market import atr as _atr
from .structure import adx as _adx
from .structure import zigzag_breaks, zigzag_confirmed

TF_S = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
FAMILY = {"15m": "low", "1h": "low", "4h": "high", "1d": "high"}
ANCHOR = {"15m": "w", "1h": "w", "4h": "m", "1d": "q"}            # VWAP ancorato di riferimento
HOLD_BARS = {"15m": 96, "1h": 72, "4h": 84, "1d": 42}              # 24 ore, 3 giorni, 14 giorni, 42 giorni
PEND_BARS = {"15m": 8, "1h": 8, "4h": 6, "1d": 4}                  # validità di un'entrata limite
WINDOW = {"15m": 16, "1h": 24, "4h": 18, "1d": 7}                  # finestra del delta (4 ore, 1 giorno, 3 giorni, 1 settimana)
WARMUP = 260
MIN_RISK_PCT = 0.4       # sotto, i costi di andata e ritorno superano 0,35R: il setup non emette
MAX_RISK_ATR = 4.0


@dataclass
class Frame:
    tf: str
    t: np.ndarray       # apertura candela (unix s)
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    a: np.ndarray       # ATR 14
    ema50: np.ndarray
    ema200: np.ndarray
    adx: np.ndarray
    trend: np.ndarray   # +1, -1, 0
    vol: np.ndarray     # percentile dell'ATR% sull'ultimo anno, 0..1
    vw: np.ndarray      # VWAP ancorato
    sd: np.ndarray      # deviazione standard pesata del VWAP
    pdelta: np.ndarray  # delta taker perp (BTC)
    sdelta: np.ndarray  # delta taker spot (BTC)
    fund: np.ndarray    # ultimo funding noto (%)
    fund_z: np.ndarray
    oi7: np.ndarray     # variazione % a 7 giorni dell'OI Bybit, con un giorno di ritardo

    @property
    def close_t(self) -> np.ndarray:
        return self.t + TF_S[self.tf]


@dataclass
class Cand:
    i: int
    tf: str
    setup: str
    side: int
    kind: str
    entry: float
    sl: float
    tp1: float
    tp2: float
    inv: float | None
    reasons: list[dict] = field(default_factory=list)
    params: dict = field(default_factory=dict)

    def key(self) -> str:
        return hyp_key(self.setup, self.tf, self.side)


def hyp_key(setup: str, tf: str, side: int) -> str:
    return f"{setup}|{tf}|{'long' if side > 0 else 'short'}"


# ------------------------------------------------------------------ frame

def anchor_key(t: np.ndarray, p: str) -> np.ndarray:
    """Chiave del periodo calendario UTC (w = lunedì, m = mese, q = trimestre) per ogni unix s."""
    days = t // 86400
    if p == "w":
        return days - ((days + 3) % 7)
    m = t.astype("datetime64[s]").astype("datetime64[M]").astype(np.int64)
    return m if p == "m" else m // 3


def anchored_vwap(t, h, l, c, v, p: str) -> tuple[np.ndarray, np.ndarray]:
    """Stessa formula di analysis/vwap.py: tp = (H+L+C)/3, VWAP = Σtp·v/Σv, σ = √(Σv·tp²/Σv − VWAP²)."""
    tp = (h + l + c) / 3
    g = pd.Series(anchor_key(t, p))
    sv = pd.Series(v).groupby(g).cumsum().to_numpy()
    spv = pd.Series(tp * v).groupby(g).cumsum().to_numpy()
    sp2 = pd.Series(v * tp * tp).groupby(g).cumsum().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        vw = spv / sv
        sd = np.sqrt(np.maximum(sp2 / sv - vw * vw, 0.0))
    return vw, sd


def secs(s) -> np.ndarray:
    return (pd.to_datetime(s, utc=True).astype("datetime64[s, UTC]").astype("int64")).to_numpy()


def resample(m5: pd.DataFrame, tf: str) -> tuple[pd.DataFrame, np.ndarray]:
    """Candele del timeframe dalle 5m. Scarta la candela finale se non è chiusa. Ritorna anche l'indice dell'ultima 5m di ogni candela."""
    step = TF_S[tf]
    t = secs(m5["time"])
    b = t // step * step
    d = pd.DataFrame({"b": b, "open": m5["open"].to_numpy(), "high": m5["high"].to_numpy(), "low": m5["low"].to_numpy(),
                      "close": m5["close"].to_numpy(), "volume": m5["volume"].to_numpy(), "tb": m5["taker_buy"].to_numpy(), "ix": np.arange(len(t))})
    g = d.groupby("b", sort=True).agg(open=("open", "first"), high=("high", "max"), low=("low", "min"), close=("close", "last"),
                                      volume=("volume", "sum"), tb=("tb", "sum"), ix=("ix", "last")).reset_index()
    if len(g) and g["b"].iloc[-1] + step > t[-1] + 300:     # ultima candela non ancora chiusa
        g = g.iloc[:-1]
    return g, g["ix"].to_numpy()


def build_frame(m5: pd.DataFrame, spot15: pd.DataFrame | None, funding: pd.DataFrame | None, oi_d: pd.DataFrame | None, tf: str) -> Frame:
    g, ix = resample(m5, tf)
    t = g["b"].to_numpy()
    step = TF_S[tf]
    df = pd.DataFrame({"high": g["high"], "low": g["low"], "close": g["close"]})
    a = _atr(df).to_numpy()
    close = g["close"]
    e50 = close.ewm(span=50, adjust=False, min_periods=50).mean().to_numpy()
    e200 = close.ewm(span=200, adjust=False, min_periods=200).mean().to_numpy()
    ax = _adx(df).to_numpy()
    c = close.to_numpy()
    trend = np.where((c > e200) & (e50 > e200) & (ax >= 20), 1, np.where((c < e200) & (e50 < e200) & (ax >= 20), -1, 0)).astype(np.int8)
    year = int(365 * 86400 / step)
    vol = pd.Series(a / c).rolling(year, min_periods=year // 4).rank(pct=True).to_numpy()

    t5 = secs(m5["time"])
    vw5, sd5 = anchored_vwap(t5, m5["high"].to_numpy(), m5["low"].to_numpy(), m5["close"].to_numpy(), m5["volume"].to_numpy(), ANCHOR[tf])
    vw, sd = vw5[ix], sd5[ix]

    pdelta = (2 * g["tb"] - g["volume"]).to_numpy()
    sdelta = np.full(len(t), np.nan)
    if spot15 is not None and len(spot15):
        st = secs(spot15["time"])
        b = st // step * step
        delta = pd.Series(2 * spot15["taker_buy"].to_numpy() - spot15["volume"].to_numpy())
        agg = delta.groupby(b).sum()
        cnt = delta.groupby(b).count()
        agg = agg[cnt >= max(1, step // 900)]      # solo candele con tutte le 15m disponibili
        sdelta = agg.reindex(t).to_numpy()

    fund = np.full(len(t), np.nan)
    fund_z = np.full(len(t), np.nan)
    if funding is not None and len(funding):
        ft = secs(funding["time"])
        fr = funding["rate"].to_numpy(float) * 100
        z = robust_z(fr, 270)
        k = np.searchsorted(ft, t + step, "left") - 1      # strettamente prima della chiusura: il funding di quell'istante non si dà per noto
        ok = k >= 0
        fund[ok] = fr[k[ok]]
        fund_z[ok] = z[k[ok]]

    oi7 = np.full(len(t), np.nan)
    if oi_d is not None and len(oi_d):
        ot = secs(oi_d["time"])
        x = oi_d[["oi_usdt", "oi_inverse_usd"]].fillna(0).sum(axis=1).to_numpy(float)
        x = np.where(x > 0, x, np.nan)
        ch = (pd.Series(x).pct_change(7, fill_method=None) * 100).to_numpy()
        # il valore del giorno D è completo a D+1 00:00 e si usa solo da lì in poi
        k = np.searchsorted(ot + 86400, t + step, "right") - 1
        ok = k >= 0
        oi7[ok] = ch[k[ok]]

    return Frame(tf, t, g["open"].to_numpy(), g["high"].to_numpy(), g["low"].to_numpy(), c, a, e50, e200, ax, trend, vol, vw, sd, pdelta, sdelta, fund, fund_z, oi7)


# ------------------------------------------------------------------ helper

def _roll_count(x: np.ndarray, n: int) -> np.ndarray:
    """Quanti True negli n valori precedenti (corrente escluso)."""
    return pd.Series(x.astype(float)).shift(1).rolling(n, min_periods=n).sum().fillna(0).to_numpy()


def _roll_ext(x: np.ndarray, n: int, side: int) -> np.ndarray:
    """Minimo (side=+1) o massimo (side=-1) degli ultimi n valori, corrente incluso."""
    r = pd.Series(x).rolling(n, min_periods=n)
    return (r.min() if side > 0 else r.max()).to_numpy()


def _prev(x: np.ndarray) -> np.ndarray:
    return pd.Series(x).shift(1).to_numpy()


def _regime_ok(F: Frame, side: int, mode: str) -> np.ndarray:
    if mode == "with":
        return F.trend == side
    if mode == "not_against":
        return F.trend != -side
    if mode == "range":
        return F.trend == 0
    return np.ones(len(F.t), bool)


def _mk(F: Frame, i: int, setup: str, side: int, kind: str, entry: float, sl: float, inv: float | None,
        reason: dict, p: dict, tp1: float | None = None, tp2: float | None = None) -> Cand | None:
    r = abs(entry - sl)
    if not np.isfinite(r) or r <= 0 or side * (entry - sl) <= 0:
        return None
    if r / entry * 100 < MIN_RISK_PCT or r > MAX_RISK_ATR * F.a[i]:
        return None
    if tp1 is None:
        tp1, tp2 = entry + side * p["a"] * r, entry + side * p["b"] * r
    if inv is not None and side * (inv - sl) <= 0:   # l'invalidazione deve scattare prima dello stop
        inv = None
    v = {k: (None if x is None else float(x) if isinstance(x, (int, float, np.floating, np.integer)) and not isinstance(x, bool) else x) for k, x in reason["v"].items()}
    return Cand(int(i), F.tf, setup, side, kind, float(entry), float(sl), float(tp1), float(tp2), None if inv is None else float(inv), [{"k": reason["k"], "v": v}], p)


# ------------------------------------------------------------------ setup

def vwap_reclaim(F: Frame, side: int, p: dict) -> list[Cand]:
    """Il prezzo resta dall'altra parte del VWAP e poi chiude di nuovo dal lato giusto, con almeno 0,1 ATR di margine."""
    d = side * (F.c - F.vw)
    hit = (_roll_count(d < 0, 6) >= 4) & (d > 0.1 * F.a) & (_prev(d) < 0) & _regime_ok(F, side, p["regime"])
    ext = _roll_ext(F.l if side > 0 else F.h, 6, side)
    out = []
    for i in np.flatnonzero(hit):
        if i >= WARMUP:
            c = _mk(F, i, "vwap_reclaim", side, "market", F.c[i], ext[i] - side * 0.2 * F.a[i], F.vw[i],
                    {"k": "vwap_reclaim", "v": {"anchor": ANCHOR[F.tf], "vwap": F.vw[i]}}, p)
            if c:
                out.append(c)
    return out


def vwap_reject(F: Frame, side: int, p: dict) -> list[Cand]:
    """Il prezzo è dal lato giusto del VWAP, lo tocca e chiude respinto con una candela nella direzione del segnale."""
    d = side * (F.c - F.vw)
    touch = (F.l <= F.vw) if side > 0 else (F.h >= F.vw)
    hit = (_roll_count(d > 0, 6) >= 5) & touch & (d > 0.1 * F.a) & (side * (F.c - F.o) > 0) & _regime_ok(F, side, p["regime"])
    out = []
    for i in np.flatnonzero(hit):
        if i >= WARMUP:
            sl = (F.l[i] if side > 0 else F.h[i]) - side * 0.3 * F.a[i]
            c = _mk(F, i, "vwap_reject", side, "market", F.c[i], sl, F.vw[i], {"k": "vwap_reject", "v": {"anchor": ANCHOR[F.tf], "vwap": F.vw[i]}}, p)
            if c:
                out.append(c)
    return out


def band_revert(F: Frame, side: int, p: dict) -> list[Cand]:
    """Ritorno alla media: chiusura oltre la banda ±kσ del VWAP e poi di nuovo dentro. Target: banda ±1σ e VWAP."""
    k = p["k"]
    band = F.vw - side * k * F.sd
    d = side * (F.c - band)
    hit = (_prev(d) < 0) & (d > 0) & (F.sd >= 0.5 * F.a) & (F.vol < 0.9) & _regime_ok(F, side, p["regime"])
    ext = _roll_ext(F.l if side > 0 else F.h, 3, side)
    out = []
    for i in np.flatnonzero(hit):
        if i < WARMUP:
            continue
        sl = ext[i] - side * 0.25 * F.a[i]
        r = abs(F.c[i] - sl)
        tp1, tp2 = F.vw[i] - side * F.sd[i], F.vw[i]
        if side * (tp1 - F.c[i]) < 0.5 * r or side * (tp2 - F.c[i]) < r:
            continue
        c = _mk(F, i, "band_revert", side, "market", F.c[i], sl, None,
                {"k": "band_revert", "v": {"anchor": ANCHOR[F.tf], "band": band[i], "sigma": k, "vwap": F.vw[i]}}, p, tp1=tp1, tp2=tp2)
        if c:
            out.append(c)
    return out


def _confirmed(F: Frame, mult: float) -> list[dict]:
    a = np.nan_to_num(F.a, nan=float(np.nanmean(F.a)))
    return [q for q in zigzag_confirmed(F.h, F.l, a, mult) if q["ci"] is not None]


def sweep(F: Frame, side: int, p: dict) -> list[Cand]:
    """Sweep di liquidità: la candela supera l'ultimo swing confermato e chiude di nuovo dentro, con stoppino di almeno metà candela."""
    conf = sorted(_confirmed(F, p["zz"]), key=lambda q: q["ci"])
    want = "low" if side > 0 else "high"
    reg = _regime_ok(F, side, p["regime"])
    out = []
    lvl = None
    pi = 0
    for i in range(len(F.t)):
        while pi < len(conf) and conf[pi]["ci"] <= i:
            if conf[pi]["kind"] == want:
                lvl = conf[pi]
            pi += 1
        if lvl is None or i < WARMUP:
            continue
        price = lvl["price"]
        if not (F.l[i] < price if side > 0 else F.h[i] > price):
            continue
        rng = F.h[i] - F.l[i]
        wick = (F.c[i] - F.l[i]) if side > 0 else (F.h[i] - F.c[i])
        if side * (F.c[i] - price) > 0 and i - lvl["i"] >= 5 and reg[i] and rng > 0 and wick / rng >= 0.5:
            ext = F.l[i] if side > 0 else F.h[i]
            c = _mk(F, i, "sweep", side, "market", F.c[i], ext - side * 0.2 * F.a[i], price, {"k": "sweep", "v": {"level": price, "extreme": ext}}, p)
            if c:
                out.append(c)
        lvl = None           # ogni swing si spazza una sola volta
    return out


def bos_retest(F: Frame, side: int, p: dict) -> list[Cand]:
    """Rottura di struttura in chiusura, poi entrata limite sul livello rotto (retest)."""
    want = ("bos_up", "choch_up") if side > 0 else ("bos_down", "choch_down")
    reg = _regime_ok(F, side, p["regime"])
    out = []
    for b in zigzag_breaks(_confirmed(F, 3.0), F.c):
        i = b["i"]
        if b["kind"] not in want or i < WARMUP or not reg[i] or not F.vol[i] >= 0.1:
            continue
        lvl, a = b["level"], F.a[i]
        if side * (F.c[i] - lvl) < 0.25 * a:      # troppo vicino: il retest non si distingue dalla rottura
            continue
        c = _mk(F, i, "bos_retest", side, "limit", lvl, lvl - side * p["sl_atr"] * a, lvl - side * 0.5 * a,
                {"k": "bos_retest", "v": {"level": lvl, "type": b["kind"].split("_")[0]}}, p)
        if c:
            out.append(c)
    return out


def cvd_div(F: Frame, side: int, p: dict) -> list[Cand]:
    """Divergenza del delta: il prezzo fa un nuovo estremo sulla finestra mentre spot e perp spingono in direzioni opposte."""
    w = WINDOW[F.tf]
    S = pd.Series(F.sdelta).rolling(w, min_periods=w).sum()
    P = pd.Series(F.pdelta).rolling(w, min_periods=w).sum()
    zs = ((S - S.rolling(500, min_periods=200).mean()) / S.rolling(500, min_periods=200).std()).to_numpy()
    zp = ((P - P.rolling(500, min_periods=200).mean()) / P.rolling(500, min_periods=200).std()).to_numpy()
    prev = pd.Series(F.c).shift(1).rolling(w, min_periods=w)
    new_ext = (F.c <= prev.min().to_numpy()) if side > 0 else (F.c >= prev.max().to_numpy())
    z = p["z"]
    hit = new_ext & (side * zs >= z) & (side * zp <= -z) & _regime_ok(F, side, p["regime"])
    ext = _roll_ext(F.l if side > 0 else F.h, 4, side)
    out = []
    last = -10 ** 9
    for i in np.flatnonzero(hit):
        if i < WARMUP or i - last < w:
            continue
        last = i
        c = _mk(F, i, "cvd_div", side, "market", F.c[i], ext[i] - side * 0.3 * F.a[i], ext[i],
                {"k": "cvd_div", "v": {"spot_z": zs[i], "perp_z": zp[i], "bars": w}}, p)
        if c:
            out.append(c)
    return out


def funding_ext(F: Frame, side: int, p: dict) -> list[Cand]:
    """Estremo di funding contro la direzione del segnale, con prezzo oltre ±1σ del VWAP. Filtro opzionale: OI in crescita a 7 giorni."""
    hit = (-side * F.fund_z >= p["z"]) & (side * (F.c - (F.vw - side * F.sd)) < 0) & (F.vol < 0.95)
    if p["oi"]:
        hit &= F.oi7 > 0
    out = []
    cool = int(3 * 86400 / TF_S[F.tf])
    last = -10 ** 9
    for i in np.flatnonzero(hit):
        if i < WARMUP or i - last < cool:
            continue
        last = i
        c = _mk(F, i, "funding_ext", side, "market", F.c[i], F.c[i] - side * 2 * F.a[i], F.c[i] - side * 1.5 * F.a[i],
                {"k": "funding_ext", "v": {"funding": F.fund[i], "z": F.fund_z[i], "vwap": F.vw[i], "oi7": F.oi7[i] if p["oi"] else None}}, p)
        if c:
            out.append(c)
    return out


def donchian(F: Frame, side: int, p: dict) -> list[Cand]:
    """Rottura del massimo o minimo di N candele, dal lato giusto della EMA 200 e con volatilità non compressa."""
    n = p["n"]
    ref = pd.Series(F.h if side > 0 else F.l).shift(1).rolling(n, min_periods=n)
    lvl = (ref.max() if side > 0 else ref.min()).to_numpy()
    d = side * (F.c - lvl)
    hit = (d > 0) & (_prev(d) <= 0) & (side * (F.c - F.ema200) > 0) & (F.vol >= 0.1)
    out = []
    for i in np.flatnonzero(hit):
        if i >= WARMUP:
            c = _mk(F, i, "donchian", side, "market", F.c[i], F.c[i] - side * 2 * F.a[i], lvl[i] - side * F.a[i], {"k": "donchian", "v": {"level": lvl[i], "bars": n}}, p)
            if c:
                out.append(c)
    return out


def _grid(**kw) -> list[dict]:
    out: list[dict] = [{}]
    for k, vs in kw.items():
        out = [dict(o, **(v if isinstance(v, dict) else {k: v})) for o in out for v in vs]
    return out


EXITS = [{"a": 1.0, "b": 2.0}, {"a": 1.5, "b": 3.0}]

SETUPS: dict[str, dict] = {
    "vwap_reclaim": {"fn": vwap_reclaim, "tfs": ("15m", "1h", "4h", "1d"), "grid": _grid(regime=("with", "any"), x=EXITS)},
    "vwap_reject": {"fn": vwap_reject, "tfs": ("15m", "1h", "4h", "1d"), "grid": _grid(regime=("with", "any"), x=EXITS)},
    "band_revert": {"fn": band_revert, "tfs": ("15m", "1h", "4h", "1d"), "grid": _grid(regime=("range", "any"), k=(2.0, 2.5))},
    "sweep": {"fn": sweep, "tfs": ("15m", "1h", "4h", "1d"), "grid": _grid(regime=("with", "any"), zz=(2.0, 3.0), x=EXITS)},
    "bos_retest": {"fn": bos_retest, "tfs": ("15m", "1h", "4h", "1d"), "grid": _grid(regime=("with", "any"), sl_atr=(0.75, 1.25), x=EXITS)},
    "cvd_div": {"fn": cvd_div, "tfs": ("15m", "1h", "4h", "1d"), "grid": _grid(regime=("not_against", "any"), z=(0.5, 1.0), x=EXITS)},
    "funding_ext": {"fn": funding_ext, "tfs": ("1h", "4h", "1d"), "grid": _grid(z=(2.0, 3.0), oi=(False, True), x=EXITS)},
    "donchian": {"fn": donchian, "tfs": ("4h", "1d"), "grid": _grid(n=(20, 55), x=[{"a": 1.5, "b": 3.0}, {"a": 2.0, "b": 4.0}])},
}


# Parametri scelti solo sui dati di sviluppo (fino al 31 dic 2023) e congelati: non si ritoccano dopo aver visto l'holdout.
# Il backtest ricontrolla che la scelta sul periodo di sviluppo porti ancora a questi valori (campo frozen_ok).
FROZEN: dict[str, dict] = {
    "vwap_reclaim|15m|long": {"regime": "any", "a": 1.5, "b": 3.0},
    "vwap_reclaim|15m|short": {"regime": "with", "a": 1.0, "b": 2.0},
    "vwap_reclaim|1h|long": {"regime": "with", "a": 1.5, "b": 3.0},
    "vwap_reclaim|1h|short": {"regime": "with", "a": 1.0, "b": 2.0},
    "vwap_reclaim|4h|long": {"regime": "any", "a": 1.5, "b": 3.0},
    "vwap_reclaim|4h|short": {"regime": "with", "a": 1.0, "b": 2.0},
    "vwap_reclaim|1d|long": {"regime": "any", "a": 1.5, "b": 3.0},
    "vwap_reclaim|1d|short": {"regime": "with", "a": 1.0, "b": 2.0},
    "vwap_reject|15m|long": {"regime": "with", "a": 1.5, "b": 3.0},
    "vwap_reject|15m|short": {"regime": "with", "a": 1.5, "b": 3.0},
    "vwap_reject|1h|long": {"regime": "any", "a": 1.5, "b": 3.0},
    "vwap_reject|1h|short": {"regime": "with", "a": 1.5, "b": 3.0},
    "vwap_reject|4h|long": {"regime": "with", "a": 1.5, "b": 3.0},
    "vwap_reject|4h|short": {"regime": "any", "a": 1.0, "b": 2.0},
    "vwap_reject|1d|long": {"regime": "with", "a": 1.0, "b": 2.0},
    "vwap_reject|1d|short": {"regime": "with", "a": 1.0, "b": 2.0},
    "band_revert|15m|long": {"regime": "range", "k": 2.0},
    "band_revert|15m|short": {"regime": "range", "k": 2.0},
    "band_revert|1h|long": {"regime": "range", "k": 2.0},
    "band_revert|1h|short": {"regime": "range", "k": 2.5},
    "band_revert|4h|long": {"regime": "any", "k": 2.0},
    "band_revert|4h|short": {"regime": "any", "k": 2.5},
    "band_revert|1d|long": {"regime": "range", "k": 2.0},
    "band_revert|1d|short": {"regime": "any", "k": 2.0},
    "sweep|15m|long": {"regime": "with", "zz": 2.0, "a": 1.5, "b": 3.0},
    "sweep|15m|short": {"regime": "with", "zz": 3.0, "a": 1.0, "b": 2.0},
    "sweep|1h|long": {"regime": "with", "zz": 3.0, "a": 1.5, "b": 3.0},
    "sweep|1h|short": {"regime": "with", "zz": 3.0, "a": 1.0, "b": 2.0},
    "sweep|4h|long": {"regime": "any", "zz": 2.0, "a": 1.5, "b": 3.0},
    "sweep|4h|short": {"regime": "any", "zz": 3.0, "a": 1.0, "b": 2.0},
    "sweep|1d|long": {"regime": "with", "zz": 2.0, "a": 1.0, "b": 2.0},
    "sweep|1d|short": {"regime": "with", "zz": 2.0, "a": 1.0, "b": 2.0},
    "bos_retest|15m|long": {"regime": "any", "sl_atr": 1.25, "a": 1.0, "b": 2.0},
    "bos_retest|15m|short": {"regime": "with", "sl_atr": 0.75, "a": 1.5, "b": 3.0},
    "bos_retest|1h|long": {"regime": "any", "sl_atr": 1.25, "a": 1.5, "b": 3.0},
    "bos_retest|1h|short": {"regime": "with", "sl_atr": 1.25, "a": 1.5, "b": 3.0},
    "bos_retest|4h|long": {"regime": "any", "sl_atr": 1.25, "a": 1.5, "b": 3.0},
    "bos_retest|4h|short": {"regime": "any", "sl_atr": 1.25, "a": 1.0, "b": 2.0},
    "bos_retest|1d|long": {"regime": "with", "sl_atr": 0.75, "a": 1.0, "b": 2.0},
    "bos_retest|1d|short": {"regime": "with", "sl_atr": 0.75, "a": 1.0, "b": 2.0},
    "cvd_div|15m|long": {"regime": "any", "z": 0.5, "a": 1.5, "b": 3.0},
    "cvd_div|15m|short": {"regime": "any", "z": 1.0, "a": 1.5, "b": 3.0},
    "cvd_div|1h|long": {"regime": "any", "z": 0.5, "a": 1.0, "b": 2.0},
    "cvd_div|1h|short": {"regime": "not_against", "z": 0.5, "a": 1.0, "b": 2.0},
    "cvd_div|4h|long": {"regime": "not_against", "z": 0.5, "a": 1.0, "b": 2.0},
    "cvd_div|4h|short": {"regime": "not_against", "z": 0.5, "a": 1.0, "b": 2.0},
    "cvd_div|1d|long": {"regime": "not_against", "z": 0.5, "a": 1.0, "b": 2.0},
    "cvd_div|1d|short": {"regime": "not_against", "z": 0.5, "a": 1.0, "b": 2.0},
    "funding_ext|1h|long": {"z": 2.0, "oi": False, "a": 1.5, "b": 3.0},
    "funding_ext|1h|short": {"z": 3.0, "oi": True, "a": 1.5, "b": 3.0},
    "funding_ext|4h|long": {"z": 2.0, "oi": False, "a": 1.5, "b": 3.0},
    "funding_ext|4h|short": {"z": 3.0, "oi": True, "a": 1.0, "b": 2.0},
    "funding_ext|1d|long": {"z": 2.0, "oi": False, "a": 1.0, "b": 2.0},
    "funding_ext|1d|short": {"z": 3.0, "oi": False, "a": 1.0, "b": 2.0},
    "donchian|4h|long": {"n": 55, "a": 2.0, "b": 4.0},
    "donchian|4h|short": {"n": 20, "a": 2.0, "b": 4.0},
    "donchian|1d|long": {"n": 20, "a": 1.5, "b": 3.0},
    "donchian|1d|short": {"n": 20, "a": 1.5, "b": 3.0},
}


def candidates(F: Frame, setup: str, side: int, params: dict) -> list[Cand]:
    return SETUPS[setup]["fn"](F, side, params)
