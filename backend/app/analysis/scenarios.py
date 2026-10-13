"""Piano scenari: 2–3 scenari CONDIZIONALI deterministici costruiti da struttura/range, pivot di apertura, livelli,
liquidità, analoghi e pivot temporali. Funzione pura: riceve un contesto già calcolato dal router.

Non sono segnali operativi: ogni scenario ha una condizione di attivazione, un percorso di livelli con le loro ragioni,
un livello di invalidazione e — dove calcolabile — una frequenza storica condizionata agli eventi simili.
"""
from __future__ import annotations

import math

import pandas as pd

from .structure import nel, pc, usd

DISCLAIMER = ("Scenari analitici condizionali ricavati da regole deterministiche e statistiche storiche di BTC: descrivono cosa è "
              "successo in passato in condizioni simili, non sono previsioni certe né consigli di investimento.")

LIQ_WORD = {"buy_side": "liquidità buy-side", "sell_side": "liquidità sell-side"}
TP_UP = ("rialzo", "inversione_rialzista")
TP_DOWN = ("ribasso", "inversione_ribassista")


def _f(x) -> bool:
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x)


def _pool_candidates(ctx: dict) -> list[dict]:
    """Tutti i livelli noti come candidati obiettivo, con la loro ragione."""
    P = ctx["price"]
    out: list[dict] = []

    def add(price, label, reason, weight=1.0, source="livello"):
        if _f(price) and price > 0:
            out.append({"price": float(price), "label": label, "reason": reason, "weight": weight, "source": source})

    r = ctx["r1d"].get("range")
    if r:
        add(r["high"], "Massimo del range 1D", f"massimo del range giornaliero, {r['touches_high']} tocchi", 2.0, "range")
        add(r["mid"], "Metà range 1D", "equilibrio del range giornaliero", 1.5, "range")
        add(r["low"], "Minimo del range 1D", f"minimo del range giornaliero, {r['touches_low']} tocchi", 2.0, "range")
        W = r["high"] - r["low"]
        add(r["high"] + W, "Measured move sopra", "proiezione 1× ampiezza del range sopra il massimo", 0.8, "range")
        add(r["low"] - W, "Measured move sotto", "proiezione 1× ampiezza del range sotto il minimo", 0.8, "range")
    mr = ctx["r1d"].get("macro_range")
    if mr:
        add(mr["high"], "Massimo del range ampio 1D", "estremo superiore del range più ampio", 1.2, "range")
        add(mr["low"], "Minimo del range ampio 1D", "estremo inferiore del range più ampio", 1.2, "range")
    r4 = ctx["r4h"].get("range")
    if r4:
        add(r4["high"], "Massimo del range 4H", "massimo del range a 4 ore", 1.0, "range")
        add(r4["low"], "Minimo del range 4H", "minimo del range a 4 ore", 1.0, "range")
    rw = ctx["r1w"].get("range")
    if rw:
        add(rw["high"], "Massimo del range 1W", "estremo del range settimanale", 1.5, "range")
    for k in ctx["r1d"].get("key_levels", []):
        if k["kind"] in ("sweep_low", "sweep_high"):
            add(k["price"], k["label"], "estremo dello sweep: liquidità già presa", 1.2, "range")
    m = ctx.get("monday")
    if m and m.get("monday_complete"):
        add(m["high"], "Massimo del lunedì", "massimo del range del lunedì", 0.9, "pivot")
        add(m["low"], "Minimo del lunedì", "minimo del range del lunedì", 0.9, "pivot")
    for lv in ctx.get("open_levels", []):
        add(lv["price"], lv["label"], lv["label"].lower(), 1.1 if lv["group"] == "open" else 1.2, "pivot")
    for k in ctx.get("key_levels", []):
        name = k["label"].split("·", 1)[-1].strip()
        reason = name.lower().replace("pivot ", "pivot classico ", 1) if name.startswith("Pivot") else f"{name.lower()} sul 1D"
        add(k["price"], name, reason.replace("(", "").replace(")", ""), 1.0, "livello")
    liq = ctx.get("liq") or {}
    for c in (liq.get("clusters") or [])[:8]:
        side = "short" if c["side"] == "short" else "long"
        add(c["price"], f"Cluster liquidazioni {side}", f"cluster stimato di liquidazioni {side} da ${c['usd'] / 1e6:.0f}M", 1.3, "liquidità")
    for pl in (liq.get("pools") or [])[:10]:
        add(pl["price"], "Pool di liquidità", f"{LIQ_WORD.get(pl['kind'], 'liquidità')}: {pl['source'].replace('(', '').replace(')', '').lower()}", 1.0 + pl.get("strength", 0) / 100, "liquidità")
    return out


