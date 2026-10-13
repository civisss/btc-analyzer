"""Calendario eventi e ciclo politico: reazione storica di BTC a eventi macro, politici e di mercato.

Tipi di evento (date passate + prossime):
  - politica: elezioni presidenziali USA (2012–2024), midterm (2014/2018/2022, prossime 3 nov 2026);
  - macro: FOMC (lista ufficiale riusata da analysis/timepivots), CPI (date BLS 2022–2025 note con certezza;
    le altre sono STIMATE con una regola e marcate "stimata"), NFP (regola BLS: terzo venerdì dopo la
    settimana che contiene il 12 del mese → "regola");
  - derivati: scadenze opzioni mensili/trimestrali (ultimo venerdì, Deribit 08:00 UTC; stesso giorno della
    scadenza dei futures CME mensili) — studio del gap CME del weekend riusato da timepivots;
  - ciclo: halving.
Per ogni tipo: variazione media/mediana di BTC e variazione assoluta (volatilità) nelle finestre ±1 giorno e
−7..+7 giorni, escursione massima (range), win rate, n, rapporto con la volatilità "normale" dello stesso periodo.
"""
from __future__ import annotations

import time

import numpy as np
import pandas as pd

from .. import util
from . import timepivots as tp
from .cycles import HALVINGS

DAY = pd.Timedelta(days=1)
MESI = tp.MESI

PRESIDENTIAL = ["2012-11-06", "2016-11-08", "2020-11-03", "2024-11-05"]
NEXT_PRESIDENTIAL = "2028-11-07"
MIDTERMS = ["2014-11-04", "2018-11-06", "2022-11-08", "2026-11-03"]

# Date di pubblicazione CPI (BLS) note con certezza. Fuori da questa lista le date sono STIMATE.
CPI_EXACT = [
    "2022-01-12", "2022-02-10", "2022-03-10", "2022-04-12", "2022-05-11", "2022-06-10", "2022-07-13", "2022-08-10",
    "2022-09-13", "2022-10-13", "2022-11-10", "2022-12-13",
    "2023-01-12", "2023-02-14", "2023-03-14", "2023-04-12", "2023-05-10", "2023-06-13", "2023-07-12", "2023-08-10",
    "2023-09-13", "2023-10-12", "2023-11-14", "2023-12-12",
    "2024-01-11", "2024-02-13", "2024-03-12", "2024-04-10", "2024-05-15", "2024-06-12", "2024-07-11", "2024-08-14",
    "2024-09-11", "2024-10-10", "2024-11-13", "2024-12-11",
    "2025-01-15", "2025-02-12", "2025-03-12", "2025-04-10", "2025-05-13", "2025-06-11", "2025-07-15", "2025-08-12",
    "2025-09-11", "2025-10-24", "2025-12-18",   # ott 2025: CPI di settembre ritardato dallo shutdown; CPI di ottobre annullato
]
CPI_EXACT_RANGE = ("2022-01-01", "2025-12-31")
# NFP: eccezioni note alla regola (shutdown USA autunno 2025). None = rilascio annullato.
NFP_OVERRIDES = {"2025-10-03": "2025-11-20", "2025-11-07": None, "2025-12-05": "2025-12-16"}

QUALITY_LABEL = {"esatta": "Data esatta", "regola": "Data da regola", "stimata": "Data stimata"}

