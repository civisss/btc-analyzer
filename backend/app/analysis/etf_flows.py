"""Flussi giornalieri degli ETF spot Bitcoin USA (Farside Investors, tabella HTML) — scaricamento, parsing e cache.

- Fonte primaria: https://farside.co.uk/bitcoin-etf-flow-all-data/ (storico completo dal 11 gen 2024, per emittente, M$).
- Fallback: https://farside.co.uk/btc/ (solo le ultime ~3 settimane) unito alla cache parquet: se la pagina completa è
  bloccata (Cloudflare) o cambia layout, l'app continua a funzionare con lo storico salvato + i giorni recenti.
- Parser a sola libreria standard (html.parser) con controlli di schema: intestazione con i ticker, colonna Total,
  date valide, numeri tra parentesi = deflussi, "-" = nessun dato (festività o emittente non ancora quotato).
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

log = logging.getLogger("etf_flows")

URL_ALL = "https://farside.co.uk/bitcoin-etf-flow-all-data/"
URL_RECENT = "https://farside.co.uk/btc/"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Cache-Control": "no-cache",
}
META_FILE = Path(__file__).resolve().parents[2] / "data" / "sd_etf_meta.json"
LAUNCH = pd.Timestamp("2024-01-11", tz="UTC")
DAY1_TOTAL = 655.3  # M$, totale pubblicato del primo giorno di quotazione


class _TableParser(HTMLParser):
    """Raccoglie le righe (testo delle celle) delle tabelle con class="etf" (tabelle annidate ignorate)."""

    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._cur: list[list[str]] | None = None
        self._nested = 0
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            if self._cur is None and "etf" in (a.get("class") or "").split():
                self._cur = []
                self.tables.append(self._cur)
            elif self._cur is not None:
                self._nested += 1
        elif self._cur is not None and not self._nested:
            if tag == "tr":
                self._row = []
                self._cur.append(self._row)
            elif tag in ("td", "th") and self._row is not None:
                self._cell = []

    def handle_endtag(self, tag):
        if tag == "table" and self._cur is not None:
            if self._nested:
                self._nested -= 1
            else:
                self._cur = None
                self._row = None
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _num(s: str) -> float:
    """'(95.1)' -> -95.1 · '1,119.9' -> 1119.9 · '-' / '' -> NaN."""
    s = (s or "").strip().replace(",", "").replace("$", "")
    if s in ("", "-", "–", "—"):
        return np.nan
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        v = float(s)
    except ValueError:
        return np.nan
    return -v if neg else v


def _date(s: str) -> pd.Timestamp | None:
    for fmt in ("%d %b %Y", "%d %B %Y"):
        try:
            return pd.Timestamp(datetime.strptime(s.strip(), fmt), tz="UTC")
        except ValueError:
            continue
    return None


def _is_ticker(s: str) -> bool:
    return 2 <= len(s) <= 5 and s.isalpha() and s.isupper() and s != "TOTAL"


def parse(html: str) -> tuple[pd.DataFrame, dict]:
    """HTML Farside -> (DataFrame [time, <ticker>..., total_reported, n_dash], meta {issuers, footer_total})."""
    p = _TableParser()
    p.feed(html)
    best: tuple[pd.DataFrame, dict] | None = None
    for rows in p.tables:
        rows = [r for r in rows if r]
        header = next((r for r in rows if sum(_is_ticker(c) for c in r[1:]) >= 5), None)
        if header is None:
            continue
        has_total = any(r and r[-1].strip().lower() == "total" for r in rows[:5])
        ncol = len(header)
        tick_idx = [i for i, c in enumerate(header) if i > 0 and _is_ticker(c) and not (has_total and i == ncol - 1)]
        tickers = [header[i] for i in tick_idx]
        recs, footer = [], None
        for r in rows:
            if len(r) != ncol:
                continue
            d = _date(r[0])
            if d is None:
                if r[0].strip().lower() == "total":
                    footer = _num(r[-1]) if has_total else None
                continue
            vals = {tk: _num(r[i]) for tk, i in zip(tickers, tick_idx)}
            rec = {"time": d, **vals, "total_reported": _num(r[-1]) if has_total else np.nan,
                   "n_dash": int(sum(1 for i in tick_idx if r[i].strip() in ("-", "")))}
            recs.append(rec)
        if not recs:
            continue
        df = pd.DataFrame(recs).drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True)
        meta = {"issuers": tickers, "footer_total": footer}
        if best is None or len(df) > len(best[0]):
            best = (df, meta)
    if best is None:
        raise ValueError("tabella Farside non trovata o layout cambiato (nessuna intestazione con i ticker)")
    return best


def _fetch(url: str, retries: int = 3) -> str:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with httpx.Client(timeout=30, headers=_HEADERS, follow_redirects=True, http2=False) as c:
                r = c.get(url)
            if r.status_code == 200 and "<table" in r.text:
                return r.text
            last = RuntimeError(f"HTTP {r.status_code}" + (" (probabile blocco Cloudflare)" if r.status_code in (403, 503) else ""))
        except httpx.HTTPError as e:
            last = e
        time.sleep(1.5 + attempt * 2.5)
    raise RuntimeError(f"Farside non raggiungibile ({url}): {last}")


def _validate_full(df: pd.DataFrame) -> None:
    if len(df) < 400:
        raise ValueError(f"storico Farside troppo corto ({len(df)} righe)")
    first = df.iloc[0]
    if first["time"] != LAUNCH:
        raise ValueError(f"prima data inattesa: {first['time']}")
    if abs(float(first["total_reported"]) - DAY1_TOTAL) > 0.5:
        raise ValueError(f"totale del primo giorno {first['total_reported']} ≠ {DAY1_TOTAL}")


def _save_meta(meta: dict) -> None:
    try:
        from ..data import store
        store.write_text(META_FILE, json.dumps(meta))
    except Exception as e:  # noqa: BLE001
        log.warning("meta ETF non salvati: %s", e)


def load_meta() -> dict:
    try:
        return json.loads(META_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def refresher(old: pd.DataFrame | None) -> pd.DataFrame:
    """Refresher per store.register: pagina completa; se fallisce, pagina recente + cache."""
    now = time.time()
    try:
        df, meta = parse(_fetch(URL_ALL))
        _validate_full(df)
        _save_meta({**meta, "source": "all", "fetched_at": now, "error": None})
        return df
    except Exception as e:  # noqa: BLE001
        err = str(e)
        log.warning("Farside completo non disponibile: %s", err)
    if old is None or old.empty:
        raise RuntimeError(f"Farside non disponibile e nessuna cache: {err}")
    try:
        recent, meta = parse(_fetch(URL_RECENT))
        cols = [c for c in old.columns]
        recent = recent.reindex(columns=sorted(set(cols) | set(recent.columns), key=lambda c: (c not in cols, cols.index(c) if c in cols else 0)))
        out = pd.concat([old[~old["time"].isin(recent["time"])], recent]).sort_values("time").reset_index(drop=True)
        prev = load_meta()
        _save_meta({**prev, "issuers": list(dict.fromkeys((prev.get("issuers") or []) + meta["issuers"])),
                    "source": "recent", "fetched_at": now, "error": err})
        return out
    except Exception as e2:  # noqa: BLE001
        # nessuna fonte raggiungibile: si serve la cache (riprova al prossimo TTL, senza bloccare ogni richiesta)
        prev = load_meta()
        _save_meta({**prev, "source": "cache", "error": f"{err} · {e2}"})
        return old
