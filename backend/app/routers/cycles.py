"""Router CYCLES: /cycles — cicli rilevati, durate adattive, proiezioni, overlay, modelli."""
from __future__ import annotations

import logging
import math

import numpy as np
import pandas as pd
from fastapi import APIRouter

from .. import util
from ..analysis import cycles as cy
from ..data import store

log = logging.getLogger("cycles")
router = APIRouter()

OVERLAY_DAYS = 1500
FUTURE_YEARS = 3.5


def _ts(t) -> int:
    return util.ts(t)


def _pt(t, v, sig=5) -> dict:
    return {"time": _ts(t), "value": cy.round_sig(util.num(v), sig) if util.num(v) is not None else None}


def _weekly(s: pd.Series) -> pd.Series:
    """Sotto-campiona a 1 punto ogni 7 giorni (ancorato all'ultimo punto) mantenendo l'ultimo."""
    s = s.dropna()
    if len(s) == 0:
        return s
    idx = np.arange(len(s) - 1, -1, -7)[::-1]
    return s.iloc[idx]


def _series(s: pd.Series, sig=5) -> list[dict]:
    return [_pt(t, v, sig) for t, v in _weekly(s).items()]


def load_daily() -> pd.DataFrame:
    def safe(name):
        try:
            return store.get(name)
        except Exception as e:  # noqa: BLE001
            log.warning("dataset %s non disponibile: %s", name, e)
            return None
    return cy.merged_daily(safe("daily"), safe("onchain"), safe("k_1d"))


def _next_halving() -> tuple[pd.Timestamp, int | None, int | None]:
    """Stima del prossimo halving dall'altezza corrente (mempool.space) o, in mancanza, a 10 min/blocco."""
    try:
        from .onchain import mempool_snapshot
        mp = mempool_snapshot()
    except Exception:  # noqa: BLE001
        mp = {}
    height = mp.get("height") if isinstance(mp, dict) else None
    if isinstance(height, (int, float)) and height > 840_000:
        avg = 600.0
        diff = mp.get("difficulty") or {}
        ta = diff.get("timeAvg")
        if isinstance(ta, (int, float)) and 300_000 < ta < 900_000:
            avg = 0.5 * ta / 1000 + 0.5 * 600  # media recente smorzata verso il target
        left = int(cy.NEXT_HALVING_BLOCK - height)
        eta = pd.Timestamp.now(tz="UTC") + pd.Timedelta(seconds=left * avg)
        return eta, int(height), left
    eta = cy.HALVINGS[-1][1] + pd.Timedelta(seconds=210_000 * 600)
    return eta, None, None


def _price_at(df: pd.DataFrame, t: pd.Timestamp, col="close") -> float:
    i = df.index.searchsorted(t)
    i = min(i, len(df) - 1)
    return float(df[col].iloc[i])


def _days(a, b) -> int:
    return int(round((b - a) / pd.Timedelta(days=1)))


