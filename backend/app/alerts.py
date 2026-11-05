"""Avvisi: motore di regole che produce pochi avvisi importanti (dedupe + cooldown per regola, severità).

Ogni avviso: {id, time, severity: info|warning|critical, category, title (≤60 caratteri), text (1–2 righe),
link (rotta frontend), data}. `push(alert)` lo salva nello storico (ring buffer + parquet) e lo trasmette sul
WebSocket /api/ws come {"type": "toast", ...alert}. `start()` esegue le regole ogni ~20 s nel loop di FastAPI.
Gli avvisi kind="alert" degli agenti vengono letti dal bus (polling di `bus.messages`, oppure spinti con
`ingest(msg)`) e aggregati, senza duplicare quelli già coperti dalle regole.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
import time
from collections import deque
from typing import Any, Callable

import pandas as pd

from . import util
from .data import store

log = logging.getLogger("alerts")

HISTORY_FILE = store.DATA_DIR / "alerts_history.parquet"
TICK_S = 20
MAX_HISTORY = 2000
TOAST_BUDGET = (6, 600)          # al massimo 6 toast "info/warning" ogni 10 minuti; oltre → solo storico
SEVERITIES = ("info", "warning", "critical")
CATEGORY_LABEL = {"price": "Prezzo", "levels": "Livelli", "liquidity": "Liquidità", "derivatives": "Derivati", "time": "Pivot temporali",
                  "cycle": "Ciclo", "onchain": "On-chain", "stablecoins": "Stablecoin", "macro": "Macro", "agents": "Agenti",
                  "events": "Eventi", "test": "Test"}

# soglie (documentate in CONTRACT.md)
TH = {
    "liq_burst_warn": 5e6, "liq_burst_crit": 20e6, "liq_window_s": 300,
    "funding_high": 0.05, "funding_low": -0.02,          # % per 8h
    "oi_spike": 5.0,                                       # % in 1h
    "move_warn": 3.0, "move_crit": 5.0,                    # % in 60 min
    "level_hyst": 0.0015,                                  # 0.15% oltre il livello per confermare il lato
    "cluster_min_usd": 100e6, "cluster_max_dist": 6.0, "pool_min_strength": 60,
    "pivot_confluence": 60, "pivot_confluence_warn": 75,
    "stable_day": 1e9, "stable_week": 3e9,
}

_history: deque[dict] = deque(maxlen=500)
_ids = itertools.count(1)
_fired: dict[str, float] = {}
_recent_texts: dict[str, float] = {}
_toasts: deque[float] = deque(maxlen=50)
_state: dict[str, Any] = {}
_pending_agent: list[dict] = []
_meta = {"started_at": None, "last_eval": None, "evals": 0, "errors": {}}
_task: asyncio.Task | None = None
_loaded = False


def _usd(x: float) -> str:
    return f"${x:,.0f}"


def _usdc(x: float) -> str:
    a = abs(x)
    s = "−" if x < 0 else ""
    for d, u in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= d:
            return f"{s}${a / d:.1f}{u}"
    return f"{s}${a:,.0f}"


# ------------------------------------------------------------------ storico

def _load_history() -> None:
    global _loaded, _ids
    if _loaded:
        return
    _loaded = True
    if HISTORY_FILE.exists():
        try:
            df = pd.read_parquet(HISTORY_FILE).tail(_history.maxlen)
            for r in df.to_dict("records"):
                r["data"] = json.loads(r.get("data") or "{}")
                r["time"] = int(r["time"])
                r = {k: v for k, v in util.clean(r).items() if v is not None or k == "data"}
                r["silent"] = bool(r.get("silent"))
                _history.appendleft(r)
                if isinstance(r.get("key"), str) and r["key"]:   # cooldown sopravvive al riavvio
                    _fired[r["key"]] = max(_fired.get(r["key"], 0), r["time"])
                for k in (r.get("data") or {}).get("cooldown_keys") or []:
                    _fired[k] = max(_fired.get(k, 0), r["time"])
                _recent_texts[f"{r['title']}|{r['text']}"] = r["time"]
            if len(df):
                _ids = itertools.count(int(df["id"].max()) + 1)
        except Exception as e:  # noqa: BLE001
            log.warning("storico avvisi illeggibile: %s", e)


def _persist(alert: dict) -> None:
    row = dict(alert, data=json.dumps(alert.get("data") or {}, ensure_ascii=False, default=str))
    try:
        old = pd.read_parquet(HISTORY_FILE) if HISTORY_FILE.exists() else None
        new = pd.DataFrame([row])
        df = pd.concat([old, new], ignore_index=True) if old is not None and len(old) else new
        store.write_parquet(df.tail(MAX_HISTORY), HISTORY_FILE)
    except Exception as e:  # noqa: BLE001
        log.warning("salvataggio avviso fallito: %s", e)


def history(limit: int = 50, since: int | None = None, severity: str | None = None) -> list[dict]:
    _load_history()
    out = []
    for a in _history:
        if since is not None and a["id"] <= since:
            break
        if severity and SEVERITIES.index(a["severity"]) < SEVERITIES.index(severity):
            continue
        if a.get("category") == "test":  # i toast di prova non finiscono nello storico visibile
            continue
        out.append(a)
        if len(out) >= limit:
            break
    return out


# ------------------------------------------------------------------ push

def _alert(severity: str, category: str, title: str, text: str, link: str, data: dict | None = None, rule: str = "") -> dict:
    title = util.prose(title)
    if len(title) > 60:
        title = title[:59].rstrip() + "…"
    return {"severity": severity, "category": category, "category_label": CATEGORY_LABEL.get(category, category),
            "title": title, "text": util.prose(text), "link": link, "data": util.clean(data or {}), "rule": rule}


async def push(alert: dict) -> dict:
    """Salva l'avviso nello storico e lo trasmette come toast sul WebSocket ({"type":"toast", ...alert})."""
    _load_history()
    now = time.time()
    a = dict(alert)
    a.setdefault("data", {})
    a["id"] = next(_ids)
    a["time"] = int(now)
    sev = a.get("severity", "info")
    # budget anti-spam: oltre la soglia gli avvisi non critici restano solo nello storico
    while _toasts and now - _toasts[0] > TOAST_BUDGET[1]:
        _toasts.popleft()
    silent = bool(a.get("silent")) or (sev != "critical" and len(_toasts) >= TOAST_BUDGET[0])
    a["silent"] = silent
    _history.appendleft(a)
    await asyncio.to_thread(_persist, a)
    if not silent:
        _toasts.append(now)
        try:
            from .routers.stream import hub
            await hub._broadcast({"type": "toast", **a})
        except Exception as e:  # noqa: BLE001
            log.debug("broadcast toast fallito: %s", e)
    log.info("avviso [%s] %s%s", sev, a["title"], " (silenzioso)" if silent else "")
    return a


