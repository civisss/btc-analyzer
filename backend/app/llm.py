"""Client per LLM locale (LM Studio, API compatibile OpenAI). Degrada in modo silenzioso se non disponibile.

Env:
  LLM_BASE_URL  default http://localhost:1234/v1  (in Docker: http://host.docker.internal:1234/v1)
  LLM_MODEL     opzionale; se assente sceglie automaticamente (preferendo gpt-oss-20b per velocità)
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Iterator

import httpx

log = logging.getLogger("llm")

TIMEOUT = httpx.Timeout(120.0, connect=3.0)
PREFERRED = ["gpt-oss-20b", "gpt-oss", "qwen", "llama", "mistral", "gemma"]
_THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.S | re.I)


class LLMUnavailable(RuntimeError):
    pass


def base_url() -> str:
    return os.environ.get("LLM_BASE_URL", "http://localhost:1234/v1").rstrip("/")


_state = {"t": 0.0, "models": [], "ok": False}
_state_lock = threading.Lock()


def _list_models(force: bool = False) -> list[str]:
    with _state_lock:
        if not force and time.time() - _state["t"] < 30:
            return _state["models"] if _state["ok"] else []
    try:
        r = httpx.get(f"{base_url()}/models", timeout=httpx.Timeout(3.0))
        r.raise_for_status()
        ids = [m.get("id") for m in r.json().get("data", []) if m.get("id")]
        ok = True
    except Exception as e:  # noqa: BLE001
        log.debug("LLM non raggiungibile: %s", e)
        ids, ok = [], False
    with _state_lock:
        _state.update(t=time.time(), models=ids, ok=ok)
    return ids if ok else []


def model() -> str | None:
    """Modello da usare (env LLM_MODEL se presente tra quelli caricabili, altrimenti scelta automatica)."""
    ids = _list_models()
    if not ids:
        return None
    env = os.environ.get("LLM_MODEL")
    if env:
        return env
    chat = [m for m in ids if "embed" not in m.lower()]
    if not chat:
        return None
    for pref in PREFERRED:
        for m in chat:
            if pref in m.lower():
                return m
    return chat[0]


def available() -> bool:
    return model() is not None


def status() -> dict:
    m = model()
    return {"available": m is not None, "model": m}


def strip_think(text: str) -> str:
    return _THINK_RE.sub("", text or "").strip()


def _prepare(messages: list[dict], m: str, reasoning: str) -> list[dict]:
    """Adatta i messaggi al modello per ridurre la latenza del ragionamento.
    gpt-oss: convenzione harmony 'Reasoning: low|medium|high' nel system prompt.
    qwen3: '/no_think' in coda all'ultimo messaggio utente (se reasoning == 'low')."""
    msgs = [dict(x) for x in messages]
    name = m.lower()
    if "gpt-oss" in name:
        tag = f"Reasoning: {reasoning}"
        if msgs and msgs[0].get("role") == "system":
            content = re.sub(r"^\s*Reasoning:\s*\w+\s*", "", msgs[0].get("content") or "")
            msgs[0]["content"] = f"{tag}\n{content}"
        else:
            msgs.insert(0, {"role": "system", "content": tag})
    elif "qwen3" in name and reasoning == "low":
        for x in reversed(msgs):
            if x.get("role") == "user":
                if "/no_think" not in (x.get("content") or ""):
                    x["content"] = (x.get("content") or "") + " /no_think"
                break
    return msgs


def _payload(messages: list[dict], m: str, stream: bool, **kw) -> dict:
    reasoning = str(kw.pop("reasoning", None) or kw.pop("reasoning_effort", None) or "low").lower()
    if reasoning not in ("low", "medium", "high"):
        reasoning = "low"
    p = {"model": m, "messages": _prepare(messages, m, reasoning), "stream": stream,
         "temperature": kw.pop("temperature", 0.4), "max_tokens": kw.pop("max_tokens", 2048)}
    if "gpt-oss" in m.lower():
        p["reasoning_effort"] = reasoning
    p.update(kw)
    return p


def complete(messages: list[dict], **kw) -> str:
    """Risposta completa (testo, senza blocchi di ragionamento). Solleva LLMUnavailable se l'LLM è giù."""
    m = kw.pop("model", None) or model()
    if not m:
        raise LLMUnavailable("LLM locale non disponibile")
    try:
        r = httpx.post(f"{base_url()}/chat/completions", json=_payload(messages, m, False, **kw), timeout=TIMEOUT)
        r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
    except Exception as e:  # noqa: BLE001
        _state["t"] = 0  # forza ricontrollo
        raise LLMUnavailable(str(e)) from e
    return strip_think(msg.get("content") or "")


def stream(messages: list[dict], **kw) -> Iterator[str]:
    """Generatore di delta testuali. Ignora `reasoning`/`reasoning_content` e i blocchi <think>...</think>."""
    m = kw.pop("model", None) or model()
    if not m:
        raise LLMUnavailable("LLM locale non disponibile")
    in_think = False
    buf = ""
    try:
        with httpx.stream("POST", f"{base_url()}/chat/completions", json=_payload(messages, m, True, **kw),
                          timeout=TIMEOUT) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0].get("delta") or {}
                except (ValueError, KeyError, IndexError):
                    continue
                piece = delta.get("content")
                if not piece:
                    continue
                buf += piece
                out = ""
                # gestisce <think> anche spezzati tra chunk
                while buf:
                    if in_think:
                        j = buf.lower().find("</think>")
                        if j < 0:
                            buf = buf[-8:]
                            break
                        buf = buf[j + 8:]
                        in_think = False
                    else:
                        j = buf.lower().find("<think>")
                        if j >= 0:
                            out += buf[:j]
                            buf = buf[j + 7:]
                            in_think = True
                            continue
                        k = buf.rfind("<")
                        if k >= 0 and len(buf) - k < 7 and "<think>".startswith(buf[k:].lower()):
                            out += buf[:k]
                            buf = buf[k:]
                        else:
                            out += buf
                            buf = ""
                        break
                if out:
                    yield out
            if buf and not in_think:
                yield buf
    except httpx.HTTPError as e:
        _state["t"] = 0
        raise LLMUnavailable(str(e)) from e


def extract_json(text: str):
    """Estrae il primo oggetto JSON da una risposta (tollera ```json ... ``` e testo attorno)."""
    text = strip_think(text)
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    i = text.find("{")
    while i >= 0:
        depth = 0
        for j in range(i, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[i: j + 1])
                    except ValueError:
                        break
        i = text.find("{", i + 1)
    return None