@util.ttl_cache(300)
def _build_heavy() -> dict:
    df = load_daily()
    close = df["close"]
    now = df.index[-1]
    price = float(close.iloc[-1])

    tops = cy.detect_tops(df)
    # un massimo troppo recente con prezzo ancora vicino non è confermato
    if tops and (now - tops[-1]).days < 90 and price > 0.8 * df["high"].loc[tops[-1]]:
        tops = tops[:-1]
    bottoms = cy.detect_bottoms(df, tops)

    # ---------------------------------------------------------- halvings
    eta, height, blocks_left = _next_halving()
    halvings = [{"n": n, "time": _ts(t), "block": blk, "price": _price_at(df, t), "estimated": False}
                for n, t, blk in cy.HALVINGS]
    halvings.append({"n": 5, "time": _ts(eta), "block": cy.NEXT_HALVING_BLOCK, "price": None, "estimated": True})
    halving_times = [t for _, t, _ in cy.HALVINGS]

    def halving_before(t):
        hs = [h for h in halving_times if h <= t]
        return hs[-1] if hs else None

    # ----------------------------------------------------------- cicli
    cycles = []
    for k, b in enumerate(bottoms):
        top = next((t for t in tops if t > b), None)
        nb = bottoms[k + 1] if k + 1 < len(bottoms) else None
        bp = float(df["low"].loc[b])
        tp = float(df["high"].loc[top]) if top is not None else None
        c = {"n": k + 1, "bottom": {"time": _ts(b), "price": bp},
             "top": {"time": _ts(top), "price": tp} if top is not None else None,
             "next_bottom": {"time": _ts(nb), "price": float(df["low"].loc[nb])} if nb is not None else None,
             "days_bottom_to_top": _days(b, top) if top is not None else None,
             "days_top_to_bottom": _days(top, nb) if (top is not None and nb is not None) else None,
             "days_halving_to_top": None, "gain": None, "drawdown": None,
             "status": "complete" if nb is not None else "in_progress"}
        if top is not None:
            h = halving_before(top)
            if h is not None and h > b:
                c["days_halving_to_top"] = _days(h, top)
            c["gain"] = (tp / bp - 1) * 100
            if nb is not None:
                c["drawdown"] = (float(df["low"].loc[nb]) / tp - 1) * 100
            else:  # ciclo in corso: drawdown massimo finora
                c["drawdown"] = (float(df["low"].loc[top:].min()) / tp - 1) * 100
        c["_b"], c["_t"], c["_nb"] = b, top, nb
        cycles.append(c)

    cur = cycles[-1] if cycles else None
    last_top = tops[-1] if tops else None
    last_bottom = bottoms[-1] if bottoms else df.index[0]
    n_next = (cur["n"] + 1) if cur else 1

    # --------------------------------------------- trend adattivo durate
    def series_of(key):
        return [(c["n"], c[key]) for c in cycles if c.get(key) is not None]

    b2t = series_of("days_bottom_to_top")
    t2b = series_of("days_top_to_bottom")
    h2t = series_of("days_halving_to_top")
    b2b = [(c["n"], _days(c["_b"], c["_nb"])) for c in cycles if c["_nb"] is not None]
    t2t = []
    for i in range(1, len(tops)):
        nn = next((c["n"] for c in cycles if c["_t"] == tops[i]), None)
        if nn is not None:
            t2t.append((nn, _days(tops[i - 1], tops[i])))

    def proj(pairs, n_target, drop_first=True):
        # il ciclo 2011-2013 (mercato immaturo, minimo a ridosso dell'halving) distorce le durate:
        # escluso dai fit quando restano almeno 2 cicli successivi
        if drop_first and len([p for p in pairs if p[0] > 1]) >= 2:
            pairs = [p for p in pairs if p[0] > 1]
        if not pairs:
            return float("nan"), float("nan")
        ns, ys = zip(*pairs)
        return cy.adaptive_projection(list(ns), list(ys), n_target)

    # per il ciclo in corso: la discesa top->bottom del ciclo cur["n"], la salita del ciclo successivo
    t2b_next_n = cur["n"] if (cur and cur["_t"] is not None and cur["_nb"] is None) else n_next
    p_t2b, u_t2b = proj(t2b, t2b_next_n, drop_first=False)
    p_b2b, u_b2b = proj(b2b, t2b_next_n)
    p_b2t, u_b2t = proj(b2t, n_next if cur and cur["_t"] is not None else (cur["n"] if cur else 1))
    p_h2t, u_h2t = proj(h2t, n_next if cur and cur["_t"] is not None else (cur["n"] if cur else 1))
    p_t2t, u_t2t = proj(t2t, n_next)

    def trend_entry(metric, pairs, p):
        return {"metric": metric, "values": [{"n": n, "days": d} for n, d in pairs],
                "projected_next": round(p) if p == p else None}

    durations_trend = [
        trend_entry("Minimo → Massimo", b2t, p_b2t),
        trend_entry("Massimo → Minimo", t2b, p_t2b),
        trend_entry("Halving → Massimo", h2t, p_h2t),
        trend_entry("Minimo → Minimo (ciclo completo)", b2b, p_b2b),
        trend_entry("Massimo → Massimo", t2t, p_t2t),
    ]

    # ------------------------------------------ rendimenti decrescenti
    gains = [(c["n"], c["gain"]) for c in cycles if c["gain"] is not None]
    dds = [(c["n"], c["drawdown"]) for c in cycles if c["drawdown"] is not None and c["status"] == "complete"]
    # gain: ln(ln(multiplo)) decresce ~linearmente -> proiezione geometrica sul log-rendimento
    if gains:
        ns, gs = zip(*gains)
        llg = [math.log(math.log(1 + g / 100)) for g in gs]
        llg_next, llg_unc = cy.adaptive_projection(list(ns), llg, n_next, lo_clip=-5, hi_clip=1.0, max_points=4)
        if llg_next < 0:  # adaptive_projection clippa a min*lo: sui log può essere negativo, ricalcola libero
            b_, a_ = cy.wlinfit(ns[-4:], llg[-4:], [1.7 ** i for i in range(len(ns[-4:]))])
            llg_next = 0.65 * (a_ + b_ * n_next) + 0.35 * llg[-1]
        mult_next = math.exp(math.exp(llg_next))
        mult_lo = math.exp(math.exp(llg_next - max(llg_unc, 0.15)))
        mult_hi = math.exp(math.exp(llg_next + max(llg_unc, 0.15)))
    else:
        mult_next, mult_lo, mult_hi = 3.0, 2.0, 4.5
    if dds:
        ns, ds = zip(*dds)
        dd_next, dd_unc = cy.adaptive_projection(list(ns), [-d for d in ds], t2b_next_n, lo_clip=0.75, hi_clip=1.0)
    else:
        dd_next, dd_unc = 75.0, 8.0

    # ------------------------------------------------------- modelli
    pl = cy.fit_power_law(close)
    future_idx = pd.date_range(now + pd.Timedelta(days=7), now + pd.Timedelta(days=int(365 * FUTURE_YEARS)), freq="7D")
    full_idx = close.index.append(future_idx)
    fair_full = pd.Series(pl.fair(full_idx), index=full_idx)
    fair_now = float(pl.fair(pd.DatetimeIndex([now]))[0])

    def pl_at(t, q):
        return float(pl.fair(pd.DatetimeIndex([t]))[0] * 10 ** q)

    s111 = cy.sma(close, 111)
    s350x2 = cy.sma(close, 350) * 2
    s200 = cy.sma(close, 200)
    s730 = cy.sma(close, 730)
    w200 = cy.sma(close, 1400)  # 200 settimane
    mayer = close / s200
    crosses = cy.pi_cycle_crosses(s111, s350x2)
    pi_dist = (float(s111.iloc[-1]) / float(s350x2.iloc[-1]) - 1) * 100

    rq = pl.resid_q
    bands = []
    resid_now = math.log10(price / fair_now)
    cur_band = cy.RAINBOW[0][0] if resid_now < rq[1] else cy.RAINBOW[-1][0]
    for i, (name, color) in enumerate(cy.RAINBOW):
        upper = fair_full * 10 ** rq[i + 1]
        bands.append({"name": name, "color": color, "series": _series(upper, 4)})
        if rq[i] <= resid_now < rq[i + 1]:
            cur_band = name

    # -------------------------------------- proiezione prossimo minimo
    est_next_bottom = None
    est_next_top = None
    notes: list[str] = []
    since_top_low_t = since_top_low = None
    rebound = None
    if last_top is not None and cur and cur["_nb"] is None:
        seg = df["low"].loc[last_top:]
        since_top_low_t = seg.idxmin()
        since_top_low = float(seg.min())
        rebound = (price / since_top_low - 1) * 100
        top_price = float(df["high"].loc[last_top])
        mids = []
        if p_t2b == p_t2b:
            mids.append(last_top + pd.Timedelta(days=p_t2b))
        if p_b2b == p_b2b:
            mids.append(last_bottom + pd.Timedelta(days=p_b2b))
        mid = pd.Timestamp(np.mean([m.value for m in mids]), tz="UTC") if mids else last_top + pd.Timedelta(days=365)
        unc = max(45.0, float(np.nanmean([u_t2b, u_b2b])) * 1.5)
        dd_price = top_price * (1 - dd_next / 100)
        cands = sorted([dd_price, pl_at(mid, pl.q_lo), pl_at(mid, rq[1]),
                        float(w200.iloc[-1]) if w200.notna().iloc[-1] else dd_price])
        lo_p = float(np.mean(cands[:2]))
        hi_p = float(np.mean(cands[-2:]))
        est_next_bottom = {"from": _ts(mid - pd.Timedelta(days=unc)), "to": _ts(mid + pd.Timedelta(days=unc)),
                           "mid": _ts(mid), "price_low": lo_p, "price_high": hi_p}
        bottom_mid, bottom_lo, bottom_hi = mid, lo_p, hi_p
        # se il minimo dopo il top è già nella finestra e il rimbalzo è solido -> minimo probabile
        probable_bottom = (rebound is not None and rebound >= 30 and (now - since_top_low_t).days >= 60
                           and since_top_low_t >= mid - pd.Timedelta(days=unc * 2.2))
        if probable_bottom:
            bottom_mid = since_top_low_t
            bottom_lo = bottom_hi = since_top_low
    else:
        bottom_mid, bottom_lo, bottom_hi = last_bottom, float(df["low"].loc[last_bottom]), float(df["low"].loc[last_bottom])
        probable_bottom = False

    # ---------------------------------------- proiezione prossimo massimo
    if last_top is not None and cur and cur["_nb"] is None:
        base_bottom_t = bottom_mid
    else:
        base_bottom_t = last_bottom
    tops_mid = []
    if p_b2t == p_b2t:
        tops_mid.append(base_bottom_t + pd.Timedelta(days=p_b2t))
    nh = eta if (cur and cur["_t"] is not None) else halving_before(now)
    if p_h2t == p_h2t and nh is not None:
        tops_mid.append(nh + pd.Timedelta(days=p_h2t))
    if tops_mid and not (cur and cur["_t"] is None and last_top is None):
        tmid = pd.Timestamp(np.mean([m.value for m in tops_mid]), tz="UTC")
        tunc = max(60.0, float(np.nanmean([u_b2t, u_h2t])) * 1.5)
        b_lo, b_hi = (bottom_lo, bottom_hi) if cur and cur["_t"] is not None else (float(df["low"].loc[last_bottom]),) * 2
        t_lo = min(b_lo * mult_lo, b_hi * mult_next)
        t_hi = max(b_hi * mult_hi, b_lo * mult_next)
        # limite superiore ragionevole: banda alta power law
        cap = pl_at(tmid, rq[-2])
        t_hi = min(t_hi, max(cap, t_lo * 1.2))
        est_next_top = {"from": _ts(tmid - pd.Timedelta(days=tunc)), "to": _ts(tmid + pd.Timedelta(days=tunc)),
                        "mid": _ts(tmid), "price_low": t_lo, "price_high": t_hi}

    # ------------------------------------------------------- fase attuale
    days_since_top = (now - last_top).days if last_top is not None and cur and cur["_nb"] is None else None
    days_since_bottom = (now - last_bottom).days
    last_halving = halving_before(now)
    days_since_halving = (now - last_halving).days
    ath = float(df["high"].max())
    dd_ath = (price / ath - 1) * 100
    m_now = float(mayer.iloc[-1])
    s200_slope = float(s200.iloc[-1] / s200.iloc[-31] - 1) * 100
    above200 = price > float(s200.iloc[-1])

    sc = {"accumulation": 0.0, "bull": 0.0, "distribution": 0.0, "bear": 0.0}
    if days_since_top is not None:  # dopo un massimo di ciclo
        frac = days_since_top / p_t2b if p_t2b == p_t2b else 0.5
        if frac < 0.15 and dd_ath > -25:
            sc["distribution"] += 2.0
        sc["bear"] += 2.0 * max(0.0, 1 - abs(frac - 0.5) / 0.6)
        if rebound is not None:
            if rebound < 15:
                sc["bear"] += 1.5
            elif rebound >= 30:
                sc["accumulation"] += 1.5 + min(1.0, (rebound - 30) / 40)
        if frac >= 0.7:
            sc["accumulation"] += 1.5 * min(1.0, (frac - 0.7) / 0.3 + 0.3)
        if probable_bottom:
            sc["accumulation"] += 1.0
        if not above200 and s200_slope < 0:
            sc["bear"] += 1.5
        elif above200 and s200_slope > 0:
            sc["accumulation"] += 0.5
            sc["bull"] += 0.6 * (1 if (rebound or 0) > 60 else 0.3)
        if m_now < 1.0:
            sc["accumulation"] += 0.5
    else:  # dopo un minimo di ciclo, prima del massimo
        frac = days_since_bottom / p_b2t if p_b2t == p_b2t else 0.5
        if frac < 0.3:
            sc["accumulation"] += 2.0 * (1 - frac / 0.3) + 0.5
        sc["bull"] += 2.0 * min(1.0, frac / 0.5) if frac < 1.05 else 0.8
        if frac > 0.8:
            sc["distribution"] += 2.0 * min(1.0, (frac - 0.8) / 0.25)
        if m_now > 2.4:
            sc["distribution"] += 1.5
        elif m_now > 1.3:
            sc["bull"] += 1.0
        if dd_ath > -10 and frac > 0.6:
            sc["distribution"] += 1.0
        if not above200 and s200_slope < 0:
            sc["bear"] += 1.5
            sc["accumulation"] += 0.5
    temp = 1.8  # temperatura: evita confidenze eccessive
    tot = sum(math.exp(v / temp) for v in sc.values())
    probs = {k: math.exp(v / temp) / tot for k, v in sc.items()}
    phase = max(probs, key=probs.get)
    confidence = round(probs[phase] * 100, 1)

    cycle_len = p_b2b if p_b2b == p_b2b else (p_b2t + p_t2b)
    days_since_confirmed_bottom = days_since_bottom
    probable = None
    if probable_bottom and since_top_low_t is not None:
        # nuovo ciclo probabilmente già iniziato dal minimo post-top: conteggi coerenti con quello
        days_since_bottom = (now - since_top_low_t).days
        probable = {"time": _ts(since_top_low_t), "price": since_top_low, "rebound": rebound,
                    "days_after_top": (since_top_low_t - last_top).days}
    progress = days_since_bottom / cycle_len * 100 if cycle_len == cycle_len and cycle_len > 0 else None

    PHASE_IT = {"accumulation": "accumulazione", "bull": "mercato rialzista", "distribution": "distribuzione", "bear": "mercato ribassista"}
    notes.append(f"Fase stimata: {PHASE_IT[phase]} (confidenza {confidence:.0f}%).")
    if last_top is not None and cur and cur["_nb"] is None:
        notes.append(
            f"Ultimo massimo di ciclo il {util.data_it(last_top)} a {util_fmt(float(df['high'].loc[last_top]))}: "
            f"{days_since_top} giorni fa, prezzo attuale {dd_ath:+.1f}% dall'ATH.")
        if since_top_low is not None:
            notes.append(
                f"Minimo dopo il top: {util_fmt(since_top_low)} il {util.data_it(since_top_low_t)} "
                f"({(since_top_low / float(df['high'].loc[last_top]) - 1) * 100:.1f}% dal massimo, "
                f"{(since_top_low_t - last_top).days} giorni dopo il top); rimbalzo attuale {rebound:+.1f}%.")
        if t2b:
            hist = ", ".join(f"{d} gg" for _, d in t2b)
            notes.append(f"Durate storiche massimo→minimo: {hist}; proiezione adattiva per questo ciclo ≈ {p_t2b:.0f} giorni.")
        if probable_bottom:
            notes.append(
                f"Il minimo di {mese(since_top_low_t)} è arrivato prima della media storica (cicli che si accorciano) "
                f"e ha retto per {(now - since_top_low_t).days} giorni con un rimbalzo >30%: possibile minimo di ciclo già segnato; "
                f"la finestra stimata resta utile per un eventuale retest.")
        elif est_next_bottom:
            notes.append(
                f"Finestra stimata del prossimo minimo: {mese(est_next_bottom['from'])} – "
                f"{mese(est_next_bottom['to'])}, area {util_fmt(est_next_bottom['price_low'])}–{util_fmt(est_next_bottom['price_high'])}.")
        notes.append(f"Drawdown storici dei bear market: {', '.join(f'{d:.0f}%' for _, d in dds)} → in attenuazione, proiezione ≈ -{dd_next:.0f}%.")
    if gains:
        notes.append(
            "Rendimenti decrescenti minimo→massimo: " + ", ".join(f"x{1 + g / 100:.1f}" for _, g in gains)
            + f"; prossimo ciclo stimato ≈ x{mult_next:.1f} (intervallo x{mult_lo:.1f}–x{mult_hi:.1f}).")
    if est_next_top:
        notes.append(
            f"Prossimo massimo stimato intorno a {mese(est_next_top['mid'])} "
            f"({util_fmt(est_next_top['price_low'])}–{util_fmt(est_next_top['price_high'])}), ~{p_h2t:.0f} giorni dopo l'halving stimato di {mese(eta)}.")
    notes.append(f"Mayer multiple {m_now:.2f}; prezzo {(price / fair_now - 1) * 100:+.0f}% rispetto al fair value power law ({util_fmt(fair_now)}); banda rainbow: {cur_band}.")
    if crosses and (now - crosses[-1]).days < 120:
        notes.append(f"Pi Cycle Top: incrocio recente il {util.data_it(crosses[-1])} (segnale storico di massimo).")
    notes.append("Le proiezioni pesano di più i cicli recenti e assumono cicli progressivamente più brevi e meno ampi: sono stime statistiche, non certezze.")

    current = {
        "phase": phase, "phase_confidence": confidence,
        "phase_probabilities": {k: round(v * 100, 1) for k, v in probs.items()},
        "days_since_bottom": days_since_bottom, "days_since_confirmed_bottom": days_since_confirmed_bottom,
        "probable_bottom": probable,   # minimo post-top probabilmente già segnato (null se no)
        "bottom_window_kind": "retest" if probable else "next_bottom",
        "days_since_top": days_since_top,
        "days_since_halving": days_since_halving,
        "progress": min(progress, 150.0) if progress is not None else None,
        "est_next_bottom": est_next_bottom, "est_next_top": est_next_top,
        "notes": notes,
    }

    # -------------------------------------------------------- overlay
    def overlay_series(anchor_t, name):
        i0 = close.index.searchsorted(anchor_t)
        if i0 >= len(close):
            return None
        base = float(close.iloc[i0])
        seg = close.iloc[i0:i0 + OVERLAY_DAYS + 1]
        days = ((seg.index - close.index[i0]) / pd.Timedelta(days=1)).astype(int)
        # giornaliero nel primo anno, poi un punto ogni 2 giorni (payload contenuto)
        return {"name": name, "points": [{"day": int(d), "roi": cy.round_sig(v / base, 4)}
                                         for k, (d, v) in enumerate(zip(days, seg.values))
                                         if d <= 400 or d % 2 == 0 or k == len(seg) - 1]}

    overlay = [
        {"anchor": "bottom", "series": [s for s in (overlay_series(b, f"Dal minimo {mese(b)}") for b in bottoms) if s]},
        {"anchor": "halving", "series": [s for s in (overlay_series(h, f"Halving {h.year}") for h in halving_times) if s]},
        {"anchor": "top", "series": [s for s in (overlay_series(t, f"Dal massimo {mese(t)}") for t in tops) if s]},
    ]

    # ------------------------------------------------------- modelli out
    q_lo, q_hi = pl.q_lo, pl.q_hi
    models = {
        "power_law": {
            "fair": _series(fair_full, 4),
            "support": _series(fair_full * 10 ** q_lo, 4),
            "resistance": _series(fair_full * 10 ** q_hi, 4),
            "current_fair": fair_now,
            "deviation": (price / fair_now - 1) * 100,
            "slope": pl.b, "intercept": pl.a,
        },
        "rainbow": {"bands": bands, "current_band": cur_band, "floor": _series(fair_full * 10 ** rq[0], 4)},
        "pi_cycle": {"sma111": _series(s111), "sma350x2": _series(s350x2), "crosses": [_ts(t) for t in crosses],
                     "distance": pi_dist},
        "mayer": {"series": _series(mayer, 4), "current": m_now},
        "two_year_ma": {"ma": _series(s730), "ma_x5": _series(s730 * 5)},
    }

    out_cycles = []
    for c in cycles:
        out_cycles.append({k: v for k, v in c.items() if not k.startswith("_")})

    extra = {
        "fair_now": fair_now, "s200": float(s200.iloc[-1]),
        "band_edges": [fair_now * 10 ** q for q in rq],
        "top_price": float(df["high"].loc[last_top]) if (last_top is not None and cur and cur["_nb"] is None) else None,
        "low_since_top": since_top_low, "ath": ath,
    }
    return util.clean({
        "_extra": extra,
        "halvings": halvings,
        "cycles": out_cycles,
        "current": current,
        "durations_trend": durations_trend,
        "overlay": overlay,
        "models": models,
        "price_log": [_pt(t, v) for t, v in close.items()],
    })


