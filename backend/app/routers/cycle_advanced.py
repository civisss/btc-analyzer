"""Router CYCLE ADVANCED: /cycle/advanced (+ /clock, /miner, /compare, /leverage).

Orologio del ciclo (Cycle Score 0–100 senza lookahead), ciclo dei miner (Hash/Difficulty Ribbon),
confronto "stesso giorno del ciclo" con analisi di sopravvivenza, ciclo della leva per fase.
"""
from __future__ import annotations

import logging
import math
import time

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from .. import util
from ..analysis import cycle_advanced as ca
from ..analysis import cycles as cy
from ..analysis import onchain as oca
from ..data import sources as src
from ..data import store
from . import cycles as cyr

log = logging.getLogger("cycle_advanced")
router = APIRouter()
DAY = pd.Timedelta(days=1)
MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]


# ------------------------------------------------------------------ dataset OI giornaliero (accumula nel tempo)

def _oi_1d(old):
    new = src.open_interest_history("1d", 29)
    if old is None or old.empty:
        return new.reset_index(drop=True)
    out = pd.concat([old, new]).drop_duplicates("time", keep="last").sort_values("time")
    return out.reset_index(drop=True)


store.register("oi_1d", _oi_1d, 6 * 3600)


def _safe(name: str) -> pd.DataFrame:
    try:
        return store.get(name)
    except Exception as e:  # noqa: BLE001
        log.warning("dataset %s non disponibile: %s", name, e)
        return pd.DataFrame()


def _live_price() -> float | None:
    try:
        from .market import live_price
        return live_price()
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------ helpers serie

def _r(v, sig=4):
    v = util.num(v)
    return None if v is None else cy.round_sig(v, sig)


def _mixed(s: pd.Series, daily_days: int = 730, step: int = 7, sig: int = 4) -> list[dict]:
    """Settimanale nello storico, giornaliero negli ultimi `daily_days` giorni."""
    s = s.dropna()
    if s.empty:
        return []
    cut = s.index[-1] - pd.Timedelta(days=daily_days)
    old, new = s[s.index < cut], s[s.index >= cut]
    if len(old):
        old = old.iloc[np.arange(len(old) - 1, -1, -step)[::-1]]
    s = pd.concat([old, new])
    return [{"time": util.ts(t), "value": _r(v, sig)} for t, v in s.items()]


def _at(s: pd.Series, t):
    s2 = s.loc[:t].dropna()
    return float(s2.iloc[-1]) if len(s2) else None


def _d(t) -> str:
    t = pd.Timestamp(t)
    return f"{t.day} {MESI[t.month - 1]} {t.year}"


def _m(t) -> str:
    t = pd.Timestamp(t)
    return f"{MESI[t.month - 1]} {t.year}"


def _usd(x) -> str:
    if x is None:
        return "n/d"
    return f"${x / 1000:,.1f}k" if x >= 1000 else f"${x:,.2f}"


# ------------------------------------------------------------------ core (pesante, cache 10 min)

@util.ttl_cache(600)
def _core() -> dict:
    t0 = time.time()
    df = cyr.load_daily()
    heavy = cyr._build_heavy()
    oc = oca.derive(store.get("onchain"))
    f = ca.build_frame(df, oc)
    ev = ca.detect_events(df, heavy["cycles"], heavy["current"].get("probable_bottom"))
    raw, aux = ca.raw_components(f, ev)
    pcts = pd.DataFrame(index=f.index)
    hists = {}
    for k in ca.COMP_KEYS:
        if k == "halving":
            pcts[k] = raw[k]
            continue
        p, h = ca.expanding_pct(raw[k].values)
        pcts[k] = p
        hists[k] = h
    eq, wf, weights_hist = ca.combine(pcts, ev)
    now = f.index[-1]
    bt = ca.backtest(wf, ev, now)
    bt_eq = ca.backtest(eq, ev, now)
    m = ca.miner_frame(f)
    sigs = ca.hash_ribbon_signals(m)
    log.info("cycle_advanced core in %.2fs", time.time() - t0)
    return {"df": df, "f": f, "heavy": heavy, "ev": ev, "raw": raw, "aux": aux, "pcts": pcts, "hists": hists,
            "eq": eq, "wf": wf, "weights": weights_hist, "bt": bt, "bt_eq": bt_eq, "m": m, "sigs": sigs, "now": now}


def _current_weights(core) -> dict:
    wh = core["weights"]
    return wh[-1]["weights"] if wh else {k: 1 / len(ca.COMP_KEYS) for k in ca.COMP_KEYS}


# ------------------------------------------------------------------ clock: valori attuali (live)