def _merge(cands: list[dict], tol: float) -> list[dict]:
    """Unisce livelli vicini (± tol relativo) in un'unica zona con più ragioni (confluenza)."""
    cands = sorted(cands, key=lambda c: c["price"])
    zones: list[dict] = []
    for c in cands:
        if zones and abs(c["price"] / zones[-1]["anchor"] - 1) <= tol:
            z = zones[-1]
            z["items"].append(c)
        else:
            zones.append({"anchor": c["price"], "items": [c]})
    out = []
    for z in zones:
        items = sorted(z["items"], key=lambda c: -c["weight"])
        best = items[0]
        reasons = []
        for c in items:
            if c["reason"] not in reasons:
                reasons.append(c["reason"])
        out.append({"price": best["price"], "label": best["label"], "reasons": reasons[:4],
                    "weight": sum(c["weight"] for c in items), "sources": sorted({c["source"] for c in items})})
    return out


def _pick(zones: list[dict], P: float, above: bool, ref: float, limit: float, must: tuple = ()) -> list[dict]:
    """Fino a 3 obiettivi oltre `ref` ed entro `limit`: il più vicino con confluenza, il più forte più lontano e uno intermedio.
    `must` = prezzi da includere sempre (es. metà e bordo opposto del range)."""
    lo, hi = (ref * 1.004, limit) if above else (limit, ref * 0.996)
    side = [z for z in zones if lo <= z["price"] <= hi and abs(z["price"] / P - 1) <= 0.16]
    side.sort(key=lambda z: abs(z["price"] - ref))
    if not side:
        return []
    chosen: list[dict] = []
    for m in must:
        z = min(side, key=lambda z: abs(z["price"] - m))
        if abs(z["price"] / m - 1) <= 0.006 and z not in chosen:
            chosen.append(z)
    if not chosen:
        near = next((z for z in side if z["weight"] >= 1.8), side[0])
        chosen.append(near)
        far_c = [z for z in side if abs(z["price"] - ref) > abs(near["price"] - ref) * 1.0 and abs(z["price"] / near["price"] - 1) >= 0.012]
        if far_c:
            far = max(far_c, key=lambda z: z["weight"])
            chosen.append(far)
    # intermedio/aggiuntivo: la zona più forte non troppo vicina a quelle scelte
    rest = [z for z in side if all(abs(z["price"] / c["price"] - 1) >= 0.01 for c in chosen)
            and abs(z["price"] - ref) < max(abs(c["price"] - ref) for c in chosen)]
    if rest and len(chosen) < 3:
        best = max(rest, key=lambda z: z["weight"])
        if best["weight"] >= 1.8:
            chosen.append(best)
    chosen.sort(key=lambda z: abs(z["price"] - ref))
    return chosen[:3]


def _stat(stats: dict | None, keys: tuple[str, ...]) -> dict | None:
    """Unisce gli esiti storici di più tipi di evento (pesati per numerosità)."""
    if not stats:
        return None
    evs = [e for e in stats["events"] if e["key"] in keys and e["n_outcome"]]
    n = sum(e["n_outcome"] for e in evs)
    if not n:
        return None

    def w(field):
        vals = [(e[field], e["n_outcome"]) for e in evs if e[field] is not None]
        tot = sum(k for _, k in vals)
        return round(sum(v * k for v, k in vals) / tot, 1) if tot else None
    return {"n": n, "p_target1": w("p_target1"), "p_target2": w("p_target2"), "p_invalid": w("p_invalid"),
            "keys": list(keys), "tf": stats["tf"], "t1": evs[0]["target1"], "t2": evs[0]["target2"], "inv": evs[0]["invalidation"]}


def _prob_block(s1: dict | None, s4: dict | None, text_event: str) -> dict | None:
    base = s1 if s1 and s1["n"] >= 8 else s4
    if not base:
        return None
    alt = s4 if base is s1 else None
    txt = (f"Dopo {text_event} ({base['n']} casi su {'1D dal 2012' if base['tf'] == '1d' else '4H dal 2018'}), il prezzo ha raggiunto "
           f"«{base['t1']}» entro 14 giorni {nel(base['p_target1'])} dei casi e «{base['t2']}» {nel(base['p_target2'])}, "
           f"mentre «{base['inv']}» è arrivato prima {nel(base['p_invalid'])}.")
    if alt and alt["n"] >= 10:
        txt += f" Sul 4H ({alt['n']} casi): {alt['p_target1']}% / {alt['p_target2']}% / {alt['p_invalid']}%."
    return {"value": base["p_target1"], "target2": base["p_target2"], "invalid": base["p_invalid"], "n": base["n"], "tf": base["tf"],
            "basis": text_event, "text": txt}


