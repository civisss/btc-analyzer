"""Pattern da immagine: estrae le candele da uno screenshot (TradingView e simili) e cerca nello storico di BTC
le finestre graficamente più simili, su uno o più timeframe, con lo stesso motore visivo degli Analoghi.

Estrazione (deterministica, solo numpy + Pillow + scipy.ndimage, l'immagine non viene mai salvata):
  1. sfondo = colore più frequente (tema scuro/chiaro); HSV vettoriale;
  2. classi di colore: rialzo = tonalità verde/turchese (75°–200°), ribasso = rosso/rosa (330°–22°), con soglie di
     saturazione e croma; per ogni classe il colore "pieno" delle candele è il cluster frequente più lontano dallo
     sfondo: i pixel più vicini allo sfondo (volumi in trasparenza, anti-aliasing, watermark) vengono scartati;
  3. pulizia: righe sottili orizzontali (linea dell'ultimo prezzo, medie mobili dello stesso colore), componenti
     di testo (legenda OHLC colorata: glifi allineati sulla stessa riga), etichette di prezzo sull'asse (rettangoli
     pieni), barre di volume in un pannello separato (barre ancorate a una base comune);
  4. componenti connesse → candele: corpo = righe la cui estensione orizzontale copre ≥ 60% della larghezza,
     ombre = estremi verticali; passo regolare stimato dalla mediana delle distanze, buchi riempiti;
  5. fallback "grafico a linee": linea saturata dominante → serie di chiusure.
Ricerca: la figura è senza scala (pixel), quindi la si confronta in log-prezzo z-normalizzato (forma, invariante
alla scala) e, per le componenti che dipendono dall'ampiezza, la si calibra sull'escursione di ciascun candidato. Somiglianza = 85% grafica + 15% struttura (R², posizione nel range, HH/HL, retest).
"""
from __future__ import annotations

import io
import logging
import math
import time

import numpy as np
from PIL import Image, UnidentifiedImageError
from scipy import ndimage as ndi

from . import analogs as an
from . import analogs_visual as vis
from . import fractals as fr

log = logging.getLogger("image_pattern")

MAX_BYTES = 8 * 1024 * 1024
MAX_CANDLES = 300
MIN_CANDLES = 12
MAX_PIXELS = 9_000_000          # oltre: ridimensionamento (es. screenshot 4K/5K)
MIN_W, MIN_H = 200, 120
W_VISUAL = 0.85
TFS = an.TFS


class ImageError(ValueError):
    """Errore dell'immagine con messaggio in italiano per l'utente (HTTP 422)."""


# ================================================================== decodifica

def decode(data: bytes) -> np.ndarray:
    if not data:
        raise ImageError("Nessuna immagine ricevuta.")
    if len(data) > MAX_BYTES:
        raise ImageError(f"Immagine troppo grande ({len(data) / 1048576:.1f} MB): il limite è 8 MB.")
    try:
        im = Image.open(io.BytesIO(data))
        fmt = (im.format or "").upper()
        if fmt not in ("PNG", "JPEG", "WEBP", "MPO"):
            raise ImageError("Formato non supportato: carica un'immagine PNG, JPG o WEBP.")
        if im.width * im.height > 60_000_000:
            raise ImageError("Immagine con troppi pixel: ritaglia o riduci lo screenshot.")
        im.load()
    except ImageError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as e:
        raise ImageError("Immagine non leggibile: carica un file PNG, JPG o WEBP valido.") from e
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    return np.asarray(im.convert("RGB"), dtype=np.uint8)


# ================================================================== colore

def _hsv(a: np.ndarray):
    f = a.astype(np.float32) / 255.0
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    mx = f.max(-1)
    mn = f.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    rm = nz & (mx == r)
    gm = nz & (mx == g) & ~rm
    bm = nz & ~rm & ~gm
    h[rm] = np.mod((g - b)[rm] / d[rm], 6.0)
    h[gm] = (b - r)[gm] / d[gm] + 2.0
    h[bm] = (r - g)[bm] / d[bm] + 4.0
    h *= 60.0
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0.0)
    return h, s, mx, d


def _background(a: np.ndarray) -> np.ndarray:
    q = (a >> 4).astype(np.int32)
    code = (q[..., 0] << 8) | (q[..., 1] << 4) | q[..., 2]
    cnt = np.bincount(code.ravel(), minlength=4096)
    top = int(np.argmax(cnt))
    sel = code == top
    return a[sel].mean(axis=0)


def _hex(c) -> str:
    c = np.clip(np.round(np.asarray(c, float)), 0, 255).astype(int)
    return "#%02x%02x%02x" % tuple(c)


def _class_mask(a: np.ndarray, cls: np.ndarray, bg: np.ndarray) -> tuple[np.ndarray, np.ndarray | None, np.ndarray]:
    """Pixel della classe con il colore 'pieno' delle candele. Ritorna (mask_candele, colore, mask_scartati)."""
    if cls.sum() < 30:
        return np.zeros(cls.shape, bool), None, np.zeros(cls.shape, bool)
    px = a[cls].astype(np.int32)
    q = px >> 3
    code = (q[:, 0] << 10) | (q[:, 1] << 5) | q[:, 2]
    u, inv, cnt = np.unique(code, return_inverse=True, return_counts=True)
    ok = cnt >= max(12, 0.12 * cnt.max())
    inv = inv.ravel()
    means = np.stack([np.bincount(inv, weights=px[:, j], minlength=len(u)) for j in range(3)], axis=1) / cnt[:, None]
    dists = np.abs(means - bg[None, :]).sum(1)
    dists[~ok] = -1
    k = int(np.argmax(dists))
    best, best_d = means[k], float(dists[k])
    if best_d <= 0:
        return np.zeros(cls.shape, bool), None, np.zeros(cls.shape, bool)
    dist_rep = np.abs(px - best[None, :]).sum(-1)
    dist_bg = np.abs(px - bg[None, :]).sum(-1)
    tol = max(60.0, 0.36 * best_d)
    m = np.zeros(cls.shape, bool)
    m[cls] = (dist_rep <= tol) & (dist_rep < dist_bg)
    return m, best, cls & ~m


# ================================================================== pulizia maschere

def _remove_thin_lines(m: np.ndarray, body_w: float) -> np.ndarray:
    """Toglie le strutture orizzontali sottili (≤ 2 px): linea dell'ultimo prezzo, medie dello stesso colore."""
    if not m.any():
        return m
    thick = ndi.binary_opening(m, structure=np.ones((3, 1), bool))
    thin = m & ~thick
    if not thin.any():
        return m
    out = m.copy()
    W = m.shape[1]
    # righe con molti pixel sottili sparsi su gran parte della larghezza (linea tratteggiata / continua)
    line_rows = np.zeros(m.shape[0], bool)
    for r in np.where(thin.sum(1) >= max(10, 0.12 * W))[0]:
        xs = np.where(thin[r])[0]
        line_rows[r] = xs.size > 0 and xs.max() - xs.min() >= 0.45 * W
    # ogni tratto sottile: quante "ombre" (pixel spessi adiacenti, in gruppi di colonne distinti) tocca?
    # doji e corpi sottili toccano la propria ombra; tratti di linea non toccano nulla o solo le candele agli estremi
    thick_d = ndi.binary_dilation(thick, structure=np.ones((3, 3), bool))
    lim = max(10, int(2.5 * body_w))
    lab, n = ndi.label(thin, structure=np.ones((3, 3), bool))
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        comp = lab[sl] == i
        cols = np.where((comp & thick_d[sl]).any(0))[0]
        clusters = int(cols.size and 1 + np.sum(np.diff(cols) > 1))
        rows_c = np.where(comp.any(1))[0] + sl[0].start
        on_line = bool(line_rows[rows_c].any())
        wide = (sl[1].stop - sl[1].start) > lim
        if (on_line and clusters == 0) or (wide and clusters <= 2):
            out[sl][comp] = False
    return out


