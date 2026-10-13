"""GET /api/derivatives — funding, open interest, long/short, basis, segnali (Binance BTCUSDT, invariato).
GET /api/derivatives/basis      — basis annualizzato e struttura a termine (Deribit + Binance trimestrali, storico dal 2020)
GET /api/derivatives/cme        — posizionamento CME (CFTC COT, Traders in Financial Futures) dal 2018
GET /api/derivatives/aggregate  — leva aggregata Binance + Bybit + OKX (OI, funding, long/short, storico)
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..analysis import aggregate, basis, cme
from ..analysis import derivatives as an

router = APIRouter()


def build(**_params) -> dict:
    return an.build_cached()


def build_basis(**_params) -> dict:
    return basis.build()


def build_cme(**_params) -> dict:
    return cme.build()


def build_aggregate(**_params) -> dict:
    return aggregate.build()


@router.get("/derivatives")
def get_derivatives():
    try:
        return build()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"derivati non disponibili: {e}") from e


@router.get("/derivatives/basis")
def get_basis():
    try:
        return build_basis()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"basis non disponibile: {e}") from e


@router.get("/derivatives/cme")
def get_cme():
    try:
        return build_cme()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"posizionamento CME non disponibile: {e}") from e


@router.get("/derivatives/aggregate")
def get_aggregate():
    try:
        return build_aggregate()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"leva aggregata non disponibile: {e}") from e