async def emit(key: str, cooldown: float, alert: dict) -> dict | None:
    """Push con dedupe: stessa chiave entro `cooldown` secondi o stesso testo entro 10 minuti → ignorato."""
    now = time.time()
    if now - _fired.get(key, 0) < cooldown:
        return None
    sig = alert["title"] + "|" + alert["text"]
    if now - _recent_texts.get(sig, 0) < 600:
        return None
    _fired[key] = now
    _recent_texts[sig] = now
    if len(_recent_texts) > 500:
        for k in [k for k, t in _recent_texts.items() if now - t > 3600]:
            _recent_texts.pop(k, None)
    return await push(dict(alert, key=key))


def ingest(msg: dict) -> None:
    """Hook per il bus degli agenti: chiamare con ogni messaggio kind=="alert" (non bloccante)."""
    if msg.get("kind") == "alert":
        _pending_agent.append(msg)


# ------------------------------------------------------------------ helpers dati

def _hub():
    try:
        from .routers.stream import hub
        return hub
    except Exception:  # noqa: BLE001
        return None


def _price() -> float | None:
    h = _hub()
    tk = h.last.get("ticker") if h else None
    if tk and time.time() - tk["time"] < 30:
        return float(tk["price"])
    try:
        from .routers.market import live_price
        return live_price()
    except Exception:  # noqa: BLE001
        return None


def _m1() -> tuple[float | None, float | None]:
    h = _hub()
    k = h.last.get("kline_1m") if h else None
    if k and time.time() - k["candle"]["time"] < 120:
        return float(k["candle"]["high"]), float(k["candle"]["low"])
    return None, None


def _primed(name: str, value) -> tuple[bool, Any]:
    """Regole a transizione: al primo giro memorizza lo stato senza avvisare. Ritorna (cambiato, precedente)."""
    key = f"prev:{name}"
    if key not in _state:
        _state[key] = value
        return False, value
    prev = _state[key]
    _state[key] = value
    return prev != value, prev


# ------------------------------------------------------------------ regole (bloccanti: girano in thread)
# ognuna ritorna [(key, cooldown_s, alert)]

Cand = list[tuple[str, float, dict]]


