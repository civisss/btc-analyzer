"""Segnali BTC seguiti sulla carta (CONTRACT.md § SIGNALS). Nessuna esecuzione, nessuna chiave exchange.

  GET /api/signals               segnali aperti, stato del sistema e integrità del registro
  GET /api/signals/history       storico completo con filtri
  GET /api/signals/performance   track record live in R, costi inclusi
  GET /api/signals/backtest      risultati fuori campione, holdout, verdetti
  GET /api/signals/{id}          un segnale con eventi e candele
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import signals as sg

router = APIRouter()


@router.get("/signals")
def get_signals():
    return sg.overview()


@router.get("/signals/history")
def get_history(limit: int = Query(500, ge=1, le=5000), setup: str | None = None, outcome: str | None = None, tf: str | None = None,
                side: str | None = None, tier: str | None = None):
    return sg.history(limit, setup, outcome, tf, side, tier)


@router.get("/signals/performance")
def get_performance():
    return sg.performance()


@router.get("/signals/backtest")
def get_backtest():
    return sg.backtest()


@router.get("/signals/{sig_id}")
def get_signal(sig_id: str):
    d = sg.detail(sig_id)
    if d is None:
        raise HTTPException(404, "segnale non trovato")
    return d