def _live_components(core, lp: float | None) -> dict:
    """Raw/percentili di oggi, ricalcolati col prezzo live per le componenti che dipendono dal prezzo."""
    f, raw, aux, pcts, hists = core["f"], core["raw"], core["aux"], core["pcts"], core["hists"]
    last = f.index[-1]
    close_last = float(f["close"].iloc[-1])
    cur_raw = {k: util.num(raw[k].iloc[-1]) for k in ca.COMP_KEYS}
    cur_pct = {k: util.num(pcts[k].iloc[-1]) for k in ca.COMP_KEYS}
    if lp and abs(lp / close_last - 1) < 0.25:
        d = lp - close_last
        s111 = float(aux["s111"].iloc[-1]) + d / 111
        s350 = float(aux["s350"].iloc[-1]) + d / 350
        s200 = float(aux["s200"].iloc[-1]) + d / 200
        s730 = float(aux["s730"].iloc[-1]) + d / 730
        ath = max(float(f["close"].iloc[:-1].max()), lp)
        upd = {"pi": math.log(s111 / (2 * s350)), "mayer": math.log(lp / s200),
               "ma2y": math.log(lp / s730) / math.log(5), "drawdown": lp / ath - 1}
        pl = util.num(raw["power_law"].iloc[-1])
        if pl is not None:
            upd["power_law"] = pl + math.log10(lp / close_last)
        o = f.iloc[-1]
        if np.isfinite(o["realized_cap"]) and np.isfinite(o["supply"]) and o["realized_cap"] > 0:
            mcap = lp * o["supply"]
            mvrv = mcap / o["realized_cap"]
            upd["nupl"] = 1 - 1 / mvrv
            z_old, close_oc = util.num(o["mvrv_z"]), util.num(o["mvrv"])
            if z_old is not None and close_oc:
                mcap_old = o["realized_cap"] * close_oc
                std = (mcap_old - o["realized_cap"]) / z_old if z_old else None
                if std:
                    upd["mvrv_z"] = (mcap - o["realized_cap"]) / std
        pu = util.num(raw["puell"].iloc[-1])
        if pu is not None:
            upd["puell"] = pu + math.log(lp / close_last)
        for k, v in upd.items():
            if v is not None and np.isfinite(v):
                cur_raw[k] = v
                cur_pct[k] = ca.pct_in(hists[k], v)
    w = _current_weights(core)
    num_ = sum(w[k] * cur_pct[k] for k in ca.COMP_KEYS if cur_pct[k] is not None)
    den = sum(w[k] for k in ca.COMP_KEYS if cur_pct[k] is not None)
    inst = num_ / den if den else None
    # lo score storico è un'EMA(7): applica lo stesso passo all'ultimo valore
    prev = core["wf"].dropna()
    alpha = 2 / (ca.SMOOTH_SPAN + 1)
    prev_v = float(prev.iloc[-2]) if len(prev) > 1 else inst
    score = (alpha * inst + (1 - alpha) * prev_v) if inst is not None else util.num(prev.iloc[-1])
    eqv = [cur_pct[k] for k in ca.COMP_KEYS if cur_pct[k] is not None]
    eq_inst = float(np.mean(eqv)) if eqv else None
    peq = core["eq"].dropna()
    score_eq = (alpha * eq_inst + (1 - alpha) * float(peq.iloc[-2])) if eq_inst is not None and len(peq) > 1 else None
    return {"raw": cur_raw, "pct": cur_pct, "score": score, "score_instant": inst, "score_equal": score_eq,
            "weights": w, "time": last, "live": bool(lp)}


def _display(k: str, v: float | None, core) -> str:
    if v is None:
        return "n/d"
    if k == "pi":
        return f"{(math.exp(v) - 1) * 100:+.1f}% dall'incrocio"
    if k == "mvrv_z":
        return f"{v:.2f}"
    if k == "nupl":
        return f"{v * 100:.1f}%"
    if k == "puell":
        return f"{math.exp(v):.2f}"
    if k == "mayer":
        return f"{math.exp(v):.2f}"
    if k == "power_law":
        return f"{(10 ** v - 1) * 100:+.0f}% dal fair value"
    if k == "ma2y":
        return f"{5 ** v:.2f}× la media mobile a 2 anni"
    if k == "drawdown":
        return f"{v * 100:.1f}% dall'ATH"
    if k == "halving":
        last_h = cy.HALVINGS[-1][1]
        days = (core["now"] - last_h).days
        return f"{days} g dall'halving · {v:.0f}/100"
    return f"{v:.2f}"


ZONE_COLORS = {"bottom": "#22c55e", "accumulation": "#14b8a6", "mid": "#facc15", "euphoria": "#f7931a", "top": "#f43f5e"}


def _zones() -> list[dict]:
    out, lo = [], 0
    for hi, k, lbl in ca.ZONES:
        out.append({"from": lo, "to": min(hi, 100), "key": k, "label": lbl, "color": ZONE_COLORS[k]})
        lo = hi
    return out


def _clock_current(core, lp) -> dict:
    lc = _live_components(core, lp)
    score = lc["score"]
    zk, zl = ca.zone_of(score)
    wf = core["wf"].dropna()

    def ago(days):
        s = wf.loc[: wf.index[-1] - days * DAY]
        return float(s.iloc[-1]) if len(s) else None
    a7, a30, a90 = ago(7), ago(30), ago(90)
    comps = []
    for k, lbl, desc in ca.COMPONENTS:
        comps.append({"key": k, "label": lbl, "description": desc, "raw": lc["raw"][k], "display": _display(k, lc["raw"][k], core),
                      "pct": lc["pct"][k], "weight": lc["weights"][k] * 100})
    comps_sorted = sorted([c for c in comps if c["pct"] is not None], key=lambda c: c["pct"])
    text = []
    if score is not None:
        text.append(f"Cycle Score {score:.0f}/100: {zl}. "
                    + (f"Variazione {score - a30:+.0f} punti in 30 giorni." if a30 is not None else ""))
        if comps_sorted:
            lo_c, hi_c = comps_sorted[0], comps_sorted[-1]
            text.append(f"Componente più 'fredda': {lo_c['label']} ({lo_c['pct']:.0f}/100); "
                        f"più 'calda': {hi_c['label']} ({hi_c['pct']:.0f}/100).")
        bt = core["bt"]
        if bt["mean_at_tops"] is not None and bt["mean_at_bottoms"] is not None:
            text.append(f"Storicamente lo score valeva in media {bt['mean_at_tops']:.0f} ai massimi di ciclo e "
                        f"{bt['mean_at_bottoms']:.0f} ai minimi.")
        hint = {"bottom": "Zona che in passato ha coinciso con i minimi di ciclo: rischio/rendimento storicamente favorevole.",
                "accumulation": "Valutazioni basse: fase storicamente di accumulo, ma il minimo può ancora essere ritestato.",
                "mid": "Valutazioni intermedie: nessun estremo di ciclo, il segnale è poco direzionale.",
                "euphoria": "Valutazioni elevate: fase avanzata di rialzo, il rischio di massimo cresce.",
                "top": "Zona che in passato ha coinciso con i massimi di ciclo: rischio di inversione elevato."}
        text.append(hint.get(zk, ""))
    return {"time": util.ts(core["now"]), "score": score, "score_equal": lc["score_equal"], "score_instant": lc["score_instant"],
            "zone": zk, "zone_label": zl, "change_7d": (score - a7) if score is not None and a7 is not None else None,
            "change_30d": (score - a30) if score is not None and a30 is not None else None,
            "change_90d": (score - a90) if score is not None and a90 is not None else None,
            "components": comps, "text": [t for t in text if t], "live": lc["live"]}


