"""Annotazioni del grafico. Il testo è scritto dall'utente: il frontend le richiede senza ?lang=en, così il traduttore non lo tocca."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Query

from .. import annotations as an

router = APIRouter()


@router.get("/annotations")
async def ann_list(symbol: str = Query("BTCUSDT"), tf: str | None = Query(None)):
    return {"items": an.list_annotations(symbol, tf)}


@router.post("/annotations")
async def ann_create(body: dict = Body(...)):
    try:
        return an.create_annotation(body)
    except an.AnnotationError as e:
        raise HTTPException(400, str(e)) from e


@router.put("/annotations/{aid}")
async def ann_update(aid: str, body: dict = Body(...)):
    try:
        a = an.update_annotation(aid, body)
    except an.AnnotationError as e:
        raise HTTPException(400, str(e)) from e
    if a is None:
        raise HTTPException(404, "annotazione non trovata")
    return a


@router.delete("/annotations/{aid}")
async def ann_delete(aid: str):
    if not an.delete_annotation(aid):
        raise HTTPException(404, "annotazione non trovata")
    return {"ok": True}