def _timing(tp: list[dict], kinds: tuple[str, ...] | None) -> list[dict]:
    out = []
    for c in tp:
        if kinds and c["expected"] not in kinds and c["expected"] not in ("inversione", "volatilita"):
            continue
        out.append({"time": c["time"], "start": c["start"], "end": c["end"], "label": c["label"], "title": c["title"],
                    "expected": c["expected"], "confluence": c["confluence"], "days_away": c["days_away"]})
    return out[:3]


def _path(now: pd.Timestamp, P: float, steps: list[tuple[float, str]], atr_d: float) -> list[dict]:
    pts = [{"time": now, "price": P, "label": "Ora"}]
    t = now
    cur = P
    for price, label in steps:
        days = max(1.0, abs(price - cur) / max(0.5 * atr_d, 1e-9))
        t = t + pd.Timedelta(days=round(days, 1))
        pts.append({"time": t, "price": price, "label": label})
        cur = price
    return pts


def _tgt(z: dict, P: float) -> dict:
    return {"price": z["price"], "label": z["label"], "reasons": z["reasons"], "distance": round((z["price"] / P - 1) * 100, 2),
            "confluence": len(z["reasons"])}


def _supports(ctx: dict, up: bool) -> tuple[list[str], list[str]]:
    pro, con = [], []

    def put(cond_up: bool | None, txt: str):
        if cond_up is None:
            return
        (pro if cond_up == up else con).append(txt)

    for tf, name in (("r1w", "settimanale"), ("r1d", "giornaliera"), ("r4h", "a 4 ore")):
        s = ctx[tf]["structure"]
        if s["trend"] in ("bullish", "bearish"):
            put(s["trend"] == "bullish", f"struttura {name} {'rialzista' if s['trend'] == 'bullish' else 'ribassista'}")
    a = ctx.get("analogs")
    if a and a.get("bias") in ("bullish", "bearish"):
        put(a["bias"] == "bullish", f"analoghi storici prevalentemente {'rialzisti' if a['bias'] == 'bullish' else 'ribassisti'} (mediana {pc(a.get('median_outcome'))})")
    w = ctx.get("weekly")
    if w:
        put(w["price"] > w["prev_low"], f"settimana sopra il minimo della precedente ({usd(w['prev_low'])})" if w["price"] > w["prev_low"]
            else f"settimana sotto il minimo della precedente ({usd(w['prev_low'])})")
    liq = ctx.get("liq") or {}
    mg = liq.get("magnet")
    if mg and _f(mg.get("price")):
        put(mg["price"] > ctx["price"], f"magnete di liquidazioni più vicino {'sopra' if mg['price'] > ctx['price'] else 'sotto'} ({usd(mg['price'])})")
    tp = ctx.get("timepivots") or []
    near = [c for c in tp if c["days_away"] <= 10 and (c["confluence"] or 0) >= 50]
    if near:
        c = near[0]
        if c["expected"] in TP_UP:
            put(True, f"pivot temporale «{c['title']}» ({c['label']}) storicamente rialzista")
        elif c["expected"] in TP_DOWN:
            put(False, f"pivot temporale «{c['title']}» ({c['label']}) storicamente ribassista")
    return pro, con


