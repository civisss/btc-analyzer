"""Layout del Superchart salvati dall'utente (stessa cartella dei dati utente: USER_DATA_DIR o backend/data).

File: superchart_layouts.json, scrittura atomica con store.write_text. Uno stato contiene solo codici e numeri:
{tf, log, panes: [{id, h, an, ov}]} (id = indicatore del catalogo, h = altezza px, an = anomalie, ov = sovrapposto al prezzo).
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid

from .alert_rules import USER_DIR
from .analysis.superchart import IND, TF_S
from .data import store

log = logging.getLogger("superchart_layouts")

FILE = USER_DIR / "superchart_layouts.json"
MAX_LAYOUTS = 50
MAX_PANES = 12
_lock = threading.RLock()
_items: list[dict] | None = None


class LayoutError(ValueError):
    pass


def _all() -> list[dict]:
    global _items
    with _lock:
        if _items is None:
            try:
                v = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else []
                _items = v if isinstance(v, list) else []
            except Exception as e:  # noqa: BLE001
                log.warning("%s illeggibile: %s", FILE.name, e)
                _items = []
        return _items


def _save() -> None:
    with _lock:
        store.write_text(FILE, json.dumps(_items or [], ensure_ascii=False, indent=1))


def clean_state(st) -> dict:
    if not isinstance(st, dict):
        raise LayoutError("stato non valido")
    tf = st.get("tf")
    if tf not in TF_S:
        raise LayoutError(f"timeframe non valido: {tf}")
    panes = st.get("panes")
    if not isinstance(panes, list) or len(panes) > MAX_PANES:
        raise LayoutError(f"servono al massimo {MAX_PANES} pannelli")
    out, seen = [], set()
    for p in panes:
        if not isinstance(p, dict) or p.get("id") not in IND or p["id"] in seen:
            raise LayoutError(f"indicatore non valido: {p.get('id') if isinstance(p, dict) else p}")
        seen.add(p["id"])
        h = int(p.get("h") or 0)
        ov = bool(p.get("ov")) or IND[p["id"]].place == "overlay"
        out.append({"id": p["id"], "h": 0 if ov else max(60, min(600, h or 110)), "an": bool(p.get("an")), "ov": ov})
    return {"tf": tf, "log": bool(st.get("log")), "panes": out}


def _name(n) -> str:
    n = " ".join(str(n or "").split())
    if not 1 <= len(n) <= 60:
        raise LayoutError("il nome deve avere da 1 a 60 caratteri")
    return n


def list_layouts() -> list[dict]:
    with _lock:
        return sorted((dict(x) for x in _all()), key=lambda x: -x.get("updated_at", 0))


def create(name, state) -> dict:
    with _lock:
        items = _all()
        if len(items) >= MAX_LAYOUTS:
            raise LayoutError(f"al massimo {MAX_LAYOUTS} layout salvati")
        now = int(time.time())
        it = {"id": uuid.uuid4().hex[:12], "name": _name(name), "state": clean_state(state), "created_at": now, "updated_at": now}
        items.append(it)
        _save()
        return dict(it)


def update(lid: str, name=None, state=None) -> dict:
    with _lock:
        for it in _all():
            if it["id"] == lid:
                if name is not None:
                    it["name"] = _name(name)
                if state is not None:
                    it["state"] = clean_state(state)
                it["updated_at"] = int(time.time())
                _save()
                return dict(it)
    raise KeyError(lid)


def delete(lid: str) -> None:
    global _items
    with _lock:
        items = _all()
        keep = [x for x in items if x["id"] != lid]
        if len(keep) == len(items):
            raise KeyError(lid)
        _items = keep
        _save()