def _levels_snapshot() -> list[dict]:
    from .routers import market
    lv = market.build_levels("1d")
    out = []
    for k in lv.get("key_levels", []):
        tag = k["label"].split(" ")[0]
        if tag in ("R1", "S1"):
            out.append({"name": k["label"], "short": tag, "price": float(k["price"]), "severity": "warning"})
    w = store.get("k_1w")
    if len(w) >= 2:
        out.append({"name": "Apertura settimanale", "short": "Open W", "price": float(w["open"].iloc[-1]), "severity": "warning"})
        out.append({"name": "Massimo settimana precedente", "short": "High W−1", "price": float(w["high"].iloc[-2]), "severity": "warning"})
        out.append({"name": "Minimo settimana precedente", "short": "Low W−1", "price": float(w["low"].iloc[-2]), "severity": "warning"})
    d = store.get("k_1d")
    if len(d) >= 2:
        last = d.iloc[-1]
        mon = d[(d["time"] >= w["time"].iloc[-1])] if len(w) else d.iloc[0:0]
        if len(mon) and mon["time"].iloc[0].dayofweek == 0 and last["time"] > mon["time"].iloc[0]:   # lunedì già chiuso
            out.append({"name": "Massimo del lunedì", "short": "Mon High", "price": float(mon["high"].iloc[0]), "severity": "info"})
            out.append({"name": "Minimo del lunedì", "short": "Mon Low", "price": float(mon["low"].iloc[0]), "severity": "info"})
    return out


def rule_levels(p: float) -> Cand:
    now = time.time()
    if now - _state.get("levels_t", 0) > 60:
        _state["levels_prev"] = _state.get("levels")
        _state["levels"] = _levels_snapshot()
        _state["levels_t"] = now
    sides: dict = _state.setdefault("level_sides", {})
    out: Cand = []
    hy = TH["level_hyst"]
    for lv in _state.get("levels") or []:
        L = lv["price"]
        k = f"{lv['short']}:{round(L)}"
        side = 1 if p > L * (1 + hy) else -1 if p < L * (1 - hy) else 0
        if not side:
            continue
        prev = sides.get(k)
        sides[k] = side
        if prev is None or prev == side:
            continue
        up = side > 0
        title = f"BTC {'sopra' if up else 'sotto'} {lv['short']} ({_usd(L)})"
        text = (f"Il prezzo ({_usd(p)}) ha {'superato' if up else 'perso'} {lv['name'].split(' · ')[-1].lower()} a {_usd(L)}. "
                f"{'Conferma con la chiusura della candela.' if lv['severity'] == 'warning' else ''}").strip()
        out.append((f"level:{k}", 6 * 3600, _alert(lv["severity"], "levels", title, text, "/grafici",
                                                   {"price": p, "level": L, "name": lv["name"], "direction": "up" if up else "down"}, "level_cross")))
    if len(sides) > 300:
        _state["level_sides"] = dict(list(sides.items())[-150:])
    return out


def rule_sweep(p: float) -> Cand:
    now = time.time()
    if now - _state.get("liq_t", 0) > 60:
        from .routers import liquidations as lq
        L = lq.build("1d")
        targets = []
        for c in L.get("clusters", []):
            if c["usd"] >= TH["cluster_min_usd"] and abs(c["distance"]) <= TH["cluster_max_dist"]:
                targets.append({"price": c["price"], "label": f"cluster di liquidazioni {c['side']} (~{_usdc(c['usd'])} stimati)",
                                "short": f"cluster {c['side']}", "usd": c["usd"]})
        for pl in L.get("pools", []):
            if pl.get("strength", 0) >= TH["pool_min_strength"]:
                targets.append({"price": pl["price"], "label": f"pool di liquidità {'buy-side' if pl['kind'] == 'buy_side' else 'sell-side'} ({pl['source']})",
                                "short": "pool buy-side" if pl["kind"] == "buy_side" else "pool sell-side", "usd": None})
        _state["liq_targets"] = targets[:12]
        _state["liq_t"] = now
    hi, lo = _m1()
    hi, lo = max(p, hi or p), min(p, lo or p)
    sides: dict = _state.setdefault("sweep_sides", {})
    out: Cand = []
    for t in _state.get("liq_targets") or []:
        L = t["price"]
        k = f"{t['short']}:{round(L, -1)}"
        prev = sides.get(k)
        if prev is None:
            sides[k] = 1 if p > L else -1
            continue
        swept = (prev > 0 and lo <= L * 0.9995) or (prev < 0 and hi >= L * 1.0005)
        sides[k] = 1 if p > L else -1
        if not swept:
            continue
        below = prev > 0
        reclaimed = (p > L) if below else (p < L)
        title = f"Sweep {t['short']} a {_usd(L)}"
        text = (f"Il prezzo è {'sceso sotto' if below else 'salito sopra'} il {t['label']} a {_usd(L)}"
                + (f" e ora è di nuovo {'sopra' if below else 'sotto'} ({_usd(p)}): possibile sweep con rientro." if reclaimed else f" (ora {_usd(p)})."))
        out.append((f"sweep:{k}", 6 * 3600, _alert("warning", "liquidity", title, text, "/posizionamento?tab=liquidazioni",
                                                   {"price": p, "level": L, "usd": t["usd"], "reclaimed": reclaimed}, "liquidity_sweep")))
    return out


