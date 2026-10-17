"""Traduzione IT -> EN dei testi generati dal backend (analisi, note, messaggi degli agenti).

- I numeri vengono sostituiti da segnaposto (⟦0⟧, ⟦1⟧…) prima della traduzione: lo stesso "modello" di frase
  si riusa anche quando i valori cambiano, e i numeri restano sempre esatti.
- Traduce l'LLM locale (LM Studio) in batch; le traduzioni sono salvate su disco (cache permanente).
- Mai bloccante: se una frase non è ancora tradotta si restituisce l'italiano e la si traduce in background.
"""
from __future__ import annotations

import json
import os
import logging
import re
import threading
import time
from pathlib import Path

log = logging.getLogger("i18n")

# stessa cartella dati dello store (BTC_DATA_DIR per le istanze di test), così i test non scrivono nella cache reale
CACHE_FILE = Path(os.environ.get("BTC_DATA_DIR") or (Path(__file__).resolve().parents[1] / "data")) / "i18n_en.json"
_NUM = re.compile(r"[−+\-]?\$?\d[\d,.]*(?:[KMBT%×]|\s?pt)?")
_LETTERS = re.compile(r"[A-Za-zÀ-ÿ]{2,}")
# stringhe da non tradurre: chiavi/codici, date ISO, url, tono, unità
_SKIP = re.compile(r"^(?:[a-z0-9_.\-/]+|\d{4}-\d{2}-\d{2}.*|https?://\S+|bullish|bearish|neutral)$")

_cache: dict[str, str] = {}
_pending: set[str] = set()
_failed: dict[str, int] = {}  # frasi che l'LLM non ha tradotto correttamente (dopo 2 tentativi restano in italiano)
_lock = threading.Lock()
_worker_started = False


def _load() -> None:
    global _cache
    try:
        if CACHE_FILE.exists():
            _cache = {k: _norm_ph(v) for k, v in json.loads(CACHE_FILE.read_text(encoding="utf-8")).items()}
    except Exception as e:  # noqa: BLE001
        log.warning("cache i18n illeggibile: %s", e)