TYPES = {
    # key: (label, categoria, qualità, descrizione, ora tipica)
    "election": ("Elezioni presidenziali USA", "politica", "esatta",
                 "Election Day (primo martedì dopo il primo lunedì di novembre). I risultati arrivano nella notte europea.", "us_night"),
    "midterm": ("Elezioni di metà mandato (midterm)", "politica", "esatta",
                "Rinnovo del Congresso a metà del mandato presidenziale.", "us_night"),
    "fomc": ("Riunione FOMC (Fed)", "macro", "esatta",
             "Decisione sui tassi della Federal Reserve: comunicato alle 14:00 ET, conferenza stampa alle 14:30 ET.", "fomc"),
    "cpi": ("Inflazione USA (CPI)", "macro", "esatta",
            "Indice dei prezzi al consumo (BLS), pubblicato alle 8:30 ET intorno a metà mese.", "data_830"),
    "nfp": ("Occupazione USA (NFP)", "macro", "regola",
            "Non-farm payrolls (BLS), pubblicati alle 8:30 ET, di solito il primo venerdì del mese.", "data_830"),
    "opex_month": ("Scadenza opzioni mensile", "derivati", "regola",
                   "Ultimo venerdì del mese, Deribit 08:00 UTC (stesso giorno dei futures CME mensili).", "deribit"),
    "opex_quarter": ("Scadenza opzioni trimestrale", "derivati", "regola",
                     "Ultimo venerdì di mar/giu/set/dic: la scadenza con l'open interest maggiore (Deribit 08:00 UTC).", "deribit"),
    "halving": ("Halving", "ciclo", "esatta", "Dimezzamento della ricompensa dei miner (ogni 210,000 blocchi).", None),
}


def rnd(x, d: int = 2):
    return tp.rnd(x, d)


# ------------------------------------------------------------------ date

def _ts(s: str) -> pd.Timestamp:
    return pd.Timestamp(s, tz="UTC")


def _us_dst(t: pd.Timestamp) -> bool:
    """Ora legale USA: dalla seconda domenica di marzo alla prima domenica di novembre."""
    y = t.year
    mar = pd.Timestamp(year=y, month=3, day=1, tz="UTC")
    start = mar + pd.Timedelta(days=(6 - mar.dayofweek) % 7 + 7)
    nov = pd.Timestamp(year=y, month=11, day=1, tz="UTC")
    end = nov + pd.Timedelta(days=(6 - nov.dayofweek) % 7)
    return start <= t.normalize() < end


def _et_hour_utc(t: pd.Timestamp, et_hour: float) -> pd.Timestamp:
    off = 4 if _us_dst(t) else 5
    return t.normalize() + pd.Timedelta(hours=et_hour + off)


def nfp_rule(year: int, month: int) -> pd.Timestamp:
    """Regola BLS: settimana di riferimento = quella (dom–sab) che contiene il 12 del mese PRECEDENTE;
    rilascio il terzo venerdì successivo. Festivi: 1 gen → +7 g, 4 lug → giovedì 3."""
    pm = pd.Timestamp(year=year, month=month, day=1, tz="UTC") - DAY
    d12 = pd.Timestamp(year=pm.year, month=pm.month, day=12, tz="UTC")
    sat = d12 + pd.Timedelta(days=(5 - d12.dayofweek) % 7)
    rel = sat + pd.Timedelta(days=6 + 14)
    if rel.month == 1 and rel.day == 1:
        rel += 7 * DAY
    if rel.month == 7 and rel.day == 4:
        rel -= DAY
    return rel


def nfp_dates(y0: int, y1: int) -> list[tuple[pd.Timestamp, str]]:
    out = []
    for y in range(y0, y1 + 1):
        for m in range(1, 13):
            t = nfp_rule(y, m)
            key = t.strftime("%Y-%m-%d")
            if key in NFP_OVERRIDES:
                alt = NFP_OVERRIDES[key]
                if alt is None:
                    continue
                out.append((_ts(alt), "esatta"))
            else:
                out.append((t, "regola"))
    return out


def cpi_rule(year: int, month: int) -> pd.Timestamp:
    """Stima: martedì–giovedì tra il 10 e il 15 del mese più vicino al 12 (a parità, il mercoledì)."""
    best = None
    for d in range(10, 16):
        t = pd.Timestamp(year=year, month=month, day=d, tz="UTC")
        if t.dayofweek not in (1, 2, 3):
            continue
        score = (abs(d - 12), 0 if t.dayofweek == 2 else 1)
        if best is None or score < best[0]:
            best = (score, t)
    return best[1]


