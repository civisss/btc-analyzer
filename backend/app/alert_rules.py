"""Avvisi personalizzati: regole definite dall'utente, salvate in backend/data/alert_rules.json (sopravvivono ai riavvii).

Le regole sono valutate dal motore esistente (`alerts.rule_custom`, ogni ~20 s) e i toast passano per `alerts.emit/push`
(stesso storico, campanella, WebSocket). Semantica unica per le regole "a condizione": l'avviso scatta quando la condizione
DIVENTA vera (se è già vera al salvataggio, scatta al primo controllo); una regola ripetibile si riarma solo dopo che la
condizione è tornata falsa e il cooldown è trascorso; una regola "una tantum" si disattiva dopo il primo avviso.
Regole "a evento" (cambio di zona del Cycle Score, finestra pivot, chiusura di candela) scattano una volta per evento.

Nessun testo generato viene restituito alle API: solo codici e numeri (le etichette sono tradotte dal frontend).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from typing import Any

import pandas as pd

from . import util
from .data import store

log = logging.getLogger("alert_rules")

# USER_DATA_DIR (opzionale) sposta i file dell'utente (regole, annotazioni), es. per un'istanza di test separata
USER_DIR = store.Path(os.environ["USER_DATA_DIR"]) if os.environ.get("USER_DATA_DIR") else store.DATA_DIR
USER_DIR.mkdir(parents=True, exist_ok=True)
RULES_FILE = USER_DIR / "alert_rules.json"
_lock = threading.RLock()
_rules: list[dict] | None = None
_runtime: dict[str, dict] = {}      # id -> {value, checked, cond, detail} (non persistito: aggiornato a ogni giro)

TYPES = ("price_cross", "pct_move", "zone", "level_distance", "indicator", "cycle_zone", "timepivot", "candle_close", "liq_burst")
EVENT_TYPES = ("cycle_zone", "timepivot", "candle_close")
SEVERITIES = ("info", "warning", "critical")
METRICS = {  # chiave -> unità (per il frontend)
    "rsi_1h": "idx", "rsi_4h": "idx", "rsi_1d": "idx", "funding": "pct8h", "oi_change_1h": "pct", "oi_change_4h": "pct",
    "oi_change_24h": "pct", "fng": "idx", "cycle_score": "idx", "usdt_d": "pct", "usdt_d_change_7d": "pt",
}
CYCLE_ZONES = ("bottom", "accumulation", "mid", "euphoria", "top")
MOVE_WINDOWS = (5, 15, 30, 60, 120, 240, 480, 720, 1440)
LIQ_WINDOWS = (1, 5, 15, 30, 60, 240)


# ------------------------------------------------------------------ persistenza

def _load() -> list[dict]:
    global _rules
    with _lock:
        if _rules is None:
            try:
                _rules = json.loads(RULES_FILE.read_text(encoding="utf-8")) if RULES_FILE.exists() else []
                if not isinstance(_rules, list):
                    _rules = []
            except Exception as e:  # noqa: BLE001
                log.warning("alert_rules.json illeggibile: %s", e)
                _rules = []
        return _rules


def _save() -> None:
    with _lock:
        tmp = RULES_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_rules or [], ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, RULES_FILE)


class RuleError(ValueError):
    """Errore di validazione (diventa HTTP 400 con un codice leggibile dal frontend)."""


def _num(v, name: str, lo: float | None = None, hi: float | None = None) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise RuleError(f"{name}: numero non valido") from None
    if f != f or f in (float("inf"), float("-inf")):
        raise RuleError(f"{name}: numero non valido")
    if lo is not None and f < lo:
        raise RuleError(f"{name}: minimo {lo:g}")
    if hi is not None and f > hi:
        raise RuleError(f"{name}: massimo {hi:g}")
    return f


def _choice(v, name: str, options) -> Any:
    if v not in options:
        raise RuleError(f"{name}: valore non valido ({v!r})")
    return v


def validate_params(rtype: str, p: dict) -> dict:
    p = p or {}
    if rtype == "price_cross":
        return {"direction": _choice(p.get("direction"), "direction", ("above", "below")), "price": _num(p.get("price"), "price", 1, 10_000_000)}
    if rtype == "pct_move":
        return {"direction": _choice(p.get("direction", "any"), "direction", ("up", "down", "any")),
                "pct": _num(p.get("pct"), "pct", 0.1, 50), "window_min": int(_choice(int(_num(p.get("window_min"), "window_min")), "window_min", MOVE_WINDOWS))}
    if rtype == "zone":
        lo, hi = _num(p.get("low"), "low", 1, 10_000_000), _num(p.get("high"), "high", 1, 10_000_000)
        if hi <= lo:
            raise RuleError("high: deve essere maggiore di low")
        return {"low": lo, "high": hi, "mode": _choice(p.get("mode", "enter"), "mode", ("enter", "exit"))}
    if rtype == "level_distance":
        lv = str(p.get("level") or "")
        if lv not in LEVEL_IDS:
            raise RuleError(f"level: livello sconosciuto ({lv!r})")
        return {"level": lv, "pct": _num(p.get("pct"), "pct", 0.05, 20)}
    if rtype == "indicator":
        m = _choice(p.get("metric"), "metric", tuple(METRICS))
        lim = {"idx": (0, 100), "pct8h": (-1, 1), "pct": (-100, 100), "pt": (-20, 20)}[METRICS[m]]
        if m == "usdt_d":
            lim = (0, 50)
        return {"metric": m, "op": _choice(p.get("op"), "op", ("above", "below")), "value": _num(p.get("value"), "value", *lim)}
    if rtype == "cycle_zone":
        return {"zone": _choice(p.get("zone", "any"), "zone", ("any",) + CYCLE_ZONES)}
    if rtype == "timepivot":
        return {"min_confluence": _num(p.get("min_confluence", 60), "min_confluence", 0, 100),
                "lead_days": int(_choice(int(_num(p.get("lead_days", 1), "lead_days")), "lead_days", (0, 1, 3, 7)))}
    if rtype == "candle_close":
        return {"tf": _choice(p.get("tf"), "tf", ("1d", "1w")), "direction": _choice(p.get("direction"), "direction", ("above", "below")),
                "price": _num(p.get("price"), "price", 1, 10_000_000)}
    if rtype == "liq_burst":
        return {"usd": _num(p.get("usd"), "usd", 100_000, 10_000_000_000), "window_min": int(_choice(int(_num(p.get("window_min"), "window_min")), "window_min", LIQ_WINDOWS)),
                "side": _choice(p.get("side", "any"), "side", ("any", "long", "short"))}
    raise RuleError(f"type: tipo di regola sconosciuto ({rtype!r})")


def _normalize(body: dict, old: dict | None = None) -> dict:
    rtype = _choice(body.get("type"), "type", TYPES)
    name = str(body.get("name") or "").strip()
    if not name:
        raise RuleError("name: obbligatorio")
    if len(name) > 80:
        raise RuleError("name: massimo 80 caratteri")
    note = str(body.get("note") or "").strip()
    if len(note) > 500:
        raise RuleError("note: massimo 500 caratteri")
    exp = body.get("expires_at")
    exp = int(_num(exp, "expires_at")) if exp not in (None, "", 0) else None
    if exp is not None and exp <= time.time() and (old is None or exp != old.get("expires_at")):
        raise RuleError("expires_at: la scadenza deve essere nel futuro")
    return {
        "name": name, "type": rtype, "params": validate_params(rtype, body.get("params") or {}),
        "enabled": bool(body.get("enabled", True)), "severity": _choice(body.get("severity", "warning"), "severity", SEVERITIES),
        "cooldown_min": int(_num(body.get("cooldown_min", 60), "cooldown_min", 1, 10080)), "repeat": bool(body.get("repeat", True)),
        "expires_at": exp, "note": note,
    }


def _prime(r: dict) -> None:
    """Stato iniziale delle regole a evento: solo gli eventi successivi al salvataggio contano."""
    st = r.setdefault("state", {})
    try:
        if r["type"] == "cycle_zone":
            st["last_zone"] = (metric_values(["cycle_zone"]) or {}).get("cycle_zone")
        elif r["type"] == "candle_close":
            st["last_candle"] = _last_closed(r["params"]["tf"])[0]
        elif r["type"] == "timepivot":
            st.setdefault("fired_ids", [])
    except Exception as e:  # noqa: BLE001
        log.info("prime regola %s: %s", r.get("id"), e)


def list_rules() -> list[dict]:
    return [public(r) for r in _load()]


def get(rid: str) -> dict | None:
    return next((r for r in _load() if r["id"] == rid), None)


def create(body: dict) -> dict:
    r = _normalize(body)
    now = int(time.time())
    r.update({"id": uuid.uuid4().hex[:12], "created_at": now, "updated_at": now, "last_fired": None, "fire_count": 0, "state": {}})
    _prime(r)
    with _lock:
        _load().append(r)
        _save()
    return public(r)


def update(rid: str, body: dict) -> dict | None:
    with _lock:
        r = get(rid)
        if r is None:
            return None
        new = _normalize({**{k: r.get(k) for k in ("name", "type", "params", "enabled", "severity", "cooldown_min", "repeat", "expires_at", "note")}, **body}, r)
        definition_changed = new["type"] != r["type"] or new["params"] != r["params"]
        reenabled = new["enabled"] and not r.get("enabled")
        r.update(new)
        r["updated_at"] = int(time.time())
        if definition_changed or reenabled:   # nuova condizione / riattivazione: si riparte da "non ancora vera"
            r["state"] = {}
            r.pop("done", None)
            _prime(r)
            _runtime.pop(rid, None)
        _save()
        return public(r)


def delete(rid: str) -> bool:
    with _lock:
        rules = _load()
        n = len(rules)
        rules[:] = [r for r in rules if r["id"] != rid]
        if len(rules) != n:
            _save()
            _runtime.pop(rid, None)
            return True
        return False


def status_of(r: dict, now: float | None = None) -> str:
    now = now or time.time()
    if r.get("expires_at") and r["expires_at"] <= now:
        return "expired"
    if r.get("done"):
        return "triggered"
    if not r.get("enabled"):
        return "paused"
    rt = _runtime.get(r["id"]) or {}
    if rt.get("error"):
        return "error"
    return "active"


def public(r: dict) -> dict:
    rt = _runtime.get(r["id"]) or {}
    cd = r["cooldown_min"] * 60
    cooldown_until = r["last_fired"] + cd if r.get("last_fired") and r["last_fired"] + cd > time.time() else None
    st = status_of(r)
    from . import alerts as al
    nxt = None
    if st == "active":
        nxt = int((rt.get("checked") or al._meta.get("last_eval") or time.time()) + al.TICK_S)
    return util.clean({
        **{k: r.get(k) for k in ("id", "name", "type", "params", "enabled", "severity", "cooldown_min", "repeat", "expires_at", "note",
                                 "created_at", "updated_at", "last_fired", "fire_count")},
        "status": st, "last_checked": rt.get("checked"), "next_check": nxt, "cooldown_until": cooldown_until,
        "current": {"value": rt.get("value"), "condition": rt.get("cond"), "error": rt.get("error")},
    })


# ------------------------------------------------------------------ dati live (cache brevi)

_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    now = time.time()
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (now, val)
    return val


def _price() -> float | None:
    from . import alerts as al
    return al._price()


def _rsi(tf: str) -> float | None:
    def fn():
        from .analysis.market import rsi
        from .routers import market
        df = market._frame(tf)
        return util.num(rsi(df["close"]).iloc[-1]) if len(df) > 30 else None
    return _cached(f"rsi:{tf}", 30, fn)


def _funding() -> float | None:
    from . import alerts as al
    h = al._hub()
    mk = h.last.get("mark") if h else None
    if mk and time.time() - mk["time"] < 120:
        return float(mk["funding_rate"])
    f = store.get("funding")
    return float(f["rate"].iloc[-1]) * 100 if len(f) else None


def _oi_change(hours: int) -> float | None:
    def fn():
        oi = store.get("oi_15m")
        if len(oi) < 2 or (pd.Timestamp.now(tz="UTC") - oi["time"].iloc[-1]).total_seconds() > 3600:
            return None
        t_ref = oi["time"].iloc[-1] - pd.Timedelta(hours=hours)
        ref = oi[oi["time"] <= t_ref]
        if not len(ref) or (t_ref - ref["time"].iloc[-1]).total_seconds() > 1800:
            return None
        a, b = float(ref["oi_usd"].iloc[-1]), float(oi["oi_usd"].iloc[-1])
        return (b / a - 1) * 100 if a else None
    return _cached(f"oi:{hours}", 60, fn)


def _fng() -> float | None:
    f = store.get("fng")
    return float(f["value"].iloc[-1]) if len(f) else None


def _cycle() -> dict:
    def fn():
        from .routers import cycle_advanced as ca
        cur = ca.build_clock().get("current") or {}
        return {"score": util.num(cur.get("score")), "zone": cur.get("zone")}
    return _cached("cycle", 120, fn)


def _usdt() -> dict:
    def fn():
        from .routers import usdt
        cur = usdt.build().get("current") or {}
        return {"usdt_d": util.num(cur.get("usdt_d")), "usdt_d_change_7d": util.num(cur.get("usdt_d_change_7d"))}
    return _cached("usdt", 300, fn)


def metric_values(keys: list[str] | None = None) -> dict:
    """Valori correnti delle metriche (solo quelle richieste: alcune sono costose)."""
    want = set(keys or list(METRICS) + ["cycle_zone"])
    out: dict[str, Any] = {}
    getters = {
        "rsi_1h": lambda: _rsi("1h"), "rsi_4h": lambda: _rsi("4h"), "rsi_1d": lambda: _rsi("1d"), "funding": _funding,
        "oi_change_1h": lambda: _oi_change(1), "oi_change_4h": lambda: _oi_change(4), "oi_change_24h": lambda: _oi_change(24),
        "fng": _fng, "cycle_score": lambda: _cycle()["score"], "cycle_zone": lambda: _cycle()["zone"],
        "usdt_d": lambda: _usdt()["usdt_d"], "usdt_d_change_7d": lambda: _usdt()["usdt_d_change_7d"],
    }
    for k in want:
        if k in getters:
            try:
                out[k] = getters[k]()
            except Exception as e:  # noqa: BLE001
                log.info("metrica %s: %s", k, e)
                out[k] = None
    return out


def _klines_1m() -> pd.DataFrame:
    def fn():
        from .data import sources as src
        rows = src._get(f"{src.BINANCE}/api/v3/klines", {"symbol": "BTCUSDT", "interval": "1m", "limit": 1000}, retries=2)
        df = pd.DataFrame([[int(r[0]) // 1000, float(r[4])] for r in rows], columns=["t", "close"])
        return df
    return _cached("k1m", 30, fn)


def _move(window_min: int, p: float) -> tuple[float | None, float | None]:
    """(variazione %, prezzo di riferimento) negli ultimi `window_min` minuti."""
    t_ref = time.time() - window_min * 60
    if window_min <= 900:
        df = _klines_1m()
        ref = df[df["t"] <= t_ref - 60]
        if not len(ref):
            return None, None
        p0 = float(ref["close"].iloc[-1])
    else:
        d = store.get("k_1h")
        ref = d[d["time"] <= pd.Timestamp(t_ref - 3600, unit="s", tz="UTC")]
        if not len(ref):
            return None, None
        p0 = float(ref["close"].iloc[-1])
    return ((p / p0 - 1) * 100 if p0 else None), p0


def _liq_sum(window_min: int, side: str) -> float | None:
    df = store.liquidations()
    if df is None or df.empty:
        return 0.0
    d = df[df["time"] >= pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=window_min)]
    if side != "any":
        d = d[d["side"] == side]
    return float(d["usd"].sum())


def _last_closed(tf: str) -> tuple[int | None, float | None]:
    d = store.get("k_1d" if tf == "1d" else "k_1w")
    if len(d) < 2:
        return None, None
    span = 86400 if tf == "1d" else 7 * 86400
    last_t = int(d["time"].iloc[-1].timestamp())
    i = -1 if last_t + span <= time.time() else -2       # l'ultima riga è la candela ancora aperta
    return int(d["time"].iloc[i].timestamp()), float(d["close"].iloc[i])


# ------------------------------------------------------------------ livelli con nome
# id -> etichetta (in italiano: il frontend usa una propria mappa per IT/EN)
LEVEL_IDS = (
    "key_r1", "key_r2", "key_r3", "key_s1", "key_s2", "key_s3",
    "piv_d_P", "piv_d_R1", "piv_d_S1", "piv_w_P", "piv_w_R1", "piv_w_R2", "piv_w_S1", "piv_w_S2", "piv_m_P", "piv_m_R1", "piv_m_S1",
    "weekly_open", "monthly_open", "quarterly_open", "yearly_open", "prev_week_high", "prev_week_low", "prev_month_high", "prev_month_low",
    "monday_high", "monday_low", "monday_mid", "range_high", "range_mid", "range_low", "ath",
    # VWAP ancorati (Kraken Futures PF_XBTUSD, candele 1m chiuse — app/analysis/vwap.py)
    "vwap_w", "vwap_w_up1", "vwap_w_dn1", "vwap_m", "vwap_m_up1", "vwap_m_dn1",
    "vwap_q", "vwap_q_up1", "vwap_q_dn1", "vwap_y", "vwap_y_up1", "vwap_y_dn1",
    "vwap_pw", "vwap_pm", "vwap_pq", "vwap_py",
    # volume profile della settimana precedente (POC e value area 70%)
    "vp_pw_poc", "vp_pw_vah", "vp_pw_val",
)


def named_levels() -> dict[str, dict]:
    """{id: {price, source}} — `source` è l'etichetta del builder (solo per i livelli chiave R/S, che cambiano col prezzo)."""
    def fn():
        from .routers import market, structure
        out: dict[str, dict] = {}
        try:
            lv = market.build_levels("1d")
            for k in lv.get("key_levels", []):
                tag, _, src = k["label"].partition(" · ")
                if tag[:1] in "RS" and tag[1:].isdigit():
                    out[f"key_{tag.lower()}"] = {"price": float(k["price"]), "source": src}
            for per, short in (("daily", "d"), ("weekly", "w"), ("monthly", "m")):
                cl = (lv.get("pivots", {}).get(per) or {}).get("classic") or {}
                for k, v in cl.items():
                    if f"piv_{short}_{k}" in LEVEL_IDS:
                        out[f"piv_{short}_{k}"] = {"price": float(v)}
        except Exception as e:  # noqa: BLE001
            log.info("livelli market: %s", e)
        try:
            pv = structure.build_pivots()
            for l in (pv.get("opens") or {}).get("levels", []):
                if l.get("key") in LEVEL_IDS and l.get("price"):
                    out[l["key"]] = {"price": float(l["price"])}
            mon = (pv.get("monday") or {}).get("current") or {}
            if mon.get("monday_complete") and mon.get("high"):
                out["monday_high"] = {"price": float(mon["high"])}
                out["monday_low"] = {"price": float(mon["low"])}
                out["monday_mid"] = {"price": float(mon["mid"])}
        except Exception as e:  # noqa: BLE001
            log.info("livelli structure: %s", e)
        try:
            rg = structure.build_scenarios().get("range")
            if rg:
                out["range_high"], out["range_mid"], out["range_low"] = ({"price": float(rg["high"])}, {"price": float(rg["mid"])}, {"price": float(rg["low"])})
        except Exception as e:  # noqa: BLE001
            log.info("livelli range: %s", e)
        try:
            out["ath"] = {"price": float(store.get("k_1d")["high"].max())}
        except Exception:  # noqa: BLE001
            pass
        try:
            from .analysis import vwap
            pdat = vwap.build("kraken", "fine").get("periods_data") or {}
            for per, d in pdat.items():
                for k, lid in (("vwap", f"vwap_{per}"), ("up1", f"vwap_{per}_up1"), ("dn1", f"vwap_{per}_dn1")):
                    if d.get(k):
                        out[lid] = {"price": float(d[k])}
                if (d.get("prev") or {}).get("vwap"):
                    out[f"vwap_p{per}"] = {"price": float(d["prev"]["vwap"])}
            vp = vwap.prev_week_profile("kraken")
            if vp:
                for k in ("poc", "vah", "val"):
                    out[f"vp_pw_{k}"] = {"price": float(vp[k])}
        except Exception as e:  # noqa: BLE001
            log.info("livelli vwap: %s", e)
        return out
    return _cached("levels", 60, fn)


