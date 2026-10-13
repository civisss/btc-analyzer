"""Diario di studio: note con snapshot automatico del contesto, revisione automatica dopo l'orizzonte, annotazioni del grafico.

Persistenza: backend/data/journal_notes.json e backend/data/journal_annotations.json (scrittura atomica).
Lo snapshot contiene solo codici e numeri presi dai builder esistenti (le etichette sono tradotte dal frontend).
Revisione: alla scadenza (created_at + horizon giorni) si confronta il prezzo di allora con il prezzo alla scadenza
(chiusura della candela 1h che contiene la scadenza), si misura l'escursione massima, si classifica l'esito con una
banda neutra per orizzonte (7 g ±2%, 30 g ±4%, 90 g ±8%) e si salva anche lo snapshot del contesto al momento della revisione.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

import pandas as pd

from . import util
from .data import store

log = logging.getLogger("journal")

from .alert_rules import USER_DIR  # noqa: E402  (stessa cartella dei dati utente; USER_DATA_DIR per un'istanza di test)

NOTES_FILE = USER_DIR / "journal_notes.json"
ANN_FILE = USER_DIR / "journal_annotations.json"
_lock = threading.RLock()
_notes: list[dict] | None = None
_anns: list[dict] | None = None

HORIZONS = (7, 30, 90)
DIRECTIONS = ("up", "down", "neutral")
BAND = {7: 2.0, 30: 4.0, 90: 8.0}          # banda neutra (%) per orizzonte
EDIT_VIEW_WINDOW = 15 * 60                  # vista e orizzonte modificabili solo nei primi 15 minuti
ANN_KINDS = ("hline", "trendline", "vline", "text")
ANN_COLORS = ("slate", "blue", "violet", "teal", "amber", "btc")
TFS = ("15m", "1h", "4h", "1d", "1w")


class JournalError(ValueError):
    pass


# ------------------------------------------------------------------ persistenza

def _read(path) -> list[dict]:
    try:
        v = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        return v if isinstance(v, list) else []
    except Exception as e:  # noqa: BLE001
        log.warning("%s illeggibile: %s", path.name, e)
        return []


def _write(path, data: list[dict]) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _notes_all() -> list[dict]:
    global _notes
    with _lock:
        if _notes is None:
            _notes = _read(NOTES_FILE)
        return _notes


def _anns_all() -> list[dict]:
    global _anns
    with _lock:
        if _anns is None:
            _anns = _read(ANN_FILE)
        return _anns


def _save_notes() -> None:
    with _lock:
        _write(NOTES_FILE, _notes or [])


def _save_anns() -> None:
    with _lock:
        _write(ANN_FILE, _anns or [])


# ------------------------------------------------------------------ snapshot del contesto

def _safe(name: str, fn, errors: list):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        errors.append(name)
        log.info("snapshot %s: %s", name, e)
        return None


def _forecast_block() -> dict | None:
    from .analysis import forecast as fc
    if not fc.is_ready():
        return None
    f = fc.build(90)
    tg = {int(t["days"]): t for t in f.get("targets", [])}
    return {"targets": [{k: t.get(k) for k in ("days", "low", "high", "median", "up_prob")} for t in f.get("targets", [])],
            "median_7d": (tg.get(7) or {}).get("median"), "median_30d": (tg.get(30) or {}).get("median"), "median_90d": (tg.get(90) or {}).get("median")}


def snapshot(include_forecast: bool = True) -> dict:
    """Contesto compatto al momento attuale (numeri e codici dai builder esistenti)."""
    from .routers import analogs, cycles, cycle_advanced as ca, derivatives, fractals, market, structure, timepivots, usdt
    from . import alerts
    errors: list[str] = []
    now = int(time.time())
    price = _safe("price", alerts._price, errors) or _safe("price", market.live_price, errors)
    snap: dict = {"time": now, "price": price}

    def _cycle():
        cy = cycles.build().get("current") or {}
        cur = ca.build_clock().get("current") or {}
        return {"phase": cy.get("phase"), "phase_confidence": cy.get("phase_confidence"), "days_since_halving": cy.get("days_since_halving"),
                "score": cur.get("score"), "zone": cur.get("zone"), "score_change_30d": cur.get("change_30d")}
    snap["cycle"] = _safe("cycle", _cycle, errors)

    def _levels():
        lv = market.build_levels("1d")
        out = []
        for k in lv.get("key_levels", []):
            tag, _, src = k["label"].partition(" · ")
            out.append({"tag": tag, "price": k["price"], "kind": k["kind"], "source": src})
        return out
    snap["levels"] = _safe("levels", _levels, errors)

    def _structure():
        s = structure.build_scenarios()
        rg = s.get("range") or {}
        return {"state": s.get("state"), "range_high": rg.get("high"), "range_low": rg.get("low"), "range_mid": rg.get("mid")}
    snap["structure"] = _safe("structure", _structure, errors)

    def _analogs():
        a = analogs.build(tf="1d")
        s = a.get("summary") or {}
        return {"bias": s.get("bias"), "median_outcome": s.get("median_outcome"), "up": s.get("up"), "down": s.get("down"),
                "count": s.get("count"), "horizon": a.get("horizon")}
    snap["analogs"] = _safe("analogs", _analogs, errors)

    def _fractals():
        f = fractals.build()
        pr = f.get("projection") or {}
        return {"bias": pr.get("bias"), "up_prob": pr.get("up_prob"), "tf": f.get("tf"), "horizon": f.get("horizon")}
    snap["fractals"] = _safe("fractals", _fractals, errors)

    snap["forecast"] = _safe("forecast", _forecast_block, errors) if include_forecast else None

    def _deriv():
        d = derivatives.build()
        return {"funding": (d.get("funding") or {}).get("current"), "oi_usd": (d.get("open_interest") or {}).get("current_usd"),
                "oi_change_24h": (d.get("open_interest") or {}).get("change_24h")}
    snap["derivatives"] = _safe("derivatives", _deriv, errors)

    def _fng():
        f = store.get("fng")
        return {"value": float(f["value"].iloc[-1]), "time": util.ts(f["time"].iloc[-1])} if len(f) else None
    snap["sentiment"] = _safe("sentiment", _fng, errors)

    def _usdt():
        c = usdt.build().get("current") or {}
        return {"usdt_d": c.get("usdt_d"), "change_7d": c.get("usdt_d_change_7d")}
    snap["usdt"] = _safe("usdt", _usdt, errors)

    def _tp():
        cal = timepivots.build(90).get("calendar", [])
        act = [c for c in cal if c.get("start") and c.get("end") and c["start"] - 7 * 86400 <= now < c["end"]]
        act.sort(key=lambda c: (-(c.get("confluence") or 0)))
        return [{"id": c["id"], "start": c["start"], "end": c["end"], "confluence": c.get("confluence"), "expected": c.get("expected"),
                 "probability": c.get("probability"), "active": c["start"] <= now} for c in act[:4]]
    snap["timepivots"] = _safe("timepivots", _tp, errors)
    snap["missing"] = errors
    return util.clean(snap)


def _fill_forecast_later(note_id: str) -> None:
    """Il modello di previsione non era pronto alla creazione: aggiunge le mediane appena disponibili (max ~10 min)."""
    def run():
        from .analysis import forecast as fc
        for _ in range(60):
            if fc.is_ready():
                break
            time.sleep(10)
        try:
            blk = _forecast_block()
        except Exception as e:  # noqa: BLE001
            log.info("forecast differito: %s", e)
            return
        with _lock:
            n = _get_note(note_id)
            if n is not None and blk is not None and not (n.get("snapshot") or {}).get("forecast"):
                n["snapshot"]["forecast"] = util.clean({**blk, "delayed_s": int(time.time()) - n["created_at"]})
                n["snapshot"]["missing"] = [m for m in n["snapshot"].get("missing", []) if m != "forecast"]
                _save_notes()
    threading.Thread(target=run, daemon=True, name=f"journal-fc-{note_id}").start()


# ------------------------------------------------------------------ note

def _clean_tags(tags) -> list[str]:
    if not tags:
        return []
    if isinstance(tags, str):
        tags = tags.split(",")
    out = []
    for t in tags:
        t = str(t).strip().lstrip("#").lower()[:24]
        if t and t not in out:
            out.append(t)
    return out[:12]


def _validate_note(body: dict, old: dict | None = None) -> dict:
    title = str(body.get("title") or "").strip()
    if len(title) > 120:
        raise JournalError("title: massimo 120 caratteri")
    text = str(body.get("body") or "").strip()
    if not text and not title:
        raise JournalError("body: scrivi almeno un titolo o un testo")
    if len(text) > 20000:
        raise JournalError("body: massimo 20000 caratteri")
    direction = body.get("direction") or None
    horizon = body.get("horizon") or None
    if direction is not None and direction not in DIRECTIONS:
        raise JournalError("direction: valore non valido")
    if horizon is not None:
        try:
            horizon = int(horizon)
        except (TypeError, ValueError):
            raise JournalError("horizon: valore non valido") from None
        if horizon not in HORIZONS:
            raise JournalError("horizon: 7, 30 o 90 giorni")
    if (direction is None) != (horizon is None):
        raise JournalError("direction: vista e orizzonte vanno indicati insieme")
    out = {"title": title, "body": text, "tags": _clean_tags(body.get("tags"))}
    if old is not None:
        locked = time.time() - old["created_at"] > EDIT_VIEW_WINDOW or old.get("review")
        if locked and (direction != old.get("direction") or horizon != old.get("horizon")):
            raise JournalError("direction: la vista non è più modificabile (bloccata 15 minuti dopo la creazione)")
    out["direction"], out["horizon"] = direction, horizon
    return out


def _get_note(nid: str) -> dict | None:
    return next((n for n in _notes_all() if n["id"] == nid), None)


def note_public(n: dict) -> dict:
    due = n["created_at"] + n["horizon"] * 86400 if n.get("horizon") else None
    rv = n.get("review")
    outcome = None if not n.get("direction") else ("pending" if not rv else ("hit" if rv.get("hit") else "miss"))
    return util.clean({**n, "due_at": due, "outcome": outcome,
                       "view_editable": not rv and time.time() - n["created_at"] <= EDIT_VIEW_WINDOW})


def list_notes(tag: str | None = None, outcome: str | None = None, q: str | None = None) -> dict:
    review_due()
    items = [note_public(n) for n in sorted(_notes_all(), key=lambda n: -n["created_at"])]
    tags: dict[str, int] = {}
    for n in items:
        for t in n.get("tags") or []:
            tags[t] = tags.get(t, 0) + 1
    if tag:
        items = [n for n in items if tag in (n.get("tags") or [])]
    if outcome:
        items = [n for n in items if (n["outcome"] or "none") == outcome]
    if q:
        s = q.lower()
        items = [n for n in items if s in (n.get("title") or "").lower() or s in (n.get("body") or "").lower()]
    return {"items": items, "tags": [{"tag": k, "count": v} for k, v in sorted(tags.items(), key=lambda x: (-x[1], x[0]))],
            "total": len(_notes_all())}


def create_note(body: dict, created_at: int | None = None) -> dict:
    data = _validate_note(body)
    snap = snapshot()
    now = int(created_at or time.time())
    n = {"id": uuid.uuid4().hex[:12], "created_at": now, "updated_at": now, **data, "price": snap.get("price"), "snapshot": snap, "review": None}
    with _lock:
        _notes_all().append(n)
        _save_notes()
    if not snap.get("forecast"):
        _fill_forecast_later(n["id"])
    return note_public(n)


def update_note(nid: str, body: dict) -> dict | None:
    with _lock:
        n = _get_note(nid)
        if n is None:
            return None
        merged = {**{k: n.get(k) for k in ("title", "body", "tags", "direction", "horizon")}, **body}
        n.update(_validate_note(merged, n))
        n["updated_at"] = int(time.time())
        _save_notes()
        return note_public(n)


def delete_note(nid: str) -> bool:
    with _lock:
        notes = _notes_all()
        k = len(notes)
        notes[:] = [n for n in notes if n["id"] != nid]
        if len(notes) != k:
            _save_notes()
            return True
        return False


# ------------------------------------------------------------------ revisione

def _price_path(t0: int, t1: int) -> tuple[float | None, float | None, float | None]:
    """(prezzo alla scadenza, massimo, minimo) tra t0 e t1 dalle candele 1h Binance (+ prezzo live se t1 è nell'ora corrente)."""
    d = store.get("k_1h")
    a, b = pd.Timestamp(t0, unit="s", tz="UTC"), pd.Timestamp(t1, unit="s", tz="UTC")
    seg = d[(d["time"] >= a.floor("h")) & (d["time"] <= b)]
    if not len(seg):
        return None, None, None
    end_row = seg[seg["time"] <= b].iloc[-1]
    closed = end_row["time"] + pd.Timedelta(hours=1) <= pd.Timestamp.now(tz="UTC")
    p_end = float(end_row["close"])
    if not closed:
        from . import alerts
        lp = alerts._price()
        p_end = float(lp) if lp else p_end
    return p_end, float(seg["high"].max()), float(seg["low"].min())


def _review(n: dict) -> dict | None:
    due = n["created_at"] + n["horizon"] * 86400
    p0 = n.get("price") or (n.get("snapshot") or {}).get("price")
    if not p0:
        return None
    p1, hi, lo = _price_path(n["created_at"], due)
    if p1 is None:
        return None
    ch = (p1 / p0 - 1) * 100
    band = BAND[n["horizon"]]
    outcome = "up" if ch > band else "down" if ch < -band else "flat"
    view = n["direction"]
    hit = (view == "up" and outcome == "up") or (view == "down" and outcome == "down") or (view == "neutral" and outcome == "flat")
    fc = (n.get("snapshot") or {}).get("forecast") or {}
    tgt = next((t for t in fc.get("targets") or [] if t.get("days") == n["horizon"]), None)
    fc_check = None
    if tgt and tgt.get("median"):
        fc_check = {"median": tgt["median"], "low": tgt.get("low"), "high": tgt.get("high"), "up_prob": tgt.get("up_prob"),
                    "inside": (tgt.get("low") or 0) <= p1 <= (tgt.get("high") or 1e12), "median_error_pct": (p1 / tgt["median"] - 1) * 100}
    try:
        ctx_now = snapshot(include_forecast=False)
    except Exception as e:  # noqa: BLE001
        log.info("snapshot revisione: %s", e)
        ctx_now = None
    return util.clean({
        "due_at": due, "reviewed_at": int(time.time()), "price_start": p0, "price_end": p1, "change_pct": ch,
        "max_up_pct": (hi / p0 - 1) * 100 if hi else None, "max_down_pct": (lo / p0 - 1) * 100 if lo else None,
        "band_pct": band, "outcome": outcome, "view": view, "hit": hit, "forecast_check": fc_check, "context_now": ctx_now,
    })


_last_review_check = {"t": 0.0}


def review_due(force: bool = False) -> list[dict]:
    """Rivede le note con l'orizzonte scaduto. -> note appena riviste (per i toast). Throttle: 60 s."""
    now = time.time()
    if not force and now - _last_review_check["t"] < 60:
        return []
    _last_review_check["t"] = now
    done = []
    with _lock:
        todo = [n for n in _notes_all() if n.get("direction") and n.get("horizon") and not n.get("review")
                and n["created_at"] + n["horizon"] * 86400 <= now]
    for n in todo:
        try:
            rv = _review(n)
        except Exception as e:  # noqa: BLE001
            log.info("revisione nota %s: %s", n["id"], e)
            rv = None
        if rv is None:
            continue
        with _lock:
            cur = _get_note(n["id"])
            if cur is not None and not cur.get("review"):
                cur["review"] = rv
                done.append(cur)
    if done:
        with _lock:
            _save_notes()
    return done


def review_alerts() -> list[tuple[str, str, str, str, dict]]:
    """Per il motore avvisi: [(key, title, text, link, data)] per le note riviste e non ancora notificate
    (la revisione può avvenire anche da una richiesta API: la notifica parte comunque una volta sola)."""
    review_due()
    with _lock:
        todo = [n for n in _notes_all() if n.get("review") and not n["review"].get("notified")]
        for n in todo:
            n["review"]["notified"] = int(time.time())
        if todo:
            _save_notes()
    out = []
    for n in todo:
        rv = n["review"]
        name = n.get("title") or f"Nota del {util.data_it(n['created_at'])}"
        view = {"up": "rialzo", "down": "ribasso", "neutral": "neutrale"}[n["direction"]]
        res = "vista confermata" if rv["hit"] else "vista non confermata"
        text = (f"Vista {view} a {n['horizon']} giorni: prezzo {rv['change_pct']:+.1f}% "
                f"(${rv['price_start']:,.0f} → ${rv['price_end']:,.0f}), {res}.")
        out.append((f"journal:{n['id']}", f"Revisione: {name}"[:60], text, f"/diario?note={n['id']}",
                    {"note_id": n["id"], "hit": rv["hit"], "change": rv["change_pct"]}))
    return out


def reviews() -> dict:
    review_due()
    notes = _notes_all()
    rev = sorted([n for n in notes if n.get("review")], key=lambda n: n["review"]["due_at"])
    items = [{"note_id": n["id"], "title": n.get("title"), "tags": n.get("tags") or [], "direction": n["direction"], "horizon": n["horizon"],
              "created_at": n["created_at"], "review": {k: v for k, v in n["review"].items() if k != "context_now"}} for n in rev]
    hits = sum(1 for n in rev if n["review"]["hit"])
    by_h = []
    for h in HORIZONS:
        g = [n for n in rev if n["horizon"] == h]
        by_h.append({"horizon": h, "total": len(g), "hits": sum(1 for n in g if n["review"]["hit"]),
                     "hit_rate": (sum(1 for n in g if n["review"]["hit"]) / len(g) * 100) if g else None})
    by_d = []
    for d in DIRECTIONS:
        g = [n for n in rev if n["direction"] == d]
        by_d.append({"direction": d, "total": len(g), "hits": sum(1 for n in g if n["review"]["hit"]),
                     "hit_rate": (sum(1 for n in g if n["review"]["hit"]) / len(g) * 100) if g else None,
                     "avg_change": (sum(n["review"]["change_pct"] for n in g) / len(g)) if g else None})
    series, h_acc = [], 0
    for i, n in enumerate(rev, 1):
        h_acc += 1 if n["review"]["hit"] else 0
        series.append({"time": n["review"]["due_at"], "value": h_acc / i * 100, "hit": n["review"]["hit"]})
    now = time.time()
    upcoming = sorted([{"note_id": n["id"], "title": n.get("title"), "direction": n["direction"], "horizon": n["horizon"],
                        "created_at": n["created_at"], "due_at": n["created_at"] + n["horizon"] * 86400, "price": n.get("price")}
                       for n in notes if n.get("direction") and n.get("horizon") and not n.get("review")], key=lambda x: x["due_at"])
    for u in upcoming:
        u["overdue"] = u["due_at"] <= now
    return util.clean({"items": items[::-1], "upcoming": upcoming,
                       "stats": {"total": len(rev), "hits": hits, "hit_rate": hits / len(rev) * 100 if rev else None,
                                 "pending": len(upcoming), "by_horizon": by_h, "by_direction": by_d, "series": series},
                       "bands": BAND})


# ------------------------------------------------------------------ annotazioni del grafico

def _validate_ann(body: dict) -> dict:
    kind = body.get("kind")
    if kind not in ANN_KINDS:
        raise JournalError("kind: hline | trendline | vline | text")
    tf = body.get("tf")
    if tf not in (None, "",) + TFS:
        raise JournalError("tf: timeframe non valido")
    pts = body.get("points") or []
    need = {"hline": 1, "vline": 1, "text": 1, "trendline": 2}[kind]
    if not isinstance(pts, list) or len(pts) != need:
        raise JournalError(f"points: servono {need} punti")
    clean_pts = []
    for p in pts:
        try:
            t = int(p.get("time")) if p.get("time") is not None else None
            pr = float(p.get("price")) if p.get("price") is not None else None
        except (TypeError, ValueError, AttributeError):
            raise JournalError("points: coordinate non valide") from None
        if kind in ("trendline", "text", "vline") and t is None:
            raise JournalError("points: manca il tempo")
        if kind in ("trendline", "text", "hline") and (pr is None or pr <= 0):
            raise JournalError("points: manca il prezzo")
        clean_pts.append({"time": t, "price": pr})
    text = str(body.get("text") or "").strip()
    if kind == "text" and not text:
        raise JournalError("text: obbligatorio per una nota sul grafico")
    if len(text) > 280:
        raise JournalError("text: massimo 280 caratteri")
    color = body.get("color") or "amber"
    if color not in ANN_COLORS:
        raise JournalError("color: valore non valido")
    return {"kind": kind, "symbol": str(body.get("symbol") or "BTCUSDT").upper()[:20], "tf": tf or None, "points": clean_pts,
            "text": text, "color": color, "extend": bool(body.get("extend", False)) if kind == "trendline" else False}


def list_annotations(symbol: str = "BTCUSDT", tf: str | None = None) -> list[dict]:
    out = [a for a in _anns_all() if a["symbol"] == symbol.upper() and (tf is None or a.get("tf") in (None, tf))]
    return sorted(out, key=lambda a: a["created_at"])


def create_annotation(body: dict) -> dict:
    a = _validate_ann(body)
    now = int(time.time())
    a.update({"id": uuid.uuid4().hex[:12], "created_at": now, "updated_at": now})
    with _lock:
        _anns_all().append(a)
        _save_anns()
    return a


def update_annotation(aid: str, body: dict) -> dict | None:
    with _lock:
        a = next((x for x in _anns_all() if x["id"] == aid), None)
        if a is None:
            return None
        merged = {**{k: a.get(k) for k in ("kind", "symbol", "tf", "points", "text", "color", "extend")}, **body}
        a.update(_validate_ann(merged))
        a["updated_at"] = int(time.time())
        _save_anns()
        return a


def delete_annotation(aid: str) -> bool:
    with _lock:
        anns = _anns_all()
        k = len(anns)
        anns[:] = [a for a in anns if a["id"] != aid]
        if len(anns) != k:
            _save_anns()
            return True
        return False