# ------------------------------------------------------------------ sezioni

def _bt_out(bt, df) -> dict:
    ev = []
    for r in bt["events"]:
        col = "high" if r["kind"] == "top" else "low"
        ev.append({**r, "time": util.ts(r["time"]), "price": float(df[col].loc[r["time"]]),
                   "extreme_365_time": util.ts(r["extreme_365_time"]) if r["extreme_365_time"] is not None else None})
    sig = []
    for s in bt["signals"]:
        sig.append({**s, "items": [{**i, "start": util.ts(i["start"]), "end": util.ts(i["end"]),
                                    "event": util.ts(i["event"]) if i["event"] is not None else None} for i in s["items"]]})
    return {"events": ev, "signals": sig, "mean_at_tops": bt["mean_at_tops"], "mean_at_bottoms": bt["mean_at_bottoms"]}


CLOCK_METHOD = (
    "Ogni componente viene trasformata nel suo percentile storico calcolato SOLO con i dati disponibili fino a quel giorno "
    "(finestra espandente, minimo 200 giorni di storia): nessun dato futuro entra nel valore di un giorno passato. "
    "Il residuo power law è ricalcolato ogni 30 giorni con la sola storia nota; la componente 'fase dall'halving' "
    "confronta i giorni dall'halving con i tempi medi halving→massimo e halving→minimo dei cicli già conclusi "
    f"(prior iniziale {ca.PRIOR_TOP_OFF} e {ca.PRIOR_BOTTOM_OFF} giorni). "
    "Pesi walk-forward: 50% uguali + 50% proporzionali al quadrato della separazione (percentile medio ai massimi − ai minimi) "
    "misurata sui soli massimi/minimi già confermati a quella data (massimo confermato 365 g dopo, minimo quando il prezzo "
    "ha raddoppiato e sono passati ≥180 g). Lo score finale è una media pesata con EMA a 7 giorni. "
    "Zone: <20 minimo, 20–40 accumulo, 40–60 metà ciclo, 60–80 euforia, ≥80 massimo. "
    "Segnale 'vero' = un massimo (sopra soglia) o minimo (sotto soglia) di ciclo cade tra 60 g prima e 365 g dopo l'inizio dell'episodio."
)


@util.ttl_cache(600)
def _clock_heavy() -> dict:
    core = _core()
    pcts = core["pcts"]
    comp_hist = {k: _mixed(pcts[k], daily_days=0, step=7, sig=3) for k in ca.COMP_KEYS}
    return {
        "history": _mixed(core["wf"], sig=3),
        "history_equal": _mixed(core["eq"], sig=3),
        "price": _mixed(core["f"]["close"], sig=5),
        "components_history": comp_hist,
        "backtest": _bt_out(core["bt"], core["df"]),
        "backtest_equal": {k: v for k, v in _bt_out(core["bt_eq"], core["df"]).items() if k != "signals"},
        "weights": {"current": {k: v * 100 for k, v in _current_weights(core).items()},
                    "history": [{"from": util.ts(w["from"]), "events": w["events"],
                                 "weights": {k: v * 100 for k, v in w["weights"].items()},
                                 "separation": w["separation"]} for w in core["weights"]]},
    }


@util.ttl_cache(20)
def build_clock() -> dict:
    core = _core()
    h = _clock_heavy()
    lp = _live_price()
    cur = _clock_current(core, lp)
    hist = list(h["history"])
    if hist and cur["score"] is not None:
        hist[-1] = {"time": hist[-1]["time"], "value": _r(cur["score"], 3)}
    return util.clean({"generated_at": int(time.time()), "current": cur, "zones": _zones(), **h, "history": hist,
                       "method": CLOCK_METHOD})


# ------------------------------------------------------------------ miner

MINER_METHOD = (
    "Hash Ribbons: SMA 30 e 60 giorni dell'hashrate (CoinMetrics). Capitolazione = SMA30 < SMA60; segnale = SMA30 torna sopra "
    "la SMA60 dopo almeno 7 giorni di capitolazione. Variante con conferma: primo giorno (entro 90 g) in cui la SMA 10 del prezzo "
    "supera la SMA 20. Difficulty Ribbon: la difficoltà non è nel dataset, viene approssimata con la media mobile a 14 giorni "
    "dell'hashrate (≈ 2016 blocchi); compressione = distanza % tra la più alta e la più bassa delle SMA 9…200. "
    "Ricavi dei miner = solo emissione (IssTotUSD, commissioni escluse). Hit rate = % di segnali con rendimento positivo; "
    "il 'tasso base' è la % di tutti i giorni dal 2011 con rendimento positivo sullo stesso orizzonte."
)


def _sig_out(s) -> dict:
    return {"time": util.ts(s["time"]), "cap_start": util.ts(s["cap_start"]), "cap_days": s["cap_days"],
            "hr_drawdown": s["hr_drawdown"], "price": s["price"], "ret": s["ret"],
            "momentum_time": util.ts(s["momentum_time"]) if s["momentum_time"] is not None else None,
            "momentum_ret": s["momentum_ret"]}