def _timepivot_windows(min_conf: float, lead_days: int) -> list[dict]:
    def fn():
        from .routers import timepivots as tpr
        return tpr.build(90).get("calendar", [])
    cal = _cached("tp", 600, fn)
    now = time.time()
    out = []
    for it in cal:
        if (it.get("confluence") or 0) < min_conf or not it.get("start") or not it.get("end"):
            continue
        # lead_days = 0: solo finestre già iniziate; altrimenti anche quelle che iniziano entro lead_days giorni
        if it["end"] > now and it["start"] - now <= lead_days * 86400:
            out.append({"id": it["id"], "start": it["start"], "end": it["end"], "confluence": it.get("confluence"),
                        "expected": it.get("expected"), "probability": it.get("probability")})
    return sorted(out, key=lambda x: x["start"])


# ------------------------------------------------------------------ valutazione

def _usd(x: float) -> str:
    return f"${x:,.0f}"


def check(r: dict, p: float | None = None) -> dict:
    """Valuta la condizione ADESSO, senza effetti. -> {value, threshold, condition, unit, detail, event?}"""
    p = p if p is not None else _price()
    t, q = r["type"], r["params"]
    if p is None and t in ("price_cross", "pct_move", "zone", "level_distance"):
        return {"value": None, "condition": None, "unit": "usd", "detail": {}}
    if t == "price_cross":
        cond = p > q["price"] if q["direction"] == "above" else p < q["price"]
        return {"value": p, "threshold": q["price"], "condition": cond, "unit": "usd", "detail": {"distance_pct": (p / q["price"] - 1) * 100}}
    if t == "pct_move":
        ch, p0 = _move(q["window_min"], p)
        if ch is None:
            return {"value": None, "condition": None, "unit": "pct", "detail": {}}
        cond = ch >= q["pct"] if q["direction"] == "up" else ch <= -q["pct"] if q["direction"] == "down" else abs(ch) >= q["pct"]
        return {"value": ch, "threshold": q["pct"], "condition": cond, "unit": "pct", "detail": {"price": p, "ref_price": p0}}
    if t == "zone":
        inside = q["low"] <= p <= q["high"]
        return {"value": p, "threshold": None, "condition": inside if q["mode"] == "enter" else not inside, "unit": "usd",
                "detail": {"inside": inside, "low": q["low"], "high": q["high"]}}
    if t == "level_distance":
        lv = named_levels().get(q["level"])
        if not lv:
            return {"value": None, "condition": None, "unit": "pct", "detail": {"level_price": None}}
        dist = (p / lv["price"] - 1) * 100
        return {"value": abs(dist), "threshold": q["pct"], "condition": abs(dist) <= q["pct"], "unit": "pct",
                "detail": {"price": p, "level_price": lv["price"], "signed_distance_pct": dist, "source": lv.get("source")}}
    if t == "indicator":
        v = metric_values([q["metric"]]).get(q["metric"])
        if v is None:
            return {"value": None, "condition": None, "unit": METRICS[q["metric"]], "detail": {}}
        cond = v > q["value"] if q["op"] == "above" else v < q["value"]
        return {"value": v, "threshold": q["value"], "condition": cond, "unit": METRICS[q["metric"]], "detail": {}}
    if t == "liq_burst":
        v = _liq_sum(q["window_min"], q["side"])
        return {"value": v, "threshold": q["usd"], "condition": v is not None and v >= q["usd"], "unit": "usd", "detail": {}}
    if t == "cycle_zone":
        c = _cycle()
        last = (r.get("state") or {}).get("last_zone")
        changed = c["zone"] is not None and last is not None and c["zone"] != last
        ev = changed and (q["zone"] == "any" or c["zone"] == q["zone"])
        return {"value": c["score"], "threshold": None, "condition": ev, "unit": "idx", "event": True,
                "detail": {"zone": c["zone"], "last_zone": last}}
    if t == "timepivot":
        wins = _timepivot_windows(q["min_confluence"], q["lead_days"])
        fired = set((r.get("state") or {}).get("fired_ids") or [])
        new = [w for w in wins if w["id"] not in fired]
        return {"value": len(wins), "threshold": q["min_confluence"], "condition": bool(new), "unit": "count", "event": True,
                "detail": {"windows": wins[:5], "new": [w["id"] for w in new]}}
    if t == "candle_close":
        ct, c = _last_closed(q["tf"])
        last = (r.get("state") or {}).get("last_candle")
        met = c is not None and (c > q["price"] if q["direction"] == "above" else c < q["price"])
        span = 86400 if q["tf"] == "1d" else 7 * 86400
        return {"value": c, "threshold": q["price"], "condition": bool(met and ct is not None and last is not None and ct > last), "unit": "usd",
                "event": True, "detail": {"candle_time": ct, "last_seen": last, "close_met": met, "next_close": (ct + 2 * span) if ct else None}}
    return {"value": None, "condition": None, "unit": "", "detail": {}}


