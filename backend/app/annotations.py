"""Annotazioni del grafico (linee, trendline e note in /grafici).

Persistenza: journal_annotations.json nella cartella dei dati utente (scrittura atomica). Il nome del file resta quello storico,
così le annotazioni già salvate continuano a essere lette senza migrazione.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

from .alert_rules import USER_DIR

log = logging.getLogger("annotations")

ANN_FILE = USER_DIR / "journal_annotations.json"
ANN_KINDS = ("hline", "trendline", "vline", "text")
ANN_COLORS = ("slate", "blue", "violet", "teal", "amber", "btc")
TFS = ("15m", "1h", "4h", "1d", "1w")
_lock = threading.RLock()
_anns: list[dict] | None = None


class AnnotationError(ValueError):
    pass


def _anns_all() -> list[dict]:
    global _anns
    with _lock:
        if _anns is None:
            try:
                v = json.loads(ANN_FILE.read_text(encoding="utf-8")) if ANN_FILE.exists() else []
                _anns = v if isinstance(v, list) else []
            except Exception as e:  # noqa: BLE001
                log.warning("%s illeggibile: %s", ANN_FILE.name, e)
                _anns = []
        return _anns


def _save_anns() -> None:
    with _lock:
        tmp = ANN_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_anns or [], ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, ANN_FILE)


def _validate_ann(body: dict) -> dict:
    kind = body.get("kind")
    if kind not in ANN_KINDS:
        raise AnnotationError("kind: hline | trendline | vline | text")
    tf = body.get("tf")
    if tf not in (None, "",) + TFS:
        raise AnnotationError("tf: timeframe non valido")
    pts = body.get("points") or []
    need = {"hline": 1, "vline": 1, "text": 1, "trendline": 2}[kind]
    if not isinstance(pts, list) or len(pts) != need:
        raise AnnotationError(f"points: servono {need} punti")
    clean_pts = []
    for p in pts:
        try:
            t = int(p.get("time")) if p.get("time") is not None else None
            pr = float(p.get("price")) if p.get("price") is not None else None
        except (TypeError, ValueError, AttributeError):
            raise AnnotationError("points: coordinate non valide") from None
        if kind in ("trendline", "text", "vline") and t is None:
            raise AnnotationError("points: manca il tempo")
        if kind in ("trendline", "text", "hline") and (pr is None or pr <= 0):
            raise AnnotationError("points: manca il prezzo")
        clean_pts.append({"time": t, "price": pr})
    text = str(body.get("text") or "").strip()
    if kind == "text" and not text:
        raise AnnotationError("text: obbligatorio per una nota sul grafico")
    if len(text) > 280:
        raise AnnotationError("text: massimo 280 caratteri")
    color = body.get("color") or "amber"
    if color not in ANN_COLORS:
        raise AnnotationError("color: valore non valido")
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
