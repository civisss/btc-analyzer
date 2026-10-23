"""Kronos (Shi et al., "Kronos: A Foundation Model for the Language of Financial Markets", arXiv:2508.02739, AAAI 2026).

Codice vendorizzato da https://github.com/shiyu-coder/Kronos (MIT, Copyright (c) 2025 ShiYu): solo i file del modello
(kronos.py, module.py). Richiede torch ed einops; nessuna dipendenza da matplotlib/qlib/tqdm.
"""
from .kronos import Kronos, KronosPredictor, KronosTokenizer, auto_regressive_inference, calc_time_stamps, sample_from_logits

__all__ = ["Kronos", "KronosPredictor", "KronosTokenizer", "auto_regressive_inference", "calc_time_stamps", "sample_from_logits"]
