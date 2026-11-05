"""Registro dei Segnali: emissione, ciclo di vita e track record. Solo carta: nessun ordine, nessuna chiave, nessuna leva.

Il registro è una catena di eventi append-only (`signals_ledger.parquet`): una riga per evento, ognuna con l'hash della precedente.
Lo stato di un segnale non è mai salvato: si ricava rileggendo i suoi eventi. Un segnale emesso non si modifica, si può solo
aggiungere un evento successivo; `verify()` ricalcola la catena e la pagina mostra l'esito.

A ogni giro (`tick`) l'agente:
  1. legge le candele 1m chiuse del perpetuo dopo il cursore e fa avanzare i segnali aperti con la stessa macchina a stati del backtest;
  2. se l'app era spenta le stesse candele ricostruiscono ciò che è successo: gli eventi restano marcati `rebuilt`;
  3. alla chiusura di una candela 15m, 1h, 4h o 1g valuta i setup attivi e, se c'è un candidato e il posto è libero, lo emette.
"""
from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from .analysis import signal_backtest as bt
from .analysis import signal_data as sd
from .analysis import signal_setups as ss
from .analysis import signal_sim as sim
from .data import store
from .util import clean

log = logging.getLogger("signals")

LEDGER_FILE = store.DATA_DIR / "signals_ledger.parquet"
STATE_FILE = store.DATA_DIR / "signals_state.json"
GENESIS = "0" * 64
REBUILT_AFTER_S = 180          # un evento elaborato più tardi di così dopo la sua candela è ricostruito, non visto dal vivo
GRACE_S = {"15m": 180, "1h": 300, "4h": 900, "1d": 1800}   # oltre, la candela è passata da troppo e il segnale non si emette
BACKTEST_MAX_AGE_S = 30 * 86400
OPEN_STATES = ("pending", "active")
FIELDS = ("seq", "sig", "type", "time", "price", "rec", "rebuilt", "data", "prev", "hash")

_lock = threading.RLock()
_tick_lock = threading.Lock()   # un solo giro alla volta; il registro resta leggibile mentre l agente lavora
_rows: list[dict] | None = None
_meta: dict = {"last_tick": None, "last_eval": {}, "error": None, "bars": 0}


# ------------------------------------------------------------------ registro