def preview(r: dict) -> dict:
    """Anteprima per /test: valore attuale vs soglia e se l'avviso partirebbe ora (con il motivo)."""
    try:
        c = check(r)
    except Exception as e:  # noqa: BLE001
        return {"value": None, "threshold": None, "condition": None, "would_fire": False, "reason": "no_data", "unit": "", "detail": {"error": str(e)[:160]}}
    now = time.time()
    st = r.get("state") or {}
    if c.get("condition") is None:
        reason = "no_data"
    elif r.get("expires_at") and r["expires_at"] <= now:
        reason = "expired"
    elif r.get("done"):
        reason = "triggered"
    elif r.get("id") and not r.get("enabled", True):
        reason = "disabled"
    elif not c["condition"]:
        reason = "pending_event" if c.get("event") else "not_met"
    elif r.get("last_fired") and now - r["last_fired"] < r.get("cooldown_min", 60) * 60:
        reason = "cooldown"
    elif not c.get("event") and st.get("cond"):
        reason = "already_fired"     # condizione già vera e già notificata: si riarma quando torna falsa
    else:
        reason = "ready"
    return util.clean({**c, "would_fire": reason == "ready", "reason": reason, "checked_at": int(now)})


def _describe(r: dict, c: dict) -> tuple[str, dict]:
    """Testo dell'avviso (italiano, tradotto dal traduttore come gli altri toast) + dati."""
    t, q, v, d = r["type"], r["params"], c.get("value"), c.get("detail") or {}
    if t == "price_cross":
        return f"Prezzo {_usd(v)}, {'sopra' if q['direction'] == 'above' else 'sotto'} la soglia di {_usd(q['price'])}.", {"price": v, "threshold": q["price"]}
    if t == "pct_move":
        return f"BTC {v:+.2f}% in {q['window_min']} minuti (da {_usd(d['ref_price'])} a {_usd(d['price'])}).", {"change": v, "price": d["price"]}
    if t == "zone":
        z = f"{_usd(q['low'])}–{_usd(q['high'])}"
        return (f"Prezzo {_usd(v)} {'entrato nella' if q['mode'] == 'enter' else 'fuori dalla'} zona {z}.", {"price": v, "low": q["low"], "high": q["high"]})
    if t == "level_distance":
        return (f"Prezzo {_usd(d['price'])} a {abs(d['signed_distance_pct']):.2f}% dal livello {LEVEL_IT.get(q['level'], q['level'])} ({_usd(d['level_price'])}).",
                {"price": d["price"], "level": d["level_price"], "distance": d["signed_distance_pct"]})
    if t == "indicator":
        unit = {"idx": "", "pct8h": "% / 8h", "pct": "%", "pt": " pt"}[METRICS[q["metric"]]]
        fmt = f"{v:.3f}" if METRICS[q["metric"]] == "pct8h" else f"{v:.0f}" if q["metric"] in ("fng", "cycle_score") else f"{v:.1f}"
        return (f"{METRIC_IT[q['metric']]} a {fmt}{unit}, {'sopra' if q['op'] == 'above' else 'sotto'} la soglia di {q['value']:g}{unit}.",
                {"value": v, "threshold": q["value"], "metric": q["metric"]})
    if t == "liq_burst":
        side = {"any": "", "long": " long", "short": " short"}[q["side"]]
        return f"Liquidazioni{side} per ${v / 1e6:,.1f}M negli ultimi {q['window_min']} minuti (soglia ${q['usd'] / 1e6:,.1f}M).", {"usd": v}
    if t == "cycle_zone":
        return (f"Il Cycle Score ({v:.0f}/100) è passato dalla zona {ZONE_IT.get(d['last_zone'], d['last_zone'])} alla zona {ZONE_IT.get(d['zone'], d['zone'])}.",
                {"score": v, "zone": d["zone"], "prev": d["last_zone"]})
    if t == "timepivot":
        w = next((x for x in d["windows"] if x["id"] in d["new"]), d["windows"][0])
        span = f"{util.data_it(w['start'], False)} – {util.data_it(w['end'], False)}"
        when = f"in corso ({span})" if w["start"] <= time.time() else f"in arrivo ({span})"
        return (f"Finestra di pivot temporale {when}, confluenza {w['confluence']:.0f}/100.",
                {"window": w["id"], "start": w["start"], "end": w["end"], "confluence": w["confluence"]})
    if t == "candle_close":
        return (f"Chiusura {'giornaliera' if q['tf'] == '1d' else 'settimanale'} a {_usd(v)}, {'sopra' if q['direction'] == 'above' else 'sotto'} {_usd(q['price'])}.",
                {"close": v, "threshold": q["price"], "candle": d["candle_time"]})
    return "", {}


