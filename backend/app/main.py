"""Entry point FastAPI: monta automaticamente i router in app/routers e serve il frontend buildato."""
from __future__ import annotations

import importlib
import logging
import pkgutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import routers
from .data import store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("main")


def _refresher():
    """Mantiene i dataset aggiornati in background (ogni get rispetta il proprio TTL)."""
    while True:
        store.refresh_all()
        time.sleep(30)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=_refresher, daemon=True, name="refresher").start()
    try:  # collector liquidazioni live (opzionale)
        from . import live
        live.start()
    except Exception as e:  # noqa: BLE001
        log.warning("live collector non avviato: %s", e)
    from .routers.stream import hub
    hub.ensure_started()  # stream Binance attivi da subito (prezzo live anche senza client)
    from .agents import engine
    await engine.start()
    from . import alerts, tracking
    alerts.start()     # regole degli avvisi ogni 20 s -> toast via WebSocket
    tracking.start()   # backfill una tantum + snapshot/risoluzione previsioni ogni 30 min
    from . import i18n
    i18n._ensure_worker()  # traduttore EN: 2 worker + pre-riscaldamento dei testi principali
    yield


app = FastAPI(title="Bitcoin Analyzer", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def i18n_middleware(request, call_next):
    """Con ?lang=en (o header X-Lang: en) traduce i testi delle risposte JSON delle API (cache + traduzione in background)."""
    lang = (request.query_params.get("lang") or request.headers.get("x-lang") or "it").lower()
    response = await call_next(request)
    if lang != "en" or not request.url.path.startswith("/api/") or "application/json" not in response.headers.get("content-type", ""):
        return response
    import json as _json
    from fastapi.responses import Response
    from . import i18n
    body = b"".join([chunk async for chunk in response.body_iterator])
    try:
        data = i18n.translate_obj(_json.loads(body))
        body = _json.dumps(data, ensure_ascii=False).encode("utf-8")
    except Exception as e:  # noqa: BLE001
        log.warning("traduzione risposta fallita: %s", e)
    headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
    return Response(content=body, status_code=response.status_code, headers=headers, media_type="application/json")

for mod in pkgutil.iter_modules(routers.__path__):
    m = importlib.import_module(f"{routers.__name__}.{mod.name}")
    if hasattr(m, "router"):
        app.include_router(m.router, prefix="/api", tags=[mod.name])
        log.info("router montato: %s", mod.name)

# compressione gzip (aggiunta per ultima = più esterna: comprime anche le risposte già tradotte)
from fastapi.middleware.gzip import GZipMiddleware  # noqa: E402
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