def cpi_rule_accuracy() -> dict:
    exact = [_ts(s) for s in CPI_EXACT if not s.startswith("2025-1")]  # escluse le date spostate dallo shutdown
    diffs = [abs((cpi_rule(t.year, t.month) - t).days) for t in exact]
    return {"n": len(diffs), "exact": rnd(np.mean([d == 0 for d in diffs]) * 100, 0),
            "within_1": rnd(np.mean([d <= 1 for d in diffs]) * 100, 0), "within_3": rnd(np.mean([d <= 3 for d in diffs]) * 100, 0)}


def cpi_dates(y0: int, y1: int) -> list[tuple[pd.Timestamp, str]]:
    exact = {(_ts(s).year, _ts(s).month): _ts(s) for s in CPI_EXACT}
    lo, hi = _ts(CPI_EXACT_RANGE[0]), _ts(CPI_EXACT_RANGE[1])
    out = [(_ts(s), "esatta") for s in CPI_EXACT]
    for y in range(y0, y1 + 1):
        for m in range(1, 13):
            t = cpi_rule(y, m)
            if lo <= t <= hi or (y, m) in exact:
                continue
            out.append((t, "stimata"))
    return sorted(out)


def all_dates(now: pd.Timestamp) -> dict[str, list[tuple[pd.Timestamp, str]]]:
    y1 = now.year + 1
    opex = [(tp._last_friday(y, m), "regola") for y in range(2019, y1 + 1) for m in range(1, 13)]
    return {
        "election": [(_ts(s), "esatta") for s in PRESIDENTIAL + [NEXT_PRESIDENTIAL]],
        "midterm": [(_ts(s), "esatta") for s in MIDTERMS],
        "fomc": [(_ts(s), "esatta") for s in tp.FOMC_DATES],
        "cpi": cpi_dates(2016, y1),
        "nfp": nfp_dates(2016, y1),
        "opex_month": [x for x in opex if x[0].month not in (3, 6, 9, 12)],
        "opex_quarter": [x for x in opex if x[0].month in (3, 6, 9, 12)],
        "halving": [(t, "esatta") for _, t, _ in HALVINGS],
    }


# ------------------------------------------------------------------ statistiche

class Moves:
    """Metriche per ogni giorno p della griglia giornaliera (rendimenti close-to-close, %)."""

    def __init__(self, g: tp.DailyGrid):
        c, h, l = g.close, g.high, g.low
        n = len(c)
        self.g = g
        nan = np.full(n, np.nan)

        def ret(a: int, b: int) -> np.ndarray:   # c[p+b] / c[p+a] − 1
            out = nan.copy()
            lo, hi = max(0, -a), min(n, n - b)
            out[lo:hi] = (c[lo + b:hi + b] / c[lo + a:hi + a] - 1) * 100
            return out

        def rng(a: int, b: int) -> np.ndarray:   # max(high[p+a..p+b]) / min(low[..]) − 1
            out = nan.copy()
            s = pd.Series(h).rolling(b - a + 1).max().to_numpy()
            m = pd.Series(l).rolling(b - a + 1).min().to_numpy()
            lo, hi = max(0, -a), min(n, n - b)
            out[lo:hi] = (s[lo + b:hi + b] / m[lo + b:hi + b] - 1) * 100
            return out

        self.d1 = ret(-2, 1)      # ±1 g: chiusura d−2 → chiusura d+1 (candele d−1, d, d+1)
        self.d7 = ret(-8, 7)      # −7..+7 g: chiusura d−8 → chiusura d+7
        self.pre7 = ret(-8, -1)
        self.post7 = ret(-1, 7)
        self.r1 = rng(-1, 1)      # escursione high/low sulle 3 candele
        self.r7 = rng(-7, 7)
        idx = np.arange(n)
        self.path = {}
        for k in range(-7, 8):            # percorso: chiusura d+k rispetto alla chiusura di d−1
            a, b = idx + k, idx - 1
            ok = (a >= 0) & (a < n) & (b >= 0)
            arr = nan.copy()
            arr[ok] = (c[a[ok]] / c[b[ok]] - 1) * 100
            self.path[k] = arr

    def baseline(self, p0: int, p1: int) -> dict:
        sl = slice(max(0, p0), max(p0 + 1, p1 + 1))
        return {"abs_1d": float(np.nanmedian(np.abs(self.d1[sl]))), "abs_7d": float(np.nanmedian(np.abs(self.d7[sl]))),
                "range_1d": float(np.nanmedian(self.r1[sl])), "range_7d": float(np.nanmedian(self.r7[sl])),
                "up_1d": float(np.nanmean(self.d1[sl] > 0) * 100)}