LEVEL_IT = {"key_r1": "R1 chiave", "key_r2": "R2 chiave", "key_r3": "R3 chiave", "key_s1": "S1 chiave", "key_s2": "S2 chiave", "key_s3": "S3 chiave",
            "piv_d_P": "pivot giornaliero P", "piv_d_R1": "pivot giornaliero R1", "piv_d_S1": "pivot giornaliero S1",
            "piv_w_P": "pivot settimanale P", "piv_w_R1": "pivot settimanale R1", "piv_w_R2": "pivot settimanale R2",
            "piv_w_S1": "pivot settimanale S1", "piv_w_S2": "pivot settimanale S2", "piv_m_P": "pivot mensile P",
            "piv_m_R1": "pivot mensile R1", "piv_m_S1": "pivot mensile S1", "weekly_open": "apertura settimanale",
            "monthly_open": "apertura mensile", "quarterly_open": "apertura trimestrale", "yearly_open": "apertura annuale",
            "prev_week_high": "massimo settimana precedente", "prev_week_low": "minimo settimana precedente",
            "prev_month_high": "massimo mese precedente", "prev_month_low": "minimo mese precedente", "monday_high": "massimo del lunedì",
            "monday_low": "minimo del lunedì", "monday_mid": "metà del lunedì", "range_high": "massimo del range", "range_mid": "metà range",
            "range_low": "minimo del range", "ath": "massimo storico",
            "vwap_w": "VWAP settimanale", "vwap_w_up1": "VWAP settimanale +1σ", "vwap_w_dn1": "VWAP settimanale −1σ",
            "vwap_m": "VWAP mensile", "vwap_m_up1": "VWAP mensile +1σ", "vwap_m_dn1": "VWAP mensile −1σ",
            "vwap_q": "VWAP trimestrale", "vwap_q_up1": "VWAP trimestrale +1σ", "vwap_q_dn1": "VWAP trimestrale −1σ",
            "vwap_y": "VWAP annuale", "vwap_y_up1": "VWAP annuale +1σ", "vwap_y_dn1": "VWAP annuale −1σ",
            "vwap_pw": "VWAP della settimana precedente", "vwap_pm": "VWAP del mese precedente",
            "vwap_pq": "VWAP del trimestre precedente", "vwap_py": "VWAP dell'anno precedente",
            "vp_pw_poc": "POC della settimana precedente", "vp_pw_vah": "VAH (value area) della settimana precedente",
            "vp_pw_val": "VAL (value area) della settimana precedente"}
