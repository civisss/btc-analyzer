"""Kronos — foundation model per candele OHLCV (Shi et al., arXiv:2508.02739, AAAI 2026), integrato in modo onesto.

Cosa fa questo modulo:
  1. Pesi da Hugging Face (revisioni fissate) scaricati al PRIMO USO in DATA_DIR/models/kronos (volume Docker: non si
     riscaricano). Nessun accesso alla rete né import di torch all'import del modulo: l'app parte anche senza torch.
  2. Previsione corrente: ultime N <= 512 candele CHIUSE BTCUSDT (k_1h / k_4h / k_1d), `sample_count` percorsi
     autoregressivi (T, top_p dichiarati) -> mediana, percentili 5/25/75/95 per passo, media dei percorsi (il punto di
     KronosPredictor), alcuni percorsi campione, P(rialzo) a fine orizzonte, regime (accordo dei percorsi + dispersione).
     Un solo thread di lavoro (torch non blocca mai l'event loop); `cuda` se disponibile, altrimenti `cpu`.
  3. Registro live: a ogni nuova candela chiusa 1h/4h/1d salva la previsione emessa (point-in-time, mai ricostruita a
     posteriori) e la verifica alla scadenza leggendo le chiusure reali.
  4. Backtest walk-forward fuori campione (pesante, si esegue in locale con la GPU: `python -m app.analysis.kronos_forecast
     backtest`): origini storiche per 1h/4h/1d, confronto con naive, deriva, passeggiata aleatoria con volatilità storica
     e il nostro modello a 1 giorno; periodo prima e DOPO la fine del pre-addestramento di Kronos (giugno 2024) valutati a
     parte. L'app legge solo il file risultante (DATA_DIR o, nell'immagine Docker, backend/seed).
Le risposte contengono chiavi e numeri: i testi li compone il frontend.
"""
from __future__ import annotations

import json
import logging
import math
import os
import queue
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from ..data import store
from ..util import clean, ts

log = logging.getLogger("kronos")

VERSION = 1
BT_VERSION = 1

# ------------------------------------------------------------------ modelli (ID e revisioni verificati su huggingface.co/NeoQuasar)
MODELS = {
    "small": {"repo": "NeoQuasar/Kronos-small", "rev": "901c26c1332695a2a8f243eb2f37243a37bea320", "tokenizer": "base",
              "ctx": 512, "params_m": 24.7},
    "base": {"repo": "NeoQuasar/Kronos-base", "rev": "2b554741eca47781b64468546e77fef3e85130e6", "tokenizer": "base",
             "ctx": 512, "params_m": 102.3},
}
TOKENIZERS = {
    "base": {"repo": "NeoQuasar/Kronos-Tokenizer-base", "rev": "0e0117387f39004a9016484a186a908917e22426"},
}
SOURCES = {
    "repo": "https://github.com/shiyu-coder/Kronos", "paper": "https://arxiv.org/abs/2508.02739",
    "hf": "https://huggingface.co/NeoQuasar", "license": "MIT",
}
LIVE_MODEL = "small"
MODEL_DIR = store.DATA_DIR / "models" / "kronos"
SEED_DIR = Path(__file__).resolve().parents[2] / "seed"     # nell'immagine Docker: backtest già calcolato (vedi Dockerfile)

# fine dei dati di pre-addestramento dichiarata nel paper ("extends up to June 2024"; test dal luglio 2024)
PRETRAIN_END = pd.Timestamp("2024-07-01", tz="UTC")

# ------------------------------------------------------------------ parametri
TFS = {"1h": {"ds": "k_1h", "sec": 3600}, "4h": {"ds": "k_4h", "sec": 14400}, "1d": {"ds": "k_1d", "sec": 86400}}
LOOKBACK = 512                       # contesto massimo di Kronos-small/base
H_OPTIONS = [6, 12, 24, 48]
DEFAULT_H = 24
SAMPLE_OPTIONS = [20, 50, 100]
DEFAULT_SAMPLES = 100
T_SAMPLING = 1.0
TOP_P = 0.9                          # valori del README di Kronos
TOP_K = 0
CLIP = 5.0
N_PATHS_OUT = 8                      # percorsi campione restituiti per il grafico
N_CANDLES_OUT = 120                  # candele reali restituite (il grafico mostra anche quella in corso dal WebSocket)
# regime: "trend" se almeno il 65% dei percorsi finisce dalla stessa parte del prezzo di oggi E la mediana del rendimento
# a fine orizzonte vale almeno 0,3 deviazioni standard della distribuzione dei percorsi; altrimenti "choppy"
AGREE_MIN = 0.65
SNR_MIN = 0.30
DIR_EPS = 1e-4                       # |variazione prevista| sotto 0,01% = nessuna direzione
LIVE_ENABLED = os.environ.get("KRONOS_LIVE", "on").lower() not in ("0", "off", "false", "no")
LIVE_FILE = store.DATA_DIR / "kronos_live.parquet"
BT_FILE = "kronos_bt.parquet"
BT_META = "kronos_bt.json"
# passi valutati nel backtest (tutti 1..24 per le curve; le tabelle usano i passi chiave)
BT_H = 24
KEY_STEPS = {"1h": [1, 24], "4h": [1, 6, 24], "1d": [1, 7, 24]}
DAY_STEP = {"1h": 24, "4h": 6, "1d": 1}         # passo = "1 giorno avanti" (stesso target del modello a 1 giorno)


# ------------------------------------------------------------------ stato condiviso
_status: dict = {
    "torch": None, "torch_version": None, "cuda": None, "device": None, "gpu_name": None, "threads": None,
    "weights": {}, "load_seconds": None, "loaded": False, "error": None,
    "worker": {"busy": False, "job": None, "started_at": None, "queue": 0},
    "timings": [],                     # ultime previsioni: {tf, h, samples, seconds, device}
}
_engine: dict = {}
_engine_lock = threading.Lock()
_cache: dict[tuple, dict] = {}         # (tf, h, samples, origin) -> previsione
_jobs: "queue.Queue[tuple]" = queue.Queue()
_queued: set[tuple] = set()
_job_err: dict[tuple, tuple[float, str]] = {}
_worker_started = False
_worker_lock = threading.Lock()
_live_lock = threading.Lock()


# ------------------------------------------------------------------ torch e pesi (import pigro)

def _torch():
    try:
        import torch  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        _status.update(torch=False, error=f"torch non installato: {e}"[:300])
        return None
    if _status["torch"] is None:
        cuda = bool(torch.cuda.is_available())
        _status.update(torch=True, torch_version=torch.__version__, cuda=cuda, device="cuda" if cuda else "cpu",
                       gpu_name=torch.cuda.get_device_name(0) if cuda else None)
        if not cuda:
            n = int(os.environ.get("KRONOS_THREADS") or max(1, (os.cpu_count() or 2) - 1))
            torch.set_num_threads(n)
        else:   # TF32 sulle matmul: tensor core, precisione ~1e-3 relativa (irrilevante per il campionamento)
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
        _status["threads"] = torch.get_num_threads()
    return torch


def _wstate(key: str) -> dict:
    return _status["weights"].setdefault(key, {"state": "absent", "bytes": 0, "total": None, "error": None, "path": None})


def _local_dir(key: str) -> Path:
    return MODEL_DIR / key.replace("/", "__")


def _have_files(d: Path) -> bool:
    return (d / "config.json").exists() and (d / "model.safetensors").exists()


def _download(repo: str, rev: str) -> Path:
    """Scarica config.json + model.safetensors (revisione fissata) in DATA_DIR/models/kronos/<repo>. Idempotente."""
    st = _wstate(repo)
    d = _local_dir(repo)
    if _have_files(d):
        st.update(state="ready", path=str(d), bytes=(d / "model.safetensors").stat().st_size, error=None)
        st["total"] = st["bytes"]
        return d
    if os.environ.get("KRONOS_OFFLINE", "").lower() in ("1", "on", "true"):
        st.update(state="error", error="offline")
        raise RuntimeError("weights_offline")
    from huggingface_hub import get_hf_file_metadata, hf_hub_download, hf_hub_url  # noqa: PLC0415

    d.mkdir(parents=True, exist_ok=True)
    st.update(state="downloading", error=None, bytes=0)
    try:
        try:
            st["total"] = get_hf_file_metadata(hf_hub_url(repo, "model.safetensors", revision=rev)).size
        except Exception:  # noqa: BLE001
            st["total"] = None
        stop = threading.Event()

        def watch():   # avanzamento: dimensione dei file .incomplete scritti da huggingface_hub
            while not stop.wait(1.0):
                tot = 0
                for p in d.rglob("*.incomplete"):
                    try:
                        tot += p.stat().st_size
                    except OSError:
                        pass
                if tot:
                    st["bytes"] = tot
        w = threading.Thread(target=watch, daemon=True, name="kronos-dl-watch")
        w.start()
        try:
            for fn in ("config.json", "model.safetensors"):
                hf_hub_download(repo, fn, revision=rev, local_dir=str(d))
        finally:
            stop.set()
    except Exception as e:  # noqa: BLE001
        st.update(state="error", error=str(e)[:200])
        raise RuntimeError(f"weights_unavailable: {e}") from e
    st.update(state="ready", path=str(d), bytes=(d / "model.safetensors").stat().st_size)
    st["total"] = st["bytes"]
    return d