def rule_liq_burst(p: float) -> Cand:
    df = store.liquidations()
    if df is None or df.empty:
        return []
    cut = pd.Timestamp.now(tz="UTC") - pd.Timedelta(seconds=TH["liq_window_s"])
    d = df[df["time"] >= cut]
    out: Cand = []
    for side in ("long", "short"):
        tot = float(d.loc[d["side"] == side, "usd"].sum())
        if tot < TH["liq_burst_warn"]:
            continue
        sev = "critical" if tot >= TH["liq_burst_crit"] else "warning"
        title = f"Liquidazioni {side} {_usdc(tot)} in 5 min"
        text = (f"Ondata di liquidazioni {'long (posizioni rialziste chiuse forzatamente)' if side == 'long' else 'short (posizioni ribassiste chiuse forzatamente)'}: "
                f"{_usdc(tot)} negli ultimi 5 minuti, prezzo {_usd(p)}.")
        out.append((f"liqburst:{side}", 30 * 60, _alert(sev, "liquidity", title, text, "/posizionamento?tab=liquidazioni", {"usd": tot, "side": side, "price": p}, "liq_burst")))
    return out


def rule_derivatives(p: float) -> Cand:
    out: Cand = []
    h = _hub()
    mk = h.last.get("mark") if h else None
    fr = float(mk["funding_rate"]) if mk and time.time() - mk["time"] < 120 else None
    if fr is None:
        try:
            f = store.get("funding")
            fr = float(f["rate"].iloc[-1]) * 100
        except Exception:  # noqa: BLE001
            fr = None
    if fr is not None:
        zone = "high" if fr >= TH["funding_high"] else "low" if fr <= TH["funding_low"] else "normal"
        changed, prev = _primed("funding_zone", zone)
        if changed and zone != "normal":
            title = f"Funding {'elevato' if zone == 'high' else 'negativo'}: {fr:+.3f}% / 8h"
            text = ("Leva long affollata: i long pagano un funding alto, rischio di flush al ribasso." if zone == "high"
                    else "I short pagano i long: posizionamento ribassista affollato, possibile short squeeze.")
            out.append((f"funding:{zone}", 12 * 3600, _alert("warning", "derivatives", title, text, "/posizionamento", {"funding": fr}, "funding")))
    try:
        oi = store.get("oi_15m")
        if len(oi) >= 5 and (pd.Timestamp.now(tz="UTC") - oi["time"].iloc[-1]).total_seconds() < 3600:
            a, b = float(oi["oi_usd"].iloc[-5]), float(oi["oi_usd"].iloc[-1])
            ch = (b / a - 1) * 100 if a else 0
            if abs(ch) >= TH["oi_spike"]:
                up = ch > 0
                title = f"Open interest {ch:+.1f}% in 1 ora"
                text = (f"OI a {_usdc(b)}: {'nuova leva in ingresso' if up else 'deleveraging rapido (chiusura di posizioni)'} "
                        f"con prezzo a {_usd(p)}.")
                out.append((f"oi:{'up' if up else 'down'}", 3 * 3600, _alert("warning", "derivatives", title, text, "/posizionamento", {"oi_usd": b, "change": ch}, "oi_spike")))
    except Exception as e:  # noqa: BLE001
        log.debug("oi: %s", e)
    return out


def rule_move(p: float) -> Cand:
    now = time.time()
    hist: deque = _state.setdefault("prices", deque(maxlen=400))
    hist.append((now, p))
    old = [x for x in hist if now - x[0] >= 3600]
    if not old:
        return []
    while len(hist) > 2 and now - hist[1][0] >= 3600:
        hist.popleft()
    p0 = old[-1][1]
    ch = (p / p0 - 1) * 100
    if abs(ch) < TH["move_warn"]:
        return []
    sev = "critical" if abs(ch) >= TH["move_crit"] else "warning"
    title = f"BTC {ch:+.1f}% nell'ultima ora"
    text = f"Movimento rapido da {_usd(p0)} a {_usd(p)} in 60 minuti."
    return [(f"move:{'up' if ch > 0 else 'down'}", 2 * 3600, _alert(sev, "price", title, text, "/grafici", {"price": p, "change": ch}, "price_move"))]