def _win(vals: np.ndarray) -> dict:
    v = vals[np.isfinite(vals)]
    if not len(v):
        return {"avg": None, "median": None, "abs_avg": None, "abs_median": None, "win_rate": None, "n": 0}
    return {"avg": rnd(v.mean()), "median": rnd(np.median(v)), "abs_avg": rnd(np.abs(v).mean()),
            "abs_median": rnd(np.median(np.abs(v))), "win_rate": rnd((v > 0).mean() * 100, 1), "n": int(len(v))}


def type_stats(mv: Moves, key: str, dates: list[tuple[pd.Timestamp, str]], today: pd.Timestamp) -> dict | None:
    g = mv.g
    label, cat, quality, desc, _ = TYPES[key]
    use_q = {"esatta", "regola"} if key != "cpi" else {"esatta"}
    rows = []
    for t, q in dates:
        if q not in use_q:
            continue
        p = g.pos(t)
        if p - 8 < 0 or p + 7 > g.last or t + 7 * DAY > today:
            continue
        rows.append((t, p))
    if not rows:
        return None
    P = np.array([p for _, p in rows])
    base = mv.baseline(int(P.min()) - 30, int(P.max()) + 30)
    d1, d7, pre7, post7 = mv.d1[P], mv.d7[P], mv.pre7[P], mv.post7[P]
    r1, r7 = mv.r1[P], mv.r7[P]
    path = [{"day": k, "median": rnd(np.nanmedian(mv.path[k][P])), "mean": rnd(np.nanmean(mv.path[k][P]))} for k in range(-7, 8)]
    vr1 = float(np.nanmedian(np.abs(d1)) / base["abs_1d"]) if base["abs_1d"] else None
    vr7 = float(np.nanmedian(np.abs(d7)) / base["abs_7d"]) if base["abs_7d"] else None
    rr1 = float(np.nanmedian(r1) / base["range_1d"]) if base["range_1d"] else None
    rr7 = float(np.nanmedian(r7) / base["range_7d"]) if base["range_7d"] else None
    recent = [{"time": util.ts(t), "label": util.data_it(t), "d1": rnd(mv.d1[p], 1), "d7": rnd(mv.d7[p], 1),
               "post7": rnd(mv.post7[p], 1), "range_1d": rnd(mv.r1[p], 1)} for t, p in rows[-10:]][::-1]
    w1, w7 = _win(d1), _win(d7)
    n = len(rows)
    # nota in italiano
    vol_txt = ("più mosso del normale" if (vr1 or 1) >= 1.15 else "meno mosso del normale" if (vr1 or 1) <= 0.85 else "in linea con il normale")
    dir1 = w1["win_rate"] or 50
    note = (f"Su {n} eventi, nei 3 giorni attorno all'evento il movimento assoluto mediano di BTC è stato del {w1['abs_median']:.1f}% "
            f"({vol_txt}: ×{vr1:.2f} rispetto a 3 giorni qualsiasi dello stesso periodo); chiusura positiva nel {dir1:.0f}% dei casi. "
            f"Sulla finestra −7..+7 giorni variazione mediana {w7['median']:+.1f}%, positiva nel {w7['win_rate']:.0f}% dei casi.")
    if n < 8:
        note += f" Campione molto piccolo (n={n}): indicazione aneddotica, non statistica."
    return {
        "key": key, "label": label, "category": cat, "quality": quality, "quality_label": QUALITY_LABEL[quality],
        "description": desc, "n": n, "since": util.ts(rows[0][0]),
        "d1": w1, "d7": w7, "pre7": _win(pre7), "post7": _win(post7),
        "range_1d": rnd(np.nanmedian(r1)), "range_7d": rnd(np.nanmedian(r7)),
        "vol_ratio_1d": rnd(vr1), "vol_ratio_7d": rnd(vr7), "range_ratio_1d": rnd(rr1), "range_ratio_7d": rnd(rr7),
        "baseline": {k: rnd(v) for k, v in base.items()},
        "path": path, "recent": recent, "note": note,
    }