def _load_module(cls, d: Path, torch):
    from safetensors.torch import load_file  # noqa: PLC0415

    cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
    m = cls(**cfg)
    sd = load_file(str(d / "model.safetensors"))
    missing, unexpected = m.load_state_dict(sd, strict=False)
    # gli unici buffer non salvati sono le frequenze RoPE (ricalcolate nel costruttore)
    bad = [k for k in missing if not k.endswith("inv_freq")]
    if bad or unexpected:
        raise RuntimeError(f"pesi incompatibili: mancanti {bad[:5]}, inattesi {list(unexpected)[:5]}")
    m.eval()          # dropout spento (in upstream lo fa PyTorchModelHubMixin.from_pretrained)
    return m


def engine(model: str = LIVE_MODEL, device: str | None = None) -> dict:
    """Tokenizer + modello caricati (una volta) sul dispositivo. Scarica i pesi se mancano. Bloccante: chiamare da un thread."""
    torch = _torch()
    if torch is None:
        raise RuntimeError("torch_missing")
    dev = device or _status["device"]
    key = (model, dev)
    with _engine_lock:
        if key in _engine:
            return _engine[key]
        t0 = time.time()
        from ..vendor.kronos import Kronos, KronosTokenizer  # noqa: PLC0415

        spec = MODELS[model]
        tk = TOKENIZERS[spec["tokenizer"]]
        dt = _download(tk["repo"], tk["rev"])
        dm = _download(spec["repo"], spec["rev"])
        tok = _load_module(KronosTokenizer, dt, torch).to(dev)
        mod = _load_module(Kronos, dm, torch).to(dev)
        e = {"tokenizer": tok, "model": mod, "device": dev, "model_name": model, "ctx": spec["ctx"],
             "load_seconds": time.time() - t0}
        _engine[key] = e
        _status.update(loaded=True, load_seconds=e["load_seconds"], error=None)
        log.info("Kronos-%s caricato su %s in %.1fs", model, dev, e["load_seconds"])
        return e


# ------------------------------------------------------------------ dati

def _now() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC")


def candles(tf: str, closed_only: bool = True) -> pd.DataFrame:
    """Candele BTCUSDT del timeframe (indice = apertura UTC). closed_only esclude la candela in corso."""
    sec = TFS[tf]["sec"]
    df = store.get(TFS[tf]["ds"])
    d = df[["time", "open", "high", "low", "close", "volume"]].copy()
    d["time"] = pd.to_datetime(d["time"], utc=True)
    d = d.drop_duplicates("time", keep="last").sort_values("time").set_index("time").astype(float)
    if closed_only:
        d = d[d.index + pd.Timedelta(seconds=sec) <= _now()]
    return d


def _stamps(times: pd.DatetimeIndex) -> np.ndarray:
    """Le 5 feature temporali di Kronos (minute, hour, weekday, day, month), come calc_time_stamps upstream."""
    t = pd.DatetimeIndex(times)
    return np.stack([t.minute, t.hour, t.weekday, t.day, t.month], axis=1).astype(np.float32)


def _window(d: pd.DataFrame, end: int, L: int, sec: int, H: int):
    """Finestra point-in-time che termina alla riga `end` (inclusa): solo dati noti alla chiusura di quella candela."""
    w = d.iloc[end - L + 1:end + 1]
    x = w[["open", "high", "low", "close", "volume"]].to_numpy(np.float64)
    amount = x[:, 4] * x[:, :4].mean(axis=1)           # come KronosPredictor quando manca 'amount'
    x = np.concatenate([x, amount[:, None]], axis=1)
    fut = w.index[-1] + pd.to_timedelta(np.arange(1, H + 1) * sec, unit="s")
    return x, _stamps(w.index), _stamps(fut), fut


# ------------------------------------------------------------------ generazione dei percorsi

def _last_logits(model, pre, post, stamp):
    """Come Kronos.decode_s1 ma con la testa calcolata solo sull'ultima posizione (l'unica usata dal campionamento):
    stesso risultato, senza materializzare (batch × 512 × 1024) logit a ogni passo."""
    x = model.embedding([pre, post])
    x = x + model.time_emb(stamp)
    x = model.token_drop(x)
    for layer in model.transformer:
        x = layer(x)
    x = model.norm(x)
    return model.head(x[:, -1:, :])[:, -1, :], x


def _last_s2_logits(model, context, s1_ids):
    """Come Kronos.decode_s2 (DependencyAwareLayer + testa s2) ristretto all'ultima posizione: la cross-attention ha una
    sola query (il token s1 campionato), quindi la riga finale dipende solo da context[:, -1] e dall'attenzione."""
    dep = model.dep_layer
    sib = model.embedding.emb_s1(s1_ids)
    attn = dep.cross_attn(query=sib, key=context, value=context)
    x2 = dep.norm(context[:, -1:, :] + attn)
    return model.head.cond_forward(x2)[:, -1, :]


def _ar_paths(tokenizer, model, x, x_stamp, y_stamp, max_context, pred_len, clip=5, T=1.0, top_k=0, top_p=0.99):
    """auto_regressive_inference di Kronos (upstream) con sample_count = 1 per riga — ogni riga del batch è un percorso —
    e le due ottimizzazioni equivalenti sopra. Stessa finestra scorrevole, stesso campionamento (sample_from_logits),
    stessa decodifica finale del tokenizer. Restituisce (batch, len, 6) normalizzato."""
    import torch  # noqa: PLC0415

    from ..vendor.kronos import sample_from_logits  # noqa: PLC0415

    x = torch.clip(x, -clip, clip)
    x_token = tokenizer.encode(x, half=True)
    initial_seq_len = x.size(1)
    batch_size = x_token[0].size(0)
    total_seq_len = initial_seq_len + pred_len
    full_stamp = torch.cat([x_stamp, y_stamp], dim=1)
    generated_pre = x_token[0].new_empty(batch_size, pred_len)
    generated_post = x_token[1].new_empty(batch_size, pred_len)
    pre_buffer = x_token[0].new_zeros(batch_size, max_context)
    post_buffer = x_token[1].new_zeros(batch_size, max_context)
    buffer_len = min(initial_seq_len, max_context)
    if buffer_len > 0:
        start_idx = max(0, initial_seq_len - max_context)
        pre_buffer[:, :buffer_len] = x_token[0][:, start_idx:start_idx + buffer_len]
        post_buffer[:, :buffer_len] = x_token[1][:, start_idx:start_idx + buffer_len]
    for i in range(pred_len):
        current_seq_len = initial_seq_len + i
        window_len = min(current_seq_len, max_context)
        if current_seq_len <= max_context:
            input_tokens = [pre_buffer[:, :window_len], post_buffer[:, :window_len]]
        else:
            input_tokens = [pre_buffer, post_buffer]
        context_end = current_seq_len
        context_start = max(0, context_end - max_context)
        current_stamp = full_stamp[:, context_start:context_end, :].contiguous()
        s1_logits, context = _last_logits(model, input_tokens[0], input_tokens[1], current_stamp)
        sample_pre = sample_from_logits(s1_logits, temperature=T, top_k=top_k, top_p=top_p, sample_logits=True)
        s2_logits = _last_s2_logits(model, context, sample_pre)
        sample_post = sample_from_logits(s2_logits, temperature=T, top_k=top_k, top_p=top_p, sample_logits=True)
        generated_pre[:, i] = sample_pre.squeeze(-1)
        generated_post[:, i] = sample_post.squeeze(-1)
        if current_seq_len < max_context:
            pre_buffer[:, current_seq_len] = sample_pre.squeeze(-1)
            post_buffer[:, current_seq_len] = sample_post.squeeze(-1)
        else:
            pre_buffer.copy_(torch.roll(pre_buffer, shifts=-1, dims=1))
            post_buffer.copy_(torch.roll(post_buffer, shifts=-1, dims=1))
            pre_buffer[:, -1] = sample_pre.squeeze(-1)
            post_buffer[:, -1] = sample_post.squeeze(-1)
    full_pre = torch.cat([x_token[0], generated_pre], dim=1)
    full_post = torch.cat([x_token[1], generated_post], dim=1)
    context_start = max(0, total_seq_len - max_context)
    z = tokenizer.decode([full_pre[:, context_start:total_seq_len].contiguous(),
                          full_post[:, context_start:total_seq_len].contiguous()], half=True)
    return z.float().cpu().numpy()


