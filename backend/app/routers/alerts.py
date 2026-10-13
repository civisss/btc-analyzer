"""GET /api/alerts — storico degli avvisi; POST /api/alerts/test — toast di prova (solo sviluppo).
Gli avvisi live arrivano sul WebSocket /api/ws come {"type": "toast", ...Alert}."""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Query, Request

from .. import alerts as al

router = APIRouter()


@router.get("/alerts")
async def alerts_route(limit: int = Query(50, ge=1, le=500), since: int | None = Query(None),
                       severity: str | None = Query(None), category: str | None = Query(None)):
    if severity is not None and severity not in al.SEVERITIES:
        raise HTTPException(400, "severity non valida (info | warning | critical)")
    al.start()  # fallback: avvia il motore se main.py non l'ha ancora fatto (idempotente)
    if category:  # filtro per categoria (es. "custom,journal" per la pagina Avvisi)
        cats = set(category.split(","))
        return {"items": [a for a in al.history(500, since, severity) if a.get("category") in cats][:limit], **al.status()}
    return {"items": al.history(limit, since, severity), **al.status()}


@router.post("/alerts/test")
async def alerts_test(request: Request, severity: str = Query("warning")):
    host = request.client.host if request.client else ""
    if os.environ.get("ALERTS_TEST") != "1" and host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Endpoint di test disponibile solo in locale (o con ALERTS_TEST=1)")
    return await al.test_alert(severity)


# ------------------------------------------------------------------ avvisi personalizzati (CONTRACT.md § CUSTOM ALERTS)
import asyncio  # noqa: E402

from fastapi import Body  # noqa: E402

from .. import alert_rules as ar  # noqa: E402


def _rule_or_404(rid: str) -> dict:
    r = ar.get(rid)
    if r is None:
        raise HTTPException(404, "regola non trovata")
    return r


@router.get("/alerts/rules")
async def rules_list():
    al.start()
    return {"items": ar.list_rules(), "types": list(ar.TYPES), "levels": list(ar.LEVEL_IDS), "metrics": ar.METRICS,
            "tick_s": al.TICK_S, "last_eval": al._meta.get("last_eval")}


@router.get("/alerts/rules/metrics")
async def rules_metrics():
    return await asyncio.to_thread(ar.metrics_snapshot)


@router.post("/alerts/rules/preview")
async def rules_preview(body: dict = Body(...)):
    """Anteprima di una regola NON salvata (editor): valore attuale vs soglia, partirebbe ora?"""
    try:
        draft = {"type": body.get("type"), "params": ar.validate_params(body.get("type"), body.get("params") or {}),
                 "enabled": True, "cooldown_min": int(body.get("cooldown_min") or 60), "state": {}}
    except ar.RuleError as e:
        raise HTTPException(400, str(e)) from e
    await asyncio.to_thread(ar._prime, draft)
    return await asyncio.to_thread(ar.preview, draft)


@router.post("/alerts/rules")
async def rules_create(body: dict = Body(...)):
    try:
        return await asyncio.to_thread(ar.create, body)
    except ar.RuleError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/alerts/rules/{rid}")
async def rules_get(rid: str):
    return ar.public(_rule_or_404(rid))


@router.put("/alerts/rules/{rid}")
async def rules_update(rid: str, body: dict = Body(...)):
    _rule_or_404(rid)
    try:
        return await asyncio.to_thread(ar.update, rid, body)
    except ar.RuleError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/alerts/rules/{rid}")
async def rules_delete(rid: str):
    if not ar.delete(rid):
        raise HTTPException(404, "regola non trovata")
    return {"ok": True}


@router.post("/alerts/rules/{rid}/test")
async def rules_test(rid: str):
    r = _rule_or_404(rid)
    return await asyncio.to_thread(ar.preview, r)
