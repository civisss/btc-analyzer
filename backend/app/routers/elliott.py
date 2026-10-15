"""Router ONDE DI ELLIOTT: /elliott (conteggio), /elliott/backtest (verifica walk-forward), /elliott/at (conteggio storico).

Motore: app/analysis/elliott.py (vedi CONTRACT.md § ELLIOTT). Regole = vincoli rigidi, linee guida = punteggio dichiarato,
probabilità per rango dal backtest point-in-time. La risposta contiene solo chiavi e numeri: i testi li compone il frontend.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from .. import util
from ..analysis import elliott as el

router = APIRouter()


def build(tf: str = "1d", degree: str | None = None, **_params) -> dict:
    """tf 4h|1d|1w · degree tra quelli del timeframe (default: 4h minor, 1d intermediate, 1w primary)."""
    return el.compute(tf=tf, degree=degree)


@util.ttl_cache(300)
def build_backtest(mode: str = "default", **_params) -> dict:
    return util.clean(el.backtest_all(mode))


def build_overview(**_params) -> dict:
    """Conteggio preferito per timeframe al grado predefinito (per l'agente e gli avvisi)."""
    out = {}
    for tf in el.TFS:
        try:
            out[tf] = el.compute(tf=tf)
        except Exception as e:  # noqa: BLE001
            out[tf] = {"error": str(e)[:200]}
    return out


@router.get("/elliott")
def get_elliott(tf: str = Query("1d"), degree: str | None = Query(None)):
    try:
        return JSONResponse(build(tf=tf, degree=degree))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"conteggio di Elliott non disponibile: {e}") from e


@router.get("/elliott/backtest")
def get_elliott_backtest(mode: str = Query("default", pattern="^(default|all)$")):
    try:
        return JSONResponse(build_backtest(mode=mode))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"backtest di Elliott non disponibile: {e}") from e


@router.get("/elliott/at")
def get_elliott_at(tf: str = Query("1d"), degree: str | None = Query(None), t: int = Query(..., ge=1_300_000_000)):
    try:
        if tf not in el.TFS:
            raise ValueError(f"tf non valido: {tf}")
        g = degree or el.DEFAULT_DEGREE[tf]
        if g not in dict(el.TF_DEGREES[tf]):
            raise ValueError(f"grado non valido per {tf}: {g}")
        return JSONResponse(_at(tf, g, int(t)))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"conteggio storico non disponibile: {e}") from e


@util.ttl_cache(600)
def _at(tf: str, degree: str, t: int) -> dict:
    return el.at_time(tf, degree, t)