@util.ttl_cache(20)
def build() -> dict:
    """Risultato pesante (cache 15 min) + campi dipendenti dal prezzo aggiornati al prezzo live."""
    heavy = _build_heavy()
    out = {k: v for k, v in heavy.items() if k != "_extra"}
    ex = heavy["_extra"]
    try:
        from .market import live_price
        lp = live_price()
    except Exception:  # noqa: BLE001
        lp = None
    if not lp:
        return out
    models = dict(out["models"])
    pl = dict(models["power_law"])
    pl["deviation"] = (lp / ex["fair_now"] - 1) * 100
    models["power_law"] = pl
    mayer = dict(models["mayer"])
    mayer["current"] = lp / ex["s200"]
    models["mayer"] = mayer
    rb = dict(models["rainbow"])
    edges = ex["band_edges"]
    names = [b["name"] for b in rb["bands"]]
    band = names[0] if lp < edges[1] else names[-1]
    for i, nm in enumerate(names):
        if edges[i] <= lp < edges[i + 1]:
            band = nm
    rb["current_band"] = band
    models["rainbow"] = rb
    out["models"] = models
    cyc = [dict(c) for c in out["cycles"]]
    if cyc and cyc[-1]["status"] == "in_progress" and ex.get("top_price") and ex.get("low_since_top"):
        cyc[-1]["drawdown"] = (min(lp, ex["low_since_top"]) / ex["top_price"] - 1) * 100
    out["cycles"] = cyc
    pls = list(out["price_log"])
    if pls:
        pls[-1] = {"time": pls[-1]["time"], "value": lp}
    out["price_log"] = pls
    return util.clean(out)


MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]


def mese(t) -> str:
    t = pd.Timestamp(t, unit="s", tz="UTC") if isinstance(t, (int, float)) else pd.Timestamp(t)
    return f"{MESI[t.month - 1]} {t.year}"


def util_fmt(x: float) -> str:
    if x >= 1000:
        return f"${x / 1000:,.1f}k"
    return f"${x:,.2f}"


@router.get("/cycles")
def cycles_route():
    return build()