def sample_paths(eng: dict, xs: list[np.ndarray], xst: list[np.ndarray], yst: list[np.ndarray], H: int, S: int,
                 seeds: list[int], chunk: int | None = None, T: float = T_SAMPLING, top_p: float = TOP_P,
                 upstream: bool = False) -> np.ndarray:
    """S percorsi per ogni finestra -> array (B, S, H, 6) in unità di prezzo/volume.

    Stessa pipeline di KronosPredictor.predict (normalizzazione per finestra, clip ±5, auto_regressive_inference
    upstream, denormalizzazione) ma con i percorsi tenuti separati: upstream li media (sample_count), qui ogni riga del
    batch è un percorso (sample_count = 1), così media, mediana e percentili si calcolano dopo."""
    torch = _torch()
    from ..vendor.kronos import auto_regressive_inference  # noqa: PLC0415

    B = len(xs)
    xs_n, mu, sd = [], [], []
    for x in xs:
        m, s = x.mean(axis=0), x.std(axis=0)
        xs_n.append(np.clip((x - m) / (s + 1e-5), -CLIP, CLIP).astype(np.float32))
        mu.append(m)
        sd.append(s)
    dev = eng["device"]
    if chunk is None:
        chunk = 128 if dev.startswith("cuda") else 25
    out = np.empty((B, S, H, 6), np.float32)
    rows = [(b, s) for b in range(B) for s in range(S)]
    for a in range(0, len(rows), chunk):
        part = rows[a:a + chunk]
        bs = [r[0] for r in part]
        # seme per blocco: riproducibile (stessa origine -> stessi percorsi)
        torch.manual_seed(int(seeds[bs[0]] * 1000 + part[0][1]) % (2 ** 31 - 1))
        x = torch.from_numpy(np.stack([xs_n[b] for b in bs])).to(dev)
        xs_t = torch.from_numpy(np.stack([xst[b] for b in bs])).to(dev)
        ys_t = torch.from_numpy(np.stack([yst[b] for b in bs])).to(dev)
        with torch.inference_mode():
            if upstream:   # implementazione originale (riferimento per il test di equivalenza)
                p = auto_regressive_inference(eng["tokenizer"], eng["model"], x, xs_t, ys_t, eng["ctx"], H, CLIP, T, TOP_K,
                                              top_p, 1, False)
            else:
                p = _ar_paths(eng["tokenizer"], eng["model"], x, xs_t, ys_t, eng["ctx"], H, CLIP, T, TOP_K, top_p)
        p = p[:, -H:, :]
        for j, (b, s) in enumerate(part):
            out[b, s] = p[j] * (sd[b] + 1e-5) + mu[b]
    return out


# ------------------------------------------------------------------ sintesi di una previsione

QS = [5, 25, 50, 75, 95]


def regime_of(close_end: np.ndarray, ref: float) -> dict:
    """Regime dai percorsi a fine orizzonte: accordo sulla direzione + mediana del rendimento in deviazioni standard."""
    lr = np.log(np.maximum(close_end, 1e-9) / ref)
    up = float(np.mean(lr > 0))
    agree = max(up, 1 - up)
    sd = float(np.std(lr))
    med = float(np.median(lr))
    snr = abs(med) / sd if sd > 0 else 0.0
    trend = agree >= AGREE_MIN and snr >= SNR_MIN
    code = ("trend_up" if med > 0 else "trend_down") if trend else "choppy"
    return {"code": code, "up_share": up, "agree": agree, "snr": snr, "median_ret_pct": 100 * med, "sd_ret_pct": 100 * sd}


def efficiency(path: np.ndarray, ref: float) -> float:
    """Efficienza direzionale di un percorso: |movimento netto| / somma dei movimenti (1 = linea retta, ~0 = laterale)."""
    lp = np.log(np.maximum(np.r_[ref, path], 1e-9))
    tot = np.abs(np.diff(lp)).sum()
    return float(abs(lp[-1] - lp[0]) / tot) if tot > 0 else 0.0


def summarize(close: np.ndarray, ref: float) -> dict:
    """close: (S, H) chiusure dei percorsi."""
    q = np.percentile(close, QS, axis=0)
    reg = regime_of(close[:, -1], ref)
    end = close[:, -1]
    er = float(np.mean([efficiency(close[i], ref) for i in range(close.shape[0])]))
    return {
        "q": q, "mean": close.mean(axis=0), "reg": reg, "er": er,
        "end": {"median": float(q[2, -1]), "mean": float(end.mean()), "p05": float(q[0, -1]), "p25": float(q[1, -1]),
                "p75": float(q[3, -1]), "p95": float(q[4, -1]), "change_pct": 100 * (float(q[2, -1]) / ref - 1),
                "mean_change_pct": 100 * (float(end.mean()) / ref - 1), "up_prob": 100 * reg["up_share"],
                "width50_pct": 100 * float(q[3, -1] - q[1, -1]) / ref, "width90_pct": 100 * float(q[4, -1] - q[0, -1]) / ref},
    }