# ------------------------------------------------------------------ ciclo politico

def _year_type(y: int) -> tuple[str, str]:
    return [("presidential", "Anno presidenziale"), ("post", "Anno post-elettorale"),
            ("midterm", "Anno di midterm"), ("pre", "Anno pre-elettorale")][y % 4]


def political_cycle(g: tp.DailyGrid, today: pd.Timestamp, price: float) -> dict:
    c = pd.Series(g.close, index=g.idx)
    ye = c.groupby(c.index.year).last()
    years = []
    for y in ye.index:
        if y - 1 not in ye.index or y < 2011:
            continue
        r = (ye[y] / ye[y - 1] - 1) * 100
        k, lab = _year_type(int(y))
        years.append({"year": int(y), "type": k, "label": lab, "return": rnd(r, 1), "partial": bool(y == today.year),
                      "halving_year": bool(y % 4 == 0)})
    types = []
    for k, lab in [("presidential", "Anno presidenziale"), ("post", "Anno post-elettorale"),
                   ("midterm", "Anno di midterm"), ("pre", "Anno pre-elettorale")]:
        v = np.array([x["return"] for x in years if x["type"] == k and not x["partial"]], float)
        types.append({"type": k, "label": lab, "n": int(len(v)),
                      "avg": rnd(v.mean(), 1) if len(v) else None, "median": rnd(np.median(v), 1) if len(v) else None,
                      "win_rate": rnd((v > 0).mean() * 100, 0) if len(v) else None,
                      "years": [x["year"] for x in years if x["type"] == k and not x["partial"]],
                      "current": k == _year_type(today.year)[0]})

    def paths(dates: list[str], anchor_off: int, d0: int = -180, d1: int = 365, step: int = 3) -> list[dict]:
        out = []
        for s in dates:
            t = _ts(s)
            p = g.pos(t)
            pa = p + anchor_off
            if pa < 0 or pa > g.last or p + d0 < 0:
                continue
            base = g.close[pa]
            last_k = min(d1, g.last - p)
            ks = list(range(d0, last_k + 1, step))
            if ks and ks[-1] != last_k:
                ks.append(last_k)
            pts = [[k, rnd((g.close[p + k] / base - 1) * 100, 1)] for k in ks]
            out.append({"name": str(t.year), "time": util.ts(t), "current": False, "points": pts})
        return out

    # ---- midterm
    mt_next = _ts(MIDTERMS[-1])
    off_now = int((today.normalize() - mt_next).days)          # negativo prima del voto
    anchor = off_now if -180 <= off_now <= 365 else 0
    mt_paths = paths(MIDTERMS, anchor)
    past_mt = [p for p in mt_paths if p["name"] != str(mt_next.year)]
    mean_pts = []
    if past_mt:
        days_axis = [d for d, _ in past_mt[0]["points"]]
        for d in days_axis:
            vals = [dict(pp["points"]).get(d) for pp in past_mt]
            vals = [v for v in vals if v is not None]
            if len(vals) == len(past_mt):
                mean_pts.append([d, rnd(np.mean(vals), 1)])
    lows = []
    for s in MIDTERMS[:-1]:
        t = _ts(s)
        p = g.pos(t)
        a, b = max(0, p - 200), min(g.last, p + 120)
        i = a + int(np.argmin(g.low[a:b + 1]))
        ath = float(np.max(g.high[:i + 1]))
        fwd = (g.close[min(g.last, p + 365)] / g.close[p] - 1) * 100 if p + 365 <= g.last else None
        from_low = (g.close[min(g.last, i + 365)] / g.low[i] - 1) * 100 if i + 365 <= g.last else None
        lows.append({"year": t.year, "midterm": util.ts(t), "low_time": util.ts(g.idx[i]), "low_label": util.data_it(g.idx[i]),
                     "low_price": rnd(g.low[i], 0), "days_from_midterm": int(i - p), "drawdown_from_ath": rnd((g.low[i] / ath - 1) * 100, 1),
                     "midterm_price": rnd(g.close[p], 0), "fwd_365": rnd(fwd, 1), "low_to_365": rnd(from_low, 1)})
    fwd = [x["fwd_365"] for x in lows if x["fwd_365"] is not None]
    pre180 = []
    for s in MIDTERMS[:-1]:
        p = g.pos(_ts(s))
        if p - 180 >= 0:
            pre180.append((g.close[p] / g.close[p - 180] - 1) * 100)
    cur_pre = None
    p_now = g.last
    p_mt = g.pos(mt_next)
    if p_mt - 180 >= 0 and p_mt - 180 <= p_now:
        cur_pre = (g.close[p_now] / g.close[p_mt - 180] - 1) * 100
    mean_off = np.mean([x["days_from_midterm"] for x in lows]) if lows else None
    texts = [
        "Il ciclo politico USA è allineato a quello dell'halving: gli anni presidenziali coincidono con gli anni dell'halving "
        "(2012, 2016, 2020, 2024) e gli anni di midterm con il secondo anno dopo l'halving, storicamente quello del bear market. "
        "Con soli 3 casi non è possibile separare l'effetto politico da quello del ciclo di Bitcoin.",
    ]
    if lows:
        lw = ", ".join(f"{x['low_label']} ({x['days_from_midterm']:+d} g)" for x in lows)
        texts.append(f"I minimi di ciclo sono caduti vicino alle midterm: {lw} rispetto al voto "
                     f"(in media {mean_off:+.0f} giorni).")
    if fwd:
        texts.append(f"Nei 12 mesi dopo le midterm BTC è salito in {sum(v > 0 for v in fwd)} casi su {len(fwd)} "
                     f"(media {np.mean(fwd):+.0f}%).")
    if cur_pre is not None and pre180:
        texts.append(f"Negli ultimi 180 giorni prima del voto del 2026 BTC segna {cur_pre:+.1f}% "
                     f"(stesso tratto negli anni precedenti: media {np.mean(pre180):+.1f}%).")
    pres_paths = paths(PRESIDENTIAL, 0)
    for p in pres_paths:
        p["current"] = False
    for p in mt_paths:
        p["current"] = p["name"] == str(mt_next.year)
    return {
        "years": years, "year_types": types, "current_year_type": _year_type(today.year)[0],
        "midterm": {"next": util.ts(mt_next), "days_to": -off_now, "anchor_day": anchor,
                    "anchor_label": ("giorno del voto" if anchor == 0 else f"{abs(anchor)} giorni {'prima del' if anchor < 0 else 'dopo il'} voto"),
                    "paths": mt_paths, "mean": mean_pts, "lows": lows,
                    "pre180": {"avg": rnd(np.mean(pre180), 1) if pre180 else None, "current": rnd(cur_pre, 1)},
                    "fwd_365": {"avg": rnd(np.mean(fwd), 1) if fwd else None, "up": sum(v > 0 for v in fwd), "n": len(fwd)}},
        "presidential": {"next": util.ts(_ts(NEXT_PRESIDENTIAL)), "paths": pres_paths},
        "text": texts,
    }


