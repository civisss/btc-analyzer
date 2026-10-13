"""Calendari astronomici per lo studio "Astronomia e numeri".

Motore: Astronomy Engine (Don Cross, MIT, `astronomy-engine` su PyPI, puro Python): VSOP87 troncato per i pianeti,
teoria lunare di Chapront/ELP troncata, nutazione IAU2000B — accuratezza dichiarata ±1 minuto d'arco.
Nessun download di effemeridi a runtime. Ogni calendario è stato confrontato con una seconda fonte indipendente
(USNO, catalogo NASA delle eclissi, JPL Horizons): gli scarti misurati sono in `astro_verification.json`.

Definizioni (dichiarate anche in pagina):
  - fasi lunari: istante in cui la longitudine eclittica apparente geocentrica della Luna supera quella del Sole
    di 0° (nuova), 90° (primo quarto), 180° (piena), 270° (ultimo quarto);
  - superluna: luna piena con distanza geocentrica centro-centro < 360,000 km (definizione usata da timeanddate);
  - eclissi: istante di massimo e tipo (penombrale/parziale/totale per la Luna, parziale/anulare/totale per il Sole;
    le ibride risultano totali o anulari a seconda della geometria al massimo);
  - Mercurio retrogrado: periodo tra la stazione retrograda e la stazione diretta della longitudine eclittica
    apparente geocentrica (eclittica vera della data), cioè tra due cambi di segno della velocità apparente;
  - equinozi/solstizi: longitudine apparente del Sole = 0°, 90°, 180°, 270°.
Tutti gli istanti sono in UTC.
"""
from __future__ import annotations

import functools
import math

import astronomy as ae
import numpy as np
import pandas as pd

J2000 = pd.Timestamp("2000-01-01 12:00", tz="UTC")
SUPERMOON_KM = 360_000
QUARTER_KEYS = ["new", "first_quarter", "full", "last_quarter"]
ECLIPSE_KIND = {ae.EclipseKind.Penumbral: "penumbral", ae.EclipseKind.Partial: "partial",
                ae.EclipseKind.Annular: "annular", ae.EclipseKind.Total: "total"}
SYNODIC = 29.530588853


def to_time(t: pd.Timestamp) -> ae.Time:
    t = pd.Timestamp(t)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return ae.Time((t - J2000).total_seconds() / 86400.0)


def to_ts(t: ae.Time) -> pd.Timestamp:
    return (J2000 + pd.Timedelta(days=t.ut)).round("s")


def moon_distance_km(t: ae.Time) -> float:
    return ae.GeoMoon(t).Length() * ae.KM_PER_AU


# ------------------------------------------------------------------ fasi lunari

@functools.lru_cache(maxsize=8)
def moon_quarters(y0: int, y1: int) -> pd.DataFrame:
    """Tutte le fasi principali tra il 1° gennaio y0 e il 31 dicembre y1 (UTC)."""
    rows = []
    mq = ae.SearchMoonQuarter(to_time(pd.Timestamp(f"{y0}-01-01", tz="UTC")))
    end = pd.Timestamp(f"{y1 + 1}-01-01", tz="UTC")
    while True:
        t = to_ts(mq.time)
        if t >= end:
            break
        dist = moon_distance_km(mq.time) if mq.quarter in (0, 2) else None
        rows.append({"time": t, "quarter": mq.quarter, "key": QUARTER_KEYS[mq.quarter], "distance_km": dist})
        mq = ae.NextMoonQuarter(mq)
    df = pd.DataFrame(rows)
    df["supermoon"] = (df["key"] == "full") & (df["distance_km"].fillna(1e9) < SUPERMOON_KM)
    return df


def moon_now(now: pd.Timestamp) -> dict:
    """Stato della Luna a un istante: illuminazione, angolo di fase, elongazione, età, distanza."""
    t = to_time(now)
    ill = ae.Illumination(ae.Body.Moon, t)
    elong = ae.MoonPhase(t)   # 0 = nuova, 90 = primo quarto, 180 = piena, 270 = ultimo quarto
    # luna nuova precedente: la cerco in avanti partendo ~2 giorni prima della stima dall'elongazione
    approx = elong / 360.0 * SYNODIC
    prev_new = ae.SearchMoonPhase(0.0, t.AddDays(-approx - 2.5), 5)
    age = (t.ut - prev_new.ut) if prev_new is not None and prev_new.ut <= t.ut else approx
    return {"time": now, "illum": ill.phase_fraction, "phase_angle": ill.phase_angle, "elongation": elong,
            "age_days": age, "distance_km": moon_distance_km(t), "waxing": elong < 180,
            "phase": phase_key(elong)}


def phase_key(elong: float) -> str:
    """Nome della fase dall'elongazione (gradi), con tolleranza di ±6.1° (≈ 12 ore) per le 4 fasi principali."""
    e = elong % 360
    for c, k in ((0, "new"), (90, "first_quarter"), (180, "full"), (270, "last_quarter"), (360, "new")):
        if abs(e - c) <= 6.1:
            return k
    if e < 90:
        return "waxing_crescent"
    if e < 180:
        return "waxing_gibbous"
    if e < 270:
        return "waning_gibbous"
    return "waning_crescent"


def elongation_daily(days: pd.DatetimeIndex) -> np.ndarray:
    """Elongazione Luna−Sole a mezzogiorno UTC di ogni giorno (gradi 0..360)."""
    return np.array([ae.MoonPhase(to_time(d + pd.Timedelta(hours=12))) for d in days])


# ------------------------------------------------------------------ eclissi