@util.ttl_cache(600)
def _miner_heavy() -> dict:
    core = _core()
    m, sigs = core["m"], core["sigs"]
    close = m["close"]
    now = m.index[-1]
    cap = (m["sma30"] < m["sma60"]).fillna(False)
    periods, start = [], None
    for t, c in cap.items():
        if c and start is None:
            start = t
        elif not c and start is not None:
            periods.append({"from": util.ts(start), "to": util.ts(t), "days": (t - start).days})
            start = None
    if start is not None:
        periods.append({"from": util.ts(start), "to": None, "days": (now - start).days})
    rb_cut = m.loc[now - 4 * 365 * DAY:]
    rb_cut = rb_cut.iloc[np.arange(len(rb_cut) - 1, -1, -3)[::-1]]
    ribbon = {"periods": ca.RIBBON, "times": [util.ts(t) for t in rb_cut.index],
              "values": [[_r(rb_cut[f"rb{n}"].iloc[i], 4) for n in ca.RIBBON] for i in range(len(rb_cut))]}
    comp_hist, _ = ca.expanding_pct(m["ribbon_compression"].values)
    comp_pct = util.num(comp_hist[-1])
    # stato attuale
    is_cap = bool(cap.iloc[-1])
    run = 0
    for v in cap.iloc[::-1]:
        if bool(v) != is_cap:
            break
        run += 1
    last_sig = sigs[-1] if sigs else None
    days_since_sig = (now - last_sig["time"]).days if last_sig else None
    if is_cap:
        state, label = "capitulation", "Capitolazione dei miner"
    elif last_sig and days_since_sig is not None and days_since_sig <= 60:
        state, label = "recovery", "Ripresa dopo la capitolazione (segnale recente)"
    else:
        state, label = "healthy", "Hashrate in espansione"
    basic = ca.hit_stats(sigs, "ret", close)
    mom = ca.hit_stats(sigs, "momentum_ret", close)
    cur = {
        "state": state, "label": label, "days_in_state": run,
        "hashrate": util.num(m["hashrate"].dropna().iloc[-1]), "sma30": util.num(m["sma30"].dropna().iloc[-1]),
        "sma60": util.num(m["sma60"].dropna().iloc[-1]),
        "ribbon_gap": (float(m["sma30"].dropna().iloc[-1]) / float(m["sma60"].dropna().iloc[-1]) - 1) * 100,
        "ribbon_compression": util.num(m["ribbon_compression"].dropna().iloc[-1]), "ribbon_compression_pct": comp_pct,
        "ribbon_inverted": bool(m["ribbon_inverted"].iloc[-1]),
        "hr_drawdown": util.num(m["hr_drawdown"].dropna().iloc[-1]),
        "puell": util.num(m["puell"].dropna().iloc[-1]), "issuance_usd": util.num(m["issuance_usd"].dropna().iloc[-1]),
        "issuance_change_90d": None,
        "last_signal": _sig_out(last_sig) if last_sig else None, "days_since_signal": days_since_sig,
    }
    iss = m["issuance_usd"].rolling(30, min_periods=20).mean().dropna()
    if len(iss) > 120:
        cur["issuance_change_90d"] = (float(iss.iloc[-1]) / float(iss.iloc[-91]) - 1) * 100
    text = []
    if is_cap:
        text.append(f"La SMA 30 dell'hashrate è sotto la SMA 60 da {run} giorni: i miner meno efficienti stanno spegnendo le macchine "
                    "(capitolazione). Storicamente le fasi di capitolazione sono vicine a minimi locali o di ciclo; il segnale "
                    "d'acquisto arriva quando la SMA 30 torna sopra la SMA 60.")
    else:
        text.append(f"Nessuna capitolazione: SMA 30 dell'hashrate {cur['ribbon_gap']:+.1f}% sopra la SMA 60 da {run} giorni.")
    if last_sig:
        r = last_sig["ret"]
        text.append(f"Ultimo segnale Hash Ribbon il {_d(last_sig['time'])} (dopo {last_sig['cap_days']} g di capitolazione)"
                    + (f": rendimento a 90 g {r['90']:+.0f}%." if r.get("90") is not None else "."))
    b90 = next((b for b in basic if b["horizon"] == 90), None)
    if b90 and b90["hit_rate"] is not None:
        text.append(f"Su {b90['n']} segnali storici il prezzo era più alto dopo 90 giorni nel {b90['hit_rate']:.0f}% dei casi "
                    f"(mediana {b90['median']:+.0f}%), contro un tasso base del {b90['base_hit_rate']:.0f}%.")
    if cur["ribbon_compression_pct"] is not None:
        rc = cur["ribbon_compression_pct"]
        text.append(f"Difficulty Ribbon: compressione {cur['ribbon_compression']:.1f}% ({rc:.0f}° percentile storico) — "
                    + ("ribbon compresso: crescita della difficoltà in stallo, tipico delle fasi di stress dei miner."
                       if rc < 25 else "ribbon espanso: difficoltà in crescita sostenuta." if rc > 60 else "compressione nella norma."))
    if cur["puell"] is not None:
        p = cur["puell"]
        text.append(f"Puell Multiple {p:.2f}: " + ("ricavi dei miner molto bassi rispetto alla media annua (stress)." if p < 0.6
                                                   else "ricavi elevati, i miner tendono a vendere di più." if p > 2 else "ricavi nella norma."))
    return {
        "current": cur, "text": text,
        "series": {"hashrate": _mixed(m["hashrate"], sig=4, daily_days=365), "sma30": _mixed(m["sma30"], sig=4, daily_days=365), "sma60": _mixed(m["sma60"], sig=4, daily_days=365),
                   "ribbon_compression": _mixed(m["ribbon_compression"], sig=3, daily_days=365), "hr_drawdown": _mixed(m["hr_drawdown"], sig=3, daily_days=365),
                   "puell": _mixed(m["puell"], sig=3, daily_days=365), "issuance_usd": _mixed(m["issuance_usd"].rolling(7, min_periods=4).mean(), sig=4, daily_days=365),
                   "price": _mixed(close, sig=5, daily_days=365)},
        "ribbon": ribbon, "capitulations": periods,
        "signals": [_sig_out(s) for s in sigs][::-1],
        "stats": {"basic": basic, "momentum": mom},
        "method": MINER_METHOD,
    }


@util.ttl_cache(20)
def build_miner() -> dict:
    return util.clean({"generated_at": int(time.time()), **_miner_heavy()})


# ------------------------------------------------------------------ confronto stesso giorno