def _save() -> None:
    try:
        from .data import store  # import pigro: i18n è caricato prima dello store
        store.write_text(CACHE_FILE, json.dumps(_cache, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        log.warning("salvataggio cache i18n fallito: %s", e)


def _template(s: str) -> tuple[str, list[str]]:
    nums: list[str] = []

    def rep(m):
        nums.append(m.group(0))
        return f"⟦{len(nums) - 1}⟧"

    return _NUM.sub(rep, s), nums


_PH_FIX = str.maketrans({"⟾": "⟧", "〛": "⟧", "〚": "⟦", "⟫": "⟧", "⟪": "⟦"})


def _norm_ph(s: str) -> str:
    """L'LLM a volte sostituisce le parentesi dei segnaposto con caratteri simili (es. ⟾ invece di ⟧)."""
    if not isinstance(s, str):
        return s
    s = s.translate(_PH_FIX)
    # qualunque carattere di chiusura "simile" dopo il numero del segnaposto torna a essere ⟧
    return re.sub(r"[⟦〚⟪]\s*(\d+)\s*(?!⟧)[^\w\s]", lambda m: f"⟦{m.group(1)}⟧", s)


def _fill(t: str, nums: list[str]) -> str | None:
    out = _norm_ph(t)
    for i, n in enumerate(nums):
        tok = f"⟦{i}⟧"
        if tok not in out:
            return None
        out = out.replace(tok, n, 1)
    return None if "⟦" in out else out


def translatable(s: str) -> bool:
    s2 = s.strip()
    return bool(s2) and len(s2) <= 3000 and not _SKIP.match(s2) and bool(_LETTERS.search(s2))


_MONTHS = {"gen": "Jan", "feb": "Feb", "mar": "Mar", "apr": "Apr", "mag": "May", "giu": "Jun", "lug": "Jul",
           "ago": "Aug", "set": "Sep", "ott": "Oct", "nov": "Nov", "dic": "Dec"}
_MONTHS_LONG = {"gennaio": "January", "febbraio": "February", "marzo": "March", "aprile": "April", "maggio": "May",
                "giugno": "June", "luglio": "July", "agosto": "August", "settembre": "September", "ottobre": "October",
                "novembre": "November", "dicembre": "December"}
_MONTH_ALT = "|".join(list(_MONTHS_LONG) + list(_MONTHS))
# "29 apr", "12 ott 2026", "8–18 ottobre", "giu–ago 2023 (1G)", "Mag 2019 (4h)", "14 ott – 2 nov"
_DATE_ONLY = re.compile(
    r"^(\d{1,2}[–-]?\d{0,2}\s+)?(%s)(\s+\d{4})?(\s*[–-]\s*(\d{1,2}\s+)?(%s)(\s+\d{4})?)?(\s+\((1h|4h|1G|1S|1M)\))?$"
    % (_MONTH_ALT, _MONTH_ALT), re.IGNORECASE)
_SHORT_UNIT = re.compile(r"^([−+\-]?\d[\d.,]*)\s?(g|gg|giorni)$")


def _deterministic(s: str) -> str | None:
    """Date e unità brevi tradotte senza LLM ("29 apr" -> "29 Apr", "7g" -> "7d")."""
    t = s.strip()
    m = _SHORT_UNIT.match(t)
    if m:
        return f"{m.group(1)}d" if m.group(2) != "giorni" else f"{m.group(1)} days"
    if _DATE_ONLY.match(t):
        return _en_units(re.sub(r"[a-zA-Z]+", lambda w: _MONTHS.get(w.group(0).lower(), _MONTHS_LONG.get(w.group(0).lower(), w.group(0))), t))
    return None


def _en_units(s: str) -> str:
    # unità italiane rimaste nella traduzione: 7g / 30g / 410 g -> 7d / 30d / 410 d
    s = re.sub(r"(\d)\s?g\b", lambda m: m.group(0)[:-1] + "d", s)
    return re.sub(r"\b1G\b", "1D", re.sub(r"\b1S\b", "1W", s))


def tr(s: str) -> str:
    """Traduzione dalla cache (immediata); se manca, accoda la frase e restituisce l'originale."""
    det = _deterministic(s)
    if det is not None:
        return det
    if not translatable(s):
        return s
    tpl, nums = _template(s)
    hit = _cache.get(tpl)
    if hit is not None:
        out = _fill(hit, nums)
        return _en_units(out) if out is not None else s
    if _failed.get(tpl, 0) < 4:
        with _lock:
            _pending.add(tpl)
        _ensure_worker()
    return s


def translate_obj(obj, _key: str | None = None):
    if isinstance(obj, dict):
        return {k: (v if k in NO_TRANSLATE_KEYS else translate_obj(v, k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [translate_obj(v, _key) for v in obj]
    if isinstance(obj, str):
        return tr(obj)
    return obj


# campi che contengono identificativi o valori tecnici da non tradurre
NO_TRANSLATE_KEYS = {
    "id", "key", "type", "kind", "tone", "topic", "from", "to", "source", "phase", "zone", "category",
    "severity", "link", "icon", "color", "tf", "range", "symbol", "side", "bias", "expected", "regime", "state",
    "family", "keys", "subscribes", "publishes", "model", "dominant",
}


WORKERS = 2            # richieste parallele a LM Studio
BATCH_CHARS = 2400     # dimensione massima di un lotto (caratteri), per restare sotto il timeout
_inflight: set[str] = set()
_SIZE = {"chars": BATCH_CHARS}  # dimensione adattiva del lotto


def _ensure_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    for i in range(WORKERS):
        threading.Thread(target=_worker, daemon=True, name=f"i18n-{i}").start()
    threading.Thread(target=_prewarm_loop, daemon=True, name="i18n-prewarm").start()


def _take_batch() -> list[str]:
    """Preleva un lotto dalla coda: prima le frasi brevi (etichette, stati), fino a BATCH_CHARS caratteri."""
    with _lock:
        cands = sorted((t for t in _pending if t not in _inflight), key=len)
        retry = [t for t in cands if _failed.get(t, 0) >= 1]
        if retry:  # una frase già fallita viene ritentata da sola, così non fa fallire il resto del lotto
            _inflight.add(retry[0])
            return [retry[0]]
        batch, size = [], 0
        for t in cands:
            if batch and (size + len(t) > _SIZE["chars"] or len(batch) >= 60):
                break
            batch.append(t)
            size += len(t)
        _inflight.update(batch)
    return batch


PREWARM = [  # builder principali: i loro testi vengono messi in coda di traduzione in anticipo
    ("cycles", "build", {}), ("onchain", "build", {}), ("market", "build_levels", {"tf": "1d"}),
    ("market", "build_indicators", {"tf": "1d", "limit": 300}), ("derivatives", "build", {}), ("flows", "build", {}),
    ("liquidations", "build", {}), ("fractals", "build", {}), ("analogs", "build", {}), ("usdt", "build", {}),
    ("usdt_analogs", "build", {}), ("usdt_analogs", "build_stablecoins", {}), ("timepivots", "build", {}),
    ("macro", "build", {}), ("cycle_advanced", "build", {}), ("forecast", "get_forecast", {"horizon": 90}),
    ("structure", "build", {}), ("events", "build", {}), ("tracking", "build", {}), ("positioning", "build", {}),
]


def _prewarm_loop() -> None:
    import importlib
    time.sleep(90)
    while True:
        for mod, fn, kw in PREWARM:
            try:
                out = getattr(importlib.import_module(f"app.routers.{mod}"), fn)(**kw)
                translate_obj(out)  # mette in coda le frasi non ancora tradotte
            except Exception as e:  # noqa: BLE001
                log.debug("prewarm %s.%s: %s", mod, fn, e)
        time.sleep(1800)


PROMPT = (
    "Translate each Italian string of the JSON array into natural, concise financial English (Bitcoin market analysis app). "
    "Keep every placeholder like ⟦0⟧ exactly as is and in a sensible position. Keep tickers, units and symbols ($, %, K, M, B, ×, pt). "
    "Use: rialzista=bullish, ribassista=bearish, minimo=low/bottom, massimo=high/top, ciclo=cycle, accumulo=accumulation, "
    "'X anni su Y' = 'X years out of Y', 'X analoghi su Y' = 'X of Y analogs'. "
    "Return ONLY a JSON array of strings with the same length and order."
)


def _worker() -> None:
    from . import llm
    while True:
        time.sleep(1)
        batch = _take_batch()
        if not batch:
            time.sleep(2)
            continue
        try:
            if not llm.available():
                time.sleep(30)
                continue
            out = llm.complete([{"role": "system", "content": PROMPT},
                                {"role": "user", "content": json.dumps(batch, ensure_ascii=False)}],
                               temperature=0.1, max_tokens=6000, reasoning="low")
            arr = llm.extract_json(out)
            if not isinstance(arr, list) or len(arr) != len(batch):
                raise ValueError("risposta non valida")
            done = 0
            for it, en in zip(batch, arr):
                en = _norm_ph(en)
                if isinstance(en, str) and en.count("⟦") == it.count("⟦") and en.count("⟧") == it.count("⟧"):
                    _cache[it] = en
                    done += 1
                else:
                    _failed[it] = _failed.get(it, 0) + 1
            with _lock:
                for it in batch:
                    _pending.discard(it)
                    _inflight.discard(it)
                _save()
            _SIZE["chars"] = min(BATCH_CHARS, int(_SIZE["chars"] * 1.25))  # LLM reattivo: lotti più grandi
            log.info("i18n: tradotte %d/%d frasi (in coda %d)", done, len(batch), len(_pending))
        except Exception as e:  # noqa: BLE001
            timeout = "timed out" in str(e).lower() or "timeout" in type(e).__name__.lower()
            if timeout:  # LLM lento/occupato: lotti più piccoli, la frase NON viene scartata
                _SIZE["chars"] = max(300, _SIZE["chars"] // 2)
            log.info("i18n batch fallito (%s): lotto ora %d caratteri", e, _SIZE["chars"])
            with _lock:
                for it in batch:
                    _inflight.discard(it)
                    if not timeout:
                        _failed[it] = _failed.get(it, 0) + 1
                        if _failed[it] >= 4:
                            _pending.discard(it)
            time.sleep(5 if not timeout else 15)


_load()