@functools.lru_cache(maxsize=8)
def lunar_eclipses(y0: int, y1: int) -> list[dict]:
    out = []
    e = ae.SearchLunarEclipse(to_time(pd.Timestamp(f"{y0}-01-01", tz="UTC")))
    end = pd.Timestamp(f"{y1 + 1}-01-01", tz="UTC")
    while to_ts(e.peak) < end:
        out.append({"time": to_ts(e.peak), "kind": ECLIPSE_KIND.get(e.kind, "partial"),
                    "obscuration": float(e.obscuration), "total_min": float(e.sd_total) * 2,
                    "partial_min": float(e.sd_partial) * 2, "distance_km": moon_distance_km(e.peak)})
        e = ae.NextLunarEclipse(e.peak)
    return out


# Classificazione NASA (catalogo Espenak) dove differisce dal tipo al massimo calcolato: ibride e l'anulare non centrale 2014
NASA_SOLAR_KIND = {"2013-11-03": "hybrid", "2014-04-29": "annular", "2023-04-20": "hybrid"}


@functools.lru_cache(maxsize=8)
def solar_eclipses(y0: int, y1: int) -> list[dict]:
    out = []
    e = ae.SearchGlobalSolarEclipse(to_time(pd.Timestamp(f"{y0}-01-01", tz="UTC")))
    end = pd.Timestamp(f"{y1 + 1}-01-01", tz="UTC")
    while to_ts(e.peak) < end:
        lat = None if e.latitude is None or (isinstance(e.latitude, float) and math.isnan(e.latitude)) else float(e.latitude)
        lon = None if e.longitude is None or (isinstance(e.longitude, float) and math.isnan(e.longitude)) else float(e.longitude)
        t = to_ts(e.peak)
        out.append({"time": t, "kind": NASA_SOLAR_KIND.get(t.strftime("%Y-%m-%d"), ECLIPSE_KIND.get(e.kind, "partial")),
                    "obscuration": None if e.obscuration is None or math.isnan(e.obscuration) else float(e.obscuration),
                    "lat": lat, "lon": lon})
        e = ae.NextGlobalSolarEclipse(e.peak)
    return out


# ------------------------------------------------------------------ stagioni

@functools.lru_cache(maxsize=8)
def seasons(y0: int, y1: int) -> list[dict]:
    out = []
    for y in range(y0, y1 + 1):
        s = ae.Seasons(y)
        for key, t in (("mar_equinox", s.mar_equinox), ("jun_solstice", s.jun_solstice),
                       ("sep_equinox", s.sep_equinox), ("dec_solstice", s.dec_solstice)):
            out.append({"time": to_ts(t), "key": key})
    return out


# ------------------------------------------------------------------ Mercurio retrogrado

def mercury_lon(t: ae.Time) -> float:
    """Longitudine eclittica apparente geocentrica di Mercurio (eclittica vera della data), gradi."""
    return ae.Ecliptic(ae.GeoVector(ae.Body.Mercury, t, True)).elon


def _mercury_speed(ut: float, h: float = 1 / 24) -> float:
    a = mercury_lon(ae.Time(ut - h))
    b = mercury_lon(ae.Time(ut + h))
    d = (b - a + 540) % 360 - 180
    return d / (2 * h)


@functools.lru_cache(maxsize=8)
def mercury_stations(y0: int, y1: int) -> list[dict]:
    """Stazioni di Mercurio: kind 'retro' (inizio retrogrado) o 'direct' (fine retrogrado), istante raffinato per bisezione."""
    t0 = to_time(pd.Timestamp(f"{y0}-01-01", tz="UTC")).ut
    t1 = to_time(pd.Timestamp(f"{y1 + 1}-01-01", tz="UTC")).ut
    uts = np.arange(t0, t1 + 1, 1.0)
    lon = np.array([mercury_lon(ae.Time(u)) for u in uts])
    d = (np.diff(lon) + 540) % 360 - 180            # moto giornaliero (gradi/giorno)
    out = []
    for i in range(1, len(d)):
        if np.sign(d[i]) == np.sign(d[i - 1]) or d[i] == 0:
            continue
        # il cambio di segno della velocità è tra uts[i-1]+0.5 e uts[i]+0.5 (centri degli intervalli)
        lo, hi = uts[i - 1] - 0.5, uts[i] + 1.5
        s_lo = _mercury_speed(lo)
        for _ in range(40):
            mid = (lo + hi) / 2
            s_mid = _mercury_speed(mid)
            if np.sign(s_mid) == np.sign(s_lo):
                lo, s_lo = mid, s_mid
            else:
                hi = mid
        ut = (lo + hi) / 2
        out.append({"time": to_ts(ae.Time(ut)), "kind": "retro" if d[i] < 0 else "direct", "lon": mercury_lon(ae.Time(ut))})
    return out


def mercury_periods(y0: int, y1: int) -> list[dict]:
    st = mercury_stations(y0, y1)
    out = []
    for a, b in zip(st, st[1:]):
        if a["kind"] == "retro" and b["kind"] == "direct":
            out.append({"start": a["time"], "end": b["time"], "lon_start": a["lon"], "lon_end": b["lon"]})
    return out


# ------------------------------------------------------------------ date numeriche

def friday13(y0: int, y1: int) -> list[pd.Timestamp]:
    out = []
    for y in range(y0, y1 + 1):
        for m in range(1, 13):
            d = pd.Timestamp(year=y, month=m, day=13, tz="UTC")
            if d.weekday() == 4:
                out.append(d)
    return out