COMPARE_CAVEAT = ("Pochi campioni (3–4 cicli): le probabilità sono indicative e non statisticamente robuste. "
                  "Kaplan-Meier usa solo le durate osservate; la curva log-normale è un'interpolazione liscia sugli stessi dati.")


@util.ttl_cache(600)
def _compare_heavy() -> dict:
    core = _core()
    df, f, ev, heavy = core["df"], core["f"], core["ev"], core["heavy"]
    close, high = df["close"], df["high"]
    now = df.index[-1]
    ath_run = high.cummax()
    mvrv = f["mvrv"]
    score = core["wf"]
    cur = heavy["current"]

    def recover_days(t):
        a = float(ath_run.loc[:t].iloc[-1])
        if float(close.loc[:t].iloc[-1]) >= a * 0.999:
            return 0
        after = high.loc[t + DAY:]
        hit = after[after >= a]
        return (hit.index[0] - t).days if len(hit) else None

    def row(label, anchor_t, days, is_current):
        t = anchor_t + days * DAY
        if t > now:
            return None
        a_price = float(close.loc[:anchor_t].iloc[-1]) if anchor_t >= close.index[0] else None
        p = float(close.loc[:t].iloc[-1])
        ath = float(ath_run.loc[:t].iloc[-1])
        fwd = {}
        for h in (90, 180, 365):
            t1 = t + h * DAY
            fwd[str(h)] = (float(close.loc[:t1].iloc[-1]) / p - 1) * 100 if t1 <= now else None
        seg = close.loc[t: t + 365 * DAY]
        return {"label": label, "anchor_time": util.ts(anchor_t), "anchor_price": a_price, "time": util.ts(t), "price": p,
                "multiple": p / a_price if a_price else None, "drawdown_ath": (p / ath - 1) * 100,
                "days_to_ath": recover_days(t), "mvrv": _at(mvrv, t), "score": _at(score, t),
                "fwd": fwd, "max_gain_365": (float(seg.max()) / p - 1) * 100 if len(seg) > 1 and not is_current else None,
                "max_dd_365": (float(seg.min()) / p - 1) * 100 if len(seg) > 1 and not is_current else None,
                "is_current": is_current}

    def series(anchor_t, name, days_max, is_current):
        i0 = close.index.searchsorted(anchor_t)
        if i0 >= len(close):
            return None
        base = float(close.iloc[i0])
        seg = close.iloc[i0: i0 + days_max + 1]
        sc = score.reindex(seg.index)
        pts = []
        for k, (t, v) in enumerate(seg.items()):
            d = (t - close.index[i0]).days
            if d % 3 == 0 or k == len(seg) - 1:
                pts.append([d, _r(v / base, 4), _r(sc.loc[t], 3)])
        return {"name": name, "current": is_current, "points": pts}

    halv = [t for _, t, _ in cy.HALVINGS]
    tops, bottoms, prob = ev["tops"], ev["bottoms"], ev["probable_bottom"]
    anchors_def = []
    anchors_def.append(("halving", "Dall'halving", halv[-1], halv[:-1], lambda t: f"Halving {t.year}"))
    if cur.get("days_since_top") is not None and tops:
        anchors_def.append(("top", "Dal massimo di ciclo", tops[-1], tops[:-1], lambda t: f"Massimo {_m(t)}"))
    last_conf = bottoms[-1] if bottoms else None
    if last_conf is not None:
        anchors_def.append(("bottom", "Dal minimo confermato", last_conf, bottoms[:-1], lambda t: f"Minimo {_m(t)}"))
    if prob is not None:
        anchors_def.append(("probable_bottom", "Dal minimo probabile", prob, bottoms[:-1] if last_conf is not None else bottoms,
                            lambda t: f"Minimo {_m(t)}"))
    anchors = []
    for key, label, cur_t, prev, namer in anchors_def:
        days = (now - cur_t).days
        rows = [r for r in (row(namer(t), t, days, False) for t in prev if t >= close.index[0]) if r]
        cr = row(f"Oggi ({namer(cur_t)})", cur_t, days, True)
        win = days + 400
        ser = [s for s in (series(t, namer(t), win, False) for t in prev if t >= close.index[0]) if s]
        cs = series(cur_t, namer(cur_t), win, True)
        if cs:
            ser.append(cs)
        fwd_stats = {}
        for h in ("90", "180", "365"):
            vals = [r["fwd"][h] for r in rows if r["fwd"].get(h) is not None]
            fwd_stats[h] = {"n": len(vals), "median": float(np.median(vals)) if vals else None,
                            "min": float(min(vals)) if vals else None, "max": float(max(vals)) if vals else None,
                            "up": sum(v > 0 for v in vals)}
        anchors.append({"key": key, "label": label, "anchor_time": util.ts(cur_t), "days": days,
                        "rows": rows + ([cr] if cr else []), "series": ser, "fwd_stats": fwd_stats})

    # ----------------------------------------------- durate e sopravvivenza
    cyc = heavy["cycles"]
    bull = [{"n": c["n"], "days": c["days_bottom_to_top"], "from": c["bottom"]["time"], "to": c["top"]["time"]}
            for c in cyc if c.get("days_bottom_to_top") is not None]
    bear = [{"n": c["n"], "days": c["days_top_to_bottom"], "from": c["top"]["time"], "to": c["next_bottom"]["time"]}
            for c in cyc if c.get("days_top_to_bottom") is not None]
    pb = cur.get("probable_bottom")
    if pb and tops:
        bear.append({"n": cyc[-1]["n"], "days": pb["days_after_top"], "from": util.ts(tops[-1]), "to": pb["time"], "probable": True})
    durations = {"bull": bull, "bear": bear}

    surv = []

    def surv_block(phase, label, elapsed, samples, anchor_t, note):
        km = ca.km_survival(samples)
        s_el_km = ca.km_at(km, elapsed)
        s_el_ln = ca.lognorm_sf(samples, elapsed)
        hz = []
        for x in (30, 90, 180, 365):
            kmv = ca.km_at(km, elapsed + x) / s_el_km if s_el_km > 0 else None
            lnv = ca.lognorm_sf(samples, elapsed + x)
            lnv = lnv / s_el_ln if (lnv is not None and s_el_ln and s_el_ln > 1e-9) else None
            hz.append({"days": x, "km": kmv * 100 if kmv is not None else None, "lognormal": lnv * 100 if lnv is not None else None})
        maxd = int(max(samples + [elapsed]) * 1.4)
        step = max(5, maxd // 120)
        curve = [{"day": d, "km": ca.km_at(km, d) * 100, "lognormal": (ca.lognorm_sf(samples, d) or 0) * 100}
                 for d in range(0, maxd + 1, step)]
        remaining = [s - elapsed for s in samples if s > elapsed]
        surv.append({"phase": phase, "label": label, "elapsed": elapsed, "anchor_time": util.ts(anchor_t),
                     "samples": samples, "remaining_median": float(np.median(remaining)) if remaining else None,
                     "exceeded_all": not remaining, "horizons": hz, "curve": curve, "note": note})

    bull_s = [b["days"] for b in bull]
    bear_s = [b["days"] for b in bear if not b.get("probable")]
    if pb:
        el = (now - pd.Timestamp(pb["time"], unit="s", tz="UTC")).days
        surv_block("bull", "Nuovo ciclo dal minimo probabile (minimo → massimo)", el, bull_s, pd.Timestamp(pb["time"], unit="s", tz="UTC"),
                   f"Se il minimo di {_m(pd.Timestamp(pb['time'], unit='s', tz='UTC'))} è il minimo di ciclo, la fase minimo→massimo è al giorno {el}.")
    if cur.get("days_since_top") is not None and tops:
        el = cur["days_since_top"]
        surv_block("bear", "Fase ribassista dal massimo (massimo → minimo)", el, bear_s, tops[-1],
                   "Scenario alternativo: il minimo di ciclo non è ancora stato segnato." if pb else
                   f"Fase massimo→minimo in corso dal {_d(tops[-1])}.")
    elif last_conf is not None:
        el = (now - last_conf).days
        surv_block("bull", "Fase rialzista dal minimo (minimo → massimo)", el, bull_s, last_conf, "")

    # ----------------------------------------------- highlights
    hl = []
    for a in anchors:
        rows = [r for r in a["rows"] if not r["is_current"]]
        crow = next((r for r in a["rows"] if r["is_current"]), None)
        if not rows or not crow:
            continue
        mults = ", ".join(f"{r['label'].split(' ', 1)[1]} ×{r['multiple']:.2f}" for r in rows if r["multiple"])
        fs = a["fwd_stats"]["180"]
        txt = f"{a['label']} (giorno {a['days']}): oggi ×{crow['multiple']:.2f} vs {mults}."
        if fs["n"]:
            txt += f" Nei 180 giorni successivi i cicli passati hanno fatto {fs['up']}/{fs['n']} volte meglio di zero (mediana {fs['median']:+.0f}%)."
        hl.append(txt)
    return {"anchors": anchors, "durations": durations, "survival": surv, "highlights": hl, "caveat": COMPARE_CAVEAT}


@util.ttl_cache(20)
def build_compare() -> dict:
    h = _compare_heavy()
    lp = _live_price()
    anchors = h["anchors"]
    if lp:
        anchors = []
        for a in h["anchors"]:
            rows = []
            for r in a["rows"]:
                if r["is_current"] and r["anchor_price"]:
                    r = {**r, "price": lp, "multiple": lp / r["anchor_price"],
                         "drawdown_ath": (lp / (r["price"] / (1 + r["drawdown_ath"] / 100)) - 1) * 100}
                rows.append(r)
            anchors.append({**a, "rows": rows})
    return util.clean({"generated_at": int(time.time()), **h, "anchors": anchors})


# ------------------------------------------------------------------ leva

LEV_METHOD = (
    "Funding: tassi Binance BTCUSDT perpetuo ogni 8 h dal 2019, media giornaliera annualizzata (×3×365). "
    "Rapporto speculativo = volume futures perpetui / volume spot Binance (BTC), media 30 giorni: misura quanto il mercato "
    "è guidato dalla leva (attenzione: da lug 2022 a mar 2023 lo spot BTC era a commissioni zero e il volume spot è gonfiato). "
    "Open interest: Binance fornisce lo storico solo per gli ultimi 30 giorni (anche con period=1d); il dataset giornaliero "
    "'oi_1d' si accumula da quando l'app è in funzione, per lo storico lungo la leva è stimata con funding e rapporto speculativo. "
    "Leverage ratio = OI (USD) / capitalizzazione BTC. Fasi storiche: accumulo = primo 25% del tratto minimo→massimo, "
    "rialzo fino a 60 g prima del massimo, distribuzione ±60 g dal massimo, ribasso fino al minimo successivo."
)


@util.ttl_cache(600)
def _lev_heavy() -> dict:
    core = _core()
    df, f, ev, heavy = core["df"], core["f"], core["ev"], core["heavy"]
    now = df.index[-1]
    cur_phase = heavy["current"]["phase"]
    idx = pd.date_range(pd.Timestamp("2017-08-17", tz="UTC"), now, freq="D")
    ph = ca.phase_history(df.index, ev, cur_phase).reindex(idx)

    fund = _safe("funding")
    fd = pd.Series(dtype=float)
    if not fund.empty:
        fr = fund.copy()
        fr["time"] = pd.DatetimeIndex(fr["time"]).normalize()
        fd = fr.groupby("time")["rate"].mean() * 3 * 365 * 100  # % annualizzato
        fd = fd.reindex(idx)
    fd30 = fd.rolling(30, min_periods=15).mean()
    fd7 = fd.rolling(7, min_periods=4).mean()

    spot, perp = _safe("k_1d"), _safe("fut_1d")
    spec = pd.Series(dtype=float, index=idx)
    if not spot.empty and not perp.empty:
        sv = spot.assign(time=pd.DatetimeIndex(spot["time"]).normalize()).drop_duplicates("time", keep="last").set_index("time")["volume"]
        pv = perp.assign(time=pd.DatetimeIndex(perp["time"]).normalize()).drop_duplicates("time", keep="last").set_index("time")["volume"]
        spec = (pv.reindex(idx).rolling(30, min_periods=20).sum() / sv.reindex(idx).rolling(30, min_periods=20).sum())
    spec = spec.replace([np.inf, -np.inf], np.nan)

    # OI: giornaliero accumulato + orario recente
    oi_d = _safe("oi_1d")
    oi_h = _safe("oi_1h")
    frames = []
    if not oi_d.empty:
        frames.append(oi_d.assign(time=pd.DatetimeIndex(oi_d["time"]).normalize()).set_index("time")["oi_usd"])
    if not oi_h.empty:
        frames.append(oi_h.assign(time=pd.DatetimeIndex(oi_h["time"]).normalize()).groupby("time")["oi_usd"].last())
    oi = pd.Series(dtype=float)
    if frames:
        oi = pd.concat(frames).groupby(level=0).last().sort_index()
    mcap = (f["close"] * f["supply"]).ffill()
    lev = (oi / mcap.reindex(oi.index).ffill() * 100) if len(oi) else pd.Series(dtype=float)

    # tabelle per fase e ciclo
    cyc_b = list(ev["bottoms"]) + ([ev["probable_bottom"]] if ev["probable_bottom"] is not None else [])

    def cycle_of(t):
        k = sum(1 for b in cyc_b if b <= t)
        return k  # numero ciclo (1 = dal minimo 2011)

    cyc_id = pd.Series([cycle_of(t) for t in idx], index=idx)
    by_phase = []
    for (c, p), g in pd.DataFrame({"c": cyc_id, "p": ph, "f": fd, "s": spec}).dropna(subset=["p"]).groupby(["c", "p"], sort=False):
        fv, sv_ = g["f"].dropna(), g["s"].dropna()
        if len(fv) < 10 and len(sv_) < 10:
            continue
        by_phase.append({"cycle": int(c), "phase": p, "label": ca.PHASE_IT[p], "from": util.ts(g.index[0]), "to": util.ts(g.index[-1]),
                         "days": len(g), "funding_avg": util.num(fv.mean()) if len(fv) else None,
                         "funding_median": util.num(fv.median()) if len(fv) else None,
                         "funding_pos_pct": util.num((fv > 0).mean() * 100) if len(fv) else None,
                         "funding_p90": util.num(fv.quantile(0.9)) if len(fv) else None,
                         "spec_avg": util.num(sv_.mean()) if len(sv_) else None, "current": bool(g.index[-1] == idx[-1])})
    by_phase.sort(key=lambda r: r["from"])
    agg = []
    for p in ["accumulation", "bull", "distribution", "bear"]:
        m_ = ph == p
        fv, sv_ = fd[m_].dropna(), spec[m_].dropna()
        agg.append({"phase": p, "label": ca.PHASE_IT[p], "days": int(m_.sum()),
                    "funding_avg": util.num(fv.mean()), "funding_median": util.num(fv.median()),
                    "funding_pos_pct": util.num((fv > 0).mean() * 100) if len(fv) else None,
                    "spec_avg": util.num(sv_.mean())})

    # fasi come bande
    bands, prev, start = [], None, None
    for t, p in ph.items():
        if p != prev:
            if prev is not None and isinstance(prev, str):
                bands.append({"from": util.ts(start), "to": util.ts(t), "phase": prev})
            prev, start = p, t
    if isinstance(prev, str):
        bands.append({"from": util.ts(start), "to": util.ts(idx[-1]), "phase": prev})

    # stato attuale vs storia e vs stessa fase ciclo precedente
    def pct_of(series, v):
        s = series.dropna()
        return float((s < v).mean() * 100) if len(s) and v is not None else None

    cur_f7 = util.num(fd7.dropna().iloc[-1]) if fd7.notna().any() else None
    cur_f30 = util.num(fd30.dropna().iloc[-1]) if fd30.notna().any() else None
    cur_s = util.num(spec.dropna().iloc[-1]) if spec.notna().any() else None
    cur_p = ph.iloc[-1] if isinstance(ph.iloc[-1], str) else cur_phase
    same_phase = ph == cur_p
    cur_c = int(cyc_id.iloc[-1])
    prev_mask = same_phase & (cyc_id == cur_c - 1)
    # stesso giorno della fase nel ciclo precedente
    phase_start = idx[-1]
    for t in ph.index[::-1]:
        if ph.loc[t] != cur_p:
            break
        phase_start = t
    days_in = (idx[-1] - phase_start).days
    prev_days = ph.index[prev_mask]
    prev_same_day = None
    if len(prev_days):
        t_eq = prev_days[0] + days_in * DAY
        if t_eq <= prev_days[-1]:
            prev_same_day = {"time": util.ts(t_eq), "funding_30d": util.num(fd30.get(t_eq)), "spec": util.num(spec.get(t_eq))}
    cur = {
        "phase": cur_p, "phase_label": ca.PHASE_IT.get(cur_p, cur_p), "cycle": cur_c, "days_in_phase": days_in,
        "funding_7d": cur_f7, "funding_30d": cur_f30,
        "funding_pct_all": pct_of(fd7, cur_f7), "funding_pct_phase": pct_of(fd7[same_phase], cur_f7),
        "funding_prev_cycle_phase_avg": util.num(fd[prev_mask].mean()) if prev_mask.any() else None,
        "spec": cur_s, "spec_pct_all": pct_of(spec, cur_s), "spec_pct_phase": pct_of(spec[same_phase], cur_s),
        "spec_prev_cycle_phase_avg": util.num(spec[prev_mask].mean()) if prev_mask.any() else None,
        "prev_cycle_same_day": prev_same_day,
        "oi_usd": util.num(oi.iloc[-1]) if len(oi) else None, "leverage_ratio": util.num(lev.dropna().iloc[-1]) if lev.notna().any() else None,
        "leverage_pct_available": pct_of(lev, util.num(lev.dropna().iloc[-1])) if lev.notna().any() else None,
        "oi_days_available": int(len(oi)), "oi_since": util.ts(oi.index[0]) if len(oi) else None,
    }
    text = []
    if cur_f7 is not None:
        lvl = ("molto basso / negativo (shorts dominanti)" if cur_f7 < 0 else "basso" if cur_f7 < 5 else
               "neutrale" if cur_f7 < 12 else "elevato" if cur_f7 < 25 else "estremo (leva long eccessiva)")
        text.append(f"Funding medio 7 giorni {cur_f7:+.1f}% annuo: livello {lvl}, {cur['funding_pct_all']:.0f}° percentile dal 2019"
                    + (f" e {cur['funding_pct_phase']:.0f}° percentile nelle fasi di {ca.PHASE_IT[cur_p].lower()}." if cur['funding_pct_phase'] is not None else "."))
    if cur["funding_prev_cycle_phase_avg"] is not None:
        text.append(f"Nella stessa fase del ciclo precedente il funding medio era {cur['funding_prev_cycle_phase_avg']:+.1f}% annuo.")
    if cur_s is not None:
        text.append(f"Rapporto volume perp/spot {cur_s:.2f}× ({cur['spec_pct_all']:.0f}° percentile dal 2019): "
                    + ("speculazione con leva elevata." if cur['spec_pct_all'] > 75 else "speculazione contenuta." if cur['spec_pct_all'] < 25 else "nella norma."))
    if cur["leverage_ratio"] is not None:
        text.append(f"Open interest {cur['oi_usd'] / 1e9:.1f} mld $ = {cur['leverage_ratio']:.2f}% della capitalizzazione BTC "
                    f"(storico disponibile: {cur['oi_days_available']} giorni).")
    text.append("Lettura: nei rialzi maturi funding e rapporto perp/spot salgono insieme (leva in accumulo, rischio di liquidazioni a cascata); "
                "nei minimi di ciclo il funding è spesso negativo e la leva è stata già 'lavata'.")
    return {
        "current": cur, "text": text,
        "series": {"funding": _mixed(fd30, daily_days=365, step=3, sig=3), "spec": _mixed(spec, daily_days=365, step=3, sig=3),
                   "price": _mixed(df["close"].loc[idx[0]:], daily_days=365, step=3, sig=5),
                   "oi_usd": [{"time": util.ts(t), "value": _r(v, 4)} for t, v in oi.items()],
                   "leverage_ratio": [{"time": util.ts(t), "value": _r(v, 4)} for t, v in lev.dropna().items()]},
        "phases": bands, "by_phase": by_phase, "by_phase_all": agg,
        "limitations": ["Storico open interest Binance limitato agli ultimi 30 giorni: l'archivio giornaliero cresce da quando l'app è attiva.",
                        "Funding disponibile dal settembre 2019 (nessun dato per i cicli 2011–2018).",
                        "Volume spot BTC gonfiato da lug 2022 a mar 2023 (promozione zero commissioni Binance): rapporto perp/spot sottostimato in quel periodo."],
        "method": LEV_METHOD,
    }


@util.ttl_cache(20)
def build_leverage() -> dict:
    return util.clean({"generated_at": int(time.time()), **_lev_heavy()})


# ------------------------------------------------------------------ riepilogo

@util.ttl_cache(20)
def build(**_params) -> dict:
    core = _core()
    lp = _live_price()
    clock = _clock_current(core, lp)
    wf = core["wf"].dropna()
    spark = wf.loc[wf.index[-1] - 365 * DAY:]
    spark_pts = [{"time": util.ts(t), "value": _r(v, 3)} for t, v in spark.items()]
    if spark_pts and clock["score"] is not None:
        spark_pts[-1]["value"] = _r(clock["score"], 3)
    mh = _miner_heavy()
    lv = _lev_heavy()
    ch = _compare_heavy()
    return util.clean({
        "generated_at": int(time.time()), "price": lp or float(core["df"]["close"].iloc[-1]),
        "clock": {k: clock[k] for k in ("time", "score", "score_equal", "zone", "zone_label", "change_7d", "change_30d", "change_90d", "text", "live")}
                 | {"components": [{k: c[k] for k in ("key", "label", "pct", "display", "weight")} for c in clock["components"]],
                    "spark": spark_pts, "zones": _zones(),
                    "mean_at_tops": core["bt"]["mean_at_tops"], "mean_at_bottoms": core["bt"]["mean_at_bottoms"]},
        "miner": {k: mh["current"][k] for k in ("state", "label", "days_in_state", "ribbon_gap", "ribbon_compression", "hr_drawdown", "puell", "last_signal", "days_since_signal")}
                 | {"hit_rate_90": next((b["hit_rate"] for b in mh["stats"]["basic"] if b["horizon"] == 90), None)},
        "compare": {"highlights": ch["highlights"], "survival": [{k: s[k] for k in ("phase", "label", "elapsed", "horizons", "remaining_median")} for s in ch["survival"]]},
        "leverage": {k: lv["current"][k] for k in ("phase", "phase_label", "funding_7d", "funding_pct_all", "spec", "spec_pct_all", "leverage_ratio")},
        "sections": ["/api/cycle/advanced/clock", "/api/cycle/advanced/miner", "/api/cycle/advanced/compare", "/api/cycle/advanced/leverage"],
    })


def _wrap(fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        log.exception("cycle advanced: %s", e)
        raise HTTPException(503, f"analisi del ciclo non disponibile: {e}") from e


@router.get("/cycle/advanced")
def advanced_route():
    return _wrap(build)


@router.get("/cycle/advanced/clock")
def clock_route():
    return _wrap(build_clock)


@router.get("/cycle/advanced/miner")
def miner_route():
    return _wrap(build_miner)


@router.get("/cycle/advanced/compare")
def compare_route():
    return _wrap(build_compare)


@router.get("/cycle/advanced/leverage")
def leverage_route():
    return _wrap(build_leverage)
