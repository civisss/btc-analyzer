"""API del team di agenti."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..agents import engine

router = APIRouter()


@router.get("/agents")
def agents():
    return engine.graph()


@router.get("/agents/messages")
def agent_messages(limit: int = Query(100, ge=1, le=600), agent: str | None = None):
    return engine.messages(limit, agent)


@router.post("/agents/{agent_id}/run")
def run_agent(agent_id: str):
    a = engine.bus.agents.get(agent_id)
    if not a:
        raise HTTPException(404, "agente sconosciuto")
    a.trigger()
    return {"ok": True}