def rule_closes(p: float) -> Cand:
    out: Cand = []
    d = store.get("k_1d")
    if len(d) < 3:
        return out
    t_closed = int(d["time"].iloc[-2].timestamp())
    changed, _ = _primed("daily_close", t_closed)
    if changed:
        c, c_prev = float(d["close"].iloc[-2]), float(d["close"].iloc[-3])
        for lv in (_state.get("levels_prev") or _state.get("levels") or []):
            if lv["short"] not in ("R1", "S1"):
                continue
            L = lv["price"]
            if (c_prev - L) * (c - L) < 0:
                up = c > L
                title = f"Chiusura daily {'sopra' if up else 'sotto'} {lv['short']} ({_usd(L)})"
                text = f"La candela giornaliera ha chiuso a {_usd(c)}, {'sopra' if up else 'sotto'} {lv['name'].split(' · ')[-1].lower()} ({_usd(L)})."
                out.append((f"dclose:{t_closed}:{lv['short']}", 86400, _alert("warning", "levels", title, text, "/grafici", {"close": c, "level": L}, "daily_close")))
    w = store.get("k_1w")
    if len(w) >= 3:
        tw = int(w["time"].iloc[-2].timestamp())
        changed, _ = _primed("weekly_close", tw)
        if changed:
            c, hi, lo = float(w["close"].iloc[-2]), float(w["high"].iloc[-3]), float(w["low"].iloc[-3])
            if c > hi or c < lo:
                up = c > hi
                L = hi if up else lo
                title = f"Chiusura weekly {'sopra il massimo' if up else 'sotto il minimo'} W−1"
                text = f"La settimana ha chiuso a {_usd(c)}, {'oltre il massimo' if up else 'sotto il minimo'} della settimana precedente ({_usd(L)}): rottura del range."
                out.append((f"wclose:{tw}", 7 * 86400, _alert("warning", "levels", title, text, "/grafici", {"close": c, "level": L}, "weekly_close")))
    return out


def rule_timepivots(p: float) -> Cand:
    from .routers import timepivots as tpr
    tp = tpr.build(90)
    now = pd.Timestamp.now(tz="UTC")
    today, tomorrow = now.normalize(), now.normalize() + pd.Timedelta(days=1)
    out: Cand = []
    for it in tp.get("calendar", []):
        conf = it.get("confluence") or 0
        if conf < TH["pivot_confluence"]:
            continue
        st = pd.Timestamp(it["start"], unit="s", tz="UTC").normalize()
        if st == tomorrow:
            when = "domani"
        elif st == today:
            when = "oggi"
        else:
            continue
        from .agents.engine import EXPECTED_IT  # etichette italiane dell'esito atteso
        exp = EXPECTED_IT.get(it.get("expected"), (it.get("expected"), "neutral"))[0]
        sev = "warning" if conf >= TH["pivot_confluence_warn"] else "info"
        title = f"Finestra pivot {it['label']} da {when}"
        prob = f", probabilità storica {it['probability']:.0f}%" if it.get("probability") else ""
        text = f"Atteso {exp} (confluenza {conf:.0f}/100{prob}). {it.get('summary') or ''}".strip()
        out.append((f"pivot:{it['id']}:{when}", 3 * 86400, _alert(sev, "time", title, text[:220], "/analoghi?tab=pivot",
                                                                 {"id": it["id"], "start": it["start"], "end": it["end"], "confluence": conf}, "timepivot_window")))
    return out


def rule_cycle(p: float) -> Cand:
    from .routers import cycle_advanced as ca
    s = ca.build()
    out: Cand = []
    ck = s.get("clock") or {}
    zone = ck.get("zone")
    if zone:
        changed, prev = _primed("clock_zone", zone)
        if changed:
            title = f"Orologio del ciclo: zona {ck.get('zone_label', zone)}"
            text = f"Lo score di ciclo ({ck.get('score', 0):.0f}/100) è passato in zona {ck.get('zone_label', zone).lower()}."
            out.append((f"clock:{zone}", 3 * 86400, _alert("warning", "cycle", title, text, "/cicli?tab=clock", {"zone": zone, "prev": prev, "score": ck.get("score")}, "cycle_zone")))
    mi = s.get("miner") or {}
    sig = (mi.get("last_signal") or {}).get("time")
    if sig:
        changed, _ = _primed("hash_signal", sig)
        if changed:
            out.append((f"hash:{sig}", 30 * 86400, _alert("warning", "onchain", "Nuovo segnale Hash Ribbons",
                                                           f"Fine della capitolazione dei miner (SMA30 dell'hashrate di nuovo sopra la SMA60) con prezzo {_usd(p)}: storicamente un segnale di medio periodo favorevole.",
                                                           "/cicli?tab=miner", {"time": sig}, "hash_ribbons")))
    st = mi.get("state")
    if st:
        changed, prev = _primed("miner_state", st)
        if changed and st == "capitulation":
            out.append((f"miner:{st}", 7 * 86400, _alert("info", "onchain", "Miner in capitolazione",
                                                          "La SMA30 dell'hashrate è scesa sotto la SMA60 (Hash Ribbons): i miner sono sotto stress.",
                                                          "/cicli?tab=miner", {"state": st, "prev": prev}, "miner_state")))
    return out


