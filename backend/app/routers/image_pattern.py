"""POST /api/analogs/image — analoghi storici di un pattern estratto da uno screenshot (multipart, elaborato in memoria)."""
from __future__ import annotations


import json
import logging

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .. import util
from ..analysis import image_pattern as ip

router = APIRouter()
log = logging.getLogger("image_pattern")

ALLOWED = {"image/png", "image/jpeg", "image/jpg", "image/webp", "application/octet-stream", ""}


def _crop(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        c = json.loads(raw)
        if not isinstance(c, dict):
            raise ValueError
        return {k: float(c[k]) for k in ("x", "y", "w", "h")}
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(422, "Ritaglio non valido: atteso JSON {x, y, w, h} in pixel dell'immagine.") from e




@router.post("/analogs/image")
async def analogs_image(
    image: UploadFile = File(...),
    crop: str | None = Form(None),
    tfs: str | None = Form(None),
    top: int = Form(5),
    horizon: int | None = Form(None),
    theme: str = Form("auto"),
):
    if (image.content_type or "").lower() not in ALLOWED:
        raise HTTPException(415, "Formato non supportato: carica un'immagine PNG, JPG o WEBP.")
    data = await image.read(ip.MAX_BYTES + 1)
    await image.close()
    if len(data) > ip.MAX_BYTES:
        raise HTTPException(413, "Immagine troppo grande: il limite è 8 MB.")
    tf_list = [x.strip() for x in (tfs or "").split(",") if x.strip()] or None
    if tf_list and any(x not in ip.TFS for x in tf_list):
        raise HTTPException(422, f"Timeframe non valido (ammessi: {', '.join(ip.TFS)}).")
    if theme not in ("auto", "dark", "light"):
        theme = "auto"
    if not 1 <= top <= 8:
        raise HTTPException(422, "Il numero di risultati deve essere tra 1 e 8.")
    if horizon is not None and not 5 <= horizon <= 150:
        raise HTTPException(422, "L'orizzonte deve essere tra 5 e 150 candele.")
    try:
        res = await run_in_threadpool(ip.analyze, data, _crop(crop), tf_list, top, horizon, theme)
    except ip.ImageError as e:
        raise HTTPException(422, str(e)) from e
    except Exception as e:  # noqa: BLE001
        log.exception("analisi immagine fallita")
        raise HTTPException(500, f"Analisi dell'immagine non riuscita: {e}") from e
    finally:
        del data  # nessuna copia persistente dell'immagine
    out = util.clean(res)
    return JSONResponse(out)
