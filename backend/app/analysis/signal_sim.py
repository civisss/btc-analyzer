"""Macchina a stati di un segnale, unica per backtest e registro live: stesse regole, stesso codice.

Costi dichiarati (Binance USDⓈ-M, livello base): commissione taker su ogni esecuzione, slittamento su ogni esecuzione,
funding realmente pagato o incassato durante la permanenza. La posizione è sempre "1 unità": il risultato è in R.

Regole di esecuzione, tutte a sfavore quando l'ordine degli eventi non è noto:
  - entrata market: apertura della prima candela fine dopo la chiusura della candela segnale;
  - entrata limite: prezzo che attraversa il livello; nella candela di entrata conta lo stop ma non il target;
  - stop e target nella stessa candela: conta lo stop;
  - il target deve essere attraversato, non solo toccato (`>`), lo stop basta toccarlo (`<=`);
  - apertura già oltre lo stop: l'uscita avviene all'apertura, non al livello;
  - dopo TP1 si chiude metà posizione e lo stop del resto passa all'entrata (pareggio);
  - TP1 e pareggio nella stessa candela: il resto esce a pareggio anche se la stessa candela tocca TP2.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

FEE_PCT = 0.05          # % per lato, taker Binance USDⓈ-M livello base
SLIP_PCT = 0.02         # % per esecuzione, stima prudente per BTCUSDT
TP1_FRACTION = 0.5
COST_PCT = 2 * (FEE_PCT + SLIP_PCT)   # andata e ritorno


@dataclass
class Plan:
    side: int                    # +1 long, -1 short
    kind: str                    # "market" | "limit"
    entry: float
    sl: float
    tp1: float
    tp2: float
    inv: float | None            # chiusura della candela del timeframe oltre questo livello = invalidazione
    pending_until: int           # unix s: oltre questo istante un'entrata non eseguita scade
    exit_by: int                 # unix s: oltre questo istante la posizione si chiude al prezzo di mercato
    tf_s: int = 3600


@dataclass
class Trade:
    plan: Plan
    status: str = "pending"      # pending | active | closed
    outcome: str | None = None   # tp2 | sl | be | timeout | invalidated | expired | canceled
    fill: float | None = None
    fill_t: int | None = None
    stop: float = 0.0
    tp1_done: bool = False
    tp1_t: int | None = None
    exit_t: int | None = None
    exit_px: float | None = None
    leave: bool = False          # invalidazione decisa: esce all'apertura della candela successiva
    events: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.stop = self.plan.sl

    # ------------------------------------------------------------------ passo
    def _ev(self, typ: str, t: int, price: float | None = None) -> None:
        self.events.append({"type": typ, "time": int(t), "price": None if price is None else float(price)})

    def _close(self, outcome: str, t: int, px: float) -> None:
        self.status, self.outcome, self.exit_t, self.exit_px = "closed", outcome, int(t), float(px)
        self._ev(outcome, t, px)

    def _end_unfilled(self, outcome: str, t: int) -> None:
        self.status, self.outcome, self.exit_t = "closed", outcome, int(t)
        self._ev(outcome, t)

    def _check_active(self, t: int, o: float, h: float, l: float, can_target: bool) -> None:
        p = self.plan
        s = p.side

        def adverse(lvl: float) -> bool:
            return l <= lvl if s > 0 else h >= lvl

        def favour(lvl: float) -> bool:
            return h > lvl if s > 0 else l < lvl

        if adverse(self.stop):
            gap = (o < self.stop) if s > 0 else (o > self.stop)
            self._close("be" if self.tp1_done else "sl", t, o if gap and can_target else self.stop)
            return
        if not can_target:
            return
        if not self.tp1_done and favour(p.tp1):
            self.tp1_done, self.tp1_t = True, int(t)
            self._ev("tp1", t, p.tp1)
            self.stop = self.fill
            if adverse(self.stop):
                self._close("be", t, self.stop)
                return
        if self.tp1_done and favour(p.tp2):
            self._close("tp2", t, p.tp2)

    def step(self, t: int, o: float, h: float, l: float, c: float, tf_close: bool) -> None:
        """Una candela fine chiusa. `t` è il suo orario di apertura, `tf_close` dice se chiude anche la candela del timeframe."""
        if self.status == "closed":
            return
        p = self.plan
        s = p.side
        if self.status == "pending":
            if t >= p.pending_until:
                self._end_unfilled("expired", t)
                return
            if p.kind == "market":
                self.status, self.fill, self.fill_t = "active", float(o), int(t)
                self._ev("active", t, o)
                self._check_active(t, o, h, l, True)
            else:
                touched = l < p.entry if s > 0 else h > p.entry
                if touched:
                    self.status, self.fill, self.fill_t = "active", float(p.entry), int(t)
                    self._ev("active", t, p.entry)
                    self._check_active(t, o, h, l, False)
                elif (h > p.tp1) if s > 0 else (l < p.tp1):
                    self._end_unfilled("canceled", t)
                    return
                elif tf_close and p.inv is not None and s * (c - p.inv) < 0:
                    self._end_unfilled("invalidated", t)
                    return
        else:
            if self.leave:
                self._close("invalidated", t, o)
                return
            if t >= p.exit_by:
                self._close("timeout", t, o)
                return
            self._check_active(t, o, h, l, True)
        if self.status == "active" and tf_close and p.inv is not None and s * (c - p.inv) < 0:
            self.leave = True
            self._ev("leave", t, c)

    # --------------------------------------------------------------- risultato
    def _gross(self, last_px: float) -> float:
        s = self.plan.side
        last = (last_px - self.fill) / self.fill * s * 100
        if self.tp1_done:
            first = (self.plan.tp1 - self.fill) / self.fill * s * 100
            return TP1_FRACTION * first + (1 - TP1_FRACTION) * last
        return last

    def gross_pct(self) -> float | None:
        if self.fill is None or self.exit_px is None:
            return None
        return self._gross(self.exit_px)

    def risk_pct(self) -> float | None:
        if self.fill is None:
            return None
        return abs(self.fill - self.plan.sl) / self.fill * 100

    def funding_pct(self, ft: np.ndarray, fr: np.ndarray, until: int | None = None) -> float:
        """Funding pagato (positivo) o incassato (negativo) tra entrata e uscita. fr in %, ft in unix s."""
        if self.fill_t is None:
            return 0.0
        end = self.exit_t if self.exit_t is not None else until
        if end is None:
            return 0.0
        a, b = int(np.searchsorted(ft, self.fill_t, "right")), int(np.searchsorted(ft, end, "right"))
        if b <= a:
            return 0.0
        w = np.ones(b - a)
        if self.tp1_t is not None:
            w[ft[a:b] > self.tp1_t] = 1 - TP1_FRACTION
        return float(self.plan.side * np.sum(fr[a:b] * w))

    def net_r(self, ft: np.ndarray, fr: np.ndarray) -> float | None:
        g, r = self.gross_pct(), self.risk_pct()
        if g is None or not r:
            return None
        return (g - COST_PCT - self.funding_pct(ft, fr)) / r

    def open_r(self, price: float, ft: np.ndarray, fr: np.ndarray, now: int) -> float | None:
        """R non realizzato di una posizione aperta, costi di uscita inclusi."""
        if self.status != "active" or self.fill is None:
            return None
        r = self.risk_pct()
        return (self._gross(price) - COST_PCT - self.funding_pct(ft, fr, now)) / r if r else None


@dataclass
class Fine:
    """Candele fini come array (t = apertura in unix s)."""
    t: np.ndarray
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    step: int = 300


CHUNK = 1024


def _next(tr: Trade, A: Fine, i: int) -> int | None:
    """Prossima candela in cui può accadere qualcosa: evita di percorrere in Python quelle che non cambiano lo stato."""
    p = tr.plan
    n = len(A.t)
    if tr.leave or (tr.status == "pending" and p.kind == "market"):
        return i if i < n else None
    s = p.side
    while i < n:
        j = min(n, i + CHUNK)
        t, h, l, c = A.t[i:j], A.h[i:j], A.l[i:j], A.c[i:j]
        if tr.status == "pending":
            m = t >= p.pending_until
            m |= (l < p.entry) if s > 0 else (h > p.entry)
            m |= (h > p.tp1) if s > 0 else (l < p.tp1)
        else:
            tgt = p.tp2 if tr.tp1_done else p.tp1
            m = t >= p.exit_by
            m |= (l <= tr.stop) if s > 0 else (h >= tr.stop)
            m |= (h > tgt) if s > 0 else (l < tgt)
        if p.inv is not None:
            m |= (((t + A.step) % p.tf_s) == 0) & ((s * (c - p.inv)) < 0)
        if m.any():
            return i + int(np.argmax(m))
        i = j
    return None


def simulate(plan: Plan, A: Fine, i0: int) -> Trade:
    """Esegue il piano sulle candele fini da i0. Se i dati finiscono prima dell'esito il trade resta aperto."""
    tr = Trade(plan)
    i = i0
    n = len(A.t)
    while tr.status != "closed" and i < n:
        j = _next(tr, A, i)
        if j is None:
            break
        tj = int(A.t[j])
        tr.step(tj, float(A.o[j]), float(A.h[j]), float(A.l[j]), float(A.c[j]), (tj + A.step) % plan.tf_s == 0)
        i = j + 1
    return tr