def rule_stables(p: float) -> Cand:
    from .routers import usdt_analogs as ua
    s = ua.build_stablecoins()
    out: Cand = []
    dn = s.get("daily_net") or []
    if dn and dn[-1].get("value") is not None and abs(dn[-1]["value"]) >= TH["stable_day"]:
        v = dn[-1]["value"]
        day = util.data_it(dn[-1]["time"])
        out.append((f"stable_day:{dn[-1]['time']}", 2 * 86400, _alert("info", "stablecoins", f"Stablecoin: {'mint' if v > 0 else 'burn'} di {_usdc(abs(v))} in un giorno",
                                                                     f"Variazione netta della supply di stablecoin il {day}: {_usdc(v)} ({'nuova liquidità in ingresso' if v > 0 else 'liquidità in uscita'}).",
                                                                     "/flussi?tab=stablecoin", {"value": v, "time": dn[-1]["time"]}, "stable_day")))
    n7 = (s.get("current") or {}).get("net_7d")
    if n7 is not None and abs(n7) >= TH["stable_week"]:
        wk = int(time.time() // (7 * 86400))
        out.append((f"stable_week:{wk}:{'up' if n7 > 0 else 'down'}", 7 * 86400, _alert("warning", "stablecoins", f"Stablecoin {_usdc(n7)} in 7 giorni",
                                                                                        f"Movimento netto forte della supply di stablecoin nell'ultima settimana ({_usdc(n7)}): {'espansione' if n7 > 0 else 'contrazione'} della liquidità crypto.",
                                                                                        "/flussi?tab=stablecoin", {"net_7d": n7}, "stable_week")))
    return out


def rule_macro(p: float) -> Cand:
    from .routers import macro
    sm = (macro.build() or {}).get("summary") or {}
    lab = sm.get("label")
    if not lab:
        return []
    changed, prev = _primed("macro_label", lab)
    if not changed:
        return []
    return [(f"macro:{lab}", 86400, _alert("warning", "macro", f"Regime macro: ora {lab}",
                                           f"Il punteggio macro è a {sm.get('score', 0):.0f}/100 (prima: {prev}). " + " ".join((sm.get("bullets") or [])[:1]),
                                           "/macro", {"score": sm.get("score"), "label": lab, "prev": prev}, "macro_regime"))]


def rule_events(p: float) -> Cand:
    from .routers import events as evr
    e = evr.build(90)
    now = time.time()
    out: Cand = []
    for u in e.get("upcoming", []):
        dt = u["time"] - now
        if not (0 < dt <= 24 * 3600):
            continue
        sev = "warning" if u.get("importance") == "alta" and u.get("quality") != "stimata" else "info"
        hrs = max(1, round(dt / 3600))
        exp = f" Movimento atteso ±{u['expected_abs_1d']:.1f}%." if u.get("expected_abs_1d") else ""
        est = " (data stimata)" if u.get("quality") == "stimata" else ""
        out.append((f"event:{u['id']}", 2 * 86400, _alert(sev, "events", f"Tra {hrs} h: {u['title']}"[:60],
                                                         f"{u['title']}{est} — {u['hour']}.{exp}", "/macro?tab=eventi", {"id": u["id"], "time": u["time"]}, "event_24h")))
    return out


TOPIC_IT = {"flow.move": "movimento forte", "market.alert": "estremo delle 24h", "levels.touch": "livello toccato", "levels.confluence": "confluenza di livelli",
            "flows.spike": "picco di flussi aggressivi", "flows.divergence": "divergenza spot/perp", "flows.leverage": "leva in aumento",
            "derivatives.signal": "segnale sui derivati", "analogs.pattern": "figura grafica", "liquidity.cluster": "cluster di liquidazioni",
            "liquidity.sweep": "sweep di liquidità", "pattern.retest": "retest probabile", "macro.riskoff": "contesto risk-off"}


def _topic_it(topic: str) -> str:
    return TOPIC_IT.get(topic) or TOPIC_IT.get(topic.rsplit(".", 1)[0] + ".*") or "avviso"


COVERED_TOPICS = {"timepivot.alert", "clock.zone", "miners.signal", "stablecoins.alert", "macro.alert"}


def rule_agents(p: float) -> Cand:
    msgs = []
    try:
        from .agents.engine import bus
        last = _state.get("bus_last_id")
        cur = [m for m in list(bus.messages) if m.get("kind") == "alert"]
        top = max((m["id"] for m in bus.messages), default=0)
        if last is None:
            _state["bus_last_id"] = top
        else:
            msgs = [m for m in cur if m["id"] > last]
            _state["bus_last_id"] = max(top, last)
    except Exception:  # noqa: BLE001
        pass
    seen: set = _state.setdefault("agent_seen", set())
    while _pending_agent:
        msgs.append(_pending_agent.pop(0))
    fresh = []
    for m in msgs:
        if m["id"] in seen or m.get("topic") in COVERED_TOPICS:
            continue
        seen.add(m["id"])
        fresh.append(m)
    if len(seen) > 2000:
        _state["agent_seen"] = set(sorted(seen)[-1000:])
    if not fresh:
        return []
    names = {}
    try:
        from .agents.engine import bus
        names = {a.id: a.name for a in bus.agents.values()}
    except Exception:  # noqa: BLE001
        pass
    # una voce per (agente, topic): la più recente
    by: dict = {}
    for m in sorted(fresh, key=lambda x: x["id"]):
        by[(m["from"], m["topic"])] = m
    now = time.time()
    keep = [(k, m) for k, m in by.items() if now - _fired.get(f"agent:{k[0]}:{k[1]}", 0) >= 3 * 3600]
    if not keep:
        return []
    ckeys = [f"agent:{k[0]}:{k[1]}" for k, _ in keep]
    for k in ckeys:
        _fired[k] = now
    if len(keep) == 1:
        (frm, topic), m = keep[0]
        return [(f"agentmsg:{m['id']}", 0, _alert("info", "agents", f"{names.get(frm, frm)}: {_topic_it(topic)}", m["text"][:220], "/avvisi",
                                                  {"from": frm, "topic": topic, "tone": m.get("tone"), "message_id": m["id"], "cooldown_keys": ckeys}, "agent_alert"))]
    items = [{"from": f, "agent": names.get(f, f), "topic": t, "text": m["text"], "tone": m.get("tone"), "message_id": m["id"]} for (f, t), m in keep]
    who = ", ".join(sorted({i["agent"] for i in items}))
    return [(f"agentagg:{int(now)}", 0, _alert("info", "agents", f"{len(items)} avvisi dagli agenti", f"{who}: {items[0]['text'][:140]}",
                                               "/avvisi", {"items": items, "cooldown_keys": ckeys}, "agent_alert"))]


def _invalidate(keys: list[str]) -> None:
    """Dal thread di una regola: chiede al frontend di ricaricare le API indicate (WS {"type":"invalidate"})."""
    try:
        if _task is None or _task.done():
            return
        from .routers.stream import hub
        asyncio.run_coroutine_threadsafe(hub._broadcast({"type": "invalidate", "source": "alerts", "keys": keys, "time": int(time.time())}), _task.get_loop())
    except Exception as e:  # noqa: BLE001
        log.debug("invalidate: %s", e)


def rule_custom(p: float) -> Cand:
    """Avvisi personalizzati dell'utente (app/alert_rules.py, pagina /avvisi)."""
    from . import alert_rules
    out: Cand = []
    for key, cd, sev, title, text, link, data in alert_rules.evaluate(p):
        a = _alert(sev, "custom", title, text, link, data, "custom_rule")
        a["category_label"] = "Avvisi personali"
        out.append((key, cd, a))
    if out:
        _invalidate(["/alerts/rules"])
    return out


# (nome, intervallo s, funzione)
RULES: list[tuple[str, int, Callable[[float], Cand]]] = [
    ("custom", 20, rule_custom),
    ("price_move", 20, rule_move),
    ("level_cross", 20, rule_levels),
    ("liquidity_sweep", 20, rule_sweep),
    ("liq_burst", 20, rule_liq_burst),
    ("agent_alert", 20, rule_agents),
    ("derivatives", 60, rule_derivatives),
    ("closes", 60, rule_closes),
    ("timepivot_window", 600, rule_timepivots),
    ("event_24h", 600, rule_events),
    ("cycle", 600, rule_cycle),
    ("macro_regime", 600, rule_macro),
    ("stablecoins", 1800, rule_stables),
]

RULE_INFO = [
    {"rule": "price_move", "category": "price", "severity": "warning/critical", "threshold": "|Δ| ≥ 3% in 60 min (critico ≥ 5%)", "cooldown": "2 h per direzione"},
    {"rule": "level_cross", "category": "levels", "severity": "warning (info lunedì)", "threshold": "R1/S1 chiave, apertura settimanale, max/min settimana precedente, max/min del lunedì; conferma oltre 0.15%", "cooldown": "6 h per livello"},
    {"rule": "liquidity_sweep", "category": "liquidity", "severity": "warning", "threshold": "cluster stimati ≥ $100M entro il 6% e pool con forza ≥ 60, toccati dalla candela 1m", "cooldown": "6 h per livello"},
    {"rule": "liq_burst", "category": "liquidity", "severity": "warning/critical", "threshold": "liquidazioni reali ≥ $5M in 5 min per lato (critico ≥ $20M)", "cooldown": "30 min per lato"},
    {"rule": "funding", "category": "derivatives", "severity": "warning", "threshold": "funding ≥ +0.05% o ≤ −0.02% per 8h (ingresso nella zona)", "cooldown": "12 h"},
    {"rule": "oi_spike", "category": "derivatives", "severity": "warning", "threshold": "open interest ±5% in 1 h", "cooldown": "3 h per direzione"},
    {"rule": "daily_close / weekly_close", "category": "levels", "severity": "warning", "threshold": "chiusura daily oltre R1/S1; chiusura weekly oltre max/min della settimana precedente", "cooldown": "1 per candela"},
    {"rule": "timepivot_window", "category": "time", "severity": "info (warning se confluenza ≥ 75)", "threshold": "finestra con confluenza ≥ 60 che inizia oggi/domani", "cooldown": "1 per finestra"},
    {"rule": "event_24h", "category": "events", "severity": "warning (importanza alta) / info", "threshold": "FOMC, CPI, NFP, scadenze opzioni, midterm entro 24 h", "cooldown": "1 per evento"},
    {"rule": "cycle_zone / hash_ribbons / miner_state", "category": "cycle", "severity": "warning / info", "threshold": "cambio di zona dell'orologio del ciclo, nuovo segnale Hash Ribbons, ingresso in capitolazione", "cooldown": "su transizione"},
    {"rule": "macro_regime", "category": "macro", "severity": "warning", "threshold": "cambio Risk-on / Neutrale / Risk-off", "cooldown": "su transizione"},
    {"rule": "stablecoins", "category": "stablecoins", "severity": "info / warning", "threshold": "mint/burn netto ≥ $1B in un giorno; ≥ $3B in 7 giorni", "cooldown": "1 per giorno / settimana"},
    {"rule": "agent_alert", "category": "agents", "severity": "info", "threshold": "messaggi kind=alert degli agenti non già coperti dalle regole; aggregati per giro", "cooldown": "3 h per agente+topic"},
    {"rule": "custom_rule", "category": "custom", "severity": "scelta dall'utente", "threshold": "regole personalizzate (/avvisi): prezzo, variazione %, zone, livelli, indicatori, Cycle Score, pivot temporali, chiusure, liquidazioni", "cooldown": "scelto per regola"},
]


# ------------------------------------------------------------------ ciclo

async def evaluate(force: bool = False) -> int:
    now = time.time()
    p = await asyncio.to_thread(_price)
    if not p:
        return 0
    n = 0
    for name, every, fn in RULES:
        if not force and now - _state.get(f"ran:{name}", 0) < every - 1:
            continue
        _state[f"ran:{name}"] = now
        try:
            cands = await asyncio.to_thread(fn, p)
            _meta["errors"].pop(name, None)
        except Exception as e:  # noqa: BLE001
            _meta["errors"][name] = str(e)[:200]
            log.info("regola %s: %s", name, e)
            continue
        for key, cd, al in cands:
            if await emit(key, cd, al):
                n += 1
    _meta["last_eval"] = int(now)
    _meta["evals"] += 1
    return n


async def _loop() -> None:
    _meta["started_at"] = int(time.time())
    await asyncio.sleep(15)
    while True:
        try:
            await evaluate()
        except Exception as e:  # noqa: BLE001
            log.warning("ciclo avvisi: %s", e)
        await asyncio.sleep(TICK_S)


def start() -> None:
    """Avvia il motore di regole nel loop di FastAPI (idempotente). Chiamare dal lifespan di main.py."""
    global _task
    _load_history()
    if _task is None or _task.done():
        _task = asyncio.get_running_loop().create_task(_loop())


def status() -> dict:
    return {"running": bool(_task and not _task.done()), **_meta, "rules": RULE_INFO, "thresholds": TH}


async def test_alert(severity: str = "warning") -> dict:
    p = await asyncio.to_thread(_price) or 0
    sev = severity if severity in SEVERITIES else "warning"
    return await push(_alert(sev, "test", "Avviso di prova", f"Toast di test generato manualmente (prezzo {_usd(p)}).", "/", {"price": p}, "test"))
