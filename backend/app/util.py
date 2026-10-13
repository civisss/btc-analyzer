"""Utilità condivise: serializzazione JSON-safe e cache con TTL."""
from __future__ import annotations

import functools
import math
import re
import threading
import time
from typing import Any, Callable

import numpy as np
import pandas as pd


def ts(t) -> int:
    """Timestamp pandas/datetime -> unix secondi."""
    return int(pd.Timestamp(t).timestamp())


def num(x) -> float | None:
    """Numero JSON-safe (NaN/inf -> None)."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def series_pts(times, values, step: int = 1) -> list[dict]:
    """Converte due sequenze in [{time, value}] (opzionalmente sotto-campionate)."""
    out = []
    for t, v in list(zip(times, values))[::step]:
        out.append({"time": ts(t), "value": num(v)})
    return out


MESI_IT = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
_MINUS_RE = re.compile(r"(?<![\w.])-(?=\$?\d)")


def data_it(t, with_year: bool = True) -> str:
    """Data in formato unico dell'app: '12 ott 2026' (o '12 ott')."""
    d = pd.Timestamp(t, unit="s", tz="UTC") if isinstance(t, (int, float)) else pd.Timestamp(t)
    return f"{d.day} {MESI_IT[d.month - 1]}" + (f" {d.year}" if with_year else "")


# Normalizzazioni della prosa verso il formato unico dell'app ($83,722 · 34.6% · 126.2K · ×2.4 · 410 g)
_PROSE_RULES = [
    (re.compile(r"\$(\d{1,3})\.(\d{3})(?![\d.,])"), r"$\1,\2"),          # $82.466 (it-IT) -> $82,466
    (re.compile(r"\$(\d{1,3})\.(\d{3})\.(\d{3})(?![\d.,])"), r"$\1,\2,\3"),
    (re.compile(r"(?<![\d,.])(\d+),(\d{1,2})(?!\d)(?!,\d)"), r"\1.\2"),          # 47,3 / 1,54 -> 47.3 / 1.54
    (re.compile(r"(\d)\s+%"), r"\1%"),                                    # 69 % -> 69%
    (re.compile(r"(\d)k\b"), r"\1K"),                                     # 126.2k -> 126.2K
    (re.compile(r"(?<![\w])x(\d)"), r"×\1"),                              # x523.9 -> ×523.9
    (re.compile(r"(\d) gg\b"), r"\1 g"),                                  # 410 gg -> 410 g
    (re.compile(r"(\d) mln(?: (?:di )?USD)?\b"), r"\1M"),                 # 256 mln USD -> 256M
    (re.compile(r"(\$[\d.,]+)\s+([KMBT])\b"), r"\1\2"),                   # $258 M -> $258M
    (re.compile(r"\b1D\b"), "1G"), (re.compile(r"\b1W\b"), "1S"),         # timeframe in italiano
    (re.compile(r"\b4H\b"), "4h"), (re.compile(r"\b1H\b"), "1h"),
]


def prose(s: str) -> str:
    """Normalizza i testi in prosa: segno meno tipografico e formato numerico unico."""
    if " " not in s:
        return s
    for rx, rep in _PROSE_RULES:
        s = rx.sub(rep, s)
    return _MINUS_RE.sub("−", s)


def clean(obj: Any) -> Any:
    """Ripulisce ricorsivamente numpy/pandas/NaN per la risposta JSON."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return num(obj)
    if isinstance(obj, pd.Timestamp):
        return ts(obj)
    if isinstance(obj, np.ndarray):
        return clean(obj.tolist())
    if isinstance(obj, str):
        return prose(obj)
    return obj


def _vowel_number(txt: str) -> bool:
    """True se il numero si legge iniziando per vocale: 1, 11, 8, 80-89, 800-899, 8000... (uno, undici, otto, ottanta...)."""
    digits = ""
    for ch in str(txt).lstrip("+-"):
        if ch.isdigit():
            digits += ch
        else:
            break
    if not digits:
        return False
    return digits in ("1", "11") or digits.startswith("8")


def art(txt, prep: str = "il") -> str:
    """Articolo/preposizione corretti davanti a un numero: art('11%') -> "l'11%", art('8 ott', 'al') -> "all'8 ott"."""
    vowel = _vowel_number(txt)
    forms = {"il": ("l'", "il "), "al": ("all'", "al "), "del": ("dell'", "del "), "dal": ("dall'", "dal "), "nel": ("nell'", "nel ")}
    a, b = forms[prep]
    return (a if vowel else b) + str(txt)


def ttl_cache(seconds: int) -> Callable:
    """Cache in-process con scadenza, chiave = argomenti."""
    def deco(fn):
        cache: dict = {}
        lock = threading.Lock()

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            now = time.time()
            with lock:
                hit = cache.get(key)
                if hit and now - hit[0] < seconds:
                    return hit[1]
            val = fn(*args, **kwargs)
            with lock:
                cache[key] = (now, val)
            return val

        wrapper.cache_clear = cache.clear  # type: ignore[attr-defined]
        return wrapper
    return deco