# ------------------------------------------------------------------ prossimi eventi

def _time_info(key: str, t: pd.Timestamp) -> tuple[pd.Timestamp, str]:
    kind = TYPES[key][4]
    if kind == "fomc":
        tt = _et_hour_utc(t, 14)
        return tt, f"{tt.hour:02d}:00 UTC (comunicato), conferenza alle {tt.hour:02d}:30 UTC"
    if kind == "data_830":
        tt = _et_hour_utc(t, 8.5)
        return tt, f"{tt.hour:02d}:30 UTC"
    if kind == "deribit":
        return t.normalize() + pd.Timedelta(hours=8), "08:00 UTC (Deribit)"
    if kind == "us_night":
        tt = t.normalize() + pd.Timedelta(hours=24)
        return tt, "Spoglio nella notte tra il giorno del voto e il successivo (00:00–06:00 UTC)"
    return t.normalize(), "Data stimata dall'altezza dei blocchi" if key == "halving" else ""


def upcoming(stats: dict[str, dict], dates: dict, today: pd.Timestamp, horizon: int, price: float, cur_base: dict) -> list[dict]:
    out = []
    end = today + horizon * DAY
    for key, lst in dates.items():
        st = stats.get(key)
        for t, q in lst:
            if not (today <= t <= end):
                continue
            if key == "cpi" and q != "esatta":
                q = "stimata"
            tt, hour_txt = _time_info(key, t)
            vr1 = (st or {}).get("vol_ratio_1d")
            vr7 = (st or {}).get("vol_ratio_7d")
            exp1 = vr1 * cur_base["abs_1d"] if vr1 else None
            exp7 = vr7 * cur_base["abs_7d"] if vr7 else None
            imp = "alta" if key in ("fomc", "cpi", "midterm", "election", "opex_quarter", "halving") else "media" if key in ("nfp", "opex_month") else "bassa"
            if vr1 and vr1 >= 1.25 and imp == "media":
                imp = "alta"
            title = TYPES[key][0]
            if key in ("cpi", "nfp"):
                ref = (t - pd.DateOffset(months=1))
                title = f"{'CPI' if key == 'cpi' else 'NFP'} di {MESI[ref.month - 1]}"
            elif key == "opex_quarter":
                title = f"Scadenza trimestrale opzioni Q{(t.month - 1) // 3 + 1}"
            elif key == "opex_month":
                title = f"Scadenza opzioni di {MESI[t.month - 1]}"
            elif key == "fomc":
                title = "Decisione FOMC sui tassi"
            elif key == "midterm":
                title = f"Elezioni di midterm USA {t.year}"
            text = ""
            if st:
                text = (f"Storicamente (n={st['n']}) il movimento assoluto mediano di BTC nei 3 giorni attorno all'evento è stato del {st['d1']['abs_median']:.1f}% "
                        f"(×{(vr1 or 1):.2f} rispetto al normale) e ha chiuso in rialzo nel {st['d1']['win_rate']:.0f}% dei casi.")
                if exp1:
                    text += f" Con la volatilità attuale ci si può attendere un movimento di circa ±{exp1:.1f}% (±${price * exp1 / 100:,.0f})."
            if q == "stimata":
                text += " Data stimata: verificare il calendario ufficiale BLS."
            out.append({
                "id": f"{key}:{t.strftime('%Y-%m-%d')}", "key": key, "type_label": TYPES[key][0], "category": TYPES[key][1],
                "title": title, "time": util.ts(tt), "date": util.ts(t), "date_label": util.data_it(t), "hour": hour_txt,
                "days_away": int((t.normalize() - today.normalize()).days), "quality": q, "quality_label": QUALITY_LABEL[q],
                "importance": imp,
                "expected_abs_1d": rnd(exp1), "expected_abs_7d": rnd(exp7),
                "expected_usd_1d": rnd(price * exp1 / 100, 0) if exp1 else None,
                "hist_abs_1d": (st or {}).get("d1", {}).get("abs_median"), "vol_ratio_1d": rnd(vr1), "vol_ratio_7d": rnd(vr7),
                "up_rate_1d": (st or {}).get("d1", {}).get("win_rate"), "up_rate_7d": (st or {}).get("d7", {}).get("win_rate"),
                "n": (st or {}).get("n", 0), "text": text,
            })
    out.sort(key=lambda x: x["time"])
    return out


