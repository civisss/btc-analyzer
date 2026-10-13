"""Modello di posizione nel ciclo: proietta il percorso del prezzo usando i cicli passati allineati sulla posizione
attuale nel ciclo, con distorsione temporale adattiva, riscalatura dell'ampiezza e pesi per similarità di stato.

Tutto è point-in-time: al giorno T si usano solo eventi di ciclo (massimi, minimi, halving) riconoscibili a T.
  - Massimo di ciclo: chiusura record (ATH) senza chiusure superiori nei 365 g successivi (o fino a T), seguita da
    un calo ≥ 30% e vecchia di almeno 60 g. L'ultimo massimo può essere "provvisorio" (meno di 365 g).
  - Minimo di ciclo: chiusura minima tra due massimi; per il ciclo in corso il minimo dopo l'ultimo massimo è
    "probabile" se il prezzo ne è risalito di ≥ 30% e sono passati ≥ 60 g.
  - Halving: date note (2012, 2016, 2020, 2024).
Allineamenti: giorni dal massimo, dal minimo, dall'halving. Per ogni ciclo passato j il punto equivalente è
e_j + s_j·d, con s_j = (durata del segmento corrispondente nel ciclo j / durata nel ciclo attuale)^γ e γ ∈ {0, ½, 1}
(incertezza sulla velocità del ciclo). L'ampiezza è riscalata con a_j = √(rapporto vol 1 anno × rapporto ampiezza
dell'ultimo segmento completato). I percorsi (con jitter ±42 g del punto di allineamento) sono pesati per recenza del
ciclo, distanza temporale e similarità di stato (drawdown, giorni dal minimo, rialzo dal minimo, MVRV, volatilità,
Mayer); i quantili giornalieri pesati danno mediana e bande fino a 365 g.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .forecast_models import QS, Ctx

HALVINGS = pd.to_datetime(["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"])
NEXT_HALVING = pd.Timestamp("2028-04-15")
ALIGNS = ("top", "bottom", "halving")
ALIGN_IT = {"top": "giorni dal massimo di ciclo", "bottom": "giorni dal minimo di ciclo", "halving": "giorni dall'halving"}
GAMMAS = ((0.0, 0.25), (0.5, 0.5), (1.0, 0.25))
OFFSETS = np.arange(-42, 43, 6)
STATE = ["dd_ath", "days_low", "rally_low", "mvrv", "vol_90d", "mayer"]
_LOG = {"days_low", "mvrv", "vol_90d", "mayer"}


class CycleModel:
    name = "cycle"

    def state_distance(self, a: int, T: int) -> float:
        st = (self.S_raw[min(a, self.n - 1)] - self.S_raw[T]) / self.S_sd[T]
        ok = ~np.isnan(st)
        return float(np.sqrt(np.mean(st[ok] ** 2))) if ok.any() else 1.0

    def __init__(self, ctx: Ctx, bw: float = 0.8, kappa: float = 1.0, recency: float = 1.0):
        self.ctx = ctx
        self.lc = ctx.lc
        self.n = ctx.n
        self.bw, self.kappa, self.recency = bw, kappa, recency
        c = self.lc
        cm = np.maximum.accumulate(c)
        self.ath_idx = np.where(c >= cm - 1e-12)[0]
        r = ctx.r
        self.vol365 = pd.Series(r).rolling(365, min_periods=120).std().bfill().to_numpy()
        S = ctx.feat[STATE].copy()
        for k in STATE:
            if k in _LOG:
                S[k] = np.log(np.maximum(S[k], 1e-6) + (1.0 if k == "days_low" else 0.0))
        # standardizzazione point-in-time: al giorno T si usano media/dev. std. della storia fino a T (stato attuale e
        # stati passati scalati con le stesse statistiche, nessuna informazione futura)
        self.S_raw = S.to_numpy(float)
        self.S_mu = S.expanding(min_periods=60).mean().bfill().to_numpy(float)
        self.S_sd = S.expanding(min_periods=60).std().bfill().to_numpy(float) + 1e-9
        self.halv = [int(np.searchsorted(ctx.dates.values, h.to_datetime64())) for h in HALVINGS]
        self.align_w = {a: 1 / len(ALIGNS) for a in ALIGNS}
        self._ev_cache: dict[int, dict] = {}

    # ------------------------------------------------------------ eventi point-in-time
    def events(self, T: int) -> dict:
        if T in self._ev_cache:
            return self._ev_cache[T]
        c = self.lc
        A = self.ath_idx[self.ath_idx <= T]
        tops, provisional = [], False
        for i, t in enumerate(A):
            nxt = A[i + 1] if i + 1 < len(A) else None
            if nxt is not None and nxt - t <= 365:
                continue
            if T - t < 60 or c[t + 1:T + 1].min() > c[t] + np.log(0.7):
                continue
            tops.append(int(t))
            if nxt is None and T - t < 365:
                provisional = True
        bottoms = [int(a + 1 + np.argmin(c[a + 1:b])) for a, b in zip(tops[:-1], tops[1:])]
        probable = None
        if tops:
            seg = c[tops[-1] + 1:T + 1]
            if len(seg):
                lo = tops[-1] + 1 + int(np.argmin(seg))
                if T - lo >= 60 and c[lo:T + 1].max() - c[lo] >= np.log(1.3):
                    bottoms.append(lo)
                    probable = lo
        halv = [h for h in self.halv if h <= T]
        ev = {"top": tops, "bottom": bottoms, "halving": halv, "provisional_top": provisional, "probable_bottom": probable}
        if len(self._ev_cache) < 50000:
            self._ev_cache[T] = ev
        return ev

    def _segments(self, ev: dict) -> list[tuple[str, int, str, int]]:
        allev = sorted([(t, k) for k in ALIGNS for t in ev[k]])
        return [(k1, t1, k2, t2) for (t1, k1), (t2, k2) in zip(allev[:-1], allev[1:]) if k1 != k2]

    # ------------------------------------------------------------ percorsi
    def paths(self, T: int, H: int = 365, aligns=ALIGNS, gammas=GAMMAS):
        """Restituisce (P (m, H+1) log-rendimenti con NaN dove il ciclo passato non ha dati, w (m,), meta per percorso)."""
        ev = self.events(T)
        segs = self._segments(ev)
        cur_seg = segs[-1] if segs else None
        t = np.arange(H + 1, dtype=float)
        P, W, meta = [], [], []
        for al in aligns:
            evs = ev[al]
            if len(evs) < 2:
                continue
            e_cur = evs[-1]
            d = T - e_cur
            past = evs[:-1]
            for rank, e in enumerate(past):
                # segmento corrispondente (stessi tipi di evento) più vicino all'evento passato
                s_raw, amp = 1.0, None
                if cur_seg is not None:
                    k1, t1, k2, t2 = cur_seg
                    cand = [(a1, a2) for (b1, a1, b2, a2) in segs[:-1] if b1 == k1 and b2 == k2]
                    if cand:
                        a1, a2 = min(cand, key=lambda x: abs(x[0] - e) if al == k1 else abs(x[1] - e))
                        s_raw = float(np.clip((a2 - a1) / max(t2 - t1, 1), 0.4, 2.5))
                        if {k1, k2} == {"top", "bottom"}:
                            amp = abs(self.lc[t2] - self.lc[t1]) / max(abs(self.lc[a2] - self.lc[a1]), 1e-6)
                for g, gw in gammas:
                    s = s_raw ** g
                    for o in OFFSETS:
                        a = e + s * max(d + o, 0)
                        if a >= T - 30 or a < 0:
                            continue
                        ai = int(round(a))
                        vr = self.vol365[T] / max(self.vol365[min(ai, self.n - 1)], 1e-6)
                        sc = np.sqrt(vr * amp) if amp else vr
                        sc = float(np.clip(sc, 0.2, 1.3))
                        x = a + s * t
                        ok = x <= T
                        if ok.sum() < 8:
                            continue
                        lcx = np.interp(x[ok], np.arange(self.n), self.lc)
                        la = np.interp(a, np.arange(self.n), self.lc)
                        p = np.full(H + 1, np.nan)
                        p[ok] = (lcx - la) * sc
                        st = (self.S_raw[min(ai, self.n - 1)] - self.S_raw[T]) / self.S_sd[T]
                        okf = ~np.isnan(st)
                        dist = np.sqrt(np.mean(st[okf] ** 2)) if okf.any() else 1.0
                        w = (self.align_w.get(al, 0) * gw * ((rank + 1) ** self.recency)
                             * np.exp(-0.5 * (o / 30.0) ** 2) * np.exp(-0.5 * (dist / self.bw) ** 2))
                        P.append(p)
                        W.append(w)
                        meta.append((al, e, rank, s, sc, o, g))
        if not P:
            return None, None, []
        return np.array(P), np.array(W), meta

    def quantiles(self, T: int, H: int = 365, aligns=ALIGNS) -> np.ndarray | None:
        P, W, _ = self.paths(T, H, aligns)
        if P is None:
            return None
        return weighted_day_quantiles(P, W, self.kappa)

    # interfaccia membro walk-forward
    def fit(self, ctx, h, end):
        return self

    def predict(self, ctx, h, idx):
        out = np.full((len(idx), 5), np.nan)
        for j, p in enumerate(idx):
            P, W, _ = self.paths(int(p), h)
            if P is None:
                continue
            q = weighted_day_quantiles(P[:, [h]], W, self.kappa)
            out[j] = q[0]
        return out, None


def weighted_day_quantiles(P: np.ndarray, W: np.ndarray, kappa: float = 1.0, min_w_frac: float = 0.15) -> np.ndarray:
    """Quantili pesati per ogni colonna (giorno); colonne con poca massa di peso disponibile -> NaN."""
    m, H1 = P.shape
    out = np.full((H1, 5), np.nan)
    tot = W.sum()
    for j in range(H1):
        v = P[:, j]
        ok = ~np.isnan(v)
        if not ok.any() or W[ok].sum() < min_w_frac * tot:
            continue
        vv, ww = v[ok], W[ok]
        o = np.argsort(vv)
        vv, ww = vv[o], ww[o]
        c = np.cumsum(ww) - 0.5 * ww
        c /= ww.sum()
        q = np.interp(QS, c, vv)
        if kappa != 1.0:
            q = q - (1 - kappa) * q[2]
        out[j] = q
    return out


def predict_multi(model: CycleModel, T: int, hs) -> dict[int, np.ndarray]:
    """Quantili del modello di ciclo a più orizzonti con un solo calcolo dei percorsi (per il walk-forward)."""
    H = max(hs)
    P, W, _ = model.paths(T, H)
    if P is None:
        return {}
    cols = P[:, list(hs)]
    q = weighted_day_quantiles(cols, W, model.kappa)
    return {h: q[i] for i, h in enumerate(hs) if not np.isnan(q[i]).any()}
