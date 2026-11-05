"""GET /api/status — stato dei dataset, dell'LLM locale e degli stream live."""
from __future__ import annotations

import pandas as pd
from fastapi import APIRouter

from .. import llm
from ..data import store
from ..util import num, ts

router = APIRouter()


def _dataset(name: str) -> dict:
    rows, last = 0, None
    try:
        df = store._mem.get(name)  # noqa: SLF001 — non blocca su refresh di rete
        if df is None:
            p = store._path(name)  # noqa: SLF001
            if p.exists():
                df = pd.read_parquet(p, columns=["time"])
        if df is not None and len(df):
            rows = int(len(df))
            last = ts(pd.to_datetime(df["time"], utc=True).max())
    except Exception:  # noqa: BLE001
        pass
    age = store.age(name)
    if age is None:
        p = store._path(name)  # noqa: SLF001
        if p.exists():
            import time

            age = time.time() - p.stat().st_mtime
    return {"name": name, "rows": rows, "last": last, "age_s": num(round(age, 1)) if age is not None else None}


def _stream() -> dict:
    try:
        from .stream import hub  # noqa: PLC0415

        return {"clients": len(hub.clients), "connected": dict(hub.connected),
                "last_price": (hub.last.get("ticker") or {}).get("price")}
    except Exception:  # noqa: BLE001
        return {"clients": 0, "connected": {}, "last_price": None}


@router.get("/status")
def status():
    try:
        from .. import live  # noqa: PLC0415

        liq = bool(live.is_connected())
        liq_multi = (live.stats().get("multi") or {}).get("exchanges")
    except Exception:  # noqa: BLE001
        liq = False
        liq_multi = None
    from ..agents import engine  # noqa: PLC0415

    return {
        "datasets": [_dataset(n) for n in store.REGISTRY],
        "agents": engine.status(),
        "llm": llm.status(),
        "liquidation_stream": liq,
        "liquidation_streams": liq_multi,
        "stream": _stream(),
    }