def forecast_once(tf: str, H: int = DEFAULT_H, S: int = DEFAULT_SAMPLES, model: str = LIVE_MODEL) -> dict:
    """Previsione sull'ultima candela chiusa (bloccante: gira nel thread di lavoro)."""
    d = candles(tf)
    sec = TFS[tf]["sec"]
    L = min(LOOKBACK, len(d))
    if L < 64:
        raise RuntimeError("dati insufficienti")
    end = len(d) - 1
    x, xst, yst, fut = _window(d, end, L, sec, H)
    eng = engine(model)
    t0 = time.time()
    seed = int(d.index[end].timestamp() // sec) % 100000
    P = sample_paths(eng, [x], [xst], [yst], H, S, [seed])[0]
    secs = time.time() - t0
    close = P[:, :, 3].astype(np.float64)
    ref = float(d["close"].iloc[end])
    sm = summarize(close, ref)
    rng = np.random.default_rng(seed)
    pick = rng.choice(S, size=min(N_PATHS_OUT, S), replace=False)
    _status["timings"] = ([{"tf": tf, "h": H, "samples": S, "seconds": secs, "device": eng["device"], "at": time.time()}]
                          + _status["timings"])[:12]
    return {
        "tf": tf, "h": H, "samples": S, "model": model, "origin": d.index[end], "origin_close": d.index[end] + pd.Timedelta(seconds=sec),
        "ref_price": ref, "lookback": L, "steps": list(fut), "q": sm["q"], "mean": sm["mean"], "paths": close[pick],
        "end": sm["end"], "regime": sm["reg"], "er": sm["er"], "seconds": secs, "device": eng["device"],
        "computed_at": time.time(),
        "_close": close,
    }


# ------------------------------------------------------------------ thread di lavoro (una coda, un job alla volta)

def _ensure_worker() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True
        threading.Thread(target=_worker, daemon=True, name="kronos-worker").start()


def _worker() -> None:
    while True:
        job = _jobs.get()
        _status["worker"].update(busy=True, job={"tf": job[0], "h": job[1], "samples": job[2]}, started_at=time.time(),
                                 queue=_jobs.qsize())
        try:
            f = forecast_once(job[0], job[1], job[2])
            _cache[(job[0], job[1], job[2], ts(f["origin"]))] = f
            _job_err.pop(job, None)
            if job[3]:
                _record_live(f)
        except Exception as e:  # noqa: BLE001
            log.warning("previsione Kronos %s fallita: %s", job[:3], e)
            _job_err[job[:3]] = (time.time(), str(e)[:300])
            _status["error"] = str(e)[:300]
        finally:
            _queued.discard(job[:3])
            _status["worker"].update(busy=False, job=None, started_at=None, queue=_jobs.qsize())
            _trim_cache()


def _trim_cache() -> None:
    if len(_cache) > 40:
        for k in sorted(_cache, key=lambda k: _cache[k]["computed_at"])[:-40]:
            _cache.pop(k, None)


def _enqueue(tf: str, H: int, S: int, live: bool = False) -> None:
    _ensure_worker()
    key = (tf, H, S)
    if key in _queued:
        return
    _queued.add(key)
    _jobs.put((tf, H, S, live))
    _status["worker"]["queue"] = _jobs.qsize()


def _last_origin(tf: str) -> pd.Timestamp | None:
    d = candles(tf)
    return d.index[-1] if len(d) else None


# ------------------------------------------------------------------ registro live

def _load_live() -> pd.DataFrame:
    try:
        if LIVE_FILE.exists():
            df = pd.read_parquet(LIVE_FILE)
            if len(df) and int(df["version"].iloc[0]) == VERSION:
                return df
    except Exception as e:  # noqa: BLE001
        log.warning("registro live Kronos illeggibile: %s", e)
    return pd.DataFrame()


def _record_live(f: dict) -> None:
    """Salva la previsione emessa per la candela appena chiusa (solo se emessa entro un periodo dalla chiusura)."""
    if f["h"] != DEFAULT_H or f["samples"] != DEFAULT_SAMPLES:
        return
    sec = TFS[f["tf"]]["sec"]
    late = f["computed_at"] - f["origin_close"].timestamp()
    if late > sec:          # emessa troppo tardi: non è più una previsione "in tempo reale"
        return
    with _live_lock:
        df = _load_live()
        o = f["origin"]
        if len(df) and ((df["tf"] == f["tf"]) & (df["origin"] == o)).any():
            return
        rows = []
        for k in range(f["h"]):
            rows.append({"version": VERSION, "tf": f["tf"], "origin": o, "step": k + 1, "target": f["steps"][k],
                         "ref": f["ref_price"], "q05": f["q"][0, k], "q25": f["q"][1, k], "q50": f["q"][2, k],
                         "q75": f["q"][3, k], "q95": f["q"][4, k], "mean": f["mean"][k],
                         "up": float(np.mean(f["_close"][:, k] > f["ref_price"])),
                         "regime": f["regime"]["code"], "agree": f["regime"]["agree"], "snr": f["regime"]["snr"],
                         "made_at": f["computed_at"], "late_s": late, "device": f["device"], "model": f["model"],
                         "samples": f["samples"]})
        new = pd.DataFrame(rows)
        new["origin"] = pd.to_datetime(new["origin"], utc=True)
        new["target"] = pd.to_datetime(new["target"], utc=True)
        df = new if df.empty else pd.concat([df, new], ignore_index=True)
        store.write_parquet(df, LIVE_FILE)
    log.info("registro live Kronos: %s origine %s", f["tf"], o)


def live_tick() -> None:
    """Accoda la previsione standard per ogni timeframe la cui ultima candela chiusa non è ancora stata prevista."""
    for tf in TFS:
        try:
            o = _last_origin(tf)
        except Exception as e:  # noqa: BLE001
            log.info("Kronos live %s: dati non disponibili (%s)", tf, e)
            continue
        if o is None:
            continue
        if (tf, DEFAULT_H, DEFAULT_SAMPLES, ts(o)) in _cache:
            continue
        err = _job_err.get((tf, DEFAULT_H, DEFAULT_SAMPLES))
        if err and time.time() - err[0] < 600:
            continue
        _enqueue(tf, DEFAULT_H, DEFAULT_SAMPLES, live=True)


def live_loop() -> None:
    while True:
        try:
            if _torch() is not None:
                live_tick()
        except Exception as e:  # noqa: BLE001
            log.warning("loop live Kronos: %s", e)
        time.sleep(60)


def track_record() -> dict:
    """Registro live: previsioni emesse in tempo reale e verificate alla scadenza (separato dal backtest)."""
    df = _load_live()
    out = {"n_forecasts": 0, "from": None, "tf": {}}
    if df.empty:
        return out
    out["n_forecasts"] = int(df.groupby(["tf", "origin"]).ngroups)
    out["from"] = df["made_at"].min()
    for tf in TFS:
        g = df[df["tf"] == tf]
        if g.empty:
            out["tf"][tf] = {"n_forecasts": 0}
            continue
        d = candles(tf)
        act = d["close"]
        g = g.copy()
        g["actual"] = act.reindex(pd.DatetimeIndex(g["target"])).to_numpy()
        res = {"n_forecasts": int(g["origin"].nunique()), "last_origin": g["origin"].max(), "steps": {}}
        for s in sorted(set(KEY_STEPS[tf]) | {DEFAULT_H}):
            r = g[(g["step"] == s) & g["actual"].notna()]
            res["steps"][str(s)] = _point_metrics(r["actual"].to_numpy(float), r["mean"].to_numpy(float), r["ref"].to_numpy(float),
                                                  r["q25"].to_numpy(float), r["q75"].to_numpy(float), r["q05"].to_numpy(float),
                                                  r["q95"].to_numpy(float), lag=s - 1, min_n=1)
            res["steps"][str(s)]["pending"] = int(((g["step"] == s) & g["actual"].isna()).sum())
        last = g[g["origin"] == g["origin"].max()].sort_values("step")
        res["recent"] = [{"origin": o, "regime": x["regime"].iloc[0], "ref": x["ref"].iloc[0],
                          "end_q50": x["q50"].iloc[-1], "end_actual": x["actual"].iloc[-1],
                          "day_q50": x.loc[x["step"] == DAY_STEP[tf], "mean"].iloc[0] if (x["step"] == DAY_STEP[tf]).any() else None,
                          "day_actual": x.loc[x["step"] == DAY_STEP[tf], "actual"].iloc[0] if (x["step"] == DAY_STEP[tf]).any() else None}
                         for o, x in g.groupby("origin")][-12:][::-1]
        del last
        out["tf"][tf] = res
    return out


# ------------------------------------------------------------------ metriche (stesse definizioni della previsione a 1 giorno)

def _binom_p(k: int, n: int, p: float) -> float | None:
    if n <= 0 or not 0 < p < 1:
        return None
    return float(stats.binomtest(k, n, p, alternative="greater").pvalue)


def _dm_hac(e_model: np.ndarray, e_naive: np.ndarray, lag: int) -> tuple[float | None, float | None]:
    """Diebold-Mariano sull'errore assoluto con varianza HAC (Newey-West, lag = passo - 1) e correzione HLN. Bilaterale.
    Statistica negativa = il modello sbaglia meno del naive."""
    d = np.abs(e_model) - np.abs(e_naive)
    d = d[~np.isnan(d)]
    n = len(d)
    if n < 30 or np.allclose(d, 0):
        return None, None
    dc = d - d.mean()
    v = np.dot(dc, dc) / n
    for k in range(1, min(lag, n - 1) + 1):
        v += 2 * (1 - k / (lag + 1)) * np.dot(dc[k:], dc[:-k]) / n
    if v <= 0:
        return None, None
    h = lag + 1
    corr = math.sqrt(max((n + 1 - 2 * h + h * (h - 1) / n) / n, 1e-9))
    dm = float(d.mean() / math.sqrt(v / n)) * corr
    return dm, float(2 * stats.t.sf(abs(dm), df=n - 1))


def _thin(n: int, every: int) -> np.ndarray:
    """Indici non sovrapposti (un'origine ogni `every`): per i test binomiali su orizzonti che si sovrappongono."""
    return np.arange(0, n, max(1, every))


def _point_metrics(A, P, R, L5=None, H5=None, L9=None, H9=None, pu=None, crps=None, crps_ref=None, lag=0, thin=1,
                   min_n=10) -> dict:
    """A = realizzato, P = previsto, R = prezzo all'origine. Errori in log (≈ %). thin = passo dei sottocampioni non
    sovrapposti per la direzione (p-value onesti quando gli orizzonti si sovrappongono)."""
    ok = ~(np.isnan(A) | np.isnan(P) | np.isnan(R))
    n = int(ok.sum())
    if n < min_n:
        return {"n": n}
    A, P, R = A[ok], P[ok], R[ok]
    e = np.log(P / A)
    en = np.log(R / A)
    pr, ar = np.log(P / R), np.log(A / R)
    mae_n = float(np.mean(np.abs(en)))
    out = {
        "n": n, "mae": float(np.mean(np.abs(P - A))), "mape": 100 * float(np.mean(np.abs(P / A - 1))),
        "mase": float(np.mean(np.abs(e)) / mae_n) if mae_n > 0 else None, "bias_pct": 100 * float(np.mean(-e)),
        "corr_ret": float(np.corrcoef(pr, ar)[0, 1]) if n > 2 and np.std(pr) > 1e-12 and np.std(ar) > 0 else None,
    }
    m = (np.abs(pr) > DIR_EPS) & (ar != 0)
    out["n_dir"] = int(m.sum())
    if m.sum() >= min_n:
        hit = np.sign(pr) == np.sign(ar)
        out["hit_rate"] = 100 * float(hit[m].mean())
        out["always_up"] = 100 * float((ar[m] > 0).mean())
        out["share_up_calls"] = 100 * float((pr[m] > 0).mean())
        idx = _thin(n, thin)
        mi = m[idx]
        k, nn = int(hit[idx][mi].sum()), int(mi.sum())
        up_share = float((ar[idx][mi] > 0).mean()) if nn else 0.5
        out["n_dir_indep"] = nn
        out["p_dir"] = _binom_p(k, nn, 0.5)
        out["p_dir_vs_up"] = _binom_p(k, nn, up_share) if 0 < up_share < 1 else None
        out["hit_rate_indep"] = 100 * k / nn if nn else None
    dm, p = _dm_hac(e, en, lag)
    out["dm_stat"], out["dm_p"] = dm, p
    if L9 is not None:
        L5, H5, L9, H9 = (x[ok] for x in (L5, H5, L9, H9))
        b = ~np.isnan(L9)
        if b.sum() >= min_n:
            out["coverage_50"] = 100 * float(np.mean((A[b] >= L5[b]) & (A[b] <= H5[b])))
            out["coverage_90"] = 100 * float(np.mean((A[b] >= L9[b]) & (A[b] <= H9[b])))
            out["width_50"] = 100 * float(np.mean((H5[b] - L5[b]) / R[b]))
            out["width_90"] = 100 * float(np.mean((H9[b] - L9[b]) / R[b]))
    if pu is not None:
        u = pu[ok]
        up = (ar > 0).astype(float)
        if np.isfinite(u).sum() >= min_n:
            out["brier"] = float(np.nanmean((u - up) ** 2))
            out["brier_half"] = float(np.mean((0.5 - up) ** 2))
            out["brier_skill"] = 100 * (1 - out["brier"] / out["brier_half"]) if out["brier_half"] > 0 else None
    if crps is not None:
        c = crps[ok]
        out["crps"] = float(np.nanmean(c))
        if crps_ref is not None:
            cr = crps_ref[ok]
            out["crps_ref"] = float(np.nanmean(cr))
            out["crps_skill"] = 100 * (1 - out["crps"] / out["crps_ref"]) if out["crps_ref"] > 0 else None
    return out


def _verdict(m: dict) -> dict:
    """Stessi codici della previsione a 1 giorno (il testo lo compone la UI)."""
    mase, p = m.get("mase"), m.get("dm_p")
    if mase is None:
        return {"code": "n_a"}
    better, sig = mase < 1, p is not None and p < 0.05
    if better and sig:
        code = "edge" if mase < 0.97 else "small_edge"
    elif better:
        code = "no_edge"
    elif sig:
        code = "worse"
    else:
        code = "no_edge" if mase < 1.02 else "worse_ns"
    return {"code": code, "mase": mase, "dm_p": p,
            "direction_significant": bool(m.get("p_dir") is not None and m["p_dir"] < 0.05),
            "direction_beats_always_up": bool(m.get("p_dir_vs_up") is not None and m["p_dir_vs_up"] < 0.05)}


# ------------------------------------------------------------------ backtest walk-forward (pesante: GPU in locale)

def _crps_samples(samples: np.ndarray, y: float) -> float:
    """CRPS empirico (forma energetica) in unità di log-rendimento."""
    x = np.sort(samples)
    n = len(x)
    t1 = np.mean(np.abs(x - y))
    # E|X-X'| = 2/n² Σ (2i-n-1) x_(i)
    t2 = 2.0 * np.sum((2 * np.arange(1, n + 1) - n - 1) * x) / (n * n)
    return float(t1 - 0.5 * t2)


def _crps_gauss(mu: np.ndarray, sig: np.ndarray, y: np.ndarray) -> np.ndarray:
    z = (y - mu) / sig
    return sig * (z * (2 * stats.norm.cdf(z) - 1) + 2 * stats.norm.pdf(z) - 1 / math.sqrt(math.pi))


def _origins(d: pd.DataFrame, tf: str, start: pd.Timestamp, end: pd.Timestamp, every_days: int, H: int) -> list[int]:
    """Indici delle origini: candela che chiude a mezzanotte UTC (stesso target del modello a 1 giorno), un'origine ogni
    `every_days` giorni, con almeno LOOKBACK candele prima e H dopo."""
    sec = TFS[tf]["sec"]
    close_t = d.index + pd.Timedelta(seconds=sec)
    mid = (close_t.hour == 0) & (close_t.minute == 0)
    idx = np.where(mid & (close_t >= start) & (close_t < end))[0]
    idx = idx[(idx >= LOOKBACK - 1) & (idx + H < len(d))]
    if every_days > 1:
        days = ((close_t[idx] - close_t[idx[0]]).days if len(idx) else np.array([]))
        idx = idx[np.asarray(days) % every_days == 0]
    return idx.tolist()


BT_COLS = ["model", "tf", "origin", "period", "step", "ref", "actual", "q05", "q25", "q50", "q75", "q95", "mean", "up",
           "crps", "sig1", "drift1", "regime", "agree", "snr", "sd_ret_pct", "er"]


def _bt_frame(rows: list) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=BT_COLS)
    df["version"] = BT_VERSION
    return df