METRIC_IT = {"rsi_1h": "RSI 1h", "rsi_4h": "RSI 4h", "rsi_1d": "RSI 1G", "funding": "Funding", "oi_change_1h": "Variazione OI 1h",
             "oi_change_4h": "Variazione OI 4h", "oi_change_24h": "Variazione OI 24h", "fng": "Fear & Greed", "cycle_score": "Cycle Score",
             "usdt_d": "USDT dominance", "usdt_d_change_7d": "Variazione USDT.D 7g"}
ZONE_IT = {"bottom": "di minimo", "accumulation": "di accumulo", "mid": "di metà ciclo", "euphoria": "di euforia", "top": "di massimo"}


def evaluate(p: float) -> list[tuple[str, float, str, str, str, str, dict]]:
    """Chiamata dal motore (thread) a ogni giro: -> [(key, cooldown_s, severity, title, text, link, data)] da emettere."""
    now = time.time()
    out = []
    dirty = False
    with _lock:
        rules = list(_load())
    for r in rules:
        if not r.get("enabled") or r.get("done") or (r.get("expires_at") and r["expires_at"] <= now):
            continue
        try:
            c = check(r, p)
            _runtime[r["id"]] = {"value": c.get("value"), "cond": c.get("condition"), "checked": int(now), "error": None}
        except Exception as e:  # noqa: BLE001
            _runtime[r["id"]] = {"value": None, "cond": None, "checked": int(now), "error": str(e)[:160]}
            log.info("regola personalizzata %s: %s", r["id"], e)
            continue
        cond = c.get("condition")
        if cond is None:
            continue
        st = r.setdefault("state", {})
        cooled = not r.get("last_fired") or now - r["last_fired"] >= r["cooldown_min"] * 60
        fire = False
        if c.get("event"):
            if cond and cooled:
                fire = True
            # l'evento viene "consumato" anche se in cooldown (niente raffiche dopo il cooldown)
            if r["type"] == "cycle_zone" and c["detail"].get("zone") and c["detail"]["zone"] != st.get("last_zone"):
                st["last_zone"] = c["detail"]["zone"]
                dirty = True
            elif r["type"] == "candle_close" and c["detail"].get("candle_time") and c["detail"]["candle_time"] != st.get("last_candle"):
                if st.get("last_candle") is None or c["detail"]["candle_time"] > st["last_candle"]:
                    st["last_candle"] = c["detail"]["candle_time"]
                    dirty = True
            elif r["type"] == "timepivot" and c["detail"].get("new"):
                st["fired_ids"] = (st.get("fired_ids") or []) + c["detail"]["new"]
                st["fired_ids"] = st["fired_ids"][-50:]
                dirty = True
        else:
            prev = bool(st.get("cond"))
            if cond and not prev and cooled:
                fire = True
            if bool(cond) != prev:
                st["cond"] = bool(cond)
                dirty = True
        if not fire:
            continue
        try:
            text, data = _describe(r, c)
        except Exception as e:  # noqa: BLE001
            log.info("testo regola %s: %s", r["id"], e)
            text, data = "", {}
        r["last_fired"] = int(now)
        r["fire_count"] = int(r.get("fire_count") or 0) + 1
        if not r.get("repeat", True):
            r["done"] = True
            r["enabled"] = False
        dirty = True
        data = {**data, "rule_id": r["id"], "rule_type": r["type"], "note": r.get("note") or None}
        out.append((f"custom:{r['id']}:{r['fire_count']}", 0, r["severity"], r["name"], text, "/avvisi", data))
    if dirty:
        try:
            _save()
        except Exception as e:  # noqa: BLE001
            log.warning("salvataggio regole fallito: %s", e)
    return out


def metrics_snapshot() -> dict:
    """GET /alerts/rules/metrics: valori correnti per l'editor (prezzo, metriche, livelli con nome, finestre pivot)."""
    p = _price()
    lv = named_levels()
    out = {"price": p, "metrics": metric_values(), "levels": {k: {"price": v["price"], "source": v.get("source"),
                                                                 "distance": ((v["price"] / p - 1) * 100) if p else None} for k, v in lv.items()},
           "time": int(time.time())}
    try:
        out["timepivots"] = _timepivot_windows(0, 30)[:8]
    except Exception:  # noqa: BLE001
        out["timepivots"] = []
    try:
        out["liq_15m"] = _liq_sum(15, "any")
    except Exception:  # noqa: BLE001
        out["liq_15m"] = None
    for w in (60, 240, 1440):
        try:
            out.setdefault("moves", {})[str(w)] = _move(w, p)[0] if p else None
        except Exception:  # noqa: BLE001
            out.setdefault("moves", {})[str(w)] = None
    for tf in ("1d", "1w"):
        try:
            ct, c = _last_closed(tf)
            out.setdefault("closes", {})[tf] = {"time": ct, "close": c}
        except Exception:  # noqa: BLE001
            pass
    return util.clean(out)