def build(ctx: dict) -> dict:
    P = ctx["price"]
    now = ctx["now"]
    atr_d = ctx["atr_d"]
    r1d = ctx["r1d"]
    rng = r1d.get("range")
    state = r1d.get("state") or "none"
    s1, s4 = ctx.get("stats1d"), ctx.get("stats4h")
    zones = _merge(_pool_candidates(ctx), 0.006)
    tp = ctx.get("timepivots") or []
    scen: list[dict] = []
    reach = max(1.5 * (rng["high"] - rng["low"]), 5 * atr_d) if rng else 5 * atr_d

    def make(sid, title, tone, trigger, path_targets, inval, prob, timing_kinds, extra_steps=None):
        pro, con = _supports(ctx, tone == "bullish") if tone != "neutral" else ([], [])
        timing = _timing(tp, timing_kinds)
        steps = (extra_steps or []) + [(t["price"], t["label"]) for t in path_targets]
        tg_txt = "; ".join(f"{usd(t['price'])} ({', '.join(t['reasons'][:2])})" for t in path_targets) or "nessun livello chiaro entro il 16%"
        parts = [f"{trigger['text']}, il percorso più coerente con la struttura passa per {tg_txt}."]
        parts.append(f"Lo scenario perde validità con {inval['text']}.")
        if prob:
            parts.append(prob["text"])
        if timing:
            t0 = timing[0]
            parts.append(f"Finestra temporale da monitorare: {t0['label']} ({t0['title'].lower()}, confluenza {t0['confluence']:.0f}/100).")
        if pro:
            parts.append("A favore: " + ", ".join(pro) + ".")
        if con:
            parts.append("Contro: " + ", ".join(con) + ".")
        scen.append({"id": sid, "title": title, "tone": tone, "trigger": trigger, "targets": path_targets, "invalidation": inval,
                     "probability": prob, "timing": timing, "supports": pro, "against": con, "narrative": " ".join(parts),
                     "path": _path(now, P, steps, atr_d)})

    if rng and state.startswith("inside"):
        H, L, M = rng["high"], rng["low"], rng["mid"]
        lower = rng["position"] < 50
        sweep_lo = next((k["price"] for k in r1d["key_levels"] if k["kind"] == "sweep_low"), None)
        sweep_hi = next((k["price"] for k in r1d["key_levels"] if k["kind"] == "sweep_high"), None)
        if lower:
            # 1) tenuta del minimo -> rotazione verso metà/massimo
            ups = _pick(zones, P, True, max(P, L), H * 1.008, must=(M, H))
            t_up = [_tgt(z, P) for z in ups]
            inv_p = sweep_lo if sweep_lo and sweep_lo < L else L * 0.99
            after_sweep = state == "inside_after_sweep_low"
            make("hold_low", "Tenuta del minimo del range", "bullish",
                 {"text": f"Se la chiusura giornaliera resta sopra {usd(L)} (minimo del range{' appena difeso dopo lo sweep' if after_sweep else ''})",
                  "level": L, "condition": "close_above", "tf": "1d"},
                 t_up, {"price": inv_p, "text": f"una chiusura giornaliera sotto {usd(inv_p)} ({'minimo dello sweep' if sweep_lo else 'sotto il minimo del range'})"},
                 _prob_block(_stat(s1, ("dev_low", "reclaim_low")), _stat(s4, ("dev_low", "reclaim_low")), "uno sweep/recupero del minimo di un range"),
                 TP_UP)
            # 2) accettazione sotto -> ricerca liquidità sotto
            downs = _pick(zones, P, False, L, L - reach)
            make("accept_below", "Accettazione sotto il range", "bearish",
                 {"text": f"Se il prezzo perde {usd(L)} con accettazione (due chiusure giornaliere sotto)", "level": L, "condition": "close_below", "tf": "1d"},
                 [_tgt(z, P) for z in downs],
                 {"price": L, "text": f"un ritorno con chiusura giornaliera sopra {usd(L)} (recupero del minimo: la rottura diventerebbe una deviazione)"},
                 _prob_block(_stat(s1, ("accept_low",)), _stat(s4, ("accept_low",)), "un'accettazione sotto il minimo di un range"),
                 TP_DOWN, extra_steps=[(L, "Trigger")])
        else:
            downs = _pick(zones, P, False, min(P, H), L * 0.992, must=(M, L))
            t_dn = [_tgt(z, P) for z in downs]
            inv_p = sweep_hi if sweep_hi and sweep_hi > H else H * 1.01
            make("reject_high", "Rifiuto del massimo del range", "bearish",
                 {"text": f"Se la chiusura giornaliera resta sotto {usd(H)} (massimo del range)", "level": H, "condition": "close_below", "tf": "1d"},
                 t_dn, {"price": inv_p, "text": f"una chiusura giornaliera sopra {usd(inv_p)}"},
                 _prob_block(_stat(s1, ("dev_high", "failed_break_high")), _stat(s4, ("dev_high", "failed_break_high")), "una deviazione sopra il massimo di un range"),
                 TP_DOWN)
            ups = _pick(zones, P, True, H, H + reach)
            make("accept_above", "Accettazione sopra il range", "bullish",
                 {"text": f"Se il prezzo supera {usd(H)} con accettazione (due chiusure giornaliere sopra)", "level": H, "condition": "close_above", "tf": "1d"},
                 [_tgt(z, P) for z in ups],
                 {"price": H, "text": f"un ritorno con chiusura giornaliera sotto {usd(H)} (rottura fallita)"},
                 _prob_block(_stat(s1, ("accept_high",)), _stat(s4, ("accept_high",)), "un'accettazione sopra il massimo di un range"),
                 TP_UP, extra_steps=[(H, "Trigger")])
        # 3) rotazione dentro il range
        mon = ctx.get("monday") or {}
        wk = ctx.get("weekly_open")
        wmag = ctx.get("weekly_magnet")
        rot_t = [{"price": M, "label": "Metà range 1D", "reasons": ["equilibrio del range: zona di rotazione"], "distance": round((M / P - 1) * 100, 2), "confluence": 1}]
        if wk and abs(wk / P - 1) > 0.002:
            rot_t.append({"price": wk, "label": "Apertura settimanale", "reasons": [f"apertura settimanale, rivisitata {nel(wmag)} delle settimane dopo uno scostamento ≥1%" if wmag else "apertura settimanale"],
                          "distance": round((wk / P - 1) * 100, 2), "confluence": 1})
        rot_t.sort(key=lambda t: abs(t["price"] - P))
        prob = None
        if wmag:
            prob = {"value": wmag, "target2": None, "invalid": None, "n": ctx.get("weekly_magnet_n"), "tf": "1h", "basis": "apertura settimanale",
                    "text": f"Dal 2018, dopo uno scostamento ≥1% dall'apertura settimanale, il prezzo l'ha rivisitata entro la settimana {nel(wmag)} dei casi."}
        lo_edge, hi_edge = (L, M) if lower else (M, H)
        make("rotation", "Rotazione nel range", "neutral",
             {"text": f"Se non arrivano chiusure giornaliere fuori da {usd(L)}–{usd(H)}", "level": None, "condition": "inside", "tf": "1d"},
             rot_t[:2], {"price": None, "text": f"una chiusura giornaliera fuori dal range ({usd(L)} / {usd(H)})"},
             prob, None, extra_steps=None)
        # percorso di rotazione: oscillazione tra i bordi della metà corrente e il centro
        scen[-1]["path"] = _path(now, P, [(M, "Metà range"), (lo_edge + 0.15 * (hi_edge - lo_edge) if lower else hi_edge - 0.15 * (hi_edge - lo_edge), "Bordo"), (M, "Metà range")], atr_d)
        if mon.get("monday_complete") and not mon.get("broke_high") and not mon.get("broke_low"):
            scen[-1]["narrative"] += f" Nel breve, il range del lunedì ({usd(mon['low'])}–{usd(mon['high'])}) fa da primo riferimento intra-settimanale."
    elif rng and state in ("accepted_above", "retest_held_above", "above_unconfirmed"):
        H, L, M = rng["high"], rng["low"], rng["mid"]
        ups = _pick(zones, P, True, max(P, H), max(P, H) + reach)
        make("breakout_hold", "Tenuta della rottura (integrità strutturale)", "bullish",
             {"text": f"Se il retest di {usd(H)} tiene con chiusure giornaliere sopra", "level": H, "condition": "close_above", "tf": "1d"},
             [_tgt(z, P) for z in ups], {"price": H, "text": f"una chiusura giornaliera di nuovo dentro il range, sotto {usd(H)}"},
             _prob_block(_stat(s1, ("retest_hold_high", "accept_high")), _stat(s4, ("retest_hold_high", "accept_high")), "un'accettazione/retest tenuto sopra un range"),
             TP_UP)
        downs = _pick(zones, P, False, H, L * 0.992, must=(M, L))
        make("failed_breakout", "Rottura fallita", "bearish",
             {"text": f"Se il prezzo torna sotto {usd(H)} con chiusura giornaliera", "level": H, "condition": "close_below", "tf": "1d"},
             [_tgt(z, P) for z in downs], {"price": H * 1.01, "text": f"una nuova chiusura giornaliera sopra {usd(H * 1.01)}"},
             _prob_block(_stat(s1, ("retest_fail_high", "failed_break_high")), _stat(s4, ("retest_fail_high", "failed_break_high")), "un retest fallito sopra un range"),
             TP_DOWN, extra_steps=[(H, "Trigger")])
    elif rng and state in ("accepted_below", "retest_held_below", "below_unconfirmed"):
        H, L, M = rng["high"], rng["low"], rng["mid"]
        downs = _pick(zones, P, False, min(P, L), min(P, L) - reach)
        make("breakdown_hold", "Conferma della rottura al ribasso", "bearish",
             {"text": f"Se i ritorni verso {usd(L)} vengono respinti con chiusure giornaliere sotto", "level": L, "condition": "close_below", "tf": "1d"},
             [_tgt(z, P) for z in downs], {"price": L, "text": f"una chiusura giornaliera di nuovo dentro il range, sopra {usd(L)}"},
             _prob_block(_stat(s1, ("retest_hold_low", "accept_low")), _stat(s4, ("retest_hold_low", "accept_low")), "un'accettazione/retest perso sotto un range"),
             TP_DOWN)
        ups = _pick(zones, P, True, L, H * 1.008, must=(M, H))
        make("reclaim", "Recupero del minimo", "bullish",
             {"text": f"Se il prezzo recupera {usd(L)} con chiusura giornaliera", "level": L, "condition": "close_above", "tf": "1d"},
             [_tgt(z, P) for z in ups], {"price": L * 0.99, "text": f"una nuova chiusura giornaliera sotto {usd(L * 0.99)}"},
             _prob_block(_stat(s1, ("retest_fail_low", "reclaim_low")), _stat(s4, ("retest_fail_low", "reclaim_low")), "un recupero del minimo di un range"),
             TP_UP, extra_steps=[(L, "Trigger")])
    else:
        st = r1d["structure"]
        sh, sl = st.get("last_high"), st.get("last_low")
        if sh:
            ups = _pick(zones, P, True, max(P, sh), max(P, sh) + 5 * atr_d)
            make("bos_up", "Rottura dello swing high", "bullish",
                 {"text": f"Se arriva una chiusura giornaliera sopra {usd(sh)} (ultimo swing high)", "level": sh, "condition": "close_above", "tf": "1d"},
                 [_tgt(z, P) for z in ups], {"price": sl, "text": f"una chiusura sotto {usd(sl)} (ultimo swing low)" if sl else "un nuovo minimo"},
                 _prob_block(_stat(s1, ("bos_up", "choch_up")), _stat(s4, ("bos_up", "choch_up")), "una rottura di struttura rialzista"), TP_UP,
                 extra_steps=[(sh, "Trigger")] if sh > P else None)
        if sl:
            downs = _pick(zones, P, False, min(P, sl), min(P, sl) - 5 * atr_d)
            make("bos_down", "Rottura dello swing low", "bearish",
                 {"text": f"Se arriva una chiusura giornaliera sotto {usd(sl)} (ultimo swing low)", "level": sl, "condition": "close_below", "tf": "1d"},
                 [_tgt(z, P) for z in downs], {"price": sh, "text": f"una chiusura sopra {usd(sh)} (ultimo swing high)" if sh else "un nuovo massimo"},
                 _prob_block(_stat(s1, ("bos_down", "choch_down")), _stat(s4, ("bos_down", "choch_down")), "una rottura di struttura ribassista"), TP_DOWN,
                 extra_steps=[(sl, "Trigger")] if sl < P else None)

    for i, s in enumerate(scen):
        s["n"] = i + 1
    # sintesi: quale condizione è più vicina e cosa la favorisce
    trig = [s for s in scen if s["trigger"].get("level")]
    nearest = min(trig, key=lambda s: abs(s["trigger"]["level"] / P - 1)) if trig else None
    summary = ""
    if rng:
        summary = (f"Prezzo {usd(P)} nel contesto del range giornaliero {usd(rng['low'])}–{usd(rng['high'])} "
                   f"({r1d['state_label'].lower()}).")
    if nearest:
        d = (nearest["trigger"]["level"] / P - 1) * 100
        summary += f" Il livello decisivo più vicino è {usd(nearest['trigger']['level'])} ({pc(d)}), che separa gli scenari «{scen[0]['title']}» e «{scen[1]['title'] if len(scen) > 1 else ''}»."
    a = ctx.get("analogs")
    if a:
        summary += f" Analoghi frattali: {a.get('text', '')}"
    zones_out = [{"price": z["price"], "label": z["label"], "reasons": z["reasons"], "distance": round((z["price"] / P - 1) * 100, 2),
                  "weight": round(z["weight"], 2), "sources": z["sources"]} for z in zones if abs(z["price"] / P - 1) <= 0.12]
    return {"scenarios": scen, "summary": summary, "levels": zones_out, "disclaimer": DISCLAIMER,
            "timing": _timing(tp, None), "analogs": a}
