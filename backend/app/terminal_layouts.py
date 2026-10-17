"""Layout del Terminale salvati dall'utente (USER_DATA_DIR o backend/data), come i layout del Superchart.

File: terminal_layouts.json, scrittura atomica con store.write_text. Uno stato contiene solo codici e numeri:
{tf, tiles: [{id, w, h, hidden}], panes: [id...], opts: {heat, est, bubbles, vol}}
(w = colonne su 12, h = righe da 80 px; ordine dei riquadri = ordine della lista).
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid

from .alert_rules import USER_DIR
from .data import store

log = logging.getLogger("terminal_layouts")

FILE = USER_DIR / "terminal_layouts.json"
MAX_LAYOUTS = 50
TILES = ("dom", "chart", "feed", "flow", "panes", "liqs", "integrity")
PANES = ("cvd_spot", "cvd_perp", "cvd_all", "oi", "funding", "premium")
TFS = ("1m", "5m", "15m", "1h")
OPTS = ("heat", "est", "bubbles", "vol")
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
    tf = st.get("tf", "5m")
    if tf not in TFS:
        raise LayoutError(f"timeframe non valido: {tf}")
    tiles = st.get("tiles")
    if not isinstance(tiles, list) or not tiles or len(tiles) > len(TILES):
        raise LayoutError("elenco dei riquadri non valido")
    out, seen = [], set()
    for x in tiles:
        if not isinstance(x, dict) or x.get("id") not in TILES or x["id"] in seen:
            raise LayoutError(f"riquadro non valido: {x.get('id') if isinstance(x, dict) else x}")
        seen.add(x["id"])
        out.append({"id": x["id"], "w": max(3, min(12, int(x.get("w") or 12))), "h": max(2, min(12, int(x.get("h") or 4))),
                    "hidden": bool(x.get("hidden"))})
    for tid in TILES:            # riquadri mancanti (versioni precedenti): in coda, nascosti
        if tid not in seen:
            out.append({"id": tid, "w": 12, "h": 4, "hidden": True})
    panes = [p for p in (st.get("panes") or []) if p in PANES]
    panes = list(dict.fromkeys(panes))
    opts = st.get("opts") if isinstance(st.get("opts"), dict) else {}
    return {"tf": tf, "tiles": out, "panes": panes, "opts": {k: bool(opts.get(k, True)) for k in OPTS}}


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