def _components(m: np.ndarray, bull: bool) -> list[dict]:
    lab, n = ndi.label(m, structure=np.ones((3, 3), bool))
    out = []
    if not n:
        return out
    for i, s in enumerate(ndi.find_objects(lab), 1):
        if s is None:
            continue
        sub = lab[s] == i
        cnt = int(sub.sum())
        if cnt < 3:
            continue
        y0, x0 = s[0].start, s[1].start
        out.append({"x0": x0, "x1": s[1].stop - 1, "y0": y0, "y1": s[0].stop - 1, "n": cnt, "bull": bull, "sub": sub})
    return out


def _text_groups(comps: list[dict]) -> set[int]:
    """Indici dei componenti che formano righe di testo (glifi allineati con stesso top/bottom, vicini)."""
    small = [i for i, c in enumerate(comps) if 5 <= c["y1"] - c["y0"] + 1 <= 26 and c["x1"] - c["x0"] + 1 <= 16]
    # un pezzo di candela ha quasi sempre un altro pezzo (corpo/ombra) subito sopra o sotto: non è testo
    def stacked(c: dict) -> bool:
        for o in comps:
            if o is c or o["x1"] < c["x0"] or o["x0"] > c["x1"]:
                continue
            if -4 <= o["y0"] - c["y1"] <= 4 or -4 <= c["y0"] - o["y1"] <= 4:
                return True
        return False
    def candle_like(c: dict) -> bool:
        """Corpo pieno + ombra centrata sopra o sotto: è una candela, non un glifo."""
        sub = c["sub"]
        h, w = sub.shape
        if w < 3:
            return False
        anyr = sub.any(1)
        first = np.argmax(sub, axis=1)
        last = w - 1 - np.argmax(sub[:, ::-1], axis=1)
        span = np.where(anyr, last - first + 1, 0)
        body = span >= max(2, 0.6 * w)
        if not body.any():
            return False
        mid = (w - 1) / 2
        for rows in (np.arange(0, int(np.argmax(body))), np.arange(h - 1, h - 1 - int(np.argmax(body[::-1])), -1)):
            if rows.size and all(span[r] <= max(2, 0.4 * w) and abs((first[r] + last[r]) / 2 - mid) <= 1.5 for r in rows if anyr[r]):
                return True
        return False
    small = [i for i in small if not stacked(comps[i]) and not candle_like(comps[i])]
    drop: set[int] = set()
    buckets: dict[tuple[int, int], list[int]] = {}
    for i in small:
        c = comps[i]
        buckets.setdefault((c["y0"] // 2, c["y1"] // 2), []).append(i)
    # unisci bucket adiacenti (tolleranza 1-2 px)
    keys = sorted(buckets)
    for key in keys:
        grp = []
        for dy0 in (-1, 0, 1):
            for dy1 in (-1, 0, 1):
                grp += buckets.get((key[0] + dy0, key[1] + dy1), [])
        grp = sorted(set(grp), key=lambda i: comps[i]["x0"])
        if len(grp) < 3:
            continue
        h = np.median([comps[i]["y1"] - comps[i]["y0"] + 1 for i in grp])
        run = [grp[0]]
        for i in grp[1:]:
            if comps[i]["x0"] - comps[run[-1]]["x1"] <= max(3, 1.2 * h):
                run.append(i)
            else:
                if len(run) >= 3:
                    drop.update(run)
                run = [i]
        if len(run) >= 3:
            drop.update(run)
    return drop


# ================================================================== candele

def _candle_from(c: dict, xa: int | None = None, xb: int | None = None) -> dict | None:
    sub = c["sub"]
    if xa is not None:
        sub = sub[:, xa:xb]
    cols = np.where(sub.any(0))[0]
    rows = np.where(sub.any(1))[0]
    if not cols.size or not rows.size:
        return None
    sub = sub[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    ox = c["x0"] + (xa or 0) + cols[0]
    oy = c["y0"] + rows[0]
    h, w = sub.shape
    if w >= 3:
        span = np.zeros(h)
        anyr = sub.any(1)
        first = np.argmax(sub, axis=1)
        last = w - 1 - np.argmax(sub[:, ::-1], axis=1)
        span[anyr] = (last - first + 1)[anyr]
        body = np.where(span >= max(2, 0.6 * w))[0]
        if not body.size:
            body = np.array([int(np.argmax(span))])
        bt, bb = int(body[0]), int(body[-1])
    else:
        bt, bb = 0, h - 1
    top, bot = oy, oy + h - 1
    b_top, b_bot = oy + bt, oy + bb
    if c["bull"]:
        yo, yc = b_bot + 0.5, b_top + 0.5
    else:
        yo, yc = b_top + 0.5, b_bot + 0.5
    if b_top == b_bot:  # doji: corpo di 1 px
        yo = yc = b_top + 0.5
    return {"x0": int(ox), "x1": int(ox + w - 1), "xc": ox + (w - 1) / 2, "y_high": float(top), "y_low": float(bot + 1),
            "y_open": float(yo), "y_close": float(yc), "bull": bool(c["bull"]), "filled": True, "n": int(sub.sum())}


def _likeness(d: dict, w_med: float) -> float:
    """Quanto un candidato somiglia a una candela: larghezza pari al corpo tipico, molti pixel."""
    w = d["x1"] - d["x0"] + 1
    return d["n"] * (1.0 if abs(w - w_med) <= max(2.0, 0.2 * w_med) else 0.25)


def _bodies_from(c: dict, w_med: float, pitch: float) -> list[dict]:
    """Componente con poco riempimento (candele attraversate da una linea dello stesso colore): tiene solo i corpi
    (sopravvivono a un'apertura orizzontale larga quanto ~60% del corpo) e ricostruisce le ombre sulla colonna centrale."""
    sub = c["sub"]
    kb = max(2, int(round(0.6 * w_med)))
    B = ndi.binary_opening(sub, structure=np.ones((1, kb), bool))
    lab, n = ndi.label(B, structure=np.ones((3, 3), bool))
    out = []
    for i, s in enumerate(ndi.find_objects(lab), 1):
        if s is None:
            continue
        bx0, bx1 = s[1].start, s[1].stop - 1
        by0, by1 = s[0].start, s[0].stop - 1
        bw = bx1 - bx0 + 1
        if bw < 0.7 * w_med or bw > 1.5 * w_med + 1:
            continue  # tratti di linea quasi orizzontali, non corpi
        k = 1
        edges = np.linspace(bx0, bx1 + 1, k + 1).round().astype(int)
        for a0, b0 in zip(edges[:-1], edges[1:]):
            xc = int((a0 + b0 - 1) // 2)
            col = sub[:, xc]
            top, bot = by0, by1
            while top > 0 and col[top - 1]:
                top -= 1
            while bot < sub.shape[0] - 1 and col[bot + 1]:
                bot += 1
            yb0, yb1 = c["y0"] + by0, c["y0"] + by1
            yo, yc = ((yb1 + 0.5, yb0 + 0.5) if c["bull"] else (yb0 + 0.5, yb1 + 0.5))
            out.append({"x0": int(c["x0"] + a0), "x1": int(c["x0"] + b0 - 1), "xc": c["x0"] + (a0 + b0 - 1) / 2,
                        "y_high": float(c["y0"] + top), "y_low": float(c["y0"] + bot + 1), "y_open": float(yo), "y_close": float(yc),
                        "bull": bool(c["bull"]), "filled": True, "n": int(B[s].sum())})
    return out


def _extract_candles(a: np.ndarray, bg: np.ndarray, warnings: list[str]) -> dict | None:
    h_, s_, v_, d_ = _hsv(a)
    dark = float(bg.mean()) < 128
    sat_ok = (s_ >= 0.25) & (d_ >= 0.16) & (v_ >= 0.22)
    up_cls = sat_ok & (h_ >= 75) & (h_ <= 200)
    dn_cls = sat_ok & ((h_ >= 330) | (h_ <= 22))
    m_up, col_up, rest_up = _class_mask(a, up_cls, bg)
    m_dn, col_dn, rest_dn = _class_mask(a, dn_cls, bg)
    if col_up is None and col_dn is None:
        return None

    # prima stima della larghezza del corpo (per il filtro delle linee)
    pre = _components(m_up, True) + _components(m_dn, False)
    ws = [c["x1"] - c["x0"] + 1 for c in pre if c["y1"] - c["y0"] >= 3]
    body_w0 = float(np.median(ws)) if ws else 5.0
    m_up = _remove_thin_lines(m_up, body_w0)
    m_dn = _remove_thin_lines(m_dn, body_w0)
    # ricuci le candele tagliate da linee orizzontali disegnate sopra (livelli, medie di altro colore): gap ≤ 3 px
    vclose = np.ones((5, 1), bool)
    m_up = m_up | (ndi.binary_closing(m_up, structure=vclose) & ~m_dn)
    m_dn = m_dn | (ndi.binary_closing(m_dn, structure=vclose) & ~m_up)
    comps = _components(m_up, True) + _components(m_dn, False)
    if not comps:
        return None

    # testo colorato (legenda OHLC, etichette): glifi allineati o stringhe fuse (riempimento basso, colonne a più tratti)
    txt = _text_groups(comps)
    for i, c in enumerate(comps):
        w, hh = c["x1"] - c["x0"] + 1, c["y1"] - c["y0"] + 1
        if hh <= 26 and w > 16 and c["n"] / (w * hh) < 0.5:
            sub = c["sub"]
            runs = (np.diff(sub.astype(np.int8), axis=0) == 1).sum(0) + sub[0]
            if np.mean(runs >= 2) >= 0.15:
                txt.add(i)
    if txt:
        comps = [c for i, c in enumerate(comps) if i not in txt]

    # pannello volumi opaco: barre ancorate alla stessa base
    vol_excluded = False
    H = a.shape[0]
    if len(comps) >= 10:
        bots = np.array([c["y1"] for c in comps])
        vals, cnts = np.unique(bots, return_counts=True)
        k = int(np.argmax(cnts))
        b0 = int(vals[k])
        near = np.abs(bots - b0) <= 1
        if near.sum() >= max(8, 0.25 * len(comps)) and b0 > 0.45 * H:
            comps = [c for c, nn in zip(comps, near) if not nn]
            vol_excluded = True
    # volumi in trasparenza (scartati dal filtro colore): segnala se formano barre ancorate
    if not vol_excluded:
        rest = rest_up | rest_dn
        if rest.sum() > 200:
            lab, nl = ndi.label(rest)
            if nl >= 10:
                sl = ndi.find_objects(lab)
                bots = np.array([s[0].stop - 1 for s in sl if s is not None and (s[1].stop - s[1].start) >= 2])
                if bots.size >= 10:
                    vals, cnts = np.unique(bots, return_counts=True)
                    if cnts.max() >= max(8, 0.25 * bots.size):
                        vol_excluded = True
    if vol_excluded:
        warnings.append("Volume pane rilevato ed escluso.")
    if not comps:
        return None

    tall = [c for c in comps if c["y1"] - c["y0"] >= 2]
    w_med = float(np.median([c["x1"] - c["x0"] + 1 for c in (tall or comps)]))
    cands: list[dict] = []
    for c in comps:
        w = c["x1"] - c["x0"] + 1
        hh = c["y1"] - c["y0"] + 1
        if w > 1.8 * w_med and w >= 6:
            sub = c["sub"]
            colmask = sub.any(0)
            tops = np.argmax(sub, axis=0)[colmask]
            bots = (hh - 1 - np.argmax(sub[::-1], axis=0))[colmask]
            if np.std(tops) < 1.6 and np.std(bots) < 1.6 and hh <= 40:
                continue  # rettangolo pieno: etichetta di prezzo / badge
            cands.append({"_wide": True, "c": c})
            continue
        if w_med >= 4 and w < 0.55 * w_med:
            continue  # frammenti di linee / glifi
        cd = _candle_from(c)
        if cd:
            cands.append(cd)
    normal = [x for x in cands if "_wide" not in x]
    if len(normal) >= 3:
        xs = np.sort([x["xc"] for x in normal])
        dif = np.diff(xs)
        dif = dif[dif >= max(1.0, 0.5 * w_med)]
        pitch = float(np.median(dif)) if dif.size else w_med * 1.5
    else:
        pitch = w_med * 1.5
    # componenti larghi = candele fuse (grafici molto compressi): dividi per passo
    out: list[dict] = []
    for x in cands:
        if "_wide" not in x:
            out.append(x)
            continue
        c = x["c"]
        w = c["x1"] - c["x0"] + 1
        hh = c["y1"] - c["y0"] + 1
        if c["n"] / (w * hh) < 0.35 and w_med >= 3:
            out.extend(_bodies_from(c, w_med, pitch))  # linea dello stesso colore fusa con le candele
            continue
        k = max(2, int(round(w / max(pitch, 1.0))))
        edges = np.linspace(0, w, k + 1).round().astype(int)
        for a0, b0 in zip(edges[:-1], edges[1:]):
            cd = _candle_from(c, int(a0), int(b0))
            if cd:
                out.append(cd)
    if len(out) < 3:
        return {"candles": out, "pitch": pitch, "body": w_med, "dark": dark, "col_up": col_up, "col_dn": col_dn,
                "vol": vol_excluded, "inserted": 0, "reg": 0.0}

    out.sort(key=lambda d: d["xc"])
    # unisci/deduplica candidati con lo stesso centro
    merged: list[dict] = [out[0]]
    for d in out[1:]:
        p = merged[-1]
        if d["xc"] - p["xc"] < 0.6 * pitch:
            vgap = max(d["y_high"] - p["y_low"], p["y_high"] - d["y_low"], 0.0)
            if d["bull"] == p["bull"] and d["x0"] <= p["x1"] + 1 and vgap <= max(3.0, pitch) and abs(d["xc"] - p["xc"]) < 0.3 * pitch:
                p.update(x0=min(p["x0"], d["x0"]), x1=max(p["x1"], d["x1"]), y_high=min(p["y_high"], d["y_high"]),
                         y_low=max(p["y_low"], d["y_low"]), n=p["n"] + d["n"])
                p["xc"] = (p["x0"] + p["x1"]) / 2
            elif _likeness(d, w_med) > _likeness(p, w_med):
                merged[-1] = d
            continue
        merged.append(d)
    # segmento principale: spezza ai buchi enormi e tieni il tratto con più candele
    segs: list[list[dict]] = [[merged[0]]]
    for d in merged[1:]:
        if d["xc"] - segs[-1][-1]["xc"] > 6 * pitch:
            segs.append([d])
        else:
            segs[-1].append(d)
    seq = max(segs, key=len)
    if len(segs) > 1 and sum(len(s) for s in segs) - len(seq) >= 3:
        warnings.append("Alcuni elementi lontani dal grafico principale sono stati ignorati.")
    # continuità verticale: scarta outlier isolati (es. glifi residui) lontani dalle candele vicine
    if len(seq) >= 8:
        mids = np.array([(d["y_high"] + d["y_low"]) / 2 for d in seq])
        span = float(np.percentile([d["y_low"] for d in seq], 95) - np.percentile([d["y_high"] for d in seq], 5)) or 1.0
        keep = []
        for i, d in enumerate(seq):
            lo, hi = max(0, i - 3), min(len(seq), i + 4)
            nb = np.delete(mids[lo:hi], i - lo)
            if nb.size and np.min(np.abs(nb - mids[i])) > 0.35 * span and (d["y_low"] - d["y_high"]) < 0.1 * span:
                continue
            keep.append(d)
        seq = keep
    # riempi le candele mancanti (passo regolare)
    filled: list[dict] = [seq[0]]
    inserted = 0
    for d in seq[1:]:
        p = filled[-1]
        gap = (d["xc"] - p["xc"]) / pitch
        k = int(round(gap))
        if k >= 2 and abs(gap - k) < 0.35 and k <= 6:
            for j in range(1, k):
                xc = p["xc"] + j * (d["xc"] - p["xc"]) / k
                y = p["y_close"]
                filled.append({"x0": int(round(xc - (p["x1"] - p["x0"]) / 2)),
                               "x1": int(round(xc + (p["x1"] - p["x0"]) / 2)), "xc": xc, "y_high": y, "y_low": y,
                               "y_open": y, "y_close": y, "bull": p["bull"], "filled": False, "n": 0})
                inserted += 1
        filled.append(d)
    xs = np.array([d["xc"] for d in filled])
    dif = np.diff(xs) / pitch if len(xs) > 1 else np.array([1.0])
    reg = float(np.mean(np.abs(dif - 1) < 0.25)) if dif.size else 0.0
    return {"candles": filled, "pitch": pitch, "body": w_med, "dark": dark, "col_up": col_up, "col_dn": col_dn,
            "vol": vol_excluded, "inserted": inserted, "reg": reg}


def _extract_line(a: np.ndarray, bg: np.ndarray) -> dict | None:
    """Fallback: grafico a linee. Linea saturata che copre più colonne → una chiusura per passo."""
    h_, s_, v_, d_ = _hsv(a)
    sat = (s_ >= 0.3) & (d_ >= 0.2) & (v_ >= 0.25)
    if sat.sum() < 50:
        return None
    hb = (h_[sat] // 20).astype(int) % 18
    W = a.shape[1]
    best, best_cov = None, 0
    for b in np.unique(hb):
        m = np.zeros(sat.shape, bool)
        m[sat] = hb == b
        cov = int(m.any(0).sum())
        if cov > best_cov:
            best, best_cov = m, cov
    if best is None or best_cov < 0.3 * W:
        return None
    m = best
    # tieni la componente più estesa orizzontalmente
    lab, n = ndi.label(ndi.binary_dilation(m, iterations=1), structure=np.ones((3, 3), bool))
    if n > 1:
        sl = ndi.find_objects(lab)
        widths = [(s[1].stop - s[1].start) if s is not None else 0 for s in sl]
        k = int(np.argmax(widths)) + 1
        m = m & (lab == k)
    cols = np.where(m.any(0))[0]
    if cols.size < 30:
        return None
    ys = np.array([np.median(np.where(m[:, x])[0]) for x in cols], float)
    color = a[m].mean(axis=0)
    npts = int(np.clip(cols.size // 8, 30, 150))
    edges = np.linspace(cols[0], cols[-1] + 1, npts + 1)
    out = []
    prev = None
    for i in range(npts):
        sel = (cols >= edges[i]) & (cols < edges[i + 1])
        if not sel.any():
            continue
        yc = float(ys[sel][-1])
        yo = prev if prev is not None else float(ys[sel][0])
        x0, x1 = int(edges[i]), int(edges[i + 1]) - 1
        out.append({"x0": x0, "x1": max(x0, x1), "xc": (x0 + x1) / 2, "y_open": yo, "y_close": yc,
                    "y_high": float(min(yo, yc, ys[sel].min())), "y_low": float(max(yo, yc, ys[sel].max())),
                    "bull": yc <= yo, "filled": True, "n": int(sel.sum())})
        prev = yc
    return {"candles": out, "color": color, "pitch": float((cols[-1] - cols[0]) / max(1, npts)), "body": 1.0}


def extract(data: bytes, crop: dict | None = None, theme: str = "auto") -> dict:
    t0 = time.perf_counter()
    img = decode(data)
    H0, W0 = img.shape[:2]
    if W0 < MIN_W or H0 < MIN_H:
        raise ImageError(f"Immagine troppo piccola ({W0}×{H0} px): servono almeno {MIN_W}×{MIN_H} px.")
    cx, cy, cw, ch = 0, 0, W0, H0
    if crop:
        try:
            cx = int(max(0, min(W0 - 1, round(float(crop["x"])))))
            cy = int(max(0, min(H0 - 1, round(float(crop["y"])))))
            cw = int(max(1, min(W0 - cx, round(float(crop["w"])))))
            ch = int(max(1, min(H0 - cy, round(float(crop["h"])))))
        except (KeyError, TypeError, ValueError) as e:
            raise ImageError("Ritaglio non valido: servono x, y, w, h in pixel.") from e
        if cw < 60 or ch < 40:
            raise ImageError("L'area selezionata è troppo piccola: seleziona almeno 60×40 px del grafico.")
        img = img[cy:cy + ch, cx:cx + cw]
    scale = 1.0
    if img.shape[0] * img.shape[1] > MAX_PIXELS:
        scale = math.sqrt(MAX_PIXELS / (img.shape[0] * img.shape[1]))
        im = Image.fromarray(img).resize((max(1, int(img.shape[1] * scale)), max(1, int(img.shape[0] * scale))), Image.NEAREST)
        img = np.asarray(im)
    t_dec = time.perf_counter()
    bg = _background(img)
    dark = float(bg.mean()) < 128
    if theme in ("dark", "light") and (theme == "dark") != dark:
        # suggerimento esplicito incoerente con lo sfondo rilevato: usa il colore medio dei bordi
        border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]]).astype(float)
        bg = np.median(border, axis=0)
        dark = float(bg.mean()) < 128
    warnings: list[str] = []
    res = _extract_candles(img, bg, warnings)
    kind = "candles"
    if res is None or len(res["candles"]) < MIN_CANDLES or res["reg"] < 0.5:
        line = _extract_line(img, bg)
        if line is not None and len(line["candles"]) >= MIN_CANDLES and (res is None or len(res["candles"]) < MIN_CANDLES or res["reg"] < 0.35):
            kind = "line"
            warnings = ["Grafico a linee: estratti solo i prezzi di chiusura (massimi/minimi approssimati)."]
            res = {"candles": line["candles"], "pitch": line["pitch"], "body": 1.0, "dark": dark, "col_up": line["color"],
                   "col_dn": None, "vol": False, "inserted": 0, "reg": 1.0}
    if res is None or not res["candles"]:
        raise ImageError("Nessuna candela trovata: assicurati che lo screenshot mostri candele verdi/rosse (o un grafico a linee) ben visibili.")
    cs = res["candles"]
    if len(cs) < MIN_CANDLES:
        raise ImageError(f"Troppe poche candele riconosciute ({len(cs)}): servono almeno {MIN_CANDLES} candele. "
                         "Allarga la selezione o usa uno zoom più ampio.")
    if len(cs) > MAX_CANDLES:
        cs = cs[-MAX_CANDLES:]
        warnings.append(f"Più di {MAX_CANDLES} candele: usate le ultime {MAX_CANDLES}.")
    if res["inserted"]:
        warnings.append(f"{res['inserted']} candele non riconosciute sono state ricostruite per interpolazione.")
    if len(cs) < 25:
        warnings.append("Poche candele: la ricerca è meno selettiva.")

    y_hi = min(d["y_high"] for d in cs)
    y_lo = max(d["y_low"] for d in cs)
    span = max(1.0, y_lo - y_hi)
    u = lambda y: (y_lo - y) / span  # noqa: E731 — 0 = minimo, 1 = massimo (y verso l'alto = prezzo più alto)
    series = {k: [round(float(u(d[f"y_{k}"])) * 100, 2) for d in cs] for k in ("open", "high", "low", "close")}
    if span < 25:
        warnings.append("Il grafico ha un'escursione verticale molto ridotta: la forma estratta è poco definita.")

    # qualità
    n = len(cs)
    both = res["col_up"] is not None and res["col_dn"] is not None and any(d["bull"] for d in cs) and any(not d["bull"] for d in cs)
    ins_frac = res["inserted"] / max(1, n)
    conf = 100 * (0.42 * res["reg"] + 0.23 * min(1.0, n / 40) + 0.15 * max(0.0, 1 - 3 * ins_frac)
                  + 0.10 * (1.0 if both or kind == "line" else 0.3) + 0.10 * min(1.0, span / 150))
    if kind == "line":
        conf = min(conf, 70.0)

    inv = 1.0 / scale
    boxes = []
    for i, d in enumerate(cs):
        boxes.append({
            "i": i, "x": round(cx + d["xc"] * inv, 1), "x0": round(cx + d["x0"] * inv, 1), "x1": round(cx + (d["x1"] + 1) * inv, 1),
            "y_open": round(cy + d["y_open"] * inv, 1), "y_close": round(cy + d["y_close"] * inv, 1),
            "y_high": round(cy + d["y_high"] * inv, 1), "y_low": round(cy + d["y_low"] * inv, 1),
            "bull": bool(d["bull"]), "filled": bool(d["filled"]),
        })
    return {
        "kind": kind, "candles": n,
        "image": {"width": W0, "height": H0},
        "crop": {"x": cx, "y": cy, "w": cw, "h": ch},
        "theme": "dark" if dark else "light",
        "colors": {"up": _hex(res["col_up"]) if res["col_up"] is not None else None,
                   "down": _hex(res["col_dn"]) if res["col_dn"] is not None else None,
                   "background": _hex(bg)},
        "pitch_px": round(res["pitch"] * inv, 2), "body_px": round(res["body"] * inv, 2),
        "spacing_score": round(res["reg"] * 100, 1), "confidence": round(float(conf), 1),
        "volume_excluded": bool(res["vol"]), "inserted": int(res["inserted"]),
        "warnings": warnings, "boxes": boxes, "series": series,
        "_ms": {"decode": (t_dec - t0) * 1000, "extract": (time.perf_counter() - t_dec) * 1000},
    }


# ================================================================== ricerca

def _ohlc(series: dict, R: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Serie relativa 0..100 → prezzi (base 1) con escursione log totale R (la figura è trattata in scala log)."""
    f = lambda k: np.exp(np.asarray(series[k], float) / 100.0 * R)  # noqa: E731
    o, h, l, c = f("open"), f("high"), f("low"), f("close")
    h = np.maximum.reduce([h, o, c])
    l = np.minimum.reduce([l, o, c])
    return o, h, l, c


def _struct(h, l, c, k_sw: int) -> dict:
    n = len(c)
    x = np.arange(n)
    y = np.log(c)
    sl, ic = np.polyfit(x, y, 1)
    ss = float(np.sum((y - y.mean()) ** 2))
    r2 = 1 - float(np.sum((y - (sl * x + ic)) ** 2)) / ss if ss > 0 else 0.0
    hi, lo = h.max(), l.min()
    zz = an._swings(h, l, k_sw)
    st = an._structure(zz)
    rt = an._retests(h, l, c)
    return {"r2": r2, "position": (c[-1] - lo) / (hi - lo) * 100 if hi > lo else 50.0,
            "structure": st["score"], "_structure": st, "retests": float(rt["count"]), "_retests": rt}


STRUCT_KEYS = ("r2", "position", "structure", "retests")


def _img(s: str) -> str:
    return (s.replace(" oggi,", " nell'immagine,").replace(" oggi ", " nell'immagine ").replace(": oggi ", ": nell'immagine ")
             .replace("Oggi ", "Nell'immagine ").replace("oggi:", "nell'immagine:"))


def search_tf(tf: str, ser: dict, top: int, horizon: int, price_now: float) -> dict:
    """Analoghi di una figura (serie relativa) su un timeframe. Ritorna {tf, matches, note}."""
    D = an.load(tf)
    close = D["close"]
    n_all = len(close)
    x = np.log(close)
    w = len(ser["close"])
    m = n_all - w - horizon + 1
    if m < max(30, top * 3):
        return {"tf": tf, "matches": [], "candidates": 0,
                "note": f"Storico {an.TF_LABEL[tf]} insufficiente per {w} candele + {horizon} di continuazione."}
    qz = fr._z(np.asarray(ser["close"], float))
    corr = fr._rolling_corr(x, qz, m)
    order = np.argsort(-corr)
    blocked = np.zeros(m, bool)
    half = max(1, w // 3)
    n_pre = 150 if w <= 120 else 100
    picks: list[int] = []
    for s in order:
        if corr[s] <= 0 or len(picks) >= n_pre:
            break
        if blocked[s]:
            continue
        picks.append(int(s))
        blocked[max(0, s - half):s + half + 1] = True
    if not picks:
        picks = [int(s) for s in order[:n_pre]]
    pa = np.array(picks)
    band = max(2, w // 10)
    cands = fr._z(x[pa[:, None] + np.arange(w)[None, :]])
    dtw = fr.dtw_banded(qz, cands, band)
    c_ = corr[pa]
    shape = 100 * (0.6 * np.clip(c_, 0, 1) + 0.4 * np.exp(-dtw / 0.35))
    n_rr = 80 if w <= 120 else 48
    pool = [int(k) for k in np.argsort(-shape)[:n_rr]]
    starts = np.array([int(pa[k]) for k in pool])
    idx = starts[:, None] + np.arange(w)[None, :]
    O, Hh, Ll = D["open"], D["high"], D["low"]
    # ampiezza: la figura è senza scala; per le componenti che dipendono dall'escursione (gambe, figure, volatilità,
    # struttura) la si calibra sull'escursione log di ciascun candidato (cache per valori arrotondati)
    k_sw = max(2, w // 15)
    cacheQ: dict[float, dict] = {}

    def qs(R: float) -> dict:
        R = round(max(R, 0.01), 3)
        if R not in cacheQ:
            oq, hq, lq, cq = _ohlc(ser, R)
            zc = vis.zigzag(hq, lq, cq, vis.zz_threshold(hq, lq, cq))
            cacheQ[R] = {"R": R, "o": oq, "h": hq, "l": lq, "c": cq, "zc": zc, "legs": vis.legs_of(zc),
                         "rng": (hq.max() / lq.min() - 1) * 100, "pats": vis.detect_patterns(oq, hq, lq, cq),
                         "geo": vis.trend_geometry(vis.zigzag(hq, lq, cq, vis.zz_threshold(hq, lq, cq) * 0.7), hq, lq),
                         "fc": _struct(hq, lq, cq, k_sw)}
        return cacheQ[R]

    R0 = float(np.median(np.log(Hh[idx[:10]].max(1) / Ll[idx[:10]].min(1))))
    Q0 = qs(R0)
    vq = vis.candle_vectors(Q0["o"], Q0["h"], Q0["l"], Q0["c"])  # corpo/ombre in ATR: praticamente invariante alla scala
    stats_c = vis.candle_stats(vq)
    specs = [s for s in an._specs(10.0) if s[0] in STRUCT_KEYS]
    cv = np.stack([vis.candle_vectors(O[r], Hh[r], Ll[r], close[r]) for r in idx])
    cdist = vis.dtw_multi(vq, cv, band)
    scored = []
    for n_k, k in enumerate(pool):
        s = int(pa[k])
        ws = slice(s, s + w)
        oa, ha, la, ca = O[ws], Hh[ws], Ll[ws], close[ws]
        Q = qs(float(np.log(ha.max() / la.min())))
        fa = _struct(ha, la, ca, k_sw)
        fs = an._feature_score(Q["fc"], fa, specs)
        s_candles = 0.65 * vis.candle_seq_score(float(cdist[n_k])) + 0.35 * vis.candle_dist_score(vq, cv[n_k])
        za = vis.zigzag(ha, la, ca, vis.zz_threshold(ha, la, ca))
        legs_a = vis.legs_of(za)
        rng_a = (ha.max() / la.min() - 1) * 100
        s_legs, pairs = vis.legs_align(Q["legs"], legs_a, w, Q["rng"], rng_a)
        pats_a = vis.detect_patterns(oa, ha, la, ca)
        geo_a = vis.trend_geometry(vis.zigzag(ha, la, ca, vis.zz_threshold(ha, la, ca) * 0.7), ha, la)
        s_pat, common, pat_text = vis.pattern_score(Q["pats"], pats_a, Q["geo"], geo_a)
        s_vty = vis.volatility_score(Q["h"], Q["l"], Q["c"], ha, la, ca)
        comps = {"shape": float(shape[k]), "candles": s_candles, "legs": s_legs, "pattern": s_pat, "volume": None, "volatility": s_vty}
        vscore = vis.combine(comps)
        scored.append({"score": W_VISUAL * vscore + (1 - W_VISUAL) * fs, "k": k, "s": s, "fa": fa, "fs": fs, "vscore": vscore,
                       "comps": comps, "za": za, "legs_a": legs_a, "pairs": pairs, "pats_a": pats_a, "common": common,
                       "pat_text": pat_text, "stats_a": vis.candle_stats(cv[n_k]), "rng_a": rng_a, "Q": Q})
    scored.sort(key=lambda r: -r["score"])
    chosen: list[dict] = []
    for row in scored:
        if all(abs(row["s"] - r["s"]) >= w for r in chosen):
            chosen.append(row)
        if len(chosen) >= top:
            break

    t = D["time"]
    step = an.TF_STEP[tf]
    t_last = int(t[-1])
    tq = np.array([t_last - (w - 1 - i) * step for i in range(w)], dtype=np.int64)
    sc = stats_c
    matches = []
    for row in chosen:
        k, s, fa, fs = row["k"], row["s"], row["fa"], row["fs"]
        Q = row["Q"]
        oq, hq, lq, cq, zc, legs_c, rng_c, fc, R = Q["o"], Q["h"], Q["l"], Q["c"], Q["zc"], Q["legs"], Q["rng"], Q["fc"], Q["R"]
        f_now = price_now / float(cq[-1])
        qo, qh, ql, qc = oq * f_now, hq * f_now, lq * f_now, cq * f_now
        query_candles = [{"time": int(tq[i]), "open": an._r(qo[i]), "high": an._r(qh[i]), "low": an._r(ql[i]), "close": an._r(qc[i])}
                         for i in range(w)]
        legs_c_out = an._legs_out(legs_c, tq, [f"G{i + 1}" for i in range(len(legs_c))])
        for g in legs_c_out:
            g["from_price"], g["to_price"] = round(g["from_price"] * f_now, 2), round(g["to_price"] * f_now, 2)
        pats_c_out = an._pats_out(Q["pats"], tq)
        for p in pats_c_out:
            for ln in p["lines"]:
                for pt in ln["points"]:
                    pt["price"] = round(pt["price"] * f_now, 2)
            for pt in p["points"]:
                pt["price"] = round(pt["price"] * f_now, 2)
        atr_c = float(np.mean((hq - lq) / cq) * 100)
        e = s + w - 1
        ws = slice(s, e + 1)
        ha, la, ca = Hh[ws], Ll[ws], close[ws]
        ta = t[ws]
        when = an._when(int(t[s]), int(t[e]))
        fut = slice(e + 1, e + 1 + horizon)
        ec = float(close[e])
        fh, fl, fcl = D["high"][fut], D["low"][fut], close[fut]
        comps = row["comps"]
        lab_a: list[str] = []
        for j in range(len(row["legs_a"])):
            ii = [i for i, jj in row["pairs"] if jj == j]
            lab_a.append("G" + "/".join(str(i + 1) for i in ii[:2]) if ii else "–")
        legs_a_out = an._legs_out(row["legs_a"], ta, lab_a)
        leg_pairs = []
        for i, j in row["pairs"]:
            gc, ga = legs_c[i], row["legs_a"][j]
            mx = gc["pct"] / max(rng_c, 1e-6)
            my = ga["pct"] / max(row["rng_a"], 1e-6)
            cost = abs(mx - my) + 0.8 * abs(gc["dur"] - ga["dur"]) / w + (0.6 if (gc["pct"] > 0) != (ga["pct"] > 0) else 0)
            leg_pairs.append({"current": i + 1, "analog": j + 1, "similarity": round(100 * math.exp(-cost / 0.35), 1),
                              "text": f"Gamba {i + 1}: {an._sgn(gc['pct'])} in {gc['dur']} candele ↔ {an._sgn(ga['pct'])} in {ga['dur']} candele"})
        good = sum(1 for p in leg_pairs if p["similarity"] >= 70)
        sa = row["stats_a"]
        atr_a = float(np.mean((ha - la) / ca) * 100)
        expl = {
            "shape": f"Correlazione {c_[k]:.2f} e distanza DTW {dtw[k]:.2f} sul log-prezzo normalizzato: la figura dell'immagine e "
                     f"il periodo storico disegnano un percorso {an._qual(comps['shape'])}.",
            "candles": f"Candele verdi {sc['green']:.0f}% nell'immagine vs {sa['green']:.0f}% {when}; corpo mediano "
                       f"{sc['body']:.2f}×ATR vs {sa['body']:.2f}×ATR, ombre {sc['wick']:.2f}×ATR vs {sa['wick']:.2f}×ATR: "
                       f"sequenza di candele {an._qual(comps['candles'], True)}.",
            "legs": f"{len(legs_c)} gambe nell'immagine contro {len(row['legs_a'])} {when}; {good} coppie su {len(leg_pairs)} con "
                    f"ampiezza (in proporzione al range) e durata simili (≥70%).",
            "pattern": _img(row["pat_text"]),
            "volume": "Volumi non confrontati: dall'immagine si estrae solo il prezzo.",
            "volatility": f"Range medio per candela pari al {atr_c / max(rng_c, 1e-9) * 100:.1f}% dell'escursione della figura "
                          f"nell'immagine vs {atr_a / max(row['rng_a'], 1e-9) * 100:.1f}% {when}; andamento della volatilità "
                          f"{an._qual(comps['volatility'], True)}.",
        }
        visual = {"score": round(row["vscore"], 1),
                  "components": [{"key": key, "label": vis.VIS_LABELS[key],
                                  "score": round(comps[key], 1) if comps[key] is not None else None,
                                  "weight": wgt, "explanation": expl[key]} for key, wgt in vis.VIS_WEIGHTS.items()]}
        feats = _feature_list(fc, fa, specs, when)
        mt = {
            "rank": 0, "tf": tf, "window": w,
            "period": {"start": int(t[s]), "end": int(t[e]), "label": an.period_label(int(t[s]), int(t[e]), tf), "when": when},
            "similarity": round(float(row["score"]), 1),
            "visual_similarity": round(float(row["vscore"]), 1),
            "shape_similarity": round(float(shape[k]), 1),
            "feature_similarity": round(float(fs), 1),
            "correlation": round(float(c_[k]), 4), "dtw": round(float(dtw[k]), 4),
            "dtw_score": round(float(100 * np.exp(-dtw[k] / 0.35)), 1),
            "visual": visual,
            "patterns": {"current": pats_c_out, "analog": an._pats_out(row["pats_a"], ta), "common": row["common"],
                         "common_name": vis.NAMES.get(row["common"]) if row["common"] else None,
                         "text": _img(row["pat_text"]), "score": round(comps["pattern"], 1)},
            "legs_current": legs_c_out, "legs_analog": legs_a_out, "leg_pairs": leg_pairs,
            "features": feats,
            "outcome": {
                "candles": int(len(fcl)),
                "change": round(float((fcl[-1] / ec - 1) * 100), 2) if len(fcl) else None,
                "max_up": round(float((fh.max() / ec - 1) * 100), 2) if len(fh) else None,
                "max_down": round(float((fl.min() / ec - 1) * 100), 2) if len(fl) else None,
                "end_time": int(t[e + len(fcl)]) if len(fcl) else None,
            },
            "candles": an._candles(D, s, min(n_all, e + 1 + horizon), volume=False),
            "projection": {"times": [t_last + step * (i + 1) for i in range(len(fcl))],
                           "close": [an._r0(v) for v in fcl * (price_now / ec)]},
            "query_candles": query_candles,
            "scale_range": round(float((math.exp(R) - 1) * 100), 2),
        }
        mapping = an._mapping(zc, row["za"], row["pairs"], hq, lq, cq, ha, la, ca, tq, ta, fc, fa, when)
        for mp in mapping:
            mp["current"]["price"] = round(mp["current"]["price"] * f_now, 2)
            mp["note"] = _img(mp["note"]).replace("dall'inizio della finestra", "dall'inizio della figura")
        mt["mapping"] = mapping
        mt["narrative"] = _narrative(mt, w)
        mt["narrative_llm"] = None
        matches.append(mt)
    return {"tf": tf, "matches": matches, "candidates": int(len(picks)), "note": None}


def _feature_list(fc: dict, fa: dict, specs, when: str) -> list[dict]:
    out = an._feature_list(fc, fa, specs, when)
    for f in out:
        f["explanation"] = _img(f["explanation"])
    return out


def _narrative(m: dict, w: int) -> list[str]:
    vc = {c["key"]: c for c in m["visual"]["components"]}
    tfl = an.TF_LABEL[m["tf"]]
    s = [f"La figura estratta dall'immagine ({w} candele) somiglia a {m['period']['label']}: somiglianza grafica "
         f"{m['visual']['score']:.0f}% (forma {vc['shape']['score']:.0f}%, candele {vc['candles']['score']:.0f}%, "
         f"gambe {vc['legs']['score']:.0f}%, figure {vc['pattern']['score']:.0f}%), struttura {m['feature_similarity']:.0f}%, "
         f"similarità complessiva {m['similarity']:.0f}% sul timeframe {tfl}."]
    s.append(m["patterns"]["text"])
    good = sorted([p for p in m["leg_pairs"] if p["similarity"] >= 70], key=lambda p: -p["similarity"])
    if m["leg_pairs"]:
        s.append(f"In proporzione all'ampiezza delle due figure, le gambe del movimento si corrispondono in {len(good)} "
                 f"casi su {len(m['leg_pairs'])}" + (f", ad esempio {an._lc(good[0]['text'])}." if good else "."))
    s.append(f"Le variazioni percentuali della figura sono stimate: l'immagine non ha una scala di prezzo, quindi la sua "
             f"escursione è calibrata su quella del periodo analogo ({an._sgn(m['scale_range'])} tra minimo e massimo).")
    o = m["outcome"]
    if o["change"] is not None:
        s.append(f"Dopo quel periodo il prezzo si mosse del {an._sgn(o['change'])} nelle {o['candles']} candele successive "
                 f"(escursione massima {an._sgn(o['max_up'])} / {an._sgn(o['max_down'])}): un precedente, non una previsione.")
    return s


def _price_now() -> float:
    for tf in ("1h", "4h", "1d"):
        try:
            return float(an.load(tf)["close"][-1])
        except Exception:  # noqa: BLE001
            continue
    return float("nan")


def _quant(arr: np.ndarray, q: float) -> list[float | None]:
    out = []
    for col in arr.T:
        v = col[np.isfinite(col)]
        out.append(round(float(np.quantile(v, q)), 2) if v.size else None)
    return out


def analyze(data: bytes, crop: dict | None = None, tfs: list[str] | None = None, top: int = 5,
            horizon: int | None = None, theme: str = "auto") -> dict:
    t0 = time.perf_counter()
    ex = extract(data, crop, theme)
    t_ex = time.perf_counter()
    tfs = [tf for tf in (tfs or list(TFS)) if tf in TFS] or list(TFS)
    n = ex["candles"]
    horizon = int(min(max(horizon or max(10, round(0.5 * n)), 5), 150))
    top = int(min(max(top, 1), 8))
    price_now = _price_now()
    per_tf, allm = [], []
    for tf in tfs:
        try:
            r = search_tf(tf, ex["series"], top, horizon, price_now)
        except Exception as e:  # noqa: BLE001
            log.warning("ricerca %s fallita: %s", tf, e)
            r = {"tf": tf, "matches": [], "candidates": 0, "note": f"Ricerca {an.TF_LABEL[tf]} non disponibile."}
        best = r["matches"][0] if r["matches"] else None
        per_tf.append({"tf": tf, "available": bool(r["matches"]), "candidates": r["candidates"],
                       "best_similarity": best["similarity"] if best else None,
                       "best_period": best["period"]["label"] if best else None, "note": r["note"]})
        for i, mt in enumerate(r["matches"]):
            mt["_tf_rank"] = i
            allm.append(mt)
    if not allm:
        raise ImageError("Nessun periodo storico confrontabile: prova con meno candele o un altro timeframe.")
    allm.sort(key=lambda m: -m["similarity"])
    sel = allm[:top]
    for tf in tfs:  # sempre il migliore di ogni timeframe
        b = next((m for m in allm if m["tf"] == tf), None)
        if b is not None and b not in sel:
            sel.append(b)
    sel.sort(key=lambda m: -m["similarity"])
    for i, m in enumerate(sel, 1):
        m["rank"] = i
        m.pop("_tf_rank", None)
    if sel:
        sel[0]["narrative_llm"] = None

    outs = np.array([m["outcome"]["change"] for m in sel if m["outcome"]["change"] is not None])
    sims = np.array([m["similarity"] for m in sel if m["outcome"]["change"] is not None])
    up = int((outs > 0).sum())
    n_m = len(outs)
    med = float(np.median(outs)) if n_m else None
    wavg = float((outs * sims).sum() / sims.sum()) if n_m and sims.sum() > 0 else None
    agree = max(up, n_m - up) / n_m * 100 if n_m else None
    bias = "neutral"
    if n_m and up / n_m >= 0.65 and (med or 0) > 0:
        bias = "bullish"
    elif n_m and up / n_m <= 0.35 and (med or 0) < 0:
        bias = "bearish"
    dir_txt = {"bullish": "al rialzo", "bearish": "al ribasso", "neutral": "senza una direzione prevalente"}[bias]
    text = (f"{up} {'analogo' if up == 1 else 'analoghi'} su {n_m} {'è salito' if up == 1 else 'sono saliti'} nelle {horizon} "
            f"candele successive (mediana {an._sgn(med)}): i precedenti si sono risolti {dir_txt}.") if n_m else "Nessun esito disponibile."
    # mediana dei percorsi (normalizzati sulla fine di ciascuna finestra) riportata sul prezzo attuale
    paths = []
    for m in sel:
        cc = [c["close"] for c in m["candles"]]
        end = cc[m["window"] - 1]
        fut = np.array(cc[m["window"]:], float) / end
        row = np.full(horizon, np.nan)
        row[:min(horizon, fut.size)] = fut[:horizon]
        paths.append(row)
    P = np.array(paths) * price_now if paths else np.zeros((0, horizon))
    proj = {"steps": horizon, "median": _quant(P, 0.5), "p25": _quant(P, 0.25), "p75": _quant(P, 0.75)}
    t_end = time.perf_counter()
    ms = ex.pop("_ms")
    tfl = ", ".join(an.TF_LABEL[tf] for tf in tfs)
    return {
        "generated_at": int(time.time()), "tfs": tfs, "window": n, "horizon": horizon, "top": top,
        "price_now": price_now,
        "extraction": ex,
        "per_tf": per_tf,
        "summary": {"count": n_m, "up": up, "down": n_m - up, "agreement": round(agree, 1) if agree is not None else None,
                    "median_outcome": round(med, 2) if med is not None else None,
                    "weighted_outcome": round(wavg, 2) if wavg is not None else None,
                    "best_similarity": sel[0]["similarity"] if sel else None, "bias": bias, "text": text},
        "projection": proj,
        "matches": sel,
        "timings": {"decode_ms": round(ms["decode"]), "extract_ms": round(ms["extract"]),
                    "search_ms": round((t_end - t_ex) * 1000), "total_ms": round((t_end - t0) * 1000)},
        "method": ("Estrazione deterministica delle candele dall'immagine (classi di colore HSV rialzo/ribasso, scarto di "
                   "volumi, testo, etichette e linee sottili, corpo e ombre per componente connessa, passo regolare). La figura "
                   f"è senza scala: la ricerca sui timeframe {tfl} usa il log-prezzo z-normalizzato (correlazione di Pearson + DTW, "
                   "invarianti alla scala) e, per gambe, figure, volatilità e struttura, calibra l'escursione della figura su quella "
                   f"di ciascun candidato. Similarità = {W_VISUAL * 100:.0f}% grafica (forma 30%, candele 20%, gambe 20%, figure 15%, "
                   f"volatilità 7.5%; volumi esclusi) + {(1 - W_VISUAL) * 100:.0f}% struttura (R², posizione nel range, HH/HL, "
                   "retest). L'immagine viene elaborata in memoria e non viene salvata."),
    }