def later_major(today: pd.Timestamp, horizon: int) -> list[dict]:
    out = []
    end = today + horizon * DAY
    try:
        from ..routers.cycles import _next_halving
        eta, _, _ = _next_halving()
    except Exception:  # noqa: BLE001
        eta = HALVINGS[-1][1] + pd.Timedelta(seconds=210_000 * 600)
    for key, t, title, q in [("halving", pd.Timestamp(eta).tz_convert("UTC") if pd.Timestamp(eta).tzinfo else pd.Timestamp(eta, tz="UTC"), "Prossimo halving (stima)", "stimata"),
                             ("election", _ts(NEXT_PRESIDENTIAL), "Elezioni presidenziali USA 2028", "esatta")]:
        if t > end:
            out.append({"key": key, "title": title, "time": util.ts(t), "date_label": util.data_it(t),
                        "days_away": int((t.normalize() - today.normalize()).days), "quality": q, "quality_label": QUALITY_LABEL[q]})
    return out


# ------------------------------------------------------------------ build

def build(g: tp.DailyGrid, now: pd.Timestamp, price: float | None, horizon: int = 90, weekend: dict | None = None) -> dict:
    today = now.normalize()
    mv = Moves(g)
    dates = all_dates(now)
    stats = {}
    for key, lst in dates.items():
        st = type_stats(mv, key, lst, today)
        if st:
            stats[key] = st
    price = float(price or g.close[-1])
    p_now = g.last
    cur_base = mv.baseline(p_now - 98, p_now - 8)       # volatilità "normale" degli ultimi ~90 giorni (finestre complete)
    up = upcoming(stats, dates, today, horizon, price, cur_base)
    acc = cpi_rule_accuracy()
    pol = political_cycle(g, today, price)
    order = ["fomc", "cpi", "nfp", "opex_month", "opex_quarter", "midterm", "election", "halving"]
    types = [stats[k] for k in order if k in stats]
    return {
        "generated_at": int(time.time()), "today": util.ts(today), "price": price, "horizon": horizon,
        "types": types, "upcoming": up, "later": later_major(today, horizon),
        "political": pol,
        "cme_gap": weekend,
        "baseline_now": {k: rnd(v) for k, v in cur_base.items()},
        "quality": {
            "cpi_rule_accuracy": acc,
            "notes": [
                "FOMC, elezioni e halving: date esatte (calendario ufficiale Fed 2017–2026, Election Day, blocchi).",
                f"CPI: date esatte BLS da gen 2022 a dic 2025 (le uniche usate nelle statistiche); le altre sono stimate con una regola "
                f"(mar–gio tra il 10 e il 15 più vicino al 12) che sulle date note coincide nel {acc['exact']:.0f}% dei casi ed entro ±1 giorno nel {acc['within_1']:.0f}%.",
                "NFP: date da regola BLS (terzo venerdì dopo la settimana che contiene il 12 del mese precedente), con le eccezioni note dello shutdown 2025; "
                "possibili scostamenti di una settimana in casi rari.",
                "Scadenze opzioni: ultimo venerdì del mese (Deribit 08:00 UTC), regola senza eccezioni note.",
            ],
        },
        "method": ("Rendimenti close-to-close sulle candele giornaliere UTC. ±1 g = dalla chiusura di d−2 alla chiusura di d+1 "
                   "(le tre candele attorno all'evento); −7..+7 g = dalla chiusura di d−8 alla chiusura di d+7. Escursione = massimo/minimo "
                   "delle stesse candele. Il rapporto di volatilità confronta la mediana dei movimenti assoluti negli eventi con la mediana di "
                   "tutti i giorni dello stesso periodo; la volatilità attesa dei prossimi eventi = rapporto storico × volatilità degli ultimi 90 giorni. "
                   "Win rate = % di finestre chiuse in rialzo. Eventi sovrapposti (es. CPI e FOMC nella stessa settimana) non sono separati."),
    }
