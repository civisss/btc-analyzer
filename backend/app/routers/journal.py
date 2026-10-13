"""Diario di studio (CONTRACT.md § JOURNAL): note con snapshot del contesto, revisioni automatiche, annotazioni del grafico.
I campi scritti dall'utente (titolo, testo, tag, testo delle annotazioni) non sono generati: il frontend li richiede senza
?lang=en, così il traduttore automatico non li tocca; tutto il resto è fatto di codici e numeri."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Body, HTTPException, Query

from .. import journal as jr

router = APIRouter()


def _err(e: Exception):
    raise HTTPException(400, str(e)) from e


@router.get("/journal/notes")
async def notes_list(tag: str | None = Query(None), outcome: str | None = Query(None, pattern="^(hit|miss|pending|none)$"),
                     q: str | None = Query(None, max_length=100)):
    return await asyncio.to_thread(jr.list_notes, tag, outcome, q)


@router.get("/journal/snapshot")
async def notes_snapshot():
    """Anteprima dello snapshot che verrebbe salvato con una nuova nota."""
    return await asyncio.to_thread(jr.snapshot)


@router.post("/journal/notes")
async def notes_create(body: dict = Body(...)):
    try:
        return await asyncio.to_thread(jr.create_note, body)
    except jr.JournalError as e:
        _err(e)


@router.get("/journal/notes/{nid}")
async def notes_get(nid: str):
    n = jr._get_note(nid)
    if n is None:
        raise HTTPException(404, "nota non trovata")
    return jr.note_public(n)


@router.put("/journal/notes/{nid}")
async def notes_update(nid: str, body: dict = Body(...)):
    try:
        n = await asyncio.to_thread(jr.update_note, nid, body)
    except jr.JournalError as e:
        _err(e)
    if n is None:
        raise HTTPException(404, "nota non trovata")
    return n


@router.delete("/journal/notes/{nid}")
async def notes_delete(nid: str):
    if not jr.delete_note(nid):
        raise HTTPException(404, "nota non trovata")
    return {"ok": True}


@router.get("/journal/reviews")
async def reviews():
    return await asyncio.to_thread(jr.reviews)


@router.get("/journal/annotations")
async def ann_list(symbol: str = Query("BTCUSDT"), tf: str | None = Query(None)):
    return {"items": jr.list_annotations(symbol, tf)}


@router.post("/journal/annotations")
async def ann_create(body: dict = Body(...)):
    try:
        return jr.create_annotation(body)
    except jr.JournalError as e:
        _err(e)


@router.put("/journal/annotations/{aid}")
async def ann_update(aid: str, body: dict = Body(...)):
    try:
        a = jr.update_annotation(aid, body)
    except jr.JournalError as e:
        _err(e)
    if a is None:
        raise HTTPException(404, "annotazione non trovata")
    return a


@router.delete("/journal/annotations/{aid}")
async def ann_delete(aid: str):
    if not jr.delete_annotation(aid):
        raise HTTPException(404, "annotazione non trovata")
    return {"ok": True}