def run_backtest(models=("small",), tfs=("1d", "4h", "1h"), samples: int = 32, pre_every: int = 8, post_every: int = 1,
                 batch_origins: int = 4, chunk: int | None = None, progress=print, out_dir: Path | None = None,
                 limit: int | None = None, periods=("post", "pre")) -> dict:
    """Walk-forward fuori campione: per ogni origine solo le LOOKBACK candele chiuse fino all'origine (nessun look-ahead);
    i realizzati si leggono dopo. Prima il periodo DOPO il pre-addestramento (quello del verdetto), poi quello prima.
    Salva righe (modello, tf, origine, passo) + meta in out_dir con scritture atomiche, con checkpoint ogni ~2 minuti e
    ripresa dalle origini già calcolate (stessa versione e stessi campioni)."""
    out_dir = Path(out_dir or store.DATA_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    _torch()
    H = BT_H
    old = None
    mp = out_dir / BT_META
    if (out_dir / BT_FILE).exists() and mp.exists():
        try:
            m0 = json.loads(mp.read_text(encoding="utf-8"))
            o = pd.read_parquet(out_dir / BT_FILE)
            if m0.get("version") == BT_VERSION and m0.get("samples") == samples and len(o):
                old = o
                progress(f"ripresa: {o.groupby(['model', 'tf', 'origin']).ngroups} origini già calcolate")
        except Exception as e:  # noqa: BLE001
            progress(f"checkpoint illeggibile, si riparte: {e}")
    done_keys = set() if old is None else set(zip(old["model"], old["tf"], pd.to_datetime(old["origin"], utc=True)))
    rows: list = []
    meta = {"version": BT_VERSION, "created_at": time.time(), "samples": samples, "H": H, "lookback": LOOKBACK,
            "T": T_SAMPLING, "top_p": TOP_P, "pretrain_end": PRETRAIN_END, "pre_every_days": pre_every,
            "post_every_days": post_every, "device": _status["device"], "gpu": _status["gpu_name"],
            "torch": _status["torch_version"], "models": list(models), "seconds": {}, "origins": {}, "complete": False}
    t_all = time.time()
    last_ck = time.time()

    def save(final=False):
        df = _bt_frame(rows)
        if old is not None:
            df = pd.concat([old, df], ignore_index=True)
        df["origin"] = pd.to_datetime(df["origin"], utc=True)
        store.write_parquet(df, out_dir / BT_FILE)
        meta["complete"] = final
        meta["seconds"]["total"] = meta["seconds"].get("total_prev", 0) + time.time() - t_all
        store.write_text(mp, json.dumps(clean(meta), ensure_ascii=False))

    for per in periods:
        for model in models:
            eng = engine(model)
            for tf in tfs:
                sec = TFS[tf]["sec"]
                d = candles(tf)
                if per == "post":
                    oi = _origins(d, tf, PRETRAIN_END, _now(), post_every, H)
                    oi = oi[:limit] if limit else oi
                else:
                    oi = _origins(d, tf, pd.Timestamp("2019-02-01", tz="UTC"), PRETRAIN_END, pre_every, H)
                    oi = oi[-limit:] if limit else oi
                meta["origins"].setdefault(f"{model}:{tf}", {})[per] = len(oi)
                todo = [i for i in oi if (model, tf, d.index[i]) not in done_keys]
                close = d["close"].to_numpy(float)
                lr = np.diff(np.log(close), prepend=np.nan)
                cs = np.nancumsum(lr)
                t0 = time.time()
                for a in range(0, len(todo), batch_origins):
                    part = todo[a:a + batch_origins]
                    xs, xst, yst, seeds = [], [], [], []
                    for i in part:
                        x, s1, s2, _f = _window(d, i, LOOKBACK, sec, H)
                        xs.append(x)
                        xst.append(s1)
                        yst.append(s2)
                        seeds.append(int(d.index[i].timestamp() // sec) % 100000)
                    P = sample_paths(eng, xs, xst, yst, H, samples, seeds, chunk=chunk)
                    for i, Pb in zip(part, P):
                        c = Pb[:, :, 3].astype(np.float64)                  # (S, H)
                        ref = close[i]
                        reg = regime_of(c[:, -1], ref)
                        er = float(np.mean([efficiency(c[k], ref) for k in range(c.shape[0])]))
                        sig1 = float(np.nanstd(lr[max(1, i - LOOKBACK + 1):i + 1]))   # volatilità della sola finestra
                        drift1 = float(cs[i] / max(i, 1))                 # media espandente dei log-rendimenti fino all'origine
                        q = np.percentile(c, QS, axis=0)
                        mean = c.mean(axis=0)
                        for k in range(H):
                            y = close[i + k + 1]                          # realizzato: letto solo dopo la previsione
                            lrs = np.log(np.maximum(c[:, k], 1e-9) / ref)
                            rows.append((model, tf, d.index[i], per, k + 1, ref, y, q[0, k], q[1, k], q[2, k], q[3, k],
                                         q[4, k], mean[k], float(np.mean(c[:, k] > ref)), _crps_samples(lrs, math.log(y / ref)),
                                         sig1, drift1, reg["code"], reg["agree"], reg["snr"], reg["sd_ret_pct"], er))
                    n = a + len(part)
                    if n % (batch_origins * 10) == 0 or n == len(todo):
                        el = time.time() - t0
                        progress(f"{per} {model} {tf}: {n}/{len(todo)} origini · {el:.0f}s · {el / max(n, 1):.2f}s/origine")
                    if time.time() - last_ck > 120:
                        save()
                        last_ck = time.time()
                meta["seconds"][f"{per}:{model}:{tf}"] = time.time() - t0
    save(final=True)
    _bt_cache.clear()
    return meta


def measure_timings(tf: str = "1h", H: int = DEFAULT_H, S: int = DEFAULT_SAMPLES, devices=("cpu", "cuda"), repeats: int = 1) -> dict:
    """Tempo di una previsione (S percorsi × H passi, contesto 512) su CPU e GPU (se presenti)."""
    torch = _torch()
    d = candles(tf)
    sec = TFS[tf]["sec"]
    x, xst, yst, _ = _window(d, len(d) - 1, LOOKBACK, sec, H)
    out = {}
    for dev in devices:
        if dev == "cuda" and not torch.cuda.is_available():
            continue
        eng = engine(LIVE_MODEL, device=dev)
        sample_paths(eng, [x], [xst], [yst], 2, 2, [1])           # riscaldamento
        best = None
        for _ in range(repeats):
            if dev == "cuda":
                torch.cuda.synchronize()
            t0 = time.time()
            sample_paths(eng, [x], [xst], [yst], H, S, [1])
            if dev == "cuda":
                torch.cuda.synchronize()
            el = time.time() - t0
            best = el if best is None else min(best, el)
        out[dev] = {"seconds": best, "threads": torch.get_num_threads() if dev == "cpu" else None,
                    "name": torch.cuda.get_device_name(0) if dev == "cuda" else (os.environ.get("PROCESSOR_IDENTIFIER") or "cpu")}
    return {"tf": tf, "h": H, "samples": S, "lookback": LOOKBACK, "model": LIVE_MODEL, **out}


# ------------------------------------------------------------------ valutazione del backtest

_bt_cache: dict = {}


def _bt_paths() -> tuple[Path, Path] | None:
    """File del backtest: DATA_DIR (calcolo locale) o backend/seed (immagine Docker); vince il più recente completo."""
    best, best_t = None, -1.0
    for base in (store.DATA_DIR, SEED_DIR):
        p, m = base / BT_FILE, base / BT_META
        if p.exists() and m.exists():
            try:
                meta = json.loads(m.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            t = float(meta.get("created_at") or 0) + (1e10 if meta.get("complete") else 0)
            if meta.get("version") == BT_VERSION and t > best_t:
                best, best_t = (p, m), t
    return best


def _oneday_series() -> pd.DataFrame | None:
    """Previsioni fuori campione del nostro modello a 1 giorno (LightGBM), per il confronto sugli stessi target."""
    p = store.DATA_DIR / "forecast_oneday_series.parquet"
    if not p.exists():
        return None
    try:
        s = pd.read_parquet(p, columns=["origin", "ref_close", "close_p_q50", "close_p_q05", "close_p_q25", "close_p_q75",
                                        "close_p_q95", "close_up"])
        s["origin"] = pd.to_datetime(s["origin"]).dt.tz_localize("UTC") if pd.to_datetime(s["origin"]).dt.tz is None else pd.to_datetime(s["origin"], utc=True)
        return s.set_index("origin")
    except Exception as e:  # noqa: BLE001
        log.info("serie a 1 giorno non leggibile: %s", e)
        return None


def _eval_block(g: pd.DataFrame, tf: str, step: int, od: pd.DataFrame | None) -> dict:
    sec = TFS[tf]["sec"]
    every = max(1, int(math.ceil(step * sec / 86400 / _spacing_days(g) - 1e-9)))
    A, R = g["actual"].to_numpy(float), g["ref"].to_numpy(float)
    yl = np.log(A / R)
    sig = g["sig1"].to_numpy(float) * math.sqrt(step)
    crps_rw = _crps_gauss(np.zeros_like(sig), sig, yl)
    z90, z50 = stats.norm.ppf(0.95), stats.norm.ppf(0.75)
    rows = {
        "kronos": _point_metrics(A, g["mean"].to_numpy(float), R, g["q25"].to_numpy(float), g["q75"].to_numpy(float),
                                 g["q05"].to_numpy(float), g["q95"].to_numpy(float), g["up"].to_numpy(float),
                                 g["crps"].to_numpy(float), crps_rw, lag=step - 1, thin=every),
        "kronos_median": _point_metrics(A, g["q50"].to_numpy(float), R, lag=step - 1, thin=every),
        "naive": _point_metrics(A, R, R, lag=step - 1, thin=every),
        "drift": _point_metrics(A, R * np.exp(g["drift1"].to_numpy(float) * step), R, lag=step - 1, thin=every),
        "rw_vol": _point_metrics(A, R, R, R * np.exp(-z50 * sig), R * np.exp(z50 * sig), R * np.exp(-z90 * sig),
                                 R * np.exp(z90 * sig), crps=crps_rw, lag=step - 1, thin=every),
    }
    for k in ("kronos", "kronos_median", "drift"):
        rows[k]["verdict"] = _verdict(rows[k])
    rows["naive"]["verdict"] = {"code": "baseline"}
    rows["rw_vol"]["verdict"] = {"code": "baseline"}
    if od is not None and step == DAY_STEP[tf]:
        # stesse origini (chiusura di mezzanotte UTC) e stesso target (chiusura del giorno dopo)
        day = (pd.DatetimeIndex(g["origin"]) + pd.Timedelta(seconds=sec)).normalize() - pd.Timedelta(days=1)
        o = od.reindex(day)
        okm = o["close_p_q50"].notna().to_numpy()
        if okm.sum() >= 30:
            gg = g[okm]
            oo = o[okm]
            A2, R2 = gg["actual"].to_numpy(float), gg["ref"].to_numpy(float)
            rows["oneday"] = _point_metrics(A2, oo["close_p_q50"].to_numpy(float), R2, oo["close_p_q25"].to_numpy(float),
                                            oo["close_p_q75"].to_numpy(float), oo["close_p_q05"].to_numpy(float),
                                            oo["close_p_q95"].to_numpy(float), oo["close_up"].to_numpy(float), lag=0, thin=1)
            rows["oneday"]["verdict"] = _verdict(rows["oneday"])
            km = _point_metrics(A2, gg["mean"].to_numpy(float), R2, lag=0)
            rows["oneday"]["kronos_mase_same"] = km.get("mase")
            ek = np.abs(np.log(gg["mean"].to_numpy(float) / A2))
            eo = np.abs(np.log(oo["close_p_q50"].to_numpy(float) / A2))
            dm, p = _dm_hac(ek, eo, 0)
            rows["oneday"]["dm_vs_kronos"], rows["oneday"]["dm_p_vs_kronos"] = dm, p
    return rows


def _spacing_days(g: pd.DataFrame) -> float:
    o = pd.DatetimeIndex(g["origin"]).sort_values().unique()
    if len(o) < 2:
        return 1.0
    return max(1.0, float(np.median(np.diff(o.asi8)) / 1e9 / 86400))


def _regime_eval(g: pd.DataFrame, tf: str) -> dict:
    """Utilità del regime a fine orizzonte (passo 24): le origini "trending" hanno movimenti successivi più ampi e più
    direzionali di quelle "choppy"? Test di Mann-Whitney unilaterale su |rendimento| ed efficienza realizzata, direzione
    nelle origini trending (sottocampione non sovrapposto)."""
    e = g[g["step"] == BT_H].sort_values("origin")
    if len(e) < 30:
        return {"n": int(len(e))}
    full = g.sort_values(["origin", "step"])
    act = full.pivot(index="origin", columns="step", values="actual").reindex(e["origin"])
    ref = e["ref"].to_numpy(float)
    paths = act.to_numpy(float)
    ret = np.log(paths[:, -1] / ref)
    er = np.array([efficiency(paths[i], ref[i]) for i in range(len(ref))])
    trend = e["regime"].isin(["trend_up", "trend_down"]).to_numpy()
    sgn_pred = np.where(e["regime"].to_numpy() == "trend_up", 1, np.where(e["regime"].to_numpy() == "trend_down", -1, 0))
    out = {"n": int(len(e)), "n_trend": int(trend.sum()), "n_choppy": int((~trend).sum()),
           "share_trend": 100 * float(trend.mean())}

    def grp(mask):
        return {"abs_ret_pct": 100 * float(np.mean(np.abs(ret[mask]))) if mask.any() else None,
                "er": float(np.mean(er[mask])) if mask.any() else None}
    out["trend"], out["choppy"] = grp(trend), grp(~trend)
    if trend.sum() >= 10 and (~trend).sum() >= 10:
        out["p_absret"] = float(stats.mannwhitneyu(np.abs(ret[trend]), np.abs(ret[~trend]), alternative="greater").pvalue)
        out["p_er"] = float(stats.mannwhitneyu(er[trend], er[~trend], alternative="greater").pvalue)
    # direzione nelle origini trending, su origini distanti almeno un orizzonte (non sovrapposte)
    sec = TFS[tf]["sec"]
    every = max(1, int(math.ceil(BT_H * sec / 86400 / _spacing_days(e))))
    idx = _thin(len(e), every)
    m = trend[idx] & (ret[idx] != 0)
    if m.sum() >= 5:
        hit = np.sign(ret[idx][m]) == sgn_pred[idx][m]
        out["hit_trend"] = 100 * float(hit.mean())
        out["n_trend_indep"] = int(m.sum())
        out["p_hit_trend"] = _binom_p(int(hit.sum()), int(m.sum()), 0.5)
    mt = trend & (ret != 0)
    if mt.sum() >= 10:
        out["hit_trend_all"] = 100 * float((np.sign(ret[mt]) == sgn_pred[mt]).mean())
    # la dispersione dei percorsi anticipa l'ampiezza del movimento? (Spearman tra deviazione prevista e |rendimento|)
    rho = stats.spearmanr(e["sd_ret_pct"].to_numpy(float), np.abs(ret))
    out["spearman_disp_absret"] = float(rho.statistic) if np.isfinite(rho.statistic) else None
    out["p_spearman"] = float(rho.pvalue) if np.isfinite(rho.pvalue) else None
    useful = bool(out.get("p_absret") is not None and out["p_absret"] < 0.05 and out["trend"]["abs_ret_pct"] > out["choppy"]["abs_ret_pct"])
    directional = bool(out.get("p_hit_trend") is not None and out["p_hit_trend"] < 0.05)
    out["verdict"] = "useful" if useful and directional else "magnitude_only" if useful else "direction_only" if directional else "not_useful"
    if out["n_trend"] < 10:
        out["verdict"] = "too_few"
    return out


def backtest_report() -> dict:
    paths = _bt_paths()
    if paths is None:
        return {"available": False}
    p, mp = paths
    od_p = store.DATA_DIR / "forecast_oneday_series.parquet"
    key = (str(p), p.stat().st_mtime, od_p.stat().st_mtime if od_p.exists() else 0)
    if _bt_cache.get("key") == key:
        return _bt_cache["val"]
    meta = json.loads(mp.read_text(encoding="utf-8"))
    df = pd.read_parquet(p)
    df["origin"] = pd.to_datetime(df["origin"], utc=True)
    od = _oneday_series()
    ev, curves, regime, series = {}, {}, {}, {}
    for (model, tf), g in df.groupby(["model", "tf"]):
        for per in ("pre", "post"):
            gp = g[g["period"] == per]
            if gp.empty:
                continue
            for s in sorted(set(KEY_STEPS[tf]) | {DAY_STEP[tf], BT_H}):
                gs = gp[gp["step"] == s].sort_values("origin")
                rows = _eval_block(gs, tf, s, od)
                ev.setdefault(model, {}).setdefault(tf, {}).setdefault(per, {})[str(s)] = {
                    "from": gs["origin"].min(), "to": gs["origin"].max(), "rows": rows}
            # curve per passo: MASE e copertura 90% (solo Kronos)
            cv = []
            for s in range(1, BT_H + 1):
                gs = gp[gp["step"] == s]
                m = _point_metrics(gs["actual"].to_numpy(float), gs["mean"].to_numpy(float), gs["ref"].to_numpy(float),
                                   gs["q25"].to_numpy(float), gs["q75"].to_numpy(float), gs["q05"].to_numpy(float),
                                   gs["q95"].to_numpy(float), lag=s - 1)
                cv.append({"step": s, "mase": m.get("mase"), "coverage_50": m.get("coverage_50"), "coverage_90": m.get("coverage_90"),
                           "hit_rate": m.get("hit_rate"), "dm_p": m.get("dm_p")})
            curves.setdefault(model, {}).setdefault(tf, {})[per] = cv
            regime.setdefault(model, {}).setdefault(tf, {})[per] = _regime_eval(gp, tf)
        # serie compatta del periodo post (1 giorno avanti) per il grafico previsto vs reale
        gd = g[(g["period"] == "post") & (g["step"] == DAY_STEP[tf])].sort_values("origin")
        series.setdefault(model, {})[tf] = {
            "t": [ts(x) for x in gd["origin"]], "ref": gd["ref"].round(1).tolist(), "actual": gd["actual"].round(1).tolist(),
            "mean": gd["mean"].round(1).tolist(), "p05": gd["q05"].round(1).tolist(), "p95": gd["q95"].round(1).tolist(),
        }
    # verdetto principale: Kronos-small, periodo DOPO il pre-addestramento, 1 giorno avanti e fine orizzonte, per timeframe
    headline = {}
    for model, by_tf in ev.items():
        for tf, by_per in by_tf.items():
            post = by_per.get("post", {})
            day = post.get(str(DAY_STEP[tf]), {}).get("rows", {}).get("kronos", {})
            end = post.get(str(BT_H), {}).get("rows", {}).get("kronos", {})
            headline.setdefault(model, {})[tf] = {"day": day.get("verdict", {"code": "n_a"}), "end": end.get("verdict", {"code": "n_a"}),
                                                  "day_mase": day.get("mase"), "end_mase": end.get("mase"),
                                                  "day_hit": day.get("hit_rate"), "day_always_up": day.get("always_up"),
                                                  "cov90_day": day.get("coverage_90"), "crps_skill_day": day.get("crps_skill"),
                                                  "regime": regime.get(model, {}).get(tf, {}).get("post", {}).get("verdict")}
    codes = [h["day"]["code"] for m in headline.values() for h in m.values()] + [h["end"]["code"] for m in headline.values() for h in m.values()]
    overall = ("edge" if codes and all(c in ("edge", "small_edge") for c in codes) else
               "mixed" if any(c in ("edge", "small_edge") for c in codes) else
               "worse" if codes and all(c in ("worse", "worse_ns") for c in codes) else "no_edge")
    val = clean({"available": True, "meta": meta, "evaluation": ev, "curves": curves, "regime": regime, "series": series,
                 "headline": headline, "overall": overall, "key_steps": KEY_STEPS, "day_step": DAY_STEP,
                 "pretrain_end": PRETRAIN_END, "settings": {"agree_min": AGREE_MIN, "snr_min": SNR_MIN, "dir_eps_pct": 100 * DIR_EPS}})
    _bt_cache.update(key=key, val=val)
    return val


# ------------------------------------------------------------------ risposte API

def status() -> dict:
    torch = _torch()
    live_specs = [MODELS[LIVE_MODEL], TOKENIZERS[MODELS[LIVE_MODEL]["tokenizer"]]]
    for spec in live_specs + [m for m in MODELS.values() if _have_files(_local_dir(m["repo"]))]:
        st = _wstate(spec["repo"])
        d = _local_dir(spec["repo"])
        if st["state"] in ("absent", "ready") and _have_files(d):
            st.update(state="ready", path=str(d), bytes=(d / "model.safetensors").stat().st_size)
            st["total"] = st["bytes"]
    bt = _bt_paths()
    meta = json.loads(bt[1].read_text(encoding="utf-8")) if bt else None
    return clean({
        "torch": bool(torch is not None), "torch_version": _status["torch_version"], "cuda": _status["cuda"],
        "device": _status["device"], "gpu_name": _status["gpu_name"], "threads": _status["threads"],
        "loaded": _status["loaded"], "load_seconds": _status["load_seconds"], "error": _status["error"],
        "live_model": LIVE_MODEL, "models": {k: {**v, "rev": v["rev"][:10]} for k, v in MODELS.items()},
        "weights": {k: v for k, v in _status["weights"].items()},
        "weights_dir": str(MODEL_DIR), "worker": _status["worker"], "recent": _status["timings"][:6],
        "live_enabled": LIVE_ENABLED, "pretrain_end": PRETRAIN_END,
        "backtest_timings": (meta or {}).get("timings"), "backtest_device": (meta or {}).get("gpu") or (meta or {}).get("device"),
        "sources": SOURCES,
        "defaults": {"h": DEFAULT_H, "samples": DEFAULT_SAMPLES, "T": T_SAMPLING, "top_p": TOP_P, "lookback": LOOKBACK,
                     "h_options": H_OPTIONS, "sample_options": SAMPLE_OPTIONS},
    })


def _candles_out(tf: str) -> list[dict]:
    d = candles(tf, closed_only=False).iloc[-(N_CANDLES_OUT + 1):]
    return [{"time": ts(t), "open": r.open, "high": r.high, "low": r.low, "close": r.close, "volume": r.volume} for t, r in d.iterrows()]


def build(tf: str = "1h", h: int = DEFAULT_H, samples: int = DEFAULT_SAMPLES) -> dict:
    """Previsione corrente (dalla cache del thread di lavoro). Se manca la accoda e risponde ready=false."""
    if tf not in TFS:
        raise ValueError("tf")
    h = h if h in H_OPTIONS else DEFAULT_H
    samples = samples if samples in SAMPLE_OPTIONS else DEFAULT_SAMPLES
    torch = _torch()
    base = {"tf": tf, "h": h, "samples": samples, "params": {"T": T_SAMPLING, "top_p": TOP_P, "top_k": TOP_K, "lookback": LOOKBACK,
                                                              "model": LIVE_MODEL, "clip": CLIP}, "candles": _candles_out(tf)}
    try:
        from .forecast import live_price  # noqa: PLC0415
        base["live_price"] = live_price()
    except Exception:  # noqa: BLE001
        base["live_price"] = None
    if torch is None:
        return clean({**base, "ready": False, "state": "torch_missing", "error": _status["error"]})
    o = _last_origin(tf)
    f = _cache.get((tf, h, samples, ts(o))) if o is not None else None
    stale = None
    if f is None:
        err = _job_err.get((tf, h, samples))
        if err and time.time() - err[0] < 120:
            return clean({**base, "ready": False, "state": "error", "error": err[1], "weights": _status["weights"]})
        _enqueue(tf, h, samples, live=(h == DEFAULT_H and samples == DEFAULT_SAMPLES))
        # intanto la previsione precedente dello stesso timeframe/parametri, se c'è (marcata come non aggiornata)
        prev = [v for k, v in _cache.items() if k[:3] == (tf, h, samples)]
        if not prev:
            w = _status["worker"]
            return clean({**base, "ready": False, "state": "computing" if _status["loaded"] else "loading",
                          "worker": w, "weights": _status["weights"], "eta_s": _eta(h, samples)})
        f = max(prev, key=lambda v: v["computed_at"])
        stale = True
    q = f["q"]
    return clean({
        **base, "ready": True, "stale": bool(stale), "origin": f["origin"], "origin_close": f["origin_close"],
        "ref_price": f["ref_price"], "lookback": f["lookback"], "steps": [ts(x) for x in f["steps"]],
        "median": q[2], "p05": q[0], "p25": q[1], "p75": q[3], "p95": q[4], "mean": f["mean"],
        "paths": f["paths"], "end": f["end"], "regime": {**f["regime"], "er": f["er"], "agree_min": AGREE_MIN, "snr_min": SNR_MIN},
        "computed_at": f["computed_at"], "seconds": f["seconds"], "device": f["device"],
        "worker": _status["worker"],
    })


def _eta(h: int, s: int) -> float | None:
    """Stima del tempo dalla misura più recente (scala lineare con passi × percorsi)."""
    for r in _status["timings"]:
        if r["device"] == _status["device"]:
            return r["seconds"] * (h * s) / max(1, r["h"] * r["samples"])
    return None


def summary() -> dict | None:
    """Numeri chiave per l'agente Kronos: previsione standard 1h/4h/1d (se pronte) + verdetto del backtest."""
    out = {"forecasts": {}, "backtest": None}
    for tf in TFS:
        try:
            o = _last_origin(tf)
        except Exception:  # noqa: BLE001
            continue
        f = _cache.get((tf, DEFAULT_H, DEFAULT_SAMPLES, ts(o))) if o is not None else None
        if f:
            out["forecasts"][tf] = {"origin": f["origin"], "ref": f["ref_price"], "end": f["end"], "regime": f["regime"],
                                    "target": f["steps"][-1]}
    try:
        bt = backtest_report()
        if bt.get("available"):
            out["backtest"] = {"headline": bt["headline"], "overall": bt["overall"]}
    except Exception as e:  # noqa: BLE001
        log.info("backtest Kronos non disponibile: %s", e)
    return out


def start_live() -> None:
    if LIVE_ENABLED:
        threading.Thread(target=lambda: (time.sleep(45), live_loop()), daemon=True, name="kronos-live").start()


# ------------------------------------------------------------------ CLI: backtest pesante e misura dei tempi

def _cli() -> None:
    import argparse  # noqa: PLC0415

    ap = argparse.ArgumentParser(description="Backtest walk-forward di Kronos (usa la GPU se disponibile)")
    ap.add_argument("cmd", choices=["backtest", "timings", "report"])
    ap.add_argument("--models", default="small")
    ap.add_argument("--tfs", default="1d,4h,1h")
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--pre-every", type=int, default=8)
    ap.add_argument("--post-every", type=int, default=1)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--chunk", type=int, default=None)
    ap.add_argument("--periods", default="post,pre")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for tf in TFS:
        store.get(TFS[tf]["ds"])
    if a.cmd == "timings":
        tim = measure_timings(repeats=2)
        print(json.dumps(clean(tim), indent=1))
        out_dir = Path(a.out or store.DATA_DIR)
        if (out_dir / BT_META).exists():   # i tempi misurati entrano nel meta del backtest (stato del modello in UI)
            meta = json.loads((out_dir / BT_META).read_text(encoding="utf-8"))
            meta["timings"] = clean(tim)
            store.write_text(out_dir / BT_META, json.dumps(meta, ensure_ascii=False))
        return
    if a.cmd == "report":
        r = backtest_report()
        print(json.dumps({"overall": r.get("overall"), "headline": r.get("headline")}, indent=1, default=str))
        return
    meta = run_backtest(models=tuple(a.models.split(",")), tfs=tuple(a.tfs.split(",")), samples=a.samples,
                        pre_every=a.pre_every, post_every=a.post_every, batch_origins=a.batch, limit=a.limit, chunk=a.chunk,
                        periods=tuple(a.periods.split(",")),
                        out_dir=Path(a.out) if a.out else None, progress=lambda s: print(s, flush=True))
    print(json.dumps(clean(meta), indent=1))


if __name__ == "__main__":
    _cli()