def _digest(prev: str, r: dict) -> str:
    body = json.dumps([r["seq"], r["sig"], r["type"], r["time"], r["price"], r["rec"], r["rebuilt"], r["data"]], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256((prev + body).encode("utf-8")).hexdigest()


def _load() -> list[dict]:
    global _rows
    if _rows is None:
        _rows = []
        if LEDGER_FILE.exists():
            df = pd.read_parquet(LEDGER_FILE)
            for r in df.to_dict("records"):
                _rows.append({"seq": int(r["seq"]), "sig": str(r["sig"]), "type": str(r["type"]), "time": int(r["time"]),
                              "price": None if r["price"] is None or pd.isna(r["price"]) else float(r["price"]), "rec": int(r["rec"]),
                              "rebuilt": bool(r["rebuilt"]), "data": str(r["data"]), "prev": str(r["prev"]), "hash": str(r["hash"])})
    return _rows


def reset_cache() -> None:
    """Dimentica la copia in memoria (test)."""
    global _rows
    with _lock:
        _rows = None
        _meta.update(last_tick=None, last_eval={}, error=None, bars=0)


def append(events: list[dict]) -> list[dict]:
    """Aggiunge eventi in coda: è l'unico modo di scrivere nel registro. Un id può essere emesso una sola volta."""
    if not events:
        return []
    with _lock:
        rows = _load()
        seen = {r["sig"] for r in rows if r["type"] == "emitted"}
        out = []
        for e in events:
            if e["type"] == "emitted":
                if e["sig"] in seen:
                    raise ValueError(f"segnale già emesso: {e['sig']}")
                seen.add(e["sig"])
            elif e["sig"] not in seen:
                raise ValueError(f"evento per un segnale sconosciuto: {e['sig']}")
            prev = rows[-1]["hash"] if rows else GENESIS
            r = {"seq": len(rows), "sig": e["sig"], "type": e["type"], "time": int(e["time"]), "price": None if e.get("price") is None else float(e["price"]),
                 "rec": int(time.time()), "rebuilt": bool(e.get("rebuilt")), "data": json.dumps(clean(e.get("data") or {}), ensure_ascii=False, sort_keys=True), "prev": prev}
            r["hash"] = _digest(prev, r)
            rows.append(r)
            out.append(r)
        store.write_parquet(pd.DataFrame(rows, columns=list(FIELDS)), LEDGER_FILE)
        return out


def verify() -> dict:
    """Ricalcola la catena dal file su disco. ok=False vuol dire che una riga passata è stata cambiata."""
    if not LEDGER_FILE.exists():
        return {"ok": True, "rows": 0, "broken_at": None}
    df = pd.read_parquet(LEDGER_FILE)
    prev = GENESIS
    for i, r in enumerate(df.to_dict("records")):
        x = {"seq": int(r["seq"]), "sig": r["sig"], "type": r["type"], "time": int(r["time"]), "price": None if pd.isna(r["price"]) else float(r["price"]),
             "rec": int(r["rec"]), "rebuilt": bool(r["rebuilt"]), "data": r["data"]}
        if r["prev"] != prev or _digest(prev, x) != r["hash"] or x["seq"] != i:
            return {"ok": False, "rows": len(df), "broken_at": i}
        prev = r["hash"]
    return {"ok": True, "rows": len(df), "broken_at": None}


# ------------------------------------------------------------------ stato derivato

def fold() -> dict[str, dict]:
    """Stato corrente di ogni segnale, ricavato dagli eventi nell'ordine in cui sono stati scritti."""
    with _lock:
        rows = list(_load())
    out: dict[str, dict] = {}
    for r in rows:
        d = json.loads(r["data"])
        if r["type"] == "emitted":
            out[r["sig"]] = dict(d, id=r["sig"], status="pending", outcome=None, tp1_hit=False, events=[], comment=None, rebuilt=False, leave=False)
        s = out.get(r["sig"])
        if s is None:
            continue
        if r["type"] == "comment":
            s["comment"] = d.get("text")
            continue
        s["events"].append({"type": r["type"], "time": r["time"], "price": r["price"], "rebuilt": r["rebuilt"], "rec": r["rec"], "r": d.get("r")})
        s["rebuilt"] = s["rebuilt"] or r["rebuilt"]
        if r["type"] == "active":
            s.update(status="active", fill=r["price"], fill_t=r["time"])
        elif r["type"] == "tp1":
            s.update(tp1_hit=True, tp1_t=r["time"])
        elif r["type"] == "leave":
            s["leave"] = True
        elif r["type"] in ("tp2", "sl", "be", "timeout", "invalidated", "expired", "canceled"):
            s.update(status="closed", outcome=r["type"], exit_t=r["time"], exit_px=r["price"], r=d.get("r"), gross_pct=d.get("gross_pct"),
                     funding_pct=d.get("funding_pct"), cost_pct=d.get("cost_pct"), risk_pct=d.get("risk_pct"))
    return out


def trade_of(s: dict) -> sim.Trade:
    """Rimette la macchina a stati nel punto raggiunto dal segnale."""
    p = sim.Plan(1 if s["side"] == "long" else -1, s["kind"], s["entry"], s["sl"], s["tp1"], s["tp2"], s.get("inv"), s["pending_until"], s["exit_by"], ss.TF_S[s["tf"]])
    t = sim.Trade(p)
    if s["status"] == "active":
        t.status, t.fill, t.fill_t = "active", s["fill"], s["fill_t"]
        t.leave = bool(s.get("leave"))
        if s["tp1_hit"]:
            t.tp1_done, t.tp1_t, t.stop = True, s["tp1_t"], s["fill"]
    return t


def _funding() -> tuple[np.ndarray, np.ndarray]:
    try:
        d = store.get("funding")
        return ss.secs(d["time"]), d["rate"].to_numpy(float) * 100
    except Exception as e:  # noqa: BLE001
        log.info("funding non disponibile: %s", e)
        return np.array([], dtype=np.int64), np.array([])


def _closing_data(tr: sim.Trade, ft, fr) -> dict:
    if tr.fill is None:
        return {}
    return {"r": tr.net_r(ft, fr), "gross_pct": tr.gross_pct(), "funding_pct": tr.funding_pct(ft, fr), "cost_pct": sim.COST_PCT, "risk_pct": tr.risk_pct()}


def advance(open_sigs: list[dict], bars: list[tuple], now: int, ft, fr) -> list[dict]:
    """Fa passare le candele 1m chiuse sui segnali aperti e restituisce i nuovi eventi. bars = (t, o, h, l, c)."""
    out: list[dict] = []
    for s in open_sigs:
        tr = trade_of(s)
        done = 0
        for t, o, h, l, c in bars:
            if t < s["emitted_at"] or tr.status == "closed":
                continue
            tr.step(int(t), o, h, l, c, (int(t) + 60) % tr.plan.tf_s == 0)
            for e in tr.events[done:]:
                rebuilt = now - (e["time"] + 60) > REBUILT_AFTER_S
                data = _closing_data(tr, ft, fr) if e["type"] == tr.outcome else {}
                out.append({"sig": s["id"], "type": e["type"], "time": e["time"], "price": e["price"], "rebuilt": rebuilt, "data": data})
            done = len(tr.events)
    out.sort(key=lambda e: e["time"])
    return out


# ------------------------------------------------------------------ verdetti

_verd: dict = {"mtime": None, "rows": {}, "summary": None}


def verdicts() -> dict[str, dict]:
    """Riga del backtest per ipotesi, ricaricata quando il file cambia."""
    p = bt.RESULT_FILE
    m = p.stat().st_mtime if p.exists() else None
    if m != _verd["mtime"]:
        d = bt.read() or {}
        _verd.update(mtime=m, rows={ss.hyp_key(r["setup"], r["tf"], 1 if r["side"] == "long" else -1): r for r in d.get("rows", [])}, summary=d.get("summary"))
    return _verd["rows"]


# esclusi per scelta dell'utente: holdout chiaramente negativo (intervallo di confidenza tutto sotto zero)
MANUAL_OFF = {"band_revert|15m|short"}


def tier_of(row: dict | None) -> str:
    """`validated` se ha passato tutti i controlli. `off` se il backtest non dà nessun appiglio: R medio non positivo sia nel walk-forward
    sia nell'holdout, oppure meno di 20 trade in tutto, o se è in MANUAL_OFF. Il resto è `experimental`: emette, ma resta marcato."""
    if not row:
        return "off"
    if f"{row.get('setup')}|{row.get('tf')}|{row.get('side')}" in MANUAL_OFF:
        return "off"
    if row.get("verdict") == "validated":
        return "validated"
    w, h = row["wf"], row.get("holdout") or {}
    if (w.get("n") or 0) + (h.get("n") or 0) < 20:
        return "off"
    return "experimental" if (w.get("mean_r") or 0) > 0 or (h.get("mean_r") or 0) > 0 else "off"


# ------------------------------------------------------------------ dati live

_tail: dict = {"t": 0.0, "m5": None, "spot": None}


def recent_market(max_age: float = 20.0) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Storico persistito più il tratto successivo letto al momento: le candele chiuse sono sempre aggiornate."""
    if _tail["m5"] is None or time.time() - _tail["t"] > max_age:
        m5, sp = sd.peek("sig_perp_5m"), sd.peek("sig_spot_15m")
        if m5.empty:
            raise RuntimeError("storico a 5m non ancora disponibile")
        a = sd.tail(sd.FAPI, "5m", m5["time"].iloc[-1])
        b = sd.tail(sd.SPOT, "15m", sp["time"].iloc[-1], limit=1000) if len(sp) else sp
        _tail.update(t=time.time(), m5=pd.concat([m5, a], ignore_index=True) if len(a) else m5, spot=pd.concat([sp, b], ignore_index=True) if len(b) else sp)
    return _tail["m5"], _tail["spot"]


def fetch_1m(after: int) -> list[tuple]:
    """Candele 1m chiuse del perpetuo dopo `after` (unix s dell'apertura dell'ultima già vista)."""
    rows = sd.fetch(sd.FAPI, "1m", (after + 60) * 1000, deadline=time.time() + 12)
    return [(int(r[0]) // 1000, float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in rows]


def live_frame(tf: str) -> ss.Frame:
    m5, spot = recent_market(0)
    return ss.build_frame(m5, spot, store.get("funding"), _opt("lev_bybit_1d"), tf)


def _opt(name: str) -> pd.DataFrame | None:
    try:
        return store.get(name)
    except Exception:  # noqa: BLE001
        p = store.DATA_DIR / f"{name}.parquet"
        return pd.read_parquet(p) if p.exists() else None


# ------------------------------------------------------------------ emissione

def _context(F: ss.Frame, i: int) -> dict:
    return {"trend": int(F.trend[i]), "vol": F.vol[i], "adx": F.adx[i], "atr": F.a[i], "atr_pct": F.a[i] / F.c[i] * 100, "vwap": F.vw[i], "sigma": F.sd[i],
            "funding": F.fund[i], "funding_z": F.fund_z[i], "oi7": F.oi7[i], "close": F.c[i], "anchor": ss.ANCHOR[F.tf]}


def payload(c: ss.Cand, F: ss.Frame, tier: str, row: dict | None) -> dict:
    close_t = int(F.t[c.i]) + ss.TF_S[c.tf]
    pl = bt.plan_of(c, close_t)
    r = abs(c.entry - c.sl)
    h = (row or {}).get("holdout") or {}
    return {"setup": c.setup, "tf": c.tf, "family": ss.FAMILY[c.tf], "side": "long" if c.side > 0 else "short", "kind": c.kind, "tier": tier,
            "entry": round(c.entry, 1), "sl": round(c.sl, 1), "tp1": round(c.tp1, 1), "tp2": round(c.tp2, 1), "inv": None if c.inv is None else round(c.inv, 1),
            "rr1": abs(c.tp1 - c.entry) / r, "rr2": abs(c.tp2 - c.entry) / r, "risk_pct": r / c.entry * 100, "emitted_at": close_t, "pending_until": pl.pending_until, "exit_by": pl.exit_by,
            "reasons": c.reasons, "context": _context(F, c.i), "params": c.params, "reason_verdict": (row or {}).get("reason"),
            "bt": {"n": h.get("n"), "mean_r": h.get("mean_r"), "win_rate": h.get("win_rate")}}


def emit_for(tf: str, close_t: int, frame: ss.Frame, sigs: dict[str, dict]) -> list[dict] | None:
    """Candidati sulla candela appena chiusa. Un solo segnale aperto per famiglia e direzione; a parità vince il setup con il verdetto migliore.
    Un setup validato prende il posto di un segnale sperimentale ancora in attesa, che viene annullato.
    None = la candela non è ancora nei dati: il giro successivo riprova."""
    step = ss.TF_S[tf]
    i = len(frame.t) - 1
    if i < 0 or int(frame.t[i]) + step != close_t:
        return None
    rows = verdicts()
    found: list[tuple[int, float, ss.Cand, dict | None, str]] = []
    for key, p in ss.FROZEN.items():
        setup, ktf, side = key.split("|")
        if ktf != tf:
            continue
        row = rows.get(key)
        tier = tier_of(row)
        if tier == "off":
            continue
        for c in ss.candidates(frame, setup, 1 if side == "long" else -1, p):
            if c.i == i:
                found.append((0 if tier == "validated" else 1, -(((row or {}).get("holdout") or {}).get("mean_r") or 0.0), c, row, tier))
    found.sort(key=lambda x: x[:2])
    out: list[dict] = []
    fam = ss.FAMILY[tf]
    for _, _, c, row, tier in found:
        sid = f"{c.setup}-{c.tf}-{'L' if c.side > 0 else 'S'}-{close_t}"
        side = "long" if c.side > 0 else "short"
        if sid in sigs:
            continue
        taken = [s for s in sigs.values() if s["family"] == fam and s["side"] == side and s["status"] in OPEN_STATES]
        taken += [e for e in out if e["type"] == "emitted" and e["data"]["family"] == fam and e["data"]["side"] == side]
        if taken and tier == "validated" and all(s.get("status") == "pending" and s.get("tier") == "experimental" for s in taken):
            for s in taken:
                out.append({"sig": s["id"], "type": "canceled", "time": close_t, "price": None, "data": {"why": "superseded"}})
                s["status"] = "closed"
            taken = []
        if taken:
            continue
        out.append({"sig": sid, "type": "emitted", "time": close_t, "price": c.entry, "data": payload(c, frame, tier, row)})
    return out


def _closed_tfs(prev: int, cur: int) -> list[tuple[str, int]]:
    """Timeframe con almeno una chiusura tra due istanti, con l'orario dell'ultima chiusura."""
    return [(tf, cur // s * s) for tf, s in ss.TF_S.items() if cur // s > prev // s]


def read_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except ValueError:
            log.warning("stato dei segnali illeggibile: riparto dal registro")
    return {}


def tick(now: int | None = None, bars_fn: Callable[[int], list[tuple]] = fetch_1m, frame_fn: Callable[[str], ss.Frame] = live_frame) -> dict:
    """Un giro dell'agente. Restituisce gli eventi scritti in questo giro."""
    now = int(now or time.time())
    with _tick_lock:
        st = read_state()
        cursor = st.get("cursor")
        if cursor is None:
            cursor = now // 60 * 60 - 120
        sigs = fold()
        open_sigs = [s for s in sigs.values() if s["status"] in OPEN_STATES]
        bars = bars_fn(cursor)
        written: list[dict] = []
        ft, fr = _funding()
        ev = advance(open_sigs, bars, now, ft, fr)
        written += append(ev)
        if bars:
            cursor = bars[-1][0]
        last_close = cursor + 60
        prev_seen = st.get("seen", last_close)
        due = _closed_tfs(prev_seen, last_close)
        retry = False
        for tf, close_t in due:
            if now - close_t > GRACE_S[tf]:
                st.setdefault("missed", {})[tf] = close_t    # l'app era spenta: niente segnali a posteriori
                continue
            try:
                sigs = fold()
                new = emit_for(tf, close_t, frame_fn(tf), sigs)
                if new is None:
                    retry = True
                    continue
                written += append(new)
                _meta["last_eval"][tf] = close_t
            except Exception as e:  # noqa: BLE001
                log.warning("valutazione %s: %s", tf, e)
                _meta["error"] = str(e)[:200]
                retry = True
        store.write_text(STATE_FILE, json.dumps(dict(st, cursor=cursor, seen=prev_seen if retry else last_close, updated=now)))
        _meta.update(last_tick=now, bars=len(bars), error=None if not _meta.get("error") else _meta["error"])
    return {"written": written, "rebuilt": sum(1 for e in ev if e.get("rebuilt"))}


# ------------------------------------------------------------------ preparazione

_prep: dict = {"thread": None, "proc": None}


def backtest_running() -> bool:
    p = _prep["proc"]
    return p is not None and p.poll() is None


def ensure_ready() -> None:
    """Scarica lo storico e fa partire il backtest, in sottofondo: l'agente non si ferma."""
    t = _prep["thread"]
    if t is not None and t.is_alive():
        return
    th = threading.Thread(target=_prepare, daemon=True, name="signals-prepare")
    _prep["thread"] = th
    th.start()


def _prepare() -> None:
    try:
        d = sd.peek("sig_perp_5m")
        stale = d.empty or d["time"].iloc[-1] < pd.Timestamp.now(tz="UTC") - pd.Timedelta(hours=3)
        if stale:
            sd.bootstrap()
        else:
            store.get("sig_perp_5m")
            store.get("sig_spot_15m")
        r = bt.RESULT_FILE
        old = not r.exists() or time.time() - r.stat().st_mtime > BACKTEST_MAX_AGE_S
        if old and not backtest_running():
            root = Path(__file__).resolve().parents[1]
            log.info("avvio del backtest dei segnali")
            _prep["proc"] = subprocess.Popen([sys.executable, "-m", "app.analysis.signal_backtest", "full"], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:  # noqa: BLE001
        log.warning("preparazione segnali: %s", e)


# ------------------------------------------------------------------ commento LLM

def _numbers(s: dict) -> list[float]:
    ctx = s.get("context") or {}
    xs = [s["entry"], s["sl"], s["tp1"], s["tp2"], s.get("inv"), s.get("rr1"), s.get("rr2"), s.get("risk_pct")]
    xs += [v for v in ctx.values() if isinstance(v, (int, float))]
    for r in s.get("reasons") or []:
        xs += [v for v in (r.get("v") or {}).values() if isinstance(v, (int, float))]
    return [float(x) for x in xs if x is not None]


def comment_text(s: dict, complete: Callable[..., str]) -> str | None:
    """Commento del modello locale: solo parole sui numeri del segnale. Entry, TP, SL e decisione restano fuori dalla sua portata."""
    from .routers import ai
    side = "long" if s["side"] == "long" else "short"
    facts = json.dumps({k: s.get(k) for k in ("setup", "tf", "entry", "sl", "tp1", "tp2", "inv", "rr1", "rr2", "tier", "reasons", "context")}, ensure_ascii=False)
    txt = complete([
        {"role": "system", "content": "Commenti segnali BTC emessi da un sistema statistico, seguiti solo sulla carta. Italiano, massimo 2 frasi, tono sobrio. Usa SOLO i numeri "
                                      "forniti, non proporne di nuovi, non indicare leva, capitale o consigli personali, non cambiare livelli o direzione."},
        {"role": "user", "content": f"Segnale {side}. Spiega in breve il contesto usando questi dati:\n{facts}"},
    ], max_tokens=220, temperature=0.2)
    if not txt:
        return None
    known = ai._snapshot_numbers(_numbers(s), [])
    if not ai._semantic_ok({"text": txt}, {"mercato": {"prezzo": s["entry"]}}) or not ai._verified(txt, known):
        log.info("commento del segnale %s scartato dalla verifica", s["id"])
        return None
    return txt


def comment_async(sig_id: str) -> None:
    def run() -> None:
        try:
            from . import llm
            if not llm.available():
                return
            s = fold().get(sig_id)
            if not s:
                return
            txt = comment_text(s, llm.complete)
            if txt:
                append([{"sig": sig_id, "type": "comment", "time": int(time.time()), "data": {"text": txt, "model": llm.model()}}])
        except Exception as e:  # noqa: BLE001
            log.info("commento del segnale non disponibile: %s", e)
    threading.Thread(target=run, daemon=True, name="signal-comment").start()


# ------------------------------------------------------------------ viste

def mark_price() -> float | None:
    try:
        from .routers.stream import hub
        m = hub.last.get("mark")
        if m and time.time() - m["time"] < 30:
            return float(m["mark"])
    except Exception:  # noqa: BLE001
        pass
    try:
        m5, _ = recent_market(60)
        return float(m5["close"].iloc[-1])
    except Exception:  # noqa: BLE001
        return None


def public(s: dict, price: float | None = None, ft=None, fr=None) -> dict:
    x = {k: v for k, v in s.items() if k not in ("leave",)}
    x["last_event"] = s["events"][-1] if s["events"] else None
    if s["status"] == "active" and price is not None and ft is not None:
        x["open_r"] = trade_of(s).open_r(price, ft, fr, int(time.time()))
    return x


def overview() -> dict:
    sigs = fold()
    price = mark_price()
    ft, fr = _funding()
    now = int(time.time())
    opened = sorted((public(s, price, ft, fr) for s in sigs.values() if s["status"] in OPEN_STATES), key=lambda s: -s["emitted_at"])
    rows = verdicts()
    tiers = {k: tier_of(rows.get(k)) for k in ss.FROZEN}
    summary = _verd["summary"]
    enabled = []
    for k, tier in tiers.items():
        if tier != "off":
            setup, tf, side = k.split("|")
            enabled.append({"setup": setup, "tf": tf, "family": ss.FAMILY[tf], "side": side, "tier": tier})
    return clean({
        "time": now, "price": price, "open": opened, "enabled": enabled,
        "recent": [public(s) for f in ("low", "high") for s in sorted((s for s in sigs.values() if s["status"] == "closed" and s["family"] == f), key=lambda s: -s["exit_t"])[:10]],
        "summary": summary, "backtest_ready": bool(rows), "backtest_running": backtest_running(),
        "tiers": {t: sum(1 for v in tiers.values() if v == t) for t in ("validated", "experimental", "off")},
        "ml_active": bool(_ml_kept()), "agent": {"last_tick": _meta["last_tick"] or read_state().get("updated"), "last_eval": _meta["last_eval"], "bars": _meta["bars"]},
        "integrity": verify(), "total": len(sigs),
    })


def _ml_kept() -> bool:
    d = bt.read() or {}
    return bool((d.get("ml") or {}).get("kept"))


def history(limit: int = 500, setup: str | None = None, outcome: str | None = None, tf: str | None = None, side: str | None = None, tier: str | None = None) -> dict:
    sigs = sorted(fold().values(), key=lambda s: -s["emitted_at"])
    total = len(sigs)
    out = []
    for s in sigs:
        state = s["outcome"] or s["status"]
        if (setup and s["setup"] != setup) or (tf and s["tf"] != tf) or (side and s["side"] != side) or (tier and s["tier"] != tier) or (outcome and state != outcome):
            continue
        out.append(public(s))
        if len(out) >= limit:
            break
    return clean({"items": out, "total": total, "setups": sorted({s["setup"] for s in sigs})})


def _perf(items: list[dict]) -> dict:
    tr = sorted((s for s in items if s.get("r") is not None), key=lambda s: s["exit_t"])
    r = np.array([s["r"] for s in tr], dtype=float)
    pos, neg = r[r > 0].sum(), -r[r < 0].sum()
    out = {"n": len(r), "win_rate": float((r > 0).mean() * 100) if len(r) else None, "mean_r": float(r.mean()) if len(r) else None,
           "total_r": float(r.sum()), "pf": float(pos / neg) if neg > 0 else None, "max_dd_r": bt.max_dd(r)}
    out["curve"] = [{"time": s["exit_t"], "value": float(c), "id": s["id"]} for s, c in zip(tr, np.cumsum(r))]
    return out


def performance() -> dict:
    sigs = list(fold().values())
    closed = [s for s in sigs if s["status"] == "closed"]

    def group(field: str) -> list[dict]:
        out = []
        for k in sorted({s[field] for s in closed}):
            p = _perf([s for s in closed if s[field] == k])
            p.pop("curve")
            out.append({"key": k, **p})
        return out

    return clean({
        "all": _perf(closed), "validated": _perf([s for s in closed if s["tier"] == "validated"]), "experimental": _perf([s for s in closed if s["tier"] == "experimental"]),
        "by_setup": group("setup"), "by_tf": group("tf"), "by_family": group("family"), "by_side": group("side"),
        "counts": {"emitted": len(sigs), "open": sum(s["status"] in OPEN_STATES for s in sigs), "closed": len(closed), "never_filled": sum(s["status"] == "closed" and s.get("r") is None for s in sigs),
                   "rebuilt": sum(bool(s["rebuilt"]) for s in sigs)},
        "first": min((s["emitted_at"] for s in sigs), default=None), "costs": {"fee_pct": sim.FEE_PCT, "slip_pct": sim.SLIP_PCT, "cost_pct": sim.COST_PCT},
    })


def backtest() -> dict:
    d = bt.read()
    if not d:
        return {"status": "computing" if backtest_running() else "missing"}
    rows = verdicts()
    for r in d["rows"]:
        r["tier"] = tier_of(rows.get(ss.hyp_key(r["setup"], r["tf"], 1 if r["side"] == "long" else -1)))
    return d


def candles_for(tf: str, t0: int, t1: int) -> list[dict]:
    m5, _ = recent_market(60)
    t = ss.secs(m5["time"])
    a, b = int(np.searchsorted(t, t0)), int(np.searchsorted(t, t1, "right"))
    g, _ix = ss.resample(m5.iloc[a:b], tf)
    return [{"time": int(r.b), "open": r.open, "high": r.high, "low": r.low, "close": r.close, "volume": r.volume} for r in g.itertuples()]


def detail(sig_id: str) -> dict | None:
    s = fold().get(sig_id)
    if not s:
        return None
    step = ss.TF_S[s["tf"]]
    end = s.get("exit_t") or int(time.time())
    last = min(end + 30 * step, int(time.time()))
    ft, fr = _funding()
    x = public(s, mark_price() if s["status"] == "active" else None, ft, fr)
    try:
        x["candles"] = candles_for(s["tf"], s["emitted_at"] - 90 * step, last)
    except Exception as e:  # noqa: BLE001
        log.info("candele del segnale %s: %s", sig_id, e)
        x["candles"] = []
    return clean(x)
